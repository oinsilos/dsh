/**
 * 讯飞 AStudio（`astudio`）的登录、目录、额度与签到协议。
 *
 * ## 两段凭据
 *
 * | 段 | 用途 | 来源 |
 * | --- | --- | --- |
 * | 网页 Cookie（四字段串） | 取**权威**模型凭据 / 额度 / 签到 | 微信扫码后 SSO 下发 |
 * | `modelBearerToken` | 推理与目录 | `GET /bot/models/configs`（Cookie 认证） |
 *
 * ⚠️ 推理与目录用的是**同一个 token**，差别只在头（见参考实现：同一 token、同一端点，
 * 只改两个头结果不同）—— 所以 token 只解析一次，头按腿组装。
 *
 * ## 登录 = **微信扫码**（SSO 三段）
 *
 * 官方客户端就是这么登的，而且它是唯一不赔本的路：短信/密码要过 GeeTest 人机验证。
 *
 * 1. `GET {sso}/SSOService/wx/scanlogin/qrcode?fd={fd}` → `{code:0, data:"<二维码图片 URL>"}`
 * 2. `GET {sso}/SSOService/wx/scanlogin/uids?fd={fd}` → `code:-1` 未扫码；`code:0` 且
 *    `data.infoList[]` 有账号 = 已扫（**空 infoList = 该微信还没开通 AStudio**，
 *    要在 AStudio 客户端里绑定手机号才能开通 —— 重新扫同一个号仍然是空）
 * 3. `POST {sso}/SSOService/wx/scanlogin/bind`（表单 `fd` / `accountId` / `ssoSessionId` / `isNew`）
 *    确认绑定，之后用四字段 Cookie 走控制面：`init-app` → `userInfo` → `bot/models/configs`
 *
 * ⚠️ `fd` 是**客户端自己生成的 8 位串**（不是上游下发的），扫码状态靠它轮询。
 *
 * ## 额度与签到都在控制面（Cookie）
 *
 * - 额度：`GET {auth}/points/balance`，权威字段是 **`totalBalance`**（主池可用合计），
 *   不是逐包求和（逐包求和会在「星火池」在场时凭空多一笔）。
 * - 签到：`GET {auth}/client-popups/pending` 找 `DAILY_REWARD_DIALOG` →
 *   `POST {auth}/client-popups/complete`（body `{popupId, instanceKey}`）。
 * - ⚠️ 这两个端点必须带 `clientType` / `studioVersion`：**版本串是上游下发内容的判据**，
 *   签到面缺了它回 `11001001`（客户端版本无效），抬到上游不认识的版本同样会坏。
 *
 * @module src/channels/astudio.js
 */

import crypto from 'node:crypto'

export const ASTUDIO = Object.freeze({
  id: 'astudio',
  displayName: 'AStudio',
  /** 模型网关（推理与目录同主机的不同路径）。 */
  maasBaseUrl: 'https://astronstudio-api-volces-prod.xf-yun.com/model-gateway/v1',
  catalogBaseUrl: 'https://astronstudio-api-volces-prod.xf-yun.com',
  chatPath: '/responses',
  catalogPath: '/api/v1/model-manager/models',
  /** 活体凭据（权威源）：Cookie 换 `modelBearerToken`。 */
  authBaseUrl: 'https://agent.xfyun.cn/xingchen-studio',
  bearerConfigPath: '/bot/models/configs',
  /** SSO（微信扫码）基址。 */
  ssoBaseUrl: 'https://sso.xfyun.cn',
  qrcodePath: '/SSOService/wx/scanlogin/qrcode',
  uidsPath: '/SSOService/wx/scanlogin/uids',
  bindPath: '/SSOService/wx/scanlogin/bind',
  initAppPath: '/tenant-app/v2/init-app',
  userInfoPath: '/userInfo',
  pointsPath: '/points/balance',
  popupsPendingPath: '/client-popups/pending',
  popupsCompletePath: '/client-popups/complete',
  /** 客户端的版本头（**上游会看**：目录条数与签到可用性都按它下发）。 */
  clientType: '21',
  studioVersion: '3.6.4',
})

/** 目录未返回时的上下文兜底。 */
export const ASTUDIO_FALLBACK_CONTEXT = 131_072

/** 上游的「会话已失效」业务码（实测集合：1002 / 1005 / 80000）。 */
export const ASTUDIO_SESSION_DEAD_CODES = Object.freeze([1002, 1005, 80000])

/** `fd` 的字符表（官方客户端用的就是这一份：去掉了易混的 0/O/l/I）。 */
const FD_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678'

/** 生成 8 位 `fd`（扫码唯一凭证；上游每轮按它查状态）。 */
export function astudioFd(random = n => crypto.randomBytes(n)) {
  const bytes = random(8)
  return Array.from(bytes, byte => FD_ALPHABET[byte % FD_ALPHABET.length]).join('')
}

/**
 * 四字段 Cookie（上游按整串校验，缺字段会以 80000 失败）。
 *
 * 形状来自官方客户端抓包：`ssoSessionId` / `sso_sessionid` 两个拼写**都要给**。
 */
export function astudioSessionCookie({ ssoSessionId, accountId, token }) {
  const sid = String(ssoSessionId ?? '')
  const account = String(accountId ?? '')
  const key = String(token ?? sid)
  return `ssoSessionId=${sid}; sso_sessionid=${sid}; account_id=${account}; token=${key}`
}

/** 控制面请求头（额度 / 签到：带版本头）。 */
export function astudioAppHeaders(cookie) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    cookie: String(cookie ?? ''),
    clientType: ASTUDIO.clientType,
    studioVersion: ASTUDIO.studioVersion,
    'x-requested-with': 'XMLHttpRequest',
  }
}

/** SSO 请求头（扫码三段同一个形状）。 */
function ssoHeaders() {
  return { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' }
}

/** 读信封里的业务码与文案（`desc` 与 `message` 两种拼写都见过）。 */
function envelopeOf(payload) {
  const record = payload !== null && typeof payload === 'object' ? payload : {}
  const raw = record.code
  const code = typeof raw === 'number' ? raw : Number.parseInt(String(raw ?? ''), 10)
  const message = typeof record.desc === 'string' ? record.desc
    : typeof record.message === 'string' ? record.message : ''
  return { record, code: Number.isFinite(code) ? code : undefined, message }
}

/**
 * 把微信二维码**内联成 data URL**。
 *
 * ⚠️ 为什么不在面板里直接 `<img src="https://mp.weixin.qq.com/...">`：
 * 渲染进程可能是 `dsh-app://` 的内嵌页，外链图片在那种上下文里会被 CSP/网络策略挡掉，
 * 而「二维码不显示」对用户来说等于「扫码登录坏了」。宿主取一次字节即可（几 KB）。
 *
 * 取不到就回 `{error}`，调用方退回原始 URL（尽力而为，不阻断登录）。
 */
export async function inlineWechatQr(qrUrl, { fetch: fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  if (typeof qrUrl !== 'string' || qrUrl === '') return { error: '没有二维码地址' }
  let response
  try {
    response = await fetchImpl(qrUrl, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    return { error: `下载二维码失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) return { error: `下载二维码返回 HTTP ${response.status}` }
  const type = String(response.headers?.get?.('content-type') ?? 'image/png').split(';')[0].trim() || 'image/png'
  if (!type.startsWith('image/')) return { error: `二维码响应不是图片（${type}）` }
  let bytes
  try {
    bytes = Buffer.from(await response.arrayBuffer())
  } catch (error) {
    return { error: `读取二维码失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (bytes.length === 0) return { error: '二维码内容为空' }
  // 上限 512 KB：正常二维码 3–20 KB，异常大就当失败（别把面板撑爆）。
  if (bytes.length > 512 * 1024) return { error: '二维码图片过大' }
  return { dataUrl: `data:${type};base64,${bytes.toString('base64')}` }
}

/**
 * ① 申请二维码。
 *
 * @returns `{fd, qrUrl}` 或 `{error}`
 */
export async function startAstudioWechatQr({ fd = astudioFd(), fetch: fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let response
  try {
    response = await fetchImpl(`${ASTUDIO.ssoBaseUrl}${ASTUDIO.qrcodePath}?fd=${encodeURIComponent(fd)}`, {
      headers: ssoHeaders(), signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { error: `申请二维码失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) return { error: `申请二维码返回 HTTP ${response.status}` }
  let payload
  try { payload = await response.json() } catch { return { error: '申请二维码的响应不是 JSON' } }
  const { record, code, message } = envelopeOf(payload)
  if (code !== 0) return { error: `申请二维码失败：${message || `code=${record.code ?? '?'}`}` }
  const qrUrl = typeof record.data === 'string' ? record.data.trim() : ''
  if (qrUrl === '') return { error: '申请二维码的响应里没有二维码地址' }
  return { fd, qrUrl }
}

/**
 * ② 轮询扫码状态（**每 tick 一次**，不在这里循环）。
 *
 * @returns `{status: 'pending'|'scanned'|'unbound'|'error', account?, message?}`
 */
export async function pollAstudioWechatScan(fd, { fetch: fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  let response
  try {
    response = await fetchImpl(`${ASTUDIO.ssoBaseUrl}${ASTUDIO.uidsPath}?fd=${encodeURIComponent(fd)}`, {
      headers: ssoHeaders(), signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { status: 'error', message: `查询扫码状态失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) return { status: 'error', message: `查询扫码状态返回 HTTP ${response.status}` }
  let payload
  try { payload = await response.json() } catch { return { status: 'error', message: '查询扫码状态的响应不是 JSON' } }
  const { record, code, message } = envelopeOf(payload)
  if (code === -1) return { status: 'pending', message: message || '未扫码' }
  if (code !== 0) return { status: 'error', message: message || `code=${record.code ?? '?'}` }
  // code === 0：`data.infoList[]`（也见过直接给数组的形态）
  const data = record.data
  const rows = Array.isArray(data) ? data
    : Array.isArray(data?.infoList) ? data.infoList
      : data !== null && typeof data === 'object' ? [data] : []
  const accounts = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const uid = String(row.uid ?? row.accountId ?? row.account_id ?? '').trim()
    // ⚠️ `uid` 与 `ssoSessionId` **互为兜底**（上游在某些入口只给其中一个）；
    // 但两个都空的行必须丢掉 —— 半截凭据进账号表，之后每个请求都是 80000。
    const ssoSessionId = String(row.ssoSessionId ?? row.sso_session_id ?? row.token ?? uid).trim()
    const accountId = String(row.accountId ?? row.account_id ?? uid).trim()
    const token = String(row.token ?? ssoSessionId).trim()
    if (uid === '' && ssoSessionId === '') continue
    accounts.push({
      uid: uid === '' ? ssoSessionId : uid,
      ssoSessionId: ssoSessionId === '' ? uid : ssoSessionId,
      accountId: accountId === '' ? uid : accountId,
      token: token === '' ? ssoSessionId : token,
      ...typeof row.username === 'string' && row.username !== '' ? { username: row.username } : {},
    })
  }
  if (accounts.length === 0) {
    // ⚠️ `code:0` 只说明「请求成功」，`desc` 在这时是「成功」而不是失败原因 ——
    // 拿它当错误文案会产出红色「成功」。空 infoList 的真实含义是**该微信没开通账号**。
    return { status: 'unbound', message: '该微信号还没有开通 AStudio：请先在 AStudio 客户端里用这个微信登录并绑定手机号，再回来扫码' }
  }
  return { status: 'scanned', account: accounts[0], accounts }
}

/** ③ 确认绑定（失败不致命：绑定只是让上游记住这台设备）。 */
export async function bindAstudioWechatSession(fd, account, { fetch: fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const body = new URLSearchParams({
    fd: String(fd ?? ''),
    accountId: String(account?.accountId ?? account?.uid ?? ''),
    ssoSessionId: String(account?.ssoSessionId ?? ''),
    isNew: 'false',
  }).toString()
  try {
    const response = await fetchImpl(`${ASTUDIO.ssoBaseUrl}${ASTUDIO.bindPath}`, {
      method: 'POST',
      headers: { ...ssoHeaders(), 'content-type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { ok: false, message: `绑定返回 HTTP ${response.status}` }
    const payload = await response.json().catch(() => undefined)
    const { code, message } = envelopeOf(payload)
    return code === 0 ? { ok: true } : { ok: false, message: message || `code=${code ?? '?'}` }
  } catch (error) {
    return { ok: false, message: `绑定失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Cookie 头：四字段串原样透传（不做解析，上游按整串校验）。 */
export function astudioCookieHeaders(cookie) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    ...typeof cookie === 'string' && cookie !== '' ? { cookie } : {},
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  }
}

/** 推理/目录头：Bearer `modelBearerToken`。 */
export function astudioBearerHeaders(bearer) {
  return {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: `Bearer ${String(bearer ?? '')}`,
  }
}

/** 从 `/bot/models/configs` 的响应里取 `modelBearerToken`（形状不认识返回 undefined）。 */
export function readAstudioBearer(payload) {
  if (payload === null || typeof payload !== 'object') return undefined
  const candidates = [
    payload.modelBearerToken,
    payload.model_bearer_token,
    payload.data?.modelBearerToken,
    payload.data?.model_bearer_token,
    payload.data?.bearer_token,
  ]
  for (const value of candidates) {
    if (typeof value === 'string' && value !== '') return value
  }
  return undefined
}

/** Cookie → Bearer。 */
export async function exchangeAstudioBearer(cookie, { fetch: fetchImpl = fetch } = {}) {
  if (typeof cookie !== 'string' || cookie === '') return { error: '没有网页 Cookie（请先登录）' }
  let response
  try {
    response = await fetchImpl(`${ASTUDIO.authBaseUrl}${ASTUDIO.bearerConfigPath}`, {
      headers: astudioCookieHeaders(cookie), signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    return { error: `取模型凭据失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) return { error: `取模型凭据返回 HTTP ${response.status}` }
  let payload
  try { payload = await response.json() } catch { return { error: '取模型凭据的响应不是 JSON' } }
  const bearer = readAstudioBearer(payload)
  if (bearer === undefined) return { error: '响应里没有 modelBearerToken（上游可能改版）' }
  return { credential: { session_cookie: cookie, model_bearer_token: bearer, provider: 'astudio' } }
}

/**
 * 扫码之后把会话补全成凭据：`init-app` → `userInfo` → `bot/models/configs`。
 *
 * ⚠️ `init-app` 是**非阻塞**的（官方客户端也无视它的结果）：它的作用是在租户侧开户，
 * 失败不该拦住登录 —— 拿它当失败判据会让「账号本来就有」的用户登不进来。
 *
 * @param {object} account - `pollAstudioWechatScan` 给出的那条账号
 * @returns `{credential, nickname?}` 或 `{error}`
 */
export async function completeAstudioLogin(account, { fetch: fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const ssoSessionId = String(account?.ssoSessionId ?? '').trim()
  const accountId = String(account?.accountId ?? account?.uid ?? '').trim()
  if (ssoSessionId === '' || accountId === '') return { error: '扫码结果里缺少账号标识（ssoSessionId / accountId），请重新扫码' }
  const cookie = astudioSessionCookie({ ssoSessionId, accountId, token: account?.token })
  try {
    await fetchImpl(`${ASTUDIO.authBaseUrl}${ASTUDIO.initAppPath}`, {
      method: 'POST', headers: astudioCookieHeaders(cookie), signal: AbortSignal.timeout(timeoutMs),
    })
  } catch { /* 开户初始化失败不拦登录（见上） */ }
  let nickname = typeof account?.username === 'string' && account.username !== '' ? account.username : undefined
  try {
    const response = await fetchImpl(`${ASTUDIO.authBaseUrl}${ASTUDIO.userInfoPath}`, {
      headers: astudioCookieHeaders(cookie), signal: AbortSignal.timeout(timeoutMs),
    })
    if (response.ok) {
      const payload = await response.json().catch(() => undefined)
      const data = payload?.data ?? payload
      const name = data?.nickname ?? data?.userName ?? data?.username
      if (typeof name === 'string' && name.trim() !== '') nickname = name.trim()
    }
  } catch { /* 昵称取不到不影响凭据 */ }
  const exchanged = await exchangeAstudioBearer(cookie, { fetch: fetchImpl })
  if (exchanged.error !== undefined) return { error: exchanged.error }
  return {
    credential: {
      ...exchanged.credential,
      uid: String(account?.uid ?? accountId),
      account_id: accountId,
      sso_session_id: ssoSessionId,
      token: String(account?.token ?? ssoSessionId),
    },
    ...nickname === undefined ? {} : { nickname },
  }
}

/* ── 额度与每日签到（控制面，Cookie 认证） ───────────────────────────────── */

/** 面板上那条活动的 id（自有渠道的 claim 按 campaignId 分派）。 */
export const ASTUDIO_DAILY_CAMPAIGN_ID = 'astudio:daily-reward'

const num = value => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string' || value.trim() === '') return undefined
  const parsed = Number(value.trim().replace(/[,\s_]/g, ''))
  return Number.isFinite(parsed) ? parsed : undefined
}

/** 控制面的一次 GET：返回 `{payload, code, message}` 或 `{error}`。 */
async function astudioAppGet(credential, path, { fetch: fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  const cookie = typeof credential?.session_cookie === 'string' ? credential.session_cookie : ''
  if (cookie === '') return { error: '没有网页 Cookie（需要重新登录）' }
  let response
  try {
    response = await fetchImpl(`${ASTUDIO.authBaseUrl}${path}`, {
      headers: astudioAppHeaders(cookie), signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { error: `请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const raw = await response.text().catch(() => '')
  if (!response.ok) return { error: `HTTP ${response.status}：${raw.slice(0, 160) || '空响应'}` }
  let payload
  try { payload = raw === '' ? {} : JSON.parse(raw) } catch { return { error: '响应不是 JSON（上游可能改版）' } }
  const { code, message } = envelopeOf(payload)
  if (code !== undefined && code !== 0) {
    const dead = ASTUDIO_SESSION_DEAD_CODES.includes(code)
    return { error: dead ? `AStudio 登录会话已失效（${code}）：请重新扫码登录` : `上游返回 ${code}${message === '' ? '' : `（${message}）`}` }
  }
  return { payload }
}

/**
 * 额度：`GET /points/balance`。
 *
 * ⚠️ 权威字段是 **`totalBalance`**（主池可用合计）；逐包求和会在「星火池」在场时
 * 凭空多出一笔（官方客户端也是直接显示它）。
 */
export async function fetchAstudioBalance(credential, options = {}) {
  const got = await astudioAppGet(credential, ASTUDIO.pointsPath, options)
  if (got.error !== undefined) return { error: got.error }
  const data = got.payload?.data ?? got.payload
  const total = num(data?.totalBalance)
  if (total === undefined) return { error: '额度报文里没有 totalBalance（上游可能改版）' }
  const totalAmount = num(data?.totalAmount)
  return { total, ...totalAmount === undefined ? {} : { totalAmount } }
}

/** 待领取弹窗（`GET /client-popups/pending`）。 */
export async function fetchAstudioPendingPopups(credential, options = {}) {
  const got = await astudioAppGet(credential, ASTUDIO.popupsPendingPath, options)
  if (got.error !== undefined) return { error: got.error }
  const data = got.payload?.data
  const rows = Array.isArray(data) ? data
    : Array.isArray(data?.list) ? data.list
      : Array.isArray(got.payload?.popups) ? got.payload.popups : []
  return { popups: rows.filter(row => row !== null && typeof row === 'object') }
}

/** 这个弹窗是不是「每日奖励」。上游两个字段都用过（`componentType` / `type`）。 */
export function isAstudioDailyReward(popup) {
  const kind = String(popup?.componentType ?? popup?.type ?? popup?.popupType ?? '')
  return kind === 'DAILY_REWARD_DIALOG'
}

/** 弹窗里声明的积分数（拿不到就 0 —— 面板据此不显示「+x」）。 */
export function astudioPopupPoints(popup) {
  const payload = popup?.payload ?? {}
  return num(payload.points ?? payload.credit ?? payload.amount ?? popup?.points) ?? 0
}

/**
 * 领每日奖励：`pending` → `complete`。
 *
 * 三种结论：领到（`claimed`）/ 今天没有弹窗（`already-claimed`）/ 失败。
 * ⚠️ 没有弹窗**不等于**失败：已领的号回的就是空列表。
 */
export async function claimAstudioDailyReward(credential, options = {}) {
  const pending = await fetchAstudioPendingPopups(credential, options)
  if (pending.error !== undefined) return { kind: 'failed', message: `查询奖励弹窗失败：${pending.error}` }
  const reward = pending.popups.find(isAstudioDailyReward)
  if (reward === undefined) return { kind: 'already-claimed', message: '今天已经领过（或当前没有可领的奖励弹窗）' }
  const popupId = reward.popupId ?? reward.id
  const instanceKey = reward.instanceKey
  if (popupId === undefined || typeof instanceKey !== 'string' || instanceKey === '') {
    return { kind: 'failed', message: '奖励弹窗缺 popupId / instanceKey（上游可能改版）' }
  }
  const cookie = typeof credential?.session_cookie === 'string' ? credential.session_cookie : ''
  const fetchImpl = options.fetch ?? fetch
  let response
  try {
    response = await fetchImpl(`${ASTUDIO.authBaseUrl}${ASTUDIO.popupsCompletePath}`, {
      method: 'POST',
      headers: astudioAppHeaders(cookie),
      body: JSON.stringify({ popupId, instanceKey }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
    })
  } catch (error) {
    return { kind: 'failed', message: `领取失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const raw = await response.text().catch(() => '')
  if (!response.ok) return { kind: 'failed', message: `领取失败：HTTP ${response.status}` }
  let payload
  try { payload = raw === '' ? {} : JSON.parse(raw) } catch { return { kind: 'failed', message: '领取响应不是 JSON' } }
  const { code, message } = envelopeOf(payload)
  if (code !== undefined && code !== 0) {
    const dead = ASTUDIO_SESSION_DEAD_CODES.includes(code)
    return { kind: 'failed', message: dead ? `AStudio 登录会话已失效（${code}）：请重新扫码登录` : `领取失败：${message || `code=${code}`}` }
  }
  const credit = astudioPopupPoints(reward) || num(payload?.data?.points) || 0
  return { kind: 'claimed', credit, message: credit > 0 ? `已领取 ${credit} 积分` : '已领取每日奖励' }
}

/**
 * 目录：`GET /api/v1/model-manager/models`（Bearer）。
 *
 * 字段口径：`context_window` → `contextWindow`，`max_output_tokens` → `maxOutput`；
 * 不认识的条目跳过，不猜。
 */
export function parseAstudioModels(payload) {
  const rows = Array.isArray(payload?.data?.models) ? payload.data.models
    : Array.isArray(payload?.models) ? payload.models
      : Array.isArray(payload?.data) ? payload.data
        : []
  const out = []
  for (const row of rows) {
    const id = typeof row?.id === 'string' && row.id !== '' ? row.id
      : typeof row?.model_id === 'string' ? row.model_id
        : typeof row?.model === 'string' ? row.model : ''
    if (id === '') continue
    const contextWindow = Number(row?.context_window ?? row?.contextWindow)
    const maxOutput = Number(row?.max_output_tokens ?? row?.maxOutputTokens)
    out.push({
      id,
      name: typeof row?.name === 'string' && row.name !== '' ? row.name : id,
      contextWindow: Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : ASTUDIO_FALLBACK_CONTEXT,
      ...Number.isFinite(maxOutput) && maxOutput > 0 ? { maxOutput } : {},
      reasoning: true,
    })
  }
  return out
}

/** 拉远端目录。 */
export async function fetchAstudioModels(bearer, { fetch: fetchImpl = fetch } = {}) {
  let response
  try {
    response = await fetchImpl(`${ASTUDIO.catalogBaseUrl}${ASTUDIO.catalogPath}`, {
      headers: astudioBearerHeaders(bearer), signal: AbortSignal.timeout(20_000),
    })
  } catch (error) {
    return { error: `目录请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  if (!response.ok) return { error: `目录返回 HTTP ${response.status}` }
  let payload
  try { payload = await response.json() } catch { return { error: '目录响应不是 JSON' } }
  const rows = parseAstudioModels(payload)
  return rows.length === 0 ? { error: '目录响应里没有可识别的模型' } : { rows }
}

/** 权益扩展：目录 + 额度 + 每日签到。 */
export function createAstudioExtras({ credentialOf, fetch: fetchImpl = fetch } = {}) {
  async function statusOf(account) {
    const base = { accountId: typeof account?.id === 'string' ? account.id : '', nickname: typeof account?.nickname === 'string' ? account.nickname : '' }
    const credential = credentialOf === undefined ? null : await credentialOf(account)
    if (credential === null) return { ...base, error: '凭据不可用（需要重新登录）' }
    const [models, balance, pending] = await Promise.all([
      fetchAstudioModels(credential.model_bearer_token, { fetch: fetchImpl }),
      fetchAstudioBalance(credential, { fetch: fetchImpl }),
      fetchAstudioPendingPopups(credential, { fetch: fetchImpl }),
    ])
    const reward = pending.popups === undefined ? undefined : pending.popups.find(isAstudioDailyReward)
    return {
      ...base,
      source: models.rows === undefined ? 'static' : 'live',
      ...models.rows === undefined ? { catalogError: models.error } : { catalog: models.rows },
      ...balance.total === undefined ? { balanceError: balance.error } : { balance: { total: balance.total, unit: 'credit' } },
      activities: [{
        campaignId: ASTUDIO_DAILY_CAMPAIGN_ID,
        type: 'checkin',
        title: '每日登录积分',
        // 读不到弹窗（或读失败）时不给「可领」：AStudio 的领取是**按弹窗 id** 的写操作，
        // 没有 id 时点了也只会报「没有可领的弹窗」。
        claimable: reward !== undefined,
        status: pending.popups === undefined ? (pending.error ?? '') : (reward === undefined ? '今天已领或暂无奖励' : ''),
        amount: reward === undefined ? 0 : astudioPopupPoints(reward),
      }],
    }
  }

  async function claim(account, campaignId) {
    const id = String(campaignId ?? '')
    if (id !== '' && id !== ASTUDIO_DAILY_CAMPAIGN_ID) return { kind: 'inactive', message: 'AStudio 只有一个每日奖励弹窗' }
    const credential = credentialOf === undefined ? null : await credentialOf(account)
    if (credential === null) return { kind: 'failed', message: '凭据不可用（需要重新登录）' }
    return claimAstudioDailyReward(credential, { fetch: fetchImpl })
  }

  return { statusOf, claim }
}
