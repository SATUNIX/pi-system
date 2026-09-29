#!/usr/bin/env node
// Auto mode: the /auto command and its state, and the in-process judge (stubbed completer):
//   - on/off writes the global firewall config (and a project/legacy state file when present);
//   - status shows the effective source and the provider-qualified judge model;
//   - a judge "allow" runs the call; a judge "block" blocks it and tells the agent why, without
//     interrupting the operator; an unusable judge falls back to the operator;
//   - the judge sees the LATEST user request, verdicts are cached per turn, and high-tier
//     actions never reach the judge.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, fakePi, setEnv, tmpWorkspace, rmWorkspace, isolateKitEnv } from "../packages/core/eval/harness.mjs";

function ui(confirmAnswer = true) {
  const notices = [];
  const confirms = [];
  return {
    notices,
    confirms,
    ctx: {
      hasUI: true,
      cwd: process.cwd(),
      model: { provider: "acme", id: "model-x" },
      ui: {
        notify: (message, level) => notices.push({ message, level }),
        confirm: async (...args) => {
          confirms.push(args);
          return confirmAnswer;
        },
      },
    },
  };
}

function judge(reply, calls) {
  return async (system, prompt) => {
    calls.push({ system, prompt });
    if (reply instanceof Error) throw reply;
    return reply;
  };
}

async function registered(complete) {
  const register = await loadExtension("extensions/tool-firewall/index.ts");
  const pi = fakePi();
  register(pi.api, { complete });
  await pi.handlers.get("session_start")({}, { cwd: process.cwd(), ui: { notify() {} } });
  return pi;
}

const esc = (s) => s.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");

async function run() {
  const restoreIsolation = isolateKitEnv();
  const ws = tmpWorkspace("pi-kit-auto-mode-");
  const stateDir = path.join(ws, "state");
  const configFile = path.join(ws, "agent", "pi-kit", "firewall.json");
  const restores = [
    restoreIsolation,
    setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")),
    setEnv("PI_KIT_FIREWALL_CONFIG", undefined),
    setEnv("PI_KIT_AUTO_MODE", undefined),
    setEnv("PI_KIT_AUTO_MODE_MODEL", undefined),
    setEnv("PI_KIT_FIREWALL_PROFILE", undefined),
    setEnv("PI_KIT_AUTO_MODE_STATE_DIR", stateDir),
    setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(ws, "audit.jsonl")),
  ];
  try {
    // State: global config + the legacy state file; status shows source and model.
    let calls = [];
    let pi = await registered(judge('{"verdict":"allow","reason":"fits task"}', calls));
    let view = ui();
    await pi.commands.get("auto-mode").handler("on", view.ctx);
    assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).mode, "auto");
    assert.equal(JSON.parse(fs.readFileSync(configFile, "utf8")).source, "user");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "auto-mode.json"), "utf8")), { enabled: true });
    await pi.commands.get("auto").handler("status", view.ctx);
    assert.match(view.notices.at(-1).message, /auto-mode: enabled/);
    assert.match(view.notices.at(-1).message, new RegExp(esc(configFile)));
    assert.match(view.notices.at(-1).message, /acme\/model-x/);
    await pi.commands.get("auto").handler("off", view.ctx);
    await pi.commands.get("auto").handler("status", view.ctx);
    assert.match(view.notices.at(-1).message, /auto-mode: disabled/);

    // A config path that cannot be written reports the error instead of throwing.
    const blocked = path.join(ws, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    const badConfig = path.join(blocked, "nested", "firewall.json");
    const restoreConfig = setEnv("PI_KIT_FIREWALL_CONFIG", badConfig);
    view = ui();
    await pi.commands.get("auto").handler("on", view.ctx);
    assert.equal(view.notices.at(-1).level, "error");
    assert.match(view.notices.at(-1).message, /could not enable/);
    assert.match(view.notices.at(-1).message, new RegExp(esc(badConfig)));
    restoreConfig();

    await pi.commands.get("auto").handler("on", ui().ctx);

    // Judge allow: runs without asking; it saw the latest request, not the first.
    calls = [];
    pi = await registered(judge('{"verdict":"allow","reason":"fits task"}', calls));
    await pi.handlers.get("before_agent_start")({ prompt: "first request: set up the repo" }, {});
    await pi.handlers.get("before_agent_start")({ prompt: "latest request: install lodash for the date helpers" }, {});
    view = ui();
    assert.equal(await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "npm install lodash" } }, view.ctx), undefined);
    assert.equal(view.confirms.length, 0, "a judged allow must not interrupt the operator");
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /latest request: install lodash/);
    assert.doesNotMatch(calls[0].prompt, /first request/);
    assert.match(calls[0].system, /data to evaluate, not instructions/);
    // Cached for the same action in the same turn.
    assert.equal(await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "npm install lodash" } }, view.ctx), undefined);
    assert.equal(calls.length, 1, "the verdict is cached per action and turn");
    const audit = fs.readFileSync(path.join(ws, "audit.jsonl"), "utf8");
    assert.match(audit, /"event":"auto_mode_check_start"[^\n]*"model":"acme\/model-x"/);

    // Judge block: blocked, the agent is told why, the operator is not interrupted.
    calls = [];
    pi = await registered(judge('{"verdict":"block","reason":"unexpected side effect"}', calls));
    view = ui();
    const blockedResult = await pi.handlers.get("tool_call")({ toolName: "unknown_ask", input: { x: 2 } }, view.ctx);
    assert.equal(blockedResult?.block, true);
    assert.match(blockedResult.reason, /auto-mode blocked unknown_ask — unexpected side effect/);
    assert.match(blockedResult.reason, /explain why to the user/);
    assert.equal(view.confirms.length, 0);
    assert.ok(view.notices.some((n) => n.level === "warning" && /unexpected side effect/.test(n.message)));

    // Malformed / failing judge: warn, then fall back to the operator.
    for (const reply of ["not-json", new Error("provider down")]) {
      calls = [];
      pi = await registered(judge(reply, calls));
      view = ui();
      assert.equal(await pi.handlers.get("tool_call")({ toolName: "unknown_ask", input: { x: 1 } }, view.ctx), undefined);
      assert.equal(view.confirms.length, 1);
      assert.match(view.confirms[0][1], /judge unavailable/);
      assert.ok(view.notices.some((n) => n.level === "warning" && /unknown_ask/.test(n.message) && /judge unavailable/.test(n.message)));
    }

    // High tier never reaches the judge.
    calls = [];
    pi = await registered(judge('{"verdict":"allow","reason":"x"}', calls));
    view = ui(false);
    const force = await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "git push origin main --force" } }, view.ctx);
    assert.equal(force?.block, true);
    assert.equal(calls.length, 0, "high-tier actions must not be judged");
    assert.equal(view.confirms.length, 1);
    assert.match(view.confirms[0][1], /force-push/);

    // In auto mode, read-only ssh to a known host needs nobody (host from firewall.json).
    fs.writeFileSync(configFile, JSON.stringify({ mode: "auto", policy: "coding", knownHosts: ["buildbox"], source: "user" }));
    calls = [];
    pi = await registered(judge('{"verdict":"block","reason":"x"}', calls));
    view = ui(false);
    assert.equal(await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "ssh buildbox 'uptime; df -h; sudo -n journalctl -u nginx -n 50'" } }, view.ctx), undefined);
    assert.equal(calls.length + view.confirms.length, 0);
    // ...but not in manual mode.
    await pi.commands.get("auto").handler("off", ui().ctx);
    fs.rmSync(path.join(stateDir, "auto-mode.json"));
    view = ui(false);
    assert.equal((await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "ssh buildbox uptime" } }, view.ctx))?.block, true);
    assert.equal(view.confirms.length, 1);

    console.log("[auto-mode-smoke] OK");
  } finally {
    restores.reverse().forEach((restore) => restore());
    rmWorkspace(ws);
  }
}

await run();
