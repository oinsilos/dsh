# 0–4 期移植进度与接续说明（checkpoint）

> 最后一次全量验证：**25 个测试文件全绿**（`npm run test:client` 串起其中 22 个；
> monkeycode / officeace-auth 两个单独跑），`check-install-drift` 报 `linked → ok`。
> 这份文档的用途：上下文丢了也能接着干 —— 每条都记着「已做了什么 / 还缺什么 / 下一个动作」。
> **接手请先读 `docs/HANDOVER.md`**（现状 / 下一步 / 判据 / 命令速查）；本文是过程与证据流水。

## 已完成（有测试钉住）

| 期 | 渠道 | 关键判据（别凭印象改） | 测试 |
| --- | --- | --- | --- |
| 0 | `minimaxintl` | `timezone_id` 是 query 且必填；业务码在 `base_resp.status_code`；`points` 不与 `bonus_points` 相加；`days` 必须 7 条；`claim_result:2` 是已领；令牌 `scope` 必须含 `agent.default`；3xx 按失败（fetch 跟随会剥 Authorization） | `tests/minimax-channel.mjs` |
| 1 | `marvis` | 回调 URL 必须带 `code=`；成功是 302+Set-Cookie；缺 refresh 当场报错；`/v3/*` 用 `md5(query+ts+KEY+nonce)`，网关**不带**签名；续期 `loginType:'Marvis'`，`expires_in` 是字符串；-107/-101 终态；钱包金额字符串、缺失不回落 0 | `tests/marvis-channel.mjs` |
| 1 | `magicrew` / `magicrewintl` | 三层凭证（JWT 30d / `mgw_` 2h / refresh 7d 一次性）；**签新 key 吊销旧 key**（只在登录与续签签）；续签 `PUT` 只带 refresh_token；`origin`+`referer` 硬要求；签到 body 是**空串**；`granted!==true`=已领；JWT×org 必须同前缀配对 | `tests/magicrew-channel.mjs` |
| 2 | `monkeycode` / `monkeycodeintl` | 三件套（api_key / signing_secret / session_cookie）；平台 API 只认 Cookie；钱包 `balance` 是毫；签到四步要过 Cap PoW；奖励优先响应、其次余额差、否则如实未知 | `tests/monkeycode-channel.mjs` |
| 2 | `baizhi` | cookie→`sk-` 两段；**maxTokens 按模型夹取**（100k / 65,536 / 32,768，唯一夹取点）；`claimed:false`=当日已领；分→积分 ÷100 | `tests/baizhi-channel.mjs` |
| 3 | `officeace` | PKCE + **DPoP**（ES256、`ieee-p1363`、私钥随凭据持久化、`htu` 完整 URL）；code 秒级过期要立刻换；`STS5.1806` 终态；无签到 | `tests/officeace-auth.mjs` |
| 3 | `astudio` | Cookie 原样透传 → `GET /bot/models/configs` 换 `modelBearerToken`；推理是 **Responses 线**（目录行必须带 `wire:'responses'`，否则正文全丢） | `tests/astudio-channel.mjs` |
| 3 | `doubao` | 签名在 **query 的 `a_bogus`**（页面 `bdms.frontierSign({'X-MS-STUB':''})` → `{'X-Bogus':…}`）；活动腿 `aid=497858` / 网页腿 `aid=582478`；`710010702`=没有可领活动、`710012001`=登录态失效；`idempotent:true` 首次成功也有 ⇒ 只看 `reward_amount`；设备身份由 `accountKey` 派生 19 位数字；**推理**：`/chat/completion` 自定义帧（`STREAM_CHUNK`/`CHUNK_DELTA`）+ `mode=1/3` 路由，`aggregate_params.conversation_mode` **必须是字符串** | `tests/doubao-channel.mjs` + `tests/doubao-inference.mjs` |
| 3 | `astudio` | 微信扫码三段（`fd` → `qrcode` → `uids` → `bind`）；四字段 Cookie 两种拼写；`code:0` + **空 `infoList`** = 该微信没开通账号；`80000/1002/1005` 会话失效；额度权威字段 `totalBalance`；签到是**弹窗**语义（`DAILY_REWARD_DIALOG` → `complete`） | `tests/astudio-login.mjs` |
| — | 渠道清单 | `GET /channels/manifest` 回宿主**实际加载**的清单；面板拿 `?expect=` 对账，缺谁点名 → 卡片集合 == `OWN_PROVIDERS` | `tests/channel-manifest.mjs` + `channels-smoke.mjs` |
| — | 占位账号 | 没凭据 = `pending`（**待登录**，不是「查询失败」）；启动时 `prunePending()` 清掉永远不会登录的行 | `tests/pending-accounts.mjs` |
| — | 浏览器驱动 | `DevToolsActivePort` 解析、`--remote-debugging-port=0`、`Fetch.fulfillRequest` 拦停（请求不出网）、`evaluate`、`Network.getCookies`、`taskkill /T`；**超时计时器不许 unref**；**`intercept` 默认关**（开了 `Fetch` 域但没人放行 = 白屏窗口）；**`headless` 只给不需要用户看的会话** | `tests/chromium-driver.mjs` |
| — | `cap-pow` | 1-based 题号、hex 前缀比较、UTF-16 `fnv1a32`、每步 `>>>0`、500 万次总预算 | 在 monkeycode/baizhi 测试内 |

## 3 期这一轮顺带修掉的三条真缺陷

1. **登录页会白屏**：`startChromiumSession` 原先无条件 `Fetch.enable('*')`，而只有
   marvis/officeace 装了拦截器。超级麦吉 / MonkeyCode / 百智云的登录页每个请求都停在
   `requestPaused` 等人放行 —— 页面永远加载不完，用户根本点不到登录。现在 `intercept`
   是**显式开关**，只有拦回调的两家打开。
2. **`baizhi` / `officeace` 没有起点分支**：`BROWSER_LOGIN_PROVIDERS` 里有它们、`poll`
   里也有，但 `start` 掉进「其余按超级麦吉处理」的兜底里读 `null.webOrigin`，抛的是
   `Cannot read properties of null`。现在起点是**表驱动**（`BROWSER_LOGIN_ENTRIES`），
   并且测试把「登录集合 / 入口表 / 面板 CDP 集合」三份清单**逐条比对**。
3. **面板的两份 CDP 数组不一致**：起点那份有百智云/MonkeyCode/OfficeAce，轮询那份没有
   ⇒ 浏览器起来了，面板却在问设备码端点（「扫完码一直转圈」）。现在客户端只有一份
   `BROWSER_CDP`。

## 2026-11-24 第二轮：面板三条腿全走自己的路由（报障驱动）

用户报障：「Accio 没法添加账号」「部分渠道都没登账号还提示余额查询失败」。两条都是
**面板把自有渠道的请求发给了渠道包**（渠道包不认识这些 provider id），外加一条
Accio 的浏览器打开位置错了。

| # | 症状 | 根因 | 修法 |
| --- | --- | --- | --- |
| 1 | Accio 点「添加账号」没反应 | 授权页靠面板的 `window.open` 打开，而桌面壳的渲染进程会拦弹出窗口；`openBrowser`（rundll32）写好了却**没人调** | 宿主在 `/channels/own/oauth/start` 里自己 `openBrowser(loginUrl)`；loopback 落定即 `close()`（那是个「等着收凭据」的口子） |
| 2 | 没登账号也报「积分读取失败：unsupported provider」 | 自有渠道也在调渠道包的 `credits.balances` | 自有渠道的余额/额度改走 `/channels/extra`（`balanceRowOf` 把 extras 行映射成 pack 的行形状）；pack 渠道原样走 RPC |
| 3 | 自有渠道点「领取」弹 `unsupported provider` | 同上，`credits.claimAll` 也不认识它们 | 自有渠道改成**逐账号** `/channels/extra/claim`；「全渠道领取」同样分叉 |
| 4 | 自有渠道的「账号」折叠永远「没有账号」，删除/停用点了没反应 | `account.list` / `account.delete` / `account.update` 都是渠道包的账号池 | 改走 `/channels/own`、`/channels/own/remove`、`/channels/own/update`；「测速 / 刷新凭据」对自有渠道**不渲染**（没有那两条腿） |

守卫：`tests/channels-smoke.mjs` 新增两条反向断言 —— 自有渠道**必须**从 `/channels/extra`
读余额，且**不得**再向渠道包要 `credits.balances`；`tests/accio-channel.mjs` 从 40 条涨到
46 条（`openBrowser` 三平台形状 + loopback 的 404/400/成功/关闭四态）。

## 2026-11-24 第三轮：豆包推理腿接通（**真机验证**）+ 占位账号噪音

用户报障：「部分渠道都没登账号还提示余额查询失败」「模型没显示如豆包」。

### ① 余额红字 = **7 条占位账号**

`~/.dsh/our-free-model/channels.json` 里有 8 条自有渠道账号，而凭据库
（`~/.dsh/.credentials.yaml`）里只有 **1 条**（doubao）。其余 7 条是
「点了添加账号、但登录没完成」留下的占位行（时间戳全在 20:27:38–20:29:07 之间）：
登录流程是**内存态**的，用户中途关窗或进程重启，这些行就永远等不到凭据 —— 而权益查询
照样去问上游，拿回「凭据不可用」画成红字。

**修法（两处，缺一不可）**：

1. `channels/index.js` 的 `status()`：凭据为空 ⇒ 只回 `{pending:true}`，**不惊动上游**；
   面板把 `pending` 显示成「待登录」而不是红字（`client.js` 的 `balanceRowOf` 同样处理）。
2. `accounts.prunePending()`：**启动时**把没有凭据的行从账号表里清掉（宿主启动调用一次）。

守卫：`tests/pending-accounts.mjs`（2 组）—— 凭据为空不发请求、`prunePending` 只清空行。

### ② 豆包模型：目录 + 推理**全部真机跑通**

用本机已登录的豆包 cookie（`OFM_DOUBAO_ACCOUNT_*`）实测：

| 腿 | 结果 |
| --- | --- |
| `POST /alice/slot/action_bar_v3/brief_list`（`{bot_id, language_code}`） | **200 / code 0**，`data.entry_list` 里 33 个 `model_item_key` 节点 → 去重后 16 个模型 |
| `POST /alice/commerce/sale/subscription/quota/summary/` | **200 / code 0**（额度正常，之前的红字与豆包无关） |
| `POST /ug/campaign/landing/get` | **200 / code 0** |
| `POST /chat/completion`（model `0`，对话线） | **200**，`event:` 依次 `SSE_HEARTBEAT` → `SSE_ACK` → `FULL_MSG_NOTIFY`（回显用户消息）→ `STREAM_MSG_NOTIFY` → `STREAM_CHUNK` → 正文「我是豆包。一，二，三。」 |
| 同上（model `5`，工作任务线 `mode=3`） | 正文「我是豆包，你的AI助手。一，二，三。」 |
| 同上（`person-deepseek-v4-1-flash-261017`，带档位） | 正文「我是豆包，一、二、三。」 |

踩到的两个真坑（都已修，并写进测试）：

1. **`aggregate_params.conversation_mode` 必须是字符串** —— 发数字实测回
   `710020202 common invalid param`（`option.conversation_mode` 反而是数字）。
2. **prompt 的角色分隔符要 ` user: ` / ` assistant: `**（与参考实现逐字同形），
   换成中文冒号同样回 `710020202`。

落地：`fetchDoubaoBriefList` / `doubaoRemoteModels`（真机树的解析，含「同一 key 多外观
→ 模式取众数、冲突走对话线」）/ `buildDoubaoChatBody` / `readDoubaoFrames`（`event:` 有意义，
通用 `readSse` 会丢）/ `createDoubaoTranslator`（帧 → OpenAI chunk，含 10040 思考头、
累积差量、`patch_object:111` 跳过、`STREAM_ERROR` 当场抛）；`inference.js` 的 `LANES.doubao`
带 `frames: 'doubao'`；`catalog.js` 的兜底表 = 16 条真机快照。

守卫：`tests/doubao-inference.mjs`（5 组：目录解析 / 请求体路由 / prompt 拼接 / 帧翻译 / 帧读取+目录）。

## ⚠️⚠️ 「新加的添加账号都不行」的**真正原因**（2026-11-24 定位）

用户报障原文：「新加的添加账号都不行，astudio 没有，渠道现在是 26 个」。

**根因不是某个渠道的代码，而是宿主与面板跑了两份不同代的代码**：

| 证据 | 值 |
| --- | --- |
| profile 里的 `dsh-our-free-model` 是 junction | 创建于 **今天 18:17:58**（此前是 npm 装的一份老代码） |
| 宿主进程启动时间 | 早于 18:17（`~/.dsh/our-free-model/own-catalog.log` 最后一条 `sync-begin` 是 **16:09**） |
| 该日志里 `syncOwnCatalog` 迭代的 provider | 只有 **4 个**（codely / autoclaw / autoclawintl / accio）—— 那是「0 期」的自有渠道表 |
| 当前仓库的 `OWN_PROVIDERS` | **14 个**（含 baizhi / officeace / astudio / doubao …） |
| 面板 `client.js` | 每次打开都从磁盘读 ⇒ **永远是新的**（27 张卡片） |

⇒ 面板渲染 27 张卡片，宿主只认识 24 个；新卡片点「添加账号」时，宿主回的是
「该渠道没有浏览器登录」或（老代码的）`Cannot read properties of null (reading 'webOrigin')`。
`astudio` 当时连卡片都没有（现在补上了）。

**修法（两道）**：

1. **可观测**：`GET /channels/manifest?expect=<面板渲染的自有渠道>` → 宿主回 `missing`；
   面板据此在顶部显示「宿主侧插件还是旧代码：它不认识 X」，并给一个**热重载插件**按钮
   （`POST /reload`）。判据是**行为级**的（宿主认不认这个 id），不是版本号字符串比对。
2. **可操作**：那个按钮点下去 = `selfReload`，重载后页面自动刷新；不方便的话直接重启 DSH。

⚠️ **排查纪律**：以后遇到「面板有、点了没反应」，先看 `~/.dsh/our-free-model/own-catalog.log`
最后一条 `sync-begin` 的 provider 条数 —— 少于 `OWN_PROVIDERS.length` 就是宿主没重载，
**不要**去改协议代码。

## 还缺的一件

### 第 4 期 agnescode ×2（约 1–2 轮）
- ⚠️ **这轮为什么没做**：本机没装 AgnesCode 客户端（`%APPDATA%\AgnesCode` 不存在）⇒
  没有可验的样本。建议先在本机装一次客户端并登录，再照下面落地。
- 读 `%APPDATA%\AgnesCode\code-auth-session*.v1`（`v10` + AES-256-GCM）
- key = `Local State` 的 `os_crypt.encrypted_key` 去掉 `"DPAPI"` 前缀后用 DPAPI 解封（非 Windows 如实 `UNSUPPORTED_PLATFORM`）
- ⚠️ `bffPublicBaseUrl` **每账号下发、绝不硬编码**；挂 `Authorization` 前必须钉扎 `https` + `*.agnes-ai.cn` / `*.agnes-ai.com` 域名边界
- 目录账号级下发、**刻意无静态兜底表**
- 可验性：DPAPI 那一段能用 PowerShell 的 `ProtectedData::Protect` **现造 fixture**
  端到端跑通（解封 → AES-256-GCM → 剥 32 字节 host 前缀），不需要真客户端

### 已完成的两项（留档）

- **astudio 登录腿**（2026-11-24）：微信扫码三段 + 二维码内联 + 额度/签到，真机验过
  `qrcode` 与 `uids` 两段
- **doubao 推理腿**（2026-11-24）：目录 + 请求体 + 帧翻译，真机用本机账号跑通三个模型
  （对话线 / 工作任务线 / 带档位），细节见上面「第三轮」那节

### 未取证（如实登记）

- 豆包签到状态腿（`landing/get`）里到底有没有 `checked_in` 字段：真机 200/`code:0` 但
  报文里没读到布尔位 ⇒ 现在对字段做宽容读取，读不到回「不知道」（面板按「可领」呈现，
  签到本身幂等）

### 4. 已有 8 家的「更好的实现」
按严重度：qoder 真目录/倍率（需 cosy 签名或 WASM）> codearts 推理 UA 覆盖 + 上下文窗口（IDE 日志）> raccoon 浏览器授权链（扫码页已 404）> zcode 3012 版本×身份块同代 > minimax 传输重试 > cline 目录 O(N²) > loomy 冷却 UTC+8 24:00 > trae 4006 → `CONTEXT_WINDOW_EXCEEDED`

## 豆包这一轮的**真机取证**（2026-11-24，本机 Edge headless）

| 观察 | 结论 |
| --- | --- |
| `www.doubao.com/chat/` 匿名加载，约 15–20 s 后 `window.bdms.frontierSign` 出现 | 签名环境**不需要**豆包客户端内核；但要等懒加载 chunk |
| `frontierSign({'X-MS-STUB': ''})` → `{'X-Bogus': 'f47N354pgz-Kt/Xg'}` | 返回**对象**、键 `X-Bogus`；值里带 `/`，进 URL 必须编码 |
| 传 `pathname+search` 字符串也回 `{X-Bogus}` | 两种调用口径都吃（所以表达式对返回形态宽容） |
| 无 cookie 打额度/状态两条腿 → `710012001 login invalid` | 端点与 query 形状**被接受**（参数错会是 `710010202`），只差登录态 |
| 无 cookie ⇒ 两条读腿都不成功 | 面板文案因此区分「重新登录」与「没有可领活动」 |

## 工程状态

- 安装：profile 依赖 `link:D:/Desktop/dsh插件/work/our-free-model`（junction），**不会被插件更新覆盖**；探针 `node scripts/check-install-drift.mjs`
- 测试：`node tests/<name>.mjs`；`package.json` 的 `test:client` 串起全部 22 个（含 doubao / own-controls）
- **未提交 git**：25 个改动文件 + 8 个新文件；提交前先跑一遍 `test:client`

## 2026-11-24 晚：模型显示 / 账号的内在补完（报障驱动）

用户复查「原改动像停留表面、内在移植不彻底（如模型显示、账号等等）」后定位到的
缺口，逐条修复：

| # | 表面现象 | 根因 | 修法 | 守卫 |
| --- | --- | --- | --- | --- |
| 1 | 选择器里 100 个自有模型混在免费车道一组 | 全部注册在 `our-free-model` 一个 adapter 路由；DSH 按路由分组 | 每家自有渠道一条路由，标题来自 `OWN_LABELS`；`computeMembership` 按 `entry.provider` 分组 | `own-controls.mjs` ③ |
| 2 | 自有渠道「模型」折叠的开关点了报 `unsupported provider` | `model.setDisabled` / `model.setAllDisabled` / `provider.setEnabled` 都是渠道包 RPC | 新增 `/channels/own/models/update` 与 `/channels/own/provider/update`，落 `settings.ownDisabledModels` / `ownClosedProviders` | `own-controls.mjs` ① + `channels-smoke` |
| 3 | 自有卡片永远「模型 —」 | `/channels/own` 恒回 `models: {total:0}` | 宿主按 `includeDisabled` 目录算 `{total, disabled, closed}` | `channels-smoke`（3/4） |
| 4 | 多账号登了也只用一个；第一个号坏了整条渠道不可用 | `ownCredentialFor` 恒取 `enabled(provider)[0]` | `createOwnAccountPicker`：轮转、跳过空凭据、取号时续期、成功回写 | `own-controls.mjs` ② |
| 5 | 令牌过期只能重新登录；账号显示「永久」 | 续期只接了 minimaxintl/marvis；AutoClaw 的 `expires_in` 原样存成 3600 | 续期扩到 9 家；`expires_at` 统一归一毫秒并写回账号表 | `own-controls.mjs` ②⑥ |
| 6 | OfficeAce 只显示 4 个模型；租户多出来的看不到 | `fetchOfficeaceModels` 写好了没人调用；兜底表手抄了 4 条 | `statusOf` 先试远端、失败回内置 8 条 | `own-controls.mjs` ④ |
| 7 | 模型能选、一发就 400 | minimaxintl / monkeycode×2 / baizhi 是 Messages 线、astudio 是 Responses 线，但远端目录与兜底表大多不写 `wire` ⇒ 按 chat 组请求体 | `WIRE_BY_PROVIDER` 成为唯一事实源，`buildOwnCatalog` 逐行补 wire | `own-controls.mjs` ① |
| 8 | 模型列表看不出是预制还是最新 | 宿主只存 rows，没有来源/时间 | `ownCatalogs` 同一次抓取落 `source/at/note/error`；`/channels/own/models` 回 `catalog`，面板画「实时/预制」pill | `channels-smoke.mjs` |
| 9 | 倍率要另开「活动」折叠才看得到 | 面板模型行只读 `extra.ratios`（且 extra 未加载） | 宿主把 `statusOf.ratios` 挂到每行 `model.ratio`，模型行直接画 pill | `channels-smoke.mjs` |
| 10 | 没登录仍报余额失败 / 签到无入口 / 任务看不到 | 红字不受账号数约束；多数自有渠道只有 `checkin` 读数没有 `activities`；麦吉任务只在 `statusOf.tasks` | 渲染层按 `enabledCount` 门控；`withDailyCheckinActivity` 补活动行；`CHANNEL_TASKS` 增加 `own` 分支 | `own-controls.mjs` ⑤ + `channels-smoke` |
| 11 | 热重载后自有模型整组消失 | 14 条路由一次注册，撞旧 generation 即全有或全无 | 逐条注册 + 延迟重试（`registerOwnProviderRoutes`） | `own-controls.mjs` ③ |

### 追加（同日 23:15，真机仍看不到模型）

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 12 | 插件面板显示 **Our Free Model 异常**，选择器一个自有分组都没有，`own-catalog.log` 无新记录 | `diagLog` 是 `const`，定义在 apply 尾部却在注册段（更早）被调用 —— 第一次 `own-route` 日志就抛 TDZ 的 `ReferenceError`，catch 里再抛一次 ⇒ `apply()` 失败 ⇒ Cordis 回滚全部路由（含主路由） | `diagLog` 提前到注册段之前（`index.js`） |
| 13 | 修好 12 后路由注册成功（14/14），但 `listModels(provider)` 仍全回 0，选择器无分组 | 自有行参加免费车道探活（`runProbeRound` 没排除 `channel:'own'`），`provider/model` 打到免费网关必 404 ⇒ 记 `unavailable` ⇒ `computeMembership` 把它们过滤掉 | 探活排除 `isOwnRow`；`computeMembership` 让自有行永远进视图；守卫：`own-controls.mjs` ③「残留 unavailable 不能抹掉分组」 |

### 追加（同日 23:40，按用户口径：有账号才显示）

| # | 要求 | 修法 |
| --- | --- | --- |
| 14 | 模型选择器**隐藏未登录渠道分组** | `buildOwnCatalog` 新增 `signedInOnly`；`syncOwnCatalog()` 喂运行时（选择器/网关）时传 `true`。面板不传 —— 卡片计数与「模型」折叠仍能看到未登录渠道的预制目录，登录入口不丢。守卫：`own-controls.mjs` ① |
| 15 | Our Free Model 面板渠道列表**已登录排前面** | `client.js` 渲染前按 `statuses[id].accounts.enabled > 0` 稳定排序（下标兜底），仅改渲染顺序，不动路由/计数 |

### 追加（同日 23:55，模型折叠为空 + 红色 toast）

真机截图：腾讯 Marvis 卡片「模型」折叠显示 `模型 (0)`、下面一条空 `—`，右下角 toast
`操作失败：diagLog is not defined`，后面多个渠道同样。

| # | 现象 | 根因 | 修法 |
| --- | --- | --- | --- |
| 16 | 点「模型」折叠 → 空列表 + `操作失败：diagLog is not defined`；自有渠道（Marvis/豆包…）全中招 | `/channels/own/models`、`/channels/own/models/update`、`/diag/models`、Accio OAuth、短信登录这些处理器都在**模块级** `createApiRoutes()` 里，却裸引用了 `apply()` 作用域的 `diagLog` / `settings` / `hostLlm` / `modelRuntime` / `ownAccounts` / `smsLogin` / Accio 登录函数 ⇒ 每次请求 `ReferenceError` → 500 | 全部改走 deps：新增 `diagLog`、`hostLlm: () => hostLlm`、`hasRefreshMaterial`、`accioLogin`；已有的 `settings` / `channelAccounts()` / `smsLogin()` / `syncOwnCatalog` 直接复用。守卫：`tests/api-own-routes.mjs` 用假 req/res 直接驱动处理器，断言 200 + 设置落盘 |

### 追加（11-25，渠道包渠道也要按登录状态隐藏）

真机截图：选择器里仍有商汤（Raccoon）/ Cline / WorkBuddy 国际版 / LobsterAI / Qoder
等**没登录**的渠道包分组。第 14、15 条只处理了自有渠道；渠道包的 13 个分组走的是
pack 自己的门控。

| # | 根因 | 修法 |
| --- | --- | --- |
| 17 | `installChannelCatalogVisibility()` 在「隐藏所有渠道」关闭时**硬返回 true**（历史口径是"未登录也列出"），而上游 `providerCatalogVisible()` 又因 env='0' 直接短路成全部可见 | 新口径：总开关开 → 全收起；总开关关 → **交回原判定**（`providerCatalogVisible` 走账号池 `hasLoggedInAccount`）。env 始终置 `'1'`，否则包装层不会被调用；`shouldHide` 存 pool Symbol，热重载换新回调。守卫：`tests/channel-visibility.mjs` 20 条 |

真机验证（11-25 重启后）：选择器提供商只剩 14 组 —— DeepSeek 账号 / DeepSeek / 魔塔 /
云知声 / 豆包 16 / CodeArts 11 / CodeBuddy 24 / Qoder(中国版) 13 / TRAE 38 / Loomy 6 /
MiniMax Code 2 / Gemini 1 / ZCode 2 / Our Free Model 22；商汤、Cline、LobsterAI、
WorkBuddy 国际版、Qoder 国际全部消失。

### 第 4 期 AgnesCode ×2（11-25 完成）

客户端已装（`%APPDATA%\AgnesCode`）。实现 `src/channels/agnescode.js`：

- 会话：`v10` + AES-256-GCM，密钥 = `Local State.os_crypt.encrypted_key` 去
  `DPAPI` 前缀后 DPAPI 解封（Node 侧只在这一步起 PowerShell）；明文可带/不带
  32 字节 host 前缀，两种都兼容。
- 登录：`POST /channels/own/import`（读客户端 → 落账号/凭据 → 重编目录）；
  「续期」= 再读一次（令牌由客户端自己续）。
- 目录：`{bffBase}/models`（`/v2/models` 实测 404，别写错）；**无静态兜底**，
  会员模型名后缀「（会员）」。
- 推理：`{bffBase}/chat/completions`，Bearer；域名钉扎
  `https` + `*.agnes-ai.cn` / `*.agnes-ai.com`（`api-agnes-ai.cn.evil` 拒绝）。
- 真机：国内站 9 模型；`agnes-3.0-flash` 流式正文「收到」；选择器出现 AgnesCode 9；
  面板卡片 已接入 / 账号 1/1 / 模型 9/9（无余额口径 ⇒ 隐藏「剩余积分」列）。
- 守卫：`tests/agnescode-channel.mjs`（6 组：解密/解析/域名/目录/权益/会话读取）。

另：Accio 登录后补 `userinfo`（昵称/掩码手机号/区域），账号列表不再显示一串 id；
自有目录缓存改为「失败不覆盖 + 10 分钟 TTL + 变化点强制刷新」。
