/**
 * CodeArts 权益扩展：余额明细、运营活动列表与领取、模型倍率。
 *
 * ## 为什么在渠道包之外再写一份
 *
 * 渠道包（`vendor/channel-pack/pack.js`）已经是生成产物（标注 do not edit），
 * 它只暴露 `credits.balances` / `credits.claimAll` 两个 RPC，而它内部其实还有
 * 整条 `/v1/ops/delivery` 活动面与 `credit[].ratio_display` 倍率 —— 只是没有
 * 出口。这一份模块读**同一个账号池、同一份凭据**，自己发请求，于是：
 *
 * 1. 面板能看到「已领 / 可领 / 不可领」的逐活动状态与领取结果（渠道包只报
 *    每日签到那一项）；
 * 2. 模型列表能显示上游真正的倍率（渠道包把 `credit[]` 整个丢弃了）。
 *
 * ## 协议来源
 *
 * 端口与语义取自 MIT 许可的两个实现，逐字节对照后落在这里：
 * - `dsh-codearts`（`src/upstream.ts` / `src/credits.ts`，elegant01，MIT）；
 * - `dsh-providers-hub`（`src/codearts-credits.ts`，iJetLi，MIT）。
 *
 * 活动：`GET /v1/ops/delivery?channel=IDE`；领取 `POST /v1/ops/claim`
 * `{campaignId, channel:'IDE'}`，响应带 `id` 时再补 `POST /v1/ops/confirm`
 * `{campaignId}`（漏掉会让积分停在「待确认」）。重复领取上游回业务码
 * **40001**，那是「已领」而不是失败。
 *
 * 签名：华为云 SDK-HMAC-SHA256（AK/SK + 临时 security-token），canonical 请求
 * 的 uri 必须以 `/` 结尾——否则验签失败，这一点两个上游实现一致。
 *
 * @module src/channels/codearts.js
 */

import crypto from 'node:crypto'
import { codeartsRateLabel } from './codearts-catalog.js'

export const SNAP_ENGINE_URL = 'https://snap-access.cn-north-4.myhuaweicloud.com'
export const OPS_DELIVERY_PATH = '/v1/ops/delivery'
export const OPS_CLAIM_PATH = '/v1/ops/claim'
export const OPS_CONFIRM_PATH = '/v1/ops/confirm'
export const OPS_CHANNEL = 'IDE'
export const STATISTICS_PATH = '/snap-manager/v1/statistics/plugin'
export const MODEL_BUILTIN_PATH = '/v1/model/builtin'

/**
 * snap 端点的路由判据头。
 *
 * ⚠️ 是否**参与签名**按端点分两种口径（`dsh-providers-hub` 的逐一实测表）：
 *
 * | 端点 | 头 | 是否参与签名 |
 * | --- | --- | --- |
 * | `/v1/model/builtin` | `Agent-Type` / `X-Language`（大写） | **不签** |
 * | `/v1/ops/*`、`/snap-manager/*` | 同上 | **不签** |
 * | agent-center（本模块未用） | `agent-type` / `x-language`（小写） | 签 |
 *
 * 本模块只走「不签」的那三类，故头在签名之后合并进去；若以后加 agent-center，
 * 必须把这两人头传进 `signHuawei` 的 `extraHeaders`，否则上游回 400
 * `TM.00001001`「未找到合法可路由api」。
 */
const SNAP_HEADERS = { 'Agent-Type': 'PromptCenter', 'X-Language': 'zh-cn' }

/** 已领取态（活动列表里可能出现的一种 status）。 */
const CLAIMED_STATUSES = new Set(['CLAIMED', 'CONFIRMED', 'CONSUMED'])
/** 重复领取的业务码。 */
const ALREADY_CLAIMED_CODE = 40001
/** 每日签到活动的类型（与渠道包 `findDailyCheckinActivity` 同判据）。 */
const DAILY_LOGIN_TYPE = 'USER_LOGIN'
const REQUEST_TIMEOUT_MS = 30_000

/* ── 签名 ─────────────────────────────────────────────────────────────────── */

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex')
}

function hmacSha256Hex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex')
}

/**
 * 生成华为云签名头。返回值是**完整**的头表（含 `Authorization`），调用方原样
 * 使用即可；不修改入参、不触网，故可直接用固定时钟的测试向量断言。
 *
 * @param {{ak: string, sk: string, securityToken: string}} credential
 * @param {string} method
 * @param {string} urlString
 * @param {string} body - 必须与实际发送的字节**完全一致**（空请求体用 ''）
 * @param {Record<string,string>} [extraHeaders] - 参与签名的附加头
 * @param {Date} [now] - 测试用时钟
 * @returns {Record<string,string>}
 */
export function signHuawei(credential, method, urlString, body, extraHeaders = {}, now = new Date()) {
  const url = new URL(urlString)
  let uri = url.pathname
  if (!uri.endsWith('/')) uri += '/'
  const query = url.search.slice(1)
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
  const payloadHash = sha256Hex(body)
  const headers = new Map()
  headers.set('host', url.host)
  headers.set('x-sdk-date', stamp)
  headers.set('x-sdk-content-sha256', payloadHash)
  headers.set('x-security-token', credential.securityToken ?? '')
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key.toLowerCase(), value)
  if (method.toUpperCase() !== 'GET') headers.set('content-type', 'application/json')
  const signedNames = [...headers.keys()].sort()
  const canonical = [
    method.toUpperCase(),
    uri,
    query,
    signedNames.map(name => `${name}:${headers.get(name) ?? ''}`).join('\n'),
    '',
    signedNames.join(';'),
    payloadHash,
  ].join('\n')
  const stringToSign = `SDK-HMAC-SHA256\n${stamp}\n${sha256Hex(canonical)}`
  const signature = hmacSha256Hex(credential.sk ?? '', stringToSign)
  headers.set('authorization', `SDK-HMAC-SHA256 Access=${credential.ak},SignedHeaders=${signedNames.join(';')},Signature=${signature}`)
  headers.delete('host')
  headers.delete('x-sdk-content-sha256')
  const out = {}
  for (const [key, value] of headers) out[key] = value
  return out
}

/* ── 传输 ────────────────────────────────────────────────────────────────── */

/** 一次签名的 snap 请求；返回 `{ok, status, data, message, code}`。 */
async function snapRequest(credential, method, url, body, fetchImpl) {
  const text = body ?? ''
  const headers = { ...SNAP_HEADERS, ...signHuawei(credential, method, url, text) }
  let response
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      ...method === 'GET' ? {} : { body: text },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, status: 0, message: `网络失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const raw = await response.text().catch(() => '')
  let data
  try {
    data = raw === '' ? {} : JSON.parse(raw)
  } catch {
    return { ok: false, status: response.status, message: `响应不是 JSON（HTTP ${response.status}）` }
  }
  const code = typeof data?.error_code === 'string' ? data.error_code : ''
  const message = typeof data?.error_msg === 'string' ? data.error_msg : ''
  const businessOk = code === '' || code === '0000'
  if (!response.ok || !businessOk) {
    return {
      ok: false,
      status: response.status,
      code: data?.code,
      // 失败原因必须带出来：用户看到「领取失败」而不知道是余额不足还是活动结束，
      // 只会重复点击。
      message: [code, message, data?.message].filter(part => typeof part === 'string' && part !== '').join(' ').trim()
        || `HTTP ${response.status}`,
    }
  }
  return { ok: true, status: response.status, data }
}

/* ── 解析 ────────────────────────────────────────────────────────────────── */

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/** `statistics/plugin` → 余额与套餐口径。无法解析返回 null（不显示假 0）。 */
export function parseAccountInfo(payload) {
  const body = payload !== null && typeof payload === 'object' ? payload : {}
  const metrics = Array.isArray(body.metrics) ? body.metrics : []
  if (metrics.length === 0) return null
  const byName = name => metrics.find(metric => metric?.name === name)
  const category = metric => {
    if (metric === undefined) return undefined
    const total = num(metric.package_credit_amount)
    const used = num(metric.package_credit_used)
    const remain = num(metric.package_credit_remain)
    // 上游用 -1 表示「该指标不适用」——负值一律当「没有」，否则会显示成 -1。
    const pick = value => (value !== undefined && value >= 0 ? value : 0)
    if (total === undefined && used === undefined && remain === undefined) return undefined
    return { total: pick(total), used: pick(used), remain: pick(remain), expiring: pick(num(metric.package_credit_expiring_amount)) }
  }
  const total = category(byName('usageTotalPackageCredit'))
  if (total === undefined) return null
  const pkg = body.package !== null && typeof body.package === 'object' ? body.package : {}
  return {
    planName: typeof pkg.package_name_cn === 'string' ? pkg.package_name_cn : (typeof pkg.package_name_en === 'string' ? pkg.package_name_en : ''),
    planStatus: pkg.status === 'normal' ? 'active' : pkg.status === 'closed' ? 'expired' : pkg.status === 'freeze' ? 'frozen' : 'unknown',
    isCreditPackage: pkg.is_credit_package === true,
    isTokenPackage: pkg.is_token_package === true,
    periodStart: typeof body.start_date === 'string' ? body.start_date : '',
    periodEnd: typeof body.end_date === 'string' ? body.end_date : '',
    total,
    bonus: category(byName('usageBonusPackageCredit')),
    basic: category(byName('usageBasicPackageCredit')),
    onDemand: category(byName('usageOnDemandPackageCredit')),
  }
}

/** `/v1/ops/delivery` → 活动数组（形状按上游原样，缺字段就少给）。 */
export function parseActivities(payload) {
  const body = payload !== null && typeof payload === 'object' ? payload : {}
  const items = Array.isArray(body.items) ? body.items : Array.isArray(body.activities) ? body.activities : []
  return items.filter(item => item !== null && typeof item === 'object').map(item => ({
    campaignId: String(item.campaignId ?? item.campaign_id ?? ''),
    type: typeof item.type === 'string' ? item.type : '',
    title: typeof item.title === 'string' ? item.title : '',
    claimable: item.claimable === true,
    status: typeof item.status === 'string' ? item.status : '',
    amount: num(item.benefitAmount) ?? num(item.amount) ?? num(item.creditAmount) ?? 0,
  }))
}

/**
 * `/v1/model/builtin` → `{modelId: 'x0.18'}`；没有 credit 的模型不出现在表里。
 *
 * 2026-11-25：时段选择改为与**渠道选择器同一份**实现（`codearts-catalog.js`）——
 * 错峰时段（21:00–次日 7:59）deepseek 是 0.09x，面板与选择器必须显示同一个数，
 * 否则同一行会出现两个倍率。`nowMs` 只为测试注入。
 */
export function parseRatios(payload, nowMs = Date.now()) {
  const body = payload !== null && typeof payload === 'object' ? payload : {}
  const rows = Array.isArray(body.builtinModels) ? body.builtinModels : []
  const out = {}
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = typeof row.model_id === 'string' ? row.model_id.trim() : ''
    if (id === '' || row.enable === false) continue
    const label = codeartsRateLabel(row, nowMs)
    if (label !== undefined) out[id] = label
  }
  return out
}

/** 领取结果 → 面板上的三种结论（与渠道包的 `ClaimOutcome` 同语义）。 */
export function classifyClaim(activity, result) {
  if (activity?.claimable !== true) {
    return CLAIMED_STATUSES.has(activity?.status ?? '')
      ? { kind: 'already-claimed', message: '今天已领取' }
      : { kind: 'inactive', message: `当前不可领取（status=${activity?.status ?? '—'}）` }
  }
  // ⚠️ 重复领取上游回的是 **HTTP 200 + 业务码 40001**（渠道包与 upstream 两处
  // 都记了这个形态），所以「HTTP 成功」不等于「领到了」——先看业务码。
  const bodyCode = result?.data?.code ?? result?.code
  if (bodyCode === ALREADY_CLAIMED_CODE) return { kind: 'already-claimed', message: '今天已领取' }
  if (result?.ok === true) {
    return { kind: 'claimed', credit: num(result.data?.benefitAmount) ?? activity.amount ?? 0 }
  }
  if (/40001/.test(String(result?.message ?? ''))) return { kind: 'already-claimed', message: '今天已领取' }
  return { kind: 'failed', message: result?.message ?? '领取失败' }
}

/* ── 对外服务 ────────────────────────────────────────────────────────────── */

/**
 * 建一个 CodeArts 权益读取器。
 *
 * @param {object} options
 * @param {(account: object) => Promise<object|null>} options.credentialOf - 由 pool.js 提供
 * @param {Function} [options.fetch] - 测试注入
 * @returns {{statusOf: Function, claim: Function}}
 */
export function createCodeArtsExtras({ credentialOf, fetch: fetchImpl = fetch }) {
  const need = credential => {
    const ak = credential?.access_key_id
    const sk = credential?.secret_access_key
    if (typeof ak !== 'string' || ak === '' || typeof sk !== 'string' || sk === '') return null
    return { ak, sk, securityToken: typeof credential.security_token === 'string' ? credential.security_token : '' }
  }

  async function statusOf(account) {
    const raw = await credentialOf(account)
    const credential = need(raw)
    if (credential === null) return { accountId: account?.id ?? '', error: '凭据不可用（缺 AK/SK）' }
    const [infoResult, activityResult, ratioResult] = await Promise.all([
      snapRequest(credential, 'GET', `${SNAP_ENGINE_URL}${STATISTICS_PATH}`, '', fetchImpl),
      snapRequest(credential, 'GET', `${SNAP_ENGINE_URL}${OPS_DELIVERY_PATH}?channel=${OPS_CHANNEL}`, '', fetchImpl),
      snapRequest(credential, 'GET', `${SNAP_ENGINE_URL}${MODEL_BUILTIN_PATH}`, '', fetchImpl),
    ])
    const info = infoResult.ok ? parseAccountInfo(infoResult.data) : null
    return {
      accountId: typeof account?.id === 'string' ? account.id : '',
      nickname: typeof account?.nickname === 'string' ? account.nickname : '',
      info,
      ...infoResult.ok ? {} : { infoError: infoResult.message },
      activities: activityResult.ok ? parseActivities(activityResult.data) : [],
      ...activityResult.ok ? {} : { activitiesError: activityResult.message },
      ratios: ratioResult.ok ? parseRatios(ratioResult.data) : {},
      ...ratioResult.ok ? {} : { ratiosError: ratioResult.message },
    }
  }

  async function claim(account, campaignId) {
    const credential = need(await credentialOf(account))
    if (credential === null) return { kind: 'failed', message: '凭据不可用（缺 AK/SK）' }
    const list = await snapRequest(credential, 'GET', `${SNAP_ENGINE_URL}${OPS_DELIVERY_PATH}?channel=${OPS_CHANNEL}`, '', fetchImpl)
    if (!list.ok) return { kind: 'failed', message: `活动列表查询失败：${list.message}` }
    const activities = parseActivities(list.data)
    const activity = typeof campaignId === 'string' && campaignId !== ''
      ? activities.find(row => row.campaignId === campaignId)
      : activities.find(row => row.type === DAILY_LOGIN_TYPE)
    if (activity === undefined) return { kind: 'inactive', message: '未找到该活动' }
    if (activity.campaignId === '') return { kind: 'failed', message: '活动缺少 campaignId' }
    const claimed = await snapRequest(
      credential,
      'POST',
      `${SNAP_ENGINE_URL}${OPS_CLAIM_PATH}`,
      JSON.stringify({ campaignId: activity.campaignId, channel: OPS_CHANNEL }),
      fetchImpl,
    )
    const outcome = classifyClaim(activity, claimed)
    if (outcome.kind !== 'claimed') return outcome
    // 响应带 `id` 时必须补确认，否则积分停在待确认（上游两个实现都这么做）。
    if (claimed.data?.id !== undefined && claimed.data?.id !== null) {
      await snapRequest(credential, 'POST', `${SNAP_ENGINE_URL}${OPS_CONFIRM_PATH}`, JSON.stringify({ campaignId: activity.campaignId }), fetchImpl)
    }
    return { ...outcome, campaignId: activity.campaignId, title: activity.title }
  }

  return { statusOf, claim }
}