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
模型以 `{渠道}/{模型}` 出现在选择器里，并且**按渠道分组**（豆包 / Codely / AStudio …
各自一组，不和免费车道混在一起）。每组的模型可在面板「模型」折叠里单独开关，
渠道也能整组关闭（关闭 = 隐藏全部模型 + 停用全部账号）。

模型列表**永远有一份较新的预制表**：能拉到上游最新目录就整表替换（面板标
「实时目录」），拉不到就继续显示预制表并把原因写在「预制目录」的悬停里；
倍率（如豆包的 `0.65x`）直接显示在模型行里。

| 渠道 | 登录 | 权益 | 推理 |
| --- | --- | --- | --- |
| **Codely（Unity）** | 设备码三步（`initiate` → `poll` → `exchange`） | 目录 `/api/model-status`、余额 `/api/user/usage/summary`、签到 `check-in/init` → `check-in` | `codely-litellm` + 每次现换 `sk-` CLI Key + `X-Codely-Signature`（HMAC，密钥内置） |
| **AutoClaw（智谱）** | 手机短信验证码（`agent-send-code` → `agent-login`） | 钱包 `wallets`、签到 `user-info`（**先 `refresh` 制造登录事件**） | 管理头（MD5 签名）+ `X-Authorization` + 模型名走 `X-Request-Model` |
| **Accio（阿里）** | 浏览器 PKCE + 本机 loopback（`client_id=accio-work`） | 目录 `POST /api/llm/config/v2`、积分 `GET /api/entitlement/*`（**无签到端点**） | `/api/adk/llm/generateContent`，Gemini 形请求体 + 响应包成 `candidates` |
| **MiniMax Code 国际版（minimaxintl）** | OAuth 设备码 + PKCE S256（`account.minimax.io/oauth2/device/code` → `/oauth2/token`） | 目录 `GET /mavis/api/v1/models?region=en&buildEnv=prod`、签到 `signin/status` → `signin/claim`（`?timezone_id=` 必填）、积分 `credit/details` | `POST /mavis/api/v1/llm/v1/messages`（**Anthropic Messages 线**，不走 OpenAI 兼容） |

同一渠道的**多个账号会轮换使用**（按账号表顺序，跳过没有凭据的占位行）；
令牌只在「快过期」或用户点「续期」时才续，续上了立刻回写账号表。支持续期的
九家：Codely / MiniMax 国际版 / Marvis / OfficeAce / 超级麦吉×2 / AutoClaw×2 / Accio。

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
| 已覆盖（自有渠道） | codely、autoclaw、autoclawintl、accio、**minimaxintl（0 期）**、**marvis / magicrew / magicrewintl（1 期）**、**monkeycode×2 / baizhi（2 期）**、**doubao / astudio / officeace（3 期）** —— 共 14 家 |
| 已覆盖（聚合车道贴 Key） | modelscope、qiniu 及其余 76 家注册表条目 |
| 已接入 | agnescode / agnescodeintl（读取桌面客户端登录态，目录按订阅档下发） |

阶段划分（0–3 已完成，4 待做）：

| 期 | 内容 | 状态 |
| --- | --- | --- |
| 0 | `minimaxintl`（设备码 + PKCE + 目录 + 签到 + 推理） | ✅ 已完成，8 组离线断言 |
| 1 | CDP 浏览器驱动 + `marvis`（拦截回调 + UAL 签名 + 钱包）+ `magicrew`×2（JWT 收割 + `mgw_` 签发 + 签到） | ✅ 已完成，驱动 5 组 + marvis 7 组 + magicrew 8 组 |
| 2 | `monkeycode`×2 + `baizhi` | ✅ 已完成，monkeycode 6 组 + baizhi 4 组 |
| 3 | `doubao` + `astudio` + `officeace` | ✅ 已完成，doubao 8 组（astudio / officeace 的登录腿状态见 docs/PORT-STATUS.md） |
| 4 | `agnescode`×2（读桌面客户端登录态） | 已完成（国内站真机验证） |

### 渠道总表：面板上 27 张卡片从哪来

「渠道现在是 26 个」这类疑问的答案在这张表里 —— 面板的卡片**不是**一份手写清单，
它是两层拼起来的，而且**宿主进程与面板是两份代码**：

| 层 | 数量 | 谁提供登录 | 谁提供模型 | 面板折叠 |
| --- | --- | --- | --- | --- |
| 渠道包（`vendor/channel-pack/pack.js`） | 13 | 渠道包（`account.create` / `login.poll`） | 渠道包 adapter | `credits.*` RPC |
| 本插件自有（`src/channels/*`） | 14 | 本插件（`/channels/own/*`） | 本插件 `inference.js` | `/channels/extra` |
| 聚合车道（贴 Key） | 注册表 78 家 | 用户自己贴 | 远端 `/models` | —— |

自有 14 家逐条：

| id | 登录 | 权益 | 模型线 |
| --- | --- | --- | --- |
| `codely` | 设备码 | 签到 + 积分 | OpenAI 形 |
| `autoclaw` / `autoclawintl` | 手机短信 | 签到（refresh 造登录事件） | OpenAI 形 |
| `accio` | 浏览器 PKCE（loopback） | 无签到，只有额度 | Gemini 形 |
| `minimaxintl` | 设备码 + PKCE | 签到 + 积分 | Anthropic Messages |
| `marvis` | 浏览器拦回调（QQ / 微信） | 无签到，钱包只读 | OpenAI 形 |
| `magicrew` / `magicrewintl` | 浏览器读 localStorage | 签到 + 积分 | OpenAI 形 |
| `monkeycode` / `monkeycodeintl` | 浏览器读 HttpOnly cookie | 签到（过 Cap PoW） | OpenAI 形 |
| `baizhi` | 浏览器控制台 → `sk-` | 每日临时积分 | Anthropic 兼容 |
| `officeace` | 浏览器 OAuth + DPoP | 无签到 | OpenAI 形 |
| `doubao` | 浏览器页面扫码 | 签到（页面 `bdms` 签名）+ 活动额度 | 自定义帧（16 个模型） |
| `astudio` | 微信扫码（SSO 三段，无浏览器） | 每日奖励弹窗 + 积分 | OpenAI Responses |

⚠️ **宿主进程与面板是两份代码**：`client.js` 每次打开面板都从磁盘读（所以永远是新的），
而宿主 `index.js` 只在**插件加载时**读一次。插件更新后没重载时，就会出现
「面板有 27 张卡片、宿主只认识 24 个」——那几张新卡片的「添加账号」点了不会有反应。
现在面板会拿 `GET /channels/manifest` 与宿主对账，缺谁就点名，并给一个**热重载插件**按钮
（`POST /reload`）。重载后页面会自动刷新；也可以直接重启 DSH。

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

⚠️ `Fetch` 域**默认不开**（`intercept: false`）：一旦 `Fetch.enable` 覆盖 `*`，
页面每个请求都停在 `requestPaused` 等人放行 —— 没人放行的会话就是一个白屏窗口。
只有真要拦回调的两家（Marvis / OfficeAce）传 `intercept: true`；豆包、超级麦吉、
MonkeyCode、百智云的登录页必须能正常加载，用户才扫得到码/点得到按钮。
签到那种「只要页面能跑」的会话用 `headless: true`（`--headless=new`），登录**不能**无头。

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

### 3 期：豆包（签到/额度渠道）

| 项 | 值 |
| --- | --- |
| 登录 | 宿主起隔离浏览器打开 `www.doubao.com/chat/`，页面内二维码扫码；判据 = `.doubao.com` 出现 `sessionid` **且** `window.bdms.frontierSign` 已就绪（后者冷启动要 15–20 秒） |
| 鉴权 | **纯 cookie**（`sessionid` / `sid_tt` / `ttwid`），没有 `Authorization` |
| 签名 | query 的 **`a_bogus`**，由页面上下文 `bdms.frontierSign({'X-MS-STUB': ''})` → `{'X-Bogus': …}` 产出；值里带 `/`，进 URL 必须编码 |
| 签到 | `POST /alice/ug/campaign/landing/checkin`，body `{"scene":"pc_incentive_task_mvp_v3"}`；要签名 ⇒ 起一次**无头**浏览器；幂等 |
| 状态 | `POST /alice/ug/campaign/landing/get`，免签名，**不能**用来短路签到（已签账号也回空活动） |
| 额度 | `POST /alice/commerce/sale/subscription/quota/summary/`，免签名；金额是千分位字符串、`"<1"` 要单独解析 |
| 设备身份 | `accountKey`（= `sessionid`）SHA-256 派生**每账号一套** 19 位数字；`s_v_web_id`/`ttwid` 是预验证 id，不算设备号 |
| 模型 | `POST /chat/completion`：请求体整体由本插件组装（`mode=1`+`agent_mode=2` 对话 / `mode=3`+`agent_mode=1` 工作任务），响应是自定义帧（`id:/event:/data:`），由翻译器转成 OpenAI chunk；目录 `POST /alice/slot/action_bar_v3/brief_list` 真机回 16 个模型，兜底表同源 |

三条实测判据（都有离线断言）：

1. `710010702` 是**没有可领活动**（`inactive`），不是「系统错误」；
2. `710012001` 是**登录态失效**，文案必须指去重新登录；
3. `idempotent:true` 在首次成功时也是 true ⇒ 「本次是否真领到」只能看 `reward_amount > 0`。

### 3 期：AStudio（微信扫码）

| 项 | 值 |
| --- | --- |
| 登录 | 微信扫码，**不需要浏览器**：`fd`（客户端自生成的 8 位串）→ `GET {sso}/SSOService/wx/scanlogin/qrcode` → 轮询 `…/uids` → `…/bind` |
| 凭据 | 四字段 Cookie `ssoSessionId=…; sso_sessionid=…; account_id=…; token=…`，再 `init-app` → `userInfo` → `bot/models/configs` 换 `modelBearerToken` |
| 二维码 | 宿主把二维码图片**内联成 data URL** 再交给面板（`dsh-app://` 渲染进程里外链图可能被策略挡掉） |
| 额度 | `GET {auth}/points/balance`，权威字段 **`totalBalance`**（不是逐包求和） |
| 签到 | 弹窗语义：`GET /client-popups/pending` 找 `DAILY_REWARD_DIALOG` → `POST /client-popups/complete`（`{popupId, instanceKey}`）；**没弹窗 = 今天已领** |
| 推理 | `POST {maas}/model-gateway/v1/responses`（Responses 线；`/chat/completions` 恒 404） |

三条判据：

1. `code:-1` = 未扫码；`code:0` + **空 `infoList`** = 该微信没开通 AStudio（重扫同一号仍是空 ⇒ 必须去客户端绑手机号）；
2. `80000`（含 1002 / 1005）= 会话失效 ⇒ 文案指去重新扫码，不当网络故障重试；
3. 额度/签到两条腿必须带 `clientType` / `studioVersion`（版本串是上游下发内容的判据）。

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
node tests/doubao-channel.mjs     # 豆包：设备身份派生、a_bogus 表达式（真跑一遍）、签到分类、额度解析、领取全链路
node tests/astudio-login.mjs      # AStudio：SSO 扫码三段、四字段 Cookie、补全凭据、额度、弹窗签到
node tests/channel-manifest.mjs   # 渠道清单对账：面板卡片 == 宿主账号表（少一条就是「添加账号没反应」）
node tests/doubao-inference.mjs   # 豆包推理腿：目录树解析、请求体路由（conversation_mode 字符串坑）、帧翻译
node tests/pending-accounts.mjs   # 占位账号：没凭据 = 待登录（不是「查询失败」），启动时清掉
node tests/channels-smoke.mjs     # 用极小 React 替身把白嫖页整页渲染一遍
```

合起来即 `pnpm test:client`。冒烟测试里的替身 React 只保证挂载期渲染与「点击 →
发请求」的契约，点击后的异步再渲染由真壳的 React 负责；故它对折叠内容断言的是
**请求契约**，数据语义交给前三个脚本。

## 与 `dsh-providers-hub` 的缺口对照（2026-11-25）

渠道包来自早前快照；参考实现 `dsh-providers-hub` 同时装在本机，可直接对照。本轮已补：

| 能力 | 上游做法 | 本插件现状 |
| --- | --- | --- |
| Qoder 真目录 | WASM `prepareRequest` 打 `/api/v2/model/list?Encode=1`，响应并 `chat` ∪ `app` 场景 | ✅ 已实现（`src/channels/qoder-catalog.js` + 渠道包）；真机选择器 14 条，含 Qwen4-Max / Fast / GLM-5.4 / Step-5-Preview |
| Qoder 目录缓存 | 拉到的表落盘，下次离线直接用新表 | ✅ `~/.dsh/our-free-model/qoder-catalog-<provider>.json`，每次成功覆写；CN 静态表也按 11-25 远端实拉重写 |
| Qoder 倍率 | `price_factor` + `promotion` 时段 | ✅ 名称带 ` · x0.4` / `x0.5→x0.2` |
| CodeArts 倍率 | `credit[].ratio_display`（按时段选生效档） | ✅ 选择器名称带 ` · x0.08`；面板与选择器共用 `src/channels/codearts-catalog.js` |
| CodeArts 窗口 | AgentCenter 动态值 > builtin `context` > 静态表 | ✅ 两层远端已接（builtin `context` + AgentCenter 两步签名） |
| CodeArts 介绍 | `model_desc` 原样透传 | ✅ |
| CodeArts 原始 id | 不裁 `-1017` 日期后缀 | ✅（选择器 12 条，旧版/新版并存） |

仍缺（已登记）：

- **CodeArts 图片输入**：适配器仍只声明 `text` —— 它的 stream 会把图片投影成文本，声明 `image` 会让图**静默丢失**；要补的是 wire 形态与逐模型模态（hub 已做）。
- **CodeArts 仅 AgentCenter 出现的模型**：只作窗口源、不进目录（与 hub 同取舍）。
- **OfficeAce 倍率**：需要 `/v1/model-token-rates` 的 V11 签名，未接。
- **AgnesCode 倍率**：解析已支持 `points_cost_multiplier`，但本机账号的 `/models` 响应里**没有该字段**（2026-11-25 实测 9 条，键全集不含倍率），上游不发就不显示（不臆造）。
- **每日自动签到默认开启**：默认值来自渠道包（`enabled: true`），不是本插件的选择；页面上已加提示，需要关闭请用「每日自动签到」开关。

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

## 交接与现状

接手/回顾请看 **docs/HANDOVER.md**：现状、下一步、逐条判据与命令速查；过程记录在 docs/PORT-STATUS.md。

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
