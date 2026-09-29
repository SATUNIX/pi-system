#!/usr/bin/env node
/**
 * AG-04 / M-04 regression coverage: verification must fail closed. Fully offline — no
 * live pi, no network (the verify subprocess this exercises is `node -e "process.exit(N)"`,
 * matching the existing eval fixture's own deterministic stand-in for a broken tsc).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
	loadModule,
	fakePi,
	tmpWorkspace,
	rmWorkspace,
	setEnv,
	ROOT,
} from "../packages/core/eval/harness.mjs";

// 1. A project with no "verify" script must NOT silently record a PASS verdict
// (previously `npm run verify --if-present` exited 0 with nothing checked).
async function testMissingScriptDoesNotRecordPass() {
	const vg = await loadModule("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-noscript-");
	fs.writeFileSync(
		path.join(ws, "package.json"),
		JSON.stringify({ name: "no-verify-script" }),
	);
	try {
		const pi = fakePi();
		vg.default(pi.api);
		await pi.handlers.get("session_start")({}, { cwd: ws });
		await pi.commands
			.get("verify")
			.handler("", { cwd: ws, ui: { setStatus() {}, notify() {} } });

		const board = JSON.parse(
			fs.readFileSync(path.join(ws, ".pi", "verdicts.json"), "utf8"),
		);
		assert.equal(
			board.verdicts.verify.pass,
			false,
			"an absent verify script must not be recorded as a pass",
		);
		assert.match(board.verdicts.verify.summary, /no.*verify.*script/i);
	} finally {
		rmWorkspace(ws);
	}
}

// Same repro against the review's own literal target package (infra/memory-mcp, which
// genuinely has no "verify" script in this repo).
async function testRealPackageWithoutVerifyScript() {
	const pkgPath = path.join(
		ROOT,
		"packages",
		"container",
		"mcp-servers",
		"memory-mcp",
		"package.json",
	);
	const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
	assert.ok(
		!pkg.scripts?.verify,
		"precondition: infra/memory-mcp must have no verify script for this repro to be meaningful",
	);

	const vg = await loadModule("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-realnoscript-");
	fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify(pkg));
	try {
		const pi = fakePi();
		vg.default(pi.api);
		await pi.handlers.get("session_start")({}, { cwd: ws });
		await pi.commands
			.get("verify")
			.handler("", { cwd: ws, ui: { setStatus() {}, notify() {} } });
		const board = JSON.parse(
			fs.readFileSync(path.join(ws, ".pi", "verdicts.json"), "utf8"),
		);
		assert.equal(
			board.verdicts.verify.pass,
			false,
			"infra/memory-mcp's own manifest must not report a false pass",
		);
	} finally {
		rmWorkspace(ws);
	}
}

// 2. missionCompleteBlocked must fail closed on missing / malformed / empty boards.
async function testMissionCompleteBlockedFailsClosed() {
	const orch = await loadModule("extensions/orchestrator/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-failclosed-");
	try {
		// Missing file entirely.
		assert.equal(
			orch.missionCompleteBlocked(ws).blocked,
			true,
			"a missing board must block completion",
		);

		// Malformed JSON.
		fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(ws, ".pi", "verdicts.json"), "{not valid json");
		assert.equal(
			orch.missionCompleteBlocked(ws).blocked,
			true,
			"malformed JSON must block completion",
		);

		// Valid JSON, wrong shape.
		fs.writeFileSync(
			path.join(ws, ".pi", "verdicts.json"),
			JSON.stringify({ notVerdicts: true }),
		);
		assert.equal(
			orch.missionCompleteBlocked(ws).blocked,
			true,
			"a schema-invalid board must block completion",
		);

		// Empty verdicts object.
		fs.writeFileSync(
			path.join(ws, ".pi", "verdicts.json"),
			JSON.stringify({ verdicts: {} }),
		);
		assert.equal(
			orch.missionCompleteBlocked(ws).blocked,
			true,
			"an empty board must block completion",
		);
		for (const verdicts of [
			{ verify: {} },
			{ verify: { pass: "true" } },
			[{ pass: true }],
		]) {
			fs.writeFileSync(
				path.join(ws, ".pi", "verdicts.json"),
				JSON.stringify({ verdicts }),
			);
			assert.equal(
				orch.missionCompleteBlocked(ws).blocked,
				true,
				"malformed verdicts cannot stand in for a boolean PASS",
			);
		}

		// Stale PASS: a real, parseable timestamp far in the past.
		const staleAt = new Date(
			Date.now() - 30 * 24 * 60 * 60 * 1000,
		).toISOString();
		fs.writeFileSync(
			path.join(ws, ".pi", "verdicts.json"),
			JSON.stringify({
				verdicts: { verify: { pass: true, summary: "ok", at: staleAt } },
			}),
		);
		assert.equal(
			orch.missionCompleteBlocked(ws).blocked,
			true,
			"a stale (30-day-old) PASS verdict must not satisfy completion",
		);

		// A fresh PASS must still satisfy completion.
		fs.writeFileSync(
			path.join(ws, ".pi", "verdicts.json"),
			JSON.stringify({
				verdicts: {
					verify: { pass: true, summary: "ok", at: new Date().toISOString() },
				},
			}),
		);
		assert.equal(
			orch.missionCompleteBlocked(ws).blocked,
			false,
			"a fresh PASS verdict must satisfy completion",
		);
	} finally {
		rmWorkspace(ws);
	}
}

// An unparseable `at` (e.g. hand-constructed board, matches the existing eval fixture's
// own `at: "t"` usage) must not itself trigger a staleness block - only the pass flag
// governs in that case.
async function testUnparseableTimestampDoesNotFalselyBlock() {
	const orch = await loadModule("extensions/orchestrator/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-badts-");
	try {
		fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(ws, ".pi", "verdicts.json"),
			JSON.stringify({
				verdicts: { verify: { pass: true, summary: "ok", at: "t" } },
			}),
		);
		assert.equal(
			orch.missionCompleteBlocked(ws).blocked,
			false,
			"an unparseable timestamp must not itself cause a staleness block",
		);
	} finally {
		rmWorkspace(ws);
	}
}

// 3. The async turn_end race: a pending-verification marker must block completion even
// though the board itself is absent/stale while the child process is still running.
async function testPendingVerificationBlocksCompletion() {
	const orch = await loadModule("extensions/orchestrator/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-pending-");
	try {
		fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(ws, ".pi", "verify-pending.json"),
			JSON.stringify({ startedAt: new Date().toISOString() }),
		);
		const result = orch.missionCompleteBlocked(ws);
		assert.equal(
			result.blocked,
			true,
			"an in-flight verify run must block completion, not race a stale/absent board read",
		);
	} finally {
		rmWorkspace(ws);
	}
}

// 4. Verdict writes are atomic and generation-tracked.
async function testVerdictWritesAreAtomicAndGenerationTracked() {
	const vg = await loadModule("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-generation-");
	try {
		vg.recordVerifyVerdict(ws, "verify", true, "first");
		const boardFile = path.join(ws, ".pi", "verdicts.json");
		const after1 = JSON.parse(fs.readFileSync(boardFile, "utf8"));
		assert.equal(after1.generation, 1, "first write must set generation to 1");

		vg.recordVerifyVerdict(ws, "verify", true, "second");
		const after2 = JSON.parse(fs.readFileSync(boardFile, "utf8"));
		assert.equal(
			after2.generation,
			2,
			"generation must increment monotonically on each write",
		);

		// No leftover temp file from the atomic write.
		const leftovers = fs
			.readdirSync(path.join(ws, ".pi"))
			.filter((f) => f.endsWith(".tmp"));
		assert.deepEqual(
			leftovers,
			[],
			"atomic write must not leave a temp file behind",
		);
	} finally {
		rmWorkspace(ws);
	}
}

// 5. Board writes take the shared O_EXCL lock: a held lock fails closed (no clobber),
// and a >60 s stale lock is taken over.
async function testBoardLockFailsClosedOnHeldLock() {
	const vg = await loadModule("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-boardlock-");
	try {
		fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
		const lock = path.join(ws, ".pi", "verdicts.lock");
		fs.writeFileSync(lock, "");
		const originalError = console.error;
		const errors = [];
		console.error = (...args) => errors.push(args.join(" "));
		try {
			vg.recordVerifyVerdict(ws, "verify", true, "must not be written");
		} finally {
			console.error = originalError;
		}
		const boardFile = path.join(ws, ".pi", "verdicts.json");
		assert.equal(
			fs.existsSync(boardFile),
			false,
			"a held board lock must fail closed, not clobber the board",
		);
		assert.ok(
			errors.some((line) => /failed to record verdict/i.test(line)),
			"a blocked write must still be reported via console.error",
		);
		assert.ok(
			fs.existsSync(lock),
			"verify-gate must not remove a lock it did not acquire",
		);
	} finally {
		rmWorkspace(ws);
	}
}

async function testBoardLockStaleTakeover() {
	const vg = await loadModule("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-boardlock-stale-");
	try {
		fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
		const lock = path.join(ws, ".pi", "verdicts.lock");
		fs.writeFileSync(lock, "");
		const stale = new Date(Date.now() - 120_000);
		fs.utimesSync(lock, stale, stale);
		vg.recordVerifyVerdict(ws, "verify", true, "stale takeover");
		const board = JSON.parse(
			fs.readFileSync(path.join(ws, ".pi", "verdicts.json"), "utf8"),
		);
		assert.equal(
			board.verdicts.verify.pass,
			true,
			"a >60 s stale lock must be taken over, not block writes forever",
		);
		assert.equal(
			fs.existsSync(lock),
			false,
			"an acquired lock must be released after the write",
		);
	} finally {
		rmWorkspace(ws);
	}
}

// 6. Two writers (fresh module instances, same cwd) each read-modify-write: both verdicts
// must survive because each mutation re-reads under the lock.
async function testConcurrentWritersDoNotClobberEachOther() {
	const vg = await loadModule("extensions/verify-gate/index.ts");
	const vg2 = await loadModule("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-boardmerge-");
	try {
		vg.recordVerifyVerdict(ws, "validator:a", true, "first writer");
		vg2.recordVerifyVerdict(ws, "validator:b", true, "second writer");
		const board = JSON.parse(
			fs.readFileSync(path.join(ws, ".pi", "verdicts.json"), "utf8"),
		);
		assert.equal(
			board.verdicts["validator:a"].pass,
			true,
			"first writer's verdict must survive the second write",
		);
		assert.equal(
			board.verdicts["validator:b"].pass,
			true,
			"second writer's verdict must be recorded too",
		);
		assert.equal(
			board.generation,
			2,
			"each locked write must increment the generation",
		);
	} finally {
		rmWorkspace(ws);
	}
}

// 7. The automatic turn_end path must honor PI_KIT_VERIFY_CMD without a package.json
// "verify" script (Area 3 F6), and clear its pending marker.
async function testAutomaticPathHonorsVerifyCmdOverride() {
	const vg = await loadModule("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-autocmd-");
	const restoreOnTurn = setEnv("PI_KIT_VERIFY_ON_TURN", "1");
	const restoreCmd = setEnv("PI_KIT_VERIFY_CMD", 'node -e "process.exit(0)"');
	try {
		fs.writeFileSync(
			path.join(ws, "package.json"),
			JSON.stringify({ name: "no-verify-script" }),
		);
		const pi = fakePi();
		vg.default(pi.api);
		await pi.handlers.get("session_start")({}, { cwd: ws });
		await pi.handlers.get("tool_result")({ isError: false, toolName: "write" });
		await pi.handlers.get("turn_end")(
			{ message: { role: "assistant", stopReason: "stop" } },
			{ cwd: ws, ui: { setStatus() {}, notify() {} } },
		);
		const board = JSON.parse(
			fs.readFileSync(path.join(ws, ".pi", "verdicts.json"), "utf8"),
		);
		assert.equal(
			board.verdicts.verify.pass,
			true,
			"automatic turn_end must run PI_KIT_VERIFY_CMD even without a verify script",
		);
		assert.match(board.verdicts.verify.summary, /configured check/i);
		assert.equal(
			fs.existsSync(path.join(ws, ".pi", "verify-pending.json")),
			false,
			"the pending marker must be cleared",
		);
	} finally {
		restoreCmd();
		restoreOnTurn();
		rmWorkspace(ws);
	}
}

// 8. A board with a null verdicts field must not swallow the write: `typeof null` is
// "object", so the guard must reject it and fall back to an initialised board.
async function testNullVerdictsBoardStillRecords() {
	const vg = await loadModule("extensions/verify-gate/index.ts");
	const ws = tmpWorkspace("pi-kit-eval-nullboard-");
	try {
		fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
		fs.writeFileSync(
			path.join(ws, ".pi", "verdicts.json"),
			JSON.stringify({ verdicts: null }),
		);
		vg.recordVerifyVerdict(ws, "verify", true, "null board");
		const board = JSON.parse(
			fs.readFileSync(path.join(ws, ".pi", "verdicts.json"), "utf8"),
		);
		assert.equal(
			board.verdicts.verify.pass,
			true,
			"a null verdicts field must not swallow a PASS verdict",
		);
		assert.equal(
			board.verdicts.verify.summary,
			"null board",
			"the repaired board must carry the recorded summary",
		);
	} finally {
		rmWorkspace(ws);
	}
}

const tests = [
	[
		"a held board lock fails closed; a stale lock is taken over",
		testBoardLockFailsClosedOnHeldLock,
	],
	[
		"a >60 s stale board lock is taken over (no permanent block)",
		testBoardLockStaleTakeover,
	],
	[
		"concurrent writers do not clobber each other's verdicts",
		testConcurrentWritersDoNotClobberEachOther,
	],
	[
		"automatic turn_end honors PI_KIT_VERIFY_CMD without a verify script",
		testAutomaticPathHonorsVerifyCmdOverride,
	],
	[
		"missing verify script does not record a false pass",
		testMissingScriptDoesNotRecordPass,
	],
	[
		"infra/memory-mcp (no verify script) does not record a false pass",
		testRealPackageWithoutVerifyScript,
	],
	[
		"missionCompleteBlocked fails closed on missing/malformed/empty/stale boards",
		testMissionCompleteBlockedFailsClosed,
	],
	[
		"an unparseable timestamp does not falsely trigger staleness",
		testUnparseableTimestampDoesNotFalselyBlock,
	],
	[
		"a pending verify run blocks completion (async race fix)",
		testPendingVerificationBlocksCompletion,
	],
	[
		"verdict writes are atomic and generation-tracked",
		testVerdictWritesAreAtomicAndGenerationTracked,
	],
	[
		"a null verdicts field does not swallow the verdict write",
		testNullVerdictsBoardStillRecords,
	],
];

let failed = 0;
for (const [name, fn] of tests) {
	try {
		await fn();
		console.log(`  OK: ${name}`);
	} catch (error) {
		failed++;
		console.error(`  FAIL: ${name}`);
		console.error(`    ${error.stack || error.message}`);
	}
}

if (failed > 0) {
	console.error(`\n[verify-failclosed-smoke] ${failed}/${tests.length} FAILED`);
	process.exit(1);
}
console.log(`\n[verify-failclosed-smoke] all ${tests.length} checks passed`);
