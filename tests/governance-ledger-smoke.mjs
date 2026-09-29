#!/usr/bin/env node
/**
 * Governance ledger reader regression: malformed or non-object JSONL records and
 * task snapshots must be skipped rather than crashing state_summary. Fully offline.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { dataRoot, readJsonlTail, latestTaskSnapshots } from "../packages/container/mcp-servers/governance/ledger.js";

function tmpRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withDataRoot(fn) {
  const root = tmpRoot("pi-kit-governance-ledger-");
  const previous = process.env.PI_AGENT_DATA_ROOT;
  process.env.PI_AGENT_DATA_ROOT = root;
  try {
    return fn(root);
  } finally {
    if (previous === undefined) delete process.env.PI_AGENT_DATA_ROOT;
    else process.env.PI_AGENT_DATA_ROOT = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function testReadJsonlTailSkipsBadElements() {
  withDataRoot((root) => {
    const file = path.join(root, "evidence", "ledger.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const valid = { evidence_id: "EV-1", timestamp: "2026-01-01T00:00:00Z" };
    fs.writeFileSync(
      file,
      ["null", "[1]", "0", "{ not json", JSON.stringify(valid)].join("\n") + "\n",
    );

    const records = readJsonlTail(file, 10);
    assert.deepEqual(records, [valid], "only the valid object must survive");
    assert.equal(dataRoot(), root);
  });
}

function testReadJsonlTailMissingFile() {
  withDataRoot((root) => {
    assert.deepEqual(readJsonlTail(path.join(root, "evidence", "missing.jsonl"), 5), []);
  });
}

function testLatestTaskSnapshotsSkipsBadFiles() {
  withDataRoot((root) => {
    const tasksDir = path.join(root, "tasks");
    fs.mkdirSync(tasksDir, { recursive: true });
    fs.writeFileSync(path.join(tasksDir, "null.json"), "null\n");
    fs.writeFileSync(path.join(tasksDir, "array.json"), "[1]\n");
    fs.writeFileSync(path.join(tasksDir, "empty.json"), "{}\n");
    fs.writeFileSync(
      path.join(tasksDir, "older.json"),
      JSON.stringify({ task_id: "T-1", title: "older", updated_at: "2026-01-01T00:00:00Z" }),
    );
    const valid = { task_id: "T-2", title: "newer", status: "active", updated_at: "2026-02-01T00:00:00Z" };
    fs.writeFileSync(path.join(tasksDir, "newer.json"), JSON.stringify(valid));

    const snapshots = latestTaskSnapshots(10);
    assert.equal(snapshots.length, 2, "only non-null non-array objects must survive");
    assert.equal(snapshots[0].task_id, "T-2", "sort must put the newest snapshot first");
    assert.deepEqual(snapshots[0], {
      task_id: "T-2",
      title: "newer",
      status: "active",
      active_step: undefined,
      next_step: undefined,
      version: undefined,
      updated_at: "2026-02-01T00:00:00Z",
    });
  });
}

const tests = [
  ["readJsonlTail skips malformed and non-object JSONL elements", testReadJsonlTailSkipsBadElements],
  ["readJsonlTail returns an empty list for a missing file", testReadJsonlTailMissingFile],
  ["latestTaskSnapshots skips non-object task files and sorts valid ones", testLatestTaskSnapshotsSkipsBadFiles],
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
  console.error(`\n[governance-ledger-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[governance-ledger-smoke] all ${tests.length} checks passed`);
