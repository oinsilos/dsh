# dsh-our-free-model

DeepSeek Harness（dsh）插件：把免费模型、账号渠道、自带 Key 的聚合渠道收进同一个模型清单，并提供一个本机 OpenAI / Anthropic 兼容网关。

纯插件挂载，不改内核、无构建步骤。

## 功能

- **免费匿名车道**——直连 OpenCode Zen 与 Kilo 公共网关，无需账号、Key 或注册；模型清单与可用性由本机实测得出。
- **十三个账号渠道**——CodeArts（华为云）、WorkBuddy / CodeBuddy（腾讯）、LobsterAI（有道）、Qoder / Qoder 中国版（阿里系）、TRAE（字节）、Cline、Loomy（讯飞）、Raccoon（商汤）、MiniMax Code、ZCode（智谱）、Gemini（Google Code Assist）、Kilo 免费池与原有匿名通道。登录流程、账号池、每日积分领取、模型黑名单随渠道包一起挂载。
- **聚合渠道（自带 Key）**——内置 76 家提供商注册表（NVIDIA NIM、OpenRouter、Groq、Cerebras、Gemini、DeepSeek、Mistral、Together、Fireworks、SiliconFlow、Nebius、Chutes、Hugging Face、Cloudflare、Z.ai、Kimi、MiniMax、QwenCloud、Bedrock、Vertex、Vercel AI Gateway、Azure OpenAI，以及 Ollama、LM Studio、llama.cpp 等本机端点），写入 Key 后模型以 `provider/model` 出现在选择器与网关里。Key 只写入本机 `settings.json`（0600），接口只回显 `hasKey` 与指纹。
- **路由（降级链）**——把任意车道的模型串成命名链，以 `combo:<name>` 作为虚拟模型；支持 `fallback` 与 `round-robin`。
- **省 Token**——工具输出压缩（RTK：git diff/status/log、grep、find、ls、tree、构建日志等）、提示词瘦身（默认关闭）与本地应答。
- **观测**——Token 热力图、总量曲线、输出速度与首字延迟逐次采样；数据全部留在本机。
- **OpenAI / Anthropic 兼容网关**——默认监听 `127.0.0.1:8326`，提供 `/v1/models`、`/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/messages/count_tokens`、`/v1/reasoning-efforts`；密钥首次启动时自动生成，存于 `~/.dsh/openai-gateway/api-key`。
- **端口冲突自动顺延**——8326 被占用时依次尝试 8327…，面板显示的地址始终是实际绑定端口；启动失败会直接显示原因。
- **本地转发与出口代理**——免费车道可另开一个本机转发端口（默认 `18899`）供其它工具接入；可选出站代理；网关页提供局域网中继（默认 `18326`，独立中继密钥）。
- **接口鉴权围栏**——插件 HTTP 路由复用宿主的连接信任检查，未授权请求不会得到数据。

面板共六个页签：免费模型、聚合渠道、白嫖模型接入、管线、观测、对外服务。

## 安装

桌面版：把本目录放进 profile 的 `node_modules/dsh-our-free-model`（例如 `~/.dsh/profiles/desktop/node_modules/`），并在 profile 的 `package.json` 中列出 `dsh-our-free-model`。

命令行：

```bash
dsh plugin add /path/to/our-free-model
```

插件数据写在 `~/.dsh/our-free-model/`（设置与统计）、`~/.dsh/channel-pack/`（账号池与渠道状态）、`~/.dsh/openai-gateway/api-key`（网关密钥）。仓库本身不包含任何账号、Key 或运行时配置。

## 网关接入

1. 打开「对外服务 → 渠道网关」，确认状态为「运行中」，复制端点与 API Key。
2. 客户端 Base URL 填 `http://127.0.0.1:8326/v1`（不要以斜杠结尾，也不要使用 `localhost`，避免解析到 IPv6 回环）。
3. 模型 ID 用面板列出的完整形式，例如 `loomy/GLM-5.3-Flash`、`codearts/glm-5.3-flash`、`our-free-model/deepseek-v4.1-flash-free`。

需要从其它设备访问时，使用网关页下方的「局域网转发（本插件中继）」并设置监听地址与中继密钥。

## 目录结构

```
index.js                 宿主侧：路由、模型运行时、转发/中继/出口代理
client.js                设置页（六页签）与公告组件
src/                     免费车道、聚合渠道、省 Token、路由、网关适配等
adapter/                 宿主内核适配层
locale/                  面板语言包
vendor/channel-pack/     内置渠道包（构建产物）与来源说明
cordis.patch.yml         dsh bundle 配置
```

## 边界

- 免费车道的上游会限流或临时不可用（例如 429 / `Free usage limit reached`），这属于上游策略，不是插件故障。
- 账号渠道的凭据只写入宿主凭据库，界面不会回显明文。
- 本构建不包含应用内升级与远程更新源：升级请直接替换插件目录后重启。

## 许可证与来源

MIT。内置渠道包 `vendor/channel-pack/` 的来源与许可说明见 `vendor/channel-pack/NOTICE.md`。
