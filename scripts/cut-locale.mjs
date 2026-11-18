/**
 * 删掉已废弃的文案键（两个须知 + 更新面板 + 部分 dock 键）。
 * 用法：node scripts/cut-locale.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const file = join(root, 'client.js')
let src = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
const before = src

const DROP = [
  /^\s*"welcome\.[^"]*":/, // 用户须知
  /^\s*"auth\.[^"]*":/, // 演练台授权
  /^\s*"update\.[^"]*":/, // 更新面板
  /^\s*"channel\.[^"]*":/,
  /^\s*"btn\.checkUpdate[^"]*":/,
  /^\s*"btn\.doUpdate[^"]*":/,
  /^\s*"dock\.(clean|drill|toggle|newSession|inSession|redteam|full|close)":/,
]

const lines = src.split('\n')
const kept = []
let dropped = 0
for (const line of lines) {
  if (DROP.some((re) => re.test(line))) { dropped += 1; continue }
  kept.push(line)
}
src = kept.join('\n')

writeFileSync(file, src)
console.log(`dropped ${dropped} locale lines; changed=${before !== src}`)