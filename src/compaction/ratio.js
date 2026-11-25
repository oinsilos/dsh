import { compactionEngines, describeEngines } from './engine-registry.js'

/**
 * 阈值滑块的可用区间。
 *
 * 下限 0.2 沿用 `dsh-compaction-threshold` 的默认；但它真正能给多低取决于
 * 引擎的 `retainRatio`（保留原文的比例）：`resolveCompactSpec` 在
 * 「阈值 ≤ 保留比例」时会直接抛错，所以下限还要按引擎抬高（见 `ratioFloor`）。
 */
export const MIN_RATIO = 0.2
export const MAX_RATIO = 0.95

/**
 * "关掉自动压缩"不是一个真正的开关，而是一个比例。
 *
 * 引擎没有 `disable()`，它的触发条件是
 * `tokens >= min(window * ratio, window - reserved - headroom)`。
 * 把比例设成 1 就是「窗口用满才压缩」——在客户端视角等于本轮不主动摘要，
 * 但不会把引擎拆掉（拆掉会连带 `compaction/*` 事件、`toolResultPruner` 的
 * realm 共享一起失效，见 MERGE-PLAN §3.3）。
 */
export const OFF_RATIO = 1

/**
 * 这个公式里的 headroom 是「为输出预留的窗口」。宿主默认 65536，200K 窗口
 * 下会把有效阈值压到 ~64%，于是滑块 70% 以上全是死位。设成负一百万等于
 * 取消这一项，让 `window * ratio` 成为唯一约束。
 */
export const HEADROOM_TOKENS = -1_000_000

const DEFAULT_MAX_TOKENS = 65536

/** 引擎第一次被我们看见时的原始配置；`config` 是冻结快照，只能靠 WeakMap 记。 */
const engineBaseline = new WeakMap()

/**
 * 记下引擎的原始预算。
 *
 * `maxTokens` 必须一起记：引擎默认把它当 headroom 的别名，headroom 改成负数
 * 之后如果不复原，摘要请求的输出上限会变成 -1000000（直接截断摘要）。
 *
 * @param {object} engine
 * @returns {{maxTokens: number, ratio: number, headroomTokens: number}|undefined}
 */
export function baselineOf(engine) {
  let base = engineBaseline.get(engine)
  if (base === undefined) {
    const config = engine?.config
    if (config === undefined || config === null) return undefined
    base = {
      maxTokens: typeof config.maxTokens === 'number' && Number.isFinite(config.maxTokens)
        ? config.maxTokens : DEFAULT_MAX_TOKENS,
      ratio: typeof config.thresholdRatio === 'number' && Number.isFinite(config.thresholdRatio)
        ? config.thresholdRatio : 0.8,
      headroomTokens: typeof config.headroomTokens === 'number' && Number.isFinite(config.headroomTokens)
        ? config.headroomTokens : 0,
    }
    engineBaseline.set(engine, base)
  }
  return base
}

/** 引擎出厂（未经我们改写）的阈值；用于"跟随默认"。 */
export function defaultRatio(ctx) {
  for (const engine of compactionEngines(ctx)) {
    const base = baselineOf(engine)
    if (base !== undefined) return base.ratio
  }
  return 0.8
}

/** 用户可落盘的比例：只接受有限数，夹在 [MIN_RATIO, MAX_RATIO] 之间。 */
export function clampRatio(value) {
  const ratio = Number(value)
  if (!Number.isFinite(ratio)) return null
  if (ratio >= OFF_RATIO) return OFF_RATIO
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, Math.round(ratio * 100) / 100))
}

/**
 * 把每个活引擎指到 `ratio`。
 *
 * `config` 是 frozen 快照 ⇒ 换引用，不改字段。尚未分配 config 的引擎
 * （服务在 `super()` 里注册、构造函数还没跑完）跳过，下一次 `agent/pre-step`
 * 会补上——这也是这个函数必须在每一步都调一次的原因。
 *
 * @returns {number} 已生效的引擎数
 */
export function applyRatio(ctx, ratio) {
  const value = clampRatio(ratio)
  if (value === null) return 0
  let applied = 0
  for (const engine of compactionEngines(ctx)) {
    const config = engine.config
    if (config === undefined) continue
    const base = baselineOf(engine)
    if (base === undefined) continue
    if (config.thresholdRatio !== value
      || config.headroomTokens !== HEADROOM_TOKENS
      || config.maxTokens !== base.maxTokens) {
      engine.config = {
        ...config,
        thresholdRatio: value,
        headroomTokens: HEADROOM_TOKENS,
        maxTokens: base.maxTokens,
      }
    }
    applied += 1
  }
  return applied
}

/**
 * 把一个活引擎恢复到我们第一次看见它时的样子。
 *
 * 面板的"恢复默认"用它：不是卸载、不是重挂，只是把引用换回原值。
 */
export function restoreRatio(ctx) {
  let restored = 0
  for (const engine of compactionEngines(ctx)) {
    const base = baselineOf(engine)
    const config = engine.config
    if (base === undefined || config === undefined) continue
    engine.config = {
      ...config,
      thresholdRatio: base.ratio,
      headroomTokens: base.headroomTokens,
      maxTokens: base.maxTokens,
    }
    restored += 1
  }
  return restored
}

/**
 * 最低可用比例：固定下限之上，再让过每个引擎的 `retainRatio`。
 *
 * 不抬高的话，滑块拉到底会让引擎 `resolveCompactSpec` 抛错——
 * 表现为"压缩突然不工作了"，而不是界面上的一句提示。
 */
export function ratioFloor(ctx) {
  let floor = MIN_RATIO
  for (const engine of compactionEngines(ctx)) {
    const retained = engine?.config?.retainRatio
    if (typeof retained === 'number' && Number.isFinite(retained)) {
      floor = Math.max(floor, Math.ceil((retained + 0.01) * 100) / 100)
    }
  }
  return Math.min(floor, MAX_RATIO)
}

/**
 * 按设置应用一次压缩器配置。
 *
 * @param {object} ctx
 * @param {{enabled?: boolean, thresholdRatio?: number|null}} [settings]
 * @returns {{applied: number, enabled: boolean, ratio: number}}
 */
export function applyCompactionSettings(ctx, settings) {
  const enabled = settings?.enabled !== false
  const configured = clampRatio(settings?.thresholdRatio)
  const ratio = enabled ? (configured ?? defaultRatio(ctx)) : OFF_RATIO
  return { applied: applyRatio(ctx, ratio), enabled, ratio }
}

/**
 * 面板与 `GET /compaction` 的完整读数。
 *
 * 这里刻意把「配置值」与「引擎实际值」分开放：两个插件各写一遍 config 时，
 * 只有实际值能说明谁赢了。
 */
export function compactionStatus(ctx, settings) {
  const engines = compactionEngines(ctx)
  const facts = describeEngines(engines)
  const enabled = settings?.enabled !== false
  const configured = clampRatio(settings?.thresholdRatio)
  return {
    supported: facts.length > 0,
    engineCount: facts.length,
    enabled,
    thresholdRatio: configured ?? defaultRatio(ctx),
    followDefault: configured === null,
    floor: ratioFloor(ctx),
    min: MIN_RATIO,
    max: MAX_RATIO,
    offRatio: OFF_RATIO,
    effectiveRatio: facts[0]?.ratio ?? null,
    engines: facts,
  }
}
