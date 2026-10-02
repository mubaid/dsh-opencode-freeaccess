#!/usr/bin/env node
/**
 * Offline verification for dsh-opencode-freeaccess.
 *
 * Drives the REAL pi-ai library — the very one dsh's `llm-pi-ai` adapter uses
 * (it is opencode's own AI library, @earendil-works/pi-ai, bundled inside the
 * dsh CLI install) — through this plugin's fetch wrapper and asserts that the
 * actual HTTP request to the opencode gateway carries the session-id headers.
 *
 * Run:  node test/verify.mjs
 * Needs: an installed dsh CLI (default path /home/gauss/.npm-global/...,
 * override with DSH_NODE_MODULES=<dir containing @earendil-works>) and the
 * repo-local symlink node_modules/@deepseek-ai/schemastery -> the dsh CLI's
 * copy (checked in dev only; the profile install resolves it itself).
 */
import { pathToFileURL } from "node:url";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

import { DEFAULT_EXTRA_HEADERS, DEFAULT_HEADERS, DEFAULT_USER_AGENT, SES_ID_CHARS, SES_TOKEN_RE, createSesToken, createSessionScope, installSessionHeaderFetch, matchesTarget, normalize, stripSessionPrefix, withSessionHeaders } from "../lib/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// Locate a dir containing `@earendil-works/pi-ai`: explicit env first, then
// the dsh checkout's pnpm store (any version, globbed so a version bump does
// not break the suite), then the installed dsh profiles, then legacy layouts.
function resolveNodeModules() {
	/** Expand each `@earendil-works+pi-ai@<version>` entry in a pnpm store. */
	function expandPnpmStoreEntries(root) {
		if (!existsSync(root)) return [];
		try {
			return readdirSync(root)
				.filter((name) => name.startsWith("@earendil-works+pi-ai@"))
				.map((name) => join(root, name, "node_modules"));
		} catch {
			return [];
		}
	}
	const candidates = [
		process.env.DSH_NODE_MODULES,
		...expandPnpmStoreEntries("/root/projects/dsh/deepseek-harness/node_modules/.pnpm"),
		"/root/.dsh/profiles/node_modules",
		"/home/gauss/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules",
	].filter((v) => typeof v === "string" && v.length > 0);
	for (const dir of candidates) {
		if (existsSync(join(dir, "@earendil-works/pi-ai/dist/api/openai-completions.js"))) return dir;
	}
	throw new Error(
		`verify.mjs: pi-ai not found; set DSH_NODE_MODULES to a dir containing @earendil-works/pi-ai (tried: ${candidates.join(", ")})`,
	);
}
const DSH_NODE_MODULES = resolveNodeModules();
const PI_AI_BASE = join(DSH_NODE_MODULES, "@earendil-works/pi-ai/dist");

const { streamSimple } = await import(pathToFileURL(join(PI_AI_BASE, "api/openai-completions.js")).href);
const catalog = JSON.parse(
	readFileSync(join(PI_AI_BASE, "providers/data/opencode-go.json"), "utf8"),
);
const MODEL = { ...catalog["openai-completions"]["deepseek-v4-flash"] };
const CONTEXT = {
	systemPrompt: "verify",
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
	tools: [],
};

/** Stub fetch: records every call and answers an empty SSE stream. */
function recordingFetch(records) {
	const stub = async (url, init) => {
		records.push({ url: String(url), init: init ?? {} });
		return new Response("", { status: 200, headers: { "content-type": "text/event-stream" } });
	};
	return stub;
}

async function opencodeChat(scope, sessionId, signal) {
	const stream = await new Promise((resolve, reject) => {
		const guard = setTimeout(() => reject(new Error("streamSimple did not return")), 3000);
		try {
			resolve(scope.run(sessionId, () => streamSimple(MODEL, CONTEXT, {
				sessionId,
				signal,
				cacheRetention: "short",
				apiKey: "test-key",
				headers: {},
			})));
		} finally {
			clearTimeout(guard);
		}
	});
	// Consume until done/error so pi-ai's IIFE settles cleanly.
	const done = stream.result ? stream.result() : undefined;
	if (done !== undefined) await Promise.race([done, new Promise((r) => setTimeout(r, 2000))]);
	return stream;
}

let passed = 0;
const ok = (label) => {
	passed += 1;
	console.log(`  ✓ ${label}`);
};

// ── unit: matchesTarget ─────────────────────────────────────────────────────
{
	const hosts = ["opencode.ai"];
	const baseURLs = ["https://gateway.opencode.example/v1"];
	assert.equal(matchesTarget("https://opencode.ai/zen/go/v1/chat/completions", hosts, baseURLs), true, "bare host");
	assert.equal(matchesTarget("https://sub.opencode.ai/zen/go/v1", hosts, baseURLs), true, "subdomain");
	assert.equal(matchesTarget("https://opencode.ai:8443/zen/go/v1", hosts, baseURLs), true, "port stripped");
	assert.equal(matchesTarget("http://opencode.ai/x", hosts, baseURLs), true, "http scheme");
	assert.equal(matchesTarget("https://opencode.ai.evil.com/x", hosts, baseURLs), false, "suffix confusion");
	assert.equal(matchesTarget("https://api.openai.com/v1/chat/completions", hosts, baseURLs), false, "foreign host");
	assert.equal(matchesTarget("https://gateway.opencode.example/v1/chat/completions", hosts, baseURLs), true, "exact baseURL prefix");
	assert.equal(matchesTarget("not-a-url", hosts, baseURLs), false, "unparseable");
	ok("matchesTarget host/baseURL filtering");
}

// ── unit: withSessionHeaders merges extras and user-agent, headers only ────
{
	const names = ["x-opencode-session"];
	const merged = withSessionHeaders("https://opencode.ai/v1/chat/completions", {
		method: "POST",
		headers: { authorization: "Bearer abc" },
		body: "{}",
	}, names, "session-unit", { "x-opencode-client": "native" }, "opencode/test");
	assert.equal(merged.init.headers.get("x-opencode-session"), "session-unit");
	assert.equal(merged.init.headers.get("x-opencode-client"), "native");
	assert.equal(merged.init.headers.get("user-agent"), "opencode/test");
	assert.equal(merged.init.headers.get("authorization"), "Bearer abc");
	assert.equal(merged.init.method, "POST");
	assert.equal(merged.init.body, "{}");
	assert.equal(merged.input, "https://opencode.ai/v1/chat/completions");
	const req = new Request("https://opencode.ai/v1/chat/completions", { method: "POST", body: "{}", headers: { authorization: "Bearer abc" } });
	const rebuilt = withSessionHeaders(req, undefined, names, "session-req");
	assert.ok(rebuilt.input instanceof Request);
	assert.equal(rebuilt.input.headers.get("x-opencode-session"), "session-req");
	assert.equal(rebuilt.input.headers.get("authorization"), "Bearer abc");
	assert.equal(rebuilt.init, undefined);
	ok("withSessionHeaders preserves method/body/auth; adds session + extras + UA");
}

// ── integration: the real pi-ai wire request carries the session id ────────
{
	const records = [];
	const scope = createSessionScope();
	globalThis.fetch = recordingFetch(records);
	const restore = installSessionHeaderFetch({
		hosts: ["opencode.ai"],
		baseURLs: [],
		headerNames: ["x-session-affinity", "x-client-request-id", "x-session-id"],
		getSessionId: () => scope.current(),
	});
	try {
		const controller = new AbortController();
		await opencodeChat(scope, "session-test-abc", controller.signal);
		controller.abort();
		const hit = records.find((r) => String(r.url).includes("opencode.ai"));
		assert.ok(hit, "expected a fetch to opencode.ai, saw: " + records.map((r) => r.url).join(", "));
		assert.ok(String(hit.url).includes("/zen/go/v1/chat/completions"), "chat completions URL: " + hit.url);
		const headers = new Headers(hit.init.headers);
		assert.equal(headers.get("x-session-affinity"), "session-test-abc");
		assert.equal(headers.get("x-client-request-id"), "session-test-abc");
		assert.equal(headers.get("x-session-id"), "session-test-abc");
		assert.ok(headers.get("authorization"), "auth header preserved");
		ok(`pi-ai wire request to ${hit.url} carries all session headers`);
	} finally {
		restore(); // restore globalThis.fetch
	}
}

// ── integration: concurrent sessions stay isolated per request ─────────────
{
	const records = [];
	const scope = createSessionScope();
	globalThis.fetch = recordingFetch(records);
	const restore = installSessionHeaderFetch({
		hosts: ["opencode.ai"],
		baseURLs: [],
		headerNames: ["x-session-affinity", "x-client-request-id"],
		getSessionId: () => scope.current(),
	});
	try {
		const a = new AbortController();
		const b = new AbortController();
		await Promise.all([
			opencodeChat(scope, "session-conv-a", a.signal),
			opencodeChat(scope, "session-conv-b", b.signal),
		]);
		a.abort();
		b.abort();
		const hits = records.filter((r) => String(r.url).includes("opencode.ai"));
		const seen = new Set(hits.map((r) => new Headers(r.init.headers).get("x-session-affinity")));
		assert.deepEqual([...seen].sort(), ["session-conv-a", "session-conv-b"], "each request saw exactly its own session id");
		ok("concurrent conversations get their own session id (AsyncLocalStorage isolation)");
	} finally {
		restore();
	}
}

// ── negative: foreign providers are untouched ───────────────────────────────
{
	const records = [];
	const scope = createSessionScope();
	globalThis.fetch = recordingFetch(records);
	const restore = installSessionHeaderFetch({
		hosts: ["opencode.ai"],
		baseURLs: [],
		headerNames: ["x-session-affinity"],
		getSessionId: () => scope.current() ?? "fallback-id",
	});
	try {
		await scope.run("session-neg", async () => {
			await globalThis.fetch("https://api.openai.com/v1/chat/completions", { method: "POST", headers: { authorization: "Bearer x" }, body: "{}" });
		});
		const hit = records.find((r) => String(r.url).includes("api.openai.com"));
		const headers = new Headers(hit.init.headers);
		assert.equal(headers.get("x-session-affinity"), null, "foreign host must not receive the header");
		assert.equal(headers.get("authorization"), "Bearer x");
		ok("non-opencode endpoints pass through untouched");
	} finally {
		restore();
	}
}

// ── headers-only guarantee: a matched request differs from the untouched
// ── control ONLY by the session headers (same url/method/body bytes) ───────
{
	// Control runner: pi-ai without our wrapper.
	const control = [];
	globalThis.fetch = recordingFetch(control);
	const controller = new AbortController();
	await opencodeChat(createSessionScope(), "session-ignored", controller.signal);
	controller.abort();
	// Wrapped runner: pi-ai through installSessionHeaderFetch with the shipped
	// default header set (which leads with opencode's own x-opencode-session).
	const records = [];
	const scope = createSessionScope();
	globalThis.fetch = recordingFetch(records);
	const restore = installSessionHeaderFetch({
		hosts: ["opencode.ai"],
		baseURLs: [],
		headerNames: DEFAULT_HEADERS,
		getSessionId: () => scope.current(),
	});
	try {
		const wrappedController = new AbortController();
		await opencodeChat(scope, "session-delta", wrappedController.signal);
		wrappedController.abort();
	} finally {
		restore();
	}
	const base = control.find((r) => String(r.url).includes("opencode.ai"));
	const changed = records.find((r) => String(r.url).includes("opencode.ai"));
	assert.ok(base && changed, "both control and wrapped requests observed");
	// URL, method, and body bytes are identical.
	assert.equal(changed.url, base.url, "URL unchanged");
	assert.equal(changed.init.method, base.init.method, "method unchanged");
	assert.equal(String(changed.init.body), String(base.init.body), "request body bytes unchanged");
	// Header delta is exactly the injected session headers.
	const baseHeaders = new Headers(base.init.headers);
	const changedHeaders = new Headers(changed.init.headers);
	const injected = new Set(DEFAULT_HEADERS);
	const baseNames = new Set([...baseHeaders.keys()]);
	const changedNames = new Set([...changedHeaders.keys()]);
	for (const name of baseNames) {
		assert.equal(changedHeaders.get(name), baseHeaders.get(name), `unrelated header ${name} unchanged`);
	}
	for (const name of changedNames) {
		assert.ok(baseNames.has(name) || injected.has(name), `only session headers added (saw ${name})`);
	}
	assert.equal(changedHeaders.get("x-opencode-session"), "session-delta");
	assert.equal(changedHeaders.get("x-session-affinity"), "session-delta");
	assert.ok(changed.init.signal instanceof AbortSignal, "signal untouched (still the SDK's controller)");
	assert.ok(injected.has("x-opencode-session"), "default set leads with x-opencode-session (opencode gateway convention)");
	ok("headers-only guarantee: same url/method/body; delta is exactly the session headers");
}

// ── unit: Request input survives with identical body, only headers replaced ─
{
	const body = JSON.stringify({ role: "user", content: "x" });
	const req = new Request("https://opencode.ai/v1/chat/completions", {
		method: "POST",
		body,
		headers: { authorization: "Bearer abc", "content-type": "application/json" },
	});
	const rebuilt = withSessionHeaders(req, undefined, ["x-session-affinity"], "session-req2");
	assert.ok(rebuilt.input instanceof Request);
	assert.equal(rebuilt.input.method, "POST");
	assert.equal(rebuilt.input.headers.get("x-session-affinity"), "session-req2");
	assert.equal(rebuilt.input.headers.get("authorization"), "Bearer abc");
	assert.equal(await rebuilt.input.text(), body, "body bytes identical through Request rebuild");
	ok("Request input: body/method preserved, headers only replaced");
}

// ── unit: createSesToken builds exact opencode ses_ ids ──────────────────
{
	assert.equal(SES_ID_CHARS, "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", "opencode identifier alphabet, exact order");
	const createdAt = 1758124800000;
	const token = createSesToken("session-e820d21d-3ea3-42b1-9f64-a309f722a3bc", createdAt);
	assert.equal(token.length, 30, "ses_ (4) + time (12) + suffix (14)");
	assert.ok(SES_TOKEN_RE.test(token), "matches ses_ grammar: " + token);
	assert.equal(token.slice(0, 4), "ses_", "ses_ prefix");
	assert.match(token.slice(4, 16), /^[0-9a-f]{12}$/, "12 lowercase hex from ~createdAt");
	assert.match(token.slice(16), /^[0-9A-Za-z]{14}$/, "14 base62 chars from sha-256(uuid)");
	assert.equal(createSesToken("session-e820d21d-3ea3-42b1-9f64-a309f722a3bc", createdAt), token, "pure function: same id + same createdAt → same token (restart-stable)");
	const other = createSesToken("session-11111111-1111-4111-8111-111111111111", createdAt);
	assert.ok(SES_TOKEN_RE.test(other), "second session also valid: " + other);
	assert.notEqual(other, token, "different dsh sessions → different ses_ ids");
	assert.equal(other.slice(4, 16), token.slice(4, 16), "same createdAt → same time half");
	assert.notEqual(other.slice(16), token.slice(16), "different uuid → different suffix half");
	// Time half is ~now descending: a later birth sorts (as hex) before an earlier one.
	const later = createSesToken("session-e820d21d-3ea3-42b1-9f64-a309f722a3bc", createdAt + 1000);
	assert.ok(later.slice(4, 16) < token.slice(4, 16), "descending time order preserved");
	ok("createSesToken: ses_ + 12 hex ~createdAt + 14 sha-256(uuid), deterministic, exact length 30");
}

// ── unit: stripSessionPrefix removes only the session- label ────────────────
{
	assert.equal(stripSessionPrefix("session-e820d21d-3ea3-42b1-9f64-a309f722a3bc"), "e820d21d-3ea3-42b1-9f64-a309f722a3bc", "session- prefix stripped");
	assert.equal(stripSessionPrefix("e820d21d-3ea3-42b1-9f64-a309f722a3bc"), "e820d21d-3ea3-42b1-9f64-a309f722a3bc", "no prefix → unchanged");
	assert.equal(stripSessionPrefix("session-"), "", "bare session- → empty");
	assert.equal(
		createSesToken("session-e820d21d-3ea3-42b1-9f64-a309f722a3bc", 1758124800000),
		createSesToken("e820d21d-3ea3-42b1-9f64-a309f722a3bc", 1758124800000),
		"wire token hashes the uuid only, session- not included",
	);
	assert.notEqual(
		createSesToken("session-e820d21d-3ea3-42b1-9f64-a309f722a3bc", 1758124800000).slice(16),
		createSesToken("session-different-uuid-part-0000-000000000000", 1758124800000).slice(16),
		"different uuid → different suffix",
	);
	ok("stripSessionPrefix: wire hash excludes the session- label");
}

// ── integration: ses_ token lands on the wire header ───────────────────────
{
	const records = [];
	const scope = createSessionScope();
	globalThis.fetch = recordingFetch(records);
	const restore = installSessionHeaderFetch({
		hosts: ["opencode.ai"],
		baseURLs: [],
		headerNames: ["x-opencode-session"],
		// Same shape as wireSessionId in apply(): one ses_ token per dsh id.
		getSessionId: () => createSesToken("session-test-xyz", 1758124800000),
	});
	try {
		await scope.run("session-test-xyz", async () => {
			await globalThis.fetch("https://opencode.ai/zen/go/v1/chat/completions", { method: "POST", body: "{}" });
		});
		const hit = records.find((r) => String(r.url).includes("opencode.ai"));
		const headers = new Headers(hit.init.headers);
		const seen = headers.get("x-opencode-session");
		assert.equal(seen, createSesToken("session-test-xyz", 1758124800000));
		assert.ok(SES_TOKEN_RE.test(seen), "wire value is a valid ses_ id: " + seen);
		ok("wire carries the ses_ token in x-opencode-session (uuid-derived, exact format)");
	} finally {
		restore();
	}
}

// ── config normalization ────────────────────────────────────────────────────
{
	const cfg = normalize({});
	assert.deepEqual(cfg.providers, ["opencode", "opencode-go"]);
	assert.equal(cfg.headers[0], "x-opencode-session", "default leads with opencode's own session header");
	assert.ok(cfg.headers.includes("x-session-affinity"));
	assert.deepEqual(cfg.extraHeaders, { "X-OpenCode-Client": "cli" }, "fingerprint extra header on by default");
	assert.equal(cfg.userAgent, "opencode/1.18.31", "opencode UA on by default");
	assert.deepEqual(normalize({ extraHeaders: {} }).extraHeaders, {}, "explicit {} disables fingerprint extras");
	assert.equal(normalize({ userAgent: "" }).userAgent, "", "explicit empty UA leaves the platform UA untouched");
	const tight = normalize({ providers: ["opencode-go"], hosts: ["opencode.ai", ".OC.ai"], headers: ["X-Session-Affinity", "bad header!"], baseURLs: ["https://gw/v1"], sessionIdEnv: "MY_SID", verbose: true, extraHeaders: { "x-opencode-client": "native", "bad name!": "x" }, userAgent: "opencode/1.18.21" });
	assert.deepEqual(tight.providers, ["opencode-go"]);
	assert.deepEqual(tight.hosts, ["opencode.ai", ".OC.ai"]);
	assert.deepEqual(tight.headers, ["X-Session-Affinity"], "invalid header names dropped, case kept");
	assert.deepEqual(tight.baseURLs, ["https://gw/v1"]);
	assert.equal(tight.sessionIdEnv, "MY_SID");
	assert.deepEqual(tight.extraHeaders, { "x-opencode-client": "native" }, "explicit config replaces (not merges) the fingerprint defaults; invalid names dropped");
	assert.equal(tight.userAgent, "opencode/1.18.21");
	ok("normalize applies defaults and sanitizes input");
}

console.log(`\nverify.mjs: ${passed} checks passed for dsh-opencode-freeaccess`);