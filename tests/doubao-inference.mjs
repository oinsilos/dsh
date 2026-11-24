/**
 * 豆包**推理腿**测试（离线）：目录解析、请求体路由、帧翻译。
 *
 * 判据来源是 2026-11-24 的真机抓包（本机已登录账号）：
 * - `POST /alice/slot/action_bar_v3/brief_list` → `code:0`，模型散在 `model_item_key` 节点里；
 * - `POST /chat/completion` → `event: SSE_ACK` / `FULL_MSG_NOTIFY`（回显**用户**那条）/
 *   `STREAM_MSG_NOTIFY`（`content.content_block[]`）/ `STREAM_CHUNK`（`patch_op[].patch_value`）；
 * - 正文在 `block_type:10000` 的 `content.text_block.text`；
 * - 请求体里 `conversation_mode` 在 `aggregate_params` 里**必须是字符串**
 *   （发数字实测回 `710020202 common invalid param`）。
 */

import assert from 'node:assert/strict'
import {
  DOUBAO_FALLBACK_MODELS,
  buildDoubaoChatBody,
  createDoubaoTranslator,
  doubaoModeOf,
  doubaoPromptOf,
  doubaoRemoteModels,
  doubaoTagList,
  readDoubaoFrames,
  rememberDoubaoModes,
} from '../src/channels/doubao.js'
import { buildOwnCatalog } from '../src/channels/catalog.js'

/* ── 1. 目录解析（真机树形状） ──────────────────────────────────────────── */

{
  // 树形状取自真机：模型节点在 `menu_conf.item_list[]` 里，菜单本身带 `mode_id`。
  const payload = {
    code: 0,
    data: {
      entry_list: [
        { item_id: '1', name: '快速', menu_conf: { item_list: [
          { item_id: '0', model_item_key: '0', name: '快速', default_mode: 1, tag_list: [] },
        ] } },
        { item_id: '2', name: '模型', menu_conf: { mode_id: 1, item_list: [
          { item_id: '3', model_item_key: '3', name: '专家', default_mode: 1, tag_list: ['0.65x'] },
        ] } },
        { item_id: '3', name: '工作', menu_conf: { mode_id: 3, item_list: [
          { item_id: '5', model_item_key: '5', name: '豆包 2.1 Pro', default_mode: 3, tag_list: [{ text: '限时优惠 0.01x' }] },
          {
            item_id: '6',
            model_item_key: 'person-x',
            name: 'DeepSeek V4.1 Flash',
            default_mode: 3,
            tag_list: [],
            show_reasoning_effort: true,
            reasoning_effort_config: { option_list: [
              { level: 3, name: '低' }, { level: 4, name: '中' }, { level: 'x', name: '坏档位' }, { level: 5, name: '高' },
            ] },
          },
        ] } },
        // 同一个 key 在另一处再出现一次（无菜单上下文）⇒ 不能因此改模式
        { item_id: '9', model_item_key: '5', name: '豆包 2.1 Pro' },
      ],
    },
  }
  const models = doubaoRemoteModels(payload)
  const byKey = Object.fromEntries(models.map(row => [row.key, row]))
  assert.deepEqual(Object.keys(byKey).sort(), ['0', '3', '5', 'person-x'])
  assert.equal(byKey['0'].mode, '1', '对话页的模型是模式 1')
  assert.equal(byKey['5'].mode, '3', '工作页的模型是模式 3（重复出现也不改）')
  assert.deepEqual(byKey['5'].tags, ['限时优惠 0.01x'], '`{text}` 形态的标签也要读')
  assert.deepEqual(byKey['person-x'].efforts, ['3', '4', '5'], '档位只认纯数字 level，坏档位剔除')
  assert.equal(byKey['person-x'].mode, '3')
  assert.equal(byKey['3'].name, '专家')
  // 模式号回填：请求体按它路由
  rememberDoubaoModes(models)
  assert.equal(doubaoModeOf('5'), '3')
  assert.equal(doubaoModeOf('不存在的模型'), '1', '未知模型保守走对话线（不误烧会员额度）')

  assert.deepEqual(doubaoTagList(['a', { text: 'b' }, '', 3]), ['a', 'b'])
  assert.deepEqual(doubaoRemoteModels({}), [], '形状不认识 ⇒ 空表（不抛）')
  console.log('ok 1/5 目录解析')
}

/* ── 2. 请求体：模式路由（真机踩过的类型坑） ────────────────────────────── */

{
  const chat = JSON.parse(buildDoubaoChatBody({ model: '0', mode: '1', prompt: 'hi' }))
  assert.equal(chat.option.agent_mode, 2, '对话：agent_mode=2')
  assert.equal(chat.option.conversation_init_ext.mode_id, '1')
  assert.equal(chat.option.conversation_mode, 1, 'option.conversation_mode 是数字')
  assert.equal(chat.option.aggregate_params.conversation_mode, '1', '⚠️ aggregate 里必须是**字符串**（实测发数字回 710020202）')
  assert.equal(chat.option.aggregate_params.agent_mode, '2')
  assert.equal(chat.option.conversation_init_ext.reasoning_effort, '4', '不指定档位时的默认值')
  assert.equal(chat.option.need_deep_think, 0, '不指定档位 ⇒ 不深度思考')
  assert.equal(chat.messages[0].content_block[0].content.text_block.text, 'hi')
  assert.equal(chat.messages[0].content_block[0].block_type, 10000)
  assert.ok(typeof chat.client_meta.bot_id === 'string' && chat.client_meta.bot_id !== '')

  const task = JSON.parse(buildDoubaoChatBody({ model: '5', mode: '3', prompt: 'hi', reasoningEffort: '5' }))
  assert.equal(task.option.agent_mode, 1, '工作任务：agent_mode=1')
  assert.equal(task.option.conversation_mode, 2)
  assert.equal(task.option.aggregate_params.conversation_mode, '2')
  assert.equal(task.option.need_deep_think, 10001, '工作任务的思考开关是独立常量 10001')
  assert.equal(task.option.conversation_init_ext.reasoning_effort, '5')
  assert.equal(task.option.model_config.model_item_key, '5')
  assert.equal(task.ext.use_deep_think, '10001')
  console.log('ok 2/5 请求体')
}

/* ── 3. prompt 拼接（角色分隔符是协议的一部分） ─────────────────────────── */

{
  const prompt = doubaoPromptOf([
    { role: 'system', content: '你是助手' },
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '在' },
    { role: 'user', content: [{ type: 'text', text: '数到三' }] },
  ])
  assert.equal(prompt, '你是助手\n\n user: 你好\n\n assistant: 在\n\n user: 数到三')
  assert.match(prompt, / user: /, '⚠️ 分隔符必须与上游同形（中文冒号会被判 common invalid param）')
  console.log('ok 3/5 prompt 拼接')
}

/* ── 4. 帧翻译（真机帧序列） ───────────────────────────────────────────── */

{
  const translator = createDoubaoTranslator()
  const frames = [
    { event: 'SSE_HEARTBEAT', data: '{}' },
    { event: 'SSE_ACK', data: JSON.stringify({ ack_client_meta: { conversation_id: 'c1' } }) },
    // 用户消息回显：必须跳过，否则用户自己的提问会当成回答
    { event: 'FULL_MSG_NOTIFY', data: JSON.stringify({ message: { user_type: 1, content: '[{"block_type":10000,"content":{"text_block":{"text":"只回答两个字：你好"}}}]' } }) },
    // 思考头 + 它的子块
    { event: 'STREAM_MSG_NOTIFY', data: JSON.stringify({ content: { content_block: [
      { block_type: 10040, block_id: '10040-1', content: { text_block: { text: '思考中' } } },
    ] } }) },
    { event: 'STREAM_MSG_NOTIFY', data: JSON.stringify({ content: { content_block: [
      { block_type: 10000, block_id: 'think-1', parent_id: '10040-1', content: { text_block: { text: '先想' } } },
    ] } }) },
    // 正文：先 "你"，再 "好"（同一 block_id，增量）
    { event: 'STREAM_MSG_NOTIFY', data: JSON.stringify({ content: { content_block: [
      { block_type: 10000, block_id: 'b1', content: { text_block: { text: '你' } } },
    ] } }) },
    { event: 'STREAM_CHUNK', data: JSON.stringify({ patch_op: [
      { patch_object: 111, patch_value: { content_block: [{ block_type: 10000, block_id: 'b1', content: { text_block: { text: '不该出现' } } }] } },
      { patch_object: 1, patch_type: 1, patch_value: { content_block: [{ block_type: 10000, block_id: 'b1', content: { text_block: { text: '好' } } }] } },
    ] }) },
    { event: 'CHUNK_DELTA', data: JSON.stringify({ text: '！' }) },
  ]
  const out = []
  for (const frame of frames) translator.push(frame, out)
  const parsed = out.map(chunk => JSON.parse(chunk))
  const content = parsed.map(row => row.choices[0].delta.content ?? '').join('')
  const reasoning = parsed.map(row => row.choices[0].delta.reasoning_content ?? '').join('')
  assert.equal(content, '你好！', '正文：累积差量 + CHUNK_DELTA 拼接')
  assert.equal(reasoning, '先想', '`parent_id` 指向 10040 头的块是思考，不是正文')
  assert.ok(!content.includes('只回答两个字'), '用户消息回显不能进正文')
  assert.ok(!content.includes('不该出现'), '`patch_object:111` 是 UI 补丁，必须跳过')
  const finish = translator.finish().map(chunk => JSON.parse(chunk))
  assert.equal(finish[0].choices[0].finish_reason, 'stop')

  // 流内业务错误：必须留痕（调用方据此抛，别当成功）
  const failing = createDoubaoTranslator()
  failing.push({ event: 'STREAM_ERROR', data: JSON.stringify({ error_code: 710020202, error_msg: 'common invalid param' }) })
  assert.deepEqual(failing.failure, { code: 710020202, message: 'common invalid param' })

  // 只有思考没有正文 ⇒ finish 仍是 stop（有内容），但调用方判「空回答」是它的事
  const reasoningOnly = createDoubaoTranslator()
  const onlyOut = []
  reasoningOnly.push({ event: 'STREAM_MSG_NOTIFY', data: JSON.stringify({ content: { content_block: [
    { block_type: 10040, block_id: 'h' }, { block_type: 10000, block_id: 't', parent_id: 'h', content: { text_block: { text: '想' } } },
  ] } }), }, onlyOut)
  assert.equal(onlyOut.length, 1)
  assert.equal(JSON.parse(onlyOut[0]).choices[0].delta.reasoning_content, '想')
  console.log('ok 4/5 帧翻译')
}

/* ── 5. 帧读取 + 目录兜底行 ─────────────────────────────────────────────── */

{
  // 三行一帧：`event:` / `data:` / 空行（真机形状）
  const stream = (async function* () {
    yield Buffer.from('id: 1\nevent: SSE_ACK\ndata: {"a":1}\n\nid: 2\nevent: STREAM_CHUNK\ndata: {"b":')
    yield Buffer.from('2}\n\n')
  })()
  const frames = []
  await readDoubaoFrames(stream, frame => frames.push(frame))
  assert.deepEqual(frames, [
    { event: 'SSE_ACK', data: '{"a":1}' },
    { event: 'STREAM_CHUNK', data: '{"b":2}' },
  ], '帧按空行切分，事件名要带出来（通用 readSse 会把事件名丢掉）')

  // 兜底目录：16 条真机快照，进得了选择器
  const rows = buildOwnCatalog({ enabled: { doubao: true } }).filter(row => row.provider === 'doubao')
  assert.equal(rows.length, DOUBAO_FALLBACK_MODELS.length)
  assert.equal(rows.length, 16)
  assert.ok(rows.every(row => row.wire === 'chat'), '豆包走 chat 线（请求体由我们自己组装）')
  assert.ok(rows.some(row => row.id === 'doubao/0' && row.name.includes('豆包')))
  assert.ok(rows.some(row => row.id === 'doubao/person-deepseek-v4-1-flash-261017' && row.efforts !== undefined), '声明档位的模型要带上 efforts')
  console.log('ok 5/5 帧读取与目录')
}

console.log('doubao inference OK: 5 组断言全部通过')
