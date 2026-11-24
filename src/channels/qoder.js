/**
 * Qoder / Qoder 中国版的**模型目录与倍率**扩展。
 *
 * ## 为什么需要它
 *
 * 渠道包里的 Qoder 适配器**一次网络请求都不发**：它的注释说「模型列表端点需要
 * WASM 签名，本插件不实现，故恒用产品兜底表」。于是面板与选择器上的模型、倍率
 * 全部停在 2026-09/10 的快照上，上游调价或增删模型后我们显示的是旧价。
 *
 * 本模块按「**先试真、再退实测表**」两段做：
 *
 * 1. **先试** `GET {openapi}/algo/api/v2/model/list?Encode=1`。渠道包存的是设备
 *    OAuth 凭据（`access_token` / `security_oauth_token`），而社区实现
 *    （`dsh-connect-qoder`）用的是 PAT→cosy 会话签名 —— 两套凭据代次不同，故这里
 *    **先用设备 token 直试**（最省事），并把 cosy 头一并带上（有就带，没有不影响）：
 *    成功即用真目录与真倍率。
 * 2. **退实测表**：401/403/404 或形状不认识时，退回 `dsh-connect-qoder` 在
 *    2026-11-02 对上游 `model/list` 实测抄下的表（key + `price_factor` + 思考档位），
 *    并如实标注来源为 `static` —— 面板据此显示「快照」而不是假装是实时价。
 *
 * ## 为什么不再要 WASM
 *
 * 渠道包里的 WASM 只为**构造加密推理请求**（`qodercontext_prepareInferRequest`），
 * 与目录端点无关。目录失败的原因是**凭据代次**（设备 token vs cosy 会话），
 * 不是签名算法缺失 —— 这一点决定了本模块的策略：能用就用，不能用就如实回退。
 *
 * @module src/channels/qoder.js
 */

/** 两个站点各自的 openapi 主机（与 `dsh-connect-qoder` 的区域表一致）。 */
const OPENAPI = {
  qoder: 'https://openapi.qoder.sh',
  qodercn: 'https://openapi.qoder.com.cn',
}

/** 目录端点（`Encode=1` 是上游要求的编码开关）。 */
const MODELS_PATH = '/algo/api/v2/model/list?Encode=1'

const REQUEST_TIMEOUT_MS = 20_000

/**
 * 实测兜底表（`dsh-connect-qoder` 2026-11-02 对 CN / Global 两区各抓一次）。
 *
 * 字段口径：
 * - `rate` = 上游 `price_factor`（计费倍率；**0 是真实报价「免费」**，不是缺值）；
 * - `efforts` / `defaultEffort` = 上游 `thinking_config` 声明的档位（顺序即强度）；
 * - `contextWindow` 取实测的 `maxInputTokens`。
 *
 * ⚠️ 这张表是**快照**：面板会把它标成 `static`。上游改价后它不会自动跟上，只能
 * 靠「先试真」那条腿；两条都拿不到时**不猜**。
 */
const FALLBACK = [
  { id: 'qmodel_38max', name: 'Qwen3.8-Max', rate: 0.5, contextWindow: 180_000, efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' },
  { id: 'qfmodel', name: 'Qwen3.8-Flash', rate: 0, contextWindow: 180_000, efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' },
  { id: 'dmodel', name: 'DeepSeek-V4-Pro', rate: 0.5, contextWindow: 180_000, efforts: ['high', 'max'], defaultEffort: 'max' },
  { id: 'dfmodel', name: 'DeepSeek-Flash', rate: 0.1, contextWindow: 180_000, efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  { id: 'gmodel', name: 'GLM-5.3', rate: 0.8, contextWindow: 180_000, efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  { id: 'gfmodel', name: 'GLM-5.3-Flash', rate: 0.1, contextWindow: 180_000, efforts: ['high', 'max'], defaultEffort: 'max' },
  { id: 'kmodel_latest', name: 'Kimi-K3.1-Pro', rate: 1, contextWindow: 180_000, efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  { id: 'kmodel', name: 'Kimi-K2.8-Preview', rate: 0.8, contextWindow: 180_000, efforts: ['low', 'high', 'max'], defaultEffort: 'high' },
  { id: 'mmodel', name: 'MiniMax-M3.1-Flash', rate: 0.1, contextWindow: 180_000 },
  { id: 'fast', name: 'Fast', rate: 0.8, contextWindow: 200_000 },
  { id: 'ultimate', name: 'Ultimate', rate: 2, contextWindow: 180_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  { id: 'efficient', name: 'Efficient', rate: 0.3, contextWindow: 200_000 },
  { id: 'smodel', name: 'Sonus', rate: 8, contextWindow: 180_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
  { id: 'cmodel', name: 'Cantus', rate: 4, contextWindow: 180_000, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
]

/** 倍率的显示写法：`x0.5` / `x2`（0 照写为 `x0`，与「没有倍率」不是一回事）。 */
function rateLabel(rate) {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return undefined
  return `x${Number(rate.toFixed(2))}`
}

/** 从一行远端目录里取倍率：两种键形都认（`price_factor` / `priceFactor`）。 */
function rateOf(row) {
  const raw = row?.price_factor ?? row?.priceFactor ?? row?.effectiveMultiple
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined
}

/**
 * 解析远端 `model/list` 的响应。
 *
 * 形状按社区实现的实测（`qoder2api` / `dsh-connect-qoder`）：`{ data: { models: [] } }`
 * 或 `{ data: [] }` 都见过，故两条都认；id 取 `key` / `model_key` / `modelKey`。
 * **不认识的行直接丢**，不猜。
 */
export function parseQoderListing(payload) {
  const root = payload !== null && typeof payload === 'object' ? payload : {}
  const data = root.data !== null && typeof root.data === 'object' ? root.data : root
  const rows = Array.isArray(data) ? data
    : Array.isArray(data.models) ? data.models
      : Array.isArray(root.models) ? root.models
        : []
  const out = []
  const seen = new Set()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = String(row.key ?? row.model_key ?? row.modelKey ?? row.model ?? '').trim()
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    const name = String(row.displayName ?? row.display_name ?? row.name ?? id).trim()
    const rate = rateOf(row)
    const efforts = Array.isArray(row.thinking_efforts) ? row.thinking_efforts.filter(item => typeof item === 'string')
      : Array.isArray(row.thinkingEfforts) ? row.thinkingEfforts.filter(item => typeof item === 'string')
        : undefined
    out.push({
      id,
      name: name === '' ? id : name,
      ...rate === undefined ? {} : { rate },
      ...efforts === undefined || efforts.length === 0 ? {} : { efforts },
    })
  }
  return out
}

/**
 * 建 Qoder 目录读取器。
 *
 * @param {object} options
 * @param {(account: object) => Promise<object|null>} options.credentialOf
 * @param {Function} [options.fetch]
 */
export function createQoderExtras({ credentialOf, fetch: fetchImpl = fetch }) {
  async function statusOf(account) {
    const provider = account?.provider === 'qoder' ? 'qoder' : 'qodercn'
    const credential = await credentialOf(account)
    const token = typeof credential?.access_token === 'string' && credential.access_token !== ''
      ? credential.access_token
      : typeof credential?.security_oauth_token === 'string' ? credential.security_oauth_token : ''
    const base = { accountId: typeof account?.id === 'string' ? account.id : '', nickname: typeof account?.nickname === 'string' ? account.nickname : '' }

    if (token !== '') {
      // 先试真：设备 token 直打目录端点；cosy 头有就带（没有也不算错）。
      const headers = {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'cosy-clienttype': '10',
        'cosy-version': '1.1.69',
      }
      if (typeof credential?.cosy_key === 'string') headers['cosy-key'] = credential.cosy_key
      if (typeof credential?.machine_id === 'string') headers['cosy-machineid'] = credential.machine_id
      try {
        const response = await fetchImpl(`${OPENAPI[provider]}${MODELS_PATH}`, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
        if (response.ok) {
          const text = await response.text()
          let payload
          try { payload = JSON.parse(text) } catch { payload = null }
          const models = parseQoderListing(payload)
          if (models.length > 0) {
            return { ...base, catalog: models, ratios: ratiosOf(models), source: 'live' }
          }
          // HTTP 200 但一行都不认识：形状变了，不要在面板上假装「目录为空」。
          return { ...base, catalog: FALLBACK.map(fallbackRow), ratios: ratiosOf(FALLBACK), source: 'static', note: '远端目录形状不认识，已回退实测表' }
        }
      } catch {
        // 网络失败 → 落到实测表；不把异常抛给面板（权益查询不该让整张卡片变红）。
      }
    }
    return { ...base, catalog: FALLBACK.map(fallbackRow), ratios: ratiosOf(FALLBACK), source: 'static' }
  }

  /** Qoder 的「领取」由渠道包负责（`credits.claimAll` 已覆盖两家站点）。 */
  async function claim() {
    return { kind: 'inactive', message: 'Qoder 的每日积分由渠道包的签到负责（面板上的「领取」按钮）' }
  }

  return { statusOf, claim }
}

/** 兜底行 → 统一目录行（名字带倍率后缀，与其余渠道同约定）。 */
function fallbackRow(entry) {
  const label = rateLabel(entry.rate)
  return {
    id: entry.id,
    name: label === undefined ? entry.name : `${entry.name} · ${label}`,
    ...entry.rate === undefined ? {} : { rate: entry.rate },
    ...entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow },
    ...entry.efforts === undefined ? {} : { efforts: entry.efforts, defaultEffort: entry.defaultEffort },
  }
}

/** 目录 → `{id: 'xN'}`（面板的倍率标签直接读它）。 */
function ratiosOf(rows) {
  const out = {}
  for (const row of rows) {
    const label = rateLabel(row.rate)
    if (label !== undefined) out[row.id] = label
  }
  return out
}