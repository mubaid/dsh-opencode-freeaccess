# Verification

What was actually run against `dsh-opencode-freeaccess` 0.4.0, and what was not.
Kept out of [README.md](README.md) so that file can stay a description of the
product.

Verified against DeepSeek Harness `0.2.0-rc.2` and `0.2.1-alpha.4`
(`engines.dsh: ^0.2.0-rc.2`, contract-tested against the host's real
`evaluatePluginCompatibility`). Test runs below were on Node **v20.19.2, v25.7.0
and v26.5.0**; the whole suite passes on all three, and no native addon is
involved, so no runtime is special and no runtime upgrade is needed.

## Summary

| Check | Result |
| --- | --- |
| Offline suite (`npm test`) | Passes on all three runtimes: 20 checks in `verify.mjs`, plus apply, stdout-hygiene and engines-compat suites |
| Live free-tier end-to-end (`npm run test:live`) | Section A1 streamed `PONG` through the real pi-ai stack on Node 25.7.0 with A2/A3 as negative controls; gates B0–B5 bracketed green; the anonymous window then reset mid-run — see "Live status" below |
| `dsh --profile web --dump-config` | Shows the plugin entry with its config applied |
| Behaviour in a real profile | Session headers observed on the wire in `journalctl -u dsh-web` |
| Install on `0.2.1-alpha.4` | `dsh plugin --profile scratch-opencode-compat add` succeeds; `--dump-config` shows the layer; scratch web profile boots with the plugin mounted and no warnings |

## The tests

`npm test` runs four suites directly with node, in order:

- `test/verify.mjs` — 20 checks. Unit coverage of the target matcher and the
  header merge; integration against the real pi-ai library dsh's `llm-pi-ai`
  adapter uses, asserting the session headers AND the adapted body (a `read`
  tool, both `<env>` lines, `stream: true`, `accept: text/event-stream`) reach
  the wire; concurrent-session isolation; a non-opencode host left alone; a
  matched request with `adaptBody: false` diffed byte-for-byte against an
  untouched control, with the delta asserted to be exactly the injected headers;
  `ses_` mint **and decode** (`sesTokenTime`, in the id's wrapped mod-2^36
  space); `adaptGateBody` edge cases (the caller's own `read` is never touched,
  exactly one placeholder appended, idempotence, all four system-prompt
  carriers); `prepareBody`; the cipher list itself — `FREE_TIER_CIPHERS` maps to
  the 17 IANA codes in the order the CLI puts on the wire, and reversing it,
  dropping the legacy eight, or capping at TLS 1.2 each measured `429`; and the
  transport takeover — `sendOverNodeTransport` is driven with
  `node:https.request` stubbed, so without any network the test asserts the
  explicit `servername`, the `ciphers` option, the recomputed `content-length`,
  `accept-encoding: identity`, the hop-by-hop headers that get dropped, the
  verbatim body bytes, that the caller's `AbortSignal` survives, and that the
  result is a standard `Response`. A socket error rejects, and the wrapper then
  retries once with the platform `fetch`.
- `test/smoke-apply.mjs` — `apply()` wiring: the waterfall listener registers, the
  scoped fetch carries the right id, mount/dispose restore the previous fetch,
  and the adapted body plus the untouched response come back through the real
  wrapper.
- `test/stdout-hygiene.mjs` — the profile's own protocols keep stdout clean; the
  mount banner and verbose log go to stderr.
- `test/engines-compat.mjs` — 5 checks. Calls the real
  `evaluatePluginCompatibility` from the dsh checkout (not a reimplementation)
  with the shipped `package.json`: the verified runtimes `0.2.0-rc.2` and
  `0.2.1-alpha.4` are admitted with no exemption, and `0.1.0`, `0.2.0-rc.1`
  and `0.3.0` are rejected as unmet.

`npm run test:live` runs `test/verify-live-opencode2.mjs`, the end-to-end proof
against the anonymous free tier. It drives real pi-ai over the real network
through this plugin's own wrapper and is written so that a closed quota window
cannot produce a fake result:

- **A. the real stack** — dsh-shaped request accepted with content; the same
  request with `adaptBody: false` refused; the same request with
  `transport: "fetch"` refused. That last cell is the one that justifies the
  takeover: `globalThis.fetch` cannot be handed the accepted cipher list.
- **B. each gate one variable at a time**, over the plugin's own transport, with
  every cell **bracketed** by a known-good control before and after it. A cell
  is only asserted when both controls returned 200; if either fails, the cell is
  reported inconclusive and the section stops. A control that answers `429` with
  a short `retry-after` is the lane's burst limiter rather than the daily window,
  so the control waits and retries before giving up, and each cell ends with a
  2-second pause to keep the burst limiter off the results. Cells: `B0` accepted
  shape, `B1` no `<env>`, `B2` `read` with dsh's schema, `B3` no `read`, `B4`
  `stream: false`, `B5` session header absent, `B6` grammatical id with a
  30-day-old clock (accepted — the clock is not checked), `B7` a NON-clock
  grammatical id (accepted — only the shape is), `B8` `abc-123` (refused),
  `B9` empty header (refused).
- **C. wire evidence** — the header set the wrapper produces, with the clock half
  decoded back to within 5 minutes of now inside the id's wrapped mod-2^36 space,
  and the fingerprint headers present. Runs regardless of the window, because it
  inspects the request, not the answer. The cipher list handed to `node:https` is
  asserted offline in `verify.mjs`, not here — section C spies on the `fetch`
  path, where no socket option is visible.

## How the free tier was identified

The gateway answers its gate rejections with the **same** `429
FreeUsageLimitError` it uses for a spent quota window, and `retry-after` looks
alike in both cases. Every claim below therefore comes from a bracketed run —
a rejection counted only when the neighbouring controls were green. Three
conclusions were produced in earlier passes and are now retracted; the record is
kept here because each retraction cost real time:

- ~~"opencode's `read` and `shell` definitions are compared verbatim"~~. Measured:
  a tool **named** `read` with dsh's own `filePath` schema is accepted (control
  green on both sides); `shell` is not required; an empty `tools` array, or one
  without a `read`, is refused. The plugin therefore aliases nothing and rewrites
  no response — the alias/restore machinery was removed with this.
- ~~"the ClientHello is not a gate; the gate is the HTTP client"~~. This was the
  wrong read of a confounded experiment. The 2026-10-26 runs captured the CLI's
  own request through a local CONNECT proxy, then replayed it **byte-identically**
  from the plugin's transport: Bun 200, Node 429 on all three lanes (HTTP/1.1,
  h2, undici). One variable remained — the TLS handshake — and the isolation was
  decisive: the CLI advertises 17 cipher suites in a fixed order; Node's default
  hello advertises 52 in OpenSSL's order and is refused. Reversing the accepted
  list: refused. Dropping its eight legacy suites: refused. TLS 1.3 only: refused.
  Capping at TLS 1.2: refused. Setting curves or `ecdhCurve` alone: irrelevant.
  `@SECLEVEL=0`: not required. The hello **extension** set and order are not
  compared — Node omits `status_request`, `signature_algorithms_cert` and
  `padding`, and advertises `encrypt_then_mac`, and still passes. So one
  `ciphers:` option on `node:https` is the entire fix, verified live on Node
  20.19.2, 25.7.0 and 26.5.0 with a byte-identical handshake. `globalThis.fetch`
  cannot be given that list, which is why the plugin still performs the request
  itself. The old "no addon is needed" conclusion survives; the reason given for
  it did not.
- ~~"the server reads the session id's clock back, so an id cannot outlive its
  window"~~. Measured with the cipher gate held constant: a missing, empty or
  ungrammatical (`abc-123`) `x-opencode-session` is refused, while a grammatical
  id minted 30 days in the past, and one with a zeroed time half, both stream.
  The check is the value's **shape**, with a loose bound against a value that
  decodes to the far future (a 400-day-forward id is refused). Renewal is kept
  because an id that never changes pins a long conversation to one stale
  server-side entry, not because the clock is enforced.
- ~~"`x-opencode-project` is the quota key"~~. Measured across eight id variants;
  the answer does not move. The anonymous lane is paced per machine by burst as
  well as by day: a control can `429` with a short `retry-after` mid-run and
  recover after a wait, while a `retry-after` over ~600s is the daily window.

The gates as they now stand:

| # | Gate | Satisfied by | Observed when missing |
| --- | --- | --- | --- |
| 1 | `Authorization: Bearer public` | the provider's `apiKey` setting | `401 AuthError: Invalid API key.` |
| 2 | The ClientHello advertises the CLI's 17 cipher suites, in order, over a client that can be told to (`node:https` + `servername`) | this plugin (`FREE_TIER_CIPHERS`, `transport`) | refused; identical bytes, different hello |
| 3 | `x-opencode-session` carries a grammatical `ses_` id | this plugin, minted from `Date.now()` | refused (`abc-123` and empty both refused) |
| 4 | Body: a tool **named** `read`, the two-line `<env>` block, `stream: true` | this plugin (`adaptBody`) | refused (each variable isolated, controls green) |

The opencode client fingerprints (`User-Agent`, `x-opencode-client`,
`x-opencode-project`) are sent because the official client sends them; no
bracketed run has yet shown the `User-Agent` alone to be load-bearing, so treat
that row of the older docs as unproven rather than measured. `x-opencode-request`
is not sent: it is v1-only.

The CLI's own request was captured once through a process-scoped local proxy
(`HTTPS_PROXY` with a throwaway CA in `NODE_EXTRA_CA_CERTS`) and is the source
for the ground truth above: same URL, `Authorization: Bearer public`, UA
`opencode/latest/2.1.4/cli`, a real sha1 `x-opencode-project`, `b3` and
`traceparent` telemetry ids, `accept: */*`, `accept-encoding: gzip, deflate, br,
zstd`, `connection: keep-alive`. Of those, only the cipher list turned out to
matter: eight different `x-opencode-project` values, including a freshly computed
sha1, produced the same answer as `global`, so it keys nothing. `b3` and
`traceparent` are not sent by this plugin and nothing refused them.

**Retracted: "a fresh CLI got the same 429, so the window was closed".** That `opencode run
--standalone` 429 went through the local CONNECT tap, whose upstream leg is a Node TLS
connection, so it never tested the CLI's own handshake. The "per-connection window" explanation
built on it is withdrawn. Measured on 2026-10-26 around 10:45 UTC, with no proxy, in the same few
minutes:

- `opencode run --standalone -m opencode/mimo-v2.6-flash-free` streamed `PONG`.
- This plugin's `sendOverNodeTransport` lane (17-suite hello, `Bearer public`) got `200`.
- `npm run test:live` passed all 16 checks. A1 streamed `PONG`, A2/A3 were refused, and B0–B9
  matched.
- `dsh --profile <scratch headless + this plugin>` with `OPENCODE2_API_KEY=public` streamed `PONG`.
  dsh's real agent body (23 tools, full system prompt) and its title call both returned `200`.
- Auth: `Bearer public` and no `Authorization` header both returned `200`. An empty key,
  `Bearer dummy` and a fake `sk-…` key each returned `401 Invalid credential`, not `429`.

So a dsh deployment that gets `429` while all of the above pass is sending something other than
`Bearer public`. The usual cause is a real opencode account key stored for `OPENCODE2_API_KEY`
in dsh's credentials service: invalid keys return `401`, so a key that gets `429` is valid, and
its traffic is metered against that account.

Path notes measured the same day on the anonymous endpoint: `/inference/v1/models` 200 (85 models,
8 `*-free`, including `mimo-v2.6-flash-free`), `/inference/go/v1/models` 200 (38 models, 2
`*-free`, no `mimo…`), `/inference/openai/v1/models` 404 while `/inference/openai/v1/chat/completions`
is the path the CLI posts to. A profile pointing at `/inference/v1` is therefore valid for the free
tier.

One detail from the first pass at this problem, because it also cost time: pi-ai does not read a
`tools` field on the request context. It resolves the request's `tools` array from the transcript,
where declarations live on the system message's `toolsAdded`. A test that declares tools the obvious
way silently sends `tools: []` and fails even though the code looks correct.

## Live status (2026-10-26)

The fix is proven end to end. With the accepted cipher list in place, on Node
**v25.7.0** — the runtime the live `dsh-web` service uses — the live suite ran:

- `A1` a real pi-ai stream through the plugin's own wrapper returned `"PONG"`,
  with the wrapper reporting `tools=[read, bash] env=ok stream=true`.
- `A2` the same request with `adaptBody: false` → refused, and `A3` the same
  request with `transport: "fetch"` → refused. Both negative controls behaved,
  so A1's 200 came from the plugin's work, not from a lax gateway.
- `B0`–`B5` — the body and session-header gates — each bracketed by controls that
  were 200 on both sides.

The anonymous daily window for this machine then closed mid-run (`429`,
`retry-after 57217s`, resetting **2026-10-27T00:00Z**), so `B6`–`B9` and section
`A`'s re-run are pending on the next window; nothing else is unknown. `B6`–`B9`
and the cipher cells were measured in the isolated probes the retraction section
describes. **Re-run `npm run test:live` after a reset** to get one green A + B
run in a single sitting.

The window itself is easy to misread and the suite is written around that:
the lane both paces bursts (short `retry-after`, clears in seconds) and enforces
a daily quota (`retry-after` over ~600s), and every gate rejection is the same
`429 FreeUsageLimitError`. A result measured against a closed window means
nothing, which is why no cell in section B is asserted without a 200 on each side
of it.

Model discovery is dynamic: the free ids in the pi-ai catalog rotate, so the live
suite takes its candidates from `https://models.opencode.ai/api.json` — the
remote catalog, provider `opencode`, api `https://opencode.ai/inference/openai/v1`,
44 `*-free` ids — and falls back to the installed `providers/data/opencode-go.json`
only if that read fails. The three `*-free` ids in pi-ai 1.3.0's bundled catalog
are dead: `400 Model is unavailable` or `410 ModelDeprecated`. The catalog's own
`baseUrl` (`/inference/go/v1`) is the *subscribed* path and answers `401` to
`Bearer public` — that is why the plugin's default `baseURLs` are host-scoped
rather than taken from the catalog.

## Models seen

- The remote catalog's `*-free` ids served 200 anonymously through the plugin's
  transport during the 2026-10-26 runs; the suite picks one it can prove with and
  prints the id in the check label.
- `cat-jam-free`, `longcat-2.5-preview-free`, `step-5-preview-free` — pi-ai's
  earlier local catalog; `step-5-preview-free` 400s on the anonymous path, and
  `/inference/go/v1` 401s for all of them.
- `fledge-alpha-free`, `space-bunny-free` on `opencode.ai/zen/v1`, anonymous
  (earlier endpoint, earlier catalog).

## Not verified

These were not run, and nothing in this repository claims they were:

- A single sitting in which the whole live suite (`A1`–`A3`, `B0`–`B9`, `C`) is
  green back to back. `A1`–`A3` and `B0`–`B5` ran green on 2026-10-26; the daily
  window closed before `B6`–`B9`, whose behaviour was measured separately with
  the cipher gate held constant.
- Whether the accepted cipher list is a permanent property of the gateway. It is
  what the CLI happened to advertise on 2026-10-26; opencode can change its TLS
  configuration in a release, and this plugin's constant goes stale with it. The
  live suite is the way to re-measure it.
- `dsh plugin add` from GitHub. The package is not published to npm, so the
  documented install is the GitHub route. The repository is public and clones
  cleanly, and `dsh` resolves the package from it, but the full
  `dsh plugin add` flow has not been run end to end since the native dependency
  was removed.
- `--dump-config-schema` and the Settings screen. The plugin ships no Schemastery
  `Config`, so there are no volatile fields to project and nothing was checked
  about the generated settings form.
- `node --test`. The suites are plain node scripts, not a `node --test` suite.
- Websocket transports, which do not reach the fetch wrapper.
- Host matching against anything other than `opencode.ai` and the negative case.
- Any pi-ai other than the 1.3.0 copy resolved from the dsh checkout at test
  time. The model entry is picked to carry a `baseUrl`, which pi-ai 1.x requires.
- Behaviour under an authenticated (`sk-…`) opencode key. The fingerprint is
  aimed at the anonymous free tier only.
- Proxy or custom-CA deployments. `transport: "fetch"` exists for them, and the
  node:https takeover deliberately does **not** inherit undici's dispatcher
  configuration; that combination is untested. Note the consequence measured on
  2026-10-26: the `fetch` path cannot set the accepted cipher list, so a
  deployment that needs it will get `429` on the free tier and must keep the
  default transport.

## Known deviations from the porting rules

Recorded rather than smoothed over:

- **R5, API surface.** The plugin wraps `globalThis.fetch`. That is a global
  monkey-patch rather than a public Cordis service. It is the only layer that can
  reach the wire, because the `llm-pi-ai` adapter drops per-request headers and
  keeps the session-affinity compat gate closed. The wrapper is installed once,
  scoped to matching hosts, and restored on dispose.
- **R5, transport takeover.** For matched opencode URLs the wrapper does not call
  `fetch` at all; it performs the request with `node:https`, sets `servername` and
  the `FREE_TIER_CIPHERS` list, and hands back a standard `Response`. That is the
  fix for gate 2 — `globalThis.fetch` gives no way to shape the ClientHello — and
  the reason the plugin needs a config escape hatch (`transport: "fetch"`) rather
  than a build-time switch.
- **Request bodies are edited.** `adaptBody` (default on) rewrites the JSON of an
  LLM request on a matched route. This is opt-out, confined to opencode routes,
  and reverted-by-design is not needed: responses pass through untouched.
- **§4, configuration schema.** There is no exported Schemastery `Config`.
  Configuration is normalised in `normalize()` instead, so the plugin gets no
  Settings form, but the schema requirement itself is unmet.
- **§7 gate 1.** The suite is not `node --test`.
