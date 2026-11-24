/**
 * 自有渠道的**推理腿**测试：三家各一套协议，逐条钉住最容易错的地方。
 *
 * 覆盖：
 * 1. Codely：两段派生签名（含 pathname 边界、±300s 时间戳）、`sk-` 换发、`x-litellm-session-id`；
 * 2. AutoClaw：MD5 管理头、两个鉴权头、模型名走 `X-Request-Model`；
 * 3. Accio：Gemini 形请求体（`token` 在 body、`iai_tag` 空串、`message_id` 必填）、
 *    响应帧包成 `candidates` 才能被我们的解码器读到；
 * 4. 凭据缺失 → `CODE.auth`（不是「未知错误」）；
 * 5. 目录行：id 前缀、`own: true`、兜底表不为空（空目录会让整组消失）。
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { codelySignature, fetchCodelyCliKey, wrapAccioFrame, toSnake, postOwnChannelStreamed, laneFor } from '../src/channels/inference.js'
import { buildOwnCatalog, ownEntry, isOwnEntry, ownProviderOf } from '../src/channels/catalog.js'

/* ── Codely 签名 ─────────────────────────────────────────────────────────── */

const fixedMs = 1900000000000
const sig = codelySignature('sk-abc', 'https://codely-litellm.tuanjie.cn/v1/chat/completions', fixedMs)
assert.match(sig, /^v1\.1900000000\.[A-Za-z0-9_-]+$/, '形如 v1.{ts}.{base64url}')

// 独立算一遍（等价于上游的 HMAC(HMAC(SECRET,salt),key) 两段派生）
const SECRET = Buffer.from('406f00f74768ba0cb0cd30f097ec6c2bdacb89c61a38b7dd140838bbd0e98018', 'hex')
const stage1 = crypto.createHmac('sha256', SECRET).update('codely-signing-v1').digest()
const key = crypto.createHmac('sha256', stage1).update('sk-abc').digest()
const expectSig = `v1.1900000000.${crypto.createHmac('sha256', key).update(['v1', '/v1/chat/completions', '1900000000'].join('\n')).digest('base64url')}`
assert.equal(sig, expectSig, '签名必须逐字节等于两段派生 + LF 拼接')

// 签名只覆盖 pathname：query 不影响，path 影响
const withQuery = codelySignature('sk-abc', 'https://codely-litellm.tuanjie.cn/v1/chat/completions?x=1', fixedMs)
assert.equal(withQuery, sig, 'query 不参与签名')
const otherPath = codelySignature('sk-abc', 'https://codely-litellm.tuanjie.cn/v1/models', fixedMs)
assert.notEqual(otherPath, sig, 'pathname 变则签名变')
// 不同 key 不同签名（按账号隔离）
assert.notEqual(codelySignature('sk-other', 'https://x/v1/chat/completions', fixedMs), sig)

/* ── Accio 帧归一化 ─────────────────────────────────────────────────────── */

const wrapped = wrapAccioFrame({
  content: { parts: [{ text: 'hello' }, { thought: true, text: 'thinking' }] },
  usage_metadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
  partial: false,
})
assert.equal(wrapped.candidates[0].content.parts.length, 2)
assert.equal(wrapped.candidates[0].content.parts[0].text, 'hello')
assert.equal(wrapped.candidates[0].content.parts[1].thought, true, 'thinking 标记必须保留（解码器据此分 reasoning）')
assert.equal(wrapped.usageMetadata.promptTokenCount, 7)

// 纯 usage 帧：给一个空 parts，别把 usage 丢掉
const usageOnly = wrapAccioFrame({ usage_metadata: { promptTokenCount: 1 } })
assert.deepEqual(usageOnly.candidates[0].content.parts, [])
assert.equal(wrapped.partial, false, 'partial 透传')
assert.equal(wrapAccioFrame(null), null)
assert.equal(wrapAccioFrame({ nothing: 1 }), null)

assert.deepEqual(toSnake({ maxOutputTokens: 5, systemInstruction: 'x', iaiTag: '', drop: undefined }),
  { max_output_tokens: 5, system_instruction: 'x', iai_tag: '' }, 'undefined 键整条丢掉')

/* ── 目录行 ─────────────────────────────────────────────────────────────── */

// 未登录也会列出别家的兜底行，故按 provider 过滤后断言
const rows = buildOwnCatalog({
  catalogs: { codely: [{ id: 'codely-core', name: 'codely-core' }] },
  enabled: { codely: true },
}).filter(row => row.provider === 'codely')
assert.equal(rows.length, 1)
assert.equal(rows[0].id, 'codely/codely-core')
assert.equal(rows[0].own, true)
assert.equal(rows[0].provider, 'codely')
assert.equal(rows[0].wire, 'chat')
assert.equal(isOwnEntry(rows[0]), true)
assert.equal(ownProviderOf('codely/codely-core'), 'codely')
assert.equal(ownProviderOf('deepseek/deepseek-v4-pro'), null, '别的车道的 id 不能被认成自有渠道')

// 兜底：权益查询还没回来时也要有行（空目录会让整组从选择器消失）
const fallback = buildOwnCatalog({ enabled: { autoclaw: true } }).filter(row => row.provider === 'autoclaw')
assert.ok(fallback.length >= 4, 'AutoClaw 的兜底表必须有内容')
assert.ok(fallback.every(row => row.id.startsWith('autoclaw/')))

// 没有启用账号的渠道不产出行；总开关一关全消失
assert.equal(buildOwnCatalog({ enabled: { codely: false } }).filter(row => row.provider === 'codely' && row.needsLogin !== true).length, 0)
assert.equal(buildOwnCatalog({ enabled: { codely: true }, hideAll: true }).length, 0)

// 上下文窗口：非法值不照抄（0 会让宿主的压缩阈值算出 0）
const guarded = ownEntry('codely', { id: 'x', contextWindow: 0 })
assert.equal(guarded.contextWindow, 131072, '0 是「未知」哨兵，不能当窗口')

/* ── 三家各发一轮（注入 fetch） ─────────────────────────────────────────── */

function sseResponse(frames) {
  const body = frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n'
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    body: new Response(body).body,
    async text() { return body },
  }
}

const openAiFrame = { id: 'c1', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: 'stop' }] }

// ① Codely：先换 sk-，再带签名
const codelyCalls = []
const codelyFetch = async (url, init) => {
  codelyCalls.push({ url, headers: init.headers, body: init.body })
  if (url.endsWith('/api/api-token/cli-api-key')) {
    return { ok: true, status: 200, headers: { get: () => null }, async text() { return JSON.stringify({ cli_api_key: 'sk-xyz' }) } }
  }
  assert.match(init.headers['X-Codely-Signature'], /^v1\.\d+\.[A-Za-z0-9_-]+$/)
  assert.equal(init.headers.Authorization, 'Bearer sk-xyz', '推理用换发到的 sk-，不是 access_token')
  return sseResponse([openAiFrame])
}
const codelyFrames = []
await postOwnChannelStreamed({
  provider: 'codely',
  credential: { access_token: 'at-1' },
  body: { model: 'codely-core', messages: [{ role: 'user', content: 'hi' }] },
  onData: frame => codelyFrames.push(frame),
  fetch: codelyFetch,
})
assert.equal(codelyCalls.length, 2, '一次换发 + 一次推理')
assert.ok(codelyFrames.length >= 1)
assert.equal(JSON.parse(codelyFrames[0]).choices[0].delta.content, 'hi')

// 换发失败 → CODE.auth（不是笼统的 server）
await assert.rejects(
  postOwnChannelStreamed({
    provider: 'codely',
    credential: { access_token: 'bad' },
    body: { model: 'codely-core', messages: [] },
    onData: () => {},
    fetch: async () => ({ ok: false, status: 401, headers: { get: () => null }, async text() { return 'no' } }),
  }),
  error => error.code === 'INVALID_CREDENTIAL' || /凭据|Key/.test(error.message),
)

// ② AutoClaw：管理头 + 两个鉴权头 + 模型名走头
let autoclawInit
await postOwnChannelStreamed({
  provider: 'autoclaw',
  credential: { access_token: 'ac-token' },
  body: { model: 'zaicoding_glm-5.3', messages: [{ role: 'user', content: 'hi' }] },
  onData: () => {},
  fetch: async (url, init) => {
    autoclawInit = { url, headers: init.headers, body: JSON.parse(init.body) }
    return sseResponse([openAiFrame])
  },
})
assert.ok(autoclawInit.url.startsWith('https://autoglm-acceleration-api.zhipuai.cn/autoclaw-proxy/proxy/autoclaw/chat/completions'))
assert.equal(autoclawInit.headers['X-Auth-Appid'], '100003')
assert.match(autoclawInit.headers['X-Auth-Sign'], /^[0-9a-f]{32}$/)
assert.equal(autoclawInit.headers['X-Authorization'], 'Bearer ac-token')
assert.equal(autoclawInit.headers.Authorization, undefined, '推理只认 X-Authorization（带 Authorization 反而可能被拒）')
assert.equal(autoclawInit.headers['X-Request-Model'], 'zaicoding_glm-5.3', '模型名走头')
assert.equal(autoclawInit.headers['X-Product'], 'autoclaw')
assert.equal(autoclawInit.body.stream, true)

// 国际版走另一个主机，凭据不串站
let intlUrl
await postOwnChannelStreamed({
  provider: 'autoclawintl',
  credential: { access_token: 't' },
  body: { model: 'zaicoding_glm-5.3', messages: [] },
  onData: () => {},
  fetch: async url => { intlUrl = url; return sseResponse([openAiFrame]) },
})
assert.ok(intlUrl.startsWith('https://autoglm-api.autoglm.ai/'), '国际版必须打 autoglm.ai')

// ③ Accio：Gemini 形请求体 + 响应包成 candidates
let accioCall
const accioFrames = []
await postOwnChannelStreamed({
  provider: 'accio',
  credential: { access_token: 'accio-token' },
  body: { model: '1Drift-N8kP2Q7wR5mX', messages: [{ role: 'system', content: 'be nice' }, { role: 'user', content: 'hi' }], max_tokens: 32 },
  onData: frame => accioFrames.push(JSON.parse(frame)),
  fetch: async (url, init) => {
    accioCall = { url, headers: init.headers, body: JSON.parse(init.body) }
    return sseResponse([{ content: { parts: [{ text: 'hi' }] }, usage_metadata: { promptTokenCount: 2 } }])
  },
})
assert.match(accioCall.url, /\/api\/adk\/llm\/generateContent\?sg_k=[0-9a-f]{32}$/)
assert.equal(accioCall.body.token, 'accio-token', 'token 必须在 body（放头恒 402）')
assert.equal(accioCall.body.empid, '')
assert.equal(accioCall.body.tenant, '')
assert.equal(accioCall.body.iai_tag, '')
assert.equal(accioCall.body.message_id.length, 32, 'message_id 必填')
assert.equal(accioCall.body.properties.app_key, undefined, 'properties 不参与 snake 化')
assert.equal(accioCall.body.properties.appKey, 'OneChat')
assert.equal(accioCall.body.contents[1].parts[0].text, 'hi')
assert.equal(accioCall.headers.appKey, 'OneChat')
assert.equal(accioFrames.length, 1)
assert.equal(accioFrames[0].candidates[0].content.parts[0].text, 'hi', 'Accio 帧必须包成 candidates 才能被解码器读到')
assert.equal(accioFrames[0].usageMetadata.promptTokenCount, 2)

// ④ 凭据缺失 / 未知渠道
await assert.rejects(
  postOwnChannelStreamed({ provider: 'codely', credential: null, body: { model: 'x', messages: [] }, onData: () => {} }),
  error => error.code === 'INVALID_CREDENTIAL',
)
await assert.rejects(
  postOwnChannelStreamed({ provider: 'nope', credential: {}, body: { model: 'x' }, onData: () => {} }),
  /unknown own channel/,
)
assert.equal(laneFor('codely').id, 'codely')
assert.equal(laneFor('nope'), null)

console.log('own inference OK:', 58, 'assertions')
process.exit(0)