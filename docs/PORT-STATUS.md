# 0–4 期移植进度与接续说明（checkpoint）

> 最后一次全量验证：**19 个测试全绿**，`check-install-drift` 报 `linked → ok`。
> 这份文档的用途：上下文丢了也能接着干 —— 每条都记着「已做了什么 / 还缺什么 / 下一个动作」。

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
| 3 | `doubao` | 签名在 **query 的 `a_bogus`**（页面 `bdms.frontierSign` 生成）；query 顺序即签名原文；签到要签名，状态/额度不要 | 无（模块自检） |
| — | 浏览器驱动 | `DevToolsActivePort` 解析、`--remote-debugging-port=0`、`Fetch.fulfillRequest` 拦停（请求不出网）、`evaluate`、`Network.getCookies`、`taskkill /T`；**超时计时器不许 unref** | `tests/chromium-driver.mjs` |
| — | `cap-pow` | 1-based 题号、hex 前缀比较、UTF-16 `fnv1a32`、每步 `>>>0`、500 万次总预算 | 在 monkeycode/baizhi 测试内 |

## 还缺的四件（按建议顺序）

### 1. doubao 接线（约 1 轮）
- `src/channels/doubao.js` 已有：`doubaoCheckinQuery`（有序数组）、`doubaoQueryString`、`doubaoCheckinUrl(credential, aBogus)`、`DOUBAO_SIGN_EXPRESSION`、`classifyDoubaoCheckin`
- 缺：宿主登录流（CDP 打开 `https://www.doubao.com/chat/` → 轮询 `evaluate(DOUBAO_SIGN_EXPRESSION)` 直到非空 → 带 Cookie 调 `doubaoCheckinUrl`）、额度腿（`/alice/commerce/sale/subscription/quota/summary/`，免签名）、`OWN_PROVIDERS`/目录/面板卡片
- 判据：`bdms` 未注入时返回空串 = 「还没加载完」，**不是错误**，继续轮询

### 2. astudio 登录腿（约 1 轮）
- 缺：`agent.xfyun.cn/xingchen-studio` 的短信 / 密码两条登录报文（本轮未取证，**不要猜字段**）
- 拿到 Cookie（四字段串）后走现成的 `exchangeAstudioBearer`；再补面板卡片

### 3. 第 4 期 agnescode ×2（约 1–2 轮）
- 读 `%APPDATA%\AgnesCode\code-auth-session*.v1`（`v10` + AES-256-GCM）
- key = `Local State` 的 `os_crypt.encrypted_key` 去掉 `"DPAPI"` 前缀后用 DPAPI 解封（非 Windows 如实 `UNSUPPORTED_PLATFORM`）
- ⚠️ `bffPublicBaseUrl` **每账号下发、绝不硬编码**；挂 `Authorization` 前必须钉扎 `https` + `*.agnes-ai.cn` / `*.agnes-ai.com` 域名边界
- 目录账号级下发、**刻意无静态兜底表**

### 4. 已有 8 家的「更好的实现」
按严重度：qoder 真目录/倍率（需 cosy 签名或 WASM）> codearts 推理 UA 覆盖 + 上下文窗口（IDE 日志）> raccoon 浏览器授权链（扫码页已 404）> zcode 3012 版本×身份块同代 > minimax 传输重试 > cline 目录 O(N²) > loomy 冷却 UTC+8 24:00 > trae 4006 → `CONTEXT_WINDOW_EXCEEDED`

## 工程状态

- 安装：profile 依赖 `link:D:/Desktop/dsh插件/work/our-free-model`（junction），**不会被插件更新覆盖**；探针 `node scripts/check-install-drift.mjs`
- 测试：`node tests/<name>.mjs`；`package.json` 的 `test:client` 串起全部（含 baizhi）
- **未提交 git**：12 个改动文件 + 新增 `src/channels/`、`src/channels/browser/`、`scripts/`、`tests/`；提交前先跑一遍 `test:client`
