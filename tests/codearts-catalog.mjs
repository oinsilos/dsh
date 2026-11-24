/**
 * CodeArts 目录纯函数测试（离线）。
 *
 * 钉住 2026-11-25 真机取证的三件事：
 * 1. **倍率按时段选**：`deepseek-v4.1-flash` 错峰（21:00–次日 7:59）是 0.09x，
 *    白天是 0.18x —— 无脑取 `credit[0]` 会在整个夜间显示高一倍的价。
 * 2. **只认 `ratio_display` 并转成 `x{n}`**（上游是 `0.18x`，x 在后）；
 *    认不出就**不显示**，绝不用占位值冒充。
 * 3. **原始 `model_id` 不裁日期后缀**（`deepseek-v4.1-flash-1017` 是独立模型）。
 */

import assert from 'node:assert/strict'
import {
  codeartsTimeSlotActive,
  pickCodeartsCredit,
  codeartsRateLabel,
  codeartsContextWindowOf,
  codeartsDescriptionOf,
  codeartsModelRow,
  codeartsDisplayName,
} from '../src/channels/codearts-catalog.js'

/* ── 时段判定 ──────────────────────────────────────────────────────────── */

const OFF_PEAK = {
  timezone: 'Asia/Shanghai',
  schedule: '0 0 21 * * *',
  duration: 11,
  timeunit: 'hour',
}
// 2026-11-25T14:00:00Z = 22:00 Asia/Shanghai（错峰内）
assert.equal(codeartsTimeSlotActive(OFF_PEAK, Date.parse('2026-11-25T14:00:00Z')), true)
// 2026-11-26T00:00:00Z = 08:00 Asia/Shanghai（错峰外，窗口 21:00 + 11h = 次日 7:59）
assert.equal(codeartsTimeSlotActive(OFF_PEAK, Date.parse('2026-11-26T00:00:00Z')), false)
// 2026-11-25T04:00:00Z = 12:00 Asia/Shanghai
assert.equal(codeartsTimeSlotActive(OFF_PEAK, Date.parse('2026-11-25T04:00:00Z')), false)
// 解析不出的形态一律 false（不臆造）
assert.equal(codeartsTimeSlotActive({ schedule: '', duration: 11, timeunit: 'hour' }, Date.now()), false)
assert.equal(codeartsTimeSlotActive({ schedule: '0 0 21 * * *', duration: 11, timeunit: 'minute' }, Date.now()), false)
assert.equal(codeartsTimeSlotActive({ schedule: '0 0 25 * * *', duration: 11, timeunit: 'hour' }, Date.now()), false)

const CREDIT = [
  { time_slot_id: 'default', ratio_display: '0.18x' },
  { time_slot_id: 'off_peak', ratio_display: '0.09x' },
]
const SLOTS = { default: { schedule: null }, off_peak: OFF_PEAK }
assert.equal(pickCodeartsCredit(CREDIT, SLOTS, Date.parse('2026-11-25T14:00:00Z')).ratio_display, '0.09x')
assert.equal(pickCodeartsCredit(CREDIT, SLOTS, Date.parse('2026-11-25T04:00:00Z')).ratio_display, '0.18x')
// 没有 time_slots 时取第一档（与上游「无时段」同形）
assert.equal(pickCodeartsCredit([{ ratio_display: '0.7x' }], undefined, Date.now()).ratio_display, '0.7x')

/* ── 倍率串 ────────────────────────────────────────────────────────────── */

const row = {
  model_id: 'deepseek-v4.1-flash',
  model_name: 'DeepSeek-V4.1-Flash',
  credit: CREDIT,
  time_slots: SLOTS,
}
assert.equal(codeartsRateLabel(row, Date.parse('2026-11-25T14:00:00Z')), 'x0.09')
assert.equal(codeartsRateLabel(row, Date.parse('2026-11-25T04:00:00Z')), 'x0.18')
// 认不出的形态 ⇒ 不显示（返回 undefined，不编造）
assert.equal(codeartsRateLabel({ credit: [{ ratio_display: '7折' }] }, Date.now()), undefined)
assert.equal(codeartsRateLabel({ credit: [] }, Date.now()), undefined)
// `0x` 是真实报价（免费），照写
assert.equal(codeartsRateLabel({ credit: [{ ratio_display: '0x' }] }, Date.now()), 'x0')

/* ── 窗口 / 介绍 ───────────────────────────────────────────────────────── */

assert.equal(codeartsContextWindowOf({ context: 202752 }), 202752)
assert.equal(codeartsContextWindowOf({ context_window: 1048576 }), 1048576)
// 只认正整数：浮点/字符串/0 一律当没有（不强转）
assert.equal(codeartsContextWindowOf({ context: 1.5 }), undefined)
assert.equal(codeartsContextWindowOf({ context: '1048576' }), undefined)
assert.equal(codeartsContextWindowOf({ context: 0 }), undefined)

assert.equal(codeartsDescriptionOf({ model_desc: '  最新旗舰模型  ' }), '最新旗舰模型')
assert.equal(codeartsDescriptionOf({ model_desc: '   ' }), undefined)
assert.equal(codeartsDescriptionOf({}), undefined)

/* ── 目录行 ────────────────────────────────────────────────────────────── */

const parsed = codeartsModelRow(row, Date.parse('2026-11-25T04:00:00Z'))
assert.equal(parsed.id, 'deepseek-v4.1-flash')
assert.equal(parsed.name, 'DeepSeek-V4.1-Flash')
assert.equal(parsed.rateLabel, 'x0.18')
assert.equal(parsed.supportsImage, false)

// 原始 id 不裁版本号：-1017 与无后缀是两个独立模型
const versioned = codeartsModelRow({ model_id: 'deepseek-v4.1-flash-1017', model_name: 'DeepSeek-V4.1-Flash-1017' })
assert.equal(versioned.id, 'deepseek-v4.1-flash-1017')
assert.equal(versioned.name, 'DeepSeek-V4.1-Flash-1017')

// VL 模型不进对话目录（大小写不敏感，与目录层同口径）
assert.equal(codeartsModelRow({ model_id: 'Qwen3-VL-235B' }), undefined)
assert.equal(codeartsModelRow({ model_id: 'kimi-k2.6-vl' }), undefined)
// 缺 model_id 直接丢弃
assert.equal(codeartsModelRow({ model_name: 'X' }), undefined)
// 缺 model_name 时用 id 作展示名（不填占位符）
assert.equal(codeartsModelRow({ model_id: 'speed' }).name, 'speed')

assert.equal(codeartsDisplayName({ name: 'GLM-5.2', rateLabel: 'x0.7' }), 'GLM-5.2 · x0.7')
assert.equal(codeartsDisplayName({ name: 'GLM-5.2' }), 'GLM-5.2')

console.log('codearts catalog OK: 32 assertions')
