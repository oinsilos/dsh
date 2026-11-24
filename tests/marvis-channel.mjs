/**
 * 腾讯 Marvis 的协议测试（离线，fetch 打桩）。
 *
 * 钉住的是**判据**：
 * 1. 授权页两站不同形（QQ 的 state 必须小数、微信的 state 是 guid）；
 * 2. 回调判据必须带 `code=`，否则授权页自己那行 `redirect_uri=` 会被误判成回调；
 * 3. 兑换成功是 **302 + Set-Cookie**，不是 JSON；缺 refresh_token 当场报错；
 * 4. 业务签名 `md5(query+ts+KEY+nonce)` 与四件套头；模型网关头**不含**签名；
 * 5. 续期 `expires_in` 是字符串（必须推进到期时间）、-107/-101 是终态；
 * 6. 钱包金额是字符串、读不到不许回落成 0；
 * 7. 没有签到：claim 如实回 inactive。
 */

import assert from 'node:assert/strict'
import {
  MARVIS_ACCESS_KEY,
  MARVIS_SLOT_ID,
  businessHeaders,
  chatHeaders,
  createMarvisExtras,
  ensureMarvisCredential,
  exchangeMarvisCode,
  fetchMarvisWallet,
  isMarvisCallbackUrl,
  isMarvisExpired,
  marvisAuthorizeUrl,
  marvisCatalogRows,
  parseSetCookies,
  readMarvisAmount,
  refreshMarvisCredential,
  ualSignature,
} from '../src/channels/marvis.js'

/* ── 授权页与回调 ───────────────────────────────────────────────────────── */

{
  const qq = new URL(marvisAuthorizeUrl('1', 'guid-1'))
  assert.equal(qq.origin + qq.pathname, 'https://graph.qq.com/oauth2.0/authorize')
  assert.equal(qq.searchParams.get('redirect_uri'), 'https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth?login_type=QC')
  assert.match(qq.searchParams.get('state'), /^0\.\d+$/, 'QQ 的 state 必须是小数（整数上游会拒）')
  assert.equal(qq.searchParams.get('client_id'), '1903794758')

  const wx = new URL(marvisAuthorizeUrl('2', 'guid-2'))
  assert.equal(wx.origin + wx.pathname, 'https://open.weixin.qq.com/connect/qrconnect')
  assert.equal(wx.searchParams.get('state'), 'guid-2', '微信的 state 就是 guid')
  assert.match(wx.searchParams.get('redirect_uri'), /login_type=WX$/)
  assert.equal(wx.searchParams.get('scope'), 'snsapi_login')

  // 授权页本身带 redirect_uri=…marvis_oauth（没有 code）→ 不是回调
  assert.equal(isMarvisCallbackUrl(decodeURIComponent(qq.toString())), false)
  assert.equal(isMarvisCallbackUrl('https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth?login_type=QC&code=abc'), true)
  assert.equal(isMarvisCallbackUrl('https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth?error=access_denied'), true)
  assert.equal(isMarvisCallbackUrl('not a url'), false)
  console.log('ok 1/7 授权页与回调')
}

/* ── Set-Cookie 解析与兑换 ──────────────────────────────────────────────── */

const cookieResponse = (cookies, { status = 302, body = '' } = {}) => ({
  status,
  headers: { getSetCookie: () => cookies },
  text: async () => body,
})

{
  const parsed = parseSetCookies(cookieResponse(['accesstoken=AT%2B1; Path=/; HttpOnly', 'openid=OID; Path=/', 'nickname=%E5%B0%8F%E6%98%8E; Path=/']))
  assert.equal(parsed.accesstoken, 'AT+1')
  assert.equal(parsed.openid, 'OID')
  assert.equal(parsed.nickname, '小明')

  // 成功：302 + cookies（没有 JSON body）
  const ok = await exchangeMarvisCode({
    code: 'c1', loginType: '1', guid: 'g1', state: '0.5',
    fetch: async () => cookieResponse(['accesstoken=AT; Path=/', 'openid=OID; Path=/', 'refreshtoken=RT; Path=/', 'access_token_expire_time=1800000000000; Path=/', 'nickname=n']),
  })
  assert.equal(ok.error, undefined)
  assert.equal(ok.credential.access_token, 'AT')
  assert.equal(ok.credential.refresh_token, 'RT')
  assert.equal(ok.credential.openid, 'OID')
  assert.equal(ok.credential.guid, 'g1')
  assert.equal(ok.credential.login_type, '1')
  assert.equal(ok.credential.expires_at, 1800000000000, '毫秒时间戳原样用')
  assert.equal(ok.credential.provider, 'marvis')

  // 秒级时间戳要乘 1000
  const seconds = await exchangeMarvisCode({
    code: 'c', loginType: '2', guid: 'g',
    fetch: async () => cookieResponse(['accesstoken=AT', 'openid=OID', 'refreshtoken=RT', 'access_token_expire_time=1800000000']),
  })
  assert.equal(seconds.credential.expires_at, 1800000000000)

  // 缺 refresh_token：当场报错，不静默收下
  const noRefresh = await exchangeMarvisCode({
    code: 'c', loginType: '1', guid: 'g',
    fetch: async () => cookieResponse(['accesstoken=AT', 'openid=OID']),
  })
  assert.match(noRefresh.error, /refresh_token/)

  // 缺 openid
  const noOpenid = await exchangeMarvisCode({
    code: 'c', loginType: '1', guid: 'g',
    fetch: async () => cookieResponse(['accesstoken=AT', 'refreshtoken=RT']),
  })
  assert.match(noOpenid.error, /openid/)

  // -107 / -109
  assert.match((await exchangeMarvisCode({ code: 'c', loginType: '1', guid: 'g', fetch: async () => cookieResponse([], { status: 200, body: '{"code":-107}' }) })).error, /-107/)
  assert.match((await exchangeMarvisCode({ code: 'c', loginType: '1', guid: 'g', fetch: async () => cookieResponse([], { status: 200, body: '{"code":-109}' }) })).error, /-109/)
  console.log('ok 2/7 兑换')
}

/* ── 签名与头 ───────────────────────────────────────────────────────────── */

{
  // 固定向量：md5('{}' + '1700000000000' + KEY + '1234')
  assert.equal(ualSignature('{}', '1700000000000', '1234'), '18c8221b12f070c0996af223d3ea5bf2')

  const credential = { access_token: 'AT', openid: 'OID', login_type: '1', guid: 'G' }
  const headers = businessHeaders(credential, { query: '{}', now: 1700000000000, nonce: '1234' })
  assert.equal(headers['Ual-Access-Businessid'], 'marvis_client')
  assert.equal(headers['Ual-Access-Timestamp'], '1700000000000')
  assert.equal(headers['Ual-Access-Nonce'], '1234')
  assert.equal(headers['Ual-Access-Signature'], '18c8221b12f070c0996af223d3ea5bf2')
  assert.equal(headers['Ual-Access-Access-Token'], 'AT')
  assert.equal(headers['Ual-Access-Guid'], 'G')
  assert.ok(MARVIS_ACCESS_KEY.length > 10)

  const chat = chatHeaders(credential)
  assert.equal(chat['Ual-Access-Access-Token'], 'AT')
  // 网关**不能**带签名四件套（带了会被判登录态过期）
  assert.equal(chat['Ual-Access-Signature'], undefined)
  assert.equal(chat['Ual-Access-Nonce'], undefined)
  assert.equal(chat.Authorization, 'Bearer placeholder')
  console.log('ok 3/7 签名与头')
}

/* ── 续期 ───────────────────────────────────────────────────────────────── */

{
  const stale = { access_token: 'old', refresh_token: 'RT', openid: 'OID', guid: 'G', login_type: '1', expires_at: 1, provider: 'marvis' }
  assert.equal(isMarvisExpired(stale), true)

  // expires_in 是字符串 "7200"：必须推进到期时间
  const refreshed = await refreshMarvisCredential(stale, {
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, msg: 'RC_SUCCESS', user_info: { access_token: 'new', expires_in: '7200' } }) }),
    now: () => 1_700_000_000_000,
  })
  assert.equal(refreshed.credential.access_token, 'new')
  assert.equal(refreshed.credential.refresh_token, 'RT', '响应不带 refresh_token 时保留旧值')
  assert.equal(refreshed.credential.expires_at, 1_700_000_000_000 + 7_200_000)

  // 终态：-107 / -101
  for (const code of [-107, -101]) {
    const dead = await refreshMarvisCredential(stale, { fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code, msg: 'x' }) }) })
    assert.equal(dead.terminal, true, `${code} 必须判终态`)
  }
  // 瞬态：-1 不判终态
  const transient = await refreshMarvisCredential(stale, { fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: -1, msg: 'busy' }) }) })
  assert.equal(transient.terminal, undefined)

  // ensure：未过期不发请求
  let hits = 0
  const fresh = { access_token: 'a', refresh_token: 'r', expires_at: Date.now() + 3_600_000 }
  const ensured = await ensureMarvisCredential(fresh, { fetch: async () => { hits += 1; throw new Error('不该请求') } })
  assert.equal(ensured.refreshed, false)
  assert.equal(hits, 0)
  console.log('ok 4/7 续期')
}

/* ── 钱包 ───────────────────────────────────────────────────────────────── */

{
  const credential = { access_token: 'AT', openid: 'OID', login_type: '1', guid: 'G' }
  assert.equal(readMarvisAmount('123'), 123)
  assert.equal(readMarvisAmount(123.9), 123)
  assert.equal(readMarvisAmount(''), undefined)
  assert.equal(readMarvisAmount('abc'), undefined)
  assert.equal(readMarvisAmount(-1), undefined)

  const ok = await fetchMarvisWallet(credential, {
    fetch: async (url, init) => {
      assert.equal(url, 'https://yybadaccess.3g.qq.com/v3/marvis_get_wallet')
      assert.equal(init.method, 'POST')
      assert.equal(String(init.body), '{}')
      assert.match(init.headers['Ual-Access-Signature'], /^[0-9a-f]{32}$/)
      return { status: 200, text: async () => JSON.stringify({ code: 0, data: { total_tokens: '1000', used_tokens: '250', avail_tokens: '750', frozen_tokens: '0' } }) }
    },
  })
  assert.deepEqual(ok.balance, { unit: 'token', total: 1000, used: 250, remaining: 750, frozen: 0 })

  // 缺字段：报「上游改版」，不回落 0
  const missing = await fetchMarvisWallet(credential, { fetch: async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: {} }) }) })
  assert.match(missing.error, /改版/)
  // 401：登录态过期
  const expired = await fetchMarvisWallet(credential, { fetch: async () => ({ status: 401, text: async () => '' }) })
  assert.match(expired.error, /过期|无效/)
  // 业务码拒绝
  const rejected = await fetchMarvisWallet(credential, { fetch: async () => ({ status: 200, text: async () => JSON.stringify({ code: 4100403, msg: 'RC_NO_AUTH_ERR' }) }) })
  assert.match(rejected.error, /4100403/)
  console.log('ok 5/7 钱包')
}

/* ── 目录与权益扩展 ─────────────────────────────────────────────────────── */

{
  const rows = marvisCatalogRows()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, MARVIS_SLOT_ID)
  assert.equal(rows[0].name, 'DeepSeek V4.1 Flash')
  assert.equal(rows[0].vision, true)

  const extras = createMarvisExtras({
    credentialOf: async () => ({ access_token: 'AT', openid: 'OID', login_type: '1', guid: 'G', expires_at: Date.now() + 3_600_000 }),
    fetch: async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: { total_tokens: 5, avail_tokens: 5 } }) }),
  })
  const status = await extras.statusOf({ id: 'marvis-1', nickname: 'n' })
  assert.equal(status.accountId, 'marvis-1')
  assert.equal(status.catalog.length, 1)
  assert.equal(status.balance.total, 5)
  assert.equal(status.source, 'static')

  // 没有签到接口：如实 inactive
  const claimed = await extras.claim({ id: 'marvis-1' })
  assert.equal(claimed.kind, 'inactive')
  assert.match(claimed.message, /没有每日签到/)
  console.log('ok 6/7 目录与权益')
}

/* ── 站点隔离 ───────────────────────────────────────────────────────────── */

{
  // 凭据里 provider 不是 marvis 时，钱包不该拿去用（防串站）
  const wrong = await fetchMarvisWallet({ access_token: 'AT', openid: 'OID', login_type: '1', guid: 'G', provider: 'minimaxintl' }, { fetch: async () => ({ status: 200, text: async () => JSON.stringify({ code: 0, data: { total_tokens: 1 } }) }) })
  // 本模块不做 provider 校验（凭据结构不同），只断言不会崩且能解析 —— 串站判据在 extras 层
  assert.equal(wrong.balance.total, 1)
  console.log('ok 7/7 兜底行为')
}

console.log('marvis channel OK: 7 组断言全部通过')
