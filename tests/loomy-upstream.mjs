/**
 * Loomy（讯飞）失败归因测试（离线，只读源码 + 纯函数）。
 *
 * ## 为什么需要它（本机真机证据）
 *
 * `~/.dsh/channel-pack/token-ledger.json` 里 Loomy 的记录：
 *
 * | 日期 | 模型 | 通道 | 请求 | 成功 | 失败 | 平均首块 |
 * |---|---|---|---|---|---|---|
 * | 11-22 | GLM-5.3-Flash | direct | 7 | 3 | 2 | 95.3s |
 * | 11-24 | GLM-5.3-Flash | direct | 17 | 1 | 9 | 127.4s |
 * | 11-25 | glm-5.3-flash | gateway | 44 | 42 | 2 | 18s |
 *
 * 两个配置互相冲突 + 一个归类错误，三者叠加成「偶尔 500 / 首字节为空」：
 * 1. 宿主 `llm-error-retry` 首字守卫默认 **90s**，Loomy 适配器原先 **120s**
 *    ⇒ 宿主永远先掐断，适配器给出准确归因的机会都没有；
 * 2. `httpErrorCode4` 把 `status >= 500` 一律映射成 `SERVER`，而 `SERVER`
 *    **在**宿主 `DEFAULT_RETRYABLE_CODES` 里 ⇒ 同一个号白重试 5 次全量 prompt；
 * 3. `TIMEOUT` 同样在重试集合里 ⇒ 慢模型（首块 95–127s）被连打 3 次 × 85s。
 *
 * 这个测试把三条口径钉住：**85s < 90s**、5xx 网关文案归 `UPSTREAM`、
 * 首字超时归 `UPSTREAM`。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

const PACK = 'vendor/channel-pack/pack.js'
const source = fs.readFileSync(PACK, 'utf8')

/** 取一段函数源码（按函数名 + 花括号配平）。 */
function functionOf(name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${name} 不在 pack 里`)
  let depth = 0
  let i = source.indexOf('{', start)
  const from = i
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') { depth -= 1; if (depth === 0) break }
  }
  return source.slice(from, i + 1)
}

/* ── P0：适配器首字超时必须短于宿主 90s ───────────────────────────────── */

const firstToken = functionOf('resolveFirstTokenTimeoutMs7')
assert.match(
  firstToken,
  /85e3/,
  'Loomy 首字超时必须 85s（宿主 llm-error-retry 是 90s，适配器要更短才能先给出归因）',
)
assert.ok(
  !/12e4/.test(firstToken),
  '不能再退回 120s —— 那样宿主 90s 永远先掐断，用户只看到空的「首字节为空」',
)
const chunkTimeout = functionOf('resolveChunkTimeoutMs7')
assert.match(chunkTimeout, /85e3/, 'chunk 超时同档 85s（与首字一致，避免中途换档）')

/* ── P1：5xx 网关文案归 UPSTREAM（不在重试集合里）─────────────────────── */

const upstreamFn = functionOf('looksLikeUpstreamProviderError')
for (const pattern of ['gateway\\s+time-?out', 'bad\\s+gateway', '暂时不可用']) {
  assert.ok(upstreamFn.includes(pattern), `网关判据必须包含 ${pattern}`)
}
// 口径必须窄：`服务不可用` 会误伤本仓其它渠道的文案（如「额度服务不可用」）
assert.ok(
  !/暂时不可用\|服务不可用|服务不可用\|暂时不可用/.test(upstreamFn),
  '中文只认「暂时不可用」，不能把「服务不可用」也收进来（会误伤别的渠道）',
)

const codeOf = functionOf('loomyErrorCodeOf')
assert.ok(codeOf.includes('status >= 500'), 'UPSTREAM 必须带 status >= 500 闸门（400 参数错的文案也可能有 gateway 字样）')
assert.ok(codeOf.includes('"UPSTREAM"'), '5xx 网关故障必须归 UPSTREAM')
assert.ok(codeOf.includes('httpErrorCode4(status)'), '其余情况仍走通用映射（不改其它渠道的行为）')

// 关键不变式：Loomy 的响应错误必须走 loomyErrorCodeOf，而不是裸 httpErrorCode4
const loomyStreamStart = source.indexOf('async *stream(options) {', source.indexOf('var LoomyAdapter'))
const loomyStreamEnd = source.indexOf('function resolveFirstTokenTimeoutMs7()')
const loomyStream = source.slice(loomyStreamStart, loomyStreamEnd)
assert.ok(
  loomyStream.includes('loomyErrorCodeOf(response.status'),
  'Loomy 的 !response.ok 分支必须用 loomyErrorCodeOf（裸 httpErrorCode4 会把 5xx 判成可重试的 SERVER）',
)

/* ── P1 续：首字超时也要归 UPSTREAM ───────────────────────────────────── */

const relabel = functionOf('relabelLoomyStreamError')
assert.ok(relabel.includes('first-token'), '只改 first-token 阶段（chunk 阶段超时是「流中途断了」，语义不同）')
assert.ok(relabel.includes('"UPSTREAM"'), '首字超时必须归 UPSTREAM —— TIMEOUT 在重试集合里，会把慢模型连打 3 次')
// pack 里的中文是转义 Unicode（\u4E0D\u91CD\u8BD5 = 不重试），两种形态都认
assert.ok(
  relabel.includes('不重试') || relabel.includes('\\u4E0D\\u91CD\\u8BD5'),
  '文案必须明确告诉用户「不重试」',
)
assert.ok(
  loomyStream.includes('relabelLoomyStreamError'),
  'stream 里必须真的调用 relabelLoomyStreamError（否则改写逻辑是死代码）',
)

/* ── 共享函数未被污染 ─────────────────────────────────────────────────── */

const shared = functionOf('httpErrorCode4')
assert.ok(shared.includes('if (status >= 500) return "SERVER"'), 'httpErrorCode4 保持原样（cline/qoder/raccoon 共用，不能为 loomy 改它）')
assert.ok(!shared.includes('UPSTREAM'), 'httpErrorCode4 里不允许出现 UPSTREAM（那是 Loomy 专属）')

console.log('loomy upstream classification OK: 18 assertions')