/**
 * 本插件自己拥有的渠道账号（用于**渠道包没有**的渠道）。
 *
 * ## 为什么需要一份自己的账号表
 *
 * 渠道包的 13 个渠道把它自己的账号池 `provide('accountPool')` 出来，本插件只读它。
 * 但「新增一家渠道」时，账号是我们自己登录、自己换 token 的 —— 渠道包根本不认识
 * `codely` 这个 provider，也没有它的登录流程。所以在**本插件自己的**存储里放一张
 * 账号表（`channels.json`），凭据照旧写宿主的 `credentials`（ref 名以 `OFM_` 开头，
 * 与渠道包的 `CODEARTS_ACCOUNT_*` 命名空间分开，互不覆盖）。
 *
 * ## 边界
 *
 * - 只存**指向凭据的引用**，凭据本体在宿主 credentials 里（与渠道包同一取向）；
 * - 表里**不落 token**：`credentialOf()` 每次现解析；
 * - 读操作（列表/查询）不需要登录态；写操作（增删）由 HTTP 路由挡住（复用宿主
 *   连接信任检查）。
 *
 * @module src/channels/accounts.js
 */

import crypto from 'node:crypto'

/**
 * 允许出现在账号表里的 provider（新增渠道时在这里加一行）。
 *
 * ⚠️ 只登记**渠道包不认识**的渠道。`minimax` 由渠道包持有账号池，这里放进去会
 * 出现两套账号表认同一家；`minimaxintl` 是另一家产品（账号不互通），故只登记它。
 */
export const OWN_PROVIDERS = Object.freeze(['codely', 'autoclaw', 'autoclawintl', 'accio', 'minimaxintl', 'marvis', 'magicrew', 'magicrewintl', 'monkeycode', 'monkeycodeintl', 'baizhi', 'officeace', 'astudio', 'doubao', 'agnescode', 'agnescodeintl'])

const REF_PREFIX = 'OFM'

/** 短随机后缀，用于凭据 ref 与账号 id。 */
function shortId() {
  return crypto.randomBytes(4).toString('hex')
}

/** `OFM_CODELY_ACCOUNT_XXXX` */
export function credentialRefName(provider) {
  return `${REF_PREFIX}_${String(provider).toUpperCase()}_ACCOUNT_${shortId().toUpperCase()}`
}

/**
 * @param {import('../store.js').JsonStore} store - `{version, accounts: []}`
 * @param {{set: (ref: string, value: string) => Promise<void>, delete?: (ref: string) => Promise<void>}} credentials
 * @param {(ref: string) => Promise<{value: string}|undefined>} resolve
 */
export function createChannelAccounts(store, credentials, resolve) {
  const doc = () => {
    const value = store.get()
    return {
      version: 1,
      accounts: Array.isArray(value?.accounts) ? value.accounts : [],
    }
  }
  const save = accounts => {
    store.update({ version: 1, accounts })
    store.flush?.()
  }

  return {
    /** 某渠道的账号（**含停用**：面板要能重新启用），按创建时间升序。 */
    list(provider) {
      const wanted = String(provider ?? '')
      return doc().accounts
        .filter(entry => entry.provider === wanted)
        .sort((left, right) => (left.createdAt ?? 0) - (right.createdAt ?? 0))
    },
    /** 只读启用中的账号（权益查询用）。 */
    enabled(provider) {
      return this.list(provider).filter(entry => entry.enabled !== false)
    },
    find(accountId) {
      const id = String(accountId ?? '')
      return doc().accounts.find(entry => entry.id === id)
    },
    /**
     * 建一个**待登录**的账号。凭据此时还不存在，`expiresAt` 缺省 ——
     * 与渠道包的「占位账号」同一形态，面板据此显示「待登录」而不是「已失效」。
     */
    create(provider, patch = {}) {
      if (!OWN_PROVIDERS.includes(provider)) throw new Error(`unsupported provider: ${provider}`)
      const entry = {
        id: `${provider}-${shortId()}`,
        provider,
        nickname: typeof patch.nickname === 'string' && patch.nickname !== '' ? patch.nickname : '',
        credentialRef: credentialRefName(provider),
        enabled: true,
        createdAt: Date.now(),
        ...patch.expiresAt === undefined ? {} : { expiresAt: patch.expiresAt },
      }
      save([...doc().accounts, entry])
      return entry
    },
    update(accountId, patch = {}) {
      const accounts = doc().accounts
      const index = accounts.findIndex(entry => entry.id === accountId)
      if (index < 0) return undefined
      const next = { ...accounts[index] }
      if (typeof patch.nickname === 'string') next.nickname = patch.nickname
      if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
      if (patch.expiresAt === null) delete next.expiresAt
      else if (typeof patch.expiresAt === 'number') next.expiresAt = patch.expiresAt
      accounts[index] = next
      save(accounts)
      return next
    },
    async remove(accountId) {
      const accounts = doc().accounts
      const entry = accounts.find(row => row.id === accountId)
      if (entry === undefined) return false
      save(accounts.filter(row => row.id !== accountId))
      // 凭据一并删掉：留着就是一份无主令牌。删除失败不影响账号表（下一次登录会写新 ref）。
      try {
        if (typeof credentials.delete === 'function') await credentials.delete(entry.credentialRef)
      } catch { /* 凭据服务没有 delete 或拒绝删除时，表已经干净了 */ }
      return true
    },
    /** 写入凭据并回填账号（登录成功后唯一的写入口）。 */
    async attach(accountId, value, patch = {}) {
      const entry = this.find(accountId)
      if (entry === undefined) return undefined
      await credentials.set(entry.credentialRef, JSON.stringify(value))
      return this.update(accountId, patch)
    },
    /** 解析某个账号的凭据 JSON；缺失/损坏时为 null（**不抛**）。 */
    async credentialOf(entry) {
      const ref = entry?.credentialRef
      if (typeof ref !== 'string' || ref === '') return null
      const resolved = await resolve(ref)
      const raw = resolved?.value
      if (typeof raw !== 'string' || raw === '') return null
      try {
        const parsed = JSON.parse(raw)
        return parsed !== null && typeof parsed === 'object' ? parsed : null
      } catch {
        return null
      }
    },
    /**
     * 清掉「占位账号」：账号表里有行、凭据库里没有本体。
     *
     * 登录流程是**内存态**的（浏览器/扫码等回调），进程一重启就没了 ⇒ 那些行永远
     * 等不到凭据，只会让面板显示一片「待登录」。启动时清一次，返回被清掉的条数。
     */
    async prunePending() {
      const rows = doc().accounts
      const keep = []
      const dropped = []
      for (const entry of rows) {
        const credential = await this.credentialOf(entry)
        if (credential === null) dropped.push(entry.id)
        else keep.push(entry)
      }
      if (dropped.length > 0) save(keep)
      return dropped
    },
  }
}