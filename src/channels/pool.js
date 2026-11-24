/**
 * 渠道池适配层：把渠道包已经登录好的账号与凭据取出来，供本插件自己的
 * 「渠道权益扩展」使用。
 *
 * ## 为什么可以这么做
 *
 * 渠道包在 `apply()` 末尾用 `ctx.provide('accountPool', pool)` 暴露了账号池，
 * 而它写的凭据走宿主的 `credentials` 服务（`ctx.credentials.resolve(ref)`）。
 * 这两样都是**宿主服务**，不是渠道包的私有物 —— 本插件与渠道包拿到的是同一
 * 份账号、同一条凭据。因此「在渠道包之外再实现一个渠道 / 一项权益」不需要改
 * `vendor/channel-pack/pack.js`：新模块读同一个池、同一份凭据，自己发请求即可。
 *
 * 这也是 dsh-providers-hub 的形态：每家渠道是一个独立 src 模块，注册到
 * `ctx.llm`，与「渠道包」是平行生产者。本目录只做**权益/任务**这一侧
 * （余额、活动领取、倍率），不改模型路由。
 *
 * 边界：
 * - 只读 `listAccounts` / `findAccount`，不写池（写操作留给渠道包，避免两处
 *   状态机同时改同一份文档）；
 * - 凭据只在本函数的调用帧里出现，不缓存、不落盘、不进日志。
 *
 * @module src/channels/pool.js
 */

/** 池上本模块用到的两个方法（做能力检测，缺一个就整体降级）。 */
const REQUIRED = ['listAccounts', 'findAccount']

/**
 * 包一层账号池。返回 `{ available, providerAccounts, findAccount, credentialOf }`。
 *
 * `providerAccounts(provider)` 只回**启用**的账号：权益查询与领取都是写操作
 * 之外的读，但拿停用账号去问上游既无意义也会产生噪音。
 *
 * @param {object|undefined} pool - 渠道包暴露的账号池
 * @param {(ref: string) => Promise<{value: string}|undefined>} resolve - 宿主凭据解析
 * @returns {{available: boolean, providerAccounts: (provider: string) => Array<object>, findAccount: (id: string) => object|undefined, credentialOf: (account: object) => Promise<object|null>}}
 */
export function openPool(pool, resolve) {
  const available = pool !== undefined && pool !== null && REQUIRED.every(method => typeof pool[method] === 'function')
  if (!available) {
    return { available: false, providerAccounts: () => [], findAccount: () => undefined, credentialOf: async () => null }
  }
  return {
    available: true,
    providerAccounts(provider) {
      const rows = pool.listAccounts(provider)
      const list = Array.isArray(rows) ? rows : []
      return list.filter(row => row?.enabled !== false)
    },
    findAccount(accountId) {
      return typeof accountId === 'string' && accountId !== '' ? pool.findAccount(accountId) : undefined
    },
    async credentialOf(account) {
      const ref = account?.credentialRef
      if (typeof ref !== 'string' || ref === '') return null
      if (typeof resolve !== 'function') return null
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
  }
}