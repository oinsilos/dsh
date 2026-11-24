/**
 * Qoder 远端模型目录的**纯解析**（`/api/v2/model/list?Encode=1` 的响应 → 兜底表同形）。
 *
 * ## 为什么单独一个模块
 *
 * 抓取（WASM 签名 + 解密）只能留在渠道包里（它持有 `QoderEncryptedInfer`），
 * 但**解析**是纯函数：抽出来才能被离线测试钉住（上游字段全是可变的，
 * 尤其是 `thinking_config` 的三种形态与 `context_config` 的档位表）。
 *
 * ## 协议事实（2026-11-25 取自 dsh-providers-hub 的真机实测）
 *
 * - 端点 `GET {encryptedInferBase}/api/v2/model/list?Encode=1`，头由 WASM 生成；
 * - 响应是 **`{场景: [模型…]}`**，必须并 `chat` ∪ `app` —— `lmodel`（QoDuck）
 *   只发布在 `app` 场景；**只读 `chat` 会结构性地看不见它**；
 * - 必须按 id 去重：DSH 的 `listModels` 遇到重复 id 会抛 `INVALID_CATALOG`，
 *   整个 provider 从选择器里消失；
 * - 窗口取 `context_config` 的**最大档**，**不取** `max_input_tokens`（两者经常
 *   自相矛盾，而官方客户端只认档位表）。
 *
 * @module src/channels/qoder-catalog.js
 */

/** 目录响应的场景键，按优先级降序（前面的赢）。 */
export const QODER_CATALOG_SCENES = ['chat', 'app']

/** 官方档位白名单（客户端常量 `k3`）：白名单外的键会被官方静默丢弃。 */
const EFFORT_WHITELIST = new Set(['none', 'low', 'medium', 'high', 'xhigh', 'max'])

function readString(source, key) {
  const value = source?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readNumber(source, key) {
  const value = source?.[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function asRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

function normalizeEffort(raw) {
  const key = String(raw).trim().toLowerCase()
  const aliased = key === 'disabled' || key === 'off' ? 'none' : key
  return EFFORT_WHITELIST.has(aliased) ? aliased : undefined
}

/** 档位三形态都认（数组 / 逗号串 / 对象），与官方 `sgi()` 逐格对齐。 */
function parseEfforts(value) {
  const dedupe = raw => {
    const out = []
    const seen = new Set()
    for (const item of raw) {
      const key = typeof item === 'string' ? normalizeEffort(item) : undefined
      if (key === undefined || seen.has(key)) continue
      seen.add(key)
      out.push(key)
    }
    return out
  }
  if (Array.isArray(value)) return { efforts: dedupe(value) }
  if (typeof value === 'string') return { efforts: dedupe(value.split(/[,\s]+/)) }
  const record = asRecord(value)
  if (record === undefined) return { efforts: [] }
  const efforts = []
  const seen = new Set()
  let defaultEffort
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = normalizeEffort(rawKey)
    if (key === undefined || seen.has(key)) continue
    seen.add(key)
    efforts.push(key)
    const flag = asRecord(rawValue)
    if (flag?.is_default === true || flag?.isDefault === true) defaultEffort = key
  }
  return defaultEffort === undefined ? { efforts } : { efforts, defaultEffort }
}

function hasDisabledBranch(block) {
  if (block === undefined) return false
  return block.disabled !== undefined && block.disabled !== null && block.disabled !== false
}

function effortsFromEntry(entry) {
  const top = parseEfforts(entry.efforts)
  if (top.efforts.length > 0) return top
  for (const blockKey of ['thinking_config', 'thinkingConfig']) {
    const block = asRecord(entry[blockKey])
    if (block === undefined) continue
    const direct = parseEfforts(block.efforts)
    if (direct.efforts.length > 0) return direct
    for (const enabledKey of ['enabled', 'enabledConfig']) {
      const enabled = asRecord(block[enabledKey])
      if (enabled === undefined) continue
      const nested = parseEfforts(enabled.efforts)
      if (nested.efforts.length > 0) return nested
    }
  }
  return { efforts: [] }
}

/** 思考档位与「能否关闭思考」（四条口径逐条对齐官方 `R3()` / `Mhc()` / `vhc()`）。 */
function parseThinking(entry) {
  let ownDisabled = false
  for (const blockKey of ['thinking_config', 'thinkingConfig']) {
    if (hasDisabledBranch(asRecord(entry[blockKey]))) ownDisabled = true
  }
  let parsed = effortsFromEntry(entry)
  let sourceDisabled = ownDisabled
  if (parsed.efforts.length === 0 && !ownDisabled) {
    // ⚠ `available_reasoning_effort` 是**一个 thinking_config 对象**，不是档位表：
    //   直接当档位表解析只会拿到 enabled/disabled 两个键（全被白名单丢掉）。
    const alt = asRecord(entry.available_reasoning_effort ?? entry.availableReasoningEffort)
    if (alt !== undefined) {
      parsed = effortsFromEntry({ thinking_config: alt })
      if (hasDisabledBranch(alt)) sourceDisabled = true
    }
  }
  let supportsDisable = sourceDisabled
  if (entry.supports_disabled === true || entry.supportsDisabled === true) supportsDisable = true
  if (parsed.defaultEffort === undefined) {
    const top = entry.default_effort ?? entry.defaultEffort
    if (typeof top === 'string') {
      const normalized = normalizeEffort(top)
      if (normalized !== undefined) parsed = { ...parsed, defaultEffort: normalized }
    }
  }
  return { ...parsed, supportsDisable }
}

/** 窗口取档位表的**最大档**（不取 `max_input_tokens`：两者经常自相矛盾）。 */
function remoteContextWindow(entry) {
  const maxOf = values => {
    let max = 0
    for (const value of values) {
      const token = typeof value === 'object' && value !== null ? readNumber(value, 'token_count') : typeof value === 'number' ? value : undefined
      if (token !== undefined && token > max) max = token
    }
    return max
  }
  const config = asRecord(entry.context_config)
  if (config !== undefined) {
    const max = maxOf(Object.values(config))
    if (max > 0) return max
  }
  const windows = entry.available_context_windows ?? entry.availableContextWindows
  if (Array.isArray(windows)) {
    const max = maxOf(windows)
    if (max > 0) return max
  }
  return 0
}

/** 错峰折扣（`active` 只是下发快照，展示时按 windowStart/End 本地推算）。 */
function parsePromotion(raw) {
  const record = asRecord(raw)
  if (record === undefined) return undefined
  const discountFactor = readNumber(record, 'discount_factor')
  const beforePromotionPriceFactor = readNumber(record, 'before_promotion_price_factor')
  const windowStart = readString(record, 'window_start')
  const windowEnd = readString(record, 'window_end')
  if (discountFactor === undefined && beforePromotionPriceFactor === undefined && windowStart === undefined && windowEnd === undefined) {
    return undefined
  }
  const badge = asRecord(record.badge)
  return {
    active: record.active === true,
    ...discountFactor === undefined ? {} : { discountFactor },
    ...beforePromotionPriceFactor === undefined ? {} : { beforePromotionPriceFactor },
    ...windowStart === undefined ? {} : { windowStart },
    ...windowEnd === undefined ? {} : { windowEnd },
    ...typeof badge?.zh === 'string' ? { badgeZh: badge.zh } : {},
  }
}

/** 远端条目 → 兜底表同形（展示/档位/能力链路完全复用，避免两套判据）。 */
export function qoderRemoteModelToFallback(raw) {
  const entry = asRecord(raw)
  if (entry === undefined || entry.enable === false) return undefined
  const id = readString(entry, 'key') ?? readString(entry, 'model_key')
  const name = readString(entry, 'display_name')
  if (id === undefined || name === undefined) return undefined
  const priceFactor = readNumber(entry, 'price_factor')
  const originalPriceFactor = readNumber(entry, 'original_price_factor')
  const promotion = parsePromotion(entry.promotion)
  const thinking = parseThinking(entry)
  const contextWindow = remoteContextWindow(entry)
  return {
    id,
    name,
    ...contextWindow > 0 ? { contextWindow } : {},
    supportsImage: entry.is_vl === true,
    supportsThinking: entry.is_reasoning === true,
    ...entry.is_free === true ? { isFree: true } : {},
    ...priceFactor === undefined ? {} : { priceFactor },
    ...originalPriceFactor === undefined ? {} : { originalPriceFactor },
    ...promotion === undefined ? {} : { promotion },
    ...thinking.efforts.length === 0 ? {} : { efforts: thinking.efforts },
    ...thinking.defaultEffort === undefined ? {} : { defaultEffort: thinking.defaultEffort },
    ...thinking.supportsDisable ? { supportsDisable: true } : {},
  }
}

/**
 * 解析目录响应（多场景合并 + 去重）。
 *
 * @returns 模型数组；**一个场景都不是数组**时返回 `undefined`（协议变了）。
 *   与「上游真的没给模型」严格区分 —— 后者返回空数组。
 */
export function qoderParseRemoteModels(body) {
  const record = asRecord(body)
  if (record === undefined) return undefined
  const models = []
  const seen = new Set()
  let found = false
  for (const scene of QODER_CATALOG_SCENES) {
    const list = record[scene]
    if (!Array.isArray(list)) continue
    found = true
    for (const raw of list) {
      const model = qoderRemoteModelToFallback(raw)
      if (model === undefined || seen.has(model.id)) continue
      seen.add(model.id)
      models.push(model)
    }
  }
  return found ? models : undefined
}
