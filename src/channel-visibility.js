/**
 * 渠道包「模型目录可见性」。
 *
 * ## 为什么需要它
 *
 * 渠道包（`vendor/channel-pack/pack.js`）的 13 个 provider 会各自向 DSH 的模型
 * 选择器贡献一个分组。默认规则（用户 2026-11-24 明确要求，11-25 再次确认）：
 * **只有登录过账号的渠道才出现在选择器里**，没登录的渠道整组不出现；登录后
 * 下一次刷新就会出现。
 *
 * 渠道包自己有一条门控 `providerCatalogVisible()`（`pack.js`）：适配器
 * `listModels()` 第一行调用它，返回 `false` 就返回 `[]`，而
 * `dsh-api-session-controller` 的 `buildModelCatalog()` 会
 * `.filter(group => group.models.length > 0)` —— **空数组即整组消失**。
 * 但它只在环境变量 `DSH_HIDE_MODELS_WITHOUT_ACCOUNT` 为真时才去问账号池；
 * 为假时直接「全部可见」。本插件需要自己掌舵，因此包裹账号池的
 * `hasLoggedInAccount`，并保证环境变量始终为真（否则上游根本不会调用包装层）。
 *
 * ## 语义
 *
 * - `hideChannelModels`（面板上的「隐藏所有渠道」）为真 → 13 个分组**全部收起**。
 * - 该开关为假 → **交回上游原判定**：有可解析凭据才可见（未登录 = 隐藏）。
 *
 * ## 做法
 *
 * 不改 2.8MB 的 `pack.js`（它标注了「do not edit」，且无法逐字节重现构建）。
 * 渠道包在 `apply()` 末尾用 `ctx.provide('accountPool', pool)` 暴露账号池，而
 * 每个适配器持有的正是**同一个对象**（`this.options.accountPool`）。因此在
 * `pack.apply()` 返回后包裹该对象的 `hasLoggedInAccount` 即可 —— 适配器每次
 * `listModels()` 都会重新调用它，包裹立即生效，且开关状态**每次调用现读**，
 * 不在安装时定格。
 *
 * ## 边界（务必保持）
 *
 * - **只影响目录展示，不影响路由**：`hasLoggedInAccount` 的唯一调用点就是那条
 *   展示门控；`resolveModel()` / `resolveModelInfo()` 都不经过它，而网关的请求
 *   路径只走 `resolveModelInfo()`。被隐藏的模型仍能正常收发。
 * - **`listAllModels()` 不受影响**：渠道包设置页的「显示列表」「关闭全部」读的是
 *   它（它有意绕过黑名单），必须保持原样，否则用户无法再打开被关掉的模型。
 * - **失败即放行**：账号池缺失、未实现该方法、原方法抛错时一律返回 `true`
 *   —— 宁可多显示，也不让整组模型凭空消失。
 * - **热重载换新开关**：`shouldHide` 存在 pool 的 Symbol 上而不是闭包里，
 *   重复安装时只更新它（包装本身复用），避免旧闭包把新设置锁死。
 */

/** `providerCatalogVisible()` 读取的开关：缺省即开启（= 去问账号池）。 */
const HIDE_FLAG = 'DSH_HIDE_MODELS_WITHOUT_ACCOUNT'

/** 包装标记：热重载重复 apply 时只包一次。 */
const WRAPPED = Symbol.for('our-free-model.catalog-visibility')

/** 最新的 `shouldHide` 回调（每次安装覆盖，包装层现读）。 */
const HIDE_HOOK = Symbol.for('our-free-model.catalog-visibility.should-hide')

/**
 * 包裹账号池的 `hasLoggedInAccount`。
 *
 * @param pool 渠道包暴露的账号池（`ctx.get('accountPool')`）。
 * @param options.shouldHide 每次判定现读的回调：`true` = 隐藏全部渠道分组。
 * @returns `{ installed, sync }`；`installed: false` 表示未接管（调用方无需处理）。
 */
export function installChannelCatalogVisibility(pool, { shouldHide } = {}) {
  // 能力检测：与上游门控一致，替身/无账号池时静默放行。
  if (!pool || typeof pool.hasLoggedInAccount !== 'function') {
    return { installed: false, sync() {} }
  }
  const shouldHideNow = typeof shouldHide === 'function' ? shouldHide : () => false
  pool[HIDE_HOOK] = shouldHideNow

  const original = pool.hasLoggedInAccount

  // 开关读不出来时按「没要求全隐藏」处理，交回账号判定（不比上游更激进）。
  const hideAll = () => {
    try {
      return pool[HIDE_HOOK]?.() === true
    } catch {
      return false
    }
  }

  if (pool[WRAPPED] !== true) {
    try {
      pool.hasLoggedInAccount = async function hasLoggedInAccount(provider) {
        /*
         * - 总开关**开** → `false`：13 个渠道分组全收起。
         * - 总开关**关** → 交回上游：`true` 仅当该 provider 有可解析凭据。
         *
         * 这条门控的唯一调用点就是 `listModels()` 的展示判定，不影响路由与
         * 推理（`resolveModelInfo()` 不经过它），所以隐藏不会让死模型可选后崩。
         */
        if (hideAll()) return false
        try {
          return await original.call(this, provider)
        } catch {
          // 原方法出错宁可显示：整组消失比多显示更难排查。
          return true
        }
      }
      Object.defineProperty(pool, WRAPPED, {
        value: true, enumerable: false, configurable: true,
      })
    } catch {
      return { installed: false, sync() {} }
    }
  }

  /**
   * 上游门控先读环境变量：为假会短路成「全部可见」，包装层根本不会被调用。
   * 因此接管期间必须保持真值（'1'）。
   */
  const sync = () => {
    process.env[HIDE_FLAG] = '1'
  }

  sync()
  return { installed: true, sync }
}
