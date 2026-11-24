/**
 * 渠道目录可见性开关的测试。
 *
 * 钉住的是一条**用户实际踩到的**回归（2026-11-24）：
 * `hideChannelModels: false` 时，包装层必须返回 **true**（一律显示），
 * 而不是把判定交回上游的「有账号才可见」——否则没登录的渠道（Qoder、
 * 被移除账号的 QoderCN）连分组都不出现，改模型表也永远看不到效果。
 *
 * 第二处：关闭总开关时 env 必须写**显式假值 '0'**。
 * `resolveHideWithoutAccountFlag(undefined)` 返回 true，删除变量等于没关掉。
 */

import assert from 'node:assert/strict'
import { installChannelCatalogVisibility } from '../src/channel-visibility.js'

const HIDE_FLAG = 'DSH_HIDE_MODELS_WITHOUT_ACCOUNT'

/** 上游门控的等价实现：未设 = 有账号才可见；显式假值 = 全部可见。 */
function upstreamGate(pool) {
  const raw = process.env[HIDE_FLAG]
  const hideFlag = raw === undefined ? true : !new Set(['0', 'false', 'no', 'off']).has(String(raw).trim().toLowerCase())
  if (!hideFlag) return true
  return pool.accounts.has('qoder')
}

function makePool() {
  const pool = {
    accounts: new Set(),
    async hasLoggedInAccount(provider) { return pool.accounts.has(provider) },
  }
  return pool
}

/* ── 总开关关闭：没登录也要显示 ─────────────────────────────────────────── */

delete process.env[HIDE_FLAG]
{
  const pool = makePool()           // 一个账号都没有
  const handle = installChannelCatalogVisibility(pool, { shouldHide: () => false })
  assert.equal(handle.installed, true)
  assert.equal(await pool.hasLoggedInAccount('qoder'), true, '没登录的渠道必须仍然可见（核心回归）')
  assert.equal(process.env[HIDE_FLAG], '0', '总开关关闭时必须写显式假值，不能删除变量')
  // 上游门控读到 '0' 会短路成「全部可见」，两条路径一致
  assert.equal(upstreamGate(pool), true)
}

/* ── 总开关打开：全部收起 ───────────────────────────────────────────────── */

{
  const pool = makePool()
  pool.accounts.add('qoder')        // 就算登录了也要隐藏
  const handle = installChannelCatalogVisibility(pool, { shouldHide: () => true })
  assert.equal(handle.installed, true)
  assert.equal(await pool.hasLoggedInAccount('qoder'), false, '总开关打开时一律 false')
  assert.equal(process.env[HIDE_FLAG], '1', '总开关打开时 env 写 1')
  // ⚠️ 不要断言 upstreamGate(pool) === false：env='1' 在上游语义里是
  // 「按账号判定」，该账号登录着就返回 true。包装层接管后原方法不再被调用，
  // env 只是给「未包装路径」的兜底 —— 这里断言包装优先才是对的。
  assert.equal(await pool.hasLoggedInAccount('qoder'), false, '包装优先于 env')
}

/* ── 开关现读，不缓存 ───────────────────────────────────────────────────── */

{
  let hide = false
  const pool = makePool()
  installChannelCatalogVisibility(pool, { shouldHide: () => hide })
  assert.equal(await pool.hasLoggedInAccount('qoder'), true)
  hide = true
  assert.equal(await pool.hasLoggedInAccount('qoder'), false, '开关变化要立刻生效（适配器每轮现读）')
}

/* ── 重复安装不叠加包装 ─────────────────────────────────────────────────── */

{
  const pool = makePool()
  installChannelCatalogVisibility(pool, { shouldHide: () => false })
  const wrapper = pool.hasLoggedInAccount
  installChannelCatalogVisibility(pool, { shouldHide: () => false })
  assert.equal(pool.hasLoggedInAccount, wrapper, '第二次安装必须复用同一个包装（热重载）')
}

/* ── 异常与缺失一律放行 ─────────────────────────────────────────────────── */

{
  const pool = makePool()
  installChannelCatalogVisibility(pool, { shouldHide: () => { throw new Error('boom') } })
  assert.equal(await pool.hasLoggedInAccount('qoder'), true, '读开关抛错时宁可显示')
}
{
  const skipped = installChannelCatalogVisibility(undefined, {})
  assert.equal(skipped.installed, false, '没有账号池时不接管')
  assert.equal(typeof skipped.sync, 'function', '未接管也要给一个 no-op sync')
}
assert.equal(installChannelCatalogVisibility({}, {}).installed, false, '没有 hasLoggedInAccount 就不接管')

delete process.env[HIDE_FLAG]
console.log('channel visibility OK:', 15, 'assertions')
process.exit(0)
