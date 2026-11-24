/**
 * `/channels/own/models` 与 `/channels/own/models/update` 的**运行时可达性**守卫。
 *
 * 真机缺陷（2026-11-24）：这两个路由在 `createApiRoutes()` 里裸引用了 apply 作用域
 * 的 `diagLog` / `settings`，而 `createApiRoutes()` 是模块级函数 ⇒ 一点「模型」折叠
 * 就抛 `ReferenceError`，面板显示「操作失败：diagLog is not defined」，子列表为空。
 * 单元测试当时只覆盖了 `buildOwnCatalog()`，没有任何用例真正调用路由处理器。
 *
 * 这里用最小 deps + 假 req/res 直接驱动处理器：能抓住「标识符越界」这一类错误，
 * 也能守住「模型开关写设置 + 重编目录」这条链路。
 */

import assert from 'node:assert/strict'
import { createApiRoutes } from '../index.js'

const makeReq = (method, url, body) => {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    // 走本机回环（结构化准入规则要求 loopback Host），不带跨站标记。
    headers: { host: '127.0.0.1:19999' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

const makeRes = () => ({
  status: 0,
  headers: null,
  body: '',
  writeHead(status, headers) {
    this.status = status
    this.headers = headers
  },
  end(body) {
    this.body = body
  },
  json() {
    return JSON.parse(this.body)
  },
})

const events = []
const syncs = []
let disabledModels = {}
const settings = {
  get: () => ({ ownDisabledModels: disabledModels }),
  update: patch => { disabledModels = patch.ownDisabledModels ?? disabledModels },
  flush: () => {},
}
const rows = [
  { id: 'doubao/0', modelId: '0', name: '豆包 快速', disabled: false },
  { id: 'doubao/5', modelId: '5', name: '豆包 2.1 Pro', disabled: false },
]
let accioStarts = 0
const handler = createApiRoutes({
  settings,
  diagLog: event => { events.push(event) },
  ownModelRows: provider => rows.filter(row => row.id.startsWith(`${provider}/`)),
  ownModelCounts: () => ({ total: 2, disabled: 0, closed: false }),
  ownModelMeta: () => ({ source: 'preset', at: 0 }),
  syncOwnCatalog: async options => { syncs.push(options ?? {}) },
  channelAccounts: () => ({
    create: provider => ({ id: `${provider}-test`, provider, nickname: '' }),
    remove: async () => true,
  }),
  // Accio 的登录起点：只验路由可达 + 把入参交给真实实现（这里用替身计数）。
  accioLogin: {
    start: async ({ region }) => {
      accioStarts += 1
      return { loginUrl: `https://example.test/login?region=${region}` }
    },
    open: () => {},
    exchange: async () => ({}),
    userInfo: async () => ({}),
    flows: new Map(),
  },
})

{
  const res = makeRes()
  await handler(makeReq('GET', '/api/our-free-model/channels/own/models?provider=doubao'), res)
  assert.equal(res.status, 200, '模型折叠路由必须返回 200（不能因标识符越界变成 500）')
  const payload = res.json()
  assert.deepEqual(payload.models.map(model => model.modelId), ['0', '5'])
  assert.equal(payload.catalog.source, 'preset')
  assert.ok(events.some(event => event.kind === 'models-route'), '路由要写诊断日志（diagLog 必须可达）')
  console.log('ok 1/3 自有渠道模型列表路由可调用')
}

{
  const res = makeRes()
  await handler(makeReq('POST', '/api/our-free-model/channels/own/models/update', {
    provider: 'doubao', modelId: 'doubao/5', disabled: true,
  }), res)
  assert.equal(res.status, 200, '模型开关路由必须返回 200（settings 必须可达）')
  assert.deepEqual(disabledModels.doubao, ['5'], '关掉的模型要写进 ownDisabledModels（裸 modelId）')
  assert.ok(syncs.length === 1, '写设置后要重编一次目录')
  console.log('ok 2/3 模型开关路由可调用并落到设置')
}

{
  // Accio 登录起点：这一条以前同样裸引用了 apply 作用域（startBrowserLogin /
  // accioLogins / openBrowser）⇒ 用户点「添加账号」只看到 ReferenceError。
  const res = makeRes()
  await handler(makeReq('POST', '/api/our-free-model/channels/own/oauth/start', { provider: 'accio', region: 'cn' }), res)
  assert.equal(res.status, 200, 'Accio oauth/start 必须可达')
  assert.equal(accioStarts, 1)
  assert.match(res.json().loginUrl, /region=cn/)
  console.log('ok 3/3 Accio 登录起点路由可调用')
}
