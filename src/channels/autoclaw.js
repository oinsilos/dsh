/**
 * AutoClaw（智谱 AutoGLM 桌面端）渠道：短信登录、积分钱包、每日签到。
 *
 * ## 协议来源
 *
 * 取自 `dsh-providers-hub`（iJetLi，MIT）的真机取证（2026-10-17 / 10-20 / 10-27）：
 *
 * | 用途 | 端点 | 鉴权 |
 * | --- | --- | --- |
 * | 发验证码 | `POST /userapi/v1/agent-send-code` | 管理头（无 token） |
 * | 验证码登录 | `POST /userapi/v1/agent-login` | 管理头 |
 * | 刷新（= 一次「登录事件」） | `POST /userapi/v1/refresh` | 管理头 |
 * | 积分钱包 | `GET /agent-assetmgr/api/v2/wallets?biz_app_id=autoclaw` | `X-Authorization` + `Authorization` |
 * | 每日签到 | `POST /userapi/v1/user-info` `{source_id, device_id}` | 同上 |
 *
 * ## 三处必须照上游做的细节（每一条都是真机踩出来的）
 *
 * 1. **管理头签名**：`X-Auth-Sign = MD5(appId + '&' + ts + '&' + appKey)`，
 *    秒级时间戳。缺一套头就进不了登录逻辑。
 * 2. **签到前必须先 refresh**：活动奖励由「登录事件」触发 —— 服务端在签发 token 时
 *    记下登录，紧随其后的 `user-info` 才发放。只用存量 token 打 `user-info` 只会
 *    拿到每日签到、拿不到活动奖励。顺序颠倒等于白发一次。
 * 3. **`device_id` 绝不能是固定常量**：上游把它当设备身份，写死会让不同请求被识别成
 *    同一台设备刷接口。凭据里有就用，没有就**随机造一个**（桌面端自己也是随机 UUID）。
 *
 * ## 上游不返回「领到多少」
 *
 * `user-info` 的 `data` 只有 `{uid, daily_check_in_completed_on_request}`。所以
 * `claimed` 的 `credit` 是 **0** 并附说明 —— 那不代表没领到，余额由调用方刷新。
 *
 * @module src/channels/autoclaw.js
 */

import crypto from 'node:crypto'

export const AUTOCLAW_API_BASE = 'https://autoglm-acceleration-api.zhipuai.cn'
/** 国际版是**另一套账号体系**（邮箱 + Z.ai OAuth），不能靠一个站点参数切换。 */
export const AUTOCLAW_INTL_API_BASE = 'https://autoglm-api.autoglm.ai'

const APP_ID = '100003'
const APP_KEY = '38d2391985e2369a5fb8227d8e6cd5e5'
const PRODUCT = 'autoclaw'
const SOURCE_ID = 'autoclaw'
const CLIENT_VERSION = '2.1.1'
const USER_AGENT = `AutoClaw/${CLIENT_VERSION} (win)`

const SEND_CODE_PATH = '/userapi/v1/agent-send-code'
const LOGIN_PATH = '/userapi/v1/agent-login'
const REFRESH_PATH = '/userapi/v1/refresh'
const WALLETS_PATH = '/agent-assetmgr/api/v2/wallets'
const USER_INFO_PATH = '/userapi/v1/user-info'

const TIMEOUT_MS = 20_000
/** 签到腿的刷新超时（上游两段尝试，各自别拖太久）。 */
const REFRESH_TIMEOUT_MS = 5_000

/** 钱包类型的展示名（只登记实测见过的；未知原样显示，不编中文名）。 */
const WALLET_LABELS = {
  reward: '奖励积分',
  daily: '每日积分',
  subscription: '签约积分',
  fuel_pack: '加油包积分',
  other: '其他积分',
}

/** `MD5(appId&ts&appKey)` —— 每次请求现算（秒级时间戳参与）。 */
export function manageSign(appId, timestamp, appKey) {
  return crypto.createHash('md5').update(`${appId}&${timestamp}&${appKey}`).digest('hex')
}

/** 管理头（登录/签到/钱包共用一套；带不带 token 由调用方决定）。 */
export function manageHeaders(token, now = Date.now()) {
  const ts = String(Math.floor(now / 1000))
  const headers = {
    'Content-Type': 'application/json',
    'X-Auth-Appid': APP_ID,
    'X-Auth-TimeStamp': ts,
    'X-Auth-Sign': manageSign(APP_ID, ts, APP_KEY),
    'X-Lang': 'zh-CN',
    'X-Channel': 'official',
    'X-User-Agent': USER_AGENT,
  }
  const clean = typeof token === 'string' ? token.trim() : ''
  if (clean !== '') {
    // 两个头都要给：`chat` 只认 X-Authorization，`user-info`/钱包只认 Authorization
    // （上游实测的两种形态并存，不是笔误）。
    headers['X-Authorization'] = `Bearer ${clean}`
    headers.Authorization = `Bearer ${clean}`
  }
  return headers
}

/** 设备号：凭据里有就用，否则**随机**（固定常量会被当成同一台设备）。 */
export function deviceIdOf(credential) {
  const fromCredential = credential?.device_id
  if (typeof fromCredential === 'string' && fromCredential !== '') return fromCredential
  return crypto.randomUUID()
}

/* ── 解析（纯函数） ─────────────────────────────────────────────────────── */

/**
 * `wallets` → `{total, packages[]}`。
 *
 * ⚠️ `display` **必须严格判 `=== true`**（缺字段 = 不可见）：上游用它标记「哪些池
 * 该展示」，fail-open 会让「每日积分 0」那个池重新出现在面板上 —— 那正是上游修过的
 * 报障形态。
 */
export function parseWallets(payload) {
  const data = payload?.data
  if (data === null || typeof data !== 'object') return null
  const rows = Array.isArray(data.wallets) ? data.wallets : []
  const packages = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    if (row.display !== true) continue
    const balance = typeof row.balance === 'number' && Number.isFinite(row.balance) ? row.balance : undefined
    const type = typeof row.public_wallet_type === 'string' && row.public_wallet_type !== '' ? row.public_wallet_type : 'other'
    const name = typeof row.display_name === 'string' && row.display_name.trim() !== ''
      ? row.display_name.trim()
      : (WALLET_LABELS[type] ?? `${type}积分`)
    // `priority` 决定展示顺序（上游下发；缺省排最后，不猜它的名次）。
    const priority = typeof row.priority === 'number' && Number.isFinite(row.priority) ? row.priority : 100
    packages.push({ name, remaining: balance ?? 0, type, priority })
  }
  // 按 priority 升序；相等时保持上游给的相对顺序（`sort` 在 ES2019 起稳定）。
  packages.sort((left, right) => left.priority - right.priority)
  const total = typeof data.total_balance === 'number' && Number.isFinite(data.total_balance)
    ? data.total_balance
    : (packages.length > 0 ? packages.reduce((sum, row) => sum + row.remaining, 0) : undefined)
  if (total === undefined) return null
  return { total, packages: packages.map(({ priority, ...rest }) => rest) }
}

/**
 * `expires_at` / `expires_in` 归一成**毫秒时间戳**。
 *
 * 上游两种字段都用过：epoch 秒（≈1.7e9）与有效期秒数（≈3600）。不归一的话，
 * 「3600」会被面板画成 1970 年，续期闸门也会永远判定「已过期」。
 */
function expiresAtMs(raw, obtainedAt) {
  if (typeof raw !== 'number' && typeof raw !== 'string') return undefined
  const text = String(raw).trim()
  if (text === '') return undefined
  const value = Number(text)
  if (Number.isFinite(value) && value > 0) {
    if (value > 1e12) return Math.round(value)
    if (value > 1e9) return Math.round(value * 1000)
    return Math.round(obtainedAt + value * 1000)
  }
  // ISO 8601 也见过：解析成功就用它，失败不猜。
  const parsed = Date.parse(text)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/** `agent-login` → 凭据（缺字段就说缺，不造）。 */
export function parseLoginPayload(payload) {
  const data = payload?.data
  if (data === null || typeof data !== 'object') return { error: '登录响应缺少 data' }
  const accessToken = typeof data.access_token === 'string' ? data.access_token : ''
  const refreshToken = typeof data.refresh_token === 'string' ? data.refresh_token : ''
  if (accessToken === '') return { error: '登录响应缺少 access_token' }
  const obtainedAt = Date.now()
  const expiresAt = expiresAtMs(data.expires_at ?? data.expires_in, obtainedAt)
  // `??` would keep an empty `user_name` (empty string is not nullish) and then
  // block the phone fallback — the account ended up named "" and every such
  // login collided on the same nickname key.
  const nickname = typeof data.user_name === 'string' && data.user_name !== '' ? data.user_name
    : typeof data.user_phone === 'string' && data.user_phone !== '' ? data.user_phone : undefined
  return {
    credential: {
      access_token: accessToken,
      ...refreshToken === '' ? {} : { refresh_token: refreshToken },
      obtained_at: obtainedAt,
      ...typeof data.user_id === 'string' || typeof data.user_id === 'number' ? { user_id: data.user_id } : {},
      ...typeof data.device_id === 'string' ? { device_id: data.device_id } : {},
      ...expiresAt === undefined ? {} : { expires_at: expiresAt },
    },
    ...nickname === undefined ? {} : { nickname },
  }
}

/**
 * 签到结论。
 *
 * `daily_check_in_completed_on_request === true` ⇒ 本次签到成功（**不含数额**）；
 * `false` ⇒ 今天已完成过。上游不返回数量，故 `claimed` 的 `credit` 恒为 0 并附说明。
 */
export function classifyClaim(payload) {
  const data = payload?.data
  if (data === null || typeof data !== 'object') {
    return { kind: 'failed', message: '签到响应缺少 data' }
  }
  if (data.daily_check_in_completed_on_request === true) {
    return { kind: 'claimed', credit: 0, delayedMessage: '签到成功（上游不返回积分数量，请看刷新后的余额）' }
  }
  return { kind: 'already-claimed', message: '今天已签到' }
}

/* ── 传输 ────────────────────────────────────────────────────────────────── */

async function call(fetchImpl, url, { method = 'GET', token = '', body, signal } = {}) {
  const response = await fetchImpl(url, {
    method,
    headers: manageHeaders(token),
    ...body === undefined ? {} : { body: JSON.stringify(body) },
    signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  let payload = null
  try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = null }
  return { ok: response.ok, status: response.status, payload, text }
}

/* ── 短信登录（登录本身不需要账号表，结果交给调用方落盘） ─────────────────── */

/** 发验证码。失败返回 `{error}`（不抛）。 */
export async function sendCode(phone, { fetch: fetchImpl = fetch, product = 'cn', signal } = {}) {
  const trimmed = String(phone ?? '').trim()
  if (!/^1[3-9]\d{9}$/.test(trimmed)) return { error: '手机号格式不正确' }
  const base = product === 'intl' ? AUTOCLAW_INTL_API_BASE : AUTOCLAW_API_BASE
  try {
    const result = await call(fetchImpl, `${base}${SEND_CODE_PATH}`, {
      method: 'POST',
      body: { phone: trimmed, source_id: SOURCE_ID, device_id: crypto.randomUUID() },
      signal,
    })
    if (!result.ok) return { error: `验证码发送失败（HTTP ${result.status}）${result.text.slice(0, 120)}` }
    if (result.payload?.code !== 0) return { error: result.payload?.msg ?? `验证码发送失败（code ${result.payload?.code}）` }
    return { ok: true }
  } catch (error) {
    return { error: `验证码发送网络失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 验证码登录 → 凭据（由调用方写进账号表）。 */
export async function loginWithCode(phone, code, { fetch: fetchImpl = fetch, product = 'cn', deviceId, signal } = {}) {
  const trimmedPhone = String(phone ?? '').trim()
  const numeric = Number(String(code ?? '').trim())
  if (!/^1[3-9]\d{9}$/.test(trimmedPhone)) return { error: '手机号格式不正确' }
  if (!Number.isSafeInteger(numeric)) return { error: '验证码必须为纯数字' }
  const base = product === 'intl' ? AUTOCLAW_INTL_API_BASE : AUTOCLAW_API_BASE
  try {
    const result = await call(fetchImpl, `${base}${LOGIN_PATH}`, {
      method: 'POST',
      body: { phone: trimmedPhone, code: numeric, source_id: SOURCE_ID, device_id: deviceId ?? crypto.randomUUID() },
      signal,
    })
    if (!result.ok) return { error: `登录失败（HTTP ${result.status}）${result.text.slice(0, 120)}` }
    if (result.payload?.code !== 0) return { error: result.payload?.msg ?? `登录失败（code ${result.payload?.code}）` }
    return parseLoginPayload(result.payload)
  } catch (error) {
    return { error: `登录网络失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * 续期：`refresh_token` 换新 `access_token`。
 *
 * 上游实测**不轮换** refresh_token（旧 access 仍可用），所以失败不判终态；
 * 到期判据用账号表里的 `expires_at`（毫秒，由 `expiresAtMs` 归一）。
 */
export async function refreshAutoclawToken(credential, { product = 'cn', fetch: fetchImpl = fetch, signal } = {}) {
  const refreshToken = typeof credential?.refresh_token === 'string' ? credential.refresh_token : ''
  if (refreshToken === '') return { error: '凭据里没有 refresh_token（需要重新登录）' }
  const base = product === 'intl' ? AUTOCLAW_INTL_API_BASE : AUTOCLAW_API_BASE
  try {
    const result = await call(fetchImpl, `${base}${REFRESH_PATH}`, {
      method: 'POST',
      body: { refresh_token: refreshToken, source_id: SOURCE_ID, device_id: deviceIdOf(credential) },
      signal,
    })
    const fresh = result.payload?.data?.access_token
    if (!result.ok || typeof fresh !== 'string' || fresh === '') {
      return { error: `续期失败（HTTP ${result.status}）${result.text.slice(0, 120)}` }
    }
    const obtainedAt = Date.now()
    const expiresAt = expiresAtMs(result.payload?.data?.expires_at ?? result.payload?.data?.expires_in, obtainedAt)
    return {
      credential: {
        ...credential,
        access_token: fresh,
        obtained_at: obtainedAt,
        ...expiresAt === undefined ? {} : { expires_at: expiresAt },
      },
      refreshed: true,
    }
  } catch (error) {
    return { error: `续期网络失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/* ── 权益 ────────────────────────────────────────────────────────────────── */

/**
 * 建 AutoClaw 的权益读取器。`product` 选国内 / 国际两站（账号体系不互通）。
 *
 * @param {object} options
 * @param {(account: object) => Promise<object|null>} options.credentialOf
 * @param {Function} [options.fetch]
 * @param {'cn'|'intl'} [options.product]
 */
export function createAutoclawExtras({ credentialOf, fetch: fetchImpl = fetch, product = 'cn' }) {
  const base = product === 'intl' ? AUTOCLAW_INTL_API_BASE : AUTOCLAW_API_BASE

  const tokenOf = async account => {
    const credential = await credentialOf(account)
    return typeof credential?.access_token === 'string' && credential.access_token !== ''
      ? { token: credential.access_token, credential }
      : null
  }

  async function statusOf(account) {
    const own = {
      accountId: typeof account?.id === 'string' ? account.id : '',
      nickname: typeof account?.nickname === 'string' ? account.nickname : '',
    }
    const resolved = await tokenOf(account)
    if (resolved === null) return { ...own, error: '凭据不可用（需要重新登录）' }
    const result = await call(fetchImpl, `${base}${WALLETS_PATH}?biz_app_id=${SOURCE_ID}`, { token: resolved.token })
    if (!result.ok) {
      return { ...own, error: result.status === 401 || result.status === 403 ? '登录已失效，请重新登录' : `钱包查询失败（HTTP ${result.status}）` }
    }
    if (result.payload?.code !== 0) {
      const message = typeof result.payload?.msg === 'string' ? result.payload.msg : ''
      return { ...own, error: result.payload?.code === 410000 ? `登录已失效，请重新登录（${message || '用户未登录'}）` : `钱包查询失败（code ${result.payload?.code}${message === '' ? '' : `，${message}`}）` }
    }
    const info = parseWallets(result.payload)
    return info === null ? { ...own, error: '钱包响应里没有可读的余额' } : { ...own, info }
  }

  /**
   * 每日签到：**先刷新（登录事件）再 user-info**。
   *
   * `persist` 由调用方注入（把轮换后的 token 写回账号表）；拿不到就不落盘 ——
   * 上游实测 refresh 不轮换 `refresh_token`，旧 access 仍可用，故不落盘也不坏。
   */
  async function claim(account, _campaignId, options = {}) {
    const resolved = await tokenOf(account)
    if (resolved === null) return { kind: 'failed', message: '凭据不可用（需要重新登录）' }
    const deviceId = deviceIdOf(resolved.credential)
    let token = resolved.token
    if (typeof resolved.credential.refresh_token === 'string' && resolved.credential.refresh_token !== '') {
      try {
        const refreshed = await call(fetchImpl, `${base}${REFRESH_PATH}`, {
          method: 'POST',
          body: { refresh_token: resolved.credential.refresh_token, source_id: SOURCE_ID, device_id: deviceId },
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        })
        const fresh = refreshed.payload?.data?.access_token
        if (refreshed.ok && typeof fresh === 'string' && fresh !== '') {
          token = fresh
          // 刷新只是「制造一次登录事件」：落盘失败不影响本次签到。
          try { await options.persist?.({ ...resolved.credential, access_token: fresh }) } catch { /* 见注释 */ }
        }
      } catch { /* 刷新失败就退回存量 token（至少每日签到还能领） */ }
    }
    const result = await call(fetchImpl, `${base}${USER_INFO_PATH}`, {
      method: 'POST',
      token,
      body: { source_id: SOURCE_ID, device_id: deviceId },
    })
    if (!result.ok) return { kind: 'failed', message: `签到失败（HTTP ${result.status}）${result.text.slice(0, 120)}` }
    if (result.payload?.code !== 0) {
      return {
        kind: 'failed',
        message: result.payload?.code === 410000 ? '登录已失效，请重新登录' : `签到失败（code ${result.payload?.code}）`,
      }
    }
    return classifyClaim(result.payload)
  }

  return { statusOf, claim }
}