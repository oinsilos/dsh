/**
 * 自有渠道的**推理**腿：Codely / AutoClaw / Accio 三家，各自一套线上协议。
 *
 * ## 与 `src/kilo.js`、`src/aggregate.js` 的分工
 *
 * 那两条腿是 OpenAI 兼容（`chat/completions` 一条路走完）；这三家不是：
 *
 * | 渠道 | 请求 | 响应 | 需要额外处理 |
 * | --- | --- | --- | --- |
 * | Codely | `POST {chatHost}/chat/completions`（OpenAI 形） | SSE | 每次请求现换 `sk-` CLI Key，并算 `X-Codely-Signature` |
 * | AutoClaw | `POST {apiBase}/autoclaw-proxy/proxy/autoclaw/chat/completions`（OpenAI 形） | SSE | 管理头（MD5 签名）+ `X-Authorization`；模型名走 `X-Request-Model` 头 |
 * | Accio | `POST {gateway}/api/adk/llm/generateContent?sg_k=…`（**Gemini 形**） | 顶层 `content.parts[]` 的 SSE | 请求体要 snake_case、`token` 在 body；响应要包成 `candidates[].content.parts[]` 才能被我们的解码器读 |
 *
 * 本模块只做「发出去 + 把上游帧转成**我们的解码器认识的那一种**」。所有帧最终都以
 * `chat.completion.chunk` 或 Gemini `candidates` 形状交出 —— 与既有车道一致，
 * 解码器不需要知道渠道差异。
 *
 * ## 凭据
 *
 * 三家都从**本插件自己的账号表**取（`accounts.credentialOf`）。取不到就抛
 * `CODE.credential`：面板上那行「凭据不可用」与这里的分级是同一套话术。
 *
 * @module src/channels/inference.js
 */

import crypto from 'node:crypto'
import { CODE, UpstreamError, classifyFailure, classifyStreamFailure, readHead, readSse, replayStream, sniffBody, transportCause } from '../http.js'
import { egressFetch } from '../egress.js'
import { chatHeaders as marvisChatHeaders } from './marvis.js'
import { monkeycodeSignature } from './monkeycode.js'
import { BAIZHI, baizhiInferenceHeaders, baizhiMaxOutputTokensFor } from './baizhi.js'
import { OFFICEACE, officeaceInferenceHeaders } from './officeace.js'
import { ASTUDIO, astudioBearerHeaders } from './astudio.js'
import { agnesHostAllowed } from './agnescode.js'
import {
  DOUBAO,
  buildDoubaoChatBody,
  createDoubaoTranslator,
  doubaoHeaders,
  doubaoModeOf,
  doubaoPromptOf,
  doubaoQueryString,
  doubaoWebQuery,
  readDoubaoFrames,
} from './doubao.js'

const TURN_TIMEOUT_MS = 300_000
const KEY_TIMEOUT_MS = 15_000
/**
 * 豆包等「整段读完才吐」的上游：等首字节的合理上限。
 *
 * 5 分钟只对真正的流式上游有意义 —— 那种情况下首帧几秒就到，等不到就是故障。
 * 豆包一次要给完整段回答，180 秒是参考实现实测取的值（目录 15s 与 undici 300s
 * 之间），再长只是让用户干等。
 */
const DOUBAO_HEAD_TIMEOUT_MS = 180_000

/**
 * Codely 的推理网关常量（与 `codely.js` 的账号侧同源，但推理走另一个主机）。
 */
const CODELY_CHAT = 'https://codely-litellm.tuanjie.cn/v1/chat/completions'
const CODELY_KEY_PATH = 'https://codely.tuanjie.cn/api/api-token/cli-api-key'
/** 官方客户端的签名根密钥（32 字节，全客户端共用），与 `codely-sign.ts` 逐字节一致。 */
const CODELY_SIGNING_SECRET = Buffer.from('406f00f74768ba0cb0cd30f097ec6c2bdacb89c61a38b7dd140838bbd0e98018', 'hex')
const CODELY_SIGNING_SALT = 'codely-signing-v1'
const CODELY_CLI_UA = 'codely-cli/1.0.0-release.57 (win32; x64)'

/**
 * 算 `X-Codely-Signature`：`v1.{ts}.{base64url(HMAC(key, "v1\n{pathname}\n{ts}"))}`。
 *
 * 密钥两段派生：`HMAC(HMAC(SECRET, salt), cliApiKey)` —— 缺任一段都不对，这也正是
 * 「每账号隔离」的来源（服务端按 Bearer 的 key 验签，错配回 401）。
 *
 * 签名**只覆盖 pathname**（不含 query、不含 body），时间窗 ±300 秒。
 *
 * @param {string} cliApiKey - 该账号换发到的 `sk-…`
 * @param {string} target - 目标 URL（只取 pathname）
 * @param {number} [nowMs] - 测试注入
 */
export function codelySignature(cliApiKey, target, nowMs = Date.now()) {
  const pathname = (() => {
    try { return new URL(String(target)).pathname } catch { return String(target) }
  })()
  const ts = String(Math.floor(nowMs / 1000))
  const stage1 = crypto.createHmac('sha256', CODELY_SIGNING_SECRET).update(CODELY_SIGNING_SALT).digest()
  const key = crypto.createHmac('sha256', stage1).update(String(cliApiKey)).digest()
  const sig = crypto.createHmac('sha256', key).update(['v1', pathname, ts].join('\n')).digest('base64url')
  return `v1.${ts}.${sig}`
}

/** 换发 Codely 的 `sk-` 推理 Key（目录/积分用 access_token，推理用这个）。 */
export async function fetchCodelyCliKey(accessToken, { fetch: fetchImpl = egressFetch, signal } = {}) {
  const response = await fetchImpl(CODELY_KEY_PATH, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
      'X-User-Agent': 'codely-vscode/4.3.0',
    },
    redirect: 'error',
    signal: signal ?? AbortSignal.timeout(KEY_TIMEOUT_MS),
  })
  const text = await response.text().catch(() => '')
  if (!response.ok) {
    throw new UpstreamError(`Codely 推理 Key 换发失败（HTTP ${response.status}）`, CODE.credential, { status: response.status })
  }
  let payload
  try { payload = JSON.parse(text) } catch {
    throw new UpstreamError('Codely 推理 Key 换发响应不是 JSON', CODE.server, { status: response.status })
  }
  const key = typeof payload?.cli_api_key === 'string' ? payload.cli_api_key : ''
  if (key === '') throw new UpstreamError('Codely 推理 Key 换发响应缺少 cli_api_key', CODE.server, { status: response.status })
  return key
}

/**
 * 把 Accio 的**顶层**帧包成 Gemini 形状。
 *
 * 上游下发 `{content: {parts}, usage_metadata, partial}`（键在顶层），而我们的
 * Gemini 解码器读 `{candidates: [{content}]}`。不包这一层，正文/工具调用/usage
 * 全都会被当成「只有 usage 的帧」丢弃 —— 这正是上游参考实现记录过的缺口。
 *
 * `partial` 透传：它标记「这一帧还不是最终结果」。
 */
export function wrapAccioFrame(payload) {
  if (payload === null || typeof payload !== 'object') return null
  const content = payload.content
  if (content === null || typeof content !== 'object') {
    // 纯 usage 帧也照传（token 计量要靠它），但只保留 usage 字段。
    if (payload.usage_metadata !== undefined || payload.usageMetadata !== undefined) {
      return { candidates: [{ index: 0, content: { parts: [] } }], ...payload.usage_metadata !== undefined ? { usageMetadata: payload.usage_metadata } : { usageMetadata: payload.usageMetadata } }
    }
    return null
  }
  const frame = {
    candidates: [{
      index: 0,
      content: {
        role: 'model',
        ...Array.isArray(content.parts) ? { parts: content.parts } : {},
      },
      ...payload.finish_reason !== undefined ? { finishReason: payload.finish_reason } : {},
      ...payload.finishReason !== undefined ? { finishReason: payload.finishReason } : {},
    }],
  }
  const usage = payload.usage_metadata ?? payload.usageMetadata
  if (usage !== undefined) frame.usageMetadata = usage
  if (payload.partial !== undefined) frame.partial = payload.partial
  return frame
}

/** camelCase → snake_case（递归）；`undefined` 键整条丢掉（不写 null）。 */
export function toSnake(value) {
  if (Array.isArray(value)) return value.map(toSnake)
  if (value !== null && typeof value === 'object') {
    const out = {}
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue
      out[key.replace(/[A-Z]/g, char => `_${char.toLowerCase()}`)] = toSnake(child)
    }
    return out
  }
  return value
}

/**
 * 一家的通道描述：`{id, chatUrl, headers(credential), body(body, model), wrap?}`。
 *
 * `wrap` 存在时，响应帧要先过它（Accio 的 Gemini 形）。没有 `wrap` 的车道是
 * OpenAI SSE，原样透传。
 */
const LANES = {
  codely: {
    id: 'codely',
    async headers(credential, { fetch: fetchImpl, signal } = {}) {
      const key = await fetchCodelyCliKey(credential.access_token, { fetch: fetchImpl, signal })
      return {
        url: CODELY_CHAT,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${key}`,
          'User-Agent': CODELY_CLI_UA,
          'X-Codely-Signature': codelySignature(key, CODELY_CHAT),
          'x-litellm-session-id': credential.session_id ?? 'ofm-session',
        },
      }
    },
  },
  autoclaw: {
    id: 'autoclaw',
    base: 'https://autoglm-acceleration-api.zhipuai.cn',
    product: 'autoclaw',
  },
  autoclawintl: {
    id: 'autoclawintl',
    base: 'https://autoglm-api.autoglm.ai',
    product: 'autoclaw',
  },
  accio: {
    id: 'accio',
    base: 'https://phoenix-gw.alibaba.com',
    wrap: wrapAccioFrame,
  },
  /**
   * MiniMax 国际版：**Anthropic Messages** 线，不是 OpenAI 兼容。
   *
   * 请求体由适配器按 `wire: 'messages'` 组好，这里只补主机与鉴权。响应是标准
   * Anthropic SSE（`message_start` / `content_block_delta` / `message_stop`），
   * 由 `readStream(..., 'messages')` 的 `feedClaude` 解码，**不做二次改写**。
   */
  minimaxintl: {
    id: 'minimaxintl',
    base: 'https://agent.minimax.io',
    path: '/mavis/api/v1/llm/v1/messages',
  },
  /**
   * 腾讯 Marvis：OpenAI 兼容 `/v1/chat/completions`，但鉴权是四件套
   * （`Ual-Access-Openid/Access-Token/Login-Type/Guid`）+ `Marvis-*` 业务头，
   * 而 `Authorization` 只有一个占位符 —— 别改成 Bearer。
   */
  marvis: {
    id: 'marvis',
    base: 'https://yybadaccess.3g.qq.com',
    path: '/v1/chat/completions',
  },
  /**
   * 超级麦吉 / MagiCrew：OpenAI 兼容，`mgw_` api_key 走 Bearer。
   * 国际站**强制** `organization-code`（业务 API 缺了回 2182；网关形态未定，但带上更安全）。
   */
  magicrew: {
    id: 'magicrew',
    base: 'https://i-magic-service.letsmagic.cn',
    path: '/v1/chat/completions',
    webOrigin: 'https://www.letsmagic.cn',
    needsOrg: false,
  },
  magicrewintl: {
    id: 'magicrewintl',
    base: 'https://magic-service.magicrew.ai',
    path: '/v1/chat/completions',
    webOrigin: 'https://www.magicrew.ai',
    needsOrg: true,
  },
  /**
   * MonkeyCode：**Anthropic Messages** 网关（`/messages`），不是 OpenAI 兼容。
   * 鉴权是 `x-api-key: oma_…` + `X-OhmyAgent-Signature: v1=HMAC-SHA256(secret, prompt)`。
   */
  monkeycode: {
    id: 'monkeycode',
    base: 'https://proxy.monkeycode-ai.com/v1',
    path: '/messages',
  },
  monkeycodeintl: {
    id: 'monkeycodeintl',
    base: 'https://proxy.monkeycode-ai.net/v1',
    path: '/messages',
  },
  /** AStudio：**Responses** 线（`/responses`），请求体已由适配器按 responses 组好。 */
  astudio: {
    id: 'astudio',
    base: ASTUDIO.maasBaseUrl,
    path: ASTUDIO.chatPath,
  },
  /** OfficeAce：OpenAI 形 `/v2/chat/completions`，Bearer（DPoP 只用于换 token）。 */
  officeace: {
    id: 'officeace',
    base: OFFICEACE.baseUrl,
    path: OFFICEACE.chatPath,
  },
  /** 百智云：Anthropic 兼容；`max_tokens` 必须按模型夹取（唯一夹取点）。 */
  baizhi: {
    id: 'baizhi',
    base: BAIZHI.baseUrl,
    path: BAIZHI.messagesPath,
  },
  /**
   * 豆包：请求体与响应帧都是**这套协议自己的**（不是 OpenAI 兼容）。
   *
   * - 请求体由 `buildDoubaoChatBody` 整体生成（`mode=1+agent_mode=2` = 对话、
   *   `mode=3+agent_mode=1` = 工作任务）；
   * - 响应帧 `id:/event:/data:`，正文在 `STREAM_CHUNK` / `CHUNK_DELTA` 里，
   *   由 `createDoubaoTranslator` 翻成 OpenAI chunk。
   *   ⇒ 故这里带 `frames: 'doubao'`，`postOwnChannelStreamed` 用它选解析器。
   */
  doubao: {
    id: 'doubao',
    base: DOUBAO.baseUrl,
    path: DOUBAO.chatPath,
    frames: 'doubao',
  },
  /**
   * AgnesCode ×2：OpenAI 兼容，但主机**每账号下发**（凭据里的 `bff_base`），
   * 所以没有静态 `base` —— `buildRequest()` 里现读并做域名钉扎。
   * 响应 SSE 带 `reasoning_content`，由 `src/stream.js` 的通用推理字段接住。
   */
  agnescode: {
    id: 'agnescode',
    path: '/chat/completions',
  },
  agnescodeintl: {
    id: 'agnescodeintl',
    path: '/chat/completions',
  },
}

export function laneFor(provider) {
  return LANES[provider] ?? null
}

/**
 * 发一轮并流式交出帧。
 *
 * @param {object} options
 * @param {string} options.provider - `codely` / `autoclaw` / `autoclawintl` / `accio`
 * @param {object|null} options.credential - 该账号的凭据 JSON
 * @param {object} options.body - 已序列化的 OpenAI 形请求体（含 `model`）
 * @param {AbortSignal} [options.signal]
 * @param {(frame: string) => void} options.onData - 交出**已标准化**的帧文本
 * @param {Function} [options.fetch] - 测试注入
 * @param {number} [options.timeoutMs]
 */
export async function postOwnChannelStreamed({ provider, credential, body, signal, onData, fetch: fetchImpl = egressFetch, timeoutMs = TURN_TIMEOUT_MS }) {
  const lane = laneFor(provider)
  if (lane === null) throw new UpstreamError(`unknown own channel "${provider}"`, CODE.client)
  if (credential === null || typeof credential !== 'object') throw new UpstreamError('凭据不可用（需要重新登录）', CODE.credential)

  const request = await buildRequest(lane, credential, body, { fetch: fetchImpl, signal })
  let response
  try {
    response = await fetchImpl(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.bodyText,
      redirect: 'error',
      signal,
    })
  } catch (error) {
    if (signal?.aborted === true || error?.name === 'AbortError') throw new UpstreamError('request aborted', CODE.aborted)
    throw new UpstreamError(`model request failed: ${error?.message ?? error}${transportCause(error)}`, CODE.transport)
  }
  const retrySeconds = Number(response.headers.get('retry-after'))
  const setRetry = Number.isFinite(retrySeconds) && retrySeconds > 0 ? Math.trunc(retrySeconds * 1000) : undefined
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw classifyFailure(response.status, withUpstreamReason(parseMaybeJson(text, response.status)), setRetry)
  }
  if (response.body === null) throw new UpstreamError('model stream returned no body', CODE.empty)

  const headTimeoutMs = lane.frames === 'doubao' ? Math.min(timeoutMs, DOUBAO_HEAD_TIMEOUT_MS) : timeoutMs
  const head = await readHead(response.body, 4096, { signal, timeoutMs: headTimeoutMs })
  const shape = sniffBody(head.text)
  if (shape === 'empty') throw new UpstreamError('model stream returned no body', CODE.empty)

  /**
   * 豆包：帧是 `id:` / `event:` / `data:`，**事件名有意义**（正文散在
   * `STREAM_CHUNK` / `CHUNK_DELTA` 里），而通用的 `readSse` 只交 `data:` 负载。
   * 故这条线走自己的帧解析 + 翻译器，交出的同样是 OpenAI chunk 负载。
   */
  if (lane.frames === 'doubao') {
    const translator = createDoubaoTranslator()
    const emit = chunk => { if (typeof chunk === 'string' && chunk !== '') onData(chunk) }
    // 上游把业务错误塞在 200 的流里（`STREAM_ERROR`），必须当场抛出去 ——
    // 否则用户看到的是一条「没有正文」的成功回答（实测 `710020202 common invalid param`）。
    const checkFailure = () => {
      if (translator.failure === undefined) return
      const { code, message } = translator.failure
      throw new UpstreamError(`doubao: 上游返回 ${code} ${message}`.trim(), CODE.server)
    }
    if (shape === 'sse') {
      await readDoubaoFrames(replayStream(head), frame => {
        for (const chunk of translator.push(frame)) emit(chunk)
        checkFailure()
      }, signal, timeoutMs)
    } else {
      // 非流式：整份 JSON 当成一帧快照喂进去（上游偶尔这么回）。
      let rawText = head.text
      if (!head.done) {
        try {
          while (true) {
            const row = await head.reader.read()
            if (row.done) break
            if (row.value !== undefined) rawText += head.decoder.decode(row.value, { stream: true })
          }
        } catch (error) {
          await head.reader.cancel().catch(() => {})
          throw classifyStreamFailure(error, signal)
        }
      }
      rawText += head.decoder.decode()
      let payload
      try { payload = JSON.parse(rawText) } catch {
        throw new UpstreamError(`unexpected non-stream response: ${rawText.slice(0, 200)}`, CODE.server, { status: response.status })
      }
      if (payload?.error !== undefined) throw classifyFailure(response.status, payload, setRetry)
      const code = Number(payload?.code)
      if (Number.isFinite(code) && code !== 0) {
        throw new UpstreamError(`doubao: 上游返回 ${code} ${String(payload?.message ?? payload?.msg ?? '')}`.trim(), CODE.server, { status: response.status })
      }
      for (const chunk of translator.push({ event: 'FULL_MSG_NOTIFY', data: JSON.stringify(payload) })) emit(chunk)
    }
    for (const chunk of translator.finish()) emit(chunk)
    return { status: response.status }
  }

  if (shape === 'sse') {
    const rewrite = lane.wrap === undefined ? null : payload => {
      let parsed
      try { parsed = JSON.parse(payload) } catch { return null }
      const wrapped = lane.wrap(parsed)
      return wrapped === null ? null : JSON.stringify(wrapped)
    }
    await readSse(replayStream(head), frame => {
      if (rewrite === null) { onData(frame); return }
      // Accio：只重写 `data:` 的负载，其余行（注释/空行）原样交出。
      const value = rewrite(frame)
      if (value !== null) onData(value)
    }, signal, timeoutMs)
    return { status: response.status }
  }

  // 单个 JSON 文档：整份收下，再按车道交出（Accio 要包一层 candidates）。
  let rawText = head.text
  if (!head.done) {
    try {
      while (true) {
        const row = await head.reader.read()
        if (row.done) break
        if (row.value !== undefined) rawText += head.decoder.decode(row.value, { stream: true })
      }
    } catch (error) {
      await head.reader.cancel().catch(() => {})
      throw classifyStreamFailure(error, signal)
    }
  }
  rawText += head.decoder.decode()
  let payload
  try { payload = JSON.parse(rawText) } catch {
    throw new UpstreamError(`unexpected non-stream response: ${rawText.slice(0, 200)}`, CODE.server, { status: response.status })
  }
  if (payload?.error !== undefined) throw classifyFailure(response.status, payload, setRetry)
  const final = lane.wrap === undefined ? payload : lane.wrap(payload)
  if (final !== null) onData(JSON.stringify(final))
  return { status: response.status }
}

/** 按车道组装 URL / 头 / 体。 */
async function buildRequest(lane, credential, body, { fetch: fetchImpl, signal }) {
  if (lane.id === 'doubao') {
    // 请求体**整体替换**（不是 OpenAI 形）：模式号从目录来，`mode=3` 是会员付费额度那条线。
    const modelId = String(body?.modelId ?? body?.model ?? '')
    return {
      url: `${DOUBAO.baseUrl}${DOUBAO.chatPath}?${doubaoQueryString(doubaoWebQuery(credential))}`,
      headers: doubaoHeaders(credential?.cookie, { accept: 'text/event-stream' }),
      bodyText: buildDoubaoChatBody({
        model: modelId,
        mode: doubaoModeOf(modelId),
        prompt: doubaoPromptOf(body?.messages),
        reasoningEffort: typeof body?.reasoning_effort === 'string' ? body.reasoning_effort : undefined,
      }),
    }
  }

  if (lane.id === 'codely') {
    const prepared = await lane.headers(credential, { fetch: fetchImpl, signal })
    return {
      url: prepared.url,
      headers: prepared.headers,
      bodyText: JSON.stringify({ ...body, stream: true }),
    }
  }

  if (lane.id === 'accio') {
    // Gemini 形：`token` 必须在 **body**（放 Authorization 头恒 402/403），
    // `sg_k` = md5(requestId) 放 query，`message_id` 必填。
    const requestId = `req-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
    const messageId = crypto.createHash('md5').update(`${requestId}:${Math.random()}`).digest('hex')
    const contents = []
    for (const message of Array.isArray(body.messages) ? body.messages : []) {
      const role = message.role === 'assistant' ? 'model' : 'user'
      const text = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
          : ''
      if (text === '') continue
      contents.push({ role, parts: [{ text }] })
    }
    const payload = toSnake({
      model: body.model,
      empid: '',
      tenant: '',
      iaiTag: '',
      requestId,
      userRequestId: requestId,
      contents,
      systemInstruction: typeof body.systemInstruction === 'string' && body.systemInstruction !== '' ? body.systemInstruction : undefined,
      temperature: body.temperature,
      maxOutputTokens: body.max_tokens,
      stopSequences: [],
      token: credential.access_token,
      messageId,
      incremental: true,
    })
    payload.properties = {
      utdid: credential.utdid ?? `ttid_${requestId}`,
      version: '0.34.4',
      appKey: 'OneChat',
      normalized_response: 'true',
    }
    return {
      url: `${lane.base}/api/adk/llm/generateContent?sg_k=${crypto.createHash('md5').update(requestId).digest('hex')}`,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        utdid: payload.properties.utdid,
        version: '0.34.4',
        appKey: 'OneChat',
      },
      bodyText: JSON.stringify(payload),
    }
  }

  if (lane.id === 'minimaxintl') {
    // Anthropic Messages：`body` 已经是 `{model, messages, system?, max_tokens, stream}`
    // 的形状，原样发出去 —— 这里**不重排**字段，也不塞 OpenAI 的 `stream_options`。
    const token = String(credential.access_token ?? '').trim()
    return {
      url: `${lane.base}${lane.path}`,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${token}`,
        // 官方客户端就这么自称；网关按 UA 分流的端点（模型目录）也吃这一套。
        'User-Agent': 'MiniMax-Code/1.0',
      },
      bodyText: JSON.stringify({ ...body, stream: true }),
    }
  }

  if (lane.id === 'magicrew' || lane.id === 'magicrewintl') {
    const apiKey = String(credential.apiKey ?? credential.api_key ?? '').trim()
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      // `mgw_` key 走 Bearer；JWT 不能拿来推理。
      Authorization: `Bearer ${apiKey}`,
      // WAF 认 origin + referer（缺 referer 是 403 空 body）。
      origin: lane.webOrigin,
      referer: `${lane.webOrigin}/`,
    }
    const org = String(credential.organizationCode ?? '').trim()
    if (org !== '') headers['organization-code'] = org
    return { url: `${lane.base}${lane.path}`, headers, bodyText: JSON.stringify({ ...body, stream: true }) }
  }

  if (lane.id === 'astudio') {
    return {
      url: `${lane.base}${lane.path}`,
      headers: { ...astudioBearerHeaders(credential.model_bearer_token), accept: 'text/event-stream' },
      bodyText: JSON.stringify({ ...body, stream: true }),
    }
  }

  if (lane.id === 'officeace') {
    return {
      url: `${lane.base}${lane.path}`,
      headers: { ...officeaceInferenceHeaders(credential), accept: 'text/event-stream' },
      bodyText: JSON.stringify({ ...body, stream: true }),
    }
  }

  if (lane.id === 'baizhi') {
    const clamped = Math.min(Number(body.max_tokens) || 0, baizhiMaxOutputTokensFor(body.model))
    return {
      url: `${lane.base}${lane.path}`,
      headers: baizhiInferenceHeaders(credential),
      bodyText: JSON.stringify({ ...body, max_tokens: clamped > 0 ? clamped : baizhiMaxOutputTokensFor(body.model), stream: true }),
    }
  }

  if (lane.id === 'monkeycode' || lane.id === 'monkeycodeintl') {
    // Anthropic 形请求体；提示词正文用于签名（最后一条 user 文本）。
    const messages = Array.isArray(body.messages) ? body.messages : []
    let prompt = ''
    for (const message of messages) {
      if (message?.role !== 'user') continue
      prompt = typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? message.content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
          : ''
    }
    return {
      url: `${lane.base}${lane.path}`,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'x-api-key': String(credential.api_key ?? credential.apiKey ?? ''),
        'anthropic-version': '2023-06-01',
        'X-OhmyAgent-Signature': monkeycodeSignature(credential.signing_secret ?? credential.signingSecret, prompt),
      },
      bodyText: JSON.stringify({ ...body, stream: true }),
    }
  }

  if (lane.id === 'marvis') {
    // OpenAI 兼容体，鉴权全在头里（`Authorization` 是占位符，别改成 Bearer）。
    return {
      url: `${lane.base}${lane.path}`,
      headers: marvisChatHeaders(credential),
      bodyText: JSON.stringify({ ...body, stream: true }),
    }
  }

  if (lane.id === 'agnescode' || lane.id === 'agnescodeintl') {
    // 主机来自凭据（每账号下发），挂 Authorization 前必须过域名白名单 ——
    // 否则一份被改过的会话文件就能把令牌送到任意主机。
    const base = String(credential.bff_base ?? '').replace(/\/+$/, '')
    if (!agnesHostAllowed(base)) {
      throw new UpstreamError('AgnesCode 凭据里的 bff_base 不在白名单内（需要重新导入登录态）', CODE.credential)
    }
    return {
      url: `${base}${lane.path}`,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${String(credential.access_token ?? '').trim()}`,
      },
      bodyText: JSON.stringify({ ...body, stream: true }),
    }
  }

  // AutoClaw：管理头（MD5 签名）+ 两个鉴权头 + 模型名走头。
  const appId = '100003'
  const appKey = '38d2391985e2369a5fb8227d8e6cd5e5'
  const ts = String(Math.floor(Date.now() / 1000))
  const sign = crypto.createHash('md5').update(`${appId}&${ts}&${appKey}`).digest('hex')
  const token = String(credential.access_token ?? '').trim()
  return {
    url: `${lane.base}/autoclaw-proxy/proxy/autoclaw/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'X-Version': '2.1.1',
      'X-Auth-Appid': appId,
      'X-Auth-TimeStamp': ts,
      'X-Auth-Sign': sign,
      'X-Authorization': `Bearer ${token}`,
      'X-Request-Model': String(body.model ?? ''),
      'X-Product': lane.product,
    },
    bodyText: JSON.stringify({ ...body, stream: true }),
  }
}

function parseMaybeJson(text, status) {
  try { return JSON.parse(text) } catch {
    return { error: { message: text.slice(0, 300) || `HTTP ${status}` } }
  }
}

/**
 * 把上游的原因从 `msg` / `error_msg` 提到 `message` 上。
 *
 * 豆包这类国内网关把原因写成 `{"code":7100…,"msg":"当前对话人数过多","message":"…"}`，
 * 有的只给 `msg`；而 `classifyFailure` 只认 `error.message` / `message`，
 * 于是那句**唯一能让用户行动的话**会被压成 `upstream HTTP 500`（参考实现 issue #150）。
 *
 * 只取这几个字段，绝不把整段 body 带进错误：body 可能回显请求与凭据。
 */
function withUpstreamReason(payload) {
  if (payload === null || typeof payload !== 'object') return payload
  const error = payload.error ?? payload
  if (error === null || typeof error !== 'object') return payload
  if (typeof error.message === 'string' && error.message.trim() !== '') return payload
  const reason = [error.msg, error.error_msg].find(value => typeof value === 'string' && value.trim() !== '')
  if (reason === undefined) return payload
  return { ...payload, error: { ...error, message: reason.trim().slice(0, 200) } }
}