/**
 * 短信验证码登录（目前只有 AutoClaw 用它）。
 *
 * 与设备码（`device-login.js`）的差别：没有「等用户授权」这一段 —— 用户填完验证码
 * 就一次请求换到凭据，因此它是**单步**的，不需要流程容器。验证码本身**不落盘**：
 * 它是一次性凭据，只在这一次调用的参数里存在。
 *
 * @module src/channels/sms-login.js
 */

import { loginWithCode, sendCode } from './autoclaw.js'

/** 由 provider 决定用哪套短信协议（新增渠道在这里加一行）。 */
const SMS_PROVIDERS = {
  autoclaw: 'cn',
  autoclawintl: 'intl',
}

export function createSmsLogin({ accounts, fetch: fetchImpl = fetch } = {}) {
  const productOf = provider => SMS_PROVIDERS[provider]

  return {
    supports(provider) {
      return typeof productOf(provider) === 'string'
    },

    /** 发验证码。手机号本地先校验（不白打一次请求）。 */
    async send(provider, phone) {
      const product = productOf(provider)
      if (product === undefined) return { error: `该渠道没有短信登录：${provider}` }
      return sendCode(phone, { fetch: fetchImpl, product })
    },

    /**
     * 验证码登录：成功即写凭据 + 建账号（或回填已存在的同号账号）。
     *
     * 「回填」的分支是为了重复登录同一个手机号时**不产生第二个账号** ——
     * 账号表里 nickname 相同的旧条目会被复用（`OFM_*` ref 也随之复用）。
     */
    async login(provider, phone, code) {
      const product = productOf(provider)
      if (product === undefined) return { error: `该渠道没有短信登录：${provider}` }
      const result = await loginWithCode(phone, code, { fetch: fetchImpl, product })
      if (result.error !== undefined) return result
      const nickname = result.nickname ?? phone
      const existing = accounts.list(provider).find(entry => entry.nickname === nickname)
      const account = existing ?? accounts.create(provider, { nickname })
      const expiresAt = Number(result.credential?.expires_at)
      await accounts.attach(account.id, result.credential, {
        ...existing === undefined ? { nickname } : {},
        // 到期时间必须写回账号表：面板的「有效期」和续期闸门都读这个字段，
        // 只写在凭据里等于界面永远显示「永久」。
        ...Number.isFinite(expiresAt) && expiresAt > 0 ? { expiresAt } : {},
      })
      return {
        accountId: account.id,
        nickname,
        ...Number.isFinite(expiresAt) && expiresAt > 0 ? { expiresAt } : {},
      }
    },
  }
}