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
- 2026-10 实测的 2.0.29 工作请求（`POST https://opencode.ai/inference/openai/v1/chat/completions`，
  `mimo-v2.6-flash-free`，`stream: true`，`tools: [read, shell]`）额外携带
  `x-opencode-session-id`；逐头消融显示它与 `x-client-request-id` 一样是惰性的——
  单独只带它会 403，`x-opencode-session` / `x-session-affinity` / `x-session-id`
  任一单头即可通过。插件默认头集合跟随工作请求（含 `x-opencode-session-id`），
  指纹头跟随官方客户端（`x-opencode-client: cli` + `x-opencode-project: global`，
  `User-Agent: opencode/latest/2.0.29/cli`）。工具门控实测收紧为“必须含 `read`”
 （`read` 单工具通过，`shell` 单工具 403，空 tools 403）。

另外，pi-ai 库（`@earendil-works/pi-ai`，opencode 自己的 AI 库）内部还有一套 `sendSessionAffinityHeaders` 门控的 affinity 头发射逻辑——默认关，且 dsh 的 `llm-pi-ai` adapter 配置门控刻意 withheld 了该开关，这正是"dsh 已有 `options.sessionId` 却发不出任何会话头"的根因。

## 2. dsh 侧的现状

`dsh-agent-loop` 把会话 id 放进 `options.sessionId`，`llm-pi-ai` 也会转发给 pi-ai；但 adapter 丢弃逐请求的 `options.headers`（只用 provider 静态 `headers` + attribution 头），且 compat 门控关着——所以实际请求头里什么都没有。本插件在**不可能被绕过的层**（实际 fetch）补上这一环。

## 3. 工作原理

1. **`llm/stream` waterfall 监听**（dsh 官方 LLM 请求拦截点）：把每个流式调用用 `AsyncLocalStorage` 绑定到它的会话 id——多个会话并发流式时每个请求也能拿到**自己的** session id。
2. **包装 `globalThis.fetch`**：Node ≥ 18 下 `openai` SDK 和 `@anthropic-ai/sdk` 解析到的都是 undici 全局 fetch（SDK 在每次请求构造客户端时才解析 `fetch`，包装必然生效）。包装器只对命中 opencode 端点（host 后缀，或精确 baseURL 前缀，均可配置）的请求**追加会话请求头**，其余请求以完全相同的参数原样透传。

**范围保证——只改请求头。** 包装器不读、不改、不替换请求体（字节与流原样透传），不改 URL/method/signal/duplex/凭证等任何 fetch 选项，也不碰响应。`llm/stream` 监听器默认不改调用选项；仅 `seedSessionId: true` 时会给缺失 `options.sessionId` 的 opencode 路由补种（唯一 wire 效果仍是会话请求头）。

## 4. wire token：opencode 原生 `ses_` 格式

插件为每个 dsh 会话生成 opencode 原生格式的会话 id（`ses_` + 26 字符，见用户提供的 `createSessionID` 移植：`packages/schema/src/identifier.ts` + `packages/core/src/id/id.ts`）：

- **前 12 位 hex**：`~(createdAt * 0x1000)` 取 6 个大端字节——与 opencode 的 descending 时间半区完全一致。`createdAt` 取自会话 `SessionHeader`（不可变、随会话日志持久化、resume 时原样恢复），即会话出生时间；全会话期间固定不变，消息再多也不变。
- **后 14 位**：opencode 原生用 `crypto.getRandomValues`，这里用 uuid 部分的 **SHA-256 前 14 字节**经 `ID_CHARS[byte % 62]` 映射（与 opencode 逐字节语义一致）。`session-` 前缀（常量 label）不参与哈希。
- **总长 30**，匹配 `/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/`。
- **故意不用 opencode 的进程内 counter**：counter 会让同一 `(id, createdAt)` 在重启前后算出不同值；这里唯一性由 uuid 后缀保证，时间半区是 `createdAt` 的纯函数——重启后同一会话算出完全相同的 token，无需额外存储。子会话（subagent）是独立会话，用自己的 id 查自己的 `createdAt`，生成自己的 token，不继承父会话。
- 该后缀是**单向**的：后台只能看到 token，无法反推原始 `session-<uuid>`；dsh 侧靠 verbose 日志里的 `→ wire` 映射回溯会话。

## 5. 限制

- session id 取 `options.sessionId`（agent-loop 已按会话填好）；无会话上下文时兜底 `sessionIdEnv` > `DSH_SESSION_ID`（web 部署下是该进程的启动会话）> 进程内随机 id。
- 覆盖 `openai-completions` / `openai-responses` / `anthropic-messages` 等走 fetch 的协议；`transport: websocket` 不走 fetch，不在覆盖范围。
- 全局 fetch 包装只在命中 opencode 端点时追加请求头，不做任何其它改动。