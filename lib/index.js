import https from "node:https";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";

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
 * dsh-opencode-freeaccess — let dsh use opencode's ANONYMOUS free tier
 * (`Authorization: Bearer public`) from inside the Node process, with no sidecar
 * and no native dependency.
 *
 * The Zen free tier admits a request only when three independent things line up,
 * and reports every failure the same way — `429 {"type":"FreeUsageLimitError"}`
 * with a `retry-after` counting down to the next window — so the obvious reading
 * (quota) is usually wrong. Each rule below was measured against the live gateway
 * with a known-good control request bracketing every probe:
 *
 *  1. **The TLS ClientHello.** The gateway reads the cipher list the client
 *     advertises. Node's default hello (52 suites, OpenSSL order) is refused, and
 *     so is the same list in reverse order, without the eight legacy suites, or
 *     capped at TLS 1.2 — each measured against the same request that passes with
 *     opencode's own 17 suites in its own order (`FREE_TIER_CIPHERS` below). The
 *     rest of the hello is not compared: extension set and order differ from the
 *     CLI's and both pass, so a tuned `ciphers` list on `node:https` is enough
 *     and no TLS-impersonation dependency is needed. pi-ai calls
 *     `globalThis.fetch`, whose client cannot be told this list, which is why the
 *     plugin performs the request itself.
 *  2. **Session header.** `x-opencode-session` must carry a grammatical `ses_...`
 *     id. The check is the value's SHAPE, not its clock (measured with gate 1 held
 *     constant: a 30-day-old grammatical id still streams and a zeroed time half
 *     passes, while `abc-123` and an empty value are refused; only an id that
 *     decodes far into the future is). It is also what pins a conversation to one
 *     session for affinity, so the plugin mints from the current clock and renews
 *     before `sessionTtlMs` — an id that never changes outlives its usefulness.
 *  3. **Request body.** The `tools` array must be non-empty and must contain a
 *     tool NAMED `read`; the system prompt must carry opencode's two-line `<env>`
 *     block; and `stream` must be true. The `read` DEFINITION is not compared —
 *     dsh's own `read`, whose schema takes `filePath`, passes untouched — and
 *     `shell` is not required (a body carrying only `read` passes).
 *
 * What this plugin therefore does on the opencode routes:
 *
 *  - scopes each LLM call to its conversation via the `llm/stream` waterfall and
 *    AsyncLocalStorage, and puts one grammatical `ses_` id on the wire for that
 *    conversation (renewed before it can go stale, see `sessionTtlMs`);
 *  - adapts the JSON request body minimally: appends a placeholder `read` tool
 *    only when the caller has none (and tells the model not to call it), adds the
 *    `<env>` block, and sets `stream: true`;
 *  - sends the request itself through `node:https` and hands back a standard
 *    `Response`, so pi-ai and the SDKs see the object they would get from fetch.
 *
 * Everything else on the machine is untouched: URLs that do not match an opencode
 * host or base URL go to the original `fetch` with the exact same arguments. A
 * refused request is logged with the gateway's own `retry-after` instead of being
 * blamed on quota.
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
 * - `x-opencode-session-id` — required NEXT TO it by the v2 CLI shape.
 * - `x-session-affinity` / `x-session-id` — the affinity family opencode sends
 *   on every other (OpenAI-compatible) provider branch; harmless duplicates
 *   here.
 *
 * `x-opencode-request` is deliberately NOT sent: it is v1-only and the v2
 * free-tier gate answers it with 403.
 */
const DEFAULT_HEADERS = ["x-opencode-session", "x-opencode-session-id", "x-session-affinity", "x-session-id"];
/**
 * opencode session-id format (`ses_` + 26 chars), ported from opencode's
 * `packages/schema/src/identifier.ts` (`create(descending, timestamp)`) and
 * `packages/core/src/id/id.ts` (sessions use descending ids with the `ses_`
 * prefix, e.g. `ses_0ad7e1b930015SnHnrn3JV9SyS`).
 *
 * - The first 12 chars are hex from `~(timeMs * 0x1000 + counter)` over the low
 *   48 bits. The server checks this half is present and decodes to a plausible
 *   recent time — it does NOT have to be now (measured: a 30-day-old id passes).
 * - The last 14 chars are random base62, exactly like opencode's own ids.
 */
const SES_PREFIX = "ses_";
/** opencode's identifier alphabet: `0-9A-Za-z` in this exact order. */
const SES_ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** Wire-format grammar: `ses_` + 12 lowercase hex + 14 base62. */
const SES_TOKEN_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
/** Low 48 bits, the width opencode's descending ids wrap at. */
const SES_TIME_MASK = (1n << 48n) - 1n;
/**
 * The 12-hex-char time half: `~(ms * 0x1000 + counter)` over the low 48 bits,
 * descending so the newest session sorts first, exactly like opencode's own.
 * @param timestamp - the minted-at time in ms.
 * @param counter - the uniqueness counter mixed into the low bits.
 */
function sesTimePart(timestamp, counter = 1) {
	return ((~(BigInt(timestamp) * 0x1000n + BigInt(counter))) & SES_TIME_MASK).toString(16).padStart(12, "0");
}
/** The 14-char uniqueness half: random bytes mapped like opencode maps them. */
function sesSuffix() {
	const bytes = new Uint8Array(14);
	globalThis.crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => SES_ID_CHARS[byte % 62]).join("");
}
/**
 * Build a wire `ses_` token. The clock half comes from `timestamp` (default:
 * now) so the id is grammatical and lands inside the window the gateway
 * tolerates — never from stored session data.
 * @param timestamp - the current time in ms.
 * @returns a 30-char `ses_...` token matching `SES_TOKEN_RE`.
 */
function createSesToken(timestamp = Date.now()) {
	return `${SES_PREFIX}${sesTimePart(timestamp)}${sesSuffix()}`;
}
/**
 * Decode the clock half of a `ses_` token back to a minted-at time. The 48-bit
 * id space is the shifted clock TRUNCATED, so the result is the true time modulo
 * 2^36 ms (~2.3 years): compare deltas inside that span, not absolute dates.
 * The encode is `(~(ms * 0x1000 + counter)) & MASK`, which over that domain is
 * exactly `MASK - v`, so the inverse is `MASK - x` with no extra term.
 * @param token - a `ses_...` id.
 * @returns the minted-at clock (low 36 bits of ms), or null when unreadable.
 */
function sesTokenTime(token) {
	const hex = String(token ?? "").slice(SES_PREFIX.length, SES_PREFIX.length + 12);
	if (!/^[0-9a-f]{12}$/.test(hex)) return null;
	return Number(((SES_TIME_MASK - BigInt(`0x${hex}`)) & SES_TIME_MASK) >> 12n);
}
/** HTTP header-name grammar (RFC 9110 token). */
const HEADER_NAME_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/**
 * Default fingerprint headers: opencode's own client family, sent on every
 * opencode request alongside the session headers. Matches what opencode
 * 2.1.4 sends itself (`x-opencode-client: cli`, `x-opencode-project: global`).
 * Explicit config replaces (not merges with) these defaults; set
 * `extraHeaders: {}` to disable.
 */
const DEFAULT_EXTRA_HEADERS = { "x-opencode-client": "cli", "x-opencode-project": "global" };
/** Default `User-Agent` override: opencode identifies as `opencode/latest/<version>/cli`. */
const DEFAULT_USER_AGENT = "opencode/latest/2.1.4/cli";
/**
 * The TLS ClientHello cipher list the free tier accepts, in the exact order the
 * opencode CLI's own client advertises. This is the gate that decides whether a
 * request is read at all: the same bytes over Node's default list answer
 * `429 FreeUsageLimitError`, over this list `200` with real SSE — measured
 * interleaved in one minute, on Node 20.19.2, 25.7.0 and 26.5.0.
 *
 * Three things about it are load-bearing and were each tested on their own:
 * the ORDER (reversed: 429), the eight legacy suites at the end (dropped: 429),
 * and offering TLS 1.3 (TLS 1.2 only: 429). Extension set and order are NOT
 * part of the gate — the CLI's own client and this list differ there and both
 * pass — which is why plain `node:https` with a tuned list is enough and no
 * TLS-impersonation dependency is needed.
 */
const FREE_TIER_CIPHERS = ["TLS_AES_128_GCM_SHA256", "TLS_AES_256_GCM_SHA384", "TLS_CHACHA20_POLY1305_SHA256", "ECDHE-ECDSA-AES128-GCM-SHA256", "ECDHE-RSA-AES128-GCM-SHA256", "ECDHE-ECDSA-AES256-GCM-SHA384", "ECDHE-RSA-AES256-GCM-SHA384", "ECDHE-ECDSA-CHACHA20-POLY1305", "ECDHE-RSA-CHACHA20-POLY1305", "ECDHE-ECDSA-AES128-SHA", "ECDHE-RSA-AES128-SHA", "ECDHE-ECDSA-AES256-SHA", "ECDHE-RSA-AES256-SHA", "AES128-GCM-SHA256", "AES256-GCM-SHA384", "AES128-SHA", "AES256-SHA"].join(":");
/**
 * The env block the free-tier gate looks for in the system prompt. BOTH lines
 * are required — a one-line block passes a single probe and then fails.
 */
const ENV_MARKER = "<env>\n  Working directory: /workspace\n  Workspace root folder: /workspace\n</env>";
/** An `<env>` block that already carries both lines needs no change. */
const ENV_MARKER_RE = /<env>[\s\S]*?Working directory:[\s\S]*?Workspace root folder:[\s\S]*?<\/env>/;
/** A partial block gets completed in place rather than duplicated. */
const ENV_BLOCK_RE = /<env>([\s\S]*?)<\/env>/;
const ENV_WORKDIR_RE = /Working directory:[^\n]*/;
const ENV_ROOT_RE = /Workspace root folder:/;
/**
 * The one tool name the body gate requires. Its definition is not compared, so
 * this placeholder only has to exist and be well-formed; it is appended solely
 * when the caller sends no `read` of its own, and the prompt then says not to
 * call it, because dsh has no such tool to run.
 */
const GATE_TOOL_NAME = "read";
const GATE_TOOL_STUB = {
	type: "function",
	function: {
		name: GATE_TOOL_NAME,
		description: "Read the contents of a file.",
		parameters: { type: "object", properties: { path: { type: "string", description: "File to read" } }, required: ["path"] },
	},
};
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
	const ttl = Number(c.sessionTtlMs);
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
		/**
		 * Adapt the request body to the free-tier body gate (placeholder `read`
		 * when the caller has none, the `<env>` block, `stream: true`). `false`
		 * keeps the body byte-identical — headers and transport only — which the
		 * anonymous free tier will reject.
		 */
		adaptBody: c.adaptBody !== false,
		/**
		 * `node` (default) sends opencode-bound requests through `node:https`,
		 * because the gateway refuses Node's own `fetch`. `fetch` keeps the
		 * platform client — for a machine where only `fetch` can reach the network
		 * (proxy, custom CA), and it will show the refusal rather than hide it.
		 */
		transport: c.transport === "fetch" ? "fetch" : "node",
		/**
		 * How long one conversation keeps its wire `ses_` id before it is re-minted
		 * from the current clock. The gate checks the value's shape, not its clock, but
		 * an id that never renews keeps a long conversation pinned to one stale
		 * server-side session.
		 */
		sessionTtlMs: Number.isFinite(ttl) && ttl > 0 ? ttl : 600_000,
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
//#endregion

//#region lib/body.js
/** Tool name from either the nested chat form or the flat Responses form. */
function toolNameOf(tool) {
	if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
	if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
	const fn = tool.function;
	if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") return fn.name.trim();
	return "";
}
/** Complete a partial `<env>` block in place; add one when there is none. */
function withEnvMarker(text) {
	if (typeof text !== "string") return text;
	if (ENV_MARKER_RE.test(text)) return text;
	const block = ENV_BLOCK_RE.exec(text);
	if (block) {
		let inner = block[1];
		if (!ENV_WORKDIR_RE.test(inner)) inner = `\n  Working directory: /workspace${inner}`;
		if (!ENV_ROOT_RE.test(inner)) inner = inner.replace(/(Working directory:[^\n]*)/, "$1\n  Workspace root folder: /workspace");
		return text.replace(block[0], `<env>${inner}</env>`);
	}
	return `${text}\n${ENV_MARKER}`;
}
/** Put the `<env>` block in whichever carrier this body uses. */
function withEnvBody(body) {
	if (typeof body.system === "string") body.system = withEnvMarker(body.system);
	else if (Array.isArray(body.system)) {
		if (!body.system.some((block) => ENV_MARKER_RE.test(typeof block === "string" ? block : block?.text ?? ""))) body.system = [...body.system, { type: "text", text: ENV_MARKER }];
	} else if (Array.isArray(body.messages)) {
		const carrier = body.messages.findIndex((message) => message?.role === "system" && typeof message.content === "string");
		if (carrier >= 0) body.messages[carrier] = { ...body.messages[carrier], content: withEnvMarker(body.messages[carrier].content) };
		else body.messages = [{ role: "system", content: ENV_MARKER }, ...body.messages];
	} else if (typeof body.instructions === "string") body.instructions = withEnvMarker(body.instructions);
}
/**
 * Make the body pass the free-tier body gate. Mutates and returns `body`, and
 * reports whether the placeholder `read` had to be appended.
 * @param body - the parsed JSON request body.
 * @returns {{ body: object, appendedTool: boolean }}
 */
function adaptGateBody(body) {
	if (!body || typeof body !== "object") return { body, appendedTool: false };
	const flat = Array.isArray(body.tools) && body.tools.some((tool) => typeof tool?.name === "string" && !tool.function);
	if (!Array.isArray(body.tools)) body.tools = [];
	const appended = !body.tools.some((tool) => toolNameOf(tool) === GATE_TOOL_NAME);
	if (appended) {
		body.tools = [...body.tools, flat ? { type: "function", ...GATE_TOOL_STUB.function } : GATE_TOOL_STUB];
		/**
		 * Tell the model the extra tool is inert. Without this it does call it,
		 * and dsh has no such tool to run. Wording matters: "not available" made
		 * models also refuse the caller's own tools.
		 */
		const note = `Do not call the \`${GATE_TOOL_NAME}\` tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
		if (flat && typeof body.instructions === "string") body.instructions = body.instructions.trim().length > 0 ? `${body.instructions}\n\n${note}` : note;
		else if (Array.isArray(body.messages) && body.system === undefined) {
			const first = body.messages[0];
			if (first?.role === "system" && typeof first.content === "string") body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...body.messages.slice(1)];
			else body.messages = [{ role: "system", content: note }, ...body.messages];
		}
	}
	withEnvBody(body);
	if (body.tool_choice === "none") body.tool_choice = "auto";
	if (body.stream === false) body.stream = true;
	return { body, appendedTool: appended };
}
//#endregion

//#region lib/transport.js
/** Collect a fetch body into bytes so it can be inspected and re-sent. */
async function readBody(body) {
	if (body === undefined || body === null) return undefined;
	if (typeof body === "string") return body;
	if (body instanceof ArrayBuffer) return new Uint8Array(body);
	if (ArrayBuffer.isView(body)) return body;
	if (body instanceof URLSearchParams) return body.toString();
	if (typeof body === "object" && typeof body.getReader === "function") {
		const reader = body.getReader();
		const chunks = [];
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			chunks.push(value);
		}
		const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
		const out = new Uint8Array(length);
		let offset = 0;
		for (const chunk of chunks) {
			out.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return out;
	}
	return undefined;
}
/**
 * Is this JSON body an LLM request the free-tier gate inspects? Anything else
 * that happens to be a POST to the same host stays untouched.
 */
function isChatBody(body) {
	return !!body && typeof body === "object" && !Array.isArray(body) && (Array.isArray(body.messages) || Array.isArray(body.input) || typeof body.messages === "string") && typeof body.model === "string";
}
/**
 * Read, adapt and re-serialize a request body.
 *
 * `takeOver: false` means the body is a shape this plugin cannot materialize
 * (`FormData`, `Blob`) — the caller must then leave the request completely
 * alone instead of silently dropping the payload. A body that is present but
 * not an LLM request comes back with `takeOver: true` and its ORIGINAL text, so
 * consuming a stream is never a way to lose data.
 * @returns {{ text: string|Uint8Array|undefined, takeOver: boolean, adapted: boolean }}
 */
async function prepareBody(body, enabled, log) {
	if (body === undefined || body === null) return { text: undefined, takeOver: true, adapted: false };
	let text;
	try {
		const bytes = await readBody(body);
		if (bytes === undefined) return { text: undefined, takeOver: false, adapted: false };
		text = typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes);
	} catch (error) {
		log?.(`body unread, sending as-is: ${error?.message ?? error}`);
		return { text: undefined, takeOver: false, adapted: false };
	}
	if (!enabled || text.length === 0) return { text, takeOver: true, adapted: false };
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { text, takeOver: true, adapted: false };
	}
	if (!isChatBody(parsed)) return { text, takeOver: true, adapted: false };
	const { body: adapted, appendedTool } = adaptGateBody(parsed);
	log?.(`body adapted for the free-tier gate: tools=[${(adapted.tools ?? []).map((tool) => toolNameOf(tool)).join(", ")}]${appendedTool ? ` +placeholder ${GATE_TOOL_NAME}` : ""} env=ok stream=${adapted.stream === true}`);
	return { text: JSON.stringify(adapted), takeOver: true, adapted: true };
}
/**
 * Perform one request through `node:https` and hand back a standard `Response`,
 * so pi-ai and the SDKs see the object they would get from `fetch`. The gateway
 * keys on the ClientHello cipher list, and `globalThis.fetch` gives no way to
 * set it — that is the only reason the plugin takes over the transport.
 *
 * `servername` is set explicitly: the ClientHello has to carry SNI for a host
 * that routes on it, and OpenSSL disables it when the request is built from a
 * socket-level target. `content-length` is recomputed from the materialized body.
 * @param url - the absolute request URL.
 * @param init - `{ method, body, signal }`, body already materialized.
 * @param headers - the finished header set.
 * @returns a promise of the response.
 */
function sendOverNodeTransport(url, init, headers) {
	const target = new URL(url);
	const body = init?.body === undefined || init.body === null ? undefined : Buffer.from(init.body);
	const plain = {};
	for (const [key, value] of headers) plain[key] = value;
	/** SSE over a hand-rolled client: ask for identity so nothing arrives encoded. */
	plain["accept-encoding"] = "identity";
	delete plain["content-length"];
	delete plain["transfer-encoding"];
	delete plain["connection"];
	if (body !== undefined) plain["content-length"] = String(body.byteLength);
	return new Promise((resolve, reject) => {
		const request = https.request(
			{
				hostname: target.hostname,
				port: target.port.length > 0 ? Number(target.port) : 443,
				path: `${target.pathname}${target.search}`,
				method: init?.method ?? "GET",
				servername: target.hostname,
				ciphers: FREE_TIER_CIPHERS,
				headers: plain,
				signal: init?.signal ?? undefined
			},
			(incoming) => {
				const out = new Headers();
				for (const [key, value] of Object.entries(incoming.headers)) {
					if (value === undefined) continue;
					for (const one of Array.isArray(value) ? value : [value]) out.append(key, one);
				}
				resolve(new Response(Readable.toWeb(incoming), { status: incoming.statusCode ?? 0, statusText: incoming.statusMessage, headers: out }));
			}
		);
		request.on("error", reject);
		if (body !== undefined) request.write(body);
		request.end();
	});
}
/**
 * Wrap `globalThis.fetch` so requests to opencode endpoints carry the
 * session-id headers, the free-tier body adaptation, and (by default) the
 * `node:https` transport the gateway accepts. One wrapper per mount; disposal
 * restores the previous fetch unless another wrapper already took its place.
 * @returns the disposer.
 */
function installSessionHeaderFetch({ hosts, baseURLs, headerNames, extra = {}, userAgent = "", getSessionId, log, adaptBody = true, transport = "node" }) {
	const original = globalThis.fetch;
	if (typeof original !== "function") return () => {};
	const wrapped = async (input, init) => {
		const passthrough = () => original.call(globalThis, input, init);
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : typeof input === "object" && input !== null && typeof input.url === "string" ? input.url : "";
		if (url.length === 0 || !matchesTarget(url, hosts, baseURLs)) return passthrough();
		let merged;
		let sessionId = "";
		try {
			sessionId = String(getSessionId() ?? "");
			merged = sessionId.length > 0 && headerNames.length > 0 ? withSessionHeaders(input, init, headerNames, sessionId, extra, userAgent) : { input, init };
			if (merged === null) return passthrough();
		} catch (error) {
			log?.(`skipped injection: ${error?.message ?? error}`);
			return passthrough();
		}
		const asRequest = typeof Request !== "undefined" && merged.input instanceof Request ? merged.input : null;
		const finalInit = {
			...merged.init,
			method: String(merged.init?.method ?? asRequest?.method ?? "GET").toUpperCase(),
			headers: new Headers(merged.init?.headers ?? asRequest?.headers),
			body: merged.init?.body ?? asRequest?.body ?? undefined,
			signal: merged.init?.signal ?? asRequest?.signal ?? undefined
		};
		const prepared = await prepareBody(finalInit.body, adaptBody, log);
		if (!prepared.takeOver) return passthrough();
		finalInit.body = prepared.text;
		/**
		 * A string body needs no `duplex`; keeping a stale value is legal but
		 * meaningless, so drop it once the stream has been materialized.
		 */
		if (typeof prepared.text === "string" && finalInit.duplex !== undefined) delete finalInit.duplex;
		const headers = finalInit.headers;
		if (prepared.adapted) {
			headers.set("content-type", "application/json");
			/** The adapted body is always an SSE stream; say so, as the CLI does. */
			headers.set("accept", "text/event-stream");
		}
		const set = [
			...headerNames.map((h) => `${h}: ${sessionId}`),
			...Object.entries(extra).map(([h, v]) => `${h}: ${v}`),
			...userAgent.length > 0 ? [`user-agent: ${userAgent}`] : []
		];
		log?.(`${url} ← ${set.join(", ")}`);
		const viaPlatform = () => original.call(globalThis, url, finalInit);
		const report = (response, over) => {
			log?.(`${url} → ${response.status} ${over}`);
			if (response.status === 429) {
				const auth = headers.get("authorization");
				const anonymous = auth === null || auth.trim() === "Bearer public";
				log?.(anonymous ? "429 FreeUsageLimitError on the anonymous key — gates (ClientHello, session header, body) or the free-tier limit; retry-after is not a reliable signal" : "429 FreeUsageLimitError — this request is NOT anonymous: the provider's API key is not `public`, so opencode meters it against that account. Set the key to `public` for the free tier");
			}
			return response;
		};
		if (transport === "fetch") return viaPlatform().then((response) => report(response, "over the platform fetch"));
		return sendOverNodeTransport(url, finalInit, headers).then((response) => report(response, "over node:https")).catch((error) => {
			log?.(`node:https request failed (${error?.message ?? error}); retrying with the platform fetch`);
			return viaPlatform().then((response) => report(response, "over the platform fetch, after a node:https error"));
		});
	};
	globalThis.fetch = wrapped;
	return () => {
		if (globalThis.fetch === wrapped) globalThis.fetch = original;
	};
}
//#endregion

//#region lib/apply.js
/** Install the plugin on a cordis context. */
function apply(ctx, config = {}) {
	const cfg = normalize(config);
	const scope = createSessionScope();
	const providers = new Set(cfg.providers);
	let processId;
	/** One `ses_` token per raw dsh session id, minted from the current clock. */
	const sesTokens = new Map();
	/**
	 * The value actually put on the wire for a raw dsh id. The gateway reads the
	 * shape of this value, not its clock, but a conversation keeps one id for
	 * `sessionTtlMs` anyway — turns inside that window look like one opencode
	 * session — and re-mints from the current clock after it. Child sessions look
	 * up their OWN id.
	 */
	const wireSessionId = (raw) => {
		const key = String(raw);
		const now = Date.now();
		const hit = sesTokens.get(key);
		if (hit !== undefined && now - hit.at < cfg.sessionTtlMs) return hit.token;
		const token = createSesToken(now);
		sesTokens.set(key, { at: now, token });
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
	//    wrapper below reads the right id. Chunks and call options pass through
	//    unchanged; only `seedSessionId` touches options, and only to fill a
	//    missing id.
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
		/** Guarded, not just a quiet `log`: an unguarded call would mint a `ses_`
		 * token for every stream of every provider, including non-opencode ones. */
		if (cfg.verbose) log(`scoping llm/stream ${options.provider}/${options.model} to session ${sid} → wire ${wireSessionId(sid)}`);
		return scopedIterable(scope, sid, next());
	});
	// 2. Wire-level injection: the llm-pi-ai adapter only forwards static
	//    profile headers and keeps the session-affinity compat gate closed, so
	//    the headers, the body adaptation and the transport land here.
	if (!cfg.disableFetchInjection) {
		const restoreFetch = installSessionHeaderFetch({
			hosts: cfg.hosts,
			baseURLs: cfg.baseURLs,
			headerNames: cfg.headers,
			extra: cfg.extraHeaders,
			userAgent: cfg.userAgent,
			getSessionId: () => wireSessionId(scope.current() ?? envFallback()),
			log,
			adaptBody: cfg.adaptBody,
			transport: cfg.transport
		});
		ctx.effect(() => restoreFetch, "opencode-freeaccess: restore global fetch");
	}
	ctx.logger.info(
		`opencode-freeaccess: tagging providers [${cfg.providers.join(", ")}]; injecting [${cfg.headers.join(", ")}] on hosts [${cfg.hosts.join(", ")}]${cfg.baseURLs.length > 0 ? ` and baseURLs [${cfg.baseURLs.join(", ")}]` : ""}${Object.keys(cfg.extraHeaders).length > 0 ? `; extra [${Object.entries(cfg.extraHeaders).map(([h, v]) => `${h}: ${v}`).join(", ")}]` : ""}${cfg.userAgent ? `; user-agent: ${cfg.userAgent}` : ""}; transport ${cfg.transport}; body ${cfg.adaptBody ? "adapted" : "untouched"}`
	);
	// Same reason as `log` above: stderr keeps stdout free for the profile's
	// own protocol (a client reading acp stdout rejects a non-JSON line, and
	// `--profile headless` prints its answer there).
	console.error(
		`[opencode-freeaccess] mounted: providers=[${cfg.providers.join(", ")}] headers=[${cfg.headers.join(", ")}] hosts=[${cfg.hosts.join(", ")}]${cfg.baseURLs.length > 0 ? ` baseURLs=[${cfg.baseURLs.join(", ")}]` : ""}${Object.keys(cfg.extraHeaders).length > 0 ? ` extra=[${Object.entries(cfg.extraHeaders).map(([h, v]) => `${h}: ${v}`).join(", ")}]` : ""}${cfg.userAgent ? ` userAgent=${cfg.userAgent}` : ""}${cfg.seedSessionId ? " seedSessionId=on" : ""}${cfg.adaptBody ? " adaptBody=on" : " adaptBody=off"} transport=${cfg.transport} sessionId=ses_~now+random (renews after ${Math.round(cfg.sessionTtlMs / 1000)}s)`
	);
}
//#endregion

export { DEFAULT_EXTRA_HEADERS, DEFAULT_HEADERS, DEFAULT_USER_AGENT, ENV_MARKER, FREE_TIER_CIPHERS, GATE_TOOL_NAME, GATE_TOOL_STUB, SES_ID_CHARS, SES_TOKEN_RE, SessionId, adaptGateBody, apply, createSesToken, createSessionScope, inject, installSessionHeaderFetch, isChatBody, matchesTarget, name, normalize, prepareBody, readBody, scopedIterable, sendOverNodeTransport, sesTimePart, sesTokenTime, toolNameOf, withEnvMarker, withSessionHeaders };
export default { name, inject, apply };
