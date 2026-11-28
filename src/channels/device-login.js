/**
 * 设备码登录的**两步式**流程容器（Codely / MiniMax 国际版）。
 *
 * 为什么是两步式：面板必须在 `account.create` 之后**立刻**拿到用户码与验证地址
 * （用户在浏览器里授权要花几十秒），而「等登录完成」不能在同一个请求里挂住 ——
 * 渠道包的 13 个渠道也是这个形状（`account.create` 先回 URL，`login.poll` 再看结果）。
 *
 * ## 每次只轮询一次
 *
 * `poll()` **不循环**：面板每个 tick 调一次。上游的 `pending` / `slow_down` 原样回给
 * 面板（`done:false`），只有拿到令牌、被拒、过期或超时才 `done:true`。
 * 在服务端挂一个 while 循环会让一个 HTTP 请求占住 15 分钟，且重启即丢。
 *
 * ## 状态只活在内存
 *
 * 进程重启后未完成的登录就该重新发起（上游设备码本身也有 900 秒有效期），
 * 把它落盘只会产生「重启后还挂着一条永远等不到的登录」。
 *
 * @module src/channels/device-login.js
 */

import { exchangeCode, fetchNickname, pollDeviceLogin, startDeviceLogin } from './codely.js'
import { MINIMAX_PRODUCTS, pollDeviceTokenOnce, startDeviceAuthorization } from './minimax.js'
import { bindAstudioWechatSession, completeAstudioLogin, inlineWechatQr, pollAstudioWechatScan, startAstudioWechatQr } from './astudio.js'

/**
 * 一家渠道的设备码流程。
 *
 * - `start({fetch})` → `{state, userCode, verificationUri, verificationUriComplete, intervalMs, expiresIn}`
 *   或 `{error}`；`state` 是流程自己留着的后续凭据（设备码 / PKCE verifier）。
 * - `poll(state, {fetch})` → `{status, credential?, expiresAt?, nickname?, error?}`，
 *   `status` ∈ `pending | slow_down | authorized | denied | expired | error`。
 */
const FLOWS = {
  codely: {
    async start({ fetch: fetchImpl }) {
      const started = await startDeviceLogin({ fetch: fetchImpl })
      if (started.error !== undefined) return started
      return {
        state: { authRequestToken: started.authRequestToken },
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        verificationUriComplete: started.verificationUriComplete,
        intervalMs: started.intervalMs,
        expiresIn: started.expiresIn,
      }
    },
    async poll(state, { fetch: fetchImpl }) {
      const polled = await pollDeviceLogin(state.authRequestToken, { fetch: fetchImpl })
      if (polled.status !== 'authorized') {
        return { status: polled.status, ...polled.error === undefined ? {} : { error: polled.error } }
      }
      const exchanged = await exchangeCode(polled.code, { fetch: fetchImpl })
      if (exchanged.error !== undefined) return { status: 'error', error: exchanged.error }
      const nickname = await fetchNickname(exchanged.credential.access_token, { fetch: fetchImpl })
      return {
        status: 'authorized',
        credential: { ...exchanged.credential, ...nickname === undefined ? {} : { nickname } },
        ...exchanged.expiresAt === undefined ? {} : { expiresAt: exchanged.expiresAt },
        ...nickname === undefined ? {} : { nickname },
      }
    },
  },
  /**
   * MiniMax 国际版：OAuth 设备码 + PKCE S256。
   *
   * ⚠️ 令牌响应自带 `provider` 标记（见 `src/channels/minimax.js`）：同一份凭据被
   * 国内站误用时，请求前就会判出来，而不是等上游回 400 才怀疑「密钥坏了」。
   */
  minimaxintl: {
    async start({ fetch: fetchImpl }) {
      const product = MINIMAX_PRODUCTS.minimaxintl
      const started = await startDeviceAuthorization({ product, fetch: fetchImpl })
      if (started.error !== undefined) return started
      return {
        state: {
          deviceCode: started.deviceCode,
          codeVerifier: started.codeVerifier,
          expiresInSec: started.expiresInSec,
        },
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        verificationUriComplete: started.verificationUriComplete,
        intervalMs: started.intervalSec * 1000,
        expiresIn: started.expiresInSec,
      }
    },
    async poll(state, { fetch: fetchImpl }) {
      const product = MINIMAX_PRODUCTS.minimaxintl
      const polled = await pollDeviceTokenOnce(
        { deviceCode: state.deviceCode, codeVerifier: state.codeVerifier },
        { product, fetch: fetchImpl },
      )
      if (polled.status !== 'authorized') {
        return { status: polled.status, ...polled.error === undefined ? {} : { error: polled.error } }
      }
      return {
        status: 'authorized',
        credential: polled.credential,
        ...typeof polled.credential.expires_at === 'number' ? { expiresAt: polled.credential.expires_at } : {},
      }
    },
  },
  /**
   * AStudio：**微信扫码**（SSO），没有用户码 —— 面板显示二维码图片。
   *
   * 三段式：`qrcode` 拿码 → `uids` 轮询扫码状态 → `bind` 确认 → 控制面换凭据。
   * 状态映射：`code:-1` 继续等；`infoList` 为空 = 该微信没开通 AStudio（重扫同一号
   * 仍然是空，必须去客户端绑定手机号）⇒ 当场报清楚，别让用户反复扫。
   */
  astudio: {
    async start({ fetch: fetchImpl }) {
      const qr = await startAstudioWechatQr({ fetch: fetchImpl })
      if (qr.error !== undefined) return qr
      // 二维码内联成 data URL（外链图片在 `dsh-app://` 渲染进程里可能被策略挡掉）；
      // 取不到就退回原始地址 —— 登录不该因为「图片没下下来」而失败。
      const inlined = await inlineWechatQr(qr.qrUrl, { fetch: fetchImpl })
      return {
        state: { fd: qr.fd },
        userCode: '',
        verificationUri: inlined.dataUrl ?? qr.qrUrl,
        // 扫码没有「打开授权页」这个动作，故 complete 留空（面板据此不渲染链接）。
        verificationUriComplete: '',
        intervalMs: 2000,
        expiresIn: 300,
        qr: true,
      }
    },
    async poll(state, { fetch: fetchImpl }) {
      const scanned = await pollAstudioWechatScan(state.fd, { fetch: fetchImpl })
      if (scanned.status === 'pending') return { status: 'pending' }
      // 「没开通账号」不是可重试的失败：换一张二维码也一样，必须去客户端开户。
      if (scanned.status === 'unbound') return { status: 'denied', error: scanned.message }
      if (scanned.status !== 'scanned') return { status: 'error', error: scanned.message }
      await bindAstudioWechatSession(state.fd, scanned.account, { fetch: fetchImpl })
      const completed = await completeAstudioLogin(scanned.account, { fetch: fetchImpl })
      if (completed.error !== undefined) return { status: 'error', error: completed.error }
      return {
        status: 'authorized',
        credential: completed.credential,
        ...completed.nickname === undefined ? {} : { nickname: completed.nickname },
      }
    },
  },
}

export function createDeviceLogin({ accounts, fetch: fetchImpl = fetch } = {}) {
  /** accountId → { provider, state, intervalMs, startedAt, expiresInMs } */
  const pending = new Map()
  /** 收掉占位账号；测试注入的 accounts 可能只有 create/attach。 */
  const dropAccount = async accountId => {
    try {
      if (typeof accounts?.remove === 'function') await accounts.remove(accountId)
    } catch { /* 账号表拒绝删除时留给 prunePending */ }
  }

  return {
    supports(provider) {
      return Object.prototype.hasOwnProperty.call(FLOWS, provider)
    },

    /** 发起一次登录：立刻建占位账号，返回用户码与验证地址。 */
    async start(provider) {
      const flow = FLOWS[provider]
      if (flow === undefined) return { error: `该渠道没有设备码登录：${provider}` }
      const started = await flow.start({ fetch: fetchImpl })
      if (started.error !== undefined) return started
      const account = accounts.create(provider)
      pending.set(account.id, {
        provider,
        state: started.state,
        intervalMs: started.intervalMs,
        startedAt: Date.now(),
        // 上游自己会给有效期；缺省按 15 分钟算，避免状态永不清理。
        expiresInMs: (started.expiresIn ?? 900) * 1000,
      })
      return {
        accountId: account.id,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        verificationUriComplete: started.verificationUriComplete,
        intervalMs: started.intervalMs,
        expiresIn: started.expiresIn,
        // 扫码型渠道（AStudio）：没有用户码，面板要画**二维码图片**而不是一行验证码。
        ...started.qr === true ? { qr: true } : {},
      }
    },

    /**
     * 轮询一次。`authorized` 时才写凭据、回填账号。
     *
     * @returns `{done, success?, nickname?, error?, status?, intervalMs?}` ——
     *   `done:false` 表示还没好，面板继续轮询（与渠道包 `login.poll` 同语义）。
     */
    async poll(accountId) {
      const flow = pending.get(accountId)
      if (flow === undefined) return { done: true, success: false, error: '登录流程不存在或已结束，请重新发起' }
      if (Date.now() - flow.startedAt > flow.expiresInMs) {
        pending.delete(accountId)
        // The placeholder row has no credential and can never get one; leaving it
        // shows a permanent "待登录" account until the next process restart.
        await dropAccount(accountId)
        return { done: true, success: false, error: '登录等待超时，请重新发起' }
      }
      const polled = await FLOWS[flow.provider].poll(flow.state, { fetch: fetchImpl })
      if (polled.status === 'authorized') {
        await accounts.attach(accountId, {
          ...polled.credential,
          ...polled.nickname === undefined ? {} : { nickname: polled.nickname },
        }, {
          ...polled.nickname === undefined ? {} : { nickname: polled.nickname },
          ...polled.expiresAt === undefined ? {} : { expiresAt: polled.expiresAt },
        })
        pending.delete(accountId)
        return { done: true, success: true, ...polled.nickname === undefined ? {} : { nickname: polled.nickname } }
      }
      if (polled.status === 'denied' || polled.status === 'expired' || polled.status === 'completed' || polled.status === 'error') {
        pending.delete(accountId)
        await dropAccount(accountId)
        return {
          done: true,
          success: false,
          error: polled.error ?? (polled.status === 'completed' ? '授权码已被取走，请重新发起登录' : '授权已拒绝或已过期'),
        }
      }
      // pending / slow_down / unknown：还没好，面板继续轮询。
      return { done: false, status: polled.status, intervalMs: flow.intervalMs }
    },

    cancel(accountId) {
      const existed = pending.delete(accountId)
      // Cancel leaves the same kind of orphan as a timeout: drop the placeholder
      // too. Fire-and-forget keeps the route's synchronous contract (the panel
      // only needs the boolean), and a failed delete is retried by prunePending.
      if (existed) void dropAccount(accountId)
      return existed
    },
  }
}
