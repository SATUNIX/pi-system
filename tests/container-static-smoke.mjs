#!/usr/bin/env node
// The container package's own static validators (scripts/preflight.sh: required files, JSON
// validity, version pins, MCP hardening flags, engagement templates, compose parity, ledger
// format) used to be documented but were never run, and had drifted until they could not pass.
// This runs them, so a change that breaks the container package's contract fails the gate. It
// needs `sh` and `python3`, and does not need a container engine.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { ROOT } from "../packages/core/eval/harness.mjs";

const dir = path.join(ROOT, "packages", "container");

if (process.platform === "win32") {
  console.log("[container-static-smoke] SKIP: needs a POSIX shell; runs in the Linux CI job");
  process.exit(0);
}

const have = (cmd) => spawnSync(cmd, ["--version"], { encoding: "utf8" }).status === 0;
assert.ok(have("python3"), "python3 is required for the container validators");

const run = spawnSync("sh", ["scripts/preflight.sh"], { cwd: dir, encoding: "utf8", env: { ...process.env, PI_AGENT_DATA_ROOT: path.join(dir, ".no-data-root") } });
assert.equal(run.status, 0, `preflight failed:\n${run.stdout}\n${run.stderr}`);
assert.match(run.stdout, /Pentest environment checks passed/);
assert.match(run.stdout, /Runtime readiness passed/);
assert.match(run.stdout, /\[validate-compose\] All checks passed\./);

// The validators must be able to fail: in a scratch copy of the tree they read, a broken pin and a
// removed hardening flag are each caught.
import fs from "node:fs";
import os from "node:os";
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-container-static-"));
try {
  const copy = (rel) => fs.cpSync(path.join(ROOT, rel), path.join(scratch, rel), { recursive: true, filter: (src) => !src.includes("node_modules") });
  copy("packages/container");
  copy("packages/extensions/src/pentest-governance-domain");
  copy("packages/kit/prompts");
  const cdir = path.join(scratch, "packages", "container");
  const validate = () => spawnSync("sh", ["scripts/validate-pentest-env.sh"], { cwd: cdir, encoding: "utf8", env: { ...process.env, PI_AGENT_DATA_ROOT: path.join(cdir, ".no-data-root") } });
  const clean = validate();
  assert.equal(clean.status, 0, `the copy must validate before it is broken:\n${clean.stdout}\n${clean.stderr}`);

  const dockerfile = path.join(cdir, "Dockerfile");
  const original = fs.readFileSync(dockerfile, "utf8");
  fs.writeFileSync(dockerfile, original.replace(/ARG PI_CODING_AGENT_VERSION=[0-9.]+/, "ARG PI_CODING_AGENT_VERSION=0.0.1"));
  const badPin = validate();
  assert.notEqual(badPin.status, 0, "a Dockerfile that drifts from the reviewed pi pin must fail");
  assert.match(badPin.stderr, /PI_CODING_AGENT_VERSION/);
  fs.writeFileSync(dockerfile, original);

  const mcp = path.join(cdir, "overlays", "pi", "mcp.json");
  const mcpOriginal = fs.readFileSync(mcp, "utf8");
  fs.writeFileSync(mcp, mcpOriginal.replace('"autoAuth": false', '"autoAuth": true'));
  const badFlag = validate();
  assert.notEqual(badFlag.status, 0, "turning an MCP hardening flag on must fail");
  assert.match(badFlag.stderr, /autoAuth/);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log("[container-static-smoke] OK (preflight passes; a drifted pin and a loosened MCP flag are each caught)");
