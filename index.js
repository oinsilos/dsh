/**
 * Our Free Model — plugin entry (Host half).
 *
 * Wiring: one adapter instance, two provider routes (usable now / region-limited
 * on this egress), a live-catalog + availability-probe loop behind them, the
 * browser-facing JSON API the settings page reads, and the OpenAI-compatible
 * forward listener.
 *
 * On top of the model lane the plugin owns a small distribution channel of its
 * own: an announcement feed served from the local cache (an operator may point
 * `feedUrl` at one), an in-app updater whose discovery sources this build ships
 * without, and a self hot-reload that swaps the running plugin for the code now
 * on disk. All three report to the browser over one
 * Server-Sent-Events route, because the kernel has no notification service and
 * the settings page should not have to poll.
 *
 * Every harness facility is reached through `ctx`, and only the one the plugin
 * cannot exist without is declared in `inject`, so a composition that omits the
 * rest degrades a feature rather than failing the plugin: no web server means no
 * in-app dashboard, no attachments means image blocks fall back to the text
 * projection the runtime already performs. See `inject` below.
 *
 * @module index.js
 */

import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ROUTE_LABELS, ROUTE_MAIN, ROUTE_REGION } from './src/adapter.js'
import { DATA_DIR_NAME, JsonStore, decodeWindow, resolveDshHome } from './src/store.js'
import { isEacEntry, isKiloEntry } from './src/catalog.js'
import { STATE } from './src/probe.js'
import { generateKey, rankLanAddresses, startForwardServer, startLanRelay } from './src/forward.js'
import { chanGatewayCredential, chanGatewayEnabled, chanGatewayPort, startChanRelay } from './src/chan-relay.js'
import { CODE, UpstreamError } from './src/http.js'
import { egressActive, egressFetch, outletLabel, readOutletSelection, startEgressRelay } from './src/egress.js'
import { directFetch } from './src/eac.js'
import { clearEacUser, readEacUser, writeEacUser } from './src/eac-user.js'
import { createEacLoginPoller } from './src/eac-login.js'
import { unlockSealedLane } from './src/vault.js'
import { DEFAULT_LEVEL, budgetLadder } from './src/effort.js'
import { windowTokens } from './src/stream.js'
import { AnnouncementFeed } from './src/feed.js'
import { PluginUpdater } from './src/updater.js'
import { selfReload, watchPackage, isReloading } from './src/reload.js'
import { installChannelCatalogVisibility } from './src/channel-visibility.js'
import { createChannelExtras } from './src/channels/index.js'
import { createChannelAccounts, OWN_PROVIDERS } from './src/channels/accounts.js'
import { buildOwnCatalog } from './src/channels/catalog.js'
import { createDeviceLogin } from './src/channels/device-login.js'
import { createSmsLogin } from './src/channels/sms-login.js'
import { exchangeCode, startBrowserLogin } from './src/channels/accio.js'
import { MINIMAX_PRODUCTS, ensureMinimaxCredential } from './src/channels/minimax.js'
import { ensureMarvisCredential, exchangeMarvisCode, isMarvisCallbackUrl, marvisAuthorizeUrl } from './src/channels/marvis.js'
import {
  MAGICREW_HARVEST_EXPRESSION,
  completeMagicrewLogin,
  magicrewProductOf,
  parseMagicrewHarvest,
} from './src/channels/magicrew.js'
import { issueMonkeycodeKey, monkeycodeProductOf, sessionCookieOf } from './src/channels/monkeycode.js'
import { BAIZHI, exchangeBaizhiKey } from './src/channels/baizhi.js'
import { authorizeUrl as officeaceAuthorizeUrl, exchangeOfficeaceCode, generateDpopKey, pkcePair } from './src/channels/officeace-auth.js'
import { OFFICEACE } from './src/channels/officeace.js'
import { interceptCallback, startChromiumSession } from './src/channels/browser/chromium.js'
import { createPushHub } from './src/push.js'
import { rejectionFor, isLoopbackHost, connectionAdmissionView } from './src/trust.js'
import { resolveAttributionUserAgent } from './adapter/kernel.js'
import { buildAggregateCatalog, fetchProviderModels, isAggregateEntry, testProvider } from './src/aggregate.js'
import { buildComboCatalog, isComboEntry, normalizeCombos, pruneRotation } from './src/combos.js'
import { getProvider, listProviders } from './src/providers/index.js'
import { addSavings, describeSavingsTotal, emptySavings, saverConfig, savingsPercent } from './src/token-saver/index.js'
import { CAVEMAN_LEVELS, PONYTAIL_LEVELS } from './src/token-saver/prompts.js'
import { OPTIMIZATIONS } from './src/local-optimize.js'
import { createModelRuntime, createRuntimeStores } from './src/core/runtime.js'

export { fromOpenAiMessages } from './src/core/completion.js'
import { buildStats } from './src/core/stats.js'
export { buildStats }

export const name = 'our-free-model'

/** The installed package directory — the self-updater and hot reload operate here. */
const PKG_URL = new URL('./', import.meta.url)
const PKG_DIR = fileURLToPath(PKG_URL)
const ENTRY_URL = new URL('index.js', import.meta.url).href

/** Published version of the installed package, read once at load. */
function readPackageVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf8')).version ?? '')
  } catch {
    return ''
  }
}

// Bind the version to this module generation. Re-registering cached old exports
// after a failed reload must not pick up the new package.json still on disk.
export const version = readPackageVersion()

/**
 * Open a URL in the system browser, best effort. The settings page shows the
 * same URL with a copy button, so a headless host or a refused spawn costs a
 * paste, never the flow. The URL is always one this plugin built from the
 * sealed gateway endpoint — never user input.
 */
function openExternal(url) {
  if (!/^https?:\/\//i.test(url)) return false
  try {
    const [command, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]]
        : ['xdg-open', [url]]
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
    child.on('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/**
 * `llm` is what the plugin exists for, so it is the only hard requirement of the
 * plugin itself.
 *
 * Cordis withholds from a context any service its fiber does not name in
 * `inject`, and keeps that fiber PENDING while a named one is absent — which is
 * how v1.2.1 stayed permanently inactive on a composition with no HTTP server,
 * the surface issue #4 reported. So nothing else may be named here: a headless
 * composition would rather serve models without a settings page than serve
 * nothing.
 *
 * What that costs and what still works:
 * - `webServer` — the in-app dashboard and the SSE push channel. Reached through
 *   a nested `ctx.inject` fiber (see the browser-facing API section), which pends
 *   on its own and never blocks the lane above.
 * - `timer` (`ctx.interval`) — nothing. The background loops are plain unref'd
 *   timers (see `every`), because reading a mixin off an undeclared service
 *   throws rather than answering `undefined`.
 * - `connection`, `attachments` — one feature each: the fence falls back to its
 *   structural replica, image blocks to the text projection. Both are read with
 *   `ctx.get()`, which is the opportunistic lookup that answers `undefined`.
 */
export const inject = ['llm']

/** Where the plugin's own announcement copy lives; bump it to re-announce. */
export const ANNOUNCEMENT_VERSION = '2026-09-25.1'

/**
 * Who owns the plugin's bytes — the distribution mode:
 *
 * - `self` (default): the plugin updates itself from its repository, publishes
 *   its announcement feed, and hot-reloads, exactly as before.
 * - `managed`: the plugin arrived through a distribution pack (an EAC
 *   integration pack, a Mojobox install). The pack manager owns the bytes now,
 *   so the in-app updater, the announcement channel and the hot reload stand
 *   down — two writers to one installed directory is a corrupted install. The
 *   model lane is untouched; this is about who ships the code, not what it does.
 *
 * `config.distribution` (what a pack's bundle patch passes) outranks the
 * settings file, and the settings API never accepts the field back, so an
 * install that shipped managed stays managed.
 */
const MANAGED_MESSAGE = 'this installation is managed; updates are handled by the pack that installed it'

/** Effective distribution mode: config override first, then the settings file. */
function distributionOf(config, settings) {
  if (config?.distribution === 'managed' || settings.get().distribution === 'managed') return 'managed'
  return 'self'
}

export function apply(ctx, config) {
  const logger = ctx.logger ?? console
  const home = resolveDshHome()
  const dataDir = path.resolve(home, DATA_DIR_NAME)
  fs.mkdirSync(dataDir, { recursive: true })
  const packageVersion = version

  // A hot reload re-enters apply with fresh stores; the generation counter lives
  // on globalThis so the new instance knows it replaced a predecessor, and does
  // the post-swap bookkeeping itself (the old closure must not touch stores
  // after its own dispose — that would race the new instance's writes).
  const generation = (globalThis[Symbol.for('our-free-model.generation')] ?? 0) + 1
  globalThis[Symbol.for('our-free-model.generation')] = generation

  const stores = createRuntimeStores({ dataDir, logger })
  const { settings, stats, availability } = stores

  if (generation > 1) {
    settings.update({ reloadedAt: Date.now(), reloadCount: generation - 1 })
    settings.flush()
  }

  /** `managed` stands down everything that would rewrite the installed bytes. */
  const distribution = distributionOf(config, settings)
  const managed = distribution === 'managed'

  let forward = null
  let forwardError = ''
  // Non-fatal: the listener is up, but not where the settings asked for it.
  let forwardNotice = ''
  /** The optional LAN relay: a second door, with a key of its own. */
  let relay = null
  let relayError = ''
  /** The optional egress outlet (subscription or single client), off by
   *  default. Named `outlet*` so the `egress` IP/country snapshot stays clear. */
  let outletRelay = null
  let outletError = ''
  /** Last reading of the outlet's own view of itself, cached for `/summary`. */
  let outletNode = { node: '', delayMs: 0, at: 0 }

  // ── the co-paid lane ────────────────────────────────────────────────────────
  /**
   * The sealed lane is invisible until the host gate passes and the seal opens,
   * both re-checked per use. Its roster persists under `sealIds` in the catalog
   * store so a desktop restart offline still shows what it served last. A host
   * the gate refuses never exposes that list through the runtime, and no
   * entry or request of the lane is observable — but the
   * persisted list survives the refusal, and the refusal itself is logged, so
   * an empty EAC group has a reason in the log instead of silence.
   */
  const profileNameOf = () => {
    const context = typeof ctx.get === 'function' ? ctx.get('profileContext') : undefined
    return typeof context?.name === 'string' ? context.name : undefined
  }
  const sealedCredentialOf = () => unlockSealedLane({ profileName: profileNameOf() })

  // ── the pool snapshot (settings-page gauge) ─────────────────────────────────
  // The co-paid gateway publishes aggregate, non-sensitive numbers (provisioned
  // capacity, live traffic) at `{mount}/pool`; this proxy exists so the browser
  // never needs the gateway URL — the seal stays server-side. Thirty seconds
  // of server-side cache keeps a settings page that re-mounts often from
  // turning into a request flood, while staying fresh enough for the load
  // verdict to mean something. A host without the lane — or a gateway that
  // does not answer — throws a tagged reason, and the route answers 404 with
  // that reason, which the client shows as a muted diagnostic line. The
  // outbound hop rides directFetch, the lane's own node:http(s) transport: if
  // global fetch is wrapped or broken in this composition, the lane still is.
  const poolError = reason => Object.assign(new Error(`pool: ${reason}`), { code: 'POOL_UNAVAILABLE', reason })
  // A snapshot this young still describes the same day; under load the panel
  // shows it rather than blanking while the gateway is slow to answer.
  const POOL_STALE_MS = 10 * 60_000
  let poolCache = { at: 0, data: null }
  async function fetchPoolSnapshot() {
    if (poolCache.data !== null && Date.now() - poolCache.at < 30_000) return poolCache.data
    const credential = sealedCredentialOf()
    if (credential === null || credential.mode !== 'worker') throw poolError('no-lane')
    const gatewayRoot = credential.base.replace(/\/v1\/?$/, '')
    const controller = new AbortController()
    // The gateway may be genuinely slow when it is saturated (that is what the
    // verdict is about); twenty seconds is the patience this hop gets.
    const timer = setTimeout(() => controller.abort(), 20_000)
    timer.unref?.()
    try {
      const response = await directFetch(`${gatewayRoot}/pool`, { headers: { accept: 'application/json' }, signal: controller.signal })
      if (!response.ok) throw poolError('gateway-status')
      const data = await response.json()
      // The gateway may answer a degraded snapshot: stars unreachable means
      // pool/poolSource come back null/'unavailable' while the live counters
      // stay real. That is still a valid snapshot — only the in-flight core
      // is required, and the panel renders the rest as it finds it.
      if (data?.ok !== true || !Number.isFinite(data.inflight)) throw poolError('malformed')
      poolCache = { at: Date.now(), data }
      return data
    } catch (error) {
      if (poolCache.data !== null && Date.now() - poolCache.at < POOL_STALE_MS) return poolCache.data
      throw error?.code === 'POOL_UNAVAILABLE' ? error : poolError('unreachable')
    } finally {
      clearTimeout(timer)
    }
  }

  // ── the GitHub authorization gate on the co-paid lane ───────────────────────
  // One per-user token (src/eac-user.js) is what the gateway's GitHub gate
  // mints after login + star, and these four hops are the settings page's whole
  // relationship with that gate. The token never reaches the browser: the page
  // sees a login name and a verdict, the file and the signed wire keep the
  // credential. `cached` is the sync bit /summary can carry.
  const eacAuthCache = { at: 0, data: { available: false, authorized: false, login: '' } }
  const eacAuthRootOf = credential => credential.base.replace(/\/v1\/?$/, '')
  async function eacAuthStatus() {
    const credential = sealedCredentialOf()
    if (credential === null || credential.mode !== 'worker') {
      return { available: false, authorized: false, login: '', mode: credential?.mode ?? null }
    }
    const local = readEacUser()
    const base = {
      available: true,
      mode: 'worker',
      local: local !== null,
      login: local?.login ?? '',
      avatar: local?.avatar ?? '',
      savedAt: local?.savedAt ?? 0,
    }
    try {
      const response = await directFetch(`${eacAuthRootOf(credential)}/auth/status`, {
        headers: { accept: 'application/json', ...(local === null ? {} : { 'x-ofm-user': local.token }) },
        signal: AbortSignal.timeout(15_000),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || data === null) throw new Error('bad answer')
      const result = {
        ...base,
        configured: data.configured === true,
        required: data.required === true,
        authorized: data.authorized === true,
        login: typeof data.login === 'string' && data.login !== '' ? data.login : base.login,
        avatar: typeof data.avatar === 'string' && data.avatar !== '' ? data.avatar : base.avatar,
        starred: data.starred === true,
        lastCheck: Number.isFinite(data.lastCheck) ? data.lastCheck : 0,
        reason: typeof data.reason === 'string' ? data.reason : null,
        repo: typeof data.repo === 'string' ? data.repo : '',
        checkedAt: Date.now(),
      }
      eacAuthCache.at = Date.now()
      eacAuthCache.data = result
      return result
    } catch {
      // The gateway did not answer: report what this machine holds, marked
      // unverified, rather than claiming an authorization nobody confirmed.
      const fallback = { ...base, authorized: local !== null, unverified: true, checkedAt: Date.now() }
      eacAuthCache.at = Date.now()
      eacAuthCache.data = fallback
      return fallback
    }
  }
  const eacLoginPoller = createEacLoginPoller({
    credentialOf: sealedCredentialOf, fetch: directFetch,
    readUser: readEacUser, writeUser: writeEacUser,
    onSaved: saved => {
      eacAuthCache.data = { ...eacAuthCache.data, available: true, local: true, authorized: true, login: saved.login, avatar: saved.avatar, savedAt: saved.savedAt }
    },
  })
  const eacAuth = {
    /** Fresh read; the settings page calls this on mount and after actions. */
    status: eacAuthStatus,
    /** The last verdict, for the sync /summary document. */
    cached: () => eacAuthCache.data,
    /** Begin a login: mint the link code, hand the URL to the system browser. */
    async start() {
      const credential = sealedCredentialOf()
      if (credential === null || credential.mode !== 'worker') return { error: 'no-lane' }
      const link = crypto.randomBytes(24).toString('base64url')
      const url = `${eacAuthRootOf(credential)}/auth/github/start?link=${link}`
      const prepared = await eacLoginPoller.prepare(link)
      if (prepared.error !== undefined) return prepared
      return { url, link, opened: openExternal(url) }
    },
    /** Collect the token the browser flow just produced. */
    poll: link => eacLoginPoller.poll(link),
    cancel: link => eacLoginPoller.cancel(link),
    /** Revoke server-side, then forget locally. Local removal is the part that
     * must always happen — a gateway that cannot be reached must not leave the
     * user logged in on this machine. */
    async logout() {
      eacLoginPoller.reset()
      const credential = sealedCredentialOf()
      const local = readEacUser()
      if (local !== null && credential !== null && credential.mode === 'worker') {
        try {
          await directFetch(`${eacAuthRootOf(credential)}/auth/logout`, {
            method: 'POST',
            headers: { accept: 'application/json', 'x-ofm-user': local.token },
            signal: AbortSignal.timeout(8000),
          })
        } catch { /* local removal below is what the user asked for */ }
      }
      const cleared = clearEacUser()
      eacAuthCache.data = { available: credential !== null && credential.mode === 'worker', authorized: false, login: '', local: false }
      return { ok: cleared }
    },
  }

  // ── push channel ────────────────────────────────────────────────────────────
  const push = createPushHub({ logger })

  /** Set of announcement ids the user has acknowledged. */
  const ackedIds = () => new Set(Array.isArray(settings.get().announcementsAcked) ? settings.get().announcementsAcked : [])

  const feed = new AnnouncementFeed({
    settings: () => settings.get(),
    cacheFile: path.join(dataDir, 'feed.json'),
    onArrival: items => {
      push.emit('announcements', { items, unread: feedView().unread })
      refreshUpdatePush?.()
    },
    log: message => logger.info?.(message),
  })
  feed.load()

  /**
   * The announcement view the settings page reads. A managed install polls no
   * feed and caches no copy — the pack speaks for the plugin — so its view is a
   * fixed empty one that names its source honestly.
   */
  const MANAGED_FEED_VIEW = { items: [], unread: 0, fetchedAt: 0, source: 'managed', error: '', lastError: '' }
  function feedView() {
    return managed ? MANAGED_FEED_VIEW : feed.view({ ackedIds: ackedIds() })
  }

  const updater = new PluginUpdater({
    pkgDir: PKG_DIR,
    dataDir,
    settings: () => settings.get(),
    log: message => logger.info?.(message),
    runningVersion: packageVersion,
  })
  /** Update versions we have already pushed a notification for. */
  let updateNotifiedFor = typeof settings.get().updateNotifiedFor === 'string' ? settings.get().updateNotifiedFor : ''

  /** Push an `update` event once per version (manual checks force a re-push). */
  function pushUpdate(force = false) {
    if (disposed || managed) return
    const status = updater.status()
    if (status.available !== true || status.latest === '') return
    if (!force && status.latest === updateNotifiedFor) return
    updateNotifiedFor = status.latest
    settings.update({ updateNotifiedFor: status.latest })
    push.emit('update', { current: status.current, latest: status.latest, notes: status.notes })
  }
  let refreshUpdatePush = undefined
  /** Set when this generation is disposed; late async callbacks must stand down. */
  let disposed = false

  // The successor offers a notification callback, but only the caller that
  // confirmed selfReload() and committed the outcome may invoke it. Booting a
  // replacement is not yet evidence that every fiber started successfully.
  const pendingUpgrade = globalThis[Symbol.for('our-free-model.pending-upgrade')]
  if (pendingUpgrade?.version === packageVersion) {
    pendingUpgrade.notify = () => {
      if (disposed) return
      settings.update({ installedVersion: packageVersion })
      settings.flush()
      push.emit('upgraded', { version: packageVersion, clientChanged: true })
    }
  }

  /**
   * 自有渠道的**推理凭据**：每个回合现解析，过期就地续期，续上了才回写账号表。
   *
   * 为什么必须在这里：`createModelRuntime` 的默认实现是 `async () => null`，
   * 于是自有渠道的请求永远以「凭据不可用」结束 —— 目录看得见、模型选得中、
   * 一发就失败，正是「自己加的渠道用不了」的形状。
   *
   * 续期按渠道分派：只登记**有 refresh 语义**的那几家（MiniMax 国际版）；
   * 没有登记的原样返回，缺 access_token 时交给推理腿判 `CODE.credential`。
   */
  const OWN_REFRESH = {
    minimaxintl: credential => ensureMinimaxCredential(credential, { product: MINIMAX_PRODUCTS.minimaxintl }),
    marvis: credential => ensureMarvisCredential(credential),
  }
  async function ownCredentialFor(provider) {
    let list = []
    try { list = ownAccounts.enabled(provider) } catch { return null }
    const account = list[0]
    if (account === undefined) return null
    const credential = await ownAccounts.credentialOf(account)
    if (credential === null) return null
    const refresh = OWN_REFRESH[provider]
    if (refresh === undefined) return credential
    const ensured = await refresh(credential)
    if (ensured.error !== undefined) {
      // 续期失败但手上还有令牌：照旧发出去，让上游判 —— 本地判「过期」比上游准。
      return typeof credential.access_token === 'string' && credential.access_token !== '' ? credential : null
    }
    if (ensured.refreshed === true) {
      try { await ownAccounts.attach(account.id, ensured.credential) } catch { /* 落盘失败不影响本回合 */ }
    }
    return ensured.credential
  }

  const modelRuntime = createModelRuntime({
    ...stores,
    logger,
    attributionUserAgent: 'deepseek-harness',
    resolveImage: imageResolver(ctx, logger),
    sealedCredential: sealedCredentialOf,
    ownCredential: ownCredentialFor,
    onSealedUnavailable: () => logger.warn?.('our-free-model: the sealed lane is not available in this composition (no recognized host profile); its models stay hidden'),
    onTopology: () => emitTopology(),
  })
  const { state, adapter, refreshCatalog, refreshAvailability, watchEgress, fetchListing, publicModelRows, syncAggregateCatalog } = modelRuntime
  const runForwarded = modelRuntime.complete

  // ── registration ────────────────────────────────────────────────────────────
  const routes = () => Object.keys(state().membership)
  const registration = ctx.llm.registerAdapter([ROUTE_MAIN, ROUTE_REGION], adapter)
  ctx.llm.registerConfigurableProviders?.([
    { provider: ROUTE_MAIN, displayName: ROUTE_LABELS[ROUTE_MAIN], settingsNs: ctx.fiber?.entry?.options?.id ?? name, settingsPath: [] },
  ])

  // Advertise a probe endpoint for the in-app "detect models" button. It offers
  // what the picker itself advertises — a model the gateway refuses to route at
  // all must not be addable to a profile just because it still appears in the
  // upstream listing.
  ctx.llm.registerModelDiscovery?.(ctx.fiber?.entry?.options?.id ?? name, async () => {
    await refreshCatalog({ probe: true, force: true })
    const advertised = new Set(Object.values(state().membership).flat())
    return modelRuntime.catalog
      .filter(entry => advertised.has(entry.id))
      .map(entry => ({
        id: entry.id,
        name: entry.name,
        contextWindow: entry.contextWindow,
        maxTokens: entry.maxOutput,
        inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      }))
  })

  ctx.on?.('loader/volatile-update', () => {
    registration.replace(routes())
  })

  /**
   * A freshly started outlet needs a moment before its nodes carry traffic: the
   * first read comes back empty, and a re-probe fired on that cold path would
   * record "unavailable" for models the new exit would have unlocked. Retry a
   * few times and let the re-probe run only once the exit answers.
   */
  async function settleOutletWatch() {
    let lastError
    for (let attempt = 0; attempt < 4; attempt++) {
      await new Promise(resolve => setTimeout(resolve, attempt === 0 ? 2500 : 5000))
      if (disposed) return
      try {
        if (await watchEgress()) {
          // The exit answers, but url-test may not have ranked a node yet: read
          // the selection now, and once more a beat later so the settings page
          // does not sit on an empty node until the next periodic tick.
          await readOutletStatus().catch(() => {})
          const later = setTimeout(() => {
            if (!disposed) void readOutletStatus().catch(() => {})
          }, 5000)
          later.unref?.()
          return
        }
      } catch (error) {
        lastError = error
      }
    }
    logger.warn?.(
      `our-free-model: egress changed but the new exit never answered; leaving verdicts alone`
      + (lastError ? ` (${lastError?.message ?? lastError})` : ''),
    )
  }

  // ── forward listener ────────────────────────────────────────────────────────
  // Both reconciles get a serialisation gate: two callers (the boot refresh and
  // every settings POST) used to overlap, and whichever bind finished last wrote
  // its entry-time snapshot of the settings back over the other one - rolling
  // the user's just-saved `enabled` edits back, or leaving an orphan listener
  // behind. The waiter re-runs after the first settles; the early-exit below
  // makes that rerun free when nothing changed.
  let forwardSyncInFlight = null
  async function syncForward() {
    while (forwardSyncInFlight !== null) await forwardSyncInFlight.catch(() => {})
    const run = syncForwardOnce()
    forwardSyncInFlight = run
    try { await run } finally { if (forwardSyncInFlight === run) forwardSyncInFlight = null }
  }
  async function syncForwardOnce() {
    const desired = settings.get().forward ?? {}
    const wanted = desired.enabled === true
    // A listener already bound where the settings want it is left alone. Two
    // callers reconcile the same state — the boot refresh and every settings
    // POST — and the second one used to close and re-bind the port anyway,
    // resetting whatever request was in flight on the old socket.
    if (forward !== null && wanted
      && forward.host === (desired.host || '127.0.0.1')
      && forward.port === (Number.isFinite(Number(desired.port)) ? Number(desired.port) : 0)) return
    if (forward === null && !wanted) return
    if (forward !== null) {
      const closing = forward
      forward = null
      await closing.close().catch(() => {})
    }
    if (!wanted) {
      forwardError = ''
      forwardNotice = ''
      return
    }
    // Checked again here, not only where the settings page posts: a headless
    // composition has no page to click, and `settings.json` is the way in. A
    // routable bind would spend this machine's free lane on the whole subnet.
    if (!isLoopbackHost(desired.host || '127.0.0.1')) {
      forwardError = 'the forward listener binds a loopback address only'
      logger.warn?.(`our-free-model: forward listener not started (${forwardError})`)
      return
    }
    try {
      forward = await startForwardServer({
        config: () => {
          const current = settings.get().forward ?? {}
          return { host: current.host || '127.0.0.1', port: current.port ?? 0, enabled: current.enabled === true, key: forwardKey() }
        },
        complete: (request, onChunk) => runForwarded(request, onChunk),
        modelRows: () => publicModelRows(),
        // Read per request, not captured: the settings page can flip a switch
        // while the listener is up, and a captured snapshot would keep answering
        // a disabled optimization until the next restart.
        optimize: () => optimizeConfig(settings.get().localOptimize),
        log: message => logger.warn?.(`our-free-model forward: ${message}`),
        onTrace: event => logger.info?.(`our-free-model request: ${JSON.stringify(event)}`),
      })
      forwardError = ''
      // The requested port is somebody else's for good — a `netsh interface
      // portproxy` rule outlives this plugin, and on Windows it surfaces as
      // EACCES on a loopback bind. `startForwardServer` walks to a free port
      // rather than leaving the feature down; the port it settled on is what
      // gets persisted below, and this notice is what says so.
      forwardNotice = forward.fellBack === true && forward.bindError !== null
        ? `port ${forward.requestedPort} is not available on this machine (${forward.bindError.code}); the listener is on port ${forward.port} instead`
        : ''
      if (forwardNotice !== '') logger.warn?.(`our-free-model forward: ${forwardNotice}`)
      // Persist the port that actually answers, but out of the CURRENT
      // settings - not the desired snapshot from before the await. An
      // overlapped save would otherwise be rolled back to entry-time values.
      const settledForward = settings.get().forward ?? {}
      settings.update({ forward: { ...settledForward, port: forward.port, host: forward.host || desired.host || '127.0.0.1' } })
      settings.flush()
    } catch (error) {
      forwardError = String(error?.message ?? error)
      logger.warn?.(`our-free-model: forward listener could not start (${forwardError})`)
    }
  }

  function forwardKey() {
    const current = settings.get()
    if (typeof current.forwardKey === 'string' && current.forwardKey !== '') return current.forwardKey
    const minted = generateKey()
    settings.update({ forwardKey: minted })
    settings.flush()
    return minted
  }

  /**
   * The relay's own key. Never the local one: a key that has to travel to other
   * devices on a network is a key that will eventually leak, and a leak must
   * cost a rotation here rather than every tool already wired to the local port.
   */
  function relayKey() {
    const current = settings.get()
    if (typeof current.forwardLanKey === 'string' && current.forwardLanKey !== '') return current.forwardLanKey
    const minted = generateKey()
    settings.update({ forwardLanKey: minted })
    settings.flush()
    return minted
  }

  /**
   * IPv4 addresses another machine on this network could dial, best first.
   *
   * Read fresh on every ask — the panel polls it while the relay is on — because
   * the answer is a property of the machine's interfaces and they change under a
   * laptop that switched networks. The ordering lives in `rankLanAddresses`
   * (`src/forward.js`), next to the relay it describes.
   */
  function lanAddresses() {
    return rankLanAddresses(os.networkInterfaces())
  }

  /**
   * Reconcile the optional LAN relay.
   *
   * Deliberately not folded into `syncForward`: the two doors have separate
   * lives, and toggling the relay must not close and re-bind the local port
   * under a request that is already in flight on it.
   */
  let relaySyncInFlight = null
  async function syncRelay() {
    while (relaySyncInFlight !== null) await relaySyncInFlight.catch(() => {})
    const run = syncRelayOnce()
    relaySyncInFlight = run
    try { await run } finally { if (relaySyncInFlight === run) relaySyncInFlight = null }
  }
  async function syncRelayOnce() {
    const desired = settings.get().forward ?? {}
    const lan = desired.lan ?? {}
    const wanted = lan.enabled === true
    const host = String(lan.host ?? '').trim() || '0.0.0.0'
    const port = Number.isFinite(Number(lan.port)) && Number(lan.port) > 0 ? Math.trunc(Number(lan.port)) : 0
    if (relay !== null && wanted && forward !== null && relay.host === host && relay.port === port) return
    if (relay === null && !wanted) return
    if (relay !== null) {
      const closing = relay
      relay = null
      await closing.close().catch(() => {})
    }
    if (!wanted) {
      relayError = ''
      return
    }
    // Without the local listener there is nothing to relay to, and a relay on
    // the local port would dial itself. Both are settings mistakes worth naming
    // here rather than surfacing as a socket error later.
    if (desired.enabled !== true || forward === null) {
      relayError = 'the local forward listener is not running'
      return
    }
    if (port !== 0 && port === forward.port) {
      relayError = 'the LAN relay needs a port of its own'
      logger.warn?.(`our-free-model: LAN relay not started (${relayError})`)
      return
    }
    try {
      relay = await startLanRelay({
        config: () => {
          const current = settings.get().forward ?? {}
          const currentLan = current.lan ?? {}
          return {
            enabled: currentLan.enabled === true,
            host: String(currentLan.host ?? '').trim() || '0.0.0.0',
            port: currentLan.port ?? 0,
            lanKey: relayKey(),
            localKey: forwardKey(),
            targetPort: forward?.port ?? 0,
          }
        },
        log: message => logger.warn?.(`our-free-model lan relay: ${message}`),
        onTrace: event => logger.info?.(`our-free-model request: ${JSON.stringify(event)}`),
      })
      relayError = ''
      // The port that was actually bound goes back into the settings, so the
      // address the page shows is the address that answers. Out of the CURRENT
      // settings — not the entry-time snapshot: an overlapped save during the
      // bind would otherwise be rolled back to the values this run started with.
      const settledForward = settings.get().forward ?? {}
      settings.update({ forward: { ...settledForward, lan: { ...(settledForward.lan ?? {}), port: relay.port } } })
      settings.flush()
    } catch (error) {
      relayError = String(error?.message ?? error)
      logger.warn?.(`our-free-model: LAN relay could not start (${relayError})`)
    }
  }

  // ── the channels' gateway relay ─────────────────────────────────────────────
  /**
   * The absorbed pack serves every 白嫖 provider through one OpenAI-compatible
   * gateway on the loopback. The relay is this plugin's own door in front of
   * it: callers authenticate with `chanGateway.relay.key` and the forwarded
   * hop is re-stamped with the gateway's own credential, which never leaves
   * the host. Off until asked for; the settings page owns the switch.
   */
  let chanRelay = null
  let chanRelayError = ''
  let chanRelaySyncInFlight = null

  function chanRelayKey() {
    const relay = settings.get().chanGateway?.relay ?? {}
    if (typeof relay.key === 'string' && relay.key !== '') return relay.key
    const minted = generateKey()
    settings.update({ chanGateway: { ...(settings.get().chanGateway ?? {}), relay: { ...(settings.get().chanGateway?.relay ?? {}), key: minted } } })
    settings.flush()
    return minted
  }

  function rotateChanRelayKey() {
    const minted = generateKey()
    settings.update({ chanGateway: { ...(settings.get().chanGateway ?? {}), relay: { ...(settings.get().chanGateway?.relay ?? {}), key: minted } } })
    settings.flush()
    return minted
  }

  /** The gateway's address and credential, read fresh: both can move (env). */
  function chanGatewayTarget() {
    return {
      port: chanGatewayPort(process.env),
      enabledByEnv: chanGatewayEnabled(process.env),
      credential: chanGatewayCredential({ profileContext: optional('profileContext'), env: process.env }),
    }
  }

  async function syncChanRelay() {
    while (chanRelaySyncInFlight !== null) await chanRelaySyncInFlight.catch(() => {})
    const run = syncChanRelayOnce()
    chanRelaySyncInFlight = run
    try { await run } finally { if (chanRelaySyncInFlight === run) chanRelaySyncInFlight = null }
  }
  async function syncChanRelayOnce() {
    const relay = settings.get().chanGateway?.relay ?? {}
    const wanted = relay.enabled === true
    const host = String(relay.host ?? '').trim() || '127.0.0.1'
    const port = Number.isFinite(Number(relay.port)) && Number(relay.port) > 0 ? Math.trunc(Number(relay.port)) : 0
    const target = chanGatewayTarget()
    if (chanRelay !== null && wanted && chanRelay.host === host && chanRelay.port === port) return
    if (chanRelay === null && !wanted) return
    if (chanRelay !== null) {
      const closing = chanRelay
      chanRelay = null
      await closing.close().catch(() => {})
    }
    if (!wanted) { chanRelayError = ''; return }
    if (port !== 0 && target.port === port) {
      chanRelayError = 'the relay needs a port of its own (the gateway listens on ' + target.port + ')'
      logger.warn?.(`our-free-model: channel gateway relay not started (${chanRelayError})`)
      return
    }
    try {
      chanRelay = await startChanRelay({
        config: () => {
          const current = settings.get().chanGateway?.relay ?? {}
          const targetNow = chanGatewayTarget()
          return {
            enabled: current.enabled === true,
            host: String(current.host ?? '').trim() || '127.0.0.1',
            port: current.port ?? 0,
            lanKey: chanRelayKey(),
            gatewayHost: '127.0.0.1',
            gatewayPort: targetNow.port,
            gatewayKey: targetNow.credential?.key ?? '',
          }
        },
        log: message => logger.warn?.(`our-free-model channel relay: ${message}`),
      })
      chanRelayError = ''
      // The bound port goes back into the settings, so the page shows the
      // address that actually answers (the OS picks when 0 was asked for).
      const settled = settings.get().chanGateway ?? {}
      settings.update({ chanGateway: { ...settled, relay: { ...(settled.relay ?? {}), port: chanRelay.port } } })
      settings.flush()
    } catch (error) {
      chanRelayError = String(error?.message ?? error)
      logger.warn?.(`our-free-model: channel gateway relay could not start (${chanRelayError})`)
    }
  }

  function chanRelayStatus() {
    const relay = settings.get().chanGateway?.relay ?? {}
    const target = chanGatewayTarget()
    return {
      relay: {
        enabled: relay.enabled === true,
        running: chanRelay !== null,
        host: chanRelay?.host ?? (String(relay.host ?? '').trim() || '127.0.0.1'),
        port: chanRelay?.port ?? relay.port ?? 0,
        hasKey: typeof relay.key === 'string' && relay.key !== '',
        error: chanRelayError,
      },
      gateway: {
        port: target.port,
        enabledByEnv: target.enabledByEnv,
        keyFound: target.credential !== null,
        keyFromEnv: target.credential?.fromEnv === true,
        keyPath: target.credential?.path ?? '',
      },
    }
  }


  // ── egress outlet ───────────────────────────────────────────────────────────
  /** One gateway round trip at a time; the panel polls, the throttle decides. */
  let latencyMeasureInFlight = null
  /**
   * Which node the outlet is carrying traffic on, and what it costs to reach the
   * gateway through it. Purely informational: every failure is a missing reading,
   * never an error, because the outlet itself may be perfectly healthy while the
   * controller call that describes it is not.
   */
  /**
   * The settings page asks "how long does opencode take to answer right now", and
   * the honest answer is a real round trip through the outlet — not the age of the
   * last catalog refresh. Re-reading the listing is the cheapest call that proves
   * the whole path (it is the same request the catalog uses, and free), so it is
   * reused here, throttled so a panel left open cannot turn into a loop.
   */
  async function measureGatewayLatency() {
    if (modelRuntime.gatewayLatency.at !== 0 && Date.now() - modelRuntime.gatewayLatency.at < 60_000) return
    if (latencyMeasureInFlight !== null) return await latencyMeasureInFlight.catch(() => {})
    const run = fetchListing()
      .then(() => {})
      .catch(error => {
        logger.debug?.(`our-free-model: gateway latency reading failed (${error?.message ?? error})`)
      })
    latencyMeasureInFlight = run
    try { await run } finally { if (latencyMeasureInFlight === run) latencyMeasureInFlight = null }
  }

  async function readOutletStatus() {
    const relay = outletRelay
    if (relay === null) {
      outletNode = { node: '', delayMs: 0, at: 0 }
      return { node: '', nodeDelayMs: 0, nodeAt: 0, latencyMs: 0, latencyAt: 0 }
    }
    await measureGatewayLatency().catch(() => {})
    const selection = await readOutletSelection(relay).catch(() => null)
    // A settled read is cached for `/summary`, which cannot await a round trip.
    if (outletRelay === relay) {
      outletNode = { node: selection?.node ?? '', delayMs: selection?.delayMs ?? 0, at: Date.now() }
    }
    return {
      node: selection?.node ?? '',
      nodeDelayMs: selection?.delayMs ?? 0,
      nodeAt: Date.now(),
      latencyMs: modelRuntime.gatewayLatency.ms,
      latencyAt: modelRuntime.gatewayLatency.at,
    }
  }
  // Same serialisation gate as the two listeners above: the boot chain and every
  // settings POST call this, and overlapping runs would leak a spawned mihomo
  // (the loser overwrites `outletRelay` while the winner's child still runs).
  let outletSyncInFlight = null
  /** What the currently running outlet was started with — restart on change. */
  let outletFingerprint = ''
  async function syncEgress() {
    while (outletSyncInFlight !== null) await outletSyncInFlight.catch(() => {})
    const run = syncEgressOnce()
    outletSyncInFlight = run
    try { await run } finally { if (outletSyncInFlight === run) outletSyncInFlight = null }
  }
  async function syncEgressOnce() {
    const desired = settings.get().egress ?? {}
    const wanted = desired.enabled === true
    const mode = desired.mode === 'client' ? 'client' : 'subscription'
    const url = String(desired.url ?? '').trim()
    const mihomoPath = String(desired.mihomoPath ?? '').trim()
    const fingerprint = `${mode}\n${url}\n${mihomoPath}`
    if (outletRelay !== null && wanted && outletFingerprint === fingerprint && !outletRelay.dead) return
    if (outletRelay === null && !wanted) return
    if (outletRelay !== null) {
      const closing = outletRelay
      outletRelay = null
      outletFingerprint = ''
      await closing.close().catch(() => {})
      // The way out changed under every fetch: re-detect the exit so the pill and
      // the model verdicts describe the path the next request actually takes.
      void settleOutletWatch()
    }
    if (!wanted) {
      outletError = ''
      return
    }
    if (url === '') {
      outletError = 'the outlet needs a subscription or proxy URL'
      logger.warn?.(`our-free-model: egress outlet not started (${outletError})`)
      return
    }
    try {
      outletRelay = await startEgressRelay({
        config: () => {
          const current = settings.get().egress ?? {}
          return {
            mode: current.mode === 'client' ? 'client' : 'subscription',
            url: String(current.url ?? '').trim(),
            mihomoPath: String(current.mihomoPath ?? '').trim(),
          }
        },
        dataDir,
        log: message => logger.info?.(`our-free-model egress: ${message}`),
        onDead: scheduleOutletRestart,
      })
      outletFingerprint = fingerprint
      outletError = ''
      outletUpSince = Date.now()
      logger.info?.(`our-free-model: egress outlet up (${outletLabel(url)} via ${mode})`)
      // Same as the close path: the exit IP, its country and the region-gated
      // verdicts all moved with the outlet, so settle them now instead of at the
      // next periodic watch.
      void settleOutletWatch()
    } catch (error) {
      outletError = String(error?.message ?? error)
      logger.warn?.(`our-free-model: egress outlet could not start (${outletError})`)
    }
  }

  // A managed mihomo that dies mid-run used to leave the outlet bricked until
  // the user touched the settings page: the relay stays up but its dial port is
  // gone, so every upstream turn fails. syncEgressOnce already restarts a dead
  // relay with an unchanged fingerprint — this only calls it, with a backoff so
  // a mihomo that dies at boot cannot spin into a start/exit loop. A run that
  // lasted two minutes counts as healthy and resets the ladder.
  const OUTLET_STABLE_MS = 120_000
  let outletUpSince = 0
  let outletRestartAttempts = 0
  let outletRestartTimer = null
  function scheduleOutletRestart() {
    if (outletRestartTimer !== null) return
    if (Date.now() - outletUpSince >= OUTLET_STABLE_MS) outletRestartAttempts = 0
    const delay = Math.min(15_000 * 2 ** outletRestartAttempts, 600_000)
    outletRestartAttempts += 1
    logger.warn?.(`our-free-model: egress outlet went down; restarting in ${Math.round(delay / 1000)}s (attempt ${outletRestartAttempts})`)
    outletRestartTimer = setTimeout(() => {
      outletRestartTimer = null
      void syncEgress().catch(() => {})
    }, delay)
    outletRestartTimer.unref?.()
  }

  // ── hot reload + in-app upgrade ─────────────────────────────────────────────
  /**
   * Swap the running plugin for the code on disk. Called for explicit reloads
   * for development. A failed ordinary reload only restores runtime state;
   * it must never overwrite current edits with an unrelated upgrade backup.
   */
  async function reloadFromDisk() {
    const status = updater.status()
    if (status.applying) throw new Error('an upgrade is already running')
    if (status.recoveryRequired) throw new Error('restore the retained upgrade backup before reloading')
    const result = await selfReload(ctx, { logger, packageUrl: PKG_URL.href, entryUrl: ENTRY_URL })
    if (result.ok) return result
    throw new Error(result.error)
  }

  async function applyUpgrade(version) {
    if (managed) throw httpError(409, MANAGED_MESSAGE)
    if (isReloading()) throw new Error('a reload is already in progress')
    const pendingKey = Symbol.for('our-free-model.pending-upgrade')
    let pending
    try {
      const result = await updater.apply({
        version,
        activate: async installed => {
          pending = { version: installed.version }
          globalThis[pendingKey] = pending
          return selfReload(ctx, { logger, packageUrl: PKG_URL.href, entryUrl: ENTRY_URL, expectedVersion: installed.version })
        },
      })
      // Notification uses the successor's stores and hub. The predecessor's
      // effects have already been disposed by the swap.
      try { pending?.notify?.() } catch (error) { logger.warn?.(`our-free-model: upgrade notification failed (${error?.message ?? error})`) }
      return { ...result, reloaded: true }
    } finally {
      if (globalThis[pendingKey] === pending) globalThis[pendingKey] = undefined
    }
  }

  /**
   * Watch the installed package and hot-reload when its files change.
   * Off by default; the settings page flips it for development and demos.
   */
  let watcher = undefined
  function syncWatcher() {
    const wanted = settings.get().autoReloadWatch === true
    if (wanted && watcher === undefined) {
      watcher = watchPackage(PKG_DIR, {
        logger,
        onChange: () => {
          const status = updater.status()
          if (isReloading() || status.applying || status.recoveryRequired) return
          logger.info?.('our-free-model: watched files changed; hot-reloading')
          void reloadFromDisk().catch(error => logger.warn?.(`our-free-model: hot reload failed (${error?.message ?? error})`))
        },
      })
    } else if (!wanted && watcher !== undefined) {
      watcher()
      watcher = undefined
    }
  }

  // ── browser-facing API ──────────────────────────────────────────────────────
  /**
   * Read a service the composition may or may not mount.
   *
   * `ctx.get` is cordis' opportunistic lookup: it answers `undefined` instead of
   * throwing when the service is absent — and also while it is merely not
   * provided yet, which matters because plugins load before the browser half has
   * published anything. So a service read this way is a snapshot: `connection` is
   * therefore resolved per request below, and `webServer` gets its own fiber (see
   * the `ctx.inject` at the end of this section).
   */
  const optional = service => (typeof ctx.get === 'function' ? ctx.get(service) : undefined)
  /**
   * The trust fence's view of the connection service, looked up per request.
   *
   * The browser half publishes `connection` after plugins have loaded, so reading
   * it once here would freeze in "absent" and leave every request on the replica
   * fence for the life of the process. The view takes the service *thunk* rather
   * than the service, and its `admit` answers `undefined` — not a no-op function
   * — while the service is missing, which is what makes the fence fall through to
   * its own structural check instead of reading as "admitted".
   */
  const fenceConnection = connectionAdmissionView(() => optional('connection'))
  // ── the absorbed free-channel pack ──────────────────────────────────────────
  /**
   * The 白嫖 channels — CodeArts (华为云), CodeBuddy / WorkBuddy (腾讯), LobsterAI
   * (有道), Qoder / Qoder CN (阿里系), TRAE (字节), Cline, Loomy (讯飞), Raccoon
   * (商汤), MiniMax Code, ZCode (智谱) and Gemini (Google) — are
   * carried with local integration adaptations from the plugin that shipped them, vendored under
   * `vendor/channel-pack` (provenance in `vendor/channel-pack/NOTICE.md`). Mounting the
   * pack keeps every login flow, account pool, credit claim, model blacklist
   * and its local OpenAI gateway working as they were validated upstream,
   * instead of being re-implemented here and drifting.
   *
   * The pack runs on a fiber of its own, after `credentials`, `commands` and
   * `llm` exist. A composition without them — a headless TUI, the offline test
   * harness — keeps the free lane and loses only the channels, the same trade
   * this plugin makes for every optional service. `channelPack` is the state
   * bit `/summary` reports so the page can say *why* the channel list is empty
   * instead of showing nothing.
   */
  let channelPack = { state: 'pending', error: '' }
  /**
   * The channel pack's own catalog gate is keyed on "has a logged-in account",
   * which is inert once a provider has any credential — and the remote catalog
   * keeps adding models a per-model blacklist cannot chase. This wrapper turns
   * that gate into one master switch over all 13 channel groups. It is display
   * only: routing resolves models through `resolveModel`, never this gate.
   */
  let channelVisibility = { installed: false, sync() {} }
  let channelExtras = createChannelExtras({})
  /**
   * 本插件自己的渠道账号（渠道包完全不认识的那些，如 codely）。
   *
   * 凭据照旧写宿主的 `credentials`，ref 名带 `OFM_` 前缀与渠道包的命名空间分开；
   * 这里只持久化「指向凭据的引用 + 展示信息」。账号表落在
   * `~/.dsh/our-free-model/channels.json`。
   *
   * ⚠️ 必须在 `ctx.inject(['credentials', …])` 之内构造：`ctx.credentials` 在
   * apply 期可能还没发布（与渠道包同一约束，见下面 pack 那段注释）。注入前的
   * 占位实现把一切操作降级成「没有账号」，页面照常渲染。
   */
  const channelAccountStore = new JsonStore(
    path.join(dataDir, 'channels.json'),
    { version: 1, accounts: [] },
    { log: message => logger.warn?.(message) },
  )
  const NO_ACCOUNTS = {
    list: () => [], enabled: () => [], find: () => undefined,
    create: () => { throw new Error('credentials service unavailable') },
    update: () => undefined, remove: async () => false, attach: async () => undefined,
    credentialOf: async () => null,
  }
  let ownAccounts = NO_ACCOUNTS
  let deviceLogin = createDeviceLogin({ accounts: NO_ACCOUNTS })
  let smsLogin = createSmsLogin({ accounts: NO_ACCOUNTS })
  /** 宿主 llm 服务（诊断路由用；注入前是 null）。 */
  let hostLlm = null
  /** Accio 的浏览器授权流程（内存态；回调等待期间持有 loopback 服务器）。 */
  const accioLogins = new Map()
  ctx.inject(['credentials', 'commands', 'llm'], scoped => {
    let stopped = false
    scoped.effect(() => () => { stopped = true }, 'our-free-model: channel pack')
    // 本插件自己的渠道账号：凭据服务在这里才确定可用（apply 期可能尚未发布）。
    ownAccounts = createChannelAccounts(
      channelAccountStore,
      {
        set: (ref, value) => scoped.credentials.set(ref, value),
        // 宿主的凭据服务不一定有 delete（不同内核代次能力不同）；没有时表仍然干净。
        ...typeof scoped.credentials.delete === 'function' ? { delete: ref => scoped.credentials.delete(ref) } : {},
      },
      ref => scoped.credentials.resolve(ref),
    )
    // 诊断用：宿主 llm 服务（`listModels` 是「宿主过滤后」的真实答案）。
    hostLlm = scoped.llm
    deviceLogin = createDeviceLogin({ accounts: ownAccounts })
    smsLogin = createSmsLogin({ accounts: ownAccounts })
    // Dynamic import: the pack's own imports (the kernel's llm and credential
    // modules) are host-provided, and a composition that lacks them must still
    // load this plugin's free lane. `pack.js` is the bundled form of the
    // vendored tree (see scripts/build-channel-pack.mjs) — one file, so the
    // release manifest stays inside its file cap.
    void import('./vendor/channel-pack/pack.js').then(pack => {
      if (stopped) return
      pack.apply(scoped, {
        disableOpencode: true,
        outlet: { active: egressActive, fetch: egressFetch },
      })
      // `apply` is synchronous and ends with `ctx.provide('accountPool', pool)`,
      // so the pool is reachable here. Read it non-strictly: the providing fiber
      // has not reached the active state yet at this point, and a strict `get`
      // returns `undefined` — which would leave the switch silently unarmed.
      // Adapters hold that same object and call the wrapped method on every
      // `listModels()`, so the switch is read live.
      channelVisibility = installChannelCatalogVisibility(scoped.get('accountPool', false), {
        shouldHide: () => settings.get().hideChannelModels === true,
      })
      // 渠道权益扩展：读同一个账号池、同一份凭据，补渠道包没有出口的能力
      // （CodeArts 的活动领取与倍率、Qoder 的目录、Codely 的整条渠道）。
      // 放在 pack.apply 之后：`provide('accountPool', pool)` 是 apply 的最后一步。
      channelExtras = createChannelExtras({
        pool: scoped.get('accountPool', false),
        resolve: ref => scoped.credentials.resolve(ref),
        ownAccounts,
        logger,
      })
      // 自有渠道进模型选择器：目录同步可读，由这里喂一次（账号表 + 权益缓存）。
      void syncOwnCatalog()
      /*
       * 自动诊断：启动后延迟跑一次宿主 `llm.listModels()`，把每个渠道的真实条数
       * 写进 `own-catalog.log`。
       *
       * 为什么必须自动：`hasLoggedInAccount()` 依赖凭据解析，而它在真机上的返回值
       * 从外部观测不到。用户四轮报障「看不到模型」，全部卡在这一环没有观测点
       * （2026-11-24）。延迟 6 秒是等 pack 注册完 adapter、凭据服务就绪。
       */
      const autoDiagnose = async () => {
        try {
          const packs = ['codearts', 'buddy', 'workbuddy', 'lobsterai', 'qoder', 'qodercn', 'trae', 'cline', 'loomy', 'raccoon', 'minimax', 'zcode', 'gemini']
          const counts = []
          const problems = []
          for (const provider of packs) {
            try {
              const models = hostLlm === null ? [] : await hostLlm.listModels(provider)
              const list = Array.isArray(models) ? models : []
              counts.push(`${provider}:${list.length}`)
              if (list.length === 0) {
                // 空分组要看是谁的锅：账号可见性 vs adapter 本身
                const pool = scoped.get('accountPool', false)
                let visible = null
                try { visible = typeof pool?.hasLoggedInAccount === 'function' ? await pool.hasLoggedInAccount(provider) : null } catch { visible = 'threw' }
                problems.push(`${provider}(visible=${visible})`)
              }
            } catch (failure) {
              counts.push(`${provider}:ERR`)
              problems.push(`${provider}(${String(failure?.message ?? failure).slice(0, 60)})`)
            }
          }
          const ownRows = modelRuntime.catalog.filter(entry => entry.channel === 'own')
          diagLog({
            kind: 'auto-diag',
            hostLlm: hostLlm !== null,
            visibilityInstalled: channelVisibility?.installed === true,
            hideChannelModels: settings.get().hideChannelModels === true,
            counts: counts.join(' '),
            empty: problems.join(' ') || 'none',
            ownRows: ownRows.length,
          })
        } catch (failure) {
          diagLog({ kind: 'auto-diag-failed', error: String(failure?.message ?? failure) })
        }
      }
      setTimeout(() => { void autoDiagnose() }, 6000)?.unref?.()
      channelPack = { state: 'ready', error: '' }
      logger.info?.(`our-free-model: free-channel pack mounted (CodeArts, CodeBuddy, and 11 more)${channelVisibility.installed ? ', catalog visibility switch armed' : ''}`)
    }).catch(error => {
      if (stopped) return
      channelPack = { state: 'failed', error: String(error?.message ?? error).slice(0, 300) }
      logger.warn?.(`our-free-model: free-channel pack unavailable (${channelPack.error})`)
    })
  })

  /**
   * 把「自有渠道的账号 + 权益目录」编成模型行喂给运行时。
   *
   * 目录必须同步可读（宿主的 `listModels` 契约不能在渲染路径上等网络），所以权益
   * 查询的结果缓存在这里，账号变化或领取成功后重新编一次。查询失败就退回各渠道
   * 的兜底表 —— 与渠道包那 13 家同一取向：宁可显示少一点，也不要整组消失。
   */
  /**
   * 链路诊断日志：写文件而不是 logger —— 桌面版没有可持续读取的宿主日志，
   * 「新渠道看不到模型」这类问题没有落点就只能猜（2026-11-24 排查实录）。
   * 每行一个 JSON 事件，追加写；文件在数据目录里，用户能直接发回来。
   */
  const diagLog = event => {
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'
      fs.appendFileSync(path.join(dataDir, 'own-catalog.log'), line)
    } catch { /* 诊断日志绝不影响主流程 */ }
  }
  const ownCatalogs = new Map()
  const syncOwnCatalog = async () => {
    diagLog({ kind: 'sync-begin', hasExtras: channelExtras !== undefined && channelExtras.available === true })
    const enabled = {}
    for (const provider of OWN_PROVIDERS) {
      const accounts = ownAccounts.enabled(provider)
      enabled[provider] = accounts.length > 0
      diagLog({ kind: 'provider', provider, accounts: accounts.length, signedIn: enabled[provider] })
      if (accounts.length === 0) continue
      if (!ownCatalogs.has(provider)) {
        try {
          const status = await channelExtras.status(provider)
          ownCatalogs.set(provider, Array.isArray(status?.catalog) ? status.catalog : [])
          diagLog({ kind: 'catalog', provider, rows: ownCatalogs.get(provider).length })
        } catch (error) {
          diagLog({ kind: 'catalog-failed', provider, error: String(error?.message ?? error) })
          logger.warn?.(`our-free-model: ${provider} 目录不可用（${error?.message ?? error}）`)
        }
      }
    }
    const rows = buildOwnCatalog({
      catalogs: Object.fromEntries(ownCatalogs),
      enabled,
      hideAll: settings.get().hideChannelModels === true,
    })
    diagLog({ kind: 'sync-done', rows: rows.length, hideAll: settings.get().hideChannelModels === true })
    modelRuntime.setOwnCatalog(rows)
    diagLog({ kind: 'set', runtimeRows: modelRuntime.catalog.filter(entry => entry.channel === 'own').length })
  }

  /**
   * 浏览器登录（CDP 拦截回调型）：目前只有 Marvis。
   *
   * 流程与设备码同形（`start` 立刻回账号与地址、`poll` 逐次看结果），差别只在
   * 「谁在等」：设备码等上游轮询，这里等**我们截停的回调 URL**。拦截与浏览器
   * 生命周期都在 `src/channels/browser/chromium.js`，本处只管账号落库。
   */
  const browserLogins = new Map()
  /** 走「起浏览器」那条腿的渠道：Marvis 拦回调，Magicrew 读 localStorage。 */
  const BROWSER_LOGIN_PROVIDERS = new Set(['marvis', 'magicrew', 'magicrewintl', 'monkeycode', 'monkeycodeintl', 'baizhi', 'officeace'])
  const BROWSER_LOGIN_TIMEOUT_MS = 240_000

  async function startBrowserChannelLogin(provider, options = {}) {
    if (!BROWSER_LOGIN_PROVIDERS.has(provider)) return { error: `该渠道没有浏览器登录：${provider}` }
    const account = ownAccounts.create(provider)
    let session
    try {
      if (provider === 'marvis') {
        const loginType = options.loginType === '2' ? '2' : '1'
        const guid = crypto.randomUUID()
        const loginUrl = marvisAuthorizeUrl(loginType, guid)
        session = await startChromiumSession({ url: loginUrl, log: message => logger.info?.(`our-free-model: ${message}`) })
        const hook = interceptCallback(session, isMarvisCallbackUrl)
        const flow = { accountId: account.id, provider, session, hook, guid, loginType, done: false, result: undefined }
        hook.promise.then(value => { flow.done = true; flow.result = value ?? null })
        browserLogins.set(account.id, flow)
        return { accountId: account.id, loginUrl, mode: 'browser' }
      }
      // Magicrew：网页登录完成后从 localStorage 读 JWT（键名带 `MAGIC:user:` 前缀）。
      const providerProduct = magicrewProductOf(provider) ?? monkeycodeProductOf(provider)
      const loginUrl = provider === 'monkeycode' || provider === 'monkeycodeintl'
        ? `${providerProduct.platformBase}/`
        : `${providerProduct.webOrigin}/login`
      session = await startChromiumSession({ url: loginUrl, log: message => logger.info?.(`our-free-model: ${message}`) })
      const flow = {
        accountId: account.id,
        provider,
        product: providerProduct,
        session,
        done: false,
        deadline: Date.now() + BROWSER_LOGIN_TIMEOUT_MS,
      }
      browserLogins.set(account.id, flow)
      return { accountId: account.id, loginUrl, mode: 'browser' }
    } catch (error) {
      // 浏览器起不来就把占位账号删掉，否则面板会留一条永远登不上的空账号。
      await ownAccounts.remove(account.id).catch(() => {})
      session?.close?.()
      return { error: String(error?.message ?? error) }
    }
  }

  /** 收掉一条浏览器流程（幂等）。 */
  function closeBrowserFlow(accountId) {
    const flow = browserLogins.get(accountId)
    if (flow === undefined) return undefined
    browserLogins.delete(accountId)
    try { flow.hook?.dispose?.() } catch { /* 已释放 */ }
    try { flow.session?.close?.() } catch { /* 已关 */ }
    return flow
  }

  async function pollBrowserChannelLogin(accountId) {
    const flow = browserLogins.get(accountId)
    if (flow === undefined) return { done: true, success: false, error: '登录流程不存在或已结束，请重新发起' }

    if (flow.provider === 'officeace') {
      if (flow.done !== true) return { done: false, status: 'pending' }
      closeBrowserFlow(accountId)
      const callback = flow.result
      if (typeof callback !== 'string' || callback === '') {
        await ownAccounts.remove(accountId).catch(() => {})
        return { done: true, success: false, error: '登录窗口已关闭或超时，请重新发起' }
      }
      let code = ''
      try { code = new URL(callback).searchParams.get('code') ?? '' } catch { code = '' }
      if (code === '') { await ownAccounts.remove(accountId).catch(() => {}); return { done: true, success: false, error: '回调里没有 code' } }
      // ⚠️ code 秒级过期：这里**立刻**换，不拆两步。
      const exchanged = await exchangeOfficeaceCode({ code, codeVerifier: flow.codeVerifier, privateJwk: flow.privateJwk })
      if (exchanged.error !== undefined) {
        await ownAccounts.remove(accountId).catch(() => {})
        return { done: true, success: false, error: exchanged.error }
      }
      await ownAccounts.attach(accountId, exchanged.credential, { nickname: OFFICEACE.displayName })
      void syncOwnCatalog()
      return { done: true, success: true, nickname: OFFICEACE.displayName }
    }

    if (flow.provider === 'marvis') {
      if (flow.done !== true) return { done: false, status: 'pending' }
      closeBrowserFlow(accountId)
      const callback = flow.result
      if (typeof callback !== 'string' || callback === '') {
        await ownAccounts.remove(accountId).catch(() => {})
        return { done: true, success: false, error: '登录窗口已关闭或超时，请重新发起' }
      }
      let parsed
      try { parsed = new URL(callback) } catch { parsed = null }
      const code = parsed?.searchParams.get('code') ?? ''
      if (code === '') {
        await ownAccounts.remove(accountId).catch(() => {})
        return { done: true, success: false, error: '授权被拒绝（回调里没有 code）' }
      }
      const state = parsed.searchParams.get('state') ?? undefined
      const exchanged = await exchangeMarvisCode({ code, loginType: flow.loginType, guid: flow.guid, state })
      if (exchanged.error !== undefined) {
        await ownAccounts.remove(accountId).catch(() => {})
        return { done: true, success: false, error: exchanged.error }
      }
      const credential = exchanged.credential
      const nickname = typeof credential.nickname === 'string' ? credential.nickname : undefined
      await ownAccounts.attach(accountId, credential, {
        ...nickname === undefined ? {} : { nickname },
        ...typeof credential.expires_at === 'number' ? { expiresAt: credential.expires_at } : {},
      })
      void syncOwnCatalog()
      return { done: true, success: true, ...nickname === undefined ? {} : { nickname } }
    }

    // Magicrew：每轮读一次页面里的实时 localStorage（Chromium 会把它缓在内存，
    // 落盘要等关窗 —— 所以只能走 `Runtime.evaluate`，不能读磁盘 leveldb）。
    if (Date.now() > flow.deadline) {
      closeBrowserFlow(accountId)
      await ownAccounts.remove(accountId).catch(() => {})
      return { done: true, success: false, error: '登录窗口已关闭或超时，请重新发起' }
    }
    // MonkeyCode：会话是 **HttpOnly cookie**（`document.cookie` 读不到），
    // 只能走 CDP 的 `Network.getCookies`；拿到后当场签网关凭据（两件一起收）。
    // 百智云：控制台 cookie → 换 `sk-` Key；401/403 是「登录态还没生效」，继续等。
    if (flow.provider === 'baizhi') {
      let cookie
      try {
        const list = await flow.session.cookies('https://baizhi.cloud/')
        cookie = list.filter(item => typeof item?.name === 'string' && typeof item?.value === 'string').map(item => `${item.name}=${item.value}`).join('; ')
      } catch {
        return { done: false, status: 'pending' }
      }
      if (cookie === '') return { done: false, status: 'pending' }
      const exchanged = await exchangeBaizhiKey({ session_cookie: cookie })
      if (exchanged.error !== undefined) {
        // 还没生效：保持 pending，下一轮再试（不要删账号）。
        if (exchanged.notEffective === true) return { done: false, status: 'pending' }
        closeBrowserFlow(accountId)
        await ownAccounts.remove(accountId).catch(() => {})
        return { done: true, success: false, error: exchanged.error }
      }
      closeBrowserFlow(accountId)
      await ownAccounts.attach(accountId, exchanged.credential, { nickname: BAIZHI.displayName })
      void syncOwnCatalog()
      return { done: true, success: true, nickname: BAIZHI.displayName }
    }

    if (flow.provider === 'monkeycode' || flow.provider === 'monkeycodeintl') {
      let cookie
      try {
        cookie = sessionCookieOf(await flow.session.cookies(flow.product.platformBase), flow.product)
      } catch {
        return { done: false, status: 'pending' }
      }
      if (cookie === undefined) return { done: false, status: 'pending' }
      const issued = await issueMonkeycodeKey({ session_cookie: cookie }, flow.product)
      closeBrowserFlow(accountId)
      if (issued.error !== undefined) {
        await ownAccounts.remove(accountId).catch(() => {})
        return { done: true, success: false, error: issued.error }
      }
      await ownAccounts.attach(accountId, issued.credential, { nickname: flow.product.displayName })
      void syncOwnCatalog()
      return { done: true, success: true, nickname: flow.product.displayName }
    }
    let harvested
    try {
      harvested = parseMagicrewHarvest(await flow.session.evaluate(MAGICREW_HARVEST_EXPRESSION))
    } catch {
      // 页面还在跳转/被关掉：当作「还没好」，下一轮再看。
      return { done: false, status: 'pending' }
    }
    if (harvested === undefined) return { done: false, status: 'pending' }
    const completed = await completeMagicrewLogin(flow.product, harvested)
    closeBrowserFlow(accountId)
    if (completed.error !== undefined) {
      await ownAccounts.remove(accountId).catch(() => {})
      return { done: true, success: false, error: completed.error }
    }
    const credential = completed.credential
    await ownAccounts.attach(accountId, credential, {
      ...typeof credential.apiKeyExpiresAt === 'number' ? { expiresAt: credential.apiKeyExpiresAt } : {},
    })
    void syncOwnCatalog()
    return { done: true, success: true, nickname: flow.product.displayName }
  }

  /** 取消一条浏览器登录（用户手动关掉流程时调用）。 */
  function cancelBrowserLogin(accountId) {
    return closeBrowserFlow(accountId) !== undefined
  }

  const logAdmissionRejection = surface => ({ status, source, reason }) => {
    // Fixed fields only: headers, request URLs and admission errors may contain
    // credentials. JSON API and SSE must report the same admission boundary.
    logger.warn?.(`our-free-model: ${surface} admission rejected status=${status} source=${source} reason=${reason}`)
  }
  const api = createApiRoutes({
    settings, stats, availability, catalog: () => modelRuntime.catalog, state,
    refreshCatalog, refreshAvailability, syncForward, syncRelay, syncEgress,
    pool: fetchPoolSnapshot,
    eacAuth,
    // 浏览器登录（CDP 拦截回调）：与设备码同形的两步式，由自己起的 Chromium 完成。
    browserLogin: { start: startBrowserChannelLogin, poll: pollBrowserChannelLogin, cancel: cancelBrowserLogin },
    // ── the aggregate lane's settings surface ────────────────────────────────
    // The registry is static data; the configured half is the settings file with
    // every key masked. Writing one provider rebuilds the catalog and re-emits
    // the topology, because a provider the picker cannot see is a provider the
    // user cannot use, and the picker is driven by `llm/adapters-updated`.
    providers: {
      registry: publicProviderRegistry,
      configured: () => publicAggregate(settings.get().aggregate),
      save: async patch => {
        if (patch === null || typeof patch !== 'object') throw httpError(400, 'the request body must be a JSON object')
        const id = String(patch.providerId ?? '').trim()
        const provider = getProvider(id)
        if (provider === null) throw httpError(400, `unknown provider "${id}"`)
        const section = settings.get().aggregate ?? {}
        const providers = { ...(section.providers ?? {}) }
        const previous = providers[id] ?? {}
        const next = { ...previous, addedAt: Number.isFinite(previous.addedAt) && previous.addedAt > 0 ? previous.addedAt : Date.now() }
        if (patch.enabled !== undefined) next.enabled = patch.enabled === true
        // An absent field keeps the stored value; an empty string clears it. That
        // is the difference between "the page did not touch the key" and "the user
        // emptied the box", and conflating them silently kept a key the user
        // believed they had removed.
        if (typeof patch.apiKey === 'string') next.apiKey = patch.apiKey.trim().slice(0, 512)
        if (typeof patch.baseUrl === 'string') {
          const url = patch.baseUrl.trim()
          if (url !== '' && !/^https?:\/\//i.test(url)) throw httpError(400, 'baseUrl must be an http(s) URL')
          next.baseUrl = url.slice(0, 512)
        }
        if (Array.isArray(patch.models)) next.models = patch.models.map(value => String(value ?? '').trim()).filter(value => value !== '').slice(0, 300)
        providers[id] = next
        settings.update({ aggregate: { ...section, providers } })
        settings.flush()
        syncAggregateCatalog()
        return publicAggregate(settings.get().aggregate)
      },
      remove: async id => {
        const section = settings.get().aggregate ?? {}
        const providers = { ...(section.providers ?? {}) }
        delete providers[String(id ?? '').trim()]
        settings.update({ aggregate: { ...section, providers } })
        settings.flush()
        syncAggregateCatalog()
        return publicAggregate(settings.get().aggregate)
      },
      test: async id => {
        const providerId = String(id ?? '').trim()
        if (getProvider(providerId) === null) throw httpError(400, `unknown provider "${providerId}"`)
        const result = await testProvider(settings.get().aggregate ?? {}, providerId)
        // The verdict is persisted so the page can show "verified 3 minutes ago"
        // without spending a probe on every mount. It is a reading, not a
        // credential, so it rides the public section as-is.
        const section = settings.get().aggregate ?? {}
        const providers = { ...(section.providers ?? {}) }
        if (providers[providerId] !== undefined) {
          providers[providerId] = { ...providers[providerId], lastTest: { at: Date.now(), ok: result.ok === true, status: result.status ?? 0, message: String(result.message ?? '').slice(0, 300) } }
          settings.update({ aggregate: { ...section, providers } })
          settings.flush()
        }
        return result
      },
      discover: async id => {
        const providerId = String(id ?? '').trim()
        if (getProvider(providerId) === null) throw httpError(400, `unknown provider "${providerId}"`)
        const ids = await fetchProviderModels(settings.get().aggregate ?? {}, providerId)
        if (ids === null) return { models: null, note: 'this provider declares no model listing' }
        const section = settings.get().aggregate ?? {}
        const providers = { ...(section.providers ?? {}) }
        if (providers[providerId] !== undefined) {
          providers[providerId] = { ...providers[providerId], discovered: ids.slice(0, 300) }
          settings.update({ aggregate: { ...section, providers } })
          settings.flush()
          syncAggregateCatalog()
        }
        return { models: ids }
      },
    },
    // ── fallback chains ─────────────────────────────────────────────────────
    combos: {
      list: () => ({
        combos: normalizeCombos(settings.get().combos),
        // Every id a chain may reference, with the display name the picker uses —
        // the editor offers a searchable list instead of a free-text field, so a
        // typo cannot become a chain link that silently never resolves.
        models: state().catalog.map(entry => ({ id: entry.id, name: entry.name, channel: entry.channel ?? 'free', vision: entry.vision === true })),
        strategies: ['fallback', 'round-robin'],
      }),
      save: async patch => {
        if (patch === null || typeof patch !== 'object') throw httpError(400, 'the request body must be a JSON object')
        const rows = normalizeCombos(patch.combos)
        // Stored as entered. Links that name nothing right now are kept on purpose:
        // a chain that reaches an EAC model is still correct on a day the lane is
        // closed, and dropping the link would quietly rewrite the user's chain.
        settings.update({ combos: rows })
        settings.flush()
        const catalog = syncAggregateCatalog()
        return { combos: rows, usable: catalog.filter(isComboEntry).map(entry => ({ id: entry.id, name: entry.name, models: entry.combo })) }
      },
    },
    // ── token savers ────────────────────────────────────────────────────────
    tokenSaver: {
      get: () => ({ ...publicTokenSaver(settings.get().tokenSaver), savings: buildStats(stats.get(), state().catalog).savings }),
      set: async patch => {
        if (patch === null || typeof patch !== 'object') throw httpError(400, 'the request body must be a JSON object')
        const current = settings.get().tokenSaver ?? {}
        const prompts = { ...(current.prompts ?? {}) }
        if (patch.prompts !== null && typeof patch.prompts === 'object') {
          if (patch.prompts.caveman !== undefined) {
            const level = String(patch.prompts.caveman)
            if (!CAVEMAN_LEVELS.includes(level)) throw httpError(400, `caveman level must be one of ${CAVEMAN_LEVELS.join(', ')}`)
            prompts.caveman = level
          }
          if (patch.prompts.ponytail !== undefined) {
            const level = String(patch.prompts.ponytail)
            if (!PONYTAIL_LEVELS.includes(level)) throw httpError(400, `ponytail level must be one of ${PONYTAIL_LEVELS.join(', ')}`)
            prompts.ponytail = level
          }
        }
        settings.update({ tokenSaver: {
          ...current,
          prompts,
          ...patch.enabled === undefined ? {} : { enabled: patch.enabled === true },
          ...patch.rtk === undefined ? {} : { rtk: patch.rtk === true },
        } })
        settings.flush()
        return publicTokenSaver(settings.get().tokenSaver)
      },
    },
    // ── the five local answers ──────────────────────────────────────────────
    localOptimize: {
      get: () => publicLocalOptimize(settings.get().localOptimize),
      set: async patch => {
        if (patch === null || typeof patch !== 'object') throw httpError(400, 'the request body must be a JSON object')
        const current = settings.get().localOptimize ?? {}
        const next = { ...current }
        if (patch.enabled !== undefined) next.enabled = patch.enabled === true
        for (const kind of OPTIMIZATION_KINDS) if (patch[kind] !== undefined) next[kind] = patch[kind] === true
        settings.update({ localOptimize: next })
        settings.flush()
        return publicLocalOptimize(settings.get().localOptimize)
      },
    },
    // Connection recipes for the local gateway, generated from the live port and
    // key so the page never shows a stale address after a port fallback.
    clients: () => clientSnippets({
      forward: { running: forward !== null, port: forward?.port ?? 0, lan: { running: relay !== null, port: relay?.port ?? 0, addresses: lanAddresses() } },
      key: settings.get().forwardKey ?? '',
      lanKey: settings.get().forwardLanKey ?? '',
      models: publicModelRows().map(row => row.id),
    }),
    // The absorbed channel pack's liveness, for the 白嫖接入 page: the page
    // renders its channel grid from this bit plus the pack's own RPC.
    channels: () => channelPack,
    // 渠道权益扩展（余额明细 / 活动领取 / 倍率）。与 `channels` 分开：它读的是
    // 「同一份账号与凭据」，但不依赖渠道包的 RPC 面，因此渠道包降级时这一路
    // 仍能回答自己为什么不可用。
    channelExtras: () => channelExtras,
    // 本插件自己的渠道（渠道包不认识的）：账号表与两步式登录流程。
    // 传的是对象（`list` / `update` / `remove` 都要用），不是单个函数。
    channelAccounts: () => ownAccounts,
    // 账号/目录变化后重编自有渠道的模型行（选择器与网关都读同一份 catalog）。
    syncOwnCatalog: () => syncOwnCatalog(),
    deviceLogin: () => deviceLogin,
    smsLogin: () => smsLogin,
    // The catalog visibility switch lives in `apply`'s scope (it wraps the pool
    // the pack provides on mount), so the route reaches it through here.
    channelVisibility: () => channelVisibility,
    // Rebuilding the catalog is what makes the picker drop the hidden groups:
    // the client caches one catalog per Host generation, so it needs the event.
    onTopology: () => emitTopology(),
    chanRelay: {
      status: chanRelayStatus,
      apply: async patch => {
        const current = settings.get().chanGateway ?? {}
        const relay = { ...(current.relay ?? {}) }
        if (patch === null || typeof patch !== 'object') throw httpError(400, 'the request body must be a JSON object')
        if (patch.enabled !== undefined) relay.enabled = patch.enabled === true
        if (patch.host !== undefined) {
          const host = String(patch.host ?? '').trim()
          if (host !== '' && host !== '127.0.0.1' && host !== 'localhost' && host !== '0.0.0.0' && host !== '::') {
            throw httpError(400, 'host must be one of 127.0.0.1, localhost, 0.0.0.0, ::')
          }
          relay.host = host === 'localhost' ? '127.0.0.1' : host
        }
        if (patch.port !== undefined) {
          const port = Number(patch.port)
          if (!Number.isInteger(port) || port < 0 || port > 65535) throw httpError(400, 'port must be an integer between 0 and 65535')
          relay.port = port
        }
        settings.update({ chanGateway: { ...current, relay } })
        settings.flush()
        await syncChanRelay()
        return chanRelayStatus()
      },
      key: () => chanRelayKey(),
      rotate: rotateChanRelayKey,
    },
    // Whether the co-paid lane is open on this host at all — the settings page's
    // one-bit answer to "why do I see no EAC group" (issue #60). Reads the gate,
    // not the listing: a closed gate and a dead relay are different sentences.
    laneAvailable: () => sealedCredentialOf() !== null,
    forwardInfo: () => ({
      running: forward !== null,
      port: forward?.port ?? 0,
      error: forwardError,
      notice: forwardNotice,
      egress: modelRuntime.egress,
      lan: {
        running: relay !== null,
        port: relay?.port ?? 0,
        host: relay?.host ?? '',
        error: relayError,
        addresses: lanAddresses(),
      },
    }),
    // The subscription URL is a credential: only its masked label ever leaves
    // this process. `active` mirrors what egressFetch is actually doing right
    // now (direct until the relay finishes starting, direct again once closed).
    egressInfo: () => ({
      running: outletRelay !== null,
      active: outletRelay !== null,
      mode: outletRelay?.mode ?? '',
      outlet: outletRelay === null ? '' : outletLabel(outletRelay.url ?? ''),
      // Cached readings: `/summary` is synchronous, so the live controller call
      // lives in `outletStatus` below and only the last answer is echoed here.
      node: outletNode.node,
      nodeDelayMs: outletNode.delayMs,
      nodeAt: outletNode.at,
      latencyMs: modelRuntime.gatewayLatency.ms,
      latencyAt: modelRuntime.gatewayLatency.at,
      // `dead` is the managed mihomo dying after startup — surfaced through the
      // same field so the settings page shows why traffic fell back to direct.
      error: outletError !== '' ? outletError : (outletRelay?.dead ?? ''),
    }),
    // The settings page polls this while the outlet is on: which node url-test is
    // carrying traffic on is mihomo's own state, and it changes without anything
    // else in this process moving.
    outletStatus: () => readOutletStatus(),
    rotateKey: () => {
      const minted = generateKey()
      settings.update({ forwardKey: minted })
      settings.flush()
      return minted
    },
    rotateLanKey: () => {
      const minted = generateKey()
      settings.update({ forwardLanKey: minted })
      settings.flush()
      return minted
    },
    testModel: async (id, effort) => {
      const entry = modelRuntime.catalog.find(candidate => candidate.id === id)
      if (entry === undefined) throw new UpstreamError(`unknown model "${id}"`, CODE.server)
      const started = Date.now()
      let firstFrame
      let sawReasoning = false
      let text = ''
      let usage
      for await (const chunk of adapter.stream({
        provider: ROUTE_MAIN,
        model: entry.id,
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        reasoningEffort: effort === undefined || effort === '' ? DEFAULT_LEVEL : effort,
        sessionId: `bench:${entry.id}:${effort ?? DEFAULT_LEVEL}`,
      }, entry, state())) {
        if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
          if (firstFrame === undefined) firstFrame = Date.now()
          if (chunk.type === 'reasoning-delta') sawReasoning = true
          if (chunk.type === 'text-delta') text += chunk.text
        }
        if (chunk.type === 'usage') usage = chunk.usage
        if (chunk.type === 'finish' && chunk.reason.kind !== 'stop' && chunk.reason.kind !== 'tool-calls') {
          throw new UpstreamError(chunk.reason.failure?.message ?? chunk.reason.kind, chunk.reason.failure?.code ?? CODE.server)
        }
      }
      const ms = Date.now() - started
      // Same rule as the recorded calls: the rate divides only by a window that
      // actually covers the tokens in its numerator.
      const measured = decodeWindow(firstFrame === undefined ? 0 : ms - firstFrame, windowTokens(usage, sawReasoning), true)
      return {
        model: entry.id, effort: effort ?? DEFAULT_LEVEL, ok: true,
        totalMs: ms,
        ttftMs: firstFrame === undefined ? ms : firstFrame - started,
        outputTokens: usage?.outputTokens ?? 0,
        reasoningTokens: usage?.reasoningTokens ?? 0,
        tokensPerSecond: measured.tps,
        sample: text.slice(0, 60),
      }
    },
    meta: () => ({
      version: packageVersion,
      distribution,
      generation,
      reloadedAt: settings.get().reloadedAt ?? 0,
      reloadCount: settings.get().reloadCount ?? 0,
      dataDir,
      autoReloadWatch: settings.get().autoReloadWatch === true,
      lastReload: globalThis[Symbol.for('our-free-model.last-reload')] ?? undefined,
      purgeSample: globalThis[Symbol.for('our-free-model.purge-sample')] ?? undefined,
    }),
    announcements: {
      view: feedView,
      /** Persist the complete acked set the caller assembled (full-replace
       *  semantics: the caller decides additions *and* clearings). */
      ack: ids => {
        settings.update({ announcementsAcked: [...ids] })
        settings.flush()
        return feedView()
      },
      refresh: () => feed.poll(),
    },
    update: {
      status: () => managed
        ? { ...updater.status(), managed: true, available: false, latest: '' }
        : { ...updater.status(), notifiedFor: updateNotifiedFor },
      check: async () => {
        if (managed) throw httpError(409, MANAGED_MESSAGE)
        const result = await updater.check()
        pushUpdate(true)
        return result
      },
      apply: applyUpgrade,
    },
    hotReload: () => {
      if (managed) throw httpError(409, MANAGED_MESSAGE)
      return reloadFromDisk()
    },
    /** Fixed for this generation; the settings API cannot flip it (see below). */
    managedDistribution: managed,
    push,
    connection: fenceConnection,
    onAdmissionRejection: logAdmissionRejection('settings API'),
    /** Read on every ask, so a machine that changed networks answers with the
     *  interfaces it has now rather than the ones the relay started on. */
    lanAddresses,
    logger,
  })

  // The dashboard half runs in its own fiber so that a composition without an
  // HTTP server cannot take the model lane down with it.
  //
  // `ctx.inject(deps, callback)` is cordis' "run this once these services exist":
  // the callback pends while `webServer` is absent *or merely not provided yet*,
  // and is re-run if the service is replaced. That pending is the whole point —
  // reading `ctx.get('webServer')` once at apply time answered `undefined` in the
  // real web composition (plugins load before the browser half publishes it), the
  // routes never registered, and the settings page had no data source while a web
  // server was busy serving it.
  ctx.inject(['webServer'], scoped => {
    const server = scoped.webServer
    scoped.effect(() => server.register({ kind: 'prefix', path: '/api/our-free-model', handler: api }), 'our-free-model: api routes')
    // The events stream is an exact route: exact dispatch outranks the prefix, so
    // the hub's handler owns the socket while every other path still lands on the
    // JSON API.
    scoped.effect(() => server.register({ kind: 'exact', path: '/api/our-free-model/events', handler: eventsRoute }), 'our-free-model: events stream')
    logger.info?.('our-free-model: settings API mounted at /api/our-free-model')
  })

  /** Adopt one request as a live push stream, after the trust fence. */
  function eventsRoute(req, res) {
    const rejection = rejectionFor(req, fenceConnection, logAdmissionRejection('events'))
    if (rejection !== undefined) {
      res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(rejection === 401 ? 'unauthorized' : rejection === 503 ? 'admission unavailable' : 'forbidden')
      return
    }
    push.attach(req, res, helloPayload())
  }

  function helloPayload() {
    return {
      version: packageVersion,
      announcements: { unread: feedView().unread, fetchedAt: feedView().fetchedAt },
      update: { available: updater.status().available, latest: updater.status().latest },
      reloadedAt: settings.get().reloadedAt ?? 0,
    }
  }

  // ── boot + background loop ──────────────────────────────────────────────────
  ctx.effect(() => () => {
    modelRuntime.dispose()
    stores.dispose()
  }, 'our-free-model: stores')

  ctx.effect(() => () => {
    void forward?.close().catch(() => {})
    void relay?.close().catch(() => {})
    void chanRelay?.close().catch(() => {})
    void outletRelay?.close().catch(() => {})
  }, 'our-free-model: forward listener')

  ctx.effect(() => () => { registration() }, 'our-free-model: adapter routes')

  ctx.effect(() => () => {
    disposed = true
    eacLoginPoller.reset()
    // The geography-reprobe timer belongs to this generation; without this it
    // outlives teardown and fires a forced probe round after the stores it
    // reads have been disposed (the rejection gets swallowed, quota burned).
    modelRuntime.dispose()
    push.dispose()
    watcher?.()
  }, 'our-free-model: push + watcher')

  ctx.effect(() => {
    void (async () => {
      modelRuntime.setAttributionUserAgent(await resolveAttributionUserAgent(logger))
      if (disposed) return
      // First: the catalog refresh and its probe round below go through
      // egressFetch, so the outlet must be carrying traffic before they run.
      await syncEgress()
      if (disposed) return
      // The listeners next, ahead of the round that goes out: they answer local
      // sockets and nothing in them depends on the gateway. Binding them after
      // the full listing + probe round meant a lane that stalled held the port
      // down for the whole round — the settings page still said it was on, and
      // it only started when the user clicked 应用, whose POST calls
      // `syncForward()` by itself.
      await syncForward()
      if (disposed) return
      await syncRelay()
      if (disposed) return
      await syncChanRelay()
      if (disposed) return
      // Every await here is a chance for teardown to have run underneath this
      // boot: a resumed refresh would force a probe round against stores it
      // disposed. The round is boot's only network step, so it is the one held
      // to a failure of its own — a throw here used to take the watcher, the
      // topology event and the upgrade marker below down with it, reported as
      // a single "startup refresh failed" line.
      try {
        await refreshCatalog({ probe: true, force: true })
      } catch (error) {
        logger.warn?.(`our-free-model: startup refresh failed (${error?.message ?? error})`)
      }
      if (disposed) return
      syncWatcher()
      emitTopology()
      push.emit('hello', helloPayload())
    })().catch(error => logger.warn?.(`our-free-model: startup refresh failed (${error?.message ?? error})`))
  }, 'our-free-model: boot refresh')

  // Feed poll: shortly after boot, then on the configured period. Concurrency
  // with a manual refresh is harmless — polls share one in-flight request.
  // A managed install polls nothing: the pack speaks for the plugin.
  ctx.effect(() => {
    if (managed) return
    const first = setTimeout(() => { void feed.poll() }, 12_000)
    first.unref?.()
    return () => clearTimeout(first)
  }, 'our-free-model: first feed poll')

  /**
   * Run one task every `ms` for as long as this generation lives.
   *
   * A plain unref'd timer chain, on purpose. `ctx.interval` is a mixin over the
   * `timer` service, and reading it from a fiber that did not name `timer` in
   * `inject` throws inside the real cordis proxy (`cannot get property "timer"
   * without inject`) instead of answering `undefined` — that one read is what
   * stopped the whole plugin from activating. `timer` is not worth declaring on a
   * headless composition, and the mixin adds nothing here beyond `setTimeout` plus
   * a disposer: it must not hold the process open, and `disposed` ends it when the
   * fiber goes away. Without any loop the availability probe would run once at
   * boot, so a model that throttled, recovered, or moved behind the region gate
   * would keep the picker position it was first given.
   */
  // `ms` may be a function: the period is re-read on every re-arm, so an
  // interval changed on the settings page takes effect from the next cycle
  // instead of echoing a number the running timer will never observe.
  function every(task, ms) {
    const period = () => typeof ms === 'function' ? ms() : ms
    let handle = setTimeout(function tick() {
      if (disposed) return
      task()
      handle = setTimeout(tick, period())
      handle.unref?.()
    }, period())
    handle.unref?.()
    ctx.effect(() => () => clearTimeout(handle), 'our-free-model: interval')
  }

  if (!managed) {
    every(() => {
      void feed.poll()
      const hours = settings.get().updateCheckHours ?? 6
      if (hours > 0) void updater.check().then(() => pushUpdate(false)).catch(() => {})
    }, () => positiveOr(settings.get().feedPollMinutes, 30, 5) * 60_000)
  }
  // The probe period is in minutes, and one minute is the floor — a value of 0 or
  // a negative one would otherwise spin. This used to read `Math.max(60, …)`,
  // which floored every interval below an hour *including the shipped default of
  // 15*, so the number on the settings page was silently ignored.
  every(() => {
    void (async () => {
      await watchEgress()
      await refreshCatalog({ probe: true })
    })().catch(error => logger.warn?.(`our-free-model: periodic refresh failed (${error?.message ?? error})`))
  }, () => positiveOr(settings.get().probeIntervalMinutes, 15, 1) * 60_000)
  // A failing egress watch means the network is down, which is worth one line —
  // and only the first of a streak, or a dead link would write every two minutes
  // until the next restart. A success resets the flag for the next outage.
  let egressWarned = false
  every(() => {
    void watchEgress()
      .then(() => {
        egressWarned = false
        // url-test re-ranks on its own 5-minute cycle; the node shown on the
        // settings page follows the same cadence as the exit reading.
        void readOutletStatus().catch(() => {})
      })
      .catch(error => {
        if (!egressWarned) logger.warn?.(`our-free-model: egress watch failed (${error?.message ?? error})`)
        egressWarned = true
      })
  }, 120_000)
  // The first update check waits for the boot refresh to settle, then runs once
  // even when the periodic poll is disabled (hours === 0 means opt out fully).
  // Managed installs check nothing — the pack that installed them decides.
  ctx.effect(() => {
    if (managed) return
    const first = setTimeout(() => {
      const hours = settings.get().updateCheckHours ?? 6
      if (hours <= 0) return
      void updater.check().then(() => pushUpdate(false)).catch(() => {})
    }, 40_000)
    first.unref?.()
    return () => clearTimeout(first)
  }, 'our-free-model: first update check')

  // Keep the module-level "notified" marker in sync with the stored one so a
  // reload does not re-toast the same version.
  refreshUpdatePush = () => pushUpdate(false)

  function emitTopology() {
    try { ctx.emit?.('llm/adapters-updated') } catch { /* no listener surface */ }
    registration.replace(routes())
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * An error the settings API presents with its own status line, not a bare 500.
 * Used where a refusal is the *correct* answer — a managed install declining to
 * update itself — so the page can say why instead of blaming a fault.
 */
function httpError(statusCode, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  return error
}

/**
 * A period that cannot become a hot loop.
 *
 * `setTimeout(fn, NaN)` is `setTimeout(fn, 1)` in Node, and a settings file the
 * user edits by hand (the only way in on a headless composition) can carry
 * anything. Both timers below take their period from a stored number, so the
 * guard belongs here rather than in each caller.
 */function positiveOr(value, fallback, floor = 1) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.max(floor, Math.trunc(number))
}

/**
 * Coerce the settings a timer or the wire reads.
 *
 * The settings page's own cleared input field posts `0`: on the output ceiling
 * that read as `min(model capacity, 0)` and every turn came back capped at the
 * 512-token floor, and on a period it asked for a probe round a minute. A value
 * that is not a positive number is "the user did not set one", so it falls back
 * to what ships rather than being clamped into an extreme.
 */
function sanitizeSettings(patch, current) {
  const next = { ...patch }
  const positive = (key, fallback) => {
    if (next[key] === undefined) return
    const value = Number(next[key])
    next[key] = Number.isFinite(value) && value > 0 ? Math.trunc(value) : (Number(current[key]) || fallback)
  }
  positive('probeIntervalMinutes', 15)
  positive('feedPollMinutes', 30)
  positive('defaultMaxTokens', 32768)
  if (next.updateCheckHours !== undefined) {
    // Zero is a real answer here: it means "stop checking for updates".
    const hours = Number(next.updateCheckHours)
    next.updateCheckHours = Number.isFinite(hours) && hours >= 0 ? Math.trunc(hours) : (Number(current.updateCheckHours) || 6)
  }
  return next
}

/**
 * Resolve an image attachment into a data URL the provider can accept.
 *
 * The attachment service exposes a host path, not bytes; reading it here keeps the
 * plugin free of a second credential path. An unresolvable image is reported as a
 * warning and dropped — the runtime has already text-projected files, and a
 * text-only model never sees an image block in the first place.
 */
function imageResolver(ctx, logger) {
  if (typeof ctx.get !== 'function') return undefined
  const cache = new Map()
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024
  return ref => {
    // Looked up per call, not once at apply time: this is the third instance of
    // the same cordis trap the release note describes for `webServer` and
    // `connection` — a service that plugins load before is not provided yet, so a
    // one-shot read silently cost the whole feature (here: image attachments,
    // with nothing in the log to say so).
    const attachments = ctx.get('attachments')
    if (attachments === undefined || typeof attachments.imageHostPath !== 'function') return undefined
    const id = String(ref?.attachmentId ?? '')
    if (id === '') return undefined
    const cached = cache.get(id)
    if (cached !== undefined) return cached
    try {
      const hostPath = attachments.imageHostPath(ref)
      if (typeof hostPath !== 'string' || hostPath === '') return undefined
      const size = fs.statSync(hostPath).size
      if (size > MAX_IMAGE_BYTES) { logger.warn?.(`our-free-model: image ${id} is ${size} bytes, above the ${MAX_IMAGE_BYTES} send limit`); return undefined }
      const media = typeof ref.mediaType === 'string' ? ref.mediaType : 'image/png'
      const url = `data:${media};base64,${fs.readFileSync(hostPath).toString('base64')}`
      if (cache.size > 48) cache.clear()
      cache.set(id, url)
      return url
    } catch (error) {
      logger.warn?.(`our-free-model: could not read image ${id} (${error?.message ?? error})`)
      return undefined
    }
  }
}

/**
 * The settings page's HTTP surface.
 *
 * Every route runs the trust fence first: the connection service's own
 * admission when the composition mounts it (the same check the kernel applies
 * to `/api`), otherwise the structural replica in src/trust.js. The plugin's
 * prefix outranks `/api` in webServer's longest-prefix dispatch, so without
 * this fence these routes would answer callers the app itself would refuse.
 */
/** The fixed failure classes the pool proxy may surface to the client. */
const POOL_REASONS = new Set(['no-lane', 'gateway-status', 'malformed', 'unreachable'])

function createApiRoutes(deps) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const routePath = url.pathname.replace(/^\/api\/our-free-model/, '').replace(/\/+$/, '') || '/'
    const method = String(req.method ?? 'GET').toUpperCase()
    const rejection = rejectionFor(req, deps.connection, deps.onAdmissionRejection)
    const send = (status, payload) => {
      const body = JSON.stringify(payload)
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(body)
    }
    if (rejection !== undefined) return send(rejection, {
      error: rejection === 401 ? 'unauthorized' : rejection === 503 ? 'admission unavailable' : 'forbidden',
    })
    try {
      if (method === 'GET' && routePath === '/summary') {
        return send(200, buildSummary(deps))
      }
      if (method === 'GET' && routePath === '/stats') {
        return send(200, buildStats(deps.stats.get(), deps.catalog()))
      }
      if (method === 'GET' && routePath === '/outlet') {
        return send(200, await deps.outletStatus())
      }
      // ── the aggregate lane ─────────────────────────────────────────────────
      if (method === 'GET' && routePath === '/providers') {
        const id = url.searchParams.get('id')
        if (id !== null && id !== '') {
          const provider = getProvider(id)
          if (provider === null) return send(404, { error: `unknown provider "${id}"` })
          return send(200, { provider, configured: publicAggregate(deps.settings.get().aggregate).providers[id] ?? null })
        }
        return send(200, { registry: deps.providers.registry(), configured: deps.providers.configured() })
      }
      if (method === 'POST' && routePath === '/providers') {
        const body = await readJson(req)
        return send(200, { ok: true, aggregate: await deps.providers.save(body) })
      }
      if (method === 'POST' && routePath === '/providers/remove') {
        const body = await readJson(req)
        return send(200, { ok: true, aggregate: await deps.providers.remove(body?.providerId) })
      }
      if (method === 'POST' && routePath === '/providers/test') {
        const body = await readJson(req)
        return send(200, await deps.providers.test(body?.providerId))
      }
      if (method === 'POST' && routePath === '/providers/discover') {
        const body = await readJson(req)
        return send(200, await deps.providers.discover(body?.providerId))
      }
      // ── fallback chains ────────────────────────────────────────────────────
      if (method === 'GET' && routePath === '/combos') {
        return send(200, deps.combos.list())
      }
      if (method === 'POST' && routePath === '/combos') {
        const body = await readJson(req)
        return send(200, { ok: true, ...await deps.combos.save(body) })
      }
      // ── token savers ───────────────────────────────────────────────────────
      if (method === 'GET' && routePath === '/token-saver') {
        return send(200, deps.tokenSaver.get())
      }
      if (method === 'POST' && routePath === '/token-saver') {
        const body = await readJson(req)
        return send(200, { ok: true, tokenSaver: await deps.tokenSaver.set(body) })
      }
      // ── the five local answers ─────────────────────────────────────────────
      if (method === 'GET' && routePath === '/local-optimize') {
        return send(200, deps.localOptimize.get())
      }
      if (method === 'POST' && routePath === '/local-optimize') {
        const body = await readJson(req)
        return send(200, { ok: true, localOptimize: await deps.localOptimize.set(body) })
      }
      // ── connection recipes ─────────────────────────────────────────────────
      if (method === 'GET' && routePath === '/clients') {
        return send(200, deps.clients())
      }
      if (method === 'GET' && routePath === '/meta') {
        return send(200, { ...deps.meta(), feed: { fetchedAt: deps.announcements.view().fetchedAt, source: deps.announcements.view().source, error: deps.announcements.view().error }, update: deps.update.status() })
      }
      if (method === 'POST' && routePath === '/eac/login/start') {
        const started = await deps.eacAuth.start()
        return send(started.error === undefined ? 200 : 404, started.error === undefined ? started : { error: started.error })
      }
      if (method === 'GET' && routePath === '/eac/login/poll') {
        const polled = await deps.eacAuth.poll(url.searchParams.get('link') ?? '')
        const status = polled.error === undefined ? 200 : polled.error === 'bad-link' ? 400 : polled.error === 'no-lane' ? 404 : 502
        return send(status, polled)
      }
      if (method === 'POST' && routePath === '/eac/login/cancel') {
        const cancelled = deps.eacAuth.cancel(url.searchParams.get('link') ?? '')
        return send(cancelled.error === undefined ? 200 : 400, cancelled)
      }
      if (method === 'GET' && routePath === '/eac/status') {
        return send(200, await deps.eacAuth.status())
      }
      if (method === 'POST' && routePath === '/eac/logout') {
        return send(200, await deps.eacAuth.logout())
      }
      if (method === 'GET' && routePath === '/pool') {
        try { return send(200, await deps.pool()) } catch (error) {
          const reason = POOL_REASONS.has(error?.reason) ? error.reason : 'unreachable'
          deps.logger?.warn?.(`our-free-model: pool snapshot unavailable (${reason})`)
          return send(404, { error: `pool unavailable (${reason})` })
        }
      }
      if (method === 'GET' && routePath === '/channels/extra') {
        // 渠道权益扩展（余额明细 / 活动 / 倍率）。逐账号问上游，故由页面按需
        // 触发；单账号失败在响应里逐行说明，不是整个 500。
        const provider = String(url.searchParams.get('provider') ?? '').trim()
        if (provider === '') return send(400, { error: 'provider is required' })
        return send(200, await deps.channelExtras().status(provider))
      }
      if (method === 'POST' && routePath === '/channels/extra/claim') {
        // 写操作：领取一个活动（省略 campaignId 时取该渠道的每日签到活动）。
        // 上游按天幂等，重复领取回「已领」；这里同样把三种结论分开回报，
        // 让页面不必猜「没变化」是什么意思。
        const body = await readJson(req)
        const provider = String(body?.provider ?? '').trim()
        const accountId = String(body?.accountId ?? '').trim()
        if (provider === '' || accountId === '') return send(400, { error: 'provider and accountId are required' })
        const outcome = await deps.channelExtras().claim(
          provider,
          accountId,
          body?.campaignId === undefined || body.campaignId === null ? undefined : String(body.campaignId),
        )
        deps.logger?.info?.(`our-free-model: extra claim ${provider}/${accountId} → ${outcome.kind}`)
        // 领取会改变余额；目录本身不变，但账号可用性可能从「无」变成「有」，
        // 故重编一次（幂等，且只对自有渠道产生行）。
        if (outcome.kind !== 'failed') void deps.syncOwnCatalog?.()
        return send(outcome.kind === 'failed' ? 502 : 200, outcome)
      }
      // ── 本插件自己的渠道账号（渠道包不认识的那些） ──────────────────────────
      //
      // 三条只读 + 三条写：登录是**两步式**的（先拿设备码回 URL，再轮询），
      // 与渠道包 `account.create` / `login.poll` 同一形状，因为「等用户在浏览器里
      // 授权几十秒」不能在同一个请求里挂住。
      /**
       * 链路诊断：直接问宿主 `llm.listModels(provider)`「过滤后」的真实答案。
       *
       * 这一环此前从没验证过——我们验证了 pack 的兜底表（`listAllModels`），却没验证
       * 宿主经过 providerCatalogVisible / disabledModels / deadModels 过滤后**交给
       * 选择器**的到底是什么。面板据此显示每个渠道的实际条数，用户一眼就能看到
       * 「宿主有没有新模型」，不用再靠猜（2026-11-24 三轮排查的教训）。
       */
      if (method === 'GET' && routePath === '/diag/models') {
        const providers = ['qoder', 'qodercn', 'zcode', 'raccoon', 'loomy', 'codearts', 'buddy', 'minimax', 'trae', 'cline', 'gemini']
        const rows = []
        for (const provider of providers) {
          let count = 0
          let ids = []
          let error = null
          try {
            const models = hostLlm === null ? [] : await hostLlm.listModels(provider)
            count = Array.isArray(models) ? models.length : 0
            ids = Array.isArray(models) ? models.slice(0, 4).map(model => model.id ?? model.name ?? '?') : []
          } catch (failure) {
            error = String(failure?.message ?? failure)
          }
          rows.push({ provider, count, ids, error })
        }
        const ownRows = modelRuntime.catalog.filter(entry => entry.channel === 'own')
        const summary = rows.map(row => row.provider + ':' + row.count).join(' ')
        diagLog({ kind: 'diag-models', counts: summary, own: ownRows.length })
        return send(200, {
          hostLlm: hostLlm !== null,
          packProviders: rows,
          ownRows: ownRows.length,
          ownSample: ownRows.slice(0, 4).map(entry => entry.id),
        })
      }
      // 自有渠道的模型清单：面板「模型」折叠用它（渠道包的 model.list 不认识这些 id）。
      // 读的就是喂给选择器的那份 catalog，两处永远一致。
      if (method === 'GET' && routePath === '/channels/own/models') {
        const provider = String(url.searchParams.get('provider') ?? '').trim()
        if (provider === '') return send(400, { error: 'provider is required' })
        const rows = modelRuntime.catalog
          .filter(entry => entry.channel === 'own' && entry.provider === provider)
        diagLog({ kind: 'models-route', provider, total: rows.length })
        const models = rows.map(entry => ({
            id: entry.id,
            name: entry.name,
            disabled: false,
            dead: false,
            ...entry.needsLogin === true ? { needsLogin: true } : {},
          }))
        return send(200, { provider, models })
      }
      if (method === 'GET' && routePath === '/channels/own') {
        const provider = String(url.searchParams.get('provider') ?? '').trim()
        if (provider === '') return send(400, { error: 'provider is required' })
        return send(200, { provider, accounts: deps.channelAccounts().list(provider), supported: deps.deviceLogin().supports(provider) })
      }
      if (method === 'POST' && routePath === '/channels/own/login/start') {
        const body = await readJson(req)
        const provider = String(body?.provider ?? '').trim()
        if (provider === '') return send(400, { error: 'provider is required' })
        const started = await deps.deviceLogin().start(provider)
        return send(started.error === undefined ? 200 : 400, started)
      }
      if (method === 'GET' && routePath === '/channels/own/login/poll') {
        const accountId = String(url.searchParams.get('account') ?? '').trim()
        if (accountId === '') return send(400, { error: 'account is required' })
        const polled = await deps.deviceLogin().poll(accountId)
        // 登录完成即重编自有渠道的模型行（账号从「无」变「有」）。
        if (polled.done === true && polled.success === true) void deps.syncOwnCatalog()
        // 轮询本身成功（还没授权）不是错误：`done:false` 就是「继续等」。
        return send(200, polled)
      }
      // Accio：浏览器 PKCE。与设备码同一形状（先回地址、再轮询等回调），
      // 但等的是**我们自己**起的 loopback，不是上游的轮询端点。
      if (method === 'POST' && routePath === '/channels/own/oauth/start') {
        const body = await readJson(req)
        const provider = String(body?.provider ?? '').trim()
        if (provider !== 'accio') return send(400, { error: `该渠道没有浏览器授权登录：${provider}` })
        const account = ownAccounts.create(provider)
        const flow = await startBrowserLogin({ region: typeof body?.region === 'string' ? body.region : 'cn' })
        accioLogins.set(account.id, flow)
        return send(200, { accountId: account.id, loginUrl: flow.loginUrl })
      }
      if (method === 'GET' && routePath === '/channels/own/oauth/poll') {
        const accountId = String(url.searchParams.get('account') ?? '').trim()
        const flow = accioLogins.get(accountId)
        if (flow === undefined) return send(200, { done: true, success: false, error: '登录流程不存在或已结束，请重新发起' })
        try {
          const { code, verifier, redirectUri } = await flow.waitForCode()
          const exchanged = await exchangeCode({ code, codeVerifier: verifier, redirectUri })
          accioLogins.delete(accountId)
          if (exchanged.error !== undefined) return send(200, { done: true, success: false, error: exchanged.error })
          await ownAccounts.attach(accountId, exchanged.credential)
          void syncOwnCatalog()
          return send(200, { done: true, success: true, nickname: exchanged.credential.access_token.slice(0, 6) })
        } catch (error) {
          accioLogins.delete(accountId)
          return send(200, { done: true, success: false, error: String(error?.message ?? error) })
        }
      }
      // 浏览器登录（Marvis）：起隔离浏览器，在回调请求**发出之前**截停。
      // 与设备码同形的两步式：先回地址，再轮询等回调。
      if (method === 'POST' && routePath === '/channels/own/browser/start') {
        const body = await readJson(req)
        const provider = String(body?.provider ?? '').trim()
        if (provider === '') return send(400, { error: 'provider is required' })
        const started = await deps.browserLogin.start(provider, { loginType: body?.loginType })
        return send(started.error === undefined ? 200 : 400, started)
      }
      if (method === 'GET' && routePath === '/channels/own/browser/poll') {
        const accountId = String(url.searchParams.get('account') ?? '').trim()
        if (accountId === '') return send(400, { error: 'account is required' })
        return send(200, await deps.browserLogin.poll(accountId))
      }
      // AutoClaw 这类「短信验证码」渠道：与设备码是两套流程，故两条独立路由。
      // 验证码本身不落盘 —— 它是**一次性**凭据，只在内存里走一趟。
      if (method === 'POST' && routePath === '/channels/own/sms/send') {
        const body = await readJson(req)
        const provider = String(body?.provider ?? '').trim()
        const phone = String(body?.phone ?? '').trim()
        if (!smsLogin().supports(provider)) return send(400, { error: `该渠道没有短信登录：${provider}` })
        return send(200, await smsLogin().send(provider, phone))
      }
      if (method === 'POST' && routePath === '/channels/own/sms/login') {
        const body = await readJson(req)
        const provider = String(body?.provider ?? '').trim()
        if (!smsLogin().supports(provider)) return send(400, { error: `该渠道没有短信登录：${provider}` })
        const result = await smsLogin().login(provider, String(body?.phone ?? '').trim(), String(body?.code ?? '').trim())
        if (result.error === undefined) void deps.syncOwnCatalog()
        return send(result.error === undefined ? 200 : 400, result)
      }
      if (method === 'POST' && routePath === '/channels/own/login/cancel') {
        const body = await readJson(req)
        const accountId = String(body?.accountId ?? '').trim()
        deps.deviceLogin().cancel(accountId)
        deps.browserLogin.cancel(accountId)
        return send(200, { ok: true })
      }
      if (method === 'POST' && routePath === '/channels/own/update') {
        const body = await readJson(req)
        const account = deps.channelAccounts().update(String(body?.accountId ?? '').trim(), {
          ...typeof body?.nickname === 'string' ? { nickname: body.nickname } : {},
          ...typeof body?.enabled === 'boolean' ? { enabled: body.enabled } : {},
        })
        return account === undefined ? send(404, { error: 'account not found' }) : send(200, { ok: true, account })
      }
      if (method === 'POST' && routePath === '/channels/own/remove') {
        const body = await readJson(req)
        const removed = await deps.channelAccounts().remove(String(body?.accountId ?? '').trim())
        return removed ? send(200, { ok: true }) : send(404, { error: 'account not found' })
      }
      if (method === 'GET' && routePath === '/announcement') {
        // A managed install also stands down the owner's onboarding copy: the
        // pack, not the plugin, speaks for what is new.
        const acknowledged = deps.managedDistribution === true || deps.settings.get().announcementAck === ANNOUNCEMENT_VERSION
        return send(200, { version: ANNOUNCEMENT_VERSION, acknowledged })
      }
      if (method === 'POST' && routePath === '/announcement/ack') {
        // Bounded like every other write to this file: the query string is
        // caller-controlled, and the comparison downstream only ever matches a
        // version id — nothing needs the whole string.
        deps.settings.update({ announcementAck: String(url.searchParams.get('version') ?? ANNOUNCEMENT_VERSION).slice(0, 64) })
        deps.settings.flush()
        return send(200, { ok: true })
      }
      if (method === 'GET' && routePath === '/announcements') {
        const view = deps.announcements.view()
        return send(200, { ...view, acked: [...ackedSet(deps)], notifyOs: deps.settings.get().notifyOs === true })
      }
      if (method === 'POST' && routePath === '/announcements/ack') {
        const body = await readJson(req)
        const acked = ackedSet(deps)
        if (body.all === true) {
          // "mark all read": every announcement currently in the feed.
          for (const item of deps.announcements.view().items) acked.add(item.id)
        }
        if (typeof body.id === 'string' && body.id !== '') acked.add(body.id)
        deps.announcements.ack(acked)
        return send(200, { ok: true, view: deps.announcements.view() })
      }
      if (method === 'POST' && routePath === '/announcements/refresh') {
        // Managed installs poll no feed; a manual refresh is a polite no-op
        // rather than a network round the pack never asked for.
        if (deps.managedDistribution !== true) await deps.announcements.refresh()
        return send(200, { ok: true, view: deps.announcements.view() })
      }
      if (method === 'GET' && routePath === '/update/status') {
        return send(200, deps.update.status())
      }
      if (method === 'POST' && routePath === '/update/check') {
        const result = await deps.update.check()
        return send(200, { ...result, status: deps.update.status() })
      }
      if (method === 'POST' && routePath === '/update/apply') {
        const body = await readJson(req)
        const result = await deps.update.apply(body?.version === undefined ? undefined : String(body.version))
        return send(200, { ok: true, ...result })
      }
      if (method === 'POST' && routePath === '/reload') {
        // A managed install does not swap its own bytes; the pack owns them.
        if (deps.managedDistribution === true) return send(409, { error: 'this installation is managed; updates are handled by the pack that installed it' })
        const status = deps.update.status()
        if (status.applying || status.recoveryRequired) return send(409, {
          error: status.applying ? 'an upgrade is already running' : 'restore the retained upgrade backup before reloading',
        })
        // Answer first, then swap: the response rides an already-accepted
        // socket, but the client should not wait on the reload finishing. The
        // swap closure is `deps.hotReload`, applied inside `apply` — this
        // module-level handler has no access to the fiber's own context.
        send(202, { ok: true, note: 'hot reload started' })
        setTimeout(() => {
          Promise.resolve()
            .then(() => deps.hotReload())
            .catch(error => deps.logger?.warn?.(`our-free-model: hot reload failed (${error?.message ?? error})`))
        }, 50).unref?.()
        return
      }
      if (method === 'POST' && routePath === '/settings') {
        const patch = await readJson(req)
        const current = deps.settings.get()
        const next = sanitizeSettings({ ...current, ...pick(patch, ['enabled', 'exposeRegionModels', 'hideChannelModels', 'probeIntervalMinutes', 'defaultMaxTokens', 'announcementAck', 'feedUrl', 'feedPollMinutes', 'notifyOs', 'updateCheckHours', 'autoReloadWatch']) }, current)
        if (patch.forward !== undefined) {
          const forward = { ...(current.forward ?? {}), ...pick(patch.forward, ['enabled', 'host', 'port']) }
          // The listener spends this machine's lane, and a routable bind address
          // would let the whole subnet spend it too. Refused here so the settings
          // page says why, and again in `syncForward` for a hand-edited file.
          if (forward.enabled === true && !isLoopbackHost(forward.host ?? '127.0.0.1')) {
            return send(400, { error: 'the forward listener binds a loopback address only' })
          }
          if (forward.port !== undefined) {
            const port = Number(forward.port)
            forward.port = Number.isFinite(port) && port >= 1 && port <= 65535 ? Math.trunc(port) : (current.forward?.port ?? 0)
          }
          // The LAN relay is a second door on the same feature, so it travels in
          // the same `forward` patch — but it does *not* inherit the loopback
          // rule, because reaching another machine is its entire purpose.
          if (patch.forward.lan !== undefined) {
            const lan = { ...(current.forward?.lan ?? {}), ...pick(patch.forward.lan, ['enabled', 'port']) }
            if (lan.port !== undefined) {
              const port = Number(lan.port)
              // Zero asks the OS to choose, which is the sane default here: the
              // local port is frequently taken on a machine that already runs
              // something else.
              lan.port = Number.isFinite(port) && port >= 0 && port <= 65535 ? Math.trunc(port) : (current.forward?.lan?.port ?? 0)
            }
            forward.lan = lan
          }
          next.forward = forward
        }
        if (patch.egress !== undefined) {
          const egressPatch = pick(patch.egress, ['enabled', 'mode', 'url', 'mihomoPath'])
          if (egressPatch.mode !== undefined && egressPatch.mode !== 'subscription' && egressPatch.mode !== 'client') {
            return send(400, { error: 'the egress mode is "subscription" or "client"' })
          }
          for (const key of ['url', 'mihomoPath']) {
            if (egressPatch[key] !== undefined) {
              const value = String(egressPatch[key]).trim()
              if (value.length > 2048) return send(400, { error: `the egress ${key} is too long` })
              egressPatch[key] = value
            }
          }
          const egress = { ...(current.egress ?? {}), ...egressPatch }
          if (egress.enabled === true && String(egress.url ?? '') === '') {
            return send(400, { error: 'the outlet needs a subscription or proxy URL' })
          }
          next.egress = egress
        }
        deps.settings.update(next)
        deps.settings.flush()
        // Apply the catalog switch before answering: the pack reads it live, so
        // the next catalog build already reflects the new value. `onTopology`
        // is what tells the picker to re-fetch instead of keeping its cache.
        deps.channelVisibility().sync()
        if (next.hideChannelModels !== current.hideChannelModels) deps.onTopology()
        await deps.syncForward()
        await deps.syncRelay()
        await deps.syncEgress()
        return send(200, { ok: true, settings: publicSettings(deps.settings.get(), deps.forwardInfo(), deps.egressInfo()) })
      }
      if (method === 'POST' && routePath === '/refresh') {
        await deps.refreshCatalog({ probe: true, force: true })
        return send(200, { ok: true, ...buildSummary(deps) })
      }
      if (method === 'POST' && routePath === '/reprobe') {
        await deps.refreshAvailability(true)
        return send(200, { ok: true, ...buildSummary(deps) })
      }
      if (method === 'GET' && routePath === '/forward/key') {
        return send(200, { key: deps.settings.get().forwardKey ?? '' })
      }
      if (method === 'POST' && routePath === '/forward/rotate') {
        return send(200, { key: deps.rotateKey() })
      }
      // The channels' gateway relay (the pack's loopback OpenAI endpoint,
   // re-exposed under this plugin's own key). Status never carries a secret;
      // the key routes are read by the same fence as every other route here.
      if (method === 'GET' && routePath === '/chan-gateway') {
        return send(200, deps.chanRelay.status())
      }
      if (method === 'POST' && routePath === '/chan-gateway/apply') {
        const body = await readJson(req)
        return send(200, await deps.chanRelay.apply(body))
      }
      if (method === 'GET' && routePath === '/chan-gateway/key') {
        return send(200, { key: deps.chanRelay.key() })
      }
      if (method === 'POST' && routePath === '/chan-gateway/rotate') {
        return send(200, { key: deps.chanRelay.rotate() })
      }
      if (method === 'GET' && routePath === '/forward/lan/key') {
        return send(200, { key: deps.settings.get().forwardLanKey ?? '' })
      }
      if (method === 'POST' && routePath === '/forward/lan/rotate') {
        return send(200, { key: deps.rotateLanKey() })
      }
      // The relay binds every interface, so which address a peer should dial is a
      // property of this machine right now — not of the moment the relay started.
      // The panel polls this while the relay is on: a laptop that switched
      // networks (or brought a VPN up) holds different addresses, and the one it
      // was showing is the one the user copies to the other machine.
      if (method === 'GET' && routePath === '/forward/lan/addresses') {
        return send(200, { addresses: deps.lanAddresses() })
      }
      // The subscription/proxy URL is a credential, so it lives outside every
      // routine payload and leaves the process only when the settings page asks
      // for it — the same shape as the forward keys above.
      if (method === 'GET' && routePath === '/egress/url') {
        return send(200, { url: deps.settings.get().egress?.url ?? '' })
      }
      if (method === 'POST' && routePath === '/bench') {
        const body = await readJson(req)
        const result = await deps.testModel(String(body.model ?? ''), body.effort === undefined ? undefined : String(body.effort))
        return send(200, result)
      }
      return send(404, { error: 'not found' })
    } catch (error) {
      const status = Number(error?.statusCode)
      return send(Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500, { error: String(error?.message ?? error) })
    }
  }
}

function ackedSet(deps) {
  const value = deps.settings.get().announcementsAcked
  return new Set(Array.isArray(value) ? value : [])
}

function pick(source, keys) {
  const out = {}
  for (const key of keys) if (source?.[key] !== undefined) out[key] = source[key]
  return out
}

/** The most a browser-API request body may weigh. The settings patch and the
 *  announcement acks are the largest real payloads here by orders of magnitude;
 *  without a cap, any caller past the fence could buffer unbounded bytes into
 *  the host process — a different standard than the forward listener's 8 MB. */
const MAX_API_BODY_BYTES = 1024 * 1024

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_API_BODY_BYTES) throw httpError(413, 'request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(text) } catch (error) {
    // A body that was sent but is not JSON is a client bug, not "no body":
    // answering {} made POST /settings a silent 200 no-op. Empty bodies stay
    // legal ({} above) because no-body POSTs are real routes here.
    throw httpError(400, `invalid JSON body (${error?.message ?? error})`)
  }
}


/**
 * The token-saver section as the browser may see it.
 *
 * Normalized rather than echoed: a stored level id that is not in the family's
 * list would otherwise reach a `<select>` with no matching option and render as
 * "off" while the pipeline was still using something else.
 */
function publicTokenSaver(section) {
  const config = saverConfig({ tokenSaver: section })
  return {
    enabled: config.enabled,
    rtk: config.rtk,
    prompts: { caveman: config.caveman, ponytail: config.ponytail },
    cavemanLevels: CAVEMAN_LEVELS,
    ponytailLevels: PONYTAIL_LEVELS,
  }
}

/**
 * The aggregate section with every key replaced by a fingerprint.
 *
 * A provider key is a bearer credential for somebody else's account — the one
 * thing in this document that must never be echoed. It stays in the 0600
 * settings file; `hasKey` plus the last four characters are all the panel needs
 * to tell "configured" from "not configured" and to let a user recognise which
 * key is stored. The value itself is served only to the page that set it, and
 * only as a mask.
 */
function publicAggregate(section) {
  const providers = section?.providers ?? {}
  const out = {}
  for (const [id, value] of Object.entries(providers)) {
    if (value === null || typeof value !== 'object') continue
    const key = typeof value.apiKey === 'string' ? value.apiKey : ''
    out[id] = {
      enabled: value.enabled !== false,
      hasKey: key !== '',
      keyHint: key === '' ? '' : `…${key.slice(-4)}`,
      baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
      models: Array.isArray(value.models) ? value.models : [],
      discovered: Array.isArray(value.discovered) ? value.discovered : [],
      addedAt: Number.isFinite(value.addedAt) ? value.addedAt : 0,
      lastTest: value.lastTest ?? null,
    }
  }
  return { enabled: section?.enabled !== false, providers: out }
}

/** The provider registry, compact enough for one settings page to hold. */
function publicProviderRegistry() {
  return listProviders().map(provider => ({
    id: provider.id,
    name: provider.name,
    category: provider.category,
    authKind: provider.auth?.kind ?? 'apiKey',
    credentialUrl: provider.auth?.url ?? '',
    baseUrl: provider.baseUrl ?? '',
    baseUrlOverrideEnv: provider.baseUrlOverrideEnv ?? '',
    format: provider.format,
    website: provider.website ?? '',
    notes: provider.notes ?? '',
    local: provider.local === true,
    modelCount: Array.isArray(provider.models) ? provider.models.length : 0,
    models: (Array.isArray(provider.models) ? provider.models : []).map(model => ({
      id: model.id,
      name: model.name ?? model.id,
      contextWindow: model.contextWindow ?? null,
      vision: model.vision === true,
      reasoning: model.reasoning === true,
    })),
  }))
}

/** The five local answers, in evaluation order. */
const OPTIMIZATION_KINDS = OPTIMIZATIONS

/**
 * The local-optimization switches as the browser may see them.
 *
 * Each kind is reported individually even when the section is off, because the
 * page shows five separate switches: a master switch that silently blanked them
 * would look like the per-kind values had been lost.
 */
function publicLocalOptimize(section) {
  const config = section ?? {}
  const out = { enabled: config.enabled !== false }
  for (const kind of OPTIMIZATION_KINDS) out[kind] = config[kind] !== false
  return out
}

/** The switches in the shape `tryOptimizations` wants. */
function optimizeConfig(section) {
  const publicView = publicLocalOptimize(section)
  return publicView.enabled === true ? publicView : null
}

/**
 * Connection recipes for the local gateway.
 *
 * Generated rather than stored: the port can move when the requested one is
 * taken, so a snippet baked into the page at mount time is a snippet that lies
 * after a restart. Everything here is derived from what the listeners actually
 * bound and the keys they actually demand.
 */
function clientSnippets({ forward, key, lanKey, models }) {
  const running = forward.running === true
  const base = running ? `http://127.0.0.1:${forward.port}` : 'http://127.0.0.1:<forward-port>'
  const lanAddress = forward.lan.running === true && forward.lan.addresses.length > 0
    ? `http://${forward.lan.addresses[0]}:${forward.lan.port}`
    : ''
  const shownKey = key === '' ? '<forward-key>' : key
  const shownLanKey = lanKey === '' ? '<lan-key>' : lanKey
  const sample = models[0] ?? 'deepseek-v4-flash-free'
  const snippets = [
    {
      id: 'claude-code',
      name: 'Claude Code',
      language: 'bash',
      body: [
        `export ANTHROPIC_BASE_URL=${base}`,
        `export ANTHROPIC_AUTH_TOKEN=${shownKey}`,
        `export ANTHROPIC_MODEL=${sample}`,
        '# the gateway speaks /v1/messages natively — no translation shim needed',
      ].join('\n'),
    },
    {
      id: 'codex',
      name: 'Codex CLI',
      language: 'toml',
      body: [
        '# ~/.codex/config.toml',
        'model_provider = "ofm"',
        `model = "${sample}"`,
        '',
        '[model_providers.ofm]',
        'name = "Our Free Model"',
        `base_url = "${base}/v1"`,
        'wire_api = "responses"',
        `env_key = "OFM_API_KEY"`,
      ].join('\n'),
    },
    {
      id: 'openai-sdk',
      name: 'OpenAI SDK / any OpenAI-compatible tool',
      language: 'python',
      body: [
        'from openai import OpenAI',
        `client = OpenAI(base_url="${base}/v1", api_key="${shownKey}")`,
        `client.chat.completions.create(model="${sample}", messages=[{"role": "user", "content": "hi"}])`,
      ].join('\n'),
    },
    {
      id: 'anthropic-sdk',
      name: 'Anthropic SDK',
      language: 'python',
      body: [
        'from anthropic import Anthropic',
        `client = Anthropic(base_url="${base}", api_key="${shownKey}")`,
        `client.messages.create(model="${sample}", max_tokens=1024, messages=[{"role": "user", "content": "hi"}])`,
      ].join('\n'),
    },
    {
      id: 'curl',
      name: 'curl',
      language: 'bash',
      body: [
        `curl ${base}/v1/chat/completions \\`,
        `  -H "authorization: Bearer ${shownKey}" \\`,
        '  -H "content-type: application/json" \\',
        `  -d '{"model":"${sample}","messages":[{"role":"user","content":"hi"}]}'`,
        '',
        '# the Anthropic surface answers on the same port:',
        `curl ${base}/v1/messages \\`,
        `  -H "x-api-key: ${shownKey}" \\`,
        '  -H "anthropic-version: 2023-06-01" \\',
        '  -H "content-type: application/json" \\',
        `  -d '{"model":"${sample}","max_tokens":1024,"messages":[{"role":"user","content":"hi"}]}'`,
      ].join('\n'),
    },
  ]
  if (lanAddress !== '') {
    snippets.push({
      id: 'lan',
      name: 'Another device on your network',
      language: 'bash',
      body: [
        `# the LAN relay is up on this machine; its key is not the local one`,
        `export OPENAI_BASE_URL=${lanAddress}/v1`,
        `export OPENAI_API_KEY=${shownLanKey}`,
      ].join('\n'),
    })
  }
  return {
    running,
    baseUrl: base,
    lanUrl: lanAddress,
    key: shownKey,
    models,
    snippets,
  }
}

function publicSettings(settings, forwardInfo, egressInfo) {
  return {
    enabled: settings.enabled !== false,
    exposeRegionModels: settings.exposeRegionModels !== false,
    hideChannelModels: settings.hideChannelModels === true,
    probeIntervalMinutes: settings.probeIntervalMinutes ?? 15,
    defaultMaxTokens: settings.defaultMaxTokens ?? 32768,
    announcementAck: settings.announcementAck ?? '',
    feedUrl: typeof settings.feedUrl === 'string' ? settings.feedUrl : '',
    feedPollMinutes: settings.feedPollMinutes ?? 30,
    notifyOs: settings.notifyOs === true,
    updateCheckHours: settings.updateCheckHours ?? 6,
    autoReloadWatch: settings.autoReloadWatch === true,
    reloadedAt: settings.reloadedAt ?? 0,
    reloadCount: settings.reloadCount ?? 0,
    tokenSaver: publicTokenSaver(settings.tokenSaver),
    aggregate: publicAggregate(settings.aggregate),
    combos: normalizeCombos(settings.combos).map(combo => ({
      id: combo.id,
      name: combo.name,
      models: combo.models,
      strategy: combo.strategy,
      stickyLimit: combo.stickyLimit,
      enabled: combo.enabled,
    })),
    forward: {
      ...(settings.forward ?? {}),
      running: forwardInfo.running,
      actualPort: forwardInfo.port,
      error: forwardInfo.error,
      notice: forwardInfo.notice ?? '',
      lan: {
        ...(settings.forward?.lan ?? {}),
        running: forwardInfo.lan?.running === true,
        actualPort: forwardInfo.lan?.port ?? 0,
        host: forwardInfo.lan?.host ?? '',
        error: forwardInfo.lan?.error ?? '',
        addresses: forwardInfo.lan?.addresses ?? [],
      },
    },
    // A subscription link is not an endpoint, it is a bearer credential: the
    // path of the URL *is* the token, which is why it is handled like the
    // forward keys and not like `feedUrl`. Stored as given, but never echoed —
    // `urlLabel` is the masked host for the panel, `hasUrl` says whether one is
    // set at all, and the value itself is served only by `GET /egress/url`, on
    // the settings page's own ask (see src/egress.js `outletLabel`).
    egress: {
      ...pick(settings.egress ?? {}, ['enabled', 'mode', 'mihomoPath']),
      hasUrl: String(settings.egress?.url ?? '') !== '',
      urlLabel: outletLabel(settings.egress?.url ?? ''),
      outlet: egressInfo?.outlet ?? '',
      running: egressInfo?.running === true,
      active: egressInfo?.active === true,
      // The node url-test is carrying traffic on, its last measured delay, and
      // how long reaching the gateway took. All three are readings, not state.
      node: egressInfo?.node ?? '',
      nodeDelayMs: egressInfo?.nodeDelayMs ?? 0,
      latencyMs: egressInfo?.latencyMs ?? 0,
      latencyAt: egressInfo?.latencyAt ?? 0,
      error: egressInfo?.error ?? '',
    },
  }
}

function buildSummary(deps) {
  const state = deps.state()
  const snapshot = deps.availability.get()
  const forwardInfo = deps.forwardInfo()
  const update = deps.update.status()
  const feedView = deps.announcements.view()
  const defaultMaxTokens = deps.settings.get().defaultMaxTokens
  // Lanes that carry no availability verdict of their own. The absorbed channels
  // and the aggregate lane are named by a listing round that already succeeded,
  // and a combo is a view over rows that were themselves named — none of them is
  // pinged, so "no verdict" must not render as "unknown".
  const unprobed = entry => isEacEntry(entry) || isKiloEntry(entry) || isAggregateEntry(entry) || isComboEntry(entry)
  return {
    catalog: state.catalog.map(entry => ({
      ...entry,
      availability: unprobed(entry) ? STATE.available : (snapshot.results?.[entry.id]?.state ?? STATE.unknown),
      detail: unprobed(entry) ? '' : (snapshot.results?.[entry.id]?.detail ?? ''),
      probedAt: unprobed(entry) ? 0 : (snapshot.results?.[entry.id]?.at ?? 0),
      ttftMs: unprobed(entry) ? undefined : snapshot.results?.[entry.id]?.ttftMs,
      latencyMs: unprobed(entry) ? undefined : snapshot.results?.[entry.id]?.latencyMs,
      // What each rung of the effort menu will really put on the wire for this
      // model, so the page never shows a 32K "output ceiling" beside a call that
      // was cut off at 8K. A model with no effort menu has no ladder to show.
      ...(entry.reasoning === true ? { budgets: budgetLadder(entry, undefined, defaultMaxTokens) } : {}),
      // `null` here is what the picker does not advertise; the roster still lists
      // those models, because "the probe refused it" is the user's only evidence.
      route: (state.membership[ROUTE_MAIN] ?? []).includes(entry.id) ? ROUTE_MAIN
        : (state.membership[ROUTE_REGION] ?? []).includes(entry.id) ? ROUTE_REGION : null,
    })),
    settings: publicSettings(deps.settings.get(), forwardInfo, deps.egressInfo()),
    egress: forwardInfo.egress ?? snapshot.egress ?? null,
    outlet: deps.egressInfo(),
    probedAt: snapshot.at ?? 0,
    announcementVersion: ANNOUNCEMENT_VERSION,
    version: deps.meta().version,
    distribution: deps.meta().distribution,
    announcements: { unread: feedView.unread, fetchedAt: feedView.fetchedAt },
    // One bit for the settings page: false with an empty EAC group means the
    // gate never opened (a host the kernel gave no profile context), which is a
    // different sentence from "the relay is down" (issue #60).
    laneAvailable: deps.laneAvailable?.() === true,
    // The last GitHub-authorization verdict (the settings page refreshes it via
    // /eac/status on mount). `authorized: false` with the lane available is the
    // one state the model cards badge as locked.
    eacAuth: deps.eacAuth?.cached?.() ?? null,
    // Whether the absorbed free-channel pack is live on this host, and its
    // failure reason when it is not (see the mount in `apply`).
    channels: deps.channels?.() ?? { state: 'unknown', error: '' },
    update: { available: update.available, latest: update.latest, current: update.current, checkedAt: update.checkedAt, applying: update.applying, managed: update.managed === true },
  }
}