/**
 * MonkeyCode 协议测试（离线）—— 钱包毫换算、信封、签到四步、幂等、目录与签名。
 */

import assert from 'node:assert/strict'
import {
  MONKEYCODE_PRODUCTS,
  claimMonkeycodeCheckin,
  createMonkeycodeExtras,
  fetchMonkeycodeCheckin,
  fetchMonkeycodeWallet,
  monkeycodeCatalogRows,
  monkeycodeProductOf,
  monkeycodeSignature,
  unwrapMonkeycodeEnvelope,
} from '../src/channels/monkeycode.js'
import { prng, solveChallenge, readCapChallenge, readCapToken } from '../src/channels/cap-pow.js'

/* 1. 产品表 */
{
  assert.equal(monkeycodeProductOf('monkeycode').platformBase, 'https://monkeycode-ai.com')
  assert.equal(monkeycodeProductOf('monkeycodeintl').platformBase, 'https://monkeycode-ai.net')
  assert.equal(monkeycodeProductOf('nope'), null)
  assert.equal(MONKEYCODE_PRODUCTS.monkeycode.sessionCookieName, 'monkeycode_ai_session')
  console.log('ok 1/5 产品表')
}

/* 2. 信封与钱包 */
{
  assert.deepEqual(unwrapMonkeycodeEnvelope({ code: 0, data: { a: 1 } }).data, { a: 1 })
  assert.equal(unwrapMonkeycodeEnvelope({ code: 1001, message: 'x' }).ok, false)

  const credential = { session_cookie: 'monkeycode_ai_session=abc' }
  const wallet = await fetchMonkeycodeWallet(credential, MONKEYCODE_PRODUCTS.monkeycode, {
    fetch: async (url, init) => {
      assert.ok(url.endsWith('/api/v1/users/wallet'))
      assert.equal(init.headers.cookie, 'monkeycode_ai_session=abc', '平台 API 只认 Cookie')
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { balance: 12345, daily_token_balance: 7 } }) }
    },
  })
  assert.equal(wallet.wallet.balance, 12.345, '毫 → 积分')
  assert.equal(wallet.wallet.dailyTokenBalance, 7)

  // 缺 balance：判失败，不回落 0
  const missing = await fetchMonkeycodeWallet(credential, MONKEYCODE_PRODUCTS.monkeycode, {
    fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: {} }) }),
  })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /balance/)
  console.log('ok 2/5 信封与钱包')
}

/* 3. 签到状态与四步领取 */
{
  const credential = { session_cookie: 'c=1', api_key: 'oma_x', signing_secret: 's' }

  // 已签到 → already-claimed，不发后续请求
  let hits = 0
  const already = await claimMonkeycodeCheckin(credential, MONKEYCODE_PRODUCTS.monkeycode, {
    fetch: async () => { hits += 1; return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { checked_in: true } }) } },
  })
  assert.equal(already.kind, 'already-claimed')
  assert.equal(hits, 1)

  // 四步：wallet → challenge → redeem → checkin
  const seen = []
  const claimed = await claimMonkeycodeCheckin(credential, MONKEYCODE_PRODUCTS.monkeycode, {
    fetch: async (url, init) => {
      seen.push(url)
      if (url.endsWith('/wallet')) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { balance: 1000 } }) }
      if (url.endsWith('/wallet/checkin') && (init.method ?? 'GET') === 'GET') return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { checked_in: false } }) }
      if (url.endsWith('/captcha/challenge')) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { token: 'tk', challenge: { c: 1, s: 8, d: 2 } } }) }
      if (url.endsWith('/captcha/redeem')) {
        const body = JSON.parse(init.body)
        assert.equal(body.token, 'tk')
        assert.equal(body.solutions.length, 1)
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { token: 'aa:bb', success: true } }) }
      }
      if (url.endsWith('/wallet/checkin')) {
        assert.deepEqual(JSON.parse(init.body), { captcha_token: 'aa:bb' })
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { credit: 100 } }) }
      }
      throw new Error(`未预期 ${url}`)
    },
  })
  assert.equal(claimed.kind, 'claimed')
  assert.equal(claimed.credit, 100)
  assert.equal(seen.filter(url => url.includes('/captcha/')).length, 2, 'challenge 与 redeem 各一次')

  // 没 cookie：明确提示用浏览器登录
  const noCookie = await claimMonkeycodeCheckin({}, MONKEYCODE_PRODUCTS.monkeycode, { fetch: async () => { throw new Error('不该请求') } })
  assert.equal(noCookie.kind, 'failed')
  assert.match(noCookie.message, /session_cookie/)
  console.log('ok 3/5 签到四步')
}

/* 4. cap-pow 求解器 */
{
  assert.equal(typeof prng('abc', 16), 'string')
  assert.equal(prng('abc', 16).length, 16)
  const solved = solveChallenge('tok', { count: 2, saltLength: 8, targetLength: 2 })
  assert.equal(solved.length, 2)
  assert.ok(solved.every(n => Number.isInteger(n) && n >= 0))
  assert.equal(readCapChallenge({ token: 't', challenge: { c: 50, s: 32, d: 3 } }).challenge.count, 50)
  assert.match(readCapChallenge({ token: '', challenge: {} }).error, /token/)
  assert.match(readCapChallenge({ token: 't', challenge: { c: 9999, s: 32, d: 3 } }).error, /范围/)
  assert.equal(readCapToken({ token: 'a:b', success: true }), 'a:b')
  assert.equal(readCapToken({ token: 'a:b', success: false }), undefined)
  console.log('ok 4/5 cap-pow')
}

/* 5. 目录、签名与权益扩展 */
{
  const rows = monkeycodeCatalogRows()
  assert.equal(rows.length, 8)
  assert.equal(rows[0].contextWindow, 1_048_576)
  assert.equal(rows[0].maxOutput, 128_000)

  const signature = monkeycodeSignature('secret', 'hello')
  assert.match(signature, /^v1=[0-9a-f]{64}$/)
  assert.equal(monkeycodeSignature('', 'hello'), '')

  const extras = createMonkeycodeExtras({
    credentialOf: async () => ({ session_cookie: 'c=1' }),
    fetch: async url => {
      if (url.endsWith('/wallet')) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { balance: 2000 } }) }
      if (url.endsWith('/wallet/checkin')) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { checked_in: true } }) }
      throw new Error(`未预期 ${url}`)
    },
  })
  const status = await extras.statusOf({ id: 'mc-1' })
  assert.equal(status.balance.balance, 2)
  assert.equal(status.checkin.todayCheckedIn, true)
  assert.equal(status.catalog.length, 8)
  console.log('ok 5/5 目录/签名/权益')
}

console.log('monkeycode channel OK: 5 组断言全部通过')
