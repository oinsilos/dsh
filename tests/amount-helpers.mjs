import fs from 'node:fs'
import assert from 'node:assert/strict'

const src = fs.readFileSync('client.js', 'utf8')
const start = src.indexOf('function amountText(value, unit)')
const marker = src.indexOf('The host RPC the pack registered')
const end = src.lastIndexOf('/**', marker)
assert.ok(start > 0 && marker > start && end > start, 'helper block not found')
const block = src.slice(start, end)
const t = key => ({ 'chan.unit.credit': '积分', 'chan.unit.tokens': 'Token', 'chan.unit.dollars': 'USD', 'chan.unit.quota': '配额' })[key] ?? key
const { amountText, claimAmountText } = new Function('t', block + '\nreturn { amountText, claimAmountText }')(t)

const cases = [
  [0.42, 'dollars', '$0.42'],
  [12.5, 'dollars', '$12.50'],
  [0, 'dollars', '$0.00'],
  [200000, 'tokens', '200K'],
  [800, 'credit', '800'],
  [0.5, 'credit', '0.5'],
  [1500, 'credit', '1.5K'],
  [42, 'quota', '42%'],
  [null, 'credit', '—'],
]
for (const [value, unit, want] of cases) {
  const got = amountText(value, unit)
  assert.equal(got, want, `amountText(${value}, ${unit}) => ${got}, want ${want}`)
}
assert.equal(claimAmountText({ totalByUnit: { credit: 800, token: 0 } }, 'credit', t), '+800 积分')
assert.equal(claimAmountText({ totalByUnit: { credit: 0, token: 200000 } }, 'tokens', t), '+200K Token')
assert.equal(claimAmountText({ totalByUnit: { credit: 100, token: 50000 } }, 'credit', t), '+100 积分 · +50K Token')
assert.equal(claimAmountText({ totalCredit: 100 }, 'credit', t), '+100 积分')
assert.equal(claimAmountText({ totalByUnit: { credit: 0, token: 0 } }, 'credit', t), '')
console.log('amount helpers OK:', cases.length + 5, 'assertions')

process.exit(0)
