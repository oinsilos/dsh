/**
 * The announcement feed.
 *
 * Announcements arrive as one JSON document the local cache keeps on disk
 * (`feed.json` in the data dir). A fresh install starts empty; an operator can
 * point `feedUrl` at a feed of their own, and every running installation re-reads
 * it on boot, on a fixed poll, and on demand.
 *
 * The fetch is fail-open in both directions: a network failure keeps serving the
 * last cached copy, and a malformed feed is rejected as a whole rather than
 * half-applied (an announcement that renders wrong is worse than one that
 * arrives late).
 *
 * This module is transport and validation only. What a user has acknowledged
 * and what has already raised a toast is state the caller owns, so that a feed
 * refresh never rewrites acknowledgement history.
 *
 * @module src/feed.js
 */

import fs from 'node:fs'
import path from 'node:path'

/**
 * Feed locations, in preference order. Empty by default: this build serves the
 * local cache only and reaches no remote feed unless the operator names one in
 * `feedUrl`. Loopback http stays allowed there: those requests never leave the
 * machine, which keeps a locally-hosted mirror (and the test suites)
 * legitimate.
 */
export const DEFAULT_FEED_SOURCES = []

/** jsDelivr's edge caches per full URL; a minute-stamp keeps every poll fresh. */
export function bustCdnCache(url, now = Date.now()) {
  try {
    const parsed = new URL(url)
    if (parsed.hostname.endsWith('.jsdelivr.net')) {
      parsed.searchParams.set('ofm', Math.floor(now / 60_000).toString())
      return parsed.href
    }
  } catch { /* leave malformed URLs untouched; fetch will report them */ }
  return url
}

export const LEVELS = new Set(['info', 'update', 'warn', 'urgent'])
const MAX_FEED_BYTES = 512 * 1024
const MAX_HTML_BYTES = 96 * 1024
const MAX_ITEMS = 100

/**
 * Validate one raw feed document into the shape the rest of the plugin consumes.
 *
 * @param {unknown} payload - the parsed JSON document
 * @param {number} [now]
 * @returns {{announcements: Array<object>}}
 * @throws {Error} when the document is not a feed at all
 */
export function parseFeed(payload, now = Date.now()) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('feed document must be a JSON object')
  }
  const rows = payload.announcements
  if (!Array.isArray(rows)) throw new Error('feed document must carry an announcements array')
  const seen = new Set()
  const announcements = []
  for (const row of rows.slice(0, MAX_ITEMS)) {
    const item = parseItem(row, now)
    if (item === undefined) continue
    if (seen.has(item.id)) continue
    seen.add(item.id)
    announcements.push(item)
  }
  return { announcements: sortItems(announcements) }
}

/** Validated, normalised single announcement; `undefined` for rows that fail. */
function parseItem(row, now) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return undefined
  const id = typeof row.id === 'string' ? row.id.trim() : ''
  if (id === '' || id.length > 128) return undefined
  const title = typeof row.title === 'string' ? row.title.trim().slice(0, 200) : ''
  if (title === '') return undefined
  const html = typeof row.html === 'string' ? row.html : ''
  if (html.length > MAX_HTML_BYTES) return undefined
  const createdAt = timestamp(row.createdAt) ?? 0
  const expiresAt = timestamp(row.expiresAt)
  if (expiresAt !== undefined && expiresAt <= now) return undefined
  const level = LEVELS.has(row.level) ? row.level : 'info'
  let link
  if (row.link !== null && typeof row.link === 'object' && typeof row.link.url === 'string'
    && /^https?:\/\//i.test(row.link.url)) {
    link = { url: row.link.url, label: typeof row.link.label === 'string' ? row.link.label.slice(0, 100) : '' }
  }
  return {
    id,
    title,
    level,
    html,
    createdAt,
    ...expiresAt === undefined ? {} : { expiresAt },
    ...row.pinned === true ? { pinned: true } : {},
    ...link === undefined ? {} : { link },
  }
}

function timestamp(value) {
  // JSON has no date type, so a feed written by a script naturally carries
  // epoch milliseconds. Only accepting strings made those entries never expire
  // (and gave them a createdAt of 0, pinning them to the bottom forever).
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

/** Pinned first, then newest first; a stable order keeps the UI calm between polls. */
export function sortItems(items) {
  const stamp = item => (typeof item.createdAt === 'number' ? item.createdAt : Date.parse(item.createdAt) || 0)
  return [...items].sort((a, b) => {
    if ((b.pinned === true ? 1 : 0) !== (a.pinned === true ? 1 : 0)) return (b.pinned === true ? 1 : 0) - (a.pinned === true ? 1 : 0)
    return stamp(b) - stamp(a)
  })
}

/**
 * Fetch the feed, trying each source in turn.
 *
 * @param {string[]} sources
 * @param {{timeoutMs?: number, fetchImpl?: typeof fetch}} [options]
 * @returns {Promise<{feed: object, source: string}>}
 */
export async function fetchFeed(sources, { timeoutMs = 15000, fetchImpl = fetch } = {}) {
  const failures = []
  for (const source of sources) {
    if (typeof source !== 'string' || source === '') continue
    try {
      const response = await fetchImpl(bustCdnCache(source), {
        redirect: 'error',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined,
      })
      if (!response.ok) { failures.push(`${source} -> HTTP ${response.status}`); continue }
      const text = await response.text()
      if (text.length > MAX_FEED_BYTES) { failures.push(`${source} -> feed too large`); continue }
      const feed = parseFeed(JSON.parse(text))
      return { feed, source }
    } catch (error) {
      failures.push(`${source} -> ${error?.message ?? error}`)
    }
  }
  throw new Error(`no feed source answered (${failures.join('; ')})`)
}

/**
 * The poll loop's state: last good copy on disk, known ids for arrival
 * detection, and the bookkeeping the settings page reads.
 */
export class AnnouncementFeed {  /**
   * @param {object} deps
   * @param {() => {feedUrl?: string}} deps.settings
   * @param {string} deps.cacheFile - where the last good feed is kept
   * @param {(items: Array<object>) => void} [deps.onArrival] - items first seen in this poll
   * @param {(message: string) => void} [deps.log]
   */
  constructor({ settings, cacheFile, onArrival, log = () => {}, defaultSources = DEFAULT_FEED_SOURCES }) {
    this.deps = { settings, cacheFile, onArrival, log, defaultSources }
    this.cache = { at: 0, source: '', announcements: [] }
    this.error = ''
    this.polling = null
    this.knownIds = new Set()
  }

  /** Read the cached copy from disk; fresh installs start empty and stay silent on first poll. */
  load(disk = this.readDisk()) {
    try {
      const parsed = JSON.parse(disk ?? '')
      const feed = parseFeed(parsed)
      this.cache = { at: Number(parsed.fetchedAt) || 0, source: String(parsed.source ?? ''), announcements: feed.announcements }
    } catch {
      this.cache = { at: 0, source: '', announcements: [] }
    }
    this.knownIds = new Set(this.cache.announcements.map(item => item.id))
    return this.cache
  }

  readDisk() {
    try { return fs.readFileSync(this.deps.cacheFile, 'utf8') } catch { return '' }
  }

  /** True when the poll has never succeeded on this installation. */
  get neverFetched() { return this.cache.at === 0 }

  /** Sources for this installation: the operator's override first, then the
   * defaults (empty by default — local cache only).
   *
   * The override must be https and carry no embedded credentials — a plaintext
   * URL would hand any local writer of settings.json a whisper network to the
   * LAN. Loopback http stays allowed: those requests never leave the machine,
   * which keeps a locally-hosted mirror (and the test suites) legitimate. The
   * update channel deliberately does not read this field at all (see
   * src/updater.js). */
  sources() {
    const override = typeof this.deps.settings()?.feedUrl === 'string' ? this.deps.settings().feedUrl.trim() : ''
    if (override === '') return this.deps.defaultSources
    let parsed = null
    try { parsed = new URL(override) } catch { parsed = null }
    // URL.hostname keeps brackets on IPv6 (`[::1]`); everything loopback never
    // leaves the machine, so plain http stays acceptable there.
    const host = (parsed?.hostname ?? '').toLowerCase()
    // `hostname` is a *name* until proven otherwise: `127.evil.example` also
    // starts with "127.", and the old prefix test let it through as loopback,
    // turning this override into a plaintext channel to a remote host.
    const loopback = host === 'localhost' || host === '[::1]' || host === '::1'
      || /^127(?:\.\d{1,3}){3}$/.test(host)
    const acceptable = parsed !== null && parsed.username === '' && parsed.password === ''
      && (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback))
    if (!acceptable) {
      this.deps.log?.('our-free-model: ignoring feedUrl override — it must be an https URL (loopback http is allowed) without credentials')
      return this.deps.defaultSources
    }
    return [override, ...this.deps.defaultSources]
  }

  /**
   * One poll. Concurrent calls share a single in-flight request. A good copy
   * is persisted to the cache file the moment it is validated. With no source
   * configured the poll is a no-op that keeps the local cache — never an
   * error, so a feed-less installation logs nothing and the UI keeps its
   * cached items.
   * @returns {Promise<{arrived: Array<object>, total: number, source: string}>}
   */
  poll() {
    if (this.polling !== null) return this.polling
    this.polling = (async () => {
      try {
        const sources = this.sources()
        if (sources.length === 0) {
          return { arrived: [], total: this.cache.announcements.length, source: this.cache.source }
        }
        const { feed, source } = await fetchFeed(sources)
        const hadCache = this.knownIds.size > 0
        const previousIds = new Set(this.knownIds)
        this.cache = { at: Date.now(), source, announcements: feed.announcements }
        this.knownIds = new Set(feed.announcements.map(item => item.id))
        this.error = ''
        const arrived = hadCache && this.deps.onArrival !== undefined
          ? feed.announcements.filter(item => !previousIds.has(item.id))
          : []
        for (const item of arrived) this.deps.log?.(`our-free-model: announcement arrived "${item.title}"`)
        if (arrived.length > 0) this.deps.onArrival?.(arrived)
        this.persist()
        return { arrived, total: feed.announcements.length, source }
      } catch (error) {
        this.error = String(error?.message ?? error)
        this.deps.log?.(`our-free-model: feed poll failed (${this.error})`)
        return { arrived: [], total: this.cache.announcements.length, source: this.cache.source }
      } finally {
        this.polling = null
      }
    })()
    return this.polling
  }

  /** Write the last good copy; a crash mid-poll must not lose the cache. */
  persist() {
    try {
      fs.mkdirSync(path.dirname(this.deps.cacheFile), { recursive: true })
      const temp = `${this.deps.cacheFile}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify({ fetchedAt: this.cache.at, source: this.cache.source, announcements: this.cache.announcements }))
      fs.renameSync(temp, this.deps.cacheFile)
    } catch (error) {
      this.deps.log?.(`our-free-model: could not persist the feed cache (${error?.message ?? error})`)
    }
  }

  /** Snapshot for the API layer and the first `hello` push. */
  view({ ackedIds = [] } = {}) {
    const acked = ackedIds instanceof Set ? ackedIds : new Set(ackedIds)
    // Annotate each item with its ack state so the client renders unread
    // markers from data instead of guessing.
    // Expired announcements stop rendering the moment they lapse, not whenever
    // the next poll happens to succeed (parseItem only filters on ingest, and
    // an unreachable feed source means no next poll for a long time).
    const now = Date.now()
    const items = this.cache.announcements
      .filter(item => item.expiresAt === undefined || item.expiresAt > now)
      .map(item => ({ ...item, acked: acked.has(item.id) }))
    return {
      items,
      unread: items.filter(item => !item.acked).length,
      fetchedAt: this.cache.at,
      source: this.cache.source,
      error: this.error,
      lastError: this.error,
    }
  }
}
