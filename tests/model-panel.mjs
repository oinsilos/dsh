/**
 * 对话框模型面板的守卫测试（离线，只读 client.js 源码）。
 *
 * ## 为什么需要它（2026-11-25 报障）
 *
 * 用户：「对话框模型面板做的不好问题非常大」。
 *
 * 旧面板只画列表：`ModelPickerPane` / `PanelModelsPage` 的模型行没有点击处理，
 * 点一行什么都不会发生 —— 它只是「目录浏览」而不是「模型选择器」。真正能切换
 * 模型的是宿主 `modelDirectories` 服务（原生选择器与 model-failover-manager
 * 的模型位共用它），而它按**会话**取：`directoryFor(sessionId)`。
 *
 * 这个测试钉住五条：
 * 1. 面板走宿主 `modelDirectories`，并用 `directory.select(...)` 提交；
 * 2. 闪光按钮把 sessionId 带进事件（否则面板拿不到会话，只能空转）；
 * 3. 没有会话时明确提示（`panel.sessionRequired`），不画假列表；
 * 4. 只画不点的旧实现（ModelPanelDialog / ModelPickerPane / PanelModelsPage /
 *    ProviderModelsPage / REF）已全部移除；
 * 5. 新增文案在中文与英文两份字典里都存在。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'

const source = fs.readFileSync('client.js', 'utf8')

let assertions = 0
function ok(condition, message) {
  assert.ok(condition, message)
  assertions += 1
}

// 1. 数据与提交都走宿主的会话模型目录
ok(source.includes("ctx.get('modelDirectories')"), '面板应通过 ctx.get(\'modelDirectories\') 取宿主模型目录')
ok(source.includes('directory.select(selection)'), '点选模型必须调用 directory.select(...) 真正切换')
ok(source.includes('store.getSnapshot()'), '面板应从 directory.store 订阅当前选择/分组')

// 2. sessionId 从会话槽位带进面板
ok(source.includes("openModelPanel('models', sessionId)"), '闪光按钮必须把 sessionId 传给面板')
ok(source.includes('sessionId: typeof detail.sessionId'), '打开事件必须读回 sessionId')

// 3. 没有会话时的明确提示
ok(source.includes("t('panel.sessionRequired')"), '无会话时必须提示先打开会话')

// 4. 只画不点的旧实现已移除
for (const gone of ['function ModelPanelDialog', 'function ModelPickerPane', 'function PanelModelsPage', 'function ProviderModelsPage', 'const REF = {']) {
  ok(!source.includes(gone), `旧的只读实现仍在：${gone}`)
}

// 5. 三个页签：模型 / 路由分组 / 失败模型，且左栏不再有与「所有提供商」重复的一行
for (const key of ['panel.tab.models', 'panel.tab.routes', 'panel.tab.failed']) {
  ok(source.includes(`t('${key}')`), `缺少页签：${key}`)
}
ok(source.includes("api('/routes')"), '路由分组/失败模型应读本插件 /routes')
ok(source.includes('function RouteGroupPanel'), '路由分组应能在模型面板内直接编辑（成员/档位/优先级）')
ok(source.includes("post('/routes/remap'"), '分组面板应提供「修复失效成员」')
ok(source.includes("post('/routes/failed/reset'"), '失败模型页签应能恢复单个/全部熔断')
ok(source.includes("post('/routes/cooldown/reset'"), '失败模型页签应能清冷却')
ok(!source.includes("id: null, label: t('panel.allModels')"), '左栏不应再有「全部/免费模型」这一重复行')

// 6. 文案两份字典齐全
for (const key of ['panel.current', 'panel.sessionRequired', 'panel.settingsLink', 'panel.failedProviders', 'panel.tab.failed', 'panel.routes.empty', 'panel.failed.resetAll', 'compaction.advice']) {
  const hits = source.split(`'${key}':`).length - 1
  ok(hits === 2, `${key} 应该在 zh 与 en 两份字典里各出现一次（实际 ${hits}）`)
}

console.log(`model panel OK: ${assertions} assertions`)
