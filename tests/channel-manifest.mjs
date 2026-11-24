/**
 * 渠道清单对账测试 —— 钉住「面板上有的卡片，宿主一定认得」。
 *
 * 这几条是**真实报障**的直接成因（2026-11-24「新加的添加账号都不行，astudio 没有」）：
 *
 * | 清单 | 谁读 | 漏一条的症状 |
 * | --- | --- | --- |
 * | `OWN_PROVIDERS`（宿主账号表） | 账号落库 / 目录 / 权益 | 面板有卡片但写不进账号 |
 * | `PROVIDERS`（权益扩展） | `/channels/extra` | 点开「活动」永远说「没有权益扩展」 |
 * | `BROWSER_LOGIN_PROVIDERS` + 入口表 | `/channels/own/browser/*` | 浏览器起来了，或「添加账号」报「入口尚未实现」 |
 * | `device-login` FLOWS | `/channels/own/login/*` | 点「添加账号」报「该渠道没有设备码登录」 |
 * | `client.js` 的 `CHANNEL_PROVIDERS` / `CHANNEL_EXTRAS` / `BROWSER_CDP` | 面板 | 卡片不存在，或按钮指向不存在的端点 |
 *
 * 判据全部是**集合相等**（双向），不是「有没有出现某个字符串」—— 只测单向时，
 * 「多一条」与「少一条」有一侧永远蒙得住。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { OWN_PROVIDERS } from '../src/channels/accounts.js'
import { createChannelExtras } from '../src/channels/index.js'
import { PACK_CHANNEL_IDS, buildChannelManifest, missingFromHost } from '../src/channels/manifest.js'
import { createDeviceLogin } from '../src/channels/device-login.js'

const indexSource = fs.readFileSync(path.resolve('index.js'), 'utf8')
const clientSource = fs.readFileSync(path.resolve('client.js'), 'utf8')

/** `const NAME = new Set(['a', 'b'])` → `['a','b']`（排序）。 */
function setOf(source, name) {
  const match = new RegExp(`${name} = new Set\\(\\[([^\\]]*)\\]\\)`).exec(source)
  assert.ok(match !== null, `找不到 ${name} 的定义`)
  return match[1].split(',').map(part => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean).sort()
}

/** `client.js` 的卡片表：只取 `own: true` 的 id。 */
function ownCardsOf(source) {
  const start = source.indexOf('const CHANNEL_PROVIDERS = [')
  assert.ok(start > 0, '找不到 CHANNEL_PROVIDERS')
  const end = source.indexOf('const BROWSER_CDP', start)
  const body = source.slice(start, end)
  const ids = []
  for (const match of body.matchAll(/\{ id: '([a-z0-9]+)',[^}]*\}/g)) {
    if (/\bown: true\b/.test(match[0])) ids.push(match[1])
  }
  return ids.sort()
}

/* ── 1. 清单构造与对账（纯函数） ─────────────────────────────────────────── */

{
  const manifest = buildChannelManifest({
    ownIds: ['codely', 'astudio', 'doubao'],
    extrasIds: ['astudio'],
    browserIds: ['doubao'],
    supportsDeviceLogin: provider => provider === 'codely' || provider === 'astudio',
    supportsSmsLogin: provider => provider === 'codely',
    hasQrLogin: provider => provider === 'astudio',
    modelCount: provider => (provider === 'astudio' ? 7 : 0),
  })
  assert.deepEqual(manifest.pack, [...PACK_CHANNEL_IDS])
  assert.equal(manifest.totals.pack, 13, '渠道包固定 13 家')
  assert.equal(manifest.totals.own, 3)
  assert.equal(manifest.totals.all, 16)

  const byId = Object.fromEntries(manifest.own.map(row => [row.id, row]))
  assert.equal(byId.doubao.login, 'browser', '走宿主起浏览器的渠道登录类型是 browser')
  assert.equal(byId.codely.login, 'device')
  assert.equal(byId.astudio.qr, true, '扫码型渠道要标出来（面板画二维码而不是贴链接）')
  assert.equal(byId.astudio.models, 7)
  assert.deepEqual(missingFromHost(manifest, ['codely', 'astudio', 'doubao']), [], '三处都认识 ⇒ 没有缺失')
  assert.deepEqual(missingFromHost(manifest, ['codely', 'baizhi']), ['baizhi'], '宿主不认识的要回 missing')
  assert.deepEqual(missingFromHost(undefined, ['x']), ['x'], '拿不到清单时一律算缺失（宁可提醒也别静默）')
  console.log('ok 1/5 清单构造与对账')
}

/* ── 2. 面板卡片 == 宿主账号表（**双向**） ──────────────────────────────── */

{
  const cards = ownCardsOf(clientSource)
  const host = [...OWN_PROVIDERS].sort()
  assert.deepEqual(cards, host, '面板的自有渠道卡片必须与宿主 `OWN_PROVIDERS` 逐条相等（少一条=卡片不见了，多一条=点了写不进账号）')
  assert.ok(cards.includes('astudio'), 'astudio 必须出现在面板上')
  assert.ok(cards.includes('doubao'), 'doubao 必须出现在面板上')
  assert.equal(cards.length + PACK_CHANNEL_IDS.length, 29, `当前面板应有 13+16=29 张卡片，实际 ${cards.length + PACK_CHANNEL_IDS.length}`)
  console.log('ok 2/5 面板卡片与宿主账号表')
}

/* ── 3. 权益扩展：面板入口 ⊆ 宿主注册（反向缺口要显式登记） ─────────────── */

{
  const stubPool = { listAccounts: () => [], findAccount: () => undefined }
  const extras = createChannelExtras({ pool: stubPool, resolve: async () => undefined })
  assert.equal(extras.available, true)
  const hostExtras = extras.providers().slice().sort()
  const clientExtras = setOf(clientSource, 'CHANNEL_EXTRAS')
  assert.ok(clientExtras.every(id => hostExtras.includes(id)),
    `面板指向了未注册的扩展：${clientExtras.filter(id => !hostExtras.includes(id)).join(',')}`)
  // 宿主有扩展而面板没入口 = 功能在但点不到。目前**不允许**再出现这种缺口：
  // 自有渠道的 extras 必须全部有面板入口（astudio/doubao 就是补上的那两个）。
  const ownOwn = [...OWN_PROVIDERS].filter(id => hostExtras.includes(id)).sort()
  const ownCards = ownCardsOf(clientSource)
  const missingEntries = ownOwn.filter(id => !clientExtras.includes(id))
  assert.deepEqual(missingEntries, [], `这些自有渠道有权益扩展但面板没有入口：${missingEntries.join(',')}`)
  assert.ok(ownCards.length >= ownOwn.length)
  console.log('ok 3/5 权益扩展入口')
}

/* ── 4. 浏览器登录：宿主集合 == 入口表 == 面板 CDP 集合 ─────────────────── */

{
  const hostBrowser = setOf(indexSource, 'BROWSER_LOGIN_PROVIDERS')
  const clientBrowser = setOf(clientSource, 'BROWSER_CDP')
  const entriesStart = indexSource.indexOf('const BROWSER_LOGIN_ENTRIES = {')
  assert.ok(entriesStart > 0, '找不到 BROWSER_LOGIN_ENTRIES')
  const entriesEnd = indexSource.indexOf('async function startBrowserChannelLogin', entriesStart)
  const entryKeys = [...indexSource.slice(entriesStart, entriesEnd).matchAll(/^\s{4}([a-z][a-z0-9]*)\s*[:(]/gm)]
    .map(match => match[1]).sort()
  assert.deepEqual(entryKeys, hostBrowser, '登录集合与入口表必须逐条相等（漏一条 = 点「添加账号」报「入口尚未实现」）')
  assert.deepEqual(clientBrowser, hostBrowser, '面板 CDP 集合必须与宿主集合相等（少一条 = 扫完码一直转圈）')
  console.log('ok 4/5 浏览器登录三份清单')
}

/* ── 5. 设备码/扫码流程：能从面板点到的渠道都得真有一条流程 ─────────────── */

{
  const deviceLogin = createDeviceLogin({ accounts: { create: () => ({ id: 'probe' }), attach: async () => undefined } })
  assert.equal(deviceLogin.supports('astudio'), true, 'astudio 必须有一条登录流程（扫码）')
  assert.equal(deviceLogin.supports('codely'), true)
  // 面板上 `login: 'device'` 的卡片：必须由设备码流程或浏览器登录之一兜住，
  // 否则「添加账号」会打在空处（`该渠道没有设备码登录`）。
  const browserSet = new Set(setOf(indexSource, 'BROWSER_LOGIN_PROVIDERS'))
  const cards = clientSource.slice(clientSource.indexOf('const CHANNEL_PROVIDERS = ['), clientSource.indexOf('const BROWSER_CDP'))
  const deviceCards = [...cards.matchAll(/\{ id: '([a-z0-9]+)',[^}]*\}/g)]
    .filter(match => /\bown: true\b/.test(match[0]) && /login: 'device'/.test(match[0]))
    .map(match => match[1])
  const orphan = deviceCards.filter(id => !deviceLogin.supports(id) && !browserSet.has(id))
  assert.deepEqual(orphan, [], `这些卡片标着 device 登录，但宿主既没有设备码流程也没有浏览器登录：${orphan.join(',')}`)
  // 短信渠道单独一张表（AutoClaw）—— `login: 'sms'` 的卡片必须能在那里找到。
  const smsCards = [...cards.matchAll(/\{ id: '([a-z0-9]+)',[^}]*\}/g)]
    .filter(match => /\bown: true\b/.test(match[0]) && /login: 'sms'/.test(match[0]))
    .map(match => match[1])
  assert.ok(smsCards.length > 0, '短信渠道不该凭空消失')
  console.log('ok 5/5 登录流程覆盖')
}

console.log('channel manifest OK: 5 组断言全部通过')
