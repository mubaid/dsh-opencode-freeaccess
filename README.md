# dsh-opencode-freeaccess

**Use OpenCode's free models in DeepSeek Harness. No proxy, no paid key, no sidecar, no config.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**English** | [简体中文](./README.zh-CN.md)

---

## The problem

You point a DeepSeek Harness provider at `opencode.ai`, pick one of their free
models, and send a message. It fails:

```
429 FreeUsageLimitError: Free usage limit
```

The name is misleading. Nothing is wrong with your quota, your key, or your
model id. OpenCode's anonymous free tier admits a request only when three
independent checks all pass, and answers **every** failure with the same
`429 FreeUsageLimitError` — including a `retry-after` that counts down to
00:00 UTC, so a rejected request looks exactly like a spent bucket:

1. **The TLS ClientHello.** The gateway reads the cipher list the client
   advertises. Node's default hello is refused; the 17 suites the OpenCode CLI
   itself advertises, **in that exact order**, are accepted — including the eight
   legacy suites at the end, which is why reversing the list, dropping them or
   capping at TLS 1.2 each answers 429. Extension order is *not* compared, so a
   tuned `ciphers` list on plain `node:https` is enough: no TLS-impersonation
   addon, no Bun, no proxy.
2. **The session header.** `x-opencode-session` must carry an OpenCode `ses_`
   id. The check is the value's shape: a stale clock still passes (measured: an id
   minted 30 days ago), while `abc-123`, an empty value and the missing header are
   all refused. The plugin mints one per conversation and renews it, which is what
   keeps a session's affinity intact.
3. **The request body.** A tool **named** `read` must be present, the system
   prompt must contain OpenCode's two-line `<env>` block, and `stream` must be
   true. The tool's *definition* is not compared — dsh's own `read` passes.

dsh satisfies none of these today, and none of them is something a provider
config can fix.

Your realistic alternatives are all worse than the fix:

- Run the whole job from inside the OpenCode CLI, losing dsh.
- Pay for a key, losing the free tier.
- Route everything through a proxy or aggregator, adding a hop you now maintain.

## The solution

One plugin, running inside dsh's own Node process, does all three: advertises
the accepted ClientHello, puts a `ses_` id on the wire per conversation, adapts
the body to what the gate inspects, and performs the request over `node:https`.

```
dsh plugin --profile web add github:mubaid/dsh-opencode-freeaccess
```

Restart the profile. OpenCode's free models now work in dsh.

## The wow moment

Before:

```
opencode / deepseek-v4.1-flash-free
> 429 {"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit…"}}
```

After the install line above, same provider, same model, same key:

```
opencode / deepseek-v4.1-flash-free
> streaming normally
```

No new provider block. No gateway. No Bun. No native addon. No second Node
version. No per-request anything.

## Why this project

**It targets the real gates, not the error message.** The 429 says "quota" and
means "you are not OpenCode's client". Each of the three checks above was
isolated with bracketed live measurements — every rejection is surrounded by a
known-good control, so a gate result can never be confused with a closed
window. See [VERIFICATION.md](VERIFICATION.md).

**It needs no dependencies.** "Only the CLI's TLS client is accepted" reads like
a job for a native TLS-impersonation addon, and this plugin had one. The
measurements said otherwise: the gate is the *cipher list*, and Node can send
that with one option on `node:https`. The addon is gone, so `dsh plugin add`
still installs with no build step and no toolchain, on any Node dsh itself
supports — verified live on Node 20.19.2, 25.7.0 and 26.5.0.

**One conversation, one id per clock window.** A `ses_` id is minted from
`Date.now()` and reused for that conversation for `sessionTtlMs` (default 10
minutes), then re-minted. The gateway compares the value's shape, not its clock
(measured: a 30-day-old grammatical id still streams), but an id that never
renews is what pins a long-lived session to a stale server-side entry, so the
plugin renews it anyway. Concurrent conversations never share an id: each
request is scoped with async context.

**It cannot change your replies.** Response bytes pass through untouched. The
request-side changes are confined to opencode routes: session headers, the
`<env>` block, one placeholder `read` tool *only if the caller has none*, and
the transport. There is a test that diffs a matched request against an
untouched control and asserts the delta is exactly what the plugin documented.

**It works with whatever route you already have.** A direct `opencode.ai`
provider, or your own gateway or proxy. Point `baseURLs` at it.

## Key features

- **Free tier unlocked.** OpenCode's free models become usable from dsh, in
  process, with no sidecar.
- **No native dependency, no runtime upgrade.** Node core only.
- **Concurrent-session safe.** Session scoping uses `AsyncLocalStorage`, so
  parallel conversations and subagents do not bleed into each other.
- **Session-scoped ids.** Every `ses_` id is minted from the current clock and
  renewed per conversation; the gateway checks the value's shape, not its clock.
- **Body adaptation with a switch.** `adaptBody: false` sends your bytes
  untouched (the free tier will refuse them — useful for debugging).
- **Transport switch.** `transport: "fetch"` keeps Node's `fetch` if you must
  route through a proxy or a custom CA it handles better.
- **Scoped by default.** Only matching hosts are touched; everything else is
  forwarded with its exact original arguments.
- **Observable.** `verbose: true` logs each id, the adapted tool list, the
  status, and — for a 429 — whether the `retry-after` looks like quota or
  like one of the gates.

## Quick start

```bash
dsh plugin --profile web add github:mubaid/dsh-opencode-freeaccess
systemctl restart dsh-web
```

That is the whole setup. Defaults match `opencode.ai` and the standard routes.

To see it working:

```bash
journalctl -u dsh-web -f | grep opencode-freeaccess
```

## Real-world examples

**A long agentic session.** Each conversation carries one id for a clock window
at a time, so upstream sees a steady client instead of a new one per request,
which is what prompt-cache affinity wants.

**Parallel subagents.** Fan out ten subagents. Each carries its own id and none
contaminates the others.

**Self-hosted only.** If you would rather not hand traffic to an aggregator,
this keeps the path from dsh to OpenCode direct, with the free tier intact.

**Migrating off a proxy.** Drop the proxy hop and keep the models.

## Technical details

What is put on an opencode request:

| Change | Detail |
|---|---|
| `x-opencode-session` | The `ses_` id the gateway checks for a grammatical value |
| `x-opencode-session-id` | Companion session header the CLI sends |
| `x-session-affinity`, `x-session-id` | Affinity family, harmless duplicates |
| `x-opencode-client: cli`, `x-opencode-project: global` | Client fingerprint headers |
| `User-Agent: opencode/latest/<version>/cli` | Client fingerprint |
| `accept: text/event-stream` | Set when the body was adapted |
| body | `<env>` block, placeholder `read` if absent, `stream: true`, `tool_choice: "none"` → `"auto"` |
| transport | The HTTP request runs over `node:https` with the CLI's accepted cipher list; on a socket error the plugin retries once with `fetch` |

`x-opencode-request` is deliberately **not** sent: it is a v1 header and the v2
free tier refuses it.

The id format is OpenCode's own: `ses_`, then 12 hex characters of
`~(Date.now() * 0x1000 + counter)` over the low 48 bits, then 14 random base62
characters. The gate checks the shape — a `ses_` prefix with both halves present,
so `abc-123` and an empty header are refused — plus a loose bound on the decoded
time: a 30-day-old id still streams, an id that decodes to the far future does
not. Minting from `Date.now()` satisfies both without reading a clock skew.

Everything is configurable from the profile's patch layer under the id
`opencode-freeaccess`: `providers`, `hosts`, `baseURLs`, `headers`,
`extraHeaders`, `userAgent`, `sessionIdEnv`, `sessionTtlMs`, `verbose`,
`seedSessionId`, `disableFetchInjection`, `adaptBody`, `transport`. Defaults
are documented in [docs/design.md](docs/design.md).

Implementation notes, the test suite, and an explicit list of what has not been
verified are in [VERIFICATION.md](VERIFICATION.md).

## Comparison

| | OpenCode CLI | Proxy or aggregator | Bun sidecar | This plugin |
|---|---|---|---|---|
| Harness | OpenCode only | Any | Any | DeepSeek Harness |
| Free tier | Yes | Depends on the provider | Yes | Yes |
| Extra process | No | Yes | Yes | No |
| Native build step | No | No | Yes | No |
| Infrastructure to maintain | None | Some | Some | None |
| Subagents and parallel sessions | Yes | Yes | Yes | Yes |

## Project status

Early, and honest about it. A small plugin with a narrow, well-defined job.

- Verified against DeepSeek Harness `0.2.0-rc.2` and `0.2.1-alpha.4`
  (`engines.dsh: ^0.2.0-rc.2`), on Node 20.19.2, 25.7.0 and 26.5.0.
- Works over `fetch`-based protocols: `openai-completions`, `openai-responses`,
  `anthropic-messages`.
- Websocket transports do not use `fetch` and are not supported.
- The free tier requires a tool named `read` in the request. dsh ships one, so
  this holds by default; if you disable dsh's `read`, the plugin adds an inert
  placeholder instead.
- The anonymous free tier is rate-limited per machine by design. When the
  window is spent, every request — including a perfect one — gets the same
  `429` with a `retry-after` counting down to 00:00 UTC. That is upstream
  behaviour, not a plugin fault.
- Individual free-tier models occasionally fail at the provider for reasons
  unrelated to credentials.

## Contributing

Issues and pull requests are welcome. If you are adding behaviour, please add a
test with it, and re-measure the gates before trusting a claim about them — the
gateway's error code cannot tell you which gate fired.

## License

MIT. See [LICENSE](LICENSE).
