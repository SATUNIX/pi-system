#!/usr/bin/env node
// Inert Node fixture only: never starts Pi or evaluates task text as code.
//
// Pins the subagent observability/recovery contract:
//   1. Every run writes a log file and returns its path on the result.
//   2. The log contains the child stream, stderr, and a lifecycle end marker.
//   3. Stored message text is bounded while the full stream stays in the log.
//   4. The run registry records start+end, and `subagent_status` lists/tails by id.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { loadModule, fakePi, tmpWorkspace, rmWorkspace, isolateKitEnv } from "../packages/core/eval/harness.mjs";
import { installDelegation } from "../packages/core/eval/delegation.mjs";

// Launches go through delegation-guard (mandatory protections + effort budget); fake children still need it in place.
const __delegation = await installDelegation();
process.on("exit", () => __delegation.cleanup());

const restoreIsolation = isolateKitEnv();
const ws = tmpWorkspace("pi-kit-subagent-observability-");
try {
  const module = await loadModule("vendor/subagent/index.ts");
  const agents = [{ name: "scout", description: "fixture", tools: ["read"], systemPrompt: "", source: "user", filePath: "fixture" }];

  function fakeChild(onSpawn) {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", 0)); return true; };
    return () => { queueMicrotask(() => onSpawn(child)); return child; };
  }

  const big = "A".repeat(300 * 1024);
  const result = await module.runSingleAgent(ws, agents, "scout", "logtest", undefined, undefined, undefined, undefined,
    fakeChild((child) => {
      child.stderr.write("npm warn fixture\n");
      child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: big }], stopReason: "end" } }) + "\n");
      child.emit("close", 0);
    }));

  // 1. log path returned + file exists
  assert.equal(result.exitCode, 0);
  assert.ok(result.logPath, "result must carry a logPath");
  assert.ok(fs.existsSync(result.logPath), "log file must exist");

  // 2. log content: child stream, stderr, lifecycle
  const log = fs.readFileSync(result.logPath, "utf8");
  assert.match(log, /# agent=scout/);
  assert.match(log, /# task=logtest/);
  assert.match(log, /"role":"assistant"/, "raw child JSONL must be in the log");
  assert.match(log, /\[stderr\] npm warn fixture/, "stderr must be in the log");
  assert.match(log, /# end status=end/, "lifecycle end marker must be in the log");

  // 3. bounded in-memory text, full stream still in the log
  const stored = result.messages.at(-1).content[0].text;
  assert.ok(stored.length < big.length, "stored message text must be bounded");
  assert.match(stored, /stored message truncated/);
  assert.ok(log.length >= big.length, "run log must retain the full stream");
  // ...but the full final answer is preserved for chain mode and success output.
  assert.equal(result.finalOutput, big, "finalOutput must hold the complete final answer");

  // 4. registry + subagent_status
  const registry = path.join(ws, ".pi", "subagent", "runs.jsonl");
  assert.ok(fs.existsSync(registry), "run registry must exist");
  const records = fs.readFileSync(registry, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(records.some((r) => r.event === "start"), "registry must record start");
  assert.ok(records.some((r) => r.event === "end" && r.status === "end"), "registry must record end");

  const runId = path.basename(result.logPath).replace(/\.log$/, "");
  const pi = fakePi();
  module.default(pi.api);
  const listed = await pi.tools.get("subagent_status").execute("s", {}, undefined, undefined, { cwd: ws });
  assert.match(listed.content[0].text, /scout/);
  assert.match(listed.content[0].text, new RegExp(runId));
  const tailed = await pi.tools.get("subagent_status").execute("s", { id: runId, tail: 5 }, undefined, undefined, { cwd: ws });
  assert.match(tailed.content[0].text, /# end status=end/);

  // 5. a model-supplied run id cannot traverse out of the state dir
  const traversal = await pi.tools.get("subagent_status").execute("s", { id: "../../etc/passwd" }, undefined, undefined, { cwd: ws });
  assert.equal(traversal.isError, true, "path-traversal id must be rejected");
  assert.match(traversal.content[0].text, /Invalid run id/);

  // 6. a parallel batch where every task fails is surfaced as an error (0/N is a failure)
  const parallel = await pi.tools.get("subagent").execute("p", { tasks: [{ agent: "nonexistent-role-xyz", task: "x" }] }, undefined, undefined, { cwd: ws, hasUI: false, ui: {} });
  assert.equal(parallel.isError, true, "0/N parallel batch must be an error");
  assert.match(parallel.content[0].text, /0\/1 succeeded/);

  // 7. stop control: a live child can be stopped via the subagent_stop tool, and the run
  //    reports stopReason "stopped" rather than a generic abort.
  const runningPromise = module.runSingleAgent(ws, agents, "scout", "long-running", undefined, undefined, undefined, undefined,
    fakeChild(() => { /* never closes on its own; only the stop kills it */ }));
  const runningList = await pi.tools.get("subagent_stop").execute("stop-list", {}, undefined, undefined, { cwd: ws });
  assert.match(runningList.content[0].text, /Running subagents \(1\)/);
  const stopped = await pi.tools.get("subagent_stop").execute("stop-all", { all: true }, undefined, undefined, { cwd: ws });
  assert.match(stopped.content[0].text, /Stopped 1 live/);
  const stoppedResult = await runningPromise;
  assert.equal(stoppedResult.stopReason, "stopped");
  assert.match(module.getResultOutput(stoppedResult), /Stopped by operator/);

  // 8. commands are registered and /subagents reports a check-in
  assert.ok(pi.commands.has("subagents"), "subagents command must be registered");
  assert.ok(pi.commands.has("subagent-stop"), "subagent-stop command must be registered");
  const notices = [];
  await pi.commands.get("subagents").handler("", { cwd: ws, ui: { notify: (m) => notices.push(m) } });
  assert.ok(notices.some((n) => /subagents/.test(n) && /total/.test(n)), "/subagents must report a run summary");

  console.log("[subagent-observability-smoke] run logs, bounded messages, registry, subagent_status, subagent_stop and commands verified");
} finally {
  restoreIsolation();
  rmWorkspace(ws);
}
