#!/usr/bin/env node
/**
 * Offline checks for the run lifecycle (packages/autonomy/lib/lifecycle.mjs), the single-owner
 * run lock (runlock.mjs) and the persistent store (store.mjs): the transition table (every legal
 * and every illegal pair), the evidence guard on `succeeded`, distinct outcomes, resume semantics
 * per state, the trusted task board, stale/duplicate/wedged locks, and the control inbox.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assert, implementRaw, makeChecker, rm, tempDir, testEffort } from "./autonomy-helpers.mjs";
import { resolveContract } from "../packages/autonomy/lib/contract.mjs";
import { STATES, TERMINAL, TRANSITIONS, IllegalTransition, applyResultsToBoard, boardFromContract, canTransition, evidenceProblem, isTerminal, newState, resumeAction, transition } from "../packages/autonomy/lib/lifecycle.mjs";
import { assessLock, createRunLock } from "../packages/autonomy/lib/runlock.mjs";
import { RunStore, listRuns } from "../packages/autonomy/lib/store.mjs";
import { runPaths } from "../packages/autonomy/lib/paths.mjs";

const { check, done } = makeChecker("autonomy-lifecycle-smoke");
const contract = resolveContract(implementRaw(), { effort: testEffort }).contract;
const fresh = () => newState({ contract, contractDigest: "c".repeat(64), boundaryDigest: "b".repeat(64), authorisation: { boundaryDigest: "b".repeat(64), by: "test", at: "2026-09-30T00:00:00.000Z", via: "contract" }, effort: contract.effort, now: "2026-09-30T00:00:00.000Z" });
const withStatus = (status, extra = {}) => ({ ...fresh(), status, ...extra });
const evidence = { acceptance: { latest: { allRequiredPass: true, results: [] }, review: { required: true, status: "approved" }, history: [] } };

// The independent copy of the table: the one in lifecycle.mjs must equal it.
const LEGAL = {
  setup: ["ready", "failed", "cancelled"],
  ready: ["running", "paused", "failed", "cancelled"],
  running: ["paused", "blocked", "recovering", "succeeded", "failed", "cancelled", "budget_exhausted"],
  paused: ["running", "failed", "cancelled"],
  blocked: ["running", "paused", "failed", "cancelled"],
  recovering: ["running", "blocked", "paused", "failed", "cancelled", "budget_exhausted"],
  budget_exhausted: ["paused"],
  succeeded: [], failed: [], cancelled: [],
};

/** Everything a transition to `to` needs to be legal. */
const infoFor = (from, to) => ({
  reason: { blocked: "question", failed: "boundary_violation", budget_exhausted: "total_usd", cancelled: "operator", succeeded: "acceptance_passed" }[to] ?? "test",
  by: from === "budget_exhausted" ? "reconfigure" : "test",
  blocker: to === "blocked" ? { kind: "question", question: "Which database?" } : undefined,
});

await check("the ten states, and the table in the code equals the reviewed table", () => {
  assert.deepEqual(STATES, ["setup", "ready", "running", "paused", "blocked", "recovering", "succeeded", "failed", "cancelled", "budget_exhausted"]);
  assert.deepEqual(TRANSITIONS, LEGAL);
  assert.deepEqual([...TERMINAL].sort(), ["cancelled", "failed", "succeeded"]);
  assert.equal(isTerminal("budget_exhausted"), false, "an exhausted budget can be lifted, by `reconfigure` only");
});

await check("every legal transition succeeds and every illegal one throws (table-driven over all 100 pairs)", () => {
  let legal = 0; let illegal = 0;
  for (const from of STATES) {
    for (const to of STATES) {
      const state = withStatus(from, evidence);
      if (LEGAL[from].includes(to)) {
        const next = transition(state, to, infoFor(from, to));
        assert.equal(next.status, to, `${from} -> ${to}`);
        assert.equal(next.history.at(-1).from, from);
        assert.equal(next.history.at(-1).to, to);
        assert.equal(canTransition(from, to), true);
        legal++;
      } else {
        assert.throws(() => transition(state, to, infoFor(from, to)), (e) => e instanceof IllegalTransition && e.from === from && e.to === to, `${from} -> ${to} must be illegal`);
        assert.equal(canTransition(from, to), false);
        illegal++;
      }
    }
  }
  assert.equal(legal, 28);
  assert.equal(illegal, 72);
  assert.throws(() => transition(fresh(), "exploded", { reason: "x" }), IllegalTransition);
});

await check("guards: success needs trusted evidence and the required review; failures, budgets and blocks carry a reason; nothing leaves a terminal state", () => {
  const running = withStatus("running");
  assert.throws(() => transition(running, "succeeded", { reason: "acceptance_passed" }), /no acceptance evaluation/);
  assert.throws(() => transition({ ...running, acceptance: { latest: { allRequiredPass: false }, review: { required: false, status: "skipped" } } }, "succeeded", { reason: "x" }), /failing required checks/);
  assert.throws(() => transition({ ...running, acceptance: { latest: { allRequiredPass: true }, review: { required: true, status: "pending" } } }, "succeeded", { reason: "x" }), /review is required/);
  assert.throws(() => transition({ ...running, acceptance: { latest: { allRequiredPass: true }, review: { required: true, status: "rejected" } } }, "succeeded", { reason: "x" }), /review/);
  assert.equal(transition({ ...running, acceptance: { latest: { allRequiredPass: true }, review: { required: false, status: "skipped" } } }, "succeeded", { reason: "acceptance_passed" }).status, "succeeded");
  assert.equal(evidenceProblem({ ...running, ...evidence }), null);
  assert.throws(() => transition(running, "failed", {}), /reason is required/);
  assert.throws(() => transition(running, "failed", { reason: "because" }), /reason must be one of/, "failure reasons come from a closed list");
  assert.throws(() => transition(running, "budget_exhausted", { reason: "out of ideas" }), /total_usd, max_steps, max_minutes/);
  assert.throws(() => transition(running, "cancelled", {}), /reason is required/);
  assert.throws(() => transition(running, "blocked", { reason: "question" }), /blocker record is required/);
  for (const terminal of ["succeeded", "failed", "cancelled"]) for (const to of STATES) assert.throws(() => transition(withStatus(terminal, evidence), to, infoFor(terminal, to)), /terminal|illegal/);
  const exhausted = transition(running, "budget_exhausted", { reason: "max_steps" });
  assert.throws(() => transition(exhausted, "paused", { reason: "x", by: "operator" }), /reconfigure/);
  const lifted = transition(exhausted, "paused", { reason: "raised", by: "reconfigure" });
  assert.equal(lifted.status, "paused");
  assert.equal(lifted.outcome, null, "the exhaustion outcome is cleared when lifted, and stays in the history");
  assert.ok(lifted.history.some((h) => h.to === "budget_exhausted" && h.reason === "max_steps"));
});

await check("outcomes stay distinct: succeeded, failed (boundary_violation), cancelled and each budget reason are recorded as such", () => {
  const out = (to, reason, base = withStatus("running", evidence)) => transition(base, to, { reason, detail: "d" }).outcome;
  assert.deepEqual(Object.keys(out("succeeded", "acceptance_passed")).sort(), ["at", "detail", "reason", "status"]);
  assert.equal(out("failed", "boundary_violation").status, "failed");
  assert.equal(out("failed", "boundary_violation").reason, "boundary_violation");
  assert.equal(out("cancelled", "operator").status, "cancelled");
  for (const reason of ["total_usd", "max_steps", "max_minutes"]) { const o = out("budget_exhausted", reason); assert.deepEqual([o.status, o.reason], ["budget_exhausted", reason]); }
  const blocked = transition(withStatus("running"), "blocked", { reason: "question", blocker: { kind: "question", question: "Which database?" } });
  assert.equal(blocked.outcome, null, "blocked is not an outcome");
  assert.equal(blocked.blocker.question, "Which database?");
  assert.ok(blocked.blocker.since);
  assert.equal(transition(blocked, "running", { reason: "answered", by: "operator" }).blocker, null);
});

await check("resume semantics are defined for every state", () => {
  const r = (status, extra, opts) => resumeAction(withStatus(status, extra), opts);
  assert.deepEqual(STATES.map((s) => typeof r(s, {}).ok), STATES.map(() => "boolean"));
  assert.equal(r("setup").action, "redo_setup");
  assert.equal(r("ready").action, "start");
  assert.equal(r("running").action, "takeover");
  assert.equal(r("recovering").action, "takeover");
  assert.equal(r("paused").action, "unpause");
  assert.equal(r("blocked", { blocker: { kind: "question", question: "q?" } }).ok, false, "a question needs an answer");
  assert.match(r("blocked", { blocker: { kind: "question", question: "Which database?" } }).message, /--answer/);
  assert.equal(r("blocked", { blocker: { kind: "question" } }, { answer: "Postgres" }).ok, true);
  assert.equal(r("blocked", { blocker: { kind: "question" } }, { answer: "   " }).ok, false);
  assert.equal(r("blocked", { blocker: { kind: "approval" } }).ok, false);
  assert.equal(r("blocked", { blocker: { kind: "approval" } }, { approve: true }).ok, true);
  assert.equal(r("blocked", { blocker: { kind: "approval" } }, { deny: true }).ok, true);
  assert.equal(r("blocked", { blocker: { kind: "external", question: "waiting for the DBA" } }, { answer: "done" }).ok, true);
  for (const terminal of ["succeeded", "failed", "cancelled"]) assert.equal(r(terminal, { outcome: { reason: "x" } }).ok, false, terminal);
  const ex = r("budget_exhausted", { outcome: { reason: "total_usd" } });
  assert.equal(ex.ok, false);
  assert.match(ex.message, /reconfigure/);
});

await check("the state record: identity, digests, authorisation, trusted board, usage and recovery counters, effort snapshot", () => {
  const s = fresh();
  assert.equal(s.schemaVersion, 1);
  assert.deepEqual([s.run, s.template, s.status], ["todo-api-1", "implement", "setup"]);
  assert.equal(s.contractDigest.length, 64);
  assert.equal(s.authorisation.via, "contract");
  assert.deepEqual(s.usage, { usd: 0, minutes: 0, steps: 0 });
  assert.deepEqual(s.effort, { tier: "standard", cap: "standard" });
  assert.deepEqual(s.limits.budget, contract.budget, "budget is snapshotted; only reconfigure changes it");
  assert.equal(s.recovery.softNudgesUsed, 0);
  assert.deepEqual(s.tasks.map((t) => [t.id, t.status]), [["T1", "todo"], ["T2", "todo"]]);
  assert.deepEqual(s.worker, null);
  assert.equal(s.history[0].to, "setup");
  assert.equal(s.acceptance.review.status, "pending");
  assert.equal(s.promotion.status, "none");
  assert.equal(boardFromContract(contract).length, 2);
});

await check("the task board changes only from trusted check results; unverifiable items are covered by the run's overall acceptance", () => {
  const tasks = boardFromContract(contract); // T1 needs check "unit"; T2 names no check
  const fail = applyResultsToBoard(tasks, [{ id: "unit", pass: false }], { step: 1 });
  assert.deepEqual(fail.map((t) => t.status), ["in_progress", "todo"]);
  const pass = applyResultsToBoard(fail, [{ id: "unit", pass: true }], { step: 2 });
  assert.deepEqual(pass.map((t) => t.status), ["done", "todo"], "T2 has no check of its own, so a passing check does not complete it");
  const regress = applyResultsToBoard(pass, [{ id: "unit", pass: false }], { step: 3 });
  assert.equal(regress[0].status, "todo", "an item that stops passing is no longer done");
  const finished = applyResultsToBoard(pass, [{ id: "unit", pass: true }], { step: 4, complete: true });
  assert.deepEqual(finished.map((t) => t.status), ["done", "done"]);
  assert.match(finished[1].evidence[0], /covered by the run's acceptance/);
  assert.equal(applyResultsToBoard(tasks, [], { step: 1 })[0].status, "todo", "no evidence, no progress");
});

// --- the run lock -----------------------------------------------------------------------------
const tmp = tempDir("autonomy-lock-");
const lockFile = path.join(tmp, "run", "supervisor.lock");
let clock = Date.parse("2026-09-30T00:00:00Z");
const mk = (over = {}) => createRunLock({ file: lockFile, host: "hostA", pid: 1000, now: () => clock, isAlive: () => true, startTimeOf: () => "proc:42", staleMs: 60_000, ...over });

await check("lock: one owner; a duplicate start refuses while the owner is alive", () => {
  const a = mk({ pid: 1001 });
  const got = a.acquire();
  assert.equal(got.acquired, true);
  const rec = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  assert.deepEqual([rec.pid, rec.host, rec.startTime], [1001, "hostA", "proc:42"]);
  assert.ok(rec.heartbeatAt && rec.token);
  const b = mk({ pid: 1002 });
  const dup = b.acquire();
  assert.equal(dup.acquired, false);
  assert.match(dup.reason, /already being supervised/);
  assert.equal(dup.holder.pid, 1001);
  clock += 10_000;
  assert.equal(a.heartbeat(), true);
  assert.equal(JSON.parse(fs.readFileSync(lockFile, "utf8")).heartbeatAt, new Date(clock).toISOString());
  a.release();
  assert.equal(fs.existsSync(lockFile), false);
  assert.equal(b.acquire().acquired, true, "free after release");
  b.release();
});

await check("lock: a crashed owner (process gone) is stale; the next supervisor takes over and the old owner learns it lost the lock", () => {
  const dead = mk({ pid: 2001 });
  dead.acquire();
  const next = mk({ pid: 2002, isAlive: (pid) => pid !== 2001 });
  const got = next.acquire();
  assert.equal(got.acquired, true);
  assert.equal(got.tookOver.pid, 2001);
  assert.match(got.tookOver.why, /no longer exists/);
  assert.equal(dead.heartbeat(), false, "the displaced owner sees the lock is no longer its own");
  assert.equal(next.heartbeat(), true);
  dead.release();
  assert.equal(fs.existsSync(lockFile), true, "a displaced owner must not delete the new owner's lock");
  next.release();
});

await check("lock: pid reuse is detected from the process start time; other hosts are judged by heartbeat age; a wedged local owner is never taken over", () => {
  const rec = { pid: 3001, host: "hostA", startTime: "proc:42", heartbeatAt: new Date(clock).toISOString() };
  const base = { host: "hostA", now: clock, isAlive: () => true, startTimeOf: () => "proc:42", staleMs: 60_000 };
  assert.equal(assessLock(rec, base).state, "alive");
  assert.match(assessLock(rec, { ...base, startTimeOf: () => "proc:99" }).why, /reused/);
  assert.equal(assessLock(rec, { ...base, startTimeOf: () => "proc:99" }).state, "stale");
  assert.equal(assessLock(rec, { ...base, now: clock + 600_000 }).state, "wedged", "alive but silent: never taken over automatically");
  assert.equal(assessLock({ ...rec, host: "hostB" }, base).state, "alive", "another host with a fresh heartbeat");
  assert.equal(assessLock({ ...rec, host: "hostB" }, { ...base, now: clock + 600_000 }).state, "stale", "another host, no heartbeat");
  assert.equal(assessLock(rec, { ...base, startTimeOf: () => null }).state, "alive", "start time unreadable: trust the fresh heartbeat");
  assert.equal(assessLock(rec, { ...base, startTimeOf: () => null, now: clock + 600_000 }).state, "stale", "start time unreadable and no heartbeat");
  const owner = mk({ pid: 3002 });
  owner.acquire();
  clock += 600_000;
  const b = mk({ pid: 3003 });
  const r = b.acquire();
  assert.equal(r.acquired, false);
  assert.match(r.reason, /wedged/);
  owner.release();
});

await check("lock: a corrupt lock file is stale once it is old, and 'being written' while young", () => {
  fs.writeFileSync(lockFile, "{not json");
  const a = mk({ pid: 4001, now: () => Date.now() });
  assert.equal(a.acquire().acquired, false, "just written: someone may be mid-write");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockFile, old, old);
  assert.equal(a.acquire().acquired, true);
  a.release();
  const real = createRunLock({ file: lockFile });
  assert.equal(real.acquire().acquired, true, "the real pid/start-time helpers work on this machine");
  const insp = real.inspect();
  assert.equal(insp.state, "alive");
  const twin = createRunLock({ file: lockFile });
  assert.equal(twin.acquire().acquired, false, "a second supervisor process on this host is refused");
  real.release();
});

await check("lock: heartbeat timer reports a lost lock", async () => {
  const a = createRunLock({ file: lockFile, heartbeatMs: 20 });
  a.acquire();
  let lost = false;
  a.start(() => { lost = true; });
  fs.rmSync(lockFile);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(lost, true);
  a.release();
});

// --- the store --------------------------------------------------------------------------------
await check("store: state round-trips atomically; transitions persist; the control inbox is ordered and acknowledged", () => {
  const home = path.join(tmp, "home");
  const store = new RunStore("todo-api-1", { home, now: () => new Date("2026-09-30T01:00:00Z") });
  assert.equal(store.exists(), false);
  fs.mkdirSync(store.p.root, { recursive: true });
  store.writeState(fresh());
  assert.equal(store.exists(), true);
  store.transition("ready", { reason: "setup complete" });
  assert.equal(store.readState().status, "ready");
  assert.equal(store.readState().updatedAt, "2026-09-30T01:00:00.000Z");
  assert.throws(() => store.transition("succeeded", { reason: "x" }), IllegalTransition);
  assert.equal(store.readState().status, "ready", "a refused transition changes nothing");
  fs.writeFileSync(store.p.state, JSON.stringify({ ...store.readState(), schemaVersion: 9 }));
  assert.throws(() => store.readState(), /schemaVersion 9/);
  store.writeState(fresh());
  const a = store.enqueue("pause");
  const b = store.enqueue("steer", { message: "use sqlite" });
  const c = store.enqueue("cancel");
  assert.deepEqual(store.pending().map((m) => m.kind), ["pause", "steer", "cancel"]);
  assert.equal(store.pending()[1].payload.message, "use sqlite");
  store.ack(a); store.ack(b);
  assert.deepEqual(store.pending().map((m) => m.name), [c]);
  assert.throws(() => store.enqueue("format-disk"), /unknown control/);
  store.log("hello");
  assert.match(fs.readFileSync(store.p.log, "utf8"), /2026-09-30T01:00:00.000Z hello/);
  assert.equal(listRuns(home)[0].run, "todo-api-1");
  assert.deepEqual(Object.keys(runPaths("x", "/h")).sort(), Object.keys(runPaths("y", "/h")).sort());
  assert.ok(runPaths("run-1", "/h").root === path.join("/h", "run-1"));
  assert.equal(os.hostname().length > 0, true);
});

rm(tmp);
done();
