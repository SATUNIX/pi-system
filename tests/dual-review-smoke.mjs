#!/usr/bin/env node
// dual-review smoke: a review that times out, blows the output cap, or fails to spawn must
// still report a result instead of silently disappearing. Deterministic and offline — the
// child process is faked with an EventEmitter and the spawner is injected.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadModule, fakePi } from "../packages/core/eval/harness.mjs";

const REVIEWER = "extensions/dual-review/index.ts";
const RESULT_TYPE = "dual-review-result";

// The reviewer is a child agent: every launch goes through delegation-guard (the parent's protections, the effort
// ledger). The tests stand in for the guard's registry and record what was asked of it.
const DELEGATION = Symbol.for("pi-kit.delegation");
const requests = [];
const attached = [];
const settled = [];
function installGuard({ refuse } = {}) {
  requests.length = attached.length = settled.length = 0;
  globalThis[DELEGATION] = {
    prepareChild(request) {
      requests.push(request);
      if (refuse) return { ok: false, code: "budget", reason: refuse };
      return { ok: true, args: ["--no-extensions", "-e", "/kit/tool-firewall/index.ts", "-e", "/kit/secret-guard/index.ts"], env: { PI_KIT_CHILD_REQUIRE: "tool-firewall,secret-guard,protected-paths,delegation-guard,effort" }, slot: { attach: (pid) => attached.push(pid), settle: (outcome) => settled.push(outcome) } };
    },
  };
}
installGuard();

// A fake child: EventEmitter plus stream EventEmitters and a kill spy. `close` is emitted by
// the test, not by kill, so we control when the result is reported.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    return true;
  };
  return child;
}

const resultMessages = (pi) => pi.steers.filter((entry) => entry.message?.customType === RESULT_TYPE);

async function launch(spawnChild, signal) {
  const mod = await loadModule(REVIEWER);
  const pi = fakePi();
  mod.default(pi.api, spawnChild);
  const tool = pi.tools.get("dual_review");
  assert.ok(tool, "dual_review tool must be registered");
  const result = await tool.execute("id", { content: "diff --git a/x b/x" }, signal, undefined, { cwd: process.cwd() });
  pi.toolResult = result?.content?.[0]?.text ?? "";
  return pi;
}

// Load the extension with an injected execFile and hand back the /review command plus a record
// of ui.notify calls, so git-error and empty-diff paths can be exercised directly.
async function loadForReview(spawnChild, runExecFile) {
  const mod = await loadModule(REVIEWER);
  const pi = fakePi();
  mod.default(pi.api, spawnChild, runExecFile);
  const cmd = pi.commands.get("review");
  assert.ok(cmd, "/review command must be registered");
  const notes = [];
  const ctx = { cwd: "/tmp/whatever", ui: { notify: (msg, level) => notes.push({ msg, level }) } };
  return { pi, cmd, notes, ctx };
}

async function run() {
  // (a) Over the 100000-char cap: the reviewer is killed and the truncated output (with its
  // marker) is reported exactly once. Fails on the pre-fix source, which drops it silently.
  {
    const child = fakeChild();
    const pi = await launch(() => child);
    child.stdout.emit("data", Buffer.from("x".repeat(100_001)));
    assert.deepEqual(child.kills, ["SIGTERM"], "over-cap output must SIGTERM the reviewer");
    child.emit("close", 0);
    const messages = resultMessages(pi);
    assert.equal(messages.length, 1, "over-cap review must be reported exactly once");
    assert.match(messages[0].message.content, /\[review output limit reached\]/);
  }

  // (b) Spawn failure: reported exactly once, and an error-then-close pair cannot double-send.
  {
    const child = fakeChild();
    const pi = await launch(() => child);
    child.emit("error", new Error("spawn ENOENT"));
    child.emit("close", -1);
    const messages = resultMessages(pi);
    assert.equal(messages.length, 1, "a spawn error must be reported exactly once");
    assert.match(messages[0].message.content, /failed to start/);
    assert.match(messages[0].message.content, /ENOENT/);
  }

  // (c) Genuine user abort: no result is sent.
  {
    const child = fakeChild();
    const controller = new AbortController();
    const pi = await launch(() => child, controller.signal);
    controller.abort();
    child.emit("close", -1);
    assert.equal(resultMessages(pi).length, 0, "a user-cancelled review must send nothing");
  }

  // (d) Git failure must surface as a git-diff error, never as "no diff to review."
  {
    const { cmd, notes, ctx } = await loadForReview(
      fakeChild,
      (_cmd, _args, _opts, cb) =>
        cb(
          new Error("fatal: not a git repository (or any of the parent directories): .git"),
          "",
          "fatal: not a git repository (or any of the parent directories): .git",
        ),
    );
    await cmd.handler("", ctx);
    assert.ok(
      notes.some((n) => n.msg.includes("git diff failed") && n.msg.includes("not a git repository")),
      "a git failure must be reported as a git diff failure",
    );
    assert.ok(
      !notes.some((n) => n.msg.includes("no diff to review.")),
      "a git failure must not be reported as no diff to review",
    );
  }

  // (e) A genuinely clean tree still reports "no diff to review." and launches no reviewer.
  {
    const child = fakeChild();
    let spawned = 0;
    const { pi, cmd, notes, ctx } = await loadForReview(
      () => { spawned++; return child; },
      (_cmd, _args, _opts, cb) => cb(null, "", ""),
    );
    await cmd.handler("", ctx);
    assert.ok(
      notes.some((n) => n.msg.includes("no diff to review.")),
      "a clean tree must be reported as no diff to review",
    );
    assert.equal(spawned, 0, "a clean tree must not spawn a reviewer");
    assert.equal(resultMessages(pi).length, 0, "a clean tree must send no review result");
  }

  // (f) A non-empty diff launches the reviewer and its result is delivered on close.
  {
    const child = fakeChild();
    let spawned = 0;
    const { pi, cmd, notes, ctx } = await loadForReview(
      () => { spawned++; return child; },
      (_cmd, _args, _opts, cb) => cb(null, "diff --git a/x b/x", ""),
    );
    await cmd.handler("", ctx);
    assert.equal(spawned, 1, "a non-empty diff must spawn a reviewer");
    assert.ok(notes.some((n) => n.msg.includes("reviewer launched")), "launch must be announced");
    child.emit("close", 0);
    const messages = resultMessages(pi);
    assert.equal(messages.length, 1, "a launched review must report a result on close");
  }

  // (g) The launch contract: the guard is asked for a read-only reviewer (discretionary for the model's tool, user for /review), the
  // child is started with the guard's arguments and environment plus the read-only tools, and its slot is attached and settled.
  {
    installGuard();
    let spawnedWith = null;
    const child = fakeChild();
    child.pid = 4321;
    const pi = await launch((cmd, argv, options) => { spawnedWith = { argv, options }; return child; });
    assert.equal(requests.length, 1);
    assert.deepEqual([requests[0].kind, requests[0].role, requests[0].readOnly], ["discretionary", "reviewer", true], "the model-callable tool is a discretionary, read-only reviewer");
    for (const arg of ["--no-extensions", "/kit/tool-firewall/index.ts", "/kit/secret-guard/index.ts", "read,grep,find,ls", "--print"]) assert.ok(spawnedWith.argv.includes(arg), `the child is started with ${arg}`);
    assert.equal(spawnedWith.argv.filter((a) => a === "--no-extensions").length, 1, "once, from the guard");
    assert.equal(spawnedWith.options.env.PI_KIT_CHILD_REQUIRE, "tool-firewall,secret-guard,protected-paths,delegation-guard,effort", "the child is told what it must have loaded");
    assert.equal(spawnedWith.options.env.PI_KIT_INTERNAL_CHILD, "1");
    assert.equal(spawnedWith.options.shell, false);
    assert.deepEqual(attached, [4321], "the ledger slot is attached to the process");
    assert.deepEqual(settled, [], "and is open while the reviewer runs");
    child.emit("error", new Error("boom"));
    child.emit("close", 1);
    assert.deepEqual(settled, ["closed"], "settled exactly once, whether the child errors, closes or both");
    assert.equal(resultMessages(pi).length, 1);
    const cmdSetup = await loadForReview(() => fakeChild(), (_c, _a, _o, cb) => cb(null, "diff --git a/x b/x", ""));
    await cmdSetup.cmd.handler("", cmdSetup.ctx);
    assert.equal(requests.at(-1).kind, "user", "/review is the operator's own request");
  }

  // (h) No guard, or a guard that refuses (effort budget, missing protections): nothing is started, and the reason is reported.
  {
    delete globalThis[DELEGATION];
    let spawned = 0;
    const noGuard = await launch(() => { spawned++; return fakeChild(); });
    assert.equal(spawned, 0, "without delegation-guard the reviewer cannot get its protections, so it is not started");
    assert.match(noGuard.toolResult, /Review not started: the delegation-guard extension is not loaded/);
    const viaCommand = await loadForReview(() => { spawned++; return fakeChild(); }, (_c, _a, _o, cb) => cb(null, "diff --git a/x b/x", ""));
    await viaCommand.cmd.handler("", viaCommand.ctx);
    assert.equal(spawned, 0);
    assert.ok(viaCommand.notes.some((n) => n.level === "error" && /reviewer not started: the delegation-guard extension is not loaded/.test(n.msg)));
    assert.ok(!viaCommand.notes.some((n) => /reviewer launched/.test(n.msg)), "a refused launch is never announced as launched");
    installGuard({ refuse: "delegation is off at effort E1 (minimal)" });
    const refused = await launch(() => { spawned++; return fakeChild(); });
    assert.equal(spawned, 0, "a refusal from the guard starts nothing");
    assert.match(refused.toolResult, /Review not started: delegation is off at effort E1/);
    assert.equal(resultMessages(refused).length, 0);
    installGuard();
  }

  console.log("[test:smoke dual-review] OK");
}

await run();
