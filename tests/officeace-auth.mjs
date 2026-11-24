/**
 * OfficeAce 登录腿测试（离线）：PKCE、DPoP JWT 形状与可验签性、换码/续期请求体。
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  authorizeUrl,
  decodeDpop,
  exchangeOfficeaceCode,
  generateDpopKey,
  pkcePair,
  refreshOfficeaceToken,
  signDpop,
} from '../src/channels/officeace-auth.js'
import { OFFICEACE, officeaceCatalogRows } from '../src/channels/officeace.js'

/* 1. PKCE 与授权页 */
{
  const { codeVerifier, codeChallenge } = pkcePair()
  assert.equal(codeChallenge, crypto.createHash('sha256').update(codeVerifier).digest('base64url'))
  const url = new URL(authorizeUrl({ state: 's1', codeChallenge }))
  assert.equal(url.searchParams.get('client_id'), 'pdp5_for_agentarts')
  assert.equal(url.searchParams.get('redirect_uri'), OFFICEACE.redirectUri)
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(url.searchParams.get('state'), 's1')
  console.log('ok 1/4 PKCE 与授权页')
}

/* 2. DPoP：头/载荷/可验签 */
{
  const { privateJwk } = generateDpopKey()
  const token = signDpop(privateJwk, 'post', OFFICEACE.tokenUrl)
  const parts = token.split('.')
  assert.equal(parts.length, 3)

  const decoded = decodeDpop(token)
  assert.equal(decoded.header.alg, 'ES256')
  assert.equal(decoded.header.typ, 'dpop+jwt')
  assert.equal(decoded.header.jwk.kty, 'EC')
  assert.equal(decoded.header.jwk.crv, 'P-256')
  assert.ok(decoded.header.jwk.d === undefined, '公钥 JWK 不许带私钥 d')
  assert.equal(decoded.payload.htm, 'POST', 'htm 必须大写')
  assert.equal(decoded.payload.htu, OFFICEACE.tokenUrl, 'htu 是完整 URL')
  assert.equal(typeof decoded.payload.jti, 'string')

  // 用 header 里的公钥真验一次签（等价于服务端动作）
  const publicKey = crypto.createPublicKey({ key: decoded.header.jwk, format: 'jwk' })
  const verified = crypto.verify(
    'sha256',
    Buffer.from(`${parts[0]}.${parts[1]}`),
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.from(parts[2], 'base64url'),
  )
  assert.equal(verified, true, 'DPoP 签名必须能被公钥验过')
  console.log('ok 2/4 DPoP')
}

/* 3. 换码 */
{
  const { privateJwk } = generateDpopKey()
  const seen = []
  const ok = await exchangeOfficeaceCode({
    code: 'C1', codeVerifier: 'V1', privateJwk,
    fetch: async (url, init) => {
      seen.push({ url, init })
      assert.equal(init.headers.DPoP.split('.').length, 3)
      const form = new URLSearchParams(init.body)
      assert.equal(form.get('grant_type'), 'authorization_code')
      assert.equal(form.get('code'), 'C1')
      assert.equal(form.get('code_verifier'), 'V1')
      assert.equal(form.get('client_id'), 'pdp5_for_agentarts')
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'AT', refresh_token: 'RT' }) }
    },
  })
  assert.equal(ok.credential.access_token, 'AT')
  assert.equal(ok.credential.refresh_token, 'RT')
  assert.equal(ok.credential.provider, 'officeace')
  assert.deepEqual(ok.credential.privateJwk, privateJwk, '私钥必须随凭据持久化（续期要用同一把）')

  const failed = await exchangeOfficeaceCode({ code: 'c', codeVerifier: 'v', privateJwk, fetch: async () => ({ ok: false, status: 400, text: async () => 'STS5.1806' }) })
  assert.match(failed.error, /STS5\.1806/)
  console.log('ok 3/4 换码')
}

/* 4. 续期 + 目录 */
{
  const { privateJwk } = generateDpopKey()
  const refreshed = await refreshOfficeaceToken({
    refreshToken: 'RT', privateJwk,
    fetch: async (url, init) => {
      const form = new URLSearchParams(init.body)
      assert.equal(form.get('grant_type'), 'refresh_token')
      assert.equal(form.get('refresh_token'), 'RT')
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'AT2' }) }
    },
  })
  assert.equal(refreshed.credential.access_token, 'AT2')
  assert.equal(refreshed.credential.refresh_token, 'RT', '响应不带 refresh 时保留旧值')
  assert.equal(refreshed.refreshed, true)

  const terminal = await refreshOfficeaceToken({ refreshToken: 'RT', privateJwk, fetch: async () => ({ ok: false, status: 400, text: async () => '{"error":"STS5.1806"}' }) })
  assert.equal(terminal.terminal, true, 'STS5.1806 是终态（一次性 token 被重放）')

  const rows = officeaceCatalogRows()
  assert.equal(rows.length, 8)
  assert.equal(rows.find(row => row.id === 'deepseek-v4.1-flash').vision, true)
  console.log('ok 4/4 续期与目录')
}

console.log('officeace auth OK: 4 组断言全部通过')
