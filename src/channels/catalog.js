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

import { DOUBAO_FALLBACK_MODELS } from './doubao.js'
import { officeaceCatalogRows } from './officeace.js'

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
  doubao: '豆包',
  agnescode: 'AgnesCode',
  agnescodeintl: 'AgnesCode 国际版',
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
  // AgnesCode 同 Accio：目录按账号/订阅档下发（`{bffBase}/models`），
  // 刻意**没有**静态兜底表 —— 没导入登录态就 0 个模型。
  agnescode: [],
  agnescodeintl: [],
  // MiniMax 国际版的兜底表与国内站共用同一份（远端目录永远是首选）。
  // ⚠️ 必须含 `MiniMax-M3.1-Flash-Preview`：它不在任何客户端内置表里。
  // ⚠️ 这一家是 **Anthropic Messages** 线：`wire` 必须随每一行走。远端目录
  // （`minimaxCatalogRows`）也带 wire；漏一处就会把 OpenAI 形请求体发到
  // `/messages`（上游 400，表现成「模型看得见、一发就失败」）。
  minimaxintl: [
    { id: 'MiniMax-M3.1-Flash-Preview', name: 'M3.1-Flash-Preview', contextWindow: 1_000_000, maxOutput: 128_000, vision: true, reasoning: true, efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'default', wire: 'messages' },
    { id: 'MiniMax-M3', name: 'M3', contextWindow: 1_000_000, maxOutput: 128_000, vision: true, reasoning: true, wire: 'messages' },
    { id: 'MiniMax-M2.7-highspeed', name: 'M2.7-highspeed', contextWindow: 200_000, maxOutput: 128_000, vision: false, reasoning: true, wire: 'messages' },
    { id: 'MiniMax-M2.7', name: 'M2.7', contextWindow: 200_000, maxOutput: 128_000, vision: false, reasoning: true, wire: 'messages' },
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
  // ⚠️ id 是上游真实 `modelId`（`xop…` 前缀），**不是**展示名 —— 兜底表按
  // `providers-astudio.md` 的真机实测口径写（含 `studioVersion:3.6.4` 才下发的
  // `xdeepseek-flash-in`）。
  astudio: [
    { id: 'xdeepseek-flash-in', name: 'DeepSeek-V4.1-Flash', contextWindow: 1_048_576, maxOutput: 100_000, reasoning: true, wire: 'responses' },
    { id: 'xopglm52', name: 'GLM-5.2', contextWindow: 1_024_000, maxOutput: 128_000, reasoning: true, wire: 'responses' },
    { id: 'xopdsv4flash0731in', name: 'DeepSeek-V4-Flash', contextWindow: 1_024_000, maxOutput: 384_000, reasoning: true, wire: 'responses' },
    { id: 'xopdeepseekv4pro0813', name: 'DeepSeek-V4-Pro', contextWindow: 1_024_000, maxOutput: 384_000, reasoning: true, wire: 'responses' },
    { id: 'astronclaw-auto', name: 'Auto（自适应）', contextWindow: 1_024_000, maxOutput: 384_000, reasoning: true, wire: 'responses' },
    { id: 'spark-x2.6-preview', name: 'Spark-X2.6', contextWindow: 262_144, maxOutput: 256_000, reasoning: true, wire: 'responses' },
    { id: 'spark-x2.5', name: 'Spark-X2.5', contextWindow: 262_144, maxOutput: 256_000, reasoning: true, wire: 'responses' },
  ],
  // OfficeAce 的内置表就在它自己的模块里（8 条，含 glm-5.2 / glm-5.1 /
  // deepseek-v4-flash / qwen3-30b-a3b）——这里只引用，不抄第二份。上一版
  // 手抄了 4 条，选择器里永远少 4 个模型，且远端目录从未被接线。
  officeace: officeaceCatalogRows(),
  // 百智云：远端 `/v1/models` 首选；拿不到时列实测过的 16 条（2026-11-07 真机，
  // 输出上限按 `baizhiMaxOutputTokensFor` 的同一口径：deepseek/glm/kimi/minimax
  // 100k、qwen 65,536、qwen-flash 32,768）。
  baizhi: [
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', maxOutput: 100_000, reasoning: true },
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', maxOutput: 100_000, reasoning: true },
    { id: 'deepseek-v4-flash-vision-exp', name: 'DeepSeek V4 Flash Vision', maxOutput: 100_000, vision: true, reasoning: true },
    { id: 'deepseek-flash', name: 'DeepSeek Flash', maxOutput: 100_000, reasoning: true },
    { id: 'minimax-m2.7', name: 'MiniMax M2.7', maxOutput: 100_000, reasoning: true },
    { id: 'minimax-m2.5', name: 'MiniMax M2.5', maxOutput: 100_000, reasoning: true },
    { id: 'minimax-m3.1-flash', name: 'MiniMax M3.1 Flash', maxOutput: 100_000, reasoning: true },
    { id: 'glm-5.1', name: 'GLM-5.1', maxOutput: 100_000, reasoning: true },
    { id: 'glm-5', name: 'GLM-5', maxOutput: 100_000, reasoning: true },
    { id: 'glm-4.7', name: 'GLM-4.7', maxOutput: 100_000, reasoning: true },
    { id: 'kimi-k2.6', name: 'Kimi K2.6', maxOutput: 100_000, reasoning: true },
    { id: 'kimi-k2.5', name: 'Kimi K2.5', maxOutput: 100_000, reasoning: true },
    { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', maxOutput: 65_536, reasoning: true },
    { id: 'qwen3.5-plus', name: 'Qwen3.5 Plus', maxOutput: 65_536, reasoning: true },
    { id: 'qwen3.5-flash', name: 'Qwen3.5 Flash', maxOutput: 65_536, reasoning: true },
    { id: 'qwen-flash', name: 'Qwen Flash', maxOutput: 32_768, reasoning: true },
  ],
  // 豆包：`/chat/completion` 是**这套协议自己的**（请求体整体替换 + `id:/event:/data:` 帧），
  // 兜底表是**真机抓到的 16 条**（参考实现 2026-11-22 的 14 条 + 本机 2026-11-24 新出的 GLM 5.4）。
  // 远端 `brief_list` 可用时以它为准（`createDoubaoExtras` 会把它塞进 `catalog`）。
  doubao: DOUBAO_FALLBACK_MODELS.map(model => ({
    id: model.key,
    // `mode=3` = 工作任务线：普通账号实测回 `712010202 参数错误`，且该会员线当前
    // 不可用（用户确认会员「是假的」，买了也不解锁）。名字里直说，免得被当成「模型不可用」。
    name: `${model.name}${model.mode === '3' ? '（会员线·暂不可用）' : ''}${model.tags.length === 0 ? '' : ` · ${model.tags.join(' · ')}`}`,
    reasoning: Array.isArray(model.efforts),
    ...Array.isArray(model.efforts) ? { efforts: model.efforts } : {},
  })),
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
 * 渠道的**线协议**（唯一事实源）。
 *
 * ⚠️ 远端目录与兜底表都可能不写 `wire`（它们只关心模型 id/名称）。漏了这一层，
 * `ownEntry()` 会把请求按 OpenAI chat 组出来，然后发到 `/messages` 或
 * `/responses` —— 上游 400，用户看到的是「模型能选、一发就失败」。
 */
const WIRE_BY_PROVIDER = {
  minimaxintl: 'messages',
  monkeycode: 'messages',
  monkeycodeintl: 'messages',
  baizhi: 'messages',
  astudio: 'responses',
}

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
    // 渠道展示名：选择器按 provider 分组后，组内行仍能带上来源（宿主会忽略
    // 它不认识的键，但面板与诊断日志读得到）。
    ...typeof model.providerLabel === 'string' && model.providerLabel !== '' ? { providerLabel: model.providerLabel } : {},
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

/** 某个渠道被用户关掉的模型（裸 modelId）。读设置时做一次归一化，坏值直接丢弃。 */
export function ownDisabledModelsOf(settings, provider) {
  const map = settings?.ownDisabledModels
  const list = map !== null && typeof map === 'object' ? map[provider] : undefined
  return new Set((Array.isArray(list) ? list : []).map(value => String(value ?? '').trim()).filter(value => value !== ''))
}

/** 某个自有渠道是否被「关闭整个渠道」（与渠道包的 `closed` 同一语义）。 */
export function ownProviderClosed(settings, provider) {
  const map = settings?.ownClosedProviders
  return map !== null && typeof map === 'object' && map[provider] === true
}

/**
 * 把「账号表 + 各渠道缓存的目录」编成 catalog 行。
 *
 * @param {object} input
 * @param {Record<string, Array<{id: string, name?: string}>>} input.catalogs - provider → 模型清单
 * @param {Record<string, boolean>} input.enabled - provider → 是否至少有一个启用账号
 * @param {boolean} [input.hideAll] - 总开关（与渠道包那 13 家同一个语义）
 * @param {Record<string, string[]>} [input.disabledModels] - provider → 被关掉的裸 modelId
 * @param {Record<string, boolean>} [input.closedProviders] - provider → 整个渠道被关闭
 * @param {boolean} [input.includeDisabled] - 面板的「模型」折叠要看到被关掉的行
 *   （选择器与网关读的是**过滤后**的那份，两者不能混用）
 * @param {boolean} [input.signedInOnly] - 只保留「有登录账号」的渠道。
 *   选择器/网关用 true：未登录渠道的预制目录不该占一个分组（用户 2026-11-24
 *   要求）；面板不传，卡片与「模型」折叠仍能看到这些渠道并去登录。
 * @returns {Array<object>}
 */
export function buildOwnCatalog({
  catalogs = {}, enabled = {}, hideAll = false,
  disabledModels = {}, closedProviders = {}, includeDisabled = false,
  signedInOnly = false,
} = {}) {
  if (hideAll) return []
  const entries = []
  for (const [provider, label] of Object.entries(OWN_LABELS)) {
    const closed = closedProviders[provider] === true
    // 选择器/网关里关闭的渠道整组消失；面板的折叠仍要列出来（否则「打开整个
    // 渠道」的按钮会随模型一起消失，用户没有入口把它开回来）。
    if (closed && !includeDisabled) continue
    const signedIn = enabled[provider] === true
    // 只呈现已登录渠道（选择器/网关）：没有账号就没有可用模型，留一个空分组
    // 只会让人以为「模型丢了」。
    if (signedInOnly && !signedIn) continue
    const disabled = new Set((Array.isArray(disabledModels[provider]) ? disabledModels[provider] : [])
      .map(value => String(value ?? '').trim()).filter(value => value !== ''))
    const cached = Array.isArray(catalogs[provider]) ? catalogs[provider] : []
    // 未登录也先编好兜底目录：面板的「模型」折叠要能看到「这家支持哪些模型、
    // 登录后就有」（`signedInOnly: false`）。选择器/网关传 `signedInOnly: true`，
    // 未登录渠道整组不出现 —— 2026-11-24 用户要求「有登录账号后才显示」。
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
      // 关闭整个渠道 = 它的每一行都按「已关掉」呈现（面板看得到、选择器看不到）。
      const off = closed || disabled.has(id)
      if (off && !includeDisabled) continue
      const name = typeof row.name === 'string' && row.name !== ''
        ? row.name
        : (AUTOCLAW_NAMES[id] ?? id)
      entries.push({
        ...ownEntry(provider, {
          ...row,
          id,
          name,
          providerLabel: label,
          needsLogin: !signedIn,
          // 行自己写了就用行的；否则按渠道的线协议补上（远端表常常不写）。
          wire: row.wire ?? WIRE_BY_PROVIDER[provider],
        }),
        ...off ? { disabled: true } : {},
      })
    }
  }
  return entries
}

/**
 * 一个渠道在面板上要显示的模型计数（**包含被关掉的行**，否则关掉一个模型
 * 之后卡片上的分母也跟着变小，用户看不出自己关过东西）。
 *
 * @returns {{total: number, disabled: number, closed: boolean}}
 */
export function ownModelStats({ catalogs = {}, enabled = {}, disabledModels = {}, closedProviders = {} } = {}, provider) {
  const closed = closedProviders[provider] === true
  const rows = buildOwnCatalog({ catalogs, enabled, disabledModels, closedProviders, includeDisabled: true })
    .filter(entry => entry.provider === provider)
  return {
    total: rows.length,
    disabled: rows.filter(entry => entry.disabled === true).length,
    closed,
  }
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