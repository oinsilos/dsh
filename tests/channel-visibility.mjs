/**
 * 渠道目录可见性测试。
 *
 * 口径（用户 2026-11-24 / 11-25 两次确认）：
 * - **默认按登录状态**：没登录的渠道（商汤、Cline…）不占模型选择器分组；
 *   登录过的正常出现。
 * - 面板上的「隐藏所有渠道」开关为真时，13 个分组全部收起。
 * - 环境变量必须保持真值，否则上游 `providerCatalogVisible()` 会短路成
 *   「全部可见」，包装层根本不会被调用。
 */

import assert from 'node:assert/strict'
import { installChannelCatalogVisibility } from '../src/channel-visibility.js'

const HIDE_FLAG = 'DSH_HIDE_MODELS_WITHOUT_ACCOUNT'

/** 上游门控的等价实现：env 真值 → 问账号池；显式假值 → 全部可见。 */
function upstreamGate(pool, provider) {
  const raw = process.env[HIDE_FLAG]
  const hideFlag = raw === undefined ? true : !new Set(['0', 'false', 'no', 'off']).has(String(raw).trim().toLowerCase())
  if (!hideFlag) return true
  return pool.accounts.has(provider)
}

function makePool() {
  const pool = {
    accounts: new Set(),
    async hasLoggedInAccount(provider) { return pool.accounts.has(provider) },
  }
  return pool
}

/* ── 默认：按登录状态显示（核心需求） ─────────────────────────────────── */

delete process.env[HIDE_FLAG]
{
  const pool = makePool()                    // 一个账号都没有（商汤 / Cline 的现状）
  const handle = installChannelCatalogVisibility(pool, { shouldHide: () => false })
  assert.equal(handle.installed, true)
  assert.equal(await pool.hasLoggedInAccount('raccoon'), false, '没登录的渠道必须隐藏')
  assert.equal(await pool.hasLoggedInAccount('cline'), false)
  assert.equal(process.env[HIDE_FLAG], '1', 'env 必须为真值，否则上游短路成全部可见')
  assert.equal(upstreamGate(pool, 'cline'), false, '上游门控路径也要藏住未登录渠道')

  pool.accounts.add('qoder')                 // 登录一个
  assert.equal(await pool.hasLoggedInAccount('qoder'), true, '登录过的渠道正常出现')
  assert.equal(upstreamGate(pool, 'qoder'), true)
}

/* ── 总开关打开：全部收起（含已登录） ─────────────────────────────────── */

{
  const pool = makePool()
  pool.accounts.add('qoder')
  const handle = installChannelCatalogVisibility(pool, { shouldHide: () => true })
  assert.equal(handle.installed, true)
  assert.equal(await pool.hasLoggedInAccount('qoder'), false, '总开关打开时一律 false')
  assert.equal(process.env[HIDE_FLAG], '1', '总开关打开时 env 同样保持真值')
}

/* ── 开关现读，不缓存 ───────────────────────────────────────────────────── */

{
  let hide = false
  const pool = makePool()
  pool.accounts.add('qoder')
  installChannelCatalogVisibility(pool, { shouldHide: () => hide })
  assert.equal(await pool.hasLoggedInAccount('qoder'), true)
  hide = true
  assert.equal(await pool.hasLoggedInAccount('qoder'), false, '开关变化要立刻生效（适配器每轮现读）')
}

/* ── 重复安装：包装复用，但开关回调要换成新的（热重载） ────────────────── */

{
  const pool = makePool()
  pool.accounts.add('qoder')
  installChannelCatalogVisibility(pool, { shouldHide: () => false })
  const wrapper = pool.hasLoggedInAccount
  installChannelCatalogVisibility(pool, { shouldHide: () => true })
  assert.equal(pool.hasLoggedInAccount, wrapper, '第二次安装必须复用同一个包装（热重载）')
  assert.equal(await pool.hasLoggedInAccount('qoder'), false, '热重载后必须用新开关，而不是旧闭包')
}

/* ── 异常与缺失 ─────────────────────────────────────────────────────────── */

{
  const pool = makePool()
  installChannelCatalogVisibility(pool, { shouldHide: () => { throw new Error('boom') } })
  assert.equal(await pool.hasLoggedInAccount('qoder'), false, '开关读挂时交回账号判定（未登录仍是隐藏）')
  pool.accounts.add('qoder')
  assert.equal(await pool.hasLoggedInAccount('qoder'), true)
}
{
  const pool = {
    async hasLoggedInAccount() { throw new Error('pool broken') },
  }
  installChannelCatalogVisibility(pool, { shouldHide: () => false })
  assert.equal(await pool.hasLoggedInAccount('qoder'), true, '原方法抛错时宁可显示，别让整组消失')
}
{
  const skipped = installChannelCatalogVisibility(undefined, {})
  assert.equal(skipped.installed, false, '没有账号池时不接管')
  assert.equal(typeof skipped.sync, 'function', '未接管也要给一个 no-op sync')
}
assert.equal(installChannelCatalogVisibility({}, {}).installed, false, '没有 hasLoggedInAccount 就不接管')

delete process.env[HIDE_FLAG]
console.log('channel visibility OK:', 20, 'assertions')
process.exit(0)
