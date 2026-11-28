/**
 * Accio（阿里）渠道：模型目录、积分余额、（无签到端点）。
 *
 * ## 协议来源
 *
 * 取自 `dsh-providers-hub`（iJetLi，MIT）的真机实测（2026-10-12）：
 *
 * | 用途 | 端点 | token 位置 |
 * | --- | --- | --- |
 * | 模型目录 | `POST /api/llm/config/v2` | **body** `{token}` |
 * | 账号身份 | `POST /api/auth/userinfo` | **body** `{accessToken}` |
 * | 订阅/积分桶 | `GET /api/entitlement/currentSubscription` | **query** `?accessToken=` |
 * | 配额读数 | `GET /api/entitlement/quota` | **query** |
 *
 * ⚠️ 三个只读端点的**传参方式各不相同**，用错就是 405 / 400。本模块把 method 与
 * token 位置绑在同一个参数上（`call()` 的 `tokenIn`），调用点无法只改一处。
 *
 * ## 没有签到
 *
 * Accio 的每日积分由**登录**触发服务端发放，没有可调用的签到端点
 * （上游登记的 `dailyCheckin: false` 是如实的）。`claim()` 因此如实返回 `inactive`，
 * 面板上的「领取」按钮也不会为它出现（`CHANNEL_CREDITS` 里没给 claim）。
 *
 * ## 登录
 *
 * PKCE + loopback（`client_id=accio-work`，公开客户端无 secret）。浏览器打开是
 * `rundll32 url.dll,FileProtocolHandler`，**绝不能** `cmd /c start` —— URL 里的 `&`
 * 会被当命令分隔符截断，症状是「弹请升级客户端」+ 回调永不到达。
 *
 * @module src/channels/accio.js
 */

import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

export const ACCIO_GATEWAY = 'https://phoenix-gw.alibaba.com'
export const ACCIO_LOGIN_CN = 'https://www.accio-ai.com'
export const ACCIO_LOGIN_GLOBAL = 'https://zh.accio.com'
const CLIENT_ID = 'accio-work'
const APP_KEY = 'OneChat'
const APP_VERSION = '0.34.4'

const CATALOG_PATH = '/api/llm/config/v2'
const USERINFO_PATH = '/api/auth/userinfo'
const SUBSCRIPTION_PATH = '/api/entitlement/currentSubscription'
const QUOTA_PATH = '/api/entitlement/quota'
const TOKEN_PATH = '/api/oauth/token'
const REFRESH_PATH = '/api/auth/refresh_token'
const CALLBACK_PATH = '/auth/callback'

const TIMEOUT_MS = 30_000

/** 三类积分桶的展示名与固定顺序（顺序固定，否则面板会「跳行」）。 */
const BUCKETS = Object.freeze([
  { key: 'daily', label: '每日积分' },
  { key: 'monthly', label: '每月积分' },
  { key: 'referral', label: '推荐积分' },
])

/* ── 解析（纯函数） ─────────────────────────────────────────────────────── */

/** 读成有限数字；读不到返回 undefined（**不编造 0**）。接受数字字符串。 */
export function readNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/**
 * 信封判定。
 *
 * `code` 可能是**数字** `401`（上游两种形态都出现过），故按标量字符串归一后比较；
 * 只认字符串会让「未登录」被报成「查询失败」，把用户引向查网络而不是重新登录。
 */
export function parseEnvelope(payload, status) {
  const record = payload !== null && typeof payload === 'object' ? payload : null
  if (record === null) {
    return { ok: false, authFailed: status === 401 || status === 403, message: `HTTP ${status}（响应不是 JSON）` }
  }
  const codeRaw = record.code
  const code = typeof codeRaw === 'string' ? codeRaw.trim() : typeof codeRaw === 'number' ? String(codeRaw) : ''
  const message = [code === '' ? '' : `code=${code}`, typeof record.message === 'string' ? record.message : typeof record.error === 'string' ? record.error : ''].filter(part => part !== '').join(' ')
  const authFailed = status === 401 || status === 403 || code === '401' || code.toUpperCase() === 'NOT_LOGIN'
  const data = record.data !== null && typeof record.data === 'object' ? record.data : undefined
  const ok = status >= 200 && status < 300 && record.success !== false && data !== undefined
  return { ok, authFailed, data, message: message === '' ? `HTTP ${status}` : `HTTP ${status} ${message}` }
}

/** `currentSubscription` → `{total, packages[]}`；一个桶都没有时返回 null。 */
export function parseSubscription(payload) {
  const envelope = payload !== null && typeof payload === 'object' ? payload : {}
  const data = envelope.data !== null && typeof envelope.data === 'object' ? envelope.data : envelope
  const entitlement = data.entitlement !== null && typeof data.entitlement === 'object' ? data.entitlement : undefined
  if (entitlement === undefined) return null
  const packages = []
  for (const bucket of BUCKETS) {
    const value = entitlement[bucket.key]
    if (value === null || typeof value !== 'object') continue
    const remaining = readNumber(value.remaining)
    // 桶存在但余额读不到 ⇒ 跳过（按 0 展示等于把「查不到」说成「已用光」）。
    if (remaining === undefined) continue
    packages.push({
      name: bucket.label,
      remaining,
      total: readNumber(value.total) ?? 0,
      used: readNumber(value.used) ?? 0,
    })
  }
  const top = readNumber(data.remaining)
  if (top === undefined && packages.length === 0) return null
  return {
    total: top ?? packages.reduce((sum, row) => sum + row.remaining, 0),
    packages,
  }
}

/** `config/v2` → 模型行（`visible !== true` 一律剔除；按倍率升序）。 */
export function parseCatalog(payload) {
  // 两种入口都认：整份响应（`{data: [...]}`）与已解包的 `data`（数组本身）。
  // 调用点拿到的是 `envelope.data`，直接传数组时不该静默返回空表。
  const groups = Array.isArray(payload) ? payload
    : Array.isArray(payload?.data) ? payload.data
      : []
  const rows = []
  const seen = new Set()
  for (const group of groups) {
    const list = Array.isArray(group?.modelList) ? group.modelList : []
    for (const raw of list) {
      if (raw === null || typeof raw !== 'object') continue
      if (raw.visible !== true) continue
      const id = typeof raw.modelCode === 'string' ? raw.modelCode : ''
      if (id === '' || seen.has(id)) continue
      seen.add(id)
      const rate = readNumber(raw.effectiveMultiple)
      const name = typeof raw.modelDisplayName === 'string' && raw.modelDisplayName !== '' ? raw.modelDisplayName : id
      rows.push({
        id,
        name: rate === undefined ? name : `${name} · x${Number(rate.toFixed(3))}`,
        ...rate === undefined ? {} : { rate },
        ...readNumber(raw.contextWindow) === undefined ? {} : { contextWindow: readNumber(raw.contextWindow) },
        vision: raw.multimodal === true,
      })
    }
  }
  // 缺倍率排最后；两个都缺返回 0（`Infinity - Infinity` 是 NaN，sort 会退化成不稳定）
  return rows.sort((left, right) => {
    if (left.rate === undefined && right.rate === undefined) return 0
    if (left.rate === undefined) return 1
    if (right.rate === undefined) return -1
    return left.rate - right.rate
  })
}

/** PKCE 对：48 随机字节 → base64url verifier，challenge = S256。 */
export function createPkce() {
  const verifier = crypto.randomBytes(48).toString('base64url')
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') }
}

/** 授权 URL。`code_challenge` 缺一个都会被登录页判成 legacy 客户端。 */
export function buildAuthUrl({ region = 'cn', redirectUri, state, challenge }) {
  const base = region === 'global' ? ACCIO_LOGIN_GLOBAL : ACCIO_LOGIN_CN
  const params = new URLSearchParams({
    return_url: redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    client_id: CLIENT_ID,
    ttid: `ttid_${crypto.randomBytes(16).toString('hex')}`,
    language: 'zh',
  })
  return `${base}/login?${params.toString()}`
}

/**
 * 用系统默认浏览器打开 URL。
 *
 * ⚠️ 绝不能用 `cmd /c start`：`cmd.exe` 把 URL 里的 `&` 当命令分隔符，URL 在第一个
 * `&` 处被截断 ⇒ `code_challenge`/`state` 全丢 ⇒ 弹「请升级客户端」且回调永不到达。
 * `rundll32` 不经过 shell，参数原样交给系统 URL 处理器。
 *
 * 永不抛出：`execFile` 的失败是异步 `'error'` 事件，第三个参数的回调就是它的消费者。
 *
 * `exec` / `platform` 可注入 —— 离线测试据此断言「参数是一个整体、且没有经过 shell」，
 * 而**不需要真的弹出浏览器**。
 */
export function openBrowser(url, { platform = process.platform, exec = execFile } = {}) {
  try {
    if (platform === 'win32') {
      // ⚠️ 只传两个参数：`url.dll,FileProtocolHandler` 与 URL。URL 必须是一个整体，
      // 这也是「不用 cmd /c start」的全部理由。
      exec('rundll32.exe', ['url.dll,FileProtocolHandler', String(url)], () => {})
      return
    }
    exec(platform === 'darwin' ? 'open' : 'xdg-open', [String(url)], () => {})
  } catch { /* 打开失败不影响流程：调用方会把地址显示给用户 */ }
}

/* ── 传输 ────────────────────────────────────────────────────────────────── */

async function call(fetchImpl, { path, method, token, tokenIn, body }) {
  const url = new URL(`${ACCIO_GATEWAY}${path}`)
  const headers = { Accept: 'application/json' }
  let payloadBody
  if (method === 'POST') {
    headers['Content-Type'] = 'application/json'
    payloadBody = JSON.stringify(body ?? (tokenIn === 'body' ? { accessToken: token } : {}))
  } else if (tokenIn === 'query') {
    url.searchParams.set('accessToken', token)
  }
  const response = await fetchImpl(url.toString(), {
    method,
    headers,
    ...payloadBody === undefined ? {} : { body: payloadBody },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  let parsed = null
  try { parsed = text === '' ? {} : JSON.parse(text) } catch { parsed = null }
  return { status: response.status, envelope: parseEnvelope(parsed, response.status) }
}

/* ── 登录（两步式：先回授权地址，再回调查询串） ────────────────────────── */

/**
 * 起一个 loopback 等回调，返回授权 URL。服务器在拿到 code 后立刻关闭。
 *
 * @returns `{loginUrl, waitForCode(timeoutMs)}`
 */
export async function startBrowserLogin({ region = 'cn', timeoutMs = 600_000 } = {}) {
  const http = await import('node:http')
  const pkce = createPkce()
  const state = crypto.randomBytes(32).toString('hex')
  let resolveCode
  const codePromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('登录等待超时')), timeoutMs)
    timer.unref?.()
    resolveCode = value => { clearTimeout(timer); resolve(value) }
  })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('未知的回调路径')
      return
    }
    // `state` 必须原样匹配：少了这层，任何能往 loopback 投查询串的页面都能塞一个 code。
    if (url.searchParams.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('state 校验失败，请回面板重新发起登录')
      return
    }
    const code = url.searchParams.get('code')
    if (code === null || code === '') {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('回调里没有授权码')
      return
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('授权已收到，可以关闭此页面并返回面板。')
    resolveCode({ code, verifier: pkce.verifier, redirectUri })
    server.close()
  })
  const redirectUri = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve(`http://127.0.0.1:${port}${CALLBACK_PATH}`)
    })
  })
  return {
    loginUrl: buildAuthUrl({ region, redirectUri, state, challenge: pkce.challenge }),
    waitForCode: () => codePromise,
    close: () => server.close(),
  }
}

/** 授权码换 token（公开客户端，**没有** client_secret）。 */
export async function exchangeCode({ code, codeVerifier, redirectUri, fetch: fetchImpl = fetch }) {
  const response = await fetchImpl(`${ACCIO_GATEWAY}${TOKEN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ code, codeVerifier, clientId: CLIENT_ID, redirectUri }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  let payload = null
  try { payload = JSON.parse(text) } catch { payload = null }
  const envelope = parseEnvelope(payload, response.status)
  if (!envelope.ok) return { error: `令牌交换失败：${envelope.message}` }
  const data = envelope.data
  const accessToken = typeof data.accessToken === 'string' ? data.accessToken : ''
  const refreshToken = typeof data.refreshToken === 'string' ? data.refreshToken : ''
  const rawExpiry = readNumber(data.expiresAt)
  // 上游 `expiresAt` 是**秒**；忘了归一化会得到 1970 年 ⇒ 每请求都续期 ⇒ 消费 RT。
  const expiresAt = rawExpiry === undefined ? undefined : rawExpiry > 1e12 ? Math.round(rawExpiry) : Math.round(rawExpiry * 1000)
  if (accessToken === '' || refreshToken === '') return { error: '令牌交换响应缺少 accessToken / refreshToken' }
  return { credential: { access_token: accessToken, refresh_token: refreshToken, ...expiresAt === undefined ? {} : { expires_at: expiresAt } }, region: 'cn' }
}

/**
 * 账号身份：`POST /api/auth/userinfo`（token 在 **body**，GET 会 405）。
 *
 * 兑换响应**不含任何身份字段**，所以登录后必须补这一次；否则账号列表只能显示
 * 账号 id，用户没法区分自己登的是哪个号。返回的 `routeRegion` 同时用于记住
 * 区域（续期/推理按它选域）。
 */
export async function fetchAccioUserInfo(accessToken, { fetch: fetchImpl = fetch } = {}) {
  const token = typeof accessToken === 'string' ? accessToken.trim() : ''
  if (token === '') return { error: '没有 access_token' }
  let result
  try {
    result = await call(fetchImpl, { path: USERINFO_PATH, method: 'POST', token, tokenIn: 'body', body: { accessToken: token } })
  } catch (error) {
    return { error: `身份查询失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!result.envelope.ok) return { error: `身份查询失败：${result.envelope.message}` }
  const data = result.envelope.data ?? {}
  return {
    info: {
      ...typeof data.userId === 'string' && data.userId !== '' ? { userId: data.userId } : {},
      ...typeof data.userName === 'string' && data.userName !== '' ? { userName: data.userName } : {},
      ...typeof data.maskedMobile === 'string' && data.maskedMobile !== '' ? { maskedMobile: data.maskedMobile } : {},
      ...typeof data.routeRegion === 'string' && data.routeRegion !== '' ? { routeRegion: data.routeRegion } : {},
      ...typeof data.userLevel === 'string' && data.userLevel !== '' ? { userLevel: data.userLevel } : {},
    },
  }
}

/** 距到期不足 5 分钟才续期（`refresh_token` 会被轮换，绝不能每个请求都刷）。 */
export function shouldRefreshAccio(credential, now = Date.now()) {
  const expiresAt = readNumber(credential?.expires_at)
  if (expiresAt === undefined || expiresAt <= 0) return false
  return expiresAt - 5 * 60_000 <= now
}

/**
 * 续期：`POST /api/auth/refresh_token` `{accessToken, refreshToken}`。
 *
 * ⚠️ 参考实现记录「续期会**轮换** refresh_token」，而该端点本身仍未实测 ⇒
 * 调用方必须**串行**（同进程内按账号排队），成功后立刻落盘；失败不判终态，
 * 让用户还能手动重新登录。
 */
export async function refreshAccioCredential(credential, { fetch: fetchImpl = fetch } = {}) {
  const accessToken = typeof credential?.access_token === 'string' ? credential.access_token : ''
  const refreshToken = typeof credential?.refresh_token === 'string' ? credential.refresh_token : ''
  if (accessToken === '' || refreshToken === '') return { error: '凭据里没有 access_token / refresh_token（需要重新登录）' }
  let result
  try {
    result = await call(fetchImpl, {
      path: REFRESH_PATH,
      method: 'POST',
      token: accessToken,
      tokenIn: 'body',
      body: { accessToken, refreshToken },
    })
  } catch (error) {
    return { error: `续期失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!result.envelope.ok) return { error: `续期失败：${result.envelope.message}`, terminal: result.envelope.authFailed === true }
  const data = result.envelope.data ?? {}
  const nextAccess = typeof data.accessToken === 'string' ? data.accessToken : ''
  const nextRefresh = typeof data.refreshToken === 'string' && data.refreshToken !== '' ? data.refreshToken : refreshToken
  const rawExpiry = readNumber(data.expiresAt)
  const expiresAt = rawExpiry === undefined ? undefined : rawExpiry > 1e12 ? Math.round(rawExpiry) : Math.round(rawExpiry * 1000)
  if (nextAccess === '') return { error: '续期响应缺少 accessToken' }
  return {
    credential: {
      ...credential,
      access_token: nextAccess,
      refresh_token: nextRefresh,
      ...expiresAt === undefined ? {} : { expires_at: expiresAt },
      ...typeof data.sgcookie === 'string' && data.sgcookie !== '' ? { sgcookie: data.sgcookie } : {},
    },
    refreshed: true,
  }
}

/* ── 权益 ────────────────────────────────────────────────────────────────── */

export function createAccioExtras({ credentialOf, fetch: fetchImpl = fetch }) {
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

    // 目录：token 在 **body**。Accio 的 modelCode 非人类可读，没有静态兜底表，
    // 所以失败必须把原因带出去——否则面板上只剩「这个渠道 0 个模型」。
    let catalog = []
    let catalogError
    try {
      const result = await call(fetchImpl, { path: CATALOG_PATH, method: 'POST', token, tokenIn: 'body', body: { token } })
      if (result.envelope.ok) catalog = parseCatalog(result.envelope.data)
      else catalogError = `目录查询失败：${result.envelope.message}`
    } catch (failure) {
      catalogError = `目录查询失败：${failure instanceof Error ? failure.message : String(failure)}`
    }

    // 订阅：token 在 **query**
    let info = null
    let error
    try {
      const result = await call(fetchImpl, { path: SUBSCRIPTION_PATH, method: 'GET', token, tokenIn: 'query' })
      if (result.envelope.authFailed) error = '未登录或登录已过期（NOT_LOGIN），请重新登录 Accio 账号'
      else if (!result.envelope.ok) error = `积分查询失败：${result.envelope.message}`
      else info = parseSubscription({ data: result.envelope.data })
      if (info === null && error === undefined) error = '积分查询失败：响应未包含余额字段'
    } catch (failure) {
      error = `积分查询失败：${failure instanceof Error ? failure.message : String(failure)}`
    }

    return {
      ...base,
      ...error === undefined ? {} : { error },
      ...info === null ? {} : { info },
      ...catalogError === undefined ? {} : { catalogError },
      ...catalog.length === 0 ? {} : { source: 'live' },
      // Accio 的 modelCode 非人类可读（如 `1Drift-N8kP2Q7wR5mX`），目录必须来自远端。
      catalog,
    }
  }

  /** Accio 没有签到端点（每日积分由登录触发服务端发放）。 */
  async function claim() {
    return { kind: 'inactive', message: 'Accio 没有签到接口：每日积分在登录时由服务端发放' }
  }

  return { statusOf, claim }
}