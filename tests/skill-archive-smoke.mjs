#!/usr/bin/env node
/**
 * H-05 regression coverage: skill_archive must not permit path traversal or destructive
 * destination aliasing. Fully offline — no live pi, no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.mjs";

async function archiveTool() {
  const register = await loadExtension("extensions/skill-forge/index.ts");
  const pi = fakePi();
  register(pi.api);
  return pi.tools.get("skill_archive");
}

// H-05 independent repro: skill_name="../../victim" must not let the tool delete an
// arbitrary reachable path (previously: source/destination both normalized to the same
// out-of-bounds "victim" directory, which was rm'd then the rename threw ENOENT).
async function testPathTraversalBlocked() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-skillarchive-"));
  const ws = path.join(root, "workspace");
  const victim = path.join(root, "victim");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(victim, { recursive: true });
  fs.writeFileSync(path.join(victim, "important.txt"), "do not delete me\n");
  try {
    const tool = await archiveTool();
    const res = await tool.execute("1", { skill_name: "../../victim" }, null, null, { cwd: ws });
    assert.ok(fs.existsSync(path.join(victim, "important.txt")), "traversal must not delete the victim directory");
    assert.match(res.content[0].text, /nothing to archive|not a valid skill name/, "traversal attempt must not report success");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Sanitization must reject a name that becomes empty/meaningless after stripping.
async function testDegenerateNameRejected() {
  const ws = tmpWorkspace("pi-kit-skillarchive-degenerate-");
  try {
    const tool = await archiveTool();
    const res = await tool.execute("1", { skill_name: "../.." }, null, null, { cwd: ws });
    assert.match(res.content[0].text, /not a valid skill name/, "an all-traversal name must be rejected outright");
  } finally {
    rmWorkspace(ws);
  }
}

// Legitimate archiving must still work end to end.
async function testLegitimateArchiveStillWorks() {
  const ws = tmpWorkspace("pi-kit-skillarchive-legit-");
  try {
    const proposalDir = path.join(ws, ".pi", "skill-proposals", "read-once-flow");
    fs.mkdirSync(proposalDir, { recursive: true });
    fs.writeFileSync(path.join(proposalDir, "SKILL.md"), "---\nname: read-once-flow\n---\n");

    const tool = await archiveTool();
    const res = await tool.execute("1", { skill_name: "read-once-flow", reason: "superseded by v2" }, null, null, { cwd: ws });

    assert.match(res.content[0].text, /archived 'read-once-flow'/);
    assert.ok(!fs.existsSync(proposalDir), "original proposal dir must be moved, not copied");
    const archived = path.join(ws, ".pi", "skill-archive", "read-once-flow");
    assert.ok(fs.existsSync(path.join(archived, "SKILL.md")), "archived skill content must be present");
    assert.match(fs.readFileSync(path.join(archived, "ARCHIVE_REASON.txt"), "utf8"), /superseded by v2/);
  } finally {
    rmWorkspace(ws);
  }
}

const tests = [
  ["path traversal via skill_name must not delete an out-of-bounds path", testPathTraversalBlocked],
  ["a degenerate all-traversal name is rejected outright", testDegenerateNameRejected],
  ["a legitimate archive still moves the proposal and writes the reason", testLegitimateArchiveStillWorks],
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
  console.error(`\n[skill-archive-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[skill-archive-smoke] all ${tests.length} checks passed`);
