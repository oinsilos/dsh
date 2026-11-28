/**
 * OfficeAce（华为云 AgentArts）的 OAuth 登录腿：PKCE + **DPoP**。
 *
 * ## 为什么必须 DPoP
 *
 * `pdp5_for_agentarts` 是**公开客户端**（无 secret）⇒ 华为 STS 用 DPoP 绑定
 * 「这张令牌只发给持私钥的那个人」。`DPoP` 头是一枚 ES256 JWT：
 *
 * ```
 * header  { alg: 'ES256', typ: 'dpop+jwt', jwk: <公钥 JWK> }
 * payload { htm, htu, iat, jti }
 * ```
 *
 * ⚠️ 私钥**必须持久化**：续期要用**同一把**密钥签，换钥等于换身份（refresh 会被拒）。
 *
 * ## 三条硬判据
 *
 * 1. **code 是秒级有效** ⇒ 拿到后立刻换 token，不能拆成两步交互；
 * 2. **refresh_token 一次性** ⇒ 续期成功必须立即落盘新 token，重放触发 `STS5.1806`；
 * 3. `htu` 必须是**完整 URL**（含 scheme 与 path），`htm` 是大写方法名。
 *
 * 全部用 `node:crypto` 实现（ES256 用 `dsaEncoding: 'ieee-p1363'` 得到 JOSE 要的
 * 64 字节 r||s），不引 jose —— 少一个依赖，也避免与宿主 Electron 的版本打架。
 *
 * @module src/channels/officeace-auth.js
 */

import crypto from 'node:crypto'
import { OFFICEACE } from './officeace.js'

/** PKCE 配对：verifier 48 字节 base64url，challenge = S256。 */
export function pkcePair() {
  const codeVerifier = crypto.randomBytes(48).toString('base64url')
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url')
  return { codeVerifier, codeChallenge }
}

/** 生成持久化的 DPoP 密钥对（私钥 JWK 要写进凭据）。 */
export function generateDpopKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const privateJwk = privateKey.export({ format: 'jwk' })
  const publicJwk = publicKey.export({ format: 'jwk' })
  return { privateJwk, publicJwk }
}

const b64url = value => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')

/**
 * 签一枚 DPoP JWT。
 *
 * @param {object} privateJwk - `generateDpopKey().privateJwk`
 * @param {string} htm - HTTP 方法（大写）
 * @param {string} htu - **完整** URL
 */
export function signDpop(privateJwk, htm, htu) {
  const key = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' })
  const publicJwk = crypto.createPublicKey(key).export({ format: 'jwk' })
  const header = { alg: 'ES256', typ: 'dpop+jwt', jwk: publicJwk }
  const payload = {
    htm: String(htm).toUpperCase(),
    htu: String(htu),
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomBytes(16).toString('hex'),
  }
  const signingInput = `${b64url(header)}.${b64url(payload)}`
  const signature = crypto.sign('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' })
  return `${signingInput}.${signature.toString('base64url')}`
}

/** 解一枚 DPoP JWT（测试与诊断用；**不验签**）。 */
export function decodeDpop(token) {
  const parts = String(token ?? '').split('.')
  if (parts.length !== 3) return undefined
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')),
      payload: JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')),
      signature: parts[2],
    }
  } catch {
    return undefined
  }
}

/** 授权页 URL（PKCE + state）。 */
export function authorizeUrl({ state, codeChallenge, base = OFFICEACE.clawBase }) {
  // 华为的授权页在 clawBase 的 OAuth 端点下；参数名与标准 OAuth2 一致。
  const url = new URL(`${base}/v1/claw/auth/authorize`)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', OFFICEACE.clientId)
  url.searchParams.set('redirect_uri', OFFICEACE.redirectUri)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  if (typeof state === 'string' && state !== '') url.searchParams.set('state', state)
  return url.toString()
}

/**
 * 这个 URL 是不是**回调**（而不是授权页本身）。
 *
 * ⚠️ 只认路径会把「授权页里嵌的 `redirect_uri` 参数」当成已回调 —— 页面刚打开就
 * 误判登录成功。必须同时带 `code=` 或 `error=`（与 Marvis 那条判据同型）。
 *
 * 回调落在**上游主机**（`agentarts…/v1/claw/auth/callback`），所以由宿主的浏览器
 * 在 `Fetch.requestPaused` 阶段截停 —— 请求不出网，code 也不会被上游消费一次。
 */
export function isOfficeaceCallbackUrl(url) {
  let parsed
  let expected
  try {
    parsed = new URL(String(url))
    expected = new URL(OFFICEACE.redirectUri)
  } catch { return false }
  if (parsed.origin !== expected.origin || parsed.pathname !== expected.pathname) return false
  return parsed.searchParams.has('code') || parsed.searchParams.has('error')
}

async function tokenRequest(body, privateJwk, { fetch: fetchImpl = fetch, tokenUrl = OFFICEACE.tokenUrl } = {}) {
  const form = new URLSearchParams(body).toString()
  let response
  try {
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        DPoP: signDpop(privateJwk, 'POST', tokenUrl),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
      signal: AbortSignal.timeout(60_000),
    })
  } catch (error) {
    return { error: `token 请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const raw = await response.text().catch(() => '')
  let payload
  try { payload = raw === '' ? undefined : JSON.parse(raw) } catch { payload = undefined }
  if (!response.ok) {
    return { error: `token 响应 HTTP ${response.status}：${raw.slice(0, 200)}` }
  }
  return { payload }
}

/**
 * 用授权码换 token（**立刻换**，code 秒级过期）。
 *
 * 响应里 `credentials.access_key_id/secret_access_key/security_token` 是 STS 三段，
 * `refresh_token` 是 30 天的一次性凭据。
 */
export async function exchangeOfficeaceCode({ code, codeVerifier, privateJwk, fetch: fetchImpl = fetch } = {}) {
  const result = await tokenRequest({
    grant_type: 'authorization_code',
    code: String(code ?? ''),
    code_verifier: String(codeVerifier ?? ''),
    client_id: OFFICEACE.clientId,
    redirect_uri: OFFICEACE.redirectUri,
  }, privateJwk, { fetch: fetchImpl })
  if (result.error !== undefined) return { error: result.error }
  const payload = result.payload ?? {}
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : undefined
  const refreshToken = typeof payload.refresh_token === 'string' ? payload.refresh_token : undefined
  if (accessToken === undefined && payload.credentials === undefined) {
    // 不要把整份响应写进错误：这份 payload 里就带着 30 天有效的一次性
    // `refresh_token`，错误会进面板、日志和会话记录。只列字段名。
    return { error: `token 响应里没有 access_token（响应字段：${Object.keys(payload).slice(0, 12).join(', ') || '空'}）` }
  }
  const expiresIn = Number(payload.expires_in)
  return {
    credential: {
      access_token: accessToken ?? String(payload.credentials?.security_token ?? ''),
      ...refreshToken === undefined ? {} : { refresh_token: refreshToken },
      ...payload.credentials === undefined ? {} : { sts: payload.credentials },
      // 续期闸门要用：没有到期时间就只能「永不自动续期」或「每请求都烧一次性
      // refresh_token」。上游给 expires_in 时记下来（秒 → 毫秒）。
      ...Number.isFinite(expiresIn) && expiresIn > 0 ? { expires_at: Date.now() + expiresIn * 1000 } : {},
      privateJwk,
      provider: 'officeace',
    },
  }
}

/** 续期（**一次性** refresh_token：成功后必须立刻落盘）。 */
export async function refreshOfficeaceToken({ refreshToken, privateJwk, fetch: fetchImpl = fetch } = {}) {
  if (typeof refreshToken !== 'string' || refreshToken === '') return { error: '没有 refresh_token（需要重新登录）' }
  const result = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OFFICEACE.clientId,
  }, privateJwk, { fetch: fetchImpl })
  if (result.error !== undefined) return { error: result.error, terminal: /STS5\.1806|invalid_grant/.test(result.error) }
  const payload = result.payload ?? {}
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : String(payload.credentials?.security_token ?? '')
  if (accessToken === '') return { error: '续期响应里没有 token' }
  const expiresIn = Number(payload.expires_in)
  return {
    credential: {
      access_token: accessToken,
      refresh_token: typeof payload.refresh_token === 'string' && payload.refresh_token !== '' ? payload.refresh_token : refreshToken,
      ...payload.credentials === undefined ? {} : { sts: payload.credentials },
      ...Number.isFinite(expiresIn) && expiresIn > 0 ? { expires_at: Date.now() + expiresIn * 1000 } : {},
      privateJwk,
      provider: 'officeace',
    },
    refreshed: true,
  }
}
