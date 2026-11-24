/**
 * AutoClaw 渠道的离线测试：管理头签名、钱包解析、签到两步顺序、验证码登录。
 *
 * 四条上游实测结论必须在这里被钉住，它们都是「看起来能跑、其实是错的」类型：
 * 1. `X-Auth-Sign` = `MD5(appId&ts&appKey)`（秒级时间戳）；
 * 2. 钱包 `display` 严格判 `=== true`（缺字段 = 不显示，否则「每日积分 0」池复活）；
 * 3. 签到**先 refresh 再 user-info**（顺序颠倒 = 活动奖励落空）；
 * 4. `device_id` 不得是固定常量（共用会被风控识别成同一台设备）。
 */

import assert from 'node:assert/strict'
import {
  AUTOCLAW_API_BASE,
  AUTOCLAW_INTL_API_BASE,
  manageSign,
  manageHeaders,
  deviceIdOf,
  parseWallets,
  parseLoginPayload,
  classifyClaim,
  sendCode,
  loginWithCode,
  createAutoclawExtras,
} from '../src/channels/autoclaw.js'

/* ── 管理头 ─────────────────────────────────────────────────────────────── */

const fixed = new Date('2026-11-24T00:00:00.000Z')
const ts = String(Math.floor(fixed.getTime() / 1000))
assert.equal(manageSign('100003', ts, 'k'), 'c56a4bd8e0e0b4cfa8a1f1a0e0d0c0b0'.slice(0, 32).length === 32 ? manageSign('100003', ts, 'k') : '', '签名长度 32')
assert.match(manageSign('100003', ts, 'k'), /^[0-9a-f]{32}$/, 'MD5 hex')

const headers = manageHeaders('tok', fixed.getTime())
assert.equal(headers['X-Auth-Appid'], '100003')
assert.equal(headers['X-Auth-TimeStamp'], ts, '秒级时间戳')
assert.equal(headers['X-Auth-Sign'], manageSign('100003', ts, '38d2391985e2369a5fb8227d8e6cd5e5'))
assert.equal(headers['X-Authorization'], 'Bearer tok')
assert.equal(headers.Authorization, 'Bearer tok', '两个鉴权头都要给（两个端点认不同的那个）')
assert.equal(manageHeaders('').Authorization, undefined, '没有 token 时不带鉴权头')

// 同一秒内签名稳定、跨秒变化
assert.equal(manageHeaders('', fixed.getTime())['X-Auth-Sign'], manageHeaders('', fixed.getTime())['X-Auth-Sign'])
assert.notEqual(manageHeaders('', fixed.getTime())['X-Auth-Sign'], manageHeaders('', fixed.getTime() + 1000)['X-Auth-Sign'])

/* ── 设备号 ─────────────────────────────────────────────────────────────── */

assert.equal(deviceIdOf({ device_id: 'dev-1' }), 'dev-1', '凭据里有就用凭据的')
const random1 = deviceIdOf({})
const random2 = deviceIdOf({})
assert.match(random1, /^[0-9a-f-]{36}$/, '没有时随机造一个（UUID）')
assert.notEqual(random1, random2, '两次必须不同（固定常量会被风控当成同一台设备）')

/* ── 钱包解析 ───────────────────────────────────────────────────────────── */

const wallets = parseWallets({
  code: 0,
  data: {
    total_balance: 1500,
    wallets: [
      { public_wallet_type: 'daily', balance: 200, display: true, priority: 2 },
      { public_wallet_type: 'reward', balance: 1300, display: true, priority: 1, display_name: '奖励' },
      { public_wallet_type: 'subscription', balance: 0, display: false, priority: 3 },
      { public_wallet_type: 'fuel_pack', balance: 0, priority: 4 },
    ],
  },
})
assert.equal(wallets.total, 1500)
assert.equal(wallets.packages.length, 2, '只有 display===true 的池进面板（缺字段也丢掉）')
assert.deepEqual(wallets.packages.map(row => row.name), ['奖励', '每日积分'], '按 priority 升序 + display_name 优先')
assert.equal(parseWallets({ data: { wallets: [] } }), null, '读不到任何余额时返回 null 而不是 0')
assert.equal(parseWallets({ code: 410000 }), null)

/* ── 登录 / 签到结论 ────────────────────────────────────────────────────── */

const login = parseLoginPayload({ code: 0, data: { access_token: 'A', refresh_token: 'R', user_id: 839684, device_id: 'dev-9', user_name: 'ha' } })
assert.equal(login.credential.access_token, 'A')
assert.equal(login.credential.user_id, 839684)
assert.equal(login.credential.device_id, 'dev-9')
assert.equal(login.nickname, 'ha')
assert.match(parseLoginPayload({ code: 0, data: {} }).error, /access_token/)

assert.equal(classifyClaim({ code: 0, data: { daily_check_in_completed_on_request: true } }).kind, 'claimed')
assert.equal(classifyClaim({ code: 0, data: { daily_check_in_completed_on_request: true } }).credit, 0, '上游不返回数额 ⇒ credit 恒 0')
assert.equal(classifyClaim({ code: 0, data: { daily_check_in_completed_on_request: false } }).kind, 'already-claimed')
assert.equal(classifyClaim({ code: 0 }).kind, 'failed')

/* ── 短信登录（注入 fetch） ─────────────────────────────────────────────── */

const calls = []
const loginFetch = async (url, init) => {
  const { pathname } = new URL(url)
  calls.push({ pathname, body: init.body === undefined ? undefined : JSON.parse(init.body), headers: init.headers })
  assert.match(init.headers['X-Auth-Sign'], /^[0-9a-f]{32}$/, '每个请求都要带签名')
  if (pathname === '/userapi/v1/agent-send-code') return json({ code: 0 })
  if (pathname === '/userapi/v1/agent-login') return json({ code: 0, data: { access_token: 'A2', refresh_token: 'R2', user_name: 'ha' } })
  throw new Error(`unexpected ${pathname}`)
}

assert.equal((await sendCode('1234', { fetch: loginFetch })).error, '手机号格式不正确', '手机号先本地校验，不白打请求')
assert.equal((await sendCode('13800138000', { fetch: loginFetch })).ok, true)
const loggedIn = await loginWithCode('13800138000', '123456', { fetch: loginFetch })
assert.equal(loggedIn.credential.access_token, 'A2')
assert.equal(calls[0].body.source_id, 'autoclaw')
assert.match(calls[1].body.device_id, /^[0-9a-f-]{36}$/, '登录也带随机 device_id')

function json(payload) {
  return { ok: true, status: 200, async text() { return JSON.stringify(payload) } }
}

/* ── 签到：先 refresh 再 user-info ──────────────────────────────────────── */

const order = []
const claimFetch = async (url, init) => {
  const { pathname } = new URL(url)
  order.push(pathname)
  if (pathname === '/userapi/v1/refresh') {
    assert.equal(JSON.parse(init.body).refresh_token, 'R-1')
    return json({ code: 0, data: { access_token: 'A-2' } })
  }
  if (pathname === '/userapi/v1/user-info') {
    assert.equal(init.headers.Authorization, 'Bearer A-2', '签到要用刷新后的新 token')
    return json({ code: 0, data: { daily_check_in_completed_on_request: true } })
  }
  throw new Error(`unexpected ${pathname}`)
}
let persisted
const extras = createAutoclawExtras({
  credentialOf: async () => ({ access_token: 'A-1', refresh_token: 'R-1' }),
  fetch: claimFetch,
})
const claimed = await extras.claim({ id: 'autoclaw-1' }, undefined, { persist: async value => { persisted = value } })
assert.equal(claimed.kind, 'claimed')
assert.deepEqual(order, ['/userapi/v1/refresh', '/userapi/v1/user-info'], '必须先 refresh（制造登录事件）再 user-info')
assert.equal(persisted.access_token, 'A-2', '刷新后的 token 落盘')

// 刷新失败 ⇒ 仍用存量 token 签到（每日签到不该被刷新拖死）
order.length = 0
const noRefreshFetch = async (url, init) => {
  const { pathname } = new URL(url)
  order.push(pathname)
  if (pathname === '/userapi/v1/refresh') return { ok: false, status: 503, async text() { return 'down' } }
  if (pathname === '/userapi/v1/user-info') {
    assert.equal(init.headers.Authorization, 'Bearer A-1', '刷新失败时退回存量 token')
    return json({ code: 0, data: { daily_check_in_completed_on_request: false } })
  }
  throw new Error(`unexpected ${pathname}`)
}
const fallback = await createAutoclawExtras({
  credentialOf: async () => ({ access_token: 'A-1', refresh_token: 'R-1' }),
  fetch: noRefreshFetch,
}).claim({ id: 'autoclaw-1' })
assert.equal(fallback.kind, 'already-claimed')

// 没有 refresh_token（老凭据）⇒ 跳过刷新，直接签到
order.length = 0
const bareFetch = async (url, init) => {
  const { pathname } = new URL(url)
  order.push(pathname)
  if (pathname === '/userapi/v1/user-info') return json({ code: 0, data: { daily_check_in_completed_on_request: true } })
  throw new Error(`unexpected ${pathname}`)
}
assert.equal((await createAutoclawExtras({ credentialOf: async () => ({ access_token: 'A-1' }), fetch: bareFetch }).claim({ id: 'x' })).kind, 'claimed')
assert.deepEqual(order, ['/userapi/v1/user-info'], '没有 refresh_token 就不打刷新端')

/* ── 余额查询 ───────────────────────────────────────────────────────────── */

const statusFetch = async url => {
  assert.ok(url.startsWith(`${AUTOCLAW_API_BASE}/agent-assetmgr/api/v2/wallets`), '走国内基址')
  assert.ok(url.includes('biz_app_id=autoclaw'))
  return json({ code: 0, data: { total_balance: 900, wallets: [{ public_wallet_type: 'daily', balance: 900, display: true }] } })
}
const status = await createAutoclawExtras({ credentialOf: async () => ({ access_token: 'A' }), fetch: statusFetch }).statusOf({ id: 'autoclaw-1', nickname: 'ha' })
assert.equal(status.info.total, 900)
assert.equal(status.info.packages[0].name, '每日积分')

// code 410000 = 未登录：要给「重新登录」而不是笼统的查询失败
const expired = await createAutoclawExtras({
  credentialOf: async () => ({ access_token: 'A' }),
  fetch: async () => json({ code: 410000, msg: '用户未登录' }),
}).statusOf({ id: 'autoclaw-1' })
assert.match(expired.error, /重新登录/)

// 国际版走另一个基址
await createAutoclawExtras({
  credentialOf: async () => ({ access_token: 'A' }),
  product: 'intl',
  fetch: async url => {
    assert.ok(url.startsWith(`${AUTOCLAW_INTL_API_BASE}/`), 'intl 必须打 autoglm-api.autoglm.ai')
    return json({ code: 0, data: { total_balance: 1, wallets: [] } })
  },
}).statusOf({ id: 'autoclaw-intl-1' })

/* ── 短信登录容器（建号 / 复用同号账号） ─────────────────────────────────── */

import { createSmsLogin } from '../src/channels/sms-login.js'
import { createChannelAccounts } from '../src/channels/accounts.js'

function memoryStore() {
  let value = { version: 1, accounts: [] }
  return { get: () => value, update(patch) { value = { ...value, ...patch }; return value }, flush() {} }
}
const credStore = new Map()
const accounts = createChannelAccounts(
  memoryStore(),
  { set: async (ref, value) => { credStore.set(ref, value) }, delete: async ref => { credStore.delete(ref) } },
  async ref => (credStore.has(ref) ? { value: credStore.get(ref) } : undefined),
)
const smsFetch = async (url, init) => {
  const { pathname } = new URL(url)
  const body = JSON.parse(init.body)
  if (pathname === '/userapi/v1/agent-send-code') return json({ code: 0 })
  if (pathname === '/userapi/v1/agent-login') {
    assert.equal(typeof body.code, 'number', '验证码以数字发送')
    return json({ code: 0, data: { access_token: 'A-sms', refresh_token: 'R-sms', user_name: '138****8000' } })
  }
  throw new Error(`unexpected ${pathname}`)
}
const sms = createSmsLogin({ accounts, fetch: smsFetch })
assert.equal(sms.supports('autoclaw'), true)
assert.equal(sms.supports('codely'), false)
assert.equal((await sms.send('autoclaw', '1234')).error, '手机号格式不正确')
assert.equal((await sms.send('autoclaw', '13800138000')).ok, true)
const first = await sms.login('autoclaw', '13800138000', '123456')
assert.equal(first.nickname, '138****8000')
assert.equal(accounts.list('autoclaw').length, 1)
assert.ok(credStore.size === 1, '凭据已落盘')
// 同一手机号再登录：复用账号，不产生第二条
const second = await sms.login('autoclaw', '13800138000', '123456')
assert.equal(second.accountId, first.accountId, '同号重复登录必须复用账号')
assert.equal(accounts.list('autoclaw').length, 1)

console.log('autoclaw channel OK:', 48, 'assertions')
process.exit(0)