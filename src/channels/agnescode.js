/**
 * AgnesCode（Agnes AI 编程客户端）渠道 ×2：国内站 / 国际站。
 *
 * ## 为什么是「读客户端登录态」而不是新开一套登录
 *
 * AgnesCode 的登录只存在于它的桌面客户端里（微信 / OAuth），没有公开的设备码
 * 端点。客户端把会话写成 Chromium 风格的加密文件：
 *
 * ```text
 * %APPDATA%\AgnesCode\code-auth-session.cn.v1      ← 国内站
 * %APPDATA%\AgnesCode\code-auth-session.v1         ← 国际站（候选名，见 SESSION_FILES）
 * ```
 *
 * 格式（逐字节实测，2026-11-25）：
 *
 * ```text
 * 00..02  "v10"
 * 03..14  12 字节 nonce
 * 15..末  AES-256-GCM 密文 + 16 字节 tag
 * 明文     JSON（{accessToken, userInfo:{id,username}, bffPublicBaseUrl, ...}）
 *         注意：Chrome 130+ 的其它产品会在明文前加 32 字节 SHA256(host)；
 *         本客户端的 `.cn.v1` 实测**没有**前缀 —— 两种都要能读。
 * ```
 *
 * 主密钥：`Local State` 的 `os_crypt.encrypted_key`（base64，前 5 字节 `DPAPI`）
 * → DPAPI（CurrentUser）解封 → 32 字节 AES 密钥。Node 没有 DPAPI，故这里
 * **只在这一步**起一个 PowerShell（`System.Security.ProtectedData`），把密钥
 * 以 base64 拿回来；解密、解析全在 Node 里做。
 *
 * ## 红线
 *
 * - `bffPublicBaseUrl` **每账号下发**，绝不硬编码；挂 `Authorization` 前必须
 *   钉扎 `https` + `*.agnes-ai.cn` / `*.agnes-ai.com`（防 `api.agnes-ai.cn.evil`）。
 * - 目录是**账号级下发**（`{bffBase}/models`），刻意**没有静态兜底表**：
 *   没登录 = 0 个模型，登录后按真实订阅档出现。
 * - 推理是 OpenAI 兼容 `{bffBase}/chat/completions`；响应 SSE 里的
 *   `reasoning_content` 由通用 stream 解析器接住，不需要二次翻译。
 *
 * @module src/channels/agnescode.js
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

const TIMEOUT_MS = 20_000

/** 两个产品：同一套实现，只换会话文件与展示名。 */
export const AGNESCODE_PRODUCTS = Object.freeze({
  agnescode: {
    id: 'agnescode',
    label: 'AgnesCode',
    region: 'cn',
    appDir: 'AgnesCode',
    // 国内站实测 `code-auth-session.cn.v1`；国际站候选名按客户端命名习惯排。
    sessionFiles: ['code-auth-session.cn.v1'],
  },
  agnescodeintl: {
    id: 'agnescodeintl',
    label: 'AgnesCode 国际版',
    region: 'intl',
    appDir: 'AgnesCode',
    sessionFiles: ['code-auth-session.v1', 'code-auth-session.intl.v1', 'code-auth-session.global.v1'],
  },
})

/** 域名白名单（后缀匹配，必须落在 `agnes-ai.cn` / `agnes-ai.com` 下）。 */
const ALLOWED_HOST_SUFFIXES = ['.agnes-ai.cn', '.agnes-ai.com']
const ALLOWED_HOSTS = ['agnes-ai.cn', 'agnes-ai.com']

/**
 * `bffPublicBaseUrl` 是否可挂 Authorization。
 *
 * 只接受 https + 精确的 agnes 域（或其子域）；`api.agnes-ai.cn.evil.example`
 * 这类后缀伪装必须被拒。
 */
export function agnesHostAllowed(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.trim() === '') return false
  let url
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.toLowerCase()
  if (ALLOWED_HOSTS.includes(host)) return true
  return ALLOWED_HOST_SUFFIXES.some(suffix => host.endsWith(suffix))
}

/**
 * 解一段 Chromium `v10` 密文。
 *
 * @param {Buffer} blob - 完整文件内容
 * @param {Buffer} key - 32 字节主密钥
 * @returns {Buffer} 明文（已剥掉可选的 32 字节 host 前缀）
 */
export function decryptSessionBlob(blob, key) {
  if (!Buffer.isBuffer(blob) || blob.length < 3 + 12 + 16) throw new Error('会话文件过短')
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('主密钥长度不是 32 字节')
  const prefix = blob.subarray(0, 3).toString('latin1')
  if (prefix !== 'v10') throw new Error(`未知的会话加密前缀 "${prefix}"`)
  const nonce = blob.subarray(3, 15)
  const ciphertext = blob.subarray(15)
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16))
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()])
  // Chrome 130+ 的部分产品在明文前加 32 字节 SHA256(host)；本客户端实测没有。
  // 判据：第 33 个字节是 JSON 的 `{`，且总长足够。
  if (plain.length > 32 && plain[32] === 0x7b) return plain.subarray(32)
  return plain
}

/**
 * 会话 JSON → 本插件的凭据形状（只保留推理与展示需要的字段，不落无关项）。
 */
export function parseSession(text) {
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new Error('会话明文不是 JSON（客户端版本可能变了）')
  }
  const accessToken = typeof payload?.accessToken === 'string' ? payload.accessToken.trim() : ''
  const bffBase = typeof payload?.bffPublicBaseUrl === 'string' ? payload.bffPublicBaseUrl.trim().replace(/\/+$/, '') : ''
  if (accessToken === '') throw new Error('会话里没有 accessToken（请先在 AgnesCode 客户端里登录）')
  if (bffBase === '') throw new Error('会话里没有 bffPublicBaseUrl（客户端版本可能变了）')
  if (!agnesHostAllowed(bffBase)) throw new Error(`bffPublicBaseUrl 不在 agnes 域白名单内：${bffBase}`)
  const user = payload?.userInfo !== null && typeof payload?.userInfo === 'object' ? payload.userInfo : {}
  return {
    access_token: accessToken,
    bff_base: bffBase,
    account_id: typeof user.id === 'string' ? user.id : '',
    username: typeof user.username === 'string' ? user.username : '',
    auth_provider: typeof user.auth_provider === 'string' ? user.auth_provider : '',
    obtained_at: Date.now(),
  }
}

/** PowerShell 一行式：DPAPI 解封（只回 base64，不打印任何明文）。 */
function unsealWithDpapi(encryptedKeyBase64) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('DPAPI 只在 Windows 上可用'))
      return
    }
    // 注意：传入的已经是**去掉 ASCII "DPAPI" 前缀**后的密文，这里不再二次剥离。
    const script = [
      'Add-Type -AssemblyName System.Security',
      '$blob=[Convert]::FromBase64String($env:OFM_AGNES_ENC_KEY)',
      '[Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect($blob,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser))',
    ].join('; ')
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, OFM_AGNES_ENC_KEY: encryptedKeyBase64 },
      timeout: 15_000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error !== null) {
        reject(new Error(`DPAPI 解封失败：${String(stdout ?? '').trim() || error.message}`))
        return
      }
      const base64 = String(stdout).trim()
      if (base64 === '') {
        reject(new Error('DPAPI 解封返回空'))
        return
      }
      resolve(Buffer.from(base64, 'base64'))
    })
  })
}

const sessionCache = new Map()

/**
 * 读取并解密客户端会话。
 *
 * @param {object} options
 * @param {object} options.product - `AGNESCODE_PRODUCTS[...]`
 * @param {string} [options.appDataDir] - `%APPDATA%`（测试注入）
 * @param {(base64: string) => Promise<Buffer>} [options.unsealKey] - 测试注入
 * @returns {Promise<{credential: object, sessionPath: string, mtimeMs: number}>}
 */
export async function readAgnescodeSession({
  product,
  appDataDir = process.env.APPDATA ?? '',
  unsealKey = unsealWithDpapi,
} = {}) {
  if (appDataDir === '') throw new Error('找不到 APPDATA（非 Windows 环境？）')
  const root = path.join(appDataDir, product.appDir)
  const candidates = product.sessionFiles.map(name => path.join(root, name))
  const sessionPath = candidates.find(file => fs.existsSync(file))
  if (sessionPath === undefined) {
    throw new Error(`未找到 ${product.label} 客户端登录态（请先打开客户端并登录；找过：${candidates.join(' / ')}）`)
  }
  const stat = fs.statSync(sessionPath)
  const cached = sessionCache.get(sessionPath)
  if (cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return { credential: { ...cached.credential }, sessionPath, mtimeMs: stat.mtimeMs }
  }
  const blob = fs.readFileSync(sessionPath)
  const localStatePath = path.join(root, 'Local State')
  if (!fs.existsSync(localStatePath)) throw new Error('客户端 Local State 不存在（无法解出主密钥）')
  const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'))
  const encryptedKey = localState?.os_crypt?.encrypted_key
  if (typeof encryptedKey !== 'string' || encryptedKey === '') throw new Error('Local State 里没有 os_crypt.encrypted_key')
  const decoded = Buffer.from(encryptedKey, 'base64')
  if (decoded.subarray(0, 5).toString('latin1') !== 'DPAPI') throw new Error('加密密钥不是 DPAPI 形态（客户端版本可能变了）')
  const key = await unsealKey(decoded.subarray(5).toString('base64'))
  const credential = parseSession(decryptSessionBlob(blob, key).toString('utf8'))
  sessionCache.set(sessionPath, { mtimeMs: stat.mtimeMs, size: stat.size, credential })
  return { credential, sessionPath, mtimeMs: stat.mtimeMs }
}

/* ── 目录（账号级下发，无静态兜底） ─────────────────────────────────────── */

/**
 * `/models` → `[{id, name, contextWindow, maxOutput}]`。
 *
 * 上游行形：`{id, model_type:'text', is_member_only, max_input_tokens,
 * max_output_tokens, description, points_cost_multiplier, allowed_subscription, ...}`。
 * 会员专享模型照列（能否调用由上游判），展示名后缀「（会员）」避免误选。
 *
 * ⚠️ **倍率必须进展示名**（`points_cost_multiplier`）：DSH 的选择器只渲染
 * `name`，没有展示价格的通道，而这条是计费事实 —— `kimi-k3` 6×、`gpt-6-astra`
 * 25×，不标出来用户会在「看起来一样」的两行里选中贵 25 倍的那个。
 * `0` 是真实报价（免费），照写 `x0.00`，不能当缺值吞掉。
 */
export function parseAgnesModels(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  const out = []
  const seen = new Set()
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (id === '' || seen.has(id)) continue
    if (typeof row.model_type === 'string' && row.model_type !== 'text') continue
    seen.add(id)
    const member = row.is_member_only === true
    const multiplier = Number(row.points_cost_multiplier)
    const rate = Number.isFinite(multiplier) && multiplier >= 0 ? ` · x${multiplier.toFixed(2)}` : ''
    out.push({
      id,
      name: `${id}${member ? '（会员）' : ''}${rate}`,
      ...Number(row.max_input_tokens) > 0 ? { contextWindow: Number(row.max_input_tokens) } : {},
      ...Number(row.max_output_tokens) > 0 ? { maxOutput: Number(row.max_output_tokens) } : {},
    })
  }
  return out
}

/** 拉一次远端目录。 */
export async function fetchAgnescodeCatalog(credential, { fetch: fetchImpl = fetch, signal } = {}) {
  const base = String(credential?.bff_base ?? '').replace(/\/+$/, '')
  if (!agnesHostAllowed(base)) return { error: '凭据里的 bff_base 不在 agnes 域白名单内（需要重新导入登录态）' }
  const token = typeof credential?.access_token === 'string' ? credential.access_token : ''
  if (token === '') return { error: '凭据里没有 access_token（需要重新导入登录态）' }
  try {
    const response = await fetchImpl(`${base}/models`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: signal ?? AbortSignal.timeout(TIMEOUT_MS),
    })
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      return { error: `模型目录查询失败（HTTP ${response.status}）${text.slice(0, 120)}` }
    }
    let payload
    try { payload = JSON.parse(text) } catch { return { error: '模型目录不是 JSON（上游形态可能变了）' } }
    // 200 但形状不认识 ≠ 真的 0 个模型：以前会把这当成 `live` 空目录，
    // 面板上看起来就是「这个渠道一个模型都没有」，真实原因是上游改了字段。
    if (!Array.isArray(payload?.data)) return { error: '模型目录形状不认识（缺少 data 数组，上游形态可能变了）' }
    return { models: parseAgnesModels(payload) }
  } catch (error) {
    return { error: `模型目录网络失败：${error instanceof Error ? error.message : String(error)}` }
  }
}

/* ── 权益扩展（面板 statusOf / claim） ─────────────────────────────────── */

/**
 * @param {object} options
 * @param {object} options.product - `AGNESCODE_PRODUCTS[...]`
 * @param {(account: object) => Promise<object|null>} options.credentialOf
 * @param {Function} [options.fetch]
 */
export function createAgnescodeExtras({ product, credentialOf, fetch: fetchImpl = fetch }) {
  async function statusOf(account) {
    const base = {
      accountId: typeof account?.id === 'string' ? account.id : '',
      nickname: typeof account?.nickname === 'string' ? account.nickname : '',
    }
    const credential = await credentialOf(account)
    if (credential === null) {
      return { ...base, error: '凭据不可用（点「添加账号」重新读取客户端登录态）' }
    }
    const result = await fetchAgnescodeCatalog(credential, { fetch: fetchImpl })
    if (result.error !== undefined) {
      return {
        ...base,
        catalog: [],
        source: 'static',
        catalogError: result.error,
      }
    }
    return {
      ...base,
      catalog: result.models,
      // 目录来自远端 → 面板显示「实时目录」；没有兜底表，0 个就是真 0 个。
      source: 'live',
    }
  }

  // 上游没有签到 / 活动端点：不给假按钮。
  async function claim() {
    return { kind: 'unsupported', message: `${product.label} 没有签到端点` }
  }

  return { statusOf, claim }
}

/** 从客户端重新导入（账号续期/刷新用：客户端会自己续 token，这里同步过来）。 */
export async function refreshAgnescodeFromClient({ product, ...options } = {}) {
  try {
    const result = await readAgnescodeSession({ product, ...options })
    return { credential: result.credential, refreshed: true }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}
