#!/usr/bin/env node
/**
 * engines.dsh compatibility contract for dsh-opencode-freeaccess.
 *
 * Calls the REAL `evaluatePluginCompatibility` shipped inside the dsh
 * checkout (no reimplementation, no stub) and asserts the declared
 * `engines.dsh` range admits every verified runtime and rejects the rest —
 * with no exemption. Adding a newly verified runtime means widening the
 * range here AND recording the run in VERIFICATION.md, never an exemption.
 *
 * Run:  node test/engines-compat.mjs
 * Needs: DSH_CHECKOUT (default /root/projects/dsh/deepseek-harness) with
 * built app-boot lib output and an installed `semver` beside it.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

const CHECKOUT = process.env.DSH_CHECKOUT ?? "/root/projects/dsh/deepseek-harness";
const COMPAT = join(CHECKOUT, "packages/boot/app-boot/lib/types/plugin-compatibility.js");
if (!existsSync(COMPAT)) {
	throw new Error(`engines-compat.mjs: built compatibility module not found at ${COMPAT}; build app-boot or set DSH_CHECKOUT`);
}
const { evaluatePluginCompatibility } = await import(pathToFileURL(COMPAT).href);

const range = manifest.engines?.dsh;
assert.equal(typeof range, "string", "package.json must declare engines.dsh as a range string");
assert.ok(!/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(range.trim()), `engines.dsh must be a range, not an exact pin (saw ${range})`);

let passed = 0;
const ok = (label) => {
	passed += 1;
	console.log(`  ✓ ${label}`);
};

// Allowed: every runtime with a recorded verification run, no exemption.
for (const runtime of ["0.2.0-rc.2", "0.2.1-alpha.4"]) {
	const issue = evaluatePluginCompatibility(manifest, {}, runtime);
	assert.equal(issue, undefined, `${range} must admit verified runtime ${runtime}, got: ${JSON.stringify(issue)}`);
	ok(`verified runtime ${runtime} admitted (no exemption)`);
}

// Rejected: older prereleases and the next minor — never silently admitted.
for (const runtime of ["0.1.0", "0.2.0-rc.1", "0.3.0"]) {
	const issue = evaluatePluginCompatibility(manifest, {}, runtime);
	assert.ok(issue !== undefined, `${range} must reject ${runtime}`);
	assert.equal(issue.exempted, false, "rejection must not depend on an exemption");
	assert.deepEqual(issue.requirements, { "engines.dsh": range });
	ok(`unverified runtime ${runtime} rejected (${JSON.stringify(issue.requirements)})`);
}

console.log(`\nengines-compat.mjs: ${passed} checks passed for dsh-opencode-freeaccess (engines.dsh ${range})`);
