#!/usr/bin/env node
// Shutdown hooks must ignore one-shot internal pi children, while retaining
// their normal top-level behavior and explicit operator commands.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  assert,
  fakePi,
  isolateKitEnv,
  loadExtension,
  rmWorkspace,
  setEnv,
  tmpWorkspace,
} from "../packages/core/eval/harness.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(cwd) {
  git(cwd, ["init"]);
  git(cwd, ["config", "user.name", "Pi Kit Smoke"]);
  git(cwd, ["config", "user.email", "pi-kit-smoke@example.invalid"]);
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "baseline\n");
  git(cwd, ["add", "tracked.txt"]);
  git(cwd, ["commit", "-m", "initial"]);
}

function shutdownCtx(cwd) {
  return {
    cwd,
    hasUI: true,
    ui: { notify() {} },
    sessionManager: {
      getEntries: () => [{
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "smoke work" }] },
      }],
    },
  };
}

async function run() {
  const workspace = tmpWorkspace("pi-kit-shutdown-gating-");
  const restoreIsolation = isolateKitEnv();
  const restoreInternalChild = setEnv("PI_KIT_INTERNAL_CHILD", undefined);
  const restoreAutoMode = setEnv("PI_KIT_AUTO_MODE", undefined);
  const restoreAudit = setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(workspace, "firewall-audit.jsonl"));
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", path.join(workspace, "agent"));
  try {
    const autoCommit = await loadExtension("vendor/auto-commit-on-exit/index.ts");
    const handoff = await loadExtension("vendor/handoff/index.ts");

    // A real top-level shutdown commits a dirty real git worktree.
    const commitRepo = path.join(workspace, "commit-baseline");
    fs.mkdirSync(commitRepo);
    initRepo(commitRepo);
    fs.appendFileSync(path.join(commitRepo, "tracked.txt"), "top-level change\n");
    const beforeCommit = git(commitRepo, ["rev-parse", "HEAD"]);
    const commitPi = fakePi({ cwd: commitRepo });
    autoCommit(commitPi.api);
    await commitPi.handlers.get("session_shutdown")({}, shutdownCtx(commitRepo));
    assert(git(commitRepo, ["rev-parse", "HEAD"]) !== beforeCommit, "top-level shutdown must commit dirty work");
    assert(git(commitRepo, ["status", "--porcelain"]) === "", "top-level auto-commit must leave the worktree clean");

    // An internal child leaves both the commit history and dirty worktree alone.
    const childRepo = path.join(workspace, "commit-child");
    fs.mkdirSync(childRepo);
    initRepo(childRepo);
    fs.appendFileSync(path.join(childRepo, "tracked.txt"), "child change\n");
    const childBeforeCommit = git(childRepo, ["rev-parse", "HEAD"]);
    const childCommitPi = fakePi({ cwd: childRepo });
    autoCommit(childCommitPi.api);
    process.env.PI_KIT_INTERNAL_CHILD = "1";
    await childCommitPi.handlers.get("session_shutdown")({}, shutdownCtx(childRepo));
    assert(git(childRepo, ["rev-parse", "HEAD"]) === childBeforeCommit, "internal child shutdown must not commit");
    assert(git(childRepo, ["status", "--porcelain"]) !== "", "internal child shutdown must preserve dirty work");
    delete process.env.PI_KIT_INTERNAL_CHILD;

    // The automatic shutdown note is opt-in (it carried no resumable content and littered
    // every directory with HANDOFF.md); off by default, available to a top-level session.
    const handoffTop = path.join(workspace, "handoff-top");
    fs.mkdirSync(handoffTop);
    const handoffPi = fakePi();
    handoff(handoffPi.api);
    await handoffPi.handlers.get("session_shutdown")({}, shutdownCtx(handoffTop));
    assert(!fs.existsSync(path.join(handoffTop, "HANDOFF.md")), "no automatic handoff note unless PI_KIT_HANDOFF_AUTO=1");
    const restoreAuto = setEnv("PI_KIT_HANDOFF_AUTO", "1");
    try {
      await handoffPi.handlers.get("session_shutdown")({}, shutdownCtx(handoffTop));
    } finally {
      restoreAuto();
    }
    assert(fs.readFileSync(path.join(handoffTop, "HANDOFF.md"), "utf8").includes("Session ended."), "opted-in top-level shutdown writes a handoff");

    // Automatic handoff is suppressed for internal children, but /handoff is not.
    const handoffChild = path.join(workspace, "handoff-child");
    fs.mkdirSync(handoffChild);
    const childHandoffPi = fakePi();
    handoff(childHandoffPi.api);
    process.env.PI_KIT_INTERNAL_CHILD = "1";
    process.env.PI_KIT_HANDOFF_AUTO = "1"; // even when opted in, children never write one
    await childHandoffPi.handlers.get("session_shutdown")({}, shutdownCtx(handoffChild));
    delete process.env.PI_KIT_HANDOFF_AUTO;
    assert(!fs.existsSync(path.join(handoffChild, "HANDOFF.md")), "internal child shutdown must not write a handoff");
    await childHandoffPi.commands.get("handoff").handler("operator note", { cwd: handoffChild, ui: { notify() {} } });
    assert(fs.readFileSync(path.join(handoffChild, "HANDOFF.md"), "utf8").includes("operator note"), "/handoff must work for internal children");
    delete process.env.PI_KIT_INTERNAL_CHILD;

    // The firewall's auto-mode judge runs in process (no child, so no env marker to pass);
    // a stubbed verdict is honoured for a headless caller.
    const firewall = await loadExtension("extensions/tool-firewall/index.ts");
    const firewallPi = fakePi();
    let judged = 0;
    firewall(firewallPi.api, { complete: async () => { judged++; return '{"verdict":"allow","reason":"smoke"}'; } });
    process.env.PI_KIT_AUTO_MODE = "1";
    const result = await firewallPi.handlers.get("tool_call")(
      { toolName: "unrecognized_helper", input: {} },
      { cwd: workspace, hasUI: false, ui: {} },
    );
    assert(result === undefined, "judge approval should allow the test call");
    assert(judged === 1, "the in-process judge must be consulted");

    console.log("[smoke:shutdown-hook-gating] OK");
  } finally {
    restoreInternalChild();
    restoreAutoMode();
    restoreAudit();
    restoreAgentDir();
    restoreIsolation();
    rmWorkspace(workspace);
  }
}

await run();
