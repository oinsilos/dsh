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

## 渠道任务与权益（2.2.0）

白嫖页把渠道包已经具备、但过去没有入口的能力接了出来。全部走渠道包自己的 RPC
（`connection.rpc.call('/api', 'channel-pack', …)`），凭据不经过本插件：

| 能力 | RPC | 覆盖范围 |
| --- | --- | --- |
| 新手任务 / 一次性奖励 | `onboarding.status` / `onboarding.claim` | Loomy 新手任务、Raccoon 桌面端登录奖励（**每号一次**，与每日签到是两件事） |
| 每日签到 | `credits.claimAll` | CodeArts、Buddy、LobsterAI、Qoder / Qoder 中国版、TRAE、Loomy、MiniMax、ZCode |
| 全部渠道一键领取 | `credits.claimAll` × N | 串行跑完上面全部渠道，结果按 `totalByUnit` 把**积分与 Token 分开**汇总 |
| 锁定永久积分 | `credits.permanentLock` | Buddy / WorkBuddy / Loomy（锁定后选号只消耗临期积分） |
| 订阅额度窗口 | `cline.quota` | Cline（各时间窗已用百分比，与「余额」是三份不同读数） |
| 渠道级总开关 | `provider.setEnabled` | 全部渠道：关闭 = 全部模型隐藏 + 全部账号停用 |

显示层同时修了三处会给出**错数**的旧行为：

- 金额按量纲读写：`zcode` 的单位是 Token、`cline` 是美元（两位小数）、`gemini` 是配额百分比。旧版把它们统称「积分」，ZCode 的 `200000` 会显示成 `200000 积分`，Cline 的 `$0.42` 会被取整成 `0`。
- 领取结果读全字段：`alreadyClaimed`（今天已领）与 `inactive`（活动未开启）过去被丢掉，于是「今天已经领过」会被写成「今天没有可领取的积分」。
- 余额明细：`packages`（总/基础/按需/赠送）、`expiredTotal`、`expiredTotal` 之外的 `extra.accountTier`（Gemini 档位）现在都渲染，不再压成一个 `total`。

## 渠道权益扩展（2.3.0）

**扩充渠道或补一项权益，不必改 `vendor/channel-pack/pack.js`。** 宿主已经把两样
东西公开给每个插件：账号池（`ctx.get('accountPool')`，渠道包 `apply()` 的最后一步
`provide` 出来的）与凭据（`ctx.credentials.resolve(ref)`）。新能力就是
`src/channels/` 下的一个模块：读同一个池、同一份凭据，自己发请求，自己的 HTTP
路由，自己的面板折叠。

```js
// src/channels/index.js
const PROVIDERS = {
  codearts: createCodeArtsExtras,   // 加一行就多一家
}
```

已实现：

| 渠道 | 能力 | 数据来源 |
| --- | --- | --- |
| `codearts` | 余额明细（总额/基础/按需/赠送、已用、即将到期）、运营活动列表与领取（含 `confirm` 补发）、模型倍率 | `statistics/plugin`、`/v1/ops/*`、`/v1/model/builtin` |
| `qoder` / `qodercn` | 模型目录与倍率（**先试真、再退实测表**） | `GET {openapi}/algo/api/v2/model/list?Encode=1`；失败时回退 `dsh-connect-qoder` 2026-11-02 实测表，并标 `source: static` |

Qoder 那一路的具体策略（见 [src/channels/qoder.js](src/channels/qoder.js)）：渠道包存的是
**设备 OAuth token**，社区实现用的是 **PAT→cosy 会话**，两套凭据代次不同 —— 所以先用
设备 token 直试目录端点（成功即真倍率），401/403/形状不认识时如实退回实测表，**不猜**。
名字里已带 `· x0.5` 的模型不会再叠一个倍率标签。

**加一家新渠道要写什么**：一个 `create({ credentialOf, fetch })` 返回
`{statusOf(account), claim(account, campaignId)}` 的模块，外加模型路由适配器
（`ctx.llm.registerAdapter`，本仓库的 `src/adapter.js` 与聚合车道就是同一形状）。
前者管权益，后者管推理；渠道包只是这些生产者之一，不是唯一入口。

### 新增的聚合渠道（贴 Key 即用）

`registry.json` 从 76 家扩到 **78 家**，新增两家都是「静态 Key + OpenAI 兼容 + 公开
模型目录」，因此走已有的聚合车道，不需要登录流程：

| 渠道 | Base URL | 凭据 | 目录 |
| --- | --- | --- | --- |
| **ModelScope（魔搭）** | `https://api-inference.modelscope.cn/v1` | `ms-` 前缀的访问令牌 | `GET /v1/models`（会列出已下线的 id，调用时上游回 400） |
| **七牛云 Qiniu** | `https://api.qnaigc.com/v1` | 长期 API Key，无 refresh | `GET /v1/models`（id 混合带命名空间与裸名，**逐字透传**） |

### 本地补丁已合入源码（2026-11-24）

此前这套安装靠 `~/.dsh/our-free-model/apply-ofm-patches.mjs` 在每次插件更新后重打
14 个补丁（CodeArts 签名头/福利路由降级/重试分级、buddy 的 system 降级、`chip.debug`
诊断、client 的输入框积分读数）。**这些补丁现在已逐条固化在本仓库的
`vendor/channel-pack/pack.js` 与 `client.js` 里**（14/14 锚点核对通过），
因此：

- 部署只需复制文件，**不需要再跑补丁脚本**；
- 补丁脚本与备份目录已归档为 `*.archived-20261124`（留着供追溯，不再执行）；
- 前提是 `settings.json` 的 `updateCheckHours` 保持 `0`（插件自更新关闭），
  否则官方版重装会再次覆盖这些改动。

### 渠道包模型表（2026-11-24 直改 pack.js）

`vendor/channel-pack/pack.js` 标着 "Generated — do not edit"，但**仓库里没有
`vendor/channel-pack/src`，也没有 `scripts/build-channel-pack.mjs`** —— 那句话只是
警告，没有重新生成的路径。表都是纯数据数组，所以缺模型只能直接改。

| 表 | 改动 | 原因 |
| --- | --- | --- |
| `RACCOON_FALLBACK_MODELS` | 6 条 → 7 条，**补 `sn-qwen4-max`** | 用户报障「千问4看不到」。上游 2026-11-17 实测目录 7 条；pack 的快照漏了它，也漏了 `sn-kimi-k3-1-pro`，且 deepseek 旧 id 已下架（剥版本号会 404） |
| `ZCODE_FALLBACK_MODELS` | 2 条 → 4 条 | pack 作者因「GLM-5-Turbo / GLM-5.2 实测返回空响应」只放 2 条。用户报障「模型不止」——列出来并标注实测结论，真不可用会回空回复，比看不到好 |
| `QODER_FALLBACK_MODELS` | 补 `fast`；删 `qmodel_latest` / `qmodel` | 上游 CN 与 global 都有 `fast`（0.8 倍，200K）；`qmodel_latest`/`qmodel` 已改名成 `qmodel_38max`/`qfmodel`/`gmodel`，调它们回 400。**其余 14 条倍率一个数字都没动**（`qmodel_38max` 的 0.2 是含夜间活动的生效价，与基础价 0.5 不是同一个量） |

`tests/channel-pack-tables.mjs` 把这三处钉住，同时守住「不许凭印象改倍率」——
逐条断言 16 个 Qoder 模型的 `priceFactor` 等于 pack 原值。

### 自有渠道：本插件自己登录、自己存账号、自己推理

渠道包完全不认识的渠道由**本插件**接管：账号表落在 `~/.dsh/our-free-model/channels.json`
（只存指向凭据的引用），凭据照旧写宿主 `credentials`，ref 名带 `OFM_` 前缀与渠道包的
`CODEARTS_ACCOUNT_*` 命名空间分开。**推理也走本插件**（`src/channels/inference.js`），
模型以 `{渠道}/{模型}` 出现在选择器里。

| 渠道 | 登录 | 权益 | 推理 |
| --- | --- | --- | --- |
| **Codely（Unity）** | 设备码三步（`initiate` → `poll` → `exchange`） | 目录 `/api/model-status`、余额 `/api/user/usage/summary`、签到 `check-in/init` → `check-in` | `codely-litellm` + 每次现换 `sk-` CLI Key + `X-Codely-Signature`（HMAC，密钥内置） |
| **AutoClaw（智谱）** | 手机短信验证码（`agent-send-code` → `agent-login`） | 钱包 `wallets`、签到 `user-info`（**先 `refresh` 制造登录事件**） | 管理头（MD5 签名）+ `X-Authorization` + 模型名走 `X-Request-Model` |
| **Accio（阿里）** | 浏览器 PKCE + 本机 loopback（`client_id=accio-work`） | 目录 `POST /api/llm/config/v2`、积分 `GET /api/entitlement/*`（**无签到端点**） | `/api/adk/llm/generateContent`，Gemini 形请求体 + 响应包成 `candidates` |
| **MiniMax Code 国际版（minimaxintl）** | OAuth 设备码 + PKCE S256（`account.minimax.io/oauth2/device/code` → `/oauth2/token`） | 目录 `GET /mavis/api/v1/models?region=en&buildEnv=prod`、签到 `signin/status` → `signin/claim`（`?timezone_id=` 必填）、积分 `credit/details` | `POST /mavis/api/v1/llm/v1/messages`（**Anthropic Messages 线**，不走 OpenAI 兼容） |

三家都走 `/channels/own/*`，UI 按登录方式分三种：设备码显示「去浏览器确认这个码」、
短信先填手机号再填验证码、浏览器授权直接开授权页（用 `rundll32` 打开，绝不用
`cmd /c start` —— `&` 会被当命令分隔符截断 URL）。

⚠️ **Accio 的模型目录没有兜底表**：它的 `modelCode` 形如 `1Drift-N8kP2Q7wR5mX`，
非人类可读、且按账号下发。拿不到远端目录时这一组不出现 —— 宁可没有，也不列假 id。

另：**AgnesCode** 的目录是**账号级下发**（`{bffBase}/v2/models`，不同订阅档看到不同条目，
bffBase 来自桌面端会话），hub 自己的兜底表都是空的 —— 所以它不能当「贴 Key」的聚合渠道
加，需要先有登录流程。

## 与 `dsh-providers-hub` 的覆盖对照（移植进度）

参考仓库的 `provider-registry` 有 **26 个 provider**。本插件的覆盖情况：

| 状态 | 渠道 |
| --- | --- |
| 已覆盖（渠道包 13 家） | codearts、buddy、workbuddy、lobsterai、qoder、qodercn、trae、cline、loomy、raccoon、minimax、zcode、opencode（+ gemini、kilo） |
| 已覆盖（自有渠道） | codely、autoclaw、autoclawintl、accio、**minimaxintl（0 期）**、**marvis / magicrew / magicrewintl（1 期）** |
| 已覆盖（聚合车道贴 Key） | modelscope、qiniu 及其余 76 家注册表条目 |
| 待移植 | monkeycode / monkeycodeintl、baizhi、doubao、astudio、officeace、agnescode / agnescodeintl |

阶段划分（0–1 已完成，2–4 待做）：

| 期 | 内容 | 状态 |
| --- | --- | --- |
| 0 | `minimaxintl`（设备码 + PKCE + 目录 + 签到 + 推理） | ✅ 已完成，8 组离线断言 |
| 1 | CDP 浏览器驱动 + `marvis`（拦截回调 + UAL 签名 + 钱包）+ `magicrew`×2（JWT 收割 + `mgw_` 签发 + 签到） | ✅ 已完成，驱动 5 组 + marvis 7 组 + magicrew 8 组 |
| 2 | `monkeycode`×2 + `baizhi` | 待做 |
| 3 | `doubao` + `astudio` + `officeace` | 待做 |
| 4 | `agnescode`×2（读桌面客户端登录态） | 待做 |

### 1 期：CDP 浏览器驱动

`src/channels/browser/chromium.js` 是后续所有「网页登录」渠道的地基（magicrew、
monkeycode、doubao、baizhi、officeace 都挂在它上面）：

- 找浏览器（`OFM_CHROMIUM` 覆盖 → Chrome → Edge → Chromium → Brave）；
- 起临时 profile（`--remote-debugging-port=0`，**不污染**用户浏览器）；
- 读 `DevToolsActivePort` → 全局 `WebSocket` 连 CDP（零依赖，不引 puppeteer）；
- 在 `Fetch.requestPaused` 阶段**拦停**回调请求：命中就 `Fetch.fulfillRequest`
  喂静态完成页（请求**不出网**，一次性 code 不会被消费），未命中 `continueRequest`；
- 收尾 `taskkill /T`（Windows 上只杀父进程会留一堆孤儿渲染进程）。

⚠️ 三条踩过的坑（都有测试钉住）：CDP 请求的超时计时器**不能 unref**（否则
「等回调」永远挂着、进程带着未结算的 await 退出）；端口 0 不是可连接端口；
只判路径会把授权页自己带的 `redirect_uri=` 当成已回调。

### 1 期：腾讯 Marvis

| 项 | 值 |
| --- | --- |
| 登录 | 隔离浏览器打开 QQ / 微信授权页，回调被 CDP 拦停，Node 侧带 `Ual-Access-Guid` 换**唯一一次** code |
| 凭据 | 成功是 **302 + Set-Cookie**（`accesstoken` / `openid` / `refreshtoken` / `access_token_expire_time` / `nickname`），缺 refresh 当场报错 |
| 签名 | `/v3/*` 与 `/marvis_client/*`：`md5(query + timestamp + ACCESS_KEY + nonce)`；模型网关**不带**签名头 |
| 续期 | `POST /marvis_client_login/marvis_refresh_token`，`loginType` 恒为 `'Marvis'`；`expires_in` 是**字符串**，-107/-101 判终态 |
| 钱包 | `POST /v3/marvis_get_wallet`，金额是字符串，读不到**不回落 0** |
| 目录 | 单条 `deepseek-v4-pro-external`（真实模型 id 直传会 400） |
| 签到 | **没有**：令牌额度服务端每日发放，面板如实回 `inactive` |

### 1 期：超级麦吉 / MagiCrew（两站一套实现）

| 层 | 寿命 | 用途 |
| --- | --- | --- |
| 网页 JWT | 30 天 | 业务 API（目录 / 积分 / 签到），浏览器登录后从 `localStorage` 读 |
| `mgw_` api_key | **2 小时** | 模型网关（推理） |
| refresh_token | 7 天，一次性轮换 | 换 api_key |

四条硬约束（都有测试钉住）：

1. **签新 key 会吊销旧 key** ⇒ 只在登录与续签两个入口签发，推理热路径绝不签；
2. **`refresh_token` 只有一个出口**（`refreshGatewayKey`），续签走 `PUT` 且**只带
   `refresh_token`、不带 JWT**（JWT 过期时这条腿还得能用）；
3. **`origin` + `referer` 都是硬要求**：只差 `referer: <webOrigin>/` 就是
   `403 空 body ⇄ 200`，漏了的症状是「登录成功但签 key 恒失败」；
4. 两站账号体系物理隔离（host / 网页 / 是否强制 org 都不同）⇒ 两个 provider id。

签到：`POST /api/v1/login-gift`，**请求体存在且为空串**（不是 `{}`）；`granted !== true`
是 `already-claimed`。新手任务在另一个域（`/onboarding/tasks`），`claim('task:<code>')`
走那条腿。积分 `total_points` 认字符串与**负数**（欠费不吞）。

localStorage 收割的判据：六个键**一次取完**、jwt 与 org **同前缀配对**
（错配在上游是 HTTP 200 + `code:403`，看起来像密钥坏）。

### 0 期顺带修掉的三条协议缺陷

这三条是「自有渠道目录看得见、一发就失败」的根因，任何一家自有渠道都受影响：

1. **`ownCredential` 从来没接线**：`createModelRuntime` 的默认实现是 `async () => null`，
   于是自有渠道的每回合都以「凭据不可用」结束。现在入口注入 `ownCredentialFor`：
   现解析账号 → 过期就地续期（按渠道登记）→ 续上了才回写账号表。
2. **模型名带着路由前缀发上游**：`payload.model` 用的是 `entry.id`
   （`minimaxintl/MiniMax-M3`），而供应商只认裸 id。自有渠道与聚合车道现在发
   `entry.modelId`；免费车道/EAC/Kilo 不受影响（它们的 id 本身就是上游 id）。
3. **自有渠道的 `wire` 声明被吞掉**：`wireOf()` 对自有行走的是免费车道的
   `wireFor(id)`，于是声明成 `messages` 的渠道仍按 `chat` 发。现在自有行按
   `entry.wire ?? 'chat'` 分派 —— MiniMax 的 Anthropic Messages 线因此才通。

### 安装不被覆盖

profile 里这份插件的依赖必须是 `link:`（指向本仓库），不能用 npm 版本范围：

```bash
dsh plugin --profile desktop add "link:D:/Desktop/dsh插件/work/our-free-model"
node scripts/check-install-drift.mjs     # linked / ok / drift
```

`node_modules/dsh-our-free-model` 是 junction 时，改动即刻生效、任何一次
「安装/升级」都无法回滚本地补丁；脚本是这条保证的探针。

> 移植进度与接续说明（每家的硬判据、还缺什么、下一个动作）见 [docs/PORT-STATUS.md](docs/PORT-STATUS.md)。

## 测试

不打网络、不需要 DSH 壳：

```bash
node tests/amount-helpers.mjs     # 金额/单位格式化（从 client.js 抽真源码断言）
node tests/i18n-keys.mjs          # 中英双语键值一一对应、无漏键
node tests/codearts-ops.mjs       # 华为签名、活动/余额解析、领取 + confirm + 40001
node tests/channel-extras.mjs     # Qoder 目录（先试真/退实测表）+ 新聚合渠道的注册表完整性
node tests/codely-channel.mjs     # Codely：字符串点数、两段签到、设备码三步、账号表
node tests/autoclaw-channel.mjs   # AutoClaw：管理头签名、钱包严格 display、先 refresh 再签到
node tests/accio-channel.mjs      # Accio：三个端点各自的传参方式、NOT_LOGIN 判定、无兜底表
node tests/minimax-channel.mjs    # MiniMax 国际版：设备码/PKCE、令牌三查、签到信封、claim 幂等、目录归一、续期
node tests/own-inference.mjs      # 推理腿：三家协议 + 帧归一化 + 目录行
node tests/channel-pack-tables.mjs # 渠道包三张模型表（Qoder/ZCode/Raccoon），守住倍率不被乱改
node tests/channels-smoke.mjs     # 用极小 React 替身把白嫖页整页渲染一遍
```

合起来即 `pnpm test:client`。冒烟测试里的替身 React 只保证挂载期渲染与「点击 →
发请求」的契约，点击后的异步再渲染由真壳的 React 负责；故它对折叠内容断言的是
**请求契约**，数据语义交给前三个脚本。

## 已知差异（对照上游实现，2.2.0）

本插件的 13 个渠道来自 `vendor/channel-pack` 的一份快照，与各产品自己的 DSH 插件
（`dsh-codearts`、`dsh-connect-qoder`、`dsh-providers-hub`）比对后，仍有三处落后：

- **CodeArts 没有倍率，也少了两个发现源**：快照只用 `gateway/config` 与
  `snap /v1/model/builtin` 两条端点，解析时只留 `model_id/model_name`，把同一份响应里的
  `credit[].ratio_display`（倍率）、`context_window`、`supports_images` 全部丢弃，并主动过滤
  `-VL-` 模型；窗口读的是 5 条硬编码静态表。上游 `dsh-codearts` 从 `credit[].ratio_display`
  读倍率、走 agent-center/第三方四路发现，`dsh-providers-hub` 实测证明窗口只在
  agent-center 下发。
  **本插件侧的进展（2.3.0）**：倍率与活动领取已在 `src/channels/codearts.js` 补齐，
  面板「活动」折叠与模型行的倍率标签都走这里；**DSH 选择器里仍没有倍率**（那由渠道
  包的适配器名字决定），四路发现源与静态窗口也仍缺 —— 这两项要重建快照。
- **Qoder / Qoder 中国版的模型目录是静态表**：快照注释称「模型列表端点需要 WASM 签名，
  本插件不实现」，而上游 `dsh-connect-qoder` 用纯 TypeScript 的 cosy 签名（`node:crypto`）
  就能拉 `/algo/api/v2/model/list?Encode=1` 并读取 `price_factor` 与促销显示倍率。
- **每日自动签到默认开启**：默认值来自渠道包（`enabled: true`），不是本插件的选择；
  页面上已加提示，需要关闭请用「每日自动签到」开关。

这三条都要改 `vendor/channel-pack/pack.js`（生成产物，标注 do not edit），因此需要重建
快照或等上游渠道包更新；本插件这一侧只能把已有数据如实展示。

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
