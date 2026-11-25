import fs from 'node:fs'
import path from 'node:path'
import { dayKey } from '../store.js'
import { describeGroup, normalizeGroups } from './groups.js'

/**
 * 路由分组的持久化。
 *
 * 三份文件，与 `model-failover-manager` 同名同形，迁移就是一次字段映射：
 *
 * - `route/groups.json`：数组，`[{id, name, enabled, models:[{provider, model, priority, effort, windows, disabled}]}]`
 * - `route/failed.json`：当日熔断，`[{key, day, count, provider, model, code, reason, at}]`
 * - `route/session-bindings.json`：旧绑定记录，只作迁移/展示；真正"会话粘性"由
 *   宿主记住用户在选择器里选的 `route:xxx` 完成，我们不再维护一份会过期的副本。
 *
 * `metrics.json` 刻意不迁（2MB 历史统计，我们有自己的 token-ledger）。
 */

const FAILED_KEEP_MS = 48 * 60 * 60 * 1000

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed ?? fallback
  } catch {
    // 读不出来的文件不删：备份一份，后续保存会写新文件，旧内容仍可手工翻。
    try {
      if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`)
    } catch { /* 家目录不可写不是这个文件的问题 */ }
    return fallback
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, undefined, 2), { mode: 0o600 })
  fs.renameSync(temp, file)
}

function asArray(value) {
  return Array.isArray(value) ? value : Array.isArray(value?.groups) ? value.groups : []
}

/** 旧目录（`~/.dsh/model-failover-manager`）的路径与文件探测。 */
function legacyState(home) {
  const dir = path.join(home, 'model-failover-manager')
  return {
    dir,
    groups: path.join(dir, 'groups.json'),
    bindings: path.join(dir, 'session-bindings.json'),
    failed: path.join(dir, 'failed.json'),
    settings: path.join(dir, 'settings.json'),
    exists: fs.existsSync(dir),
  }
}

/**
 * 把旧 `provider/model` 映射成我们目录里的 id。
 *
 * 本机的旧数据几乎都能直接命中（渠道 id 一致），所以顺序是：
 * 1. `model` 本身已是完整 id（旧数据里 doubao 那种 `doubao/xxx` 写法）；
 * 2. `provider/model` 拼起来就是 id；
 * 3. 裸 id 忽略大小写、按 provider 找同名模型；
 * 4. 全目录唯一同名模型（最后兜底，宁可映射也不要丢配置）。
 */
export function mapLegacyModel(provider, model, catalog) {
  const entries = Array.isArray(catalog) ? catalog : []
  const byId = new Map(entries.map(entry => [String(entry.id).toLowerCase(), entry]))
  const wanted = String(model ?? '').trim()
  const owner = String(provider ?? '').trim()
  if (wanted === '') return undefined
  const direct = byId.get(wanted.toLowerCase())
  if (direct !== undefined) return direct
  const composite = byId.get(`${owner}/${wanted}`.toLowerCase())
  if (composite !== undefined) return composite

  const base = wanted.includes('/') ? wanted.split('/').pop() : wanted
  const inProvider = entries.find(entry => String(entry.provider ?? '').toLowerCase() === owner.toLowerCase()
    && String(entry.modelId ?? '').toLowerCase() === base.toLowerCase())
  if (inProvider !== undefined) return inProvider
  // 不做"全目录唯一同名"兜底：同一模型常被多家渠道同时提供，跨 provider 猜错
  // 会把用户明确指定的一条成员悄悄换成另一家的模型（旧数据里 `codearts/x`
  // 变成 `trae/x`），宁可不匹配、在面板里标成"目录里没有"。
  return undefined
}

/**
 * @param {object} input
 * @param {string} input.dataDir - `~/.dsh/our-free-model`
 * @param {string} input.home - `~/.dsh`
 * @param {object} [input.logger]
 * @param {() => object[]} [input.catalog] - 目录构建完成后再映射（懒读）
 */
export function createRouteStore({ dataDir, home, logger, catalog } = {}) {
  const dir = path.join(dataDir, 'route')
  const groupsFile = path.join(dir, 'groups.json')
  const failedFile = path.join(dir, 'failed.json')
  const bindingsFile = path.join(dir, 'session-bindings.json')
  const legacy = legacyState(home)
  let catalogOf = () => (typeof catalog === 'function' ? catalog() : catalog) ?? []

  let groups = []
  let failed = []
  let bindings = []
  let importedAt = 0
  let importedFrom = ''

  if (fs.existsSync(groupsFile)) {
    // 构造时目录可能还没建好（运行时在同一个 apply 里稍后才创建），所以这里
    // 只做纯结构归一化；`provider` 由 `attachCatalog` 之后的第一次保存/展示补。
    groups = normalizeGroups(readJson(groupsFile, []))
  }
  if (fs.existsSync(failedFile)) failed = normalizeFailed(readJson(failedFile, []))
  if (fs.existsSync(bindingsFile)) {
    bindings = asArray(readJson(bindingsFile, [])).filter(item => typeof item?.sessionId === 'string' && typeof item?.groupId === 'string')
  }

  function normalizeFailed(raw) {
    const today = dayKey()
    const out = []
    for (const item of asArray(raw)) {
      if (typeof item?.key !== 'string' || item.key === '') continue
      if (item.day !== today) continue
      if (Number.isFinite(Number(item.at)) && Date.now() - Number(item.at) > FAILED_KEEP_MS) continue
      out.push({
        key: item.key,
        day: today,
        count: Math.max(1, Math.trunc(Number(item.count) || 1)),
        ...typeof item.provider === 'string' && item.provider !== '' ? { provider: item.provider } : {},
        ...typeof item.model === 'string' && item.model !== '' ? { model: item.model } : {},
        ...typeof item.group === 'string' && item.group !== '' ? { group: item.group } : {},
        ...typeof item.code === 'string' && item.code !== '' ? { code: item.code } : {},
        ...typeof item.reason === 'string' && item.reason !== '' ? { reason: item.reason } : {},
        at: Number(item.at) || Date.now(),
      })
    }
    return out
  }

  function persistGroups() {
    writeJson(groupsFile, groups)
  }

  function persistFailed() {
    writeJson(failedFile, failed)
  }

  function persistBindings() {
    writeJson(bindingsFile, bindings)
  }

  function refreshFailed() {
    const today = dayKey()
    const before = failed.length
    failed = failed.filter(item => item.day === today && Date.now() - item.at <= FAILED_KEEP_MS)
    if (failed.length !== before) persistFailed()
  }

  /**
   * 一次性迁移旧插件的配置。
   *
   * 默认只在 `groups.json` 不存在时自动跑（`force: false`）；面板上的"重新导入"
   * 用 `force: true`，它会先备份现有 groups，再覆盖——旧文件不会被无声吞掉。
   */
  function importLegacy({ force = false } = {}) {
    if (!legacy.exists) return { imported: false, reason: '旧插件的数据目录不存在' }
    if (groups.length > 0 && !force) return { imported: false, reason: '已有分组数据（需要强制导入请传 force）' }
    const legacyGroups = asArray(readJson(legacy.groups, []))
    if (legacyGroups.length === 0) return { imported: false, reason: '旧插件没有分组配置' }

    const mapped = []
    const legacyIdToName = new Map()
    for (const old of legacyGroups) {
      const name = String(old?.name ?? '').trim()
      if (name === '') continue
      legacyIdToName.set(String(old.id ?? ''), name)
      const models = []
      for (const member of Array.isArray(old.models) ? old.models : []) {
        const legacyProvider = String(member?.provider ?? '').trim()
        const legacyModel = String(member?.model ?? '').trim()
        if (legacyModel === '') continue
        const entry = mapLegacyModel(legacyProvider, legacyModel, catalogOf())
        models.push({
          model: entry?.id ?? `${legacyProvider}/${legacyModel}`,
          provider: entry?.provider ?? legacyProvider,
          priority: member.priority,
          effort: member.effort,
          windows: member.windows,
          disabled: member.disabled,
          legacy: { provider: legacyProvider, model: legacyModel },
          ...entry === undefined ? { note: '迁移：目录里没有这个模型（渠道未启用）' } : {},
        })
      }
      mapped.push({
        name,
        enabled: old?.enabled !== false,
        models,
        importedFrom: 'model-failover-manager',
        legacyId: String(old?.id ?? ''),
      })
    }
    if (mapped.length === 0) return { imported: false, reason: '旧分组为空' }

    if (groups.length > 0) {
      try {
        writeJson(path.join(dir, `groups.before-import-${Date.now()}.json`), groups)
      } catch (error) {
        logger?.warn?.(`our-free-model: could not back up route groups before import (${error?.message ?? error})`)
      }
    }
    groups = normalizeGroups(mapped, { catalog: catalogOf() })
    persistGroups()

    // 绑定按旧组名对齐；`mode` 保留，只作参考。
    const legacyBindings = asArray(readJson(legacy.bindings, []))
    const groupByName = new Map(groups.map(group => [group.name, group.id]))
    bindings = legacyBindings.map(item => {
      const name = legacyIdToName.get(String(item?.groupId ?? '')) ?? ''
      const target = groupByName.get(name)
      if (target === undefined) return null
      return {
        sessionId: String(item.sessionId),
        group: target,
        mode: typeof item.mode === 'string' ? item.mode : 'route',
        explicit: item.explicit === true,
        legacyGroupId: String(item.groupId ?? ''),
      }
    }).filter(item => item !== null)
    if (bindings.length > 0) persistBindings()

    // 当日熔断：key 本身就是目录 id 时直接沿用，否则按 provider/model 再映射一次。
    const legacyFailed = asArray(readJson(legacy.failed, []))
    const today = dayKey()
    failed = []
    for (const item of legacyFailed) {
      if (item?.day !== today) continue
      const key = String(item.key ?? '')
      const provider = String(item.provider ?? '')
      const model = String(item.model ?? '')
      const entry = catalogOf().find(candidate => candidate.id === key)
        ?? mapLegacyModel(provider, model, catalogOf())
      failed.push({
        key: entry?.id ?? key,
        day: today,
        count: Math.max(1, Math.trunc(Number(item.count) || 1)),
        ...provider === '' ? {} : { provider },
        ...model === '' ? {} : { model },
        ...typeof item.code === 'string' && item.code !== '' ? { code: item.code } : {},
        ...typeof item.reason === 'string' && item.reason !== '' ? { reason: item.reason } : {},
        at: Number(item.at) || Date.now(),
      })
    }
    if (failed.length > 0) persistFailed()

    importedAt = Date.now()
    importedFrom = legacy.dir
    return {
      imported: true,
      groups: groups.length,
      members: groups.reduce((sum, group) => sum + group.models.length, 0),
      bindings: bindings.length,
      failed: failed.length,
      legacySettings: readJson(legacy.settings, {}) ?? {},
    }
  }

  // 首次启动的自动迁移延后到 `autoImport()`：映射需要完整目录，而目录通常在
  // 本模块构造之后才建好（见 index.js 的装配顺序）。
  return {
    dir,
    /** 运行时建好目录后接上；迁移与保存用它补 provider / 映射旧 id。 */
    attachCatalog(getter) {
      catalogOf = () => (typeof getter === 'function' ? getter() : getter) ?? []
      // 给已加载的成员补 provider（不改文件，只影响展示与后续保存）。
      for (const group of groups) {
        for (const member of group.models) {
          if (member.provider !== undefined) continue
          const entry = catalogOf().find(candidate => candidate.id === member.model)
          if (entry?.provider !== undefined) member.provider = entry.provider
        }
      }
    },

    /**
     * 旧插件还在、我们还没有分组 → 直接接手它的配置。
     *
     * 返回 `importLegacy()` 的结果（没导入时 `imported: false` 带原因）。
     */
    autoImport() {
      if (groups.length > 0 || !legacy.exists) return { imported: false }
      return importLegacy()
    },

    get groups() {
      return groups
    },

    /** 保存整份分组表；返回归一化后的结果（面板直接用它刷新）。 */
    saveGroups(raw) {
      groups = normalizeGroups(raw, { catalog: catalogOf() })
      persistGroups()
      return groups
    },

    /** 当日失败的 key 集合（目录 id）。 */
    failedKeys() {
      refreshFailed()
      return new Set(failed.map(item => item.key))
    },

    failed() {
      refreshFailed()
      return failed
    },

    isFailed(key) {
      if (!key) return false
      refreshFailed()
      return failed.some(item => item.key === key)
    },

    /**
     * 记一次失败。
     *
     * 同一模型同一天只累计 `count`，不重复插入——面板显示"3 次"比三行同样的
     * 记录有用得多，`failed.json` 也不会随轮次膨胀。
     */
    markFailed(member, failure = {}) {
      if (!member?.model) return
      refreshFailed()
      const today = dayKey()
      const existing = failed.find(item => item.key === member.model)
      if (existing !== undefined) {
        existing.count += 1
        existing.at = Date.now()
        if (typeof failure.code === 'string' && failure.code !== '') existing.code = failure.code
        if (typeof failure.reason === 'string' && failure.reason !== '') existing.reason = failure.reason
      } else {
        failed.push({
          key: member.model,
          day: today,
          count: 1,
          ...member.provider === undefined ? {} : { provider: member.provider },
          model: member.model,
          ...typeof failure.group === 'string' && failure.group !== '' ? { group: failure.group } : {},
          ...typeof failure.code === 'string' && failure.code !== '' ? { code: failure.code } : {},
          ...typeof failure.reason === 'string' && failure.reason !== '' ? { reason: failure.reason } : {},
          at: Date.now(),
        })
      }
      persistFailed()
    },

    /** 成功一次就解除当日的熔断：模型恢复了，没必要等到零点。 */
    clearFailed(key) {
      if (!key) return false
      const before = failed.length
      failed = failed.filter(item => item.key !== key)
      if (failed.length === before) return false
      persistFailed()
      return true
    },

    resetFailed(key) {
      if (key === undefined || key === null || key === '') {
        failed = []
        persistFailed()
        return 0
      }
      return this.clearFailed(String(key)) ? 1 : 0
    },

    bindings() {
      return bindings
    },

    importLegacy,

    /** 面板完整读数。 */
    status({ catalog: list, gate } = {}) {
      refreshFailed()
      const failedKeys = new Set(failed.map(item => item.key))
      return {
        dir,
        groups: groups.map(group => describeGroup(group, {
          catalog: list ?? catalogOf(),
          failedKeys,
          gate,
          bindings,
        })),
        failed,
        bindings,
        legacy: {
          dir: legacy.dir,
          available: legacy.exists,
          importedAt,
          importedFrom,
          settings: readJson(legacy.settings, {}) ?? {},
        },
      }
    },
  }
}
