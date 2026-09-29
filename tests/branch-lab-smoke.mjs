#!/usr/bin/env node
/**
 * branch-lab lease-store hardening coverage.
 *
 * A crash mid-write previously truncated .pi/branch-leases.json (plain writeFileSync), and
 * readLeases then threw SyntaxError on every lease tool until an operator hand-deleted it.
 * This smoke is hermetic: fresh HOME / PI_CODING_AGENT_DIR / lease path plus a throwaway git
 * repo, so no real checkout, worktree, or branch is touched. It fails on the pre-fix source
 * because the corrupt-file read rejects instead of returning an empty list.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  loadExtension,
  fakePi,
  setEnv,
  tmpWorkspace,
  rmWorkspace,
  isolateKitEnv,
} from "../packages/core/eval/harness.mjs";

function withCwd(cwd, fn) {
  const previous = process.cwd();
  process.chdir(cwd);
  return Promise.resolve(fn()).finally(() => process.chdir(previous));
}

const taskId = `smoke-${process.pid}`;

// Real git is only needed to create the throwaway repo below. The extension's own git
// calls go through the fake on PATH, so this smoke stays hermetic and records argv.
const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

async function main() {
  const restoreEnv = isolateKitEnv();
  const ws = tmpWorkspace("pi-kit-branch-lab-");
  const leaseFile = path.join(ws, ".pi", "branch-leases.json");
  const restores = [
    restoreEnv,
    setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")),
    setEnv("HOME", path.join(ws, "home")),
    setEnv("PI_KIT_BRANCH_LEASES_FILE", leaseFile),
  ];
  try {
    // Throwaway repo: created with the real git before the fake is on PATH.
    execFileSync(realGit, ["init"], { cwd: ws, stdio: "pipe" });
    execFileSync(realGit, ["config", "user.email", "smoke@example.invalid"], { cwd: ws });
    execFileSync(realGit, ["config", "user.name", "Smoke Test"], { cwd: ws });
    fs.writeFileSync(path.join(ws, "README.md"), "smoke\n");
    execFileSync(realGit, ["add", "README.md"], { cwd: ws });
    execFileSync(realGit, ["commit", "-m", "init"], { cwd: ws, stdio: "pipe" });

    // Fake git: records each invocation as "argv<TAB>arg..." and succeeds without
    // touching the repo. This captures the exact argv the extension hands to git.
    const gitLog = path.join(ws, "git-argv.log");
    const binDir = path.join(ws, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const shim = path.join(binDir, "git");
    fs.writeFileSync(
      shim,
      `#!/bin/sh\nprintf 'argv' >> '${gitLog}'\nfor a in "$@"; do printf '\\t%s' "$a" >> '${gitLog}'; done\nprintf '\\n' >> '${gitLog}'\n`,
    );
    fs.chmodSync(shim, 0o755);
    restores.push(setEnv("PATH", `${binDir}${path.delimiter}${process.env.PATH ?? ""}`));
    const gitInvocations = () =>
      fs.existsSync(gitLog) ? fs.readFileSync(gitLog, "utf8").trim().split("\n").filter(Boolean) : [];

    await withCwd(ws, async () => {
      const register = await loadExtension("extensions/branch-lab/index.ts");
      const pi = fakePi();
      register(pi.api);
      await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
      const ctx = { cwd: ws, hasUI: false, ui: { notify() {} } };
      const run = (name, params = {}) =>
        pi.tools.get(name).execute(name, params, undefined, undefined, ctx);

      // (b) A truncated/corrupt lease file must read as an empty list, not throw.
      fs.mkdirSync(path.dirname(leaseFile), { recursive: true });
      fs.writeFileSync(leaseFile, "{ not json");
      const corrupt = await run("branch_list");
      assert.match(
        corrupt.content[0].text,
        /no active leases/,
        "branch_list must treat a corrupt lease file as empty instead of throwing",
      );

      // (b2) F5: a lease file that is valid JSON but holds a non-object element
      // (`[null]`) or a partial lease missing worktreePath must drop those entries
      // instead of making branch_list dereference null/undefined and throw.
      fs.writeFileSync(leaseFile, "[null]");
      const nullLease = await run("branch_list");
      assert.match(
        nullLease.content[0].text,
        /no active leases/,
        "branch_list must drop a null lease element instead of dereferencing it",
      );

      fs.writeFileSync(leaseFile, JSON.stringify([{ taskId: "t", branch: "pi/t" }]));
      const partialLease = await run("branch_list");
      assert.match(
        partialLease.content[0].text,
        /no active leases/,
        "branch_list must drop a lease element missing worktreePath",
      );

      // (c) A normal write+read round-trip works, keeps the exact JSON shape, and leaves
      // no temp sibling behind.
      fs.rmSync(leaseFile, { force: true });
      const created = await run("branch_create", { taskId });
      assert.match(created.content[0].text, new RegExp(`created pi/${taskId}`));

      const onDisk = fs.readFileSync(leaseFile, "utf8");
      assert.equal(
        onDisk,
        `${JSON.stringify(JSON.parse(onDisk), null, 2)}\n`,
        "writeLeases must persist exact pretty JSON with a trailing newline",
      );
      assert.equal(JSON.parse(onDisk).length, 1, "the round-trip lease must be persisted");

      const listed = await run("branch_list");
      assert.match(listed.content[0].text, new RegExp(taskId), "branch_list must read back the written lease");

      const piDir = path.dirname(leaseFile);
      assert.deepEqual(
        fs.readdirSync(piDir).filter((f) => f.includes(".tmp-")),
        [],
        "no leftover .tmp-* file after a successful write",
      );

      // Cleanup: discard removes the worktree + branch and writes the store back to [].
      const discarded = await run("branch_discard", { taskId });
      assert.match(discarded.content[0].text, new RegExp(`discarded pi/${taskId}`));
      assert.deepEqual(JSON.parse(fs.readFileSync(leaseFile, "utf8")), []);
      assert.deepEqual(
        fs.readdirSync(piDir).filter((f) => f.includes(".tmp-")),
        [],
        "no leftover .tmp-* file after a second write",
      );

      // (d) WU-2: baseBranch accepts a real git ref containing '/'. Pre-change this
      // failed with "Invalid taskId" because baseBranch went through sanitizeTaskId.
      const baseTask = `smoke-base-${process.pid}`;
      const beforeBase = gitInvocations().length;
      const withBase = await run("branch_create", { taskId: baseTask, baseBranch: "feature/base" });
      assert.match(withBase.content[0].text, new RegExp(`created pi/${baseTask}`));

      const baseLease = JSON.parse(fs.readFileSync(leaseFile, "utf8")).find((l) => l.taskId === baseTask);
      assert.ok(baseLease, "the base-ref lease must be persisted");
      assert.equal(baseLease.baseBranch, "feature/base", "the lease must record the real base ref");

      const afterBase = gitInvocations();
      assert.equal(afterBase.length, beforeBase + 1, "branch_create must make exactly one git call");
      const addArgv = afterBase.at(-1).split("\t");
      assert.equal(addArgv[1], "worktree");
      assert.equal(addArgv[2], "add");
      assert.equal(addArgv.at(-1), "feature/base", "git argv must pass feature/base as the start point");
      assert.ok(addArgv.includes(`pi/${baseTask}`), "git argv must create the pi/<taskId> branch");

      // (e) Unsafe baseBranch values are rejected before git is invoked.
      const rejectTask = `smoke-reject-${process.pid}`;
      const unsafeRefs = ["-x", "a b", "a..b", "feature//x", "foo/", "foo.", ".hidden/x", "x~y", "a".repeat(201)];
      for (const unsafe of unsafeRefs) {
        const beforeReject = gitInvocations().length;
        await assert.rejects(
          () => run("branch_create", { taskId: rejectTask, baseBranch: unsafe }),
          /Invalid baseBranch/,
          `the unsafe baseBranch ${JSON.stringify(unsafe)} must be rejected`,
        );
        assert.equal(
          gitInvocations().length,
          beforeReject,
          `the unsafe baseBranch ${JSON.stringify(unsafe)} must not invoke git`,
        );
      }
      assert.ok(
        !JSON.parse(fs.readFileSync(leaseFile, "utf8")).some((l) => l.taskId === rejectTask),
        "a rejected baseBranch must not write a lease",
      );

      // (f) A raw commit SHA is also a valid base ref.
      const sha = "0123456789abcdef0123456789abcdef01234567";
      const shaTask = `smoke-sha-${process.pid}`;
      await run("branch_create", { taskId: shaTask, baseBranch: sha });
      const shaLease = JSON.parse(fs.readFileSync(leaseFile, "utf8")).find((l) => l.taskId === shaTask);
      assert.equal(shaLease.baseBranch, sha, "a 40-char SHA must be accepted as a base ref");

      console.log("[branch-lab-smoke] OK");
    });
  } finally {
    for (const restore of restores.reverse()) restore();
    rmWorkspace(ws);
  }
}

await main();
