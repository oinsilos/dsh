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
import { ROUTE_LABELS, ROUTE_MAIN, ROUTE_REGION, ROUTE_GROUPS } from './src/adapter.js'
import { DATA_DIR_NAME, JsonStore, dayKey, decodeWindow, resolveDshHome } from './src/store.js'
import { isEacEntry, isKiloEntry } from './src/catalog.js'
import { STATE } from './src/probe.js'
import { generateKey, rankLanAddresses, startForwardServer, startLanRelay } from './src/forward.js'
import { pickGatewayPort } from './src/chan-relay.js'
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
import { applyCompactionSettings, compactionStatus, restoreRatio } from './src/compaction/ratio.js'
import { installRetry } from './src/retry/host.js'
import { createRouteStore } from './src/route/store.js'
import { createGate } from './src/route/gate.js'
import { describeGroupLine, isRouteEntry, remapGroups, GROUP_PREFIX } from './src/route/groups.js'
import { createChannelAccounts, OWN_PROVIDERS } from './src/channels/accounts.js'
import { refreshAutoclawToken } from './src/channels/autoclaw.js'
import { refreshCodelyToken } from './src/channels/codely.js'
import { createOwnAccountPicker } from './src/channels/select.js'
import { PACK_CHANNEL_IDS, buildChannelManifest, missingFromHost } from './src/channels/manifest.js'
import { buildOwnCatalog, ownDisabledModelsOf, ownModelStats, ownProviderClosed } from './src/channels/catalog.js'
import { createDeviceLogin } from './src/channels/device-login.js'
import { createSmsLogin } from './src/channels/sms-login.js'
import { exchangeCode, fetchAccioUserInfo, openBrowser, refreshAccioCredential, shouldRefreshAccio, startBrowserLogin } from './src/channels/accio.js'
import { MINIMAX_PRODUCTS, ensureMinimaxCredential, refreshMinimaxToken } from './src/channels/minimax.js'
import { ensureMarvisCredential, exchangeMarvisCode, isMarvisCallbackUrl, marvisAuthorizeUrl, refreshMarvisCredential } from './src/channels/marvis.js'
import {
  MAGICREW_HARVEST_EXPRESSION,
  MAGICREW_PRODUCTS,
  completeMagicrewLogin,
  magicrewProductOf,
  parseMagicrewHarvest,
  refreshGatewayKey,
  shouldRefreshKey,
} from './src/channels/magicrew.js'
import { issueMonkeycodeKey, monkeycodeProductOf, sessionCookieOf } from './src/channels/monkeycode.js'
import { BAIZHI, exchangeBaizhiKey } from './src/channels/baizhi.js'
import { authorizeUrl as officeaceAuthorizeUrl, exchangeOfficeaceCode, generateDpopKey, isOfficeaceCallbackUrl, pkcePair, refreshOfficeaceToken } from './src/channels/officeace-auth.js'
import { OFFICEACE } from './src/channels/officeace.js'
import { DOUBAO, DOUBAO_SIGN_EXPRESSION, doubaoCookieHeaderFromList, sessionIdFromCookie } from './src/channels/doubao.js'
import { AGNESCODE_PRODUCTS, readAgnescodeSession } from './src/channels/agnescode.js'
import { interceptCallback, startChromiumSession } from './src/channels/browser/chromium.js'
import { createPushHub } from './src/push.js'
import { rejectionFor, isLoopbackHost, connectionAdmissionView } from './src/trust.js'
import { resolveAttributionUserAgent } from './adapter/kernel.js'
import { buildAggregateCatalog, isAggregateEntry, probeProviderListing, testModel, testProvider } from './src/aggregate.js'
import { buildComboCatalog, isComboEntry, normalizeCombos, pruneRotation } from './src/combos.js'
import { buildPoolRow, normalizePool, isPoolEntry } from './src/forward-pool.js'
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

  /**
   * 路由分组的存储与并发闸门。
   *
   * 存储先建（内部只做结构归一化），目录建好后再 `attachCatalog`：迁移时的
   * `provider/model` → 目录 id 映射必须有完整目录，而目录由下面的 runtime 提供。
   */
  const routeStore = createRouteStore({ dataDir, home, logger })
  const routeConcurrency = modelId => {
    const route = settings.get().route ?? {}
    const table = route.concurrencyByModel ?? {}
    if (Object.prototype.hasOwnProperty.call(table, modelId)) {
      const own = Number(table[modelId])
      return Number.isFinite(own) && own > 0 ? Math.trunc(own) : 0
    }
    const fallback = Number(route.defaultConcurrency)
    return Number.isFinite(fallback) && fallback > 0 ? Math.trunc(fallback) : 0
  }
  const gate = createGate({
    limitOf: routeConcurrency,
    cooldownOf: () => Number(settings.get().route?.capacityCooldownMs) || 30_000,
  })

  /**
   * `dsh-llm-error-retry` 合并进来的宿主半。
   *
   * 不写进顶层 `inject`：重试只是增强，缺 agents/sessions/timer 的组合仍应
   * 提供模型。数据目录沿用旧包的位置，故卸载旧包后 rules.json 与
   * status.json 原样继续生效，用户调过的规则不需要重填。
   */
  ctx.inject(['timer', 'agents', 'sessions'], retryScope => {
    installRetry(retryScope, { dataDir: path.join(home, 'llm-error-retry') })
  })

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
   * 续期按渠道分派：登记**有 refresh 语义**的那几家。没有登记的原样返回，
   * 缺 access_token 时交给推理腿判 `CODE.credential`。
   */
  const magicrewRefresher = product => async (credential, { force = false } = {}) => {
    if (!force && !shouldRefreshKey(credential)) return { credential, refreshed: false }
    const refreshed = await refreshGatewayKey(product, { refreshToken: credential?.refreshToken })
    if (refreshed.error !== undefined) return { error: refreshed.error }
    return { credential: { ...credential, ...refreshed.key }, refreshed: true }
  }
  const autoclawRefresher = product => async (credential, { force = false } = {}) => {
    const expiresAt = Number(credential?.expires_at)
    const due = Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt - 5 * 60_000 <= Date.now()
    if (!force && !due) return { credential, refreshed: false }
    return refreshAutoclawToken(credential, { product })
  }
  const codelyRefresher = async (credential, { force = false } = {}) => {
    // `expires_at` 在 Codely 凭据里是 JWT 的 ISO 字符串（账号表里才是毫秒）。
    const raw = credential?.expires_at
    const expiresAt = typeof raw === 'number' ? raw : Date.parse(String(raw ?? ''))
    const due = Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt - 5 * 60_000 <= Date.now()
    if (!force && !due) return { credential, refreshed: false }
    return refreshCodelyToken(credential)
  }
  /** provider → AgnesCode 产品表（两个站点各自的会话文件）。 */
  const AGNES_PRODUCTS_BY_PROVIDER = {
    agnescode: AGNESCODE_PRODUCTS.agnescode,
    agnescodeintl: AGNESCODE_PRODUCTS.agnescodeintl,
  }
  /**
   * 从 AgnesCode 桌面客户端导入登录态。
   *
   * 登录发生在客户端里（微信/OAuth），插件只读它的加密会话；读不到就给**可执行**
   * 的原因（文件路径、客户端版本、域名白名单），不编造凭据。
   */
  async function importAgnesAccount(provider) {
    const product = AGNES_PRODUCTS_BY_PROVIDER[provider]
    if (product === undefined) return { error: `该渠道不支持从客户端导入：${provider}` }
    try {
      const result = await readAgnescodeSession({ product })
      return { credential: result.credential, sessionPath: result.sessionPath }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    }
  }
  const OWN_REFRESH = {
    codely: codelyRefresher,
    autoclaw: autoclawRefresher('cn'),
    autoclawintl: autoclawRefresher('intl'),
    minimaxintl: (credential, { force = false } = {}) => force
      ? refreshMinimaxToken(credential, { product: MINIMAX_PRODUCTS.minimaxintl }).then(result => result.error === undefined ? { ...result, refreshed: true } : result)
      : ensureMinimaxCredential(credential, { product: MINIMAX_PRODUCTS.minimaxintl }),
    marvis: (credential, { force = false } = {}) => force
      ? refreshMarvisCredential(credential)
      : ensureMarvisCredential(credential),
    // OfficeAce：refresh_token **一次性** ⇒ 只在「确实快过期」或用户点刷新时续。
    officeace: async (credential, { force = false } = {}) => {
      const expiresAt = Number(credential?.expires_at)
      const due = Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt - 5 * 60_000 <= Date.now()
      if (!force && !due) return { credential, refreshed: false }
      const refreshed = await refreshOfficeaceToken({ refreshToken: credential?.refresh_token, privateJwk: credential?.privateJwk })
      if (refreshed.error !== undefined) return { error: refreshed.error, terminal: refreshed.terminal === true }
      return { credential: { ...credential, ...refreshed.credential }, refreshed: true }
    },
    // 超级麦吉：网关密钥 2 小时，`apiKeyExpiresAt` 是现成闸门。
    magicrew: magicrewRefresher(MAGICREW_PRODUCTS.magicrew),
    magicrewintl: magicrewRefresher(MAGICREW_PRODUCTS.magicrewintl),
    // Accio：端点未实测，但 `expires_at` 是现成的闸门；只在快过期或手动刷新时调。
    accio: async (credential, { force = false } = {}) => {
      if (!force && !shouldRefreshAccio(credential)) return { credential, refreshed: false }
      return refreshAccioCredential(credential)
    },
    // AgnesCode：令牌由桌面客户端续，插件没有 refresh 端点 ⇒ 「续期」= 再读一次
    // 客户端会话（客户端开着就会拿到新 token）。
    agnescode: async (credential, { force = false } = {}) => {
      const imported = await importAgnesAccount('agnescode')
      if (imported.error !== undefined) return { error: imported.error }
      if (!force && imported.credential.access_token === credential?.access_token) {
        return { credential, refreshed: false }
      }
      return { credential: imported.credential, refreshed: true }
    },
    agnescodeintl: async (credential, { force = false } = {}) => {
      const imported = await importAgnesAccount('agnescodeintl')
      if (imported.error !== undefined) return { error: imported.error }
      if (!force && imported.credential.access_token === credential?.access_token) {
        return { credential, refreshed: false }
      }
      return { credential: imported.credential, refreshed: true }
    },
  }
  /**
   * 凭据里有没有续期材料。面板据此决定是否渲染「刷新凭据」——有续期实现但
   * 这份凭据没有 refresh_token 时，按钮点了只会报错。
   */
  function hasRefreshMaterial(provider, credential) {
    if (credential === null || typeof credential !== 'object') return false
    // AgnesCode 的「续期」是重新读客户端会话，材料就是那份会话本身。
    if (provider === 'agnescode' || provider === 'agnescodeintl') {
      return typeof credential.access_token === 'string' && credential.access_token !== ''
        && typeof credential.bff_base === 'string' && credential.bff_base !== ''
    }
    if (provider === 'magicrew' || provider === 'magicrewintl') {
      return typeof credential.refreshToken === 'string' && credential.refreshToken !== ''
    }
    return typeof credential.refresh_token === 'string' && credential.refresh_token !== ''
  }
  /**
   * 推理取号：**轮换** + 跳过无凭据的占位行 + 取号时就地续期。
   *
   * 以前永远取 `enabled(provider)[0]`：第二个账号永远用不上，第一个账号的令牌
   * 坏了整条渠道就不可用。取号器是本进程内的（游标不落盘），与渠道包账号池的
   * 「轮转」同一取向。
   */
  const ownPicker = createOwnAccountPicker({
    accounts: () => ownAccounts,
    refreshers: OWN_REFRESH,
    logger,
  })
  async function ownCredentialFor(provider) {
    const picked = await ownPicker.pick(provider)
    return picked?.credential ?? null
  }
  /**
   * 面板「刷新凭据」：对**指定账号**强制续期一次（不参与轮换）。
   * 续期成功把新凭据（含新的到期时间）写回账号表。
   */
  async function refreshOwnAccount(accountId) {
    const account = ownAccounts.find(accountId)
    if (account === undefined) return { error: '账号不存在' }
    const refresher = OWN_REFRESH[account.provider]
    if (typeof refresher !== 'function') return { error: '该渠道没有续期接口' }
    const credential = await ownAccounts.credentialOf(account)
    if (credential === null) return { error: '凭据不可用（需要重新登录）' }
    const refreshed = await refresher(credential, { force: true })
    if (refreshed.error !== undefined) return { error: refreshed.error, terminal: refreshed.terminal === true }
    // `expiresAt` 是续期器显式交回的毫秒值（Codely 的凭据字段是 ISO 字符串，
    // 不能直接 Number()）；其余渠道读凭据里的毫秒字段。
    const expiresAt = Number(refreshed.expiresAt ?? refreshed.credential?.expires_at ?? refreshed.credential?.apiKeyExpiresAt)
    await ownAccounts.attach(account.id, refreshed.credential, Number.isFinite(expiresAt) && expiresAt > 0 ? { expiresAt } : {})
    void syncOwnCatalog({ refresh: true })
    return { ok: true, refreshed: refreshed.refreshed === true, ...Number.isFinite(expiresAt) && expiresAt > 0 ? { expiresAt } : {} }
  }

  const modelRuntime = createModelRuntime({
    ...stores,
    logger,
    attributionUserAgent: 'deepseek-harness',
    resolveImage: imageResolver(ctx, logger),
    sealedCredential: sealedCredentialOf,
    ownCredential: ownCredentialFor,
    routeStore,
    gate,
    routeGroups: () => routeStore.groups,
    // 分组成员属于别的渠道时，这一轮交回宿主自己的路由（懒绑定：llm 服务在
    // 运行时创建之后才发布）。返回 null = 这个宿主没有转发能力。
    hostStream: options => (hostLlm !== null && typeof hostLlm.stream === 'function' ? hostLlm.stream(options) : null),
    // 分组每一轮的选人/跳过/落地都留一行读数：线上「为什么没走 A」只有这里有答案。
    trace: event => diagLog(event),
    onSealedUnavailable: () => logger.warn?.('our-free-model: the sealed lane is not available in this composition (no recognized host profile); its models stay hidden'),
    onTopology: () => emitTopology(),
  })
  const { state, adapter, refreshCatalog, refreshAvailability, watchEgress, fetchListing, publicModelRows, syncAggregateCatalog, syncRouteCatalog } = modelRuntime
  const runForwarded = modelRuntime.complete

  // 目录已成立，接上映射并接手旧插件的分组；失败不拖垮主路由。
  try {
    routeStore.attachCatalog(() => modelRuntime.catalog)
    const routeImport = routeStore.autoImport()
    if (routeImport.imported === true) {
      logger.info?.(`our-free-model: imported ${routeImport.groups} route group(s) / ${routeImport.members} member(s) from model-failover-manager`)
      syncRouteCatalog()
    }
  } catch (error) {
    logger.warn?.(`our-free-model: route group import failed (${error?.message ?? error})`)
  }

  /**
   * 旧插件的并发配置也要复用。
   *
   * `model-failover-manager` 的 `defaultConcurrency: 3` 是"每模型最多 3 个在飞
   * 请求"；我们的默认 0 是"不限"。自动导入只搬 groups/bindings/failed，不包含
   * settings，所以这里单独迁一次，并写 marker——之后用户在面板里改成 0 不会被
   * 下一次启动再覆盖回 3。
   */
  if (settings.get().routeConcurrencyMigratedAt === undefined) {
    let legacyRouteSettings = null
    try {
      legacyRouteSettings = JSON.parse(fs.readFileSync(path.join(home, 'model-failover-manager', 'settings.json'), 'utf8'))
    } catch { /* 没装过旧插件就是没有这个文件 */ }
    if (legacyRouteSettings !== null) {
      const legacyConcurrency = Number(legacyRouteSettings?.defaultConcurrency)
      settings.update({
        route: {
          ...(settings.get().route ?? {}),
          ...Number.isFinite(legacyConcurrency) && legacyConcurrency >= 0
            ? { defaultConcurrency: Math.min(64, Math.trunc(legacyConcurrency)) }
            : {},
        },
        routeConcurrencyMigratedAt: Date.now(),
      })
      settings.flush()
    }
  }

  /**
   * 上下文压缩：引擎是宿主的，我们只接管「比例」。
   *
   * 三条不能省的细节（都来自踩过的坑）：
   * 1. 引擎挂在每个 preset 的隔离组里，只能遍历 `ctx.registry` 的 fiber store；
   * 2. `config` 是 frozen 快照，必须换引用；
   * 3. `headroomTokens` 要一起改，否则滑块高位被公式静默夹死。
   *
   * 每一步都重放一次：preset 后挂载、热重载换 config、上下文窗口切换都会让
   * 上一次写入失效，只有 `agent/pre-step` 是稳定的锚点。
   */
  const legacyThresholdFile = path.join(home, 'compaction-threshold.json')
  let legacyThresholdRatio = null
  try {
    const parsed = JSON.parse(fs.readFileSync(legacyThresholdFile, 'utf8'))
    const ratio = Number(parsed?.thresholdRatio)
    if (Number.isFinite(ratio) && ratio > 0) legacyThresholdRatio = ratio
  } catch { /* 没装过阈值插件就是没有这个文件 */ }
  if (legacyThresholdRatio !== null && settings.get().compactionMigratedAt === undefined) {
    settings.update({
      compaction: { enabled: true, thresholdRatio: legacyThresholdRatio },
      compactionMigratedAt: Date.now(),
    })
    settings.flush()
  }
  const applyCompaction = () => applyCompactionSettings(ctx, settings.get().compaction)
  const compaction = {
    apply: applyCompaction,
    status: () => ({
      ...compactionStatus(ctx, settings.get().compaction),
      legacy: legacyThresholdRatio === null ? null : { thresholdRatio: legacyThresholdRatio, file: legacyThresholdFile },
    }),
    set(patch) {
      const current = settings.get()
      const merged = sanitizeSettings({
        ...current,
        compaction: { ...(current.compaction ?? {}), ...pick(patch ?? {}, ['enabled', 'thresholdRatio']) },
      }, current)
      settings.update({ compaction: merged.compaction })
      settings.flush()
      applyCompactionSettings(ctx, merged.compaction)
      return {
        ...compactionStatus(ctx, merged.compaction),
        legacy: legacyThresholdRatio === null ? null : { thresholdRatio: legacyThresholdRatio, file: legacyThresholdFile },
      }
    },
    restore() {
      // 只把引擎换回原值不够：设置里还留着 0.75，下一步 `agent/pre-step` 会
      // 立刻再写回去。恢复默认 = 清掉配置值（followDefault），再还原引擎。
      const current = settings.get()
      settings.update({
        compaction: { ...(current.compaction ?? {}), thresholdRatio: null },
      })
      settings.flush()
      const restored = restoreRatio(ctx)
      return {
        ...compactionStatus(ctx, settings.get().compaction),
        restored,
        legacy: legacyThresholdRatio === null ? null : { thresholdRatio: legacyThresholdRatio, file: legacyThresholdFile },
      }
    },
  }
  applyCompaction()
  ctx.on('agent/pre-step', (_payload, next) => {
    applyCompaction()
    return next()
  }, { global: true, prepend: true })

  /**
   * 链路诊断日志：写文件而不是 logger —— 桌面版没有可持续读取的宿主日志，
   * 「新渠道看不到模型」这类问题没有落点就只能猜（2026-11-24 排查实录）。
   * 每行一个 JSON 事件，追加写；文件在数据目录里，用户能直接发回来。
   *
   * ⚠️ 必须定义在下面的注册段**之前**：它是 `const`，在初始化前调用会抛
   * `ReferenceError`（TDZ）。上一版把它留在 apply 尾部，`own-route` 日志第一次
   * 落笔就把整个 apply 抛崩，插件被标成「异常」、连主路由一起回滚 ——
   * 表现就是「模型列表整组不显示」。
   */
  const diagLog = event => {
    try {
      const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'
      fs.appendFileSync(path.join(dataDir, 'own-catalog.log'), line)
    } catch { /* 诊断日志绝不影响主流程 */ }
  }
  // ── registration ────────────────────────────────────────────────────────────
  /**
   * 主路由（免费车道 + 地域）与自有渠道的路由**分开注册**。
   *
   * 自有渠道各自一条路由：选择器按路由分组，所以 `doubao` / `codely` /
   * `astudio` 等会是各自独立的分组（标题来自 `OWN_LABELS`）。
   *
   * ⚠️ 为什么不是一次 `registerAdapter([...14 个 id])`：
   * 1. 宿主的热重载会**先加载新 fiber、再异步 dispose 旧 fiber**。旧 fiber 的
   *    provider 还挂在注册表里时，一次全量注册会撞 `DUPLICATE_ADAPTER`（全有或
   *    全无）⇒ 新代码一个自有路由都没注册；旧 fiber 随后被清掉 ⇒ **模型整组消失**。
   *    这正是「重载后还是看不到模型」的形状。
   * 2. dsh-providers-hub 同机时也会占同名 provider。
   *
   * 故逐条注册、撞了就稍后重试：旧 fiber 一释放，下一次尝试就成功。
   */
  const registration = ctx.llm.registerAdapter([ROUTE_MAIN, ROUTE_REGION, ROUTE_GROUPS], adapter)
  const ownRouteHandles = new Set()
  let ownRouteAttempt = 0
  function registerOwnProviderRoutes() {
    if (disposed) return
    for (const provider of OWN_PROVIDERS) {
      if (ownRouteHandles.has(provider)) continue
      try {
        ctx.llm.registerAdapter([provider], adapter)
        ownRouteHandles.add(provider)
        diagLog({ kind: 'own-route', provider, ok: true })
      } catch (error) {
        // 旧 generation 还占着 / 别的插件占着：下一轮再试。日志留证据 ——
        // 这个分支曾经是静默的，结果「选择器里整组不见」只能靠猜。
        diagLog({ kind: 'own-route', provider, ok: false, error: String(error?.message ?? error) })
      }
    }
    if (ownRouteHandles.size < OWN_PROVIDERS.length && ownRouteAttempt < 12) {
      ownRouteAttempt += 1
      const timer = setTimeout(registerOwnProviderRoutes, Math.min(500 * ownRouteAttempt, 5000))
      timer.unref?.()
    } else if (ownRouteHandles.size === OWN_PROVIDERS.length && ownRouteAttempt < 100) {
      // 只在首次全集成功时记一条，避免每轮重复写日志。
      ownRouteAttempt = 100
      diagLog({ kind: 'own-routes-ready', count: ownRouteHandles.size })
    }
  }
  registerOwnProviderRoutes()
  /** 主路由只换主路由的两条 id；自有路由的生命周期在各自的 handle 里。 */
  const routes = () => Object.keys(state().membership)
    .filter(route => route === ROUTE_MAIN || route === ROUTE_REGION || route === ROUTE_GROUPS)
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
    // 占位账号清理：登录流程是**内存态**的（浏览器/扫码等回调），进程一重启就没了。
    // 那些「点了添加账号但没登完」的行永远等不到凭据，只会在面板上显示一片「待登录」，
    // 并在权益查询里变成「凭据不可用」的红字（用户报障「都没登账号还提示余额查询失败」）。
    void ownAccounts.prunePending().then(dropped => {
      if (Array.isArray(dropped) && dropped.length > 0) {
        logger.info?.(`our-free-model: dropped ${dropped.length} placeholder channel account(s) with no credential: ${dropped.join(', ')}`)
      }
    }).catch(error => logger.warn?.(`our-free-model: placeholder cleanup failed (${error?.message ?? error})`))
    // 诊断用：宿主 llm 服务（`listModels` 是「宿主过滤后」的真实答案）。
    hostLlm = scoped.llm
    deviceLogin = createDeviceLogin({ accounts: ownAccounts })
    smsLogin = createSmsLogin({ accounts: ownAccounts })
    // Dynamic import: the pack's own imports (the kernel's llm and credential
    // modules) are host-provided, and a composition that lacks them must still
    // load this plugin's free lane. `pack.js` is the bundled form of the
    // vendored tree (see scripts/build-channel-pack.mjs) — one file, so the
    // release manifest stays inside its file cap.
    // The pack's gateway takes its port from `process.env` when `apply` runs,
    // so settle that before mounting: on a machine whose reserved TCP range
    // covers 8326 the default silently cannot bind (EACCES), and the switch then
    // reads "on, not listening" forever. An explicit env value wins.
    void pickGatewayPort({ env: process.env })
      .catch(error => logger.warn?.(`our-free-model: gateway port probe failed (${error?.message ?? error})`))
      .then(() => import('./vendor/channel-pack/pack.js')).then(pack => {
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
      void syncOwnCatalog({ refresh: true })
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
          const packs = PACK_CHANNEL_IDS
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
          // state() 是选择器真正读的那份视图；`ownRows` 只是内部目录。两者对不上
          // 就说明「行进了 catalog 但没进 membership」——分组逻辑/字段在这中间丢了。
          const view = state()
          const ownWithProvider = ownRows.filter(entry => typeof entry.provider === 'string' && entry.provider !== '').length
          // 自有渠道分组是否真的进了选择器：宿主 `listProviders()` 里有没有这些
          // 路由、`listModels(provider)` 又给出几条。没有这两列就只能看到
          // 「注册成功」和「选择器空白」同时成立，无从判断断在哪一层。
          const ownCounts = []
          const ownRoutes = hostLlm === null || typeof hostLlm.listProviders !== 'function'
            ? []
            : hostLlm.listProviders().map(provider => provider.id ?? provider.name)
          for (const provider of OWN_PROVIDERS) {
            try {
              const models = hostLlm === null ? [] : await hostLlm.listModels(provider)
              const direct = await adapter.listModels(provider)
              // `宿主条数/适配器直读条数`：两者不相等就说明「注册的路由不是这个
              // 适配器实例」或宿主侧过滤；相等且为 0 才是目录没进 state。
              ownCounts.push(`${provider}:${Array.isArray(models) ? models.length : 0}/${direct.length}`)
            } catch (failure) {
              ownCounts.push(`${provider}:ERR(${String(failure?.message ?? failure).slice(0, 40)})`)
            }
          }
          diagLog({
            kind: 'auto-diag',
            hostLlm: hostLlm !== null,
            visibilityInstalled: channelVisibility?.installed === true,
            hideChannelModels: settings.get().hideChannelModels === true,
            counts: counts.join(' '),
            empty: problems.join(' ') || 'none',
            ownRows: ownRows.length,
            ownWithProvider,
            memKeys: Object.keys(view.membership).length,
            memOwnKeys: Object.keys(view.membership).filter(key => key !== ROUTE_MAIN && key !== ROUTE_REGION).join(','),
            memDoubao: (view.membership['doubao'] ?? []).length,
            viewCatalog: view.catalog.length,
            ownCatalog: (view.catalog.filter(entry => entry.channel === 'own') ?? []).length,
            ownCounts: ownCounts.join(' '),
            routes: ownRoutes.join(' '),
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
   * 自有渠道的目录缓存：`provider → {rows, at, error}`。
   *
   * ⚠️ 以前只在「进程里第一次看到这个 provider 有账号」时抓一次目录，且抓失败
   * 也把空数组记成「已抓过」——一次网络抖动就让这家渠道整个进程生命周期都用
   * 兜底表（用户看到的是「模型少了」，但重启又好了）。现在：
   * - 抓失败不覆盖已有行，并允许下一轮重试；
   * - 超过 10 分钟重新抓（远端目录会随账号/活动变化）；
   * - 登录成功、领取成功、账号增删这些**明确的变化点**传 `refresh: true` 立即抓。
   */
  const ownCatalogs = new Map()
  const OWN_CATALOG_TTL_MS = 10 * 60_000
  /** 最近一次编目录时的账号可见性（`/channels/own` 的计数与显示要用同一份）。 */
  let ownEnabled = {}
  const ownCatalogRows = () => Object.fromEntries([...ownCatalogs].map(([provider, entry]) => [provider, entry.rows]))
  /** 目录来源（面板「实时/预制」提示 + 倍率）：与 rows 同一次抓取落盘。 */
  const ownCatalogMeta = provider => {
    const entry = ownCatalogs.get(provider)
    return {
      source: entry?.source === 'live' ? 'live' : 'preset',
      at: entry?.at ?? 0,
      ...entry?.note === undefined ? {} : { note: entry.note },
      ...entry?.catalogError === undefined ? {} : { error: entry.catalogError },
      ...entry?.error === undefined ? {} : { error: entry.error },
    }
  }
  const ownCatalogRatios = provider => ownCatalogs.get(provider)?.ratios ?? {}
  const ownControlSettings = () => {
    const current = settings.get()
    const disabledModels = {}
    const closedProviders = {}
    for (const provider of OWN_PROVIDERS) {
      disabledModels[provider] = [...ownDisabledModelsOf(current, provider)]
      closedProviders[provider] = ownProviderClosed(current, provider)
    }
    return { disabledModels, closedProviders }
  }
  /** 面板卡片与「模型」折叠读的计数（含被关掉/被关闭的行）。 */
  const ownCountsOf = provider => ownModelStats({
    catalogs: ownCatalogRows(),
    enabled: ownEnabled,
    ...ownControlSettings(),
  }, provider)
  const syncOwnCatalog = async ({ refresh = false } = {}) => {
    diagLog({ kind: 'sync-begin', hasExtras: channelExtras !== undefined && channelExtras.available === true })
    const enabled = {}
    for (const provider of OWN_PROVIDERS) {
      const accounts = ownAccounts.enabled(provider)
      enabled[provider] = accounts.length > 0
      diagLog({ kind: 'provider', provider, accounts: accounts.length, signedIn: enabled[provider] })
      if (accounts.length === 0) continue
      const cached = ownCatalogs.get(provider)
      const stale = cached === undefined || cached.error !== undefined || Date.now() - cached.at > OWN_CATALOG_TTL_MS
      if (!refresh && !stale) continue
      try {
        const status = await channelExtras.status(provider)
        const rows = Array.isArray(status?.catalog) ? status.catalog : []
        // `source` 由各渠道的 statusOf 决定：远端成功 = live；回退内置表 =
        // static/preset。没写 source 但给了目录的渠道按 live（它们自己已回退）。
        const source = status?.source === 'static' ? 'preset' : (rows.length > 0 ? 'live' : 'preset')
        ownCatalogs.set(provider, {
          rows,
          at: Date.now(),
          source,
          ...status?.catalogNote === undefined && status?.note === undefined
            ? {}
            : { note: status?.catalogNote ?? status?.note },
          ...status?.catalogError === undefined ? {} : { catalogError: status.catalogError },
          // 倍率与目录同源：面板「模型」折叠直接显示，不再依赖另开「活动」折叠。
          ratios: status?.ratios !== null && typeof status?.ratios === 'object' ? status.ratios : {},
        })
        diagLog({ kind: 'catalog', provider, rows: rows.length, source })
      } catch (error) {
        // 抓取失败**不覆盖**已有行（宁可旧目录，也不要整组消失）。
        ownCatalogs.set(provider, {
          rows: Array.isArray(cached?.rows) ? cached.rows : [],
          at: cached?.at ?? 0,
          source: cached?.source ?? 'preset',
          ...cached?.note === undefined ? {} : { note: cached.note },
          ...cached?.ratios === undefined ? {} : { ratios: cached.ratios },
          error: String(error?.message ?? error),
        })
        diagLog({ kind: 'catalog-failed', provider, error: String(error?.message ?? error) })
        logger.warn?.(`our-free-model: ${provider} 目录不可用（${error?.message ?? error}）`)
      }
    }
    ownEnabled = enabled
    const rows = buildOwnCatalog({
      catalogs: ownCatalogRows(),
      enabled,
      hideAll: settings.get().hideChannelModels === true,
      // 选择器/网关只看到「有登录账号」的渠道（用户 2026-11-24 要求）。
      // 面板不读这份：卡片计数与「模型」折叠仍按 ownCatalogs 全量编，否则
      // 未登录渠道连「登录后有哪些模型」都看不到。
      signedInOnly: true,
      ...ownControlSettings(),
    })
    diagLog({ kind: 'sync-done', rows: rows.length, hideAll: settings.get().hideChannelModels === true })
    modelRuntime.setOwnCatalog(rows)
    diagLog({ kind: 'set', runtimeRows: modelRuntime.catalog.filter(entry => entry.channel === 'own').length })
  }

  /**
   * 浏览器登录（CDP）：用一个**宿主自己起的**隔离浏览器完成「网页登录」那条腿。
   *
   * 流程与设备码同形（`start` 立刻回账号与地址、`poll` 逐次看结果），差别只在
   * 「谁在等」：设备码等上游轮询，这里等**页面/回调**。拦截与浏览器生命周期都在
   * `src/channels/browser/chromium.js`，本处只管账号落库。
   */
  const browserLogins = new Map()
  /**
   * 走「起浏览器」那条腿的渠道。
   *
   * ⚠️ 这张集合与下面的 `BROWSER_LOGIN_ENTRIES` **必须逐条对齐**：集合里多一个 id
   * 却没有入口，用户点「添加账号」只会得到一句「入口尚未实现」；入口里多一个 id
   * 而集合里没有，则那条入口是死代码（两处各有一句自检，见 `tests/doubao-channel.mjs`）。
   */
  const BROWSER_LOGIN_PROVIDERS = new Set(['marvis', 'magicrew', 'magicrewintl', 'monkeycode', 'monkeycodeintl', 'baizhi', 'officeace', 'doubao'])
  const BROWSER_LOGIN_TIMEOUT_MS = 240_000

  /** 产品型渠道（超级麦吉 / MonkeyCode）：页面地址由产品表决定。 */
  function productLoginEntry(provider) {
    const product = magicrewProductOf(provider) ?? monkeycodeProductOf(provider)
    if (product === null || product === undefined) return undefined
    const platform = provider === 'monkeycode' || provider === 'monkeycodeintl'
    return {
      loginUrl: platform ? `${product.platformBase}/` : `${product.webOrigin}/login`,
      flow: { product },
    }
  }

  /**
   * 每个渠道的**登录入口**：打开哪个页面、要不要拦回调、流程里要先备好什么。
   *
   * 表驱动而不是 if 链：上一版是 if 链 + 一个「其余都按超级麦吉处理」的兜底分支，
   * 于是 `baizhi` / `officeace` 掉进兜底里读 `null.webOrigin` 抛 TypeError ——
   * 两者一直登不上，而错误文案是「不能读取 null 的属性」，与真实原因毫无关系。
   */
  const BROWSER_LOGIN_ENTRIES = {
    marvis(options) {
      const loginType = options?.loginType === '2' ? '2' : '1'
      const guid = crypto.randomUUID()
      return { loginUrl: marvisAuthorizeUrl(loginType, guid), intercept: isMarvisCallbackUrl, flow: { guid, loginType } }
    },
    officeace() {
      // PKCE + DPoP：私钥必须随凭据持久化（续期要用同一把），故先造好挂进 flow。
      const { codeVerifier, codeChallenge } = pkcePair()
      const { privateJwk } = generateDpopKey()
      return {
        loginUrl: officeaceAuthorizeUrl({ state: crypto.randomUUID(), codeChallenge }),
        intercept: isOfficeaceCallbackUrl,
        flow: { codeVerifier, privateJwk },
      }
    },
    // 豆包：登录是页面内的二维码模态框（不是独立登录页），扫码后 `.doubao.com` 种下
    // `sessionid`。不拦任何请求 —— 页面必须能正常加载，用户才扫得到码。
    doubao() {
      return { loginUrl: DOUBAO.pageUrl, flow: {} }
    },
    // 百智云：控制台登录后 cookie 换 `sk-`。
    baizhi() {
      return { loginUrl: `${BAIZHI.platformBase}/console`, flow: {} }
    },
    magicrew: () => productLoginEntry('magicrew'),
    magicrewintl: () => productLoginEntry('magicrewintl'),
    monkeycode: () => productLoginEntry('monkeycode'),
    monkeycodeintl: () => productLoginEntry('monkeycodeintl'),
  }

  async function startBrowserChannelLogin(provider, options = {}) {
    if (!BROWSER_LOGIN_PROVIDERS.has(provider)) return { error: `该渠道没有浏览器登录：${provider}` }
    const entryOf = BROWSER_LOGIN_ENTRIES[provider]
    if (typeof entryOf !== 'function') return { error: `该渠道的浏览器登录入口尚未实现：${provider}` }
    const entry = entryOf(options)
    if (entry === undefined || typeof entry.loginUrl !== 'string' || entry.loginUrl === '') {
      return { error: `该渠道的登录入口不可用：${provider}` }
    }
    const account = ownAccounts.create(provider)
    let session
    try {
      // ⚠️ `intercept` 只在真的要拦回调时打开：`Fetch` 域一旦覆盖 `*`，页面每个请求
      // 都会停在 `requestPaused` 等人放行 —— 没人放行的会话就是白屏窗口。
      const hookable = typeof entry.intercept === 'function'
      session = await startChromiumSession({
        url: entry.loginUrl,
        intercept: hookable,
        log: message => logger.info?.(`our-free-model: ${message}`),
      })
      const flow = {
        accountId: account.id,
        provider,
        session,
        done: false,
        deadline: Date.now() + BROWSER_LOGIN_TIMEOUT_MS,
        ...entry.flow ?? {},
      }
      if (hookable) {
        flow.hook = interceptCallback(session, entry.intercept)
        flow.hook.promise.then(value => { flow.done = true; flow.result = value ?? null })
      }
      browserLogins.set(account.id, flow)
      return { accountId: account.id, loginUrl: entry.loginUrl, mode: 'browser' }
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
      await ownAccounts.attach(accountId, exchanged.credential, {
        nickname: OFFICEACE.displayName,
        ...typeof exchanged.credential.expires_at === 'number' ? { expiresAt: exchanged.credential.expires_at } : {},
      })
      void syncOwnCatalog({ refresh: true })
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
      void syncOwnCatalog({ refresh: true })
      return { done: true, success: true, ...nickname === undefined ? {} : { nickname } }
    }

    // Magicrew：每轮读一次页面里的实时 localStorage（Chromium 会把它缓在内存，
    // 落盘要等关窗 —— 所以只能走 `Runtime.evaluate`，不能读磁盘 leveldb）。
    if (Date.now() > flow.deadline) {
      closeBrowserFlow(accountId)
      await ownAccounts.remove(accountId).catch(() => {})
      // `expiredReason` 由各渠道在「已经看到一半」时改写：超时那句话得说清缺的是哪一半。
      return { done: true, success: false, error: flow.expiredReason ?? '登录窗口已关闭或超时，请重新发起' }
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
      void syncOwnCatalog({ refresh: true })
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
      void syncOwnCatalog({ refresh: true })
      return { done: true, success: true, nickname: flow.product.displayName }
    }
    // 豆包：扫码后 `.doubao.com` 种下 `sessionid`；另外**必须**等页面把 `bdms`
    // 注入好（签到的 `a_bogus` 只能在那里算）。两个条件都满足才算登完 ——
    // 「cookie 有了但签名环境还没起来」是最常见的中间态，此时落库等于签到时才报错。
    // ⚠️ 登录**不**打任何上游请求：签到是写操作，登录只负责把会话收下来。
    if (flow.provider === 'doubao') {
      // 用户把窗口关了：立刻收尾，别让他对着「等待中」等满 4 分钟。
      if (flow.session?.cdp?.closed === true) {
        closeBrowserFlow(accountId)
        await ownAccounts.remove(accountId).catch(() => {})
        return { done: true, success: false, error: '登录窗口已关闭，请重新发起' }
      }
      let cookie
      try {
        cookie = doubaoCookieHeaderFromList(await flow.session.cookies(DOUBAO.pageUrl))
      } catch {
        return { done: false, status: 'pending' }
      }
      const sessionid = sessionIdFromCookie(cookie)
      if (sessionid === undefined) return { done: false, status: 'pending' }
      // 空串 = 「bdms 还没注入」，**不是错误**：继续轮询。
      let signature = ''
      try { signature = await flow.session.evaluate(DOUBAO_SIGN_EXPRESSION) } catch { signature = '' }
      if (typeof signature !== 'string' || signature === '') {
        // 登录态已经收下、差的是签名环境（实测冷启动要 15–20 秒；被拦掉的 chunk 就永远不会来）。
        flow.expiredReason = '登录态已收下，但页面签名环境（bdms）始终没就绪：请确认浏览器能正常打开 www.doubao.com/chat/ 后重试'
        return { done: false, status: 'pending' }
      }
      closeBrowserFlow(accountId)
      await ownAccounts.attach(accountId, { cookie, accountKey: sessionid, provider: DOUBAO.id }, { nickname: DOUBAO.displayName })
      void syncOwnCatalog({ refresh: true })
      return { done: true, success: true, nickname: DOUBAO.displayName }
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
    void syncOwnCatalog({ refresh: true })
    return { done: true, success: true, nickname: flow.product.displayName }
  }

  /** 取消一条浏览器登录（用户手动关掉流程时调用）。 */
  function cancelBrowserLogin(accountId) {
    return closeBrowserFlow(accountId) !== undefined
  }

  /**
   * 宿主其它渠道的模型目录（只作路由分组成员的候选）。
   *
   * 分组的价值在于覆盖**整个宿主**：成员的 provider 常常不是本插件，落在别的
   * adapter 上。那些行由这里从宿主 `llm` 读出，只进分组视图（不进我们自己的
   * 目录）；真正发请求时再原样交回宿主路由（见 `FreeModelAdapter.runForeign`）。
   *
   * 60 秒缓存：`/routes` 是面板每次改动都会拉的路径，逐个 provider 现读会把一次
   * 保存拖成十几趟 RPC；这个目录只会因为「渠道装没装 / 开没开」而变。
   */
  const HOST_CATALOG_TTL = 60_000
  let hostCatalogAt = 0
  let hostCatalogRun = null
  let hostCatalogSig = ''
  let hostCatalogLogged = false
  async function syncHostCatalog({ force = false } = {}) {
    const llm = hostLlm
    if (llm === null || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return
    if (!force && Date.now() - hostCatalogAt < HOST_CATALOG_TTL) return
    if (hostCatalogRun !== null) return hostCatalogRun
    hostCatalogRun = (async () => {
      const skip = new Set([ROUTE_MAIN, ROUTE_REGION, ROUTE_GROUPS, ...OWN_PROVIDERS])
      const rows = []
      const counts = []
      let providers = []
      try { providers = llm.listProviders() ?? [] } catch { providers = [] }
      for (const provider of providers) {
        const id = String(provider?.id ?? provider?.name ?? '').trim()
        if (id === '' || skip.has(id) || id.startsWith(GROUP_PREFIX) || id.startsWith('combo:')) continue
        try {
          const models = await llm.listModels(id)
          const list = Array.isArray(models) ? models : []
          counts.push(`${id}:${list.length}`)
          for (const model of list) {
            const modelId = String(model?.id ?? '').trim()
            if (modelId === '') continue
            const reasoning = model?.reasoning
            const efforts = Array.isArray(reasoning?.efforts)
              ? reasoning.efforts.map(row => typeof row === 'string' ? row : String(row?.id ?? '')).filter(value => value !== '')
              : []
            rows.push({
              id: `${id}/${modelId}`,
              name: String(model?.name ?? modelId),
              provider: id,
              modelId,
              channel: 'host',
              vision: Array.isArray(model?.inputModalities) && model.inputModalities.includes('image'),
              ...efforts.length === 0 ? {} : { efforts },
              ...typeof reasoning?.defaultEffort === 'string' ? { effortDefault: reasoning.defaultEffort } : {},
              ...reasoning === undefined || reasoning === null ? {} : { reasoning: true },
            })
          }
        } catch {
          counts.push(`${id}:ERR`)
        }
      }
      hostCatalogAt = Date.now()
      const signature = rows.map(row => row.id).join('\n')
      // 目录变化才重建（rebuild 会发拓扑事件）；但第一次必须留一条读数，
      // 否则「一个成员都加不进来」时没有任何观测点。
      if (signature !== hostCatalogSig || !hostCatalogLogged) {
        hostCatalogSig = signature
        hostCatalogLogged = true
        modelRuntime.setHostCatalog(rows)
        diagLog({ kind: 'host-catalog', rows: rows.length, counts: counts.join(' ') })
      }
    })().finally(() => { hostCatalogRun = null })
    return hostCatalogRun
  }

  /**
   * 路由页的完整读数：分组 + 熔断 + 绑定 + 可加入分组的模型清单。
   * `models` 只列真实模型行，且排除分组自身——否则一个组可以把自己当成员，
   * 候选解析会无限递归。组合链也不列：成组后 `runChain` 没有嵌套 combo 的递归
   * 路径，会把 `combo:` 当实模型直发免费车道端点。
   *
   * 目录用 `routeCatalog`：本插件自己的行 + 宿主其它渠道的行，这样迁移过来的
   * 分组（成员常是 unisound / codearts / trae 这些）才能被解析、被修复。
   */
  const routeStatus = async () => {
    await syncHostCatalog()
    const snapshotState = state()
    const visible = snapshotState.routeCatalog ?? snapshotState.catalog
    return {
      ...routeStore.status({ catalog: visible, gate }),
      settings: {
        defaultConcurrency: Number(settings.get().route?.defaultConcurrency) || 0,
        capacityCooldownMs: Number(settings.get().route?.capacityCooldownMs) || 30_000,
        concurrencyByModel: { ...(settings.get().route?.concurrencyByModel ?? {}) },
      },
      models: visible
        // 组合链不能进分组：`runChain` 把成员当实模型直接发下游，没有嵌套 combo 的
        // 递归路径；把 `combo:` 放进组会以 chat 协议打到免费车道端点。
        .filter(entry => !isRouteEntry(entry) && !isComboEntry(entry))
        .map(entry => ({
          id: entry.id,
          name: entry.name,
          channel: entry.channel ?? 'free',
          provider: entry.provider ?? '',
          contextWindow: entry.contextWindow,
          vision: entry.vision === true,
          availability: availability.get().results?.[entry.id]?.state ?? 'unknown',
          // 分组编辑器要把「成员档位」做成下拉：只给 id 的话用户只能背 id，
          // 填错的旧词汇还会静默落回默认档。这里把模型自己认的档位一起下发。
          reasoning: entry.reasoning === true,
          canDisableThinking: entry.canDisableThinking === false ? false : undefined,
          efforts: Array.isArray(entry.efforts) ? entry.efforts.map(level => String(level)) : [],
          effortDefault: typeof entry.effortDefault === 'string' ? entry.effortDefault : undefined,
        })),
    }
  }

  // 启动后补一次宿主目录：即便用户没打开过 `/routes`，分组面板也要能立刻列出
  // 「可加入的模型」。延迟是为了等所有渠道包注册完 adapter；`llm` 服务本身可能
  // 比 apply 还晚（实测：6 秒时 `scoped.llm` 仍是空的），所以没等到就再试几次。
  {
    let attempts = 0
    const kick = () => {
      void syncHostCatalog({ force: true })
        .then(() => {
          if (hostLlm !== null || attempts >= 5) return
          attempts += 1
          setTimeout(kick, 4000).unref?.()
        })
        .catch(error => logger.warn?.(`our-free-model: host catalog sync failed (${error?.message ?? error})`))
    }
    setTimeout(kick, 6000).unref?.()
  }

  const logAdmissionRejection = surface => ({ status, source, reason }) => {
    // Fixed fields only: headers, request URLs and admission errors may contain
    // credentials. JSON API and SSE must report the same admission boundary.
    logger.warn?.(`our-free-model: ${surface} admission rejected status=${status} source=${source} reason=${reason}`)
  }
  const api = createApiRoutes({
    settings, stats, availability, catalog: () => modelRuntime.catalog, state,
    // 诊断日志是 apply 作用域里的闭包：`createApiRoutes` 在模块级，直接引用会
    // ReferenceError（真机表现：点「模型」折叠 → 操作失败：diagLog is not defined）。
    diagLog,
    refreshCatalog, refreshAvailability, syncForward, syncRelay, syncEgress,
    // 池的候选要在读取时刷新宿主目录；和 diagLog 同一批 apply 作用域闭包，
    // 直接裸引用会 ReferenceError（见下方 2470 行的注释）。
    syncHostCatalog,
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
        // A verdict, not a nullable list: the page has to be able to say *why*
        // nothing came back (no listing URL, 401, timeout, unexpected shape).
        const probe = await probeProviderListing(settings.get().aggregate ?? {}, providerId)
        if (!probe.ok) return { ok: false, models: null, status: probe.status, message: String(probe.message ?? '') }
        const ids = probe.models ?? []
        const section = settings.get().aggregate ?? {}
        const providers = { ...(section.providers ?? {}) }
        if (providers[providerId] !== undefined) {
          providers[providerId] = { ...providers[providerId], discovered: ids.slice(0, 300) }
          settings.update({ aggregate: { ...section, providers } })
          settings.flush()
          syncAggregateCatalog()
        }
        diagLog({ kind: 'aggregate-discover', provider: providerId, models: ids.length })
        return { ok: true, models: ids, status: probe.status, message: String(probe.message ?? '') }
      },
      // One tiny generation against one model: the listing proves the key, this
      // proves the model is actually entitled for this account.
      testModel: async patch => {
        const providerId = String(patch?.providerId ?? '').trim()
        const modelId = String(patch?.modelId ?? '').trim()
        if (getProvider(providerId) === null) throw httpError(400, `unknown provider "${providerId}"`)
        if (modelId === '') throw httpError(400, 'a modelId is required')
        return testModel(settings.get().aggregate ?? {}, providerId, modelId, { timeoutMs: 120_000 })
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
    // ── forward pool (one exposed gateway name, auto-retry + failover) ──────
    forwardPool: {
      get: () => {
        const pool = normalizePool(settings.get().forwardPool)
        // Candidate *and* resolution source: `routeCatalog` (`routeMembers`) is
        // "this plugin's real rows + the host's other-provider rows", without the
        // group/combo/pool virtual rows. Using `catalog` here dropped every
        // host-lane model from the picker while `runChain` could still run them
        // (`runForeign`), so ticking one resolved to nothing.
        const catalog = state().routeCatalog ?? state().catalog
        const row = buildPoolRow(pool, catalog)
        // The picker offers every *real* model; a pool can never contain another
        // virtual row, so combos, groups and the pool itself are filtered out.
        const members = catalog
          .filter(entry => entry.channel !== 'pool' && !isComboEntry(entry) && !isRouteEntry(entry))
          .map(entry => ({
            id: entry.id,
            name: entry.name,
            channel: entry.channel ?? 'free',
            // Host rows carry their real provider; the panel shows it so two
            // models with the same display name stay distinguishable.
            provider: typeof entry.provider === 'string' ? entry.provider : null,
            vision: entry.vision === true,
            // Where the row comes from, so the picker can say "预置" instead of
            // presenting a registry template as if it were a live upstream model
            // (the aggregate lane falls back to its registry list until a
            // discovery round writes the real ids back).
            source: entry.channel === 'aggregate'
              ? (entry.source === 'discovered' ? 'discovered' : 'registry')
              : entry.channel === 'host' ? 'host'
                : entry.source === 'discovered' ? 'discovered' : null,
            // What the smart ranking sees today, so the panel can explain its order
            // rather than presenting it as a black box.
            today: (() => {
              const bucket = stats.get().days?.[dayKey()]?.models?.[entry.id]
              if (bucket === undefined) return null
              return { calls: Number(bucket.calls) || 0, failed: Number(bucket.failed) || 0,
                meanTtftMs: (Number(bucket.ttftSamples) || 0) > 0 ? Math.round((Number(bucket.ttftMs) || 0) / bucket.ttftSamples) : null }
            })(),
          }))
        return {
          pool,
          members,
          resolved: row === null ? [] : row.pool,
          // The base URL a client should dial, with the pool name pre-filled so the
          // "just one field" promise is visible, not merely described.
          example: { model: pool.name, endpoint: '/v1/chat/completions' },
          strategies: ['smart', 'fallback', 'round-robin'],
        }
      },
      save: async patch => {
        if (patch === null || typeof patch !== 'object') throw httpError(400, 'the request body must be a JSON object')
        const before = normalizePool(settings.get().forwardPool)
        // A partial patch keeps what it does not name: without this, a client
        // that only flips `enabled` would silently reset the member list to the
        // default empty array (an empty `members` is still an explicit clear).
        const next = normalizePool({ ...before, ...patch })
        // Refuse a name that collides with a real model or another virtual row: two
        // catalog entries with one id is a resolution ambiguity, not a preference.
        if (next.enabled === true) {
          const clash = state().catalog.find(entry => entry.id === next.id && entry.channel !== 'pool')
          if (clash !== undefined) throw httpError(409, `"${next.name}" already names another model (${clash.id}); pick a different entry name`)
        }
        settings.update({ forwardPool: next })
        settings.flush()
        syncAggregateCatalog()
        // One line per save: the panel's "saved" notice and the log now agree,
        // so a save that did not persist is visible as a missing line instead of
        // an unexplained revert.
        diagLog({ kind: 'pool-save', enabled: next.enabled, name: next.name, members: next.members.length })
        // Resolve against the same directory the picker offered, or a saved host
        // member would come back as "unresolved" the moment it is not in `catalog`.
        const row = buildPoolRow(next, state().routeCatalog ?? state().catalog)
        return {
          pool: next,
          resolved: row === null ? [] : row.pool,
          // Name changes invalidate any client config pinned to the old name; say so
          // when it happened rather than letting the client 404 later.
          renamed: before.id !== next.id ? { from: before.name, to: next.name } : null,
        }
      },
      /**
       * 真实调用一次某个成员，回答「它现在到底能不能用」。
       *
       * 池的价值取决于成员质量：一个空流成员加一个永不响应的成员，会把一次
       * 正常请求拖到客户端超时，而用户只看到「流返回空」。面板据此让用户逐个
       * 测、把坏的移出去，而不是靠猜。
       */
      test: async memberId => {
        const id = String(memberId ?? '').trim()
        const pool = normalizePool(settings.get().forwardPool)
        if (id === '' || !pool.members.includes(id)) {
          throw httpError(400, `"${id}" is not a member of this pool`)
        }
        const snapshot = state()
        const entry = (snapshot.routeCatalog ?? snapshot.catalog).find(row => row.id === id)
        if (entry === undefined) {
          return { ok: false, message: 'this member is not in the current catalog — its channel or credential is gone', ttftMs: 0, elapsedMs: 0 }
        }
        const started = Date.now()
        const controller = new AbortController()
        // 120s rather than the turn budget: a member that has not produced a
        // single byte by then is exactly the one that makes a client time out.
        const timer = setTimeout(() => controller.abort(), 120_000)
        timer.unref?.()
        let firstAt = 0
        let text = ''
        let failure = ''
        try {
          for await (const chunk of adapter.stream({
            provider: ROUTE_MAIN,
            model: id,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
            maxTokens: 32,
            sessionId: `pool-probe:${id}`,
            signal: controller.signal,
          }, entry, snapshot)) {
            const type = chunk?.type
            if (type === 'finish') {
              if (chunk.reason?.kind === 'error') failure = String(chunk.reason.failure?.message ?? 'failed')
              break
            }
            if (type === 'usage') continue
            if (firstAt === 0) firstAt = Date.now()
            if (type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
          }
        } catch (error) {
          failure = String(error?.message ?? error)
        } finally {
          clearTimeout(timer)
        }
        const elapsedMs = Date.now() - started
        const ttftMs = firstAt === 0 ? 0 : firstAt - started
        if (failure !== '') return { ok: false, message: failure, ttftMs, elapsedMs }
        if (firstAt === 0) return { ok: false, message: 'the member closed the stream without producing a token', ttftMs: 0, elapsedMs }
        return { ok: true, message: text.trim() === '' ? 'answered (reasoning only)' : 'answered', ttftMs, elapsedMs }
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
    // ── 上下文压缩（宿主编译器 + 运行时阈值）──────────────────────────────
    compaction: {
      get: async () => compaction.status(),
      /** 设置页保存后立即重放（下一次 `agent/pre-step` 仍会再兜底一次）。 */
      apply: async () => {
        applyCompaction()
        return compaction.status()
      },
      set: async patch => {
        if (patch === null || typeof patch !== 'object') throw httpError(400, 'the request body must be a JSON object')
        return compaction.set(patch)
      },
      restore: async () => compaction.restore(),
    },
    // ── 路由分组（取代 model-failover-manager 的持久层）────────────────────
    routes: {
      list: async () => await routeStatus(),
      save: async patch => {
        if (patch === null || typeof patch !== 'object') throw httpError(400, 'the request body must be a JSON object')
        const groups = routeStore.saveGroups(patch.groups ?? patch)
        const catalog = syncRouteCatalog()
        for (const group of groups) {
          logger.info?.(`our-free-model: route group saved — ${describeGroupLine(group)}`)
        }
        return { groups, usable: catalog.filter(isRouteEntry).map(entry => ({ id: entry.id, name: entry.name, models: entry.memberIds })) }
      },
      resetFailed: async patch => {
        const key = typeof patch?.key === 'string' && patch.key !== '' ? patch.key : undefined
        if (key === undefined) routeStore.resetFailed()
        else routeStore.resetFailed(key)
        return await routeStatus()
      },
      /**
       * 把「目录里能对上、但存的是旧坐标」的成员改写当前 id。
       *
       * 迁移过来的分组常带旧 provider 前缀或双前缀（`unison/u2-flash`、
       * `doubao/doubao/person-…`），`memberEntry` 能在运行时按尾段兜底解析，
       * 但面板会一直显示「目录缺失」，改档位/看失败也没法定位。这里一次性
       * 把坐标写正；真的找不到的成员原样保留并列出来，由用户删或补。
       */
      remap: async () => {
        await syncHostCatalog({ force: true })
        const { groups, changed, unresolved } = remapGroups(routeStore.groups, state().routeCatalog)
        if (changed > 0) routeStore.saveGroups(groups)
        syncRouteCatalog()
        logger.info?.(`our-free-model: route remap — ${changed} member(s) rewritten, ${unresolved.length} unresolved`)
        return { changed, unresolved, ...await routeStatus() }
      },
      cooldown: async patch => {
        gate.resetCooldown(typeof patch?.model === 'string' && patch.model !== '' ? patch.model : undefined)
        return await routeStatus()
      },
      import: async patch => {
        const result = routeStore.importLegacy({ force: patch?.force === true })
        if (result.imported === true) syncRouteCatalog()
        return { result, ...await routeStatus() }
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
    syncOwnCatalog: options => syncOwnCatalog(options),
    // 面板的「模型」折叠：**含被关掉的行**（否则关掉一个模型后它就从列表里消失，
    // 用户再也点不回来）。选择器读的仍是过滤后的 catalog。
    ownModelRows: provider => {
      const ratios = ownCatalogRatios(provider)
      return buildOwnCatalog({
        catalogs: ownCatalogRows(),
        enabled: ownEnabled,
        includeDisabled: true,
        ...ownControlSettings(),
      }).filter(entry => entry.provider === provider).map(entry => {
        // 倍率与目录同源：`statusOf` 回的 ratios 用完整 id（`doubao/xxx`）；
        // 行本身的 `rate`（若有）优先。没有倍率就不编。
        const ratio = entry.rate ?? ratios[entry.id] ?? ratios[entry.modelId]
        return ratio === undefined ? entry : { ...entry, ratio: String(ratio) }
      })
    },
    ownModelCounts: provider => ownCountsOf(provider),
    ownModelMeta: provider => ownCatalogMeta(provider),
    /** 这家渠道有没有可用的续期实现（面板据此决定是否渲染「刷新凭据」）。 */
    canRefreshProvider: provider => typeof OWN_REFRESH[provider] === 'function',
    refreshOwnAccount: accountId => refreshOwnAccount(accountId),
    deviceLogin: () => deviceLogin,
    smsLogin: () => smsLogin,
    // 下面这几项原本是 apply 作用域里的自由变量，被 `createApiRoutes`（模块级
    // 函数）直接引用 ⇒ 一点就 `ReferenceError`（真机：模型折叠 500 / Accio 登录失败）。
    // 统一走 deps，路由函数里不再出现裸引用。
    hostLlm: () => hostLlm,
    hasRefreshMaterial,
    agnesImport: importAgnesAccount,
    accioLogin: {
      start: startBrowserLogin,
      open: openBrowser,
      exchange: exchangeCode,
      userInfo: fetchAccioUserInfo,
      flows: accioLogins,
    },
    /**
     * 渠道清单（**宿主实际加载的那一份**）：面板拿它与自己渲染的卡片对账。
     *
     * 值全部现场读真实注册表 —— 不再抄一份常量（那只会把「六处」变成「七处」）。
     */
    manifest: () => buildChannelManifest({
      ownIds: [...OWN_PROVIDERS],
      extrasIds: channelExtras.available === true ? channelExtras.providers() : [],
      browserIds: [...BROWSER_LOGIN_PROVIDERS],
      importIds: Object.keys(AGNES_PRODUCTS_BY_PROVIDER),
      supportsDeviceLogin: provider => deviceLogin.supports(provider),
      supportsSmsLogin: provider => smsLogin.supports(provider),
      hasQrLogin: provider => provider === 'astudio',
      modelCount: provider => modelRuntime.catalog.filter(entry => entry.channel === 'own' && entry.provider === provider).length,
    }),
    // The catalog visibility switch lives in `apply`'s scope (it wraps the pool
    // the pack provides on mount), so the route reaches it through here.
    channelVisibility: () => channelVisibility,
    // Rebuilding the catalog is what makes the picker drop the hidden groups:
    // the client caches one catalog per Host generation, so it needs the event.
    onTopology: () => emitTopology(),
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
  if (next.compaction !== undefined) {
    const raw = next.compaction ?? {}
    const ratio = raw.thresholdRatio === null || raw.thresholdRatio === undefined || raw.thresholdRatio === ''
      ? null
      : Number(raw.thresholdRatio)
    next.compaction = {
      enabled: raw.enabled !== false,
      // null = 跟随引擎默认。1.0 不在这里出现：那只能由"关闭"开关产生。
      thresholdRatio: Number.isFinite(ratio) && ratio > 0
        ? Math.min(0.95, Math.max(0.2, Math.round(ratio * 100) / 100))
        : null,
    }
  }
  if (next.modelEffort !== undefined) {
    const table = {}
    for (const [id, level] of Object.entries(next.modelEffort ?? {})) {
      if (typeof level !== 'string') continue
      const clean = level.trim().slice(0, 24)
      if (clean === '') continue
      table[String(id).slice(0, 160)] = clean
    }
    next.modelEffort = table
  }
  if (next.route !== undefined) {
    const merged = { ...(current.route ?? {}), ...(next.route ?? {}) }
    const clampCount = value => {
      const number = Number(value)
      return Number.isFinite(number) && number >= 0 ? Math.min(64, Math.trunc(number)) : 0
    }
    merged.defaultConcurrency = clampCount(merged.defaultConcurrency)
    const cooldown = Number(merged.capacityCooldownMs)
    merged.capacityCooldownMs = Number.isFinite(cooldown) && cooldown >= 0 ? Math.min(600_000, Math.trunc(cooldown)) : 30_000
    const table = {}
    for (const [id, value] of Object.entries(merged.concurrencyByModel ?? {})) {
      const number = Number(value)
      if (Number.isFinite(number) && number >= 0) table[String(id).slice(0, 160)] = Math.min(64, Math.trunc(number))
    }
    merged.concurrencyByModel = table
    next.route = merged
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

export function createApiRoutes(deps) {
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
      if (method === 'POST' && routePath === '/providers/test-model') {
        const body = await readJson(req)
        return send(200, await deps.providers.testModel(body))
      }
      // ── fallback chains ────────────────────────────────────────────────────
      if (method === 'GET' && routePath === '/combos') {
        return send(200, deps.combos.list())
      }
      if (method === 'POST' && routePath === '/combos') {
        const body = await readJson(req)
        return send(200, { ok: true, ...await deps.combos.save(body) })
      }
      // ── forward pool (one exposed gateway name, auto-retry + failover) ─────
      if (method === 'GET' && routePath === '/forward-pool') {
        // The picker must include the host's other-channel models, and those only
        // exist in `routeCatalog` after a sync. `syncHostCatalog` is an `apply`-scope
        // closure: reached only through deps, or this route throws a ReferenceError
        // that reads as a bare 500 (same trap as diagLog, see the deps block).
        await deps.syncHostCatalog?.()
        return send(200, deps.forwardPool.get())
      }
      if (method === 'POST' && routePath === '/forward-pool') {
        const body = await readJson(req)
        return send(200, { ok: true, ...await deps.forwardPool.save(body) })
      }
      if (method === 'POST' && routePath === '/forward-pool/test') {
        const body = await readJson(req)
        return send(200, await deps.forwardPool.test(body?.memberId))
      }
      // ── compaction threshold (host engine, runtime takeover) ───────────────
      if (method === 'GET' && routePath === '/compaction') {
        return send(200, await deps.compaction.get())
      }
      if (method === 'POST' && routePath === '/compaction') {
        const body = await readJson(req)
        return send(200, { ok: true, ...await deps.compaction.set(body) })
      }
      if (method === 'POST' && routePath === '/compaction/restore') {
        return send(200, { ok: true, ...await deps.compaction.restore() })
      }
      // ── route groups (failover, priority, windows, concurrency) ────────────
      if (method === 'GET' && routePath === '/routes') {
        return send(200, await deps.routes.list())
      }
      if (method === 'POST' && routePath === '/routes') {
        const body = await readJson(req)
        return send(200, { ok: true, ...await deps.routes.save(body) })
      }
      if (method === 'POST' && routePath === '/routes/import') {
        const body = await readJson(req)
        return send(200, { ok: true, ...await deps.routes.import(body) })
      }
      if (method === 'POST' && routePath === '/routes/remap') {
        return send(200, { ok: true, ...await deps.routes.remap() })
      }
      if (method === 'POST' && routePath === '/routes/failed/reset') {
        const body = await readJson(req)
        return send(200, { ok: true, ...await deps.routes.resetFailed(body) })
      }
      if (method === 'POST' && routePath === '/routes/cooldown/reset') {
        const body = await readJson(req)
        return send(200, { ok: true, ...await deps.routes.cooldown(body) })
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
      if (method === 'GET' && routePath === '/channels/manifest') {
        // 面板的对账入口：**宿主到底认识哪些渠道**。不带任何凭据，只报注册表事实。
        // `?expect=a,b,c`（面板渲染的自有渠道）→ 额外回 `missing`：宿主不认识的那些。
        // 判据在宿主侧算一次（`missingFromHost`），面板只显示 —— 不抄第二份规则。
        const manifest = deps.manifest()
        const expect = String(url.searchParams.get('expect') ?? '').trim()
        const expected = expect === '' ? [] : expect.split(',').map(id => id.trim()).filter(id => id !== '')
        return send(200, { ...manifest, missing: missingFromHost(manifest, expected) })
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
        if (outcome.kind !== 'failed') void deps.syncOwnCatalog?.({ refresh: true })
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
            const models = deps.hostLlm() === null ? [] : await deps.hostLlm().listModels(provider)
            count = Array.isArray(models) ? models.length : 0
            ids = Array.isArray(models) ? models.slice(0, 4).map(model => model.id ?? model.name ?? '?') : []
          } catch (failure) {
            error = String(failure?.message ?? failure)
          }
          rows.push({ provider, count, ids, error })
        }
        const ownRows = deps.catalog().filter(entry => entry.channel === 'own')
        const summary = rows.map(row => row.provider + ':' + row.count).join(' ')
        deps.diagLog?.({ kind: 'diag-models', counts: summary, own: ownRows.length })
        return send(200, {
          hostLlm: deps.hostLlm() !== null,
          packProviders: rows,
          ownRows: ownRows.length,
          ownSample: ownRows.slice(0, 4).map(entry => entry.id),
        })
      }
      // 自有渠道的模型清单：面板「模型」折叠用它（渠道包的 model.list 不认识这些 id）。
      // ⚠️ 这里**包含被关掉的行**（`disabled: true`）：过滤后的那份只给选择器/
      // 网关用，面板必须能看到自己关过什么、并点回来。
      if (method === 'GET' && routePath === '/channels/own/models') {
        const provider = String(url.searchParams.get('provider') ?? '').trim()
        if (provider === '') return send(400, { error: 'provider is required' })
        const rows = deps.ownModelRows(provider)
        deps.diagLog?.({ kind: 'models-route', provider, total: rows.length })
        const models = rows.map(entry => ({
          id: entry.id,
          modelId: entry.modelId,
          name: entry.name,
          disabled: entry.disabled === true,
          dead: false,
          ...entry.needsLogin === true ? { needsLogin: true } : {},
          ...entry.ratio === undefined ? {} : { ratio: entry.ratio },
          ...entry.rate === undefined ? {} : { rate: entry.rate },
          ...entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow },
        }))
        return send(200, {
          provider,
          models,
          counts: deps.ownModelCounts(provider),
          // 「实时/预制」提示：远端取到就用最新表，取不到就继续显示预制表并说明。
          catalog: deps.ownModelMeta(provider),
        })
      }
      // 模型开关（单个 / 全部）：写进设置，选择器与网关在下一次 sync 时生效。
      if (method === 'POST' && routePath === '/channels/own/models/update') {
        const body = await readJson(req)
        const provider = String(body?.provider ?? '').trim()
        if (!OWN_PROVIDERS.includes(provider)) return send(400, { error: `unknown own provider: ${provider}` })
        const disabled = body?.disabled === true
        const rawId = String(body?.modelId ?? '').trim()
        // 面板拿到的是完整 id（`doubao/xxx`），设置里存裸 modelId —— 与兜底表同名。
        const modelId = rawId.startsWith(`${provider}/`) ? rawId.slice(provider.length + 1) : rawId
        const current = deps.settings.get().ownDisabledModels ?? {}
        const set = new Set((Array.isArray(current[provider]) ? current[provider] : []).map(String))
        if (modelId !== '') {
          if (disabled) set.add(modelId)
          else set.delete(modelId)
        } else if (disabled) {
          for (const row of deps.ownModelRows(provider)) set.add(row.modelId)
        } else {
          set.clear()
        }
        const next = { ...current }
        if (set.size === 0) delete next[provider]
        else next[provider] = [...set]
        deps.settings.update({ ownDisabledModels: next })
        deps.settings.flush()
        await deps.syncOwnCatalog()
        return send(200, { ok: true, provider, models: deps.ownModelCounts(provider), rows: deps.ownModelRows(provider) })
      }
      // 渠道级总开关：关闭 = 隐藏全部模型 + 停用全部账号；打开 = 清空模型黑名单 + 启用全部账号。
      if (method === 'POST' && routePath === '/channels/own/provider/update') {
        const body = await readJson(req)
        const provider = String(body?.provider ?? '').trim()
        if (!OWN_PROVIDERS.includes(provider)) return send(400, { error: `unknown own provider: ${provider}` })
        const enabled = body?.enabled === true
        const closedMap = { ...(deps.settings.get().ownClosedProviders ?? {}) }
        const disabledMap = { ...(deps.settings.get().ownDisabledModels ?? {}) }
        if (enabled) {
          delete closedMap[provider]
          delete disabledMap[provider]
        } else {
          closedMap[provider] = true
        }
        const accounts = deps.channelAccounts().list(provider)
        for (const account of accounts) deps.channelAccounts().update(account.id, { enabled })
        deps.settings.update({ ownClosedProviders: closedMap, ownDisabledModels: disabledMap })
        deps.settings.flush()
        await deps.syncOwnCatalog()
        return send(200, {
          ok: true,
          provider,
          enabled,
          models: deps.ownModelCounts(provider),
          // 上面已把**全部账号**写成同一个 `enabled`，故两数同源。
          accounts: { total: accounts.length, enabled: enabled ? accounts.length : 0 },
        })
      }
      // 面板「刷新凭据」：只对登记了续期实现的渠道；逐账号串行由面板负责。
      if (method === 'POST' && routePath === '/channels/own/refresh') {
        const body = await readJson(req)
        const accountId = String(body?.accountId ?? '').trim()
        if (accountId === '') return send(400, { error: 'accountId is required' })
        const result = await deps.refreshOwnAccount(accountId)
        if (result.error !== undefined) {
          return send(result.error === '账号不存在' ? 404 : 400, result)
        }
        return send(200, result)
      }
      // AgnesCode：没有登录端点，凭据来自桌面客户端的加密会话（读取 + 解密在
      // src/channels/agnescode.js）。这里只负责落账号/凭据并触发目录重编。
      if (method === 'POST' && routePath === '/channels/own/import') {
        const body = await readJson(req)
        const provider = String(body?.provider ?? '').trim()
        if (provider === '') return send(400, { error: 'provider is required' })
        const imported = await deps.agnesImport(provider)
        if (imported.error !== undefined) return send(400, { error: imported.error })
        const username = typeof imported.credential?.username === 'string' ? imported.credential.username : ''
        // 同一个客户端账号反复导入 → 复用已有那条（有且仅有一条启用账号时）。
        const existing = deps.channelAccounts().list(provider).filter(entry => entry.enabled !== false)
        const account = existing.length === 1
          ? existing[0]
          : deps.channelAccounts().create(provider, { nickname: username })
        await deps.channelAccounts().attach(account.id, imported.credential, {
          ...username === '' ? {} : { nickname: username },
        })
        void deps.syncOwnCatalog({ refresh: true })
        deps.diagLog?.({ kind: 'agnes-import', provider, accountId: account.id, hasNickname: username !== '' })
        return send(200, { accountId: account.id, nickname: username })
      }
      if (method === 'GET' && routePath === '/channels/own') {
        const provider = String(url.searchParams.get('provider') ?? '').trim()
        if (provider === '') return send(400, { error: 'provider is required' })
        const canRefresh = deps.canRefreshProvider(provider)
        // `refreshable` 是**账号级**的：有续期实现 + 凭据本体存在。面板据此决定
        // 是否渲染「刷新凭据」，而不是给一个点了报「该渠道没有续期接口」的按钮。
        const accounts = await Promise.all(deps.channelAccounts().list(provider).map(async entry => {
          const credential = await deps.channelAccounts().credentialOf(entry)
          return { ...entry, refreshable: canRefresh && deps.hasRefreshMaterial(provider, credential) }
        }))
        const models = deps.ownModelCounts(provider)
        return send(200, {
          provider,
          accounts,
          supported: deps.deviceLogin().supports(provider),
          models,
          closed: models.closed,
          refreshable: canRefresh,
        })
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
        if (polled.done === true && polled.success === true) void deps.syncOwnCatalog({ refresh: true })
        // 轮询本身成功（还没授权）不是错误：`done:false` 就是「继续等」。
        return send(200, polled)
      }
      // Accio：浏览器 PKCE。与设备码同一形状（先回地址、再轮询等回调），
      // 但等的是**我们自己**起的 loopback，不是上游的轮询端点。
      //
      // ⚠️ 浏览器由**宿主**用 `rundll32 url.dll,FileProtocolHandler` 打开，不靠面板的
      // `window.open`：桌面壳的渲染进程可能拦掉弹出窗口（`dsh-app://` 上下文里
      // window.open 常被策略吃掉），而这条登录**必须在真浏览器里完成**。
      // 面板仍会把地址显示出来（`loginUrl` 回给前端）作为兜底。
      if (method === 'POST' && routePath === '/channels/own/oauth/start') {
        const body = await readJson(req)
        const provider = String(body?.provider ?? '').trim()
        if (provider !== 'accio') return send(400, { error: `该渠道没有浏览器授权登录：${provider}` })
        const account = deps.channelAccounts().create(provider)
        try {
          const flow = await deps.accioLogin.start({ region: typeof body?.region === 'string' ? body.region : 'cn' })
          deps.accioLogin.flows.set(account.id, flow)
          deps.accioLogin.open(flow.loginUrl)
          return send(200, { accountId: account.id, loginUrl: flow.loginUrl })
        } catch (error) {
          // 起不了 loopback 就把占位账号删掉，别在面板上留一条永远等不到回调的账号。
          await deps.channelAccounts().remove(account.id).catch(() => {})
          return send(500, { error: `Accio 登录初始化失败：${error?.message ?? error}` })
        }
      }
      if (method === 'GET' && routePath === '/channels/own/oauth/poll') {
        const accountId = String(url.searchParams.get('account') ?? '').trim()
        const flow = deps.accioLogin.flows.get(accountId)
        if (flow === undefined) return send(200, { done: true, success: false, error: '登录流程不存在或已结束，请重新发起' })
        // ⚠️ 落定即关掉 loopback 端口：那是一个「等着收凭据」的口子，留着没有任何好处
        // （`state` 是公开信息，本机进程能往它投一枚 code 换走凭据）。
        const settle = () => {
          deps.accioLogin.flows.delete(accountId)
          try { flow.close?.() } catch { /* 已关 */ }
        }
        try {
          const { code, verifier, redirectUri } = await flow.waitForCode()
          const exchanged = await deps.accioLogin.exchange({ code, codeVerifier: verifier, redirectUri })
          settle()
          if (exchanged.error !== undefined) return send(200, { done: true, success: false, error: exchanged.error })
          // 兑换响应**没有身份字段**：补一次 userinfo 才有可读昵称（手机号掩码/
          // 用户名），同时把区域写进凭据（续期/推理按它选域）。
          const identity = await deps.accioLogin.userInfo(exchanged.credential.access_token)
          const info = identity.info ?? {}
          const nickname = info.maskedMobile ?? info.userName ?? info.userId ?? 'Accio'
          const credential = {
            ...exchanged.credential,
            ...Object.keys(info).length === 0 ? {} : { account: info },
            ...info.routeRegion === undefined ? {} : { region: info.routeRegion },
          }
          await deps.channelAccounts().attach(accountId, credential, {
            nickname,
            ...typeof credential.expires_at === 'number' ? { expiresAt: credential.expires_at } : {},
          })
          void deps.syncOwnCatalog({ refresh: true })
          return send(200, { done: true, success: true, nickname })
        } catch (error) {
          settle()
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
        if (!deps.smsLogin().supports(provider)) return send(400, { error: `该渠道没有短信登录：${provider}` })
        return send(200, await deps.smsLogin().send(provider, phone))
      }
      if (method === 'POST' && routePath === '/channels/own/sms/login') {
        const body = await readJson(req)
        const provider = String(body?.provider ?? '').trim()
        if (!deps.smsLogin().supports(provider)) return send(400, { error: `该渠道没有短信登录：${provider}` })
        const result = await deps.smsLogin().login(provider, String(body?.phone ?? '').trim(), String(body?.code ?? '').trim())
        if (result.error === undefined) void deps.syncOwnCatalog({ refresh: true })
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
        // 停用最后一个账号后，模型行要变成「待登录」；启用后要变回来。
        if (account !== undefined) void deps.syncOwnCatalog()
        return account === undefined ? send(404, { error: 'account not found' }) : send(200, { ok: true, account })
      }
      if (method === 'POST' && routePath === '/channels/own/remove') {
        const body = await readJson(req)
        const removed = await deps.channelAccounts().remove(String(body?.accountId ?? '').trim())
        // 删掉最后一个账号 = 这家渠道从「已登录」回到「待登录」。
        if (removed) void deps.syncOwnCatalog()
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
        const next = sanitizeSettings({ ...current, ...pick(patch, ['enabled', 'exposeRegionModels', 'hideChannelModels', 'hideUnavailableModels', 'probeIntervalMinutes', 'defaultMaxTokens', 'announcementAck', 'feedUrl', 'feedPollMinutes', 'notifyOs', 'updateCheckHours', 'autoReloadWatch', 'compaction', 'modelEffort', 'route']) }, current)
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
        // 压缩阈值是"运行时接管"，保存后立刻重放一次；`pre-step` 还会兜底。
        if (patch.compaction !== undefined) await deps.compaction.apply()
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
    hideUnavailableModels: settings.hideUnavailableModels === true,
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
    compaction: {
      enabled: settings.compaction?.enabled !== false,
      thresholdRatio: typeof settings.compaction?.thresholdRatio === 'number' ? settings.compaction.thresholdRatio : null,
    },
    modelEffort: { ...(settings.modelEffort ?? {}) },
    route: {
      defaultConcurrency: Number(settings.route?.defaultConcurrency) || 0,
      capacityCooldownMs: Number(settings.route?.capacityCooldownMs) || 0,
      concurrencyByModel: { ...(settings.route?.concurrencyByModel ?? {}) },
    },
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
  const unprobed = entry => isEacEntry(entry) || isKiloEntry(entry) || isAggregateEntry(entry) || isComboEntry(entry) || isRouteEntry(entry)
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