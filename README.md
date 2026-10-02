# dsh-opencode-freeaccess

**Use OpenCode's free models in DeepSeek Harness. No proxy, no paid key, no config.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**English** | [简体中文](./README.zh-CN.md)

---

## The problem

You point a DeepSeek Harness provider at `opencode.ai`, pick one of their free
models, and send a message. It fails:

```
403 FreeTierError: OpenCode's free tier can only be used from within OpenCode
```

Nothing is wrong with your key, your model id, or your harness. OpenCode serves
its free tier only to requests that carry a session id, and dsh does not put one
on the wire.

Your realistic options are all worse than the fix:

- Run the whole job from inside the OpenCode CLI, losing dsh.
- Pay for a key, losing the free tier.
- Route everything through a proxy or aggregator, adding a hop you now maintain.

## The solution

One plugin puts the session id on the request. That is the whole job.

```
dsh plugin --profile web add github:mubaid/dsh-opencode-freeaccess
```

Restart the profile. OpenCode's free models now work in dsh.

## The wow moment

Before:

```
opencode2 / space-bunny-free
> 403 FreeTierError: OpenCode's free tier can only be used from within OpenCode
```

After the install line above, same provider, same model, same key:

```
opencode2 / space-bunny-free
> streaming normally
```

No new provider block. No gateway. No per-request anything.

## Why this project

**It targets the real gap, not a symptom.** dsh already knows the session id.
The adapter simply never forwards it. This closes that gap at the only layer
that can reach the wire, so you inherit the behaviour instead of rebuilding it.

**One conversation, one stable id.** The id is derived from the conversation's
birth time and its uuid, so it survives a restart and is identical afterwards.
Conversations running at the same time never share an id.

**It cannot change your output.** Only request headers are added. Body, URL,
method, credentials and response pass through untouched, and requests to any
other host are forwarded with their exact original arguments. There is a test
that diffs a matched request against an untouched control and asserts the
headers are the only difference.

**It works with whatever route you already have.** A direct `opencode.ai`
provider, or your own gateway or proxy. Point `baseURLs` at it.

## Key features

- **Free tier unlocked.** OpenCode's free models become usable from dsh.
- **Stable per-conversation identity.** Upstream gets a consistent id instead of
  a fresh one per request, which is what prompt-cache affinity needs.
- **Concurrent-session safe.** Session scoping uses async context, so parallel
  conversations do not bleed into each other.
- **Subagents included.** Each subagent mints its own id from its own
  conversation, so child sessions work too.
- **Headers only.** Nothing about the prompt or the reply changes.
- **Scoped by default.** Only matching hosts are touched.
- **Observable.** `verbose: true` logs every id it sends.
- **No build step.** Plain ESM, installs from GitHub with no extra permission.

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

**A long agentic session.** The conversation id stays constant for the whole
run, so upstream can keep one prompt cache warm instead of rebuilding it.

**Parallel subagents.** Fan out ten subagents. Each carries its own id and none
contaminates the others.

**Self-hosted only.** If you would rather not hand traffic to an aggregator,
this keeps the path from dsh to OpenCode direct, with the free tier intact.

**Migrating off a proxy.** Drop the proxy hop and keep the models.

## Technical details

The header set, in full:

| Header | Purpose |
|---|---|
| `x-opencode-session` | The session header the OpenCode gateway keys on |
| `x-session-affinity` | Affinity family, for cache and routing |
| `x-client-request-id` | Per-request identity the Zen backend expects |
| `x-session-id` | Companion affinity header |
| `X-OpenCode-Client: cli` | Client fingerprint |
| `User-Agent: opencode/<version>` | Client fingerprint |

The id format is OpenCode's own: `ses_`, then 12 hex characters derived from the
conversation's creation time, then 14 characters derived from the conversation
uuid. One dsh conversation maps to exactly one id, for its whole life.

Everything is configurable from the profile's patch layer under the id
`opencode-freeaccess`: `providers`, `hosts`, `baseURLs`, `headers`,
`extraHeaders`, `userAgent`, `sessionIdEnv`, `verbose`, `seedSessionId`,
`disableFetchInjection`. Defaults are documented in
[docs/design.md](docs/design.md).

Implementation notes, the test suite, and an explicit list of what has not been
verified are in [VERIFICATION.md](VERIFICATION.md).

## Comparison

| | OpenCode CLI | Proxy or aggregator | This plugin |
|---|---|---|---|
| Harness | OpenCode only | Any | DeepSeek Harness |
| Free tier | Yes | Depends on the provider | Yes |
| Extra hop | No | Yes | No |
| Infrastructure to maintain | None | Some | None |
| Subagents and parallel sessions | Yes | Yes | Yes |

## Project status

Early, and honest about it. A small plugin with a narrow, well-defined job.

- Verified against DeepSeek Harness `0.2.0-rc.2`.
- Works over `fetch`-based protocols: `openai-completions`, `openai-responses`,
  `anthropic-messages`.
- Websocket transports do not use `fetch` and are not supported.
- The OpenCode free tier expects the `bash`, `glob`, `grep` and `read` tools to
  be present in the request. dsh ships tools with exactly those names, so this
  holds by default, but disabling any of them will make the gateway reject the
  request.
- Individual free-tier models occasionally fail at the provider for reasons
  unrelated to credentials. That is upstream behaviour, not a plugin fault.

## Contributing

Issues and pull requests are welcome. If you are adding behaviour, please add a
test with it and keep the headers-only guarantee intact.

## License

MIT. See [LICENSE](LICENSE).