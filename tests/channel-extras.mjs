/**
 * 渠道扩展的离线测试：Qoder 目录（先试真 / 退实测表）、以及**新增聚合渠道**的
 * 注册表条目完整性。
 *
 * 两件事都属「用户会直接看到数字」的地方：
 * - Qoder 的倍率要么是真值、要么明确标 `static` —— 不能把快照说成实时价；
 * - 注册表条目的 `modelsUrl` 必须与 `baseUrl` 同源，否则「发现模型」会打到
 *   另一个主机上（这正是聚合车道最容易出的静默错误）。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createQoderExtras, parseQoderListing } from '../src/channels/qoder.js'

/* ── Qoder 目录 ─────────────────────────────────────────────────────────── */

const listing = parseQoderListing({
  data: { models: [
    { key: 'qmodel_38max', displayName: 'Qwen3.8-Max', price_factor: 0.42 },
    { model_key: 'qfmodel', name: 'Qwen3.8-Flash', price_factor: 0 },
    { key: 'broken-row' },
    { key: 'qmodel_38max', displayName: 'dup', price_factor: 9 },
  ] },
})
assert.equal(listing.length, 3, '不认识的键与重复 id 必须被丢掉')
assert.equal(listing[0].id, 'qmodel_38max')
assert.equal(listing[0].rate, 0.42)
assert.equal(listing[1].id, 'qfmodel')
assert.equal(listing[1].rate, 0, '0 是真实报价（免费），不能当缺值丢掉')
assert.equal(listing[2].name, 'broken-row', '没有展示名时用 id，不编名字')

const cred = { access_token: 'tok' }
const account = { id: 'qodercn-1', nickname: 'nick', provider: 'qodercn' }

// ① 远端可用 → live，倍率来自远端
const liveFetch = async (url, init) => {
  assert.ok(url.startsWith('https://openapi.qoder.com.cn'), 'qodercn 必须打 CN 的 openapi')
  assert.match(init.headers.authorization, /^Bearer tok$/)
  return jsonResponse({ data: { models: [{ key: 'gmodel', displayName: 'GLM-5.3', price_factor: 0.42 }] } })
}
const live = await createQoderExtras({ credentialOf: async () => cred, fetch: liveFetch }).statusOf(account)
assert.equal(live.source, 'live')
assert.equal(live.ratios.gmodel, 'x0.42')

// ② 401 → static，且带对实测表的倍率（不是空表、也不假装 live）
const denyFetch = async () => ({ ok: false, status: 401, async text() { return 'unauthorized' } })
const denied = await createQoderExtras({ credentialOf: async () => cred, fetch: denyFetch }).statusOf(account)
assert.equal(denied.source, 'static')
assert.ok(denied.catalog.length >= 10, '回退表必须有内容')
assert.equal(denied.ratios.qmodel_38max, 'x0.5', '实测表里的 0.5 倍')
assert.equal(denied.ratios.qfmodel, 'x0', '免费模型照写 x0')
assert.ok(denied.catalog.some(row => row.name.includes('· x0.5')), '展示名要带倍率后缀（与其余渠道同约定）')

// ③ 网络异常 → 同样是 static，不抛
const brokenFetch = async () => { throw new Error('ECONNRESET') }
const broken = await createQoderExtras({ credentialOf: async () => cred, fetch: brokenFetch }).statusOf(account)
assert.equal(broken.source, 'static')

// ④ 没有凭据 → static（不假装查过）
const noCred = await createQoderExtras({ credentialOf: async () => null, fetch: denyFetch }).statusOf(account)
assert.equal(noCred.source, 'static')

// ⑤ 两个站点各自的主机
let seenUrl = ''
const spy = async url => { seenUrl = url; return jsonResponse({ data: { models: [] } }) }
await createQoderExtras({ credentialOf: async () => cred, fetch: spy }).statusOf({ ...account, provider: 'qoder' })
assert.ok(seenUrl.startsWith('https://openapi.qoder.sh'), 'qoder（国际）必须打 .sh 主机')

function jsonResponse(payload) {
  return { ok: true, status: 200, async text() { return JSON.stringify(payload) } }
}

/* ── 新增聚合渠道的注册表条目 ───────────────────────────────────────────── */

const registry = JSON.parse(fs.readFileSync(path.resolve('src/providers/registry.json'), 'utf8'))
for (const id of ['modelscope', 'qiniu']) {
  const row = registry.find(entry => entry.id === id)
  assert.ok(row !== undefined, `注册表缺少 ${id}`)
  assert.equal(row.category, 'apikey', `${id} 是贴 Key 型渠道`)
  assert.equal(row.auth.kind, 'apiKey')
  assert.ok(typeof row.auth.env === 'string' && row.auth.env !== '', `${id} 必须声明凭据环境变量名`)
  assert.ok(row.models.length > 0, `${id} 的模型表不能为空（空表会让面板显示「已关闭」）`)
  assert.ok(row.modelsUrl.startsWith(row.baseUrl), `${id} 的 modelsUrl 必须与 baseUrl 同源`)
  assert.equal(row.format, 'openai-chat')
  for (const model of row.models) {
    assert.ok(typeof model.id === 'string' && model.id !== '')
    assert.ok(model.contextWindow === null || model.contextWindow > 0, `${id}/${model.id} 的窗口要么留空、要么为正`)
  }
}
// 全表 id 唯一（重复会让选择器出现两条同名模型）
const ids = registry.map(row => row.id)
assert.equal(new Set(ids).size, ids.length, 'provider id 必须唯一')

console.log('channel extras OK:', 20, 'assertions')
process.exit(0)