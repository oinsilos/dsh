/**
 * Forward pool: one exposed model name that is really a self-ordering candidate
 * set behind the loopback gateway.
 *
 * The pain this exists for is operational, not theoretical. Other harnesses that
 * dial this plugin's gateway see every lane we serve — a hundred-odd rows — and
 * the user has to remember which one is healthy *today*, edit a config, restart
 * the client, and try again when that one hits a quota wall. A pool collapses
 * that to a single name: the client keeps `model: "auto"` forever, and the three
 * things that used to be manual happen inside one request:
 *
 * 1. **pick the best candidate first** — a request-time score built from the
 *    day's recorded success rate and first-token latency, so a stable lane is
 *    tried before a shaky one;
 * 2. **retry where a retry helps** — a transient wobble (timeout / transport /
 *    5xx / empty reply) is retried on the *same* member before moving on;
 * 3. **fail over where a retry cannot help** — a quota wall, a region refusal,
 *    a dead credential moves straight to the next member.
 *
 * That split is the whole point of `retryable`/`scope` in `route/classify.js`,
 * and reusing it (rather than inventing a "max retries per member") is what
 * keeps a 429 from turning into three billed walls — the issue #13 lesson.
 *
 * The pool is a *virtual catalog row* (`channel: 'pool'`), exactly like a combo:
 * the gateway dials it by name, `runStream` resolves it to `runChain`, and the
 * commit rule (buffer until the first answer-bearing delta, then the answer is
 * the caller's) comes for free. The only pool-specific work is *ordering* the
 * candidates and *classifying* a failure into retry-or-advance.
 *
 * @module src/forward-pool.js
 */

import { FAILURE_SCOPE } from './route/classify.js'

export const POOL_CHANNEL = 'pool'
export const POOL_PREFIX = 'pool:'

/**
 * Default entry name. Deliberately a short, unqualified id: a client config
 * reads `"model": "auto"`, which is what every failover router on the market
 * uses and what a human can type without looking it up.
 */
export const DEFAULT_POOL_NAME = 'auto'

/**
 * Strategies, and what each means for the *first* candidate:
 *
 * - `smart` (default) — request-time score (see `rankCandidates`), so the
 *   fastest+healthiest member answers first and the order self-corrects as the
 *   day's stats come in;
 * - `fallback` — the user's declared order, verbatim. Predictable, and the
 *   right choice when the list is a quality ladder;
 * - `round-robin` — rotate the starting point each request so no single member
 *   eats all the load.
 */
export const POOL_STRATEGIES = ['smart', 'fallback', 'round-robin']

/** Rotation cursors, keyed by pool id. In-memory on purpose: a restart losing
 *  the cursor costs nothing but a different starting point. */
const rotation = new Map()

export function isPoolEntry(entry) {
  return entry?.channel === POOL_CHANNEL && Array.isArray(entry.pool)
}

/** `My Auto Chain` -> `pool:my-auto-chain`. */
export function poolId(name) {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug === '' ? '' : `${POOL_PREFIX}${slug}`
}

/**
 * Coerce the stored settings value into a well-formed pool config.
 *
 * The pool is optional and single, so this returns one normalized object rather
 * than a list. Every field is treated as untrusted: a non-array `members`
 * becomes empty, an unknown strategy falls back to `smart`, and a blank name
 * falls back to `auto`.
 */
export function normalizePool(raw) {
  const row = raw !== null && typeof raw === 'object' ? raw : {}
  const members = [...new Set((Array.isArray(row.members) ? row.members : [])
    .map(value => String(value ?? '').trim())
    .filter(value => value !== ''))]
  const name = String(row.name ?? '').trim() || DEFAULT_POOL_NAME
  // A member can never be the pool itself, or a chain that names it would
  // recurse forever.
  const id = poolId(name)
  return {
    enabled: row.enabled === true,
    name,
    id,
    members: members.filter(member => member !== id),
    strategy: POOL_STRATEGIES.includes(row.strategy) ? row.strategy : 'smart',
    stickyLimit: positiveInt(row.stickyLimit, 1),
    /** Retry a *retryable* failure this many times on the same member before
     *  moving on. 0 = move on immediately. Advance-worthy failures ignore it. */
    memberRetries: positiveInt(row.memberRetries, 0, true),
    /** When on, the gateway's `/v1/models` lists only this pool entry, so a
     *  client sees exactly one dialable name. */
    hideOthers: row.hideOthers !== false,
  }
}

function positiveInt(value, fallback, allowZero = false) {
  const number = Number(value)
  if (!Number.isFinite(number) || number < 0) return fallback
  const whole = Math.trunc(number)
  if (whole === 0 && allowZero === false) return fallback
  return whole
}

/**
 * Build the one virtual catalog row for the pool, or `null` when it cannot
 * serve anything.
 *
 * Members that are not in the catalog *right now* are dropped rather than kept
 * as a hopeful entry — same rule as combos: a chain that reports "tried 3" for
 * a turn that only ever had one is a worse lie than an honest no-op.
 *
 * Capacities are the intersection, not the union: a pool that advertises vision
 * because its first member reads images would hand a text-only fallback an
 * image it cannot parse, and a 1M window advertised by the head would overrun a
 * 128K tail. The honest numbers are the ones every member honours.
 *
 * @param {object} pool - from `normalizePool`
 * @param {Array<object>} catalog - every real catalog entry
 */
export function buildPoolRow(pool, catalog) {
  if (pool.enabled !== true) return null
  const byId = new Map()
  for (const entry of catalog) if (!isPoolEntry(entry)) byId.set(entry.id, entry)
  const members = pool.members.map(id => byId.get(id)).filter(entry => entry !== undefined)
  if (members.length === 0) return null
  const windows = members.map(entry => contextWindow(entry)).filter(value => value !== undefined)
  const outputs = members.map(entry => maxOutput(entry)).filter(value => value !== undefined)
  return {
    id: pool.id,
    name: pool.name,
    channel: POOL_CHANNEL,
    pool: members.map(entry => entry.id),
    strategy: pool.strategy,
    stickyLimit: pool.stickyLimit,
    memberRetries: pool.memberRetries,
    hideOthers: pool.hideOthers === true,
    vision: members.every(entry => entry.vision === true),
    reasoning: members.some(entry => entry.reasoning === true),
    contextWindow: windows.length === 0 ? 131072 : Math.min(...windows),
    maxOutput: outputs.length === 0 ? 32768 : Math.min(...outputs),
    canDisableThinking: members.every(entry => entry.canDisableThinking !== false),
    regionSensitive: false,
    wire: 'chat',
    lanes: [...new Set(members.map(entry => entry.channel ?? 'free'))],
  }
}

function contextWindow(entry) {
  const value = Number(entry?.contextWindow)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

function maxOutput(entry) {
  const value = Number(entry?.maxOutput)
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined
}

/**
 * Order a pool's members for one request.
 *
 * `smart` scores each candidate from the day's turn stats:
 *
 *   score = successRate * 1000 - min(avgTtftMs, 30000) / 30
 *
 * A healthy, fast lane beats a healthy, slow one; a lane that has failed today
 * sinks below one that has not. A candidate with no samples today scores as a
 * neutral 0.5 (better than a proven-failing lane, worse than a proven-good one),
 * so a freshly added member is tried before sitting idle forever, but not ahead
 * of a lane that is working right now.
 *
 * Ties keep the user's declared order (a stable sort), so `smart` degrades to
 * `fallback` when there is nothing to go on — which is exactly what a brand-new
 * install looks like.
 *
 * @param {object} entry - the pool catalog row
 * @param {Array<object>} catalog
 * @param {object} [options]
 * @param {(model: string) => {calls: number, failed: number, ttftMs: number, ttftSamples: number}} [options.statsFor] -
 *   today's per-model call stats (the `days[today].models[id]` bucket); omitted
 *   = pure declared order
 * @param {{peek?: boolean}} [options.walk] - `peek` computes the order without consuming a turn
 */
export function poolChain(entry, catalog, options = {}) {
  const ids = Array.isArray(entry?.pool) ? entry.pool : []
  const byId = new Map()
  for (const row of catalog) byId.set(row.id, row)
  const members = ids.map(id => byId.get(id)).filter(row => row !== undefined)
  if (members.length <= 1) return members
  const strategy = entry.strategy
  if (strategy === 'fallback') return members
  if (strategy === 'round-robin') return rotate(entry, members, options)
  return rankCandidates(entry, members, options.statsFor)
}

/** Round-robin: rotate the starting point, sticky for `stickyLimit` turns. */
function rotate(entry, members, options) {
  const limit = positiveInt(entry.stickyLimit, 1)
  const cursor = rotation.get(entry.id) ?? { index: 0, used: 0 }
  const index = Math.min(Math.max(cursor.index, 0), members.length - 1)
  const ordered = [...members.slice(index), ...members.slice(0, index)]
  if (options.walk?.peek !== true) {
    const used = cursor.used + 1
    rotation.set(entry.id, used >= limit ? { index: (index + 1) % members.length, used: 0 } : { index, used })
  }
  return ordered
}

/** Score and sort, keeping declared order for ties. */
function rankCandidates(entry, members, statsFor) {
  if (typeof statsFor !== 'function') return members
  const scored = members.map((member, index) => ({
    member,
    index,
    score: scoreOf(statsFor(member.id)),
  }))
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index))
  return scored.map(row => row.member)
}

/**
 * One member's request-time score. See `poolChain` for the formula and why an
 * unsampled member sits in the middle rather than at the top or bottom.
 *
 * Input is today's per-model call bucket (`days[day].models[id]`):
 * `{calls, failed, ttftMs, ttftSamples}` where `ttftMs` is a *sum* over
 * `ttftSamples` measured calls — hence the mean below, not the raw total.
 */
function scoreOf(stats) {
  const calls = Number(stats?.calls) || 0
  const failed = Number(stats?.failed) || 0
  if (calls <= 0) return 0.5 * 1000
  const successRate = Math.max(0, Math.min(1, (calls - failed) / calls))
  const samples = Number(stats?.ttftSamples) || 0
  const meanTtft = samples > 0 ? (Number(stats?.ttftMs) || 0) / samples : 0
  const latencyPenalty = Math.min(Math.max(meanTtft, 0), 30000) / 30
  return successRate * 1000 - latencyPenalty
}

/**
 * Decide what to do with one member's failure: retry it in place, or advance to
 * the next member.
 *
 * The single authority is the verdict's `scope` — `route/classify.js` documents
 * it as exactly this: "the router-facing summary of where the fault lives". The
 * `kind` is deliberately *not* consulted here, because kinds straddle scopes and
 * reading them directly reintroduces two bugs:
 *
 * - `UNAVAILABLE` covers both a retryable transport wobble and a permanent 404
 *   ("this account no longer routes the model"); only `scope` tells them apart.
 * - `INVALID_REQUEST` covers both the request-scoped 4xx carve-out and the
 *   account-scoped "improperly formed request" the provider raised against its
 *   own payload; again only `scope` separates them.
 *
 * The mapping:
 *
 * - `request`   → **stop**. The same body reproduces the same refusal on every
 *   member, so the honest answer is the original error, not N copies of it.
 * - `transient` → **retry** while the member's budget lasts, then **advance**. A
 *   timeout / transport / 5xx wobble may clear on the next try, and moving on
 *   early would spend a different lane's quota for nothing.
 * - `account` / `provider` → **advance** immediately. The member itself is the
 *   problem (quota wall, auth, region refusal, dead endpoint); a retry just
 *   reproduces it, which is the billed-thrice bug this split exists to prevent.
 *
 * A remaining-retry budget is passed in and decremented by the caller; this
 * function only says which of the three applies.
 *
 * @param {object} verdict - a `classifyFailure` result
 * @param {number} retriesLeft - how many in-place retries remain for this member
 * @returns {'retry' | 'advance' | 'stop'}
 */
export function decideFailure(verdict, retriesLeft) {
  if (verdict === null || typeof verdict !== 'object') return retriesLeft > 0 ? 'retry' : 'advance'
  switch (verdict.scope) {
    case FAILURE_SCOPE.REQUEST:
      return 'stop'
    case FAILURE_SCOPE.TRANSIENT:
      return retriesLeft > 0 ? 'retry' : 'advance'
    case FAILURE_SCOPE.ACCOUNT:
    case FAILURE_SCOPE.PROVIDER:
      return 'advance'
    default:
      // An unclassified failure has already defaulted to `transient` in
      // classifyFailure; treat any surprise the same way rather than stalling.
      return retriesLeft > 0 ? 'retry' : 'advance'
  }
}

/** Drop rotation cursors for pools that no longer exist. */
export function prunePoolRotation(pool) {
  const live = pool?.id
  for (const key of rotation.keys()) if (key !== live) rotation.delete(key)
}

/** Test seam: the rotation map is process state. */
export function resetPoolRotation() {
  rotation.clear()
}
