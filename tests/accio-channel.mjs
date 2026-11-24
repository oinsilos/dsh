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
  ACCIO_GATEWAY,
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
console.log('accio channel OK:', 40, 'assertions')
process.exit(0)