import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";

//#region lib/types/brand.js
/**
 * Brand a session identifier for the wire. Values are opaque strings; no
 * validation is performed here.
 * @param id - the raw session id string.
 * @returns the same string, branded as a SessionId.
 */
function SessionId(id) {
	return id;
}
//#endregion

//#region lib/types/index.js
/**
 * dsh-opencode-freeaccess — make the LLM HTTP requests dsh sends to opencode
 * providers carry the dsh conversation session id, the same way opencode
 * itself does.
 *
 * How opencode carries it (for comparison): opencode threads its current
 * session id through the provider call options (`sessionId`); its OpenAI
 * compatible client then emits `x-session-affinity: <sessionId>` and
 * `x-client-request-id: <sessionId>` on every wire request (plus
 * `session_id:` for the "openai" affinity format, or `x-session-id:` for the
 * OpenRouter format). The emission is gated by the model's
 * `compat.sendSessionAffinityHeaders` flag.
 *
 * The dsh side already provides the id — `dsh-agent-loop` fills
 * `options.sessionId` and the `llm-pi-ai` adapter forwards it to pi-ai — but
 * two design walls keep it off the wire: the adapter deliberately withholds
 * `sendSessionAffinityHeaders` / `sessionAffinityFormat` from its provider
 * compat gate, and it drops per-request `options.headers` (it only sends the
 * static `headers` of the provider profile plus attribution headers). This
 * plugin closes the gap at the layer that cannot be bypassed:
 *
 *  1. It listens on the `llm/stream` waterfall (the harness's official LLM
 *     request interception seam) and scopes each call to its session id via
 *     AsyncLocalStorage, so the id is correct per request even when several
 *     conversations stream concurrently. Stream chunks and call options pass
 *     through unchanged; only the in-process async context is scoped.
 *  2. It wraps `globalThis.fetch` (the undici fetch both the `openai` and
 *     `@anthropic-ai/sdk` clients resolve to on Node ≥ 18) and adds the
 *     session-id headers to every request whose URL targets an opencode
 *     endpoint (host suffix or exact base URL, configurable).
 *
 * **Scope guarantee — only request headers change.** The fetch wrapper never
 * reads, rewrites, or replaces the request body (bytes and streams pass
 * through untouched), never changes the URL, method, signal, credentials,
 * duplex, or any other fetch option, and never touches responses. Calls that
 * do not match an opencode endpoint are handed to the original fetch with the
 * exact same arguments. The waterfall listener does not modify call options
 * by default; only with `seedSessionId: true` does it fill a missing
 * `options.sessionId` for the configured opencode routes, whose only wire
 * effect is (session) request headers.
 *
 * @module dsh-opencode-freeaccess
 */
const name = "opencode-freeaccess";
const inject = [];
/**
 * Default session headers opencode itself emits on requests:
 *
 * - `x-opencode-session` — the session id header on the opencode gateway
 *   branch (providers whose id starts with `opencode`); this is the one the
 *   ZEN gateway keys sessions on.
 * - `x-session-affinity` / `x-client-request-id` / `x-session-id` — the
 *   affinity family opencode sends on every other (OpenAI-compatible)
 *   provider branch; harmless duplicates on the gateway branch.
 */
const DEFAULT_HEADERS = ["x-opencode-session", "x-session-affinity", "x-client-request-id", "x-session-id"];
/**
 * opencode session-id format (`ses_` + 26 chars), ported from opencode's
 * `packages/schema/src/identifier.ts` (`create(descending, timestamp)`) and
 * `packages/core/src/id/id.ts` (sessions use descending ids with the `ses_`
 * prefix, e.g. `ses_0ad7e1b930015SnHnrn3JV9SyS`).
 *
 * - The first 12 chars are hex from the bitwise-NOT of the session's creation
 *   timestamp (`~now`, descending order = newest sorts first). This half is
 *   fixed at session start and never changes, no matter how many messages the
 *   session accumulates.
 * - The last 14 chars are normally random base62; here they are derived from
 *   SHA-256 of the dsh session uuid so the SAME dsh session always maps to
 *   the SAME `ses_` token — including across process restarts (both inputs,
 *   the uuid and the persisted `createdAt`, survive resume). Same byte-wise
 *   mapping as opencode (`byte % 62` over `ID_CHARS`), exact total length 30.
 */
const SES_PREFIX = "ses_";
/** opencode's identifier alphabet: `0-9A-Za-z` in this exact order. */
const SES_ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Wire-format grammar: `ses_` + 12 lowercase hex + 14 base62. */
const SES_TOKEN_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
/**
 * The 12-hex-char time half of an opencode session id: `~(ms * 0x1000)`
 * rendered as 6 big-endian bytes. Deliberately a pure function of the
 * timestamp (opencode additionally mixes a per-process counter for
 * uniqueness, but here uniqueness comes from the uuid-derived suffix, and
 * purity is what keeps the token identical across process restarts).
 */
function sesTimePart(timestamp) {
	const current = BigInt(timestamp) * 0x1000n;
	const value = ~current; // descending = true, like opencode sessions
	return Array.from({ length: 6 }, (_, index) => Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0")).join("");
}
/**
 * The 14-char uniqueness half: first 14 bytes of SHA-256 over the input,
 * mapped through `SES_ID_CHARS` exactly like opencode maps random bytes.
 */
function sesSuffix(input) {
	const digest = createHash("sha256").update(String(input)).digest();
	return Array.from(digest.subarray(0, 14), (byte) => SES_ID_CHARS[byte % 62]).join("");
}
/**
 * Build the wire `ses_` token for a raw dsh session id.
 * The `session-` label is stripped first so only the uuid participates;
 * `timestamp` should be the session's `createdAt` (fixed at session start).
 * @param raw - the raw dsh session id (`session-<uuid>`).
 * @param timestamp - session creation time in ms (default now).
 * @returns a 30-char `ses_...` token matching `SES_TOKEN_RE`.
 */
function createSesToken(raw, timestamp = Date.now()) {
	return `${SES_PREFIX}${sesTimePart(timestamp)}${sesSuffix(stripSessionPrefix(raw))}`;
}
/** HTTP header-name grammar (RFC 9110 token). */
const HEADER_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/**
 * Strip the dsh `session-` prefix so the wire token hashes only the uuid
 * part (`e820d21d-…-a309f722a3bc`), independent of the label. Ids without
 * the prefix (env fallback / random uuid) pass through unchanged.
 */
function stripSessionPrefix(id) {
	return String(id).replace(/^session-/, "");
}
/**
 * Default fingerprint headers: opencode's own client family, sent on every
 * opencode request alongside the session headers. Matches what opencode
 * 1.18.x sends itself (`X-OpenCode-Client: cli`). Explicit config replaces
 * (not merges with) these defaults; set `extraHeaders: {}` to disable.
 */
const DEFAULT_EXTRA_HEADERS = { "X-OpenCode-Client": "cli" };
/** Default `User-Agent` override: opencode identifies as `opencode/<version>`. */
const DEFAULT_USER_AGENT = "opencode/1.18.31";
/** Pair validation for `extraHeaders` / the `userAgent` override. */
function pairsOf(value, fallback = {}) {
	if (value === undefined) return { ...fallback };
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const out = {};
	for (const [h, v] of Object.entries(value)) {
		if (typeof v !== "string") continue;
		const name = h.trim();
		if (!HEADER_NAME_TOKEN.test(name) || v.length === 0) continue;
		out[name] = v;
	}
	return out;
}
/** Tolerate every shape a patch layer may deliver; defaults apply per key. */
function normalize(config) {
	const c = config ?? {};
	const stringList = (value, fallback) => Array.isArray(value) && value.length > 0 ? value.filter((v) => typeof v === "string" && v.length > 0) : fallback;
	let headers = stringList(c.headers, DEFAULT_HEADERS);
	if (headers.length === 0) headers = DEFAULT_HEADERS;
	return {
		providers: stringList(c.providers, ["opencode", "opencode-go"]),
		hosts: stringList(c.hosts, ["opencode.ai"]),
		baseURLs: stringList(c.baseURLs, []),
		headers: [...new Set(headers)].filter((h) => HEADER_NAME_TOKEN.test(h)),
		/** Static fingerprint headers (opencode's own client family). Explicit config replaces the defaults; `{}` disables. */
		extraHeaders: pairsOf(c.extraHeaders, DEFAULT_EXTRA_HEADERS),
		/** `User-Agent` override (default `opencode/<version>`); set `""` to leave the platform UA untouched. Headers only. */
		userAgent: typeof c.userAgent === "string" ? c.userAgent.trim() : DEFAULT_USER_AGENT,
		sessionIdEnv: typeof c.sessionIdEnv === "string" ? c.sessionIdEnv.trim() : "",
		verbose: c.verbose === true,
		disableFetchInjection: c.disableFetchInjection === true,
		/** Opt-in only: fill a missing `options.sessionId` for the configured opencode routes (wire effect: headers only). Default off — requests stay untouched except headers. */
		seedSessionId: c.seedSessionId === true
	};
}
/**
 * Per-request session scoping over AsyncLocalStorage. Every step of the
 * downstream LLM stream runs inside `run()`, so a fetch issued deep inside
 * the adapter — pi-ai fires its HTTP client synchronously from the stream's
 * first pull — observes the exact conversation session id even when several
 * conversations stream concurrently.
 */
function createSessionScope() {
	const store = new AsyncLocalStorage();
	return {
		/** The session id active for the current async context, if any. */
		current() {
			return store.getStore();
		},
		run(sessionId, fn) {
			return store.run(String(sessionId), fn);
		}
	};
}
/**
 * Wrap a downstream LLM chunk stream so each pull runs inside the scope,
 * keeping the session id visible to everything the adapter does on that pull.
 * @param scope - the session scope.
 * @param sessionId - the id to bind.
 * @param iterable - the downstream chunk stream (`next()` result).
 * @returns an AsyncIterable with the same chunk semantics.
 */
function scopedIterable(scope, sessionId, iterable) {
	const iterator = iterable[Symbol.asyncIterator]();
	const inside = (method, args) => scope.run(sessionId, () => {
		const fn = iterator[method];
		return typeof fn === "function" ? fn.apply(iterator, args) : undefined;
	});
	const fallbackDone = Promise.resolve({ done: true, value: undefined });
	return {
		[Symbol.asyncIterator]() {
			return this;
		},
		next() {
			return inside("next", []) ?? fallbackDone;
		},
		return(...args) {
			return inside("return", args) ?? fallbackDone;
		},
		throw(...args) {
			return inside("throw", args) ?? fallbackDone;
		}
	};
}
/** Lowercase hostname of a URL, or "" when unreadable. */
function hostnameOf(url) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}
/** Does this request URL target a configured opencode endpoint? */
function matchesTarget(url, hosts, baseURLs) {
	if (baseURLs.some((base) => url.startsWith(base))) return true;
	const host = hostnameOf(url);
	if (!host) return false;
	return hosts.some((entry) => {
		const suffix = entry.trim().toLowerCase().replace(/^\./, "");
		if (!suffix || suffix.includes("/")) return false;
		return host === suffix || host.endsWith(`.${suffix}`);
	});
}
/**
 * Rebuild a fetch call with the session headers added, preserving every
 * other aspect (method, body, signal, duplex, credentials). Returns `null`
 * when the request cannot be rebuilt (e.g. a body-already-used Request),
 * in which case the caller passes the call through untouched.
 */
function withSessionHeaders(input, init, headerNames, sessionId, extra = {}, userAgent = "") {
	const source = init?.headers ?? (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined);
	const headers = new Headers(source ?? undefined);
	for (const headerName of headerNames) headers.set(headerName, String(sessionId));
	for (const [headerName, value] of Object.entries(extra)) headers.set(headerName, value);
	if (userAgent.length > 0) headers.set("user-agent", userAgent);
	if (typeof init === "object" && init !== null) return { input, init: { ...init, headers } };
	if (typeof Request !== "undefined" && input instanceof Request) {
		try {
			return { input: new Request(input, { headers }), init: undefined };
		} catch {
			return null;
		}
	}
	return { input, init: { headers } };
}
/**
 * Wrap `globalThis.fetch` so requests to opencode endpoints carry the
 * session-id headers. One wrapper per mount; disposal restores the previous
 * fetch unless another wrapper already took its place.
 * @returns the disposer.
 */
function installSessionHeaderFetch({ hosts, baseURLs, headerNames, extra, userAgent, getSessionId, log }) {
	const original = globalThis.fetch;
	if (typeof original !== "function") return () => {};
	const wrapped = (input, init) => {
		let nextInput = input;
		let nextInit = init;
		try {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : typeof input === "object" && input !== null && typeof input.url === "string" ? input.url : "";
			if (url.length > 0 && matchesTarget(url, hosts, baseURLs)) {
				const sessionId = getSessionId();
				if (sessionId !== undefined && sessionId !== null && String(sessionId).length > 0 && headerNames.length > 0) {
					const merged = withSessionHeaders(input, init, headerNames, sessionId, extra, userAgent);
					if (merged !== null) {
						nextInput = merged.input;
						nextInit = merged.init;
						const set = [
							...headerNames.map((h) => `${h}: ${sessionId}`),
							...Object.entries(extra).map(([h, v]) => `${h}: ${v}`),
							...userAgent.length > 0 ? [`user-agent: ${userAgent}`] : []
						];
						log?.(`${url} ← ${set.join(", ")}`);
					}
				}
			}
		} catch (error) {
			log?.(`skipped header injection: ${error?.message ?? error}`);
		}
		return original.call(globalThis, nextInput, nextInit);
	};
	globalThis.fetch = wrapped;
	return () => {
		if (globalThis.fetch === wrapped) globalThis.fetch = original;
	};
}
/** Install the plugin on a cordis context. */
function apply(ctx, config = {}) {
	const cfg = normalize(config);
	const scope = createSessionScope();
	const providers = new Set(cfg.providers);
	let processId;
	/** One `ses_` token per raw dsh session id, minted once and reused for the full session. */
	const sesTokens = new Map();
	/**
	 * The session's creation time from the live store (`SessionHeader.createdAt`:
	 * immutable and persisted, so resume restores the same value). Falls back
	 * to `undefined` for ids with no live session (env/random fallbacks) —
	 * those mint against `Date.now()` once and pin via `sesTokens`.
	 */
	const createdAtFor = (sid) => {
		try {
			const store = typeof ctx.get === "function" ? ctx.get("sessions") : undefined;
			const createdAt = store?.get(sid)?.header.createdAt;
			return typeof createdAt === "number" && Number.isSafeInteger(createdAt) && createdAt >= 0 ? createdAt : undefined;
		} catch {
			return undefined;
		}
	};
	/**
	 * The value actually put on the wire for a raw session id: the `ses_`
	 * token for that session, constant for the whole session (1 dsh session
	 * ⇔ 1 `ses_` id). The time half uses the session's `createdAt`, so the
	 * token is a pure function of persisted data and is identical after a
	 * restart. Child sessions look up their OWN id (no parent inheritance).
	 */
	const wireSessionId = (raw) => {
		const key = String(raw);
		const hit = sesTokens.get(key);
		if (hit !== undefined) return hit;
		const token = createSesToken(key, createdAtFor(key) ?? Date.now());
		sesTokens.set(key, token);
		return token;
	};
	const envFallback = () => {
		if (cfg.sessionIdEnv.length > 0 && typeof process.env[cfg.sessionIdEnv] === "string") {
			const hit = process.env[cfg.sessionIdEnv];
			if (hit.length > 0) return hit;
		}
		if (typeof process.env.DSH_SESSION_ID === "string" && process.env.DSH_SESSION_ID.length > 0) return process.env.DSH_SESSION_ID;
		return processId ??= randomUUID();
	};
	const log = (message) => {
		if (!cfg.verbose) return;
		ctx.logger.debug(`opencode-freeaccess: ${message}`);
		// The web app routes cordis logs to an invisible sink; print to stderr
		// as well so systemd/journal shows each injection live. Never stdout:
		// the acp / headless / sdk profiles carry JSON-RPC or the final answer
		// there, and a bare line breaks those channels.
		console.error(`[opencode-freeaccess] ${message}`);
	};
	// 1. Scope every LLM stream to its conversation session id, so the fetch
	//    wrapper below reads the right id. Chunks and call options pass
	//    through untouched — the ONLY thing that changes is request headers.
	//    `seedSessionId: true` additionally fills a missing
	//    `options.sessionId` for the configured opencode routes (its only
	//    wire effect is session request headers); default off.
	ctx.on("llm/stream", (options, next) => {
		let sessionId = options.sessionId;
		if ((typeof sessionId !== "string" || sessionId.length === 0) && cfg.seedSessionId) {
			if (typeof options.provider === "string" && providers.has(options.provider)) {
				sessionId = envFallback();
				if (!Object.isFrozen(options)) {
					try {
						options.sessionId = sessionId;
					} catch {
						/* frozen request object; the fetch injection still applies */
					}
				}
			}
		}
		if (sessionId === undefined || sessionId === null) return next();
		const sid = String(sessionId);
		log(`scoping llm/stream ${options.provider}/${options.model} to session ${sid} → wire ${wireSessionId(sid)}`);
		return scopedIterable(scope, sid, next());
	});
	// 2. Wire-level injection: the llm-pi-ai adapter only forwards static
	//    profile headers and keeps the session-affinity compat gate closed, so
	//    the headers land here, on the actual HTTP request.
	if (!cfg.disableFetchInjection) {
		const restoreFetch = installSessionHeaderFetch({
			hosts: cfg.hosts,
			baseURLs: cfg.baseURLs,
			headerNames: cfg.headers,
			extra: cfg.extraHeaders,
			userAgent: cfg.userAgent,
			getSessionId: () => wireSessionId(scope.current() ?? envFallback()),
			log
		});
		ctx.effect(() => restoreFetch, "opencode-freeaccess: restore global fetch");
	}
	ctx.logger.info(
		`opencode-freeaccess: tagging providers [${cfg.providers.join(", ")}]; injecting [${cfg.headers.join(", ")}] on hosts [${cfg.hosts.join(", ")}]${cfg.baseURLs.length > 0 ? ` and baseURLs [${cfg.baseURLs.join(", ")}]` : ""}${Object.keys(cfg.extraHeaders).length > 0 ? `; extra [${Object.entries(cfg.extraHeaders).map(([h, v]) => `${h}: ${v}`).join(", ")}]` : ""}${cfg.userAgent ? `; user-agent: ${cfg.userAgent}` : ""}`
	);
	// Same reason as `log` above: stderr keeps stdout free for the profile's
	// own protocol (a client reading acp stdout rejects a non-JSON line, and
	// `--profile headless` prints its answer there).
	console.error(
		`[opencode-freeaccess] mounted: providers=[${cfg.providers.join(", ")}] headers=[${cfg.headers.join(", ")}] hosts=[${cfg.hosts.join(", ")}]${cfg.baseURLs.length > 0 ? ` baseURLs=[${cfg.baseURLs.join(", ")}]` : ""}${Object.keys(cfg.extraHeaders).length > 0 ? ` extra=[${Object.entries(cfg.extraHeaders).map(([h, v]) => `${h}: ${v}`).join(", ")}]` : ""}${cfg.userAgent ? ` userAgent=${cfg.userAgent}` : ""}${cfg.seedSessionId ? " seedSessionId=on" : ""} sessionId=ses_~createdAt+sha256(uuid)`
	);
}
//#endregion

export { DEFAULT_EXTRA_HEADERS, DEFAULT_HEADERS, DEFAULT_USER_AGENT, SES_ID_CHARS, SES_TOKEN_RE, SessionId, apply, createSesToken, createSessionScope, inject, installSessionHeaderFetch, matchesTarget, name, normalize, scopedIterable, stripSessionPrefix, withSessionHeaders };
export default { name, inject, apply };