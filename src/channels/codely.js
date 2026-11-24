/**
 * Codely（Unity 团结引擎）渠道：设备码登录、模型目录、积分余额、每日签到。
 *
 * ## 协议来源（逐条实测记录）
 *
 * 取自 `dsh-providers-hub`（iJetLi，MIT）的实测与官方客户端逆向，这里只保留
 * 本渠道真正用到的四组端点：
 *
 * | 用途 | 端点 | 鉴权 |
 * | --- | --- | --- |
 * | 设备码登录 | `POST /auth/device/initiate` → `GET /auth/device/poll?auth_request_token=` → `POST /auth/device/exchange` | 无 / 无 / 无 |
 * | 模型目录 | `GET /api/model-status` | `Bearer access_token` |
 * | 积分余额 | `GET /api/user/usage/summary` | `Bearer access_token` |
 * | 每日签到 | `POST /api/points/check-in/init` → `POST /api/points/check-in` | `Bearer access_token` |
 *
 * 三处最容易踩的坑，都按上游实测形态处理：
 *
 * 1. **`remaining_points` 是字符串**（`"2400"`），顶层与 `details[]` 里都是 ——
 *    必须按 `string | number` 双形态读；读不出**不得**回落成 0（0 = 已用光）。
 * 2. **`details[]` 是逐桶结构**，只看顶层会让多桶账号（赠送 + 充值）少桶。
 * 3. **签到必须两步**：先 `init` 查状态（`can_check_in` 判幂等），再 `check-in`
 *    执行；跳过 init 直接执行会重复发请求，且拿不到「今天已领」的判据。
 *
 * 登录只做**设备码**这一条（国内/国际同一套）。推理网关（`codely-litellm` + HMAC
 * 签名）不在本模块：它需要 `sk-` CLI Key 换发与 `X-Codely-Signature`，是适配器
 * 那一侧的事（见 README「还没接的三家」）。
 *
 * @module src/channels/codely.js
 */

export const CODELY_API_BASE = 'https://codely.tuanjie.cn'
export const CODELY_INFERENCE_BASE = 'https://codely-litellm.tuanjie.cn/v1'
export const CODELY_USER_AGENT = 'codely-vscode/4.3.0'

const INITIATE_PATH = '/auth/device/initiate'
const POLL_PATH = '/auth/device/poll'
const EXCHANGE_PATH = '/auth/device/exchange'
const ME_PATH = '/auth/external/me'
const MODEL_STATUS_PATH = '/api/model-status'
const USAGE_SUMMARY_PATH = '/api/user/usage/summary'
const CHECKIN_INIT_PATH = '/api/points/check-in/init'
const CHECKIN_PATH = '/api/points/check-in'

const TIMEOUT_MS = 30_000

/** 连续网络失败多少次后放弃轮询（与上游实现同档）。 */
const POLL_MAX_FAILURES = 5

/** 兜底目录：8 个 `modelGroup`，逐字来自 `/api/model-status` 实测。 */
export const FALLBACK_MODELS = Object.freeze([
  'codely-core', 'codely-basic', 'codely-flash', 'codely-air',
  'codely-vl', 'DeepSeek-V4.1-Flash', 'GLM-5.3-FLASH', 'KIMI-K3',
])

/* ── 解析（纯函数，供测试直接断言） ─────────────────────────────────────── */

/** 上游「字符串优先」的数值读取；读不到返回 undefined（不编造 0）。 */
export function readPoints(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined
  }
  return undefined
}

/** `/api/model-status` → `[{id, status?}]`（`modelGroup` 即可直接当模型 id）。 */
export function parseModelStatus(payload) {
  const rows = Array.isArray(payload?.models) ? payload.models : []
  const out = []
  const seen = new Set()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = typeof row.modelGroup === 'string' ? row.modelGroup.trim() : ''
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    out.push({ id, ...typeof row.status === 'string' ? { status: row.status } : {} })
  }
  return out
}

/**
 * `/api/user/usage/summary` → `{total, packages[], exhausted}`。
 *
 * 顶层 `remaining_points` 是全桶汇总；`details[]` 逐桶（`type` / `remaining_points`
 * / `exhausted`）。读不到顶层时用逐桶之和兜底；**一个都读不到**就返回 null，
 * 面板据此显示「查不到」而不是 0。
 */
export function parseUsageSummary(payload) {
  const rows = Array.isArray(payload?.details) ? payload.details : []
  const packages = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const remaining = readPoints(row.remaining_points)
    if (remaining === undefined) continue
    const type = typeof row.type === 'string' && row.type !== '' ? row.type : 'credit'
    packages.push({ name: type, remaining, exhausted: row.exhausted === true })
  }
  const total = readPoints(payload?.remaining_points) ?? (packages.length > 0 ? packages.reduce((sum, row) => sum + row.remaining, 0) : undefined)
  if (total === undefined) return null
  return { total, packages, exhausted: payload?.is_exhausted === true }
}

/** `/api/points/check-in/init` → 签到状态（`can_check_in` 是**幂等判据**）。 */
export function parseCheckinState(payload) {
  if (payload === null || typeof payload !== 'object') return null
  const level = Array.isArray(payload.levels)
    ? payload.levels.find(row => row?.status === 'CURRENT')
    : undefined
  const reward = typeof level?.reward_summary === 'string' ? Number.parseInt(level.reward_summary.trim(), 10) : NaN
  return {
    activityStatus: typeof payload.activity_status === 'string' ? payload.activity_status : '',
    checkinStatus: typeof payload.check_in_status === 'string' ? payload.check_in_status : '',
    canCheckIn: payload.can_check_in === true,
    count: readPoints(payload.check_in_count) ?? 0,
    max: readPoints(payload.max_count) ?? 0,
    reward: Number.isFinite(reward) && reward > 0 ? reward : undefined,
    error: typeof payload.error === 'string' ? payload.error : '',
  }
}

/**
 * 签到两步的结论映射（与渠道包 `ClaimOutcome` 同语义）。
 *
 * 顺序即判据顺序：活动未开 → 不可用 → 今日已领/处理中 → 执行 → 按 `check_in_status` 判成败。
 */
export function classifyCheckin(state, executed) {
  if (state === null) return { kind: 'failed', message: '签到状态查询失败（响应形状不认识）' }
  if (state.activityStatus !== '' && state.activityStatus !== 'ACTIVE') {
    const labels = {
      NOT_CONFIGURED: '本月活动暂未开放',
      PENDING: '本月活动尚未开始',
      EXPIRED: '本月活动已结束',
    }
    return { kind: 'inactive', message: labels[state.activityStatus] ?? `签到活动状态异常（${state.activityStatus}）` }
  }
  if (state.checkinStatus === 'UNAVAILABLE') {
    return { kind: 'failed', message: `Codely 签到暂不可用：${state.error || '签到暂不可用'}` }
  }
  if (!state.canCheckIn) {
    // `PROCESSING` / `CREDIT_PENDING` 是「已受理、未到账」的过渡态：再打一次只会白跑。
    return { kind: 'already-claimed', message: '今天已签到' }
  }
  if (executed === undefined) return { kind: 'failed', message: '签到执行请求未发出' }
  const after = parseCheckinState(executed)
  if (after !== null && after.checkinStatus === 'COMPLETED') {
    return { kind: 'claimed', credit: state.reward ?? 0 }
  }
  if (after !== null && after.canCheckIn === false) return { kind: 'already-claimed', message: '今天已签到' }
  return { kind: 'failed', message: `签到未完成（status=${after?.checkinStatus ?? 'unknown'}）` }
}

/** JWT 的 `exp`（秒）→ 毫秒；解不出返回 undefined（不编造过期时间）。 */
export function decodeJwtExpMs(token) {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length < 2) return undefined
  try {
    const claims = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    const exp = claims?.exp
    return typeof exp === 'number' && Number.isFinite(exp) && exp > 0 ? exp * 1000 : undefined
  } catch {
    return undefined
  }
}

/* ── 传输 ────────────────────────────────────────────────────────────────── */

async function postJson(fetchImpl, url, body, token, signal) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json', 'X-User-Agent': CODELY_USER_AGENT }
  if (typeof token === 'string' && token !== '') headers.Authorization = `Bearer ${token}`
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  let payload = null
  try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = null }
  return { ok: response.ok, status: response.status, payload, text }
}

async function getJson(fetchImpl, url, token, signal) {
  const headers = { Accept: 'application/json', 'X-User-Agent': CODELY_USER_AGENT }
  if (typeof token === 'string' && token !== '') headers.Authorization = `Bearer ${token}`
  const response = await fetchImpl(url, { headers, signal: signal ?? AbortSignal.timeout(TIMEOUT_MS) })
  const text = await response.text().catch(() => '')
  let payload = null
  try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = null }
  return { ok: response.ok, status: response.status, payload, text }
}

/* ── 设备码登录（两步式：先拿码，再轮询） ─────────────────────────────────── */

/**
 * 第 1 步：申请设备码。
 *
 * @returns `{authRequestToken, userCode, verificationUri, verificationUriComplete, intervalMs, expiresIn}`，
 *   失败时 `{error}`（不抛 —— 调用方要把原因显示在面板上）。
 */
export async function startDeviceLogin({ fetch: fetchImpl = fetch, signal } = {}) {
  try {
    const result = await postJson(fetchImpl, `${CODELY_API_BASE}${INITIATE_PATH}`, {
      provider: 'unity',
      client_name: 'codely-vscode',
      auth_from: 'vscode-codely',
    }, '', signal)
    if (!result.ok) return { error: `申请设备码失败（HTTP ${result.status}）${result.text.slice(0, 120)}` }
    const payload = result.payload ?? {}
    const authRequestToken = typeof payload.auth_request_token === 'string' ? payload.auth_request_token : ''
    const userCode = typeof payload.user_code === 'string' ? payload.user_code : ''
    const verificationUri = typeof payload.verification_uri === 'string' ? payload.verification_uri : ''
    if (authRequestToken === '' || verificationUri === '') {
      return { error: '设备码响应缺少 auth_request_token 或 verification_uri' }
    }
    return {
      authRequestToken,
      userCode,
      verificationUri,
      verificationUriComplete: typeof payload.verification_uri_complete === 'string' ? payload.verification_uri_complete : verificationUri,
      intervalMs: Math.max(500, Number(payload.interval) > 0 ? Number(payload.interval) * 1000 : 2000),
      expiresIn: Number(payload.expires_in) > 0 ? Number(payload.expires_in) : 900,
    }
  } catch (error) {
    return { error: `申请设备码网络失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 第 2 步：轮询一次。
 *
 * 与渠道包的两步式登录同一约定：路由返回「还没好」而不是挂住请求 —— 面板每 3 秒
 * 调一次，用户在浏览器里点完授权后自然落到 `authorized`。
 *
 * @returns `{status}` 或 `{status:'authorized', code}`；网络失败计入 `failures`
 *   （连续 5 次才判死，与上游一致）。
 */
export async function pollDeviceLogin(authRequestToken, { fetch: fetchImpl = fetch, signal } = {}) {
  try {
    const url = `${CODELY_API_BASE}${POLL_PATH}?auth_request_token=${encodeURIComponent(authRequestToken)}`
    const result = await getJson(fetchImpl, url, '', signal)
    if (!result.ok) return { status: 'error', error: `轮询失败（HTTP ${result.status}）` }
    const payload = result.payload ?? {}
    const status = typeof payload.status === 'string' ? payload.status : 'unknown'
    if (status === 'authorized') {
      const code = typeof payload.authorization_code === 'string' ? payload.authorization_code : ''
      return code === '' ? { status: 'error', error: '授权响应缺少 authorization_code' } : { status, code }
    }
    return {
      status,
      ...typeof payload.error_description === 'string' && payload.error_description !== ''
        ? { error: payload.error_description }
        : {},
    }
  } catch (error) {
    return { status: 'error', error: `轮询网络失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 第 3 步：授权码换令牌（返回落盘用的凭据形状）。 */
export async function exchangeCode(code, { fetch: fetchImpl = fetch, signal } = {}) {
  const result = await postJson(fetchImpl, `${CODELY_API_BASE}${EXCHANGE_PATH}`, { authorization_code: code }, '', signal)
  if (!result.ok) return { error: `令牌交换失败（HTTP ${result.status}）${result.text.slice(0, 120)}` }
  const payload = result.payload ?? {}
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : ''
  const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : ''
  if (accessToken === '' || refreshToken === '') return { error: '令牌交换响应缺少 access_token / refresh_token' }
  const expiresAt = decodeJwtExpMs(accessToken)
  return {
    credential: {
      access_token: accessToken,
      refresh_token: refreshToken,
      obtained_at: Date.now(),
      ...expiresAt === undefined ? {} : { expires_at: new Date(expiresAt).toISOString() },
    },
    expiresAt,
  }
}

/** 取昵称（尽力而为，失败不影响登录）。 */
export async function fetchNickname(accessToken, { fetch: fetchImpl = fetch, signal } = {}) {
  try {
    const result = await getJson(fetchImpl, `${CODELY_API_BASE}${ME_PATH}`, accessToken, signal)
    if (!result.ok) return undefined
    const username = result.payload?.username
    return typeof username === 'string' && username !== '' ? username : undefined
  } catch {
    return undefined
  }
}

/* ── 权益（目录 / 余额 / 签到） ───────────────────────────────────────────── */

/**
 * 建 Codely 的权益读取器。
 *
 * @param {object} options
 * @param {(account: object) => Promise<object|null>} options.credentialOf
 * @param {Function} [options.fetch]
 */
export function createCodelyExtras({ credentialOf, fetch: fetchImpl = fetch }) {
  const tokenOf = async account => {
    const credential = await credentialOf(account)
    return typeof credential?.access_token === 'string' && credential.access_token !== '' ? credential.access_token : ''
  }

  async function statusOf(account) {
    const base = {
      accountId: typeof account?.id === 'string' ? account.id : '',
      nickname: typeof account?.nickname === 'string' ? account.nickname : '',
    }
    const token = await tokenOf(account)
    if (token === '') return { ...base, error: '凭据不可用（需要重新登录）' }
    const [catalogResult, usageResult, checkinResult] = await Promise.all([
      getJson(fetchImpl, `${CODELY_API_BASE}${MODEL_STATUS_PATH}`, token),
      getJson(fetchImpl, `${CODELY_API_BASE}${USAGE_SUMMARY_PATH}`, token),
      postJson(fetchImpl, `${CODELY_API_BASE}${CHECKIN_INIT_PATH}`, {}, token),
    ])
    const catalog = catalogResult.ok ? parseModelStatus(catalogResult.payload) : []
    const info = usageResult.ok ? parseUsageSummary(usageResult.payload) : null
    const checkin = checkinResult.ok ? parseCheckinState(checkinResult.payload) : null
    return {
      ...base,
      // 目录：远端可用就用远端；空的时候如实给兜底（并在 note 里说明）。
      catalog: catalog.length > 0
        ? catalog.map(row => ({ id: row.id, name: row.id, ...row.status === undefined ? {} : { status: row.status } }))
        : FALLBACK_MODELS.map(id => ({ id, name: id })),
      ...catalog.length > 0 ? {} : { catalogNote: '远端目录为空，已列兜底的 8 个模型组' },
      info,
      ...usageResult.ok ? {} : { infoError: `余额查询失败（HTTP ${usageResult.status}）` },
      checkin,
      ...checkinResult.ok ? {} : { checkinError: `签到状态查询失败（HTTP ${checkinResult.status}）` },
    }
  }

  async function claim(account) {
    const token = await tokenOf(account)
    if (token === '') return { kind: 'failed', message: '凭据不可用（需要重新登录）' }
    const init = await postJson(fetchImpl, `${CODELY_API_BASE}${CHECKIN_INIT_PATH}`, {}, token)
    const state = init.ok ? parseCheckinState(init.payload) : null
    const decided = classifyCheckin(state, undefined)
    if (decided.kind !== 'failed' || state === null) return decided
    const executed = await postJson(fetchImpl, `${CODELY_API_BASE}${CHECKIN_PATH}`, {}, token)
    if (!executed.ok) {
      return { kind: 'failed', message: `签到执行失败（HTTP ${executed.status}）${executed.text.slice(0, 120)}` }
    }
    return classifyCheckin(state, executed.payload)
  }

  return { statusOf, claim }
}

export { POLL_MAX_FAILURES }