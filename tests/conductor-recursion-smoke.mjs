#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadExtension, fakePi, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.mjs";

function context(cwd, notes, statuses) {
  return { cwd, ui: { notify: (message, level) => notes.push({ message, level }), setStatus: (key, text) => statuses.push({ key, text }) } };
}

async function setup(ws) {
  const register = await loadExtension("extensions/conductor/index.ts");
  const pi = fakePi(); register(pi.api);
  const notes = []; const statuses = []; const ctx = context(ws, notes, statuses);
  await pi.commands.get("engagement").handler("start", ctx);
  fs.mkdirSync(path.join(ws, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".pi", "agents", "scout.md"), "---\nname: scout\ntools: read\n---\nYou are a scout.\n");
  return { pi, notes, statuses };
}

function updateBudget(ws, budget) {
  const file = path.join(ws, ".pi", "engagement", "engagement.json");
  const record = JSON.parse(fs.readFileSync(file, "utf8")); record.recursion = budget; fs.writeFileSync(file, JSON.stringify(record, null, 2));
}

function engagement(ws) {
  return JSON.parse(fs.readFileSync(path.join(ws, ".pi", "engagement", "engagement.json"), "utf8"));
}

function traceEntries(ws) {
  return fs.readFileSync(path.join(ws, ".pi", "trace.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

async function testDepthCapIsDurableAndRefused() {
  const ws = tmpWorkspace("pi-kit-conductor-depth-"); const originalDepth = process.env.PI_KIT_CONDUCTOR_DEPTH;
  try {
    const { pi, statuses } = await setup(ws);
    updateBudget(ws, { maxDepth: 1, maxDispatches: 4, dispatchesUsed: 0 });
    let calls = 0;
    const runner = async (_cwd, _agent, _task, childDepth) => { calls++; assert.equal(childDepth, 1); return { ok: true, output: "done" }; };
    const module = await import(pathToFileURL(path.join(ROOT, "packages", "extensions", "src", "conductor", "index.ts")).href + `?depth=${Date.now()}`);
    delete process.env.PI_KIT_CONDUCTOR_DEPTH;
    assert.equal((await module.dispatchSpecialist(ws, "scout", "inspect", runner)).ok, true);
    process.env.PI_KIT_CONDUCTOR_DEPTH = "1";
    const refused = await module.dispatchSpecialist(ws, "scout", "recurse", runner);
    assert.deepEqual(refused, { ok: false, reason: "depth cap reached (1/1)" });
    assert.equal(calls, 1, "the runner must not start after a depth refusal");
    const record = engagement(ws);
    assert.equal(record.recursion.dispatchesUsed, 1, "the first reservation persists across a fresh dispatch call");
    await pi.commands.get("engagement").handler("status", context(ws, [], statuses));
    assert.ok(statuses.some((s) => s.key === "conductor-recursion" && /dispatches 1\/4/.test(s.text)), "footer status reports durable cap state");
    const entries = traceEntries(ws);
    const reservation = entries.find((entry) => entry.tool === "conductor:dispatch_specialist" && entry.target === "scout@1; cap allowed");
    assert.deepEqual(Object.fromEntries(["tool", "status"].map((key) => [key, reservation?.[key]])), { tool: "conductor:dispatch_specialist", status: "ok" }, "successful reservation has a structured audit entry");
    const consumption = entries.find((entry) => entry.tool === "conductor:dispatch_budget_consumed");
    assert.deepEqual(Object.fromEntries(["tool", "status"].map((key) => [key, consumption?.[key]])), { tool: "conductor:dispatch_budget_consumed", status: "ok" }, "budget consumption is audited with exact structured fields");
  } finally { if (originalDepth === undefined) delete process.env.PI_KIT_CONDUCTOR_DEPTH; else process.env.PI_KIT_CONDUCTOR_DEPTH = originalDepth; rmWorkspace(ws); }
}

async function testGenericSubagentIsBlockedAndLedgerIsProtected() {
  const ws = tmpWorkspace("pi-kit-conductor-closure-"); const oldProtected = process.env.PI_KIT_PROTECTED_PATHS;
  try {
    const { pi } = await setup(ws);
    const blocked = await pi.handlers.get("tool_call")({ toolName: "subagent", input: {} }, { cwd: ws, hasUI: false, ui: {} });
    assert.deepEqual(blocked, { block: true, reason: "conductor: an engagement is active; use dispatch_specialist for bounded delegation" });
    const module = await import(pathToFileURL(path.join(ROOT, "packages", "extensions", "src", "conductor", "index.ts")).href + `?protected=${Date.now()}`);
    fs.writeFileSync(path.join(ws, ".pi", "agents", "shell-role.md"), "---\nname: shell-role\ntools: read, bash\n---\nunsafe\n");
    const shellRole = await module.dispatchSpecialist(ws, "shell-role", "attempt shell escape", async () => ({ ok: true, output: "must not run" }));
    assert.match(shellRole.reason, /materialized tool restriction/, "bash-capable specialist definitions are refused before reservation");
    assert.equal(engagement(ws).recursion.dispatchesUsed, 0, "a rejected shell-capable role cannot consume dispatch budget");
    process.env.PI_KIT_PROTECTED_PATHS = module.specialistProtectedPaths();
    const protectedRegister = await loadExtension("vendor/protected-paths/index.ts"); const protectedPi = fakePi(); protectedRegister(protectedPi.api);
    const protectedCtx = { cwd: ws, hasUI: false, ui: {} };
    for (const [toolName, input] of [["write", { path: ".pi/engagement/engagement.json" }], ["edit", { path: ".pi/engagement/findings/x.json" }], ["bash", { command: "echo x > .pi/engagement/engagement.json" }]]) {
      const decision = await protectedPi.handlers.get("tool_call")({ toolName, input }, protectedCtx);
      assert.equal(decision?.block, true, `${toolName} must not write the specialist recursion ledger`);
    }
    assert.match(process.env.PI_KIT_PROTECTED_PATHS, /\.env;\.git\/;node_modules\/;.pi\/engagement\//, "specialist environment merges defaults rather than replacing them");
    fs.rmSync(path.join(ws, ".pi", "engagement", "engagement.json"));
    assert.equal(await pi.handlers.get("tool_call")({ toolName: "subagent", input: {} }, { cwd: ws, hasUI: false, ui: {} }), undefined, "generic subagent is only constrained during an active engagement");
  } finally { if (oldProtected === undefined) delete process.env.PI_KIT_PROTECTED_PATHS; else process.env.PI_KIT_PROTECTED_PATHS = oldProtected; rmWorkspace(ws); }
}

async function testAllEngagementWritersShareTheLock() {
  const ws = tmpWorkspace("pi-kit-conductor-writer-lock-"); const originalDepth = process.env.PI_KIT_CONDUCTOR_DEPTH;
  try {
    const { pi, notes, statuses } = await setup(ws); delete process.env.PI_KIT_CONDUCTOR_DEPTH;
    fs.writeFileSync(path.join(ws, ".pi", "verdicts.json"), JSON.stringify({ verdicts: { verify: { pass: true, at: new Date().toISOString() } } }));
    const module = await import(pathToFileURL(path.join(ROOT, "packages", "extensions", "src", "conductor", "index.ts")).href + `?lock=${Date.now()}`);
    let dispatch; let phaseAttempt;
    await module.withEngagementLock(ws, () => {
      dispatch = module.dispatchSpecialist(ws, "scout", "inspect", async () => ({ ok: true, output: "must not run" }));
      phaseAttempt = pi.commands.get("engagement").handler("phase authorisation", context(ws, notes, statuses));
    });
    const refused = await dispatch;
    assert.match(refused.reason, /engagement ledger is busy/, "dispatch cannot reserve while another engagement writer holds the shared lock");
    await phaseAttempt;
    assert.equal(engagement(ws).phase, "intake", "phase cannot write while another engagement writer owns the lock");
    await pi.commands.get("engagement").handler("phase authorisation", context(ws, notes, statuses));
    assert.equal(engagement(ws).phase, "authorisation", "phase writer works after the shared lock is released");
    const allowed = await module.dispatchSpecialist(ws, "scout", "inspect", async () => ({ ok: true, output: "done" }));
    assert.equal(allowed.ok, true);
    assert.equal(engagement(ws).recursion.dispatchesUsed, 1, "a later phase write cannot erase a durable dispatch reservation");
  } finally { if (originalDepth === undefined) delete process.env.PI_KIT_CONDUCTOR_DEPTH; else process.env.PI_KIT_CONDUCTOR_DEPTH = originalDepth; rmWorkspace(ws); }
}

async function testBudgetCapIsRefusedBeforeRunner() {
  const ws = tmpWorkspace("pi-kit-conductor-budget-"); const originalDepth = process.env.PI_KIT_CONDUCTOR_DEPTH;
  try {
    await setup(ws); updateBudget(ws, { maxDepth: 2, maxDispatches: 2, dispatchesUsed: 2 }); delete process.env.PI_KIT_CONDUCTOR_DEPTH;
    const module = await import(pathToFileURL(path.join(ROOT, "packages", "extensions", "src", "conductor", "index.ts")).href + `?budget=${Date.now()}`);
    let calls = 0; const refused = await module.dispatchSpecialist(ws, "scout", "runaway", async () => { calls++; return { ok: true, output: "must not run" }; });
    assert.deepEqual(refused, { ok: false, reason: "dispatch budget exhausted (2/2)" }); assert.equal(calls, 0, "budget refusal must precede child creation");
    const trace = fs.readFileSync(path.join(ws, ".pi", "trace.jsonl"), "utf8"); assert.match(trace, /"status":"error"/, "refused attempts are audited");
  } finally { if (originalDepth === undefined) delete process.env.PI_KIT_CONDUCTOR_DEPTH; else process.env.PI_KIT_CONDUCTOR_DEPTH = originalDepth; rmWorkspace(ws); }
}

import { pathToFileURL } from "node:url";
const tests = [
  ["durably refuses a depth-cap runaway with structured reservation audits", testDepthCapIsDurableAndRefused],
  ["refuses exhausted fan-out budget before spawning", testBudgetCapIsRefusedBeforeRunner],
  ["blocks generic delegation and protects the specialist ledger", testGenericSubagentIsBlockedAndLedgerIsProtected],
  ["serializes phase and dispatch writers through one lock", testAllEngagementWritersShareTheLock],
];
let failed = 0;
for (const [name, test] of tests) { try { await test(); console.log(`  OK: ${name}`); } catch (error) { failed++; console.error(`  FAIL: ${name}\n    ${error.stack || error.message}`); } }
if (failed) { console.error(`\n[conductor-recursion-smoke] ${failed}/${tests.length} FAILED`); process.exit(1); }
console.log(`\n[conductor-recursion-smoke] all ${tests.length} checks passed`);
