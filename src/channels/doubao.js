/**
 * 豆包（`doubao`）的签到与额度端点契约。
 *
 * ## 签名是 **query 的 `a_bogus`**，不是请求头
 *
 * `a_bogus` 由**豆包页面上下文**里的 `bdms.frontierSign` 生成（`window.bdms` 只在
 * 页面里有）。纯 Node `fetch` 产不出合法签名 —— 与 magicrew「网页登录读 localStorage」
 * 同型：必须借用宿主起的 Chromium（`src/channels/browser/chromium.js`），
 * 在页面里算完再把签名值交给 Node 侧发请求。
 *
 * ## 三条腿里只有签到要签名
 *
 * | 腿 | 路径 | 要 `a_bogus` |
 * | --- | --- | --- |
 * | 签到 | `/alice/ug/campaign/landing/checkin` | **是** |
 * | 签到状态 | `/alice/ug/campaign/landing/get` | 否 |
 * | 额度 | `/alice/commerce/sale/subscription/quota/summary/` | 否 |
 *
 * ## 公共 query
 *
 * 签到请求的 query 是固定几项（见 `doubaoCheckinQuery`），`a_bogus` 另算、追加在最后。
 *
 * @module src/channels/doubao.js
 */

export const DOUBAO = Object.freeze({
  id: 'doubao',
  displayName: '豆包',
  baseUrl: 'https://www.doubao.com',
  pageUrl: 'https://www.doubao.com/chat/',
  checkinPath: '/alice/ug/campaign/landing/checkin',
  checkinStatusPath: '/alice/ug/campaign/landing/get',
  quotaPath: '/alice/commerce/sale/subscription/quota/summary/',
  chatPath: '/chat/completion',
})

/**
 * 签到请求的公共 query（**不含 `a_bogus`**）。
 *
 * ⚠️ 顺序即上游口径：签名覆盖的是完整 query 串，顺序变了签名就对不上，
 * 所以这里返回**数组**而不是对象 —— 调用方按序拼接，别用 `Object.keys`。
 */
export function doubaoCheckinQuery(credential) {
  return [
    ['aid', String(credential?.aid ?? '497858')],
    ['device_platform', 'web'],
    ['channel', 'online'],
    ['iid', String(credential?.iid ?? '')],
    ['timestamp', String(Math.floor(Date.now() / 1000))],
  ]
}

/** 把 query 数组拼成待签名字符串（不含 `?`）。 */
export function doubaoQueryString(pairs) {
  return (Array.isArray(pairs) ? pairs : [])
    .filter(pair => Array.isArray(pair) && typeof pair[0] === 'string' && pair[0] !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value ?? ''))}`)
    .join('&')
}

/** 追加 `a_bogus`（页面算出来的值）后的完整 URL。 */
export function doubaoCheckinUrl(credential, aBogus) {
  const query = doubaoQueryString(doubaoCheckinQuery(credential))
  const signature = typeof aBogus === 'string' && aBogus !== '' ? `&a_bogus=${encodeURIComponent(aBogus)}` : ''
  return `${DOUBAO.baseUrl}${DOUBAO.checkinPath}?${query}${signature}`
}

/**
 * 在页面里求签名的表达式（`window.bdms.frontierSign`）。
 *
 * ⚠️ 页面没加载完 / `bdms` 还没注入时返回 undefined —— 调用方要**轮询等**，
 * 不能当成错误（用户刚打开窗口时必然如此）。
 */
export const DOUBAO_SIGN_EXPRESSION = `(() => {
  try {
    if (!window.bdms || typeof window.bdms.frontierSign !== 'function') return ''
    const out = window.bdms.frontierSign(location.pathname + location.search)
    if (typeof out === 'string') return out
    if (out && typeof out.a_bogus === 'string') return out.a_bogus
    if (out && typeof out.xBogus === 'string') return out.xBogus
    return ''
  } catch (error) { return '' }
})()`

/** 签到响应 → 我们的 outcome（`already` 由上游文案/字段判）。 */
export function classifyDoubaoCheckin(payload) {
  const data = payload?.data ?? payload ?? {}
  const message = String(data?.message ?? data?.toast ?? payload?.message ?? '')
  if (data?.checked === true || (typeof data?.credit === 'number' && data.credit > 0)) {
    return { kind: 'claimed', credit: typeof data?.credit === 'number' ? data.credit : undefined, message: message || '签到成功' }
  }
  if (/已签|已领|already/i.test(message)) return { kind: 'already-claimed', message: message || '今天已签到' }
  if (data?.checked === false && message === '') return { kind: 'inactive', message: '今天暂不可签到' }
  return { kind: 'failed', message: message || '签到失败（响应里没有可识别的结果）' }
}
