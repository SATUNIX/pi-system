#!/usr/bin/env node
/**
 * /profile is all-or-nothing: every failure stage rolls the configuration back byte-for-byte.
 *
 * The command runs a REAL child process (a stub install.mjs whose behaviour is chosen with
 * STUB_MODE) through an exec that reproduces pi.exec's quirk: a signal-killed child resolves as
 * `code: 0` (pi's child-process.js resolves `code ?? 0`), so the command must not trust exit codes.
 * Every case hashes all the files a switch can change before and after and demands equality.
 *
 * Stages covered: installer non-zero exit, installer killed mid-way (with and without output),
 * installer timeout, exception, corrupt marker, mismatching marker, no marker rewrite, unknown
 * firewall policy, dangling extension entry, leftover lock/tmp files, a profile that names an unknown
 * firewall policy, a failing reload, project scope, invalid arguments and a cancelled picker.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.mjs";

const restoreEnv = isolateKitEnv();
const helpers = await loadModule("extensions/session-helpers/index.ts");
const txn = await loadModule("extensions/session-helpers/profile-switch.ts");
const sessionHelpers = helpers.default;

const STUB = `
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const profile = flag("--profile");
const scope = flag("--scope", "global");
const mode = process.env.STUB_MODE || "ok";
const agent = process.env.PI_CODING_AGENT_DIR;
const settingsPath = scope === "project" ? path.join(process.cwd(), ".pi", "settings.json") : path.join(agent, "settings.json");
const markerPath = scope === "project" ? path.join(process.cwd(), ".pi", ".pi-kit.json") : path.join(agent, ".pi-kit.json");
const firewallPath = path.join(agent, "pi-kit", "firewall.json");
const def = JSON.parse(fs.readFileSync(path.join(root, "packages", "kit", "profiles", profile + ".json"), "utf8"));
const include = def.include || [];
const patterns = include.filter((n) => fs.existsSync(path.join(root, "packages", "extensions", "src", n, "index.ts"))).map((n) => "packages/extensions/src/" + n + "/index.ts");
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const writeSettings = (extra) => {
  let s = {}; try { s = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {}
  const packages = Array.isArray(s.packages) ? s.packages : [];
  const at = packages.findIndex((p) => (typeof p === "string" ? p : p.source) === root);
  const entry = { source: root, extensions: patterns.concat(extra || []) };
  if (at >= 0) packages[at] = entry; else packages.push(entry);
  s.packages = packages;
  write(settingsPath, JSON.stringify(s, null, 2));
};
const writeMarker = (over) => write(markerPath, JSON.stringify(Object.assign({ kitSource: root, profile, scope, mode: "local", extensions: include, installedAt: new Date().toISOString() }, over || {}), null, 2));
const writeFirewall = (over) => write(firewallPath, JSON.stringify(Object.assign({ mode: (def.firewall && def.firewall.mode) || "manual", policy: (def.firewall && def.firewall.policy) || "coding", source: "profile" }, over || {}), null, 2));
if (mode !== "silent-kill") console.log("[install] pi-system");
switch (mode) {
  case "exit1-after-settings": writeSettings(); console.error("[install] FAIL: boom"); process.exit(1);
  case "sigkill-after-settings": writeSettings(); process.kill(process.pid, "SIGKILL"); break;
  case "silent-kill": writeSettings(); writeFirewall(); process.kill(process.pid, "SIGKILL"); break;
  case "hang": writeSettings(); setTimeout(() => {}, 60000); await new Promise(() => {}); break;
  case "stale-lock": writeSettings(); write(settingsPath + ".pi-kit.lock", "1"); write(settingsPath + ".4242.tmp", "{"); console.error("[install] FAIL: crashed"); process.exit(1);
  case "throw": writeSettings(); throw new Error("stub exception");
  case "corrupt-marker": writeSettings(); writeFirewall(); write(markerPath, "{ not json"); break;
  case "wrong-profile": writeSettings(); writeFirewall(); writeMarker({ profile: "balanced" }); break;
  case "no-marker-write": writeSettings(); writeFirewall(); break;
  case "bad-firewall": writeSettings(); writeFirewall({ policy: "yolo" }); writeMarker(); break;
  case "bad-mode": writeSettings(); writeFirewall({ mode: "always" }); writeMarker(); break;
  case "dangling": writeSettings(["packages/extensions/src/ghost/index.ts"]); writeFirewall(); writeMarker(); break;
  case "unfiltered": { let s = {}; try { s = JSON.parse(fs.readFileSync(settingsPath, "utf8")); } catch {} s.packages = [root]; write(settingsPath, JSON.stringify(s)); writeFirewall(); writeMarker(); break; }
  case "warn-ok": console.error("[install] WARN: overrides.json extensions.add \\"old-ext\\" no longer exists; skipped"); writeSettings(); writeFirewall(); writeMarker(); break;
  default: writeSettings(); writeFirewall(); writeMarker();
}
console.log("[install] Done.");
`;

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// pi.exec reproduction: code is `code ?? 0` (a signal-killed child reads as success), plus timeout kill.
function piLikeExec(command, args, options = {}) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    let stdout = "";
    let stderr = "";
    let killed = false;
    let timer;
    if (options.timeout) timer = setTimeout(() => { killed = true; proc.kill("SIGKILL"); }, options.timeout);
    proc.stdout.on("data", (d) => { stdout += d; });
    proc.stderr.on("data", (d) => { stderr += d; });
    proc.on("close", (code) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? 0, killed }); });
    proc.on("error", (error) => { clearTimeout(timer); resolve({ stdout, stderr: String(error), code: 1, killed }); });
  });
}

function makeWorld() {
  const dir = tmp("pi-kit-txn-");
  const root = path.join(dir, "kit");
  const agent = path.join(dir, "agent");
  const project = path.join(dir, "project");
  fs.mkdirSync(path.join(root, "packages", "core"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "core", "install.mjs"), STUB);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@satunix/pi-system", version: "0.0.0" }));
  fs.mkdirSync(path.join(root, "packages", "kit", "profiles"), { recursive: true });
  for (const n of ["tool-firewall", "protected-paths", "alpha", "beta", "gamma"]) {
    fs.mkdirSync(path.join(root, "packages", "extensions", "src", n), { recursive: true });
    fs.writeFileSync(path.join(root, "packages", "extensions", "src", n, "index.ts"), "");
  }
  const profile = (name, include, firewall) => fs.writeFileSync(path.join(root, "packages", "kit", "profiles", `${name}.json`), JSON.stringify({ name, description: `${name} profile`, include, firewall }));
  profile("balanced", ["tool-firewall", "protected-paths", "alpha", "beta"], { mode: "manual", policy: "coding" });
  profile("long", ["tool-firewall", "protected-paths", "alpha", "gamma"], { mode: "auto", policy: "coding" });
  profile("pentest", ["tool-firewall", "protected-paths", "beta"], { mode: "manual", policy: "pentest" });
  profile("broken-fw", ["tool-firewall", "protected-paths"], { mode: "manual", policy: "pentset" });
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const restores = [setEnv("PI_CODING_AGENT_DIR", agent), setEnv("PI_KIT_ROOT", root)];
  return { dir, root, agent, project, done: () => { for (const r of restores) r(); rmWorkspace(dir); } };
}

// Put the world on the "balanced" profile with a hand-tuned settings file, an overrides file and a
// user-owned firewall mode: everything a rollback has to preserve exactly.
async function installBalanced(world, scope = "global") {
  const restore = setEnv("STUB_MODE", "ok");
  try {
    const args = [path.join(world.root, "packages", "core", "install.mjs"), "--profile", "balanced", "--yes", "--settings-only", "--scope", scope];
    const r = await piLikeExec(process.execPath, args, { cwd: scope === "project" ? world.project : world.root });
    assert.equal(r.code, 0, r.stderr);
  } finally { restore(); }
  const settingsPath = scope === "project" ? path.join(world.project, ".pi", "settings.json") : path.join(world.agent, "settings.json");
  const s = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  s.theme = "solarized";
  s.packages.push("npm:pi-lens@3.8.63");
  fs.writeFileSync(settingsPath, JSON.stringify(s, null, 2) + "\n");
  fs.chmodSync(settingsPath, 0o600);
  fs.mkdirSync(path.join(world.agent, "pi-kit"), { recursive: true });
  fs.writeFileSync(path.join(world.agent, "pi-kit", "overrides.json"), JSON.stringify({ extensions: { add: [], remove: [] } }, null, 2));
  fs.writeFileSync(path.join(world.agent, "pi-kit", "firewall.json"), JSON.stringify({ mode: "auto", policy: "coding", source: "user", judgeModel: "x/y" }, null, 2));
}

function hashAll(world) {
  const files = helpers.switchFiles(world.project);
  const out = {};
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      out[f] = crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") + ":" + (st.mode & 0o777).toString(8);
    } catch { out[f] = null; }
  }
  // Nothing may be left behind next to them either.
  for (const f of files) {
    const dir = path.dirname(f);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) if (/\.(lock|tmp)$/.test(name)) out[path.join(dir, name)] = "transient";
  }
  return out;
}

function loadCommand(world) {
  const pi = fakePi();
  sessionHelpers(pi.api);
  const calls = [];
  pi.api.exec = (command, args, options) => { calls.push({ command, args, options }); return piLikeExec(command, args, options); };
  return { pi, calls, handler: pi.commands.get("profile").handler };
}

function makeCtx(world, { hasUI = true, select, confirm, reload } = {}) {
  const ctx = {
    cwd: world.project,
    hasUI,
    notes: [],
    reloads: 0,
    ui: {
      notify: (message, level) => ctx.notes.push({ message, level }),
      select: select ?? (async () => undefined),
      confirm: confirm ?? (async () => false),
      setStatus() {},
    },
  };
  ctx.reload = reload ?? (async () => { ctx.reloads++; });
  ctx.waitForIdle = async () => {};
  return ctx;
}

async function withMode(mode, fn) {
  const restore = setEnv("STUB_MODE", mode);
  try { return await fn(); } finally { restore(); }
}

const last = (ctx) => ctx.notes.at(-1);
const tests = {};

tests["a clean switch changes the files, verifies them and reloads once"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const before = hashAll(w);
    const { handler, calls } = loadCommand(w);
    const ctx = makeCtx(w);
    await withMode("ok", () => handler("long", ctx));
    assert.equal(calls.length, 1);
    assert.equal(ctx.reloads, 1);
    assert.match(ctx.notes[0].message, /switched to "long"\. Verified: marker, extension list and firewall match/);
    const marker = JSON.parse(fs.readFileSync(path.join(w.agent, ".pi-kit.json"), "utf8"));
    assert.equal(marker.profile, "long");
    assert.notDeepEqual(hashAll(w), before);
  } finally { w.done(); }
};

tests["installer warnings are shown to the operator, not swallowed"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const { handler } = loadCommand(w);
    const ctx = makeCtx(w);
    await withMode("warn-ok", () => handler("long", ctx));
    assert.equal(ctx.reloads, 1);
    assert.match(ctx.notes[0].message, /Warnings:\s+WARN: overrides\.json extensions\.add "old-ext" no longer exists/);
  } finally { w.done(); }
};

const failureCases = [
  ["installer exits non-zero after rewriting settings", "exit1-after-settings", /FAILED at install: installer exited 1/],
  ["installer throws after rewriting settings", "throw", /FAILED at install: installer exited 1/],
  ["installer is SIGKILLed mid-way (pi.exec reports code 0)", "sigkill-after-settings", /FAILED at install: the installer stopped before finishing/],
  ["installer is SIGKILLed with no output at all", "silent-kill", /FAILED at verify: .*marker/],
  ["installer leaves a corrupt marker", "corrupt-marker", /FAILED at verify: install marker .* is not valid JSON/],
  ["installer writes a marker for the wrong profile", "wrong-profile", /FAILED at verify: marker records profile "balanced", expected "long"/],
  ["installer never rewrites the marker", "no-marker-write", /FAILED at verify: marker records profile "balanced", expected "long"/],
  ["installer writes an unknown firewall policy", "bad-firewall", /FAILED at verify: firewall policy "yolo" is not a known policy/],
  ["installer writes an unknown firewall mode", "bad-mode", /FAILED at verify: firewall mode "always" is not a known mode/],
  ["installer lists an extension that does not exist", "dangling", /FAILED at verify: .*(differs from profile "long"; unexpected: ghost|do not exist in the kit: ghost)/],
  ["installer leaves an unfiltered kit entry", "unfiltered", /FAILED at verify: .*no filtered kit entry/],
  ["installer crashes leaving lock and tmp files behind", "stale-lock", /FAILED at install: installer exited 1/],
];
for (const [name, mode, pattern] of failureCases) {
  tests[`rollback: ${name}`] = async () => {
    const w = makeWorld();
    try {
      await installBalanced(w);
      const before = hashAll(w);
      const { handler } = loadCommand(w);
      const ctx = makeCtx(w);
      await withMode(mode, () => handler("long", ctx));
      assert.equal(ctx.reloads, 0, "a failed switch must not reload");
      assert.equal(last(ctx).level, "error");
      assert.match(last(ctx).message, pattern);
      assert.match(last(ctx).message, /restored byte-for-byte and the previous profile stays in force/);
      assert.deepEqual(hashAll(w), before, "every configuration file (bytes and mode) and no transient file must be back as it was");
    } finally { w.done(); }
  };
}

tests["rollback: a failing reload restores the files and reloads the old configuration"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const before = hashAll(w);
    const { handler } = loadCommand(w);
    let calls = 0;
    const ctx = makeCtx(w, { reload: async () => { calls++; if (calls === 1) throw new Error("extension failed to load"); } });
    await withMode("ok", () => handler("long", ctx));
    assert.equal(calls, 2, "reload the new config (fails), then the restored one");
    assert.match(last(ctx).message, /FAILED at reload: pi could not reload the new configuration: extension failed to load/);
    assert.deepEqual(hashAll(w), before);
  } finally { w.done(); }
};

tests["rollback: an installer timeout (killed) is a failure even though pi.exec says code 0"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const before = hashAll(w);
    const world = w;
    const files = helpers.switchFiles(world.project);
    const outcome = await withMode("hang", () => txn.transactionalSwitch({
      exec: piLikeExec,
      command: process.execPath,
      args: [path.join(world.root, "packages", "core", "install.mjs"), "--profile", "long", "--yes", "--settings-only"],
      cwd: world.root,
      timeoutMs: 400,
      files,
      expectation: {
        profile: "long", scope: "global", kitRoot: world.root,
        markerFile: path.join(world.agent, ".pi-kit.json"), settingsFile: path.join(world.agent, "settings.json"), firewallFile: path.join(world.agent, "pi-kit", "firewall.json"),
        extensions: ["tool-firewall", "protected-paths", "alpha", "gamma"], firewall: { policy: "coding", mode: "auto" },
        loadedExtensions: (f) => helpers.loadedKitExtensions(f, world.root), extensionExists: () => true,
      },
    }));
    assert.equal(outcome.ok, false);
    assert.equal(outcome.stage, "install");
    assert.match(outcome.message, /the installer was killed after/);
    assert.deepEqual(hashAll(world), before);
  } finally { w.done(); }
};

tests["rollback: pi.exec rejecting is a failure"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const before = hashAll(w);
    const pi = fakePi();
    sessionHelpers(pi.api);
    pi.api.exec = async () => { throw new Error("spawn EAGAIN"); };
    const ctx = makeCtx(w);
    await pi.commands.get("profile").handler("long", ctx);
    assert.match(last(ctx).message, /FAILED at install: could not run the installer: spawn EAGAIN/);
    assert.deepEqual(hashAll(w), before);
  } finally { w.done(); }
};

tests["rollback: project scope restores project files and leaves the global ones alone"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w, "project");
    const before = hashAll(w);
    const { handler, calls } = loadCommand(w);
    const ctx = makeCtx(w);
    await withMode("wrong-profile", () => handler("long", ctx));
    assert.ok(calls[0].args.includes("--scope") && calls[0].args.includes("project"));
    assert.equal(calls[0].options.cwd, w.project);
    assert.match(last(ctx).message, /FAILED at verify/);
    assert.deepEqual(hashAll(w), before);
    assert.equal(fs.existsSync(path.join(w.agent, ".pi-kit.json")), false, "the global marker never existed and must not be created");
  } finally { w.done(); }
};

tests["a profile whose firewall block is unknown is refused before the installer runs"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const before = hashAll(w);
    const { handler, calls } = loadCommand(w);
    const ctx = makeCtx(w);
    await handler("broken-fw", ctx);
    assert.equal(calls.length, 0);
    assert.match(last(ctx).message, /refusing to switch to "broken-fw".*unknown policy or mode/);
    assert.deepEqual(hashAll(w), before);
  } finally { w.done(); }
};

tests["invalid arguments change nothing and never reach the installer"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const before = hashAll(w);
    for (const arg of ["long extra", "--evil", "../etc/passwd", "LONG", "long;rm", "long --scope project"]) {
      const { handler, calls } = loadCommand(w);
      const ctx = makeCtx(w);
      await handler(arg, ctx);
      assert.equal(calls.length, 0, `"${arg}" must not run the installer`);
      assert.equal(ctx.reloads, 0);
      assert.equal(last(ctx).level, "error", arg);
      assert.match(last(ctx).message, /Nothing was changed|expected one argument/);
      assert.deepEqual(hashAll(w), before, arg);
    }
  } finally { w.done(); }
};

tests["a cancelled picker changes nothing"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const before = hashAll(w);
    const { handler, calls } = loadCommand(w);
    const ctx = makeCtx(w, { select: async () => undefined });
    await handler("", ctx);
    assert.equal(calls.length, 0);
    assert.equal(ctx.reloads, 0);
    assert.equal(ctx.notes.length, 0);
    assert.deepEqual(hashAll(w), before);
  } finally { w.done(); }
};

tests["non-interactive sessions print results to stderr instead of doing nothing"] = async () => {
  const w = makeWorld();
  const chunks = [];
  const original = process.stderr.write.bind(process.stderr);
  try {
    await installBalanced(w);
    const { handler } = loadCommand(w);
    process.stderr.write = (c) => { chunks.push(String(c)); return true; };
    const ctx = makeCtx(w, { hasUI: false });
    await handler("nope", ctx); // unknown
    await handler("balanced", ctx); // already on
    await withMode("wrong-profile", () => handler("long", ctx)); // failed switch
    await withMode("ok", () => handler("long", ctx)); // good switch
    process.stderr.write = original;
    const text = chunks.join("");
    assert.match(text, /\[pi-kit\] profile: unknown profile "nope"/);
    assert.match(text, /\[pi-kit\] profile: already on "balanced"/);
    assert.match(text, /\[pi-kit\] profile: switch to "long" FAILED at verify/);
    assert.match(text, /\[pi-kit\] profile: switched to "long"\. Verified/);
    assert.equal(ctx.reloads, 1);
  } finally { process.stderr.write = original; w.done(); }
};

tests["/profile status prints the effective configuration"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    fs.writeFileSync(path.join(w.agent, "pi-kit", "overrides.json"), JSON.stringify({ extensions: { add: ["gamma"], remove: [] }, skills: { exclude: ["x"] } }));
    const marker = JSON.parse(fs.readFileSync(path.join(w.agent, ".pi-kit.json"), "utf8"));
    marker.companions = ["npm:pi-lens@3.8.63", "npm:pi-readseek@1.0.0"];
    marker.channel = "next";
    fs.writeFileSync(path.join(w.agent, ".pi-kit.json"), JSON.stringify(marker));
    const { handler } = loadCommand(w);
    const ctx = makeCtx(w);
    ctx.model = { contextWindow: 200_000 };
    await handler("status", ctx);
    const text = last(ctx).message;
    assert.match(text, /^Current: /);
    assert.match(text, /Profile: /);
    assert.match(text, /Install: local · channel next · scope global · source /);
    assert.match(text, /Extensions: 4 loaded - notable: tool-firewall, protected-paths/);
    assert.match(text, /Firewall: policy coding · mode auto \(set with \/auto\)/);
    assert.match(text, /Compaction: pi auto ON \(default\) · earliest trigger 183\.6k · no kit trigger/);
    assert.match(text, /Overrides: extensions \+1\/-0, skills -1\/\+0, prompts -0\/\+0 \(.*overrides\.json\)/);
    assert.match(text, /Companions: pi-lens@3\.8\.63, pi-readseek@1\.0\.0 \(not registered\)/);
  } finally { w.done(); }
};

tests["/profile status warns when a mandatory protection extension is not loaded"] = async () => {
  const w = makeWorld();
  try {
    await installBalanced(w);
    const s = JSON.parse(fs.readFileSync(path.join(w.agent, "settings.json"), "utf8"));
    const kit = s.packages.find((p) => p.source === w.root);
    kit.extensions = kit.extensions.filter((e) => !/protected-paths/.test(e));
    fs.writeFileSync(path.join(w.agent, "settings.json"), JSON.stringify(s));
    const { handler } = loadCommand(w);
    const ctx = makeCtx(w);
    await handler("status", ctx);
    assert.match(last(ctx).message, /WARNING: protected-paths is NOT loaded/);
  } finally { w.done(); }
};

tests["restoreSnapshots reports a file it cannot restore and saveBackup keeps the bytes"] = () => {
  const dir = tmp("pi-kit-txn-restore-");
  try {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "i am a file");
    const snap = { path: path.join(blocker, "child", "settings.json"), existed: true, bytes: Buffer.from("original"), mode: 0o600 };
    const result = txn.restoreSnapshots([snap]);
    assert.equal(result.restored.length, 0);
    assert.equal(result.errors.length, 1);
    const backup = txn.saveBackup([snap]);
    assert.ok(backup && fs.readdirSync(backup).length === 1);
    assert.equal(fs.readFileSync(path.join(backup, fs.readdirSync(backup)[0]), "utf8"), "original");
    rmWorkspace(backup);
  } finally { rmWorkspace(dir); }
};

tests["snapshot/restore round-trips bytes, mode and absence"] = () => {
  const dir = tmp("pi-kit-txn-snap-");
  try {
    const a = path.join(dir, "a.json");
    const b = path.join(dir, "sub", "b.json");
    fs.writeFileSync(a, Buffer.from([0, 1, 2, 255, 10, 13]));
    fs.chmodSync(a, 0o640);
    const snaps = txn.snapshotFiles([a, b, a]);
    assert.equal(snaps.length, 2, "duplicates collapse");
    fs.writeFileSync(a, "changed");
    fs.chmodSync(a, 0o777);
    fs.mkdirSync(path.dirname(b), { recursive: true });
    fs.writeFileSync(b, "created by the switch");
    const r = txn.restoreSnapshots(snaps);
    assert.deepEqual(r.errors, []);
    assert.deepEqual([...fs.readFileSync(a)], [0, 1, 2, 255, 10, 13]);
    assert.equal(fs.statSync(a).mode & 0o777, 0o640);
    assert.equal(fs.existsSync(b), false, "a file the switch created is removed");
  } finally { rmWorkspace(dir); }
};

// The real thing: the actual packages/core/install.mjs and the shipped profiles, driven through the real
// command, must pass the command's own verification for every profile (a verifier that rejects a good
// switch would roll back every /profile in production).
tests["the real installer and the shipped profiles pass /profile's verification for all seven profiles"] = async () => {
  const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
  const dir = tmp("pi-kit-txn-real-");
  const agent = path.join(dir, "agent");
  const project = path.join(dir, "project");
  const bin = path.join(dir, "bin");
  for (const d of [agent, project, bin]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(bin, "pi"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ theme: "dark", packages: [repo] }, null, 2));
  const restores = [
    setEnv("PI_CODING_AGENT_DIR", agent),
    setEnv("PI_KIT_ROOT", repo),
    setEnv("PI_LEAN_CTX_BIN", path.join(dir, "no-lean-ctx")),
    setEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`),
  ];
  try {
    const { handler } = loadCommand({});
    for (const profile of ["balanced", "quick", "long-horizon", "autonomous", "self-improving", "pentest", "lite"]) {
      const ctx = makeCtx({ project, agent });
      await handler(profile, ctx);
      assert.equal(ctx.reloads, 1, `${profile}: ${ctx.notes.map((n) => n.message).join("\n")}`);
      assert.match(ctx.notes[0].message, new RegExp(`switched to "${profile}"\\. Verified`));
      const marker = JSON.parse(fs.readFileSync(path.join(agent, ".pi-kit.json"), "utf8"));
      assert.equal(marker.profile, profile);
      const fw = JSON.parse(fs.readFileSync(path.join(agent, "pi-kit", "firewall.json"), "utf8"));
      assert.equal(fw.policy, profile === "pentest" ? "pentest" : "coding");
      const status = makeCtx({ project, agent });
      await handler("status", status);
      assert.match(status.notes.at(-1).message, new RegExp(`^Current: ${profile}\\n`), `${profile} is reported as the current profile`);
    }
    assert.equal(JSON.parse(fs.readFileSync(path.join(agent, "settings.json"), "utf8")).theme, "dark", "other settings survive every switch");
    // A no-op switch to the profile already in force never touches anything.
    const same = makeCtx({ project, agent });
    await handler("lite", same);
    assert.match(same.notes[0].message, /already on "lite"/);
  } finally { for (const r of restores.reverse()) r(); rmWorkspace(dir); }
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}\n${error.stack}`);
  }
}
restoreEnv();
const total = Object.keys(tests).length;
if (failed) {
  console.error(`profile-transaction-smoke: ${failed}/${total} failed`);
  process.exit(1);
}
console.log(`profile-transaction-smoke: ${total}/${total} passed`);
