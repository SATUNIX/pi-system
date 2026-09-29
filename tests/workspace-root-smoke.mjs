#!/usr/bin/env node
// tool-firewall workspaceRoot() smoke: the workspace root must be recomputed on every call.
// A repo can be created at an ancestor after the first lookup; a cached root would go stale
// (and grow unbounded per distinct cwd). Deterministic and fully offline.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadModule } from "../packages/core/eval/harness.mjs";

const { workspaceRoot } = await loadModule("extensions/tool-firewall/config.ts");

const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-wsroot-"));
try {
  // (1) No .git anywhere above b: the cwd itself is the workspace.
  const b = path.join(base, "a", "b");
  fs.mkdirSync(b, { recursive: true });

  assert.equal(
    workspaceRoot(b),
    b,
    "workspaceRoot(b) with no enclosing .git must return b itself",
  );

  // Create a repo at an ancestor *after* the first call. The root must be recomputed, not
  // served from a cache: this is the case the removed `wsCache` got wrong.
  fs.mkdirSync(path.join(base, ".git"));
  assert.equal(
    workspaceRoot(b),
    base,
    "workspaceRoot(b) must recompute after <base>/.git appears (stale value means a wsCache regression)",
  );

  // (2) Repeated calls are stable once the ancestor repo exists.
  assert.equal(workspaceRoot(b), base, "repeated workspaceRoot(b) calls must be stable");
  assert.equal(workspaceRoot(b), base, "repeated workspaceRoot(b) calls must remain stable");

  // A cwd that owns its own .git returns itself, even under an ancestor repo.
  const c = path.join(base, "c");
  fs.mkdirSync(path.join(c, ".git"), { recursive: true });
  assert.equal(
    workspaceRoot(c),
    c,
    "a cwd containing its own .git must return itself",
  );
} finally {
  // (3) Clean up the temp tree.
  fs.rmSync(base, { recursive: true, force: true });
}

console.log("OK");
