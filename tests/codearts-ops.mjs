/**
 * CodeArts 权益扩展的离线测试：签名、解析、领取流程全部用固定数据跑。
 *
 * 这几段是「在渠道包之外补一条渠道能力」的最小闭环 —— 不碰网络、不需要账号，
 * 却能覆盖最容易错的三处：华为签名的 canonical 口径、上游 `-1 = 不适用` 的
 * 负值处理、以及 `POST /v1/ops/claim` 之后**必须**补的 `/v1/ops/confirm`。
 */

import assert from 'node:assert/strict'
import {
  signHuawei,
  parseAccountInfo,
  parseActivities,
  parseRatios,
  classifyClaim,
  createCodeArtsExtras,
  OPS_DELIVERY_PATH,
  STATISTICS_PATH,
  MODEL_BUILTIN_PATH,
} from '../src/channels/codearts.js'

const CRED = { ak: 'AKIDEXAMPLE', sk: 'SECRETEXAMPLE', securityToken: 'TOKENEXAMPLE' }

/* ── 签名 ──────────────────────────────────────────────────────────────── */

const fixed = new Date('2026-11-24T00:00:00.000Z')
const headersA = signHuawei(CRED, 'GET', 'https://snap-access.cn-north-4.myhuaweicloud.com' + OPS_DELIVERY_PATH + '?channel=IDE', '', {}, fixed)
const headersB = signHuawei(CRED, 'GET', 'https://snap-access.cn-north-4.myhuaweicloud.com' + OPS_DELIVERY_PATH + '?channel=IDE', '', {}, fixed)

assert.equal(headersA.authorization, headersB.authorization, '同一输入必须签出同一签名')
assert.match(headersA.authorization, /^SDK-HMAC-SHA256 Access=AKIDEXAMPLE,SignedHeaders=[a-z0-9;-]+,Signature=[0-9a-f]{64}$/)
assert.equal(headersA['x-sdk-date'], '20261124T000000Z', 'x-sdk-date 必须是压缩过的 ISO 时间')
assert.ok(!headersA.authorization.includes('agent-type'),
  'builtin / ops 端点的 Agent-Type 不参与签名（只有 agent-center 需要签）—— 见 codearts.js 的路由判据头表')
assert.ok(headersA.authorization.includes('x-security-token'), '临时凭据必须参与签名')
assert.equal(headersA['content-type'], undefined, 'GET 不带 content-type（与上游一致）')

const post = signHuawei(CRED, 'POST', 'https://snap-access.cn-north-4.myhuaweicloud.com/v1/ops/claim', '{"campaignId":"1"}', {}, fixed)
assert.equal(post['content-type'], 'application/json')
assert.notEqual(post.authorization, headersA.authorization, 'body 变化必须改变签名')

/* ── 解析 ──────────────────────────────────────────────────────────────── */

const info = parseAccountInfo({
  package: { package_name_cn: 'CodeArts 企业版', status: 'normal', is_credit_package: true },
  start_date: '2026-11-01',
  end_date: '2026-11-30',
  metrics: [
    { name: 'usageTotalPackageCredit', package_credit_amount: 5000, package_credit_used: 4200, package_credit_remain: 800, package_credit_expiring_amount: 200 },
    { name: 'usageBonusPackageCredit', package_credit_amount: 200, package_credit_used: 100, package_credit_remain: 100 },
    { name: 'usageModelUsage', usage_token: -1, model_quota_num: -1 },
  ],
})
assert.equal(info.total.remain, 800)
assert.equal(info.total.expiring, 200)
assert.equal(info.bonus.remain, 100)
assert.equal(info.planStatus, 'active')
assert.equal(info.isCreditPackage, true)
assert.equal(parseAccountInfo({ metrics: [] }), null, '没有 metrics 必须返回 null，而不是一排 0')
assert.equal(parseAccountInfo({ metrics: [{ name: 'usageModelUsage', usage_token: -1 }] }), null)

const activities = parseActivities({ items: [
  { campaignId: 1, type: 'USER_LOGIN', title: '每日登录', claimable: true, status: 'ENTRY', benefitAmount: 1000 },
  { campaignId: '2', type: 'WEEKLY', title: '周任务', claimable: false, status: 'CLAIMED' },
] })
assert.equal(activities.length, 2)
assert.equal(activities[0].campaignId, '1', 'campaignId 实测是数字，必须归一成字符串')
assert.equal(activities[0].amount, 1000)
assert.equal(activities[1].claimable, false)

const ratios = parseRatios({ builtinModels: [
  { model_id: 'deepseek-v4-flash', credit: [{ time_slot_id: 'default', ratio_display: '0.18x' }, { time_slot_id: 'off_peak', ratio_display: '0.09x' }] },
  { model_id: 'qwen3-vl-235b', credit: [] },
  { model_id: 'glm-5.2', enable: false, credit: [{ ratio_display: '1x' }] },
] })
assert.deepEqual(ratios, { 'deepseek-v4-flash': 'x0.18' }, '取 default 时段；无 credit / 已停用的模型不进表')

assert.equal(classifyClaim({ claimable: true, status: 'ENTRY', amount: 100 }, { ok: true, data: { benefitAmount: 1000 } }).kind, 'claimed')
assert.equal(classifyClaim({ claimable: true, status: 'ENTRY' }, { ok: true, data: {} }).kind, 'claimed')
assert.equal(classifyClaim({ claimable: false, status: 'CLAIMED' }, undefined).kind, 'already-claimed')
assert.equal(classifyClaim({ claimable: false, status: 'ENTRY' }, undefined).kind, 'inactive')
assert.equal(classifyClaim({ claimable: true, status: 'ENTRY' }, { ok: false, code: 40001, message: 'already' }).kind, 'already-claimed')
assert.equal(classifyClaim({ claimable: true, status: 'ENTRY' }, { ok: false, message: '余额不足' }).kind, 'failed')

/* ── 领取流程（注入 fetch） ─────────────────────────────────────────────── */

const calls = []
const fakeFetch = async (url, init) => {
  calls.push({ url, method: init.method, headers: init.headers, body: init.body })
  assert.match(init.headers.authorization, /^SDK-HMAC-SHA256 /, '每个请求都必须带签名')
  if (url.endsWith(STATISTICS_PATH)) {
    return new Response(JSON.stringify({ package: { is_credit_package: true }, metrics: [{ name: 'usageTotalPackageCredit', package_credit_amount: 5000, package_credit_remain: 800 }] }), { status: 200 })
  }
  if (url.includes(OPS_DELIVERY_PATH)) {
    return new Response(JSON.stringify({ items: [{ campaignId: 7, type: 'USER_LOGIN', title: '每日登录', claimable: true, status: 'ENTRY', benefitAmount: 1000 }] }), { status: 200 })
  }
  if (url.endsWith(MODEL_BUILTIN_PATH)) {
    return new Response(JSON.stringify({ builtinModels: [{ model_id: 'deepseek-v4-flash', credit: [{ time_slot_id: 'default', ratio_display: '0.18x' }] }] }), { status: 200 })
  }
  if (url.endsWith('/v1/ops/claim')) {
    return new Response(JSON.stringify({ id: 'benefit-1', benefitAmount: 1000 }), { status: 200 })
  }
  if (url.endsWith('/v1/ops/confirm')) {
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  throw new Error(`unexpected url: ${url}`)
}

const extras = createCodeArtsExtras({ credentialOf: async () => ({ access_key_id: CRED.ak, secret_access_key: CRED.sk, security_token: CRED.securityToken }), fetch: fakeFetch })
const account = { id: 'codearts-1', nickname: 'ha' }

const status = await extras.statusOf(account)
assert.equal(status.accountId, 'codearts-1')
assert.equal(status.info.total.remain, 800)
assert.equal(status.activities.length, 1)
assert.deepEqual(status.ratios, { 'deepseek-v4-flash': 'x0.18' })

calls.length = 0
const claimed = await extras.claim(account, '7')
assert.equal(claimed.kind, 'claimed')
assert.equal(claimed.credit, 1000)
const paths = calls.map(row => new URL(row.url).pathname)
assert.deepEqual(paths, ['/v1/ops/delivery', '/v1/ops/claim', '/v1/ops/confirm'], '领取后必须补 confirm')
assert.equal(JSON.parse(calls[1].body).campaignId, '7')
assert.equal(JSON.parse(calls[1].body).channel, 'IDE')

// 重复领取：上游回 40001 → 「已领」而不是「失败」
const replayFetch = async (url, init) => {
  if (url.includes(OPS_DELIVERY_PATH)) {
    return new Response(JSON.stringify({ items: [{ campaignId: 7, type: 'USER_LOGIN', claimable: true, status: 'ENTRY' }] }), { status: 200 })
  }
  return new Response(JSON.stringify({ code: 40001, message: 'already claimed' }), { status: 200 })
}
const replay = createCodeArtsExtras({ credentialOf: async () => ({ access_key_id: 'a', secret_access_key: 's' }), fetch: replayFetch })
assert.equal((await replay.claim(account, '7')).kind, 'already-claimed')

// 凭据缺失：明确报原因，不发请求
const bare = createCodeArtsExtras({ credentialOf: async () => ({ access_token: 'x' }), fetch: fakeFetch })
const bareStatus = await bare.statusOf(account)
assert.match(bareStatus.error, /AK\/SK/)

console.log('codearts extras OK:', 24, 'assertions')
process.exit(0)