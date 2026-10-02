#!/usr/bin/env node
/**
 * LIVE end-to-end verification for dsh-opencode-freeaccess against the
 * opencode Zen free tier — the `opencode2` provider shape
 * (baseURL https://opencode.ai/zen/v1, api openai-completions, anonymous
 * `public` key).
 *
 * Unlike verify.mjs (which stubs fetch), this drives the REAL pi-ai library —
 * the one dsh's `llm-pi-ai` adapter uses — through the REAL network through
 * this plugin's actual fetch wrapper, and asserts the gateway answers 200 with
 * real content.
 *
 * It reproduces the four upstream free-tier gates found by bisecting live:
 *   1. `Authorization: Bearer public`  — the LITERAL anonymous key.
 *   2. `User-Agent: opencode/<ver>`.
 *   3. canonical `ses_` session id headers.
 *   4. `tools` must include the file-search quartet {bash, glob, grep, read}
 *      AND `stream: true`.
 * This test also proves gate 4 is satisfied natively: dsh's own built-in tools
 * are named exactly bash/glob/grep/read, so no body injection is required.
 *
 * Run:  node test/verify-live-opencode2.mjs
 * Needs network access to opencode.ai. Costs nothing (free tier).
 */
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

import { DEFAULT_EXTRA_HEADERS, DEFAULT_HEADERS, DEFAULT_USER_AGENT, createSesToken, createSessionScope, installSessionHeaderFetch, normalize } from "../lib/index.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Locate pi-ai as shipped inside the installed dsh profile. */
function resolvePiAiBase() {
	const candidates = [
		process.env.DSH_PI_AI,
		"/root/.dsh/profiles/node_modules/@earendil-works/pi-ai/dist",
		"/home/gauss/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist",
	].filter((v) => typeof v === "string" && v.length > 0);
	for (const dir of candidates) {
		if (existsSync(join(dir, "api/openai-completions.js"))) return dir;
	}
	throw new Error(
		`verify-live-opencode2.mjs: pi-ai not found; set DSH_PI_AI to a dist dir containing api/openai-completions.js (tried: ${candidates.join(", ")})`,
	);
}
const PI_AI_BASE = resolvePiAiBase();
const { streamSimple } = await import(pathToFileURL(join(PI_AI_BASE, "api/openai-completions.js")).href);

/** The `opencode2` provider as configured in the dsh web patch layer. */
const BASE_URL = "https://opencode.ai/zen/v1";
/** The anonymous free-tier key. The gateway special-cases this exact string. */
const ANONYMOUS_KEY = "public";

/**
 * dsh's four built-in tools, named exactly as the gateway requires.
 *
 * pi-ai does NOT read `context.tools`: it resolves the request `tools` array
 * from the transcript, where declarations live on the system message's
 * `toolsAdded` (see pi-ai `utils/transcript.js` → `resolveTranscriptTools`).
 * That is how dsh's `llm-pi-ai` adapter ships them too, which is why the
 * quartet reaches the wire with no body injection by this plugin.
 */
const FINGERPRINT_TOOLS = ["bash", "glob", "grep", "read"];
const TOOLS = FINGERPRINT_TOOLS.map((name) => ({
	name,
	description: `dsh built-in ${name} tool`,
	parameters: { type: "object", properties: { input: { type: "string" } } },
}));
/** Transcript carrying the tool declarations the way dsh does. */
function transcript(tools) {
	const messages = [];
	if (tools.length > 0) {
		messages.push({
			role: "system",
			content: "You are a test harness. Reply with one short word.",
			toolsAdded: tools,
			timestamp: Date.now(),
		});
	}
	messages.push({ role: "user", content: "Reply with the word: PONG", timestamp: Date.now() });
	return messages;
}

const MODEL = {
	id: "fledge-alpha-free",
	name: "Fledge Alpha Free",
	api: "openai-completions",
	provider: "opencode",
	baseUrl: BASE_URL,
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	compat: { supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: true, maxTokensField: "max_tokens" },
	contextWindow: 1048576,
	maxTokens: 32000,
};

let passed = 0;
const ok = (label) => {
	passed += 1;
	console.log(`  ✓ ${label}`);
};

/** Run one real pi-ai stream and return the concatenated text + error. */
async function liveChat({ sessionId, tools, stream = true }) {
	const cfg = normalize({ verbose: false });
	const scope = createSessionScope();
	const restore = installSessionHeaderFetch({
		hosts: cfg.hosts,
		baseURLs: cfg.baseURLs,
		headerNames: cfg.headers,
		extra: cfg.extraHeaders,
		userAgent: cfg.userAgent,
		getSessionId: () => createSesToken(sessionId, 1758124800000),
	});
	try {
		return await scope.run(sessionId, async () => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 60000);
			try {
				const result = await streamSimple(
					MODEL,
					{ messages: transcript(tools) },
					{ sessionId, signal: controller.signal, cacheRetention: "short", apiKey: ANONYMOUS_KEY, stream, headers: {} },
				);
				// Drain the async iterable. pi-ai emits `text_delta` /
				// `thinking_delta` chunks plus a terminal `done`, and on an
				// upstream failure a single `{ type: "error", error }` chunk
				// whose `error.errorMessage` carries the gateway's message.
				let text = "";
				let failure;
				for await (const chunk of result) {
					if (chunk?.type === "text_delta" && typeof chunk.delta === "string") text += chunk.delta;
					if (chunk?.type === "error") failure = chunk.error?.errorMessage ?? "unknown upstream error";
				}
				return { text, failure };
			} finally {
				clearTimeout(timer);
			}
		});
	} finally {
		restore();
	}
}

// ── 1. the real request must succeed ───────────────────────────────────────
{
	const { text, failure } = await liveChat({
		sessionId: "session-live-verify-0001",
		tools: TOOLS,
	});
	assert.equal(failure, undefined, `upstream returned an error: ${JSON.stringify(failure)?.slice(0, 400)}`);
	assert.ok(text.trim().length > 0, "expected non-empty assistant text, got: " + JSON.stringify(text));
	ok(`live fledge-alpha-free request via plugin headers returned content: ${JSON.stringify(text.trim().slice(0, 60))}`);
}

// ── 2. the session headers must actually be on the wire ────────────────────
// Capture the outgoing request without stubbing the response path: wrap fetch
// once more to observe, then let the real network call proceed.
{
	const cfg = normalize({});
	const seen = [];
	const scope = createSessionScope();
	const inner = globalThis.fetch;
	const spy = (input, init) => {
		seen.push({ url: String(input), headers: new Headers(init?.headers ?? input?.headers) });
		return inner(input, init);
	};
	globalThis.fetch = spy;
	const restore = installSessionHeaderFetch({
		hosts: cfg.hosts,
		baseURLs: cfg.baseURLs,
		headerNames: cfg.headers,
		extra: cfg.extraHeaders,
		userAgent: cfg.userAgent,
		getSessionId: () => createSesToken("session-live-verify-0002", 1758124800000),
	});
	try {
		await scope.run("session-live-verify-0002", async () => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), 60000);
			try {
				for await (const _ of await streamSimple(
					MODEL,
					{ messages: transcript(TOOLS) },
					{ sessionId: "session-live-verify-0002", signal: controller.signal, apiKey: ANONYMOUS_KEY, headers: {} },
				)) { /* drain */ }
			} finally {
				clearTimeout(timer);
			}
		});
	} finally {
		restore();
		globalThis.fetch = inner;
	}
	const hit = seen.find((r) => r.url.startsWith(BASE_URL));
	assert.ok(hit, `expected a live request to ${BASE_URL}, saw: ${seen.map((r) => r.url).join(", ")}`);
	for (const name of DEFAULT_HEADERS) {
		assert.ok(hit.headers.get(name), `missing injected header ${name}`);
	}
	assert.ok(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/.test(hit.headers.get("x-opencode-session")), "ses_ id on the wire");
	assert.equal(hit.headers.get("user-agent"), DEFAULT_USER_AGENT, "opencode UA on the wire");
	assert.equal(hit.headers.get("x-opencode-client"), DEFAULT_EXTRA_HEADERS["X-OpenCode-Client"], "client fingerprint header on the wire");
	assert.ok(hit.headers.get("authorization")?.includes(ANONYMOUS_KEY), "anonymous public key forwarded untouched");
	assert.ok(hit.headers.get("content-type")?.includes("application/json"), "json body preserved");
	ok("wire request carries every session header, the opencode UA, client fingerprint and untouched auth");
}

// ── 3. document the gate that the key alone does not satisfy ───────────────
// Without the quartet the gateway 403s; this proves the tools gate is real and
// that dsh's own tool names are what satisfies it.
{
	const { failure, text } = await liveChat({
		sessionId: "session-live-verify-0003",
		tools: [], // no file-search quartet
	});
	const message = JSON.stringify(failure ?? "");
	assert.ok(
		(failure !== undefined && /FreeTierError|free tier/i.test(message)) || text.trim().length === 0,
		`expected a FreeTierError without the tool quartet, got: ${message.slice(0, 300)}`,
	);
	ok("without {bash,glob,grep,read} the free tier rejects — confirming dsh must keep those tools enabled");
}

console.log(`\nverify-live-opencode2.mjs: ${passed} checks passed against the live opencode Zen free tier`);