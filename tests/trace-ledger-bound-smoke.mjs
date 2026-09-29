#!/usr/bin/env node
/**
 * Evidence retention regression: long sessions and session startup must never
 * truncate the shared ledger. Retention is explicit and operator-managed. Fully offline — no live pi, no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.mjs";

async function testLedgerRetainsEvidence() {
  const ws = tmpWorkspace("pi-kit-trace-bound-");
  try {
    const register = await loadExtension("extensions/trace-ledger/index.ts");
    const pi = fakePi();
    register(pi.api);
    const ctx = { cwd: ws, hasUI: false, ui: { notify() {} } };
    await pi.handlers.get("session_start")({}, ctx);

    const ledgerPath = path.join(ws, ".pi", "trace.jsonl");

    // Simulate many turns, each with a couple of tool calls - past the former 500-line
    // trim - all within a single, uninterrupted session (no session_start in between).
    for (let i = 0; i < 300; i++) {
      await pi.handlers.get("tool_call")({ toolName: "read", input: { path: `src/f${i}.ts` } }, ctx);
      await pi.handlers.get("tool_result")({ toolName: "read", input: { path: `src/f${i}.ts` }, isError: false }, ctx);
      await pi.handlers.get("turn_end")({}, ctx);
    }

    const lineCount = fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).length;
    assert.equal(lineCount, 600, "all shared evidence must be retained");
    await pi.handlers.get("session_start")({}, ctx);
    assert.equal(fs.readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean).length, 600, "new sessions must not delete prior evidence");
  } finally {
    rmWorkspace(ws);
  }
}

async function testTraceSkipsNonObjectRecords() {
  const ws = tmpWorkspace("pi-kit-trace-corrupt-");
  try {
    const register = await loadExtension("extensions/trace-ledger/index.ts");
    const pi = fakePi();
    register(pi.api);
    const notices = [];
    const ctx = { cwd: ws, hasUI: true, ui: { notify: (msg) => notices.push(msg) } };
    await pi.handlers.get("session_start")({}, ctx);

    const ledgerPath = path.join(ws, ".pi", "trace.jsonl");
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    // Syntactically valid JSON that is not a plain object: null and 0.
    fs.writeFileSync(
      ledgerPath,
      ["null", "0", JSON.stringify({ kind: "call", tool: "read", target: "src/a.ts" })].join("\n") + "\n",
    );

    const command = pi.commands.get("trace");
    assert.ok(command, "trace command must be registered");
    await command.handler("", ctx);

    const summary = notices.join("\n");
    assert.ok(summary.includes("tool calls: 1"), `summary must count the valid record, got: ${summary}`);
    assert.ok(summary.includes("2 corrupt line(s) skipped"), `summary must report corrupt lines, got: ${summary}`);
  } finally {
    rmWorkspace(ws);
  }
}

const tests = [
  ["the ledger preserves long-session evidence and prior-session records", testLedgerRetainsEvidence],
  ["the /trace summary skips non-object records and counts valid ones", testTraceSkipsNonObjectRecords],
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
  console.error(`\n[trace-ledger-bound-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[trace-ledger-bound-smoke] all ${tests.length} checks passed`);
