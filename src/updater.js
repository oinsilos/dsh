/**
 * In-app plugin upgrade machinery, sourced from the npm registry.
 *
 * A check reads the package's `latest` dist-tag, and an apply downloads that
 * version's tarball, verifies the registry's `dist.integrity` (sha512), unpacks
 * it, then swaps it over the installed copy. The transaction is otherwise the
 * same as it always was:
 *
 * - the tarball lands in a staging directory under the plugin's data dir and is
 *   integrity-checked before anything on the installed copy is touched;
 * - the running process keeps executing from its in-memory module graph, so
 *   replacing files on disk cannot disturb a live request;
 * - the installed package is backed up first, a failed verification restores
 *   it, and a failed reload also restores the disk from that same backup;
 * - replacements are written as `<file>.ofm-new` beside their target and
 *   renamed over it, so a crash mid-swap cannot truncate a file that the next
 *   boot will import (transient Windows EPERM from indexers is retried).
 *
 * Trust: npm's registry publishes a sha512 `dist.integrity` per version, so the
 * downloaded bytes are authenticated by the same account that published them —
 * there is no separate signing key to keep, rotate, or leak.
 *
 * The EAC profile gate forbids symlinks and junctions under the profile; this
 * module only ever copies plain files inside the plugin's own directory and
 * data dir, which keeps the gate's answer unchanged.
 *
 * @module src/updater.js
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'

/** The npm package this plugin updates itself from. */
export const PACKAGE_NAME = '@oinsilos/dsh-model-manager'

/** Registry base URL; a mirror or a test host is substituted here. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

const MAX_METADATA_BYTES = 256 * 1024
const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_FILES = 240
// The shipped package carries ~108 runtime files (src/, channels/, adapters,
// vendor pack). The cap is a sanity bound, not a package budget; 240 leaves
// room for growth without letting a bad tarball unpack without bound.
const MAX_TOTAL_EXTRACT_BYTES = 64 * 1024 * 1024
const SHA_RE = /^[0-9a-f]{64}$/
// Hot reload evaluates a fresh updater module before the old request finishes.
// A process-wide lock keeps the successor from starting a second transaction.
const UPGRADE_LOCKS = Symbol.for('our-free-model.upgrade-locks')
const upgradeLocks = globalThis[UPGRADE_LOCKS] ??= new Set()

/** Parse `1.2.3` / `1.2.3-rc.4` into a comparable tuple; `null` when malformed. */
export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([\w.]+))?$/.exec(String(value ?? '').trim())
  if (match === null) return null
  const pre = match[4] === undefined ? null : match[4].split('.')
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), pre }
}

/** -1 | 0 | 1 in semver precedence; a pre-release sorts before its release. */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return a === b ? 0 : a > b ? 1 : -1
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1
  }
  if (left.pre === null && right.pre === null) return 0
  if (left.pre === null) return 1
  if (right.pre === null) return -1
  const width = Math.max(left.pre.length, right.pre.length)
  for (let i = 0; i < width; i += 1) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn && Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1
    if (xn !== yn) return xn ? -1 : 1
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

/** `https://registry.npmjs.org/@scope%2Fname/latest` — the slash is the only escaped part. */
export function metadataUrlOf(registry, packageName) {
  const base = registry.endsWith('/') ? registry : `${registry}/`
  return new URL(`${packageName.replace('/', '%2F')}/latest`, base).href
}

/**
 * Validate a registry `latest` document.
 * @param {unknown} payload
 * @param {string} [expectedName]
 * @returns {{version: string, tarball: string, integrity: string, notes: string, publishedAt: number}}
 * @throws {Error} with a reason the settings page can show
 */
export function parseRegistryRelease(payload, expectedName) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('registry metadata must be a JSON object')
  }
  if (expectedName !== undefined && typeof payload.name === 'string' && payload.name !== expectedName) {
    throw new Error(`registry metadata is for ${payload.name}, not ${expectedName}`)
  }
  const version = typeof payload.version === 'string' ? payload.version.trim() : ''
  if (parseVersion(version) === null) throw new Error(`registry version "${version}" is not a valid semver`)
  const dist = payload.dist
  if (dist === null || typeof dist !== 'object') throw new Error('registry metadata carries no dist block')
  const tarball = typeof dist.tarball === 'string' ? dist.tarball : ''
  if (!/^https:\/\/[^\s]+\.tgz$/i.test(tarball)) throw new Error('registry dist.tarball is not an https .tgz URL')
  const integrity = typeof dist.integrity === 'string' ? dist.integrity.trim() : ''
  if (integrity === '') throw new Error('registry dist.integrity is missing')
  return {
    version,
    tarball,
    integrity,
    notes: typeof payload.description === 'string' ? payload.description : '',
    // `latest` carries no per-version timestamp; the full packument does, and
    // fetching it just for a date would double every check's payload.
    publishedAt: 0,
  }
}

/**
 * Fetch the `latest` dist-tag for one package.
 * @returns {Promise<object>} the release view {@link parseRegistryRelease} builds
 */
export async function fetchLatestRelease({ registry = DEFAULT_REGISTRY, packageName = PACKAGE_NAME, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const url = metadataUrlOf(registry, packageName)
  const signal = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
  const response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal })
  if (!response.ok) throw new Error(`${packageName}: registry answered HTTP ${response.status}`)
  const text = await response.text()
  if (text.length > MAX_METADATA_BYTES) throw new Error(`${packageName}: registry metadata too large`)
  return parseRegistryRelease(JSON.parse(text), packageName)
}

/**
 * Verify a downloaded tarball against npm's `dist.integrity`.
 *
 * The field is a space-separated list like `sha512-<base64>`; one match is
 * enough, and an algorithm this build cannot compute is skipped rather than
 * silently accepted.
 */
export function verifyIntegrity(bytes, integrity) {
  for (const token of String(integrity ?? '').trim().split(/\s+/)) {
    const dash = token.indexOf('-')
    if (dash <= 0) continue
    const algorithm = token.slice(0, dash)
    if (!/^sha(256|384|512)$/.test(algorithm)) continue
    const expected = token.slice(dash + 1)
    const actual = crypto.createHash(algorithm).update(bytes).digest('base64')
    if (actual === expected) return true
  }
  return false
}

/** Read a NUL-terminated field out of a tar header block. */
function tarString(block, start, length) {
  const raw = block.toString('latin1', start, start + length)
  const end = raw.indexOf('\0')
  return end < 0 ? raw : raw.slice(0, end)
}

/** Read an octal numeric field out of a tar header block. */
function tarOctal(block, start, length) {
  const raw = tarString(block, start, length).trim()
  return raw === '' ? 0 : Number.parseInt(raw, 8) || 0
}

/** Reject any tar member name that could escape the staging directory. */
function safeMemberPath(relative) {
  const normalized = relative.replace(/\\/g, '/')
  if (normalized === '' || normalized.startsWith('/') || normalized.includes('../')
    || normalized.endsWith('..') || /[A-Za-z]:/.test(normalized)
    || normalized.split('/').some(part => part === '' || part === '.' || part === '..')) return undefined
  return normalized
}

/**
 * Unpack an npm tarball (gzip + ustar) into `destDir`, stripping the leading
 * `package/` directory npm adds.
 *
 * Hand-written on purpose: the package ships no dependencies, and a tar reader
 * for the single shape npm publishes is a few dozen lines. Only regular files
 * and directories are written — links, devices and pax sidecars are skipped,
 * so a hostile archive cannot plant a symlink that the swap then writes through.
 *
 * @param {Buffer} archive - the .tgz bytes
 * @param {string} destDir
 * @returns {Array<{path: string, size: number, sha256: string}>} extracted files
 */
export function extractTarball(archive, destDir) {
  const bytes = zlib.gunzipSync(archive)
  const files = []
  let total = 0
  let offset = 0
  let longName = ''
  const root = 'package/'

  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const type = String.fromCharCode(header[156] === 0 ? 48 : header[156])
    const size = tarOctal(header, 124, 12)
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > bytes.length) throw new Error('tarball is truncated')
    const data = bytes.subarray(dataStart, dataEnd)
    offset = dataStart + Math.ceil(size / 512) * 512

    // GNU long name and pax sidecars describe the next entry; the name they
    // carry is honoured, their payload is not written.
    if (type === 'L') { longName = tarString(data, 0, data.length); continue }
    if (type === 'x' || type === 'g') continue

    const prefix = tarString(header, 345, 155)
    const name = longName !== '' ? longName : (prefix === '' ? tarString(header, 0, 100) : `${prefix}/${tarString(header, 0, 100)}`)
    longName = ''

    if (type === '5') continue
    if (type !== '0' && type !== '\0' && type !== '7') continue
    if (!name.startsWith(root)) throw new Error(`tarball member "${name}" is outside package/`)
    const relative = safeMemberPath(name.slice(root.length))
    if (relative === undefined) throw new Error(`tarball member "${name}" is not a safe path`)
    if (relative === '') continue

    if (files.length >= MAX_FILES) throw new Error(`tarball carries more than ${MAX_FILES} files`)
    if (size > MAX_FILE_BYTES) throw new Error(`tarball member "${relative}" is above the ${MAX_FILE_BYTES} per-file cap`)
    total += size
    if (total > MAX_TOTAL_EXTRACT_BYTES) throw new Error('tarball unpacks beyond the size cap')

    const target = path.join(destDir, ...relative.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, data)
    files.push({ path: relative, size, sha256: crypto.createHash('sha256').update(data).digest('hex') })
  }

  if (!files.some(file => file.path === 'package.json')) throw new Error('tarball carries no package.json')
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

const STAGE_ATTEMPTS = 3
const STAGE_BACKOFF_MS = 700

/** A CN egress to the CDN drops connections regularly; transport failures
 * retry with a short backoff, while an integrity mismatch never does — a wrong
 * body is the trust check refusing, not a bad hair day. */
function isTransientDownloadError(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return true
  return /fetch failed|network|ECONN|ETIMEDOUT|EAI_AGAIN|terminated|socket/i.test(String(error?.message ?? error))
}

/**
 * Download, integrity-check and unpack one release into `stageDir`.
 * @returns {Promise<{bytes: number, files: Array<object>}>}
 */
export async function stageRelease({ release, stageDir, fetchImpl = fetch, onProgress = () => {}, timeoutMs = 60000 }) {
  fs.rmSync(stageDir, { recursive: true, force: true })
  fs.mkdirSync(stageDir, { recursive: true })
  let lastError
  for (let attempt = 1; attempt <= STAGE_ATTEMPTS; attempt += 1) {
    try {
      onProgress({ phase: 'download' })
      const signal = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
      const response = await fetchImpl(release.tarball, { signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const body = Buffer.from(await response.arrayBuffer())
      if (!verifyIntegrity(body, release.integrity)) throw new Error('tarball integrity mismatch')
      onProgress({ phase: 'extract' })
      const files = extractTarball(body, stageDir)
      return { bytes: body.length, files }
    } catch (error) {
      lastError = error
      const httpStatus = /^HTTP (\d{3})$/.exec(String(error?.message ?? ''))?.[1]
      // An integrity mismatch is final: retrying could only fetch another body.
      const retryable = error?.message === 'tarball integrity mismatch'
        ? false
        : httpStatus ? httpStatus === '429' || httpStatus.startsWith('5') : isTransientDownloadError(error)
      if (attempt >= STAGE_ATTEMPTS || !retryable) break
      await new Promise(resolve => setTimeout(resolve, STAGE_BACKOFF_MS * attempt))
    }
  }
  fs.rmSync(stageDir, { recursive: true, force: true })
  throw new Error(`staging failed: ${lastError?.message ?? lastError}`)
}

/** The staged copy is checked against the expected release before install touches anything. */
export function verifyStaged(stageDir, release, files) {
  for (const file of files) {
    const target = path.join(stageDir, ...file.path.split('/'))
    let stat
    try { stat = fs.statSync(target) } catch { throw new Error(`staged file missing: ${file.path}`) }
    if (stat.size !== file.size) throw new Error(`staged size drift for ${file.path}`)
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(stageDir, 'package.json'), 'utf8'))
  if (pkg.version !== release.version) throw new Error(`staged package.json says ${pkg.version}, registry says ${release.version}`)
}

/** Put a backed-up copy back in place (used when a swap or reload fails). */
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Top-level directories and files that belong to the repository rather than to a
 * release. An installed copy never has them; a git-clone or linked development
 * copy always does, and it is the same directory the upgrader operates on.
 * `catalog` travels with ecosystem packs rather than with a release, and
 * `worker` and vendor development sources ship for self-hosters — a sweep that
 * treats them as "files the new release dropped" would delete the pack's
 * readiness records out from under the harness's bundle validation, or the
 * development copy's own test suite, on the first in-app upgrade.
 */
const REPOSITORY_SCAFFOLDING = ['feed', 'scripts', 'docs', 'promo', 'node_modules', 'catalog', 'worker', 'vendor', 'tests']
// Actual published runtime assets must participate in backup and rollback,
// including when an upgrade crosses the 1.x/2.x boundary. Keep vendor source
// trees protected; package.json is overwritten during installation, so it
// cannot be the sole authority for identifying old runtime files to clean up.
const VENDOR_RUNTIME_FILES = [
  'vendor/channel-pack/pack.js',
  'vendor/channel-pack/qoder-auth-wasm.wasm',
  'vendor/channel-pack/NOTICE.md',
  'vendor/channel-pack/LICENSE',
]

/**
 * Walk a directory into relative file paths, skipping release scratch files and
 * anything that belongs to the repository rather than to the package.
 *
 * The skip matters twice over: the backup must not copy a `.git` directory, and
 * `installStaged` must not delete the development copy's test suite or feed
 * directory as "a file the new release dropped".
 */
export function listPackageFiles(dir) {
  const out = []
  const visit = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.endsWith('.ofm-new') || entry.name.endsWith('.ofm-old')) continue
      if (rel === '' && (entry.name.startsWith('.') || REPOSITORY_SCAFFOLDING.includes(entry.name))) continue
      const child = path.join(current, entry.name)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) visit(child, childRel)
      else if (entry.isFile()) out.push(childRel)
    }
  }
  if (fs.existsSync(dir)) visit(dir, '')
  for (const rel of VENDOR_RUNTIME_FILES) {
    const target = path.join(dir, ...rel.split('/'))
    if (fs.existsSync(target) && fs.lstatSync(target).isFile()) out.push(rel)
  }
  return out
}

/**
 * Copy the current package aside so a failed swap can be undone.
 * @returns {number} files backed up
 */
export function backupPackage(pkgDir, backupDir) {
  const snapshot = packageSnapshot(pkgDir)
  const pending = `${backupDir}.pending-${crypto.randomUUID()}`
  const previous = `${backupDir}.previous-${crypto.randomUUID()}`
  let movedPrevious = false
  try {
    fs.mkdirSync(pending, { recursive: true })
    for (const file of snapshot.files) {
      const target = path.join(pending, ...file.path.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(pkgDir, ...file.path.split('/')), target)
    }
    verifySnapshot(pending, snapshot)
    // Detect edits during backup too: the copy must describe the preimage
    // that is actually about to be replaced.
    verifySnapshot(pkgDir, snapshot)
    fs.writeFileSync(path.join(pending, '.ofm-backup.json'), JSON.stringify(snapshot))
    if (fs.existsSync(backupDir)) {
      fs.renameSync(backupDir, previous)
      movedPrevious = true
    }
    try {
      fs.renameSync(pending, backupDir)
    } catch (error) {
      if (movedPrevious) fs.renameSync(previous, backupDir)
      throw error
    }
    // Failure to clean an older copy does not invalidate the new verified copy.
    if (movedPrevious) {
      try { fs.rmSync(previous, { recursive: true, force: true }) } catch { /* retain it */ }
    }
    return snapshot.files.length
  } finally {
    try { fs.rmSync(pending, { recursive: true, force: true }) } catch { /* retain it */ }
  }
}

function packageSnapshot(dir) {
  const files = listPackageFiles(dir).sort().map(rel => {
    const file = path.join(dir, ...rel.split('/'))
    return { path: rel, size: fs.statSync(file).size, sha256: sha256File(file) }
  })
  if (!files.some(file => file.path === 'package.json') || !files.some(file => file.path === 'index.js')) {
    throw new Error(`no complete rollback copy in ${dir} — package.json and index.js are required`)
  }
  return { files }
}

function verifySnapshot(dir, snapshot) {
  const paths = listPackageFiles(dir).sort()
  if (paths.join('\n') !== snapshot.files.map(file => file.path).sort().join('\n')) {
    throw new Error('rollback file set mismatch')
  }
  for (const file of snapshot.files) {
    const target = path.join(dir, ...file.path.split('/'))
    if (fs.statSync(target).size !== file.size || sha256File(target) !== file.sha256) {
      throw new Error(`rollback hash drift for ${file.path}`)
    }
  }
}

function backupSnapshot(backupDir) {
  if (listPackageFiles(backupDir).length === 0) {
    throw new Error(`no rollback copy in ${backupDir} — leaving the installed package untouched`)
  }
  const metadata = path.join(backupDir, '.ofm-backup.json')
  // Older releases did not leave a receipt. Keep their complete backups usable.
  if (!fs.existsSync(metadata)) return packageSnapshot(backupDir)
  const snapshot = JSON.parse(fs.readFileSync(metadata, 'utf8'))
  if (!Array.isArray(snapshot?.files) || snapshot.files.length === 0
    || snapshot.files.some(file => file === null || typeof file !== 'object')
    || !snapshot.files.some(file => file.path === 'package.json')
    || !snapshot.files.some(file => file.path === 'index.js')
    || snapshot.files.some(file => typeof file.path !== 'string' || file.path.startsWith('/')
      || file.path.includes('\\') || file.path.split('/').some(part => part === '' || part === '.' || part === '..')
      || /:/.test(file.path) || !SHA_RE.test(file.sha256) || !Number.isInteger(file.size) || file.size < 0)
    || new Set(snapshot.files.map(file => file.path)).size !== snapshot.files.length) {
    throw new Error('invalid rollback receipt')
  }
  verifySnapshot(backupDir, snapshot)
  return snapshot
}

/** Put a backed-up copy back in place (used when a swap or reload fails). */
export function restoreBackup(backupDir, pkgDir) {
  // Never let a missing rollback copy turn into a wipe: listPackageFiles
  // answers [] for a directory that does not exist, and an install that has
  // never applied an update has no rollback copy at all — walking into the
  // delete loop with nothing to put back would empty the package (index.js,
  // client.js, src/*) while the running process keeps going from memory.
  const snapshot = backupSnapshot(backupDir)
  const backup = snapshot.files.map(file => file.path)
  const failures = []
  for (const rel of backup) {
    // Copy loop must survive a locked file: attempting every entry keeps the
    // restore as complete as this machine allows instead of crashing halfway.
    try {
      const target = path.join(pkgDir, ...rel.split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.copyFileSync(path.join(backupDir, ...rel.split('/')), target)
    } catch (error) { failures.push(`${rel} (${error?.message ?? error})`) }
  }
  // Restore first. Deleting every installed file before copying made a denied
  // copy destroy files that could otherwise still have been used for recovery.
  try {
    for (const rel of listPackageFiles(pkgDir)) {
      if (backup.includes(rel)) continue
      try { fs.rmSync(path.join(pkgDir, ...rel.split('/')), { force: true }) }
      catch (error) { failures.push(`${rel} (${error?.message ?? error})`) }
    }
    verifySnapshot(pkgDir, snapshot)
  } catch (error) { failures.push(String(error?.message ?? error)) }
  if (failures.length > 0) throw new Error(`rollback incomplete: ${failures.slice(0, 3).join('; ')}${failures.length > 3 ? ` +${failures.length - 3} more` : ''}`)
}

/** Windows can transiently refuse a rename while a file is scanned; retry briefly. */
async function renameWithRetry(from, to) {
  let delay = 60
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      if (attempt >= 4 || !['EPERM', 'EACCES', 'ENOENT'].includes(error?.code)) throw error
      await new Promise(resolve => setTimeout(resolve, delay))
      delay *= 4
    }
  }
}

/**
 * Move a verified staging directory into the installed package location.
 * Every file goes through a same-directory `<name>.ofm-new` so the final
 * hop is a same-volume rename; the running module graph is unaffected.
 */
export async function installStaged(stageDir, pkgDir, files) {
  for (const rel of files) {
    const parts = rel.split('/')
    const source = path.join(stageDir, ...parts)
    const target = path.join(pkgDir, ...parts)
    const pending = `${target}.ofm-new`
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.copyFileSync(source, pending)
    await renameWithRetry(pending, target)
  }
  // A file the new release dropped must not linger from the old one.
  for (const rel of listPackageFiles(pkgDir)) {
    if (files.includes(rel)) continue
    fs.rmSync(path.join(pkgDir, ...rel.split('/')), { force: true })
  }
}

/** Read back everything that was just written; one drifted byte aborts the swap. */
export function verifyInstalled(pkgDir, files) {
  for (const file of files) {
    const target = path.join(pkgDir, ...file.path.split('/'))
    if (!fs.existsSync(target)) throw new Error(`installed file missing: ${file.path}`)
    if (sha256File(target) !== file.sha256) throw new Error(`installed hash drift for ${file.path}`)
  }
}

/**
 * The upgrade lifecycle. The optional activate callback lets the Host include
 * hot reload in the transaction; standalone release audits only install files.
 */
export class PluginUpdater {
  /**
   * @param {object} deps
   * @param {string} deps.pkgDir - installed package directory
   * @param {string} deps.dataDir - plugin data dir (staging, backup, history)
   * @param {() => {updateCheckHours?: number}} deps.settings
   * @param {(message: string) => void} [deps.log]
   * @param {typeof fetch} [deps.fetchImpl]
   * @param {string} [deps.registry] - registry base URL; tests substitute a local one
   * @param {string} [deps.packageName] - package to update from
   * @param {string} [deps.runningVersion] - version captured by the running module
   */
  constructor({ pkgDir, dataDir, settings, log = () => {}, fetchImpl = fetch, registry = DEFAULT_REGISTRY, packageName = PACKAGE_NAME, runningVersion }) {
    this.deps = { pkgDir, dataDir, settings, log, fetchImpl, registry, packageName, runningVersion }
    this.latest = undefined
    this.checkedAt = 0
    this.error = ''
    this.applying = false
    this.history = this.loadHistory()
  }

  get stageDir() { return path.join(this.deps.dataDir, 'upgrade-stage') }
  get backupDir() { return path.join(this.deps.dataDir, 'rollback') }
  get stateFile() { return path.join(this.deps.dataDir, 'upgrade-state.json') }

  loadUpgradeState() {
    try {
      const state = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      if (state === null || !['installing', 'activating', 'recovery-required', 'rolled-back', 'complete'].includes(state.phase)) {
        throw new Error('invalid transaction phase')
      }
      return state
    }
    catch (error) {
      if (error?.code === 'ENOENT') return undefined
      return { phase: 'recovery-required', error: `could not read upgrade state (${error?.message ?? error})` }
    }
  }

  saveUpgradeState(state) {
    fs.mkdirSync(this.deps.dataDir, { recursive: true })
    const pending = `${this.stateFile}.tmp`
    fs.writeFileSync(pending, JSON.stringify(state), { mode: 0o600 })
    fs.renameSync(pending, this.stateFile)
  }

  reconcileRecovery() {
    const state = this.loadUpgradeState()
    if (upgradeLocks.has(this.deps.pkgDir) || !['installing', 'activating', 'recovery-required'].includes(state?.phase)) return
    try {
      verifySnapshot(this.deps.pkgDir, backupSnapshot(this.backupDir))
      if ((this.deps.runningVersion ?? this.currentVersion()) !== state.from) return
      this.saveUpgradeState({ ...state, phase: 'rolled-back', error: '', diskRestored: true, runtimeRestored: true })
    } catch { /* keep the blocker until both the bytes and runtime match */ }
  }

  currentVersion() {
    try {
      return String(JSON.parse(fs.readFileSync(path.join(this.deps.pkgDir, 'package.json'), 'utf8')).version ?? '')
    } catch {
      return ''
    }
  }

  loadHistory() {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(this.deps.dataDir, 'updates.json'), 'utf8'))
      return Array.isArray(parsed?.applied) ? parsed.applied : []
    } catch {
      return []
    }
  }

  recordHistory(entry) {
    // A hot reload creates a successor before the caller finishes. Merge with
    // durable history, and let both instances read the final outcome.
    this.history = [...this.loadHistory(), entry].slice(-20)
    try {
      fs.mkdirSync(this.deps.dataDir, { recursive: true })
      fs.writeFileSync(path.join(this.deps.dataDir, 'updates.json'), JSON.stringify({ applied: this.history }, undefined, 2))
    } catch (error) {
      this.deps.log?.(`our-free-model: could not write update history (${error?.message ?? error})`)
    }
  }

  status() {
    const installedVersion = this.currentVersion()
    const current = this.deps.runningVersion ?? installedVersion
    const state = this.loadUpgradeState()
    const active = upgradeLocks.has(this.deps.pkgDir)
    const unfinished = ['installing', 'activating'].includes(state?.phase)
    const recoveryRequired = state?.phase === 'recovery-required' || (unfinished && !active)
    const available = this.latest !== undefined && compareVersions(this.latest.version, current) > 0
    this.history = this.loadHistory()
    return {
      current,
      runningVersion: current,
      installedVersion,
      versionMismatch: current !== installedVersion,
      recoveryRequired,
      phase: state?.phase ?? 'idle',
      latest: this.latest?.version ?? '',
      available,
      notes: this.latest?.notes ?? '',
      publishedAt: this.latest?.publishedAt ?? 0,
      checkedAt: this.checkedAt,
      applying: active,
      error: state?.error || this.error,
      recoveryBackup: recoveryRequired ? this.backupDir : undefined,
      lastApplied: this.history[this.history.length - 1] ?? undefined,
    }
  }

  /** True when this copy is a git checkout rather than an npm install. */
  isDevelopmentCheckout() {
    try {
      return fs.existsSync(path.join(this.deps.pkgDir, '.git'))
    } catch {
      return false
    }
  }

  /**
   * Fetch and evaluate the latest published version.
   * @returns {Promise<{available: boolean, current: string, latest: string}>}
   */
  async check() {
    try {
      this.reconcileRecovery()
      const release = await fetchLatestRelease({
        registry: this.deps.registry,
        packageName: this.deps.packageName,
        fetchImpl: this.deps.fetchImpl,
      })
      const current = this.deps.runningVersion ?? this.currentVersion()
      this.latest = release
      this.checkedAt = Date.now()
      this.error = ''
      this.deps.log?.(`our-free-model: update check via npm -> ${release.version} (installed ${current})`)
      return { available: compareVersions(release.version, current) > 0, current, latest: release.version }
    } catch (error) {
      this.error = String(error?.message ?? error)
      throw error
    }
  }

  /**
   * Download, verify and install one published version. Idempotent for the
   * same version.
   * @param {{version?: string, onProgress?: (progress: object) => void, activate?: (result: object) => Promise<object>}} [options]
   * @returns {Promise<{version: string, files: number, bytes: number, previous: string}>}
   */
  async apply({ version, onProgress = () => {}, activate } = {}) {
    if (upgradeLocks.has(this.deps.pkgDir)) throw new Error('an upgrade is already running')
    // A git checkout is not a release: swapping a tarball over it would delete
    // the working tree's own files (tests, docs) that no npm package carries.
    if (this.isDevelopmentCheckout()) {
      throw new Error('this copy is a development checkout (.git); update it with git or npm, not the in-app updater')
    }
    this.reconcileRecovery()
    const priorState = this.loadUpgradeState()
    if (['installing', 'activating', 'recovery-required'].includes(priorState?.phase)) {
      throw new Error(`previous upgrade requires recovery; restore the verified backup in ${this.backupDir} and restart before upgrading again`)
    }
    this.applying = true
    upgradeLocks.add(this.deps.pkgDir)
    const previous = this.currentVersion()
    let targetVersion = version ?? ''
    let state
    let installed = false
    let activated = false
    try {
      // Re-check immediately before installing: the publisher may have pushed a
      // new version since the last check, and a stale cached release would
      // verify downloads against a tarball the registry no longer serves.
      await this.check()
      const release = this.latest
      if (release === undefined) throw new Error('no release available')
      targetVersion = release.version
      if (version !== undefined && release.version !== version) throw new Error(`registry offers ${release.version}, not ${version}`)
      if (compareVersions(release.version, previous) < 0) throw new Error(`installed ${previous} is newer than ${release.version}`)

      const staged = await stageRelease({
        release, stageDir: this.stageDir, fetchImpl: this.deps.fetchImpl, onProgress,
      })
      verifyStaged(this.stageDir, release, staged.files)

      onProgress({ phase: 'install' })
      const backedUp = backupPackage(this.deps.pkgDir, this.backupDir)
      state = { from: previous, to: release.version, at: Date.now(), phase: 'installing' }
      // Persist the intent before the first installed byte changes.
      this.saveUpgradeState(state)
      const result = { version: release.version, previous, files: staged.files.length, bytes: staged.bytes }
      try {
        installed = true
        await installStaged(this.stageDir, this.deps.pkgDir, staged.files.map(file => file.path))
        verifyInstalled(this.deps.pkgDir, staged.files)
        if (activate !== undefined) {
          state = { ...state, phase: 'activating' }
          this.saveUpgradeState(state)
          onProgress({ phase: 'reload' })
          const activation = await activate(result)
          if (activation?.ok !== true) {
            throw Object.assign(new Error(activation?.error ?? 'hot reload did not confirm activation'), { runtimeRestored: activation?.restored === true })
          }
          if (activation.version !== release.version) {
            throw new Error(`activation version mismatch: expected ${release.version}, got ${String(activation.version ?? '(missing)')}`)
          }
          activated = true
        }
      } catch (error) {
        // The installed copy is now in an unknown state: put the old one back
        // before surfacing the failure, so the next boot still works. A failed
        // restore must not mask the install failure that caused it, and the
        // "previous version restored" claim is only true when it succeeded.
        let restoreError = null
        try { restoreBackup(this.backupDir, this.deps.pkgDir) } catch (rollbackError) { restoreError = rollbackError }
        state = {
          ...state,
          phase: restoreError !== null || (state.phase === 'activating' && error.runtimeRestored !== true) ? 'recovery-required' : 'rolled-back',
          diskRestored: restoreError === null,
          runtimeRestored: state.phase !== 'activating' || error.runtimeRestored === true,
        }
        if (restoreError !== null) {
          throw new Error(`upgrade failed (${error?.message ?? error}); rollback also failed (${restoreError?.message ?? restoreError})`)
        }
        throw new Error(`upgrade failed, previous files restored (${error?.message ?? error})`)
      }
      this.saveUpgradeState({ ...state, phase: 'complete', activated })
      try { fs.rmSync(this.stageDir, { recursive: true, force: true }) } catch (error) { this.deps.log?.(`our-free-model: staging cleanup failed (${error?.message ?? error})`) }
      const record = { from: previous, to: release.version, at: Date.now(), ok: true, files: staged.files.length, bytes: staged.bytes, backedUp, activated }
      this.recordHistory(record)
      this.checkedAt = Date.now()
      this.deps.log?.(`our-free-model: upgraded ${previous} -> ${release.version} (${staged.files.length} files)`)
      return result
    } catch (error) {
      this.error = String(error?.message ?? error)
      if (state !== undefined && installed) {
        try {
          this.saveUpgradeState({ ...state, phase: activated ? 'complete' : state.phase, error: this.error, activated })
        } catch (stateError) {
          this.error += `; could not persist upgrade outcome (${stateError?.message ?? stateError})`
        }
      }
      const record = { from: previous, to: targetVersion, at: Date.now(), ok: false, error: this.error }
      this.recordHistory(record)
      throw new Error(this.error)
    } finally {
      this.applying = false
      upgradeLocks.delete(this.deps.pkgDir)
    }
  }
}