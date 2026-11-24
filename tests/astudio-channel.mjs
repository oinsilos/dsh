/**
 * AStudio 协议测试（离线）：Cookie→Bearer、目录归一、缺字段不猜。
 */

import assert from 'node:assert/strict'
import {
  ASTUDIO,
  ASTUDIO_FALLBACK_CONTEXT,
  exchangeAstudioBearer,
  fetchAstudioModels,
  parseAstudioModels,
  readAstudioBearer,
} from '../src/channels/astudio.js'

/* 1. Bearer 解析 */
{
  assert.equal(readAstudioBearer({ modelBearerToken: 'b1' }), 'b1')
  assert.equal(readAstudioBearer({ data: { model_bearer_token: 'b2' } }), 'b2')
  assert.equal(readAstudioBearer({ data: {} }), undefined)
  assert.equal(readAstudioBearer(null), undefined)
  console.log('ok 1/3 Bearer 解析')
}

/* 2. Cookie → Bearer */
{
  const ok = await exchangeAstudioBearer('k=v; k2=v2', {
    fetch: async (url, init) => {
      assert.equal(url, 'https://agent.xfyun.cn/xingchen-studio/bot/models/configs')
      assert.equal(init.headers.cookie, 'k=v; k2=v2', 'Cookie 原样透传（四字段串）')
      return { ok: true, status: 200, json: async () => ({ data: { modelBearerToken: 'bt' } }) }
    },
  })
  assert.equal(ok.credential.model_bearer_token, 'bt')
  assert.equal(ok.credential.session_cookie, 'k=v; k2=v2')
  assert.equal(ok.credential.provider, 'astudio')

  const noCookie = await exchangeAstudioBearer('', { fetch: async () => { throw new Error('不该请求') } })
  assert.match(noCookie.error, /Cookie/)

  const noBearer = await exchangeAstudioBearer('k=v', { fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) }) })
  assert.match(noBearer.error, /modelBearerToken/)
  console.log('ok 2/3 Cookie → Bearer')
}

/* 3. 目录归一 */
{
  const rows = parseAstudioModels({
    data: { models: [
      { id: 'glm-5.3', name: 'GLM-5.3', context_window: 1_048_576, max_output_tokens: 128_000 },
      { model_id: 'deepseek-v4-flash', context_window: 'bad' },
      { nothing: true },
    ] },
  })
  assert.equal(rows.length, 2, '无 id 的条目必须丢掉')
  assert.equal(rows[0].contextWindow, 1_048_576)
  assert.equal(rows[0].maxOutput, 128_000)
  assert.equal(rows[1].contextWindow, ASTUDIO_FALLBACK_CONTEXT, '窗口非法时回兜底，不丢行')

  const remote = await fetchAstudioModels('bt', {
    fetch: async (url, init) => {
      assert.equal(url, 'https://astronstudio-api-volces-prod.xf-yun.com/api/v1/model-manager/models')
      assert.equal(init.headers.authorization, 'Bearer bt')
      return { ok: true, status: 200, json: async () => ({ models: [{ id: 'x', context_window: 1000 }] }) }
    },
  })
  assert.equal(remote.rows.length, 1)
  assert.equal(ASTUDIO.catalogPath, '/api/v1/model-manager/models')
  console.log('ok 3/3 目录归一')
}

console.log('astudio channel OK: 3 组断言全部通过')
