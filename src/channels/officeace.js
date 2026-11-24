/**
 * OfficeAce（华为云 AgentArts）的目录、推理与额度协议。
 *
 * ## 目录是**产品决策表**，不是远端镜像
 *
 * 远端 `/v2/models` 会随账号/租户变化，而用户只想要「一渠道一可预期模型」；
 * 内置表是实测过的 8 条（含 `multimodal` 标记），远端失败时直接用它。
 *
 * ## 登录是 OAuth + **DPoP**（这一段最重，单独一层）
 *
 * `client_id=pdp5_for_agentarts`（PKCE 公开客户端，无 secret），
 * `redirect_uri=https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/auth/callback`，
 * 换 token 打 `https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens`，
 * 且必须带 **DPoP 私钥签的 JWT** —— 私钥要持久化（续期要用同一把）。
 *
 * 三条硬判据（真机踩过）：
 * 1. **code 有效期是秒级** ⇒ 拿到后必须立刻换，不能拆成两步交互；
 * 2. **refresh_token 一次性** ⇒ 续期成功必须立即落盘新 token，重放会触发 STS5.1806；
 * 3. 续期与登录共用同一个 DPoP 私钥，换钥等于换身份。
 *
 * ## 额度
 *
 * 只有订阅/额度读数，**没有签到端点**（`dailyCheckin: false`）。
 *
 * @module src/channels/officeace.js
 */

export const OFFICEACE = Object.freeze({
  id: 'officeace',
  displayName: 'OfficeAce',
  /** 默认业务主机（华为云 AgentArts 西南二）。 */
  baseUrl: 'https://officeace.cn-southwest-2.huaweicloud-agentarts.com',
  /** 官方 MaaS 主机（部分租户走它）。 */
  maasBaseUrl: 'https://api.modelarts-maas.com',
  chatPath: '/v2/chat/completions',
  modelsPath: '/v2/models',
  /** OAuth 常量（登录腿用；见模块头）。 */
  clawBase: 'https://agentarts.cn-southwest-2.myhuaweicloud.com',
  tokenUrl: 'https://sts.cn-north-4.myhuaweicloud.com/v1/oauth2/tokens',
  clientId: 'pdp5_for_agentarts',
  redirectUri: 'https://agentarts.cn-southwest-2.myhuaweicloud.com/v1/claw/auth/callback',
})

/** 目录未返回时的上下文兜底。 */
export const OFFICEACE_FALLBACK_CONTEXT = 131_072

/**
 * 内置目录（8 条，实测口径）。`maxTokens` 目前没有代码读 —— 保持与上游一致，
 * 需要时由 `resolveModel` 的 `defaultMaxTokens` 接。
 */
export const OFFICEACE_MODELS = Object.freeze([
  { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_048_576, maxTokens: 131_072 },
  { id: 'glm-5.2', name: 'GLM-5.2', contextWindow: 1_044_480, maxTokens: 131_072 },
  { id: 'glm-5.1', name: 'GLM-5.1', contextWindow: 196_608, maxTokens: 131_072 },
  { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1_048_576, maxTokens: 393_216, multimodal: true },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_044_480, maxTokens: 393_216 },
  { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 262_144, maxTokens: 131_072, multimodal: true },
  { id: 'qwen3-32b', name: 'Qwen3-32B', contextWindow: 131_072, maxTokens: 65_536 },
  { id: 'qwen3-30b-a3b', name: 'Qwen3-30B-A3B', contextWindow: 131_072, maxTokens: 65_536 },
])

/** 目录行（供自有渠道目录使用）。 */
export function officeaceCatalogRows() {
  return OFFICEACE_MODELS.map(model => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    maxOutput: model.maxTokens,
    vision: model.multimodal === true,
    reasoning: true,
  }))
}

/** 推理头：Bearer access_token（DPoP 只用于**换 token**，网关不用它）。 */
export function officeaceInferenceHeaders(credential) {
  return {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    authorization: `Bearer ${String(credential?.access_token ?? '')}`,
  }
}

/**
 * 远端目录（失败交调用方走内置表）。
 *
 * 只认 `{data:[{id, ...}]}` 或 `{models:[...]}` 两种形状；不认识的键**跳过**。
 */
export async function fetchOfficeaceModels(credential, { fetch: fetchImpl = fetch, base = OFFICEACE.baseUrl } = {}) {
  let response
  try {
    response = await fetchImpl(`${base}${OFFICEACE.modelsPath}`, {
      headers: { accept: 'application/json', authorization: `Bearer ${String(credential?.access_token ?? '')}` },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    return { error: `目录请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) return { error: `目录返回 HTTP ${response.status}` }
  let payload
  try { payload = await response.json() } catch { return { error: '目录响应不是 JSON' } }
  const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : []
  const out = []
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id.trim() : ''
    if (id === '') continue
    const known = OFFICEACE_MODELS.find(model => model.id === id)
    out.push({
      id,
      name: typeof row?.name === 'string' && row.name !== '' ? row.name : (known?.name ?? id),
      contextWindow: typeof row?.context_window === 'number' ? row.context_window : (known?.contextWindow ?? OFFICEACE_FALLBACK_CONTEXT),
      ...known?.maxTokens === undefined ? {} : { maxOutput: known.maxTokens },
      vision: known?.multimodal === true,
      reasoning: true,
    })
  }
  return out.length === 0 ? { error: '目录响应里没有可识别的模型' } : { rows: out }
}

/**
 * 权益扩展：**只有额度读数，没有签到**。
 *
 * 本模块只接目录；额度端点（订阅/用量）在登录腿落地后补 —— 在那之前
 * `claim` 如实回 `inactive`，不假装成功。
 */
export function createOfficeaceExtras({ credentialOf } = {}) {
  async function statusOf(account) {
    const base = { accountId: typeof account?.id === 'string' ? account.id : '', nickname: typeof account?.nickname === 'string' ? account.nickname : '' }
    const credential = credentialOf === undefined ? null : await credentialOf(account)
    return {
      ...base,
      catalog: officeaceCatalogRows(),
      source: 'static',
      ...credential === null ? { error: '凭据不可用（需要重新登录）' } : {},
    }
  }
  async function claim() {
    return { kind: 'inactive', message: 'OfficeAce 没有每日签到接口（只有额度读数）' }
  }
  return { statusOf, claim }
}
