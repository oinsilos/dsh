/**
 * Reasoning-effort policy.
 *
 * A live probe of this lane (2026-09-24) settled the design: the gateway accepts
 * `reasoning_effort`, `thinking.budget_tokens`, `enable_thinking` and
 * `thinking_budget` and then ignores all of them — three samples per spelling
 * showed `low` producing *more* reasoning tokens than `xhigh`, and the unknown
 * fields occasionally surfaced as an upstream 503. The single control the pooled
 * account actually enforces is `max_tokens`, and reasoning volume tracks it
 * directly (a 64-token ceiling pulled reasoning from ~397 tokens down to ~63).
 *
 * So an effort level here is a real, enforced generation budget rather than a
 * hint. Every declared level therefore changes measured behaviour; a level that
 * could not be enforced would not be declared, because an effort menu that does
 * nothing is worse to a user than no effort menu at all.
 *
 * Because the ceiling is shared by thinking and the visible answer, a lower
 * level shortens both — that is the only modulation this lane offers, and it is
 * why the levels are stated as token budgets rather than as vague adjectives.
 *
 * A model whose thinking cannot be switched off pays for it out of the same
 * ceiling before the answer starts, so every rung of its ladder is doubled: one
 * rung then leaves the answer about as much room as it has on a model that can
 * think nothing at all. Measured on `mimo-v2.6-flash-free` over the 92 calls of
 * one day: 82% of the output tokens were reasoning, so the un-doubled 8192
 * ceiling left roughly 1500 for the answer and a long turn ended in `length`
 * about every third request.
 *
 * @module src/effort.js
 */

/** Ordered for display: the array order is the picker's order. */
export const LEVELS = [
  { id: 'light', name: 'Light', zh: '精简', ceiling: 2048, hint: 'terse deliberation, the fastest answer here.' },
  { id: 'balanced', name: 'Balanced', zh: '均衡', ceiling: 8192, hint: 'enough to reason through a normal turn.' },
  { id: 'deep', name: 'Deep', zh: '深思', ceiling: undefined, hint: 'the model\'s full output capacity, extended deliberation.' },
]

export const DEFAULT_LEVEL = 'balanced'

/** Rungs of a model that must think are widened by this factor; see the module note. */
export const ALWAYS_THINKING_FACTOR = 2

/** Does this model expose an effort menu at all? */
export function supportsEffort(model) {
  return model?.reasoning === true
}

/**
 * The rung in force for one call, resolved the same way for the budget sent
 * upstream and the effort recorded against it.
 *
 * A model with no effort menu has no rung: its whole output window belongs to the
 * answer, and a level inherited from elsewhere must not shrink it. A model with a
 * menu that the caller did not answer with a level still gets the menu's default.
 * The two each failed differently before: a no-menu model inherited `balanced`
 * and had its window cut by a rung it never offered, while a menu model with no
 * rung sent the full capacity and *logged* the default — so the dashboard showed
 * 均衡 next to a 32K generation that 均衡 had never promised.
 *
 * @param {string|undefined} level - effort id from the harness, when it sent one
 * @param {object} model - catalog entry
 * @returns {object|undefined} the declared level, or undefined when none applies
 */
export function resolveLevel(level, model) {
  // A menu model's recorded effort is the level the wire actually carries —
  // resolving 'high' onto the free ladder's nearest rung logged 均衡 next to a
  // generation the model delivered at High.
  if (hasDeclaredEffortMenu(model)) {
    const chosen = model.efforts.includes(level) ? level : eacDefaultLevel(model)
    return { id: chosen }
  }
  if (!supportsEffort(model)) return undefined
  return LEVELS.find(candidate => candidate.id === level)
    ?? LEVELS.find(candidate => candidate.id === DEFAULT_LEVEL)
}

/** The ceiling one rung carries on one model, before capacity is applied. */
function ceilingOf(entry, model) {
  if (entry === undefined || entry.ceiling === undefined) return undefined
  return model?.canDisableThinking === false ? entry.ceiling * ALWAYS_THINKING_FACTOR : entry.ceiling
}

/**
 * Resolve the generation ceiling for one level against one model.
 *
 * The level ceiling is the controlling term; the model's own capacity and the
 * session's request can only lower it further, never raise it. A level with no
 * ceiling inherits the model capacity, which is why "Deep" is the top row.
 *
 * @param {string|undefined} level - the effort id the harness selected
 * @param {object} model - catalog entry, supplying `maxOutput`
 * @param {number|undefined} requested - the session's maxTokens, when it set one
 * @param {number|undefined} fallback - the plugin default ceiling
 * @returns {number} tokens
 */
export function budgetFor(level, model, requested, fallback) {
  // A ceiling that is not a positive number is *no* ceiling. Without this, the
  // settings page's own cleared input — `Number('') || 0` — reached the wire as
  // `min(model capacity, 0)`, and every turn of every model silently came back
  // clamped to `MIN_BUDGET`.
  const capacity = Math.min(
    model?.maxOutput ?? 32768,
    usableTokens(requested),
    usableTokens(fallback),
  )
  // A model with a declared thinking menu has its level as the real control on
  // the wire (an effort field the gateway forwards), so its ceiling is the
  // model capacity regardless of level — a ladder here would cut answers for a
  // menu that never promised to. Both absorbed channels declare menus; the
  // free lane's own ladder is the budget semantics below.
  if (hasDeclaredEffortMenu(model)) return Math.max(MIN_BUDGET, Math.trunc(capacity))
  const ceiling = ceilingOf(resolveLevel(level, model), model)
  if (ceiling === undefined) return Math.max(MIN_BUDGET, Math.trunc(capacity))
  return Math.max(MIN_BUDGET, Math.trunc(Math.min(ceiling, capacity)))
}

/** A caller-supplied token ceiling, or "none" when it is not a positive number. */
function usableTokens(value) {
  return Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY
}

/** Below this the answer itself cannot land, so no level is allowed to go. */
export const MIN_BUDGET = 512

/**
 * The whole ladder as it applies to one model right now, for anything that has
 * to show the user the number that will actually go out on the wire.
 *
 * @param {object} model - catalog entry
 * @param {number|undefined} requested - the session's maxTokens, when it set one
 * @param {number|undefined} fallback - the plugin default ceiling
 * @returns {Array<{id: string, name: string, tokens: number, isDefault: boolean}>}
 */
export function budgetLadder(model, requested, fallback) {
  return LEVELS.map(entry => ({
    id: entry.id,
    name: entry.name,
    tokens: budgetFor(entry.id, model, requested, fallback),
    isDefault: entry.id === DEFAULT_LEVEL,
  }))
}

/**
 * Deep-clone a declared patch and substitute the selected level for `$effort`.
 *
 * The patch is a plain JSON object (ZCode's declaration shape); `$effort` is
 * the placeholder the selected thinking level stands in for. A patch with no
 * placeholder is emitted as-is (the off patch), so a level whose mapping does
 * not name the level itself is expressible.
 */
function instantiatePatch(patch, effort) {
  const walk = value => {
    if (typeof value === 'string') return value === '$effort' ? effort : value
    if (Array.isArray(value)) return value.map(walk)
    if (value !== null && typeof value === 'object') {
      const out = {}
      for (const [key, inner] of Object.entries(value)) out[key] = walk(inner)
      return out
    }
    return value
  }
  return walk(patch)
}

/**
 * The thinking menu a model declares in ZCode's shape.
 *
 * These models are not budget-driven: the gateway takes the level itself as
 * the control (a JSON merge patch on the request body), so the menu is the
 * model's own level list rather than the free lane's token ladder.
 *
 * @param {object} model - catalog entry carrying `efforts`/`effortDefault`
 * @returns {Array<{id:string, name:string, description:string}>|undefined}
 */
function declaredEffortsFor(model) {
  const levels = Array.isArray(model?.efforts) ? model.efforts : undefined
  if (levels === undefined || levels.length === 0) return undefined
  const names = { disabled: 'Off', low: 'Low', medium: 'Medium', high: 'High', max: 'Max' }
  return levels.map(id => ({
    id,
    name: names[id] ?? id,
    description: id === 'disabled'
      ? 'thinking switched off for this turn; the answer alone'
      : `thinking level "${id}", sent to the gateway as this model's own effort field`,
  }))
}

/** The declared default level id for a menu model, or its first level. */
export function eacDefaultLevel(model) {
  const levels = Array.isArray(model?.efforts) ? model.efforts : []
  if (levels.length === 0) return undefined
  return levels.includes(model.effortDefault) ? model.effortDefault : levels[0]
}

/**
 * The request-body patch a co-paid-lane level turns into, or null when the
 * model declares no thinking menu at all.
 *
 * @param {string|undefined} level - the effort id the harness selected
 * @param {object} model - catalog entry
 * @returns {object|null}
 */
export function effortPatchFor(level, model) {
  if (!Array.isArray(model?.efforts) || model.efforts.length === 0) return null
  const chosen = model.efforts.includes(level) ? level : eacDefaultLevel(model)
  if (chosen === 'disabled' && model.effortOffPatch !== undefined) {
    return instantiatePatch(model.effortOffPatch, chosen)
  }
  if (model.effortPatch === undefined) return null
  return instantiatePatch(model.effortPatch, chosen)
}

/** Does this entry carry a declared thinking menu (its own effort field is
 *  the control on the wire)? Both absorbed channels' entries do; the free
 *  lane's never do, so its entries keep the token-ladder semantics. */
export function hasDeclaredEffortMenu(model) {
  return Array.isArray(model?.efforts) && model.efforts.length > 0
}

/**
 * The declared effort list for one model, in picker order.
 *
 * Two producers, two shapes: the free lane declares a token ladder (see the
 * module note on why a level there is an enforced generation budget), while a
 * model with a declared menu offers its own levels, which the gateway honours
 * as an effort field (see {@link declaredEffortsFor}).
 *
 * The description is generated from the same `budgetFor`/patch call that will
 * decide the request, not written next to it. A rung that advertises 8K while
 * the plugin sends 16 384 on a thinking-always-on model is the same defect
 * issue #2 reported for the settings page — a number the user reads and the
 * wire does not honour — so this cannot carry a per-level constant.
 *
 * @param {object} model - catalog entry
 * @param {number|undefined} requested - the session's maxTokens, when it set one
 * @param {number|undefined} fallback - the plugin default ceiling
 * @returns {Array<{id:string, name:string, description:string}>|undefined}
 */
/**
 * The effort id the harness should treat as this model's default.
 *
 * The free lane's ladder always has `balanced`; the co-paid lane's menu is
 * the model's own declaration, whose default is not `balanced` — reporting the
 * free lane's id for a sealed model made the harness reject the whole roster
 * ("adapter returned an unknown default reasoning effort").
 */
export function defaultEffortFor(model) {
  if (hasDeclaredEffortMenu(model)) return eacDefaultLevel(model) ?? DEFAULT_LEVEL
  return DEFAULT_LEVEL
}

export function effortsFor(model, requested, fallback) {
  if (hasDeclaredEffortMenu(model)) return declaredEffortsFor(model)
  if (!supportsEffort(model)) return undefined
  return budgetLadder(model, requested, fallback).map(row => ({
    id: row.id,
    name: row.name,
    description: `${kilos(row.tokens)} output ceiling, shared by thinking and the answer`
      + (model.canDisableThinking === false ? ' (thinking cannot be switched off on this model)' : '')
      + `: ${LEVELS.find(level => level.id === row.id)?.hint ?? ''}`,
  }))
}

/**
 * 思考强度的跨来源归一。
 *
 * 从 model-failover-manager 迁过来的分组，成员档位是用它自己的词汇存的
 * （`low` / `medium` / `high` / `xhigh` / `max` / `extra_high`，界面上写
 * "默认（最低）/ 默认（高）/ Extra High"）；本插件的两条车道各有自己的 id
 * （免费车道 `light/balanced/deep`，自带菜单的渠道用模型声明的那一组）。
 *
 * 直接把这些词交给 `resolveLevel` 不会报错——它落回默认档，于是用户以为设了
 * xhigh、实际跑的是 balanced，这正是"思考强度不生效"的来源。这里显式翻译
 * 到当前模型真实认的那一档；翻译不到就返回空串（跟随会话），由面板把这件事
 * 说出来，而不是静默降级。
 *
 * @param {object} model - catalog entry（决定可用档位）
 * @param {string|undefined} value - 旧词汇或本插件的 id
 * @returns {string} 模型自己的档位 id；'' = 跟随会话
 */
export function normalizeEffort(model, value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase().replace(/\s+/g, '_') : ''
  const menu = hasDeclaredEffortMenu(model)
    ? model.efforts.map(id => String(id).toLowerCase())
    : supportsEffort(model) ? LEVELS.map(level => level.id) : []
  if (menu.length === 0) return ''
  // 旧面板把档位显示成「强度：默认（高）」「Extra High」这类标签，迁移数据里
  // 可能整串存下来。先用整串匹配，再用中文提示词兜一次。
  const hint = effortHintOf(raw)
  for (const candidate of [raw, hint]) {
    if (candidate === '' || candidate === 'default' || candidate === 'auto' || candidate === 'follow' || candidate === 'session') continue
    if (menu.includes(candidate)) return candidate
    for (const rule of EFFORT_ALIASES) {
      if (!rule.ids.includes(candidate) && !rule.alias.includes(candidate)) continue
      for (const id of rule.ids) if (menu.includes(id)) return id
      // 最高档在只有三档的车道上没有同名词：退到该车道最高的一档。关思考
      // 这一档没有这种退法，翻不到就是翻不到。
      if (rule.ids[0] === 'max') return menu[menu.length - 1]
    }
  }
  if (raw === '' || raw === 'default' || raw === 'auto' || raw === 'follow' || raw === 'session') return ''
  return ''
}

/** 中文/英文标签里的强弱提示词 → 通用档位名；认不出来返回 ''。 */
function effortHintOf(raw) {
  if (raw === '') return ''
  if (raw.includes('关')) return 'disabled'
  if (raw.includes('最高') || raw.includes('极高') || raw.includes('extra')) return 'max'
  if (raw.includes('高')) return 'high'
  if (raw.includes('中')) return 'medium'
  if (raw.includes('低')) return 'low'
  return ''
}

/** 旧插件词汇 → 本插件档位。顺序即「优先取哪一个同义档」。 */
const EFFORT_ALIASES = Object.freeze([
  { ids: ['disabled', 'off', 'none'], alias: ['disabled', 'off', 'none', '关闭'] },
  { ids: ['light', 'low', 'min', 'minimal', 'lowest'], alias: ['light', 'low', 'min', 'minimal', 'lowest', '最低', '精简'] },
  { ids: ['balanced', 'medium', 'med', 'normal'], alias: ['balanced', 'medium', 'med', 'normal', '中', '均衡'] },
  { ids: ['deep', 'high', 'higher'], alias: ['deep', 'high', 'higher', '高', '深思'] },
  { ids: ['max', 'xhigh', 'extra_high', 'extrahigh', 'extra-high', 'ultra', 'maximum', 'highest'], alias: ['max', 'xhigh', 'extra_high', 'extrahigh', 'extra-high', 'ultra', 'maximum', 'highest', '最高', '极高'] },
])

/** 16384 -> `16 K`, the spelling the settings page and the README both use. */
function kilos(tokens) {
  return `${Math.round(tokens / 1024)} K`
}
