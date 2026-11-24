/**
 * Qoder 远端目录解析测试（离线）。
 *
 * 钉住 2026-11-25 从 `dsh-providers-hub` 真机实测搬来的四条协议事实：
 * 1. 响应是 `{场景: [模型…]}`，**必须并 `app`** —— `lmodel`（QoDuck）只在 app 场景；
 * 2. 必须按 id **去重**（DSH 对重复 id 抛 `INVALID_CATALOG`，整个 provider 会消失）；
 * 3. 窗口取 `context_config` 的**最大档**，**不取** `max_input_tokens`；
 * 4. 档位三形态（数组 / 逗号串 / 对象）+ 白名单（白名单外的键官方会静默丢弃）。
 */

import assert from 'node:assert/strict'
import {
  QODER_CATALOG_SCENES,
  qoderRemoteModelToFallback,
  qoderParseRemoteModels,
} from '../src/channels/qoder-catalog.js'

/* ── 条目 → 兜底表同形 ─────────────────────────────────────────────────── */

const qwen4 = {
  key: 'qmodel_latest',
  display_name: 'Qwen4-Max',
  price_factor: 0.4,
  original_price_factor: 0.5,
  is_vl: true,
  is_reasoning: true,
  context_config: {
    fast: { token_count: 200000 },
    balanced: { token_count: 1000000 },
  },
  max_input_tokens: 180000,
  thinking_config: {
    enabled: {
      efforts: {
        low: {},
        high: { is_default: true },
        xhigh: {},
        minimal: {},
      },
    },
    disabled: {},
  },
  promotion: {
    active: false,
    discount_factor: 0.4,
    before_promotion_price_factor: 0.5,
    window_start: '22:00',
    window_end: '08:00',
    badge: { zh: '错峰 4 折', en: 'Off-peak 40%' },
  },
}
const parsed = qoderRemoteModelToFallback(qwen4)
assert.equal(parsed.id, 'qmodel_latest')
assert.equal(parsed.name, 'Qwen4-Max')
// 窗口 = 档位表最大档（1M），不是 max_input_tokens（180k）
assert.equal(parsed.contextWindow, 1_000_000)
assert.equal(parsed.priceFactor, 0.4)
assert.equal(parsed.originalPriceFactor, 0.5)
assert.equal(parsed.supportsImage, true)
assert.equal(parsed.supportsThinking, true)
assert.deepEqual(parsed.efforts, ['low', 'high', 'xhigh'], '白名单丢掉 minimal，顺序保持上游键序')
assert.equal(parsed.defaultEffort, 'high')
assert.equal(parsed.supportsDisable, true)
assert.equal(parsed.promotion.discountFactor, 0.4)
assert.equal(parsed.promotion.windowStart, '22:00')
assert.equal(parsed.promotion.badgeZh, '错峰 4 折')

// 免费模型：price_factor 0 + is_free
const free = qoderRemoteModelToFallback({ key: 'dfmodel', display_name: 'DeepSeek-Flash', price_factor: 0, is_free: true })
assert.equal(free.priceFactor, 0)
assert.equal(free.isFree, true)

// 已停用 / 缺 key / 缺 display_name 都丢弃
assert.equal(qoderRemoteModelToFallback({ ...qwen4, enable: false }), undefined)
assert.equal(qoderRemoteModelToFallback({ display_name: 'X' }), undefined)
assert.equal(qoderRemoteModelToFallback({ key: 'x' }), undefined)
assert.equal(qoderRemoteModelToFallback(null), undefined)

// 档位形态二：数组
const arr = qoderRemoteModelToFallback({ key: 'a', display_name: 'A', efforts: ['low', 'HIGH', 'off', 'nope'] })
assert.deepEqual(arr.efforts, ['low', 'high', 'none'])
// 档位形态三：逗号串
const str = qoderRemoteModelToFallback({ key: 'b', display_name: 'B', efforts: 'low, medium max' })
assert.deepEqual(str.efforts, ['low', 'medium', 'max'])
// 档位对象形态（thinking_config.efforts 直接是对象）
const obj = qoderRemoteModelToFallback({ key: 'c', display_name: 'C', thinking_config: { efforts: { low: {}, max: { isDefault: true } } } })
assert.deepEqual(obj.efforts, ['low', 'max'])
assert.equal(obj.defaultEffort, 'max')
// available_reasoning_effort 是「一个 thinking_config 对象」，必须包一层再解析
const alt = qoderRemoteModelToFallback({ key: 'd', display_name: 'D', available_reasoning_effort: { enabled: { efforts: { medium: {}, high: {} } }, disabled: null } })
assert.deepEqual(alt.efforts, ['medium', 'high'])
assert.ok(alt.supportsDisable !== true, 'disabled 为 null 不算「可关闭」')

/* ── 多场景合并 / 去重 ─────────────────────────────────────────────────── */

assert.deepEqual(QODER_CATALOG_SCENES, ['chat', 'app'], '必须并 app（lmodel 只在 app）')

const body = {
  chat: [
    { key: 'qmodel_latest', display_name: 'Qwen4-Max', price_factor: 0.4 },
  ],
  app: [
    { key: 'lmodel', display_name: 'QoDuck', price_factor: 0, is_free: true },
    { key: 'qmodel_latest', display_name: 'Qwen4-Max（重复）' },
    { key: 'dfmodel', display_name: 'DeepSeek-Flash', price_factor: 0.1 },
  ],
  developer: [{ key: 'x', display_name: 'X' }],
}
const merged = qoderParseRemoteModels(body)
assert.deepEqual(merged.map(row => row.id), ['qmodel_latest', 'lmodel', 'dfmodel'], 'chat 优先、app 补 lmodel、跨场景去重')
assert.equal(merged[0].name, 'Qwen4-Max', '重复 id 保留先出现的（chat）')
assert.equal(merged[1].isFree, true)

// 协议变更（一个场景都不是数组）返回 undefined；空数组是「上游真没模型」
assert.equal(qoderParseRemoteModels({ developer: [] }), undefined)
assert.equal(qoderParseRemoteModels(null), undefined)
assert.deepEqual(qoderParseRemoteModels({ chat: [] }), [])

console.log('qoder catalog OK: 34 assertions')
