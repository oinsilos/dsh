/**
 * CodeArts 模型目录的**纯函数**（倍率、上下文窗口、介绍、展示名）。
 *
 * ## 为什么单独一个模块
 *
 * 同一份目录被两处消费，而它们**不能各写一份解析**：
 * 1. 渠道包（`vendor/channel-pack/pack.js`）的 CodeArts 适配器 —— 模型选择器读它；
 * 2. 本插件的权益扩展（`src/channels/codearts.js`）—— 面板的倍率标签读它。
 *
 * 上游形态见 2026-11-25 真机取证（`/v1/model/builtin`，12 条）：
 *
 * ```json
 * {
 *   "model_id": "deepseek-v4.1-flash",
 *   "model_name": "DeepSeek-V4.1-Flash",
 *   "model_desc": "【2026/11/30 00:00（北京时间）下线】【限时体验】能力更高, 速度更快",
 *   "supports_images": true,
 *   "context": 1048576,
 *   "credit": [
 *     { "ratio": "0.05", "ratio_display": "0.18x", "time_slot_id": "default" },
 *     { "ratio": "0.05", "ratio_display": "0.09x", "time_slot_id": "off_peak", "before_display_ratio": "0.18x" }
 *   ],
 *   "time_slots": {
 *     "off_peak": { "schedule": "0 0 21 * * *", "duration": 11, "timeunit": "hour" },
 *     "default": { "schedule": null }
 *   }
 * }
 * ```
 *
 * 三条口径与 `dsh-providers-hub` 逐字对齐（`src/models.ts` / `src/llm-adapter.ts`）：
 * - **只取 `ratio_display`，不取 `ratio`** —— 两者不同量纲（0.05 是单价系数，
 *   0.18x 才是用户界面上的倍率）。
 * - **按时段选生效的那一档**，不是无脑取 `credit[0]`：错峰时段（21:00–次日 7:59）
 *   的 deepseek 是 0.09x，取 default 会显示成 0.18x。
 * - **形态转成仓内口径 `x{n}`**：上游是 `0.18x`（x 在后），本仓选择器统一 ` · x0.18`。
 *   认不出就**不显示**（宁可少显示，不可显示错数）。
 *
 * @module src/channels/codearts-catalog.js
 */

/** 视觉模型不进对话目录（与 hub 的目录层同口径、大小写不敏感）。 */
const VL_MODEL_ID = /-VL-|-VL$/i

/**
 * 判断一个 `time_slot` 此刻是否生效。
 *
 * 只认已实测的一种形态：6 段 cron（秒 分 时 日 月 周，如 `0 0 21 * * *`）
 * + `duration` + `timeunit: 'hour'`。解析不出返回 false（调用方会退回第一档）。
 * 时区硬取 Asia/Shanghai（上游明确下发 `timezone`，且用户改系统时区不该改变结果）。
 *
 * @param {object} slot
 * @param {number} nowMs
 * @returns {boolean}
 */
export function codeartsTimeSlotActive(slot, nowMs) {
  const schedule = typeof slot?.schedule === 'string' ? slot.schedule.trim() : ''
  if (schedule === '') return false
  const parts = schedule.split(/\s+/)
  if (parts.length < 3) return false
  const hour = Number(parts[2])
  const minute = Number(parts[1])
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return false
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return false
  const duration = Number(slot?.duration)
  if (!Number.isFinite(duration) || duration <= 0) return false
  // 只认小时；其他单位不臆造换算。
  if (slot?.timeunit !== 'hour') return false
  const shanghaiMinutes = Math.floor((nowMs + 8 * 3_600_000) / 60_000) % (24 * 60)
  const start = hour * 60 + minute
  const width = duration * 60
  // 窗口可跨日界（21:00 + 11h → 次日 7:59）：按 24h 取模。
  const offset = (shanghaiMinutes - start + 24 * 60) % (24 * 60)
  return offset < width
}

/**
 * 从 `credit[]` 里挑出**当前时段生效**的那一档；没有时段信息时取第一档。
 *
 * @param {unknown[]} credit
 * @param {unknown} slots
 * @param {number} nowMs
 * @returns {object|undefined}
 */
export function pickCodeartsCredit(credit, slots, nowMs) {
  const entries = Array.isArray(credit)
    ? credit.filter(row => row !== null && typeof row === 'object' && !Array.isArray(row))
    : []
  if (entries.length === 0) return undefined
  if (slots === null || typeof slots !== 'object' || Array.isArray(slots)) return entries[0]
  for (const entry of entries) {
    const slotId = entry.time_slot_id
    if (typeof slotId !== 'string') continue
    if (codeartsTimeSlotActive(slots[slotId], nowMs)) return entry
  }
  return entries[0]
}

/**
 * 单条模型 → 展示倍率（`x0.18`）。取不到 / 形态不认识 ⇒ `undefined`（不占位）。
 *
 * @param {object} row - `/v1/model/builtin` 的一行
 * @param {number} [nowMs]
 * @returns {string|undefined}
 */
export function codeartsRateLabel(row, nowMs = Date.now()) {
  const credit = Array.isArray(row?.credit) ? row.credit : []
  if (credit.length === 0) return undefined
  const picked = pickCodeartsCredit(credit, row?.time_slots ?? row?.timeSlots, nowMs)
  const display = picked?.ratio_display
  if (typeof display !== 'string' || display === '') return undefined
  const match = /^\s*(\d+(?:\.\d+)?)\s*x\s*$/i.exec(display)
  return match === null ? undefined : `x${match[1]}`
}

/**
 * 单条模型的上下文窗口。
 *
 * 2026-11-25 真机：`/v1/model/builtin` 已直接下发 `context`（GLM-5.2=202752、
 * openpangu=524288、glm-5.3/deepseek/kimi=1048576）；旧的 `context_window`
 * 键形也认。只认正整数 —— 字符串/浮点/0 一律当没有（不强转，绝不臆造）。
 *
 * @param {object} row
 * @returns {number|undefined}
 */
export function codeartsContextWindowOf(row) {
  const value = row?.context ?? row?.context_window ?? row?.contextWindow
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined
}

/**
 * 单条模型的介绍（`model_desc` 原样，仅 trim 两端空白；空/零宽 ⇒ 不落键）。
 *
 * @param {object} row
 * @returns {string|undefined}
 */
export function codeartsDescriptionOf(row) {
  const raw = row?.model_desc
  if (typeof raw !== 'string') return undefined
  const text = raw.trim()
  return text === '' ? undefined : text
}

/**
 * `/v1/model/builtin`（或 gateway/config）的一行 → 目录条目。
 *
 * ⚠️ **id 用原始 `model_id`，不裁日期后缀**：上游把
 * `deepseek-v4.1-flash` 与 `deepseek-v4.1-flash-1017` 当成两个独立模型同时下发，
 * 裁掉后缀会静默吞掉新版（hub 2026-10-27 的报障正是这个）。
 *
 * @param {object} row
 * @param {number} [nowMs]
 * @returns {{id: string, name: string, rateLabel?: string, description?: string, contextWindow?: number, supportsImage: boolean}|undefined}
 */
export function codeartsModelRow(row, nowMs = Date.now()) {
  const rawId = typeof row?.model_id === 'string' ? row.model_id.trim() : ''
  if (rawId === '' || VL_MODEL_ID.test(rawId)) return undefined
  const rawName = typeof row?.model_name === 'string' ? row.model_name.trim() : ''
  const rateLabel = codeartsRateLabel(row, nowMs)
  const description = codeartsDescriptionOf(row)
  const contextWindow = codeartsContextWindowOf(row)
  return {
    id: rawId,
    name: rawName === '' ? rawId : rawName,
    ...rateLabel === undefined ? {} : { rateLabel },
    ...description === undefined ? {} : { description },
    ...contextWindow === undefined ? {} : { contextWindow },
    supportsImage: row?.supports_images === true,
  }
}

/**
 * 选择器里的展示名：`GLM-5.2 · x0.7`。
 *
 * ⚠️ 倍率**必须**拼进 `name`：宿主的选择器只渲染 `name`（`description` 只在
 * `/model` 弹窗里出现）。`resolveModel` 仍然用裸名（由调用方传入 `model.name`），
 * 避免会话记录被价格污染。
 *
 * @param {{name: string, rateLabel?: string}} model
 * @returns {string}
 */
export function codeartsDisplayName(model) {
  return model.rateLabel === undefined ? model.name : `${model.name} · ${model.rateLabel}`
}
