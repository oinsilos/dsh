# dsh-model-manager（Model Manager）

DeepSeek Harness（dsh）插件：把免费模型、账号渠道、自带 Key 的聚合渠道收进同一个模型清单，并提供一个本机 OpenAI / Anthropic 兼容网关。

纯插件挂载，不改内核、无构建步骤。

## 安装与更新

npm 包：[`@oinsilos/dsh-model-manager`](https://www.npmjs.com/package/@oinsilos/dsh-model-manager)。代码仓库：[github.com/oinsilos/dsh](https://github.com/oinsilos/dsh)。

```bash
dsh plugin add @oinsilos/dsh-model-manager
```

或在 profile 的 `package.json` 里列出 `"@oinsilos/dsh-model-manager": "^3.0.0"` 后安装。

- **应用内更新**：设置页点「检查更新 / 立即升级」即可，插件自带更新器（读 npm `latest`，sha512 校验后替换，失败自动回滚）。
- **开发副本**：`link:` 指向本仓库的副本改代码即刻生效；应用内更新会拒绝带 `.git` 的副本，更新用 `git pull`。
- **发布新版本**：改 `package.json` 的 `version` → `npm publish --access public`。

## 功能

- **免费匿名车道**——直连 OpenCode Zen 与 Kilo 公共网关，无需账号、Key 或注册。
- **账号渠道**——CodeArts、WorkBuddy / CodeBuddy、LobsterAI、Qoder、TRAE、Cline、Loomy、Raccoon、MiniMax、ZCode、Gemini、Kilo 等十三个渠道随渠道包挂载；Codely、AutoClaw、Accio、豆包、AStudio、Marvis 等十四家由本插件自带（登录、账号池轮换、每日签到、积分领取）。
- **聚合渠道（自带 Key）**——内置 78 家提供商注册表（OpenRouter、Groq、SiliconFlow、ModelScope 等），写入 Key 即出现在选择器与网关里；Key 只存本机。
- **路由分组与降级链**——`route:<分组>` 按优先级/时段/熔断自动切换，`combo:<链>` 支持 fallback 与 round-robin；面板可编辑并导入旧 `model-failover-manager` 配置。
- **上下文压缩阈值与省 Token**——接管宿主压缩引擎阈值；工具输出压缩、提示词瘦身。
- **观测**——Token 热力图、总量曲线、输出速度与首字延迟采样；数据全部留在本机。
- **OpenAI / Anthropic 兼容网关**——默认 `127.0.0.1:8326`（`/v1/chat/completions`、`/v1/messages` 等），密钥自动生成；端口占用自动顺延；可选局域网中继与出站代理。

面板共七个页签：免费模型、聚合渠道、白嫖模型接入、管线、路由、观测、对外服务。

## 网关接入

1. 打开「对外服务 → 渠道网关」，确认「运行中」，复制端点与 API Key。
2. Base URL 填 `http://127.0.0.1:8326/v1`（不要用 `localhost`，避免解析到 IPv6 回环）。
3. 模型 ID 用面板列出的完整形式，如 `loomy/GLM-5.3-Flash`、`our-free-model/deepseek-v4.1-flash-free`。

## 数据位置

`~/.dsh/our-free-model/`（设置与统计）、`~/.dsh/channel-pack/`（账号池与渠道状态）、`~/.dsh/openai-gateway/api-key`（网关密钥）。仓库本身不包含任何账号、Key 或运行时配置。

## 目录结构

```
index.js                 宿主侧：路由、模型运行时、转发/中继/出口代理
client.js                设置页（七页签）与公告组件
src/                     免费车道、聚合渠道、省 Token、路由、网关适配等
adapter/                 宿主内核适配层
locale/                  面板语言包
vendor/channel-pack/     内置渠道包（构建产物）与来源说明
cordis.patch.yml         dsh bundle 配置
```

## 边界

- 免费车道上游限流或临时不可用（429 / `Free usage limit reached`）属于上游策略，不是插件故障。
- 账号渠道的凭据只写入宿主凭据库，界面不回显明文。
- 插件 HTTP 路由复用宿主的连接信任检查，未授权请求不会得到数据。

## 许可证与来源

MIT。内置渠道包 `vendor/channel-pack/` 的来源与许可说明见 `vendor/channel-pack/NOTICE.md`。
