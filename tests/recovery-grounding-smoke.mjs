#!/usr/bin/env node
/**
 * H-06 regression coverage (partial): the recovery report must be grounded in real
 * recorded action history, not a 100%-blank template. Fully offline — no live pi.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.mjs";

async function testReportIncludesRealTraceData() {
  const ws = tmpWorkspace("pi-kit-recovery-ground-");
  try {
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    const lines = [
      JSON.stringify({ kind: "call", tool: "read", target: "src/app.ts", status: undefined }),
      JSON.stringify({ kind: "result", tool: "read", target: "src/app.ts", status: "ok" }),
      JSON.stringify({ kind: "call", tool: "grep", target: "TODO", status: undefined }),
      JSON.stringify({ kind: "result", tool: "grep", target: "TODO", status: "error" }),
      JSON.stringify({ kind: "call", tool: "read", target: "src/app.ts", status: undefined }),
      JSON.stringify({ kind: "result", tool: "read", target: "src/app.ts", status: "ok" }),
    ];
    fs.writeFileSync(path.join(ws, ".pi", "trace.jsonl"), lines.join("\n") + "\n");

    const register = await loadExtension("extensions/recovery-orchestrator/index.ts");
    const pi = fakePi();
    register(pi.api);
    await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
    fs.mkdirSync(path.join(ws, ".pi", "recovery"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".pi", "recovery", "escalation.json"),
      JSON.stringify({ signature: "repeat:xyz", reason: "repeated action", count: 3, at: new Date().toISOString() }),
    );
    await pi.handlers.get("turn_end")({}, { cwd: ws, ui: { notify() {} } });

    const reports = fs.readdirSync(path.join(ws, ".pi", "recovery")).filter((f) => f.endsWith(".md"));
    assert.equal(reports.length, 1, "recovery must write exactly one report");
    const report = fs.readFileSync(path.join(ws, ".pi", "recovery", reports[0]), "utf8");

    assert.match(report, /Recorded action history \(real, from trace-ledger/, "report must have a real-data grounding section");
    assert.match(report, /read \(2×\)/, "report must reflect the actual tool-call counts from trace.jsonl");
    assert.match(report, /1 result\(s\) recorded as error/, "report must reflect the actual error count from trace.jsonl");
    assert.doesNotMatch(report, /- scout 1: fill/i, "must not fabricate scout findings that never ran");
  } finally {
    rmWorkspace(ws);
  }
}

async function testReportHandlesMissingTraceGracefully() {
  const ws = tmpWorkspace("pi-kit-recovery-notrace-");
  try {
    const register = await loadExtension("extensions/recovery-orchestrator/index.ts");
    const pi = fakePi();
    register(pi.api);
    await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
    fs.mkdirSync(path.join(ws, ".pi", "recovery"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".pi", "recovery", "escalation.json"),
      JSON.stringify({ signature: "stall", reason: "read stall", count: 2, at: new Date().toISOString() }),
    );
    await pi.handlers.get("turn_end")({}, { cwd: ws, ui: { notify() {} } });

    const reports = fs.readdirSync(path.join(ws, ".pi", "recovery")).filter((f) => f.endsWith(".md"));
    const report = fs.readFileSync(path.join(ws, ".pi", "recovery", reports[0]), "utf8");
    assert.match(report, /no trace-ledger data available/, "must degrade gracefully with no trace.jsonl present");
  } finally {
    rmWorkspace(ws);
  }
}

const tests = [
  ["recovery report is grounded in real trace-ledger data", testReportIncludesRealTraceData],
  ["recovery report degrades gracefully with no trace data", testReportHandlesMissingTraceGracefully],
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
  console.error(`\n[recovery-grounding-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[recovery-grounding-smoke] all ${tests.length} checks passed`);
