# vendor/channel-pack — 渠道包的构成与再构建

本目录是账号渠道包的完整运行时拷贝，由本插件的 Host 半身在独立 fiber 上挂载，
使 CodeArts、CodeBuddy、WorkBuddy、LobsterAI、Qoder、Qoder 中国版、TRAE、
Cline、Loomy、Raccoon、MiniMax Code、ZCode、Gemini 这十三个账号渠道的
登录流程、账号池、积分领取、模型黑名单与本地 OpenAI 网关可用。
挂载时关闭 OpenCode 账号接入，原有匿名免费车道保持独立。
目录名与内部标识符在本插件的再构建中统一为 channel-pack。

- 许可证：MIT（见 `LICENSE`）

## 目录内容

| 路径 | 说明 |
| --- | --- |
| `pack.js` | **插件运行时实际加载的代码**：打包成单文件（jose/undici 内联，`@deepseek-ai/*` 保持外部），使发布清单不超文件上限 |
| `qoder-auth-wasm.wasm` | Qoder 加密推理所需的 WASM，必须与 `pack.js` 同目录（`pack.js` 按 `import.meta.url` 定位它） |

宿主提供的依赖（`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-credentials`、
`@deepseek-ai/cordis`、`@deepseek-ai/schemastery`）不在此目录，按 Node 解析规则
从安装它的 profile 的 `node_modules` 取；缺少时渠道包整体降级（`/summary.channels`
报告 `state: "failed"` 与原因），免费车道不受影响。

## 挂载适配

- 挂载配置 `disableOpencode` 开启时跳过重复 OpenCode adapter、默认匿名账号和能力表预热，保留历史账号及凭据。
- 渠道 RPC 在该配置下拒绝 `opencode.*` 与通用 `account.create(provider=opencode)`。
- 13 个 provider 的远端模型目录按 30 分钟 TTL 后台刷新：过期后的下一次
  `listModels` / `resolveModel` 触发重拉（不阻塞当前调用），上游新增模型无需重启即可见。

本目录**不含**渠道包的浏览器半身与其设置页——
界面由本插件自己的界面取代，渠道操作经渠道包的
`/api/channel-pack` RPC 完成（`connection.rpc.call('/api', 'channel-pack', { method, payload })`）。
