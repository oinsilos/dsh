/**
 * 自有渠道的**目录行**：把本插件自己的渠道（Codely / AutoClaw / Accio）编成与其它
 * 车道同形的 catalog entry，供模型选择器与 `resolveModel` 使用。
 *
 * ## 为什么单独一个模块
 *
 * `src/catalog.js` 是免费车道的目录（id 由上游 listing 决定），`src/aggregate.js`
 * 是自带 Key 的聚合车道（id 形如 `provider/model`）。自有渠道的 id 形如
 * `codely/codely-core`：前缀是**我们**定的路由名，后半段是上游的模型 id ——
 * 与聚合车道同构，但凭据来源不同（本插件账号表 vs 用户贴的 Key），故单独一份。
 *
 * ## 读谁
 *
 * 账号表（`src/channels/accounts.js`）只告诉我们「有哪些账号」；**模型清单**要靠
 * 权益查询（`/channels/extra`）拿到并缓存在内存里。缓存由 `index.js` 在渠道状态
 * 刷新时喂进来 —— 目录本身必须**同步可读**（宿主的 `listModels` 契约），不能现拉网络。
 *
 * @module src/channels/catalog.js
 */

/** 渠道 → 展示名（选择器里的分组标题）。 */
export const OWN_LABELS = {
  codely: 'Codely',
  autoclaw: 'AutoClaw',
  autoclawintl: 'AutoClaw (国际版)',
  accio: 'Accio',
  minimaxintl: 'MiniMax (国际版)',
  marvis: '腾讯 Marvis',
  magicrew: '超级麦吉',
  magicrewintl: 'MagiCrew',
  monkeycode: 'MonkeyCode',
  monkeycodeintl: 'MonkeyCode 国际版',
  baizhi: '百智云',
  officeace: 'OfficeAce',
  astudio: 'AStudio',
}

/**
 * 各渠道的兜底目录（网络不可用时的最小可用集合）。
 *
 * 行可以是**字符串**（id，展示名同 id）或**对象**（带 `name` / `contextWindow` /
 * `maxOutput` / `vision` / `efforts`）。对象形态是为了让兜底表也能声明上游实测过的
 * 能力 —— `ownEntry()` 只认这些字段，多写的键会被忽略。
 */
const FALLBACK = {
  codely: ['codely-core', 'codely-basic', 'codely-flash', 'codely-air', 'codely-vl', 'DeepSeek-V4.1-Flash', 'GLM-5.3-FLASH', 'KIMI-K3'],
  autoclaw: ['zaicoding_glm-5.3', 'zai_auto', 'zai_auto-fast', 'zai_glm-5.3-flash'],
  autoclawintl: ['zaicoding_glm-5.3', 'zai_auto', 'zai_auto-fast', 'zai_glm-5.3-flash'],
  // Accio 的 modelCode 非人类可读、且按账号下发，兜底表**刻意留空**：
  // 目录只能来自远端；没有远端数据时这一组不出现（而不是列出一堆假 id）。
  accio: [],
  // MiniMax 国际版的兜底表与国内站共用同一份（远端目录永远是首选）。
  // ⚠️ 必须含 `MiniMax-M3.1-Flash-Preview`：它不在任何客户端内置表里。
  minimaxintl: [
    { id: 'MiniMax-M3.1-Flash-Preview', name: 'M3.1-Flash-Preview', contextWindow: 1_000_000, maxOutput: 128_000, vision: true, reasoning: true, efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'default' },
    { id: 'MiniMax-M3', name: 'M3', contextWindow: 1_000_000, maxOutput: 128_000, vision: true, reasoning: true },
    { id: 'MiniMax-M2.7-highspeed', name: 'M2.7-highspeed', contextWindow: 200_000, maxOutput: 128_000, vision: false, reasoning: true },
    { id: 'MiniMax-M2.7', name: 'M2.7', contextWindow: 200_000, maxOutput: 128_000, vision: false, reasoning: true },
  ],
  // Marvis 的上游**没有**目录端点（实测 9 个候选全 404），目录只能是这条产品决策：
  // 槽位名 `deepseek-v4-pro-external`，展示名按用户要求写美化名。
  marvis: [
    { id: 'deepseek-v4-pro-external', name: 'DeepSeek V4.1 Flash', contextWindow: 1_000_000, vision: true, reasoning: true },
  ],
  // 超级麦吉 / MagiCrew：兜底目录照抄上游 `model_order`（远端 /flows/models 失败时用）。
  magicrew: [
    { id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 204_800, reasoning: true },
    { id: 'glm-4.6', name: 'GLM 4.6', contextWindow: 204_800, reasoning: true },
    { id: 'glm-4.5', name: 'GLM 4.5', contextWindow: 131_072, reasoning: true },
    { id: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash', contextWindow: 1_048_576, vision: true, reasoning: true },
    { id: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro', contextWindow: 1_048_576, reasoning: true },
    { id: 'doubao-seed-2.0-pro', name: 'Seed 2.0 Pro', contextWindow: 256_000, vision: true, reasoning: true },
    { id: 'doubao-seed-2.0-code', name: 'Seed 2.0 Code', contextWindow: 256_000, vision: true, reasoning: true },
    { id: 'doubao-seed-2.0-lite', name: 'Seed 2.0 Lite', contextWindow: 256_000, vision: true, reasoning: true },
  ],
  magicrewintl: [
    { id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 204_800, reasoning: true },
    { id: 'glm-4.6', name: 'GLM 4.6', contextWindow: 204_800, reasoning: true },
    { id: 'glm-4.5', name: 'GLM 4.5', contextWindow: 131_072, reasoning: true },
    { id: 'mimo-v2.6-flash', name: 'MiMo V2.6 Flash', contextWindow: 1_048_576, vision: true, reasoning: true },
    { id: 'mimo-v2.6-pro', name: 'MiMo V2.6 Pro', contextWindow: 1_048_576, reasoning: true },
    { id: 'doubao-seed-2.0-pro', name: 'Seed 2.0 Pro', contextWindow: 256_000, vision: true, reasoning: true },
    { id: 'doubao-seed-2.0-code', name: 'Seed 2.0 Code', contextWindow: 256_000, vision: true, reasoning: true },
    { id: 'doubao-seed-2.0-lite', name: 'Seed 2.0 Lite', contextWindow: 256_000, vision: true, reasoning: true },
  ],
  // MonkeyCode：网关没有模型列表（GET /v1/models 回 405），目录是内置常量。
  monkeycode: [
    { id: 'monkeycode-basic/deepseek-flash', name: 'DeepSeek Flash（basic）', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true },
    { id: 'monkeycode-basic/deepseek-v4-flash', name: 'DeepSeek V4 Flash（basic）', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true },
    { id: 'monkeycode-pro/deepseek-flash', name: 'DeepSeek Flash（pro）', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true },
    { id: 'monkeycode-pro/deepseek-v4-pro', name: 'DeepSeek V4 Pro（pro）', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true },
    { id: 'monkeycode-ultra/deepseek-v4-pro', name: 'DeepSeek V4 Pro（ultra）', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true },
    { id: 'deepseek-flash', name: 'DeepSeek Flash（积分）', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash（积分）', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro（积分）', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true },
  ],
  // AStudio：`/responses` 线，目录行必须带 wire，否则解码器按 chat 读会全丢。
  astudio: [
    { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true, wire: 'responses' },
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_048_576, maxOutput: 384_000, reasoning: true, wire: 'responses' },
  ],
  officeace: [
    { id: 'glm-5.3', name: 'GLM-5.3', contextWindow: 1_048_576, maxOutput: 131_072, reasoning: true },
    { id: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1_048_576, maxOutput: 393_216, vision: true, reasoning: true },
    { id: 'kimi-k2.6', name: 'Kimi-K2.6', contextWindow: 262_144, maxOutput: 131_072, vision: true, reasoning: true },
    { id: 'qwen3-32b', name: 'Qwen3-32B', contextWindow: 131_072, maxOutput: 65_536, reasoning: true },
  ],
  monkeycodeintl: [
    { id: 'monkeycode-basic/deepseek-flash', name: 'DeepSeek Flash（basic）', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true },
    { id: 'monkeycode-basic/deepseek-v4-flash', name: 'DeepSeek V4 Flash（basic）', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true },
    { id: 'monkeycode-pro/deepseek-flash', name: 'DeepSeek Flash（pro）', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true },
    { id: 'monkeycode-pro/deepseek-v4-pro', name: 'DeepSeek V4 Pro（pro）', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true },
    { id: 'monkeycode-ultra/deepseek-v4-pro', name: 'DeepSeek V4 Pro（ultra）', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true },
    { id: 'deepseek-flash', name: 'DeepSeek Flash（积分）', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash（积分）', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true },
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro（积分）', contextWindow: 1_048_576, maxOutput: 128_000, reasoning: true },
  ],
}


/** AutoClaw 的模型展示名（远端 `name` 为准，加品牌后缀避免跨渠道同名）。 */
const AUTOCLAW_NAMES = {
  zaicoding_glm_5_3: 'GLM-5.3 (AutoClaw)',
  'zaicoding_glm-5.3': 'GLM-5.3 (AutoClaw)',
  zai_auto: 'Auto (AutoClaw)',
  'zai_auto-fast': 'Auto-Fast (AutoClaw)',
  'zai_glm-5.3-flash': 'GLM-5.3 Flash (AutoClaw)',
  'zai_glm_5_3_flash': 'GLM-5.3 Flash (AutoClaw)',
}

const DEFAULT_CONTEXT = 131_072
const DEFAULT_MAX_OUTPUT = 32_768

/**
 * 一行目录。字段与 `entryOf`（aggregate）同形，另加 `own: true` 与 `provider`
 * 让适配器把请求交给 `src/channels/inference.js`。
 *
 * @param {string} provider - `codely` / `autoclaw` / `autoclawintl` / `accio`
 * @param {object} model - `{id, name?, contextWindow?, rate?, efforts?, defaultEffort?, vision?}`
 */
export function ownEntry(provider, model) {
  const id = `${provider}/${model.id}`
  const label = model.name ?? model.id
  return {
    id,
    name: label,
    channel: 'own',
    own: true,
    provider,
    modelId: model.id,
    // 默认按 chat 渲染；AStudio 走 Responses 线，故行里可带 `wire`。
    wire: model.wire === 'responses' || model.wire === 'messages' ? model.wire : 'chat',
    vision: model.vision === true,
    reasoning: model.efforts !== undefined ? true : model.reasoning !== false,
    contextWindow: typeof model.contextWindow === 'number' && model.contextWindow > 0 ? model.contextWindow : DEFAULT_CONTEXT,
    maxOutput: typeof model.maxOutput === 'number' && model.maxOutput > 0 ? model.maxOutput : DEFAULT_MAX_OUTPUT,
    canDisableThinking: true,
    regionSensitive: false,
    ...model.efforts === undefined ? {} : { efforts: model.efforts, effortDefault: model.defaultEffort },
    ...model.rate === undefined ? {} : { rate: model.rate },
    // 未登录的行：列表里看得见、选得中，真正发请求时才报「需要登录」。
    // 面板据此显示「待登录」而不是把它当成可用。
    ...model.needsLogin === true ? { needsLogin: true } : {},
  }
}

/**
 * 把「账号表 + 各渠道缓存的目录」编成 catalog 行。
 *
 * @param {object} input
 * @param {Record<string, Array<{id: string, name?: string}>>} input.catalogs - provider → 模型清单
 * @param {Record<string, boolean>} input.enabled - provider → 是否至少有一个启用账号
 * @param {boolean} [input.hideAll] - 总开关（与渠道包那 13 家同一个语义）
 * @returns {Array<object>}
 */
export function buildOwnCatalog({ catalogs = {}, enabled = {}, hideAll = false } = {}) {
  if (hideAll) return []
  const entries = []
  for (const [provider, label] of Object.entries(OWN_LABELS)) {
    const signedIn = enabled[provider] === true
    const cached = Array.isArray(catalogs[provider]) ? catalogs[provider] : []
    // 未登录时**也列出兜底目录**：选择器里看得见、选得中，发请求时返回
    // 「凭据不可用（需要重新登录）」—— 比「整组不存在」好排查，用户也才知道
    // 这个渠道支持哪些模型（2026-11-24 用户明确要求）。
    const rows = cached.length > 0
      ? cached
      : (FALLBACK[provider] ?? []).map(row => {
        // 兜底表允许两种形态：裸 id（展示名同 id）与带能力的对象。
        if (typeof row === 'string') return { id: row, name: AUTOCLAW_NAMES[row] ?? row }
        if (row === null || typeof row !== 'object') return null
        const id = typeof row.id === 'string' ? row.id.trim() : ''
        return id === '' ? null : { ...row, id, name: typeof row.name === 'string' && row.name !== '' ? row.name : (AUTOCLAW_NAMES[id] ?? id) }
      }).filter(row => row !== null)
    for (const row of rows) {
      if (row === null || typeof row !== 'object') continue
      const id = typeof row.id === 'string' ? row.id.trim() : ''
      if (id === '') continue
      const name = typeof row.name === 'string' && row.name !== ''
        ? row.name
        : (AUTOCLAW_NAMES[id] ?? id)
      entries.push(ownEntry(provider, { ...row, id, name, providerLabel: label, needsLogin: !signedIn }))
    }
  }
  return entries
}

/** 是不是自有渠道的行。 */
export function isOwnEntry(entry) {
  return entry?.own === true && typeof entry?.provider === 'string'
}

/** 自有渠道的 id 前缀集合（给「这个 id 属于谁」的判断用）。 */
export function ownProviderOf(modelId) {
  const text = String(modelId ?? '')
  const slash = text.indexOf('/')
  if (slash <= 0) return null
  const prefix = text.slice(0, slash)
  return Object.prototype.hasOwnProperty.call(OWN_LABELS, prefix) ? prefix : null
}