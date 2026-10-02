# Verification

What was actually run against `dsh-opencode-freeaccess` 0.2.0, and what was not.
Kept out of [README.md](README.md) so that file can stay a description of the
product.

Verified against DeepSeek Harness `0.2.0-rc.2`, the version pinned in
`engines.dsh`. Test runs below were on Node v25.7.0.

## Summary

| Check | Result |
| --- | --- |
| Offline suite (`npm test`) | Passes: 11 checks plus the apply and stdout-hygiene suites |
| Live free-tier end-to-end | Passes: 3 checks against `https://opencode.ai/zen/v1` |
| `dsh --profile web --dump-config` | Shows the plugin entry with its config applied |
| Behaviour in a real profile | Session headers observed on the wire in `journalctl -u dsh-web` |

## The tests

`npm test` runs three suites directly with node, in order:

- `test/verify.mjs` — 11 checks. Unit coverage of the target matcher and the
  header merge, then integration: it drives the real pi-ai library that dsh's
  `llm-pi-ai` adapter uses and asserts the outgoing request carries the session
  headers. Also covers concurrent-session isolation, that a non-opencode host is
  left alone, and that a matched request differs from an untouched control only
  by the injected headers.
- `test/smoke-apply.mjs` — `apply()` wiring: the waterfall listener registers, the
  scoped fetch carries the right id, and the fetch wrapper is restored on dispose.
- `test/stdout-hygiene.mjs` — the profile's own protocols keep stdout clean; the
  mount banner and verbose log go to stderr.

`npm run test:live` runs `test/verify-live-opencode2.mjs`, which is the
end-to-end proof for the anonymous free tier. It drives real pi-ai over the real
network, through this plugin's own fetch wrapper, and asserts three things: the
gateway answers with real content, every session header plus the opencode
`User-Agent` and client fingerprint are on the wire with the authorization header
and body untouched, and dropping the `{bash, glob, grep, read}` quartet
reproduces `403 FreeTierError`. It uses only the free tier, so it costs nothing.

## How the free tier was identified

The gateway refuses anonymous free-tier requests that do not look like the
official client. Bisecting live established four gates:

| # | Gate | Satisfied by | Failure when missing |
| --- | --- | --- | --- |
| 1 | `Authorization: Bearer public` | the provider's `apiKeyEnv` secret | `401 AuthError: Invalid API key.` |
| 2 | `User-Agent: opencode/<version>` | this plugin | `403 FreeTierError` |
| 3 | Canonical `ses_` session id headers | this plugin | `403 FreeTierError` |
| 4 | `tools` including `{bash, glob, grep, read}`, and `stream: true` | dsh itself | `403 FreeTierError` |

Gate 4 needs nothing from this plugin. dsh's built-in tools are named exactly
`bash`, `glob`, `grep` and `read`, and pi-ai streams by default, so both are
already true on the wire.

One detail worth recording, because it cost time: pi-ai does not read a `tools`
field on the request context. It resolves the request's `tools` array from the
transcript, where declarations live on the system message's `toolsAdded`. A test
that declares tools the obvious way silently sends `tools: []` and fails with
`FreeTierError` even though the code looks correct.

## Models used

Only models that actually served a request during verification are named here.

- `fledge-alpha-free` on `opencode.ai/zen/v1`, via the anonymous key.
- `space-bunny-free` on the same endpoint and key.
- `gizmothon/opencode/space-bunny-free` through the local proxy, as the working
  comparison.

## Not verified

These were not run, and nothing in this repository claims they were:

- `dsh plugin add` from GitHub. The package is not published to npm, so the
  documented install is the GitHub route. The repository is public and clones
  cleanly, and `dsh` resolves the package from it, but the full
  `dsh plugin add` flow has not been run end to end.
- `--dump-config-schema` and the Settings screen. The plugin ships no Schemastery
  `Config`, so there are no volatile fields to project and nothing was checked
  about the generated settings form.
- `node --test`. The suites are plain node scripts, not a `node --test` suite, so
  that specific gate was not met.
- Websocket transports, which do not reach the fetch wrapper.
- Host matching against anything other than `opencode.ai` and the negative case.
- Any pi-ai other than 0.87.1. A second version exists in the workspace; the
  plugin was not exercised against it.
- Behaviour under an authenticated (`sk-…`) opencode key. The fingerprint is
  aimed at the anonymous free tier only.

## Known deviations from the porting rules

Recorded rather than smoothed over:

- **R5, API surface.** The plugin wraps `globalThis.fetch`. That is a global
  monkey-patch rather than a public Cordis service. It is the only layer that can
  reach the wire, because the `llm-pi-ai` adapter drops per-request headers and
  keeps the session-affinity compat gate closed. The wrapper is installed once,
  scoped to matching hosts, and restored on dispose.
- **§4, configuration schema.** There is no exported Schemastery `Config`.
  Configuration is normalised in `normalize()` instead, so the plugin gets no
  Settings form and the volatile-reference hazard of §6 does not apply, but the
  schema requirement itself is unmet.
- **§7 gate 1.** The suite is not `node --test`.