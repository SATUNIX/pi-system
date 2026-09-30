#!/usr/bin/env node
// Inert Node fixture only: never starts Pi or evaluates task text as code.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { loadModule, fakePi, tmpWorkspace, rmWorkspace, setEnv } from "../packages/core/eval/harness.mjs";
import { installDelegation } from "../packages/core/eval/delegation.mjs";

// Launches go through delegation-guard (mandatory protections + effort budget); fake children still need it in place.
const __delegation = await installDelegation();
process.on("exit", () => __delegation.cleanup());

const ws = tmpWorkspace("pi-kit-subagent-progress-");
try {
  const module = await loadModule("vendor/subagent/index.ts");
  const fixture = path.join(ws, "inert-child.mjs");
  // The inert child echoes its argv and the prompt it read from stdin (print mode merges piped
  // stdin into the prompt; the task travels there so it is never bounded by MAX_ARG_STRLEN).
  fs.writeFileSync(fixture, `let stdin = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => { stdin += d; }); process.stdin.on("end", () => { for (const text of ["working", JSON.stringify({ argv: process.argv.slice(2), stdin })]) console.log(JSON.stringify({type:"message_end",message:{role:"assistant",content:[{type:"text",text}],stopReason:"end"}})); });`);
  const agents = [{ name: "scout", description: "fixture", tools: ["read"], systemPrompt: "", source: "user", filePath: "fixture" }];
  const task = 'literal "quotes" & | %NAME% $(inert) `data`\nnext line';
  const updates = [];
  let launch;
  const result = await module.runSingleAgent(ws, agents, "scout", task, undefined, undefined, undefined, text => updates.push(text), (exe, args, options) => {
    launch = { exe, args, options };
    return spawn(exe, [fixture, ...args.slice(1)], options);
  });
  assert.equal(result.exitCode, 0);
  assert.equal(launch.exe, process.execPath);
  assert.equal(launch.options.shell, false);
  assert.match(launch.args[0], /cli\.js$/);
  const echoed = JSON.parse(result.messages.at(-1).content[0].text);
  assert.equal(echoed.stdin, `Task: ${task}`, "the task reaches the child verbatim over stdin");
  assert.ok(!echoed.argv.some((a) => a.includes("literal")), "the task is never passed as an argv string");
  assert.ok(echoed.argv.includes("--no-extensions"), "children run with extension discovery disabled");
  assert.equal(updates.length, 2);
  // Kill-on-cancel is the default; pin it explicitly so these assertions never depend on the env.
  const restoreDetach = setEnv("PI_KIT_SUBAGENT_DETACH_SIGNAL", "0");
  try {
    const abort = new AbortController(); abort.abort();
    const pre = await module.runSingleAgent(ws, agents, "scout", "never launch", undefined, undefined, abort.signal, undefined, () => { throw new Error("must not spawn"); });
    assert.equal(pre.stopReason, "aborted");
    const during = new AbortController();
    const kills = [];
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = false;
    child.kill = signal => { kills.push(signal); child.killed = true; if (signal === "SIGKILL") queueMicrotask(() => child.emit("close", null)); return true; };
    const running = module.runSingleAgent(ws, agents, "scout", "cancel", undefined, undefined, during.signal, undefined, () => { queueMicrotask(() => during.abort()); return child; });
    const keepalive = setInterval(() => {}, 1000);
    try { assert.equal((await running).stopReason, "aborted"); } finally { clearInterval(keepalive); }
    assert.deepEqual(kills, ["SIGTERM", "SIGKILL"]);
  } finally { restoreDetach(); }
  // Detach-signal path is opt-in (PI_KIT_SUBAGENT_DETACH_SIGNAL=1); the runner must remove its
  // abort listener when the child finishes normally too, not only when abort fires (B-091).
  // A counting signal makes the leak, which an anonymous {once:true} listener hides, visible.
  const restoreDetachOn = setEnv("PI_KIT_SUBAGENT_DETACH_SIGNAL", "1");
  try {
    let added = 0;
    let removed = 0;
    const detachSignal = {
      aborted: false,
      addEventListener: type => { if (type === "abort") added++; },
      removeEventListener: type => { if (type === "abort") removed++; },
    };
    const result = await module.runSingleAgent(ws, agents, "scout", "detach fixture", undefined, undefined, detachSignal, undefined, () => {
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new PassThrough();
      child.killed = false;
      child.pid = 4242;
      child.kill = () => true;
      setTimeout(() => child.emit("close", 0), 5);
      return child;
    });
    assert.equal(result.exitCode, 0, "detach run completes normally");
    assert.equal(added, 1, "runner subscribes to the abort signal exactly once");
    assert.equal(removed, added, `abort listener leaked: added=${added} removed=${removed}`);
  } finally { restoreDetachOn(); }
  fs.mkdirSync(path.join(ws, ".pi", "agents"), { recursive: true });
  fs.writeFileSync(path.join(ws, ".pi", "agents", "scout.md"), "---\nname: scout\ndescription: fixture\ntools: read\n---\nscout\n");
  const pi = fakePi(); module.default(pi.api);
  for (const hasUI of [false, true]) {
    let prompted = 0;
    const blocked = await pi.tools.get("subagent").execute("trust", { agent: "scout", task: "fixture", agentScope: "project", confirmProjectAgents: false }, undefined, undefined, { cwd: ws, hasUI, ui: { confirm: async () => { prompted++; return false; } } });
    assert.match(blocked.content[0].text, /Blocked|Canceled/);
    assert.equal(prompted, hasUI ? 1 : 0);
  }
  console.log("[subagent-progress-smoke] argv fidelity, streaming, pre-abort, escalation and trust checks passed");
} finally { rmWorkspace(ws); }
