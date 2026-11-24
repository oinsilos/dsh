/**
 * MonkeyCode（国内 `monkeycode` / 国际 `monkeycodeintl`）的账号、钱包与签到协议。
 *
 * ## 凭证是**三件套**（不是一把 Key）
 *
 * | 字段 | 用途 | 来源 |
 * | --- | --- | --- |
 * | `api_key` | 模型网关 Bearer | 平台 `POST /api/v1/users/ohmyagent/api-keys`（body `{}`，Cookie 认证） |
 * | `signing_secret` | 网关 `X-OhmyAgent-Signature: v1=HMAC-SHA256(secret, prompt)` | 同上 |
 * | `session_cookie` | 平台 API（积分 / 额度 / 签到） | 浏览器登录后的 `monkeycode_ai_session`（**HttpOnly**，`document.cookie` 读不到） |
 *
 * ⚠️ 缺 cookie 的账号查得到额度却签到不了；缺 api_key 的账号完全不能推理 ——
 * 故浏览器登录必须**两样一起收**，只收一样就是半份凭据。
 *
 * ## 签到要过 Cap 人机验证
 *
 * `challenge → cap-pow 本地求解 → redeem → checkin(captcha_token)`，四步缺一不可；
 * 求解算法在 `src/channels/cap-pow.js`（与本文件同一套判据的来源）。
 *
 * ## 目录没有远端来源
 *
 * 网关 `GET /v1/models` 实测 **405**，平台侧目录要 cookie ⇒ 目录只能是内置常量，
 * 上游加模型后需手工同步。
 *
 * @module src/channels/monkeycode.js
 */

export const MONKEYCODE_PRODUCTS = Object.freeze({
  monkeycode: Object.freeze({
    id: 'monkeycode',
    displayName: 'MonkeyCode',
    gatewayBase: 'https://proxy.monkeycode-ai.com/v1',
    platformBase: 'https://monkeycode-ai.com',
    messagesPath: '/messages',
    walletPath: '/api/v1/users/wallet',
    checkinPath: '/api/v1/users/wallet/checkin',
    captchaChallengePath: '/api/v1/public/captcha/challenge',
    captchaRedeemPath: '/api/v1/public/captcha/redeem',
    apiKeysPath: '/api/v1/users/ohmyagent/api-keys',
    sessionCookieName: 'monkeycode_ai_session',
  }),
  monkeycodeintl: Object.freeze({
    id: 'monkeycodeintl',
    displayName: 'MonkeyCode 国际版',
    gatewayBase: 'https://proxy.monkeycode-ai.net/v1',
    platformBase: 'https://monkeycode-ai.net',
    messagesPath: '/messages',
    walletPath: '/api/v1/users/wallet',
    checkinPath: '/api/v1/users/wallet/checkin',
    captchaChallengePath: '/api/v1/public/captcha/challenge',
    captchaRedeemPath: '/api/v1/public/captcha/redeem',
    apiKeysPath: '/api/v1/users/ohmyagent/api-keys',
    sessionCookieName: 'monkeycode_ai_session',
  }),
})

export const MONKEYCODE_MAX_CONTEXT = 1_048_576
export const MONKEYCODE_MAX_OUTPUT_TOKENS = 128_000

/**
 * 目录（**全量事实**，没有远端来源：网关 `/v1/models` 回 405）。
 * `monkeycode-<plan>/` 前缀是额度档位，与按积分计费的裸 id 是不同条目。
 */
export const MONKEYCODE_MODELS = Object.freeze([
  { id: 'monkeycode-basic/deepseek-flash', name: 'DeepSeek Flash（basic 额度）' },
  { id: 'monkeycode-basic/deepseek-v4-flash', name: 'DeepSeek V4 Flash（basic 额度）' },
  { id: 'monkeycode-pro/deepseek-flash', name: 'DeepSeek Flash（pro 额度）' },
  { id: 'monkeycode-pro/deepseek-v4-pro', name: 'DeepSeek V4 Pro（pro 额度）' },
  { id: 'monkeycode-ultra/deepseek-v4-pro', name: 'DeepSeek V4 Pro（ultra 额度）' },
  { id: 'deepseek-flash', name: 'DeepSeek Flash（按积分计费）' },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash（按积分计费）' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro（按积分计费）' },
])

export function monkeycodeProductOf(provider) {
  const key = String(provider ?? '')
  return Object.prototype.hasOwnProperty.call(MONKEYCODE_PRODUCTS, key) ? MONKEYCODE_PRODUCTS[key] : null
}

/** 目录行（带能力上限）。 */
export function monkeycodeCatalogRows() {
  return MONKEYCODE_MODELS.map(model => ({
    id: model.id,
    name: model.name,
    contextWindow: MONKEYCODE_MAX_CONTEXT,
    maxOutput: MONKEYCODE_MAX_OUTPUT_TOKENS,
    vision: false,
    reasoning: true,
  }))
}

/** 凭据里的会话 cookie（缺失即签到不可用）。 */
export function monkeycodeCookieOf(credential) {
  const value = credential?.session_cookie
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 平台 API 的请求头：**Cookie 认证**，不是 Bearer。 */
export function monkeycodePlatformHeaders(credential) {
  const cookie = monkeycodeCookieOf(credential)
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...cookie === undefined ? {} : { cookie },
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  }
}

/**
 * 网关签名：`v1=HMAC-SHA256(signing_secret, prompt)`。
 *
 * ⚠️ 签名对象是**提示词正文**（不是整份 JSON）；我们按「最后一条 user 文本」签，
 * 与本模块的推理体组装口径一致。这条腿未在真机逐字节核对，代码里如实标注。
 */
export function monkeycodeSignature(signingSecret, prompt) {
  if (typeof signingSecret !== 'string' || signingSecret === '') return ''
  return `v1=${cryptoHmac(signingSecret, String(prompt ?? ''))}`
}

import crypto from 'node:crypto'
const cryptoHmac = (key, text) => crypto.createHmac('sha256', key).update(text, 'utf8').digest('hex')

/** 一次平台调用（解 `{code, data}` 信封）。 */
async function platform(product, credential, path, init, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  let response
  try {
    response = await fetchImpl(`${product.platformBase}${path}`, {
      method: init.method ?? 'GET',
      headers: monkeycodePlatformHeaders(credential),
      ...init.body === undefined ? {} : { body: JSON.stringify(init.body) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { ok: false, status: 0, error: `平台接口请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const raw = await response.text().catch(() => '')
  let payload
  try { payload = raw === '' ? undefined : JSON.parse(raw) } catch { payload = undefined }
  if (!response.ok) {
    return { ok: false, status: response.status, error: `平台接口返回 HTTP ${response.status}${raw === '' ? '' : `：${raw.slice(0, 120)}`}` }
  }
  if (payload === undefined) return { ok: false, status: response.status, error: '平台响应不是 JSON' }
  return { ok: true, status: response.status, envelope: payload }
}

/** 剥信封：`{code:0, data}`；非 0 视为失败。 */
export function unwrapMonkeycodeEnvelope(payload) {
  if (payload === null || typeof payload !== 'object') return { ok: false, error: '响应不是对象' }
  const code = typeof payload.code === 'number' ? payload.code : Number(payload.code)
  if (Number.isFinite(code) && code !== 0) return { ok: false, code, error: String(payload.message ?? payload.msg ?? `业务码 ${code}`) }
  return { ok: true, data: payload.data ?? payload }
}

/**
 * 钱包：`balance` 是**毫**（÷1000），缺失必须判失败、不得回落 0。
 */
export async function fetchMonkeycodeWallet(credential, product = MONKEYCODE_PRODUCTS.monkeycode, { fetch: fetchImpl = fetch } = {}) {
  const result = await platform(product, credential, product.walletPath, {}, { fetchImpl })
  if (!result.ok) return { ok: false, error: result.error }
  const unwrapped = unwrapMonkeycodeEnvelope(result.envelope)
  if (!unwrapped.ok) return { ok: false, error: unwrapped.error }
  const balance = typeof unwrapped.data.balance === 'number' ? unwrapped.data.balance
    : (typeof unwrapped.data.balance === 'string' && unwrapped.data.balance.trim() !== '' ? Number(unwrapped.data.balance) : undefined)
  if (balance === undefined || !Number.isFinite(balance)) return { ok: false, error: '钱包报文里没有 balance 字段（上游形态可能已变）' }
  const daily = unwrapped.data.daily_token_balance
  return {
    ok: true,
    wallet: {
      balance: Math.round((balance / 1000) * 1000) / 1000,
      unit: 'credit',
      ...typeof daily === 'number' && Number.isFinite(daily) ? { dailyTokenBalance: daily } : {},
    },
  }
}

/**
 * 用网页会话 Cookie 签发网关凭据（`POST /api/v1/users/ohmyagent/api-keys`，body `{}`）。
 *
 * ⚠️ `api_key` 与 `signing_secret` 是**两个独立的东西**：少了后者，每个网关请求
 * 都会 403 `invalid ohmyagent request`。
 */
export async function issueMonkeycodeKey(credential, product = MONKEYCODE_PRODUCTS.monkeycode, { fetch: fetchImpl = fetch } = {}) {
  if (monkeycodeCookieOf(credential) === undefined) return { error: '没有网页会话 Cookie（请先浏览器登录）' }
  const result = await platform(product, credential, product.apiKeysPath, { method: 'POST', body: {} }, { fetchImpl })
  if (!result.ok) return { error: result.error }
  const unwrapped = unwrapMonkeycodeEnvelope(result.envelope)
  if (!unwrapped.ok) return { error: unwrapped.error }
  const data = unwrapped.data
  const apiKey = typeof data.api_key === 'string' && data.api_key !== '' ? data.api_key : undefined
  const signingSecret = typeof data.signing_secret === 'string' && data.signing_secret !== '' ? data.signing_secret : undefined
  if (apiKey === undefined) return { error: '签发凭据失败：响应里没有 api_key' }
  if (signingSecret === undefined) return { error: '签发凭据失败：响应里没有 signing_secret（缺它每个网关请求都会 403）' }
  return { credential: { ...credential, api_key: apiKey, signing_secret: signingSecret, provider: product.id } }
}

/** 从 CDP cookie 列表里取平台会话 cookie 串（`name=value`）。 */
export function sessionCookieOf(cookies, product = MONKEYCODE_PRODUCTS.monkeycode) {
  const list = Array.isArray(cookies) ? cookies : []
  const hit = list.find(cookie => cookie?.name === product.sessionCookieName)
  if (hit === undefined || typeof hit.value !== 'string' || hit.value === '') return undefined
  return `${product.sessionCookieName}=${hit.value}`
}

/** 签到状态：`GET /wallet/checkin` → `{checked_in}`。 */
export async function fetchMonkeycodeCheckin(credential, product = MONKEYCODE_PRODUCTS.monkeycode, { fetch: fetchImpl = fetch } = {}) {
  const result = await platform(product, credential, product.checkinPath, {}, { fetchImpl })
  if (!result.ok) return { error: result.error }
  const unwrapped = unwrapMonkeycodeEnvelope(result.envelope)
  if (!unwrapped.ok) return { error: unwrapped.error }
  return { todayCheckedIn: unwrapped.data.checked_in === true }
}

/**
 * 一键签到：`challenge → 本地求解 → redeem → checkin(captcha_token)`。
 *
 * ⚠️ 每一步失败给**不同**文案（用户动作完全不同）：题解不出来 ⇒ 上游改版；
 * redeem 失败 ⇒ 验证过期（重试）；checkin 失败 ⇒ 上游拒绝（看原文）。
 * 笼统成「签到失败」等于零线索。
 */
export async function claimMonkeycodeCheckin(credential, product = MONKEYCODE_PRODUCTS.monkeycode, { fetch: fetchImpl = fetch } = {}) {
  if (monkeycodeCookieOf(credential) === undefined) {
    return { kind: 'failed', message: '未配置会话（session_cookie）—— 签到只认网页登录态，请用「浏览器登录」添加账号' }
  }
  const status = await fetchMonkeycodeCheckin(credential, product, { fetch: fetchImpl })
  if (status.todayCheckedIn === true) return { kind: 'already-claimed', message: '今天已经签到过了' }
  const before = await fetchMonkeycodeWallet(credential, product, { fetch: fetchImpl })

  const challengeResult = await platform(product, credential, product.captchaChallengePath, { method: 'POST', body: {} }, { fetchImpl })
  if (!challengeResult.ok) return { kind: 'failed', message: `获取签到验证题失败：${challengeResult.error}` }
  // ⚠️ 必须先剥信封：直接把原始报文交给 readCapChallenge 会被判成「没有 token」，
  //    签到永远失败且文案指向「上游改版」，排查方向完全跑偏。
  const challengeEnvelope = unwrapMonkeycodeEnvelope(challengeResult.envelope)
  if (!challengeEnvelope.ok) return { kind: 'failed', message: `获取签到验证题失败：${challengeEnvelope.error}` }
  const challenge = readCapChallenge(challengeEnvelope.data)
  if (challenge.error !== undefined) return { kind: 'failed', message: challenge.error }

  let solutions
  try {
    solutions = await solveChallengeYielding(challenge.token, challenge.challenge)
  } catch (error) {
    return { kind: 'failed', message: `签到验证题求解失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const redeemResult = await platform(product, credential, product.captchaRedeemPath, {
    method: 'POST', body: { token: challenge.token, solutions },
  }, { fetchImpl })
  if (!redeemResult.ok) return { kind: 'failed', message: `提交签到验证答案失败：${redeemResult.error}` }
  const redeemEnvelope = unwrapMonkeycodeEnvelope(redeemResult.envelope)
  if (!redeemEnvelope.ok) return { kind: 'failed', message: `提交签到验证答案失败：${redeemEnvelope.error}` }
  const captchaToken = readCapToken(redeemEnvelope.data)
  if (captchaToken === undefined) {
    return { kind: 'failed', message: '签到验证没有通过（redeem 响应里没有 token）—— 可能是验证题已过期，请重试一次' }
  }

  const checkinResult = await platform(product, credential, product.checkinPath, {
    method: 'POST', body: { captcha_token: captchaToken },
  }, { fetchImpl })
  if (!checkinResult.ok) return { kind: 'failed', message: `签到失败：${checkinResult.error}` }

  // 奖励金额：响应里有就用；没有就求「签到前后余额差」（真机为 +100）。
  const checkinEnvelope = unwrapMonkeycodeEnvelope(checkinResult.envelope)
  const responseCredit = checkinEnvelope.ok ? readReward(checkinEnvelope.data) : undefined
  let credited = responseCredit
  if (credited === undefined && before.ok === true) {
    const after = await fetchMonkeycodeWallet(credential, product, { fetch: fetchImpl })
    if (after.ok === true) {
      const delta = Math.round((after.wallet.balance - before.wallet.balance) * 1000) / 1000
      if (delta > 0) credited = delta
    }
  }
  // ⚠️ 拿不到正数时**不编造** 100，如实标注「已签到，奖励未知」。
  return credited === undefined
    ? { kind: 'claimed', message: '已签到（上游未下发奖励金额，且余额差读不到）' }
    : { kind: 'claimed', credit: credited, message: `已签到 +${credited}` }
}

/** 从签到响应里读奖励金额（不同版本/站点字段名不同）。 */
function readReward(data) {
  if (data === null || typeof data !== 'object') return undefined
  for (const key of ['credit', 'credits', 'reward', 'reward_credit', 'amount', 'points']) {
    const value = data[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return undefined
}

/** 权益扩展：钱包 + 签到（目录是静态常量）。 */
export function createMonkeycodeExtras({ product = MONKEYCODE_PRODUCTS.monkeycode, credentialOf, fetch: fetchImpl = fetch } = {}) {
  async function statusOf(account) {
    const base = { accountId: typeof account?.id === 'string' ? account.id : '', nickname: typeof account?.nickname === 'string' ? account.nickname : '' }
    const credential = await credentialOf(account)
    const catalog = monkeycodeCatalogRows()
    if (credential === null) return { ...base, catalog, error: '凭据不可用（需要重新登录）', source: 'static' }
    const [wallet, checkin] = await Promise.all([
      fetchMonkeycodeWallet(credential, product, { fetch: fetchImpl }),
      fetchMonkeycodeCheckin(credential, product, { fetch: fetchImpl }),
    ])
    return {
      ...base,
      catalog,
      source: 'static',
      ...wallet.ok === true ? { balance: wallet.wallet } : { balanceError: wallet.error },
      ...checkin.todayCheckedIn === undefined ? {} : { checkin: { todayCheckedIn: checkin.todayCheckedIn, streakDays: 0, todayCredit: 0 } },
    }
  }

  async function claim(account) {
    const credential = await credentialOf(account)
    if (credential === null) return { kind: 'failed', message: '凭据不可用（需要重新登录）' }
    return claimMonkeycodeCheckin(credential, product, { fetch: fetchImpl })
  }

  return { statusOf, claim }
}

import { readCapChallenge, readCapToken, solveChallengeYielding } from './cap-pow.js'
