/**
 * 安装漂移检查：已安装的那份插件，还是不是这个仓库？
 *
 * ## 为什么需要它
 *
 * 2026-11-24 的事故：profile 里写的是 `dsh-our-free-model: ^2.1.0`（npm 版本范围），
 * 一次插件安装/升级就把 `node_modules/dsh-our-free-model` 整个换成 npm 上的 2.1.0，
 * 本地补丁（`sn-qwen4-max`、ZCode 4 条、Qoder `fast`）**静默消失** —— 没有报错、
 * 没有日志，只有「千问4 又看不到了」。
 *
 * 现在 profile 用 `link:` 指回本仓库（junction），正常情况下**不可能**漂移。
 * 这个脚本是那条保证的**探针**：任何时候觉得「改动没生效」，先跑它 ——
 *
 * - 已安装目录是 junction → 报 `linked`，本体就是这个仓库，漂移无从发生；
 * - 是普通目录 → 逐文件 sha256 对比 `package.json` 的 `files` 白名单，
 *   列出**缺失 / 长度不同 / 内容不同**的文件，退出码 1。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-install-drift.mjs                  # 默认查 desktop profile
 * node scripts/check-install-drift.mjs --target <dir>   # 查任意安装位置
 * ```
 *
 * 只读：不写任何文件、不联网、不 import pack.js（它依赖宿主 `@deepseek-ai/*`）。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_TARGET = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-our-free-model')

/** `--target <dir>`；缺省用 desktop profile 的安装位置。 */
function targetOf(argv) {
  const at = argv.indexOf('--target')
  if (at < 0) return DEFAULT_TARGET
  const value = argv[at + 1]
  if (typeof value !== 'string' || value === '') {
    console.error('--target 需要一个目录')
    process.exit(2)
  }
  return path.resolve(value)
}

/** `package.json` 的 `files` 白名单 → 仓库内的相对文件路径（目录递归展开）。 */
function shippedFiles(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const entries = Array.isArray(pkg.files) ? pkg.files : []
  const out = new Set()
  const walk = relative => {
    const absolute = path.join(root, relative)
    const stat = fs.statSync(absolute, { throwIfNoEntry: false })
    if (stat === undefined) return
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absolute)) walk(path.join(relative, child))
      return
    }
    out.add(relative.split(path.sep).join('/'))
  }
  for (const entry of entries) walk(entry)
  return [...out].sort()
}

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')

const target = targetOf(process.argv.slice(2))
if (!fs.existsSync(target)) {
  console.error(`装好的插件不在：${target}`)
  process.exit(2)
}

// junction / symlink：本体就是这个仓库（或另一个目录），漂移无从发生。
const link = fs.lstatSync(target).isSymbolicLink() ? fs.readlinkSync(target) : null
if (link !== null) {
  const resolved = path.resolve(path.dirname(target), link)
  const same = path.resolve(resolved) === path.resolve(REPO)
  console.log(`linked   ${target}`)
  console.log(`target   ${resolved}`)
  console.log(same ? 'ok       安装目录就是本仓库（link:），不存在漂移' : 'warn     链接指向别的目录 —— 改动不会生效')
  process.exit(same ? 0 : 1)
}

const files = shippedFiles(REPO)
const missing = []
const different = []
for (const relative of files) {
  const mine = path.join(REPO, relative)
  const theirs = path.join(target, relative)
  if (!fs.existsSync(theirs)) { missing.push(relative); continue }
  const a = fs.statSync(mine)
  const b = fs.statSync(theirs)
  if (a.size !== b.size || sha256(mine) !== sha256(theirs)) different.push(relative)
}

console.log(`installed   ${target}`)
console.log(`files       ${files.length}`)
if (missing.length === 0 && different.length === 0) {
  console.log('ok          已安装副本与仓库逐字节一致')
  process.exit(0)
}
if (missing.length > 0) console.log(`missing     ${missing.join(', ')}`)
if (different.length > 0) console.log(`different   ${different.join(', ')}`)
console.log('drift       已安装副本被换掉了 —— 这就是「补丁又没了」的形状')
process.exit(1)
