# dsh-opencode-freeaccess

**在 DeepSeek Harness 里用上 OpenCode 的免费模型。不需要代理、不需要付费 key、不需要配置。**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[English](./README.md) | **简体中文**

---

## 问题所在

你把 DeepSeek Harness 的 provider 指向 `opencode.ai`，选一个他们的免费模型，
发一条消息，然后失败了：

```
403 FreeTierError: OpenCode's free tier can only be used from within OpenCode
```

你的 key、模型 id、harness 都没问题。OpenCode 的免费额度只提供给携带 session
id 的请求，而 dsh 并没有把这个 id 发到 wire 上。

现实中你可选的几条路，都比直接修掉它更糟：

- 整个活儿都改在 OpenCode CLI 里跑，等于放弃 dsh。
- 付费买 key，等于放弃免费额度。
- 全量走代理或聚合服务，多出一个要自己维护的跳板。

## 解决方案

一个插件，把 session id 放到请求上，这就是全部。

```
dsh plugin --profile web add github:mubaid/dsh-opencode-freeaccess
```

重启该 profile，OpenCode 的免费模型就在 dsh 里跑起来了。

## 惊喜时刻

之前：

```
opencode2 / space-bunny-free
> 403 FreeTierError: OpenCode's free tier can only be used from within OpenCode
```

装完上面那行之后，同一个 provider、同一个模型、同一个 key：

```
opencode2 / space-bunny-free
> 正常流式输出
```

不用新写 provider 配置，不用网关，不用任何逐请求设置。

## 为什么是这个项目

**它修的是真正的缺口，不是表象。** dsh 本来就知道 session id，只是适配器没有
转发出去。插件在唯一能触达 wire 的那一层补上它，于是你直接继承这个行为，而不用
自己重新实现一遍。

**一个会话，一个稳定 id。** id 由会话的创建时间和 uuid 派生，因此重启后不变、
重启后完全一致。并发运行的会话之间不会共用 id。

**它无法改变你的输出。** 只增加请求头。请求体、URL、方法、凭据和响应全部原样
透传，指向其它 host 的请求以完全相同的原始参数转发。有一个测试会把命中目标
的请求与未改动的对照请求做diff，断言唯一的差别就是那些请求头。

**你现有的任何链路都能用。** 直连 `opencode.ai` 的 provider，或者你自己的网关、
代理，把 `baseURLs` 指过去即可。

## 主要特性

- **解锁免费额度。** OpenCode 的免费模型可以在 dsh 里直接使用。
- **按会话稳定的身份。** 上游拿到的是一个一致的 id，而不是每个请求换一个，这正是
  prompt cache 亲和性需要的。
- **并发会话安全。** 会话作用域基于 async context，并行会话之间不会互相污染。
- **子 agent 同样覆盖。** 每个 subagent 用自己的会话生成自己的 id，子会话也能用。
- **只改请求头。** prompt 和回复都不会被改变。
- **默认有作用域。** 只处理匹配到的 host。
- **可观测。** `verbose: true` 会打印它发出的每个 id。
- **无构建步骤。** 纯 ESM，从 GitHub 安装不需要额外授权。

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

**一次长时间的任务。** 会话 id 在整个运行期间保持不变，上游可以持续复用同一份
prompt cache，而不必反复重建。

**并行 subagent。** 扇出十个 subagent，各自携带自己的 id，互不干扰。

**只想自托管。** 如果你不愿意把流量交给聚合服务，这条路径是 dsh 直连 OpenCode，
免费额度照常可用。

**从代理上迁走。** 去掉代理这一跳，模型继续用。

## 技术细节

完整的请求头集合：

| 请求头 | 作用 |
|---|---|
| `x-opencode-session` | OpenCode 网关据以识别会话的请求头 |
| `x-session-affinity` | 亲和性族，用于缓存与路由 |
| `x-client-request-id` | Zen 后端期望的逐请求身份 |
| `x-session-id` | 配套的亲和性请求头 |
| `X-OpenCode-Client: cli` | 客户端指纹 |
| `User-Agent: opencode/<version>` | 客户端指纹 |

id 格式就是 OpenCode 自己的：`ses_` 开头，接着是 12 位由会话创建时间导出的 hex，
再接着 14 位由会话 uuid 导出的字符。一个 dsh 会话在整个生命周期内对应且仅对应
一个 id。

所有选项都能在 profile 的 patch 层配置，id 为 `opencode-freeaccess`：`providers`、
`hosts`、`baseURLs`、`headers`、`extraHeaders`、`userAgent`、`sessionIdEnv`、
`verbose`、`seedSessionId`、`disableFetchInjection`。默认值见
[docs/design.md](docs/design.md)。

实现说明、测试套件，以及一份明确的「未验证」清单见
[VERIFICATION.md](VERIFICATION.md)。

## 对比

| | OpenCode CLI | 代理或聚合服务 | 本插件 |
|---|---|---|---|
| Harness | 仅 OpenCode | 任意 | DeepSeek Harness |
| 免费额度 | 有 | 取决于服务方 | 有 |
| 额外跳板 | 无 | 有 | 无 |
| 需要维护的基础设施 | 无 | 有一些 | 无 |
| subagent 与并发会话 | 支持 | 支持 | 支持 |

## 项目状态

早期阶段，实话实说。一个很小、职责很明确的插件。

- 已在 DeepSeek Harness `0.2.0-rc.2` 上验证。
- 适用于走 `fetch` 的协议：`openai-completions`、`openai-responses`、
  `anthropic-messages`。
- Websocket 传输不走 `fetch`，不在支持范围。
- OpenCode 免费额度要求请求里带有 `bash`、`glob`、`grep`、`read` 这几个工具。dsh
  自带工具的名字恰好就是这四个，所以默认满足；但关掉其中任何一个，网关都会拒绝
  该请求。
- 免费额度里的个别模型偶尔会在 provider 侧因与凭据无关的原因失败，那是上游行为，
  不是插件的问题。

## 参与贡献

欢迎提 issue 和 pull request。如果你打算新增行为，请一并补上测试，并保持
「只改请求头」这一保证不被破坏。

## 许可证

MIT，见 [LICENSE](LICENSE)。