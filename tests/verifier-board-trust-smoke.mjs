#!/usr/bin/env node
/**
 * WU-1 trust hardening: a verifier board only satisfies the definition-of-done gate when
 * at least one trusted, independent (non-model) source — `verify`, `review`, or
 * `validator:<id>` — is present and passing. An untrusted-only board (e.g. a single
 * self-recorded `reviewer` PASS) must never satisfy completion. Fully offline.
 *
 * Also asserts parity between verifier-board.summarize / isBoardComplete and the two
 * self-contained completion gates (orchestrator.missionCompleteBlocked,
 * conductor.verifierBoardBlocked).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
	loadModule,
	tmpWorkspace,
	rmWorkspace,
	isolateKitEnv,
} from "../packages/core/eval/harness.mjs";

const restoreEnv = isolateKitEnv();
const board = await loadModule("extensions/verifier-board/index.ts");
const orch = await loadModule("extensions/orchestrator/index.ts");
const cond = await loadModule("extensions/conductor/index.ts");

const now = () => new Date().toISOString();
const staleAt = () => new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

function writeBoard(ws, verdicts) {
	fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
	fs.writeFileSync(
		path.join(ws, ".pi", "verdicts.json"),
		JSON.stringify({ verdicts }),
	);
}

const cases = [
	{
		name: "(a) untrusted-only board does not pass",
		verdicts: { reviewer: { pass: true, summary: "looks good", at: now() } },
		complete: false,
	},
	{
		name: "(b) trusted + untrusted passing board passes",
		verdicts: {
			reviewer: { pass: true, summary: "looks good", at: now() },
			verify: { pass: true, summary: "tests pass", at: now() },
		},
		complete: true,
	},
	{
		name: "validator:<id> counts as a trusted source",
		verdicts: {
			"validator:conductor-1": { pass: true, summary: "validated", at: now() },
		},
		complete: true,
	},
	{
		name: "review counts as a trusted source",
		verdicts: { review: { pass: true, summary: "reviewed", at: now() } },
		complete: true,
	},
	{
		name: "(c) stale trusted board does not pass",
		verdicts: {
			verify: { pass: true, summary: "old pass", at: staleAt() },
		},
		complete: false,
	},
	{
		name: "failing trusted source does not pass",
		verdicts: { verify: { pass: false, summary: "boom", at: now() } },
		complete: false,
	},
	{
		name: "a failing untrusted source still fails beside a trusted pass",
		verdicts: {
			verify: { pass: true, summary: "ok", at: now() },
			tests: { pass: false, summary: "red", at: now() },
		},
		complete: false,
	},
];

const ws = tmpWorkspace("pi-kit-eval-trust-");
let failed = 0;
try {
	for (const c of cases) {
		try {
			const summarized = board.summarize({ verdicts: c.verdicts });
			assert.equal(
				summarized.overall,
				c.complete,
				`summarize.overall: ${c.name}`,
			);
			assert.equal(
				board.isBoardComplete({ verdicts: c.verdicts }),
				c.complete,
				`isBoardComplete: ${c.name}`,
			);

			writeBoard(ws, c.verdicts);
			const mission = orch.missionCompleteBlocked(ws);
			const conductor = cond.verifierBoardBlocked(ws);

			// (d) both parity gates agree with verifier-board's own verdict.
			assert.equal(
				mission.blocked,
				!c.complete,
				`orchestrator parity: ${c.name}`,
			);
			assert.equal(
				conductor.blocked,
				!c.complete,
				`conductor parity: ${c.name}`,
			);
			assert.equal(
				summarized.overall,
				!mission.blocked,
				`orchestrator agrees with verifier-board summarize: ${c.name}`,
			);
			assert.equal(
				summarized.overall,
				!conductor.blocked,
				`conductor agrees with verifier-board summarize: ${c.name}`,
			);

			console.log(`  OK: ${c.name}`);
		} catch (error) {
			failed++;
			console.error(`  FAIL: ${c.name}`);
			console.error(`    ${error.stack || error.message}`);
		}
	}

	// WU-1 regression: a corrupt board element (null / non-object / partial) must not
	// make the reader throw. A stored `{"verdicts":{"tests":null}}` previously raised
	// "TypeError: Cannot read properties of null (reading 'pass')" from summarize and
	// the status path. Mirror the sibling gates: corruption is simply not a pass.
	const corruptCases = [
		{ name: "null element", verdicts: { tests: null } },
		{ name: "non-object element", verdicts: { tests: "not-an-object" } },
		{
			name: "partial element",
			verdicts: { tests: { summary: "no pass/at" }, lint: 42 },
		},
	];
	for (const c of corruptCases) {
		try {
			const summarized = board.summarize({ verdicts: c.verdicts });
			assert.equal(summarized.overall, false, `summarize.overall: corrupt ${c.name}`);
			assert.equal(
				board.isBoardComplete({ verdicts: c.verdicts }),
				false,
				`isBoardComplete: corrupt ${c.name}`,
			);

			// status path (load + summarize) must survive the same corruption.
			writeBoard(ws, c.verdicts);
			const st = board.statusText(ws);
			assert.equal(typeof st.text, "string", `statusText returns text: corrupt ${c.name}`);
			assert.equal(st.overall, false, `statusText.overall: corrupt ${c.name}`);

			console.log(`  OK: corrupt ${c.name} does not throw`);
		} catch (error) {
			failed++;
			console.error(`  FAIL: corrupt ${c.name}`);
			console.error(`    ${error.stack || error.message}`);
		}
	}

	// WU-1 trust gate: a malformed element must remain visible and fatal. A mixed board
	// (one trusted passing verdict + one malformed element) must still be incomplete and
	// summarize must render the malformed source as FAIL. Deleting corrupt elements in
	// load() would silently drop this and let the mixed board pass.
	try {
		const mixed = {
			verify: { pass: true, summary: "tests pass", at: now() },
			tests: null,
		};
		const summarized = board.summarize({ verdicts: mixed });
		assert.equal(summarized.overall, false, "summarize.overall: mixed board");
		assert.equal(
			board.isBoardComplete({ verdicts: mixed }),
			false,
			"isBoardComplete: mixed board",
		);
		assert.ok(
			summarized.lines.some((l) => l === "- tests: FAIL — (malformed verdict)"),
			`mixed board shows malformed source as FAIL: ${JSON.stringify(summarized.lines)}`,
		);

		// status path (load + summarize) must keep the malformed element fatal too.
		writeBoard(ws, mixed);
		const st = board.statusText(ws);
		assert.equal(st.overall, false, "statusText.overall: mixed board");

		console.log("  OK: mixed trusted-PASS + malformed board stays incomplete");
	} catch (error) {
		failed++;
		console.error("  FAIL: mixed trusted-PASS + malformed board");
		console.error(`    ${error.stack || error.message}`);
	}

	if (failed > 0) {
		console.error(`\n[verifier-board-trust-smoke] ${failed}/${cases.length} FAILED`);
		process.exit(1);
	}
	console.log(`\n[verifier-board-trust-smoke] all ${cases.length} checks passed`);
} finally {
	rmWorkspace(ws);
	restoreEnv();
}
