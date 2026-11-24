/**
 * 讯飞 AStudio（`astudio`）的账号与目录协议。
 *
 * ## 两段凭据
 *
 * | 段 | 用途 | 来源 |
 * | --- | --- | --- |
 * | 网页 Cookie（四字段串） | 取**权威**模型凭据 | `agent.xfyun.cn/xingchen-studio` 登录后 |
 * | `modelBearerToken` | 推理与目录 | `GET /bot/models/configs`（Cookie 认证） |
 *
 * ⚠️ 推理与目录用的是**同一个 token**，差别只在头（见参考实现：同一 token、同一端点，
 * 只改两个头结果不同）—— 所以 token 只解析一次，头按腿组装。
 *
 * ## 登录
 *
 * 上游有短信与密码两种，都打在 `authBaseUrl` 的登录接口上；登录成功后从响应/页面
 * 里拿那枚四字段 Cookie。**登录腿**与设备码同形（先发起、再等结果），本模块只做
 * 「Cookie → Bearer」与目录这两段（纯 HTTP、可离线测）。
 *
 * @module src/channels/astudio.js
 */

export const ASTUDIO = Object.freeze({
  id: 'astudio',
  displayName: 'AStudio',
  /** 模型网关（推理与目录同主机的不同路径）。 */
  maasBaseUrl: 'https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1',
  catalogBaseUrl: 'https://astronstudio-api-volces-prod.xf-yun.com',
  chatPath: '/responses',
  catalogPath: '/api/v1/model-manager/models',
  /** 活体凭据（权威源）：Cookie 换 `modelBearerToken`。 */
  authBaseUrl: 'https://agent.xfyun.cn/xingchen-studio',
  bearerConfigPath: '/bot/models/configs',
})

/** 目录未返回时的上下文兜底。 */
export const ASTUDIO_FALLBACK_CONTEXT = 131_072

/** Cookie 头：四字段串原样透传（不做解析，上游按整串校验）。 */
export function astudioCookieHeaders(cookie) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...typeof cookie === 'string' && cookie !== '' ? { cookie } : {},
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  }
}

/** 推理/目录头：Bearer `modelBearerToken`。 */
export function astudioBearerHeaders(bearer) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${String(bearer ?? '')}`,
  }
}

/** 从 `/bot/models/configs` 的响应里取 `modelBearerToken`（形状不认识返回 undefined）。 */
export function readAstudioBearer(payload) {
  if (payload === null || typeof payload !== 'object') return undefined
  const candidates = [
    payload.modelBearerToken,
    payload.model_bearer_token,
    payload.data?.modelBearerToken,
    payload.data?.model_bearer_token,
    payload.data?.bearer_token,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** Cookie → Bearer。 */
export async function exchangeAstudioBearer(cookie, { fetch: fetchImpl = fetch } = {}) {
  if (typeof cookie !== 'string' || cookie === '') return { error: '没有网页 Cookie（请先登录）' }
  let response
  try {
    response = await fetchImpl(`${ASTUDIO.authBaseUrl}${ASTUDIO.bearerConfigPath}`, {
      headers: astudioCookieHeaders(cookie), signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    return { error: `取模型凭据失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) return { error: `取模型凭据返回 HTTP ${response.status}` }
  let payload
  try { payload = await response.json() } catch { return { error: '取模型凭据的响应不是 JSON' } }
  const bearer = readAstudioBearer(payload)
  if (bearer === undefined) return { error: '响应里没有 modelBearerToken（上游可能改版）' }
  return { credential: { session_cookie: cookie, model_bearer_token: bearer, provider: 'astudio' } }
}

/**
 * 目录：`GET /api/v1/model-manager/models`（Bearer）。
 *
 * 字段口径：`context_window` → `contextWindow`，`max_output_tokens` → `maxOutput`；
 * 不认识的条目跳过，不猜。
 */
export function parseAstudioModels(payload) {
  const rows = Array.isArray(payload?.data?.models) ? payload.data.models
    : Array.isArray(payload?.models) ? payload.models
      : Array.isArray(payload?.data) ? payload.data
        : []
  const out = []
  for (const row of rows) {
    const id = typeof row?.id === 'string' && row.id !== '' ? row.id
      : typeof row?.model_id === 'string' ? row.model_id
        : typeof row?.model === 'string' ? row.model : ''
    if (id === '') continue
    const contextWindow = Number(row?.context_window ?? row?.contextWindow)
    const maxOutput = Number(row?.max_output_tokens ?? row?.maxOutputTokens)
    out.push({
      id,
      name: typeof row?.name === 'string' && row.name !== '' ? row.name : id,
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : ASTUDIO_FALLBACK_CONTEXT,
      ...Number.isFinite(maxOutput) && maxOutput > 0 ? { maxOutput } : {},
      reasoning: true,
    })
  }
  return out
}

/** 拉远端目录。 */
export async function fetchAstudioModels(bearer, { fetch: fetchImpl = fetch } = {}) {
  let response
  try {
    response = await fetchImpl(`${ASTUDIO.catalogBaseUrl}${ASTUDIO.catalogPath}`, {
      headers: astudioBearerHeaders(bearer), signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    return { error: `目录请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) return { error: `目录返回 HTTP ${response.status}` }
  let payload
  try { payload = await response.json() } catch { return { error: '目录响应不是 JSON' } }
  const rows = parseAstudioModels(payload)
  return rows.length === 0 ? { error: '目录响应里没有可识别的模型' } : { rows }
}

/** 权益扩展：目录 + 余额（余额端点未在本轮取证，先只出目录）。 */
export function createAstudioExtras({ credentialOf, fetch: fetchImpl = fetch } = {}) {
  async function statusOf(account) {
    const base = { accountId: typeof account?.id === 'string' ? account.id : '', nickname: typeof account?.nickname === 'string' ? account.nickname : '' }
    const credential = credentialOf === undefined ? null : await credentialOf(account)
    if (credential === null) return { ...base, error: '凭据不可用（需要重新登录）' }
    const models = await fetchAstudioModels(credential.model_bearer_token, { fetch: fetchImpl })
    return {
      ...base,
      source: models.rows === undefined ? 'static' : 'live',
      ...models.rows === undefined ? { catalogError: models.error } : { catalog: models.rows },
    }
  }
  // AStudio 的签到端点本轮未取证 ⇒ 如实回 inactive，不假装成功。
  async function claim() {
    return { kind: 'inactive', message: 'AStudio 的签到端点尚未取证，暂不支持领取' }
  }
  return { statusOf, claim }
}
