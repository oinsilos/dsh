/**
 * Magicrew（超级麦吉 `magicrew` / 国际站 `magicrewintl`）的账号、积分与签到协议。
 *
 * ## 三层凭证（各管一段，别混）
 *
 * | 层 | 寿命 | 用途 | 怎么来 |
 * | --- | --- | --- | --- |
 * | 网页 JWT | 30 天 | 业务 API（目录 / 积分 / 签到） | 浏览器登录后从 localStorage 读 |
 * | `mgw_` api_key | **2 小时** | 模型网关（推理） | `POST /api/v1/model-gateway/tokens` |
 * | refresh_token | 7 天，**一次性轮换** | 换 api_key | 同一个端点的 `PUT` |
 *
 * ## 四条硬约束（都是真实事故换来的）
 *
 * 1. **签新 key 会吊销旧 key** ⇒ 只在「登录」与「续期」两个入口签发，**绝不在推理热路径**。
 * 2. **`refresh_token` 只能有一个出口** ⇒ 只允许本模块的 `refreshGatewayKey` 持有，
 *    别处不得自持第二份（分叉的后果是两处 token 不一致、用户莫名掉登录）。
 * 3. **`origin` 与 `referer` 都是硬要求**：同一套头只差 `referer: <webOrigin>/`
 *    就是 `403 空 body ⇄ 200`（WAF 认 referer）。漏了它的症状是「登录成功但昵称恒回落、
 *    gateway key 恒签发失败」两条 warn，而不是明确的鉴权错误。
 * 4. **两站是独立 provider**：账号体系物理隔离、host 不同、国际站**强制 org**
 *    （业务 API 缺 `organization-code` 回 `{code:2182}`）。只差 6 个字段 ⇒ 一套实现。
 *
 * ## 签到
 *
 * `POST /api/v1/login-gift`，**请求体存在且为空串**（不是 `{}`、不是没有）。
 * 幂等判据是 `granted`：`!== true` ⇒ `already-claimed`（今天已领），不是失败。
 * 新手任务在另一个域（`/api/v1/onboarding/tasks`），每号一辈子一次。
 *
 * @module src/channels/magicrew.js
 */

import crypto from 'node:crypto'

/** 两站产品表（新增站点只加一行）。 */
export const MAGICREW_PRODUCTS = Object.freeze({
  magicrew: Object.freeze({
    id: 'magicrew',
    displayName: '超级麦吉',
    site: 'cn',
    host: 'https://i-magic-service.letsmagic.cn',
    webOrigin: 'https://www.letsmagic.cn',
    /** 国内站缺 org 仍 200；国际站缺了业务 API 回 2182。 */
    needsOrg: false,
    loginHint: '手机号 / 短信验证码',
    dailyGift: 200,
  }),
  magicrewintl: Object.freeze({
    id: 'magicrewintl',
    displayName: 'MagiCrew',
    site: 'intl',
    host: 'https://magic-service.magicrew.ai',
    webOrigin: 'https://www.magicrew.ai',
    needsOrg: true,
    loginHint: '邮箱 / OAuth',
    dailyGift: 50,
  }),
})

export const MAGICREW_GATEWAY_TOKENS_PATH = '/api/v1/model-gateway/tokens'
export const MAGICREW_MODELS_PATH = '/api/v1/flows/models'
export const MAGICREW_POINTS_PATH = '/api/v1/quota/points/total'
export const MAGICREW_LOGIN_GIFT_PATH = '/api/v1/login-gift'
export const MAGICREW_ONBOARDING_TASKS_PATH = '/api/v1/onboarding/tasks'

/** 官方网页的 UA（WAF 按 UA/来源判，改成自定义值会 403）。 */
export const MAGICREW_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'

/** 业务信封里的成功码。 */
const MAGICREW_OK_CODE = 1000

/** 兜底目录（远端 `/api/v1/flows/models` 失败时用；顺序照抄上游）。 */
export const MAGICREW_FALLBACK_MODELS = Object.freeze([
  { id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 204_800 },
  { id: 'glm-4.6', name: 'GLM 4.6', contextWindow: 204_800 },
  { id: 'glm-4.5', name: 'GLM 4.5', contextWindow: 131_072 },
  { id: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash', contextWindow: 1_048_576, vision: true },
  { id: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro', contextWindow: 1_048_576 },
  { id: 'doubao-seed-2.0-pro', name: 'Seed 2.0 Pro', contextWindow: 256_000, vision: true },
  { id: 'doubao-seed-2.0-code', name: 'Seed 2.0 Code', contextWindow: 256_000, vision: true },
  { id: 'doubao-seed-2.0-lite', name: 'Seed 2.0 Lite', contextWindow: 256_000, vision: true },
])

export function magicrewProductOf(provider) {
  const key = String(provider ?? '')
  return Object.prototype.hasOwnProperty.call(MAGICREW_PRODUCTS, key) ? MAGICREW_PRODUCTS[key] : null
}

/**
 * 业务/网关请求头。
 *
 * ⚠️ `referer` 的**尾斜杠**是照浏览器真实请求抄的：WAF 按它判来源，缺了直接 403 空 body。
 */
export function magicrewHeaders(product, { token, organizationCode, accept = 'application/json' } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept,
    'user-agent': MAGICREW_USER_AGENT,
    origin: product.webOrigin,
    referer: `${product.webOrigin}/`,
  }
  if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`
  if (typeof organizationCode === 'string' && organizationCode !== '') headers['organization-code'] = organizationCode
  return headers
}

/** 一次业务调用：解信封 `{code, data}`，非 1000 抛可读错误。 */
async function call({ url, method = 'GET', headers, body, fetch: fetchImpl = fetch, timeoutMs = 30_000 }) {
  let response
  try {
    response = await fetchImpl(url, { method, headers, ...body === undefined ? {} : { body }, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    return { ok: false, error: `网络失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const raw = await response.text().catch(() => '')
  let payload
  try { payload = raw === '' ? undefined : JSON.parse(raw) } catch { payload = undefined }
  if (payload === undefined) {
    // 国际站缺 org 实测回过 22 字节裸文本 —— 这里如实报出来，别包装成「未知错误」。
    return { ok: false, error: `HTTP ${response.status}：${raw.slice(0, 120) || '空响应'}` }
  }
  const code = typeof payload.code === 'number' ? payload.code : Number(payload.code)
  if (Number.isFinite(code) && code !== MAGICREW_OK_CODE) {
    const message = String(payload.message ?? payload.msg ?? '')
    if (code === 2182) return { ok: false, code, error: `缺少组织码（${message || '用户所在组织不存在'}）`, needsOrg: true }
    return { ok: false, code, error: `${message || '上游拒绝'}（code ${code}）` }
  }
  if (!response.ok) return { ok: false, error: `HTTP ${response.status}：${raw.slice(0, 120)}` }
  return { ok: true, data: payload.data ?? {}, payload }
}

/** 读字符串 / 读数字（字符串数字也认）。 */
const readString = (source, key) => (typeof source?.[key] === 'string' && source[key] !== '' ? source[key] : undefined)
function readNumber(source, key) {
  const value = source?.[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

/** 凭据指纹（按 JWT 算）：同一账号判重用。 */
export function magicrewFingerprint(jwt) {
  if (typeof jwt !== 'string' || jwt === '') return ''
  return crypto.createHash('sha256').update(jwt).digest('hex').slice(0, 16)
}

/**
 * 用 JWT 签一把 `mgw_` key。
 *
 * ⚠️ **签新 key 会吊销旧 key** —— 只在登录与续期调用，绝不在推理前调用。
 */
export async function issueGatewayKey(product, { jwt, organizationCode, fetch: fetchImpl = fetch } = {}) {
  const result = await call({
    url: `${product.host}${MAGICREW_GATEWAY_TOKENS_PATH}`,
    method: 'POST',
    headers: magicrewHeaders(product, { token: jwt, organizationCode }),
    body: '{}',
    fetch: fetchImpl,
  })
  if (!result.ok) return { error: `签发密钥失败：${result.error}`, ...result.needsOrg === true ? { needsOrg: true } : {} }
  const apiKey = readString(result.data, 'api_key')
  if (apiKey === undefined) return { error: '签发密钥失败：响应里没有 api_key' }
  return {
    key: {
      apiKey,
      ...readString(result.data, 'refresh_token') === undefined ? {} : { refreshToken: readString(result.data, 'refresh_token') },
      ...readNumber(result.data, 'api_key_expires_at') === undefined ? {} : { apiKeyExpiresAt: readNumber(result.data, 'api_key_expires_at') },
      ...readNumber(result.data, 'refresh_token_expires_at') === undefined ? {} : { refreshTokenExpiresAt: readNumber(result.data, 'refresh_token_expires_at') },
    },
  }
}

/**
 * 续签 `mgw_` key。
 *
 * ⚠️ 走 **PUT 且 body 只带 `refresh_token`**：带上 JWT 反而会在 JWT 过期时把
 * 「能续的」变成「不能续的」—— 这条路径存在的意义就是 JWT 已经没用了。
 */
export async function refreshGatewayKey(product, { refreshToken, fetch: fetchImpl = fetch } = {}) {
  if (typeof refreshToken !== 'string' || refreshToken === '') return { error: '没有 refresh_token（需要重新登录）' }
  const result = await call({
    url: `${product.host}${MAGICREW_GATEWAY_TOKENS_PATH}`,
    method: 'PUT',
    headers: magicrewHeaders(product, {}),
    body: JSON.stringify({ refresh_token: refreshToken }),
    fetch: fetchImpl,
  })
  if (!result.ok) return { error: `续签密钥失败：${result.error}` }
  const apiKey = readString(result.data, 'api_key')
  if (apiKey === undefined) return { error: '续签密钥失败：响应里没有 api_key' }
  return {
    key: {
      apiKey,
      refreshToken: readString(result.data, 'refresh_token') ?? refreshToken,
      ...readNumber(result.data, 'api_key_expires_at') === undefined ? {} : { apiKeyExpiresAt: readNumber(result.data, 'api_key_expires_at') },
      ...readNumber(result.data, 'refresh_token_expires_at') === undefined ? {} : { refreshTokenExpiresAt: readNumber(result.data, 'refresh_token_expires_at') },
    },
  }
}

/** 是否该续签：只剩 30 分钟以内。 */
export function shouldRefreshKey(credential, now = Date.now()) {
  const expiresAt = Number(credential?.apiKeyExpiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false
  return expiresAt - 30 * 60_000 <= now
}

/** 积分总额：`total_points` 可能是负数（欠费）与字符串，两种都要认。 */
export async function fetchPoints(product, { jwt, organizationCode, fetch: fetchImpl = fetch } = {}) {
  const result = await call({
    url: `${product.host}${MAGICREW_POINTS_PATH}`,
    headers: magicrewHeaders(product, { token: jwt, organizationCode }),
    fetch: fetchImpl,
  })
  if (!result.ok) return { error: result.error, ...result.needsOrg === true ? { needsOrg: true } : {} }
  const total = readNumber(result.data, 'total_points')
  if (total === undefined) return { error: '积分查询失败（响应缺少可解析的 total_points）' }
  return { total }
}

/**
 * 每日登录积分（= 签到）。
 *
 * ⚠️ 请求体是**存在且为空串** `''`（不是 `{}`、不是没有 body）。
 * ⚠️ 幂等：`granted !== true` ⇒ `already-claimed`「今日已领取登录积分」，不是失败。
 */
export async function claimLoginGift(product, { jwt, organizationCode, fetch: fetchImpl = fetch } = {}) {
  const result = await call({
    url: `${product.host}${MAGICREW_LOGIN_GIFT_PATH}`,
    method: 'POST',
    headers: magicrewHeaders(product, { token: jwt, organizationCode }),
    body: '',
    fetch: fetchImpl,
  })
  if (!result.ok) return { kind: 'failed', message: result.error }
  const granted = result.data.granted === true
  const points = readNumber(result.data, 'point_amount') ?? 0
  if (!granted) return { kind: 'already-claimed', message: '今日已领取登录积分' }
  return { kind: 'claimed', credit: points, message: `已领取 ${points} 积分` }
}

/** 新手任务（每号一次）：只读状态，供 `claim` 的第二个入口用。 */
export async function fetchOnboarding(product, { jwt, organizationCode, fetch: fetchImpl = fetch } = {}) {
  const result = await call({
    url: `${product.host}${MAGICREW_ONBOARDING_TASKS_PATH}`,
    headers: magicrewHeaders(product, { token: jwt, organizationCode }),
    fetch: fetchImpl,
  })
  if (!result.ok) return { error: result.error }
  const tasks = Array.isArray(result.data.tasks) ? result.data.tasks : []
  return {
    tasks: tasks.map(task => ({
      code: String(task.code ?? ''),
      title: String(task.title ?? ''),
      points: readNumber(task, 'points') ?? 0,
      status: String(task.status ?? ''),
      rewardStatus: String(task.reward_status ?? ''),
    })),
  }
}

/** 完成一项新手任务：`PUT …/<code>/completion`，body `{}`。 */
export async function completeOnboarding(product, code, { jwt, organizationCode, fetch: fetchImpl = fetch } = {}) {
  const result = await call({
    url: `${product.host}${MAGICREW_ONBOARDING_TASKS_PATH}/${encodeURIComponent(String(code))}/completion`,
    method: 'PUT',
    headers: magicrewHeaders(product, { token: jwt, organizationCode }),
    body: '{}',
    fetch: fetchImpl,
  })
  if (!result.ok) return { kind: 'failed', message: result.error }
  return { kind: 'claimed', credit: readNumber(result.data, 'points') ?? 0 }
}

/** 目录（远端失败时交调用方走兜底）。 */
export async function fetchMagicrewModels(product, { jwt, organizationCode, fetch: fetchImpl = fetch } = {}) {
  const result = await call({
    url: `${product.host}${MAGICREW_MODELS_PATH}`,
    headers: magicrewHeaders(product, { token: jwt, organizationCode }),
    fetch: fetchImpl,
  })
  if (!result.ok) return { error: result.error }
  const rows = Array.isArray(result.data.models) ? result.data.models
    : Array.isArray(result.data) ? result.data
      : []
  const out = []
  for (const row of rows) {
    const id = readString(row, 'id') ?? readString(row, 'model_id') ?? readString(row, 'code')
    if (id === undefined) continue
    out.push({
      id,
      name: readString(row, 'name') ?? readString(row, 'display_name') ?? id,
      ...readNumber(row, 'context_window') === undefined ? {} : { contextWindow: readNumber(row, 'context_window') },
    })
  }
  return out.length === 0 ? { error: '目录响应里没有可识别的模型' } : { rows: out }
}

/** 目录行（兜底）。 */
export function magicrewCatalogRows() {
  return MAGICREW_FALLBACK_MODELS.map(model => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    vision: model.vision === true,
    reasoning: true,
  }))
}

/**
 * 浏览器里读凭据的求值表达式。
 *
 * ⚠️ **六个键一次取完**（不是六次 `Runtime.evaluate`）：来回几次会让「读到 jwt 之后、
 * 读组织码之前用户换了账号」出现窗口，而错配的 jwt × org 在上游是 HTTP 200 +
 * `code:403` —— 看起来像「密钥坏」。
 * ⚠️ `n = localStorage.length`：空 = 还没登完。
 */
export const MAGICREW_HARVEST_EXPRESSION = `(() => {
  const a = localStorage.getItem('authorization')
  const ao = localStorage.getItem('MAGIC:user:authorization')
  const o = localStorage.getItem('organizationCode')
  const oo = localStorage.getItem('MAGIC:user:organizationCode')
  const t = localStorage.getItem('teamshareOrganizationCode')
  const to = localStorage.getItem('MAGIC:user:teamshareOrganizationCode')
  return { a, ao, o, oo, t, to, n: localStorage.length }
})()`

/** JWT 形状：`eyJ…` 三段。形状对 ≠ 有效，但形状不对一定不是。 */
function isJwtShaped(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) && value.startsWith('ey')
}

/**
 * 解析收割结果。
 *
 * ⚠️ 必须**成对**取：jwt 用哪个键，org 就取同一前缀的那个键 —— 上游对错配的
 * jwt × org 回 HTTP 200 + `code:403`，不报「组织不存在」。
 */
export function parseMagicrewHarvest(value) {
  if (value === null || typeof value !== 'object') return undefined
  if (Number(value.n ?? 0) <= 0) return undefined
  const pairs = [
    [value.a, value.o],
    [value.ao, value.oo],
    [value.a, value.oo],
    [value.ao, value.o],
    [value.a, value.t],
    [value.ao, value.to],
  ]
  for (const [jwt, org] of pairs) {
    if (!isJwtShaped(jwt)) continue
    const organizationCode = typeof org === 'string' ? org : ''
    return { jwt, organizationCode }
  }
  return undefined
}

/** 浏览器登录后：收凭据 → 签 key → 得到完整 credential。 */
export async function completeMagicrewLogin(product, { jwt, organizationCode, fetch: fetchImpl = fetch } = {}) {
  const issued = await issueGatewayKey(product, { jwt, organizationCode, fetch: fetchImpl })
  if (issued.error !== undefined) return { error: issued.error }
  return {
    credential: {
      jwt,
      organizationCode,
      provider: product.id,
      ...issued.key,
    },
  }
}

/** 权益扩展：目录 + 积分 + 签到。 */
export function createMagicrewExtras({ product = MAGICREW_PRODUCTS.magicrew, credentialOf, fetch: fetchImpl = fetch, persist } = {}) {
  /**
   * `accountId → 正在跑的续签`。
   *
   * 续签会吊销旧 key：两个并发读（面板轮询 + 推理取号）撞在同一个账号上时，
   * 各自续一次，后一次会让前一次刚写回的 key 失效。按账号单飞。
   */
  const refreshing = new Map()
  async function live(account) {
    const raw = await credentialOf(account)
    if (raw === null || typeof raw.jwt !== 'string' || raw.jwt === '') return { error: '凭据不可用（需要重新登录）' }
    // ⚠️ 续签会吊销旧 key：只在「快过期」时做，且不在推理路径上。
    if (shouldRefreshKey(raw) && typeof raw.refreshToken === 'string' && raw.refreshToken !== '') {
      const key = `magicrew:${String(account?.id ?? '')}`
      let pending = refreshing.get(key)
      if (pending === undefined) {
        pending = refreshGatewayKey(product, { refreshToken: raw.refreshToken, fetch: fetchImpl })
          .finally(() => refreshing.delete(key))
        refreshing.set(key, pending)
      }
      const refreshed = await pending
      if (refreshed.error === undefined) {
        const next = { ...raw, ...refreshed.key, provider: product.id }
        if (typeof persist === 'function' && typeof account?.id === 'string') {
          try { await persist(account.id, next) } catch { /* 落盘失败不影响本回合 */ }
        }
        return { credential: next }
      }
      // 续签失败但 JWT 还在：业务腿照常可用，如实带上错误。
      return { credential: raw, refreshError: refreshed.error }
    }
    return { credential: raw }
  }

  async function statusOf(account) {
    const base = { accountId: typeof account?.id === 'string' ? account.id : '', nickname: typeof account?.nickname === 'string' ? account.nickname : '' }
    const resolved = await live(account)
    if (resolved.error !== undefined) return { ...base, catalog: magicrewCatalogRows(), error: resolved.error, source: 'static' }
    const { jwt, organizationCode } = resolved.credential
    const [models, points, gift] = await Promise.all([
      fetchMagicrewModels(product, { jwt, organizationCode, fetch: fetchImpl }),
      fetchPoints(product, { jwt, organizationCode, fetch: fetchImpl }),
      fetchOnboarding(product, { jwt, organizationCode, fetch: fetchImpl }),
    ])
    return {
      ...base,
      catalog: models.rows ?? magicrewCatalogRows(),
      source: models.rows === undefined ? 'static' : 'live',
      ...points.total === undefined ? { balanceError: points.error } : { balance: { total: points.total, unit: 'point' } },
      ...gift.tasks === undefined ? {} : { tasks: gift.tasks },
      ...resolved.refreshError === undefined ? {} : { refreshError: resolved.refreshError },
    }
  }

  async function claim(account, campaignId) {
    const resolved = await live(account)
    if (resolved.error !== undefined) return { kind: 'failed', message: resolved.error }
    const { jwt, organizationCode } = resolved.credential
    // 第二入口：新手任务（`campaignId` 形如 `task:<code>`）。
    const code = String(campaignId ?? '')
    if (code.startsWith('task:')) {
      return completeOnboarding(product, code.slice(5), { jwt, organizationCode, fetch: fetchImpl })
    }
    return claimLoginGift(product, { jwt, organizationCode, fetch: fetchImpl })
  }

  return { statusOf, claim }
}
