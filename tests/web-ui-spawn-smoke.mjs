#!/usr/bin/env node
// Offline regression smoke for the web-ui spawn lifecycle. Two bugs:
//   B-099: createSession writes RUNTIME_DIR/agent-<name>-<hex>.md for
//          --append-system-prompt, but PiRpcProcess never unlinked it.
//   B-101: the child `exit` handler never removed the proc from the module-level
//          registry, so dead procs (each with up to 500 replay events) accumulated.
// PI_BIN is set to node itself, which exits immediately on the unknown `--mode`
// argv, so the child dies fast and no network or pi install is needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let homeDir = null;
let projectDir = null;
let cwdDir = null;
let failed = false;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed = true;
    console.error(`  not ok - ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

let runtimeDir = null;
let runtimeExisted = false;
let preexisting = new Set();

try {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-spawn-home-"));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-spawn-proj-"));
  cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-spawn-cwd-"));

  // config.js captures HOME, the agent dirs and PI_BIN at import time, so set every
  // env var before the dynamic import.
  process.env.HOME = homeDir;
  process.env.PI_CODING_AGENT_DIR = path.join(homeDir, ".pi", "agent");
  process.env.PI_CONSOLE_PROJECT_AGENTS = projectDir;
  process.env.PI_BIN = process.execPath;

  fs.writeFileSync(
    path.join(projectDir, "spawn-smoke.md"),
    "---\nname: spawn-smoke\ndescription: smoke\n---\n\nspawn smoke body\n",
    "utf8",
  );

  const { createSession, listLiveSessions, getSession } = await import(
    "../packages/web-ui/server/spawn.js"
  );
  const { RUNTIME_DIR } = await import("../packages/web-ui/server/config.js");
  runtimeDir = RUNTIME_DIR;
  runtimeExisted = fs.existsSync(runtimeDir);
  try {
    for (const name of fs.readdirSync(runtimeDir)) {
      if (/^agent-spawn-smoke-.*\.md$/.test(name)) preexisting.add(name);
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }

  const proc = await createSession({ cwd: cwdDir, agent: "spawn-smoke" });

  // Wait for the child to die (poll, up to 5s).
  const deadline = Date.now() + 5000;
  while (!proc.exited && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  check("createSession returned the spawn-smoke agent proc", () => {
    assert.equal(proc.agentName, "spawn-smoke");
  });

  check("agent prompt file is unlinked on exit (B-099)", () => {
    const leftover = fs.readdirSync(runtimeDir).filter(
      (name) =>
        /^agent-spawn-smoke-.*\.md$/.test(name) && !preexisting.has(name),
    );
    assert.deepEqual(leftover, [], `leaked agent prompt file(s): ${leftover}`);
  });

  check("live session registry is empty after exit (B-101)", () => {
    assert.equal(listLiveSessions().length, 0);
  });

  check("getSession returns null for the exited proc (B-101)", () => {
    assert.equal(getSession(proc.publicId), null);
  });
} finally {
  if (runtimeDir) {
    try {
      for (const name of fs.readdirSync(runtimeDir)) {
        if (/^agent-spawn-smoke-.*\.md$/.test(name) && !preexisting.has(name)) {
          fs.rmSync(path.join(runtimeDir, name), { force: true });
        }
      }
      // Only remove RUNTIME_DIR when this run created it and it is now empty.
      if (!runtimeExisted && fs.readdirSync(runtimeDir).length === 0) {
        fs.rmdirSync(runtimeDir);
      }
    } catch {
      /* best-effort cleanup */
    }
  }
  for (const dir of [homeDir, projectDir, cwdDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (failed) {
  console.error("web-ui-spawn smoke: FAIL");
  process.exit(1);
}
console.log("web-ui-spawn smoke: OK");
