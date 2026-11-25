/**
 * 按模型的并发闸门。
 *
 * `model-failover-manager` 的 `defaultConcurrency: 3` 语义是"每个模型最多三个
 * 在飞请求，第四个不排队、直接换组内下一个空闲模型"。这里照搬，但把状态放在
 * 进程内 Map 里：它只服务"这一刻该发给谁"，不需要跨重启。
 *
 * 两个维度分开：
 * - `inflight`：现在有几个请求在这个模型上；
 * - `cooldown`：上一条 429/配额错误要求安静多久，期间不再选它。
 *
 * 上限为 0 表示不限（迁移前的旧配置常见 0 或缺失），此时 `isFull` 永远 false。
 */

export const DEFAULT_CONCURRENCY = 0
export const DEFAULT_CAPACITY_COOLDOWN_MS = 30_000

/**
 * @param {object} input
 * @param {(model: string) => number} input.limitOf
 * @param {(model: string) => number} [input.cooldownOf]
 */
export function createGate({ limitOf, cooldownOf } = {}) {
  const inflight = new Map()
  const cooling = new Map()

  const limitFor = model => {
    const value = Number(limitOf?.(model) ?? 0)
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
  }

  return {
    /** 该模型是否已经满员。 */
    isFull(model) {
      const limit = limitFor(model)
      return limit > 0 && (inflight.get(model) ?? 0) >= limit
    },

    /**
     * 占一个名额。
     *
     * @returns {boolean} false = 满员，调用方应换下一个候选
     */
    acquire(model) {
      if (this.isFull(model)) return false
      inflight.set(model, (inflight.get(model) ?? 0) + 1)
      return true
    },

    /** 释放名额；多释放一次也不会变负。 */
    release(model) {
      const count = (inflight.get(model) ?? 0) - 1
      if (count <= 0) inflight.delete(model)
      else inflight.set(model, count)
    },

    inflight(model) {
      return inflight.get(model) ?? 0
    },

    limit(model) {
      return limitFor(model)
    },

    /** 记录一次"上游说它忙"——冷却期间候选排序会跳过它。 */
    markCapacity(model, ms) {
      const duration = Number(ms) > 0 ? Math.trunc(Number(ms)) : (Number(cooldownOf?.(model)) || DEFAULT_CAPACITY_COOLDOWN_MS)
      if (duration <= 0) return 0
      const until = Date.now() + duration
      const previous = cooling.get(model) ?? 0
      if (until > previous) cooling.set(model, until)
      return until
    },

    cooldownUntil(model) {
      return cooling.get(model) ?? 0
    },

    /** 面板读数：每个被观察到的模型一行。 */
    snapshot(models = []) {
      return models.map(model => ({
        model,
        inflight: inflight.get(model) ?? 0,
        limit: limitFor(model),
        cooldownUntil: cooling.get(model) ?? 0,
      }))
    },

    /** 清空冷却（面板的"重置冷却"）。 */
    resetCooldown(model) {
      if (model === undefined) cooling.clear()
      else cooling.delete(model)
    },
  }
}
