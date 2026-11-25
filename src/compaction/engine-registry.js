/**
 * 活着（已挂载）的上下文压缩引擎清单。
 *
 * ## 为什么必须这样摸
 *
 * 宿主的 `compaction-basic` 不在 profile 的插件树里，而是挂在**每个 agent
 * preset 的 `compaction` 隔离组**（`isolate: compaction: true`）。隔离 realm
 * 会让常规的 `ctx.get('compaction')` 看不到它，所以插件配置里写
 * `thresholdRatio` 是无效的（实测记录见 docs/MERGE-PLAN.md §3.1）。
 *
 * 唯一稳定的入口是 fiber 的 **provisions**（以及旧运行时的 raw store）：
 * 注册表遍历不受 realm 影响，`fiber.provisions` 里 `name === 'compaction'`
 * 的那条 `Impl.value` 就是引擎实例。宿主版本不同时字段位置也不同：有的把
 * `Impl` 放在 `fiber.store.compaction`，有的放在 `fiber._store` / `fiber.committed`；
 * 三种都摸一遍，取到实例就停。
 * 一个 preset 一份 fiber ⇒ 一台机器上可能同时有多份引擎，必须全部改，
 * 否则只有当前会话的 preset 生效，换个 preset 就"滑块失灵"。
 *
 * 已 dispose 的 fiber 会把 provisions 清空，可选链天然吸收。
 *
 * @param {object} ctx - `apply` 收到的上下文
 * @returns {object[]} 引擎实例（去重）
 */
export function compactionEngines(ctx) {
  const found = []
  const registry = ctx?.registry
  if (registry === undefined || typeof registry.values !== 'function') return found
  const take = candidate => {
    // 有的版本存 `Impl`（`.value` 是实例），有的版本直接存实例。
    const engine = candidate?.value ?? candidate
    if (engine === null || typeof engine !== 'object') return
    if (typeof engine.compactIfNeeded !== 'function' && typeof engine.config !== 'object') return
    if (found.includes(engine)) return
    found.push(engine)
  }
  for (const runtime of registry.values()) {
    const fibers = runtime?.fibers
    if (fibers === undefined) continue
    for (const fiber of fibers) {
      // 当前 Cordis：服务实现挂在 fiber.provisions（隔离 realm 也在其中）。
      for (const impl of fiber?.provisions ?? []) {
        if (impl?.name === 'compaction') take(impl)
      }
      // 兼容旧 Cordis / 旧插件的摸法：raw store（公开或私有字段）。
      for (const store of [fiber?.store, fiber?._store, fiber?.committed]) {
        if (store === undefined || store === null) continue
        take(store.compaction)
      }
    }
  }
  return found
}

/**
 * 每台引擎的可读快照，只用于面板展示与诊断日志。
 *
 * `config` 是冻结快照，所以这里只读不写；写路径在 `ratio.js`。
 *
 * @param {object[]} engines
 * @returns {Array<{index: number, ratio: number, retainRatio: number, maxTokens: number, headroomTokens: number, contextWindow: number}>}
 */
export function describeEngines(engines) {
  return engines.map((engine, index) => {
    const config = engine?.config ?? {}
    return {
      index,
      ratio: finiteOr(config.thresholdRatio, 0),
      retainRatio: finiteOr(config.retainRatio, 0),
      maxTokens: finiteOr(config.maxTokens, 0),
      headroomTokens: finiteOr(config.headroomTokens, 0),
      contextWindow: finiteOr(config.contextWindow, 0),
    }
  })
}

function finiteOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
