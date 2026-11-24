/**
 * 百智云（`baizhi`）的账号、积分与签到协议。
 *
 * ## 凭证：网页 cookie → `sk-` Key 两段
 *
 * 控制台只有 cookie 登录态（`baizhi_session` + `sl-session`），**拿不到** `sk-`；
 * 推理 Key 必须用 cookie 到 `/api/console/api-keys` 现场换（`sk-` 开头的长期静态 Key）。
 * ⇒ 凭据里同时存 `session_cookie`（查积分/签到）与 `api_key`（推理）。
 *
 * ⚠️ 换 Key 时若 `baizhi_session` 已写入但服务端登录态尚未生效，会回 401/403 ——
 * 那是「还没生效」，应隔几秒重试，不是凭据错。
 *
 * ## 输出预算：**必须按模型夹取**（否则长回答被静默截断）
 *
 * 实测服务级：`max_tokens=100000` 可成功；Qwen 系回
 * `Range of max_tokens should be [1, 65536]`，Qwen-Flash 是 `[1, 32768]`。
 * 目录条目不声明 `maxTokens` ⇒ 宿主用 4096 兜底 ⇒ 思考一长正文零字。
 * 故 `baizhiMaxOutputTokensFor()` 是**唯一**夹取点，别处不得再夹第二遍
 * （两处互为掩码，删任一处都测不出来）。
 *
 * ## 每日临时积分
 *
 * `POST /api/v1/user/wallet/daily-temporary-credit`，body `{captcha_token}`；
 * `claimed:false` = **当日已领过**（不是失败）；`amount_credit_cents` 是分（10000 ⇒ 100 积分）。
 * 人机验证与 MonkeyCode 同一套 Cap 协议（`src/channels/cap-pow.js`）。
 *
 * @module src/channels/baizhi.js
 */

export const BAIZHI = Object.freeze({
  id: 'baizhi',
  displayName: '百智云',
  baseUrl: 'https://ai-models.app.baizhi.cloud/api/anthropic',
  messagesPath: '/v1/messages',
  modelsPath: '/v1/models',
  platformBase: 'https://baizhi.cloud',
  consoleBase: 'https://ai-models.app.baizhi.cloud',
  walletBalancePath: '/api/v1/user/wallet/balance',
  walletUsagePath: '/api/v1/user/wallet/app-credit-usage',
  profilePath: '/api/v1/user/profile',
  dailyCreditPath: '/api/v1/user/wallet/daily-temporary-credit',
  captchaChallengePath: '/api/v1/public/captcha/challenge',
  captchaRedeemPath: '/api/v1/public/captcha/redeem',
  apiKeysPath: '/api/console/api-keys',
})

/** 服务级硬上限（实测 400 原文：`maximum context length is 1048576 tokens`）。 */
export const BAIZHI_MAX_CONTEXT = 1_048_576
/** 单次输出默认上限（`max_tokens=100000` 实测可成功）。 */
export const BAIZHI_MAX_OUTPUT_TOKENS = 100_000
export const BAIZHI_QWEN_MAX_OUTPUT_TOKENS = 65_536
export const BAIZHI_QWEN_FLASH_MAX_OUTPUT_TOKENS = 32_768
/** 每日临时积分（实测 `amount_credit_cents: 10000` ⇒ 100 积分）。 */
export const BAIZHI_DAILY_CREDIT_TOTAL = 100

/**
 * 按模型夹取单次输出上限 —— **唯一**夹取点。
 *
 * 大小写不敏感（上游把 `Qwen3.6-Plus` 写成首字母大写时，精确比较会静默回落 100,000 ⇒ 400）。
 */
export function baizhiMaxOutputTokensFor(modelId) {
  const id = String(modelId ?? '').toLowerCase()
  if (id.includes('qwen') && id.includes('flash')) return BAIZHI_QWEN_FLASH_MAX_OUTPUT_TOKENS
  if (id.includes('qwen')) return BAIZHI_QWEN_MAX_OUTPUT_TOKENS
  return BAIZHI_MAX_OUTPUT_TOKENS
}

/** 平台 API 头：Cookie 认证。 */
export function baizhiPlatformHeaders(credential) {
  const cookie = typeof credential?.session_cookie === 'string' ? credential.session_cookie : ''
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...cookie === '' ? {} : { cookie },
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  }
}

/** 推理头：`x-api-key`（`sk-`）。 */
export function baizhiInferenceHeaders(credential) {
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    'x-api-key': String(credential?.api_key ?? ''),
    'anthropic-version': '2023-06-01',
  }
}

async function platformCall(path, init, credential, { fetchImpl = fetch, base = BAIZHI.platformBase, timeoutMs = 20_000 } = {}) {
  let response
  try {
    response = await fetchImpl(`${base}${path}`, {
      method: init.method ?? 'GET',
      headers: baizhiPlatformHeaders(credential),
      ...init.body === undefined ? {} : { body: JSON.stringify(init.body) },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { ok: false, status: 0, error: `网络失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const raw = await response.text().catch(() => '')
  let payload
  try { payload = raw === '' ? undefined : JSON.parse(raw) } catch { payload = undefined }
  if (!response.ok) return { ok: false, status: response.status, error: `HTTP ${response.status}：${raw.slice(0, 120) || '空响应'}` }
  if (payload === undefined) return { ok: false, status: response.status, error: '响应不是 JSON' }
  const code = typeof payload.code === 'number' ? payload.code : Number(payload.code)
  if (Number.isFinite(code) && code !== 0) return { ok: false, code, error: String(payload.message ?? payload.msg ?? `业务码 ${code}`) }
  return { ok: true, data: payload.data ?? payload }
}

/** 网页登录态 → `sk-` Key。401/403 视为「登录态还没生效」（调用方可重试）。 */
export async function exchangeBaizhiKey(credential, { fetch: fetchImpl = fetch } = {}) {
  const result = await platformCall(BAIZHI.apiKeysPath, { method: 'POST', body: {} }, credential, { fetchImpl, base: BAIZHI.consoleBase })
  if (!result.ok) return { error: result.error, ...result.status === 401 || result.status === 403 ? { notEffective: true } : {} }
  const key = typeof result.data.api_key === 'string' && result.data.api_key !== '' ? result.data.api_key : undefined
  if (key === undefined) return { error: '换 Key 失败：响应里没有 api_key' }
  return { credential: { ...credential, api_key: key, provider: BAIZHI.id } }
}

/** 余额 + 今日是否已领临时积分。 */
export async function fetchBaizhiWallet(credential, { fetch: fetchImpl = fetch } = {}) {
  const result = await platformCall(BAIZHI.walletBalancePath, {}, credential, { fetchImpl })
  if (!result.ok) return { error: result.error }
  const cents = result.data.balance_credit_cents
  const balance = typeof cents === 'number' && Number.isFinite(cents) ? Math.round(cents) / 100
    : (typeof cents === 'string' && cents.trim() !== '' && Number.isFinite(Number(cents)) ? Number(cents) / 100 : undefined)
  if (balance === undefined) return { error: '余额报文里没有 balance_credit_cents（上游可能改版）' }
  return { balance: { total: balance, unit: 'credit' }, dailyClaimed: result.data.daily_temporary_credit_claimed === true }
}

/**
 * 领取每日临时积分：`challenge → cap-pow → redeem → daily-temporary-credit`。
 *
 * ⚠️ `claimed:false` 是**当日已领过**（成功语义），不是失败。
 */
export async function claimBaizhiDailyCredit(credential, { fetch: fetchImpl = fetch } = {}) {
  const challengeResult = await platformCall(BAIZHI.captchaChallengePath, { method: 'POST', body: {} }, credential, { fetchImpl })
  if (!challengeResult.ok) return { kind: 'failed', message: `获取验证题失败：${challengeResult.error}` }
  const challenge = readCapChallenge(challengeResult.data)
  if (challenge.error !== undefined) return { kind: 'failed', message: challenge.error }
  let solutions
  try {
    solutions = await solveChallengeYielding(challenge.token, challenge.challenge)
  } catch (error) {
    return { kind: 'failed', message: `验证题求解失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const redeemResult = await platformCall(BAIZHI.captchaRedeemPath, { method: 'POST', body: { token: challenge.token, solutions } }, credential, { fetchImpl })
  if (!redeemResult.ok) return { kind: 'failed', message: `提交验证答案失败：${redeemResult.error}` }
  const captchaToken = readCapToken(redeemResult.data)
  if (captchaToken === undefined) return { kind: 'failed', message: '验证没有通过（redeem 响应里没有 token）—— 可能已过期，请重试' }

  const claimResult = await platformCall(BAIZHI.dailyCreditPath, { method: 'POST', body: { captcha_token: captchaToken } }, credential, { fetchImpl })
  if (!claimResult.ok) return { kind: 'failed', message: `领取失败：${claimResult.error}` }
  if (claimResult.data.claimed !== true) return { kind: 'already-claimed', message: '今日已领取临时积分' }
  const cents = claimResult.data.amount_credit_cents
  const credit = typeof cents === 'number' && Number.isFinite(cents) ? Math.round(cents) / 100 : BAIZHI_DAILY_CREDIT_TOTAL
  return { kind: 'claimed', credit, message: `已领取 ${credit} 积分` }
}

/** 目录：`GET {baseUrl}/v1/models`（失败交调用方走兜底）。 */
export async function fetchBaizhiModels(credential, { fetch: fetchImpl = fetch } = {}) {
  let response
  try {
    response = await fetchImpl(`${BAIZHI.baseUrl}${BAIZHI.modelsPath}`, {
      headers: baizhiInferenceHeaders(credential), signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    return { error: `目录请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const raw = await response.text().catch(() => '')
  if (!response.ok) return { error: `目录返回 HTTP ${response.status}` }
  let payload
  try { payload = JSON.parse(raw) } catch { return { error: '目录响应不是 JSON' } }
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
  const out = []
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    if (id === '') continue
    out.push({
      id,
      name: typeof row?.display_name === 'string' && row.display_name !== '' ? row.display_name : id,
      contextWindow: BAIZHI_MAX_CONTEXT,
      // 目录不声明 maxTokens ⇒ 这里**按模型**补上夹取值，别处不再夹第二遍。
      maxOutput: baizhiMaxOutputTokensFor(id),
      vision: Array.isArray(row?.input_modalities) ? row.input_modalities.includes('image') : false,
      reasoning: true,
    })
  }
  return out.length === 0 ? { error: '目录响应里没有可识别的模型' } : { rows: out }
}

/** 权益扩展：余额 + 每日临时积分（目录走远端 `/v1/models`，失败交调用方兜底）。 */
export function createBaizhiExtras({ credentialOf, fetch: fetchImpl = fetch } = {}) {
  async function statusOf(account) {
    const base = { accountId: typeof account?.id === 'string' ? account.id : '', nickname: typeof account?.nickname === 'string' ? account.nickname : '' }
    const credential = await credentialOf(account)
    if (credential === null) return { ...base, error: '凭据不可用（需要重新登录）' }
    const [wallet, models] = await Promise.all([
      fetchBaizhiWallet(credential, { fetch: fetchImpl }),
      fetchBaizhiModels(credential, { fetch: fetchImpl }),
    ])
    return {
      ...base,
      source: models.rows === undefined ? 'static' : 'live',
      ...models.rows === undefined ? { catalogError: models.error } : { catalog: models.rows },
      ...wallet.balance === undefined ? { balanceError: wallet.error } : { balance: wallet.balance, checkin: { todayCheckedIn: wallet.dailyClaimed === true, streakDays: 0, todayCredit: 0 } },
    }
  }

  async function claim(account) {
    const credential = await credentialOf(account)
    if (credential === null) return { kind: 'failed', message: '凭据不可用（需要重新登录）' }
    return claimBaizhiDailyCredit(credential, { fetch: fetchImpl })
  }

  return { statusOf, claim }
}

import { readCapChallenge, readCapToken, solveChallengeYielding } from './cap-pow.js'
