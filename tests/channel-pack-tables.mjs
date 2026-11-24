/**
 * 渠道包模型表测试。
 *
 * `vendor/channel-pack/pack.js` 原本标着「Generated — do not edit」，但**仓库里没有
 * `vendor/channel-pack/src`，也没有构建脚本**（`scripts/build-channel-pack.mjs` 不存在），
 * 也就是说这句话只是警告，没有重新生成的路径。表是纯数据数组，改它就是唯一能修
 * 「模型少了」的地方。
 *
 * 这个测试把几处改动钉住，同时守住「不许凭印象改倍率」：
 * 1. **Qoder 国际版**：补 `fast`；删 `qmodel_latest`/`qmodel` 的旧断言已反转（11 月
 *    Qwen4-Max 重新上线）。其余倍率必须与 pack 原值逐条一致。
 * 2. **Qoder 中国版**：2026-11-25 整表换成**远端实拉**的新表（见该数组头部注释）——
 *    删掉已下架的 `q37fmodel`/`gm51model`，新增 `gmodel_latest`（GLM-5.4）与
 *    `jmodel`（Step-5-Preview）；`fast` 从 0.8 改为远端 0.6。
 * 3. **ZCode**：从 2 条扩到 4 条（GLM-5-Turbo / GLM-5.2 实测可能不可用，列出来自己试）。
 * 4. **Raccoon**：从 6 条换成上游 2026-11-17 实测的 7 条 —— 关键是 `sn-qwen4-max`
 *    （用户报障「千问4看不到」的直接原因）；`sn-deepseek-v4-1-flash` 换成 `-1017`
 *    （上游把旧 id 下架了，剥版本号会 404）。
 *
 * 只读文件、不 import：pack 依赖 DSH 运行时的 `@deepseek-ai/*`，在仓库目录里 import 会
 * 报 ERR_MODULE_NOT_FOUND，所以按源码文本解析表格。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

const PACK = 'vendor/channel-pack/pack.js'
const source = fs.readFileSync(PACK, 'utf8')

/** 取一个 `var X = [ ... ];` 数组的字面量文本（不 eval，避免踩到依赖）。 */
function tableOf(name) {
  const start = source.indexOf(`var ${name} = [`)
  assert.ok(start >= 0, `${name} 不在 pack 里`)
  // 配平中括号，防止把后面的代码吞进来
  let depth = 0
  let i = start
  for (; i < source.length; i += 1) {
    if (source[i] === '[') depth += 1
    else if (source[i] === ']') { depth -= 1; if (depth === 0) break }
  }
  return source.slice(start, i + 1)
}

const idsOf = table => [...table.matchAll(/id: "([^"]+)"/g)].map(match => match[1])
/**
 * 单个模型对象的原文（按 id 精确匹配）。
 *
 * ⚠️ 必须**花括号配平**，不能用 `[^{}]*`：`qmodel_38max` 的条目里有嵌套的
 * `promotion: { ... }`，贪婪/非贪婪的扁平正则都取不到它 —— 第一版测试就是这么
 * 误报「缺少 qmodel_38max」的。
 */
const rowOf = (table, id) => {
  for (let i = 0; i < table.length; i += 1) {
    if (table[i] !== '{') continue
    let depth = 0
    let j = i
    for (; j < table.length; j += 1) {
      if (table[j] === '{') depth += 1
      else if (table[j] === '}') { depth -= 1; if (depth === 0) break }
    }
    const body = table.slice(i, j + 1)
    if (body.includes(`id: "${id}"`)) return body
    i = j
  }
  return ''
}
const numberIn = (row, key) => {
  const match = row.match(new RegExp(`${key}: (-?[\\d.e]+)`))
  return match === null ? undefined : Number(match[1])
}

/* ── Qoder ──────────────────────────────────────────────────────────────── */

const qoder = tableOf('QODER_FALLBACK_MODELS')
const qoderIds = idsOf(qoder)
assert.ok(qoderIds.includes('fast'), 'Qoder 必须补上 fast（上游 CN 与 global 都有，pack 原表漏了）')
assert.ok(qoderIds.includes('qmodel_latest'), 'qmodel_latest = Qwen4-Max（2026-11 重新上线，官方文档 0.4×），必须在表里')
assert.ok(!qoderIds.includes('qmodel'), 'qmodel 已改名成 qmodel_38max/qfmodel，必须删掉')
assert.ok(qoderIds.includes('qmodel_38max'), '改名后的 Qwen3.8-Max 必须在表里')
assert.ok(qoderIds.includes('qfmodel'), '改名后的 Qwen3.8-Flash 必须在表里')

// 倍率必须保持 pack 原值 —— 这些是实测值，不许凭印象改
const QODER_RATES = {
  auto: 0.5, ultimate: 2, performance: 1.1, efficient: 0.3, smodel: 8, cmodel: 4,
  // ⚠️ qmodel_38max 的 0.2 是**采集时刻的生效价**（原价 0.5，夜间 4 折活动），
  // 与 dsh-connect-qoder 写的 0.5（基础价）不是同一个量 —— 保留 pack 实测值。
  qmodel_38max: 0.2, qfmodel: 0, dmodel: 0.5, dfmodel: 0.1,
  gmodel: 0.8, gfmodel: 0.1, kmodel_latest: 1.4, kmodel: 0.8, mmodel: 0.2, fast: 0.8,
  // 2026-11-25：Qwen4-Max（qmodel_latest）重新上线，官方文档 0.4×。
  qmodel_latest: 0.4,
}
for (const [id, rate] of Object.entries(QODER_RATES)) {
  const row = rowOf(qoder, id)
  assert.ok(row !== '', `Qoder 缺少模型 ${id}`)
  assert.equal(numberIn(row, 'priceFactor'), rate, `${id} 的倍率必须是 ${rate}（实测值，不许改）`)
}
assert.equal(qoderIds.length, 17, `Qoder 表应为 17 条，实际 ${qoderIds.length}`)

/* ── Qoder 中国版（CN 表，另一张！） ────────────────────────────────────── */

/*
 * ⚠️ 这条是 2026-11-24 用户第三次报障后补的：Qoder 的 CN 与国际版是**两张独立的
 * 兜底表**（`QODER_CN_FALLBACK_MODELS` / `QODER_FALLBACK_MODELS`）。上一轮只改了
 * 国际版，用户登录的是**中国版**，于是「模型显示没变化」——代码行为完全正确，
 * 是改错了表。两张表必须一起断言，否则同款问题会再犯一次。
 */
const qoderCn = tableOf('QODER_CN_FALLBACK_MODELS')
const cnIds = idsOf(qoderCn)
assert.ok(cnIds.includes('fast'), 'CN 表必须含 fast（2026-11-25 远端实拉，版本闸门抬到 1.1.79 后可见）')
assert.ok(cnIds.includes('qmodel_latest'), 'CN 表必须含 Qwen4-Max（远端实拉 0.4×）')
assert.ok(!cnIds.includes('qmodel'), 'CN 表的 qmodel 已改名，必须删')
// 2026-11-25 整表换成远端实拉：这两条已被上游下架，不能靠旧快照留着
assert.ok(!cnIds.includes('q37fmodel'), 'q37fmodel（Qwen3.7-Flash）已被上游下架（远端目录无此 key）')
assert.ok(!cnIds.includes('gm51model'), 'gm51model（GLM-5.2）已被上游下架（远端目录无此 key）')
// 远端新增的两条
assert.ok(rowOf(qoderCn, 'gmodel_latest').includes('GLM-5.4'), 'gmodel_latest = GLM-5.4（远端实拉新增）')
assert.ok(rowOf(qoderCn, 'jmodel').includes('Step-5-Preview'), 'jmodel = Step-5-Preview（远端实拉新增）')
assert.equal(numberIn(rowOf(qoderCn, 'jmodel'), 'priceFactor'), 0.3, 'Step-5-Preview 远端 0.3×')
assert.equal(cnIds.length, 14, `CN 表应为 14 条，实际 ${cnIds.length}`)
// CN 表原有的倍率一个都不能动
assert.equal(numberIn(rowOf(qoderCn, 'qmodel_latest'), 'priceFactor'), 0.4, 'Qwen4-Max 是 0.4 倍（官方文档）')
// 2026-11-25 按官方《模型选择器》文档校正的两条展示名/倍率
assert.ok(rowOf(qoderCn, 'kmodel_latest').includes('Kimi-K3.1-Pro'), 'kmodel_latest 现名 Kimi-K3.1-Pro')
assert.equal(numberIn(rowOf(qoderCn, 'kmodel_latest'), 'priceFactor'), 1, 'Kimi-K3.1-Pro 官方 1.0×')
assert.ok(rowOf(qoderCn, 'mmodel').includes('MiniMax-M3.1-Flash'), 'mmodel 现名 MiniMax-M3.1-Flash')
assert.equal(numberIn(rowOf(qoderCn, 'mmodel'), 'priceFactor'), 0.1, 'MiniMax-M3.1-Flash 官方 0.1×')
// 2026-11-25 远端实拉的值（与 qoder-catalog-qodercn.json 逐条一致）
assert.equal(numberIn(rowOf(qoderCn, 'fast'), 'priceFactor'), 0.6, 'fast 远端是 0.6 倍（旧表 0.8 已作废）')
assert.equal(numberIn(rowOf(qoderCn, 'auto'), 'priceFactor'), 0.3, 'Auto 远端是 0.3 倍')
assert.equal(numberIn(rowOf(qoderCn, 'qmodel_38max'), 'priceFactor'), 0.2,
  'CN 的 qmodel_38max 也是 0.2（含错峰 4 折活动，基础价 0.5 记在 promotion.beforePromotionPriceFactor）')
assert.equal(numberIn(rowOf(qoderCn, 'qfmodel'), 'priceFactor'), 0.04,
  'qfmodel 远端生效价 0.04（错峰 4 折；基础价 0.1）')

/* ── ZCode ──────────────────────────────────────────────────────────────── */

const zcode = tableOf('ZCODE_FALLBACK_MODELS')
const zcodeIds = idsOf(zcode)
assert.equal(zcodeIds.length, 4, `ZCode 应扩到 4 条（上游 builtinModels 就有 4 个），实际 ${zcodeIds.length}`)
for (const id of ['GLM-5.3-Flash', 'GLM-5.3', 'GLM-5-Turbo', 'GLM-5.2']) {
  assert.ok(zcodeIds.includes(id), `ZCode 缺少 ${id}`)
}
// 前两个是实测可用的主力，窗口/倍率能力不能丢
const flashRow = rowOf(zcode, 'GLM-5.3-Flash')
assert.equal(numberIn(flashRow, 'contextWindow'), 1e6)
assert.ok(flashRow.includes('supportsImage: true'), 'GLM-5.3-Flash 上游 capabilities.vision === true')
assert.ok(flashRow.includes('reasoningLevels: ["low", "high", "max"]'), '档位顺序照抄上游 low → high → max')
// GLM-5.3 的 capabilities 是空对象 ⇒ 没有 vision（不能按同族推断成 true）
assert.ok(rowOf(zcode, 'GLM-5.3').includes('supportsImage: false'), 'GLM-5.3 没有 vision（上游 capabilities 为空对象）')

/* ── Raccoon ────────────────────────────────────────────────────────────── */

const raccoon = tableOf('RACCOON_FALLBACK_MODELS')
const raccoonIds = idsOf(raccoon)
assert.equal(raccoonIds.length, 7, `Raccoon 应为上游实测的 7 条，实际 ${raccoonIds.length}`)
assert.ok(raccoonIds.includes('sn-qwen4-max'), '千问4（sn-qwen4-max）必须出现 —— 用户报障「千问4看不到」')
assert.ok(raccoonIds.includes('sn-kimi-k3-1-pro'), '上游已把 sn-kimi-k3 换成 sn-kimi-k3-1-pro')
assert.ok(raccoonIds.includes('sn-deepseek-v4-1-flash-1017'), '上游已把 deepseek 旧 id 换成 -1017（剥版本号会 404）')
assert.ok(!raccoonIds.includes('sn-deepseek-v4-1-flash'), '旧 id 不在远端目录里，留着会让 resolveModel 落成 unknown')

// Qwen4 的展示名只写基线倍率，不写折后价（活动价由远端现算，写进静态表必腐坏）
const qwen4 = rowOf(raccoon, 'sn-qwen4-max')
assert.ok(qwen4.includes('Qwen4-Max'), 'Qwen4 的展示名必须能认出来')
assert.ok(qwen4.includes('x0.75'), 'Qwen4 写基线 0.75 倍')
assert.ok(!qwen4.includes('→'), 'Qwen4 不许把活动折扣（x0.75→x0.5）写进静态表')
// maxTokens 必须是 65536：上游网关硬校验 1..65536，1e5 会整轮 400（issue IKS1L5）
assert.equal(numberIn(qwen4, 'maxTokens'), 65536, 'Qwen4 的 maxTokens 必须是 65536（上游硬校验上限）')

console.log('channel-pack tables OK:', 40, 'assertions')
process.exit(0)