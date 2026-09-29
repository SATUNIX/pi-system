#!/usr/bin/env node
/**
 * B-097 regression coverage: the check-suite runner must resolve an npm command
 * that works on Windows (`npm.cmd` + shell), matching pack-check.mjs. Also asserts
 * that importing the module no longer runs the suite (is-main guard), so `--list`
 * can be exercised.
 *
 * Deterministic and offline - no pi/docker/network.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveNpmCommand } from "../packages/core/check-all.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

assert.deepEqual(
  resolveNpmCommand("win32"),
  { command: "npm.cmd", shell: true },
  "win32 must use the npm.cmd shim with shell:true",
);
assert.deepEqual(resolveNpmCommand("linux"), { command: "npm", shell: false });
assert.deepEqual(resolveNpmCommand("darwin"), { command: "npm", shell: false });

// Importing the module must not have started the suite; --list runs and exits 0.
const cli = spawnSync(process.execPath, [path.join(ROOT, "packages", "core", "check-all.mjs"), "--list"], {
  encoding: "utf8",
});
assert.equal(cli.status, 0, `check-all --list must exit 0 (stderr: ${cli.stderr.trim()})`);
assert.match(cli.stdout, /check-all: \d+ check run\(s\) would run/);

console.log("check-all npm smoke: OK");
