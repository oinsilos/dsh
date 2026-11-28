import { ROUTE_MAIN } from '../adapter.js'
import { toOpenAiUsage } from '../forward.js'
import { isPoolEntry } from '../forward-pool.js'

export function routableModelIds(snapshot) {
  /**
   * 自有渠道有自己的路由（每条路由 = 选择器里的一个分组），但本机网关与
   * `/v1/models` 是**按模型 id 收单**的：只并 `ROUTE_MAIN` 会让 80 个自有模型
   * 在网关里 404（模型看得到、选得中，网关却说不存在）。所以这里并**所有**
   * 路由 —— 路由名只影响选择器分组，不影响哪些 id 可路由。
   */
  const membership = new Set()
  for (const ids of Object.values(snapshot.membership ?? {})) {
    for (const id of Array.isArray(ids) ? ids : []) membership.add(id)
  }
  return membership
}

export function publicModelRows(snapshot) {
  const membership = routableModelIds(snapshot)
  /**
   * 「对外入口」开启隐藏时，网关只报这一个名字。
   *
   * 这不是省流量的花活：池的契约是「外部只填一个名字、内部自动换人」，但一个
   * 客户端看到 100 多个可选项时，人会去挑、会填错、会挑到一个今天正好限流的，
   * 又开始来回改配置 —— 恰好是池要消灭的那个流程。只报入口名，客户端就没得选，
   * 契约才真正成立。想精确指定某模型时，把隐藏开关关掉即可。
   *
   * 隐藏只作用于**网关 `/v1/models`**，不作用于宿主选择器：本机人仍能看到全部。
   */
  const pool = snapshot.catalog.find(entry => isPoolEntry(entry) && entry.hideOthers === true)
  const visible = group => pool === undefined ? group : group.filter(entry => entry.id === pool.id)
  return visible(snapshot.catalog)
    .filter(entry => membership.has(entry.id))
    .map(entry => ({
      id: entry.id, object: 'model',
      created: Math.floor(Date.now() / 1000), owned_by: 'our-free-model',
      ...entry.contextWindow === undefined ? {} : { context_window: entry.contextWindow },
    }))
}

/** 固定本次请求的模型和配置快照，两个入口使用同一条推理链路。 */
export function createForwardCompletion({ adapter, state, signal }) {
  return async (request, onChunk) => {
    if (signal?.aborted) throw Object.assign(new Error('model runtime is stopped'), { statusCode: 503 })
    const snapshot = state()
    const entry = snapshot.catalog.find(candidate => candidate.id === request.model)
    if (entry === undefined || !routableModelIds(snapshot).has(entry.id)) {
      throw Object.assign(new Error(`model "${request.model}" not found`), { statusCode: 404 })
    }
    const openAi = request.openAi ?? {}
    // Two callers converge here. The OpenAI/Responses listener hands over a raw
    // body; the Anthropic listener hands over harness messages it already
    // projected through `fromAnthropicRequest`, because re-spelling them as
    // OpenAI blocks and back would lose thinking blocks and block ordering. Both
    // shapes end at the same adapter call, so there is exactly one place that
    // decides which model runs.
    const messages = Array.isArray(request.messages)
      ? request.messages
      : fromOpenAiMessages(openAi, request.responses === true, entry.id)
    const tools = Array.isArray(request.tools)
      ? request.tools
      : (openAi.tools ?? []).map(normalizeTool).filter(Boolean)
    const handler = typeof onChunk === 'function' ? onChunk : () => {}
    const outcome = { text: '', toolCalls: [], usage: undefined, truncated: false, error: undefined }
    const maxTokens = Number.isFinite(request.maxTokens) ? request.maxTokens
      : Number.isFinite(openAi.max_tokens) ? openAi.max_tokens : undefined
    const temperature = Number.isFinite(request.temperature) ? request.temperature
      : Number.isFinite(openAi.temperature) ? openAi.temperature : undefined
    const reasoningEffort = typeof request.reasoningEffort === 'string' ? request.reasoningEffort
      : typeof openAi.reasoning_effort === 'string' ? openAi.reasoning_effort : undefined
    const options = {
      provider: ROUTE_MAIN, model: entry.id,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      ...temperature === undefined ? {} : { temperature },
      ...maxTokens === undefined ? {} : { maxTokens },
      ...reasoningEffort === undefined ? {} : { reasoningEffort },
      sessionId: `forward:${String(openAi.user ?? openAi.conversation ?? request.sessionId ?? 'shared')}`,
      signal: request.signal && signal ? AbortSignal.any([request.signal, signal]) : request.signal ?? signal,
    }
    for await (const chunk of adapter.stream(options, entry, snapshot)) {
      handler(chunk)
      foldForwardOutcome(outcome, chunk)
    }
    if (outcome.truncated === true) {
      outcome.toolCalls = outcome.toolCalls.filter(call => {
        try { JSON.parse(call.arguments === '' ? '{}' : call.arguments); return true } catch { return false }
      })
    }
    return outcome
  }
}

export function fromOpenAiMessages(body, isResponses, modelId) {
  const out = []
  const rows = isResponses
    ? normaliseResponsesInput(body.input)
    : (Array.isArray(body.messages) ? body.messages : [])
  for (const row of rows) {
    const role = row.role ?? 'user'
    const content = []
    if (typeof row.content === 'string') {
      if (row.content !== '') content.push({ type: 'text', text: row.content })
    } else if (Array.isArray(row.content)) {
      for (const part of row.content) {
        if (typeof part === 'string') { if (part !== '') content.push({ type: 'text', text: part }); continue }
        const text = part?.text ?? part?.input_text ?? part?.output_text
        if (typeof text === 'string' && text !== '') content.push({ type: 'text', text })
        const image = part?.image_url?.url ?? part?.image_url
        if (typeof image === 'string' && image !== '') {
          content.push({ type: 'image', attachment: { attachmentId: `url:${image.slice(0, 64)}`, mediaType: 'image/png', bytes: 0, width: 0, height: 0, url: image } })
        }
      }
    }
    if (role === 'tool') {
      out.push({ role: 'tool', content: [{ type: 'text', text: typeof row.content === 'string' ? row.content : JSON.stringify(row.content ?? '') }], toolCallId: row.tool_call_id ?? '', source: { kind: 'tool', callId: row.tool_call_id ?? '' } })
      continue
    }
    if (role === 'assistant' && Array.isArray(row.tool_calls)) {
      for (const call of row.tool_calls) {
        content.push({ type: 'tool-call', id: call.id ?? '', name: call.function?.name ?? '', arguments: call.function?.arguments ?? '{}' })
      }
    }
    if (content.length === 0) continue
    out.push({
      role: role === 'developer' ? 'developer' : role === 'system' ? 'system' : role === 'assistant' ? 'assistant' : 'user',
      content,
      ...role === 'assistant' ? { source: { kind: 'model', provider: ROUTE_MAIN, model: String(modelId ?? '') } } : {},
    })
  }
  return out
}

function normaliseResponsesInput(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }]
  if (!Array.isArray(input)) return []
  return input.map(row => {
    if (typeof row === 'string') return { role: 'user', content: row }
    if (row.type === 'function_call') return { role: 'assistant', content: [], tool_calls: [{ id: row.call_id, function: { name: row.name, arguments: row.arguments } }] }
    if (row.type === 'function_call_output') return { role: 'tool', content: String(row.output ?? ''), tool_call_id: row.call_id }
    return row
  })
}

function normalizeTool(tool) {
  const name = tool?.name ?? tool?.function?.name
  if (typeof name !== 'string' || name.trim() === '') return null
  const parameters = tool?.parameters ?? tool?.function?.parameters ?? { type: 'object', properties: {} }
  return { name, description: String(tool?.description ?? tool?.function?.description ?? ''), parameters }
}

export function foldForwardOutcome(outcome, chunk) {
  switch (chunk.type) {
    case 'text-delta': outcome.text += chunk.text; break
    case 'tool-call-delta': {
      let call = outcome.toolCalls.find(candidate => candidate.slot === chunk.index)
      if (call === undefined) { call = { slot: chunk.index, id: chunk.id ?? '', name: chunk.name ?? '', arguments: chunk.argumentsDelta ?? '' }; outcome.toolCalls.push(call) }
      else call.arguments += chunk.argumentsDelta ?? ''
      if (chunk.name) call.name = chunk.name
      if (chunk.id) call.id = chunk.id
      break
    }
    case 'block-end':
      if (chunk.block?.type === 'tool-call') {
        // Match by slot first: the call's deltas were folded under this same
        // block index, and a relayed stream can carry its id late — matching
        // by id alone would miss the slot's entry and fold one call into two.
        // The block-end carries the assembled arguments, so a slot match
        // adopts them; an id match only fills identity fields.
        const bySlot = outcome.toolCalls.find(candidate => candidate.slot === chunk.index)
        if (bySlot !== undefined) {
          if (typeof chunk.block.id === 'string' && chunk.block.id !== '') bySlot.id = chunk.block.id
          if (typeof chunk.block.name === 'string' && chunk.block.name !== '') bySlot.name = chunk.block.name
          if (typeof chunk.block.arguments === 'string') bySlot.arguments = chunk.block.arguments
          break
        }
        const byId = outcome.toolCalls.find(candidate => typeof candidate.id === 'string' && candidate.id !== ''
          && candidate.id === chunk.block.id)
        if (byId === undefined) {
          outcome.toolCalls.push({
            slot: chunk.index,
            id: typeof chunk.block.id === 'string' ? chunk.block.id : '',
            name: typeof chunk.block.name === 'string' ? chunk.block.name : '',
            arguments: typeof chunk.block.arguments === 'string' ? chunk.block.arguments : '',
          })
        }
      }
      break
    case 'usage': outcome.usage = toOpenAiUsage(chunk.usage); break
    case 'finish':
      if (chunk.reason?.kind === 'max-tokens') outcome.truncated = true
      if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') outcome.error = chunk.reason.failure?.message
      break
    default: break
  }
  return outcome
}
