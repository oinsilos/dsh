import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildGroupRows, DEFAULT_PRIORITY, describeGroup, describeGroupLine, isRouteEntry, memberEntry,
  normalizeGroups, orderMembers, resolveGroupCandidates, windowActive,
} from '../src/route/groups.js'
import { createGate } from '../src/route/gate.js'
import { createRouteStore, mapLegacyModel } from '../src/route/store.js'
import { dayKey } from '../src/store.js'
import { normalizeEffort } from '../src/effort.js'
import { remapGroups } from '../src/route/groups.js'
import { FreeModelAdapter } from '../src/adapter.js'
import {
  applyRatio, baselineOf, clampRatio, compactionStatus, MIN_RATIO, MAX_RATIO, OFF_RATIO,
  ratioFloor, restoreRatio,
} from '../src/compaction/ratio.js'

// ── 分组结构：迁移数据原样保留（慢模型 priority 15 不动）──────────────────
const legacy = [
  {
    id: 'dccb69d7-f43f-4364-aa3f-a6415ee73b2c',
    name: '主力',
    enabled: true,
    models: [
      { provider: 'loomy', model: 'GLM-5.3-Flash', priority: 15, effort: 'xhigh' },
      { provider: 'codearts', model: 'glm-5.3-flash', priority: 10 },
      { provider: 'trae', model: 'deepseek-v4.1-flash', priority: 40, windows: [{ from: 18, to: 8 }, { from: 12, to: 14 }], disabled: true },
    ],
  },
]
const groups = normalizeGroups(legacy)
assert.equal(groups.length, 1)
assert.ok(groups[0].id.startsWith('route:'), 'group id is a route-prefixed slug')
assert.ok(/^route:[a-z0-9-]+$/.test(groups[0].id), 'slug is ascii-safe')
assert.equal(groups[0].models[0].priority, 15, 'loomy priority stays 15 (Q2: do not reorder slow models)')
assert.equal(groups[0].models[0].effort, 'xhigh')
assert.deepEqual(groups[0].models[2].windows, [{ from: 18, to: 8 }, { from: 12, to: 14 }])
assert.equal(groups[0].models[2].disabled, true)
assert.equal(groups[0].models[1].priority, 10)
assert.equal(groups[0].legacyId, 'dccb69d7-f43f-4364-aa3f-a6415ee73b2c')

// 幂等：保存 → 再归一化 → 不漂移，优先级也不重排。
const again = normalizeGroups(groups)
assert.deepEqual(again.map(g => g.models.map(m => m.priority)), [[15, 10, 40]])
assert.deepEqual(orderMembers(groups[0]).map(m => m.model), ['codearts/glm-5.3-flash', 'loomy/GLM-5.3-Flash', 'trae/deepseek-v4.1-flash'])

// 时段：跨零点 + 午间窗口
assert.equal(windowActive([{ from: 18, to: 8 }], 2), true)
assert.equal(windowActive([{ from: 18, to: 8 }], 12), false)
assert.equal(windowActive([{ from: 12, to: 14 }], 13), true)
assert.equal(windowActive([], 13), true)

// ── 目录投影 ──────────────────────────────────────────────────────────────
const catalog = [
  { id: 'codearts/glm-5.3-flash', name: 'GLM-5.3-Flash', provider: 'codearts', contextWindow: 200_000, maxOutput: 32_000, vision: false },
  { id: 'loomy/GLM-5.3-Flash', name: 'GLM-5.3-Flash', provider: 'loomy', contextWindow: 1_000_000, maxOutput: 64_000, vision: true },
  { id: 'trae/deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', provider: 'trae', contextWindow: 1_000_000, maxOutput: 32_000, vision: true },
]
const rows = buildGroupRows(groups, catalog)
assert.equal(rows.length, 1)
assert.equal(rows[0].channel, 'route')
assert.equal(rows[0].contextWindow, 200_000, 'group promises the weakest member window')
assert.equal(rows[0].maxOutput, 32_000)
assert.equal(rows[0].vision, false, 'vision only when every member sees images')
assert.equal(rows[0].groupMembers, 2, 'disabled member is not counted as a live candidate')
assert.ok(isRouteEntry(rows[0]))

// 目录少一个成员：行还在，成员数减少；全缺：整组不投影。
const partial = buildGroupRows(groups, catalog.filter(entry => entry.id !== 'codearts/glm-5.3-flash'))
assert.equal(partial[0].groupMembers, 1)
assert.equal(buildGroupRows(groups, []).length, 0)
assert.equal(buildGroupRows([{ ...groups[0], enabled: false }], catalog).length, 0)

// ── 候选解析：时段 / 熔断 / 并发 / 缺失 ───────────────────────────────────
const hour = 13 // 午间：trae 的 12-14 生效，但它被 disabled；其余全在
const resolved = resolveGroupCandidates(groups[0], {
  catalog,
  failedKeys: new Set(['loomy/GLM-5.3-Flash']),
  hour,
  gate: { isFull: id => id === 'codearts/glm-5.3-flash', cooldownUntil: () => 0 },
})
assert.equal(resolved.candidates.length, 0, 'loomy failed + codearts busy => nothing left')
assert.equal(resolved.skipped.filter(item => item.reason === 'failed').length, 1)
assert.equal(resolved.skipped.filter(item => item.reason === 'busy').length, 1)
assert.equal(resolved.skipped.filter(item => item.reason === 'disabled').length, 1)
assert.equal(resolved.allFailed, false)

const okResolved = resolveGroupCandidates(groups[0], { catalog, failedKeys: new Set(), hour, gate: null })
assert.deepEqual(okResolved.candidates.map(c => c.entry.id), ['codearts/glm-5.3-flash', 'loomy/GLM-5.3-Flash'])

const allFailed = resolveGroupCandidates(groups[0], {
  catalog,
  failedKeys: new Set(['loomy/GLM-5.3-Flash', 'codearts/glm-5.3-flash']),
  hour,
})
assert.equal(allFailed.candidates.length, 0)
assert.equal(allFailed.allFailed, true)

// 时段外：trae 在 10 点被 disable 挡住；换一个不 disable 的组验证 window 过滤。
const windowGroup = normalizeGroups([{ name: '时段', models: [{ model: 'trae/deepseek-v4.1-flash', priority: 10, windows: [{ from: 18, to: 8 }] }] }])[0]
assert.equal(resolveGroupCandidates(windowGroup, { catalog, hour: 12 }).candidates.length, 0)
assert.equal(resolveGroupCandidates(windowGroup, { catalog, hour: 23 }).candidates.length, 1)

assert.equal(describeGroupLine(groups[0]), '主力：codearts/glm-5.3-flash(10) → loomy/GLM-5.3-Flash(15) → trae/deepseek-v4.1-flash(40)')

// ── 迁移坐标兜底：双前缀 / 裸名 / 同 provider 尾段 ────────────────────────
const liveCatalog = [
  { id: 'doubao/person-deepseek-v4-1-flash-261017', provider: 'doubao', name: 'Doubao' },
  { id: 'loomy/GLM-5.3-Flash', provider: 'loomy', name: 'GLM' },
  { id: 'codearts/glm-5.3-flash', provider: 'codearts', name: 'GLM' },
]
const doubled = normalizeGroups([{ name: '主力', models: [
  {
    provider: 'doubao', model: 'doubao/doubao/person-deepseek-v4-1-flash-261017', priority: 10,
    legacy: { provider: 'doubao', model: 'doubao/person-deepseek-v4-1-flash-261017' },
  },
  { provider: 'loomy', model: 'GLM-5.3-Flash', priority: 15, effort: 'xhigh' },
] }], { catalog: liveCatalog })
assert.equal(memberEntry(doubled[0].models[0], liveCatalog)?.id, 'doubao/person-deepseek-v4-1-flash-261017', 'legacy coordinate rescues a double-prefixed id')
assert.equal(memberEntry(doubled[0].models[1], liveCatalog)?.id, 'loomy/GLM-5.3-Flash', 'bare model + provider is prefixed')
const doubledDescription = describeGroup(doubled[0], { catalog: liveCatalog, failedKeys: new Set() })
assert.equal(doubledDescription.models[0].available, true, 'available despite the stored id shape')
assert.equal(doubledDescription.models[0].id, 'doubao/person-deepseek-v4-1-flash-261017', 'panel exposes the canonical id for breaker resets')
const doubledRows = buildGroupRows(doubled, liveCatalog)
assert.equal(doubledRows.length, 1, 'a group with only migration-shaped ids still projects a catalog row')
assert.deepEqual(doubledRows[0].memberIds, ['doubao/person-deepseek-v4-1-flash-261017', 'loomy/GLM-5.3-Flash'])
const doubledCandidates = resolveGroupCandidates(doubled[0], { catalog: liveCatalog, failedKeys: new Set(), gate: createGate({ limitOf: () => 0 }) })
assert.deepEqual(doubledCandidates.candidates.map(row => row.entry.id), ['doubao/person-deepseek-v4-1-flash-261017', 'loomy/GLM-5.3-Flash'])
assert.equal(doubledCandidates.skipped.length, 0)
// 没有 legacy 坐标时，同 provider 的尾段匹配仍能救回来（大小写不敏感）。
assert.equal(memberEntry({ provider: 'doubao', model: 'doubao/doubao/PERSON-DEEPSEEK-V4-1-FLASH-261017' }, liveCatalog)?.id, 'doubao/person-deepseek-v4-1-flash-261017')
// 跨 provider 不猜：codearts 的 glm 不能命中 loomy 的同名模型。
assert.equal(memberEntry({ provider: 'other', model: 'other/GLM-5.3-Flash' }, liveCatalog), undefined)

// ── 并发闸门 ──────────────────────────────────────────────────────────────
const gate = createGate({ limitOf: id => (id === 'codearts/glm-5.3-flash' ? 2 : 0) })
assert.equal(gate.acquire('codearts/glm-5.3-flash'), true)
assert.equal(gate.acquire('codearts/glm-5.3-flash'), true)
assert.equal(gate.isFull('codearts/glm-5.3-flash'), true)
assert.equal(gate.acquire('codearts/glm-5.3-flash'), false)
gate.release('codearts/glm-5.3-flash')
assert.equal(gate.inflight('codearts/glm-5.3-flash'), 1)
assert.equal(gate.isFull('codearts/glm-5.3-flash'), false)
gate.release('codearts/glm-5.3-flash')
gate.release('codearts/glm-5.3-flash')
assert.equal(gate.inflight('codearts/glm-5.3-flash'), 0, 'over-release never goes negative')
assert.equal(gate.acquire('loomy/GLM-5.3-Flash'), true, 'limit 0 = unlimited')
gate.markCapacity('loomy/GLM-5.3-Flash', 30_000)
assert.ok(gate.cooldownUntil('loomy/GLM-5.3-Flash') > Date.now())
gate.resetCooldown()
assert.equal(gate.cooldownUntil('loomy/GLM-5.3-Flash'), 0)

// ── 迁移：旧 provider/model → 目录 id ─────────────────────────────────────
assert.equal(mapLegacyModel('doubao', 'doubao/person-deepseek-v4-1-flash-261017', [
  { id: 'doubao/person-deepseek-v4-1-flash-261017', modelId: 'person-deepseek-v4-1-flash-261017', provider: 'doubao' },
])?.id, 'doubao/person-deepseek-v4-1-flash-261017')
assert.equal(mapLegacyModel('codearts', 'deepseek-v4.1-flash', catalog), undefined, 'no invented match')
assert.equal(mapLegacyModel('codearts', 'GLM-5.3-FLASH', catalog)?.id, 'codearts/glm-5.3-flash', 'case-insensitive provider match')

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-route-'))
const home = path.join(temp, '.dsh')
const dataDir = path.join(home, 'our-free-model')
const legacyDir = path.join(home, 'model-failover-manager')
fs.mkdirSync(legacyDir, { recursive: true })
fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(path.join(legacyDir, 'groups.json'), JSON.stringify(legacy))
fs.writeFileSync(path.join(legacyDir, 'session-bindings.json'), JSON.stringify([
  { sessionId: 's1', groupId: 'dccb69d7-f43f-4364-aa3f-a6415ee73b2c', mode: 'route', explicit: true },
]))
fs.writeFileSync(path.join(legacyDir, 'failed.json'), JSON.stringify([
  { key: 'codearts/deepseek-v4.1-flash', day: dayKey(), count: 2, provider: 'codearts', model: 'deepseek-v4.1-flash', code: 'MANUAL' },
]))
fs.writeFileSync(path.join(legacyDir, 'settings.json'), JSON.stringify({ defaultConcurrency: 3 }))
const store = createRouteStore({ dataDir, home })
store.attachCatalog(() => catalog)
const imported = store.autoImport()
assert.equal(imported.imported, true)
assert.equal(imported.groups, 1)
assert.equal(imported.bindings, 1)
const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'route', 'groups.json'), 'utf8'))
assert.equal(saved[0].models[0].model, 'loomy/GLM-5.3-Flash', 'known id kept as-is')
assert.equal(saved[0].models[0].priority, 15)
assert.equal(saved[0].models[2].model, 'trae/deepseek-v4.1-flash')
assert.deepEqual(saved[0].models[2].windows, [{ from: 18, to: 8 }, { from: 12, to: 14 }])
const status = store.status({ catalog })
assert.equal(status.groups[0].models.length, 3)
assert.equal(status.groups[0].bindings, 1)
assert.equal(status.failed.length, 1)
assert.equal(status.failed[0].key, 'codearts/deepseek-v4.1-flash')

// 熔断累计 + 成功解除
store.markFailed({ model: 'loomy/GLM-5.3-Flash', provider: 'loomy' }, { group: 'route:主力', code: 'QUOTA', reason: 'quota' })
assert.equal(store.isFailed('loomy/GLM-5.3-Flash'), true)
store.markFailed({ model: 'loomy/GLM-5.3-Flash' }, { code: 'QUOTA' })
assert.equal(store.failed().find(item => item.key === 'loomy/GLM-5.3-Flash').count, 2)
store.clearFailed('loomy/GLM-5.3-Flash')
assert.equal(store.isFailed('loomy/GLM-5.3-Flash'), false)
assert.equal(store.resetFailed('codearts/deepseek-v4.1-flash'), 1)
assert.equal(store.failed().length, 0)

// 保存：未知模型保留（标 note），成员上限内去重
const savedAgain = store.saveGroups([{
  name: '主力',
  models: [
    { model: 'ghost/model', provider: 'ghost', priority: 99, note: '目录里没有' },
    { model: 'loomy/GLM-5.3-Flash', priority: 15 },
    { model: 'loomy/GLM-5.3-Flash', priority: 15 },
  ],
}])
assert.equal(savedAgain[0].id, 'route:group')
assert.equal(savedAgain[0].models.length, 2, 'duplicate model dropped')
assert.equal(savedAgain[0].models[0].model, 'ghost/model')

// 强制再导入：先备份现有 groups
const reimport = store.importLegacy({ force: true })
assert.equal(reimport.imported, true)
assert.ok(fs.readdirSync(path.join(dataDir, 'route')).some(name => name.startsWith('groups.before-import-')), 'force import backs up current groups')

fs.rmSync(temp, { recursive: true, force: true })

// ── 压缩器：运行时替换 config + 三件套修正 + 恢复 ─────────────────────────
const config = Object.freeze({ thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 65536, headroomTokens: 65536, contextWindow: 200_000 })
const engine = { config }
const ctx = {
  // 当前 Cordis：服务实现挂在 fiber.provisions，隔离 realm 也在其中。
  registry: new Map([['runtime', { fibers: [{ provisions: new Set([{ name: 'compaction', value: engine }]) }] }]]),
}
assert.equal(applyRatio(ctx, 0.6), 1)
assert.equal(engine.config.thresholdRatio, 0.6)
assert.equal(engine.config.headroomTokens, -1_000_000, 'headroom must be neutralized or high slider values are inert')
assert.equal(engine.config.maxTokens, 65536, 'summarizer output budget restored from baseline')
assert.equal(baselineOf(engine).ratio, 0.8, 'baseline keeps the original ratio')

// 幂等：第二次同值不换引用
const same = engine.config
applyRatio(ctx, 0.6)
assert.equal(engine.config, same)

assert.equal(clampRatio(0.05), MIN_RATIO)
assert.equal(clampRatio(0.99), MAX_RATIO)
assert.equal(clampRatio(1), OFF_RATIO, 'off is clampable to 1.0')
assert.equal(clampRatio('nope'), null)

const statusNow = compactionStatus(ctx, { enabled: true, thresholdRatio: 0.6 })
assert.equal(statusNow.engineCount, 1)
assert.equal(statusNow.effectiveRatio, 0.6)
assert.equal(statusNow.followDefault, false)
assert.equal(ratioFloor(ctx), 0.2)

// 保留比例高于固定下限时，下限跟着抬（否则引擎 resolveCompactSpec 抛错）
const hot = { config: Object.freeze({ thresholdRatio: 0.8, retainRatio: 0.44, maxTokens: 65536, contextWindow: 200_000 }) }
const hotCtx = { registry: new Map([['r', { fibers: [{ store: { compaction: { value: hot } } }] }]]) }
assert.equal(ratioFloor(hotCtx), 0.45)

restoreRatio(ctx)
assert.equal(engine.config.thresholdRatio, 0.8)
assert.equal(engine.config.headroomTokens, 65536, 'restore puts the original headroom back')
applyRatio(ctx, 0.55)
assert.equal(engine.config.maxTokens, 65536)

// 旧 Cordis 把 Impl 放在 fiber.store：仍要能摸到（热重载期间新老 fiber 共存）
const legacyEngine = { config: Object.freeze({ thresholdRatio: 0.8, retainRatio: 0.16, maxTokens: 65536, headroomTokens: 65536 }) }
const legacyCtx = { registry: new Map([['r', { fibers: [{ store: { compaction: { value: legacyEngine } } }] }]]) }
assert.equal(applyRatio(legacyCtx, 0.7), 1)
assert.equal(legacyEngine.config.thresholdRatio, 0.7)

// 没有引擎时：状态仍可回答，apply 是安全的空操作
const emptyCtx = { registry: new Map() }
assert.equal(applyRatio(emptyCtx, 0.6), 0)
assert.equal(compactionStatus(emptyCtx, {}).supported, false)

// 思考强度归一：旧插件的词汇必须落到当前模型真认的 id 上，翻不到就跟随会话
// （而不是像 resolveLevel 那样静默落回默认档）。
const declared = { efforts: ['low', 'medium', 'high', 'max'], reasoning: true }
assert.equal(normalizeEffort(declared, 'xhigh'), 'max', 'xhigh 在四档菜单上应落到 max')
assert.equal(normalizeEffort(declared, 'Extra High'), 'max', 'Extra High（带空格）应落到 max')
assert.equal(normalizeEffort(declared, 'extra_high'), 'max')
assert.equal(normalizeEffort(declared, 'high'), 'high')
assert.equal(normalizeEffort(declared, '最低'), 'low')
assert.equal(normalizeEffort(declared, '默认（高）'), 'high', '旧面板的“默认（高）”标签应落到 high')
const ladder = { reasoning: true, canDisableThinking: false }
assert.equal(normalizeEffort(ladder, 'high'), 'deep', '免费三档车道：high 应落到 deep')
assert.equal(normalizeEffort(ladder, 'xhigh'), 'deep', '三档车道没有 xhigh：落到最高一档')
assert.equal(normalizeEffort(ladder, 'low'), 'light')
assert.equal(normalizeEffort(ladder, ''), '', '空值 = 跟随会话')
assert.equal(normalizeEffort(ladder, 'default'), '', 'default = 跟随会话')
assert.equal(normalizeEffort({ reasoning: false }, 'high'), '', '没有档位的模型不应被塞进档位')
assert.equal(normalizeEffort(declared, 'nonsense'), '', '翻不到就跟随会话，交给面板提示')

// 一键重映射：旧 provider 前缀 / 双前缀要能改写成当前目录 id，找不到的保留
const remapCatalog = [
  { id: 'codearts/glm-5.3-flash', provider: 'codearts', name: 'GLM-5.3-Flash' },
  { id: 'doubao/person-deepseek-v4-1-flash', provider: 'doubao', name: 'DeepSeek V4.1 Flash' },
]
const remapResult = remapGroups([{
  id: 'route:main',
  name: '主力',
  models: [
    { model: 'codearts/glm-5.3-flash', provider: 'codearts-agent', priority: 10 },
    { model: 'doubao/doubao/person-deepseek-v4-1-flash', provider: 'doubao', priority: 20 },
    { model: 'ghost/nope-flash', provider: 'ghost', priority: 30 },
  ],
}], remapCatalog)
assert.equal(remapResult.changed, 2, '两个旧坐标应被改写')
assert.equal(remapResult.groups[0].models[0].provider, 'codearts', '旧 provider 前缀应改成目录里的 provider')
assert.equal(remapResult.groups[0].models[1].model, 'doubao/person-deepseek-v4-1-flash', '双前缀应收成目录 id')
assert.equal(remapResult.groups[0].models[2].model, 'ghost/nope-flash', '找不到的成员必须原样保留')
assert.equal(remapResult.unresolved.length, 1, '找不到的成员应进 unresolved')
assert.equal(remapResult.groups[0].models[0].priority, 10, '重映射不能改动优先级')

// ── 别的渠道的成员（channel: 'host'）──────────────────────────────────────
// 分组要覆盖整个宿主的渠道：这类成员不进我们的目录，只在建组视图里参与，
// 发放时原样交回宿主 llm.stream。
const hostCatalog = [
  { id: 'unisound/u2-flash', provider: 'unisound', modelId: 'u2-flash', channel: 'host', name: 'u2-flash', reasoning: true },
  { id: 'codearts/glm-5.3-flash', provider: 'codearts', name: 'GLM-5.3-Flash', channel: 'own' },
]
const hostGroup = normalizeGroups([{ name: '主力', models: [
  { model: 'unisound/u2-flash', provider: 'unisound', priority: 1, effort: 'high' },
  { model: 'codearts/glm-5.3-flash', provider: 'codearts', priority: 10 },
] }])[0]
const hostResolved = resolveGroupCandidates(hostGroup, { catalog: hostCatalog, hour: 12 })
assert.deepEqual(hostResolved.candidates.map(row => row.entry.id), ['unisound/u2-flash', 'codearts/glm-5.3-flash'], 'host 行要能当候选')
const hostDescribed = describeGroup(hostGroup, { catalog: hostCatalog, failedKeys: new Set() })
assert.equal(hostDescribed.models[0].available, true, 'host 成员应显示可用')
assert.deepEqual(hostDescribed.models[0].efforts, [], '别的渠道没声明档位时不能套用免费车道三档')
assert.equal(hostDescribed.models[0].effortDefault, undefined)
assert.equal(buildGroupRows([hostGroup], hostCatalog).length, 1, '只由 host 成员组成的分组也要投影成虚拟行')

// 转发：成员属于别的 provider 时把这一轮交回宿主 llm.stream，只替换 provider/model。
const foreignAdapter = new FreeModelAdapter({
  state: () => ({ catalog: [], routeCatalog: [], membership: {}, settings: {}, attributionUserAgent: '' }),
  recordUsage: () => {},
  hostStream: options => (async function* () {
    assert.equal(options.provider, 'unisound')
    assert.equal(options.model, 'u2-flash')
    assert.equal(options.reasoningEffort, undefined, '翻不到的档位不传给外部模型')
    yield { type: 'text-delta', text: 'hi' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })(),
})
const foreignEntry = { id: 'unisound/u2-flash', provider: 'unisound', modelId: 'u2-flash', channel: 'host' }
const foreignSeen = []
const foreignIterator = foreignAdapter.runForeign({ provider: 'our-free-model', model: 'route:main', reasoningEffort: 'max', messages: [] }, foreignEntry, {})
let foreignRow = await foreignIterator.next()
while (foreignRow.done !== true) { foreignSeen.push(foreignRow.value); foreignRow = await foreignIterator.next() }
assert.equal(foreignSeen[0].text, 'hi')
assert.equal(foreignRow.value.ok, true)
assert.equal(foreignRow.value.advance, false, '成功的一轮不该换人')

// 宿主没有 llm.stream：这是环境缺陷，不能装作「换个成员再试试」。
const noStreamAdapter = new FreeModelAdapter({
  state: () => ({ catalog: [], membership: {}, settings: {}, attributionUserAgent: '' }),
  recordUsage: () => {},
  hostStream: () => null,
})
const noStreamSeen = []
const noStreamIterator = noStreamAdapter.runForeign({ provider: 'our-free-model', model: 'route:main', messages: [] }, foreignEntry, {})
let noStreamRow = await noStreamIterator.next()
while (noStreamRow.done !== true) { noStreamSeen.push(noStreamRow.value); noStreamRow = await noStreamIterator.next() }
assert.equal(noStreamSeen.at(-1)?.type, 'finish', '转发缺失时必须给调用方一个收尾')
assert.equal(noStreamSeen.at(-1)?.reason?.kind, 'error')
assert.equal(noStreamRow.value.advance, false, '环境缺陷换成员也没用')

console.log('route groups / gate / migration / compaction OK')
process.exit(0)
