#!/usr/bin/env node
/**
 * Offline check that the standalone web-ui installer resolves the install marker with the
 * same precedence as uninstall.mjs: a project marker in the cwd wins over the global one.
 *
 * Fully hermetic: `--dry-run` means the kit installer is never executed, and a throwaway
 * `pi` on PATH satisfies the prerequisite check. The project marker asks for a reconcile,
 * which is exactly the branch that used to be reached only through the global marker.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "packages", "web-ui", "install.mjs");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-webui-install-"));
const agent = path.join(dir, "agent");
const project = path.join(dir, "project");
const bin = path.join(dir, "bin");
try {
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });

  // A fake pi is enough for the prerequisite check; --dry-run never invokes it.
  fs.writeFileSync(path.join(bin, "pi"), "#!/bin/sh\nexit 0\n");
  fs.chmodSync(path.join(bin, "pi"), 0o755);

  // A global marker that must be ignored because a project marker exists in the cwd.
  fs.writeFileSync(
    path.join(agent, ".pi-kit.json"),
    JSON.stringify({ kitSource: "/nonexistent", profile: "global-prof", scope: "global", extensions: [] }),
  );
  fs.writeFileSync(
    path.join(project, ".pi", ".pi-kit.json"),
    JSON.stringify({ kitSource: "/nonexistent", profile: "proj-prof", scope: "project", extensions: [] }),
  );

  const result = spawnSync(process.execPath, [INSTALL, "--dry-run"], {
    cwd: project,
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.ok(!/No kit install found/.test(result.stdout), "the project marker must be found");
  assert.match(result.stdout, /would reconcile the existing "proj-prof" install/);
  assert.match(result.stdout, /--profile proj-prof --yes --scope project/);

  console.log("[web-ui-install-smoke] OK: project marker is resolved before the global marker");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
