/**
 * 腾讯 Marvis（`marvis`）的账号、钱包与推理协议。
 *
 * ## 两条腿的鉴权**不一样**（这是本家最容易踩的坑）
 *
 * | 腿 | 头 | 说明 |
 * | --- | --- | --- |
 * | 模型网关 `/v1/chat/completions` | `Ual-Access-Openid/Access-Token/Login-Type/Guid` + `Marvis-*` | **不带** UAL 签名头 |
 * | 业务 `/v3/*`、`/marvis_client/*` | 上面四项 **+ 签名四件套**（`Ual-Access-Businessid/Timestamp/Nonce/Signature`） | 网关加了签名会被判「登录态过期」 |
 *
 * 签名：`md5(query + timestamp + ACCESS_KEY + nonce)`，32 位小写 hex；
 * GET 的 query 是查询串（不含 `?`），POST 的 query 是 **body 原文**。
 *
 * ## 登录：回调是**一次性 code 兑换入口**
 *
 * `https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth` 既是 redirect_uri
 * 也是一次性兑换点：浏览器真发出这个请求，code 就被消费；而且它要求
 * `Ual-Access-Guid` 请求头（浏览器顶层导航带不了）。所以登录必须：
 * 起一个隔离浏览器 → 在 `Fetch.requestPaused` 阶段**拦停**这个 URL →
 * 由 Node 带 guid 换**唯一一次** code。拦截逻辑在 `browser/chromium.js`。
 *
 * 成功响应是 **302 + Set-Cookie**（不是 JSON）：`accesstoken` / `openid` /
 * `refreshtoken` / `access_token_expire_time` / `nickname` 都在 cookie 里。
 *
 * ## 续期：`expires_in` 是**字符串**
 *
 * 实测 `{"code":0,"user_info":{…,"expires_in":"7200"}}`。只认 number 会导致
 * 「续期成功也不推进 expiresAt」→ 面板永远显示已过期。必须宽容解析。
 *
 * ## 没有签到
 *
 * 令牌额度由服务端每日发放，上游**没有**签到端点（钱包是只读的）。
 * 面板上的「领取」如实回 `inactive`，不假装成功。
 *
 * @module src/channels/marvis.js
 */

import crypto from 'node:crypto'

export const MARVIS_BASE_URL = 'https://yybadaccess.3g.qq.com'
/** 业务接口签名密钥（官方客户端内置，所有客户端共用）。 */
export const MARVIS_ACCESS_KEY = 'fpzkeTlcGLVP37qiOWd29MyaOqaJYxMi'
export const MARVIS_BUSINESS_ID = 'marvis_client'
export const MARVIS_BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Marvis/1.60.3300.408'
export const MARVIS_CLIENT_UA = 'AsyncOpenAI/Python 2.32.0'
export const MARVIS_QQ_APP_ID = '1903794758'
export const MARVIS_WX_APP_ID = 'wxb650708317d56f88'
export const MARVIS_REDIRECT_URI = `${MARVIS_BASE_URL}/marvis_client_login/marvis_oauth`
export const MARVIS_DEFAULT_CLIENT_VERSION = '1.60.3300.765'

export const MARVIS_WALLET_PATH = '/v3/marvis_get_wallet'
export const MARVIS_REFRESH_PATH = '/marvis_client_login/marvis_refresh_token'
export const MARVIS_USER_INFO_PATH = '/marvis_client/marvis_get_user_info'
export const MARVIS_CHAT_PATH = '/v1/chat/completions'

/** 兜底有效期（毫秒）：上游没给 `access_token_expire_time` 时用（实测两站都是 2 小时）。 */
export const MARVIS_QQ_TTL_MS = 2 * 60 * 60 * 1000
export const MARVIS_WECHAT_TTL_MS = 2 * 60 * 60 * 1000

/** 唯一上行槽位（真实模型 id 直传会 400 `4130001 无效模型id`）。 */
export const MARVIS_SLOT_ID = 'deepseek-v4-pro-external'

/**
 * 目录只有一条 —— 这是**产品决策**，不是上游目录的镜像：其余槽位属于 Marvis
 * 自己的产品线。`contextWindow: 0` 在参考实现里是「不知道」的哨兵，我们这里
 * 直接写实测口径 1M，并在目录行里如实标注。
 */
export const MARVIS_MODELS = Object.freeze([
  { id: MARVIS_SLOT_ID, name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, vision: true, reasoning: true },
])

/** 登录码：`'1'` = QQ，`'2'` = 微信。 */
export function marvisLanguageOf(loginType) {
  return loginType === '2' ? 'WX' : 'QC'
}

/** 账号展示名：`QQ·昵称` / `微信·昵称`。 */
export function marvisAccountLabel(nickname, loginType) {
  const platform = loginType === '2' ? '微信' : 'QQ'
  const name = typeof nickname === 'string' ? nickname.trim() : ''
  return name === '' ? platform : `${platform}·${name}`
}

/**
 * 授权页 URL。
 *
 * - QQ：`state` 必须是**小数**（整数上游会拒），`login_type=QC` 挂在 redirect_uri 的 query 上；
 * - 微信：`state` 就是设备 guid（回调时靠它取回同一个 guid）。
 */
export function marvisAuthorizeUrl(loginType, guid, state) {
  if (loginType === '1') {
    const qqState = typeof state === 'string' && state !== '' ? state : `0.${String(Math.random()).slice(2)}`
    return `https://graph.qq.com/oauth2.0/authorize?${new URLSearchParams({
      which: 'Login',
      display: 'pc',
      response_type: 'code',
      client_id: MARVIS_QQ_APP_ID,
      redirect_uri: `${MARVIS_REDIRECT_URI}?login_type=QC`,
      state: qqState,
    }).toString()}`
  }
  return `https://open.weixin.qq.com/connect/qrconnect?${new URLSearchParams({
    appid: MARVIS_WX_APP_ID,
    redirect_uri: `${MARVIS_REDIRECT_URI}?login_type=WX`,
    response_type: 'code',
    scope: 'snsapi_login',
    state: guid,
  }).toString()}`
}

/**
 * 这个 URL 是不是**回调**（而不是授权页本身）。
 *
 * ⚠️ 只认路径会把「授权页里嵌的 redirect_uri 参数」当成回调 —— 页面刚打开就
 * 误判成功。必须同时带 `code=` 或 `error=`。
 */
export function isMarvisCallbackUrl(url) {
  let parsed
  try { parsed = new URL(String(url)) } catch { return false }
  if (!parsed.pathname.toLowerCase().includes('marvis_client_login/marvis_oauth')) return false
  return parsed.searchParams.has('code') || parsed.searchParams.has('error')
}

/**
 * 一次性的 code 兑换。
 *
 * @returns `{credential}` 或 `{error}`
 */
export async function exchangeMarvisCode({ code, loginType, guid, state, fetch: fetchImpl = fetch } = {}) {
  const search = new URLSearchParams({ login_type: marvisLanguageOf(loginType), code: String(code ?? '') })
  if (typeof state === 'string' && state !== '') search.set('state', state)
  let response
  try {
    response = await fetchImpl(`${MARVIS_REDIRECT_URI}?${search.toString()}`, {
      method: 'GET',
      redirect: 'manual',
      headers: { Accept: '*/*', 'User-Agent': MARVIS_BROWSER_UA, 'Ual-Access-Guid': String(guid ?? '') },
      signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    return { error: `Marvis 登录请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const cookies = parseSetCookies(response)
  const accessToken = cookies['accesstoken']
  if (typeof accessToken === 'string' && accessToken !== '') {
    const openid = cookies['openid'] ?? ''
    if (openid === '') return { error: 'Marvis 登录响应缺少 openid（无法把该账号与设备绑定）' }
    const refreshToken = cookies['refreshtoken'] ?? ''
    // 没有 refresh 意味着几天后必死且无法自愈 —— 当场说清，不静默收下。
    if (refreshToken === '') return { error: 'Marvis 登录响应缺少 refresh_token（该账号将无法自动续期）' }
    const rawExpire = Number(cookies['access_token_expire_time'] ?? '')
    const expiresAtMs = Number.isFinite(rawExpire) && rawExpire > 0
      ? (rawExpire > 1e12 ? rawExpire : rawExpire * 1000)
      : Date.now() + (loginType === '2' ? MARVIS_WECHAT_TTL_MS : MARVIS_QQ_TTL_MS)
    const nickname = cookies['nickname']
    return {
      credential: {
        access_token: accessToken,
        refresh_token: refreshToken,
        openid,
        guid: String(guid ?? ''),
        login_type: loginType,
        ...typeof nickname === 'string' && nickname !== '' ? { nickname } : {},
        expires_at: expiresAtMs,
        provider: 'marvis',
      },
    }
  }
  const text = await response.text().catch(() => '')
  const businessCode = /"code"\s*:\s*(-?\d+)/.exec(text)?.[1]
  if (businessCode === '-107') return { error: 'Marvis 授权码已失效（-107）：请重新登录' }
  if (businessCode === '-109') return { error: 'Marvis 登录参数无效（-109）：缺少 guid 或 login_type' }
  return { error: `Marvis 登录响应里没有 access_token（HTTP ${response.status}）` }
}

/** 把 `Set-Cookie` 列表解成 `name → value`（值做 decodeURIComponent）。 */
export function parseSetCookies(response) {
  const out = {}
  const list = typeof response?.headers?.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  for (const row of list) {
    const first = String(row).split(';')[0]
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    try { out[name] = decodeURIComponent(value) } catch { out[name] = value }
  }
  return out
}

/** `/v3/*` 业务签名：`md5(query + timestamp + ACCESS_KEY + nonce)`。 */
export function ualSignature(query, timestamp, nonce) {
  return crypto.createHash('md5').update(`${query}${timestamp}${MARVIS_ACCESS_KEY}${nonce}`).digest('hex')
}

/** `/v3/*` 业务头（带签名四件套）。 */
export function businessHeaders(credential, { query, now = Date.now(), nonce } = {}) {
  const timestamp = String(now)
  const n = typeof nonce === 'string' && nonce !== '' ? nonce : String(1000 + Math.floor(Math.random() * 9000))
  return {
    Accept: '*/*',
    'Content-Type': 'application/json; charset=utf-8',
    'User-Agent': MARVIS_BROWSER_UA,
    'Ual-Access-Businessid': MARVIS_BUSINESS_ID,
    'Ual-Access-Timestamp': timestamp,
    'Ual-Access-Nonce': n,
    'Ual-Access-Signature': ualSignature(String(query ?? ''), timestamp, n),
    'Ual-Access-Guid': String(credential?.guid ?? ''),
    'Ual-Access-Access-Token': String(credential?.access_token ?? ''),
    'Ual-Access-Login-Type': String(credential?.login_type ?? '1'),
    'Ual-Access-Openid': String(credential?.openid ?? ''),
  }
}

/** 模型网关头（**不带**签名四件套）。 */
export function chatHeaders(credential) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': MARVIS_CLIENT_UA,
    Authorization: 'Bearer placeholder',
    'Ual-Access-Openid': String(credential?.openid ?? ''),
    'Ual-Access-Access-Token': String(credential?.access_token ?? ''),
    'Ual-Access-Login-Type': String(credential?.login_type ?? '1'),
    'Ual-Access-Guid': String(credential?.guid ?? ''),
    'X-Device-GUID': String(credential?.guid ?? ''),
    'Marvis-AgentTag': 'auto_discovery',
    'Marvis-Scene': 'preload_summary',
    'Marvis-Protocol-Version': '1000',
  }
}

/** 宽容读秒（number 或字符串数字）。 */
function readSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return undefined
}

/** 凭据是否过期（60 秒余量）。 */
export function isMarvisExpired(credential, now = Date.now()) {
  const expiresAt = Number(credential?.expires_at)
  return Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt - 60_000 <= now
}

/**
 * 续期。
 *
 * ⚠️ `loginType` 恒为字面量 `'Marvis'`（不是 QC/WX）；
 * ⚠️ `expires_in` 是字符串，必须宽容解析，否则「续期成功也不推进到期时间」。
 */
export async function refreshMarvisCredential(credential, { fetch: fetchImpl = fetch, now = Date.now } = {}) {
  const refreshToken = typeof credential?.refresh_token === 'string' ? credential.refresh_token : ''
  if (refreshToken === '') return { error: '凭据里没有 refresh_token（需要重新登录）' }
  const body = JSON.stringify({
    userInfo: {
      openId: String(credential.openid ?? ''),
      refreshToken,
      accessToken: String(credential.access_token ?? ''),
      loginType: 'Marvis',
    },
  })
  let response
  try {
    response = await fetchImpl(`${MARVIS_BASE_URL}${MARVIS_REFRESH_PATH}`, {
      method: 'POST',
      headers: businessHeaders(credential, { query: body }),
      body,
      signal: AbortSignal.timeout(30_000),
    })
  } catch (error) {
    return { error: `Marvis 续期请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const text = await response.text().catch(() => '')
  let json
  try { json = JSON.parse(text) } catch { return { error: `Marvis 续期响应不是 JSON（HTTP ${response.status}）` } }
  if (json?.code !== 0) {
    const message = `Marvis 续期失败（code ${String(json?.code)} ${String(json?.msg ?? '')}）`
    // -107 / -101 是终态：refresh_token 已死，再试也不会好。
    if (json?.code === -107 || json?.code === -101) return { error: message, terminal: true }
    return { error: message }
  }
  const info = json.user_info ?? {}
  const accessToken = typeof info.access_token === 'string' && info.access_token !== '' ? info.access_token : credential.access_token
  const nextRefresh = typeof info.refresh_token === 'string' && info.refresh_token !== '' ? info.refresh_token : refreshToken
  const expiresIn = readSeconds(info.expires_in)
  // `now` 是注入点（测试传函数）。默认值曾经在解构时**调用**了一次，于是
  // 函数体里 `now()` 拿到的是数字 → TypeError；而且此时上游已经轮换过
  // refresh_token，失败一次就把账号废掉。
  const at = typeof now === 'function' ? now() : Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const expiresAt = expiresIn === undefined
    ? (Number(credential.expires_at) > 0 ? Number(credential.expires_at) : at + MARVIS_QQ_TTL_MS)
    : at + expiresIn * 1000
  return {
    credential: { ...credential, access_token: accessToken, refresh_token: nextRefresh, expires_at: expiresAt, provider: 'marvis' },
    refreshed: true,
  }
}

/** 确保可用凭据：过期才续期。 */
export async function ensureMarvisCredential(credential, { fetch: fetchImpl = fetch } = {}) {
  if (credential === null || typeof credential !== 'object') return { error: '凭据不可用（需要重新登录）' }
  if (!isMarvisExpired(credential)) return { credential, refreshed: false }
  const refreshed = await refreshMarvisCredential(credential, { fetch: fetchImpl })
  if (refreshed.error !== undefined) {
    // 续期失败但手上还有令牌：发出去让上游判，别在本地判死。
    const fallback = typeof credential.access_token === 'string' && credential.access_token !== '' ? credential : null
    return fallback === null ? { error: refreshed.error } : { credential: fallback, refreshed: false, refreshError: refreshed.error }
  }
  return refreshed
}

/** 读金额：`number` 或**字符串数字**（实测就是字符串）；读不到返回 `undefined`（不是 0）。 */
export function readMarvisAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? Math.floor(value) : undefined
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim())
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : undefined
  }
  return undefined
}

/**
 * 钱包余额：`POST /v3/marvis_get_wallet`，body `'{}'`，签名的 query 就是 body 原文。
 *
 * 失败分三类（用户动作完全不同）：401/403 ⇒ 登录态过期；`code !== 0` ⇒ 上游拒绝；
 * `code === 0` 但缺字段 ⇒ 上游改版。**读数缺失绝不回落成 0**（0 是「用光」）。
 */
export async function fetchMarvisWallet(credential, { fetch: fetchImpl = fetch } = {}) {
  const body = '{}'
  let response
  try {
    response = await fetchImpl(`${MARVIS_BASE_URL}${MARVIS_WALLET_PATH}`, {
      method: 'POST',
      headers: businessHeaders(credential, { query: body }),
      body,
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error) {
    return { error: `钱包查询失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (response.status === 401 || response.status === 403) return { error: '登录态已过期或凭据无效（钱包端点 401/403），请重新登录' }
  const text = await response.text().catch(() => '')
  let json
  try { json = JSON.parse(text) } catch { return { error: `钱包响应不是 JSON（HTTP ${response.status}）` } }
  const code = typeof json?.code === 'number' ? json.code : Number(json?.code)
  if (Number.isFinite(code) && code !== 0) return { error: `上游拒绝（code ${code} ${String(json.msg ?? '')}）` }
  const data = json?.data ?? {}
  const total = readMarvisAmount(data.total_tokens)
  const used = readMarvisAmount(data.used_tokens)
  const remaining = readMarvisAmount(data.avail_tokens)
  if (total === undefined && remaining === undefined) return { error: '钱包报文里没有可识别的额度字段（上游可能改版）' }
  return {
    balance: {
      unit: 'token',
      ...total === undefined ? {} : { total },
      ...used === undefined ? {} : { used },
      ...remaining === undefined ? {} : { remaining },
      ...readMarvisAmount(data.frozen_tokens) === undefined ? {} : { frozen: readMarvisAmount(data.frozen_tokens) },
    },
  }
}

/** 目录行（静态，单条）。 */
export function marvisCatalogRows() {
  return MARVIS_MODELS.map(model => ({
    id: model.id,
    name: model.name,
    contextWindow: model.contextWindow,
    vision: model.vision === true,
    reasoning: model.reasoning !== false,
  }))
}

/** 权益扩展：钱包只读；**没有签到**，如实回 inactive。 */
export function createMarvisExtras({ credentialOf, fetch: fetchImpl = fetch, persist } = {}) {
  async function live(account) {
    const raw = await credentialOf(account)
    if (raw === null) return { error: '凭据不可用（需要重新登录）' }
    const ensured = await ensureMarvisCredential(raw, { fetch: fetchImpl })
    if (ensured.error !== undefined) return { error: ensured.error }
    if (ensured.refreshed === true && typeof persist === 'function' && typeof account?.id === 'string') {
      try { await persist(account.id, ensured.credential) } catch { /* 落盘失败不影响本回合 */ }
    }
    return { credential: ensured.credential }
  }

  async function statusOf(account) {
    const base = {
      accountId: typeof account?.id === 'string' ? account.id : '',
      nickname: typeof account?.nickname === 'string' ? account.nickname : '',
    }
    const resolved = await live(account)
    const catalog = marvisCatalogRows()
    if (resolved.error !== undefined) return { ...base, catalog, error: resolved.error }
    const wallet = await fetchMarvisWallet(resolved.credential, { fetch: fetchImpl })
    return {
      ...base,
      catalog,
      source: 'static',
      ...wallet.balance === undefined ? { balanceError: wallet.error } : { balance: wallet.balance },
    }
  }

  async function claim() {
    return { kind: 'inactive', message: 'Marvis 没有每日签到接口：令牌额度由服务端每日发放，无需手动领取' }
  }

  return { statusOf, claim }
}
