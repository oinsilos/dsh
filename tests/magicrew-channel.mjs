/**
 * Magicrew（超级麦吉 / MagiCrew）协议测试 —— 离线，fetch 打桩。
 *
 * 钉住的判据：
 * 1. 两站只差 host/webOrigin/org 强制 6 个字段；
 * 2. `origin` 与 `referer` 都在（WAF 认 referer，缺了 403 空 body）；
 * 3. 签 key 是 `POST …/tokens` + body `'{}'`；续签是 `PUT` 且**只带 refresh_token**、
 *    **不带 Authorization**（JWT 过期时这条路径还得能用）；
 * 4. 积分 `total_points` 认字符串与**负数**（欠费不吞）；
 * 5. 签到请求体是**空串**，`granted !== true` 是 already-claimed；
 * 6. 新手任务是另一套端点（`/onboarding/tasks`，PUT `…/completion`）；
 * 7. localStorage 收割**成对**取 jwt × org（错配在上游是 HTTP 200 + code:403）；
 * 8. 续签只在「剩 30 分钟内」发生（签新 key 会吊销旧 key）。
 */

import assert from 'node:assert/strict'
import {
  MAGICREW_HARVEST_EXPRESSION,
  MAGICREW_PRODUCTS,
  claimLoginGift,
  completeOnboarding,
  createMagicrewExtras,
  fetchMagicrewModels,
  fetchOnboarding,
  fetchPoints,
  issueGatewayKey,
  magicrewHeaders,
  magicrewProductOf,
  parseMagicrewHarvest,
  refreshGatewayKey,
  shouldRefreshKey,
} from '../src/channels/magicrew.js'

/* ── 1. 产品表 ──────────────────────────────────────────────────────────── */

{
  const cn = magicrewProductOf('magicrew')
  const intl = magicrewProductOf('magicrewintl')
  assert.equal(cn.host, 'https://i-magic-service.letsmagic.cn')
  assert.equal(cn.webOrigin, 'https://www.letsmagic.cn')
  assert.equal(cn.needsOrg, false)
  assert.equal(intl.host, 'https://magic-service.magicrew.ai')
  assert.equal(intl.webOrigin, 'https://www.magicrew.ai')
  assert.equal(intl.needsOrg, true, '国际站必须强制 org')
  assert.equal(magicrewProductOf('nope'), null)
  assert.equal(MAGICREW_PRODUCTS.magicrew.dailyGift, 200)
  assert.equal(MAGICREW_PRODUCTS.magicrewintl.dailyGift, 50)
  console.log('ok 1/8 产品表')
}

/* ── 2. 请求头 ──────────────────────────────────────────────────────────── */

{
  const headers = magicrewHeaders(MAGICREW_PRODUCTS.magicrewintl, { token: 'JWT', organizationCode: 'ORG' })
  assert.equal(headers.origin, 'https://www.magicrew.ai')
  assert.equal(headers.referer, 'https://www.magicrew.ai/', 'referer 必须带尾斜杠（WAF 判来源）')
  assert.equal(headers.authorization, 'Bearer JWT')
  assert.equal(headers['organization-code'], 'ORG')
  assert.equal(headers['content-type'], 'application/json')

  // 没有令牌时不许出现空 Bearer
  const bare = magicrewHeaders(MAGICREW_PRODUCTS.magicrew, {})
  assert.equal(bare.authorization, undefined)
  assert.equal(bare['organization-code'], undefined)
  console.log('ok 2/8 请求头')
}

import { completeMagicrewLogin } from '../src/channels/magicrew.js'

/* ── 3. 签 key / 续签 ───────────────────────────────────────────────────── */

{
  const ok = await issueGatewayKey(MAGICREW_PRODUCTS.magicrew, {
    jwt: 'JWT', organizationCode: 'ORG',
    fetch: async (url, init) => {
      assert.equal(url, 'https://i-magic-service.letsmagic.cn/api/v1/model-gateway/tokens')
      assert.equal(init.method, 'POST')
      assert.equal(init.body, '{}')
      assert.equal(init.headers.authorization, 'Bearer JWT')
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 1000, data: { api_key: 'mgw_x', refresh_token: 'rt1', api_key_expires_at: 1800000000000, refresh_token_expires_at: 1800600000000 } }) }
    },
  })
  assert.equal(ok.key.apiKey, 'mgw_x')
  assert.equal(ok.key.refreshToken, 'rt1')
  assert.equal(ok.key.apiKeyExpiresAt, 1800000000000)

  const missing = await issueGatewayKey(MAGICREW_PRODUCTS.magicrew, {
    jwt: 'JWT', organizationCode: '', fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 1000, data: {} }) }),
  })
  assert.match(missing.error, /api_key/)

  // 续签：PUT、只带 refresh_token、**不带 Authorization**
  const refreshed = await refreshGatewayKey(MAGICREW_PRODUCTS.magicrew, {
    refreshToken: 'rt1',
    fetch: async (url, init) => {
      assert.equal(init.method, 'PUT')
      assert.deepEqual(JSON.parse(init.body), { refresh_token: 'rt1' })
      assert.equal(init.headers.authorization, undefined, '续签不许带 JWT（JWT 过期时这条腿还得能用）')
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 1000, data: { api_key: 'mgw_y', refresh_token: 'rt2' } }) }
    },
  })
  assert.equal(refreshed.key.apiKey, 'mgw_y')
  assert.equal(refreshed.key.refreshToken, 'rt2')

  // 完整登录：JWT + org → 签 key → 凭据
  const done = await completeMagicrewLogin(MAGICREW_PRODUCTS.magicrew, {
    jwt: 'JWT', organizationCode: 'ORG',
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 1000, data: { api_key: 'mgw_z' } }) }),
  })
  assert.equal(done.credential.jwt, 'JWT')
  assert.equal(done.credential.organizationCode, 'ORG')
  assert.equal(done.credential.apiKey, 'mgw_z')
  assert.equal(done.credential.provider, 'magicrew')
  console.log('ok 3/8 签 key / 续签')
}

/* ── 4. 积分 ────────────────────────────────────────────────────────────── */

{
  const stringTotal = await fetchPoints(MAGICREW_PRODUCTS.magicrew, { jwt: 'J', organizationCode: '', fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 1000, data: { total_points: '1093' } }) }) })
  assert.equal(stringTotal.total, 1093)

  // 负数（欠费）必须认，不能吞
  const negative = await fetchPoints(MAGICREW_PRODUCTS.magicrew, { jwt: 'J', organizationCode: '', fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 1000, data: { total_points: -31 } }) }) })
  assert.equal(negative.total, -31)

  const missing = await fetchPoints(MAGICREW_PRODUCTS.magicrew, { jwt: 'J', organizationCode: '', fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 1000, data: {} }) }) })
  assert.match(missing.error, /total_points/)

  // 国际站缺 org：2182
  const noOrg = await fetchPoints(MAGICREW_PRODUCTS.magicrewintl, { jwt: 'J', organizationCode: '', fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 2182, message: '用户所在组织不存在' }) }) })
  assert.equal(noOrg.needsOrg, true)
  assert.match(noOrg.error, /组织/)
  console.log('ok 4/8 积分')
}

/* ── 5. 签到 ────────────────────────────────────────────────────────────── */

{
  const claimed = await claimLoginGift(MAGICREW_PRODUCTS.magicrew, {
    jwt: 'J', organizationCode: '',
    fetch: async (url, init) => {
      assert.equal(url, 'https://i-magic-service.letsmagic.cn/api/v1/login-gift')
      assert.equal(init.method, 'POST')
      assert.equal(init.body, '', '请求体必须存在且为空串')
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 1000, data: { granted: true, point_amount: 200 } }) }
    },
  })
  assert.equal(claimed.kind, 'claimed')
  assert.equal(claimed.credit, 200)

  const already = await claimLoginGift(MAGICREW_PRODUCTS.magicrew, {
    jwt: 'J', organizationCode: '',
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 1000, data: { granted: false, point_amount: 0 } }) }),
  })
  assert.equal(already.kind, 'already-claimed', 'granted!==true 是已领，不是失败')

  const failed = await claimLoginGift(MAGICREW_PRODUCTS.magicrew, {
    jwt: 'J', organizationCode: '',
    fetch: async () => ({ ok: false, status: 500, text: async () => 'not json' }),
  })
  assert.equal(failed.kind, 'failed')
  console.log('ok 5/8 签到')
}

/* ── 6. 新手任务 ────────────────────────────────────────────────────────── */

{
  const listing = await fetchOnboarding(MAGICREW_PRODUCTS.magicrew, {
    jwt: 'J', organizationCode: '',
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 1000, data: { tasks: [{ code: 'profile', title: '完善资料', points: 50, status: 'PENDING', reward_status: 'NONE' }] } }) }),
  })
  assert.equal(listing.tasks.length, 1)
  assert.equal(listing.tasks[0].points, 50)

  const done = await completeOnboarding(MAGICREW_PRODUCTS.magicrew, 'profile', {
    jwt: 'J', organizationCode: '',
    fetch: async (url, init) => {
      assert.equal(url, 'https://i-magic-service.letsmagic.cn/api/v1/onboarding/tasks/profile/completion')
      assert.equal(init.method, 'PUT')
      assert.equal(init.body, '{}')
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 1000, data: { points: 50 } }) }
    },
  })
  assert.equal(done.kind, 'claimed')
  assert.equal(done.credit, 50)
  console.log('ok 6/8 新手任务')
}

/* ── 7. localStorage 收割 ───────────────────────────────────────────────── */

{
  assert.match(MAGICREW_HARVEST_EXPRESSION, /MAGIC:user:authorization/)
  assert.match(MAGICREW_HARVEST_EXPRESSION, /localStorage\.length/)

  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig'
  const parsed = parseMagicrewHarvest({ a: jwt, o: 'ORG', n: 2 })
  assert.deepEqual(parsed, { jwt, organizationCode: 'ORG' })

  // 前缀键 + 同前缀 org 配对
  const prefixed = parseMagicrewHarvest({ ao: jwt, oo: 'ORG2', n: 2 })
  assert.deepEqual(prefixed, { jwt, organizationCode: 'ORG2' })

  // 空 localStorage（还没登完）
  assert.equal(parseMagicrewHarvest({ a: null, o: null, n: 0 }), undefined)
  // 形状不对
  assert.equal(parseMagicrewHarvest({ a: 'not-a-jwt', o: 'ORG', n: 1 }), undefined)

  // 续签判据：只剩 20 分钟才续
  assert.equal(shouldRefreshKey({ apiKeyExpiresAt: Date.now() + 20 * 60_000 }), true)
  assert.equal(shouldRefreshKey({ apiKeyExpiresAt: Date.now() + 90 * 60_000 }), false)
  assert.equal(shouldRefreshKey({}), false)
  console.log('ok 7/8 收割与续签判据')
}

/* ── 8. 权益扩展 ────────────────────────────────────────────────────────── */

{
  const credential = { jwt: 'J', organizationCode: 'ORG', apiKey: 'mgw', apiKeyExpiresAt: Date.now() + 90 * 60_000, provider: 'magicrew' }
  let persisted = 0
  const extras = createMagicrewExtras({
    product: MAGICREW_PRODUCTS.magicrew,
    credentialOf: async () => credential,
    persist: async () => { persisted += 1 },
    fetch: async url => {
      if (url.endsWith('/flows/models')) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 1000, data: { models: [{ id: 'glm-5.3', name: 'GLM 5.3', context_window: 204800 }] } }) }
      if (url.endsWith('/quota/points/total')) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 1000, data: { total_points: 1093 } }) }
      if (url.endsWith('/onboarding/tasks')) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 1000, data: { tasks: [] } }) }
      if (url.endsWith('/login-gift')) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 1000, data: { granted: true, point_amount: 200 } }) }
      throw new Error(`未预期请求 ${url}`)
    },
  })
  const status = await extras.statusOf({ id: 'magicrew-1', nickname: 'n' })
  assert.equal(status.source, 'live')
  assert.equal(status.catalog.length, 1)
  assert.equal(status.balance.total, 1093)
  assert.equal(persisted, 0, '未到续签窗口不许动 key')

  const outcome = await extras.claim({ id: 'magicrew-1' })
  assert.equal(outcome.kind, 'claimed')
  assert.equal(outcome.credit, 200)
  console.log('ok 8/8 权益扩展')
}

console.log('magicrew channel OK: 8 组断言全部通过')
