/**
 * 自有渠道的**账号轮换**（推理取号）。
 *
 * ## 为什么需要一个模块
 *
 * 以前 `ownCredentialFor()` 永远取 `enabled(provider)[0]`：第二个账号登了也
 * 永远不会被用到，第一个账号的令牌一坏，这家渠道就整条不可用 —— 用户看到的是
 * 「账号列表里明明有两个号，模型却一直报凭据不可用」。
 *
 * 现在的口径与渠道包的账号池一致：
 * - **轮转**：按账号表顺序取下一个（游标存在本进程内），多账号分摊请求；
 * - **跳过无凭据的占位行**：没有凭据的账号不参与（占位行本该在启动时被清掉，
 *   但登录中途也会短暂存在）；
 * - **续期在取号时做**：只对登记了 refresher 的渠道；续成功了才回写账号表。
 *
 * 轮换是**尽力而为**，不做跨账号的失败重试：一个回合只能有一份凭据（请求体里
 * 没有账号维度），失败重试要等下一回合。下一回合的游标已经向前走了一格。
 *
 * @module src/channels/select.js
 */

/**
 * @param {object} options
 * @param {{enabled: (provider: string) => Array<object>, credentialOf: (account: object) => Promise<object|null>, attach?: (accountId: string, credential: object) => Promise<unknown>}} options.accounts
 * @param {Record<string, (credential: object, options?: {force?: boolean}) => Promise<{credential?: object, refreshed?: boolean, error?: string}>>} [options.refreshers]
 * @param {{warn?: (message: string) => void}} [options.logger]
 */
export function createOwnAccountPicker({ accounts, refreshers = {}, logger } = {}) {
  /** provider → 上次用过的 account.id（用 id 而不是下标：账号表会增删）。 */
  const lastByProvider = new Map()

  return {
    /**
     * 取一个可用账号。
     *
     * @returns `{account, credential, refreshed}` 或 `null`（没有可用账号）
     */
    async pick(provider, { force = false } = {}) {
      // `accounts` 允许传 thunk：宿主的账号表在 `ctx.inject` 里才构造完成，
      // 而取号器要在 apply 期就交给模型运行时（否则自有渠道永远「凭据不可用」）。
      const book = typeof accounts === 'function' ? accounts() : accounts
      let list
      try {
        list = book.enabled(provider)
      } catch {
        return null
      }
      if (!Array.isArray(list) || list.length === 0) return null
      const lastId = lastByProvider.get(provider)
      const seen = list.findIndex(account => account?.id === lastId)
      const start = seen < 0 ? 0 : (seen + 1) % list.length
      for (let offset = 0; offset < list.length; offset += 1) {
        const account = list[(start + offset) % list.length]
        let credential = await book.credentialOf(account)
        if (credential === null) continue
        let refreshed = false
        const refresher = refreshers[provider]
        if (typeof refresher === 'function') {
          try {
            const ensured = await refresher(credential, { force })
            // 续期失败但手上还有令牌：照旧发出去，让上游判 —— 本地判「过期」
            // 比上游准。只有「续期也没给出凭据」时才退回原凭据。
            if (ensured?.credential !== undefined && ensured?.credential !== null) credential = ensured.credential
            refreshed = ensured?.refreshed === true
          } catch (error) {
            logger?.warn?.(`our-free-model: ${provider} 续期失败（${error instanceof Error ? error.message : String(error)}）`)
          }
        }
        if (refreshed) {
          try {
            await book.attach?.(account.id, credential)
          } catch { /* 落盘失败不影响本回合 */ }
        }
        lastByProvider.set(provider, account?.id)
        return { account, credential, refreshed }
      }
      return null
    },
    /** 最近一次用过的账号（诊断/测试用）。 */
    lastAccountId(provider) {
      return lastByProvider.get(provider)
    },
  }
}
