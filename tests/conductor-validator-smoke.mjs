#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, loadModule, fakePi, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.mjs";

const validator = await loadModule("extensions/conductor/validate/validator.ts");
const conductor = await loadModule("extensions/conductor/index.ts");
const evidence = "GET /accounts/42 returned account 42 to an unauthenticated request.";
const requirement = "Only authenticated users may retrieve their own account data.";
const finderNarrative = "Finder says this is CRITICAL and proves systemic compromise.";
const expectedTask = `## Evidence

${evidence}

## Requirement

${requirement}

## Questions

1. Is it real? Can it be reproduced from the evidence alone?
2. Does it matter? Judge significance or severity independently.
3. Does it match the requirement / stay in scope?
`;

function output(real = true, matters = true, inScope = true) {
  const verdict = real && matters && inScope ? "PASS" : "FAIL";
  return `## Real
${real ? "PASS" : "FAIL"}
Reason: Evidence independently supports this answer.

## Matters
${matters ? "PASS" : "FAIL"}
Reason: Independent impact assessment supports this answer.

## In Scope
${inScope ? "PASS" : "FAIL"}
Reason: Requirement comparison supports this answer.

## Verdict
${verdict}

## Summary
The supplied evidence was assessed independently against the supplied requirement.`;
}

function testBundleIsExactAndWithholdsNarrative() {
  const result = validator.buildValidatorBundle({ evidence, requirement });
  assert.equal(result.ok, true);
  assert.equal(result.task, expectedTask);
  assert.equal(result.task.includes(finderNarrative), false);
  assert.deepEqual(Object.keys({ evidence, requirement }), ["evidence", "requirement"]);
  assert.equal(validator.buildValidatorBundle({ evidence: "", requirement }).ok, false);
  assert.equal(validator.buildValidatorBundle({ evidence, requirement: "" }).ok, false);
}

async function testToolDispatchesAndRecordsWithInjectedChild() {
  const ws = tmpWorkspace("pi-kit-conductor-validator-dispatch-");
  try {
    const pi = fakePi(); let received;
    validator.registerValidatorTools(pi.api, { runner: async (_cwd, task) => { received = task; return { ok: true, output: output() }; } });
    assert.deepEqual([...pi.tools.keys()], ["dispatch_validator"], "raw verdict recording is not model-callable");
    const response = await pi.tools.get("dispatch_validator").execute("1", { findingId: "account-exposure", evidence, requirement }, undefined, undefined, { cwd: ws });
    assert.equal(received, expectedTask, "the child receives exactly the constructed evidence bundle");
    assert.match(response.content[0].text, /PASS recorded/);
    assert.equal(validator.findingValidated(ws, "account-exposure").validated, true);
    assert.deepEqual(validator.pendingValidatorFindings(ws), []);
    const trace = fs.readFileSync(path.join(ws, ".pi", "trace.jsonl"), "utf8");
    assert.match(trace, /conductor:dispatch_validator/); assert.match(trace, /conductor:record_validator_verdict/);
  } finally { rmWorkspace(ws); }
}

async function testEachQuestionFailureFailsClosedEndToEnd() {
  const ws = tmpWorkspace("pi-kit-conductor-validator-fail-");
  try {
    for (const [id, real, matters, inScope] of [["not-real", false, true, true], ["does-not-matter", true, false, true], ["out-of-scope", true, true, false]]) {
      const result = await validator.dispatchValidator(ws, id, { evidence, requirement }, async (_cwd, task) => { assert.equal(task, expectedTask); return { ok: true, output: output(real, matters, inScope) }; });
      assert.equal(result.ok, true); assert.equal(result.verdict.pass, false, `${id} must fail overall`);
      assert.equal(validator.findingValidated(ws, id).validated, false, `${id} must fail closed after actual dispatch+parse+record`);
    }
    assert.equal(conductor.verifierBoardBlocked(ws).blocked, true, "validator failures roll up to the existing board gate");
  } finally { rmWorkspace(ws); }
}

async function testPendingAndMalformedOutputFailClosed() {
  const ws = tmpWorkspace("pi-kit-conductor-validator-pending-");
  try {
    const result = await validator.dispatchValidator(ws, "bad-output", { evidence, requirement }, async () => ({ ok: true, output: "not structured" }));
    assert.equal(result.ok, false);
    assert.deepEqual(validator.pendingValidatorFindings(ws), ["bad-output"], "a dispatched finding remains pending until a real verdict records");
    assert.match(validator.findingValidated(ws, "bad-output").reason, /pending/);
  } finally { rmWorkspace(ws); }
}

function testStrictValidationAndStaleness() {
  const ws = tmpWorkspace("pi-kit-conductor-validator-verdict-");
  try {
    const malformed = validator.recordValidatorVerdict(ws, "malformed", { evidence, requirement, real: { pass: true, note: "" }, matters: { pass: true, note: "ok" }, inScope: { pass: true, note: "ok" } });
    assert.equal(malformed.ok, false, "empty reason is malformed");
    const passing = validator.recordValidatorVerdict(ws, "passing", { evidence, requirement, real: { pass: true, note: "reproduces" }, matters: { pass: true, note: "material" }, inScope: { pass: true, note: "in scope" }, extra: "must not persist" });
    assert.equal(passing.ok, true); assert.equal(validator.findingValidated(ws, "passing").validated, true);
    const file = path.join(ws, ".pi", "engagement", "findings", "passing", "verdict.json"); const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal("extra" in stored, false, "surplus runtime fields are not persisted");
    stored.at = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); fs.writeFileSync(file, JSON.stringify(stored));
    const stale = validator.findingValidated(ws, "passing"); assert.equal(stale.validated, false); assert.equal(stale.reason, "validator verdict stale", "a genuinely passing verdict fails specifically for staleness");
    stored.at = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(); fs.writeFileSync(file, JSON.stringify(stored));
    assert.equal(validator.findingValidated(ws, "passing").reason, "validator verdict stale", "future timestamps are untrusted");
    const board = JSON.parse(fs.readFileSync(path.join(ws, ".pi", "verdicts.json"), "utf8")); board.verdicts["validator:passing"].pass = "yes"; stored.at = new Date().toISOString(); fs.writeFileSync(file, JSON.stringify(stored)); fs.writeFileSync(path.join(ws, ".pi", "verdicts.json"), JSON.stringify(board));
    assert.equal(validator.findingValidated(ws, "passing").validated, false, "truthy non-boolean board pass is rejected");
  } finally { rmWorkspace(ws); }
}

async function testConductorMaterializesOnlyValidatorRole() {
  const ws = tmpWorkspace("pi-kit-conductor-validator-role-");
  try {
    const register = await loadExtension("extensions/conductor/index.ts"); const pi = fakePi(); register(pi.api);
    assert.deepEqual([...pi.tools.keys()], ["dispatch_validator", "dispatch_specialist"]);
    await pi.handlers.get("before_agent_start")({}, { cwd: ws });
    assert.match(fs.readFileSync(path.join(ws, ".pi", "agents", "validator.md"), "utf8"), /tools: read, grep, find, ls/);
  } finally { rmWorkspace(ws); }
}

const tests = [
  ["builds an exact independent evidence-only validator task", testBundleIsExactAndWithholdsNarrative],
  ["dispatches, parses, and records through the model-callable tool", testToolDispatchesAndRecordsWithInjectedChild],
  ["fails closed end-to-end for each independent question", testEachQuestionFailureFailsClosedEndToEnd],
  ["keeps dispatched malformed output pending", testPendingAndMalformedOutputFailClosed],
  ["strictly validates reasons, roll-ups, and verdict freshness", testStrictValidationAndStaleness],
  ["materializes the read-only validator role", testConductorMaterializesOnlyValidatorRole],
];
let failed = 0;
for (const [name, fn] of tests) { try { await fn(); console.log(`  OK: ${name}`); } catch (error) { failed++; console.error(`  FAIL: ${name}`); console.error(`    ${error.stack || error.message}`); } }
if (failed > 0) { console.error(`\n[conductor-validator-smoke] ${failed}/${tests.length} FAILED`); process.exit(1); }
console.log(`\n[conductor-validator-smoke] all ${tests.length} checks passed`);
