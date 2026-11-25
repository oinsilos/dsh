import fs from 'node:fs'
import path from 'node:path'
import { FreeModelAdapter, ROUTE_MAIN, ROUTE_REGION } from '../adapter.js'
import { buildCatalog, buildEacCatalog, buildKiloCatalog, isEacEntry, isKiloEntry, parseListing, reviveKiloCatalog } from '../catalog.js'
import { buildAggregateCatalog, isAggregateEntry } from '../aggregate.js'
import { buildComboCatalog, isComboEntry, normalizeCombos, pruneRotation } from '../combos.js'
import { buildGroupRows, isRouteEntry } from '../route/groups.js'
import { buildOwnCatalog } from '../channels/catalog.js'
import { JsonStore, SETTINGS_INITIAL, STATS_INITIAL, STATS_VERSION, migrateStats, pruneDays, recordTurn, recordUsage } from '../store.js'
import { STATE, detectEgress, probeCatalog } from '../probe.js'
import { CODE, getJson } from '../http.js'
import { fetchSealedListing } from '../eac.js'
import { fetchKiloListing } from '../kilo.js'
import { mintRequestId, sessionForConversation } from '../upstream.js'
import { createForwardCompletion, publicModelRows } from './completion.js'

const FALLBACK_CATALOG = buildCatalog([
  'mimo-v2.6-flash-free', 'mimo-v2.5-free', 'ling-3.0-flash-fin-free',
  'nemotron-3-ultra-free', 'nemotron-3.5-lightning-free', 'space-bunny-free',
  'muse-spark-1.3-contributor-free', 'muse-spark-1.2-contributor-free',
])

/** 路径由产品入口决定；核心不解析 DSH_HOME，也不发现宿主服务。 */
export function createRuntimeStores({ dataDir, logger = console }) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) {
    throw new TypeError('dataDir must be an absolute path')
  }
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const open = (file, initial) => new JsonStore(path.join(dataDir, file), structuredClone(initial), {
    log: message => logger.warn?.(message),
  })
  const settings = open('settings.json', SETTINGS_INITIAL)
  const stats = open('stats.json', STATS_INITIAL)
  const availability = open('availability.json', { version: 1, at: 0, egress: null, results: {} })
  const catalogStore = open('catalog.json', { version: 1, at: 0, entries: FALLBACK_CATALOG.map(entry => entry.id) })
  if (stats.get().version !== STATS_VERSION) stats.edit(migrateStats)
  return {
    settings, stats, availability, catalogStore,
    dispose() {
      settings.dispose(); stats.dispose(); availability.dispose(); catalogStore.dispose()
    },
  }
}

/**
 * 两个产品共同使用的模型运行时。宿主仅注入能力，不传入 Cordis ctx。
 * 创建不启动网络任务；入口先绑定本地监听器，再决定何时刷新和探测。
 */
export function createModelRuntime({
  settings, stats, availability, catalogStore,
  logger = console,
  attributionUserAgent = 'our-free-model',
  resolveImage,
  sealedCredential = () => null,
  /** 自有渠道的凭据解析（provider → 凭据 JSON），由入口注入。 */
  ownCredential = async () => null,
  /** 路由分组：配置存储、并发闸门与分组读取（虚拟目录项的来源）。 */
  routeStore = null,
  gate = null,
  routeGroups = () => [],
  /**
   * 宿主 `llm.stream`，只用来把「别的渠道」的分组成员转发出去。
   * 入口注入的是懒闭包：llm 服务可能在运行时创建之后才可见。
   */
  hostStream = null,
  onSealedUnavailable = () => {},
  onTopology = () => {},
}) {
  let catalog = materializeCatalog(catalogStore.get().entries ?? [])
  // EAC 协付车道已摘除：网关服务端不再提供登录与模型接口（全部路由 404），
  // 车道无法上线。保留空目录即可让模型选择器与面板都不再出现点不动的死模型。
  let sealedCatalog = []
  let kiloCatalog = reviveKiloCatalog(catalogStore.get().kiloRows)
  /** The aggregate lane: one row per enabled provider/model the user configured.
   *  Derived from settings, not from a listing, so it is rebuilt on every merge. */
  let aggregateCatalog = []
  /** 自有渠道（渠道包不认识的那些）：由入口喂进来，目录必须同步可读。 */
  let ownCatalog = []
  /** The virtual rows a combo contributes; rebuilt last, after every real lane. */
  let comboCatalog = []
  /** 路由分组投影出来的虚拟行（进 `catalog`，选择器里能选）。 */
  let routeCatalog = []
  /** 分组成员解析用的目录：本插件自己的行 + 宿主其它渠道的行。 */
  let routeMembers = []
  /**
   * 宿主目录里其它渠道的模型行 —— **只**给路由分组成员当候选，不进本插件的
   * 目录（否则这些模型会在选择器里出现两次，且都被算成我们的模型）。
   *
   * 分组要能像 model-failover-manager 一样覆盖全宿主的渠道，成员才不只是我们
   * 自己供给的那几十个；这类成员由 `runForeign` 用宿主 `llm.stream` 转发。
   */
  let hostCatalog = []
  /** The free lane's own roster: the base every other lane is merged onto. */
  let freeCatalog = catalog
  let egress = availability.get().egress ?? null
  let gatewayLatency = { ms: 0, at: 0 }
  let disposed = false
  const lifetime = new AbortController()
  let reprobeTimer

  /**
   * Rebuild the merged catalog from its parts, in precedence order.
   *
   * Rebuilt rather than appended to, because every one of these lists can shrink:
   * a provider the user switched off, a chain whose head was removed, a Kilo
   * model that went paid. Appending only ever grew the view, so a removed row
   * stayed dialable until the next full listing round happened to reset it.
   *
   * Combos come last on purpose — a chain's links have to already exist as real
   * rows, which is also what makes `buildComboCatalog` drop a link that is gone
   * instead of keeping a hopeful placeholder.
   */
  const rebuildCatalog = () => {
    const seen = new Set()
    const merged = []
    for (const entry of [...freeCatalog, ...sealedCatalog, ...kiloCatalog, ...aggregateCatalog, ...ownCatalog]) {
      if (entry === null || entry === undefined || seen.has(entry.id)) continue
      seen.add(entry.id)
      merged.push(entry)
    }
    const combos = normalizeCombos(settings.get().combos)
    comboCatalog = buildComboCatalog(combos, merged)
    pruneRotation(combos)
    for (const entry of comboCatalog) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      merged.push(entry)
    }
    // 分组排在最后：成员必须是上面已经成立的实模型行，否则组内会指向一个
    // 不存在的东西；`buildGroupRows` 自己会把空组/全失效组丢掉。宿主目录的
    // 行只在建组视图中参与（成员解析 + 投影），不并进 `catalog`。
    const groupCatalog = hostCatalog.length === 0
      ? merged
      : [...merged, ...hostCatalog.filter(row => !seen.has(row.id))]
    // `groups` 是投影出来的虚拟分组行（进 `catalog`），`routeMembers` 才是
    // 成员解析用的目录（含宿主其它渠道）。两者别混：分组行本身不能当成员。
    routeMembers = groupCatalog
    routeCatalog = buildGroupRows(routeGroups(), groupCatalog)
    for (const entry of routeCatalog) {
      if (seen.has(entry.id)) continue
      seen.add(entry.id)
      merged.push(entry)
    }
    catalog = merged
  }
  const mergeCatalogs = () => {
    aggregateCatalog = buildAggregateCatalog(settings.get().aggregate ?? {})
    rebuildCatalog()
  }
  mergeCatalogs()
  const state = () => ({
    catalog,
    routeCatalog: routeMembers,
    membership: computeMembership(catalog, availability.get(), settings.get()),
    settings: settings.get(),
    attributionUserAgent,
  })
  const emitTopology = () => { if (!disposed) onTopology() }
  const adapter = new FreeModelAdapter({
    state,
    resolveImage,
    sealedCredential,
    ownCredential,
    recordUsage: record => {
      if (disposed) return
      recordUsage(stats, record)
      stats.edit(value => pruneDays(value, 120))
    },
    recordTurn: record => { if (!disposed) recordTurn(stats, record) },
    routeStore,
    gate,
    routeGroups,
    hostStream,
    warn: message => logger.warn?.(message) ?? logger.log?.(message),
    onRegionBlocked: () => {
      if (disposed || reprobeTimer !== undefined) return
      reprobeTimer = setTimeout(() => {
        reprobeTimer = undefined
        if (!disposed) void refreshAvailability(true).catch(error => {
          logger.warn?.(`our-free-model: region reprobe failed (${error?.message ?? error})`)
        })
      }, 4000)
      reprobeTimer.unref?.()
    },
  })

  // 手动强制刷新不能借用一个因限流而跳过探测的普通刷新。
  let catalogRefresh = null
  let catalogRefreshForced = false
  let catalogRefreshProbed = false
  async function refreshCatalog(opts) {
    const { probe = true, force = false } = opts ?? {}
    if (disposed) return catalog
    while (catalogRefresh !== null) {
      const shared = catalogRefresh
      const sharedForced = catalogRefreshForced
      const sharedProbed = catalogRefreshProbed
      const value = await shared
      if (disposed || ((!force || sharedForced) && (!probe || sharedProbed))) return value
    }
    const run = refreshCatalogOnce({ probe, force })
    catalogRefresh = run
    catalogRefreshForced = force
    catalogRefreshProbed = probe
    try { return await run } finally {
      if (catalogRefresh === run) {
        catalogRefresh = null; catalogRefreshForced = false; catalogRefreshProbed = false
      }
    }
  }

  async function refreshCatalogOnce({ probe, force }) {
    let ids = []
    try {
      ids = parseListing(await fetchListing())
    } catch (error) {
      if (!disposed) logger.warn?.(`our-free-model: model listing refresh failed (${error?.message ?? error}); keeping the cached catalog`)
    }
    if (disposed) return catalog
    if (ids.length > 0) {
      freeCatalog = buildCatalog(ids)
      catalogStore.update({ at: Date.now(), entries: freeCatalog.map(entry => entry.id) })
      catalogStore.flush()
      settings.update({ catalogSyncedAt: Date.now() })
    } else {
      freeCatalog = materializeCatalog(catalogStore.get().entries ?? [])
    }
    await refreshSealedRoster()
    if (disposed) return catalog
    await refreshKiloRoster()
    if (disposed) return catalog
    mergeCatalogs()
    if (probe) await refreshAvailability(force)
    emitTopology()
    return catalog
  }

  async function refreshSealedRoster() {
    // 车道已摘除：不再向网关拉清单，也不再保留历史 sealIds。
    sealedCatalog = []
    if (Array.isArray(catalogStore.get().sealIds) && catalogStore.get().sealIds.length > 0) catalogStore.update({ sealIds: [] })
  }

  async function refreshSealedLane() {
    await refreshSealedRoster()
    if (disposed) return
    // The rebuild in `mergeCatalogs` drops a stale roster on its own: a closed
    // lane's rows vanish without a filter pass over the merged view.
    mergeCatalogs()
    emitTopology()
  }

  async function refreshKiloRoster() {
    try {
      const payload = await fetchKiloListing({ signal: lifetime.signal })
      if (disposed) return
      if (payload?.error || !Array.isArray(payload?.data)) throw new Error('invalid Kilo model listing')
      kiloCatalog = buildKiloCatalog(payload.data)
      catalogStore.update({ kiloRows: kiloCatalog })
    } catch (error) {
      if (!disposed) logger.warn?.(`our-free-model: Kilo channel listing failed (${error?.code ?? error?.message ?? 'unknown'}); keeping its cached roster`)
    }
  }

  async function fetchListing() {
    if (disposed) return { data: [] }
    const started = Date.now()
    const listing = await getJson('/zen/v1/models', {
      session: sessionForConversation('catalog:our-free-model'),
      requestId: mintRequestId(),
      attributionUserAgent,
      signal: lifetime.signal,
    })
    if (!disposed) gatewayLatency = { ms: Date.now() - started, at: Date.now() }
    return listing
  }

  let probeRound = null
  let probeThrottleStreak = 0
  let probeBackoffUntil = 0
  async function runProbeRound() {
    // The absorbed channels get no per-model probes: their verdicts would be
    // spent against a different gateway than the one that serves them, and a
    // roster the listing named is advertised as-is (its health is the listing
    // round's, refreshed on the same cadence). The aggregate lane is excluded
    // for a sharper reason — a probe there is a *real request to a provider the
    // user pays for*, spent to learn something the settings page already knows
    // (whether a key is configured). A combo is excluded because it has no
    // endpoint of its own: probing one would send the chain's own id to the free
    // lane as a model name, spending quota to collect a verdict about nothing.
    // 自有渠道不参与免费车道探活：它们的「模型 id」是 `provider/model` 形式，
    // 打到免费网关只会拿回 404，然后被 availability 记成 unavailable —— 结果是
    // 自有分组整组从 membership 消失（选择器空白）。它们是否有模型由目录/账号
    // 状态决定，见 `setOwnCatalog()`。
    const probeable = catalog.filter(entry => !isOwnRow(entry)
      && !isEacEntry(entry) && !isKiloEntry(entry) && !isAggregateEntry(entry) && !isComboEntry(entry)
      && !isRouteEntry(entry))
    const results = await probeCatalog(probeable, { attributionUserAgent, signal: lifetime.signal }, (id, result) => {
      if (disposed) return
      availability.edit(value => ({
        ...value,
        results: {
          ...value.results,
          [id]: {
            state: result.state,
            ...result.detail === undefined ? {} : { detail: result.detail },
            ...result.ttftMs === undefined ? {} : { ttftMs: result.ttftMs },
            latencyMs: result.latencyMs, at: Date.now(),
          },
        },
      }))
    }, 2)
    if (disposed) return {}
    availability.update({ at: Date.now(), egress })
    availability.flush()
    const verdicts = Object.values(results)
    if (verdicts.length > 0 && verdicts.every(row => row.state === STATE.unavailable)) {
      logger.warn?.(`our-free-model: the gateway refused all ${verdicts.length} models this round (${verdicts[0].detail ?? 'no detail'}); keeping them advertised`)
    }
    const allThrottled = verdicts.length > 0 && verdicts.every(row => row.state === STATE.throttled)
    probeThrottleStreak = allThrottled ? probeThrottleStreak + 1 : 0
    probeBackoffUntil = allThrottled
      ? Date.now() + Math.min(30 * 2 ** (probeThrottleStreak - 1), 120) * 60_000
      : 0
    if (allThrottled) {
      logger.warn?.(`our-free-model: the probe round hit the lane's quota; availability probes pause for ${Math.round((probeBackoffUntil - Date.now()) / 60_000)} minutes (your own requests are unaffected, and the reprobe button forces a round)`)
    }
    emitTopology()
    return results
  }
  async function refreshAvailability(force = false) {
    if (disposed || (!force && probeBackoffUntil > Date.now())) return {}
    if (probeRound !== null) return probeRound
    const round = runProbeRound()
    probeRound = round
    try { return await round } finally { if (probeRound === round) probeRound = null }
  }

  async function watchEgress() {
    if (disposed) return false
    const seen = await detectEgress({ signal: lifetime.signal })
    if (disposed || seen === undefined) return false
    const previous = availability.get().egress
    const changed = previous === null || previous === undefined
      || previous.ip !== seen.ip || (seen.country !== undefined && previous.country !== seen.country)
    egress = seen
    if (changed) {
      availability.update({ egress: seen })
      availability.flush()
      logger.info?.(`our-free-model: egress changed to ${seen.ip}${seen.country ? ` (${seen.country})` : ''}; re-probing availability`)
      await refreshAvailability(true)
    }
    return true
  }

  return {
    state, adapter, refreshCatalog, refreshSealedLane, refreshAvailability, watchEgress, fetchListing,
    complete: createForwardCompletion({ adapter, state, signal: lifetime.signal }),
    publicModelRows: () => publicModelRows(state()),
    // A settings write that changes the aggregate lane or the chains (a key
    // saved, a provider switched off, a combo edited) rebuilds the merged view
    // without a listing round: the aggregate rows come from settings alone.
    syncAggregateCatalog() {
      if (disposed) return catalog
      mergeCatalogs()
      emitTopology()
      return catalog
    },
    /** 路由分组保存后重建虚拟行（与会话选择器同步）。 */
    syncRouteCatalog() {
      if (disposed) return catalog
      rebuildCatalog()
      emitTopology()
      return catalog
    },
    /** 自有渠道的目录由入口提供（账号表 + 权益查询的缓存），变更后重建视图。 */
    setOwnCatalog(rows) {
      ownCatalog = Array.isArray(rows) ? rows : []
      if (disposed) return catalog
      rebuildCatalog()
      emitTopology()
      return catalog
    },
    /**
     * 宿主其它渠道的目录（只作分组成员候选）。入口按需刷新，变更后重建分组
     * 视图：已经失效的成员可能因此复活，也可能因为渠道下线而变回缺失。
     */
    setHostCatalog(rows) {
      hostCatalog = Array.isArray(rows) ? rows : []
      if (disposed) return catalog
      rebuildCatalog()
      emitTopology()
      return catalog
    },
    get catalog() { return catalog },
    get routeCatalog() { return routeMembers },
    get egress() { return egress },
    get gatewayLatency() { return gatewayLatency },
    setAttributionUserAgent(value) { attributionUserAgent = value },
    dispose() {
      if (disposed) return
      disposed = true
      lifetime.abort()
      clearTimeout(reprobeTimer)
    },
  }
}

function materializeCatalog(ids) {
  const rebuilt = buildCatalog(ids)
  return rebuilt.length > 0 ? rebuilt : FALLBACK_CATALOG
}

/**
 * 自有渠道行（`channel: 'own'` + `provider`）。
 *
 * 它们有各自的 adapter 路由与账号状态，**不属于免费车道**：既不能拿免费网关
 * 探活，也不能被免费车道的 availability 结论过滤（探活必然 404 → 整组消失）。
 */
function isOwnRow(entry) {
  return entry?.channel === 'own' && typeof entry.provider === 'string' && entry.provider !== ''
}

export function computeMembership(catalog, availabilitySnapshot, settings) {
  const results = availabilitySnapshot?.results ?? {}
  const expose = settings?.exposeRegionModels !== false
  const verdictOf = entry => results[entry.id]?.state
  const probeable = catalog.filter(entry => !entry.channel)
  const refusedAll = probeable.length > 0 && probeable.every(entry => verdictOf(entry) === STATE.unavailable)
  // 自有行永远进视图：availability.json 里可能还留着它们被误探活时写下的
  // `unavailable`，照单全收就会让 14 个分组一起从选择器里消失。
  const usable = refusedAll
    ? catalog
    : catalog.filter(entry => isOwnRow(entry) || verdictOf(entry) !== STATE.unavailable)
  const main = []
  const region = []
  /**
   * 自有渠道按**渠道**分组。
   *
   * 宿主的选择器是按 adapter 路由分组的（`listProviders()` → 每组一个标题），
   * 把 14 家自有渠道全塞进 `our-free-model` 这一个路由，结果是 80 个模型与免费
   * 车道混在同一组里 —— 用户分不清哪个模型来自哪个渠道，也没法整组收起。
   * 这里给每家一条路由（`provider` 字段就是路由名），标题由
   * `FreeModelAdapter.providerInfo()` 从 `OWN_LABELS` 取。
   */
  const own = {}
  for (const entry of usable) {
    if (isOwnRow(entry)) {
      ;(own[entry.provider] ??= []).push(entry.id)
      continue
    }
    if (verdictOf(entry) === STATE.regionBlocked) {
      if (expose) region.push(entry.id)
      continue
    }
    main.push(entry.id)
  }
  const membership = {}
  if (main.length > 0) membership[ROUTE_MAIN] = main
  if (region.length > 0) membership[ROUTE_REGION] = region
  for (const [provider, ids] of Object.entries(own)) membership[provider] = ids
  return membership
}
