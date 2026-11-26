/**
 * The provider adapter.
 *
 * It satisfies the harness adapter contract structurally — `registerAdapter`
 * validates by calling the methods, not by an `instanceof` test — which is what
 * lets this plugin mount on more than one kernel line without importing a
 * version-pinned adapter base class.
 *
 * Two routes are published from one adapter instance, because the harness groups
 * the model picker strictly by provider route and offers no other grouping
 * field: `our-free-model` carries what this egress can use right now, and
 * `our-free-model-region` carries what the gateway refuses on this egress. A
 * group with no models is dropped from the picker by the client, so a user whose
 * VPN unlocks the region-gated models sees one group, and a user without sees
 * the second group labelled as such.
 *
 * @module src/adapter.js
 */

import { applyFingerprint, baseModelId, endpointFor, mintRequestId, sessionForConversation, wireFor } from './upstream.js'
import { toChatMessages, toClaudeMessages, toResponseInput, toToolDefs, repairToolPairing } from './messages.js'
import { CODE, UpstreamError, postStreamed } from './http.js'
import { postSealedStreamed } from './eac.js'
import { postKiloStreamed } from './kilo.js'
import { postOwnChannelStreamed } from './channels/inference.js'
import { OWN_LABELS, isOwnEntry } from './channels/catalog.js'
import { postAggregateStreamed, isAggregateEntry } from './aggregate.js'
import { finishReason, readStream, windowTokens } from './stream.js'
import { DEFAULT_LEVEL, MIN_BUDGET, budgetFor, defaultEffortFor, effortPatchFor, effortsFor, normalizeEffort, resolveLevel } from './effort.js'
import { createChannel } from './channel.js'
import { recoveryPolicy, canRecover, canRecoverSilentStop, recoveryMessages, continuationMessages, checkpointFits, addUsage, createBlockTracker } from './recovery.js'
import { isEacEntry, isKiloEntry } from './catalog.js'
import { isComboEntry, comboChain } from './combos.js'
import { applyTokenSavers, saverConfig } from './token-saver/index.js'
import { classifyFailure, describeVerdict, shouldAdvance, FAILURE_KIND } from './route/classify.js'
import { isRouteEntry, GROUP_PREFIX, resolveGroupCandidates } from './route/groups.js'
import { PIXEL_IMAGE_PRICING } from './image-pricing.js'

export const ROUTE_MAIN = 'our-free-model'
export const ROUTE_REGION = 'our-free-model-region'
/**
 * 虚拟行走一条独立路由：路由分组 + 组合链。
 *
 * 宿主的选择器按**路由**分组，一个路由一个标题。以前只有免费车道有路由，
 * 这些虚拟行都并进 `ROUTE_MAIN`，于是「免费模型」这一组里混着 `route:主力`
 * 和 `combo:xxx`。它们不是免费模型，给它们自己一条路由和方法名。
 */
export const ROUTE_GROUPS = 'our-free-model-route'

/** Group headings — the only strings the picker shows as a section title. */
export const ROUTE_LABELS = {
  [ROUTE_MAIN]: '免费模型',
  [ROUTE_REGION]: '免费模型 · 地区受限',
  [ROUTE_GROUPS]: '路由分组与组合链',
}

const STYLE_FOR_WIRE = { chat: 'chat', responses: 'flat', messages: 'claude' }

export class FreeModelAdapter {
  /**
   * @param {object} dependencies
   * @param {() => {catalog: Array<object>, membership: Record<string, string[]>, settings: object, attributionUserAgent: string}} dependencies.state
   * @param {(ref: object) => string | undefined} [dependencies.resolveImage]
   * @param {(record: object) => void} dependencies.recordUsage
   * @param {(record: object) => void} [dependencies.recordTurn]
   * @param {(message: string) => void} [dependencies.warn]
   */
  constructor(dependencies) {
    this.deps = dependencies
  }

  providerInfo(provider) {
    // 自有渠道各自占一条路由：选择器把每个路由画成一个分组，标题就是这里
    // 的 `name`。没有它，把渠道 id 原样当标题（`doubao` / `autoclawintl`）。
    return { id: provider, name: ROUTE_LABELS[provider] ?? OWN_LABELS[provider] ?? provider }
  }

  /**
   * A fully resolved policy, not a configuration fragment.
   *
   * Both the 0.1.5 and 0.1.7 kernels store this object verbatim instead of
   * running it through their policy resolver, and the backoff scheduler reads the
   * delay fields off the top level. Reporting them nested under `backoff` makes
   * every scheduled delay `NaN`, which the durable session log then rejects —
   * turning a recoverable transient failure into an aborted turn.
   */
  providerRetryPolicy() {
    return Object.freeze({
      mode: 'normal',
      maxRetries: 2,
      // A regional refusal is a property of the egress, not a transient fault;
      // retrying it only spends quota. It is deliberately absent here. So is
      // RATE_LIMIT: this lane's 429 carries a *growing* retry-after, and the two
      // automatic retries turned every quota wall into three walls — the same
      // turn, paid thrice, arriving later (issue #13).
      retryableCodes: Object.freeze(['EMPTY_RESPONSE', 'SERVER', 'TIMEOUT', 'TRANSPORT']),
      initialDelayMs: 700,
      maxDelayMs: 8000,
      jitterRatio: 0.2,
    })
  }

  /**
   * Resolve provider-side request-image pricing for one exact model route.
   *
   * 宿主 spill-policy 遇到 undefined 会放弃整条含图结果的落盘（issue #151）。
   * 免费出口没有统一视觉计价协议，提供同步估算以支持预算与落盘。
   *
   * Must stay synchronous: the token meter resolves it per measurement, with no
   * I/O window (issue #42).
   *
   * @param {string} _provider - a route passed to `registerAdapter()` for this instance.
   * @param {string} _model - exact model id passed to GenerateOptions.model.
   * @returns {typeof PIXEL_IMAGE_PRICING} 视觉 Token 估算，不是厂商真实消耗。
   */
  imageRequestPricing(_provider, _model) {
    return PIXEL_IMAGE_PRICING
  }

  /** Models this route advertises right now. */
  async listModels(provider) {
    const state = this.deps.state()
    const ids = new Set(state.membership[provider] ?? [])
    return state.catalog
      .filter(entry => ids.has(entry.id))
      .map(entry => ({
        provider,
        id: entry.id,
        name: entry.name,
        description: describe(entry, state.settings),
        inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      }))
  }

  async resolveModel(provider, model) {
    const state = this.deps.state()
    const entry = state.catalog.find(candidate => candidate.id === baseModelId(model))
    if (entry === undefined) {
      return {
        provider,
        id: baseModelId(model),
        name: baseModelId(model),
        context: { contextWindow: 131072 },
        defaultMaxTokens: 8192,
      }
    }
    const ceiling = Math.min(entry.maxOutput, state.settings.defaultMaxTokens ?? 32768)
    const efforts = effortsFor(entry, undefined, state.settings.defaultMaxTokens)
    return {
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: entry.vision ? ['text', 'image'] : ['text'],
      context: { contextWindow: entry.contextWindow },
      defaultMaxTokens: ceiling,
      ...efforts === undefined ? {} : { reasoning: { efforts, defaultEffort: defaultEffortFor(entry) } },
    }
  }

  /**
   * Bind model metadata and the dispatch closure to one state snapshot, so a
   * catalog refresh arriving mid-turn cannot mix one generation's capacities
   * with another's endpoint table.
   */
  async prepareCall(provider, model) {
    const snapshot = this.deps.state()
    const entry = snapshot.catalog.find(candidate => candidate.id === baseModelId(model)) ?? null
    return {
      model: await this.resolveModel(provider, model),
      stream: options => this.stream(options, entry, snapshot),
    }
  }

  /**
   * @param {object} options - GenerateOptions
   * @param {object|null} pinned - catalog row frozen by `prepareCall`, if any
   * @param {object} [snapshot] - state generation frozen by `prepareCall`
   */
  stream(options, pinned, snapshot = this.deps.state()) {
    const controller = new AbortController()
    const onAbort = () => controller.abort(options.signal?.reason)
    if (options.signal?.aborted === true) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    const iterator = this.runStream({ ...options, signal: controller.signal }, pinned, snapshot)
    const cleanup = () => options.signal?.removeEventListener('abort', onAbort)
    const step = async (method, value) => {
      try {
        const row = await iterator[method](value)
        if (row.done) cleanup()
        return row
      } catch (error) {
        cleanup()
        throw error
      }
    }
    // 原生生成器把 return 排在 pending next 后；先取消请求才能立即退出。
    return {
      [Symbol.asyncIterator]() { return this },
      next: value => step('next', value),
      return: value => { controller.abort(); cleanup(); return step('return', value) },
      throw: error => { controller.abort(error); cleanup(); return step('throw', error) },
    }
  }

  /**
   * One turn: a combo walks its chain, everything else is a single model.
   *
   * A combo is a virtual model, so it reaches here as a pinned catalog row like
   * any other; the only difference is that its row carries a chain instead of an
   * endpoint. Resolving that here — rather than at the picker or the gateway —
   * means both callers get the failover for free.
   */
  async * runStream(options, pinned, snapshot) {
    const modelId = baseModelId(options.model)
    const entry = pinned ?? snapshot.catalog.find(candidate => candidate.id === modelId) ?? null
    // 面板里给单个模型定的档位优先于会话选择；清空下拉 = 跟随会话。
    const panelEffort = entry === null ? undefined : snapshot.settings?.modelEffort?.[entry.id]
    const effective = typeof panelEffort === 'string' && panelEffort !== ''
      ? { ...options, reasoningEffort: panelEffort }
      : options
    if (entry !== null && isComboEntry(entry)) {
      yield * this.runCombo(effective, entry, snapshot)
      return
    }
    if (entry !== null && isRouteEntry(entry)) {
      yield * this.runRoute(effective, entry, snapshot)
      return
    }
    // 会话钉在一个刚被停用/刚被删掉的分组上：目录里已经没有这一行，但仍要
    // 说清是哪个分组、为什么没走。否则会掉进 `runSingle`，拿一个 `route:` id
    // 去请求免费车道。
    if (entry === null && modelId.startsWith(GROUP_PREFIX)) {
      const group = (this.deps.routeGroups?.() ?? []).find(candidate => candidate.id === modelId)
      if (group !== undefined) {
        yield * this.runRoute(effective, {
          id: group.id,
          name: group.name,
          group: group.id,
          channel: 'route',
          wire: 'chat',
        }, snapshot)
        return
      }
      yield { type: 'finish', reason: { kind: 'error', failure: {
        message: `route group "${modelId.slice(GROUP_PREFIX.length)}" is no longer configured; pick another model`,
        code: CODE.server,
      } } }
      return
    }
    yield * this.runSingle(effective, entry, snapshot, {})
  }

  /**
   * A combo's chain, in the order its strategy produced.
   *
   * Kept as a thin wrapper so the walk itself lives in one place: a combo and a
   * route group differ only in how candidates are chosen and what happens on
   * failure, never in the commit rule.
   */
  async * runCombo(options, entry, snapshot) {
    yield * this.runChain(options, entry, comboChain(entry, snapshot.catalog).map(candidate => ({ entry: candidate })), snapshot, {
      onAdvance: (candidate, _result, reason) => {
        this.deps.warn?.(`our-free-model: chain "${entry.name}" advanced past ${candidate.entry.id} — ${reason}`)
      },
      emptyMessage: `the chain "${entry.name}" has no model available on this egress`,
    })
  }

  /**
   * A route group's turn: priority order, windows, today's failures and the
   * per-model concurrency gate all resolved before the first byte.
   *
   * Failure bookkeeping lives here rather than inside `runSingle`: "this model
   * failed today" is a property of the group, not of one turn, and it has to
   * survive the request that discovered it.
   */
  async * runRoute(options, entry, snapshot) {
    const group = (this.deps.routeGroups?.() ?? []).find(candidate => candidate.id === entry.group)
    if (group === undefined) {
      yield { type: 'finish', reason: { kind: 'error', failure: {
        message: `route group "${entry.name}" is no longer configured`,
        code: CODE.server,
      } } }
      return
    }
    if (group.enabled === false) {
      yield { type: 'finish', reason: { kind: 'error', failure: {
        message: `route group "${entry.name}" is switched off in its panel; enable it or pick another model`,
        code: CODE.server,
      } } }
      return
    }
    const resolved = resolveGroupCandidates(group, {
      catalog: snapshot.routeCatalog ?? snapshot.catalog,
      failedKeys: this.deps.routeStore?.failedKeys() ?? new Set(),
      gate: this.deps.gate,
    })
    this.deps.trace?.({
      kind: 'route-turn',
      group: group.id,
      candidates: resolved.candidates.map(candidate => candidate.entry.id).join(' '),
      skipped: resolved.skipped.map(item => `${item.model}:${item.reason}`).join(' '),
    })
    if (resolved.candidates.length === 0) {
      const skipped = resolved.skipped.map(item => `${item.model} (${item.detail})`).join('; ')
      const message = resolved.allFailed
        ? `route group "${entry.name}" has every member circuit-broken today — reset the failures in its panel to try again`
        : `route group "${entry.name}" has no usable member${skipped === '' ? '' : `: ${skipped}`}`
      yield { type: 'finish', reason: { kind: 'error', failure: { message, code: CODE.server } } }
      return
    }
    yield * this.runChain(options, entry, resolved.candidates, snapshot, {
      planFor: candidate => ({
        wire: wireOf(candidate.entry),
        turnModel: entry.id,
        // 成员的档位是这条分组真正的控制：同一组里 loomy 要 xhigh、codearts
        // 走 token 阶梯，effort 必须跟着候选走，而不是跟着会话走。旧插件的
        // 词汇（xhigh/Extra High/默认（高）…）先翻译成候选模型认的 id；
        // 翻不到就跟随会话，而不是像 resolveLevel 那样静默落回默认档。
        // 别的渠道的成员不跟随会话档位：那个档位是给本插件模型选的，塞给
        // 外部模型只会换来一句 UNSUPPORTED_REASONING_EFFORT（翻不到就留空）。
        reasoningEffort: normalizeEffort(candidate.entry, candidate.member.effort)
          || (candidate.entry.channel === 'host' ? undefined : options.reasoningEffort),
        hold: () => {
          const model = candidate.entry.id
          if (this.deps.gate?.acquire(model) !== true) return null
          return () => this.deps.gate.release(model)
        },
      }),
      onCommit: (candidate, result) => {
        if (result?.ok === true) this.deps.routeStore?.clearFailed(candidate.entry.id)
        this.deps.trace?.({ kind: 'route-commit', group: entry.id, model: candidate.entry.id, ok: result?.ok === true })
      },
      onAdvance: (candidate, result, reason) => {
        // 熔断键必须是目录 id，不是迁移前的成员写法：否则 `failedKeys.has(entry.id)`
        // 永远查不到，同一模型会在一个请求里被反复尝试。
        this.deps.routeStore?.markFailed({ ...candidate.member, model: candidate.entry.id }, {
          group: entry.id,
          code: result?.verdict?.kind ?? 'UNKNOWN',
          reason,
        })
        // 429 / 配额类失败说明"上游忙"，冷却期间连候选都不该是它。
        if (result?.verdict?.kind === FAILURE_KIND.RATE_LIMIT || result?.verdict?.cooldownMs > 0) {
          this.deps.gate?.markCapacity(candidate.entry.id, result?.verdict?.cooldownMs)
        }
        this.deps.warn?.(`our-free-model: route group "${entry.name}" advanced past ${candidate.entry.id} — ${reason}`)
      },
      emptyMessage: `route group "${entry.name}" has no usable member`,
    })
  }

  /**
   * Walk a chain until one candidate produces output.
   *
   * The commit rule is the whole design. Chunks are held in a buffer until the
   * first answer-bearing delta, so a candidate that fails before that point is
   * discarded whole: the caller never saw a byte of it, and switching models is
   * invisible. Reasoning deltas are deliberately *not* a commit — "thought for a
   * minute, then hit a quota wall" is the single most valuable case to fail
   * over, and the held thinking is dropped along with the rest of the discarded
   * try.
   *
   * Once an answer delta has been handed over the answer is the caller's, and a
   * later failure ends the turn the normal way — the single-model recovery path
   * inside `runSingle` still gets its continuation attempt first.
   *
   * @param {Array<{entry: object, member?: object}>} candidates
   * @param {object} [hooks] - `planFor` / `onAdvance` / `onCommit` / `emptyMessage`
   */
  async * runChain(options, entry, candidates, snapshot, hooks = {}) {
    const settings = snapshot.settings ?? {}
    const started = Date.now()
    const rejectedTurn = attempts => {
      this.deps.recordTurn?.({ at: started, model: entry.id, ok: false, recovered: false, attempts, origin: 'harness' })
    }
    if (settings.enabled === false) {
      rejectedTurn(0)
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'our free model is switched off in its settings page', code: 'CONFIG_DISABLED' } } }
      return
    }
    if (candidates.length === 0) {
      rejectedTurn(0)
      yield { type: 'finish', reason: { kind: 'error', failure: {
        message: hooks.emptyMessage ?? `the chain "${entry.name}" has no model available on this egress`,
        code: CODE.server,
      } } }
      return
    }
    const tried = []
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index]
      const plan = hooks.planFor?.(candidate, index) ?? {}
      const release = plan.hold?.() ?? null
      try {
        const passOptions = plan.reasoningEffort !== undefined
          ? { ...options, reasoningEffort: plan.reasoningEffort }
          : options
        const iterator = candidate.entry.channel === 'host'
          ? this.runForeign(passOptions, candidate.entry, plan)
          : this.runSingle(passOptions, candidate.entry, snapshot, {
            wire: plan.wire ?? wireOf(candidate.entry),
            turnModel: entry.id,
            recordTurn: false,
            allowAdvance: true,
          })
        this.deps.trace?.({ kind: 'route-dispatch', model: candidate.entry.id, channel: candidate.entry.channel ?? 'local' })
        let committed = false
        let result
        const held = []
        let settled = false
        /**
         * 收尾必须在**交出 `finish` 之前**完成。
         *
         * 宿主读到 `finish` 就认为这一轮结束，随即关闭生成器；写在循环之后的
         * `onCommit` / 回合统计再也不会执行（真机表现：明细里没有这一轮、
         * 熔断的成员永远不被清除）。
         */
        const settleCommitted = resultLike => {
          if (settled) return
          settled = true
          hooks.onCommit?.(candidate, resultLike)
          this.deps.recordTurn?.({ at: started, model: entry.id, ok: resultLike?.ok === true, recovered: resultLike?.recovered === true, attempts: index + 1, origin: 'harness' })
        }
        while (true) {
          const row = await iterator.next()
          if (row.done === true) { result = row.value; break }
          if (committed) {
            if (row.value?.type === 'finish' && !settled) {
              const kind = row.value.reason?.kind
              settleCommitted({ ok: kind !== 'error' && kind !== 'aborted', recovered: false })
            }
            yield row.value
            continue
          }
          held.push(row.value)
          if (commitsAnswer(row.value)) {
            committed = true
            for (const chunk of held) yield chunk
            held.length = 0
          }
        }
        if (committed) {
          settleCommitted(result)
          return
        }
        if (result?.advance !== true) {
          // Not a candidate fault — an abort, or a failure that arrived after the
          // single-model recovery budget was spent. Hand the caller the real
          // ending instead of pretending another model could have saved it.
          rejectedTurn(index + 1)
          for (const chunk of held) yield chunk
          return
        }
        const reason = result.verdict === null || result.verdict === undefined ? 'failed' : describeVerdict(result.verdict)
        tried.push(`${candidate.entry.id} (${reason})`)
        hooks.onAdvance?.(candidate, result, reason)
      } finally {
        release?.()
      }
    }
    rejectedTurn(candidates.length)
    yield { type: 'finish', reason: { kind: 'error', failure: {
      message: `the chain "${entry.name}" exhausted every candidate: ${tried.join('; ')}`,
      code: CODE.server,
    } } }
  }


  /**
   * 一条「不是本插件供给」的组成员：把这一轮原样交回宿主自己的 `llm.stream`。
   *
   * 分组的价值在于覆盖整个宿主的渠道，而一个 adapter 只能代发自己注册的那几个
   * provider。成员属于别的 provider 时（`channel: 'host'`），唯一不越权的做法
   * 是把它交回宿主路由：我们只负责挑人、记账、失败时换下一个。选项对象原样
   * 透传（tools / 附件 / 系统提示都是宿主自己的格式），只替换 provider/model；
   * 成员的档位翻不到目标模型认的 id 时**不传**，让它按自己的默认走。
   *
   * @returns 与 `runSingle` 同形的收尾摘要，`advance` 决定链路是否换人。
   */
  async * runForeign(options, entry, plan = {}) {
    const started = Date.now()
    const emit = this.deps.hostStream
    const provider = String(entry?.provider ?? '')
    if (typeof emit !== 'function' || provider === '') {
      yield { type: 'finish', reason: { kind: 'error', failure: {
        message: `route group member "${entry?.id ?? ''}" is served by another provider, and this host exposes no llm.stream to forward it`,
        code: CODE.server,
      } } }
      return { advance: true, verdict: null, ok: false, recovered: false }
    }
    const model = String(entry.modelId ?? entry.id ?? '')
    const request = { ...options, provider, model: model.startsWith(`${provider}/`) ? model.slice(provider.length + 1) : model }
    if (typeof plan.reasoningEffort === 'string' && plan.reasoningEffort !== '') request.reasoningEffort = plan.reasoningEffort
    else delete request.reasoningEffort
    const usage = { inputTokens: 0, outputTokens: 0 }
    let firstDeltaAt
    let failure = null
    let thrown = null
    const shapes = []
    let outcome = null
    /**
     * 记账 + 读数，**必须在交出 `finish` 之前**跑：宿主读到 finish 就关闭生成器，
     * 循环之后的代码不会执行（曾导致转发的成员永远不记明细、不留读数）。
     */
    const settle = () => {
      if (outcome !== null) return outcome
      const ok = failure === null && thrown === null
      outcome = ok
      if (thrown !== null) {
        this.deps.warn?.(`our-free-model: forwarding ${entry.id} failed — ${String(thrown?.message ?? thrown).slice(0, 200)}`)
      }
      this.deps.trace?.({ kind: 'route-forward', model: entry.id, ok, shapes: shapes.join(' ') })
      this.deps.recordUsage?.({
        at: started,
        model: entry.id,
        effort: typeof request.reasoningEffort === 'string' ? request.reasoningEffort : '',
        ok,
        input: usage.inputTokens,
        output: usage.outputTokens,
        reasoning: usage.reasoningTokens ?? 0,
        cacheRead: usage.cacheReadTokens ?? 0,
        decodeTokens: ok ? windowTokens(usage, false) : 0,
        ttftMs: firstDeltaAt === undefined ? undefined : firstDeltaAt - started,
        decodeMs: firstDeltaAt === undefined ? 0 : Date.now() - firstDeltaAt,
        origin: 'harness',
        elapsedMs: Date.now() - started,
      })
      return ok
    }
    try {
      const stream = emit(request)
      // 宿主没有 llm 服务（或版本太老）时不能假装「这个成员挂了」：
      // 换人没用，必须说清楚是转发能力缺失。
      if (stream === null || stream === undefined) {
        throw Object.assign(new Error('this host exposes no llm.stream to forward a foreign route-group member'), { code: 'NO_HOST_STREAM' })
      }
      for await (const chunk of stream) {
        if (shapes.length < 3 && chunk !== null && typeof chunk === 'object') {
          const textish = typeof chunk.text === 'string' ? chunk.text : typeof chunk.delta?.text === 'string' ? chunk.delta.text : ''
          shapes.push(`${chunk.type ?? '?'}${textish === '' ? '' : `(${textish.slice(0, 10)})`}[${Object.keys(chunk).filter(key => key !== 'type').slice(0, 5).join('+')}]`)
        }
        if (chunk?.type === 'usage') {
          for (const key of ['inputTokens', 'outputTokens']) {
            const value = Number(chunk.usage?.[key])
            if (Number.isFinite(value)) usage[key] = value
          }
          if (Number.isFinite(Number(chunk.usage?.reasoningTokens))) usage.reasoningTokens = Number(chunk.usage.reasoningTokens)
          if (Number.isFinite(Number(chunk.usage?.cacheReadTokens))) usage.cacheReadTokens = Number(chunk.usage.cacheReadTokens)
        }
        if (firstDeltaAt === undefined
          && (chunk?.type === 'text-delta' || chunk?.type === 'reasoning-delta' || chunk?.type === 'tool-call-delta')) {
          firstDeltaAt = Date.now()
        }
        if (chunk?.type === 'finish') {
          if (chunk.reason?.kind === 'error' || chunk.reason?.kind === 'aborted') failure = chunk.reason
          settle()
          yield chunk
          continue
        }
        yield chunk
      }
    } catch (error) {
      thrown = error
    }
    const ok = settle()
    if (ok) return { advance: false, verdict: null, ok: true, recovered: false }
    // 宿主没有转发能力是环境缺陷，换下一个成员也没用；但它发生在第一个 chunk
    // 之前，调用方至今没收到任何收尾，所以这里必须自己补一个。
    if (thrown?.code === 'NO_HOST_STREAM') {
      yield { type: 'finish', reason: { kind: 'error', failure: { message: String(thrown.message ?? thrown), code: CODE.server } } }
      return { advance: false, verdict: null, ok: false, recovered: false }
    }
    // 转发失败的真实原因必须留在熔断记录里：只写 "unknown/transient" 的话，
    // 面板上根本看不出是没装适配器、模型下线还是参数被拒。
    const text = String(failure?.failure?.message ?? thrown?.message ?? thrown ?? '')
    const verdict = {
      ...classifyFailure({ code: failure?.failure?.code ?? thrown?.code, message: text }),
      rule: `forward: ${text.slice(0, 120)}`,
    }
    return { advance: true, verdict, ok: false, recovered: false }
  }


  /**
   * One model's turn — the original single-lane path.
   *
   * @param {object} [plan] - `{ wire?, turnModel?, recordTurn?, allowAdvance? }`.
   *   `turnModel` re-attributes the logical turn, so a combo's link is recorded
   *   physically under its own id while the turn belongs to the chain;
   *   `recordTurn: false` leaves the turn record to the caller; `allowAdvance`
   *   makes a pre-output failure report itself as advanceable instead of ending
   *   the turn outright.
   * @returns the turn's own summary, which only a combo caller reads.
   */
  async * runSingle(options, entry, snapshot, plan = {}) {
    const settings = snapshot.settings ?? {}
    const started = Date.now()
    const turnModel = plan.turnModel ?? baseModelId(options.model)
    const recordRejectedTurn = () => {
      if (plan.recordTurn === false) return
      this.deps.recordTurn?.({
        at: started,
        model: turnModel,
        ok: false,
        recovered: false,
        attempts: 0,
        origin: 'harness',
      })
    }

    if (settings.enabled === false) {
      recordRejectedTurn()
      yield { type: 'finish', reason: { kind: 'error', failure: { message: 'our free model is switched off in its settings page', code: 'CONFIG_DISABLED' } } }
      return { advance: false, verdict: null, ok: false }
    }
    if (entry === null) {
      recordRejectedTurn()
      yield { type: 'finish', reason: { kind: 'error', failure: { message: `our free model does not serve "${options.model}" on this egress`, code: CODE.server } } }
      return { advance: false, verdict: null, ok: false }
    }

    const sealed = isEacEntry(entry)
    const kilo = isKiloEntry(entry)
    const aggregate = isAggregateEntry(entry)
    // 自有渠道（Codely / AutoClaw / Accio）：走本插件的账号表 + 各自的线上协议，
    // 由 `src/channels/inference.js` 统一把帧交成我们的解码器认识的那一种。
    const own = isOwnEntry(entry)
    // The absorbed channels speak the Chat wire regardless of what their ids
    // resemble; only the free lane splits endpoints per model, and an aggregate
    // row carries the wire its provider actually serves. An absorbed channel's
    // own row may declare its wire (MiniMax speaks Anthropic Messages).
    const wire = plan.wire ?? wireOf(entry)
    /**
     * What the **upstream** must see in `model`.
     *
     * Own and aggregate rows carry this lane's routing prefix in `id`
     * (`minimaxintl/MiniMax-M3`, `nvidia_nim/nvidia/…`); the provider only knows
     * the bare id. Sending the composite id is how every own-channel turn used to
     * fail at the far end even with a valid credential.
     */
    const wireModel = (own || aggregate) && typeof entry.modelId === 'string' && entry.modelId !== ''
      ? entry.modelId
      : entry.id
    const style = STYLE_FOR_WIRE[wire]
    const warnings = []
    const resolveImage = this.deps.resolveImage
    const messages = repairToolPairing(options.messages ?? [])
    const budget = budgetFor(options.reasoningEffort, entry, options.maxTokens, settings.defaultMaxTokens)
    const declared = toToolDefs(options.tools, style)
    const policy = recoveryPolicy(settings.streamRecovery)
    const session = sessionForConversation(options.sessionId)
    const recoveryId = mintRequestId()
    let attemptMessages = messages
    let attemptBudget = budget
    let nextIndex = 0
    let totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    const blocks = createBlockTracker()
    let turnRecorded = false
    const finishTurn = (ok, recovered = false, attempts = 1) => {
      if (turnRecorded) return
      turnRecorded = true
      if (plan.recordTurn === false) return
      this.deps.recordTurn?.({
        at: started,
        model: turnModel,
        ok,
        recovered,
        attempts,
        origin: 'harness',
      })
    }

    // One pipeline report per dispatch build, so the usage record can carry what
    // the token savers measured for the body that actually shipped.
    let attemptSavings = null

    // 一次逻辑回合的丢弃内容告警只由首个 payload 收集。检查点估算和续写段都要另建
    // 一份 payload，共用同一个数组会让 `image-dropped` 按 build 次数重复累积，还会
    // 让已经交出去的首段样本跟着后面的 build 一起变长。
    const payloadFor = (input, ceiling, recovering, sink, savingsSink) => {
      const payload = buildPayload(wire, wireModel, input, options, ceiling, resolveImage, sink)
      if (declared.length > 0) payload.tools = declared
      if (typeof options.temperature === 'number' && Number.isFinite(options.temperature)) payload.temperature = options.temperature
      if (wire !== 'responses' && Array.isArray(options.stop) && options.stop.length > 0) payload.stop = options.stop
      if (recovering) payload.tool_choice = wire === 'messages' ? { type: 'none' } : 'none'
      // Both absorbed channels carry a declared thinking menu whose level is
      // the real control on the wire: the selected level rides the request as
      // the model's own effort field (a JSON merge patch, ZCode's declaration
      // shape). The free lane keeps its token-budget behaviour untouched.
      if (sealed || kilo) {
        const patch = effortPatchFor(options.reasoningEffort, entry)
        if (patch !== null) Object.assign(payload, patch)
      }
      if (sealed) applySealedPacingHint(payload)
      // The token savers run last, after every other mutation, so the byte counts
      // they report and the fingerprint's rename map both describe the body that
      // actually ships. Applied on estimation builds too — the checkpoint size
      // gate has to measure the payload it is gating, not a fatter draft of it.
      const savings = applyTokenSavers(payload, wire, saverConfig(settings))
      if (savingsSink !== undefined) savingsSink.report = savings
      return payload
    }

    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (options.signal?.aborted === true) {
        finishTurn(false, false, attempt)
        if (attempt > 0) yield { type: 'usage', usage: totalUsage }
        yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: CODE.aborted } } }
        return { advance: false, verdict: null, ok: false }
      }
      const attemptStarted = Date.now()
      const recovering = attempt === 1
      const savingsSink = {}
      const payload = payloadFor(attemptMessages, attemptBudget, recovering, recovering ? [] : warnings, savingsSink)
      attemptSavings = savingsSink.report ?? null
      // The absorbed channels have no tool-name gate; their models see the
      // caller's tools exactly as declared, so the fingerprint pass is free-lane
      // only. The aggregate lane is somebody else's gateway entirely — renaming
      // its tools to this lane's decoy quartet would break the caller's calls.
      const renameMap = sealed || kilo || aggregate || own ? new Map() : applyFingerprint(payload, wire === 'messages' ? 'claude' : style === 'flat')
      const controller = new AbortController()
      const onAbort = () => controller.abort(options.signal?.reason)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      const remainingMs = Math.max(1, policy.totalTimeoutMs - (attemptStarted - started))
      let expired = false
      const timeoutMs = recovering ? Math.min(policy.maxContinuationMs, remainingMs) : remainingMs
      const timer = policy.enabled ? setTimeout(() => {
        expired = true
        controller.abort()
      }, timeoutMs) : undefined
      timer?.unref?.()
      const channel = createChannel()
      // 自有渠道的凭据要先取（异步），故在构造请求之前解析一次；取不到就是
      // null，`postOwnChannelStreamed` 会把它判成 CODE.auth 而不是「未知错误」。
      const ownCredential = own && typeof this.deps.ownCredential === 'function'
        ? await this.deps.ownCredential(entry.provider)
        : null
      const request = (sealed
        ? postSealedTurn(this.deps, payload, controller.signal, value => channel.push(value))
        : own
          ? postOwnChannelStreamed({
            provider: entry.provider,
            credential: ownCredential,
            body: payload,
            signal: controller.signal,
            onData: value => channel.push(value),
          })
          : kilo
            ? postKiloStreamed({ body: payload, signal: controller.signal, onData: value => channel.push(value) })
            : aggregate
              ? postAggregateStreamed({
                config: settings.aggregate ?? {},
                providerId: entry.providerId,
                modelId: entry.modelId,
                body: payload,
                signal: controller.signal,
                onData: value => channel.push(value),
              })
              : postStreamed({
                path: endpointFor(entry.id), body: payload, session,
                requestId: attempt === 0 ? recoveryId : mintRequestId(),
                attributionUserAgent: snapshot.attributionUserAgent,
                signal: controller.signal,
                onData: value => channel.push(value),
              }))
        .then(() => channel.push(undefined))
        .catch(error => channel.push(error instanceof Error ? error : new Error(String(error))))
      let firstDeltaAt
      let delivered = false
      let sawAnswer = false
      let recorded = false
      let continuationScheduled = false
      let partialOutcome
      let usageAdded = false
      const record = (ok, outcome, extra = {}) => {
        if (recorded) return
        recorded = true
        const usage = outcome?.sawUsage === true ? outcome.usage : undefined
        this.deps.recordUsage({
          at: attemptStarted,
          model: entry.id,
          effort: resolveLevel(options.reasoningEffort, entry)?.id ?? '',
          ok,
          input: usage?.inputTokens ?? 0,
          output: usage?.outputTokens ?? 0,
          reasoning: usage?.reasoningTokens ?? 0,
          cacheRead: usage?.cacheReadTokens ?? 0,
          decodeTokens: ok ? windowTokens(usage, outcome?.sawReasoning === true) : 0,
          ttftMs: firstDeltaAt === undefined ? undefined : firstDeltaAt - attemptStarted,
          decodeMs: firstDeltaAt === undefined ? 0 : Date.now() - firstDeltaAt,
          origin: 'harness',
          recoveryId,
          attempt,
          elapsedMs: Date.now() - attemptStarted,
          ...recovering ? { recoveryAttempt: true } : {},
          ...outcome?.sawUsage === true ? {} : { noUsage: true },
          ...warnings.length === 0 ? {} : { warnings },
          ...savingsFields(attemptSavings),
          ...extra,
        })
      }
      /**
       * Whether another model could answer this failure.
       *
       * Three things veto it, and each one is a different kind of "no": the
       * caller did not ask for a chain, the caller walked away, or this model
       * already put an *answer* on the wire — a switch after that point would
       * splice two models' prose together in front of the user.
       *
       * The veto reads `sawAnswer`, not `delivered`, on purpose. `delivered`
       * also covers reasoning deltas, but a combo holds those in its own
       * buffer and drops them whole when it advances — the user never saw
       * them, so they must not pin the chain to a model that hit a quota wall
       * after a minute of thinking ("thought for a minute, then hit the wall"
       * is the single most valuable case to fail over). Answer-bearing output
       * — visible text or a streamed tool call — is what `commitsAnswer`
       * commits on, and once committed the combo ignores `advance` anyway, so
       * this predicate and the commit rule stay two views of one definition.
       */
      const advanceVerdict = (code, message, status) => {
        if (plan.allowAdvance !== true || options.signal?.aborted === true || sawAnswer) return { advance: false, verdict: null }
        const verdict = classifyFailure({ status, code, message })
        return { advance: shouldAdvance(verdict), verdict }
      }
      try {
        const reader = readStream(channel.read(), wire, renameMap, () => Date.now(), {
          startIndex: nextIndex, checkpointLimit: policy.checkpointLimit,
          onState: value => { partialOutcome = value },
        })
        let outcome
        try {
          while (true) {
            const row = await reader.next()
            if (row.done) { outcome = row.value; break }
            if (options.signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
            const chunk = row.value
            if (chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text.trim() !== '') sawAnswer = true
            // 续写禁用工具；网关不遵守时也不把工具块交给宿主执行。
            if (recovering && (chunk.blockType === 'tool-call' || chunk.type === 'tool-call-delta' || chunk.block?.type === 'tool-call')) {
              throw new UpstreamError('our free model continuation unexpectedly requested a tool', 'STREAM_CUT')
            }
            if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta' || chunk.type === 'tool-call-delta') {
              delivered = true
              if (firstDeltaAt === undefined) firstDeltaAt = Date.now()
            }
            blocks.accept(chunk)
            yield chunk
          }
        } finally {
          await reader.return()
        }
        nextIndex = outcome.nextIndex
        totalUsage = addUsage(totalUsage, outcome.usage, outcome.sawUsage)
        usageAdded = true
        if (options.signal?.aborted === true) {
          record(false, outcome, { aborted: true })
          finishTurn(false, false, attempt + 1)
          yield { type: 'usage', usage: totalUsage }
          yield { type: 'finish', reason: { kind: 'aborted', failure: { message: 'request aborted', code: CODE.aborted } } }
          return { advance: false, verdict: null, ok: false }
        }
        const reason = outcome.brokenToolCall === true ? { kind: 'max-tokens' } : finishReason(outcome.finish)
        // finishReason 是兜底映射，failed/cancelled 也会落成 stop：正常收尾的判定必须显式查原 token。
        const elapsed = Date.now() - started
        const interrupted = canRecover(outcome, policy, elapsed)
        // 正文撞输出上限被截断（finish=length）：把已出正文回灌成 assistant 轮、
        // 用剩余预算自动续写一次，替代宿主提示的「发送继续」手动接力（#28）。
        // 只在首段触发（recovering 段自己也撞墙就如实报 max-tokens，不无限续），
        // 且不与断流/空停续写共用 attempt 名额以外的路径。
        const maxTokensCut = policy.enabled && !recovering && reason.kind === 'max-tokens' && outcome.brokenToolCall !== true
          && outcome.sawText === true && outcome.sawToolCall !== true
          && typeof outcome.answerText === 'string' && outcome.answerText.trim() !== ''
        const silentStop = !interrupted && !maxTokensCut && reason.kind === 'stop'
          // 无 token 的正常收尾（message_stop / response.done 不带 status）也算停收；failed、length 这类有 token 的收尾仍被挡在外面。
          && (outcome.finish === undefined || ['stop', 'end_turn', 'stop_sequence'].includes(outcome.finish))
          && canRecoverSilentStop(outcome, policy, elapsed)
        if (!recovering && (interrupted || silentStop || maxTokensCut)) {
          const remainingTokens = budget - (outcome.sawUsage ? outcome.usage.outputTokens ?? 0 : 0)
          const continuationBudget = Math.min(remainingTokens, policy.maxOutputTokens)
          const nextMessages = maxTokensCut
            ? continuationMessages(messages, outcome.answerText)
            : recoveryMessages(messages, outcome.reasoningText)
          if (continuationBudget >= MIN_BUDGET
            && checkpointFits(payloadFor(nextMessages, continuationBudget, true, []), entry, maxTokensCut ? outcome.answerText : outcome.reasoningText, continuationBudget)) {
            record(false, outcome, { truncated: true, recoveryScheduled: true })
            this.deps.warn?.(maxTokensCut
              ? 'our-free-model: the answer hit the output token ceiling; continuing once from where it stopped'
              : silentStop
                ? 'our-free-model: a stopped turn held only its reasoning; continuing once from its checkpoint'
                : 'our-free-model: interrupted reasoning; continuing once from its checkpoint')
            attemptMessages = nextMessages
            attemptBudget = continuationBudget
            continuationScheduled = true
            continue
          }
        }
        const failedEnding = outcome.finish === 'failed' || outcome.finish === 'cancelled'
        const normalEnding = outcome.finish === undefined || ['stop', 'end_turn', 'stop_sequence'].includes(outcome.finish)
        if (outcome.sawFinish !== true || failedEnding || (recovering && (!sawAnswer
          || outcome.sawToolCall === true || reason.kind !== 'stop' || !normalEnding))) {
          const seconds = Math.round((Date.now() - started) / 1000)
          const code = recovering || delivered || outcome.sawToolCall === true ? 'STREAM_CUT'
            : failedEnding ? CODE.server : CODE.transport
          const message = recovering
            ? `our free model continuation ended without a complete answer after ${seconds}s; automatic recovery exhausted`
            : failedEnding ? `our free model upstream response ended with status ${outcome.finish}`
            : delivered || outcome.sawToolCall === true
              ? `our free model closed the stream after ${seconds}s, before its finish token; automatic recovery was not safe`
              : 'our free model closed the stream before its finish token, without answering; retrying'
          record(false, outcome, { truncated: true })
          finishTurn(false, false, attempt + 1)
          yield { type: 'usage', usage: totalUsage }
          yield { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
          return { ok: false, ...advanceVerdict(code, message, undefined) }
        }
        if (outcome.sawText !== true && outcome.sawToolCall !== true && outcome.sawReasoning !== true && reason.kind === 'stop') {
          record(false, outcome)
          finishTurn(false, false, attempt + 1)
          yield { type: 'usage', usage: totalUsage }
          yield { type: 'finish', reason: { kind: 'error', failure: { message: 'our free model returned an empty response', code: CODE.empty } } }
          return { ok: false, ...advanceVerdict(CODE.empty, 'empty response') }
        }
        record(true, outcome, recovering ? { recovered: reason.kind === 'stop' } : {})
        finishTurn(true, recovering && reason.kind === 'stop', attempt + 1)
        yield { type: 'usage', usage: totalUsage }
        yield { type: 'finish', reason }
        if (warnings.length > 0) this.deps.warn?.(`our-free-model: dropped unsupported content for ${entry.id}: ${warnings.join(', ')}`)
        return { advance: false, verdict: null, ok: true, recovered: recovering && reason.kind === 'stop' }
      } catch (error) {
        if (error?.code === CODE.region) this.deps.onRegionBlocked?.(entry.id)
        const aborted = options.signal?.aborted === true
        let failure = toFailure(error)
        if (!aborted && (recovering || expired)) {
          failure = { ...failure, code: recovering || delivered || partialOutcome?.sawToolCall === true ? 'STREAM_CUT' : CODE.timeout,
            message: expired
              ? `our free model reached its ${Math.round(timeoutMs / 1000)}s time limit before its finish token${recovering ? ', during the continuation from its checkpoint' : ''}`
              : `our free model continuation failed: ${failure.message}` }
        }
        if (!usageAdded) totalUsage = addUsage(totalUsage, partialOutcome?.usage, partialOutcome?.sawUsage)
        record(false, partialOutcome, { ...(recovering || expired) ? { truncated: true } : {}, ...aborted ? { aborted: true } : {} })
        finishTurn(false, false, attempt + 1)
        for (const chunk of blocks.close()) yield chunk
        if (recovering || partialOutcome?.sawUsage === true) yield { type: 'usage', usage: totalUsage }
        yield { type: 'finish', reason: { kind: aborted ? 'aborted' : 'error', failure } }
        return {
          ok: false,
          ...aborted
            ? { advance: false, verdict: null }
            : advanceVerdict(failure.code, failure.message, failure.status),
        }
      } finally {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        controller.abort()
        await request
        if (!recorded) record(false, partialOutcome, { aborted: true })
        if (!continuationScheduled && !turnRecorded) finishTurn(false, false, attempt + 1)
      }
    }
  }
}

/** The co-paid reasoning models can burn minutes in the thinking channel on
 * turns that need seconds (observed: an entire small token budget spent on
 * reasoning for a one-line answer, first visible byte minutes late). The
 * effort menu owns the hard depth; this one-line prompt asks for pacing so a
 * turn does not sit silent while the model over-explores. Applied on every
 * sealed build, so the continuation and recovery payloads carry it too. */
const SEALED_PACING_HINT =
  'Avoid overthinking: keep your reasoning brief and proportionate to the task.'

function applySealedPacingHint(payload) {
  if (Array.isArray(payload.messages)) {
    const system = payload.messages.find(message => message?.role === 'system' && typeof message.content === 'string')
    if (system !== undefined) {
      system.content = system.content === '' ? SEALED_PACING_HINT : `${system.content}\n\n${SEALED_PACING_HINT}`
      return
    }
    payload.messages.unshift({ role: 'system', content: SEALED_PACING_HINT })
    return
  }
  if (typeof payload.system === 'string') {
    payload.system = payload.system === '' ? SEALED_PACING_HINT : `${payload.system}\n\n${SEALED_PACING_HINT}`
  }
}

/**
 * One co-paid-lane turn: unlock the sealed credential for this request frame
 * and hand it straight to the lane's poster. A host the gate refuses — or a
 * seal that does not open — is a non-retryable configuration state, not a
 * transport fault: `LANE_LOCKED` is deliberately outside the retryable set so
 * a locked host fails its turn once, with a plain message and no retry storm.
 */
async function postSealedTurn(deps, payload, signal, onData) {
  const credential = await Promise.resolve(deps.sealedCredential?.())
  if (credential === null || credential === undefined) throw new UpstreamError('this model lane is not available on this host', 'LANE_LOCKED')
  return postSealedStreamed({ credential, body: payload, signal, onData })
}

function buildPayload(wire, modelId, messages, options, budget, resolveImage, warnings) {
  if (wire === 'responses') {
    const input = toResponseInput(messages, resolveImage, warnings)
    return {
      model: modelId,
      input: input.length > 0 ? input : [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: '...' }] }],
      stream: true,
      store: false,
      max_output_tokens: budget,
    }
  }
  if (wire === 'messages') {
    const shaped = toClaudeMessages(messages, resolveImage, warnings)
    return {
      model: modelId,
      messages: shaped.messages,
      stream: true,
      max_tokens: budget,
      ...shaped.system === undefined ? {} : { system: shaped.system },
    }
  }
  const chat = toChatMessages(messages, resolveImage, warnings)
  return {
    model: modelId,
    messages: typeof options.system === 'string' && options.system !== ''
      ? [{ role: 'system', content: options.system }, ...chat]
      : chat,
    stream: true,
    max_tokens: budget,
  }
}

/**
 * Shape one thrown error into the harness's `LlmFailure` vocabulary.
 *
 * The harness writes this object straight into a durable session event, and that
 * log rejects anything that does not survive a lossless JSON round trip — an
 * Error instance, a `NaN`, an explicit `undefined` field. A rejected append
 * aborts the whole turn, so a malformed failure is strictly worse than a sparse
 * one: only the whitelisted fields are carried, each validated, and each dropped
 * rather than emitted in a degraded form.
 */
function toFailure(error) {
  const message = typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : String(error ?? 'our free model request failed')
  const code = typeof error?.code === 'string' && error.code.length > 0 ? error.code : CODE.transport
  const status = error?.status
  const retryAfter = error?.providerRetryAfterMs
  return {
    message,
    code,
    ...Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {},
    ...Number.isFinite(retryAfter) && retryAfter > 0 ? { providerRetryAfterMs: Math.trunc(retryAfter) } : {},
  }
}

/**
 * Which wire serves one catalog row.
 *
 * The absorbed channels speak the Chat wire regardless of what their ids
 * resemble; an aggregate row carries the wire its provider actually serves; the
 * free lane splits its endpoints per model id.
 */
function wireOf(entry) {
  if (isAggregateEntry(entry)) return entry.wire ?? 'chat'
  if (isOwnEntry(entry)) return entry.wire ?? 'chat'
  if (isEacEntry(entry) || isKiloEntry(entry)) return 'chat'
  return wireFor(entry.id)
}

/**
 * Does this chunk carry an answer the caller would have to un-see?
 *
 * A combo may only abandon a candidate while the answer is still entirely
 * inside its own buffer. Reasoning deltas are excluded on purpose: thinking is
 * not the answer, and "thought for a minute, then hit a quota wall" is the
 * most valuable failure to fail over — the held thinking is dropped with the
 * rest of the discarded attempt, so the caller never learns it happened. A
 * `block-end` for a reasoning block is the tail of that same reasoning stream
 * (`closeAll` emits it when the SSE loop ends), so it does not commit either;
 * letting it commit would pin the chain one chunk before the failure it
 * exists to survive. Text commits only when it carries visible content, the
 * same bar `sawAnswer` uses, so whitespace noise cannot pin a chain either.
 */
function commitsAnswer(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text.trim() !== ''
  if (chunk.type === 'tool-call-delta') return true
  if (chunk.type !== 'block-end') return false
  if (chunk.block?.type === 'reasoning') return false
  if (chunk.block?.type === 'text') return typeof chunk.block.text === 'string' && chunk.block.text.trim() !== ''
  return true
}

/** What the token savers measured for one dispatched body, as usage-record fields. */
function savingsFields(report) {
  if (report === null || report === undefined) return {}
  const saved = Number(report.saved) || 0
  const promptInjected = report.prompt?.injected === true
  if (saved === 0 && promptInjected !== true) return {}
  return {
    savings: {
      saved,
      bytesBefore: Number(report.bytesBefore) || 0,
      // Carried alongside the other two, not derived from them later: the panel
      // shows "before → after", and an after of 0 beside a before of 2599 reads
      // as "the body became empty" rather than "this field was never recorded".
      bytesAfter: Number(report.bytesAfter) || 0,
      blocks: Array.isArray(report.rtk?.hits) ? report.rtk.hits.length : 0,
      ...promptInjected ? { prompt: report.prompt.families ?? [] } : {},
    },
  }
}

/**
 * The `/model` popup's detail line. The composer renders only the model name, so
 * the capacities that matter for choosing a model — modality, window, whether an
 * effort menu exists — have to fit here.
 *
 * A model that cannot switch its thinking off names the shared ceiling outright:
 * on that lane the rung is not only the answer's budget, and a picker that
 * implied otherwise is how "why is it cut off at 8K when my ceiling is 32K" gets
 * asked.
 */
function describe(entry, settings) {
  const parts = [entry.vision ? 'vision + text input' : 'text input', `${Math.round(entry.contextWindow / 1024)}K context`]
  // A chain's own detail line: which models it will try, in order. Without it a
  // combo in the picker looks like one more model with no endpoint behind it.
  if (isComboEntry(entry)) {
    parts.push(`${entry.combo.length}-model chain: ${entry.combo.join(' -> ')}`)
    if (entry.strategy === 'round-robin') parts.push('rotating start')
    return parts.join(' · ')
  }
  // 分组也是一个虚拟模型：行里说清"几条成员"，具体优先级在面板里看。
  if (isRouteEntry(entry)) {
    parts.push(`${entry.groupMembers}-model route group`)
    return parts.join(' · ')
  }
  if (entry.reasoning === true) {
    // A declared menu is the model's own level list on the wire — naming the
    // levels is the honest detail line; "budget" would describe the free lane's
    // ladder, which is exactly what a menu model does not use.
    if (Array.isArray(entry.efforts) && entry.efforts.length > 0) {
      parts.push(`thinking levels: ${entry.efforts.join(' / ')}`)
    } else {
      const rung = Math.round(budgetFor(DEFAULT_LEVEL, entry, undefined, settings?.defaultMaxTokens) / 1024)
      parts.push(entry.canDisableThinking === false
        ? `thinking always on · ${rung}K default ceiling, shared with the answer`
        : 'tunable thinking budget')
    }
  }
  return parts.join(' · ')
}
