/**
 * 输入框积分读数的覆盖测试（离线，只读 client.js 源码）。
 *
 * ## 为什么需要它（2026-11-25 报障）
 *
 * 用户：「新加渠道的对话框模型切换旁边没有积分显示」。
 *
 * 根因不是取数失败，而是 `ComposerChannelCredits` 的**白名单**
 * （`CREDITS_CHIP_PROVIDERS`）只列了渠道包那 13 家，而本插件自己的 14 家
 * （豆包 / AgnesCode / 百度云 / Marvis …）全都不在里面 ⇒ `scope=[]`
 * ⇒ 组件直接 `return null`，一个请求都不发。**用户看到的「没有积分」其实是
 * 「这个渠道压根不在显示名单里」。**
 *
 * 更深一层的坑：自有渠道的余额**不在**渠道包的 `credits.balances` RPC 里
 * （渠道包不认识这些 provider，会回 `unsupported provider`），必须走本插件
 * 自己的 `/channels/extra`。两条腿混用会拿渠道包去问一个它不认识的 provider。
 *
 * 这个测试钉住四条：
 * 1. 自有渠道清单 = `CHANNEL_PROVIDERS` 里 `own: true` 且 `noCredits !== true` 的全集；
 * 2. `noCredits` 的渠道**不能**进清单（没有额度端点，挂上去只会画一行空）；
 * 3. 自有渠道必须走 `/channels/extra`，不能走 `credits.balances`；
 * 4. `CHIP_LABELS` 必须覆盖清单里的每一个 id（否则界面上显示裸 id）。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

const CLIENT = 'client.js'
const source = fs.readFileSync(CLIENT, 'utf8')

/** 取 `const NAME = [...]` / `{...}` / `new Set([...])` 的字面量文本。 */
function literalOf(name, open = '[', close = ']') {
  const start = source.indexOf(`const ${name} = `)
  assert.ok(start >= 0, `${name} 不在 client.js 里`)
  const from = source.indexOf(open, start)
  assert.ok(from >= 0, `${name} 的字面量起点找不到`)
  let depth = 0
  let i = from
  for (; i < source.length; i += 1) {
    if (source[i] === open) depth += 1
    else if (source[i] === close) { depth -= 1; if (depth === 0) break }
  }
  return source.slice(from, i + 1)
}

/* ── 1. 从 CHANNEL_PROVIDERS 推出「应该有积分读数」的自有渠道 ─────────── */

const providersBlock = literalOf('CHANNEL_PROVIDERS')
const entries = [...providersBlock.matchAll(/\{\s*id:\s*'([^']+)'[^}]*\}/g)].map(m => ({
  id: m[1],
  own: /\bown:\s*true\b/.test(m[0]),
  noCredits: /\bnoCredits:\s*true\b/.test(m[0]),
}))
assert.ok(entries.length >= 25, `CHANNEL_PROVIDERS 解析出 ${entries.length} 条，明显少于预期`)

const shouldShow = entries.filter(e => e.own && !e.noCredits).map(e => e.id).sort()
assert.ok(shouldShow.length > 0, '至少应有一家自有渠道有额度读数')
assert.ok(shouldShow.includes('doubao'), '豆包必须有积分读数（它有活动额度）')
assert.ok(shouldShow.includes('codely'), 'Codely 必须有（每日签到积分）')
assert.ok(shouldShow.includes('astudio'), 'AStudio 必须有（每日登录积分）')

/* ── 2. 白名单必须与上面完全一致 ───────────────────────────────────────── */

const setBlock = literalOf('CREDITS_CHIP_OWN', '[', ']')
const declared = [...setBlock.matchAll(/'([^']+)'/g)].map(m => m[1]).sort()
assert.deepEqual(
  declared,
  shouldShow,
  `CREDITS_CHIP_OWN 与「own 且 !noCredits」不一致：缺 ${shouldShow.filter(x => !declared.includes(x)).join(',') || '无'}；`
  + `多 ${declared.filter(x => !shouldShow.includes(x)).join(',') || '无'}`,
)

// 3. noCredits 的渠道绝不能进清单（它们没有额度端点）
for (const e of entries.filter(e => e.noCredits)) {
  assert.ok(!declared.includes(e.id), `${e.id} 声明了 noCredits，不能进积分读数清单`)
}
assert.ok(!declared.includes('agnescode'), 'AgnesCode 是 noCredits（目录按订阅档下发，无余额端点）')
assert.ok(!declared.includes('agnescodeintl'), 'AgnesCode 国际版同上')

/* ── 4. 取数必须分两条腿 ───────────────────────────────────────────────── */

const chipStart = source.indexOf('function ComposerChannelCredits(props)')
assert.ok(chipStart >= 0, '找不到 ComposerChannelCredits')
const chipEnd = source.indexOf('function apply(ctx)', chipStart)
const chip = source.slice(chipStart, chipEnd)

assert.ok(chip.includes('/channels/extra?provider='), '自有渠道必须走 /channels/extra（渠道包 RPC 不认识这些 provider）')
assert.ok(chip.includes('credits.balances'), '渠道包渠道仍走 credits.balances RPC')
assert.ok(chip.includes('CREDITS_CHIP_OWN.has'), '取数逻辑必须按渠道来源分流')
assert.ok(
  chip.includes('info?.total?.remain') || chip.includes('info.total.remain'),
  '自有渠道余额要认 info.total.remain（与面板 balanceRowOf 同口径）',
)
// 关键回归点：不能再用「没有 RPC 连接就整体不渲染」挡住自有渠道
assert.ok(
  !/if \(!available \|\| segments === undefined\)/.test(chip),
  '不能再用 !available 整体短路 —— 自有渠道不需要渠道包 RPC，那样会让新渠道继续缺席',
)

/* ── 5. 标签必须覆盖全部 id ─────────────────────────────────────────────── */

const labelsBlock = literalOf('CHIP_LABELS', '{', '}')
const labels = [...labelsBlock.matchAll(/([A-Za-z0-9_]+):\s*"/g)].map(m => m[1])
for (const id of declared) {
  assert.ok(labels.includes(id), `CHIP_LABELS 缺 ${id}（会显示裸 id 而不是渠道名）`)
}

console.log('composer credits chip OK:', 12, 'assertions')