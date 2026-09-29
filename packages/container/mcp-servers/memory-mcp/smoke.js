#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-memory-mcp-"));
const env = { ...process.env, PI_KIT_MEMORY_MCP_DATA_ROOT: root };
const here = path.dirname(fileURLToPath(import.meta.url));

function call(name, params) {
  const stdout = execFileSync(process.execPath, ["./index.js", "--call", name, JSON.stringify(params || {})], {
    cwd: here,
    env,
    encoding: "utf8"
  });
  return JSON.parse(stdout);
}

try {
  const stored = call("memory_store", { topic: "auth", content: "Use passkeys for admin authentication", tags: ["security"] });
  assert.match(stored.memory_id, /^MEM-/);

  const search = call("memory_search", { query: "passkeys", limit: 5 });
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].memory_id, stored.memory_id);

  const updated = call("memory_update", { memory_id: stored.memory_id, tags: ["security", "identity"] });
  assert.deepEqual(updated.tags, ["security", "identity"]);

  const task = call("task_create", { task_id: "smoke-task", title: "Smoke task", status: "candidate" });
  assert.equal(task.status, "candidate");

  const active = call("task_state_update", { task_id: "smoke-task", status: "active", active_step: "Run server smoke" });
  assert.equal(active.version, 2);
  assert.equal(active.status, "active");

  const read = call("task_state_read", { task_id: "smoke-task" });
  assert.equal(read.task.task_id, "smoke-task");

  const done = call("task_complete", { task_id: "smoke-task", notes: "validated" });
  assert.equal(done.status, "done");

  const checkpoint = call("checkpoint_append", { task_id: "smoke-task", summary: "Checkpoint smoke" });
  assert.equal(checkpoint.sequence, 1);

  for (let i = 0; i < 12; i++) {
    call("trace_append", { event_type: "smoke", payload: { i } });
  }
  const trace = call("trace_tail", { limit: 10 });
  assert.equal(trace.events.length, 10);
  assert.equal(trace.events[0].payload.i, 2);

  const traceFile = path.join(root, "trace", "trace.jsonl");
  const lines = fs.readFileSync(traceFile, "utf8").trim().split(/\r?\n/).map((line) => JSON.parse(line));
  for (let i = 1; i < lines.length; i++) {
    assert.equal(lines[i].previous_hash, lines[i - 1].record_hash);
  }

  const summary = call("state_summary", { max_items: 3 });
  assert.equal(summary.counts.memories, 1);
  assert.equal(summary.counts.tasks, 1);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.error("Memory MCP smoke checks passed");
