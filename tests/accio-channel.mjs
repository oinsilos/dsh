/**
 * Accio 渠道的离线测试：三个端点的**传参方式各不相同**是这里最大的坑。
 *
 * 上游实测 table：
 * | 端点 | method | token 位置 |
 * | --- | --- | --- |
 * | `/api/llm/config/v2` | POST | body `{token}` |
 * | `/api/auth/userinfo` | POST | body `{accessToken}` |
 * | `/api/entitlement/currentSubscription` | GET | query `?accessToken=` |
 * | `/api/entitlement/quota` | GET | query |
 *
 * 用错就是 405 / 400，而症状只是「查询失败」—— 所以每条都单独断言。
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  readNumber,
  parseEnvelope,
  parseSubscription,
  parseCatalog,
  createPkce,
  buildAuthUrl,
  createAccioExtras,
  openBrowser,
  startBrowserLogin,
  ACCIO_GATEWAY,
  ACCIO_LOGIN_CN,
  ACCIO_LOGIN_GLOBAL,
} from '../src/channels/accio.js'
import { buildOwnCatalog } from '../src/channels/catalog.js'

/* ── 纯函数 ─────────────────────────────────────────────────────────────── */

assert.equal(readNumber('12.5'), 12.5, '数字字符串要能读')
assert.equal(readNumber(0), 0, '0 是合法读数')
assert.equal(readNumber(''), undefined, '空串不是 0')
assert.equal(readNumber(null), undefined)

// code 可能是数字 401：必须按标量归一，否则「未登录」被报成「查询失败」
assert.equal(parseEnvelope({ code: 401 }, 200).authFailed, true, '数字 401 也算未登录')
assert.equal(parseEnvelope({ code: '401' }, 200).authFailed, true)
assert.equal(parseEnvelope({ code: 'NOT_LOGIN' }, 200).authFailed, true)
assert.equal(parseEnvelope({ success: false, code: 500 }, 500).ok, false)
assert.equal(parseEnvelope({ success: true, data: {} }, 200).ok, true)
assert.equal(parseEnvelope(null, 502).ok, false)

const subscription = parseSubscription({ data: {
  remaining: 300,
  entitlement: {
    daily: { remaining: 200, total: 200, used: 0 },
    monthly: { remaining: 100, total: 500, used: 400 },
    referral: { total: 50 },
  },
} })
assert.equal(subscription.total, 300, '总余额优先取服务端算好的 remaining')
assert.deepEqual(subscription.packages.map(row => row.name), ['每日积分', '每月积分'], '桶顺序固定；读不到余额的桶不产出')
assert.equal(parseSubscription({ data: { entitlement: {} } }), null, '一个桶都没有时返回 null 而不是 0')

const catalog = parseCatalog({ data: [
  { modelList: [
    { modelCode: '1Orbit-Q7hN3xR6cP2m', modelDisplayName: 'Ultimate', visible: true, effectiveMultiple: 2.8, contextWindow: 1000000, multimodal: true },
    { modelCode: '1Drift-N8kP2Q7wR5mX', modelDisplayName: 'Qwen 3.8 27B', visible: true, effectiveMultiple: 0.013, contextWindow: 512000 },
    { modelCode: 'hidden', modelDisplayName: 'Hidden', visible: false, effectiveMultiple: 1 },
    { modelCode: '1NoPrice', modelDisplayName: 'No Price', visible: true },
  ] },
] })
assert.equal(catalog.length, 3, 'visible !== true 的剔除')
assert.equal(catalog[0].id, '1Drift-N8kP2Q7wR5mX', '按倍率升序（便宜在前）')
assert.ok(catalog[0].name.includes('x0.013'), '倍率进展示名（与其它渠道同约定）')
assert.equal(catalog.at(-1).id, '1NoPrice', '无倍率排最后')
assert.equal(catalog.at(-1).rate, undefined)
assert.equal(catalog.find(row => row.id === '1Orbit-Q7hN3xR6cP2m').vision, true)

const pkce = createPkce()
assert.ok(pkce.verifier.length >= 60, 'verifier 是 48 随机字节的 base64url')
assert.equal(pkce.challenge, crypto.createHash('sha256').update(pkce.verifier).digest('base64url'))
const authUrl = new URL(buildAuthUrl({ redirectUri: 'http://127.0.0.1:1234/auth/callback', state: 'st', challenge: pkce.challenge }))
assert.equal(authUrl.origin, 'https://www.accio-ai.com')
assert.equal(authUrl.searchParams.get('client_id'), 'accio-work')
assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256')
assert.equal(authUrl.searchParams.get('code_challenge'), pkce.challenge, '缺 code_challenge 会被判成 legacy 客户端')
assert.equal(authUrl.searchParams.get('return_url'), 'http://127.0.0.1:1234/auth/callback')
assert.equal(new URL(buildAuthUrl({ region: 'global', redirectUri: 'http://x/auth/callback', state: 's', challenge: 'c' })).origin, 'https://zh.accio.com')

/* ── 权益：三个端点各自的传参方式 ───────────────────────────────────────── */

const calls = []
const fetchImpl = async (url, init) => {
  const parsed = new URL(url)
  calls.push({ path: parsed.pathname, method: init.method ?? 'GET', hasQueryToken: parsed.searchParams.has('accessToken'), body: init.body === undefined ? undefined : JSON.parse(init.body) })
  if (parsed.pathname === '/api/llm/config/v2') {
    return json({ success: true, data: [{ modelList: [{ modelCode: 'M1', modelDisplayName: 'M1', visible: true, effectiveMultiple: 0.03 }] }] })
  }
  if (parsed.pathname === '/api/entitlement/currentSubscription') {
    return json({ success: true, data: { remaining: 150, entitlement: { daily: { remaining: 150, total: 150, used: 0 } } } })
  }
  throw new Error(`unexpected ${parsed.pathname}`)
}
function json(payload) {
  return { ok: true, status: 200, async text() { return JSON.stringify(payload) } }
}

const extras = createAccioExtras({ credentialOf: async () => ({ access_token: 'tok' }), fetch: fetchImpl })
const status = await extras.statusOf({ id: 'accio-1', nickname: 'me' })
assert.equal(status.info.total, 150)
assert.equal(status.catalog.length, 1)
assert.equal(status.catalog[0].name, 'M1 · x0.03')

const catalogCall = calls.find(row => row.path === '/api/llm/config/v2')
const subscriptionCall = calls.find(row => row.path === '/api/entitlement/currentSubscription')
assert.equal(catalogCall.method, 'POST')
assert.deepEqual(catalogCall.body, { token: 'tok' }, '目录的 token 在 body（不是 query、不是头）')
assert.equal(catalogCall.hasQueryToken, false)
assert.equal(subscriptionCall.method, 'GET')
assert.equal(subscriptionCall.hasQueryToken, true, '订阅的 token 在 query（缺它回 400）')

// NOT_LOGIN（HTTP 200 + body code 401）→ 必须说「重新登录」
const notLogin = await createAccioExtras({
  credentialOf: async () => ({ access_token: 'tok' }),
  fetch: async url => new URL(url).pathname === '/api/llm/config/v2'
    ? json({ success: false, data: [] })
    : json({ success: false, code: 401, message: 'NOT_LOGIN' }),
}).statusOf({ id: 'accio-1' })
assert.match(notLogin.error, /重新登录/, 'NOT_LOGIN 不能报成「查询失败」')

// 无凭据：本地就判，不发请求
let touched = false
const bare = await createAccioExtras({
  credentialOf: async () => null,
  fetch: async () => { touched = true; return json({}) },
}).statusOf({ id: 'accio-1' })
assert.match(bare.error, /重新登录/)
assert.equal(touched, false, '没有凭据时不该白打请求')

// 没有签到端点：如实说 inactive
assert.equal((await extras.claim({ id: 'accio-1' })).kind, 'inactive')

/* ── 目录行 ─────────────────────────────────────────────────────────────── */

// 现在未登录也会列出别家的兜底行，故按 provider 过滤后再断言
const rows = buildOwnCatalog({
  catalogs: { accio: [{ id: 'M1', name: 'M1 · x0.03' }] },
  enabled: { accio: true },
}).filter(row => row.provider === 'accio')
assert.equal(rows.length, 1)
assert.equal(rows[0].id, 'accio/M1')
assert.equal(rows[0].own, true)

// 没有远端目录时 accio **不产出行**（它的 modelCode 无法凭名字手写）
const accioRows = buildOwnCatalog({ enabled: { accio: true } }).filter(row => row.provider === 'accio')
assert.equal(accioRows.length, 0, 'accio 没有兜底表，这是刻意的')

// 未登录也列兜底目录（2026-11-24 用户要求）：行上带 needsLogin，面板显示「登录后可用」
const noLogin = buildOwnCatalog({ enabled: {} })
assert.ok(noLogin.length > 0, '未登录时也要能看到模型')
assert.ok(noLogin.every(row => row.needsLogin === true), '未登录的行要带 needsLogin')
const withLogin = buildOwnCatalog({ enabled: { codely: true } })
assert.ok(withLogin.filter(row => row.provider === 'codely').every(row => row.needsLogin === undefined), '已登录的行不带 needsLogin')

assert.ok(ACCIO_GATEWAY.includes('phoenix-gw.alibaba.com'))

/* ── 登录腿：宿主自己开浏览器 + loopback 收回调 ─────────────────────────────
 *
 * 2026-11-24 真实报障「Accio 没法添加账号」的根因：这条登录必须在**真浏览器**里完成，
 * 而面板的 `window.open` 在桌面壳里可能被拦掉。现在由宿主用 rundll32 打开。
 * 这里钉两件事：① 打开命令的形状（URL 必须是一个整体参数）；② loopback 收码。 */

{
  // ① 打开命令：win32 走 rundll32（不经 shell），mac/linux 走 open / xdg-open
  const calls = []
  const exec = (file, args, cb) => { calls.push({ file, args }); cb?.() }
  const url = 'https://www.accio-ai.com/login?state=abc&code_challenge=xyz&code_challenge_method=S256'
  openBrowser(url, { platform: 'win32', exec })
  openBrowser(url, { platform: 'darwin', exec })
  openBrowser(url, { platform: 'linux', exec })
  assert.equal(calls[0].file, 'rundll32.exe', 'Windows 上必须用 rundll32，不能用 cmd /c start')
  assert.deepEqual(calls[0].args, ['url.dll,FileProtocolHandler', url], 'URL 必须是一个整体参数（\& 会被 cmd 截断）')
  assert.equal(calls[1].file, 'open')
  assert.equal(calls[2].file, 'xdg-open')
  // 打开失败不许抛（execFile 的 error 是异步事件，回调就是消费者）
  assert.doesNotThrow(() => openBrowser(url, { platform: 'win32', exec: () => { throw new Error('boom') } }))

  // ② 授权页地址：region 决定主机，PKCE/state 都在 query 里
  const pkce = createPkce()
  const cn = new URL(buildAuthUrl({ region: 'cn', redirectUri: 'http://127.0.0.1:1234/auth/callback', state: 'S', challenge: pkce.challenge }))
  assert.equal(cn.origin + cn.pathname, `${ACCIO_LOGIN_CN}/login`)
  assert.equal(cn.searchParams.get('return_url'), 'http://127.0.0.1:1234/auth/callback')
  assert.equal(cn.searchParams.get('state'), 'S')
  assert.equal(cn.searchParams.get('code_challenge'), pkce.challenge)
  assert.equal(cn.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(cn.searchParams.get('client_id'), 'accio-work')
  const globalUrl = new URL(buildAuthUrl({ region: 'global', redirectUri: 'http://127.0.0.1:1/auth/callback', state: 'S', challenge: 'c' }))
  assert.equal(globalUrl.origin + globalUrl.pathname, `${ACCIO_LOGIN_GLOBAL}/login`)

  // ③ loopback：路径/state 两道校验 + 正确回调交出 {code, verifier, redirectUri}
  //
  // ⚠️ 随机端口可能落在 fetch 规范禁止的「bad port」（6000 / 6665-6669 / 10080 …），
  // 那时 undici 会在发请求前就抛 `bad port` —— 不是实现错。抽到这类端口就重开。
  const BLOCKED_PORTS = new Set([1, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080])
  let flow = await startBrowserLogin({ region: 'cn' })
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidate = Number(new URL(new URL(flow.loginUrl).searchParams.get('return_url')).port)
    if (!BLOCKED_PORTS.has(candidate)) break
    flow.close()
    flow = await startBrowserLogin({ region: 'cn' })
  }
  const auth = new URL(flow.loginUrl)
  const redirectUri = auth.searchParams.get('return_url')
  const state = auth.searchParams.get('state')
  assert.match(redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/, 'redirect_uri 必须落在 loopback 随机端口')

  const wrongPath = await fetch(`http://127.0.0.1:${new URL(redirectUri).port}/nope?code=x&state=${state}`)
  assert.equal(wrongPath.status, 404, '未知回调路径必须 404')
  const wrongState = await fetch(`${redirectUri}?code=x&state=not-the-state`)
  assert.equal(wrongState.status, 400, 'state 不匹配必须拒绝（否则任何本机页面都能塞 code）')
  const noCode = await fetch(`${redirectUri}?state=${encodeURIComponent(state)}`)
  assert.equal(noCode.status, 400, '缺 code 必须拒绝')

  const good = await fetch(`${redirectUri}?code=THE-CODE&state=${encodeURIComponent(state)}`)
  assert.equal(good.status, 200)
  const delivered = await flow.waitForCode()
  assert.equal(delivered.code, 'THE-CODE')
  assert.equal(delivered.redirectUri, redirectUri, '换码必须用同一个 redirect_uri（PKCE 绑定它）')
  assert.equal(delivered.verifier.length >= 43, true, 'verifier 是 48 字节 base64url（≥43 字符）')
  flow.close()

  // 关掉之后端口必须真的不可连（loopback 是「等着收凭据」的口子，不能留着）
  const port = Number(new URL(redirectUri).port)
  let closed = false
  try { await fetch(`http://127.0.0.1:${port}/auth/callback?code=x&state=y`, { signal: AbortSignal.timeout(1500) }) }
  catch { closed = true }
  assert.equal(closed, true, '登录落定后 loopback 必须已关闭')
  // 让 server.close() 与那次失败请求的句柄收干净：Windows 上带着「正在关闭的句柄」
  // 调 process.exit() 会触发 libuv 断言（本仓库踩过同型）。
  await new Promise(resolve => setTimeout(resolve, 200))
}

console.log('accio channel OK:', '46', 'assertions')
process.exit(0)