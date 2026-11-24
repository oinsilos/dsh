# 交接文件：dsh-our-free-model（2026-11-24 21:40）

> 给下一位接手的人：看完这份就能接着干。**判据优先于叙事** —— 每条结论都标了它的
> 证据与守卫测试，别凭印象改。过程记录在 `docs/PORT-STATUS.md`，这份是"现在在哪儿、
> 下一步怎么走"。

---

## 0. 一句话现状

0–3 期移植**全部落地**（13 家渠道包 + 14 家自有渠道 = 面板 27 张卡片），
自有渠道的**登录 / 凭据 / 目录 / 权益 / 推理**五条腿都已接通；其中
**astudio（微信扫码）与 doubao（目录+推理）是本机真机验证过的**。
自有渠道 16 家（新增 AgnesCode ×2，国内站已真机验证）。
**25 个离线测试全绿**，代码**尚未提交 git**。

> 2026-11-24 晚补完：自有渠道的**模型显示与账号**不再停留在「能看」——
> 选择器按渠道分组（不再混进免费车道）、模型开关/渠道开关真正落盘、
> 推理多账号轮换、六家渠道接上续期。见 §10。

---

## 1. 环境事实（照抄即可，别猜）

| 项 | 值 |
| --- | --- |
| 仓库 | `D:\Desktop\dsh插件\work\our-free-model`（git 分支 `main`，HEAD `b0c6611`） |
| 安装方式 | `~/.dsh/profiles/desktop/node_modules/dsh-our-free-model` = **junction** 指向上面的仓库（2026-11-24 18:17 建） |
| 漂移探针 | `node scripts/check-install-drift.mjs` → 必须是 `linked → ok` |
| 插件数据 | `~/.dsh/our-free-model/`：`settings.json`（设置）、`channels.json`（自有渠道账号表）、`catalog.json`（目录快照）、`own-catalog.log`（链路诊断，**排查必看**） |
| 凭据库 | `~/.dsh/.credentials.yaml`：渠道包用 `CODEARTS_ACCOUNT_*` 等，本插件自有渠道用 `OFM_<PROVIDER>_ACCOUNT_<hex>` |
| 宿主 | DSH 桌面版（Electron）。**插件代码只在加载时读一次** ⇒ 改完必须"重载插件"或重启，面板每次都从磁盘读（所以面板永远是新界面） |
| 测试 | `npm run test:client`（22 步）；`tests/` 下共 **25** 个文件，另两个单独跑：`node tests/monkeycode-channel.mjs`、`node tests/officeace-auth.mjs` |
| 真机参考实现 | `D:\Desktop\dsh插件\_refs\dsh-providers-hub-master\`（TS，逐条实测笔记在 `docs/agent-notes/providers-*.md`）——**移植前先读对应笔记** |
| 桌面可视化 | MCP `desktop-touch`（截图/UIA/CDP）。⚠️ DSH 面板在 Electron 渲染进程里，UIA 读不到（UIA-blind），web GUI 需要 token ⇒ **验证走真实 HTTP 接口 + 离线测试**，比截屏更硬 |

---

## 2. 插件逻辑总览（先看这张，后面都是细节）

面板那一页（"白嫖模型接入"）的 27 张卡片来自**两层**，且宿主与面板是**两份代码**：

| 层 | 数量 | 登录谁做 | 模型谁做 | 权益/活动 |
| --- | --- | --- | --- | --- |
| 渠道包 `vendor/channel-pack/pack.js` | 13 | 渠道包（`account.create` / `login.poll`） | 渠道包 adapter | 渠道包 `credits.*` RPC |
| 本插件自有 `src/channels/*` | 14 | 本插件 `/channels/own/*` | 本插件 `inference.js` | 本插件 `/channels/extra` |
| 聚合车道（贴 Key） | 78 家注册表 | 用户自贴 | 远端 `/models` | —— |

四层职责：

```
index.js                 宿主：路由 / 模型运行时 / 转发·中继·出口 / 浏览器登录编排
  src/channels/*.js      每家渠道的协议（登录 → 凭据 → 目录 → 权益 → 推理）
  src/channels/index.js  权益扩展注册表（statusOf / claim）+ pending 判定
  src/channels/inference.js  自有渠道推理：LANES（URL/头/体）+ 帧归一化成 OpenAI chunk
  src/channels/catalog.js    自有渠道的目录行（供选择器与网关）
  src/channels/manifest.js   **渠道清单唯一事实源**（面板对账用）
client.js                面板（六页签；渠道卡片、登录弹窗、活动折叠、热重载按钮）
```

三条关键机制（**改之前必须知道**）：

1. **面板 ↔ 宿主对账**：`GET /channels/manifest?expect=<面板渲染的自有渠道>` 由宿主算
   `missing`；面板缺谁点名 + 给"热重载插件"按钮。判据是**行为级**（宿主认不认这个 id），
   不是版本号比对。
2. **自有渠道的一切请求都走本插件自己的路由**：余额/额度 → `/channels/extra`；
   领取 → `/channels/extra/claim`（逐账号）；账号列表/删除/启停 → `/channels/own`、
   `/channels/own/remove`、`/channels/own/update`。**不许**再打渠道包的 `credits.balances`
   / `claimAll` / `account.*`（它们不认识这些 provider，回 `unsupported provider`）。
3. **没有凭据 = `pending`（待登录）**，不是错误：`channels/index.js` 入口就短路，
   一个上游请求都不发；宿主启动时 `accounts.prunePending()` 把"永远等不到凭据"的
   占位行清掉。

---

## 3. 自有 14 家一览（现状）

| id | 登录 | 凭据 | 权益 | 模型线 | 守卫 |
| --- | --- | --- | --- | --- | --- |
| `codely` | 设备码三步 | `access_token` + 现换 `sk-` | 签到 + 积分 | OpenAI 形 | `codely-channel` |
| `autoclaw` / `autoclawintl` | 手机短信 | `X-Authorization` 管理头 | 签到（refresh 造登录事件） | OpenAI 形 | `autoclaw-channel` |
| `accio` | 浏览器 PKCE（loopback，**宿主用 rundll32 打开**） | `access_token`/`refresh_token` | 无签到，只额度 | Gemini 形 | `accio-channel` |
| `minimaxintl` | 设备码 + PKCE | OAuth | 签到 + 积分 | Anthropic Messages | `minimax-channel` |
| `marvis` | 浏览器拦回调（QQ/微信） | `accesstoken`+`refreshtoken` | 钱包只读、无签到 | OpenAI 形 | `marvis-channel` |
| `magicrew` / `magicrewintl` | 浏览器读 localStorage | JWT + `mgw_` + refresh | 签到 + 积分 | OpenAI 形 | `magicrew-channel` |
| `monkeycode` / `monkeycodeintl` | 浏览器读 HttpOnly cookie | 三件套 | 签到（过 Cap PoW） | OpenAI 形 | `monkeycode-channel` |
| `baizhi` | 浏览器控制台 → `sk-` | cookie + `api_key` | 每日临时积分 | Anthropic 兼容 | `baizhi-channel` |
| `officeace` | 浏览器 OAuth + DPoP | `access_token` + 私钥 JWK | 无签到 | OpenAI 形 | `officeace-auth` |
| `astudio` | **微信扫码**（SSO 三段，无浏览器） | 四字段 Cookie + `modelBearerToken` | 每日奖励弹窗 + 积分 | OpenAI **Responses** | `astudio-login` |
| `doubao` | 浏览器页面扫码（`sessionid` + `bdms` 就绪才算完） | cookie + `accountKey` | 签到（页面 `bdms` 签名）+ 活动额度 | **自定义帧**（16 个模型） | `doubao-channel` + `doubao-inference` |

自有渠道目录行现状（`buildOwnCatalog({})`）：共 **100** 行 —— doubao 16、baizhi
**16**（新增预制表）、codely 8、magicrew×2 8+8、monkeycode×2 8+8、astudio 7、
officeace **8**（改为直接引用模块内置表；旧的手抄版只有 4 条）、autoclaw×2 4+4、
minimaxintl 4、marvis 1、**accio 0**（modelCode 按账号下发、刻意为空）。
远端目录成功时以远端为准（面板标「实时目录」），失败时保留预制表并标「预制目录」。

---

## 4. 本轮（2026-11-24）做完的四件事

1. **豆包接线**：登录（页面扫码 → `sessionid` + `bdms` 就绪）→ 签到（`a_bogus` 页面签名，
   无头浏览器）→ 额度/状态腿 → **目录 + 推理**。
2. **AStudio**：微信扫码三段 + 二维码内联成 data URL + 额度 + 弹窗式签到 + 面板卡片。
3. **渠道清单**：`manifest.js` + `/channels/manifest` + 面板红条 + 热重载按钮；
   `tests/channel-manifest.mjs` 把"面板卡片 == 宿主账号表"钉成集合相等。
4. **面板三条腿归位**：余额/领取/账号增删全走自己的路由；占位账号 → `pending`。

### 真机验证记录（可复现，命令见 §8）

| 项 | 结果 |
| --- | --- |
| 豆包 `brief_list` | 200 / `code:0`，33 个 `model_item_key` → 去重 **16 个模型** |
| 豆包 `quota` / 签到状态 | 200 / `code:0` |
| 豆包 `/chat/completion`（对话线 `0`、工作任务线 `5`、带档位 `person-deepseek-v4-1-flash-261017`） | 三发**都出正文**（如"我是豆包。一，二，三。"） |
| 豆包签名表达式 | 真页面 `bdms.frontierSign({'X-MS-STUB':''})` → `{'X-Bogus': …}` |
| AStudio `qrcode` / `uids` | 真二维码 ticket；未扫回 `code:-1` |
| AStudio 假 cookie 打控制面 | `80000` → 文案指向"重新扫码" |

---

## 5. 未提交的改动（25 改 + 8 新，约 +3400 行）

```
改：README.md  client.js  docs/PORT-STATUS.md  index.js  package.json
    src/adapter.js  src/core/{completion,runtime}.js
    src/channels/{accio,accounts,astudio,autoclaw,browser/chromium,catalog,codely,
                  device-login,doubao,index,inference,officeace,officeace-auth,sms-login}.js
    tests/{accio-channel,channels-smoke,officeace-auth}.mjs
新：src/channels/{manifest,select}.js
    tests/{astudio-login,channel-manifest,doubao-channel,doubao-inference,pending-accounts,own-controls}.mjs
```

提交前清单：
1. `npm run test:client`（22 步全绿）+ 两个单独测试 + `node scripts/check-install-drift.mjs`
2. 检查有无残留 `*.tmp.mjs`（本轮探针已删）
3. 建议按主题拆提交：
   `feat: doubao/astudio 接线 + 渠道清单对账 + 占位账号语义`
   `feat: 自有渠道按渠道分组 + 模型/渠道开关 + 多账号轮换与续期`

---

## 6. 下一步（按优先级）

### ① AgnesCode ×2（**已接入**，国内站真机跑通）
- 登录态只存在于桌面客户端：`%APPDATA%\AgnesCode\code-auth-session.cn.v1`（国内站）
  / `code-auth-session.v1`（国际站候选名）。`v10` + AES-256-GCM，密钥来自
  `Local State` 的 `os_crypt.encrypted_key`（DPAPI CurrentUser，PowerShell 现解）。
- 面板「添加账号」= 读一次客户端会话（`POST /channels/own/import`）；「续期」= 再读一次。
- 目录：`{bffBase}/models`（账号级下发，**无静态兜底**）；推理：
  `{bffBase}/chat/completions`（OpenAI 兼容，`reasoning_content` 由通用 parser 接住）。
- 红线：`bffBase` 每账号下发，必须 https + `*.agnes-ai.cn` / `*.agnes-ai.com`。
- 实测（2026-11-25）：国内站账号「沆瀣」→ 9 个模型，`agnes-3.0-flash` 真出正文
  「收到」（reasoning 181 字符）；选择器出现 **AgnesCode 9**。
- 国际站：代码同一套，但本机没有国际版客户端的会话文件 ⇒ 面板显示「未接入」，
  登录一次国际版客户端后点「添加账号」即可。


### ② 已有渠道的"更好的实现"（按严重度）
qoder 真目录/倍率（需 cosy 签名或 WASM）> codearts 推理 UA 覆盖 + 上下文窗口（IDE 日志）
> raccoon 浏览器授权链（扫码页已 404）> zcode 3012 版本×身份块同代 > minimax 传输重试
> cline 目录 O(N²) > loomy 冷却 UTC+8 24:00 > trae 4006 → `CONTEXT_WINDOW_EXCEEDED`

### ③ 豆包的未取证项
签到状态腿（`landing/get`）实测 200/`code:0` 但报文里**没读到布尔位** ⇒ 现在对字段
宽容读取、读不到回"不知道"（面板按"可领"呈现，签到本身幂等）。拿到真实响应后补判据。

---

## 7. 坑与判据（**这些是踩出来的，别再改回去**）

### 宿主 vs 面板
1. **插件代码只在加载时读一次**：面板新、宿主旧时会表现为"新卡片点添加账号没反应"。
   排查第一站：`~/.dsh/our-free-model/own-catalog.log` 最后一条 `sync-begin` 后面跟了
   几个 `provider` 行 —— 少于 `OWN_PROVIDERS.length` 就是宿主没重载。
2. 面板对账必须由**宿主**算（`missingFromHost`），面板别抄第二份规则。
   取清单失败（旧宿主没有这条路由）**也要报警**并给重载按钮。

### 浏览器驱动（`src/channels/browser/chromium.js`）
3. `Fetch` 域**默认不开**：`intercept: true` 只在真要拦回调时用（marvis / officeace）。
   开了却没人放行 = 白屏窗口（曾经 5 家网页登录全白屏）。
4. `headless: true` 只给"不需要用户看"的会话（豆包签到的签名环境）；**登录不能无头**。
5. CDP 超时计时器**不许 unref**（否则"等回调"永远挂着）。

### 自有渠道请求路由
6. 余额/领取/账号增删**只能**走本插件路由；打渠道包会回 `unsupported provider`
   （→ 空卡片上画红字，用户报障"都没登账号还提示余额查询失败"）。
7. 没凭据 = `pending`，不是 error；启动清理占位行。
8. 自有渠道的「测速 / 刷新凭据」**不渲染按钮**（没有那两条腿）。

### 豆包
9. 签名在 **query 的 `a_bogus`**（页面 `bdms.frontierSign`），Node 侧裸调恒 `710010702`。
10. `710010702` = 没有可领活动（`inactive`），不是系统错误；`710012001` = 登录态失效。
11. `idempotent:true` 在**首次成功**时也是 true ⇒ "本次是否真领到"只看 `reward_amount > 0`。
12. 推理两条坑（都实测）：`aggregate_params.conversation_mode` **必须是字符串**；
    prompt 角色分隔符必须是 ` user: ` / ` assistant: `（中文冒号 → `710020202`）。
13. 帧是 `id:/event:/data:`，**事件名有意义**（正文在 `STREAM_CHUNK`/`CHUNK_DELTA`）⇒
    通用 `readSse` 会丢；`10040` 头下面的 `10000` 块是**思考**不是正文；
    `FULL_MSG_NOTIFY` 回显用户消息（`user_type:1`）必须跳过。
14. 设备身份由 `accountKey`（= `sessionid`）派生 19 位数字；`s_v_web_id`/`ttwid` 是
    预验证 id，**不能**当设备号。

### AStudio
15. `code:-1` = 未扫码；`code:0` + **空 `infoList`** = 该微信没开通账号（重扫同一号仍是空，
    必须去客户端绑手机号）—— 文案要指这条路，不然用户反复扫。
16. `80000 / 1002 / 1005` = 会话失效（指去重新扫码）；额度权威字段 **`totalBalance`**；
    签到是**弹窗**语义（`DAILY_REWARD_DIALOG` → `complete`），没弹窗 = 今天已领。
17. 额度/签到必须带 `clientType:21` + `studioVersion:3.6.4`（版本串是上游下发内容的判据）。

### 其它
18. Accio 登录必须由**宿主**用 `rundll32 url.dll,FileProtocolHandler` 打开
    （`cmd /c start` 会把 `&` 当命令分隔符截断 URL；面板 `window.open` 会被桌面壳拦）。
    loopback 端口**落定即关**。
19. 离线测试里凡是"真跑一遍"能验的，别只比源码文本（`if (false)` 短路挡不住）。
    Windows 上 `process.exit()` 前要等句柄收尾，否则 libuv 断言。

---

## 8. 命令速查

```bash
# 全量离线测试（22 步）
npm run test:client
node tests/monkeycode-channel.mjs && node tests/officeace-auth.mjs
node scripts/check-install-drift.mjs          # 必须是 linked → ok

# 只看某一家
node tests/doubao-inference.mjs    # 目录解析 / 请求体路由 / 帧翻译
node tests/astudio-login.mjs       # 扫码三段 / 四字段 Cookie / 弹窗签到
node tests/pending-accounts.mjs    # 占位账号语义
node tests/channel-manifest.mjs    # 面板卡片 == 宿主账号表
node tests/own-controls.mjs        # 模型开关/渠道开关/账号轮换/续期/选择器分组

# 宿主没重载时（面板会显示红条 + 热重载按钮）；或直接重启 DSH
# 面板 → 白嫖模型接入 → 顶部红条里的「热重载插件」

# 链路诊断
type %USERPROFILE%\.dsh\our-free-model\own-catalog.log
```

**真机探针模板**（要验证某家上游，用已登录凭据打真实接口；别把 cookie 打印出来）：
读 `~/.dsh/.credentials.yaml` 里的 `OFM_<PROVIDER>_ACCOUNT_*`（用宿主自带的 `js-yaml`：
`createRequire('…/resources/app/dsh/')`）→ 解析 JSON → 调 `src/channels/<provider>.js`
里导出的函数。豆包这一轮的三个模型验证就是这么跑的。

---

## 9. 文档地图

| 文件 | 内容 |
| --- | --- |
| `docs/HANDOVER.md`（本文） | **现状 + 下一步 + 判据 + 命令** |
| `docs/PORT-STATUS.md` | 过程记录：每轮报障的根因、证据、修法（含"宿主旧代码"那次排查） |
| `README.md` | 用户向：渠道总表、每家协议要点、安装/测试 |
| `_refs/dsh-providers-hub-master/docs/agent-notes/providers-*.md` | 上游实测笔记（移植前必读） |

---

## 10. 2026-11-24 晚：模型显示 / 账号的**内在**补完

上一轮的「自有渠道」只做到「看得见、点了有反应」，这一轮把**状态**补齐：

### ① 选择器按渠道分组（模型显示）

- 之前 14 家自有渠道的 100 个模型全塞在 `our-free-model` 一个 adapter 路由里，
  和免费车道混成一组；DSH 的选择器是**按路由分组**的（`buildModelCatalog`：
  `listProviders()` → 每组一个标题）。
- 现在每家自有渠道各占一条路由（**逐条** `registerAdapter([provider], adapter)`，
  撞到旧 generation / 别的插件时延迟重试 —— 全量注册在热重载竞态下是「全有或
  全无」，一次冲突就会让整组模型消失），标题来自 `OWN_LABELS`（豆包 / Codely /
  AStudio …）；`computeMembership` 把 `channel === 'own'` 的行按 `provider` 分组。
- 本机网关不受影响：`routableModelIds` 并**所有**路由，`/v1/models` 与
  `/v1/chat/completions` 仍按模型 id 收单。
- 与 dsh-providers-hub 同机时：已被别人注册的 provider id 会注册失败，重试若干次
  后放弃（那条路由归别的插件；本机网关仍按模型 id 可路由）。

### ② 模型开关 / 渠道开关（原来打的是渠道包 RPC）

| 控件 | 之前 | 现在 |
| --- | --- | --- |
| 逐模型开关 | `rpc('model.setDisabled')` → `unsupported provider` | `POST /channels/own/models/update`（写 `settings.ownDisabledModels`） |
| 全部开/关 | `rpc('model.setAllDisabled')` | 同一路由（省略 `modelId` = 全部） |
| 关闭整个渠道 | `rpc('provider.setEnabled')` | `POST /channels/own/provider/update`（写 `ownClosedProviders` + 停用账号） |
| 卡片模型数 | 写死 `0` → 永远「模型 —」 | `/channels/own` 回 `models {total, disabled, closed}` |

判据：选择器/网关读**过滤后**的目录（关掉的模型与关闭的渠道整组消失）；
面板「模型」折叠读 `includeDisabled` 的那份（否则关掉后没有入口点回来）。

### ③ 账号：轮换、续期、到期时间

- **推理取号**从「永远第一个账号」改成 `createOwnAccountPicker`（`src/channels/select.js`）：
  按账号表轮转、跳过没有凭据的占位行、取号时就地续期、续上了才回写。
- **续期**从 2 家扩到 9 家：`codely` / `minimaxintl` / `marvis` / `officeace` /
  `magicrew` / `magicrewintl` / `autoclaw` / `autoclawintl` / `accio`；面板的「续期」按钮
  对自有渠道改走 `POST /channels/own/refresh`，并且只在**凭据里真有
  refresh 材料**时渲染。
- **到期时间**：AutoClaw 的 `expires_in`（秒数）/ `expires_at`（epoch 秒）
  统一归一成毫秒；短信登录、Accio、OfficeAce 登录都会把 `expiresAt` 写回
  账号表（之前只有 codely / minimaxintl / marvis / magicrew 写了）。
- **Accio 身份**：登录后补 `POST /api/auth/userinfo`（`maskedMobile` / `userName`
  / `routeRegion`），账号列表不再只剩一串 `account-id`。

### ④ 目录缓存

- 之前「第一次抓失败」会把空数组记成已抓过 ⇒ 这一家整个进程生命周期都用兜底表。
  现在失败不覆盖旧行、10 分钟 TTL、登录/领取/账号变化时 `refresh: true` 立即重抓。
- OfficeAce 的 `fetchOfficeaceModels` 之前写好了没人调；现在 `statusOf` 先试远端，
  失败才回内置 8 条（手抄的 4 条兜底已删）。

### ⑤ 模型列表的「预制 / 实时」与倍率

- 预制表**永远有内容**（accio 除外：modelCode 按账号下发，面板会写明「登录后
  自动获取」）；远端目录成功则**整表替换**为最新，并记 `source:'live'` + 抓取时间。
- 面板「模型」折叠旁显示一枚 pill：`实时目录` / `预制目录`（悬停写明原因或时间）。
  取的还是 `/channels/own/models` 的 `catalog` 字段（宿主 `ownCatalogs` 同一次抓取
  落的 `source/at/note/error`）。
- 倍率随目录一起回：宿主把 `statusOf` 的 `ratios`（如豆包 `0.65x`）挂到每一行
  （`model.ratio`），面板在模型行里直接画 pill —— 不再要求先展开「活动」折叠；
  展示名已含同一倍率时不重复挂。
- 百智云新增 16 条预制表（2026-11-07 真机口径 + 按模型的 max_tokens 夹取值）。

### ⑥ 线协议（wire）不再丢

- **minimaxintl / monkeycode×2 / baizhi** 是 Anthropic Messages 线，**astudio**
  是 Responses 线；但远端目录与兜底表大多不写 `wire`，`ownEntry()` 默认 chat
  ⇒ 请求体按 OpenAI 形组、发到 `/messages` / `/responses`，上游 400。
- 现在 `src/channels/catalog.js` 的 `WIRE_BY_PROVIDER` 是唯一事实源：无论行来自
  远端还是预制表，`buildOwnCatalog` 都补上正确 wire。
  守卫：`tests/own-controls.mjs` ①（逐渠道断言 wire）。

### ⑦ 没登录不再报「余额查询失败」+ 签到活动行 + 任务

- 卡片渲染层：`enabledCount === 0` 时不显示任何余额红字（旧宿主缺路由 / 旧渠道包
  不认识 provider 时也不会画）；「待登录」仍由 `/channels/extra` 的 `pending` 表达。
- 签到：多数自有渠道的 `statusOf` 只回 `checkin` 读数，没有 `activities` ⇒
  `src/channels/index.js` 的 `withDailyCheckinActivity()` 统一补一条「每日签到」
  活动行（可领/已签 + 金额）；AutoClaw / 超级麦吉没有状态端点但领取按天幂等，
  给可执行入口；没有签到能力的（Marvis / OfficeAce / Accio）不伪造。
- 任务：超级麦吉的 8 项新人任务原来只存在 `statusOf.tasks` 里、面板看不到。
  现在 `CHANNEL_TASKS = { loomy:'pack', raccoon:'pack', magicrew:'own', magicrewintl:'own' }`，
  面板「任务」折叠对 `own` 渠道读 `/channels/extra`，领取逐项走
  `campaignId=task:<code>`（完成判据 `status==='COMPLETED' || rewardStatus==='GRANTED'`）。

### 守卫

`tests/own-controls.mjs`（6 组）+ `tests/channels-smoke.mjs` 新增：
自有模型不向渠道包要 `model.list`、卡片显示真实模型计数、模型折叠读自己的路由、
「预制目录」提示与倍率都在模型行里、wire 逐渠道正确。

---

## 11. 2026-11-24 23:15：真机「模型列表还是不显示」的两个致命点

现象：插件面板里 Our Free Model 标成**异常**，选择器里 14 个自有渠道分组一个都不出现，
`~/.dsh/our-free-model/own-catalog.log` 也没有任何新启动记录。

### 根因 A：诊断日志的 TDZ 把整个 apply 抛崩

`diagLog` 是 `const`，原先定义在 apply 尾部（第 1378 行），但注册段（第 594 行）
先调用了它 ⇒ `ReferenceError: Cannot access 'diagLog' before initialization`。
第一次 `own-route` 日志就抛，catch 里再调一次又抛 ⇒ `apply()` 失败 ⇒ Cordis 回滚
它已注册的**全部**路由（含主路由）⇒ 插件标「异常」、模型整组消失、日志一条不落。

修：把 `diagLog` 定义提前到注册段之前（`index.js`，带注释说明原因）。

### 根因 B：自有行被免费车道拿去探活

`runProbeRound()` 的 `probeable` 只排除了 eac/kilo/aggregate/combo，没排除
`channel === 'own'`。自有行的 id 是 `provider/model`，打到免费网关必 404 ⇒
availability 记 `unavailable` ⇒ `computeMembership()` 的
`filter(verdict !== 'unavailable')` 把它们全部丢掉 ⇒ membership 只剩 1 个 key
（`our-free-model` 22 个模型），14 条自有路由虽然**注册成功**，`listModels()` 却全回 0。

修：
- `runProbeRound()` 排除 `isOwnRow(entry)`；
- `computeMembership()` 里自有行**永远进视图**（`isOwnRow || verdict !== unavailable`），
  并新增 `isOwnRow()` 单一判据；
- 守卫：`tests/own-controls.mjs` ③ 新增「残留 unavailable 不能抹掉自有分组」。

### 真机验证（2026-11-24 23:19 重启后）

`auto-diag` 一行给出两条独立读数（`宿主条数/适配器直读条数`）：

```
memKeys:14 memOwnKeys:codely,autoclaw,...,doubao memDoubao:16
ownCounts: codely:8/8 autoclaw:4/4 ... baizhi:16/16 astudio:7/7 doubao:16/16
routes: ... codely autoclaw autoclawintl minimaxintl marvis magicrew ... doubao our-free-model
```

选择器实测：提供商列表出现 Codely 8、AutoClaw 4、AutoClaw(国际版) 4、MiniMax(国际版) 4、
腾讯 Marvis 1、超级麦吉 8、MagiCrew 8、MonkeyCode 8、MonkeyCode 国际版 8、百智云 16、
OfficeAce 8、AStudio 7、豆包 16（Accio 0，按设计不显示）；豆包组内 16 条都带倍率
（`豆包 2.1 Lite · 限时优惠 0.01x`、`豆包 2.1 Pro · 0.65x` …）。插件面板不再显示「异常」。

### 重新加载的正确姿势（桌面版）

用 shell 起 DSH 时，**父命令一结束子进程就会被回收**（本次排查里所有「启动后消失」
都是这个原因，不是崩溃）。要么在同一个前台命令里 `Start-Process …; Start-Sleep 3600`，
要么用 WMI 分离启动（`Invoke-CimMethod Win32_Process Create`，实测命令结束后仍存活）。
重启后看 `own-catalog.log` 的 `own-routes-ready` 与 `auto-diag` 两行即可判断加载是否成功。

### 显示口径（2026-11-24 23:40 用户确认）

- **模型选择器**：只显示**有登录账号**的渠道分组 —— 自有渠道走
  `buildOwnCatalog({ signedInOnly: true })`（`syncOwnCatalog()` 喂运行时）；
  13 个渠道包分组走 `installChannelCatalogVisibility()`（`hasLoggedInAccount`
  现读账号池）。未登录渠道整组不出现，登录后下一次刷新自动出现。
  面板上的「隐藏所有渠道」开关仍可一次性收起全部渠道包分组。
- **Our Free Model 面板**：27 张卡片照旧全显示（登录入口不能丢），但**已登录账号的
  渠道排前面**（`client.js` 按 `statuses[id].accounts.enabled` 稳定排序）。
- **设置 → 模型**：那是 DSH 的 API-Key 提供商页，行只来自
  `registerConfigurableProviders` 声明且 `settingsNs` 存在命名空间；本插件按
  dsh-providers-hub 的既有结论**不往里塞渠道行**（塞了就是一行行无意义的密钥编辑框）。

### 路由处理器的作用域红线（2026-11-24 23:55）

`createApiRoutes()` 与 `buildSummary()` 等是**模块级**函数，`apply()` 里的闭包
（`settings`、`diagLog`、`hostLlm`、`modelRuntime`、`ownAccounts`、`smsLogin`、
Accio 登录函数、`syncOwnCatalog`…）在里面一律不可见。真机症状：点自有渠道的
「模型」折叠 → `操作失败：diagLog is not defined`，子列表恒为空。
以后新增路由代码只能读写 `deps.*`；`tests/api-own-routes.mjs` 会直接调用处理器
（假 req/res）来兜住这类越界。



