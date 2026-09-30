#!/usr/bin/env node
// A denied, pending, cancelled or timed-out action has produced NO side effect, on every shell path.
//
// Drives pi's REAL agent loop, extension loader and ExtensionRunner with the real protected-paths and
// tool-firewall extensions and a bash tool that REALLY runs the command (in a temporary directory, with
// `sudo` and `ssh` replaced by harmless shims that run the rest locally). The action of every case is
// "create a marker file"; a case passes only if the marker is absent. Each wrapper form is run through
//   deny        the operator says No
//   pending     the approval card is open and never answered; the turn is aborted while it is open
//   headless    no UI, nobody answers the human console before its timeout
//   judge       auto mode, the judge blocks it / the judge is still thinking when the turn is aborted
// and, as the control that proves the harness really executes, through "Allow once" (marker present).
// Then: a session approval survives a /reload and is not widened, a revoked one asks again.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadModule, setEnv, isolateKitEnv, rmWorkspace, ROOT } from "../packages/core/eval/harness.mjs";

const PCA = path.join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");
const AGENT_CORE = path.join(PCA, "node_modules", "@earendil-works", "pi-agent-core", "dist", "agent-loop.js");
const imp = (p) => import(pathToFileURL(p).href);
const { createExtensionRuntime, ExtensionRunner } = await imp(path.join(PCA, "dist", "core", "extensions", "index.js"));
const { loadExtensions, loadExtensionFromFactory } = await imp(path.join(PCA, "dist", "core", "extensions", "loader.js"));
const { runAgentLoop } = await imp(AGENT_CORE);
const firewall = await loadModule("extensions/tool-firewall/index.ts");
const classify = await loadModule("extensions/tool-firewall/classify.ts");
const EXT = (rel) => path.join(ROOT, "packages", "extensions", rel, "index.ts");

// The marker directory must not be under a temp root (the firewall treats /tmp as scratch space and
// would allow the write): the repo's own cache directory, /dev/shm or the real home are tried in order.
function pickBase() {
  const tmpRoots = ["/tmp", "/var/tmp", fs.realpathSync(os.tmpdir()), os.tmpdir()];
  for (const parent of [path.join(ROOT, "node_modules", ".cache"), "/dev/shm", os.homedir()]) {
    try {
      fs.mkdirSync(parent, { recursive: true });
      const dir = fs.mkdtempSync(path.join(parent, "pi-kit-noeffect-"));
      if (tmpRoots.some((t) => dir === t || dir.startsWith(`${t}/`))) {
        fs.rmSync(dir, { recursive: true, force: true });
        continue;
      }
      return dir;
    } catch {
      /* try the next place */
    }
  }
  throw new Error("no writable directory outside the temp roots for the side-effect markers");
}
const base = pickBase();
const ws = path.join(base, "ws");
const home = path.join(base, "home");
const bin = path.join(base, "bin");
const agentDir = path.join(base, "agent");
const consoleDir = path.join(base, "console");
const configFile = path.join(agentDir, "pi-kit", "firewall.json");
for (const d of [path.join(ws, ".git"), home, bin, agentDir]) fs.mkdirSync(d, { recursive: true });
// Shims: `sudo` runs its command (a real sudo would need a password) and `ssh` runs the remote command locally.
fs.writeFileSync(path.join(bin, "sudo"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -n|-E|-H|-S) shift;; *) break;; esac; done\nexec "$@"\n', { mode: 0o755 });
fs.writeFileSync(path.join(bin, "ssh"), '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -*) shift;; *) break;; esac; done\nshift\nexec /bin/sh -c "$*"\n', { mode: 0o755 });

const restores = [
  isolateKitEnv(),
  setEnv("HOME", home),
  setEnv("PI_CODING_AGENT_DIR", agentDir),
  setEnv("PI_KIT_AUTO_MODE_STATE_DIR", path.join(base, "legacy")),
  setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(base, "audit.jsonl")),
  setEnv("PI_KIT_HUMAN_CONSOLE_DIR", consoleDir),
  setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "250"),
  setEnv("PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS", "20000"),
  setEnv("PI_KIT_FIREWALL_JUDGE_TIMEOUT_MS", "20000"),
];
const keepAlive = setInterval(() => {}, 1000);
let checks = 0;
const ok = (label) => {
  checks++;
  console.log(`  OK: ${label}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, label, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${label}`);
    await sleep(10);
  }
}
const config = (mode) => {
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, JSON.stringify({ mode, policy: "coding", learn: false, knownHosts: [], source: "user" }));
};
const exists = (marker) => fs.existsSync(path.join(home, marker));

let sessionNo = 0;
// One pi session: real loader + runner + agent loop, with a bash tool that really runs the command.
async function session({ ui, judge, id = `noeffect-${++sessionNo}` } = {}) {
  const runtime = createExtensionRuntime();
  runtime.getThinkingLevel = () => "off";
  const extensions = [];
  const loaded = await loadExtensions([EXT("third_party/protected-paths")], ws, undefined, runtime);
  assert.deepEqual(loaded.errors, []);
  extensions.push(...loaded.extensions);
  extensions.push(await loadExtensionFromFactory((api) => firewall.default(api, { complete: judge ?? null }), ws, undefined, runtime, "<tool-firewall>"));
  const signalRef = { current: undefined };
  const runner = new ExtensionRunner(extensions, runtime, ws, { getSessionId: () => id, getBranch: () => [], getEntries: () => [] }, undefined);
  Object.assign(runner, { getModel: () => undefined, getScopedModels: () => [], isIdleFn: () => false, getSignalFn: () => signalRef.current, hasPendingMessagesFn: () => false, getContextUsageFn: () => undefined, getSystemPromptFn: () => "" });
  if (ui) runner.setUIContext(ui, "interactive");
  await runner.emit({ type: "session_start", reason: "startup" });

  const ran = [];
  const tools = [
    {
      name: "bash",
      label: "bash",
      description: "run a shell command",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      execute: async (toolCallId, args) => {
        ran.push(args.command);
        const r = spawnSync("/bin/bash", ["-c", args.command], { cwd: ws, env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, encoding: "utf8", timeout: 15000 });
        return { content: [{ type: "text", text: `exit ${r.status}\n${r.stdout}${r.stderr}` }], details: {} };
      },
    },
  ];
  async function run(command, { signal } = {}) {
    signalRef.current = signal;
    const events = [];
    let turn = 0;
    const assistant = (content, stopReason) => ({ role: "assistant", content, stopReason, api: "test", provider: "test", model: "test", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: Date.now() });
    const streamFn = async () => {
      const msg = turn++ === 0 ? assistant([{ type: "toolCall", id: "c0", name: "bash", arguments: { command } }], "toolUse") : assistant([{ type: "text", text: "done" }], "stop");
      return { async *[Symbol.asyncIterator]() { yield { type: "done", reason: msg.stopReason, message: msg }; }, result: async () => msg };
    };
    const cfg = {
      model: { provider: "test", id: "test", api: "test" },
      convertToLlm: (m) => m,
      toolExecution: "sequential",
      beforeToolCall: async ({ toolCall, args }) => (runner.hasHandlers("tool_call") ? runner.emitToolCall({ type: "tool_call", toolName: toolCall.name, toolCallId: toolCall.id, input: args }) : undefined),
    };
    const emit = async (ev) => {
      events.push({ type: ev.type, toolCallId: ev.toolCallId, isError: ev.isError, result: ev.result });
      if (ev.type.startsWith("tool_execution")) await runner.emit(ev);
    };
    const done = runAgentLoop([{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }], { systemPrompt: "", messages: [], tools }, cfg, emit, signal, streamFn);
    const text = () => events.find((e) => e.type === "tool_execution_end")?.result?.content?.[0]?.text ?? "";
    return { done, events, text };
  }
  return { run, ran, id };
}
const cardUI = (select) => ({ notify() {}, setStatus() {}, setWidget() {}, select, confirm: async () => false, input: async () => "" });
const limited = (p, ms, label) => Promise.race([p, sleep(ms).then(() => { throw new Error(`${label} hung`); })]);

// Every form below creates exactly one marker (~/<name>) if it runs.
const FORMS = [
  ["plain command", (m) => `touch ~/${m}`],
  ["sudo", (m) => `sudo touch ~/${m}`],
  ["env", (m) => `env X=1 touch ~/${m}`],
  ["timeout", (m) => `timeout 5 touch ~/${m}`],
  ["xargs", (m) => `echo ${m} | xargs -I{} touch ~/{}`],
  ["xargs, paths on stdin", (m) => `echo ~/${m} | xargs touch`],
  ["find -exec", (m) => `find . -maxdepth 0 -exec touch ~/${m} \\;`],
  ["bash -c", (m) => `bash -c 'touch ~/${m}'`],
  ["eval", (m) => `eval 'touch ~/${m}'`],
  ["ssh host '...'", (m) => `ssh buildbox 'touch ~/${m}'`],
  ["command substitution", (m) => `echo $(touch ~/${m})`],
  ["backticks", (m) => `echo \`touch ~/${m}\``],
  ["heredoc into a shell", (m) => `bash <<'EOF'\ntouch ~/${m}\nEOF`],
  ["heredoc redirect", (m) => `cat <<'EOF' > ~/${m}\nhi\nEOF`],
  ["pipe to sh", (m) => `echo 'touch ~/${m}' | sh`],
  ["nested wrappers", (m) => `sudo env A=1 timeout 5 bash -c "eval 'touch ~/${m}'"`],
];

const TAGS = (text) => ["HARD DENY", "UNCERTAIN", "OPERATOR DECISION", "AUTO-MODE BLOCK"].filter((t) => text.includes(`[${t}`));

try {
  // 0. The premise: every form needs an approval (it is not routine), and the harness really executes.
  {
    const env = { cwd: ws, workspace: ws, home, tmpRoots: ["/tmp", "/var/tmp"], knownHosts: new Set(), policy: "coding" };
    for (const [name, make] of FORMS) {
      const a = classify.classifyToolCall("bash", { command: make("probe") }, env, undefined, "ask");
      assert.notEqual(a.tier, "low", `${name} must not be routine, or the cases below prove nothing: ${a.summary}`);
    }
    config("manual");
    const s = await session({ ui: cardUI(async () => "Allow once") });
    const r = await s.run("touch ~/control-0");
    await r.done;
    assert.ok(exists("control-0"), "control: an allowed command really creates its marker");
    ok(`${FORMS.length} wrapper forms are all above the routine tier; the harness executes what is allowed`);
  }

  // 1. Deny, pending+abort, headless timeout, judge block: no marker, on every form. ------------------------
  let n = 0;
  const denyUI = cardUI(async () => "Deny");
  for (const [name, make] of FORMS) {
    n++;
    // deny
    config("manual");
    let m = `deny-${n}`;
    let s = await session({ ui: denyUI });
    let r = await s.run(make(m));
    await limited(r.done, 8000, `${name} deny`);
    assert.equal(exists(m), false, `${name}: the operator said no, yet the command ran`);
    assert.deepEqual(s.ran, [], `${name}: the tool was never executed`);
    assert.deepEqual(TAGS(r.text()), ["OPERATOR DECISION"], `${name}: denied by the operator`);

    // pending, then the turn is aborted while the card is open
    m = `pending-${n}`;
    let asked = 0;
    s = await session({ ui: cardUI(() => (asked++, new Promise(() => {}))) });
    const ac = new AbortController();
    r = await s.run(make(m), { signal: ac.signal });
    await until(() => asked === 1, `${name}: the card opens`);
    await sleep(60);
    assert.equal(exists(m), false, `${name}: ran while the approval was pending`);
    ac.abort();
    await limited(r.done, 8000, `${name} abort`);
    assert.equal(exists(m), false, `${name}: ran after the approval was cancelled`);
    assert.deepEqual(s.ran, [], `${name}: nothing executed after the abort`);

    // headless: no UI, nobody answers the human console within its timeout
    m = `headless-${n}`;
    s = await session({});
    const t0 = Date.now();
    r = await s.run(make(m));
    await limited(r.done, 8000, `${name} headless`);
    assert.equal(exists(m), false, `${name}: ran without an operator answer (headless)`);
    assert.deepEqual(TAGS(r.text()), ["UNCERTAIN"], `${name}: headless timeout is UNCERTAIN`);
    assert.ok(Date.now() - t0 < 6000, `${name}: bounded (${Date.now() - t0} ms)`);

    // auto mode. A medium form goes to the judge: it blocks (high confidence), or is still thinking when the
    // turn is aborted. A high form never reaches the judge: the operator's card denies it.
    config("auto");
    const tier = classify.effectiveTier(classify.classifyToolCall("bash", { command: make("t") }, { cwd: ws, workspace: ws, home, tmpRoots: ["/tmp", "/var/tmp"], knownHosts: new Set(), policy: "coding" }, undefined, "ask"), true);
    m = `auto-${n}`;
    s = await session({ ui: denyUI, judge: async (system) => (/review one tool call/.test(system) ? '{"verdict":"block","confidence":"high","reason":"not asked for"}' : "{}") });
    r = await s.run(make(m));
    await limited(r.done, 8000, `${name} auto`);
    assert.equal(exists(m), false, `${name}: ran in auto mode although it was blocked/denied`);
    assert.deepEqual(TAGS(r.text()), [tier === "medium" ? "AUTO-MODE BLOCK" : "OPERATOR DECISION"], `${name}: ${tier} tier in auto mode`);
    if (tier === "medium") {
      m = `judgehang-${n}`;
      let judging = 0;
      s = await session({ ui: cardUI(async () => "Allow once"), judge: (system) => (/review one tool call/.test(system) ? (judging++, new Promise(() => {})) : Promise.resolve("{}")) });
      const ac2 = new AbortController();
      r = await s.run(make(m), { signal: ac2.signal });
      await until(() => judging === 1, `${name}: the judge is called`);
      await sleep(60);
      assert.equal(exists(m), false, `${name}: ran while the judge was deciding`);
      ac2.abort();
      await limited(r.done, 8000, `${name} judge abort`);
      assert.equal(exists(m), false, `${name}: ran after the turn was aborted mid-judgement`);
    }

    // control: approved once, it really runs (so the absences above are not vacuous)
    config("manual");
    m = `allow-${n}`;
    s = await session({ ui: cardUI(async () => "Allow once") });
    r = await s.run(make(m));
    await limited(r.done, 8000, `${name} allow`);
    assert.equal(exists(m), true, `${name}: control: an approved command creates its marker`);
    assert.deepEqual(s.ran, [make(m)]);
  }
  ok(`${FORMS.length} wrapper forms x (denied, pending+aborted, headless timeout, auto-mode judge block / operator denial, judge hung+aborted): no marker; approved: marker`);

  // 2. A session approval survives a /reload, is not widened, and a revocation is honoured. ---------------
  {
    config("manual");
    const first = await session({ id: "reload-1", ui: cardUI(async () => "Allow for this session (exact repeats only)") });
    const m = "reload-marker";
    const cmd = `bash -c 'touch ~/${m}'`;
    await (await first.run(cmd)).done;
    assert.equal(exists(m), true);
    fs.rmSync(path.join(home, m));
    // /reload: a new set of extension instances, same session: the approved command runs without a card.
    let cards = 0;
    const reloaded = await session({ id: "reload-1", ui: cardUI(async () => (cards++, "Deny")) });
    await (await reloaded.run(cmd)).done;
    assert.equal(cards, 0, "the approval survived the reload: no card");
    assert.equal(exists(m), true, "and the exact command ran");
    fs.rmSync(path.join(home, m));
    // Not widened: another marker (a different command) is asked, denied, and does not run.
    const widened = `bash -c 'touch ~/${m}-other'`;
    await (await reloaded.run(widened)).done;
    assert.equal(cards, 1, "a different command is asked");
    assert.equal(exists(`${m}-other`), false);
    // Not shared: another session is asked.
    const other = await session({ id: "reload-2", ui: cardUI(async () => (cards++, "Deny")) });
    await (await other.run(cmd)).done;
    assert.equal(cards, 2);
    assert.equal(exists(m), false);
    // Revoked: the next call in the same (reloaded) session asks again.
    const view = { notes: [], ctx: { cwd: ws, hasUI: true, sessionManager: { getSessionId: () => "reload-1" }, ui: { notify() {} } } };
    const cmdHandler = (await firewallCommands()).get("firewall");
    await cmdHandler.handler("revoke session", view.ctx);
    const afterRevoke = await session({ id: "reload-1", ui: cardUI(async () => (cards++, "Deny")) });
    await (await afterRevoke.run(cmd)).done;
    assert.equal(cards, 3, "a revoked approval is asked again");
    assert.equal(exists(m), false, "and the denied command did not run");
    ok("a session approval survives /reload without widening; a revoked one asks again and the denied command does not run");
  }

  console.log(`[firewall-noeffect-smoke] all ${checks} checks passed`);
} finally {
  clearInterval(keepAlive);
  for (const r of restores.reverse()) r();
  rmWorkspace(base);
}

// The /firewall command of a fresh instance (commands are registered per instance).
async function firewallCommands() {
  const commands = new Map();
  firewall.default({ on() {}, registerTool() {}, registerCommand: (name, c) => commands.set(name, c) }, { complete: null });
  return commands;
}
