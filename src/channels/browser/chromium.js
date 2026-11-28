/**
 * 极简 Chromium 会话：起一个临时 profile 的浏览器，用 CDP 拦一次回调。
 *
 * ## 为什么需要它
 *
 * 有三家渠道（Marvis、超级麦吉、MonkeyCode、豆包、百智云）的登录**不能**用
 * 「开个链接等用户点完」那条腿：
 *
 * - Marvis 的回调地址是**一次性 code 兑换入口**，浏览器真发出去就把 code 消费掉，
 *   而它又要求自定义头 `Ual-Access-Guid`（浏览器顶层导航带不了）⇒ 必须在
 *   `Fetch.requestPaused` 阶段把请求**拦在发出之前**；
 * - 超级麦吉 / 豆包的凭据在网页 localStorage 里，只能读页面；
 * - 百智云的目录/签到要页面会话里的签名函数。
 *
 * 本模块只做这四件事：找浏览器、起进程、连 CDP、拦请求/求值。**不碰任何渠道
 * 业务** —— 渠道协议在各自的模块里，这里保持可单测。
 *
 * ## 为什么不用 npm 依赖
 *
 * Node 22+ 自带全局 `WebSocket`（undici），CDP 就是一条 WebSocket 上的 JSON-RPC，
 * 手写 60 行比引一个 puppeteer 便宜得多，也不会和宿主 Electron 的版本打架。
 *
 * ## 进程收尾
 *
 * Windows 上 `child.kill()` 只杀父进程，Chromium 的渲染进程会留在后台（用户会
 * 看到一堆孤儿进程）。必须 `taskkill /PID <pid> /T /F`。Linux/mac 用进程组。
 *
 * @module src/channels/browser/chromium.js
 */

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 起浏览器的最长等待（毫秒）：冷启动 + 首次解压 profile 会慢。 */
const LAUNCH_TIMEOUT_MS = 20_000
/** 单次 CDP 调用的超时（毫秒）。 */
const CDP_TIMEOUT_MS = 15_000

/**
 * 解析 `DevToolsActivePort`。
 *
 * 文件两行：端口、浏览器级 WebSocket 路径（如 `/devtools/browser/xxxx`）。
 * 形状不对返回 `undefined`（调用方继续等）。
 */
export function parseDevToolsActivePort(text) {
  const lines = String(text ?? '').split(/\r?\n/).map(line => line.trim())
  const port = Number(lines[0] ?? '')
  const browserPath = lines[1] ?? ''
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined
  if (browserPath === '' || !browserPath.startsWith('/')) return undefined
  return { port, browserPath }
}

/**
 * 候选浏览器路径（按优先级）。
 *
 * 环境变量 `OFM_CHROMIUM` 永远第一：用户的便携版 / 非标准安装目录只在那里能配。
 * 只列**Chromium 系**（Chrome / Edge / Chromium / Brave）——Firefox 没有 CDP。
 */
export function browserCandidates(env = process.env, platform = process.platform) {
  const out = []
  const override = typeof env.OFM_CHROMIUM === 'string' ? env.OFM_CHROMIUM.trim() : ''
  if (override !== '') out.push(override)
  if (platform === 'win32') {
    const roots = [env['PROGRAMFILES'], env['PROGRAMFILES(X86)'], env['LOCALAPPDATA']].filter(Boolean)
    const relative = [
      ['Google', 'Chrome', 'Application', 'chrome.exe'],
      ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
      ['Chromium', 'Application', 'chrome.exe'],
      ['BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'],
    ]
    for (const root of roots) for (const parts of relative) out.push(path.join(root, ...parts))
    out.push('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')
    out.push('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
  } else if (platform === 'darwin') {
    out.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    )
  } else {
    out.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge')
  }
  return out
}

/** 第一个真实存在的候选；都不在返回 `undefined`。 */
export function findBrowserExecutable({ env = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  for (const candidate of browserCandidates(env, platform)) {
    try { if (exists(candidate)) return candidate } catch { /* 不可读就当没有 */ }
  }
  return undefined
}

/**
 * 起浏览器用的参数（临时 profile + 关掉一切「第一次运行」噪音）。
 *
 * `headless` 只给**不需要用户看**的会话用（豆包签到的签名环境：起一次只为在页面里
 * 算一枚 `a_bogus`）。登录要用户扫码/填号，必须带窗口 —— 别给登录流程开无头。
 */
export function buildLaunchArgs({ userDataDir, url = 'about:blank', headless = false }) {
  return [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    ...headless ? ['--headless=new'] : [],
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-extensions',
    '--disable-features=Translate,MediaRouter',
    '--window-size=1000,760',
    url,
  ]
}

const sleep = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref?.() })

/**
 * 一个 CDP 连接（JSON-RPC over WebSocket）。
 *
 * `flatten: true` 的会话把子目标的事件也发到同一条连接上，`sessionId` 随消息走。
 */
export class CdpConnection {
  /**
   * @param {string} url - `ws://127.0.0.1:<port>/devtools/browser/<id>`
   * @param {{WebSocketImpl?: typeof WebSocket, timeoutMs?: number}} [options]
   */
  constructor(url, { WebSocketImpl = globalThis.WebSocket, timeoutMs = CDP_TIMEOUT_MS } = {}) {
    if (typeof WebSocketImpl !== 'function') throw new Error('当前 Node 没有全局 WebSocket（需要 22+）')
    this.url = url
    this.timeoutMs = timeoutMs
    this.nextId = 1
    this.pending = new Map()
    this.listeners = new Set()
    this.closed = false
    this.socket = new WebSocketImpl(url)
    this.socket.addEventListener('message', event => this.#onMessage(event))
    this.socket.addEventListener('close', () => this.#onClose())
    this.socket.addEventListener('error', () => this.#onClose())
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), timeoutMs)
      timer.unref?.()
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve() })
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')) })
    })
  }

  #onMessage(event) {
    let payload
    try { payload = JSON.parse(String(event.data)) } catch { return }
    if (payload.id !== undefined) {
      const waiter = this.pending.get(payload.id)
      if (waiter === undefined) return
      this.pending.delete(payload.id)
      clearTimeout(waiter.timer)
      if (payload.error !== undefined) waiter.reject(new Error(`${waiter.method}: ${payload.error.message ?? 'CDP 错误'}`))
      else waiter.resolve(payload.result)
      return
    }
    for (const listener of this.listeners) {
      try { listener(payload) } catch { /* 监听器异常不影响连接 */ }
    }
  }

  #onClose() {
    this.closed = true
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('CDP 连接已关闭'))
      this.pending.delete(id)
    }
  }

  /** 发一条 CDP 命令。 */
  send(method, params = {}, { sessionId, timeoutMs = this.timeoutMs } = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'))
    const id = this.nextId++
    const message = { id, method, params, ...sessionId === undefined ? {} : { sessionId } }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} 超时`))
      }, timeoutMs)
      // ⚠️ **不 unref**：一条挂起的 CDP 请求必须让进程活着等它超时。
      // unref 掉之后，若事件循环里没有别的句柄（浏览器已退出等），进程会直接
      // 带着「未结算的 await」退出 —— 症状是「脚本没报错也没输出」。
      this.pending.set(id, { resolve, reject, timer, method })
      try { this.socket.send(JSON.stringify(message)) } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /** 订阅所有事件（含子目标会话的）。 */
  onEvent(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 等一个满足条件的事件。 */
  waitForEvent(predicate, { timeoutMs = this.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('等待 CDP 事件超时')) }, timeoutMs)
      // 同上：等待本身就要撑住宿主的等待语义。
      const off = this.onEvent(event => {
        if (!predicate(event)) return
        clearTimeout(timer)
        off()
        resolve(event)
      })
    })
  }

  close() {
    this.closed = true
    try { this.socket.close() } catch { /* 已关 */ }
    this.#onClose()
  }
}

/** 收掉整棵进程树（Windows 必须 taskkill /T）。 */
function killTree(pid) {
  if (typeof pid !== 'number' || pid <= 0) return
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
    } else {
      process.kill(-pid, 'SIGKILL')
    }
  } catch { /* 进程已经没了 */ }
}

/**
 * 起一个会话（浏览器 + CDP）。
 *
 * ⚠️ `intercept` 决定要不要启用 `Fetch` 域，**默认不启用**：一旦 `Fetch.enable`
 * 覆盖 `*`，页面发出的**每一个**请求都会停在 `requestPaused` 等客户端放行 ——
 * 没人放行的会话就是一个白屏窗口。只有真的要拦回调（Marvis / OfficeAce）才开它；
 * 其余「网页登录」（豆包扫码、超级麦吉、MonkeyCode、百智云）必须让页面正常加载。
 *
 * @param {object} options
 * @param {string} options.url - 打开的第一个页面（授权页）
 * @param {string} [options.executable]
 * @param {string} [options.userDataDir] - 缺省用系统临时目录下的随机目录（不污染用户 profile）
 * @param {boolean} [options.headless] - 无头（只为在页面里求值，不需要用户看）
 * @param {boolean} [options.intercept] - 是否启用 `Fetch` 域（拦回调前必须为 true）
 * @param {(message: string) => void} [options.log]
 * @returns {Promise<{cdp: CdpConnection, targetId: string, close: () => void}>}
 */
export async function startChromiumSession({ url, executable, userDataDir, headless = false, intercept = false, log = () => {} } = {}) {
  const binary = executable ?? findBrowserExecutable()
  if (binary === undefined) {
    throw new Error('没有找到 Chromium 系浏览器（Chrome / Edge）。可用环境变量 OFM_CHROMIUM 指定可执行文件')
  }
  const profileDir = userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-browser-'))
  const child = spawn(binary, buildLaunchArgs({ userDataDir: profileDir, url: 'about:blank', headless }), {
    stdio: 'ignore',
    windowsHide: false,
    detached: process.platform !== 'win32',
  })
  // Without a listener Node turns a failed spawn (ENOENT/EACCES/AV block) into
  // an uncaught `error` event — that crashes the host process, not just this
  // login. Record it and fail the flow with the real reason instead of waiting
  // out the 20 s debug-port budget.
  let spawnError
  child.on('error', error => { spawnError = error })
  const close = () => {
    killTree(child.pid)
    if (userDataDir === undefined) {
      try { fs.rmSync(profileDir, { recursive: true, force: true }) } catch { /* 占用中，留给系统清理 */ }
    }
  }
  try {
    const activePort = path.join(profileDir, 'DevToolsActivePort')
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS
    let parsed
    while (Date.now() < deadline) {
      if (spawnError !== undefined) throw spawnError
      if (fs.existsSync(activePort)) {
        parsed = parseDevToolsActivePort(fs.readFileSync(activePort, 'utf8'))
        if (parsed !== undefined) break
      }
      await sleep(100)
    }
    if (spawnError !== undefined) throw spawnError
    if (parsed === undefined) throw new Error(`浏览器没有暴露调试端口（${LAUNCH_TIMEOUT_MS / 1000}s 超时）`)
    const cdp = new CdpConnection(`ws://127.0.0.1:${parsed.port}${parsed.browserPath}`)
    await cdp.ready
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
    await cdp.send('Page.enable', {}, { sessionId })
    if (intercept) await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, { sessionId })
    if (typeof url === 'string' && url !== '') {
      await cdp.send('Page.navigate', { url }, { sessionId })
    }
    /** 在页面里求值（`returnByValue`，所以能直接拿到 JSON 可序列化的值）。 */
    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', {
        expression: String(expression),
        returnByValue: true,
        awaitPromise: false,
      }, { sessionId })
      if (result?.exceptionDetails !== undefined) {
        throw new Error(`页面求值失败：${result.exceptionDetails.text ?? '未知异常'}`)
      }
      return result?.result?.value
    }
    log(`chromium 已启动（${binary}）`)
    /**
     * 读某个 URL 作用域下的 cookie（HttpOnly 也能读到 —— 这正是它的用途：
     * `document.cookie` 拿不到 HttpOnly，而平台会话恰恰是 HttpOnly）。
     */
    const cookies = async target => {
      await cdp.send('Network.enable', {}, { sessionId })
      const result = await cdp.send('Network.getCookies', { urls: [String(target)] }, { sessionId })
      return Array.isArray(result?.cookies) ? result.cookies : []
    }
    return { cdp, targetId, sessionId, evaluate, cookies, close }
  } catch (error) {
    close()
    throw error
  }
}

/**
 * 拦到回调：命中 predicate 的请求**不发出**，改喂静态完成页，并把 URL 交回。
 *
 * 返回 `{promise, dispose}`：`promise` 在命中或超时时 resolve（**不 reject** ——
 * 用户没登完是正常路径）。
 *
 * @param {{cdp: CdpConnection, sessionId: string}} session
 * @param {(url: string) => boolean} predicate
 * @param {{timeoutMs?: number, html?: string}} [options]
 */
export function interceptCallback(session, predicate, { timeoutMs = 240_000, html = DEFAULT_DONE_PAGE } = {}) {
  const { cdp, sessionId } = session
  let settled = false
  let resolveUrl
  const promise = new Promise(resolve => { resolveUrl = resolve })
  const timer = setTimeout(() => settle(undefined), timeoutMs)
  // ⚠️ 不 unref：浏览器被用户关掉后不会再有事件，这个计时器是**唯一**能让
  // promise 落定的东西。unref 掉会让「等回调」永远挂着（进程若已无其它句柄，
  // 还会带着未结算的 await 直接退出）。
  const bodyText = Buffer.from(html, 'utf8').toString('base64')

  const settle = value => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    off()
    resolveUrl(value)
  }

  const off = cdp.onEvent(event => {
    if (event.method !== 'Fetch.requestPaused' || event.sessionId !== sessionId) return
    const { requestId, request } = event.params ?? {}
    const target = String(request?.url ?? '')
    if (!predicate(target)) {
      // 别的请求原样放行；失败（请求已消失）不影响流程。
      void cdp.send('Fetch.continueRequest', { requestId }, { sessionId }).catch(() => {})
      return
    }
    // 命中：喂静态页，请求**不出网**（否则一次性 code 会被消费掉）。
    void cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }],
      body: bodyText,
    }, { sessionId }).catch(() => {})
    settle(target)
  })
  return { promise, dispose: () => settle(undefined) }
}

/** 命中的回调窗口里显示的页面（自包含：拦截期间任何外链都会再触发一次 requestPaused）。 */
export const DEFAULT_DONE_PAGE = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>登录完成</title>
<style>body{font:16px/1.6 system-ui,"Microsoft YaHei",sans-serif;margin:0;display:flex;height:100vh;align-items:center;justify-content:center;background:#f6f7f9;color:#1f2328}main{text-align:center;padding:32px 40px;background:#fff;border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.06)}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#57606a}</style>
</head><body><main><h1>登录已完成</h1><p>可以关闭此窗口，回到 DSH 继续。</p></main></body></html>`
