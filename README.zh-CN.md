# dsh-opencode-freeaccess

**在 DeepSeek Harness 里用上 OpenCode 的免费模型。不需要代理、不需要付费 key、不需要 sidecar、不需要配置。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](./README.md) | **简体中文**

---

## 问题所在

你把 DeepSeek Harness 的 provider 指向 `opencode.ai`，选一个他们的免费模型，
发一条消息，然后失败了：

```
429 FreeUsageLimitError: Free usage limit
```

这个名字有误导性。你的额度、key、模型 id、harness 都没问题。OpenCode 的匿名免费档
只有在三个独立检查全部通过时才放行，而它把**每一种**失败都报成同一个
`429 FreeUsageLimitError` —— 附带的 `retry-after` 还会一路倒计到 00:00 UTC，
所以「请求被拒」和「额度用尽」看起来完全一样：

1. **TLS ClientHello。** 网关会读客户端宣告的加密套件列表。Node 默认的 hello 被拒；
   OpenCode CLI 自己宣告的那 17 个套件、**且按那个顺序**，就被放行 —— 包括末尾那 8 个
   legacy 套件，所以把列表倒序、砍掉它们、或封顶到 TLS 1.2，三种都实测回 429。
   扩展的集合与顺序并不比对，因此在普通的 `node:https` 上设一个 `ciphers` 参数就够了：
   不需要 TLS 伪装 addon，不需要 Bun，不需要代理。
2. **会话头。** `x-opencode-session` 必须带一个 OpenCode 的 `ses_` id。校验的是这个值的
   **格式**：一个 30 天前铸出来的 id 照样放行，而 `abc-123`、空值、以及不带这个头，三种都被拒。
   插件为每个会话铸一个 id 并定期续签，为的是保持会话粘性。
3. **请求体。** 必须有一个**名字叫 `read`** 的工具，系统提示里必须有 OpenCode 那两行
   `<env>`，`stream` 必须是 `true`。工具的**定义并不比对** —— dsh 自己的 `read` 就能通过。

现在的 dsh 三条都不满足，而且这三条都不是 provider 配置能改的东西。

现实中你可选的几条路，都比直接修掉它更糟：

- 整个活儿都改在 OpenCode CLI 里跑，等于放弃 dsh。
- 付费买 key，等于放弃免费档。
- 全量走代理或聚合服务，多出一个要自己维护的跳板。

## 解决方案

一个插件，跑在 dsh 自己的 Node 进程里，把这几件事一起做：发出被放行的 ClientHello、
每个会话带上一个 `ses_` id、把请求体改成门控要看的样子，并用 `node:https` 发出请求。

```
dsh plugin --profile web add github:mubaid/dsh-opencode-freeaccess
```

重启该 profile，OpenCode 的免费模型就在 dsh 里跑起来了。

## 惊喜时刻

之前：

```
opencode / deepseek-v4.1-flash-free
> 429 {"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit…"}}
```

装完上面那行之后，同一个 provider、同一个模型、同一个 key：

```
opencode / deepseek-v4.1-flash-free
> 正常流式输出
```

不用新写 provider 配置，不用网关，不用 Bun，不用原生 addon，不用装第二个 Node 版本。

## 为什么是这个项目

**它对着真实的门，不是对着报错信息。** 429 说的是「额度」，实际意思是「你不是 OpenCode
的客户端」。上面三道门中的每一条都是靠**夹对照**的实测隔离出来的：每个被拒的请求前后都有
一次已知可通过的对照，这样门控结果才不会被误读成额度窗口关闭。见
[VERIFICATION.md](VERIFICATION.md)。

**它没有依赖。** 「只有 CLI 的 TLS 客户端能过关」这个直觉结论会让人去装一个 TLS
伪装的原生 addon，这个插件曾经就带着它。实测推翻了它：门要看的是 hello 里的**加密套件
列表**，而普通的 `node:https` 设一个 `ciphers` 参数就能发出去。addon 已删除，所以
`dsh plugin add` 依旧不需要构建步骤、不需要工具链，在 dsh 本身支持的任意 Node 上都能跑
—— 已在 Node 20.19.2、25.7.0、26.5.0 上实测通过。

**一个会话一个 id，按时间窗滚动。** `ses_` id 用 `Date.now()` 铸造，在该会话上复用
`sessionTtlMs`（默认 10 分钟）之后重新铸造 —— 服务端比对的是这个值的**格式**而不是它的
时钟（实测：30 天前的合法 id 依然放行），但一个永不续签的 id 会把长会话钉在服务端一条
过期的记录上，所以插件照样续签。并发会话绝不共用 id：每个请求都由 async context 定作用域。

**它不会改变你拿到的回复。** 响应字节完全不动。请求侧的改动只发生在 opencode 路由上：
会话头、`<env>` 块、**仅当调用方自己没有 `read` 时**补一个占位工具、`stream`/`tool_choice`
这两个会被拒的取值，以及传输方式。有一个测试会把命中目标的请求与未改动的对照做 diff，
断言差集恰好是文档里写明的这些。

**你现有的任何链路都能用。** 直连 `opencode.ai` 的 provider，或者你自己的网关、代理，
把 `baseURLs` 指过去即可。

## 主要特性

- **解锁免费档。** OpenCode 的免费模型可以在 dsh 里直接使用，进程内完成，没有 sidecar。
- **没有原生依赖，也不用升级运行时。** 只用 Node 核心模块。
- **并发会话安全。** 会话作用域基于 `AsyncLocalStorage`，并行会话之间不会互相污染。
- **会话作用域的 id。** 每个 `ses_` id 都由当前时钟铸造并按会话续签；门校验的是值的格式，不是它的时钟。
- **请求体改写有开关。** `adaptBody: false` 就原样发送你的字节（免费档会拒绝它 —— 排查时有用）。
- **传输有开关。** `transport: "fetch"` 可以退回 Node 自带的 `fetch`，适合必须走代理或
  自定义 CA 的环境。
- **默认有作用域。** 只处理匹配到的 host，其余请求以完全相同的原始参数转发。
- **可观测。** `verbose: true` 会打印每个发出的 id、改写后的工具列表、响应状态；遇到 429 时
  还会根据 `retry-after` 判断这更像额度还是像门控。

## 快速开始

```bash
dsh plugin --profile web add github:mubaid/dsh-opencode-freeaccess
systemctl restart dsh-web
```

配置到此为止。默认值对应 `opencode.ai` 和标准路由。

确认它在工作：

```bash
journalctl -u dsh-web -f | grep opencode-freeaccess
```

## 真实用例

**一次长时间的任务。** 每个会话在一段时间窗内携带同一个 id，上游看到的是稳定的客户端而不是
每请求一个新会话，这正是 prompt cache 亲和性需要的。

**并行 subagent。** 扇出十个 subagent，各自携带自己的 id，互不干扰。

**只想自托管。** 如果你不愿意把流量交给聚合服务，这条路径是 dsh 直连 OpenCode，免费档照常可用。

**从代理上迁走。** 去掉代理这一跳，模型继续用。

## 技术细节

插件在 opencode 请求上加的东西：

| 改动 | 作用 |
|---|---|
| `x-opencode-session` | 网关要校验格式的 `ses_` id |
| `x-opencode-session-id` | 官方客户端发送的配套会话请求头 |
| `x-session-affinity`、`x-session-id` | 亲和性族，重复但无害 |
| `x-opencode-client: cli`、`x-opencode-project: global` | 客户端指纹请求头 |
| `User-Agent: opencode/latest/<version>/cli` | 客户端指纹 |
| `accept: text/event-stream` | 请求体被改写时一并设置 |
| 请求体 | `<env>` 块；调用方没有 `read` 时补占位；`stream: true`；`tool_choice: "none"` → `"auto"` |
| 传输 | 该请求由 `node:https` 发出，并带上被放行的那串加密套件；socket 出错时自动用 `fetch` 重试一次 |

`x-opencode-request` 故意**不发**：它是 v1 的请求头，v2 免费档会拒绝。

id 格式就是 OpenCode 自己的：`ses_` 开头，接着 12 位 hex 是 `~(Date.now() * 0x1000 + counter)`
的低 48 位，再接 14 位随机 base62 字符。门校验的是这个值的格式 —— `ses_` 前缀、两半都在，所以 `abc-123` 和空值被拒 —— 再加一个对解码时间的宽松边界：30 天前的 id 仍然放行，解码到很远的将来则不行。用 `Date.now()` 铸造同时满足这两点，也不需要读时钟偏移。

所有选项都能在 profile 的 patch 层配置，id 为 `opencode-freeaccess`：`providers`、`hosts`、
`baseURLs`、`headers`、`extraHeaders`、`userAgent`、`sessionIdEnv`、`sessionTtlMs`、`verbose`、
`seedSessionId`、`disableFetchInjection`、`adaptBody`、`transport`。默认值见
[docs/design.md](docs/design.md)。

实现说明、测试套件，以及一份明确的「未验证」清单见 [VERIFICATION.md](VERIFICATION.md)。

## 对比

| | OpenCode CLI | 代理或聚合服务 | Bun sidecar | 本插件 |
|---|---|---|---|---|
| Harness | 仅 OpenCode | 任意 | 任意 | DeepSeek Harness |
| 免费档 | 有 | 取决于服务方 | 有 | 有 |
| 额外进程 | 无 | 有 | 有 | 无 |
| 原生构建步骤 | 无 | 无 | 有 | 无 |
| 需要维护的基础设施 | 无 | 有一些 | 有一些 | 无 |
| subagent 与并发会话 | 支持 | 支持 | 支持 | 支持 |

## 项目状态

早期阶段，实话实说。一个很小、职责很明确的插件。

- 已在 DeepSeek Harness `0.2.0-rc.2` 和 `0.2.1-alpha.4` 上验证
 （`engines.dsh: ^0.2.0-rc.2`），Node 20.19.2、25.7.0、26.5.0 三个版本实测通过。
- 适用于走 `fetch` 的协议：`openai-completions`、`openai-responses`、`anthropic-messages`。
- Websocket 传输不走 `fetch`，不在支持范围。
- 免费档要求请求里有一个名为 `read` 的工具。dsh 自带一个，所以默认满足；如果你关掉 dsh 的
  `read`，插件会补一个什么都不做的占位工具。
- 匿名免费档本身就是按机器限速的。额度窗口耗尽时，每一个请求 —— 包括完全正确的 —— 都会收到
  同样的 `429`，`retry-after` 倒计到 00:00 UTC。这是上游行为，不是插件的问题。
- 免费档里的个别模型偶尔会在 provider 侧因与凭据无关的原因失败，那也是上游行为。

## 参与贡献

欢迎提 issue 和 pull request。如果你打算新增行为，请一并补上测试；并且在相信任何关于门控的
结论之前重新实测一次 —— 网关的错误码无法告诉你是哪道门触发的。

## 许可证

MIT，见 [LICENSE](LICENSE)。
