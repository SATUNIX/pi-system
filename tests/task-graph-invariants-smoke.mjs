#!/usr/bin/env node
/**
 * AG-03 regression coverage: task-graph must actually enforce DAG invariants, not just
 * store notes. Fully offline — no live pi, no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.mjs";

async function loadGraph() {
  const register = await loadExtension("extensions/task-graph/index.ts");
  const pi = fakePi();
  register(pi.api);
  return pi;
}

const ctx = { cwd: null };

async function create(pi, cwd, title, dependsOn) {
  return pi.tools.get("task_create").execute("c", { title, depends_on: dependsOn }, undefined, undefined, { cwd });
}

// Independent-repro shape: two consecutive task_next calls both returned t1.
async function testTaskNextClaimsAtomically() {
  const ws = tmpWorkspace("pi-kit-taskgraph-claim-");
  try {
    const pi = await loadGraph();
    await create(pi, ws, "first task");
    const first = await pi.tools.get("task_next").execute("c", {}, undefined, undefined, { cwd: ws });
    assert.match(first.content[0].text, /Next: t1/);
    const second = await pi.tools.get("task_next").execute("c", {}, undefined, undefined, { cwd: ws });
    assert.doesNotMatch(second.content[0].text, /Next: t1/, "a claimed task must not be handed out again");
    assert.match(second.content[0].text, /No unblocked task|All tasks done/);
  } finally {
    rmWorkspace(ws);
  }
}

// Independent-repro shape: task_complete(t2) succeeded while t2 still depended on
// unfinished t1.
async function testCompleteRejectsUnfinishedDependency() {
  const ws = tmpWorkspace("pi-kit-taskgraph-dep-");
  try {
    const pi = await loadGraph();
    await create(pi, ws, "t1 title");
    await create(pi, ws, "t2 title", ["t1"]);
    const result = await pi.tools.get("task_complete").execute("c", { id: "t2" }, undefined, undefined, { cwd: ws });
    assert.match(result.content[0].text, /Cannot complete t2.*unfinished dependencies.*t1/s);

    // Completing t1 first must then allow t2.
    await pi.tools.get("task_complete").execute("c", { id: "t1" }, undefined, undefined, { cwd: ws });
    const ok = await pi.tools.get("task_complete").execute("c", { id: "t2" }, undefined, undefined, { cwd: ws });
    assert.match(ok.content[0].text, /Completed t2/);
  } finally {
    rmWorkspace(ws);
  }
}

// Independent-repro shape: task_update(t1, "teleported") persisted the invalid state.
async function testUpdateRejectsInvalidStatus() {
  const ws = tmpWorkspace("pi-kit-taskgraph-status-");
  try {
    const pi = await loadGraph();
    await create(pi, ws, "t1 title");
    const result = await pi.tools.get("task_update").execute("c", { id: "t1", status: "teleported" }, undefined, undefined, { cwd: ws });
    assert.match(result.content[0].text, /Invalid status/);
    const list = await pi.tools.get("task_list").execute("c", {}, undefined, undefined, { cwd: ws });
    assert.match(list.content[0].text, /\[pending\]/, "the task's status must remain unchanged, not \"teleported\"");
  } finally {
    rmWorkspace(ws);
  }
}

// M-05: missing and self-referential dependencies must both be rejected at creation
// (a task cannot be given an id-dependency on itself, and cannot depend on a task that
// does not exist yet).
async function testDependencyValidation() {
  const ws = tmpWorkspace("pi-kit-taskgraph-cycles-");
  try {
    const pi = await loadGraph();
    const missing = await create(pi, ws, "bad task", ["t99"]);
    assert.match(missing.content[0].text, /unknown task/);

    // The first task created in a fresh graph is always assigned id "t1" (nextId()),
    // so a self-referential depends_on: ["t1"] is deterministically reachable here.
    const selfRef = await create(pi, ws, "self-dep", ["t1"]);
    assert.match(selfRef.content[0].text, /own id/);

    // Confirm the rejected task was never actually created.
    const list = await pi.tools.get("task_list").execute("c", {}, undefined, undefined, { cwd: ws });
    assert.match(list.content[0].text, /no tasks/);
  } finally {
    rmWorkspace(ws);
  }
}

// WU-2: a corrupted graph (a non-object task element and a task object missing
// dependsOn) must not crash the read paths. Seeded directly on disk to simulate an
// externally-edited/legacy graph that load() accepted verbatim.
async function testCorruptGraphDoesNotCrashReadPaths() {
  const ws = tmpWorkspace("pi-kit-taskgraph-corrupt-");
  try {
    const pi = await loadGraph();
    fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(ws, ".pi", "task-graph.json"),
      JSON.stringify({ tasks: [42, { id: "t1", title: "missing dependsOn", status: "pending" }] }),
      "utf8",
    );
    const list = await pi.tools.get("task_list").execute("c", {}, undefined, undefined, { cwd: ws });
    assert.equal(typeof list.content[0].text, "string");
    const next = await pi.tools.get("task_next").execute("c", {}, undefined, undefined, { cwd: ws });
    assert.equal(typeof next.content[0].text, "string");
  } finally {
    rmWorkspace(ws);
  }
}

const tests = [
  ["task_next claims a task atomically, does not hand it out twice", testTaskNextClaimsAtomically],
  ["task_complete rejects completion with unfinished dependencies", testCompleteRejectsUnfinishedDependency],
  ["task_update rejects an invalid status value", testUpdateRejectsInvalidStatus],
  ["task_create rejects missing/self-referential dependencies", testDependencyValidation],
  ["corrupt graph does not crash the task read paths", testCorruptGraphDoesNotCrashReadPaths],
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
  console.error(`\n[task-graph-invariants-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[task-graph-invariants-smoke] all ${tests.length} checks passed`);
