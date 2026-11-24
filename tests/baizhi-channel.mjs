/**
 * 百智云协议测试（离线）。
 *
 * 钉住：maxTokens 三档夹取（大小写不敏感）、`claimed:false` = 已领、
 * 分→积分换算、余额缺失判失败、换 Key 的 401/403 视为「尚未生效」。
 */

import assert from 'node:assert/strict'
import {
  BAIZHI,
  baizhiMaxOutputTokensFor,
  claimBaizhiDailyCredit,
  exchangeBaizhiKey,
  fetchBaizhiModels,
  fetchBaizhiWallet,
} from '../src/channels/baizhi.js'

/* 1. 输出预算三档 */
{
  assert.equal(baizhiMaxOutputTokensFor('qwen-flash'), 32_768)
  assert.equal(baizhiMaxOutputTokensFor('Qwen3.6-Flash-Preview'), 32_768, '大小写不敏感')
  assert.equal(baizhiMaxOutputTokensFor('Qwen3.6-Plus'), 65_536)
  assert.equal(baizhiMaxOutputTokensFor('deepseek-v4-pro'), 100_000)
  assert.equal(baizhiMaxOutputTokensFor(undefined), 100_000)
  console.log('ok 1/4 输出预算')
}

/* 2. 余额与错误 */
{
  const credential = { session_cookie: 'baizhi_session=x' }
  const wallet = await fetchBaizhiWallet(credential, {
    fetch: async (url, init) => {
      assert.ok(url.endsWith('/api/v1/user/wallet/balance'))
      assert.equal(init.headers.cookie, 'baizhi_session=x', '平台 API 走 Cookie')
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { balance_credit_cents: 12345, daily_temporary_credit_claimed: true } }) }
    },
  })
  assert.equal(wallet.balance.total, 123.45, '分 → 积分')
  assert.equal(wallet.dailyClaimed, true)

  const missing = await fetchBaizhiWallet(credential, { fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: {} }) }) })
  assert.match(missing.error, /balance_credit_cents/)
  console.log('ok 2/4 余额')
}

/* 3. 每日临时积分：claimed:false = 已领 */
{
  const credential = { session_cookie: 'c=1' }
  const respond = (claimed, cents) => async url => {
    if (url.includes('/captcha/challenge')) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { token: 't', challenge: { c: 1, s: 8, d: 2 } } }) }
    if (url.includes('/captcha/redeem')) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { token: 'a:b', success: true } }) }
    if (url.includes('/daily-temporary-credit')) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { claimed, amount_credit_cents: cents } }) }
    throw new Error(`未预期 ${url}`)
  }

  const claimed = await claimBaizhiDailyCredit(credential, { fetch: respond(true, 10_000) })
  assert.equal(claimed.kind, 'claimed')
  assert.equal(claimed.credit, 100)

  const already = await claimBaizhiDailyCredit(credential, { fetch: respond(false, 10_000) })
  assert.equal(already.kind, 'already-claimed', 'claimed:false 是当日已领，不是失败')
  console.log('ok 3/4 每日积分')
}

/* 4. 换 Key 与目录 */
{
  const notEffective = await exchangeBaizhiKey({ session_cookie: 'c=1' }, { fetch: async () => ({ ok: false, status: 403, text: async () => '' }) })
  assert.equal(notEffective.notEffective, true, '401/403 是「登录态还没生效」，调用方要重试')

  const issued = await exchangeBaizhiKey({ session_cookie: 'c=1' }, {
    fetch: async (url, init) => {
      assert.ok(url.endsWith('/api/console/api-keys'))
      assert.equal(init.method, 'POST')
      assert.equal(String(init.body), '{}')
      return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { api_key: 'sk-abc' } }) }
    },
  })
  assert.equal(issued.credential.api_key, 'sk-abc')
  assert.equal(issued.credential.session_cookie, 'c=1', 'cookie 与 key 两段都要留')

  const models = await fetchBaizhiModels({ api_key: 'sk-abc' }, {
    fetch: async (url, init) => {
      assert.ok(url.endsWith('/api/anthropic/v1/models'))
      assert.equal(init.headers['x-api-key'], 'sk-abc')
      return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: 'qwen-flash' }, { id: 'deepseek-v4-pro' }] }) }
    },
  })
  assert.equal(models.rows.length, 2)
  assert.equal(models.rows[0].maxOutput, 32_768, '目录行自带夹取后的上限')
  assert.equal(models.rows[1].maxOutput, 100_000)
  assert.equal(BAIZHI.id, 'baizhi')
  console.log('ok 4/4 换 Key 与目录')
}

console.log('baizhi channel OK: 4 组断言全部通过')
