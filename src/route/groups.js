/**
 * 路由分组：一份「优先级 + 时段 + 熔断」的模型候选表。
 *
 * 这套字段不是凭空来的——它是 `model-failover-manager` 的 `groups.json` 原样
 * 搬过来的（`provider` / `model` / `priority` / `effort` / `windows` /
 * `disabled`），所以迁移脚本只需要把 `model` 换成我们目录里的 id，其余一律
 * 保留。语义上多了两条：
 *
 * 1. `model` 存的是**目录 id**（`codearts/glm-5.3-flash` 这种），不是裸模型名。
 *    这样分组和 `combos` 共用同一套查询，也天然避开前缀门面那堆 provider 冲突。
 * 2. 分组本身是一个虚拟目录项（`channel: 'route'`），选择器里能直接选；
 *    会话选了它 = 绑定这个分组，宿主自己的会话记录负责"重启不丢"。
 *
 * 候选的排序只做一遍：优先级升序，同优先级按声明顺序。失败的跳过，
 * 时段外的跳过，被禁用的跳过，目录里不存在的跳过——每个跳过都带理由，
 * 面板与错误信息都靠它。
 */

export const GROUP_CHANNEL = 'route'
export const GROUP_PREFIX = 'route:'
export const MAX_GROUPS = 24
export const MAX_MEMBERS = 24
export const DEFAULT_PRIORITY = 99

/**
 * 本插件的 adapter 路由名。它们**不是**目录 id 的 provider 段：
 *
 * - 免费车道的目录 id 是裸模型名（`deepseek-v4.1-flash-free`）；
 * - Kilo 的目录 id 是 `org/model:free`；
 * - 聚合渠道的目录 id 已经是 `provider/model`。
 *
 * 但面板曾按「路由名/目录 id」拼成员坐标，于是免费车道与 Kilo 的成员被存成
 * `our-free-model/<目录 id>`，`memberEntry` 精确匹配不到 ⇒ 面板永久显示
 * 「目录缺失」。这里把这类前缀认出来并剥掉再匹配一次（**仍然不跨 provider 猜**）。
 *
 * ⚠️ 与 `src/adapter.js` 的 `ROUTE_MAIN` / `ROUTE_REGION` / `ROUTE_VIRTUAL`
 * 必须一致；`tests/route-groups.mjs` 钉住这一点。
 */
export const ADAPTER_ROUTE_ALIASES = new Set(['our-free-model', 'our-free-model-region', 'our-free-model-route'])

/** 撞名时加 `-2`、`-3`；只允许小写字母、数字、连字符。 */
function slugify(name) {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
  return slug === '' ? 'group' : slug
}

/** `route:main` 的稳定 id：由名称生成，重命名不改 id（改 id 会丢会话绑定）。 */
export function groupIdOf(name, taken = new Set()) {
  const base = `${GROUP_PREFIX}${slugify(name)}`
  if (!taken.has(base)) return base
  for (let index = 2; index <= MAX_GROUPS + 1; index += 1) {
    const candidate = `${base}-${index}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

export function isRouteEntry(entry) {
  return entry !== null && typeof entry === 'object'
    && entry.channel === GROUP_CHANNEL
    && typeof entry.group === 'string'
    && entry.group !== ''
}

/**
 * 时段：[{from, to}] 小时制，允许跨零点（18 → 8 = 晚上六点到早上八点）。
 *
 * `from === to` 按"全天"读，而不是"零小时"——迁移数据里把 0-0 写成全天更常见。
 */
export function normalizeWindows(value) {
  const list = typeof value === 'string'
    ? value.split(',').map(part => {
      const bits = part.trim().split(/[-~—]/)
      return { from: Number(bits[0]), to: Number(bits[1]) }
    })
    : Array.isArray(value) ? value : []
  const out = []
  for (const item of list) {
    const from = Number(item?.from)
    const to = Number(item?.to)
    if (!Number.isInteger(from) || !Number.isInteger(to)) continue
    if (from < 0 || from > 24 || to < 0 || to > 24) continue
    const hourFrom = Math.min(23, from)
    const hourTo = Math.min(24, to)
    out.push({ from: hourFrom, to: hourTo })
    if (out.length >= 8) break
  }
  return out
}

/** 当前小时是否落在任一时段内；空数组 = 不限时段。 */
export function windowActive(windows, hour) {
  if (!Array.isArray(windows) || windows.length === 0) return true
  const now = Number.isInteger(hour) ? hour : new Date().getHours()
  for (const window of windows) {
    const from = Number(window?.from)
    const to = Number(window?.to)
    if (!Number.isInteger(from) || !Number.isInteger(to)) continue
    if (from === to) return true
    if (from < to ? now >= from && now < to : now >= from || now < to) return true
  }
  return false
}

/**
 * 一条成员 → 目录项。目录 id 是唯一权威，provider 只作展示与兜底匹配。
 *
 * 迁移数据里存在两种历史写法，必须兜住，否则成员会永久显示「目录缺失」：
 * - 双前缀：`doubao/doubao/person-...`（provider 已拼过一次）；
 * - 裸名 + provider：`GLM-5.3-Flash` + `loomy`。
 * 兜底顺序：精确 id → legacy 坐标 → 去掉重复前缀 → 补 provider 前缀 →
 * 同 provider 同尾段 modelId（忽略大小写）。**不跨 provider 猜**。
 */
export function memberEntry(member, catalog) {
  if (!member || typeof member !== 'object') return undefined
  // 宿主渠道（loomy/codearts 等）的 model id 通常含大小写，但用户手动粘贴/
  // 迁移配置时大小写不一致会直接导致精确查找失败（真机：GLM-5.3-Flash 被写
  // 成 glm-5.3-flash 后整条链路走不通）。建 Map 时统一小写键，查找也用小写。
  const rawList = catalog instanceof Map ? Array.from(catalog.values()) : (catalog ?? [])
  const byId = new Map(rawList.map(entry => [String(entry?.id ?? '').toLowerCase(), entry]))
  const tried = new Set()
  const test = id => {
    if (typeof id !== 'string' || id === '') return undefined
    const key = id.toLowerCase()
    if (tried.has(key)) return undefined
    tried.add(key)
    return byId.get(key)
  }
  const model = String(member.model ?? '')
  const provider = String(member.provider ?? '').trim()
  let entry = test(model)
  if (entry !== undefined) return entry
  if (member.legacy !== null && typeof member.legacy === 'object') {
    const legacyProvider = String(member.legacy.provider ?? '').trim()
    const legacyModel = String(member.legacy.model ?? '').trim()
    entry = test(legacyModel)
    if (entry !== undefined) return entry
    if (legacyProvider !== '' && legacyModel !== '' && !legacyModel.includes('/')) {
      entry = test(`${legacyProvider}/${legacyModel}`)
      if (entry !== undefined) return entry
    }
  }
  // 面板按宿主目录拼出来的坐标会带 adapter 路由名（`our-free-model/<目录 id>`）。
  // 目录 id 本身形态各异：免费车道是裸名，Kilo 是 `org/model:free`，聚合渠道是
  // `provider/model`；统一剥掉这一层再精确匹配。
  const alias = [...ADAPTER_ROUTE_ALIASES].find(name => model.toLowerCase().startsWith(`${name}/`.toLowerCase()))
  if (alias !== undefined) {
    entry = test(model.slice(alias.length + 1))
    if (entry !== undefined) return entry
  }
  if (provider !== '' && model.toLowerCase().startsWith(`${provider}/${provider}/`.toLowerCase())) {
    entry = test(model.slice(provider.length + 1))
    if (entry !== undefined) return entry
  }
  if (provider !== '' && !model.includes('/') && !model.includes(':')) {
    entry = test(`${provider}/${model}`)
    if (entry !== undefined) return entry
  }
  if (provider !== '') {
    const tail = id => String(id ?? '').slice(String(id ?? '').lastIndexOf('/') + 1).toLowerCase()
    const wanted = tail(model)
    if (wanted !== '') {
      for (const row of byId.values()) {
        if (String(row.provider ?? '').trim().toLowerCase() !== provider.toLowerCase()) continue
        if (tail(row.id) === wanted) return row
      }
    }
  }
  // 找不到就不猜：同名模型在不同 provider 下是两份完全不同的额度
  // （loomy/GLM-5.3-Flash 与 codearts 的同名模型换不得）。真失效的成员由
  // 面板的「修复失效成员」显式处理，用户看得到改了什么。
  return undefined
}

function normalizeMember(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const rawModel = String(raw.model ?? raw.modelId ?? '').trim()
  if (rawModel === '' || rawModel.length > 160) return null
  const provider = String(raw.provider ?? '').trim().slice(0, 40)
  // 目录 id 的约定是 `provider/model`。旧数据/手写文件只给裸模型名 + provider
  // 时在这里补齐；已经是复合 id 的不动（`doubao/person-...` 那种双前缀写法）。
  // 带冒号的虚拟 id（`combo:xxx` / `route:xxx`）不能被拼前缀。
  //
  // ⚠️ adapter 路由名（`our-free-model` 等）也不能补：免费车道的目录 id 就是裸名，
  // 补成 `our-free-model/<裸名>` 会永远匹配不上目录。
  const model = !rawModel.includes('/') && !rawModel.includes(':') && provider !== ''
    && !ADAPTER_ROUTE_ALIASES.has(provider)
    ? `${provider}/${rawModel}` : rawModel
  const priority = Number.isFinite(Number(raw.priority))
    ? Math.min(999, Math.max(0, Math.trunc(Number(raw.priority))))
    : DEFAULT_PRIORITY
  const effort = typeof raw.effort === 'string' ? raw.effort.trim().slice(0, 24) : ''
  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 80) : ''
  const windows = normalizeWindows(raw.windows)
  const member = {
    model,
    ...provider === '' ? {} : { provider },
    priority,
    ...effort === '' ? {} : { effort },
    ...windows.length > 0 ? { windows } : {},
    ...raw.disabled === true ? { disabled: true } : {},
    ...note === '' ? {} : { note },
  }
  // 迁移时留下原始坐标；面板显示"原 loomy/GLM-5.3-Flash"，排查映射问题用。
  if (raw.legacy !== null && typeof raw.legacy === 'object') {
    member.legacy = {
      provider: String(raw.legacy.provider ?? '').slice(0, 40),
      model: String(raw.legacy.model ?? '').slice(0, 120),
    }
  }
  return member
}

function normalizeGroup(raw, taken) {
  if (raw === null || typeof raw !== 'object') return null
  const name = String(raw.name ?? '').trim().slice(0, 40)
  if (name === '') return null
  const rawId = String(raw.id ?? '').trim()
  let id = /^route:[a-z0-9][a-z0-9-]{0,39}$/.test(rawId) ? rawId : groupIdOf(name, taken)
  if (taken.has(id)) id = groupIdOf(name, taken)
  // 旧插件的 uuid 不是我们的 id，但迁移/回查需要留着。
  const legacySourceId = /^route:/.test(rawId) ? '' : rawId
  const seen = new Set()
  const models = []
  for (const item of Array.isArray(raw.models) ? raw.models : []) {
    const member = normalizeMember(item)
    if (member === null) continue
    if (seen.has(member.model)) continue
    seen.add(member.model)
    models.push(member)
    if (models.length >= MAX_MEMBERS) break
  }
  const group = {
    id,
    name,
    enabled: raw.enabled !== false,
    models,
  }
  if (typeof raw.importedFrom === 'string' && raw.importedFrom !== '') {
    group.importedFrom = raw.importedFrom.slice(0, 60)
  }
  if (typeof raw.legacyId === 'string' && raw.legacyId !== '') {
    group.legacyId = raw.legacyId.slice(0, 60)
  } else if (legacySourceId !== '') {
    group.legacyId = legacySourceId.slice(0, 60)
  }
  return group
}

/**
 * 归一化整份分组表（数组，或 `{groups: []}` 的旧包装）。
 *
 * 幂等：`normalizeGroups(normalizeGroups(x))` 结果一致，迁移脚本与面板保存
 * 走同一条路径，不必写两套校验。
 *
 * @param {unknown} raw
 * @param {{catalog?: object[]|Map<string, object>}} [options]
 * @returns {object[]}
 */
export function normalizeGroups(raw, { catalog } = {}) {
  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.groups) ? raw.groups : []
  const taken = new Set()
  const groups = []
  for (const item of list) {
    const group = normalizeGroup(item, taken)
    if (group === null) continue
    taken.add(group.id)
    // 目录里已不存在的成员保留（迁移数据不能丢），只在投影与候选中跳过；
    // 顺手把 provider 补上，面板显示得更完整。
    for (const member of group.models) {
      if (member.provider !== undefined) continue
      const entry = memberEntry(member, catalog ?? [])
      if (entry?.provider !== undefined) member.provider = entry.provider
    }
    groups.push(group)
    if (groups.length >= MAX_GROUPS) break
  }
  return groups
}

/**
 * 把「目录里能解析、但存的是旧坐标」的成员改写为当前目录 id。
 *
 * 只改能唯一解析的：`memberEntry` 的尾段兜底已经保证不会跨 provider 猜错。
 * 解析不到的成员原样保留并进 `unresolved`，由面板提示用户删掉或换掉——静默
 * 删除会把用户精心排的优先级顺序也一起丢掉。
 *
 * @param {object[]} groups - normalize 过的分组
 * @param {object[]|Map<string, object>} catalog
 * @returns {{groups: object[], changed: number, unresolved: object[]}}
 */
export function remapGroups(groups, catalog) {
  const byId = catalog instanceof Map ? catalog : new Map((catalog ?? []).map(entry => [entry.id, entry]))
  let changed = 0
  const unresolved = []
  const next = (Array.isArray(groups) ? groups : []).map(group => ({
    ...group,
    models: (Array.isArray(group.models) ? group.models : []).map(member => {
      const entry = memberEntry(member, byId)
      if (entry === undefined) {
        unresolved.push({ group: group.id, model: member.model, provider: member.provider ?? '' })
        return member
      }
      if (member.model === entry.id && (member.provider ?? '') === (entry.provider ?? '') && member.legacy === undefined) {
        return member
      }
      changed += 1
      const patched = { ...member, model: entry.id }
      if (entry.provider !== undefined) patched.provider = entry.provider
      delete patched.legacy
      return patched
    }),
  }))
  return { groups: next, changed, unresolved }
}

/** 组内按优先级排序（同优先级保持声明顺序）。 */
export function orderMembers(group) {
  return [...(group?.models ?? [])]
    .map((member, index) => ({ member, index }))
    .sort((a, b) => (a.member.priority ?? DEFAULT_PRIORITY) - (b.member.priority ?? DEFAULT_PRIORITY) || a.index - b.index)
    .map(item => item.member)
}

/**
 * 把一个分组投影成一个虚拟目录项。
 *
 * 容量取组内容量的最小值：路由组不能承诺比它最弱的成员更多——选择器里显示
 * 的 1M 窗口如果实际落到 200K 的成员上，用户会看到"超出上下文"却没提示。
 * 思考菜单不投影（`reasoning: false`）：组内模型一半有菜单一半是 token 阶梯，
 * 统一成一个菜单只会把"真实档位"藏起来；成员自己的 `effort` 才是发放时的控制。
 *
 * @param {object[]} groups
 * @param {object[]} catalog
 * @param {{provider?: string}} [options]
 *   `provider` 是分组虚拟行的 adapter 路由名 —— 选择器按它分组，入口传自己的
 *   路由名（`ROUTE_GROUPS`），分组才不会被画进「免费模型」那一组。
 * @returns {object[]}
 */
export function buildGroupRows(groups, catalog, { provider = GROUP_CHANNEL } = {}) {
  const byId = new Map((catalog ?? []).map(entry => [entry.id, entry]))
  const rows = []
  for (const group of groups) {
    if (group.enabled === false) continue
    const members = orderMembers(group).filter(member => member.disabled !== true)
    // 与候选解析共用同一套映射兜底：迁移数据里的双前缀/裸名必须能投影成行，
    // 否则选择器里根本不会出现这个分组（即使运行时能解析出候选）。
    const resolved = members
      .map(member => memberEntry(member, byId))
      .filter(entry => entry !== undefined && entry.channel !== 'combo' && entry.channel !== 'route')
    if (resolved.length === 0) continue
    const windows = resolved.map(entry => Number(entry.contextWindow)).filter(n => Number.isFinite(n) && n > 0)
    const outputs = resolved.map(entry => Number(entry.maxOutput)).filter(n => Number.isFinite(n) && n > 0)
    rows.push({
      id: group.id,
      name: group.name,
      channel: GROUP_CHANNEL,
      group: group.id,
      modelId: group.id,
      provider,
      vision: resolved.every(entry => entry.vision === true),
      reasoning: false,
      contextWindow: windows.length > 0 ? Math.min(...windows) : 131072,
      maxOutput: outputs.length > 0 ? Math.min(...outputs) : 32768,
      wire: 'chat',
      memberIds: resolved.map(entry => entry.id),
      groupMembers: resolved.length,
    })
  }
  return rows
}

/**
 * 发放时真正可用的候选。
 *
 * 四道门按顺序过：禁用 → 目录里没有 → 时段外 → 当日失败。返回的 `skipped`
 * 带着每条的理由，面板的"为什么这次没走 A"与最终错误信息都用它。
 *
 * @param {object} group
 * @param {object} input
 * @param {object[]|Map<string, object>} input.catalog
 * @param {Set<string>} [input.failedKeys]
 * @param {number} [input.hour]
 * @param {{isFull?: (model: string) => boolean, cooldownUntil?: (model: string) => number}} [input.gate]
 * @returns {{candidates: Array<{entry: object, member: object}>, skipped: Array<{model: string, reason: string, detail: string}>, allFailed: boolean}}
 */
export function resolveGroupCandidates(group, { catalog, failedKeys, hour, gate, now = Date.now() } = {}) {
  const byId = catalog instanceof Map ? catalog : new Map((catalog ?? []).map(entry => [entry.id, entry]))
  const candidates = []
  const skipped = []
  let failedCount = 0
  for (const member of orderMembers(group)) {
    const entry = memberEntry(member, byId)
    if (member.disabled === true) {
      skipped.push({ model: member.model, reason: 'disabled', detail: '成员被禁用' })
      continue
    }
    if (entry === undefined) {
      skipped.push({ model: member.model, reason: 'missing', detail: '目录里没有这个模型（渠道未登录或模型已下架）' })
      continue
    }
    // 虚拟行不能当分组成员：combo 需要自己的走链器，route 会递归，pool 是
    // 整条转发链的入口（把它当成员会再吞一次候选表并在池内二次换人）。
    if (entry.channel === 'combo' || entry.channel === 'route' || entry.channel === 'pool') {
      skipped.push({ model: member.model, reason: 'virtual', detail: '组合链/分组/转发池不能作为另一个分组的成员' })
      continue
    }
    if (!windowActive(member.windows, hour)) {
      skipped.push({ model: member.model, reason: 'window', detail: '不在成员设定的时段内' })
      continue
    }
    if (failedKeys?.has(entry.id) === true) {
      failedCount += 1
      skipped.push({ model: member.model, reason: 'failed', detail: '今日已熔断（可在分组面板重置）' })
      continue
    }
    if (gate?.isFull?.(entry.id) === true) {
      skipped.push({ model: member.model, reason: 'busy', detail: '并发已满，本次不排队' })
      continue
    }
    if (typeof gate?.cooldownUntil === 'function' && gate.cooldownUntil(entry.id) > now) {
      skipped.push({ model: member.model, reason: 'cooling', detail: '限流冷却中' })
      continue
    }
    candidates.push({ entry, member })
  }
  return {
    candidates,
    skipped,
    allFailed: candidates.length === 0 && failedCount > 0 && skipped.every(item => item.reason === 'failed' || item.reason === 'disabled'),
  }
}

/** 面板用：成员在目录里的可用性、当日熔断、并发读数。 */
export function describeGroup(group, { catalog, failedKeys, gate, bindings } = {}) {
  const byId = catalog instanceof Map ? catalog : new Map((catalog ?? []).map(entry => [entry.id, entry]))
  return {
    id: group.id,
    name: group.name,
    enabled: group.enabled !== false,
    legacyId: group.legacyId ?? '',
    importedFrom: group.importedFrom ?? '',
    bindings: (bindings ?? []).filter(binding => binding.group === group.id).length,
    models: orderMembers(group).map(member => {
      const entry = memberEntry(member, byId)
      return {
        ...member,
        // 目录里真正命中的 id（迁移数据可能是双前缀/裸名，面板要用它重置熔断）。
        id: entry?.id ?? member.model,
        available: entry !== undefined,
        name: entry?.name ?? member.model,
        failed: entry !== undefined ? failedKeys?.has(entry.id) === true : false,
        inflight: entry !== undefined ? gate?.inflight(entry.id) ?? 0 : 0,
        contextWindow: entry?.contextWindow ?? 0,
        // 面板要把「成员档位」做成下拉：只给旧词汇的话用户只能背 id，而且改错
        // 了也不会有人告诉他。这里把该模型真实认的档位一起投影出去。
        efforts: Array.isArray(entry?.efforts) && entry.efforts.length > 0
          ? entry.efforts.map(level => String(level))
          // 免费车道的 token 阶梯是我们自己的三档；别的渠道（`channel: 'host'`）
          // 没有声明就只给「跟随会话」，不能把我们的档位名安到人家头上。
          : entry?.reasoning === true && entry?.channel !== 'host' ? ['light', 'balanced', 'deep'] : [],
        effortDefault: typeof entry?.effortDefault === 'string' ? entry.effortDefault : undefined,
      }
    }),
  }
}

/**
 * 一行的可读描述，日志与错误信息共用。
 *
 * 例：`主力：codearts/glm-5.3-flash(10) → loomy/GLM-5.3-Flash(15)`
 */
export function describeGroupLine(group) {
  const members = orderMembers(group)
  const body = members.map(member => `${member.model}(${member.priority})`).join(' → ')
  return `${group.name}：${body === '' ? '（空组）' : body}`
}
