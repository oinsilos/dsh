/**
 * Cap 人机验证的 proof-of-work 求解器（MonkeyCode / 百智云共用）。
 *
 * 两家签到都要求先过同一套「挑战 → 本地求解 → 兑换」：
 *
 *     POST /api/v1/public/captcha/challenge → { token, challenge: { c, s, d } }
 *     （本地解 c 道题）
 *     POST /api/v1/public/captcha/redeem    → { token: '<8hex>:<15hex>', success }
 *
 * 题目就是让人算的（网页版也在浏览器里算），这里只是把同一套算法在服务端跑。
 *
 * ## 五个逐字节对齐点（改任一处都会让**全部**签到失败）
 *
 * 1. `fnv1a32` 的输入是 **UTF-16 code unit**（`charCodeAt`），不是 UTF-8 字节 ——
 *    带中文的 token 用字节能漂。
 * 2. 乘法用 `Math.imul`（等价于上游「五次移位相加」，都是取低 32 位），
 *    但每步要 `>>> 0`：JS 位运算是有符号 32 位，不转无符号会让 `toString(16)` 带负号。
 * 3. 第 `i` 题的题号是 **`i+1`（1-based）**：写成 `i` 服务端必然判失败，
 *    而失败文案只会说「验证失败」，极难反推。
 * 4. 命中判据是 **十六进制前缀**（`digest.startsWith(target)`），不是按字节比较 ——
 *    按字节在奇数 `d` 上会少比较半个字节，redeem 回 `invalid solutions`。
 * 5. 解数组**顺序即题号**，不能排序或去重。
 *
 * ## 预算
 *
 * 现网实测 `c=50, s=32, d=3`（50 题合计约 0.2s）。上游一旦调高难度，同步求解会
 * 冻住宿主事件循环 ⇒ 总预算 500 万次（≈7s）超限即**抛错并说清楚**，绝不静默
 * 降级成「签到失败」。
 *
 * @module src/channels/cap-pow.js
 */

import crypto from 'node:crypto'

/** 每题尝试上限（防形态变化导致死循环）。 */
const MAX_ATTEMPTS_PER_QUESTION = 20_000_000
/** 一次签到的总预算（所有题合计）。 */
export const MAX_ATTEMPTS_TOTAL = 5_000_000

/** FNV-1a 32 位（与上游 cap.js 前端逐字符同构，见模块头）。 */
export function fnv1a32(data) {
  let hash = 2166136261
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data.charCodeAt(index)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

/** 由 seed 派生 `length` 位十六进制串（xorshift32 变体，每轮 8 位补零）。 */
export function prng(seed, length) {
  let state = fnv1a32(seed)
  let out = ''
  while (out.length < length) {
    state = (state ^ ((state << 13) >>> 0)) >>> 0
    state = (state ^ (state >>> 17)) >>> 0
    state = (state ^ ((state << 5) >>> 0)) >>> 0
    out += state.toString(16).padStart(8, '0')
  }
  return out.slice(0, length)
}

/** 解一道题：最小的 `n` 使 `sha256(salt + n)` 的十六进制前缀等于 `target`。 */
function solveOne(salt, target, budget) {
  for (let n = 0; n < MAX_ATTEMPTS_PER_QUESTION; n += 1) {
    budget.remaining -= 1
    if (budget.remaining < 0) {
      throw new Error(`签到验证题累计求解超过 ${MAX_ATTEMPTS_TOTAL} 次（target=${target}，上游可能提高了难度）—— 已放弃本次签到，请稍后重试`)
    }
    const digest = crypto.createHash('sha256').update(salt + String(n)).digest('hex')
    if (digest.startsWith(target)) return n
  }
  throw new Error(`签到验证题求解超过 ${MAX_ATTEMPTS_PER_QUESTION} 次仍未命中（target=${target}）—— 上游可能提高了难度`)
}

/** 同步解整套（纯计算，便于单测与固定向量）。 */
export function solveChallenge(token, challenge, budget = { remaining: MAX_ATTEMPTS_TOTAL }) {
  const solutions = []
  for (let index = 0; index < challenge.count; index += 1) {
    const ordinal = index + 1
    const target = prng(`${token}${ordinal}d`, challenge.targetLength)
    const salt = prng(`${token}${ordinal}`, challenge.saltLength)
    solutions.push(solveOne(salt, target, budget))
  }
  return solutions
}

/** 与 `solveChallenge` 同算法，但每解完一题让出一次事件循环。 */
export async function solveChallengeYielding(token, challenge, budget = { remaining: MAX_ATTEMPTS_TOTAL }) {
  const solutions = []
  for (let index = 0; index < challenge.count; index += 1) {
    const ordinal = index + 1
    const target = prng(`${token}${ordinal}d`, challenge.targetLength)
    const salt = prng(`${token}${ordinal}`, challenge.saltLength)
    solutions.push(solveOne(salt, target, budget))
    await new Promise(resolve => { setImmediate(resolve) })
  }
  return solutions
}

const readNumber = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

/**
 * 读挑战报文（**已解包**后的业务对象）。
 *
 * ⚠️ 调用方必须先剥掉 `{code, data}` 信封：直接传原始报文会被判成「没有 token」，
 * 签到永远失败且文案指向「上游改版」。
 */
export function readCapChallenge(data) {
  if (data === null || typeof data !== 'object') return { error: '签到验证题报文不是对象（上游形态可能已变）' }
  const token = typeof data.token === 'string' ? data.token.trim() : ''
  if (token === '') return { error: '签到验证题报文里没有 token（上游形态可能已变）' }
  const challenge = data.challenge
  if (challenge === null || typeof challenge !== 'object') return { error: '签到验证题报文里没有 challenge（上游形态可能已变）' }
  const count = readNumber(challenge.c)
  const saltLength = readNumber(challenge.s)
  const targetLength = readNumber(challenge.d)
  if (count === undefined || saltLength === undefined || targetLength === undefined) {
    return { error: '签到验证题的 c/s/d 字段缺失或不是数字（上游形态可能已变）' }
  }
  // 防御性上限：这些数字直接决定本地计算量（c=10^9 就是一次卡死宿主的长任务）。
  if (count < 1 || count > 500 || saltLength < 1 || saltLength > 256 || targetLength < 1 || targetLength > 16) {
    return { error: `签到验证题参数超出合理范围（c=${count}, s=${saltLength}, d=${targetLength}）` }
  }
  return { token, challenge: { count: Math.floor(count), saltLength: Math.floor(saltLength), targetLength: Math.floor(targetLength) } }
}

/** 从 redeem 响应里取验证 token（已解包）。 */
export function readCapToken(data) {
  if (data === null || typeof data !== 'object') return undefined
  if (data.success === false) return undefined
  const token = typeof data.token === 'string' ? data.token.trim() : ''
  return token === '' ? undefined : token
}
