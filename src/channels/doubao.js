/**
 * 豆包（`doubao`，字节跳动）的登录、签到与额度契约。
 *
 * ## 鉴权 = **纯 cookie**，签名 = **query 的 `a_bogus`**
 *
 * 会话态由 `.doubao.com` 上的 `sessionid` / `sid_tt` / `ttwid` 等一组 cookie 承载，
 * **没有** `Authorization` 头。签到请求另外带一个 `a_bogus` 查询参数，它由**豆包页面
 * 上下文**里的 `bdms.frontierSign` 生成（`window.bdms` 只在 doubao.com 页面里存在）。
 *
 * ⇒ 纯 Node `fetch` 裸调签到恒回 `710010702`（哪怕 cookie/query 全对）。本模块因此
 * 必须借用宿主起的 Chromium（`src/channels/browser/chromium.js`）：在页面里算完签名，
 * 再把签名值交给 Node 侧发请求。这正是「一次签到要起一个浏览器」的全部理由。
 *
 * ## 三条腿里只有签到要签名
 *
 * | 腿 | 路径 | 要 `a_bogus` | 用途 |
 * | --- | --- | --- | --- |
 * | 签到 | `/alice/ug/campaign/landing/checkin` | **是** | 领每日额度（幂等） |
 * | 签到状态 | `/alice/ug/campaign/landing/get` | 否 | 面板「今天签没签」 |
 * | 额度 | `/alice/commerce/sale/subscription/quota/summary/` | 否 | 面板额度窗口 |
 *
 * ## query 为什么要**有序数组**
 *
 * ⚠️ 上游的公共 query 是一份固定清单（`doubaoCheckinQuery`），顺序与字节形态逐字节
 * 比对过：用 `URLSearchParams` 之类的映射结构会按插入序重排、并把 `-` / `:` 编码成
 * `%2D` / `%3A`（`use-olympus-account`、`Asia/Shanghai` 就在里面），签出来的串与
 * 抓包不一致。故这里返回**数组**，调用方按序拼接，别用 `Object.keys`。
 *
 * ## 设备身份：**确定性派生 + 每账号一套**
 *
 * 签到 query 里的 `device_id` / `web_id` / `tea_uuid` 都是 19 位数字。登录会话里的
 * `s_v_web_id`（`verify_…` 前缀）与 `ttwid`（URL 编码串）是**预验证 id**，服务端没
 * 注册过 ⇒ 拿它们当设备号会被当成新设备（同 `src/channels/trae.js` 的
 * `deriveDeviceId15` 纪律）。故：`accountKey`（= `sessionid`）经 SHA-256 派生
 * **每账号一套、跨日稳定**的 19 位数字；凭据里存的显式设备号只有 15–21 位纯数字
 * 才算数（老凭据里的 verify 形态一律回落派生）。
 *
 * ## `710010702` 不是「系统错误」
 *
 * 实测（多轮对照实验，含官方客户端环境）：它是**当前没有可领的签到活动**——
 * 今日名额发完 / 活动未对该账号投放 / 活动已收摊，三者对用户动作相同（明天再看）。
 * 归 `inactive`，不按网络故障排查。
 *
 * ## 2026-11-24 真机取证（这台机器，Edge headless）
 *
 * | 观察 | 结论 |
 * | --- | --- |
 * | `www.doubao.com/chat/` 匿名加载，约 15–20 s 后 `window.bdms.frontierSign` 出现 | 签名环境**不需要**豆包客户端内核；但要等懒加载的 chunk，别一打开就判失败 |
 * | `frontierSign({'X-MS-STUB': ''})` → `{'X-Bogus': 'f47N354pgz-Kt/Xg'}` | 返回值是**对象**、键名 `X-Bogus`；值里带 `/`，进 URL 必须编码 |
 * | 传 `pathname+search` 字符串也回 `{X-Bogus}` | 两种调用口径都吃，故签名表达式对返回形态宽容 |
 * | 无 cookie 打额度腿 → `710012001 login invalid` | 端点与 query 形状**被接受**（参数错会是 `710010202`），只差登录态 |
 * | 无 cookie 打状态腿 → 同上 | 状态腿形状正确 |
 *
 * 未取证（需要一枚真实登录 cookie，本轮没有）：`checked_in` 字段在**状态腿**里是否
 * 存在、`reward_amount` 的实际取值。故状态腿对字段做宽容读取，读不到就回「不知道」。
 *
 * @module src/channels/doubao.js
 */

import crypto from 'node:crypto'
import { startChromiumSession } from './browser/chromium.js'

export const DOUBAO = Object.freeze({
  id: 'doubao',
  displayName: '豆包',
  baseUrl: 'https://www.doubao.com',
  pageUrl: 'https://www.doubao.com/chat/',
  checkinPath: '/alice/ug/campaign/landing/checkin',
  checkinStatusPath: '/alice/ug/campaign/landing/get',
  quotaPath: '/alice/commerce/sale/subscription/quota/summary/',
  /** 模型目录（免签名；缺 ot_id 回 710010202）。 */
  briefListPath: '/alice/slot/action_bar_v3/brief_list',
  chatPath: '/chat/completion',
  /** 签到活动组码（实测自客户端 user-growth 快照）。 */
  campaignScene: 'pc_incentive_task_mvp_v3',
  /** 面板上那条活动的 id（自有渠道的 claim 按 campaignId 分派，单活动即常量）。 */
  checkinCampaignId: 'doubao:checkin',
  /** 活动侧的 `aid`（签到/状态两条腿）。 */
  campaignAid: '497858',
  /** 网页服务侧的 `aid`（额度腿；**与活动侧不同，别混**）。 */
  webAid: '582478',
  /** 客户端版本号（风控看它，随上游发版变化）。 */
  clientVersion: '2.31.4',
  runtimeVersion: '3.39.0',
  chromiumVersion: '147.0.7727.149',
})

const REQUEST_TIMEOUT_MS = 20_000
/**
 * 等页面 `bdms` 就绪的上限。
 *
 * ⚠️ 实测（2026-11-24 本机 Edge headless）：`/chat/` 的签名函数在**懒加载 chunk**
 * 里，冷启动要 15–20 秒才注入。给 45 秒是因为签到那条腿会先 `Page.navigate` 一次
 * （注入 cookie 后重载），两段加载串起来可能比单次更慢。
 */
const SIGN_READY_TIMEOUT_MS = 45_000
/** 轮询间隔：页面每跳一次导航，`bdms` 都要重新注入。 */
const SIGN_POLL_INTERVAL_MS = 400
/**
 * 上游的「登录态无效」业务码（实测：无 cookie 打额度/状态两条腿都回 `710012001`）。
 *
 * 与 `710010702`（没有可领活动）**不是一回事**：它要用户去重新登录。
 */
const DOUBAO_LOGIN_INVALID_CODE = 710012001

/* ── 设备身份（确定性派生，每账号一套） ─────────────────────────────────── */

/**
 * SHA-256 确定性伪随机流：`(seed, salt)` 永远产生相同的字节序列。
 *
 * 与 `src/channels/trae.js` 的 `seededStream` 同算法 —— 两家都是字节系活动系统，
 * 设备维度的纪律也同源（每账号一套、跨日稳定）。
 */
function seededStream(seed, salt, nbytes) {
  const prefix = `${salt}:${seed}`
  const out = []
  let counter = 0
  while (out.length < nbytes) {
    const counterBuf = Buffer.alloc(4)
    counterBuf.writeUInt32BE(counter >>> 0, 0)
    const digest = crypto.createHash('sha256').update(prefix, 'utf8').update(counterBuf).digest()
    for (const byte of digest) {
      out.push(byte)
      if (out.length >= nbytes) break
    }
    counter += 1
  }
  return out.slice(0, nbytes)
}

/** 确定性派生 N 位数字串（19 位对齐豆包抓包里的 device_id/web_id 形态）。 */
function seededDigits(n, seed, salt) {
  return seededStream(seed, salt, n).map(byte => String(byte % 10)).join('')
}

/**
 * ★ 账号的设备身份：由 `accountKey` 派生，**每账号一套**。
 *
 * 同账号永远同一套（跨日、跨设备）；不同账号天然不同 —— 规避服务端
 * 「每设备每天一次」的配额（TRAE 那条实测过的坑，同族活动系统）。
 *
 * @param {string} accountKey - 账号稳定标识（`sessionid`）
 */
export function doubaoDerivedDeviceIdentity(accountKey) {
  const seed = typeof accountKey === 'string' && accountKey !== '' ? accountKey : 'doubao-anon'
  return {
    deviceId: seededDigits(19, seed, 'dbdev'),
    webId: seededDigits(19, seed, 'dbweb'),
    teaUuid: seededDigits(19, seed, 'dbtea'),
  }
}

/** 15–21 位纯数字才是「服务端注册过的设备号」形态（verify 前缀 / 含 `%|` 一律不算）。 */
function isRegisteredDeviceShape(value) {
  return typeof value === 'string' && /^\d{15,21}$/.test(value)
}

/** 从 cookie 头里取 `sessionid`（账号稳定标识）。 */
export function sessionIdFromCookie(cookie) {
  if (typeof cookie !== 'string' || cookie === '') return undefined
  for (const pair of cookie.split(';')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    if (pair.slice(0, eq).trim() !== 'sessionid') continue
    const value = pair.slice(eq + 1).trim()
    return value === '' ? undefined : value
  }
  return undefined
}

/**
 * 本账号的设备身份：显式存的合法设备号优先，否则走确定性派生。
 *
 * ⚠️ 老凭据里存过 `s_v_web_id` / `ttwid` —— 它们不是注册形态，`isRegisteredDeviceShape`
 * 会让它们回落派生（否则每次签到都在冒充一台新设备）。
 */
export function doubaoDeviceIdentityOf(credential) {
  const seed = typeof credential?.accountKey === 'string' && credential.accountKey !== ''
    ? credential.accountKey
    : (sessionIdFromCookie(credential?.cookie) ?? 'doubao-anon')
  const derived = doubaoDerivedDeviceIdentity(seed)
  return {
    deviceId: isRegisteredDeviceShape(credential?.deviceId) ? credential.deviceId : derived.deviceId,
    webId: isRegisteredDeviceShape(credential?.webId) ? credential.webId : derived.webId,
    teaUuid: derived.teaUuid,
  }
}

/* ── cookie 头 ⇄ 列表 ────────────────────────────────────────────────────── */

/** `name=value; …` → `[[name, value], …]`（`Network.setCookie` 逐条注入用）。 */
export function parseDoubaoCookieHeader(header) {
  const out = []
  if (typeof header !== 'string') return out
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    if (name === '' || value === '') continue
    out.push([name, value])
  }
  return out
}

/**
 * CDP `Network.getCookies` 的结果 → `Cookie` 头。
 *
 * 只收 `.doubao.com` / `.bytedance.com` 域（`msToken` 在后者），其余站点的 cookie
 * 混进来会撑大请求头、也可能触发上游的「跨站会话」判定。
 */
export function doubaoCookieHeaderFromList(list) {
  const pairs = []
  const seen = new Set()
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item?.name !== 'string' || typeof item?.value !== 'string') continue
    const domain = typeof item.domain === 'string' ? item.domain : ''
    if (domain !== '' && !domain.includes('doubao.com') && !domain.includes('bytedance.com')) continue
    if (item.name === '' || item.value === '' || seen.has(item.name)) continue
    seen.add(item.name)
    pairs.push(`${item.name}=${item.value}`)
  }
  return pairs.join('; ')
}

/* ── 请求构造 ────────────────────────────────────────────────────────────── */

/** 把 query 数组拼成待拼接/待签名的字符串（不含 `?`）。 */
export function doubaoQueryString(pairs) {
  return (Array.isArray(pairs) ? pairs : [])
    .filter(pair => Array.isArray(pair) && typeof pair[0] === 'string' && pair[0] !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value ?? ''))}`)
    .join('&')
}

/**
 * 签到/状态两条腿的公共 query（**不含 `a_bogus`**）。
 *
 * 顺序即上游字节序（见模块头）。`a_bogus` 另算、追加在最后。
 */
export function doubaoCheckinQuery(credential) {
  const { deviceId, webId, teaUuid } = doubaoDeviceIdentityOf(credential)
  return [
    ['version_code', '20800'],
    ['language', 'zh'],
    ['device_platform', 'web'],
    ['doubao_device_platform', 'web'],
    ['aid', DOUBAO.campaignAid],
    ['real_aid', DOUBAO.campaignAid],
    ['pkg_type', 'release_version'],
    ['device_id', deviceId],
    ['web_id', webId],
    ['tea_uuid', teaUuid],
    ['region', 'CN'],
    ['sys_region', 'CN'],
    ['samantha_web', '1'],
    ['web_platform', 'desktop'],
    ['use-olympus-account', '1'],
  ]
}

/**
 * 网页服务腿（额度 / 目录 / 对话）的公共 query。
 *
 * ⚠️ 与活动腿的差异是**实测**的，别「统一」掉：
 * `aid` 是 `582478`（活动腿是 `497858`）、`fp` 恒为 `verify_<device_id>`、
 * 另有 `pc_version` / `chromium_version` / `runtime_version` / `tz_name` 等客户端自报字段。
 */
export function doubaoWebQuery(credential) {
  const { deviceId, webId, teaUuid } = doubaoDeviceIdentityOf(credential)
  return [
    ['aid', DOUBAO.webAid],
    ['real_aid', DOUBAO.webAid],
    ['version_code', '20800'],
    ['pc_version', DOUBAO.clientVersion],
    ['device_id', deviceId],
    ['tea_uuid', teaUuid],
    ['web_id', webId],
    ['fp', `verify_${deviceId}`],
    ['chromium_version', DOUBAO.chromiumVersion],
    ['runtime_version', DOUBAO.runtimeVersion],
    ['channel', 'win'],
    ['language', 'zh'],
    ['region', 'CN'],
    ['sys_region', 'CN'],
    ['tz_name', 'Asia/Shanghai'],
    ['pkg_type', 'release_version'],
    ['client_platform', 'pc_client'],
    ['device_platform', 'web'],
    ['doubao_device_platform', 'desktop'],
    ['web_platform', 'desktop'],
    ['samantha_web', '1'],
    ['use-olympus-account', '1'],
    ['web_tab_id', crypto.randomUUID()],
  ]
}

/** 追加 `a_bogus`（页面算出来的值）后的完整签到 URL。 */
export function doubaoCheckinUrl(credential, aBogus) {
  const query = doubaoQueryString(doubaoCheckinQuery(credential))
  const signature = typeof aBogus === 'string' && aBogus !== '' ? `&a_bogus=${encodeURIComponent(aBogus)}` : ''
  return `${DOUBAO.baseUrl}${DOUBAO.checkinPath}?${query}${signature}`
}

/** 签到状态 URL（**不签名**）。 */
export function doubaoCheckinStatusUrl(credential) {
  return `${DOUBAO.baseUrl}${DOUBAO.checkinStatusPath}?${doubaoQueryString(doubaoCheckinQuery(credential))}`
}

/** 额度汇总 URL（**不签名**；只接受 POST，GET 同路径是 404）。 */
export function doubaoQuotaUrl(credential) {
  return `${DOUBAO.baseUrl}${DOUBAO.quotaPath}?${doubaoQueryString(doubaoWebQuery(credential))}`
}

/**
 * 客户端形态的请求头。
 *
 * ⚠️ `Referer` 必须是 `chrome://doubao-chat/`（客户端方案），**不能**是网页地址 ——
 * 与 TRAE 那条「UA 前缀决定 WAF 放行」同型：头是身份，不是装饰。
 */
export function doubaoHeaders(cookie, extra) {
  return {
    'User-Agent': `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${DOUBAO.chromiumVersion} Safari/537.36 SamanthaDoubao/${DOUBAO.clientVersion}`,
    Referer: 'chrome://doubao-chat/',
    accept: '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'content-type': 'application/json',
    'agw-js-conv': 'str',
    'sec-ch-ua': '"Chromium";v="147", "Not.A/Brand";v="8"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'x-flow-trace': `${crypto.randomUUID().replace(/-/g, '')}-${crypto.randomUUID().replace(/-/g, '')}-01`,
    cookie: typeof cookie === 'string' ? cookie : '',
    ...extra === undefined ? {} : extra,
  }
}

/* ── 签名（只能在页面里算） ──────────────────────────────────────────────── */

/**
 * 在页面里求 `a_bogus` 的表达式。
 *
 * 上游调用形态是 `bdms.frontierSign({'X-MS-STUB': ''})` → `{'X-Bogus': '…'}`；
 * 这里对**返回值形态宽容**：字符串、`X-Bogus`、`a_bogus`、`xBogus` 都吃
 * （不同版本的前端产物返回值不一样，只认一种会在发版后静默变成空串）。
 *
 * ⚠️ 页面没加载完 / `bdms` 还没注入时返回**空串** —— 调用方要**轮询等**，
 * 不能当成错误（用户刚打开窗口时必然如此）。
 */
export const DOUBAO_SIGN_EXPRESSION = `(() => {
  try {
    const bdms = window.bdms
    if (!bdms || typeof bdms.frontierSign !== 'function') return ''
    const out = bdms.frontierSign({ 'X-MS-STUB': '' })
    if (typeof out === 'string') return out
    if (out && typeof out === 'object') {
      const keys = ['X-Bogus', 'x-bogus', 'a_bogus', 'xBogus']
      for (const key of keys) {
        if (typeof out[key] === 'string' && out[key] !== '') return out[key]
      }
    }
    return ''
  } catch (error) { return '' }
})()`

/* ── 解析 ────────────────────────────────────────────────────────────────── */

/* ── 推理腿：目录 / 请求体 / 流翻译 ──────────────────────────────────────── */

/**
 * 豆包助手的 `bot_id`（目录与对话两处都要它；缺了目录回 `710010202`）。
 *
 * 实测 2026-11-24：`POST /alice/slot/action_bar_v3/brief_list` + `{bot_id, language_code}`
 * 回 200 / `code:0`，`data.entry_list` 是一棵 9 项的树，模型散在 `model_item_key` 节点里。
 */
export const DOUBAO_BOT_ID = '7338286299411103781'

/**
 * 兜底目录（远端 brief_list 失败时用）。
 *
 * 值来自**真机响应**（参考实现 2026-11-22 抓的 14 条 + 2026-11-24 本机多出的 `GLM 5.4`），
 * 不是编的：`mode` 是上游的模式号（1 = 对话，3 = 工作任务/会员额度），
 * `tags` 是上游的倍率/活动标签原样（`0.65x` / `限时优惠 0.01x` / `小额免费`）。
 */
export const DOUBAO_FALLBACK_MODELS = Object.freeze([
  { key: '0', name: '豆包 快速', mode: '1', tags: [] },
  { key: '3', name: '豆包 专家', mode: '1', tags: [] },
  { key: '9', name: '豆包 2.1 Auto', mode: '3', tags: ['小额免费'] },
  { key: 'seed-lite-7b', name: '豆包 2.1 Lite', mode: '3', tags: ['限时优惠 0.01x'] },
  { key: '5', name: '豆包 2.1 Pro', mode: '3', tags: ['0.65x'] },
  { key: 'person-deepseek-v4-1-flash-261017', name: 'DeepSeek V4.1 Flash', mode: '3', tags: ['限时优惠 0.01x'], efforts: ['3', '4', '5', '6', '7'] },
  { key: 'person-qwen4-max', name: 'Qwen 4 Max', mode: '3', tags: ['新上线 0.47x'] },
  { key: 'person-kimi-k3-1-pro-261111', name: 'Kimi K3.1 Pro', mode: '3', tags: ['0.95x'] },
  { key: 'person-kimi-k3-1-pro-highspeed-261111', name: 'Kimi K3.1 Pro 高速', mode: '3', tags: ['1.44x'] },
  { key: 'person-kimi-k3-261111', name: 'Kimi K3', mode: '3', tags: ['1.48x'] },
  { key: 'person-glm-5-4', name: 'GLM 5.4', mode: '3', tags: [] },
  { key: 'person-glm-5-3-261111', name: 'GLM 5.3', mode: '3', tags: ['0.80x'] },
  { key: 'person-glm-5-3-flash-261111', name: 'GLM 5.3 Flash', mode: '3', tags: ['0.08x'] },
  { key: 'person-deepseek-v4-pro-ga-260813', name: 'DeepSeek V4 Pro', mode: '3', tags: ['0.46x'] },
  { key: 'person-qwen3-8-max', name: 'Qwen 3.8 Max', mode: '3', tags: ['0.74x'] },
  { key: 'person-qwen3-8-flash', name: 'Qwen 3.8 Flash', mode: '3', tags: ['0.05x'] },
])

/**
 * 模型 → 模式号。目录是**运行时下发**的，所以这张表由 `statusOf` 解析后回填；
 * 兜底表先把已知的那 16 条塞进去，保证「没开过面板也能发请求」。
 */
const DOUBAO_MODES = new Map(DOUBAO_FALLBACK_MODELS.map(row => [row.key, row.mode]))

/** 记下目录里每个模型的模式号（`statusOf` 解析完调一次）。 */
export function rememberDoubaoModes(models) {
  for (const row of Array.isArray(models) ? models : []) {
    if (typeof row?.key === 'string' && row.key !== '' && typeof row?.mode === 'string') DOUBAO_MODES.set(row.key, row.mode)
  }
}

/** 模式号（未知一律按对话 1 —— 那是免费额度那条线，错也不会扣会员额度）。 */
export function doubaoModeOf(modelId) {
  const mode = DOUBAO_MODES.get(String(modelId ?? ''))
  return mode === '3' ? '3' : '1'
}

/** `tag_list` 的元素两种形态都见过：字符串，或 `{text}`。 */
export function doubaoTagList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const text = typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : ''
    const trimmed = text.trim()
    if (trimmed !== '') out.push(trimmed)
  }
  return out
}

/** 读档位列表（`reasoning_effort_config.option_list[]` 的 `level`/`name`）。 */
function doubaoReasoningEfforts(value) {
  const options = Array.isArray(value?.option_list) ? value.option_list : []
  const efforts = []
  for (const option of options) {
    if (option === null || typeof option !== 'object') continue
    const id = String(option.level ?? '')
    const name = typeof option.name === 'string' ? option.name.trim() : ''
    if (!/^\d+$/.test(id) || name === '' || efforts.some(row => row.id === id)) continue
    efforts.push({ id, name })
  }
  return efforts.length === 0 ? undefined : efforts
}

/**
 * `brief_list` → 模型表（**移植自参考实现的实测解析器**）。
 *
 * 上游把模型散在一棵嵌套树里，同一个 `model_item_key` 可能在多个「菜单外观」下重复
 * 出现（对话页 / 工作任务页各一份），且**只有菜单里那一份带模式号**。判据：
 * 1. 先按 `model_item_key` 归并所有外观；
 * 2. 优先用「有 `mode_id` 的菜单外观」；
 * 3. 默认模式取众数（唯一才算），冲突时退到「有 1 就 1，否则 3」——
 *    **宁可走免费对话线，也不要误扣会员额度**；
 * 4. 同一路线上多份能力描述**不一致**时，不声明档位（宁可不给，也别给错）。
 */
export function doubaoRemoteModels(payload) {
  const modeIdOf = value => (value === 1 || value === '1' ? '1' : value === 3 || value === '3' ? '3' : undefined)
  const found = new Map()
  const visit = (node, menuMode, reasoningEnabled) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item, menuMode, reasoningEnabled)
      return
    }
    if (node === null || typeof node !== 'object') return
    const mode = modeIdOf(node.mode_id) ?? menuMode
    const enabled = typeof node.show_reasoning_effort === 'boolean' ? node.show_reasoning_effort : reasoningEnabled
    const rawKey = node.model_item_key
    if ((typeof rawKey === 'string' || typeof rawKey === 'number') && rawKey !== '') {
      const key = String(rawKey)
      const rows = found.get(key) ?? []
      rows.push({
        name: typeof node.name === 'string' ? node.name.trim() : '',
        tags: doubaoTagList(node.tag_list),
        menuMode: mode,
        defaultMode: modeIdOf(node.default_mode),
        efforts: enabled ? doubaoReasoningEfforts(node.reasoning_effort_config) : undefined,
      })
      found.set(key, rows)
    }
    for (const value of Object.values(node)) visit(value, mode, enabled)
  }
  visit(payload, undefined, false)

  const out = []
  for (const [key, rows] of found) {
    const menu = rows.filter(row => row.menuMode !== undefined)
    const candidates = menu.length > 0 ? menu : rows
    const modeOf = row => row.menuMode ?? row.defaultMode ?? '1'
    const modes = new Set(candidates.map(modeOf))
    const defaults = new Set(candidates.filter(row => row.defaultMode !== undefined).map(row => row.defaultMode))
    const preferred = defaults.size === 1 ? [...defaults][0] : undefined
    const mode = preferred !== undefined && modes.has(preferred) ? preferred : (modes.has('1') || !modes.has('3') ? '1' : '3')
    const chosen = candidates.filter(row => modeOf(row) === mode)
    const efforts = chosen[0]?.efforts
    const sameEfforts = efforts !== undefined && chosen.every(row => JSON.stringify(row.efforts) === JSON.stringify(efforts))
    const display = [...chosen, ...rows]
    const name = display.find(row => row.name !== '')?.name ?? key
    const tags = display.find(row => row.tags.length > 0)?.tags ?? []
    out.push({ key, name, mode, tags, ...sameEfforts ? { efforts: efforts.map(row => row.id), effortNames: efforts } : {} })
  }
  return out
}

/** 拉目录（`POST /alice/slot/action_bar_v3/brief_list`，**不签名**）。 */
export async function fetchDoubaoBriefList(credential, options = {}) {
  const posted = await doubaoPost(`${DOUBAO.baseUrl}${DOUBAO.briefListPath}?${doubaoQueryString(doubaoWebQuery(credential))}`, {
    cookie: credential?.cookie,
    body: JSON.stringify({ bot_id: DOUBAO_BOT_ID, language_code: 'zh' }),
    ...options,
  })
  if (posted.error !== undefined) return { error: posted.error }
  const payload = posted.payload ?? {}
  const code = Number(payload.code)
  if (Number.isFinite(code) && code !== 0) return { error: doubaoErrorText(code, String(payload.message ?? payload.msg ?? '')) }
  const models = doubaoRemoteModels(payload)
  if (models.length === 0) return { error: '目录报文里没有可识别的模型（上游可能改版）' }
  rememberDoubaoModes(models)
  return { models }
}

/**
 * 请求体（**移植自参考实现的实测报文**）。
 *
 * ⚠️ 两条路由是**实测**的，别「统一」：
 * `mode=1 + agent_mode=2` = 普通对话（免费额度）；
 * `mode=3 + agent_mode=1` = 工作任务（会员付费额度）。
 * `need_deep_think`：普通对话 3、工作任务 10001、按档位时用 `10001`。
 */
export function buildDoubaoChatBody({ model, mode, prompt, reasoningEffort, now = Date.now() }) {
  const modeId = mode === '3' ? '3' : '1'
  const isTask = modeId === '3'
  const agentMode = isTask ? 1 : 2
  const effort = typeof reasoningEffort === 'string' && reasoningEffort !== '' ? reasoningEffort : '4'
  const needDeepThink = typeof reasoningEffort === 'string' && reasoningEffort !== '' ? (isTask ? 10001 : 3) : 0
  const stamp = String(now)
  return JSON.stringify({
    client_meta: {
      local_conversation_id: `local_${stamp}`,
      conversation_id: '',
      bot_id: DOUBAO_BOT_ID,
      last_section_id: '',
      last_message_index: null,
    },
    messages: [{
      local_message_id: `msg_${stamp}`,
      content_block: [{
        block_type: 10000,
        content: { text_block: { text: String(prompt ?? ''), icon_url: '', icon_url_dark: '', summary: '' }, pc_event_block: '' },
        block_id: 'blk_0',
        parent_id: '',
        meta_info: [],
        extra_info: {},
        append_fields: [],
      }],
      message_status: 0,
    }],
    option: {
      agent_mode: agentMode,
      need_deep_think: needDeepThink,
      scene_type: 0,
      need_create_conversation: true,
      conversation_init_option: { need_ack_conversation: true },
      conversation_init_ext: { model_item_key: model, reasoning_effort: effort, mode_id: modeId },
      sse_recv_event_options: { support_chunk_delta: true },
      support_lazy_fetch_stream: true,
      is_old_user: true,
      recovery_option: { is_recovery: false, req_create_time_sec: Math.floor(now / 1000), append_sse_event_scene: 0 },
      model_config: { model_item_key: model, model_extra_params: {}, reasoning_effort: effort },
      aggregate_params: {
        mention_skill_list: '[]',
        mention_plugin_list: '[]',
        mention_ext: '[{}]',
        // ⚠️ 上游要**字符串**（参考实现是 String(conversationMode)）；发数字回 710020202。
        conversation_mode: String(isTask ? 2 : 1),
        mode_id: modeId,
        model_item_key: model,
        agent_mode: String(agentMode),
        reasoning_effort: effort,
        provider_id: '',
      },
      conversation_mode: isTask ? 2 : 1,
      unique_key: `uk_${stamp}`,
    },
    user_context: [],
    ext: {
      agent_mode: String(agentMode),
      use_deep_think: String(needDeepThink),
      sub_conv_firstmet_type: '1',
      collection_id: '',
      is_finish: '1',
      conversation_init_option: '{"need_ack_conversation":true}',
      commerce_credit_config_enable: '0',
    },
  })
}

/** 把 OpenAI 形的 messages 压成豆包要的单段 `prompt`（system 在前，历史逐条标注）。 */
export function doubaoPromptOf(messages) {
  const textOf = message => {
    if (typeof message?.content === 'string') return message.content
    if (Array.isArray(message?.content)) return message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
    return ''
  }
  const system = []
  const turns = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const text = textOf(message).trim()
    if (text === '') continue
    if (message.role === 'system') system.push(text)
    // ⚠️ 与参考实现**逐字同形**：` user: ` / ` assistant: ` —— 上游按这个分隔符切角色，
    // 换成中文冒号会被当成一条无角色的长 prompt（实测 `710020202 common invalid param`）。
    else turns.push(`${message.role === 'assistant' ? ' assistant: ' : ' user: '}${text}`)
  }
  return [system.join('\n\n'), turns.join('\n\n')].filter(part => part !== '').join('\n\n')
}

/**
 * 逐帧读豆包的流。
 *
 * ⚠️ 它的帧是 `id:` / `event:` / `data:` + 空行（**事件名有意义**），而通用的
 * `readSse` 只交出 `data:` 负载 ⇒ 事件名会被丢掉，正文找不回来。故这里单独解析。
 */
export async function readDoubaoFrames(source, handler, signal, timeoutMs = 300_000) {
  const iterator = typeof source?.getReader === 'function'
    ? source.getReader()
    : typeof source?.[Symbol.asyncIterator] === 'function' ? source[Symbol.asyncIterator]() : source
  const decoder = new TextDecoder()
  let buffer = ''
  let deadline = Date.now() + timeoutMs
  let event = ''
  let data = []
  const flushFrame = () => {
    if (data.length === 0 && event === '') return
    const frame = { event, data: data.join('\n') }
    event = ''
    data = []
    handler(frame)
  }
  while (true) {
    const row = await iterator.next()
    if (row.done === true) break
    if (Date.now() > deadline) throw new Error('豆包流式响应超时（上游长时间没有新帧）')
    if (row.value !== undefined) buffer += decoder.decode(row.value, { stream: true })
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, '')
      buffer = buffer.slice(newline + 1)
      if (line === '') flushFrame()
      else if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) data.push(line.slice(5).trim())
      newline = buffer.indexOf('\n')
    }
    deadline = Date.now() + timeoutMs
  }
  buffer += decoder.decode()
  if (buffer.trim() !== '') {
    for (const line of buffer.split('\n')) {
      const text = line.replace(/\r$/, '')
      if (text.startsWith('event:')) event = text.slice(6).trim()
      else if (text.startsWith('data:')) data.push(text.slice(5).trim())
    }
  }
  flushFrame()
  if (signal?.aborted === true) throw new Error('request aborted')
}

/** 正文块（`block_type: 10000`）与「思考头」（`10040`，它的子块才是思考正文）。 */
function doubaoBlocks(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) doubaoBlocks(item, out)
    return out
  }
  if (value === null || typeof value !== 'object') return out
  if (value.block_type === 10000 || value.block_type === 10040) {
    out.push(value)
    return out
  }
  for (const child of Object.values(value)) doubaoBlocks(child, out)
  return out
}

const blockIdOf = value => {
  const text = String(value ?? '')
  return text === '' || text === '0' ? undefined : text
}

/**
 * 帧 → **OpenAI chat chunk**（`data:` 负载 JSON 字符串）。
 *
 * 规则（逐条都有实测出处，见参考实现的 `DoubaoTextTracker`）：
 * - 只认四个事件：`STREAM_MSG_NOTIFY` / `FULL_MSG_NOTIFY`（**快照**）/ `STREAM_CHUNK`
 *   （`patch_op[].patch_value`）/ `CHUNK_DELTA`（`record.text`）；
 * - 正文在 `block_type:10000` 的 `content.text_block.text`；`parent_id` 指向一个
 *   `10040` 头 ⇒ 那是**思考**，不是正文；
 * - 带 `block_id` 的块是**累积**的（`text` 以上次为前缀）⇒ 取差量；快照里的旧值跳过；
 * - `patch_object === '111'` 的补丁是 UI 状态，跳过。
 */
export function createDoubaoTranslator({ includeReasoning = true } = {}) {
  const thinkingHeaders = new Set()
  const owners = new Map()
  const upstream = new Map()
  const started = new Set()
  let answered = false
  let reasoned = false

  const chunk = delta => JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })

  const emitDelta = (kind, text, out) => {
    if (text === '') return
    if (kind === 'reasoning') {
      reasoned = true
      if (!includeReasoning) return
      out.push(chunk({ reasoning_content: text }))
      return
    }
    answered = true
    out.push(chunk({ content: text }))
  }

  const pushBlocks = (blocks, snapshot, out) => {
    for (const block of blocks) {
      const id = blockIdOf(block?.block_id)
      if (block?.block_type === 10040 && id !== undefined) thinkingHeaders.add(id)
    }
    for (const block of blocks) {
      if (block?.block_type !== 10000) continue
      const id = blockIdOf(block.block_id)
      const parentId = blockIdOf(block.parent_id)
      const previousOwner = id === undefined ? undefined : owners.get(id)
      const kind = parentId !== undefined && thinkingHeaders.has(parentId) ? 'reasoning' : previousOwner ?? 'text'
      if (id !== undefined) owners.set(id, kind)
      const text = block?.content?.text_block?.text
      if (typeof text !== 'string') continue
      if (text === '') { if (id !== undefined && previousOwner === undefined) started.add(kind); continue }
      let delta = text
      if (id !== undefined) {
        const previous = upstream.get(id) ?? ''
        if (text.startsWith(previous)) delta = text.slice(previous.length)
        else if (snapshot || previous.startsWith(text)) continue
      }
      if (delta === '') continue
      if (id !== undefined) upstream.set(id, text)
      emitDelta(kind, delta, out)
    }
  }

  return {
    /** 上游在 200 的流里塞的业务错误（`STREAM_ERROR`）；由调用方决定怎么抛。 */
    failure: undefined,
    /** 吃一帧，返回要交给下游的 `data:` 负载列表。 */
    push(frame, out = []) {
      const name = String(frame?.event ?? '')
      if (name === 'STREAM_ERROR') {
        let payload
        try { payload = JSON.parse(String(frame?.data ?? '')) } catch { payload = {} }
        const code = Number(payload?.error_code ?? payload?.code ?? -1)
        const message = String(payload?.error_msg ?? payload?.message ?? '')
        this.failure = { code, message: message === '' ? `code ${code}` : message }
        return out
      }
      if (name !== 'STREAM_MSG_NOTIFY' && name !== 'FULL_MSG_NOTIFY' && name !== 'STREAM_CHUNK' && name !== 'CHUNK_DELTA') return out
      let payload
      try { payload = JSON.parse(String(frame?.data ?? '')) } catch { return out }
      if (payload === null || typeof payload !== 'object') return out
      if (name === 'STREAM_MSG_NOTIFY' || name === 'FULL_MSG_NOTIFY') {
        const message = payload.message !== null && typeof payload.message === 'object' ? payload.message : payload
        if (String(message.user_type) === '1' || message.role === 'user') return out
        pushBlocks(doubaoBlocks(message.content ?? payload.content), true, out)
        return out
      }
      if (name === 'STREAM_CHUNK') {
        for (const operation of Array.isArray(payload.patch_op) ? payload.patch_op : []) {
          if (operation === null || typeof operation !== 'object') continue
          if (String(operation.patch_object) === '111') continue
          pushBlocks(doubaoBlocks(operation.patch_value), false, out)
        }
        return out
      }
      if (typeof payload.text === 'string' && payload.text !== '') {
        // `CHUNK_DELTA` 是**真增量**，直接接在当前块上。
        emitDelta(owners.size === 0 ? 'text' : 'text', payload.text, out)
        return out
      }
      return out
    },
    /** 收尾：给出 finish_reason（没有正文是 `length`，有正文是 `stop`）。 */
    finish() {
      return [
        JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: answered ? 'stop' : reasoned ? 'stop' : 'length' }],
        }),
      ]
    },
  }
}

/**
 * 读一个金额：上游给的是**千分位字符串**（实测 `"1,600"`）。
 *
 * 带 `<` 的阈值串（实测 `"<1"`）按阈值保守取整 —— 宁可少算剩余额度，也不虚报可用数。
 */
export function doubaoAmount(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  const drop = text => text.replace(/[,\s_]/g, '')
  if (trimmed.startsWith('<')) {
    const inner = Number(drop(trimmed.slice(1)))
    return Number.isFinite(inner) ? inner : undefined
  }
  const digits = drop(trimmed)
  if (!/^-?\d+(?:\.\d+)?$/.test(digits)) return undefined
  return Number(digits)
}

/**
 * 业务码 → 人话。
 *
 * `710012001` 是**登录态失效**（要用户重新登录），与「没有可领活动」（`710010702`）
 * 分开处理；其余码如实回显上游原文 —— 用户看到 710010202 才知道是参数问题。
 */
export function doubaoErrorText(code, message) {
  if (Number(code) === DOUBAO_LOGIN_INVALID_CODE) return '豆包登录态已失效（710012001 login invalid）：请重新登录该账号'
  const suffix = typeof message === 'string' && message !== '' ? `（${message}）` : ''
  return `上游返回 ${code}${suffix}`
}

/**
 * 签到响应 → 我们的 outcome。
 *
 * ⚠️ 三条判据来自实测报文 `{data:{checked_in,checkin_date,continuous_days,idempotent,reward_amount},code:0}`：
 * - `reward_amount > 0` 才是**本次真领到**（`idempotent:true` 在首次成功时也是 true，
 *   所以**不能**拿它当「今天已领」的判据）；
 * - `code 710010702` = 当前没有可领的活动（`inactive`，不是故障）；
 * - `code 710012001` = 登录态失效（要用户重新登录）；
 * - 其余非 0 码如实 `failed`。
 */
export function classifyDoubaoCheckin(payload) {
  const data = payload?.data ?? {}
  const code = Number(payload?.code)
  const message = String(payload?.message ?? payload?.msg ?? data?.message ?? '')
  if (Number.isFinite(code) && code === 710010702) {
    return { kind: 'inactive', message: '当前没有可领取的豆包签到活动（可能今日已领完、或活动未对当前账号/时段投放）' }
  }
  if (Number.isFinite(code) && code !== 0) {
    return { kind: 'failed', message: code === DOUBAO_LOGIN_INVALID_CODE ? doubaoErrorText(code, message) : (message || `签到失败（code=${code}）`) }
  }
  const checkedIn = data.checked_in ?? data.checkedIn
  const reward = doubaoAmount(data.reward_amount ?? data.rewardAmount)
  const streakDays = doubaoAmount(data.continuous_days ?? data.continuousDays)
  const days = streakDays === undefined ? {} : { streakDays }
  if (checkedIn === true) {
    if (reward !== undefined && reward > 0) {
      return { kind: 'claimed', credit: reward, ...days, message: `签到成功 +${reward}${streakDays === undefined ? '' : `（连续 ${streakDays} 天）`}` }
    }
    // 幂等重放 / 已签：上游照旧回 `checked_in:true`，但**没有** reward_amount。
    return { kind: 'already-claimed', ...days, message: message || '今天已签到' }
  }
  if (checkedIn === false) return { kind: 'inactive', message: message || '今天暂不可签到' }
  return { kind: 'failed', message: message || '签到响应里没有可识别的结果（上游可能改版）' }
}

/**
 * 解析额度响应里的窗口列表。
 *
 * 上游把它放在 `incentive_quota_section` 与 `window_limit_section` **两处**，形状相同；
 * 未来出现第三处只需再加一个（别把两处合并成一个 if）。
 */
export function doubaoQuotaWindows(payload) {
  const data = payload?.data
  if (data === null || typeof data !== 'object') return []
  const out = []
  for (const section of [data.incentive_quota_section, data.window_limit_section]) {
    const groups = section?.window_limit_groups
    if (!Array.isArray(groups)) continue
    for (const group of groups) {
      const limits = group?.window_limits
      if (!Array.isArray(limits)) continue
      for (const limit of limits) {
        const total = doubaoAmount(limit?.total_amount)
        const used = doubaoAmount(limit?.used_amount)
        if (total === undefined && used === undefined) continue
        out.push({
          featureGroup: typeof group?.feature_group === 'string' ? group.feature_group : '',
          featureGroupName: typeof group?.feature_group_name === 'string' ? group.feature_group_name : '',
          total: total ?? 0,
          used: used ?? 0,
          ...typeof limit?.end_time === 'number' ? { endTime: limit.end_time } : {},
          ...typeof limit?.used_percent === 'number' ? { usedPercent: limit.used_percent } : {},
        })
      }
    }
  }
  return out
}

/** 订阅展示名（实测 `display.short_name` = 「免费体验」）。 */
export function doubaoSubscriptionName(payload) {
  const display = payload?.data?.current_subscription?.display
  const short = typeof display?.short_name === 'string' ? display.short_name.trim() : ''
  return short === '' ? undefined : short
}

/**
 * 窗口列表 → 面板那一行要的 `{total, used, remain}`。
 *
 * 没有窗口返回 `null`（**不是 0**：0 在额度语境里是「用光」）。
 */
export function doubaoQuotaSummary(windows) {
  const list = Array.isArray(windows) ? windows : []
  if (list.length === 0) return null
  let total = 0
  let used = 0
  for (const window of list) {
    total += Number.isFinite(window?.total) ? window.total : 0
    used += Number.isFinite(window?.used) ? window.used : 0
  }
  return { total, used, remain: Math.max(0, total - used) }
}

/* ── 上游调用 ────────────────────────────────────────────────────────────── */

/** 统一的一次 POST：返回 `{payload}` 或 `{error}`（坏 JSON / 非 2xx 都如实说明）。 */
async function doubaoPost(url, { cookie, body = '{}', fetch: fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let response
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: doubaoHeaders(cookie),
      body,
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    return { error: `请求失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const raw = await response.text().catch(() => '')
  if (!response.ok) return { error: `HTTP ${response.status}：${raw.slice(0, 160) || '空响应'}` }
  let payload
  try { payload = raw === '' ? {} : JSON.parse(raw) } catch { return { error: '响应不是 JSON（上游可能改版）' } }
  return { payload }
}

/** 签到（**要** `a_bogus`）。 */
export async function postDoubaoCheckin(credential, aBogus, options = {}) {
  return doubaoPost(doubaoCheckinUrl(credential, aBogus), {
    cookie: credential?.cookie,
    body: JSON.stringify({ scene: DOUBAO.campaignScene }),
    ...options,
  })
}

/**
 * 签到状态（**不要**签名）。
 *
 * ⚠️ 它**不能**用来短路签到：实测已签账号的 `landing/get` 也回空活动
 * （签完当天就没有可领对象），据此跳过 checkin 会把「今天已签」误报成「没有活动」。
 * 它只负责「今天签没签」这一个读数。
 */
export async function fetchDoubaoCheckinStatus(credential, options = {}) {
  const posted = await doubaoPost(doubaoCheckinStatusUrl(credential), {
    cookie: credential?.cookie,
    body: JSON.stringify({ scene: DOUBAO.campaignScene }),
    ...options,
  })
  if (posted.error !== undefined) return { error: posted.error }
  const payload = posted.payload ?? {}
  const code = Number(payload.code)
  if (Number.isFinite(code) && code !== 0) {
    return { error: doubaoErrorText(code, String(payload.message ?? payload.msg ?? '')) }
  }
  const data = payload.data ?? {}
  const flag = data.checked_in ?? data.checkedIn ?? data.today_checked_in ?? data.checked_in_today
  const streak = doubaoAmount(data.continuous_days ?? data.continuousDays)
  return {
    todayCheckedIn: typeof flag === 'boolean' ? flag : undefined,
    ...streak === undefined ? {} : { streakDays: streak },
  }
}

/** 额度窗口 + 订阅名（**不要**签名）。 */
export async function fetchDoubaoQuota(credential, options = {}) {
  const posted = await doubaoPost(doubaoQuotaUrl(credential), { cookie: credential?.cookie, ...options })
  if (posted.error !== undefined) return { error: posted.error }
  const payload = posted.payload ?? {}
  const code = Number(payload.code)
  if (Number.isFinite(code) && code !== 0) {
    return { error: doubaoErrorText(code, String(payload.message ?? payload.msg ?? '')) }
  }
  const windows = doubaoQuotaWindows(payload)
  if (windows.length === 0) return { error: '额度报文里没有可用窗口（该账号可能没有活动额度）' }
  const subscription = doubaoSubscriptionName(payload)
  return { windows, ...subscription === undefined ? {} : { subscription } }
}

/* ── 签到（CDP 页面会话） ────────────────────────────────────────────────── */

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

/**
 * 把该账号的 cookie 逐条注入当前会话（**账号隔离的关键**）。
 *
 * ⚠️ 不注入就会打在「页面上那个号」身上 —— 多账号场景下签到会签错人
 * （参考实现的第一版缺陷，靠临时 profile + 逐条注入才修好）。
 */
export async function injectDoubaoCookies(session, cookieHeader) {
  const pairs = parseDoubaoCookieHeader(cookieHeader)
  let written = 0
  for (const [name, value] of pairs) {
    const domain = name === 'msToken' ? '.bytedance.com' : '.doubao.com'
    const secure = name.endsWith('_ss') || name === 'ttwid' || name === 'sid_ucp_v1' || name === 'ssid_ucp_v1'
    await session.cdp.send('Network.setCookie', { name, value, domain, path: '/', secure, httpOnly: false }, { sessionId: session.sessionId })
    written += 1
  }
  return written
}

/**
 * 轮询页面直到 `bdms` 就绪并算出签名；超时返回空串。
 *
 * 页面在导航/重载期间 `Runtime.evaluate` 会抛（执行上下文已销毁）——那是「还没好」，
 * 继续等，不是失败。
 */
export async function waitForDoubaoSignature(session, { timeoutMs = SIGN_READY_TIMEOUT_MS } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = await session.evaluate(DOUBAO_SIGN_EXPRESSION)
      if (typeof value === 'string' && value !== '') return value
    } catch { /* 页面还在跳转，继续等 */ }
    await sleep(SIGN_POLL_INTERVAL_MS)
  }
  return ''
}

/**
 * 执行每日签到：起一次临时浏览器 → 注入该账号 cookie → 页面里签名 → Node 侧发请求。
 *
 * `startSession` 可注入（离线测试用它换成假会话，**不真起浏览器**）。
 *
 * @param {object|null} credential - `{cookie, accountKey, deviceId?, webId?}`
 * @param {object} [options]
 * @param {Function} [options.startSession] - 默认 `startChromiumSession`
 */
export async function claimDoubaoDaily(credential, {
  fetch: fetchImpl = fetch,
  startSession = startChromiumSession,
  log = () => {},
  timeoutMs = SIGN_READY_TIMEOUT_MS,
  executable,
} = {}) {
  const cookie = typeof credential?.cookie === 'string' ? credential.cookie : ''
  if (cookie === '') return { kind: 'inactive', message: '没有可用的豆包登录会话（请先在账号卡片上完成登录）' }
  let session
  try {
    session = await startSession({ url: DOUBAO.pageUrl, executable, headless: true, log })
  } catch (error) {
    return { kind: 'failed', message: `豆包签到需要本机有 Chromium 系浏览器：${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    let injected = 0
    try {
      injected = await injectDoubaoCookies(session, cookie)
    } catch (error) {
      return { kind: 'failed', message: `注入登录态失败：${error instanceof Error ? error.message : String(error)}` }
    }
    log(`doubao: 已注入 ${injected} 条账号 cookie`)
    // 注入后**重新加载**页面：让页面按该账号的 cookie 重新初始化（bdms 也会随之重算）。
    try {
      await session.cdp.send('Page.navigate', { url: DOUBAO.pageUrl }, { sessionId: session.sessionId })
    } catch { /* 导航失败也给它一次机会：页面可能已在该地址 */ }
    const aBogus = await waitForDoubaoSignature(session, { timeoutMs })
    if (aBogus === '') {
      return { kind: 'failed', message: '豆包页面没有准备好签名环境（bdms 未注入）—— 请确认浏览器可正常打开 www.doubao.com/chat/' }
    }
    const posted = await postDoubaoCheckin(credential, aBogus, { fetch: fetchImpl })
    if (posted.error !== undefined) return { kind: 'failed', message: posted.error }
    return classifyDoubaoCheckin(posted.payload)
  } finally {
    try { session?.close?.() } catch { /* 已关 */ }
  }
}

/* ── 权益扩展（接进 `src/channels/index.js` 的 `{statusOf, claim}` 契约） ── */

/**
 * 豆包的权益扩展：**额度 + 每日签到 + 模型目录**。
 *
 * ⚠️ 目录来自远端 `brief_list`（真机 200/`code:0`），失败才退回
 * `DOUBAO_FALLBACK_MODELS`（16 条实测快照）—— 与其它渠道同一取向：
 * 宁可显示「上一次知道的模型」，也不要整组消失。
 */
export function createDoubaoExtras({ credentialOf, fetch: fetchImpl = fetch } = {}) {
  /** 目录行：`id` 就是上游的 `model_item_key`（请求里路由用的正是它）。 */
  const catalogRowsOf = models => models.map(model => {
    const tags = Array.isArray(model.tags) ? model.tags : []
    const effortNames = Array.isArray(model.effortNames) ? model.effortNames : []
    return {
      id: model.key,
      name: tags.length === 0 ? model.name : `${model.name} · ${tags.join(' · ')}`,
      reasoning: effortNames.length > 0,
      ...effortNames.length === 0 ? {} : {
        efforts: effortNames.map(row => row.id),
        effortNames: effortNames.map(row => ({ id: row.id, name: row.name })),
      },
    }
  })

  async function statusOf(account) {
    const base = {
      accountId: typeof account?.id === 'string' ? account.id : '',
      nickname: typeof account?.nickname === 'string' ? account.nickname : '',
    }
    const credential = credentialOf === undefined ? null : await credentialOf(account)
    if (credential === null) return { ...base, pending: true }
    const [quota, checkin, catalog] = await Promise.all([
      fetchDoubaoQuota(credential, { fetch: fetchImpl }),
      fetchDoubaoCheckinStatus(credential, { fetch: fetchImpl }),
      fetchDoubaoBriefList(credential, { fetch: fetchImpl }),
    ])
    const summary = quota.windows === undefined ? null : doubaoQuotaSummary(quota.windows)
    const todayCheckedIn = checkin.todayCheckedIn
    const models = catalog.models ?? DOUBAO_FALLBACK_MODELS
    // 倍率标签：只把**看起来像倍率**的那一条挂到模型行上（`0.65x` / `限时优惠 0.01x`）。
    const ratios = {}
    for (const model of models) {
      const tag = (Array.isArray(model.tags) ? model.tags : []).find(text => /x\s*$/i.test(text))
      if (tag !== undefined) ratios[`${DOUBAO.id}/${model.key}`] = tag
    }
    return {
      ...base,
      catalog: catalogRowsOf(models),
      source: catalog.models === undefined ? 'static' : 'live',
      ...catalog.models === undefined ? { catalogError: catalog.error } : {},
      ...Object.keys(ratios).length === 0 ? {} : { ratios },
      info: summary === null ? null : {
        planName: quota.subscription ?? '豆包活动额度',
        planStatus: 'active',
        total: summary,
        windows: quota.windows,
      },
      ...quota.windows === undefined ? { infoError: quota.error } : {},
      activities: [{
        campaignId: DOUBAO.checkinCampaignId,
        type: 'checkin',
        title: '每日签到',
        // 状态腿没读到（或读失败）时按「可领」呈现：签到本身幂等，多领一次不会出错，
        // 而把「未知」画成「不可领」会让用户当天白丢一次机会。
        claimable: todayCheckedIn !== true,
        status: todayCheckedIn === true ? '今天已签到' : '',
        // 奖励额度只有**领完**才知道（上游在响应里下发 reward_amount），
        // 这里不编数字：面板据此不显示「+x 积分」。
        amount: 0,
      }],
    }
  }

  async function claim(account, campaignId) {
    const id = String(campaignId ?? '')
    if (id !== '' && id !== DOUBAO.checkinCampaignId) return { kind: 'inactive', message: '豆包只有一个每日签到活动' }
    const credential = credentialOf === undefined ? null : await credentialOf(account)
    if (credential === null) return { kind: 'failed', message: '凭据不可用（需要重新登录）' }
    return claimDoubaoDaily(credential, { fetch: fetchImpl })
  }

  return { statusOf, claim }
}
