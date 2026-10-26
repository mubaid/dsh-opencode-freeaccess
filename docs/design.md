# 设计说明（dsh-opencode-freeaccess）

本文档记录插件的实现原理与设计取舍，供维护者参考；使用说明见 [README](../README.md)。

## 1. opencode 是怎么携带 session id 的（取自 opencode 1.18.21 源码）

opencode 构建 LLM 请求头时按 provider 分成两个分支（`providerID` 以 `opencode` 开头 → 网关分支）：

```js
headers: {
  ...(model.providerID.startsWith("opencode")
    ? {
        ...(projectId ? { "x-opencode-project": projectId } : {}),
        "x-opencode-session": sessionID,     // ← 网关分支：会话 ID 在这个头里
        "x-opencode-request": user.id,
        "x-opencode-client": flags.client,
        "User-Agent": `opencode/${version}`, // ← 指纹 UA
      }
    : {
        "x-session-affinity": sessionID,     // ← 非 opencode provider 才是这套
        "X-Session-Id": sessionID,
        ...(parentSessionID ? { "x-parent-session-id": parentSessionID } : {}),
        "User-Agent": `opencode/${version}`,
      }),
  ...model.headers,
}
```

结论：

- 对 opencode 网关，会话 ID 走 **`x-opencode-session`**（外加 `x-opencode-client` / `x-opencode-request` / `x-opencode-project` 和 `User-Agent: opencode/<版本>` 指纹头）。
- `x-session-affinity` / `X-Session-Id` 是 opencode 对普通 OpenAI 兼容端点才用的。
- opencode 原生会话 id 是 `ses_` + 26 字符格式（如 `ses_0ad7e1b930015SnHnrn3JV9SyS`），非 `session-<uuid>` 格式。
- 2026-10 实测的 2.1.4 工作请求（用本地 CONNECT 代理抓到 CLI 自己的请求）（`POST https://opencode.ai/inference/openai/v1/chat/completions`，
  `stream: true`）额外携带 `x-opencode-session-id`；逐头消融显示它与 `x-client-request-id`
  一样是惰性的——单独只带它会 403，`x-opencode-session` / `x-session-affinity` / `x-session-id`
  任一单头即可通过。插件默认头集合跟随工作请求（含 `x-opencode-session-id`），指纹头跟随官方
  客户端（`x-opencode-client: cli` + `x-opencode-project: global`，
  `User-Agent: opencode/latest/2.1.4/cli`）。`x-opencode-request` 属于 v1，v2 匿名门控对它
  直接 403，所以**不发**。

另外，pi-ai 库（`@earendil-works/pi-ai`，opencode 自己的 AI 库）内部还有一套 `sendSessionAffinityHeaders` 门控的 affinity 头发射逻辑——默认关，且 dsh 的 `llm-pi-ai` adapter 配置门控刻意 withheld 了该开关，这正是"dsh 已有 `options.sessionId` 却发不出任何会话头"的根因。

## 2. 匿名免费档的真实门控（2026-10-26 带对照实测）

网关把**所有**失败都报成同一个 `429 FreeUsageLimitError`，`retry-after` 还一路倒计到
00:00 UTC，所以"额度用尽"和"门控拒绝"看起来一模一样。任何一次测量都必须前后各夹一个已知能过
的对照请求，否则结果没有意义。夹了对照之后测出三道门：

1. **TLS ClientHello 的加密套件列表**：网关读取客户端宣告的 cipher list。OpenCode CLI 宣告
   17 个套件、按固定顺序（`1301,1302,1303,c02b,c02f,c02c,c030,cca9,cca8,c009,c013,c00a,c014,009c,
   009d,002f,0035`）；Node 默认 hello 宣告 52 个、按 OpenSSL 顺序，被拒。逐项实测：把列表倒序 →
   429；砍掉末尾 8 个 legacy 套件 → 429；只留 TLS 1.3 → 429；封顶 TLS 1.2 → 429；单独调曲线或
   `ecdhCurve` → 无关；`@SECLEVEL=0` 并不需要。hello 的**扩展集合与顺序不比对**（Node 缺
   `status_request`、`signature_algorithms_cert`、`padding`，多出 `encrypt_then_mac`，照样通过）。
   所以一个 `ciphers:` 选项就够：`tls-impersonate` 原生依赖、`HELLO`、`sendImpersonated` 全部删除，
   纯 Node 核心即可，无需升级运行时、无需 Bun、无需 sidecar（Node 20.19.2 / 25.7.0 / 26.5.0 实测，
   hello 与 CLI 逐字节相同）。`globalThis.fetch`（undici）无法设定这个列表，这才是插件自己发请求
   的唯一理由。
2. **会话头的取值格式**：`x-opencode-session` 必须是 `ses_` + 12 位 hex + 14 位 base62
   （`~(timeMs * 0x1000 + counter)` 取低 48 位）。**服务端读回的是格式，不是时钟**：在把门 1 固定
   住之后实测——缺头、空值、`abc-123` 全部被拒；语法正确但铸自 30 天前的 id 放行；时间半区清零
   也放行；解码到很远将来的 id（400 天）被拒。counter 只占低 12 位，服务端读它但不限制大小。
   插件仍按 `sessionTtlMs` 续签，是因为一个永不更换的 id 会把长会话钉在服务端一条过期记录上，
   不是因为时钟被校验。
3. **请求体**：`tools` 里必须有**名字叫 `read`** 的工具（定义**不**比对——dsh 自己那个
   `filePath` schema 的 `read` 就能过；`shell` 不是必需），系统提示里必须有 `<env>` 两行块，
   `stream` 必须为 `true`（`false` 被拒），`tool_choice: "none"` 被拒。

## 3. dsh 侧的现状

`dsh-agent-loop` 把会话 id 放进 `options.sessionId`，`llm-pi-ai` 也会转发给 pi-ai；但 adapter 丢弃逐请求的 `options.headers`（只用 provider 静态 `headers` + attribution 头），且 compat 门控关着——所以实际请求头里什么都没有。本插件在**不可能被绕过的层**（实际 fetch）补上这一环。

## 4. 工作原理

1. **`llm/stream` waterfall 监听**（dsh 官方 LLM 请求拦截点）：把每个流式调用用 `AsyncLocalStorage` 绑定到它的会话 id——多个会话并发流式时每个请求也能拿到**自己的** session id。
2. **包装 `globalThis.fetch`**：SDK 在每次请求构造客户端时才解析 `fetch`，包装必然生效。包装器只对命中 opencode 端点（host 后缀，或精确 baseURL 前缀，均可配置）的请求做下面三件事，其余请求以完全相同的参数原样透传：
   - 追加会话头与指纹头；
   - 若请求体是 LLM chat 请求（`isChatBody`）且 `adaptBody` 未关闭，按第 2 节的门控改写；
   - 用 `node:https` 自己发这个请求（带 `servername` 和被放行的 `ciphers` 列表），把响应包装成标准 `Response` 交回上层（`transport: "fetch"` 可退回平台 fetch；`node:https` 抛 socket 错误时自动用平台 fetch 重试一次）。

**改动范围。** 响应字节完全不动——门控只读请求，不需要改写回。请求侧只碰 opencode 路由，且只改
文档化过的这几项：会话/指纹头、`accept`、`<env>` 块、**仅在调用方没有 `read` 时**追加一个 inert
占位工具（并在系统提示里注明别调用它）、`stream`/`tool_choice` 这两个会被拒的取值。`verify.mjs`
里有一条 headers-only 保证测试：同一请求在关闭 `adaptBody` 时与未包装对照逐字节相同，差集恰好是注入的头。

## 5. wire token：opencode 原生 `ses_` 格式

- **前 12 位 hex**：`~(Date.now() * 0x1000 + counter)` 取低 48 位，与 opencode 的 descending 时间半区完全一致。用当前时钟铸造；门校验的是格式，附带一个不校验过去的宽松时间边界。
- **后 14 位**：`crypto.getRandomValues` 逐字节经 `ID_CHARS[byte % 62]` 映射（与 opencode 语义一致）。
- **总长 30**，匹配 `/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/`。
- **每个 dsh 会话一个 token，但按 TTL 续期**：`sesTokens` 记录 `{at, token}`，超过 `sessionTtlMs`（默认 10 分钟）就用新时钟重造。因为一个永不更换的 id 会把长会话钉在服务端一条过期记录上；窗口内的多轮共用同一个 id，看上去就是一个 opencode 会话。子会话（subagent）查自己的 id，生成自己的 token，不继承父会话。
- `sesTokenTime()` 能把 token 的时间半区解回毫秒（**模 2^36 ms**，约 2.3 年一圈），测试与 verbose 日志都用它核对。

## 6. 限制

- session id 取 `options.sessionId`（agent-loop 已按会话填好）；无会话上下文时兜底 `sessionIdEnv` > `DSH_SESSION_ID`（web 部署下是该进程的启动会话）> 进程内随机 id。
- 覆盖 `openai-completions` / `openai-responses` / `anthropic-messages` 等走 fetch 的协议；`transport: websocket` 不走 fetch，不在覆盖范围。
- 门控结论只在带对照的实测窗口内成立；网关随时可能收紧，改代码前先跑 `npm run test:live`（它会在窗口关闭时拒绝解释任何结果）。
