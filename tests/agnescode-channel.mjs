/**
 * AgnesCode ×2：客户端会话解密 / 目录解析 / 域名钉扎 / 权益形状。
 *
 * 这些用例全部用**内存 fixture**（假 Local State + 现造 v10 密文），不读本机真实
 * 登录态 —— 测试不该依赖某台机器上有没有登录客户端。
 */

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AGNESCODE_PRODUCTS,
  agnesHostAllowed,
  createAgnescodeExtras,
  decryptSessionBlob,
  fetchAgnescodeCatalog,
  parseAgnesModels,
  parseSession,
  readAgnescodeSession,
} from '../src/channels/agnescode.js'

/* ── 1. v10 解密（无前缀 / 有 32 字节 host 前缀） ───────────────────────── */

const key = crypto.randomBytes(32)
function seal(text, { hostPrefix = false } = {}) {
  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const plain = Buffer.concat([hostPrefix ? crypto.randomBytes(32) : Buffer.alloc(0), Buffer.from(text, 'utf8')])
  const body = Buffer.concat([cipher.update(plain), cipher.final()])
  return Buffer.concat([Buffer.from('v10', 'latin1'), nonce, body, cipher.getAuthTag()])
}

const sessionJson = JSON.stringify({
  accessToken: 'tok_test_123',
  userInfo: { id: 'u-1', username: '测试账号', auth_provider: 'wechat' },
  bffPublicBaseUrl: 'https://api-agnes-code.agnes-ai.cn/v1',
})
assert.equal(decryptSessionBlob(seal(sessionJson), key).toString('utf8'), sessionJson)
assert.equal(decryptSessionBlob(seal(sessionJson, { hostPrefix: true }), key).toString('utf8'), sessionJson, '带 SHA256(host) 前缀也要能剥掉')
assert.throws(() => decryptSessionBlob(Buffer.from('v11' + 'x'.repeat(40), 'latin1'), key), /未知的会话加密前缀/)
assert.throws(() => decryptSessionBlob(seal(sessionJson), crypto.randomBytes(16)), /32 字节/)
console.log('ok 1/6 v10 解密与前缀剥离')

/* ── 2. 会话解析 ─────────────────────────────────────────────────────────── */

const parsed = parseSession(sessionJson)
assert.equal(parsed.access_token, 'tok_test_123')
assert.equal(parsed.bff_base, 'https://api-agnes-code.agnes-ai.cn/v1')
assert.equal(parsed.username, '测试账号')
assert.throws(() => parseSession('{"accessToken":""}'), /accessToken/)
assert.throws(() => parseSession(JSON.stringify({ accessToken: 't', bffPublicBaseUrl: 'https://evil.example/v1' })), /白名单/)
console.log('ok 2/6 会话解析与凭据形状')

/* ── 3. 域名钉扎 ─────────────────────────────────────────────────────────── */

for (const good of ['https://api-agnes-code.agnes-ai.cn/v1', 'https://agnes-ai.com/v1', 'https://x.agnes-ai.com/']) {
  assert.equal(agnesHostAllowed(good), true, good)
}
for (const bad of [
  'http://api-agnes-code.agnes-ai.cn/v1',       // 非 https
  'https://api-agnes-ai.cn.evil.example/v1',    // 后缀伪装
  'https://evilagnes-ai.cn/v1',                 // 不是子域边界
  'not a url',
  '',
]) {
  assert.equal(agnesHostAllowed(bad), false, bad)
}
console.log('ok 3/6 域名钉扎（正反用例）')

/* ── 4. 目录解析 ─────────────────────────────────────────────────────────── */

const models = parseAgnesModels({
  data: [
    { id: 'agnes-3.0-pro', model_type: 'text', max_input_tokens: 1_000_000, max_output_tokens: 256_000 },
    { id: 'deepseek-v4.1-flash', model_type: 'text', is_member_only: true },
    { id: 'agnes-image-1', model_type: 'image' },
    { id: 'agnes-3.0-pro', model_type: 'text' },
  ],
})
assert.deepEqual(models.map(row => row.id), ['agnes-3.0-pro', 'deepseek-v4.1-flash'], '去重 + 只留 text')
assert.equal(models[0].name, 'agnes-3.0-pro')
assert.equal(models[0].contextWindow, 1_000_000)
assert.equal(models[0].maxOutput, 256_000)
assert.equal(models[1].name, 'deepseek-v4.1-flash（会员）', '会员专享要有后缀提示')
console.log('ok 4/6 目录解析（去重/过滤/会员标记）')

/* ── 5. 权益扩展：远端目录 / 401 / 无兜底 ───────────────────────────────── */

{
  const extras = createAgnescodeExtras({
    product: AGNESCODE_PRODUCTS.agnescode,
    credentialOf: async () => parsed,
    fetch: async () => new Response(JSON.stringify({ data: [{ id: 'agnes-3.0-pro', model_type: 'text' }] }), { status: 200 }),
  })
  const status = await extras.statusOf({ id: 'a1', nickname: '测试账号' })
  assert.equal(status.source, 'live')
  assert.deepEqual(status.catalog.map(row => row.id), ['agnes-3.0-pro'])
  assert.equal(status.error, undefined)
}
{
  const extras = createAgnescodeExtras({
    product: AGNESCODE_PRODUCTS.agnescode,
    credentialOf: async () => parsed,
    fetch: async () => new Response('unauthorized', { status: 401 }),
  })
  const status = await extras.statusOf({ id: 'a1' })
  assert.deepEqual(status.catalog, [], '失败时不给假兜底目录')
  assert.match(status.catalogError, /401/)
  assert.equal(status.source, 'static')
}
{
  const extras = createAgnescodeExtras({
    product: AGNESCODE_PRODUCTS.agnescode,
    credentialOf: async () => null,
  })
  const status = await extras.statusOf({ id: 'a1' })
  assert.match(status.error, /凭据不可用/)
  assert.equal((await extras.claim()).kind, 'unsupported')
}
assert.match((await fetchAgnescodeCatalog({ bff_base: 'https://evil.example', access_token: 't' })).error, /白名单/)
console.log('ok 5/6 权益扩展（live/失败/无凭据/无签到）')

/* ── 6. readAgnescodeSession（假 APPDATA + 注入解封） ───────────────────── */

{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-agnes-'))
  const appDir = path.join(root, 'AgnesCode')
  fs.mkdirSync(appDir, { recursive: true })
  fs.writeFileSync(path.join(appDir, 'Local State'), JSON.stringify({
    // 真实 Local State：base64(ASCII "DPAPI" + 密文)
    os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI', 'latin1'), Buffer.from('fake')]).toString('base64') },
  }))
  fs.writeFileSync(path.join(appDir, 'code-auth-session.cn.v1'), seal(sessionJson))
  const result = await readAgnescodeSession({
    product: AGNESCODE_PRODUCTS.agnescode,
    appDataDir: root,
    unsealKey: async base64 => {
      assert.equal(base64, Buffer.from('fake').toString('base64'), '解封输入应是去掉 DPAPI 前缀的部分')
      return key
    },
  })
  assert.equal(result.credential.username, '测试账号')
  assert.equal(result.credential.bff_base, 'https://api-agnes-code.agnes-ai.cn/v1')
  await assert.rejects(
    readAgnescodeSession({ product: AGNESCODE_PRODUCTS.agnescodeintl, appDataDir: root, unsealKey: async () => key }),
    /未找到 AgnesCode 国际版 客户端登录态/,
  )
  fs.rmSync(root, { recursive: true, force: true })
}
console.log('ok 6/6 客户端会话读取（含国际站缺文件）')

console.log('agnescode channel OK')
