/**
 * AStudio 登录/额度/签到测试（离线，**不出网**）。
 *
 * 钉住的是真机取证过的判据（见 `_refs/dsh-providers-hub-master/docs/agent-notes/providers-astudio.md`）：
 * 1. SSO 三段（`qrcode` → `uids` → `bind`）与 `fd` 形状；
 * 2. `code:-1` = 未扫码（继续等）；`code:0` + **空 `infoList`** = 该微信没开通账号
 *    （不是可重试失败，重扫同一号仍然是空）；
 * 3. 四字段 Cookie 的两种拼写；`80000` = 会话失效 ⇒ 文案必须指去重新扫码；
 * 4. 额度权威字段是 `totalBalance`（不是逐包求和）；
 * 5. 签到是「弹窗」语义：`DAILY_REWARD_DIALOG` → `complete`，没弹窗 = 今天已领。
 */

import assert from 'node:assert/strict'
import {
  ASTUDIO,
  ASTUDIO_DAILY_CAMPAIGN_ID,
  astudioFd,
  astudioSessionCookie,
  bindAstudioWechatSession,
  claimAstudioDailyReward,
  completeAstudioLogin,
  createAstudioExtras,
  fetchAstudioBalance,
  fetchAstudioPendingPopups,
  pollAstudioWechatScan,
  startAstudioWechatQr,
} from '../src/channels/astudio.js'
import { createDeviceLogin } from '../src/channels/device-login.js'

const jsonResponse = payload => ({ ok: true, status: 200, async json() { return payload }, async text() { return JSON.stringify(payload) } })
const textResponse = (text, status = 200) => ({ ok: status < 400, status, async text() { return text }, async json() { return JSON.parse(text) } })

/* ── 1. fd 与 Cookie ────────────────────────────────────────────────────── */

{
  const fd = astudioFd()
  assert.equal(fd.length, 8, '官方客户端的 fd 是 8 位')
  assert.match(fd, /^[A-Za-z2-9]+$/, '字符表里没有易混的 0/O/l/I')
  // 注入随机源 ⇒ 确定性（越界字节也要落在表内）
  const fixed = astudioFd(() => Buffer.from([0, 1, 2, 250, 251, 252, 253, 254]))
  assert.equal(fixed.length, 8)
  assert.match(fixed, /^[A-Za-z2-9]+$/)

  assert.equal(
    astudioSessionCookie({ ssoSessionId: 'S1', accountId: 'A1', token: 'T1' }),
    'ssoSessionId=S1; sso_sessionid=S1; account_id=A1; token=T1',
    '两个拼写都要给（上游按整串校验，缺一个就是 80000）',
  )
  assert.equal(
    astudioSessionCookie({ ssoSessionId: 'S1', accountId: 'A1' }),
    'ssoSessionId=S1; sso_sessionid=S1; account_id=A1; token=S1',
    '没有 token 时用 ssoSessionId 顶上',
  )
  console.log('ok 1/9 fd 与 Cookie')
}

/* ── 2. 二维码 ─────────────────────────────────────────────────────────── */

{
  let seenUrl = ''
  const qr = await startAstudioWechatQr({
    fd: 'ABCD2345',
    fetch: async url => { seenUrl = url; return jsonResponse({ code: 0, data: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=X' }) },
  })
  assert.equal(qr.fd, 'ABCD2345')
  assert.ok(qr.qrUrl.includes('showqrcode'))
  assert.ok(seenUrl.startsWith(`${ASTUDIO.ssoBaseUrl}${ASTUDIO.qrcodePath}?fd=ABCD2345`))
  assert.match(seenUrl, /fd=ABCD2345$/)

  assert.match((await startAstudioWechatQr({ fetch: async () => textResponse('<html>') })).error, /不是 JSON/)
  assert.match((await startAstudioWechatQr({ fetch: async () => jsonResponse({ code: 7, desc: '风控' }) })).error, /风控/)
  assert.match((await startAstudioWechatQr({ fetch: async () => jsonResponse({ code: 0 }) })).error, /没有二维码/)
  console.log('ok 2/9 二维码')
}

/* ── 3. 扫码状态 ───────────────────────────────────────────────────────── */

{
  const pending = await pollAstudioWechatScan('FD1', { fetch: async () => jsonResponse({ code: -1, desc: '暂无数据' }) })
  assert.equal(pending.status, 'pending', 'code:-1 就是「还没扫」，继续轮询')

  const scanned = await pollAstudioWechatScan('FD1', {
    fetch: async () => jsonResponse({ code: 0, desc: '成功', data: { infoList: [{ uid: 'UID-1', ssoSessionId: 'SID-1', username: '小明' }] } }),
  })
  assert.equal(scanned.status, 'scanned')
  assert.equal(scanned.account.uid, 'UID-1')
  assert.equal(scanned.account.ssoSessionId, 'SID-1')
  assert.equal(scanned.account.username, '小明')

  // 只给 uid 的行：ssoSessionId 互为兜底（上游某些入口只给一半）
  const half = await pollAstudioWechatScan('FD1', { fetch: async () => jsonResponse({ code: 0, data: { infoList: [{ uid: 'ONLY-UID' }] } }) })
  assert.equal(half.account.ssoSessionId, 'ONLY-UID', '缺 ssoSessionId 时用 uid 顶，别产出半截凭据')

  // 空 infoList：该微信没开通账号 —— 不是可重试失败
  const unbound = await pollAstudioWechatScan('FD1', { fetch: async () => jsonResponse({ code: 0, desc: '成功', data: { infoList: [] } }) })
  assert.equal(unbound.status, 'unbound')
  assert.match(unbound.message, /绑定手机号/, '文案必须给出**有效**动作（去客户端开户），不是「重新扫码」')
  assert.doesNotMatch(unbound.message, /^成功/, '`desc` 在成功信封里是「成功」，不能当失败原因')

  const failed = await pollAstudioWechatScan('FD1', { fetch: async () => jsonResponse({ code: 500, desc: '内部错误' }) })
  assert.equal(failed.status, 'error')
  assert.match(failed.message, /内部错误/)
  console.log('ok 3/9 扫码状态')
}

/* ── 4. 绑定 ───────────────────────────────────────────────────────────── */

{
  let body = ''
  const ok = await bindAstudioWechatSession('FD9', { uid: 'UID9', ssoSessionId: 'SID9', accountId: 'UID9' }, {
    fetch: async (url, init) => { body = init.body; return jsonResponse({ code: 0 }) },
  })
  assert.equal(ok.ok, true)
  const form = new URLSearchParams(body)
  assert.equal(form.get('fd'), 'FD9')
  assert.equal(form.get('accountId'), 'UID9')
  assert.equal(form.get('ssoSessionId'), 'SID9')
  assert.equal(form.get('isNew'), 'false')
  const denied = await bindAstudioWechatSession('FD9', { uid: 'U' }, { fetch: async () => jsonResponse({ code: 9, desc: '绑定失败' }) })
  assert.equal(denied.ok, false)
  assert.match(denied.message, /绑定失败/)
  console.log('ok 4/9 绑定')
}

/* ── 5. 补全凭据（init-app → userInfo → bot/models/configs） ────────────── */

{
  const calls = []
  const completed = await completeAstudioLogin({ uid: 'UID-1', ssoSessionId: 'SID-1', accountId: 'ACC-1', token: 'TOK-1' }, {
    fetch: async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET' })
      if (url.endsWith(ASTUDIO.initAppPath)) return textResponse('{}')
      if (url.endsWith(ASTUDIO.userInfoPath)) return jsonResponse({ code: 0, data: { nickname: '讯飞小明' } })
      if (url.endsWith(ASTUDIO.bearerConfigPath)) return jsonResponse({ code: 0, data: { modelBearerToken: 'BEARER-1' } })
      throw new Error(`unexpected ${url}`)
    },
  })
  assert.equal(completed.credential.model_bearer_token, 'BEARER-1')
  assert.equal(completed.credential.session_cookie, 'ssoSessionId=SID-1; sso_sessionid=SID-1; account_id=ACC-1; token=TOK-1')
  assert.equal(completed.credential.sso_session_id, 'SID-1')
  assert.equal(completed.nickname, '讯飞小明')
  assert.deepEqual(calls.map(c => c.url.split('/xingchen-studio')[1]), [ASTUDIO.initAppPath, ASTUDIO.userInfoPath, ASTUDIO.bearerConfigPath])

  const missing = await completeAstudioLogin({ uid: 'U' }, { fetch: async () => textResponse('{}') })
  assert.match(missing.error, /缺少账号标识/)

  // init-app 失败**不拦登录**（它是非阻塞的开户初始化）
  const noInit = await completeAstudioLogin({ uid: 'U', ssoSessionId: 'S', accountId: 'U' }, {
    fetch: async (url, init) => {
      if (url.endsWith(ASTUDIO.initAppPath)) throw new Error('boom')
      if (url.endsWith(ASTUDIO.userInfoPath)) return { ok: false, status: 500, async json() { return {} }, async text() { return '' } }
      return jsonResponse({ modelBearerToken: 'B2' })
    },
  })
  assert.equal(noInit.credential.model_bearer_token, 'B2')
  console.log('ok 5/9 补全凭据')
}

/* ── 6. 额度 ───────────────────────────────────────────────────────────── */

{
  const credential = { session_cookie: 'ssoSessionId=S; sso_sessionid=S; account_id=A; token=S' }
  let headers
  const balance = await fetchAstudioBalance(credential, {
    fetch: async (url, init) => {
      headers = init.headers
      assert.ok(url.endsWith(ASTUDIO.pointsPath))
      return jsonResponse({ code: 0, data: { totalBalance: 192, totalAmount: 200, memberBalance: 192, sparkTotalBalance: 5000 } })
    },
  })
  assert.equal(balance.total, 192, '权威字段是 totalBalance（不是逐包求和，星火池不参与）')
  assert.equal(headers.clientType, ASTUDIO.clientType, '版本头必须带（上游按它下发内容）')
  assert.equal(headers.studioVersion, ASTUDIO.studioVersion)

  const dead = await fetchAstudioBalance(credential, { fetch: async () => jsonResponse({ code: 80000, message: 'unauthorized' }) })
  assert.match(dead.error, /重新扫码登录/, '80000 是会话失效，不能让用户去猜')
  const noCookie = await fetchAstudioBalance({}, { fetch: async () => jsonResponse({}) })
  assert.match(noCookie.error, /Cookie/)
  const noField = await fetchAstudioBalance(credential, { fetch: async () => jsonResponse({ code: 0, data: {} }) })
  assert.match(noField.error, /totalBalance/)
  console.log('ok 6/9 额度')
}

/* ── 7. 签到（弹窗语义） ────────────────────────────────────────────────── */

{
  const credential = { session_cookie: 'ssoSessionId=S; sso_sessionid=S; account_id=A; token=S' }
  // 有奖励弹窗 ⇒ complete 一次
  let completedBody = ''
  const claimed = await claimAstudioDailyReward(credential, {
    fetch: async (url, init) => {
      if (url.endsWith(ASTUDIO.popupsPendingPath)) {
        return jsonResponse({ code: 0, data: [
          { popupId: 1, componentType: 'BANNER', instanceKey: 'k0' },
          { popupId: 2, componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'k1', payload: { points: 30 } },
        ] })
      }
      completedBody = init.body
      return jsonResponse({ code: 0, flag: true })
    },
  })
  assert.equal(claimed.kind, 'claimed')
  assert.equal(claimed.credit, 30, '积分优先取弹窗里声明的那份')
  assert.deepEqual(JSON.parse(completedBody), { popupId: 2, instanceKey: 'k1' })

  // 没有弹窗 = 今天已领（**不是失败**）
  const none = await claimAstudioDailyReward(credential, { fetch: async () => jsonResponse({ code: 0, data: [] }) })
  assert.equal(none.kind, 'already-claimed')

  const dead = await claimAstudioDailyReward(credential, { fetch: async () => jsonResponse({ code: 80000 }) })
  assert.equal(dead.kind, 'failed')
  assert.match(dead.message, /重新扫码/)

  const pending = await fetchAstudioPendingPopups(credential, { fetch: async () => jsonResponse({ code: 0, data: { list: [{ popupId: 3 }] } }) })
  assert.equal(pending.popups.length, 1, '`data.list` 形态也要吃')
  console.log('ok 7/9 签到')
}

/* ── 8. 权益扩展 ───────────────────────────────────────────────────────── */

{
  const extras = createAstudioExtras({
    credentialOf: async () => ({ session_cookie: 'ssoSessionId=S; sso_sessionid=S; account_id=A; token=S', model_bearer_token: 'B' }),
    fetch: async url => {
      if (url.includes('model-manager/models')) return jsonResponse({ code: 0, data: { models: [{ id: 'xopglm52', name: 'GLM-5.2', context_window: 1_000_000 }] } })
      if (url.endsWith(ASTUDIO.pointsPath)) return jsonResponse({ code: 0, data: { totalBalance: 192 } })
      return jsonResponse({ code: 0, data: [{ popupId: 5, componentType: 'DAILY_REWARD_DIALOG', instanceKey: 'k5', payload: { points: 10 } }] })
    },
  })
  const row = await extras.statusOf({ id: 'astudio-1', nickname: '小明' })
  assert.equal(row.catalog.length, 1)
  assert.deepEqual(row.balance, { total: 192, unit: 'credit' })
  assert.equal(row.activities[0].campaignId, ASTUDIO_DAILY_CAMPAIGN_ID)
  assert.equal(row.activities[0].claimable, true)
  assert.equal(row.activities[0].amount, 10)
  assert.equal((await extras.claim({ id: 'astudio-1' }, 'other')).kind, 'inactive')
  console.log('ok 8/9 权益扩展')
}

/* ── 9. 接进 device-login（面板的「添加账号」入口） ─────────────────────── */

{
  const attached = []
  // 第一张流程：扫码状态一直是 -1（未扫）⇒ 每轮 poll 都只是 pending。
  const flow = createDeviceLogin({
    accounts: { create: () => ({ id: 'astudio-probe' }), attach: async (id, credential, patch) => { attached.push({ id, credential, patch }) } },
    fetch: async (url) => {
      if (url.includes('scanlogin/qrcode')) return jsonResponse({ code: 0, data: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=T' })
      if (url.includes('scanlogin/uids')) return jsonResponse({ code: -1, desc: '暂无数据' })
      throw new Error(`unexpected ${url}`)
    },
  })
  const started = await flow.start('astudio')
  assert.equal(started.qr, true, '扫码型：面板要画二维码图片')
  assert.ok(started.verificationUri.includes('showqrcode'))
  assert.equal(started.userCode, '', '扫码没有用户码')
  assert.equal(started.expiresIn, 300)

  const pending = await flow.poll(started.accountId)
  assert.equal(pending.done, false, '未扫码时不能落定（面板继续轮询）')

  // 换一张「已扫码」的流程再跑一次落定
  const flow2 = createDeviceLogin({
    accounts: { create: () => ({ id: 'astudio-probe-2' }), attach: async (id, credential, patch) => { attached.push({ id, credential, patch }) } },
    fetch: async (url) => {
      if (url.includes('scanlogin/qrcode')) return jsonResponse({ code: 0, data: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=T' })
      if (url.includes('scanlogin/uids')) return jsonResponse({ code: 0, data: { infoList: [{ uid: 'UID', ssoSessionId: 'SID', accountId: 'ACC', token: 'TOK' }] } })
      if (url.includes('scanlogin/bind')) return jsonResponse({ code: 0 })
      if (url.endsWith(ASTUDIO.initAppPath)) return textResponse('{}')
      if (url.endsWith(ASTUDIO.userInfoPath)) return jsonResponse({ code: 0, data: {} })
      if (url.endsWith(ASTUDIO.bearerConfigPath)) return jsonResponse({ modelBearerToken: 'BEARER' })
      throw new Error(`unexpected ${url}`)
    },
  })
  const started2 = await flow2.start('astudio')
  const done = await flow2.poll(started2.accountId)
  assert.equal(done.done, true)
  assert.equal(done.success, true)
  assert.equal(attached.at(-1).credential.model_bearer_token, 'BEARER')

  // 「没开通账号」不是可重试失败：直接落定并指路
  const flow3 = createDeviceLogin({
    accounts: { create: () => ({ id: 'astudio-probe-3' }), attach: async () => undefined },
    fetch: async url => (url.includes('scanlogin/qrcode')
      ? jsonResponse({ code: 0, data: 'https://mp.weixin.qq.com/cgi-bin/showqrcode?ticket=T' })
      : jsonResponse({ code: 0, desc: '成功', data: { infoList: [] } })),
  })
  const started3 = await flow3.start('astudio')
  const unbound = await flow3.poll(started3.accountId)
  assert.equal(unbound.done, true)
  assert.equal(unbound.success, false)
  assert.match(unbound.error, /绑定手机号/)
  console.log('ok 9/9 接进 device-login')
}

console.log('astudio login OK: 9 组断言全部通过')
