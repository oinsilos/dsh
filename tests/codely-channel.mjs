/**
 * Codely 渠道 + 本插件账号表 + 设备码登录的离线测试。
 *
 * 这一段最容易错的三处恰好都能离线覆盖：
 * 1. `remaining_points` 是**字符串** → 读不出不得变成 0（0 = 已用光）；
 * 2. 签到必须**先 init 再执行**，且 `can_check_in === false` 时**不得**再发执行请求；
 * 3. 设备码登录的三步（initiate → poll → exchange）与凭据落点。
 */

import assert from 'node:assert/strict'
import {
  createCodelyExtras,
  parseModelStatus,
  parseUsageSummary,
  parseCheckinState,
  classifyCheckin,
  readPoints,
  decodeJwtExpMs,
  startDeviceLogin,
  pollDeviceLogin,
  exchangeCode,
  CODELY_API_BASE,
} from '../src/channels/codely.js'
import { createChannelAccounts, credentialRefName } from '../src/channels/accounts.js'
import { createDeviceLogin } from '../src/channels/device-login.js'

/* ── 纯解析 ─────────────────────────────────────────────────────────────── */

assert.equal(readPoints('2400'), 2400, '字符串点数必须能读')
assert.equal(readPoints(0), 0, '0 是合法读数')
assert.equal(readPoints(''), undefined, '空串不是 0')
assert.equal(readPoints('  '), undefined)
assert.equal(readPoints(-5), undefined, '负数不是合法余额')
assert.equal(readPoints(null), undefined)

const models = parseModelStatus({ models: [
  { modelGroup: 'codely-core', status: 'degraded' },
  { modelGroup: 'KIMI-K3', status: 'outage' },
  { modelGroup: 'codely-core' },
  { status: 'operational' },
] })
assert.deepEqual(models.map(row => row.id), ['codely-core', 'KIMI-K3'], '无 modelGroup 的行与重复 id 都要丢')
assert.equal(models[0].status, 'degraded', '运行状态照实带上（但不进展示名）')

const usage = parseUsageSummary({
  remaining_points: '2400',
  is_exhausted: false,
  details: [
    { type: 'gift_credit', remaining_points: '2400', exhausted: false },
    { type: 'purchased', remaining_points: '100' },
  ],
})
assert.equal(usage.total, 2400)
assert.equal(usage.packages.length, 2, '逐桶必须全保留（多桶账号）')
assert.equal(usage.packages[1].name, 'purchased', '未登记的桶类型原样显示，不编中文名')
assert.equal(parseUsageSummary({ details: [] }), null, '读不到任何点数必须返回 null 而不是 0')
assert.equal(parseUsageSummary({ details: [{ type: 'gift_credit', remaining_points: '50' }] }).total, 50, '顶层缺失时用逐桶之和兜底')

const state = parseCheckinState({
  activity_status: 'ACTIVE', check_in_status: 'READY', can_check_in: true,
  check_in_count: 19, max_count: 31,
  levels: [{ level: 19, status: 'COMPLETED' }, { level: 20, status: 'CURRENT', reward_summary: '+300' }],
})
assert.equal(state.canCheckIn, true)
assert.equal(state.reward, 300, '可领数额只能来自 CURRENT 那一级的 reward_summary')
assert.equal(state.count, 19)

assert.equal(classifyCheckin(null, undefined).kind, 'failed')
assert.equal(classifyCheckin({ activityStatus: 'EXPIRED', canCheckIn: true }, undefined).kind, 'inactive')
assert.equal(classifyCheckin({ activityStatus: 'ACTIVE', checkinStatus: 'UNAVAILABLE', canCheckIn: true, error: '维护中' }, undefined).message.includes('维护中'), true)
assert.equal(classifyCheckin({ activityStatus: 'ACTIVE', canCheckIn: false }, undefined).kind, 'already-claimed')
assert.equal(classifyCheckin({ activityStatus: 'ACTIVE', canCheckIn: true, reward: 300 }, { check_in_status: 'COMPLETED' }).kind, 'claimed')
assert.equal(classifyCheckin({ activityStatus: 'ACTIVE', canCheckIn: true }, { check_in_status: 'PROCESSING', can_check_in: false }).kind, 'already-claimed')

// JWT exp：解不出时 undefined（绝不编造过期时间）
const jwt = `x.${Buffer.from(JSON.stringify({ exp: 1900000000 })).toString('base64url')}.y`
assert.equal(decodeJwtExpMs(jwt), 1900000000 * 1000)
assert.equal(decodeJwtExpMs('not-a-jwt'), undefined)

/* ── 权益查询与签到（注入 fetch） ────────────────────────────────────────── */

const cred = { access_token: 'tok-codely' }
const account = { id: 'codely-1', nickname: 'unity', provider: 'codely' }

let checkinExecuted = 0
const happyFetch = async (url, init) => {
  const path = new URL(url).pathname
  assert.equal(init.headers.Authorization, 'Bearer tok-codely', '权益端点必须带 Bearer')
  if (path === '/api/model-status') return json({ models: [{ modelGroup: 'codely-core' }] })
  if (path === '/api/user/usage/summary') return json({ remaining_points: '150', details: [{ type: 'gift_credit', remaining_points: '150' }] })
  if (path === '/api/points/check-in/init') return json({ activity_status: 'ACTIVE', check_in_status: 'READY', can_check_in: true, levels: [{ status: 'CURRENT', reward_summary: '+300' }] })
  if (path === '/api/points/check-in') { checkinExecuted += 1; return json({ check_in_status: 'COMPLETED', can_check_in: false }) }
  throw new Error(`unexpected ${path}`)
}
const extras = createCodelyExtras({ credentialOf: async () => cred, fetch: happyFetch })
const status = await extras.statusOf(account)
assert.equal(status.catalog[0].id, 'codely-core')
assert.equal(status.info.total, 150)
assert.equal(status.checkin.canCheckIn, true)

const claimed = await extras.claim(account)
assert.equal(claimed.kind, 'claimed')
assert.equal(claimed.credit, 300)
assert.equal(checkinExecuted, 1)

// 今天已领：init 说 can_check_in=false ⇒ **不得**发执行请求
checkinExecuted = 0
const alreadyFetch = async (url, init) => {
  const path = new URL(url).pathname
  if (path === '/api/points/check-in/init') return json({ activity_status: 'ACTIVE', can_check_in: false, check_in_status: 'COMPLETED' })
  if (path === '/api/points/check-in') { checkinExecuted += 1; return json({}) }
  return json({})
}
assert.equal((await createCodelyExtras({ credentialOf: async () => cred, fetch: alreadyFetch }).claim(account)).kind, 'already-claimed')
assert.equal(checkinExecuted, 0, 'can_check_in=false 时不得再打执行端点（白跑一次写请求）')

// 无凭据：明确报原因
const bare = await createCodelyExtras({ credentialOf: async () => null, fetch: happyFetch }).statusOf(account)
assert.match(bare.error, /重新登录/)

function json(payload) {
  return { ok: true, status: 200, async text() { return JSON.stringify(payload) } }
}

/* ── 设备码登录三步 ─────────────────────────────────────────────────────── */

let step = 0
const loginFetch = async (url, init) => {
  const { pathname, searchParams } = new URL(url)
  if (pathname === '/auth/device/initiate') {
    assert.deepEqual(JSON.parse(init.body), { provider: 'unity', client_name: 'codely-vscode', auth_from: 'vscode-codely' })
    return json({ auth_request_token: 'ART-1', user_code: 'ABCD-EFGH', verification_uri: 'https://codely/device', verification_uri_complete: 'https://codely/device?c=ABCD', interval: 2, expires_in: 900 })
  }
  if (pathname === '/auth/device/poll') {
    assert.equal(searchParams.get('auth_request_token'), 'ART-1')
    step += 1
    return step === 1
      ? json({ status: 'pending', error: 'authorization_pending' })
      : json({ status: 'authorized', authorization_code: 'AC-1' })
  }
  if (pathname === '/auth/device/exchange') {
    assert.equal(JSON.parse(init.body).authorization_code, 'AC-1')
    return json({ access_token: `a.${Buffer.from(JSON.stringify({ exp: 1900000000 })).toString('base64url')}.s`, refresh_token: 'RT-1' })
  }
  if (pathname === '/auth/external/me') return json({ username: 'unity-user', email: 'u@example.com' })
  throw new Error(`unexpected ${pathname}`)
}

const started = await startDeviceLogin({ fetch: loginFetch })
assert.equal(started.authRequestToken, 'ART-1')
assert.equal(started.userCode, 'ABCD-EFGH')
assert.equal(started.intervalMs, 2000, 'interval 秒 → 毫秒')
assert.equal((await pollDeviceLogin('ART-1', { fetch: loginFetch })).status, 'pending')
const authorized = await pollDeviceLogin('ART-1', { fetch: loginFetch })
assert.equal(authorized.status, 'authorized')
const exchanged = await exchangeCode(authorized.code, { fetch: loginFetch })
assert.ok(exchanged.credential.access_token.startsWith('a.'))
assert.equal(exchanged.credential.refresh_token, 'RT-1')
assert.equal(exchanged.expiresAt, 1900000000 * 1000, '过期时刻来自 JWT exp')
assert.ok(typeof exchanged.credential.expires_at === 'string', '落盘用 ISO 字符串')

// 设备码申请失败：回 error，不抛
const failFetch = async () => ({ ok: false, status: 503, async text() { return 'unavailable' } })
const failed = await startDeviceLogin({ fetch: failFetch })
assert.match(failed.error, /HTTP 503/)

/* ── 账号表 + 两步式流程容器 ────────────────────────────────────────────── */

function memoryStore(initial) {
  let value = structuredClone(initial)
  return {
    get: () => value,
    update(patch) { value = { ...value, ...patch }; return value },
    flush() {},
  }
}
const credStore = new Map()
const accounts = createChannelAccounts(
  memoryStore({ version: 1, accounts: [] }),
  {
    set: async (ref, value) => { credStore.set(ref, value) },
    delete: async ref => { credStore.delete(ref) },
  },
  async ref => (credStore.has(ref) ? { value: credStore.get(ref) } : undefined),
)

const created = accounts.create('codely', { nickname: '' })
assert.match(created.id, /^codely-[0-9a-f]{8}$/)
assert.match(created.credentialRef, /^OFM_CODELY_ACCOUNT_[0-9A-F]{8}$/, 'ref 必须与渠道包的命名空间分开')
assert.equal(accounts.list('codely').length, 1)
assert.equal(accounts.find(created.id).provider, 'codely')
assert.throws(() => accounts.create('not-owned'), /unsupported provider/)

const deviceLogin = createDeviceLogin({ accounts, fetch: loginFetch })
assert.equal(deviceLogin.supports('codely'), true)
assert.equal(deviceLogin.supports('codearts'), false)

// 走完整条：start 建占位账号 → poll(pending) → poll(authorized) → 凭据落盘 + 昵称回填
step = 0
const flow = await deviceLogin.start('codely')
assert.equal(flow.userCode, 'ABCD-EFGH')
assert.equal(accounts.list('codely').length, 2, 'start 必须先建占位账号（面板要能立刻轮询）')
assert.equal((await deviceLogin.poll(flow.accountId)).done, false, '第一次轮询还没授权')
const done = await deviceLogin.poll(flow.accountId)
assert.equal(done.done, true)
assert.equal(done.success, true)
assert.equal(done.nickname, 'unity-user')
const attached = accounts.find(flow.accountId)
assert.equal(attached.nickname, 'unity-user', '昵称回填到账号表')
assert.equal(attached.expiresAt, 1900000000 * 1000, '账号表带上真实过期时刻')
assert.ok(credStore.has(attached.credentialRef), '凭据写进宿主 credentials')

// 流程已结束：再轮询要如实说「不存在」
assert.equal((await deviceLogin.poll(flow.accountId)).success, false)

// 删除账号：凭据一并清掉
assert.equal(await accounts.remove(flow.accountId), true)
assert.equal(accounts.find(flow.accountId), undefined)
assert.equal(credStore.has(attached.credentialRef), false, '删账号必须删凭据（不留无主令牌）')

// ref 命名：两次生成不同（并发登录不互相覆盖）
assert.notEqual(credentialRefName('codely'), credentialRefName('codely'))

console.log('codely channel OK:', 46, 'assertions')
process.exit(0)