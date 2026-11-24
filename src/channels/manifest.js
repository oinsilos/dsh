/**
 * 渠道清单（**唯一事实源**）：宿主侧认识哪些渠道、每个渠道怎么登录、有没有权益扩展。
 *
 * ## 为什么需要它
 *
 * 这一页的渠道信息曾经散在**六处**：`OWN_PROVIDERS`（账号表）、`PROVIDERS`（权益扩展）、
 * `BROWSER_LOGIN_PROVIDERS`（浏览器登录）、`BROWSER_LOGIN_ENTRIES`（登录入口）、
 * `client.js` 的 `CHANNEL_PROVIDERS`（卡片）、`local-packages` 里那份**旧代码**。
 * 后果是真实发生过的两类故障：
 *
 * 1. 面板渲染了新卡片，而宿主进程里还是旧代码（插件更新后没重启）⇒ 点「添加账号」
 *    得到「该渠道没有浏览器登录」或 `Cannot read properties of null`；
 * 2. 集合之间漏一条 ⇒ 浏览器起来了、面板却在问设备码端点（「扫完码一直转圈」）。
 *
 * 现在宿主把**自己实际加载的那份清单**挂出来（`GET /channels/manifest`），面板拿它
 * 与自己渲染的卡片对账：**对不上就明说「宿主是旧代码，重启 DSH」** —— 不再让用户
 * 对着一个「按钮没反应」的界面猜。
 *
 * ⚠️ 清单是**运行时拼装**的（读真实注册表与真实流程表），不是又抄一份常量：
 * 抄一份等于把「六处」变成「七处」。
 *
 * @module src/channels/manifest.js
 */

/**
 * 渠道包（`vendor/channel-pack`）持有的 13 家。
 *
 * ⚠️ 这 13 个 id 由渠道包决定，不是我们能改的；唯一的用处是「面板上有、宿主却不认识」
 * 这类对账，以及启动诊断里那条 `llm.listModels(provider)` 的探针列表。
 */
export const PACK_CHANNEL_IDS = Object.freeze([
  'codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn',
  'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini',
])

/** 本次构建的标记（只用于排查「宿主加载的是哪一版」，不参与任何判据）。 */
export const BUILD_ID = '2026-11-25.agnescode'

/**
 * 拼一份清单。
 *
 * @param {object} input
 * @param {string[]} input.ownIds - `OWN_PROVIDERS`（账号表里认识的渠道）
 * @param {string[]} input.extrasIds - 宿主实际注册了权益扩展的渠道
 * @param {string[]} input.browserIds - 走「宿主起浏览器」那条腿的渠道
 * @param {string[]} [input.importIds] - 走「读桌面客户端登录态」那条腿的渠道
 * @param {(provider: string) => boolean} input.supportsDeviceLogin
 * @param {(provider: string) => boolean} input.supportsSmsLogin
 * @param {(provider: string) => boolean} input.hasQrLogin - 扫码型（无用户码）
 * @param {(provider: string) => number} input.modelCount
 */
export function buildChannelManifest({
  ownIds = [],
  extrasIds = [],
  browserIds = [],
  importIds = [],
  supportsDeviceLogin = () => false,
  supportsSmsLogin = () => false,
  hasQrLogin = () => false,
  modelCount = () => 0,
} = {}) {
  const own = ownIds.map(id => {
    const login = importIds.includes(id) ? 'import'
      : browserIds.includes(id) ? 'browser'
        : supportsDeviceLogin(id) ? 'device'
          : supportsSmsLogin(id) ? 'sms'
            : 'none'
    return {
      id,
      login,
      qr: login === 'device' && hasQrLogin(id),
      browser: login === 'browser',
      extras: extrasIds.includes(id),
      models: modelCount(id),
    }
  })
  return {
    buildId: BUILD_ID,
    pack: [...PACK_CHANNEL_IDS],
    own,
    totals: { pack: PACK_CHANNEL_IDS.length, own: own.length, all: PACK_CHANNEL_IDS.length + own.length },
  }
}

/**
 * 面板与宿主对账：面板渲染的 `own` 渠道里，宿主不认识的那些。
 *
 * 返回**缺失的 id 列表**（空 = 一致）。这条判据是行为级的：不比对版本号字符串，
 * 只问「宿主到底认不认这个渠道」，所以插件更新/回滚/热重载都自然覆盖。
 *
 * @param {object} manifest - `GET /channels/manifest` 的返回
 * @param {string[]} renderedOwnIds - 面板 `CHANNEL_PROVIDERS` 里 `own: true` 的 id
 */
export function missingFromHost(manifest, renderedOwnIds) {
  const known = new Set(Array.isArray(manifest?.own) ? manifest.own.map(row => row?.id) : [])
  return (Array.isArray(renderedOwnIds) ? renderedOwnIds : []).filter(id => !known.has(id))
}
