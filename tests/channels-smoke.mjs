/**
 * 白嫖页渲染冒烟测试（离线、零依赖）。
 *
 * 为什么需要它：`client.js` 是手写的 ModuleLoader 包，平时只有在 DSH 壳里才会
 * 被渲染，而渠道页的每个折叠都在读渠道包 RPC 的返回值。改坏一个字段名
 * （例如把 `summary.totalByUnit` 读成 `totalCredit`）在语法检查里看不出来，
 * 只有真渲染一次才会炸 —— 这里用一份极小的 React 替身把整页跑一遍。
 *
 * 契约来源：`client.js` 末尾的 `exports.__test`（与 scripts/client-lint.mjs
 * 共用同一份替身思路），以及渠道包 `pack.js` 里各 RPC 的真实返回形状。
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/* ── 极小 React 替身 ─────────────────────────────────────────────────────── */

const Fragment = Symbol.for('ofm.fragment')
let active = null
let passCounters = new Map()
const store = new Map()
let effects = []
let dirty = false

function keyFor(type, path, explicitKey) {
  const name = type.name || 'anon'
  // 实例身份 = **树里的位置**（列表项用 `key`，其余用父路径 + 序号）。
  // 真的 React 也是这样做的；替身若只按「出现次序」编号，一次条件渲染
  // 改变兄弟数量就会让后面实例的身份整体漂移 —— 状态会串到别的组件上，
  // 表现为「RPC 明明回包了、界面还是空」。
  return explicitKey !== undefined && explicitKey !== null ? `${name}@key:${explicitKey}` : `${name}@${path}`
}

function slot() {
  const entry = store.get(active)
  const s = entry.slots[entry.cursor] ?? (entry.slots[entry.cursor] = {})
  entry.cursor += 1
  return s
}

function sameDeps(a, b) {
  if (a === undefined || b === undefined) return false
  if (a.length !== b.length) return false
  return a.every((value, index) => Object.is(value, b[index]))
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  Fragment,
  useState(initial) {
    const s = slot()
    if (!('value' in s)) {
      s.value = typeof initial === 'function' ? initial() : initial
      s.set = next => {
        s.value = typeof next === 'function' ? next(s.value) : next
        dirty = true
      }
    }
    return [s.value, s.set]
  },
  useMemo(fn, deps) {
    const s = slot()
    if (!('value' in s) || !sameDeps(s.deps, deps)) { s.value = fn(); s.deps = deps }
    return s.value
  },
  useCallback(fn, deps) {
    const s = slot()
    if (!('value' in s) || !sameDeps(s.deps, deps)) { s.value = fn; s.deps = deps }
    return s.value
  },
  useRef(initial) {
    const s = slot()
    if (!('value' in s)) s.value = { current: initial }
    return s.value
  },
  useEffect(fn, deps) {
    const s = slot()
    if (!('value' in s) || !sameDeps(s.deps, deps)) { s.deps = deps; effects.push(fn) }
  },
}

/* ── 渠道包替身：按 pack.js 里各 RPC 的真实形状回包 ─────────────────────── */

export const calls = []
export const payloads = []
const ACCOUNTS = {
  codearts: [{ id: 'codearts-1', nickname: 'ha', enabled: true, refreshable: true, expiresAt: Date.now() + 3600_000 }],
  buddy: [{ id: 'buddy-1', nickname: 'ha', enabled: true, refreshable: true, expiresAt: Date.now() + 3600_000 }],
  workbuddy: [],
  lobsterai: [],
  qoder: [],
  qodercn: [{ id: 'qodercn-1', nickname: 'nick', enabled: true, refreshable: true }],
  trae: [{ id: 'trae-1', nickname: '180****', enabled: true, refreshable: true }],
  cline: [{ id: 'cline-1', nickname: 'c', enabled: true, refreshable: true }],
  loomy: [{ id: 'loomy-1', nickname: 'ha', enabled: true, refreshable: false }],
  raccoon: [],
  minimax: [{ id: 'minimax-1', nickname: 'mm', enabled: true, refreshable: true }],
  zcode: [{ id: 'zcode-1', nickname: 'zc', enabled: true, refreshable: false }],
  gemini: [{ id: 'gemini-1', nickname: 'a@gmail.com', enabled: true, refreshable: true }],
}

const BALANCES = {
  codearts: { total: 480, expiredTotal: 5, packages: [
    { name: '总积分包', remaining: 480, total: 1000, used: 520, active: true },
    { name: '赠送积分包', remaining: 20, total: 20, used: 0, active: true },
  ] },
  buddy: { total: 100, expiredTotal: 0, packages: [{ name: '基础积分包', remaining: 100, total: 100, active: true }] },
  workbuddy: { total: 0, expiredTotal: 0, packages: [] },
  lobsterai: null,
  qoder: null,
  qodercn: { total: 100, expiredTotal: 0, packages: [] },
  trae: { total: 100, expiredTotal: 0, packages: [] },
  cline: { total: 0.42, expiredTotal: 0, packages: [] },
  loomy: { total: '—', expiredTotal: 0, packages: [] },
  raccoon: null,
  minimax: { total: 400, expiredTotal: 0, packages: [] },
  zcode: { total: 200000, expiredTotal: 0, packages: [{ name: 'GLM-5.3-Flash', remaining: 200000, total: 200000, active: true }] },
  gemini: { total: 60, expiredTotal: 0, packages: [{ name: '5 小时窗口', remaining: 60, total: 100, active: true }] },
}

function reply(method, payload) {
  const provider = payload?.provider
  switch (method) {
    case 'provider.status': {
      const statuses = {}
      for (const id of payload.providers) {
        const accounts = ACCOUNTS[id] ?? []
        statuses[id] = {
          accounts: { total: accounts.length, enabled: accounts.filter(row => row.enabled !== false).length },
          models: { total: 2, disabled: 0 },
          closed: false,
        }
      }
      return { statuses }
    }
    case 'account.list':
      return { accounts: ACCOUNTS[provider] ?? [] }
    case 'model.list':
      return { models: [
        { id: `${provider}-a`, name: `${provider} A · x0.75`, disabled: false, dead: false },
        { id: `${provider}-b`, name: `${provider} B · x1`, disabled: true, dead: false, isFree: true },
      ] }
    case 'credits.balances':
      return { accounts: (ACCOUNTS[provider] ?? []).map(row => ({
        accountId: row.id,
        nickname: row.nickname,
        balance: BALANCES[provider] ?? null,
        ...BALANCES[provider] === null ? { error: '凭据未配置' } : {},
        ...provider === 'gemini' ? { extra: { accountTier: { label: 'Free', title: '免费版（FREE）' } } } : {},
      })) }
    case 'credits.status':
      return { accounts: (ACCOUNTS[provider] ?? []).map(row => ({ accountId: row.id, nickname: row.nickname, status: { todayCheckedIn: true, todayCredit: 100 } })) }
    case 'credits.claimAll':
      return {
        results: [{ accountId: `${provider}-1`, nickname: 'x', outcome: { kind: 'failed', code: 500, message: '方法1失败' } }],
        summary: {
          claimed: 1, alreadyClaimed: 2, inactive: 1, failed: 1,
          totalCredit: provider === 'zcode' ? 200000 : 800,
          totalByUnit: { credit: provider === 'zcode' ? 0 : 800, token: provider === 'zcode' ? 200000 : 0 },
        },
      }
    case 'credits.permanentLock':
      return { provider, locked: false, windowDays: 15 }
    case 'cline.quota':
      return { accounts: [{ accountId: 'cline-1', nickname: 'c', ok: true, windows: [{ type: 'five-hour', percentUsed: 40, resetsAt: '' }] }] }
    case 'onboarding.status':
      return { tasks: { desktop_login_reward: payload.accountId === 'loomy-1' }, earned: 10, total: 40, titles: { desktop_login_reward: '桌面端登录奖励' }, points: { desktop_login_reward: 10 } }
    case 'onboarding.claim':
      return { claimed: [{ key: 'desktop_login_reward', title: '桌面端登录奖励', points: 10 }], skipped: [], earned: 20, total: 40 }
    case 'provider.setEnabled':
      return { provider, enabled: payload.enabled, models: 2, accounts: 1 }
    case 'usage.autoCheckin':
      return { autoCheckin: { enabled: true, ranToday: true, running: false, lastResult: '5 个账号领取成功（+800积分）' } }
    case 'usage.tokenLedger':
    case 'usage.tokenLedgerHistory':
      return { rows: [] }
    default:
      throw new Error(`unexpected rpc method: ${method}`)
  }
}

const ctx = {
  connection: {
    rpc: {
      async call(api, service, body) {
        assert.equal(api, '/api')
        assert.equal(service, 'channel-pack')
        calls.push(body.method)
        payloads.push({ method: body.method, payload: body.payload ?? {} })
        return { ok: true, value: reply(body.method, body.payload ?? {}) }
      },
    },
  },
}

/* ── 载入 client.js（模拟 ModuleLoader） ────────────────────────────────── */

let factory
globalThis.window = {
  __ModuleLoader__: { load(bundle) { factory = bundle.factory } },
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent() {},
  confirm: () => true,
  open: () => null,
  location: { href: 'http://127.0.0.1/' },
}
globalThis.document = { visibilityState: 'visible' }

/* 本插件自己的 HTTP 路由（`/api/our-free-model/*`）：页面用 `api()` 直接 fetch。
   只实现权益扩展的两条，其余一律「该路由未实现」——这样漏配的路由会在断言里
   变成可见的失败，而不是静默拿到 undefined。 */
const httpCalls = []
const API_PREFIX = '/api/our-free-model'
globalThis.fetch = async (input, init = {}) => {
  const url = String(input)
  httpCalls.push({ url, method: init.method ?? 'GET', body: init.body })
  if (url.startsWith(`${API_PREFIX}/channels/extra?`)) {
    const provider = new URL(url, 'http://127.0.0.1').searchParams.get('provider')
    return jsonResponse({
      provider,
      // 只有 codearts 由替身给出数据；qoder/qodercn 走「未实现该渠道」那条如实分支
      supported: provider === 'codearts',
      ratios: provider === 'codearts' ? { 'codearts-a': 'x0.18' } : {},
      accounts: provider === 'codearts' ? [{
        accountId: 'codearts-1',
        nickname: 'ha',
        info: { planName: '企业版', total: { remain: 800, total: 5000, used: 4200, expiring: 200 } },
        activities: [{ campaignId: '7', type: 'USER_LOGIN', title: '每日登录', claimable: true, status: 'ENTRY', amount: 1000 }],
        ratios: { 'codearts-a': 'x0.18' },
      }] : [],
    })
  }
  if (url === `${API_PREFIX}/channels/extra/claim` && (init.method ?? '') === 'POST') {
    return jsonResponse({ kind: 'claimed', credit: 1000, campaignId: '7', title: '每日登录' })
  }
  if (url === `${API_PREFIX}/channels/own/login/start` && (init.method ?? '') === 'POST') {
    return jsonResponse({ accountId: 'codely-1', userCode: 'ABCD-EFGH', verificationUri: 'https://codely/device', verificationUriComplete: 'https://codely/device?c=ABCD', intervalMs: 2000 })
  }
  if (url.startsWith(`${API_PREFIX}/channels/own?`)) {
    const provider = new URL(url, 'http://127.0.0.1').searchParams.get('provider')
    const own = provider === 'codely' ? [{ id: 'codely-1', nickname: 'unity', credentialRef: 'OFM_CODELY_ACCOUNT_AAAA', enabled: true, createdAt: 1 }]
      : provider === 'autoclaw' ? [{ id: 'autoclaw-1', nickname: '138****8000', credentialRef: 'OFM_AUTOCLAW_ACCOUNT_BBBB', enabled: true, createdAt: 2 }]
        : []
    return jsonResponse({ provider, supported: provider === 'codely' || provider === 'autoclaw', accounts: own })
  }
  if (url.startsWith(`${API_PREFIX}/channels/own/login/poll?`)) {
    return jsonResponse({ done: true, success: true, nickname: 'unity-user' })
  }
  throw new Error(`unexpected fetch: ${init.method ?? 'GET'} ${url}`)
}
function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify(payload) },
  }
}

const clientPath = pathToFileURL(path.resolve(process.cwd(), 'client.js')).href
await import(clientPath)
assert.equal(typeof factory, 'function', 'ModuleLoader factory was not captured')

const module = factory(name => {
  if (name === 'react') return React
  if (name === 'react-dom') throw new Error('no react-dom in smoke harness')
  throw new Error(`unknown require: ${name}`)
})

const ChannelsPage = module.__test?.ChannelsPage
assert.equal(typeof ChannelsPage, 'function', '__test.ChannelsPage missing')

/* ── 渲染 ──────────────────────────────────────────────────────────────── */

function render(node, path = 'root') {
  if (node === null || node === undefined || node === false || node === true) return null
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) {
    return node.map((child, index) => {
      const childKey = child !== null && typeof child === 'object' ? child.props?.key : undefined
      const childPath = `${path}/${childKey !== undefined && childKey !== null ? `k:${childKey}` : index}`
      return render(child, childPath)
    }).filter(value => value !== null)
  }
  if (node.type === Fragment) return render(node.children, `${path}/<>`)
  if (typeof node.type === 'function') {
    const key = keyFor(node.type, path, node.props?.key)
    const saved = active
    const entry = store.get(key) ?? { slots: [], cursor: 0 }
    entry.cursor = 0
    store.set(key, entry)
    active = key
    let out
    try { out = node.type({ ...node.props, children: node.children }) } finally { active = saved }
    return render(out, `${key}/out`)
  }
  return { host: String(node.type), props: node.props, children: render(node.children, `${path}/<${String(node.type)}>`) }
}

const t = key => ({
  'chan.unit.credit': '积分',
  'chan.unit.tokens': 'Token',
  'chan.unit.dollars': 'USD',
  'chan.unit.quota': '配额',
  'chan.claim.result': '已领取 {count} 个账号：{amounts}。',
  'chan.claim.withAlready': '已领取 {count} 个账号：{amounts}；另有 {already} 个今天已领。',
  'chan.claim.alreadyOnly': '今天已领过（{already} 个账号），无需重复领取。',
  'chan.claim.inactive': '；{count} 个账号的签到活动未开启。',
  'chan.claim.failed': '领取失败：{reason}',
  'chan.claim.all.already': '{already} 个账号今天已领',
  'chan.claim.all.failed': '{failed} 个账号领取失败',
  'chan.claim.none': '今天没有可领取的积分。',
  'chan.credits.expired': '已作废 {amount}',
  'chan.credits.tier': '档位 {tier}',
  'chan.task.claimed': '已领取：{list}',
  'chan.task.skipped': '{count} 项此前已领',
  'chan.task.earned': '已领 {earned} / {total}',
  'chan.task.none': '没有可领取的任务。',
  'chan.provider.doneOff': '已关闭「{name}」：{models} 个模型、{accounts} 个账号',
  'chan.quota.window': '{type} 已用 {percent}%',
}[key] ?? key)

let tree = null

function walk(node, visit) {
  if (node === null || node === undefined || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(child => walk(child, visit)); return }
  visit(node)
  walk(node.children, visit)
}

function textOf(node) {
  if (typeof node === 'string') return node
  if (node === null || typeof node !== 'object') return ''
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return textOf(node.children)
}

function clickByText(needle) {
  let hit = false
  walk(tree, node => {
    if (hit || node.host !== 'button') return
    if (!textOf(node).includes(needle)) return
    if (typeof node.props?.onClick !== 'function') return
    node.props.onClick()
    hit = true
  })
  return hit
}

/** 点开**每一张**卡片上同名折叠：每张卡片的 `open` 是各自的 state，只点第一个
 *  会让其余渠道的行永远不渲染（本测试最初就踩了这个坑）。 */
function clickAll(label) {
  const hits = []
  walk(tree, node => {
    if (node.host !== 'button') return
    if (!textOf(node).includes(label)) return
    if (typeof node.props?.onClick === 'function') hits.push(node.props.onClick)
  })
  for (const onClick of hits) onClick()
  return hits.length
}

async function settle(passes = 10) {
  // 不提前 break：折叠里的 `toggle()` 是「先 await 账号、再 await 任务」的
  // 串行链，每个 await 都要一个微任务回合才落地。只在 dirty 才继续的循环
  // 会在链跑完之前停手，于是渲染出的树永远停在 loading 分支。
  for (let pass = 0; pass < passes; pass += 1) {
    passCounters = new Map()
    effects = []
    dirty = false
    tree = render(React.createElement(ChannelsPage, { t, ctx, summary: { channels: { state: 'ready', error: '' } } }))
    for (const effect of effects) effect()
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  return tree
}

await settle()

/* ── 断言：真实返回值被正确读出，而不是被压成一个数 ──────────────────── */

let flat = JSON.stringify(tree)
assert.ok(calls.includes('provider.status'), 'provider.status was never requested')
assert.ok(calls.includes('credits.balances'), 'credits.balances was never requested')
assert.ok(flat.includes('$0.42'), 'Cline 的美元余额没有按两位小数显示')
assert.ok(flat.includes('chan.lock.off'), '永久积分锁按钮没有出现')
assert.ok(flat.includes('chan.fold.tasks'), '任务折叠入口没有出现')
assert.ok(flat.includes('chan.fold.subscription'), '订阅额度折叠入口没有出现')
assert.ok(flat.includes('chan.claim.all'), '全渠道领取按钮没有出现')
assert.ok(flat.includes('5 个账号领取成功（+800积分）'), '自动签到上次结果没有显示')

/* ── 展开折叠：账号行 / 任务 / 订阅额度 / 全部领取 ─────────────────────── */

const opened = ['chan.fold.accounts', 'chan.fold.tasks', 'chan.fold.subscription', 'chan.fold.extra'].map(label => clickAll(label))
assert.ok(opened[0] >= 12, `账号折叠只点开了 ${opened[0]} 张卡片`)
assert.ok(opened[1] >= 2, `任务折叠只点开了 ${opened[1]} 张卡片`)
assert.ok(opened[2] >= 1, '订阅额度折叠没有点开')
assert.ok(opened[3] >= 1, '活动折叠没有点开')
await settle()

// ── 契约断言 ───────────────────────────────────────────────────────────────
// 折叠内容的渲染依赖「点击 → await → setState → 再渲染」这条链；替身 React 对
// 它只做到尽力而为（真壳里由 React 保证）。所以这里断言**请求契约**：每个能力
// 打到正确的端点、带正确的载荷。各自的**数据语义**由其它三份测试覆盖：
//   tests/amount-helpers.mjs（金额/单位）、tests/i18n-keys.mjs（文案键）、
//   tests/codearts-ops.mjs（签名、活动解析、领取 + confirm + 40001）。
const issued = method => payloads.filter(row => row.method === method)
for (const provider of ['codearts', 'buddy', 'zcode', 'gemini', 'cline']) {
  assert.ok(issued('credits.balances').some(row => row.payload.provider === provider),
    `credits.balances 没有覆盖 ${provider}`)
}
assert.equal(issued('cline.quota').length, 1, 'cline.quota 没有被调用')
assert.equal(issued('cline.quota')[0].payload.provider, 'cline')
assert.equal(issued('onboarding.status').length, 1, 'onboarding.status 没有被调用')
assert.equal(issued('onboarding.status')[0].payload.accountId, 'loomy-1')
const lockProviders = [...new Set(issued('credits.permanentLock').map(row => row.payload.provider))].sort()
assert.deepEqual(lockProviders, ['buddy', 'loomy', 'workbuddy'], '永久积分锁只应发给 buddy/workbuddy/loomy')
assert.ok(issued('provider.status').length >= 1)

// 权益扩展走本插件自己的 HTTP 路由（不是渠道包 RPC）
const extraGets = httpCalls.filter(row => row.url.includes('/channels/extra?'))
assert.ok(extraGets.length >= 1, '活动查询没有打到 /channels/extra')
assert.ok(extraGets[0].url.includes('provider=codearts'), '活动查询没带 provider')

// 任务领取：载荷要带 provider/accountId
assert.ok(clickByText('chan.task.claim'), '任务领取按钮不可点')
await settle()
const taskClaimCalls = issued('onboarding.claim')
assert.equal(taskClaimCalls.length, 1, 'onboarding.claim 没有被调用')
assert.equal(taskClaimCalls[0].payload.provider, 'loomy')
assert.equal(taskClaimCalls[0].payload.accountId, 'loomy-1')

// 全渠道领取：串起所有有 claim 能力的渠道；不支持签到的三家不得被调用
assert.ok(clickByText('chan.claim.all'), '全渠道领取按钮不可点')
await settle(12)
const claims = calls.filter(method => method === 'credits.claimAll').length
assert.ok(claims >= 8, `只有 ${claims} 个渠道发起了领取`)
for (const unsupported of ['cline', 'workbuddy', 'raccoon']) {
  assert.ok(!issued('credits.claimAll').some(row => row.payload.provider === unsupported),
    `${unsupported} 不支持签到，却发起了领取`)
}


// 本插件自己的渠道（codely）：账号表由自己的路由提供，不进渠道包的 provider.status
const ownStatus = httpCalls.filter(row => row.url.includes('/channels/own?provider='))
assert.ok(ownStatus.some(row => row.url.includes('provider=codely')), 'codely 的账号没有从自己的路由读')
assert.ok(!payloads.some(row => row.method === 'provider.status' && row.payload.providers.includes('codely')),
  'codely 不该出现在渠道包 provider.status 的 provider 列表里（它不认识这个 id）')
assert.ok(JSON.stringify(tree).includes('Codely'), 'codely 卡片没有渲染')

// 回归钉死：qoder/qodercn 在 CHANNEL_EXTRAS 里（倍率折叠用），但它们的登录
// 必须走渠道包的 account.create —— 上一版只判 CHANNEL_EXTRAS，把 Qoder 的
// 「添加账号」路由到只认识 Codely 的设备码端点，登录整个坏了（用户报障
// 「qoder 还不能登录了，咋还退化了」）。先真的点一遍所有「添加账号」，
// 再断言没有任何 own/login/start 请求带 qoder/qodercn。
const addClicks = clickAll(t('chan.act.add'))
assert.ok(addClicks >= 14, `添加账号按钮只点到 \${addClicks} 个（应 ≥ 14）`)
await settle()
const ownStarts = httpCalls
  .filter(row => row.url.includes('/channels/own/login/start'))
  .map(row => JSON.parse(row.body).provider)
assert.ok(!ownStarts.includes('qoder') && !ownStarts.includes('qodercn'),
  `qoder/qodercn 的登录被路由到自己的设备码端点：\${ownStarts.join(',')}（应走渠道包）`)
assert.ok(ownStarts.every(p => ['codely', 'autoclaw', 'autoclawintl', 'accio', 'minimaxintl'].includes(p)),
  `own/login/start 只该被自有渠道调用，实际：\${ownStarts.join(',')}`)

// 回归钉死：qoder/qodercn 在 CHANNEL_EXTRAS 里（倍率折叠用），但它们的登录
// 必须走渠道包的 account.create —— 上一版只判 CHANNEL_EXTRAS，把 Qoder 的
// 「添加账号」路由到只认识 Codely 的设备码端点，登录整个坏了。
assert.ok(!httpCalls.some(row => row.url.includes('/channels/own/login/start') && JSON.parse(row.body).provider === 'qoder'),
  'qoder 的登录被路由到了自己的设备码端点（应走渠道包）')

console.log('channels smoke OK — rpc calls:', [...new Set(calls)].join(', '))
// client.js 里挂了 45s/60s 的轮询定时器，替身渲染不会清理它们；
// 断言全过之后直接退出，别让 CI 卡在 event loop 上。
process.exit(0)