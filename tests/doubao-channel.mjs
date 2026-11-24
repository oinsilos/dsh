/**
 * 豆包（`doubao`）渠道的离线测试 —— **不起浏览器、不出网**。
 *
 * 钉住的是判据，不是外观：
 * 1. 设备身份：**确定性派生 + 每账号一套**，19 位数字；凭据里存的 verify 形态 id 不算数；
 * 2. cookie 工具：`sessionid` 提取、`name=value` 拆分、CDP cookie 列表 → 请求头（含域过滤）；
 * 3. query 契约：活动腿 `aid=497858` / 网页腿 `aid=582478` + `fp=verify_<device_id>`；
 *    `a_bogus` **只在签到 URL 上**，且做 URL 编码；
 * 4. 签名表达式：**把那段脚本真跑一遍**（`bdms` 未注入 → 空串 = 「还没加载完」，不是错误）；
 * 5. 签到响应分类：`reward_amount>0` 才是「本次领到」，`710010702` 是 `inactive`；
 * 6. 额度：千分位字符串、`"<1"` 阈值、两处 section 都要读；
 * 7. 领取全链路（注入假会话）：注入 cookie → 页面签名 → Node 侧带签名发请求；
 * 8. 三份清单（宿主登录集合 / 宿主入口表 / 面板 CDP 集合）必须逐条对齐。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  DOUBAO,
  DOUBAO_SIGN_EXPRESSION,
  classifyDoubaoCheckin,
  claimDoubaoDaily,
  createDoubaoExtras,
  doubaoAmount,
  doubaoCheckinQuery,
  doubaoCheckinStatusUrl,
  doubaoCheckinUrl,
  doubaoCookieHeaderFromList,
  doubaoDerivedDeviceIdentity,
  doubaoDeviceIdentityOf,
  doubaoHeaders,
  doubaoQuotaSummary,
  doubaoQuotaUrl,
  doubaoQuotaWindows,
  doubaoQueryString,
  doubaoWebQuery,
  fetchDoubaoCheckinStatus,
  fetchDoubaoQuota,
  injectDoubaoCookies,
  parseDoubaoCookieHeader,
  postDoubaoCheckin,
  sessionIdFromCookie,
} from '../src/channels/doubao.js'
import { OWN_PROVIDERS } from '../src/channels/accounts.js'
import { createChannelExtras } from '../src/channels/index.js'
import { buildOwnCatalog } from '../src/channels/catalog.js'

const jsonResponse = payload => ({ ok: true, status: 200, async text() { return JSON.stringify(payload) } })

/* ── 1. 设备身份 ─────────────────────────────────────────────────────────── */

{
  const a = doubaoDerivedDeviceIdentity('session-AAAA')
  const b = doubaoDerivedDeviceIdentity('session-AAAA')
  const other = doubaoDerivedDeviceIdentity('session-BBBB')
  assert.deepEqual(a, b, '同账号必须派生同一套设备号（跨日稳定）')
  assert.notEqual(a.deviceId, other.deviceId, '不同账号必须天然不同设备')
  for (const key of ['deviceId', 'webId', 'teaUuid']) {
    assert.match(a[key], /^\d{19}$/, `${key} 必须是 19 位数字（对齐抓包形态）`)
  }
  assert.notEqual(a.deviceId, a.webId, '三条设备号不能退化成同一个值')

  // accountKey 缺席时用 cookie 里的 sessionid 当种子
  const fromCookie = doubaoDeviceIdentityOf({ cookie: 'ttwid=x; sessionid=SID-1; sid_tt=y' })
  assert.deepEqual(fromCookie, doubaoDerivedDeviceIdentity('SID-1'))

  // 显式设备号：合法 15–21 位数字照用；verify 形态 / ttwid 一律回落派生
  const explicit = doubaoDeviceIdentityOf({ accountKey: 'k', deviceId: '1234567890123456789', webId: 'verify_abc' })
  assert.equal(explicit.deviceId, '1234567890123456789')
  assert.equal(explicit.webId, doubaoDerivedDeviceIdentity('k').webId, 'verify 前缀不是注册形态，必须回落派生')

  const short = doubaoDeviceIdentityOf({ accountKey: 'k', deviceId: '12345' })
  assert.equal(short.deviceId, doubaoDerivedDeviceIdentity('k').deviceId, '不足 15 位的数字不算设备号')
  console.log('ok 1/8 设备身份')
}

/* ── 2. cookie 工具 ─────────────────────────────────────────────────────── */

{
  assert.equal(sessionIdFromCookie('a=1; sessionid=S-9 ; b=2'), 'S-9')
  assert.equal(sessionIdFromCookie('sessionid='), undefined, '空值等于没有 sessionid')
  assert.equal(sessionIdFromCookie('sid_tt=x'), undefined)
  assert.equal(sessionIdFromCookie(undefined), undefined)

  assert.deepEqual(parseDoubaoCookieHeader('a=1;;b=2; =bad; c='), [['a', '1'], ['b', '2']])

  const header = doubaoCookieHeaderFromList([
    { name: 'sessionid', value: 'S', domain: '.doubao.com' },
    { name: 'msToken', value: 'M', domain: '.bytedance.com' },
    { name: 'evil', value: 'E', domain: '.example.com' },
    { name: 'sessionid', value: 'dup', domain: '.doubao.com' },
    { name: '', value: 'x', domain: '.doubao.com' },
  ])
  assert.equal(header, 'sessionid=S; msToken=M', '只收豆包/字节域，且同名不重复')
  console.log('ok 2/8 cookie 工具')
}

/* ── 3. query 与 URL ────────────────────────────────────────────────────── */

{
  const credential = { cookie: 'sessionid=SID-2', accountKey: 'SID-2' }
  const { deviceId, webId, teaUuid } = doubaoDeviceIdentityOf(credential)
  const pairs = doubaoCheckinQuery(credential)
  const asObject = Object.fromEntries(pairs)
  assert.equal(asObject.aid, '497858', '活动腿的 aid')
  assert.equal(asObject.device_id, deviceId)
  assert.equal(asObject.web_id, webId)
  assert.equal(asObject.tea_uuid, teaUuid)
  assert.equal(pairs[0][0], 'version_code', '顺序即上游字节序：首项是 version_code')
  assert.equal(pairs.at(-1)[0], 'use-olympus-account')

  const web = Object.fromEntries(doubaoWebQuery(credential))
  assert.equal(web.aid, '582478', '网页腿的 aid 与活动腿不同，别混')
  assert.equal(web.fp, `verify_${deviceId}`)
  assert.equal(web.tz_name, 'Asia/Shanghai')
  assert.match(web.web_tab_id, /^[0-9a-f-]{36}$/, '每次请求一个 tab id')

  const query = doubaoQueryString(doubaoCheckinQuery(credential))
  assert.ok(query.includes('use-olympus-account=1'), '连字符不是需要编码的字符')
  assert.equal(doubaoQueryString([['a', 'Asia/Shanghai']]), 'a=Asia%2FShanghai', '斜杠必须编码（抓包形态）')

  const plain = doubaoCheckinUrl(credential, '')
  assert.ok(plain.startsWith(`${DOUBAO.baseUrl}${DOUBAO.checkinPath}?`))
  assert.ok(!plain.includes('a_bogus'), '没签名时不许出现空的 a_bogus 参数')
  const signed = doubaoCheckinUrl(credential, 'a+b/c=')
  assert.ok(signed.endsWith(`&a_bogus=${encodeURIComponent('a+b/c=')}`), '签名追加在最后并做编码')

  const statusUrl = doubaoCheckinStatusUrl(credential)
  assert.ok(statusUrl.startsWith(`${DOUBAO.baseUrl}${DOUBAO.checkinStatusPath}?`))
  assert.ok(!statusUrl.includes('a_bogus'), '状态腿不签名')

  const quotaUrl = doubaoQuotaUrl(credential)
  assert.ok(quotaUrl.startsWith(`${DOUBAO.baseUrl}${DOUBAO.quotaPath}?`))
  assert.ok(quotaUrl.includes('aid=582478') && quotaUrl.includes('fp=verify_' + deviceId))
  assert.ok(!quotaUrl.includes('a_bogus'), '额度腿不签名')

  const headers = doubaoHeaders('sid=1')
  assert.equal(headers.Referer, 'chrome://doubao-chat/', '客户端形态的 Referer，不是网页地址')
  assert.ok(headers['User-Agent'].includes('SamanthaDoubao/'), 'UA 必须带客户端标记')
  assert.equal(headers['agw-js-conv'], 'str')
  assert.equal(headers.cookie, 'sid=1')
  console.log('ok 3/8 query 与 URL')
}

/* ── 4. 签名表达式（真跑一遍，别只比文本） ──────────────────────────────── */

{
  // 表达式用的是全局 `window`；把它当形参传进沙箱，就能在不碰真实全局的情况下跑。
  const run = window => new Function('window', `return ${DOUBAO_SIGN_EXPRESSION}`)(window)

  assert.equal(run({}), '', 'bdms 未注入 ⇒ 空串（还没加载完，不是错误）')
  assert.equal(run({ bdms: {} }), '', 'bdms 存在但没有 frontierSign ⇒ 空串')
  assert.equal(run({ bdms: { frontierSign: () => ({ 'X-Bogus': 'BOGUS-1' }) } }), 'BOGUS-1', '官方形态：取 X-Bogus')
  assert.equal(run({ bdms: { frontierSign: () => 'RAW-STRING' } }), 'RAW-STRING', '返回字符串时原样用')
  assert.equal(run({ bdms: { frontierSign: () => ({ a_bogus: 'AB' }) } }), 'AB', 'a_bogus 键也要吃')
  assert.equal(run({ bdms: { frontierSign: () => ({}) } }), '', '返回值里没有签名 ⇒ 空串')
  assert.equal(run({ bdms: { frontierSign: () => { throw new Error('boom') } } }), '', '签名抛错 ⇒ 空串（继续轮询）')
  assert.equal(run({ bdms: { frontierSign: () => null } }), '', 'null 也要能撑住')

  // 调用口径：上游是 `frontierSign({'X-MS-STUB': ''})`，别改成裸路径
  let received
  run({ bdms: { frontierSign: arg => { received = arg; return { 'X-Bogus': 'x' } } } })
  assert.deepEqual(received, { 'X-MS-STUB': '' }, '签名入参必须是 X-MS-STUB 桩对象')
  console.log('ok 4/8 签名表达式')
}

/* ── 5. 签到响应分类 ───────────────────────────────────────────────────── */

{
  const claimed = classifyDoubaoCheckin({ code: 0, data: { checked_in: true, idempotent: true, reward_amount: 200, continuous_days: 2 } })
  assert.equal(claimed.kind, 'claimed')
  assert.equal(claimed.credit, 200)
  assert.equal(claimed.streakDays, 2, '连续天数要带出来（面板文案用）')

  // ⚠️ `idempotent:true` 在**首次成功**时也是 true ⇒ 判据只能是 reward_amount
  const replay = classifyDoubaoCheckin({ code: 0, data: { checked_in: true, idempotent: true } })
  assert.equal(replay.kind, 'already-claimed', '没有奖励额度 = 今天已经签过（不是又领了一次）')

  const inactive = classifyDoubaoCheckin({ code: 710010702, message: '系统错误' })
  assert.equal(inactive.kind, 'inactive', '710010702 是「没有可领活动」，不是故障')
  assert.ok(inactive.message.includes('签到活动'))

  const failed = classifyDoubaoCheckin({ code: 999, message: '上游说得很难听' })
  assert.equal(failed.kind, 'failed')
  assert.equal(failed.message, '上游说得很难听', '上游文案优先，别用我们的话盖掉')

  assert.equal(classifyDoubaoCheckin({ code: 0, data: { checked_in: false } }).kind, 'inactive')
  assert.equal(classifyDoubaoCheckin({ code: 0, data: {} }).kind, 'failed')
  assert.equal(classifyDoubaoCheckin(null).kind, 'failed', '空响应也要有结论')
  console.log('ok 5/8 签到响应分类')
}

/* ── 6. 额度 ───────────────────────────────────────────────────────────── */

{
  assert.equal(doubaoAmount('1,600'), 1600, '千分位字符串')
  assert.equal(doubaoAmount('<1'), 1, '阈值串按阈值保守取整')
  assert.equal(doubaoAmount('12.5'), 12.5)
  assert.equal(doubaoAmount(7), 7)
  assert.equal(doubaoAmount(''), undefined)
  assert.equal(doubaoAmount('n/a'), undefined)
  assert.equal(doubaoAmount(undefined), undefined)

  const payload = {
    code: 0,
    data: {
      current_subscription: { display: { short_name: '免费体验', product_name: '个人订阅' } },
      incentive_quota_section: { window_limit_groups: [{
        feature_group: 'incentive',
        feature_group_name: '活动赠送额度',
        window_limits: [{ total_amount: '1,600', used_amount: '<1', end_time: 1_800_000_000_000 }],
      }] },
      window_limit_section: { window_limit_groups: [{
        feature_group_name: '月度额度',
        window_limits: [{ total_amount: '400', used_amount: '120' }, { nothing: true }],
      }] },
    },
  }
  const windows = doubaoQuotaWindows(payload)
  assert.equal(windows.length, 2, '两处 section 都要读，读不出的行要跳过')
  assert.equal(windows[0].featureGroupName, '活动赠送额度')
  assert.equal(windows[0].total, 1600)
  assert.equal(windows[0].used, 1)
  assert.equal(windows[0].endTime, 1_800_000_000_000)
  const summary = doubaoQuotaSummary(windows)
  assert.deepEqual(summary, { total: 2000, used: 121, remain: 1879 })
  assert.equal(doubaoQuotaSummary([]), null, '没有窗口 = 不知道（不是 0）')

  const credential = { cookie: 'sessionid=S3', accountKey: 'S3' }
  const seen = []
  const quotaFetch = async (url, init) => {
    seen.push({ url, init })
    return jsonResponse(payload)
  }
  const quota = await fetchDoubaoQuota(credential, { fetch: quotaFetch })
  assert.equal(quota.subscription, '免费体验')
  assert.equal(quota.windows.length, 2)
  assert.equal(seen[0].init.method, 'POST', '额度端点只接受 POST')
  assert.equal(seen[0].init.body, '{}')
  assert.equal(seen[0].init.headers.cookie, 'sessionid=S3', '凭据里的 cookie 原样进请求头')
  assert.ok(seen[0].url.includes('/alice/commerce/sale/subscription/quota/summary/'))

  const broken = await fetchDoubaoQuota(credential, { fetch: async () => ({ ok: false, status: 403, async text() { return 'denied' } }) })
  assert.match(broken.error, /403/)
  const empty = await fetchDoubaoQuota(credential, { fetch: async () => jsonResponse({ code: 0, data: {} }) })
  assert.match(empty.error, /没有可用窗口/)
  const badCode = await fetchDoubaoQuota({ cookie: 'sessionid=S3' }, { fetch: async () => jsonResponse({ code: 710010202, message: 'common invalid param' }) })
  assert.match(badCode.error, /710010202.*common invalid param/, '业务码要连文案一起带出来')

  // 710012001 = 登录态失效（实测：无 cookie 打两条读腿都回它）⇒ 文案要指去重新登录
  const expired = await fetchDoubaoQuota({ cookie: 'sessionid=old' }, { fetch: async () => jsonResponse({ code: 710012001, message: 'login invalid' }) })
  assert.match(expired.error, /重新登录/, '登录态失效不能让用户去猜 710012001 是什么')
  assert.match(expired.error, /710012001/, '码值也要留一份（排查时靠它）')
  const expiredStatus = await fetchDoubaoCheckinStatus({ cookie: 'sessionid=old' }, { fetch: async () => jsonResponse({ code: 710012001, message: 'login invalid' }) })
  assert.match(expiredStatus.error, /重新登录/)
  const expiredClaim = classifyDoubaoCheckin({ code: 710012001, message: 'login invalid' })
  assert.equal(expiredClaim.kind, 'failed')
  assert.match(expiredClaim.message, /重新登录/)

  const status = await fetchDoubaoCheckinStatus(credential, {
    fetch: async () => jsonResponse({ code: 0, data: { checked_in: true, continuous_days: 3 } }),
  })
  assert.equal(status.todayCheckedIn, true)
  assert.equal(status.streakDays, 3)
  const unknown = await fetchDoubaoCheckinStatus(credential, { fetch: async () => jsonResponse({ code: 0, data: {} }) })
  assert.equal(unknown.todayCheckedIn, undefined, '读不到就是「不知道」，不是 false')
  console.log('ok 6/8 额度与状态')
}

/* ── 7. 领取全链路（注入假会话，不起浏览器） ────────────────────────────── */

{
  const credential = { cookie: 'sessionid=S4; ttwid=T4', accountKey: 'S4' }
  const cdpCalls = []
  let closed = false
  const makeSession = (signature = 'BOGUS-FROM-PAGE') => ({
    sessionId: 'S-1',
    cdp: { send: async (method, params) => { cdpCalls.push({ method, params }); return {} } },
    evaluate: async () => signature,
    close() { closed = true },
  })

  // ① 成功
  let startArgs
  let postUrl = ''
  const outcome = await claimDoubaoDaily(credential, {
    startSession: async args => { startArgs = args; return makeSession() },
    fetch: async (url, init) => {
      postUrl = url
      assert.equal(init.headers.cookie, credential.cookie)
      assert.equal(JSON.parse(init.body).scene, 'pc_campaign'.replace('pc_campaign', DOUBAO.campaignScene))
      return jsonResponse({ code: 0, data: { checked_in: true, reward_amount: 200, continuous_days: 2 } })
    },
  })
  assert.equal(outcome.kind, 'claimed')
  assert.equal(outcome.credit, 200)
  assert.equal(startArgs.url, DOUBAO.pageUrl, '签到会话打开的是豆包 chat 页（bdms 只在那里）')
  assert.equal(startArgs.headless, true, '签到不需要用户看 ⇒ 无头')
  assert.ok(postUrl.includes('a_bogus=' + encodeURIComponent('BOGUS-FROM-PAGE')), '签名由页面产出后进入 URL')
  assert.equal(postUrl, doubaoCheckinUrl(credential, 'BOGUS-FROM-PAGE'), 'URL 构造必须只有一处实现')
  const cookieWrites = cdpCalls.filter(call => call.method === 'Network.setCookie')
  assert.equal(cookieWrites.length, 2, '两条 cookie 逐条注入（账号隔离的关键）')
  assert.equal(cookieWrites[0].params.domain, '.doubao.com')
  assert.ok(cdpCalls.some(call => call.method === 'Page.navigate'), '注入后要重新加载页面')
  assert.equal(closed, true, '会话必须收掉（临时 profile 即用即弃）')

  // ② 没有 cookie ⇒ inactive，且**不起浏览器**
  let started = false
  const skipped = await claimDoubaoDaily({ accountKey: 'x' }, { startSession: async () => { started = true } })
  assert.equal(skipped.kind, 'inactive')
  assert.equal(started, false, '没登录态就别起浏览器')

  // ③ 浏览器起不来 ⇒ failed，文案要指路
  const noBrowser = await claimDoubaoDaily(credential, { startSession: async () => { throw new Error('没有找到 Chromium 系浏览器') } })
  assert.equal(noBrowser.kind, 'failed')
  assert.match(noBrowser.message, /Chromium/)

  // ④ 页面 30 秒还没注入 bdms ⇒ failed（timeoutMs:0 直接放弃，别真等）
  closed = false
  const noSign = await claimDoubaoDaily(credential, {
    startSession: async () => makeSession(''),
    fetch: async () => { throw new Error('不该发请求') },
    timeoutMs: 0,
  })
  assert.equal(noSign.kind, 'failed')
  assert.match(noSign.message, /bdms/)
  assert.equal(closed, true, '失败也要收掉浏览器')

  // ⑤ 上游回 710010702 ⇒ inactive（不是故障）
  const inactive = await claimDoubaoDaily(credential, {
    startSession: async () => makeSession(),
    fetch: async () => jsonResponse({ code: 710010702, message: '系统错误' }),
  })
  assert.equal(inactive.kind, 'inactive')

  // ⑥ 注入函数本身：msToken 落 .bytedance.com
  const writes = []
  const written = await injectDoubaoCookies({ sessionId: 'S', cdp: { send: async (method, params) => { writes.push(params) } } }, 'sessionid=S; msToken=M')
  assert.equal(written, 2)
  assert.equal(writes[1].domain, '.bytedance.com')

  // ⑦ 发请求这一腿单独测：非 2xx / 非 JSON 都要如实说明
  const http403 = await postDoubaoCheckin(credential, 'SIG', { fetch: async () => ({ ok: false, status: 403, async text() { return 'forbidden' } }) })
  assert.match(http403.error, /403/)
  const notJson = await postDoubaoCheckin(credential, 'SIG', { fetch: async () => ({ ok: true, status: 200, async text() { return '<html>' } }) })
  assert.match(notJson.error, /不是 JSON/)
  console.log('ok 7/8 领取全链路')
}

/* ── 8. 权益扩展与三份清单 ─────────────────────────────────────────────── */

{
  // 没凭据：标成**待登录**（不是「查询失败」），且不去打上游
  const extras = createDoubaoExtras({ credentialOf: async () => null, fetch: async () => { throw new Error('不该发请求') } })
  const missing = await extras.statusOf({ id: 'doubao-1' })
  assert.equal(missing.pending, true, '没有凭据 = 待登录（画红字会让「都没登账号」的卡片也报错）')
  assert.equal(missing.error, undefined)
  // 别的 campaignId 不执行（豆包只有一个活动，也别为它起浏览器）
  const otherCampaign = await extras.claim({ id: 'doubao-1' }, 'other')
  assert.equal(otherCampaign.kind, 'inactive')

  // 有凭据：额度 + 活动行；今天已签 ⇒ 不可领
  const full = createDoubaoExtras({
    credentialOf: async () => ({ cookie: 'sessionid=S5', accountKey: 'S5' }),
    fetch: async url => (url.includes('quota/summary')
      ? jsonResponse({ code: 0, data: { current_subscription: { display: { short_name: '免费体验' } }, incentive_quota_section: { window_limit_groups: [{ feature_group_name: '活动赠送额度', window_limits: [{ total_amount: '1,600', used_amount: '600' }] }] } } })
      : jsonResponse({ code: 0, data: { checked_in: true, continuous_days: 5 } })),
  })
  const row = await full.statusOf({ id: 'doubao-2', nickname: '豆包A' })
  assert.equal(row.nickname, '豆包A')
  assert.equal(row.info.planName, '免费体验')
  assert.deepEqual(row.info.total, { total: 1600, used: 600, remain: 1000 })
  assert.equal(row.activities.length, 1)
  assert.equal(row.activities[0].campaignId, DOUBAO.checkinCampaignId)
  assert.equal(row.activities[0].claimable, false, '今天签过了就不再给「领取」')
  assert.equal(row.activities[0].status, '今天已签到')
  // 推理腿已接通（真机 2026-11-24）：目录来自 brief_list，失败才退回 16 条实测快照
  assert.equal(Array.isArray(row.catalog), true, '要产出目录（推理腿已接通）')
  assert.equal(row.catalog.length, 16, '目录读不到时用兜底表（16 条真机快照）')
  assert.equal(row.source, 'static')

  // 状态腿读不到 ⇒ 仍给可领入口（签到幂等，宁多一次不少一次）
  const unknownState = createDoubaoExtras({
    credentialOf: async () => ({ cookie: 'sessionid=S6', accountKey: 'S6' }),
    fetch: async url => (url.includes('quota/summary')
      ? jsonResponse({ code: 0, data: {} })
      : { ok: false, status: 500, async text() { return 'boom' } }),
  })
  const row2 = await unknownState.statusOf({ id: 'doubao-3' })
  assert.equal(row2.info, null)
  assert.match(row2.infoError, /没有可用窗口/)
  assert.equal(row2.activities[0].claimable, true)

  // 注册：账号表 / 扩展工厂 / 目录三处都要认得这个 id
  assert.ok(OWN_PROVIDERS.includes('doubao'), 'OWN_PROVIDERS 漏了 doubao（账号表会写不进去）')
  const registry = createChannelExtras({ ownAccounts: undefined })
  assert.equal(registry.available, false, '没挂账号池时如实降级')
  // 推理腿接通后，豆包**应该**产出模型行（细节在 `tests/doubao-inference.mjs`）
  assert.ok(buildOwnCatalog({}).some(entry => entry.provider === 'doubao' && entry.id === 'doubao/0'))

  // 面板要能点到这张卡片的扩展入口（跨文件的清单对账在 `tests/channel-manifest.mjs`）
  const stubPool = { listAccounts: () => [], findAccount: () => undefined }
  assert.equal(createChannelExtras({ pool: stubPool, resolve: async () => undefined }).providers().includes('doubao'), true)
  assert.match(fs.readFileSync(path.resolve('client.js'), 'utf8'), /CHANNEL_EXTRAS = new Set\(\[[^\]]*'doubao'/)
  console.log('ok 8/8 权益扩展与注册')
}

console.log('doubao channel OK: 8 组断言全部通过')
