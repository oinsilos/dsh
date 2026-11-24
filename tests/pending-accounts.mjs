/**
 * 占位账号（点了「添加账号」但没登完）的判据测试。
 *
 * 2026-11-24 真实报障：「部分渠道都没登账号还提示余额查询失败」。
 * 根因：登录会先建一条占位账号，凭据要等用户登录完才写进来；用户中途关窗口
 * （或进程重启，登录流程是内存态）就留下一条**没有凭据**的行，而权益查询照样
 * 去问上游 ⇒ 拿回「凭据不可用」画成红字。
 *
 * 两条不变式：
 * 1. 没有凭据 ⇒ `pending: true`，**不惊动上游**（不是错误）；
 * 2. 启动时把这类行从账号表里清掉（它们永远等不到凭据）。
 */

import assert from 'node:assert/strict'
import { createChannelAccounts } from '../src/channels/accounts.js'
import { createChannelExtras } from '../src/channels/index.js'

/* ── 1. 没有凭据 ⇒ pending，且不发任何请求 ──────────────────────────────── */

{
  /** 最小 JsonStore 替身（`get` / `update` / `flush`）。 */
  const makeStore = () => {
    let doc = { version: 1, accounts: [] }
    return {
      get: () => doc,
      update: patch => { doc = { ...doc, ...patch } },
      flush: () => {},
    }
  }
  const store = makeStore()
  const emptyResolve = async () => undefined
  const accounts = createChannelAccounts(store, { set: async () => {} }, emptyResolve)

  const placeholder = accounts.create('doubao')
  assert.equal(accounts.list('doubao').length, 1, '占位账号要先入表（面板要能显示它）')
  assert.equal(await accounts.credentialOf(placeholder), null, '没有凭据 ⇒ credentialOf 为 null')

  const extras = createChannelExtras({
    pool: { listAccounts: () => [], findAccount: () => undefined },
    resolve: emptyResolve,
    ownAccounts: accounts,
    fetch: async () => { throw new Error('待登录的账号不该发任何请求') },
  })
  const status = await extras.status('doubao')
  assert.equal(status.supported, true)
  assert.equal(status.accounts.length, 1)
  assert.equal(status.accounts[0].pending, true, '没有凭据的账号要标成 pending')
  assert.equal(status.accounts[0].error, undefined, 'pending 不是错误（否则面板画红字）')

  // 领取同样不能对着占位账号打上游
  const claim = await extras.claim('doubao', placeholder.id)
  assert.equal(claim.kind, 'failed')
  assert.match(claim.message, /重新登录|凭据/, '领取失败要说清是「还没登录」')
  console.log('ok 1/2 pending 语义')
}

/* ── 2. 启动清理：只清没有凭据的行 ──────────────────────────────────────── */

{
  let doc = { version: 1, accounts: [] }
  const store = { get: () => doc, update: patch => { doc = { ...doc, ...patch } }, flush: () => {} }
  const empty = createChannelAccounts(store, { set: async () => {} }, async () => undefined)
  const orphan = empty.create('doubao')
  const orphan2 = empty.create('astudio')

  const dropped = await empty.prunePending()
  assert.deepEqual(dropped.slice().sort(), [orphan.id, orphan2.id].sort(), '两个占位账号都要被清')
  assert.equal(empty.list('doubao').length, 0, '清完表里不该再有占位账号')
  assert.equal(empty.list('astudio').length, 0)

  // 有凭据的账号不受影响
  const real = empty.create('doubao')
  const withCredential = createChannelAccounts(store, { set: async () => {} }, async ref => ({ value: JSON.stringify({ cookie: 'sessionid=S', provider: 'doubao', ref }) }))
  assert.deepEqual(await withCredential.prunePending(), [], '有凭据的账号不能被清掉')
  assert.equal(empty.list('doubao').length, 1)
  assert.equal(empty.list('doubao')[0].id, real.id)
  console.log('ok 2/2 启动清理')
}

console.log('pending accounts OK: 2 组断言全部通过')
