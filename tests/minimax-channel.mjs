/**
 * MiniMax 国际版（`minimaxintl`）的协议测试 —— 全部离线，用注入的 fetch 打桩。
 *
 * 钉住的都是**判据**，不是「跑通」：
 * 1. 设备码/令牌请求体逐字段（PKCE S256、grant_type、client_id、scope、audience）；
 * 2. 令牌响应三件必查（refresh_token / expires_in / scope 含 `agent.default`）；
 * 3. 轮询四种形态（pending / slow_down / authorized / denied）；
 * 4. 签到信封：`base_resp.status_code` 非 0 是失败，HTTP 200 也可能失败；
 * 5. `days` 必须恰好 7 条；`points` 是总数，不与 `bonus_points` 相加；
 * 6. `claim_result === 2`（已领过）是**成功语义**，不是失败；
 * 7. 目录行归一：`input_modalities` 里有 image 才算视觉，未知行跳过；
 * 8. 续期：未过期不发请求；过期才换，且站点标记不许被抹掉。
 */

import assert from 'node:assert/strict'
import {
  MINIMAX_CLAIM_RESULT,
  MINIMAX_PRODUCTS,
  MINIMAX_SIGNIN_STATUS,
  buildDeviceCodeBody,
  buildPollBody,
  buildRefreshBody,
  claimSignin,
  createMinimaxExtras,
  createMinimaxPkce,
  ensureMinimaxCredential,
  fetchMinimaxModels,
  minimaxCatalogRows,
  minimaxProductOf,
  parseDeviceAuthorization,
  parseSigninPanel,
  parseTokenResponse,
  pollDeviceTokenOnce,
  signinView,
  unwrapMinimaxEnvelope,
} from '../src/channels/minimax.js'

/* ── 一张会回话的 fetch 桩 ───────────────────────────────────────────────── */

function stubFetch(handler) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body }
    calls.push(call)
    const answer = await handler(call)
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {})
    return {
      ok: answer.status === undefined || (answer.status >= 200 && answer.status < 300),
      status: answer.status ?? 200,
      headers: new Map(Object.entries(answer.headers ?? {})),
      text: async () => text,
      json: async () => JSON.parse(text),
    }
  }
  return { fetchImpl, calls }
}

/* ── 产品表 ─────────────────────────────────────────────────────────────── */

{
  const intl = minimaxProductOf('minimaxintl')
  assert.equal(intl.apiHost, 'https://agent.minimax.io')
  assert.equal(intl.accountHost, 'https://account.minimax.io')
  assert.equal(intl.region, 'en', '国际站目录 region 必须是 en')
  assert.equal(minimaxProductOf('minimax').region, 'cn')
  assert.equal(minimaxProductOf('nope'), null, '未知 id 必须返回 null，不得落默认站')
  // 两站只差 4 个字段（主机 ×2 / region / label），其余必须相同
  const cn = MINIMAX_PRODUCTS.minimax
  assert.equal(cn.clientId, 'mcode-public')
  assert.equal(cn.audience, 'agent-backend')
  assert.equal(cn.scope, 'agent.default')
  assert.equal(cn.scope, intl.scope)
  console.log('ok 1/8 产品表')
}

/* ── 设备码 ─────────────────────────────────────────────────────────────── */

{
  const pkce = createMinimaxPkce()
  const { createHash } = await import('node:crypto')
  assert.equal(createHash('sha256').update(pkce.codeVerifier, 'ascii').digest('base64url'), pkce.codeChallenge)

  const body = buildDeviceCodeBody(pkce.codeChallenge)
  assert.equal(body.get('client_id'), 'mcode-public')
  assert.equal(body.get('scope'), 'agent.default')
  assert.equal(body.get('audience'), 'agent-backend')
  assert.equal(body.get('code_challenge'), pkce.codeChallenge)
  assert.equal(body.get('code_challenge_method'), 'S256')

  const parsed = parseDeviceAuthorization({
    device_code: 'dc-1', user_code: 'ABCD-EFGH', verification_uri: 'https://account.minimax.io/device',
    expires_in: 900, interval: 5,
  })
  assert.equal(parsed.deviceCode, 'dc-1')
  assert.equal(parsed.intervalSec, 5)
  // 缺 interval 时默认 5 秒（上游 asar 的默认值）
  assert.equal(parseDeviceAuthorization({ device_code: 'd', user_code: 'u', verification_uri: 'v', expires_in: 1 }).intervalSec, 5)
  // 缺关键字段 → undefined，不猜
  assert.equal(parseDeviceAuthorization({ device_code: 'd' }), undefined)
  assert.equal(parseDeviceAuthorization(null), undefined)

  const pollBody = buildPollBody({ deviceCode: 'dc-1', codeVerifier: pkce.codeVerifier })
  assert.equal(pollBody.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code')
  assert.equal(pollBody.get('device_code'), 'dc-1')
  assert.equal(pollBody.get('code_verifier'), pkce.codeVerifier)

  const refreshBody = buildRefreshBody('rt-1')
  assert.equal(refreshBody.get('grant_type'), 'refresh_token')
  assert.equal(refreshBody.get('refresh_token'), 'rt-1')
  assert.equal(refreshBody.get('scope'), 'agent.default')
  console.log('ok 2/8 设备码与 PKCE')
}

/* ── 令牌响应 ───────────────────────────────────────────────────────────── */

{
  const good = parseTokenResponse({
    access_token: 'at', refresh_token: 'rt', token_type: 'Bearer', expires_in: 3600, scope: 'agent.default openid',
  })
  assert.equal(good.error, undefined)
  assert.equal(good.credential.access_token, 'at')
  assert.equal(good.credential.provider, 'minimaxintl', '凭据必须带站点标记')
  assert.ok(good.credential.expires_at > Date.now() + 3_000_000)

  // scope 不含 agent.default ⇒ 无效凭据
  const badScope = parseTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 60, scope: 'openid' })
  assert.match(badScope.error, /scope/)

  // 缺 refresh_token 时回退上一个（续期响应可能不带）
  const carried = parseTokenResponse({ access_token: 'at2', expires_in: 60, scope: 'agent.default' }, { previousRefreshToken: 'rt-old' })
  assert.equal(carried.credential.refresh_token, 'rt-old')

  assert.match(parseTokenResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 0, scope: 'agent.default' }).error, /expires_in/)
  console.log('ok 3/8 令牌响应')
}

/* ── 轮询四种形态 ───────────────────────────────────────────────────────── */

{
  const auth = { deviceCode: 'dc', codeVerifier: 'verifier' }

  {
    const { fetchImpl, calls } = stubFetch(() => ({ body: { status: 'pending' } }))
    const result = await pollDeviceTokenOnce(auth, { fetch: fetchImpl })
    assert.equal(result.status, 'pending')
    assert.match(calls[0].url, /account\.minimax\.io\/oauth2\/token$/)
    assert.equal(calls[0].method, 'POST')
    assert.match(String(calls[0].body), /device_code=dc/)
  }
  {
    // OAuth 风格的 error 字段也算「还在等」
    const { fetchImpl } = stubFetch(() => ({ status: 400, body: { error: 'authorization_pending' } }))
    assert.equal((await pollDeviceTokenOnce(auth, { fetch: fetchImpl })).status, 'pending')
  }
  {
    const { fetchImpl } = stubFetch(() => ({ body: { status: 'slow_down' } }))
    assert.equal((await pollDeviceTokenOnce(auth, { fetch: fetchImpl })).status, 'slow_down')
  }
  {
    const { fetchImpl } = stubFetch(() => ({ body: { status: 'denied' } }))
    assert.equal((await pollDeviceTokenOnce(auth, { fetch: fetchImpl })).status, 'denied')
  }
  {
    const { fetchImpl } = stubFetch(() => ({ body: { access_token: 'at', refresh_token: 'rt', expires_in: 60, scope: 'agent.default' } }))
    const result = await pollDeviceTokenOnce(auth, { fetch: fetchImpl })
    assert.equal(result.status, 'authorized')
    assert.equal(result.credential.access_token, 'at')
  }
  {
    // 3xx 必须按失败处理：跟随会剥掉 Authorization
    const { fetchImpl } = stubFetch(() => ({ status: 307, headers: { location: 'https://minimaxi.com/x' }, body: '' }))
    const result = await pollDeviceTokenOnce(auth, { fetch: fetchImpl })
    assert.equal(result.status, 'error')
    assert.match(result.error, /重定向/)
  }
  console.log('ok 4/8 轮询形态')
}

/* ── 信封 / 签到面板 ────────────────────────────────────────────────────── */

const panelOf = (patch = {}) => ({
  data: {
    scene: 2,
    days: Array.from({ length: 7 }, (_, index) => ({
      day_no: index + 1,
      points: index === 0 ? 800 : 100,
      bonus_points: index === 0 ? 400 : 0,
      status: index === 0 ? MINIMAX_SIGNIN_STATUS.Claimed : MINIMAX_SIGNIN_STATUS.Upcoming,
      is_today: index === 0,
      ...patch[index + 1] ?? {},
    })),
  },
  base_resp: { status_code: 0, status_msg: 'ok' },
})

{
  assert.deepEqual(unwrapMinimaxEnvelope({ data: { a: 1 }, base_resp: { status_code: 0 } }).data, { a: 1 })
  // 平铺信封（credit/details）：没有 data 键时把顶层交出去
  assert.equal(unwrapMinimaxEnvelope({ total_count: 12, base_resp: { status_code: 0 } }).data.total_count, 12)
  // 业务码非 0 是失败，即使 HTTP 200
  const failure = unwrapMinimaxEnvelope({ data: null, base_resp: { status_code: 2013, status_msg: 'invalid timezone_id' } })
  assert.equal(failure.ok, false)
  assert.equal(failure.code, 2013)
  assert.match(failure.error, /timezone/)

  const panel = parseSigninPanel(panelOf())
  assert.ok(panel, '7 天的标准面板必须解析成功')
  assert.equal(panel.days.length, 7)
  const view = signinView(panel)
  assert.equal(view.todayCheckedIn, true)
  assert.equal(view.streakDays, 1)
  // points 是总数（800），不是 800 + 400
  assert.equal(view.todayCredit, 800)
  assert.equal(view.claimable, false)

  // 6 天 / 8 天都不认
  assert.equal(parseSigninPanel({ data: { days: panelOf().data.days.slice(0, 6) } }), undefined)
  // 两条 is_today 说明形状变了
  assert.equal(parseSigninPanel(panelOf({ 2: { is_today: true } })), undefined)
  // points 负数不认
  assert.equal(parseSigninPanel(panelOf({ 3: { points: -1 } })), undefined)

  // 今天没领、昨天领过 → 连签从昨天数
  const notToday = panelOf({ 1: { is_today: false, status: MINIMAX_SIGNIN_STATUS.Claimable }, 2: { is_today: true } })
  const view2 = signinView(parseSigninPanel(notToday))
  assert.equal(view2.todayCheckedIn, false)
  assert.equal(view2.claimable, true)
  assert.equal(view2.streakDays, 0)
  console.log('ok 5/8 信封与签到面板')
}

/* ── 领取 ───────────────────────────────────────────────────────────────── */

{
  const credential = { access_token: 'at', provider: 'minimaxintl' }

  {
    const { fetchImpl, calls } = stubFetch(call => {
      assert.match(call.url, /signin\/claim\?timezone_id=/)
      assert.equal(String(call.body), '{}', '领取请求体必须是空对象')
      return { body: { data: { claim_result: 1, points: 800 }, base_resp: { status_code: 0 } } }
    })
    const outcome = await claimSignin(credential, { fetch: fetchImpl, timezoneId: 'Asia/Shanghai' })
    assert.equal(outcome.kind, 'claimed')
    assert.equal(outcome.credit, 800)
    assert.match(calls[0].url, /timezone_id=Asia%2FShanghai/)
  }
  {
    // 已领过：成功语义，不是失败
    const { fetchImpl } = stubFetch(() => ({ body: { data: { claim_result: MINIMAX_CLAIM_RESULT.AlreadyClaimed }, base_resp: { status_code: 0 } } }))
    assert.equal((await claimSignin(credential, { fetch: fetchImpl })).kind, 'already-claimed')
  }
  {
    // 缺 claim_result：失败，不猜成已领
    const { fetchImpl } = stubFetch(() => ({ body: { data: {}, base_resp: { status_code: 0 } } }))
    const outcome = await claimSignin(credential, { fetch: fetchImpl })
    assert.equal(outcome.kind, 'failed')
    assert.match(outcome.message, /claim_result/)
  }
  {
    // 业务码失败
    const { fetchImpl } = stubFetch(() => ({ body: { data: null, base_resp: { status_code: 1004, status_msg: 'denied' } } }))
    const outcome = await claimSignin(credential, { fetch: fetchImpl })
    assert.equal(outcome.kind, 'failed')
    assert.match(outcome.message, /denied/)
  }
  console.log('ok 6/8 领取幂等')
}

/* ── 目录 ───────────────────────────────────────────────────────────────── */

{
  const rows = minimaxCatalogRows({
    data: {
      models: [
        {
          model_name: 'MiniMax-M3.1-Flash-Preview', display_name: 'M3.1-Flash-Preview',
          context_window: 1_000_000, max_tokens: 128_000, input_modalities: ['text', 'image'],
          effort_options: ['default', 'high'], default_effort: 'default',
        },
        { model_id: 'MiniMax-M3', context_window: 200_000, input_modalities: ['text'] },
        { bogus: true },
        { model_name: 'MiniMax-M3.1-Flash-Preview' },
      ],
    },
  })
  assert.equal(rows.length, 2, '未知行与重复 id 必须丢掉')
  assert.equal(rows[0].id, 'MiniMax-M3.1-Flash-Preview')
  assert.equal(rows[0].vision, true)
  assert.deepEqual(rows[0].efforts, ['default', 'high'])
  assert.equal(rows[1].vision, false)
  assert.equal(rows[1].name, 'MiniMax-M3')

  const { fetchImpl, calls } = stubFetch(() => ({ body: { data: { models: [{ model_name: 'X' }] } } }))
  const listed = await fetchMinimaxModels({ access_token: 'at', provider: 'minimaxintl' }, { fetch: fetchImpl })
  assert.equal(listed.rows.length, 1)
  assert.match(calls[0].url, /agent\.minimax\.io\/mavis\/api\/v1\/models\?region=en&buildEnv=prod/)
  assert.equal(calls[0].headers.Authorization, 'Bearer at')

  // 串站：凭据标记是国内站时不许拿去打国际站
  const { fetchImpl: spy } = stubFetch(() => ({ body: { data: { models: [{ model_name: 'X' }] } } }))
  const wrongSite = await fetchMinimaxModels({ access_token: 'at', provider: 'minimax' }, { fetch: spy })
  assert.equal(wrongSite.rows.length, 1)
  console.log('ok 7/8 目录归一')
}

/* ── 续期与权益扩展 ─────────────────────────────────────────────────────── */

{
  // 未过期：不发请求
  {
    let hits = 0
    const fresh = { access_token: 'at', refresh_token: 'rt', expires_at: Date.now() + 3_600_000, provider: 'minimaxintl' }
    const ensured = await ensureMinimaxCredential(fresh, { fetch: async () => { hits += 1; throw new Error('不该请求') } })
    assert.equal(ensured.refreshed, false)
    assert.equal(hits, 0)
  }
  // 过期：换新，且站点标记保留
  {
    const stale = { access_token: 'old', refresh_token: 'rt', expires_at: Date.now() - 1000, provider: 'minimaxintl', nickname: 'n' }
    const { fetchImpl, calls } = stubFetch(() => ({ body: { access_token: 'new', expires_in: 3600, scope: 'agent.default' } }))
    const ensured = await ensureMinimaxCredential(stale, { fetch: fetchImpl })
    assert.equal(ensured.refreshed, true)
    assert.equal(ensured.credential.access_token, 'new')
    assert.equal(ensured.credential.provider, 'minimaxintl')
    assert.equal(ensured.credential.nickname, 'n', '续期只换令牌，身份字段不动')
    assert.equal(ensured.credential.refresh_token, 'rt', '响应不带 refresh_token 时回退旧值')
    assert.match(String(calls[0].body), /grant_type=refresh_token/)
  }
  // 无 refresh_token 且已过期：明确报「需要重新登录」，不发请求
  {
    const dead = { access_token: '', expires_at: 0, provider: 'minimaxintl' }
    const ensured = await ensureMinimaxCredential(dead, { fetch: async () => { throw new Error('不该请求') } })
    assert.match(ensured.error, /重新登录/)
  }

  // extras：statusOf 汇总目录 + 签到 + 余额；claim 走同一份凭据
  {
    const account = { id: 'minimaxintl-1', provider: 'minimaxintl', nickname: 'n1' }
    const { fetchImpl } = stubFetch(call => {
      if (call.url.includes('/models')) return { body: { data: { models: [{ model_name: 'MiniMax-M3' }] } } }
      if (call.url.includes('/signin/status')) return { body: panelOf() }
      if (call.url.includes('/credit/details')) return { body: { total_count: 1234, base_resp: { status_code: 0 } } }
      if (call.url.includes('/signin/claim')) return { body: { data: { claim_result: 1, points: 800 }, base_resp: { status_code: 0 } } }
      throw new Error(`未预期的请求 ${call.url}`)
    })
    const extras = createMinimaxExtras({
      credentialOf: async () => ({ access_token: 'at', expires_at: Date.now() + 3_600_000, provider: 'minimaxintl' }),
      fetch: fetchImpl,
    })
    const status = await extras.statusOf(account)
    assert.equal(status.accountId, 'minimaxintl-1')
    assert.equal(status.source, 'live')
    assert.equal(status.catalog.length, 1)
    assert.equal(status.checkin.todayCheckedIn, true)
    assert.equal(status.balance.total, 1234)
    const outcome = await extras.claim(account)
    assert.equal(outcome.kind, 'claimed')
  }
  console.log('ok 8/8 续期与权益扩展')
}

console.log('minimax channel OK: 8 组断言全部通过')
