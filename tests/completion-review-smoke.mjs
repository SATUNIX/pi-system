#!/usr/bin/env node
/**
 * Offline checks for the general completion verifier (verify-gate /verify and
 * verify_completion) and the definition-of-done view in verifier-board.
 * The reviewer child is replaced by an injected runner, so no model runs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadModule, fakePi, setEnv, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.mjs";

const vg = await loadModule("extensions/verify-gate/index.ts");
const vb = await loadModule("extensions/verifier-board/index.ts");
const orch = await loadModule("extensions/orchestrator/index.ts");

const board = (ws) => JSON.parse(fs.readFileSync(path.join(ws, ".pi", "verdicts.json"), "utf8"));

function workspace() {
  const ws = tmpWorkspace("pi-kit-review-");
  fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".pi", "GOAL.yaml"), "goal: Add a health endpoint to the service\n");
  fs.writeFileSync(path.join(ws, "TODO.md"), "# TODO\n\n- [x] #1: Add GET /health\n- [ ] #2: Document the endpoint in README\n");
  fs.writeFileSync(path.join(ws, ".pi", "task-graph.json"), JSON.stringify({ tasks: [{ id: "t1", title: "Wire route", status: "done" }] }));
  return ws;
}

const entries = [
  { type: "message", message: { role: "user", content: "Add a /health endpoint and document it." } },
  { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Builder reasoning: I THINK IT IS DONE" }] } },
  { type: "message", message: { role: "user", content: "/verify" } },
];

const PASS_OUTPUT = `## Criteria
- PASS | GET /health exists | src/server.ts:12
- PASS | README documents /health | README.md:40

## Verdict
PASS

## Summary
Both criteria have evidence.

## Next Actions
- none`;

const FAIL_OUTPUT = `## Criteria
- PASS | GET /health exists | src/server.ts:12
- FAIL | README documents /health | README.md has no /health section
- UNKNOWN | Todo #2 marked done | todo is unchecked

## Verdict
FAIL

## Summary
The endpoint exists but is not documented.

## Next Actions
- Add a /health section to README.md`;

function runner(output, calls = []) {
  return async (cwd, task, opts) => {
    calls.push({ cwd, task, opts });
    return { ok: true, output };
  };
}

async function withEnv(vars, fn) {
  const restores = Object.entries(vars).map(([k, v]) => setEnv(k, v));
  try { return await fn(); } finally { restores.reverse().forEach((r) => r()); }
}

const clean = { PI_KIT_VERIFY_CMD: undefined, PI_KIT_VERIFY_REVIEW: undefined, PI_KIT_TODO_FILE: undefined };

const tests = {
  async parserAcceptsConsistentOutput() {
    const pass = vg.parseReviewOutput(PASS_OUTPUT);
    assert.equal(pass.ok, true);
    assert.equal(pass.review.pass, true);
    assert.equal(pass.review.criteria.length, 2);
    assert.deepEqual(pass.review.nextActions, []);
    const fail = vg.parseReviewOutput(FAIL_OUTPUT);
    assert.equal(fail.review.pass, false);
    assert.deepEqual(fail.review.criteria.map((c) => c.status), ["PASS", "FAIL", "UNKNOWN"]);
    assert.deepEqual(fail.review.nextActions, ["Add a /health section to README.md"]);
  },

  async parserRejectsContradictionsAndJunk() {
    assert.match(vg.parseReviewOutput(FAIL_OUTPUT.replace("## Verdict\nFAIL", "## Verdict\nPASS")).reason, /contradicts/);
    assert.match(vg.parseReviewOutput("Looks good to me! PASS").reason, /no parseable criteria/);
    assert.match(vg.parseReviewOutput("## Criteria\n- PASS | a | b\n").reason, /no PASS\/FAIL verdict/);
    assert.equal(vg.parseReviewOutput("").ok, false);
  },

  async reviewTaskCarriesDefinitionOfDoneButNotBuilderReasoning() {
    const ws = workspace();
    try {
      const done = await vg.collectDoneContext(ws, entries, "check the docs too");
      const task = vg.buildReviewTask(done, { ran: true, ok: false, label: "npm run verify", output: "1 test failed" });
      assert.match(task, /## Operator focus\ncheck the docs too/);
      assert.match(task, /## Goal\nAdd a health endpoint/);
      assert.match(task, /- \[ \] #2: Document the endpoint in README/);
      assert.match(task, /- t1 \[done\] Wire route/);
      assert.match(task, /1\. Add a \/health endpoint and document it\./);
      assert.doesNotMatch(task, /\/verify$/m, "slash commands are not requests");
      assert.doesNotMatch(task, /I THINK IT IS DONE/, "builder reasoning never reaches the reviewer");
      assert.match(task, /FAILED\n1 test failed/);
    } finally { rmWorkspace(ws); }
  },

  async passingReviewWithoutCheckCommandPassesTheBoard() {
    await withEnv(clean, async () => {
      const ws = workspace();
      try {
        fs.writeFileSync(path.join(ws, ".pi", "verdicts.json"), JSON.stringify({ verdicts: { verify: { pass: false, summary: "old", at: new Date().toISOString() } } }));
        const calls = [];
        const report = await vg.runVerification(ws, { entries, runner: runner(PASS_OUTPUT, calls), model: "pentest/qwen" });
        assert.equal(report.pass, true);
        assert.equal(report.check.ran, false, "no check command is not a failure");
        assert.equal(calls[0].opts.model, "pentest/qwen");
        const b = board(ws);
        assert.equal(b.verdicts.review.pass, true);
        assert.match(b.verdicts.review.summary, /2\/2 criteria met/);
        assert.equal(b.verdicts.verify, undefined, "stale check verdict removed when there is no check command");
        assert.equal(orch.missionCompleteBlocked(ws).blocked, false, "a real passing review satisfies the gate");
        assert.ok(!fs.existsSync(path.join(ws, ".pi", "verify-pending.json")));
        const md = fs.readFileSync(path.join(ws, ".pi", "verify-report.md"), "utf8");
        assert.match(md, /Result: \*\*PASS\*\*/);
        assert.match(md, /- PASS \| README documents \/health \| README\.md:40/);
      } finally { rmWorkspace(ws); }
    });
  },

  async failingReviewBlocksWithActionableSummary() {
    await withEnv(clean, async () => {
      const ws = workspace();
      try {
        const report = await vg.runVerification(ws, { entries, runner: runner(FAIL_OUTPUT), model: "m/x" });
        assert.equal(report.pass, false);
        const b = board(ws);
        assert.equal(b.verdicts.review.pass, false);
        assert.match(b.verdicts.review.summary, /2 of 3 criteria not met: FAIL README documents \/health; UNKNOWN Todo #2/);
        assert.equal(orch.missionCompleteBlocked(ws).blocked, true);
        assert.match(report.text, /## Next actions\n- Add a \/health section to README\.md/);
      } finally { rmWorkspace(ws); }
    });
  },

  async checkFailureFailsEvenWhenReviewPasses() {
    await withEnv({ ...clean, PI_KIT_VERIFY_CMD: 'node -e "process.exit(3)"' }, async () => {
      const ws = workspace();
      try {
        const report = await vg.runVerification(ws, { entries, runner: runner(PASS_OUTPUT), model: "m/x" });
        assert.equal(report.check.ran, true);
        assert.equal(report.pass, false);
        assert.equal(board(ws).verdicts.verify.pass, false);
        assert.equal(board(ws).verdicts.review.pass, true);
      } finally { rmWorkspace(ws); }
    });
  },

  async checkPassWithReviewPasses() {
    await withEnv({ ...clean, PI_KIT_VERIFY_CMD: 'node -e "process.exit(0)"' }, async () => {
      const ws = workspace();
      try {
        const calls = [];
        const report = await vg.runVerification(ws, { entries, runner: runner(PASS_OUTPUT, calls), model: "m/x" });
        assert.equal(report.pass, true);
        assert.match(calls[0].task, /-> PASSED/, "reviewer sees the check result");
        assert.equal(orch.missionCompleteBlocked(ws).blocked, false);
      } finally { rmWorkspace(ws); }
    });
  },

  async nothingCheckedFailsClosed() {
    await withEnv(clean, async () => {
      const ws = workspace();
      try {
        // No model and no runner: the reviewer cannot run and there is no check command.
        const report = await vg.runVerification(ws, { entries });
        assert.equal(report.pass, false);
        const b = board(ws);
        assert.equal(b.verdicts.verify.pass, false);
        assert.match(b.verdicts.verify.summary, /nothing was checked.*no model selected/);
        assert.equal(b.verdicts.review.pass, false);
      } finally { rmWorkspace(ws); }
    });
    await withEnv({ ...clean, PI_KIT_VERIFY_REVIEW: "0" }, async () => {
      const ws = workspace();
      try {
        await vg.runVerification(ws, { entries, runner: runner(PASS_OUTPUT), model: "m/x" });
        assert.match(board(ws).verdicts.review.summary, /disabled/);
        assert.equal(orch.missionCompleteBlocked(ws).blocked, true);
      } finally { rmWorkspace(ws); }
    });
  },

  async malformedOrFailedReviewerNeverPasses() {
    await withEnv(clean, async () => {
      const ws = workspace();
      try {
        await vg.runVerification(ws, { entries, runner: runner("All good, ship it."), model: "m/x" });
        assert.equal(board(ws).verdicts.review.pass, false);
        assert.match(board(ws).verdicts.review.summary, /no parseable criteria/);
        await vg.runVerification(ws, { entries, runner: async () => ({ ok: false, reason: "reviewer timed out" }), model: "m/x" });
        assert.match(board(ws).verdicts.review.summary, /review did not run: reviewer timed out/);
        assert.equal(orch.missionCompleteBlocked(ws).blocked, true);
      } finally { rmWorkspace(ws); }
    });
  },

  async noDefinitionOfDoneDoesNotInventOne() {
    await withEnv(clean, async () => {
      const ws = tmpWorkspace("pi-kit-review-empty-");
      try {
        const calls = [];
        const report = await vg.runVerification(ws, { entries: [], runner: runner(PASS_OUTPUT, calls), model: "m/x" });
        assert.equal(calls.length, 0, "no reviewer call without anything to review against");
        assert.equal(report.pass, false);
        assert.match(board(ws).verdicts.review.summary, /no goal, todos, tasks, requests, or focus/);
      } finally { rmWorkspace(ws); }
    });
  },

  async toolAndCommandRegistrationAndChildGuard() {
    const pi = fakePi();
    vg.default(pi.api);
    assert.ok(pi.tools.has("verify_completion"));
    assert.ok(pi.commands.has("verify"));
    await withEnv({ PI_KIT_VERIFY_REVIEWER_CHILD: "1" }, async () => {
      const child = fakePi();
      (await loadModule("extensions/verify-gate/index.ts")).default(child.api);
      assert.equal(child.tools.has("verify_completion"), false, "the reviewer child cannot start another review");
    });
  },

  async boardStatusShowsDefinitionOfDone() {
    await withEnv(clean, async () => {
      const ws = workspace();
      try {
        await vg.runVerification(ws, { entries, runner: runner(FAIL_OUTPUT), model: "m/x" });
        const { overall, text } = vb.statusText(ws);
        assert.equal(overall, false);
        assert.match(text, /- review: FAIL — 2 of 3 criteria not met/);
        assert.match(text, /Goal: Add a health endpoint/);
        assert.match(text, /Todos: 1\/2 done\. Open: #2 Document the endpoint in README/);
        assert.match(text, /Tasks: 1\/1 done/);
        assert.match(text, /verify-report\.md \(FAIL, /);
        assert.match(text, /run verify_completion/);

        const pi = fakePi();
        vb.default(pi.api);
        const notes = [];
        await pi.commands.get("verdicts").handler("clear", { cwd: ws, ui: { notify: (m) => notes.push(m) } });
        assert.deepEqual(board(ws).verdicts, {});
        assert.equal(orch.missionCompleteBlocked(ws).blocked, true, "a cleared board still blocks");
        const recorded = await pi.tools.get("record_verdict").execute("id", { source: "tests", pass: true, summary: "12 passed", evidence: "pytest exit 0" }, undefined, undefined, { cwd: ws });
        assert.match(recorded.content[0].text, /Recorded tests: PASS/);
        assert.equal(board(ws).verdicts.tests.evidence, "pytest exit 0");
      } finally { rmWorkspace(ws); }
    });
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n${err.stack}`);
  }
}
const total = Object.keys(tests).length;
if (failed) {
  console.error(`completion-review-smoke: ${failed}/${total} failed`);
  process.exit(1);
}
console.log(`completion-review-smoke: ${total}/${total} passed`);
