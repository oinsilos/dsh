#!/usr/bin/env node
/**
 * Build the signed update manifest a release publishes.
 *
 * The plugin's in-app updater (src/updater.js) accepts only a manifest whose
 * Ed25519 signature verifies against PINNED_MANIFEST_PUBLIC_KEY, and then
 * downloads every file from the URL the manifest's `base` resolves to. So this
 * script does the two things that make that work:
 *
 *   1. enumerate exactly the files a release ships (package.json `files`, plus
 *      package.json itself), hashing each one;
 *   2. sign the manifest with the release private key.
 *
 * Layout it produces, relative to the repository root:
 *
 *   releases/latest/manifest.json      <- the signed document
 *   (every listed file lives at its repo path, since base = '../../')
 *
 * Usage:
 *   node scripts/build-manifest.mjs \
 *     --key D:\path\to\update-manifest.key \
 *     [--out releases/latest/manifest.json] \
 *     [--notes "…"] [--published-at 2026-11-26T00:00:00Z] [--min-supported 2.11.0] \
 *     [--check]
 *
 * Without --key it signs nothing and only prints what a manifest would contain
 * (useful in CI to detect drift). The private key is never read from this repo:
 * a trust root committed beside the code it authenticates authenticates nothing.
 *
 * `--check` exits non-zero when an existing manifest disagrees with the working
 * tree (file set, hashes, or version), which is the guard against publishing a
 * manifest that no longer matches the code beside it.
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import { signManifest, stableStringify, verifyManifestSignature, PINNED_MANIFEST_PUBLIC_KEY, parseManifest } from '../src/updater.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PKG_DIR = path.resolve(HERE, '..')
const DEFAULT_OUT = path.join(PKG_DIR, 'releases', 'latest', 'manifest.json')

const MAX_FILE_BYTES = 4 * 1024 * 1024
const MAX_FILES = 240

function parseArgs(argv) {
  const out = { check: false }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--check') { out.check = true; continue }
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} needs a value`)
      out[key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value
      i += 1
      continue
    }
    throw new Error(`unknown argument ${arg}`)
  }
  return out
}

/** Walk a package directory, skipping everything that is not part of a release. */
function listReleaseFiles(dir) {
  const out = []
  const visit = (current, rel) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.endsWith('.ofm-new') || entry.name.endsWith('.ofm-old')) continue
      if (rel === '' && (entry.name.startsWith('.') || entry.name === 'releases')) continue
      const child = path.join(current, entry.name)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) visit(child, childRel)
      else if (entry.isFile()) out.push(childRel)
    }
  }
  visit(dir, '')
  return out.sort()
}

/**
 * Resolve the release file set from package.json `files`.
 *
 * `files` entries name either a file or a directory; a directory contributes
 * every file beneath it. This mirrors what npm would pack, so the manifest
 * describes the same thing the package.json claims to ship.
 */
function selectFiles(dir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  const wanted = Array.isArray(pkg.files) ? pkg.files : []
  const all = listReleaseFiles(dir)
  const selected = new Set(['package.json'])

  const matches = (rel, entry) => {
    const target = entry.replace(/^\.\//, '').replace(/\/$/, '')
    return rel === target || rel.startsWith(`${target}/`)
  }

  for (const entry of wanted) {
    for (const rel of all) if (matches(rel, entry)) selected.add(rel)
  }

  // A `files` entry that resolves to nothing is almost always a typo. Reporting
  // it beats silently shipping a manifest that omits something package.json
  // promised, so treat it as an error.
  const missing = wanted.filter(entry => {
    const target = entry.replace(/^\.\//, '').replace(/\/$/, '')
    return !all.some(rel => rel === target || rel.startsWith(`${target}/`))
  })
  if (missing.length > 0) throw new Error(`package.json "files" lists paths that do not exist: ${missing.join(', ')}`)

  return { pkg, files: [...selected].sort() }
}

/**
 * The bytes a release actually serves, and their sha256/size.
 *
 * Git normalises text to LF in the repository, and the updater downloads from
 * GitHub, so the manifest must describe LF bytes. A Windows checkout with
 * `core.autocrlf=true` has CRLF on disk, and hashing that would produce a
 * manifest the updater rejects on every machine but this one. Normalise the
 * same way git does before hashing: text files get CRLF→LF; binaries are left
 * untouched (git leaves them alone, and rewriting them would corrupt the PNG).
 */
function releaseBytes(file) {
  const bytes = fs.readFileSync(file)
  if (!isTextFile(file)) return bytes
  // Only convert when the buffer actually contains CRLF.
  if (bytes.indexOf('\r\n') < 0) return bytes
  return Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1')
}

/** Extensions git treats as binary; everything else is normalised to LF. */
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.wasm', '.zip', '.gz', '.tgz'])

function isTextFile(file) {
  return !BINARY_EXT.has(path.extname(file).toLowerCase())
}

function describeFile(file) {
  const bytes = releaseBytes(file)
  return { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}

function buildDocument({ dir, notes, publishedAt, minSupported }) {
  const { pkg, files } = selectFiles(dir)
  if (files.length > MAX_FILES) throw new Error(`release carries ${files.length} files, above the ${MAX_FILES} cap`)

  const entries = []
  for (const rel of files) {
    const abs = path.join(dir, ...rel.split('/'))
    const { sha256, size } = describeFile(abs)
    if (size <= 0) throw new Error(`${rel} is empty`)
    if (size > MAX_FILE_BYTES) throw new Error(`${rel} is ${size} bytes, above the ${MAX_FILE_BYTES} per-file cap`)
    entries.push({ path: rel, sha256, size })
  }

  return {
    version: pkg.version,
    // base is resolved against the manifest URL. The manifest lives at
    // releases/latest/manifest.json, so '../../' resolves to the repo root where
    // every listed file sits at its own path.
    base: '../../',
    publishedAt: publishedAt ?? new Date().toISOString(),
    notes: notes ?? '',
    ...minSupported === undefined ? {} : { minSupported },
    files: entries,
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const document = buildDocument({
    dir: PKG_DIR,
    notes: args.notes,
    publishedAt: args.publishedAt,
    minSupported: args.minSupported,
  })

  if (args.key === undefined) {
    if (args.check) {
      // Content-only check: no key present, so the signature cannot be verified,
      // but the file set and hashes still catch a manifest that drifted from the
      // working tree. Signature verification needs --key.
      const outPath = args.out === undefined ? DEFAULT_OUT : path.resolve(PKG_DIR, args.out)
      let existing
      try {
        existing = JSON.parse(fs.readFileSync(outPath, 'utf8'))
      } catch {
        console.error(`no existing manifest at ${outPath}`)
        process.exit(1)
      }
      const parsed = parseManifest(existing)
      const sameFiles = parsed.files.length === document.files.length && parsed.files.every((row, i) => {
        const mine = document.files[i]
        return row.path === mine.path && row.sha256 === mine.sha256 && row.size === mine.size
      })
      if (parsed.version !== document.version || !sameFiles) {
        console.error(`${outPath} is stale: version ${parsed.version} vs ${document.version}, files ${parsed.files.length} vs ${document.files.length}`)
        process.exit(1)
      }
      console.log(`manifest content up to date: ${parsed.version}, ${parsed.files.length} files (signature NOT verified: no --key)`)
      return
    }
    // Unsigned preview: print the canonical payload and a summary, so CI can
    // diff it without holding the key.
    console.log(`version: ${document.version}`)
    console.log(`files: ${document.files.length}`)
    console.log(`bytes: ${document.files.reduce((sum, row) => sum + row.size, 0)}`)
    console.log('payload sha256:', crypto.createHash('sha256').update(stableStringify((({ signature, ...rest }) => rest)(document))).digest('hex'))
    for (const row of document.files) console.log(`  ${row.sha256.slice(0, 12)}  ${String(row.size).padStart(8)}  ${row.path}`)
    console.log('\n(no --key given: manifest not signed, nothing written)')
    return
  }

  const privateKeyPem = fs.readFileSync(args.key, 'utf8')
  const signed = { ...document, signature: signManifest(document, privateKeyPem) }
  if (!verifyManifestSignature(signed, PINNED_MANIFEST_PUBLIC_KEY)) {
    throw new Error('signature did not verify against PINNED_MANIFEST_PUBLIC_KEY — is --key the matching private key?')
  }

  const outPath = args.out === undefined ? DEFAULT_OUT : path.resolve(PKG_DIR, args.out)

  if (args.check) {
    let existing
    try {
      existing = JSON.parse(fs.readFileSync(outPath, 'utf8'))
    } catch {
      console.error(`no existing manifest at ${outPath}`)
      process.exit(1)
    }
    if (!verifyManifestSignature(existing, PINNED_MANIFEST_PUBLIC_KEY)) {
      console.error(`${outPath}: signature does not verify against the pinned key`)
      process.exit(1)
    }
    const parsed = parseManifest(existing)
    const sameFiles = parsed.files.length === signed.files.length && parsed.files.every((row, i) => {
      const mine = signed.files[i]
      return row.path === mine.path && row.sha256 === mine.sha256 && row.size === mine.size
    })
    if (parsed.version !== signed.version || !sameFiles) {
      console.error(`${outPath} is stale: version ${parsed.version} vs ${signed.version}, files ${parsed.files.length} vs ${signed.files.length}`)
      process.exit(1)
    }
    console.log(`manifest up to date: ${parsed.version}, ${parsed.files.length} files`)
    return
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${JSON.stringify(signed, undefined, 2)}\n`)
  console.log(`wrote ${outPath}`)
  console.log(`version: ${signed.version}, files: ${signed.files.length}, bytes: ${signed.files.reduce((sum, row) => sum + row.size, 0)}`)
}

try {
  main()
} catch (error) {
  console.error(`build-manifest: ${error?.message ?? error}`)
  process.exit(1)
}