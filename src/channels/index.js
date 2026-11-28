/**
 * 渠道权益扩展的注册表：**在渠道包之外**补上它没有出口的能力。
 *
 * ## 这个目录解决什么
 *
 * 「扩充渠道」不等于改 `pack.js`。宿主已经把凭据公开给所有插件
 * （`ctx.credentials.resolve(ref)`），渠道包另行 `provide('accountPool')` 出它的
 * 账号池。因此新增一个渠道、或给已有渠道补一项权益，做法是**本目录新增一个模块**：
 *
 * ```js
 * export const id = 'some-provider'
 * export function create({ credentialOf, fetch }) {
 *   return { statusOf(account) {...}, claim(account, campaignId) {...} }
 * }
 * ```
 *
 * 然后在 `PROVIDERS` 里登记。渠道包仍是它那 13 家渠道的登录与路由执行者；本目录负责
 * ① 它没有出口的读写（余额明细、活动领取、倍率），② **它完全不认识的渠道**
 * （`OWN_PROVIDERS`：账号由本插件自己登录、自己换 token，见 `accounts.js`）。
 *
 * ## 两套账号来源
 *
 * | 来源 | 谁负责登录 | 账号表 | 例子 |
 * | --- | --- | --- | --- |
 * | 渠道包账号池 | 渠道包 | `~/.dsh/channel-pack/state.json` | codearts、qoder |
 * | 本插件自己的账号表 | 本插件（设备码等） | `~/.dsh/our-free-model/channels.json` | codely |
 *
 * 两条路都只**读**账号、只用 `credentials.resolve` 取凭据，不存在第二套状态机。
 *
 * @module src/channels/index.js
 */

import { openPool } from './pool.js'
import { createCodeArtsExtras } from './codearts.js'
import { createQoderExtras } from './qoder.js'
import { createCodelyExtras } from './codely.js'
import { createAutoclawExtras } from './autoclaw.js'
import { createAccioExtras } from './accio.js'
import { createMinimaxExtras, MINIMAX_PRODUCTS } from './minimax.js'
import { createMarvisExtras } from './marvis.js'
import { MAGICREW_PRODUCTS, createMagicrewExtras } from './magicrew.js'
import { MONKEYCODE_PRODUCTS, createMonkeycodeExtras } from './monkeycode.js'
import { createBaizhiExtras } from './baizhi.js'
import { createOfficeaceExtras } from './officeace.js'
import { createAstudioExtras } from './astudio.js'
import { createDoubaoExtras } from './doubao.js'
import { AGNESCODE_PRODUCTS, createAgnescodeExtras } from './agnescode.js'
import { OWN_PROVIDERS } from './accounts.js'

/** 已实现的扩展渠道 → 工厂。加新渠道就是加一行。 */
const PROVIDERS = {
  codearts: createCodeArtsExtras,
  qoder: createQoderExtras,
  qodercn: createQoderExtras,
  codely: createCodelyExtras,
  // AutoClaw 国内站与国际站是两套账号体系（手机号 vs Z.ai OAuth），各占一个 id：
  // 同一个工厂传不同的 product，凭据与主机都不会串站。
  autoclaw: shared => createAutoclawExtras({ ...shared, product: 'cn' }),
  autoclawintl: shared => createAutoclawExtras({ ...shared, product: 'intl' }),
  accio: createAccioExtras,
  // MiniMax 国际版：自有渠道（渠道包只有国内站 `minimax`）。两站共用一份实现，
  // 只换产品表 —— 账号不互通，凭据里带 `provider` 标记，串站会在请求前被拒。
  minimaxintl: shared => createMinimaxExtras({ ...shared, product: MINIMAX_PRODUCTS.minimaxintl }),
  // 腾讯 Marvis：钱包只读，上游没有签到端点。
  marvis: createMarvisExtras,
  // 超级麦吉 / MagiCrew：两站同一套实现，只换产品表（账号体系物理隔离）。
  magicrew: shared => createMagicrewExtras({ ...shared, product: MAGICREW_PRODUCTS.magicrew }),
  magicrewintl: shared => createMagicrewExtras({ ...shared, product: MAGICREW_PRODUCTS.magicrewintl }),
  // MonkeyCode：三件套凭据（api_key / signing_secret / session_cookie）。
  monkeycode: shared => createMonkeycodeExtras({ ...shared, product: MONKEYCODE_PRODUCTS.monkeycode }),
  monkeycodeintl: shared => createMonkeycodeExtras({ ...shared, product: MONKEYCODE_PRODUCTS.monkeycodeintl }),
  // 百智云：网页 cookie 换 `sk-` Key，余额与每日临时积分走 cookie。
  baizhi: createBaizhiExtras,
  // OfficeAce：目录内置，没有签到端点（只有额度读数）。
  officeace: createOfficeaceExtras,
  // AStudio：Cookie→Bearer，目录远端，签到是**弹窗**语义（pending → complete）。
  astudio: createAstudioExtras,
  // 豆包：cookie 会话 + 页面签名的每日签到，额度走 commerce 腿；
  // 推理/目录走 `/chat/completion` 与 `brief_list` 两条自己的协议。
  doubao: createDoubaoExtras,
  // AgnesCode：登录态只存在于桌面客户端（Chromium v10 + DPAPI），
  // 由 `/channels/own/import` 读出来；目录账号级下发，无静态兜底。
  agnescode: shared => createAgnescodeExtras({ ...shared, product: AGNESCODE_PRODUCTS.agnescode }),
  agnescodeintl: shared => createAgnescodeExtras({ ...shared, product: AGNESCODE_PRODUCTS.agnescodeintl }),
}

/**
 * 把「每日签到」补成一条**活动行**。
 *
 * 多数自有渠道的 `statusOf` 只回 `checkin` 读数（`canCheckIn` / `claimable` /
 * `todayCheckedIn`），没有 `activities`；面板的「活动」折叠因此永远空白，用户
 * 只能靠卡片上的「一键领取」猜。这里统一翻译成活动行（与豆包/AStudio 已有的
 * 形状一致），领取仍然走 `/channels/extra/claim`。
 *
 * - `stateless` 两家（AutoClaw / 超级麦吉）没有签到状态端点，但领取本身按天
 *   幂等，给一个可执行入口比不给好；
 * - 读不到布尔位的账号**不伪造状态**：没有可判定的字段就不产生活动行。
 */
export function withDailyCheckinActivity(provider, row) {
  if (row === null || typeof row !== 'object') return row
  if (Array.isArray(row.activities) && row.activities.length > 0) return row
  const state = row.checkin !== null && typeof row.checkin === 'object' ? row.checkin : null
  const stateless = provider === 'autoclaw' || provider === 'autoclawintl'
    || provider === 'magicrew' || provider === 'magicrewintl'
  const claimable = state === null
    ? (stateless ? true : undefined)
    : typeof state.claimable === 'boolean' ? state.claimable
      : typeof state.canCheckIn === 'boolean' ? state.canCheckIn
        : state.todayCheckedIn === false ? true
          : state.todayCheckedIn === true ? false : undefined
  if (claimable === undefined) return row
  return {
    ...row,
    activities: [{
      campaignId: `${provider}:daily`,
      type: 'checkin',
      title: '每日签到',
      claimable,
      status: claimable ? '' : '今天已签',
      amount: Number(state?.todayCredit ?? state?.reward) || 0,
    }],
  }
}

/** 一个什么都不做的空实现：宿主没挂渠道包时页照常渲染。 */
const EMPTY = {
  available: false,
  providers: () => [],
  status: async provider => ({ provider, accounts: [], supported: false, reason: '渠道包未挂载或账号池不可用' }),
  claim: async () => ({ kind: 'failed', message: '渠道包未挂载或账号池不可用' }),
}

/**
 * @param {object} options
 * @param {object|undefined} options.pool - 渠道包暴露的账号池
 * @param {(ref: string) => Promise<{value: string}|undefined>} options.resolve - 宿主凭据解析
 * @param {object} [options.ownAccounts] - `createChannelAccounts` 的产物（本插件自己的渠道）
 * @param {Function} [options.fetch] - 测试注入
 * @param {{warn?: Function}} [options.logger]
 */
export function createChannelExtras({ pool, resolve, ownAccounts, fetch: fetchImpl, logger } = {}) {
  const opened = openPool(pool, resolve)
  const shared = {
    credentialOf: async account => {
      // 本插件自己的渠道：账号表里带 `credentialRef`，与渠道包同形，故同一解析路径。
      if (ownAccounts !== undefined && OWN_PROVIDERS.includes(account?.provider)) {
        return ownAccounts.credentialOf(account)
      }
      return opened.credentialOf(account)
    },
    /**
     * 续期后的凭据回写：只有**自有渠道**有可写的账号表。
     * 渠道包的账号由它自己的续期器负责，这里绝不代写（会与它的单飞表打架）。
     */
    persist: async (accountId, credential) => {
      if (ownAccounts === undefined || typeof ownAccounts.attach !== 'function') return
      await ownAccounts.attach(accountId, credential)
    },
    ...fetchImpl === undefined ? {} : { fetch: fetchImpl },
  }
  // 渠道包不可用时仍要能服务「本插件自己的渠道」——两者独立降级。
  if (!opened.available && ownAccounts === undefined) return EMPTY

  const handlers = {}
  for (const [id, create] of Object.entries(PROVIDERS)) {
    handlers[id] = create(shared)
  }

  /** 某渠道的账号：先看本插件自己的表，再看渠道包。 */
  const accountsOf = provider => {
    if (OWN_PROVIDERS.includes(provider)) return ownAccounts === undefined ? [] : ownAccounts.enabled(provider)
    return opened.providerAccounts(provider)
  }
  /** 全部账号（含停用）—— 面板要能显示并重新启用被停用的账号。 */
  const allAccountsOf = provider => {
    if (OWN_PROVIDERS.includes(provider)) return ownAccounts === undefined ? [] : ownAccounts.list(provider)
    return opened.providerAccounts(provider)
  }
  const findAccount = accountId => {
    if (ownAccounts !== undefined) {
      for (const provider of OWN_PROVIDERS) {
        const hit = ownAccounts.find(accountId)
        if (hit !== undefined && hit.provider === provider) return hit
      }
    }
    return opened.findAccount(accountId)
  }

  return {
    available: true,
    providers: () => Object.keys(handlers),
    /**
     * 一个渠道的全部账号：余额、活动、倍率。
     *
     * 逐账号串行（账号数是个位数，且这些端点本身有速率限制）；单个账号失败只影响
     * 它自己那一行 —— 一个凭据过期不该让整张卡片变空。
     */
    async status(provider) {
      const handler = handlers[provider]
      if (handler === undefined) return { provider, accounts: [], supported: false, reason: `未实现该渠道的权益扩展：${provider}` }
      const rows = []
      for (const account of accountsOf(provider)) {
        try {
          /**
           * ⚠️ **没有凭据的账号 = 待登录，不是「查询失败」**。
           *
           * 「添加账号」会先建一个占位账号，凭据要等用户在浏览器/扫码那边登完才写进来；
           * 用户中途关掉窗口就会留下一条永远没有凭据的行。以前这里照样去问上游，
           * 拿到「凭据不可用」画成红字 —— 面板上表现为「都没登账号还提示余额查询失败」。
           * 判据放在**入口这一处**：凭据为空就只回 `pending`，不惊动任何上游。
           */
          const credential = ownAccounts !== undefined && OWN_PROVIDERS.includes(provider)
            ? await shared.credentialOf(account)
            : undefined
          if (credential === null) {
            rows.push({ accountId: account?.id ?? '', nickname: account?.nickname ?? '', pending: true })
            continue
          }
          rows.push(withDailyCheckinActivity(provider, await handler.statusOf({ ...account, provider })))
        } catch (error) {
          logger?.warn?.(`our-free-model: ${provider} 权益查询失败（${account?.id ?? '?'}）：${error instanceof Error ? error.message : String(error)}`)
          rows.push({ accountId: account?.id ?? '', nickname: account?.nickname ?? '', error: '权益查询失败' })
        }
      }
      // 倍率与目录是**渠道维度**的，同一渠道各账号一致；合并成给模型列表用的一张表。
      // `source` / `catalogNote` / `catalogError` 必须一起抬上来：各渠道的 `statusOf`
      // 早就按行返回它们，但这里曾只挑 `catalog` 与 `ratios`，于是「实时/预制」
      // 提示和失败原因在宿主侧永远是 undefined，面板只能显示成功的样子。
      const ratios = {}
      let catalog
      let source
      let catalogNote
      let catalogError
      for (const row of rows) {
        for (const [model, ratio] of Object.entries(row.ratios ?? {})) if (ratios[model] === undefined) ratios[model] = ratio
        if (catalog === undefined && Array.isArray(row.catalog) && row.catalog.length > 0) {
          catalog = row.catalog
          source = typeof row.source === 'string' ? row.source : undefined
        }
        const note = typeof row.catalogNote === 'string' ? row.catalogNote : typeof row.note === 'string' ? row.note : undefined
        if (catalogNote === undefined && note !== undefined) catalogNote = note
        if (catalogError === undefined && typeof row.catalogError === 'string' && row.catalogError !== '') catalogError = row.catalogError
      }
      return {
        provider,
        accounts: rows,
        ratios,
        ...catalog === undefined ? {} : { catalog },
        ...source === undefined ? {} : { source },
        ...catalogNote === undefined ? {} : { catalogNote },
        ...catalogError === undefined ? {} : { catalogError },
        supported: true,
      }
    },
    /** 领取某个活动 / 每日签到；`campaignId` 省略时取该渠道的默认活动。 */
    async claim(provider, accountId, campaignId) {
      const handler = handlers[provider]
      if (handler === undefined) return { kind: 'failed', message: `未实现该渠道的权益扩展：${provider}` }
      const account = findAccount(accountId)
      if (account === undefined) return { kind: 'failed', message: '账号不存在' }
      if (account.provider !== undefined && account.provider !== provider) return { kind: 'failed', message: '账号与渠道不匹配' }
      try {
        // 自己的渠道：把「轮换后的 token」写回本插件的账号表（refresh 只制造登录事件，
        // 落盘失败不影响本次签到 —— 工厂内部已 try/catch）。
        const persist = OWN_PROVIDERS.includes(provider) && ownAccounts !== undefined && typeof ownAccounts.attach === 'function'
          ? value => ownAccounts.attach(account.id, value)
          : undefined
        return await handler.claim({ ...account, provider }, campaignId, persist === undefined ? {} : { persist })
      } catch (error) {
        return { kind: 'failed', message: error instanceof Error ? error.message : String(error) }
      }
    },
    /** 渠道的账号清单（含停用），供面板渲染「本插件自己的渠道」那一组。 */
    accounts: provider => allAccountsOf(provider),
    /**
     * 清掉没有凭据的占位账号（登录流程是内存态，进程重启后那些行永远等不到凭据）。
     * 返回 `{provider, id}[]`；宿主启动时调一次，面板上就不再有一片「待登录」。
     */
    prunePending: async () => {
      if (ownAccounts === undefined || typeof ownAccounts.prunePending !== 'function') return []
      return ownAccounts.prunePending()
    },
  }
}