/**
 * 浏览器驱动的离线测试 —— **不真起浏览器**。
 *
 * 钉住的是判据（真起 Chromium 的那一段只能在真机验收里测）：
 * 1. `DevToolsActivePort` 的解析（端口 + 浏览器级路径，形状不对返回 undefined）；
 * 2. 候选路径优先级（`OFM_CHROMIUM` 永远第一）与存在性筛选；
 * 3. 启动参数：临时 profile + `--remote-debugging-port=0`（端口由浏览器分配）；
 * 4. CDP 连接：请求/响应按 id 配对、事件分发、超时拒绝、关闭时挂起请求被拒；
 * 5. 回调拦截：**命中 → fulfillRequest（请求不出网）+ 交出 URL**，
 *    未命中 → continueRequest 放行。
 */

import assert from 'node:assert/strict'
import {
  CdpConnection,
  browserCandidates,
  buildLaunchArgs,
  findBrowserExecutable,
  interceptCallback,
  parseDevToolsActivePort,
} from '../src/channels/browser/chromium.js'

/* ── 1. DevToolsActivePort ──────────────────────────────────────────────── */

{
  assert.deepEqual(parseDevToolsActivePort('9222\n/devtools/browser/abc-123\n'), { port: 9222, browserPath: '/devtools/browser/abc-123' })
  // 端口 0 不是可连接的端口 —— 必须判形状不对，别让调用方去连 0
  assert.equal(parseDevToolsActivePort('0\r\n/devtools/browser/x'), undefined)
  assert.equal(parseDevToolsActivePort('9222'), undefined, '缺第二行')
  assert.equal(parseDevToolsActivePort('abc\n/devtools/browser/x'), undefined)
  assert.equal(parseDevToolsActivePort('9222\nnope'), undefined)
  assert.equal(parseDevToolsActivePort(''), undefined)
  console.log('ok 1/5 DevToolsActivePort')
}

/* ── 2. 候选与查找 ──────────────────────────────────────────────────────── */

{
  const env = { OFM_CHROMIUM: 'D:/portable/chrome.exe', PROGRAMFILES: 'C:/PF', LOCALAPPDATA: 'C:/LA' }
  const candidates = browserCandidates(env, 'win32')
  assert.equal(candidates[0], 'D:/portable/chrome.exe', 'OFM_CHROMIUM 必须第一')
  assert.ok(candidates.some(path => path.endsWith('chrome.exe')))
  assert.ok(candidates.some(path => path.endsWith('msedge.exe')))

  // 只有第二个候选存在 → 返回它
  const found = findBrowserExecutable({ env: {}, platform: 'linux', exists: file => file === '/usr/bin/chromium' })
  assert.equal(found, '/usr/bin/chromium')
  assert.equal(findBrowserExecutable({ env: {}, platform: 'linux', exists: () => false }), undefined)
  console.log('ok 2/5 候选与查找')
}

/* ── 3. 启动参数 ────────────────────────────────────────────────────────── */

{
  const args = buildLaunchArgs({ userDataDir: 'C:/tmp/ofm', url: 'https://example.test/login' })
  assert.ok(args.includes('--user-data-dir=C:/tmp/ofm'))
  assert.ok(args.includes('--remote-debugging-port=0'), '端口必须交给浏览器分配（0）')
  assert.ok(args.includes('--no-first-run'))
  assert.equal(args[args.length - 1], 'https://example.test/login')
  console.log('ok 3/5 启动参数')
}

/* ── 4. CDP 连接 ────────────────────────────────────────────────────────── */

/** 一条假的 WebSocket：记录发出的帧，用 `emit` 喂回响应/事件。 */
class FakeWebSocket {
  static last
  constructor(url) {
    this.url = url
    this.sent = []
    this.listeners = new Map()
    FakeWebSocket.last = this
    queueMicrotask(() => this.#fire('open', {}))
  }
  addEventListener(name, fn) {
    const list = this.listeners.get(name) ?? []
    list.push(fn)
    this.listeners.set(name, list)
  }
  send(text) { this.sent.push(JSON.parse(text)) }
  close() { this.#fire('close', {}) }
  emit(payload) { this.#fire('message', { data: JSON.stringify(payload) }) }
  #fire(name, event) { for (const fn of this.listeners.get(name) ?? []) fn(event) }
}

{
  const cdp = new CdpConnection('ws://127.0.0.1:9222/devtools/browser/x', { WebSocketImpl: FakeWebSocket })
  await cdp.ready
  const socket = FakeWebSocket.last
  assert.equal(socket.url, 'ws://127.0.0.1:9222/devtools/browser/x')

  const pending = cdp.send('Target.createTarget', { url: 'about:blank' }, { sessionId: 'S1' })
  const sent = socket.sent.at(-1)
  assert.equal(sent.method, 'Target.createTarget')
  assert.equal(sent.sessionId, 'S1', 'flatten 会话的 sessionId 必须随消息走')
  socket.emit({ id: sent.id, result: { targetId: 'T1' } })
  assert.deepEqual(await pending, { targetId: 'T1' })

  // 事件分发
  const seen = []
  const off = cdp.onEvent(event => seen.push(event.method))
  socket.emit({ method: 'Page.loadEventFired', params: {} })
  assert.deepEqual(seen, ['Page.loadEventFired'])
  off()

  // 错误响应 → reject
  const failing = cdp.send('Page.navigate', {})
  socket.emit({ id: socket.sent.at(-1).id, error: { message: 'nope' } })
  await assert.rejects(() => failing, /Page\.navigate: nope/)

  // 超时
  const slow = cdp.send('Page.captureScreenshot', {}, { timeoutMs: 20 })
  await assert.rejects(() => slow, /超时/)

  // 关闭：挂起的请求全部被拒
  const hanging = cdp.send('Runtime.evaluate', {})
  socket.close()
  await assert.rejects(() => hanging, /已关闭/)
  await assert.rejects(() => cdp.send('Page.enable', {}), /已关闭/)
  console.log('ok 4/5 CDP 连接')
}

/* ── 5. 回调拦截 ────────────────────────────────────────────────────────── */

{
  /** 假 cdp：只记录 send，手动触发事件。 */
  const makeFake = () => {
    const listeners = new Set()
    const calls = []
    return {
      calls,
      send(method, params) { calls.push({ method, params }); return Promise.resolve({}) },
      onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      fire(event) { for (const listener of [...listeners]) listener(event) },
    }
  }

  const cdp = makeFake()
  const session = { cdp, sessionId: 'S1' }
  const { promise } = interceptCallback(session, url => url.includes('marvis_oauth') && url.includes('code='), { timeoutMs: 500 })

  // 未命中：放行（continueRequest），且不 resolve
  cdp.fire({ method: 'Fetch.requestPaused', sessionId: 'S1', params: { requestId: 'R1', request: { url: 'https://graph.qq.com/oauth2.0/authorize?x=1' } } })
  assert.equal(cdp.calls.at(-1).method, 'Fetch.continueRequest')
  assert.equal(cdp.calls.at(-1).params.requestId, 'R1')

  // 别的会话的事件不处理
  cdp.fire({ method: 'Fetch.requestPaused', sessionId: 'OTHER', params: { requestId: 'R2', request: { url: 'https://x/?code=1' } } })
  assert.equal(cdp.calls.length, 1, '非本 session 的事件不该驱动拦截')

  // 命中：fulfillRequest（请求不出网）+ 交出 URL
  const target = 'https://yybadaccess.3g.qq.com/marvis_client_login/marvis_oauth?login_type=QC&code=abc'
  cdp.fire({ method: 'Fetch.requestPaused', sessionId: 'S1', params: { requestId: 'R3', request: { url: target } } })
  const fulfilled = cdp.calls.at(-1)
  assert.equal(fulfilled.method, 'Fetch.fulfillRequest')
  assert.equal(fulfilled.params.responseCode, 200)
  assert.ok(typeof fulfilled.params.body === 'string' && fulfilled.params.body.length > 0)
  assert.equal(await promise, target)

  // 超时：resolve(undefined)，**不 reject**（用户没登完是正常路径）
  const cdp2 = makeFake()
  const timed = interceptCallback({ cdp: cdp2, sessionId: 'S1' }, () => false, { timeoutMs: 20 })
  assert.equal(await timed.promise, undefined)
  console.log('ok 5/5 回调拦截')
}

console.log('chromium driver OK: 5 组断言全部通过')
