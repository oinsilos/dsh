/**
 * 自有渠道的**控制面**：模型开关 / 渠道开关 / 账号轮换 / 续期 / 身份 / 选择器分组。
 *
 * 这些是「面板上有、点了没反应」那一类缺陷的直接守卫：
 * - 模型开关与渠道开关必须落在**本插件自己的设置**里（不是渠道包的 RPC）；
 * - 推理取号必须在多个账号之间轮换，且跳过没有凭据的占位行；
 * - 有续期实现的渠道（MiniMax / Marvis / OfficeAce / 麦吉 / Accio）必须真的接上；
 * - 选择器要按渠道分组（每条路由一个标题），而不是把 80 个模型混进一组。
 */

import assert from 'node:assert/strict'
import { buildOwnCatalog, ownEntry, ownModelStats } from '../src/channels/catalog.js'
import { createOwnAccountPicker } from '../src/channels/select.js'
import { createOfficeaceExtras, OFFICEACE_MODELS } from '../src/channels/officeace.js'
import { withDailyCheckinActivity } from '../src/channels/index.js'
import { fetchAccioUserInfo, refreshAccioCredential, shouldRefreshAccio } from '../src/channels/accio.js'
import { parseLoginPayload, refreshAutoclawToken } from '../src/channels/autoclaw.js'
import { refreshCodelyToken } from '../src/channels/codely.js'
import { computeMembership } from '../src/core/runtime.js'
import { FreeModelAdapter, ROUTE_MAIN } from '../src/adapter.js'

/* ── 1. 模型开关 / 渠道开关 ─────────────────────────────────────────────── */

{
  const catalogs = { doubao: [{ id: 'm1', name: 'M1' }, { id: 'm2', name: 'M2' }] }
  const enabled = { doubao: true }
  const picked = provider => buildOwnCatalog({ catalogs, enabled, disabledModels: { doubao: ['m2'] } })
    .filter(row => row.provider === provider)
  assert.deepEqual(picked('doubao').map(row => row.modelId), ['m1'], '被关掉的模型不能出现在选择器里')

  const withOff = buildOwnCatalog({
    catalogs, enabled, disabledModels: { doubao: ['m2'] }, includeDisabled: true,
  }).filter(row => row.provider === 'doubao')
  assert.equal(withOff.length, 2, '面板列表必须包含被关掉的行（否则关掉后点不回来）')
  assert.equal(withOff.find(row => row.modelId === 'm2')?.disabled, true)

  const closed = buildOwnCatalog({ catalogs, enabled, closedProviders: { doubao: true } })
    .filter(row => row.provider === 'doubao')
  assert.equal(closed.length, 0, '关闭整个渠道后选择器里整组消失')

  // 选择器/网关只收「有登录账号」的渠道（2026-11-24 用户要求）；同一时刻
  // 面板仍要拿到预制目录，否则未登录渠道连「登录后有哪些模型」都看不到。
  const notSignedIn = buildOwnCatalog({ catalogs, enabled: { doubao: false }, signedInOnly: true })
  assert.equal(notSignedIn.length, 0, '未登录渠道不占选择器分组')
  const signedInOnly = buildOwnCatalog({ catalogs, enabled: { doubao: true }, signedInOnly: true })
  assert.equal(signedInOnly.length, 2)
  assert.ok(signedInOnly.every(row => row.provider === 'doubao'), '已登录渠道照常进选择器')
  const panelView = buildOwnCatalog({ catalogs, enabled: { doubao: false }, includeDisabled: true })
  assert.ok(panelView.filter(row => row.provider === 'doubao').length === 2, '面板仍能看到未登录渠道的预制目录')

  const closedPanel = buildOwnCatalog({
    catalogs, enabled, closedProviders: { doubao: true }, includeDisabled: true,
  }).filter(row => row.provider === 'doubao')
  assert.equal(closedPanel.length, 2, '面板仍要列出被关闭渠道的模型（否则没有入口重新打开）')
  assert.ok(closedPanel.every(row => row.disabled === true))

  assert.deepEqual(ownModelStats({ catalogs, enabled, disabledModels: { doubao: ['m2'] } }, 'doubao'),
    { total: 2, disabled: 1, closed: false }, '卡片的模型计数不能把被关掉的行算丢')
  assert.deepEqual(ownModelStats({ catalogs, enabled, closedProviders: { doubao: true } }, 'doubao'),
    { total: 2, disabled: 2, closed: true })

  // 线协议必须随**每一行**走（远端表常常不写 wire）：漏了就会把 OpenAI 形请求
  // 发到 Anthropic / Responses 端点，表现为「模型看得见、一发就失败」。
  const all = buildOwnCatalog({})
  for (const provider of ['minimaxintl', 'monkeycode', 'monkeycodeintl', 'baizhi']) {
    const rows = all.filter(row => row.provider === provider)
    assert.ok(rows.length > 0, `${provider} 没有预制模型行`)
    assert.ok(rows.every(row => row.wire === 'messages'), `${provider} 的 wire 必须是 messages`)
  }
  assert.ok(all.filter(row => row.provider === 'astudio').every(row => row.wire === 'responses'), 'AStudio 的 wire 必须是 responses')
  console.log('ok 1/6 模型开关、渠道开关与线协议')
}

/* ── 2. 账号轮换 / 占位行 / 续期 ─────────────────────────────────────────── */

{
  const rows = [
    { id: 'a', enabled: true },
    { id: 'b', enabled: true },
    { id: 'empty', enabled: true },
  ]
  const credentials = new Map([['a', { access_token: 'ta' }], ['b', { access_token: 'tb' }]])
  const attached = []
  const book = {
    enabled: () => rows,
    credentialOf: async row => credentials.get(row.id) ?? null,
    attach: async (id, credential) => { attached.push({ id, credential }) },
  }
  const picker = createOwnAccountPicker({ accounts: book })
  assert.equal((await picker.pick('doubao')).account.id, 'a', '首个回合从第一个账号开始')
  assert.equal((await picker.pick('doubao')).account.id, 'b', '第二个回合换下一个账号')
  const third = await picker.pick('doubao')
  assert.equal(third.account.id, 'a', '游标绕回，并跳过没有凭据的占位行')
  assert.equal(third.credential.access_token, 'ta')

  // 续期成功：返回新凭据并回写账号表
  const refreshing = createOwnAccountPicker({
    accounts: book,
    refreshers: {
      doubao: async credential => ({ credential: { ...credential, access_token: credential.access_token + '-new' }, refreshed: true }),
    },
  })
  const refreshed = await refreshing.pick('doubao')
  assert.equal(refreshed.credential.access_token, 'ta-new')
  assert.deepEqual(attached.at(-1), { id: 'a', credential: { access_token: 'ta-new' } }, '续期后必须回写账号表')

  // 续期失败：手上还有令牌就照旧发（本地判过期不如上游准）
  const failing = createOwnAccountPicker({
    accounts: book,
    refreshers: { doubao: async () => ({ error: 'boom' }) },
  })
  const fallback = await failing.pick('doubao')
  assert.equal(fallback.credential.access_token, 'ta')
  console.log('ok 2/6 账号轮换、占位行与续期')
}

/* ── 3. 选择器按渠道分组 ────────────────────────────────────────────────── */

{
  const catalog = [
    { id: 'free-1' },
    ownEntry('doubao', { id: 'm1', name: 'M1', contextWindow: 256_000 }),
    ownEntry('codely', { id: 'm2', name: 'M2' }),
  ]
  const membership = computeMembership(catalog, { results: {} }, { exposeRegionModels: true })
  assert.deepEqual(membership[ROUTE_MAIN], ['free-1'], '自有模型不再混进免费车道那一组')
  assert.deepEqual(membership.doubao, ['doubao/m1'], '豆包有自己的路由/分组')
  assert.deepEqual(membership.codely, ['codely/m2'])

  // 回归（2026-11-24 真机）：自有行曾被免费车道拿去探活，404 后记成 unavailable，
  // 于是整组从 membership 消失 —— 选择器里 14 个渠道一个都不显示。
  const poisoned = {
    results: {
      'doubao/m1': { state: 'unavailable' },
      'codely/m2': { state: 'unavailable' },
    },
  }
  const survived = computeMembership(catalog, poisoned, { exposeRegionModels: true })
  assert.deepEqual(survived.doubao, ['doubao/m1'], '残留的探活结论不能抹掉自有分组')
  assert.deepEqual(survived.codely, ['codely/m2'])
  assert.deepEqual(survived[ROUTE_MAIN], ['free-1'])

  const adapter = new FreeModelAdapter({
    state: () => ({ catalog, membership, settings: {} }),
    recordUsage: () => {},
    recordTurn: () => {},
  })
  assert.equal(adapter.providerInfo('doubao').name, '豆包', '分组标题用中文渠道名')
  assert.equal(adapter.providerInfo('codely').name, 'Codely')
  const models = await adapter.listModels('doubao')
  assert.deepEqual(models.map(model => model.id), ['doubao/m1'])
  assert.equal(models[0].provider, 'doubao')
  // 宿主对每个模型都会调 `resolveModel`（上下文/推理档位来自这一行）。
  const resolved = await adapter.resolveModel('doubao', 'doubao/m1')
  assert.equal(resolved.provider, 'doubao')
  assert.equal(resolved.id, 'doubao/m1')
  assert.equal(resolved.context.contextWindow, 256_000)
  console.log('ok 3/6 选择器分组')
}

/* ── 4. OfficeAce 远端目录（写好了但没人调的缺陷） ──────────────────────── */

{
  const credentialOf = async () => ({ access_token: 'at' })
  const live = createOfficeaceExtras({
    credentialOf,
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() { return { data: [{ id: 'tenant-only-model', name: 'Tenant Only' }] } },
      async text() { return JSON.stringify({ data: [{ id: 'tenant-only-model', name: 'Tenant Only' }] }) },
    }),
  })
  const status = await live.statusOf({ id: 'acc', nickname: 'n' })
  assert.equal(status.source, 'live', '远端目录可用时必须用远端')
  assert.equal(status.catalog[0].id, 'tenant-only-model')

  const fallback = createOfficeaceExtras({
    credentialOf,
    fetch: async () => { throw new Error('offline') },
  })
  const offline = await fallback.statusOf({ id: 'acc', nickname: 'n' })
  assert.equal(offline.source, 'static')
  assert.equal(offline.catalog.length, OFFICEACE_MODELS.length, '失败时退回内置的 8 条（不是旧的 4 条）')
  assert.equal(typeof offline.catalogError, 'string')
  console.log('ok 4/6 OfficeAce 远端目录')
}

/* ── 5. Accio 身份与续期 ────────────────────────────────────────────────── */

{
  const userinfo = await fetchAccioUserInfo('tok', {
    fetch: async (url, init) => {
      assert.ok(String(url).endsWith('/api/auth/userinfo'))
      assert.equal(JSON.parse(init.body).accessToken, 'tok', 'userinfo 的 token 必须在 body')
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ success: true, code: '200', data: { userId: 'u1', maskedMobile: '138****0000', routeRegion: 'CN' } })
        },
      }
    },
  })
  assert.equal(userinfo.info.maskedMobile, '138****0000')
  assert.equal(userinfo.info.routeRegion, 'CN')

  const refreshed = await refreshAccioCredential({ access_token: 'old', refresh_token: 'rt', expires_at: 1 }, {
    fetch: async (url, init) => {
      assert.ok(String(url).endsWith('/api/auth/refresh_token'))
      assert.deepEqual(JSON.parse(init.body), { accessToken: 'old', refreshToken: 'rt' })
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ success: true, code: '200', data: { accessToken: 'new', refreshToken: 'rt2', expiresAt: 1794407698 } })
        },
      }
    },
  })
  assert.equal(refreshed.credential.access_token, 'new')
  assert.equal(refreshed.credential.refresh_token, 'rt2')
  assert.equal(refreshed.credential.expires_at, 1794407698000, '秒必须归一化成毫秒')
  assert.equal(shouldRefreshAccio({ expires_at: Date.now() + 60_000 }), true)
  assert.equal(shouldRefreshAccio({ expires_at: Date.now() + 3_600_000 }), false)

  // 签到：statusOf 只回 `checkin` 读数时，补成面板能渲染的活动行。
  const claimable = withDailyCheckinActivity('codely', { checkin: { canCheckIn: true, reward: 5 } })
  assert.equal(claimable.activities.length, 1)
  assert.equal(claimable.activities[0].claimable, true)
  assert.equal(claimable.activities[0].amount, 5)
  const done = withDailyCheckinActivity('monkeycode', { checkin: { todayCheckedIn: true } })
  assert.equal(done.activities[0].claimable, false)
  const stateless = withDailyCheckinActivity('autoclaw', { info: { total: 1 } })
  assert.equal(stateless.activities[0].claimable, true, 'AutoClaw 没有状态端点，但领取按天幂等')
  const unknown = withDailyCheckinActivity('marvis', { info: { total: 1 } })
  assert.equal(unknown.activities, undefined, '没有签到能力/状态时不伪造活动行')
  console.log('ok 5/6 Accio 身份、续期与签到活动行')
}

/* ── 6. 到期时间与 AutoClaw 续期 ─────────────────────────────────────────── */

{
  const before = Date.now()
  const login = parseLoginPayload({ data: { access_token: 'at', expires_in: 3600 } })
  assert.ok(login.credential.expires_at > before, '`expires_in`（秒数）必须归一成时间戳，不能原样存 3600')
  assert.ok(login.credential.expires_at >= before + 3_500_000)

  const refreshed = await refreshAutoclawToken({ access_token: 'old', refresh_token: 'rt', expires_at: before + 1000 }, {
    fetch: async (url, init) => {
      assert.ok(String(url).endsWith('/userapi/v1/refresh'))
      const body = JSON.parse(init.body)
      assert.equal(body.refresh_token, 'rt')
      assert.equal(body.source_id, 'autoclaw')
      return {
        ok: true,
        status: 200,
        async text() { return JSON.stringify({ code: 0, data: { access_token: 'new', expires_in: 7200 } }) },
      }
    },
  })
  assert.equal(refreshed.error, undefined, `refresh failed: ${refreshed.error}`)
  assert.equal(refreshed.refreshed, true)
  assert.equal(refreshed.credential.access_token, 'new')
  assert.ok(refreshed.credential.expires_at > before)

  const codely = await refreshCodelyToken({ access_token: 'old', refresh_token: 'rt' }, {
    fetch: async (url, init) => {
      assert.ok(String(url).endsWith('/auth/refresh'))
      assert.deepEqual(JSON.parse(init.body), { refresh_token: 'rt' })
      return { ok: true, status: 200, async text() { return JSON.stringify({ access_token: 'at2', refresh_token: 'rt' }) } }
    },
  })
  assert.equal(codely.refreshed, true)
  assert.equal(codely.credential.access_token, 'at2')
  assert.equal(codely.credential.refresh_token, 'rt', 'Codely 的 refresh_token 不轮换')
  console.log('ok 6/6 到期时间与 AutoClaw / Codely 续期')
}

console.log('own controls OK: 6 组断言全部通过')
process.exit(0)
