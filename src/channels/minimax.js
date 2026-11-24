/**
 * MiniMax Code（国际版 `minimaxintl` / 中国版 `minimax`）的**账号与权益**协议。
 *
 * ## 为什么单独一个模块
 *
 * 渠道包只认识 `minimax` 一家，且只做推理与它的账号池；`minimaxintl` 是**另一个
 * 产品**（账号不互通、主机不同、凭据 ref 前缀不同）。本插件把国际版当**自有渠道**
 * 接管：自己登录、自己存账号、自己查目录与签到。
 *
 * 两站之间**只差 6 个字段**（`docs/agent-notes/providers-loomy-raccoon-minimax.md`），
 * 其余逐字相同 —— 所以这里是**一份实现 + 一张产品表**，不是两份代码。
 *
 * ## 协议（逐条来自上游实现与真机实测）
 *
 * | 用途 | 请求 |
 * | --- | --- |
 * | 设备码 | `POST {accountHost}/oauth2/device/code`（form，PKCE S256） |
 * | 轮询/续期 | `POST {accountHost}/oauth2/token`（form，`device_code` / `refresh_token`） |
 * | 目录 | `GET {apiHost}/mavis/api/v1/models?region=&buildEnv=` |
 * | 推理 | `POST {apiHost}/mavis/api/v1/llm/v1/messages`（Anthropic Messages） |
 * | 签到状态 | `GET {apiHost}/minimax-cloud/api/v1/signin/status?timezone_id=` |
 * | 签到领取 | `POST {apiHost}/minimax-cloud/api/v1/signin/claim?timezone_id=`，body `{}` |
 * | 积分 | `GET {apiHost}/minimax-cloud/api/v1/credit/details` |
 *
 * ## 六个**不能凭直觉改**的判据
 *
 * 1. **`timezone_id` 是 query 参数且必填**：放请求头无效、不带报 `invalid timezone_id`、
 *    非法时区名也报错。它按**客户端上报的时区**结算签到（与 Qoder 写死 UTC+8 不同）。
 * 2. **业务码在 `base_resp.status_code`**，不是 `code`；HTTP 可能是 200 + 非零码。
 * 3. **`points` 是当日总数，`bonus_points` 是其中的「额外」部分，不得相加**
 *    （实测第 1 天 `points: 800` / `bonus_points: 400`，按钮写的就是 800）。
 * 4. **「今日已领」= `is_today && status === 3`**，不能只看「有没有 Claimable」。
 * 5. **领取幂等靠 `data.claim_result`**：`1` = 本次真领取，`2` = 已领过。
 *    `2` 是**成功语义**（`already-claimed`），判成失败会让自动签到一天反复打上游。
 * 6. **`days` 必须恰好 7 条**且 `is_today` 是布尔、最多 1 条 `Claimable`；形状不认识
 *    就返回 `undefined` —— 宁可显示「查不到」，也不要猜出一份假签到表。
 *
 * 另：**3xx 必须手动处理**。`fetch` 跟随时会按规范**剥掉 `Authorization`**，
 * 上游一次 307 就会变成「400 invalid signature」，看起来像凭据坏了。
 *
 * @module src/channels/minimax.js
 */

import crypto from 'node:crypto'

/** 两站的产品表（只差 6 个字段；新增站点就在这里加一行）。 */
export const MINIMAX_PRODUCTS = Object.freeze({
  minimax: Object.freeze({
    id: 'minimax',
    displayName: 'MiniMax Code (中国版)',
    accountHost: 'https://account.minimax.cn',
    apiHost: 'https://agent.minimax.cn',
    region: 'cn',
    buildEnv: 'prod',
    clientId: 'mcode-public',
    audience: 'agent-backend',
    scope: 'agent.default',
    label: 'MiniMax',
  }),
  minimaxintl: Object.freeze({
    id: 'minimaxintl',
    displayName: 'MiniMax Code (国际版)',
    accountHost: 'https://account.minimax.io',
    apiHost: 'https://agent.minimax.io',
    // ⚠️ 目录查询参数按站点不同：国内 `cn` / 国际 `en`。
    region: 'en',
    buildEnv: 'prod',
    clientId: 'mcode-public',
    audience: 'agent-backend',
    scope: 'agent.default',
    label: 'MiniMax (国际版)',
  }),
})

/** 端点路径（两站同形）。 */
export const MINIMAX_DEVICE_CODE_PATH = '/oauth2/device/code'
export const MINIMAX_TOKEN_PATH = '/oauth2/token'
export const MINIMAX_MODELS_PATH = '/mavis/api/v1/models'
export const MINIMAX_INFER_PATH = '/mavis/api/v1/llm/v1/messages'
export const MINIMAX_SIGNIN_STATUS_PATH = '/minimax-cloud/api/v1/signin/status'
export const MINIMAX_SIGNIN_CLAIM_PATH = '/minimax-cloud/api/v1/signin/claim'
export const MINIMAX_CREDIT_DETAILS_PATH = '/minimax-cloud/api/v1/credit/details'

/** 单日状态（上游 `SigninDayStatus`）。 */
export const MINIMAX_SIGNIN_STATUS = Object.freeze({ Upcoming: 1, Claimable: 2, Claimed: 3, Disabled: 4 })
/** 领取结果（上游 `SigninClaimResult`）。 */
export const MINIMAX_CLAIM_RESULT = Object.freeze({ Claimed: 1, AlreadyClaimed: 2 })

const OAUTH_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 30_000

/**
 * 兜底目录（4 条，顺序照抄远端 `model_order`）。
 *
 * ⚠️ 必须含 `MiniMax-M3.1-Flash-Preview` —— 它**不在**客户端内置静态表里，
 * 兜底表再漏掉，远端一失败用户就看不到自己在用的模型。
 * ⚠️ 只有它有 `effortOptions`；其余三个远端**没有** `effort_options`，
 * 给它们编档位就是凭空猜测。
 */
export const MINIMAX_FALLBACK_MODELS = Object.freeze([
  {
    id: 'MiniMax-M3.1-Flash-Preview', name: 'M3.1-Flash-Preview', contextWindow: 1_000_000, maxOutput: 128_000,
    vision: true, efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'default', thinkingMode: 'forced_on',
  },
  { id: 'MiniMax-M3', name: 'M3', contextWindow: 1_000_000, maxOutput: 128_000, vision: true, thinkingMode: 'switchable' },
  { id: 'MiniMax-M2.7-highspeed', name: 'M2.7-highspeed', contextWindow: 200_000, maxOutput: 128_000, vision: false, thinkingMode: 'forced_on' },
  { id: 'MiniMax-M2.7', name: 'M2.7', contextWindow: 200_000, maxOutput: 128_000, vision: false, thinkingMode: 'forced_on' },
])

/** 取产品配置；未知 id 返回 null（调用方据此拒绝，不落默认站）。 */
export function minimaxProductOf(provider) {
  const key = String(provider ?? '')
  return Object.prototype.hasOwnProperty.call(MINIMAX_PRODUCTS, key) ? MINIMAX_PRODUCTS[key] : null
}

/** PKCE 配对：verifier 32 字节 base64url，challenge = S256。 */
export function createMinimaxPkce() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url')
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url')
  return { codeVerifier, codeChallenge }
}

/** 设备码请求体。 */
export function buildDeviceCodeBody(codeChallenge, product = MINIMAX_PRODUCTS.minimaxintl) {
  return new URLSearchParams({
    client_id: product.clientId,
    scope: product.scope,
    audience: product.audience,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  })
}

/** 轮询请求体。 */
export function buildPollBody(auth, product = MINIMAX_PRODUCTS.minimaxintl) {
  return new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: auth.deviceCode,
    client_id: product.clientId,
    code_verifier: auth.codeVerifier,
  })
}

/** 续期请求体。 */
export function buildRefreshBody(refreshToken, product = MINIMAX_PRODUCTS.minimaxintl) {
  return new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: product.clientId,
    scope: product.scope,
    audience: product.audience,
  })
}

const text = value => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined)
const positive = value => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined)

/** 解析设备码响应；形状不对返回 undefined。 */
export function parseDeviceAuthorization(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return undefined
  const deviceCode = text(payload.device_code)
  const userCode = text(payload.user_code)
  const verificationUri = text(payload.verification_uri) ?? text(payload.verification_url)
  const expiresInSec = positive(payload.expires_in)
  if (deviceCode === undefined || userCode === undefined || verificationUri === undefined || expiresInSec === undefined) return undefined
  return {
    deviceCode,
    userCode,
    verificationUri,
    verificationUriComplete: text(payload.verification_uri_complete) ?? verificationUri,
    expiresInSec,
    // ⚠️ `interval` 单位是**秒**；缺省 5 秒（上游 asar 的默认值）。
    intervalSec: positive(payload.interval) ?? 5,
  }
}

/**
 * 解析令牌响应。
 *
 * ⚠️ 三件必查：`refresh_token` 非空、`expires_in` 是正数、`scope` 必须含产品声明的
 * scope（不含即视为无效凭据 —— 上游客户端就是这么判的）。
 */
export function parseTokenResponse(payload, { product = MINIMAX_PRODUCTS.minimaxintl, previousRefreshToken } = {}) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: '令牌响应不是对象' }
  }
  const accessToken = text(payload.access_token)
  if (accessToken === undefined) return { error: '令牌响应缺少 access_token' }
  const refreshToken = text(payload.refresh_token) ?? previousRefreshToken
  if (refreshToken === undefined) return { error: '令牌响应缺少 refresh_token' }
  const expiresInSec = positive(payload.expires_in)
  if (expiresInSec === undefined) return { error: '令牌响应缺少 expires_in' }
  const scope = text(payload.scope) ?? ''
  if (!scope.split(/\s+/u).filter(Boolean).includes(product.scope)) {
    return { error: `令牌响应的 scope 不含 ${product.scope}` }
  }
  return {
    credential: {
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: text(payload.token_type) ?? 'Bearer',
      scope,
      expires_at: Date.now() + expiresInSec * 1000,
      // 站点标记：同一份凭据 JSON 被两站误用时，请求前就能判出来。
      provider: product.id,
    },
  }
}

/** 从凭据里读 access_token（拒绝把别的站点的 token 拿来用）。 */
export function accessTokenOf(credential, product = MINIMAX_PRODUCTS.minimaxintl) {
  if (credential === null || typeof credential !== 'object') return ''
  if (typeof credential.provider === 'string' && credential.provider !== '' && credential.provider !== product.id) return ''
  return text(credential.access_token) ?? ''
}

/** 业务请求头（国际站额外挂用户设置的 XFF）。 */
export function minimaxHeaders(credential, { product = MINIMAX_PRODUCTS.minimaxintl, xff } = {}) {
  const headers = {
    Authorization: `Bearer ${accessTokenOf(credential, product)}`,
    Accept: 'application/json',
  }
  const forwarded = text(xff)
  if (forwarded !== undefined && !/[\r\n]/.test(forwarded)) headers['X-Forwarded-For'] = forwarded
  return headers
}

/**
 * 一次带「手动重定向」的请求。
 *
 * 3xx 一律按错误交给调用方：跟随会把 `Authorization` 剥掉（fetch 规范），
 * 于是「真失败」看起来像「凭据无效」。
 */
async function request(url, init, fetchImpl, timeoutMs = REQUEST_TIMEOUT_MS) {
  let response
  try {
    response = await fetchImpl(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    return { ok: false, status: 0, error: `网络失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (response.status >= 300 && response.status < 400) {
    return { ok: false, status: response.status, error: `上游返回重定向（${response.status} → ${response.headers.get('location') ?? '?'}），已按失败处理` }
  }
  const raw = await response.text().catch(() => '')
  let payload
  try { payload = raw === '' ? undefined : JSON.parse(raw) } catch { payload = undefined }
  if (!response.ok) {
    const message = text(payload?.error_description) ?? text(payload?.error) ?? text(payload?.message) ?? `HTTP ${response.status}`
    return { ok: false, status: response.status, error: message, payload }
  }
  if (payload === undefined) return { ok: false, status: response.status, error: '响应不是 JSON', payload: undefined }
  return { ok: true, status: response.status, payload }
}

/** 申请设备码：立刻拿到 `user_code` 与验证地址。 */
export async function startDeviceAuthorization({ product = MINIMAX_PRODUCTS.minimaxintl, fetch: fetchImpl = fetch } = {}) {
  const pkce = createMinimaxPkce()
  const result = await request(`${product.accountHost}${MINIMAX_DEVICE_CODE_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildDeviceCodeBody(pkce.codeChallenge, product).toString(),
  }, fetchImpl, OAUTH_TIMEOUT_MS)
  if (!result.ok) return { error: `设备码申请失败：${result.error}` }
  const parsed = parseDeviceAuthorization(result.payload)
  if (parsed === undefined) return { error: '设备码响应无法解析' }
  return { ...parsed, codeVerifier: pkce.codeVerifier }
}

/**
 * 轮询**一次**（两步式：面板每个 tick 调一次，不在服务端挂住）。
 *
 * 返回 `{status}`：`pending` / `slow_down` / `authorized`（带 credential）/ `denied` / `error`。
 * 上游两种「还在等」的形态都要认：HTTP 200 + `status`，以及 OAuth 的 `error` 字段。
 */
export async function pollDeviceTokenOnce(auth, { product = MINIMAX_PRODUCTS.minimaxintl, fetch: fetchImpl = fetch, signal } = {}) {
  const result = await request(`${product.accountHost}${MINIMAX_TOKEN_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildPollBody(auth, product).toString(),
    ...signal === undefined ? {} : { signal },
  }, fetchImpl, OAUTH_TIMEOUT_MS)
  const payload = result.payload ?? {}
  const status = text(payload.status)
  const error = text(payload.error)
  if (status === 'pending' || error === 'authorization_pending') return { status: 'pending' }
  if (status === 'slow_down' || error === 'slow_down') return { status: 'slow_down' }
  if (status === 'denied' || status === 'access_denied' || error === 'access_denied') return { status: 'denied' }
  if (status === 'expired' || error === 'expired_token') return { status: 'expired' }
  if (!result.ok) {
    // ⚠️ 业务失败也可能带 HTTP 200；`error` 已经在上面的分支里判过，走到这里就是真错。
    return { status: 'error', error: result.error }
  }
  const parsed = parseTokenResponse(payload, { product })
  if (parsed.error !== undefined) return { status: 'error', error: parsed.error }
  return { status: 'authorized', credential: parsed.credential }
}

/** 续期：`refresh_token` 换新 access_token。 */
export async function refreshMinimaxToken(credential, { product = MINIMAX_PRODUCTS.minimaxintl, fetch: fetchImpl = fetch } = {}) {
  const refreshToken = text(credential?.refresh_token)
  if (refreshToken === undefined) return { error: '凭据里没有 refresh_token' }
  const result = await request(`${product.accountHost}${MINIMAX_TOKEN_PATH}`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: buildRefreshBody(refreshToken, product).toString(),
  }, fetchImpl, OAUTH_TIMEOUT_MS)
  if (!result.ok) return { error: `续期失败：${result.error}` }
  const parsed = parseTokenResponse(result.payload, { product, previousRefreshToken: refreshToken })
  if (parsed.error !== undefined) return { error: parsed.error }
  // 续期不改变账号身份：昵称/创建时间等字段由账号表持有，这里只交令牌。
  return { credential: { ...credential, ...parsed.credential } }
}

/** 凭据是否已过期（留 60 秒余量）。 */
export function isMinimaxExpired(credential, now = Date.now()) {
  const expiresAt = credential?.expires_at
  return typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt - 60_000 <= now
}

/**
 * 确保拿到可用的 access_token：过期就地续期，续期成功才落盘。
 *
 * @returns `{credential, refreshed}` 或 `{error}`
 */
export async function ensureMinimaxCredential(credential, { product, fetch: fetchImpl = fetch, now = Date.now } = {}) {
  const token = accessTokenOf(credential, product)
  if (token !== '' && !isMinimaxExpired(credential, now())) return { credential, refreshed: false }
  if (text(credential?.refresh_token) === undefined) {
    return token === '' ? { error: '凭据不可用（需要重新登录）' } : { credential, refreshed: false }
  }
  const refreshed = await refreshMinimaxToken(credential, { product, fetch: fetchImpl })
  if (refreshed.error !== undefined) return { error: refreshed.error }
  return { credential: refreshed.credential, refreshed: true }
}

/* ── 目录 ─────────────────────────────────────────────────────────────── */

/**
 * 目录行 → 自有渠道目录（与 `ownEntry()` 同形的字段子集）。
 *
 * 远端字段：`{model_name, model_id?, display_name?, context_window, max_tokens,
 * input_modalities, effort_options, default_effort, thinking_config}`。
 * 不认识的行**跳过**，不猜。
 */
export function minimaxCatalogRows(payload) {
  const rows = Array.isArray(payload?.data?.models) ? payload.data.models
    : Array.isArray(payload?.models) ? payload.models
      : Array.isArray(payload?.data) ? payload.data
        : []
  const out = []
  const seen = new Set()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = text(row.model_name) ?? text(row.model_id) ?? text(row.id)
    if (id === undefined || seen.has(id)) continue
    seen.add(id)
    const contextWindow = positive(row.context_window) ?? positive(row.max_input_tokens)
    const maxOutput = positive(row.max_tokens) ?? positive(row.max_output_tokens)
    const modalities = Array.isArray(row.input_modalities) ? row.input_modalities : []
    const efforts = Array.isArray(row.effort_options) ? row.effort_options.filter(level => typeof level === 'string') : undefined
    const thinking = row.thinking_config ?? row.thinking
    out.push({
      id,
      name: text(row.display_name) ?? text(row.name) ?? id,
      ...contextWindow === undefined ? {} : { contextWindow },
      ...maxOutput === undefined ? {} : { maxOutput },
      ...modalities.length === 0 ? {} : { vision: modalities.includes('image') },
      ...efforts === undefined || efforts.length === 0 ? {} : { efforts },
      ...text(row.default_effort) === undefined ? {} : { defaultEffort: text(row.default_effort) },
      ...thinking !== undefined && typeof thinking === 'object' && text(thinking.mode) !== undefined ? { thinkingMode: text(thinking.mode) } : {},
    })
  }
  return out
}

/** 拉远端目录；失败时交给调用方决定兜底。 */
export async function fetchMinimaxModels(credential, { product = MINIMAX_PRODUCTS.minimaxintl, fetch: fetchImpl = fetch, xff } = {}) {
  const url = new URL(`${product.apiHost}${MINIMAX_MODELS_PATH}`)
  url.searchParams.set('region', product.region)
  url.searchParams.set('buildEnv', product.buildEnv)
  const result = await request(url.toString(), { method: 'GET', headers: minimaxHeaders(credential, { product, xff }) }, fetchImpl)
  if (!result.ok) return { error: result.error }
  const rows = minimaxCatalogRows(result.payload)
  if (rows.length === 0) return { error: '目录响应里没有可识别的模型' }
  return { rows }
}

/* ── 签到 ─────────────────────────────────────────────────────────────── */

/** 本机 IANA 时区名（上游客户端原样这么做；取不到用 UTC）。 */
export function resolveTimezoneId(resolve = () => Intl.DateTimeFormat().resolvedOptions().timeZone) {
  try {
    const zone = resolve()
    return typeof zone === 'string' && zone.trim() !== '' ? zone.trim() : 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * 解业务信封：`{data, base_resp: {status_code, status_msg}}`。
 *
 * ⚠️ `credit/details` 是**平铺**的（`total_count` 与 `base_resp` 同级、没有 `data`），
 * 所以这里两种形状都认：有 `data` 取 `data`，没有就把顶层交出去。
 */
export function unwrapMinimaxEnvelope(payload) {
  if (payload === null || typeof payload !== 'object') return { ok: false, error: '响应不是对象' }
  const base = payload.base_resp
  const statusCode = typeof base?.status_code === 'number' ? base.status_code : undefined
  const statusMsg = text(base?.status_msg) ?? ''
  if (statusCode !== undefined && statusCode !== 0) {
    return { ok: false, code: statusCode, error: statusMsg === '' ? `业务码 ${statusCode}` : statusMsg }
  }
  const data = payload.data !== undefined && payload.data !== null && typeof payload.data === 'object' ? payload.data : payload
  return { ok: true, data }
}

/**
 * 解析签到面板（`days` 必须恰好 7 条）。
 *
 * @returns `{{scene: number, days: Array<{dayNo:number, points:number, bonusPoints:number, status:number, isToday:boolean}>}|undefined}`
 */
export function parseSigninPanel(payload) {
  const unwrapped = unwrapMinimaxEnvelope(payload)
  if (!unwrapped.ok) return undefined
  const record = unwrapped.data
  const scene = typeof record.scene === 'number' && Number.isFinite(record.scene) ? record.scene : 0
  const rawDays = record.days
  if (!Array.isArray(rawDays) || rawDays.length !== 7) return undefined
  const days = []
  let today = 0
  let claimable = 0
  for (const raw of rawDays) {
    if (raw === null || typeof raw !== 'object') return undefined
    const dayNo = typeof raw.day_no === 'number' && Number.isFinite(raw.day_no) ? raw.day_no : undefined
    const points = typeof raw.points === 'number' && Number.isFinite(raw.points) && raw.points >= 0 ? raw.points : undefined
    const bonusRaw = raw.bonus_points
    const bonusPoints = bonusRaw === undefined ? 0
      : typeof bonusRaw === 'number' && Number.isFinite(bonusRaw) && bonusRaw >= 0 ? bonusRaw : undefined
    const status = typeof raw.status === 'number' && Number.isFinite(raw.status) ? raw.status : undefined
    if (dayNo === undefined || points === undefined || bonusPoints === undefined || status === undefined) return undefined
    if (typeof raw.is_today !== 'boolean') return undefined
    if (raw.is_today) today += 1
    if (status === MINIMAX_SIGNIN_STATUS.Claimable) claimable += 1
    days.push({ dayNo, points, bonusPoints, status, isToday: raw.is_today })
  }
  // 上游保证「最多 1 条今日 / 最多 1 条可领」；多于一条说明形状变了。
  if (today > 1 || claimable > 1) return undefined
  return { scene, days }
}

/** 面板 → 我们的签到视图（`todayCheckedIn` / `streakDays` / `todayCredit`）。 */
export function signinView(panel) {
  if (panel === undefined) return undefined
  const today = panel.days.find(day => day.isToday)
  const sorted = [...panel.days].sort((a, b) => a.dayNo - b.dayNo)
  const todayIndex = sorted.findIndex(day => day.isToday)
  let index = todayIndex
  let streakDays = 0
  // 连续天数：今天的已领就从今天往前数；今天还没领就从昨天往前数。
  if (today !== undefined && today.status !== MINIMAX_SIGNIN_STATUS.Claimed) index = todayIndex - 1
  for (; index >= 0; index -= 1) {
    if (sorted[index]?.status !== MINIMAX_SIGNIN_STATUS.Claimed) break
    streakDays += 1
  }
  const claimable = panel.days.find(day => day.status === MINIMAX_SIGNIN_STATUS.Claimable)
  const target = today ?? claimable
  return {
    todayCheckedIn: today !== undefined && today.status === MINIMAX_SIGNIN_STATUS.Claimed,
    streakDays,
    // ⚠️ 只报 `points`（总数），不与 `bonus_points` 相加。
    todayCredit: target?.points ?? 0,
    claimable: claimable !== undefined,
  }
}

/** 查签到面板。 */
export async function fetchSigninPanel(credential, { product = MINIMAX_PRODUCTS.minimaxintl, fetch: fetchImpl = fetch, timezoneId, xff } = {}) {
  const url = new URL(`${product.apiHost}${MINIMAX_SIGNIN_STATUS_PATH}`)
  url.searchParams.set('timezone_id', timezoneId ?? resolveTimezoneId())
  const result = await request(url.toString(), { method: 'GET', headers: minimaxHeaders(credential, { product, xff }) }, fetchImpl)
  if (!result.ok) return { error: result.error }
  const panel = parseSigninPanel(result.payload)
  if (panel === undefined) return { error: '签到面板形状不认识' }
  return { panel, view: signinView(panel) }
}

/**
 * 领取签到。
 *
 * ⚠️ 幂等：`claim_result === 2` 是 **already-claimed**（成功语义），不是失败。
 */
export async function claimSignin(credential, { product = MINIMAX_PRODUCTS.minimaxintl, fetch: fetchImpl = fetch, timezoneId, xff } = {}) {
  const url = new URL(`${product.apiHost}${MINIMAX_SIGNIN_CLAIM_PATH}`)
  url.searchParams.set('timezone_id', timezoneId ?? resolveTimezoneId())
  const result = await request(url.toString(), {
    method: 'POST',
    headers: { ...minimaxHeaders(credential, { product, xff }), 'Content-Type': 'application/json' },
    body: '{}',
  }, fetchImpl)
  if (!result.ok) return { kind: 'failed', message: result.error }
  const unwrapped = unwrapMinimaxEnvelope(result.payload)
  if (!unwrapped.ok) return { kind: 'failed', message: unwrapped.error }
  const claimResult = unwrapped.data.claim_result
  if (claimResult === MINIMAX_CLAIM_RESULT.AlreadyClaimed) return { kind: 'already-claimed', message: '今天已领取' }
  if (claimResult !== MINIMAX_CLAIM_RESULT.Claimed) {
    return { kind: 'failed', message: `签到响应缺少有效的 claim_result（${String(claimResult)}）` }
  }
  const points = unwrapped.data.points ?? unwrapped.data.credit
  return { kind: 'claimed', credit: typeof points === 'number' && Number.isFinite(points) ? points : 0 }
}

/** 积分明细（平铺信封）。 */
export async function fetchCreditDetails(credential, { product = MINIMAX_PRODUCTS.minimaxintl, fetch: fetchImpl = fetch, xff } = {}) {
  const result = await request(`${product.apiHost}${MINIMAX_CREDIT_DETAILS_PATH}`, {
    method: 'GET', headers: minimaxHeaders(credential, { product, xff }),
  }, fetchImpl)
  if (!result.ok) return { error: result.error }
  const unwrapped = unwrapMinimaxEnvelope(result.payload)
  if (!unwrapped.ok) return { error: unwrapped.error }
  const total = unwrapped.data.total_count
  return {
    total: typeof total === 'number' && Number.isFinite(total) ? total : (typeof total === 'string' ? Number(total) || 0 : 0),
  }
}

/* ── 权益扩展（接进 `src/channels/index.js` 的 `{statusOf, claim}` 契约） ── */

/**
 * @param {object} options
 * @param {(account: object) => Promise<object|null>} options.credentialOf
 * @param {object} [options.product] - `MINIMAX_PRODUCTS.*`
 * @param {Function} [options.fetch]
 * @param {(accountId: string, credential: object) => Promise<void>} [options.persist] - 续期后回写
 */
export function createMinimaxExtras({ credentialOf, product = MINIMAX_PRODUCTS.minimaxintl, fetch: fetchImpl = fetch, persist } = {}) {
  /** 取一次「可用」的凭据（过期就地续期，续期后回写账号表）。 */
  async function live(account) {
    const raw = await credentialOf(account)
    if (raw === null) return { error: '凭据不可用（需要重新登录）' }
    const ensured = await ensureMinimaxCredential(raw, { product, fetch: fetchImpl })
    if (ensured.error !== undefined) return { error: ensured.error }
    if (ensured.refreshed && typeof persist === 'function' && typeof account?.id === 'string') {
      await persist(account.id, ensured.credential).catch?.(() => {})
    }
    return { credential: ensured.credential }
  }

  async function statusOf(account) {
    const base = {
      accountId: typeof account?.id === 'string' ? account.id : '',
      nickname: typeof account?.nickname === 'string' ? account.nickname : '',
    }
    const resolved = await live(account)
    if (resolved.error !== undefined) return { ...base, error: resolved.error }
    const [models, signin, credits] = await Promise.all([
      fetchMinimaxModels(resolved.credential, { product, fetch: fetchImpl }),
      fetchSigninPanel(resolved.credential, { product, fetch: fetchImpl }),
      fetchCreditDetails(resolved.credential, { product, fetch: fetchImpl }),
    ])
    return {
      ...base,
      // 目录不可用时**不产出 catalog**：`syncOwnCatalog` 会因此退回兜底表，
      // 而不是把「一组空目录」写进选择器。
      ...models.rows === undefined ? { catalogError: models.error } : { catalog: models.rows },
      ...signin.view === undefined ? { checkinError: signin.error } : { checkin: signin.view },
      ...credits.total === undefined ? { balanceError: credits.error } : { balance: { total: credits.total, unit: 'credit' } },
      source: models.rows === undefined ? 'static' : 'live',
      ...models.rows === undefined ? { note: `目录走兜底表（${models.error}）` } : {},
    }
  }

  async function claim(account) {
    const resolved = await live(account)
    if (resolved.error !== undefined) return { kind: 'failed', message: resolved.error }
    return claimSignin(resolved.credential, { product, fetch: fetchImpl })
  }

  return { statusOf, claim }
}
