#!/usr/bin/env node
// dual-review smoke: a review that times out, blows the output cap, or fails to spawn must
// still report a result instead of silently disappearing. Deterministic and offline — the
// child process is faked with an EventEmitter and the spawner is injected.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadModule, fakePi } from "../packages/core/eval/harness.mjs";

const REVIEWER = "extensions/dual-review/index.ts";
const RESULT_TYPE = "dual-review-result";

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
  await tool.execute("id", { content: "diff --git a/x b/x" }, signal, undefined, { cwd: process.cwd() });
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

  console.log("[test:smoke dual-review] OK");
}

await run();
