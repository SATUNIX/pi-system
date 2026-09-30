#!/usr/bin/env node
/**
 * delegation-guard: the single launch contract for child pi sessions. Covers what every launch
 * path (subagents, workflows, completion review, conductor) gets: mandatory protections and task
 * governance always load, a missing protection refuses the launch, overrides cannot drop a
 * protection, the launch reserves against the shared effort budget at every depth, and the child
 * verifies before any tool runs that everything required registered itself.
 *
 * Deterministic and offline: no child is spawned; the argv/env the guard hands back is what is
 * checked, and the child-side hook is driven with a fake pi API.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, isolateKitEnv, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.mjs";

const restoreEnv = isolateKitEnv();
const guardMod = await loadModule("extensions/delegation-guard/index.ts");
const effortMod = await loadModule("extensions/effort/index.ts");
const launchMod = await loadModule("vendor/subagent/launch.ts");
const conductorMod = await loadModule("extensions/conductor/index.ts");
const validatorMod = await loadModule("extensions/conductor/validate/validator.ts");
const verifyGateMod = await loadModule("extensions/verify-gate/index.ts");
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const { default: guard, DELEGATION_KEY, PROTECTIONS_KEY, prepareChild, requiredForChild } = guardMod;
const EFFORT_KEY = Symbol.for("pi-kit.effort");

// A scratch extensions tree with fake governance extensions, so the test controls the manifests.
function fixtureRoot(extensions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-root-"));
  for (const [name, { childGovernance = false, avenue = "src" } = {}] of Object.entries(extensions)) {
    const dir = path.join(root, avenue, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.ts"), "export default function () {}\n");
    fs.writeFileSync(path.join(dir, "extension.json"), JSON.stringify({ name, childGovernance }));
  }
  return root;
}

function world({ registered = [], fixture, env = {} } = {}) {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-agent-"));
  const root = fixture ? fixtureRoot(fixture) : null;
  const restores = [setEnv("PI_CODING_AGENT_DIR", agent), ...(root ? [setEnv("PI_KIT_EXTENSIONS_ROOT", root)] : []), ...Object.entries(env).map(([k, v]) => setEnv(k, v))];
  globalThis[PROTECTIONS_KEY] = new Set(registered);
  return { agent, root, cleanup: () => { restores.reverse().forEach((r) => r()); delete globalThis[PROTECTIONS_KEY]; delete globalThis[DELEGATION_KEY]; delete globalThis[EFFORT_KEY]; rmWorkspace(agent); if (root) rmWorkspace(root); } };
}

// The real effort extension, opened on a fresh scope, gives real reservations.
async function withEffort(tier = "standard") {
  delete globalThis[EFFORT_KEY];
  const restore = setEnv("PI_KIT_EFFORT", tier);
  const pi = fakePi();
  effortMod.default(pi.api);
  const ctx = { hasUI: false, cwd: process.cwd(), ui: {}, sessionManager: { getSessionId: () => "g1" } };
  await pi.handlers.get("session_start")({ reason: "startup" }, ctx);
  await pi.handlers.get("before_agent_start")({ systemPrompt: "" }, ctx);
  return { registry: globalThis[EFFORT_KEY], done: () => restore() };
}

const argsOf = (p) => p.args.filter((_, i) => p.args[i - 1] === "-e").map((f) => path.basename(path.dirname(f)));

const tests = {
  "a child loads the guard first, every governance extension the parent runs, and nothing the parent lacks": async () => {
    const w = world({ registered: ["tool-firewall", "protected-paths", "pentest-governance-domain", "delegation-guard", "effort"], fixture: { "delegation-guard": { childGovernance: true }, effort: { childGovernance: true }, "tool-firewall": { childGovernance: true }, "protected-paths": { childGovernance: true, avenue: "third_party" }, "secret-guard": { childGovernance: true }, "pentest-governance-domain": { childGovernance: true }, todo: {}, "finish-reason-retry": {} } });
    const e = await withEffort();
    try {
      const p = prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "implementer" });
      assert.equal(p.ok, true, p.reason);
      assert.equal(p.args[0], "--no-extensions");
      assert.equal(argsOf(p)[0], "delegation-guard", "the guard is loaded first so its blocking hook runs first");
      for (const name of ["tool-firewall", "protected-paths", "pentest-governance-domain", "effort", "todo", "finish-reason-retry"]) assert.ok(argsOf(p).includes(name), `${name} is loaded in the child`);
      assert.ok(!argsOf(p).includes("secret-guard"), "secret-guard is required only when the parent actually runs it");
      assert.equal(p.env.PI_KIT_CHILD_REQUIRE.split(",").sort().join(), ["delegation-guard", "effort", "pentest-governance-domain", "protected-paths", "tool-firewall"].join());
      assert.equal(p.env.PI_KIT_INTERNAL_CHILD, "1");
      // secret-guard enabled in the parent -> the child must have it too
      globalThis[PROTECTIONS_KEY].add("secret-guard");
      const q = prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "implementer" });
      assert.ok(argsOf(q).includes("secret-guard") && q.env.PI_KIT_CHILD_REQUIRE.includes("secret-guard"));
    } finally { e.done(); w.cleanup(); }
  },

  "a protection that cannot be located refuses the launch; it is never silently skipped": async () => {
    const w = world({ registered: ["tool-firewall", "delegation-guard", "effort"], fixture: { "delegation-guard": { childGovernance: true }, effort: { childGovernance: true }, "tool-firewall": { childGovernance: true } } });
    const e = await withEffort();
    try {
      fs.rmSync(path.join(w.root, "src", "tool-firewall", "index.ts"));
      const p = prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "worker" });
      assert.equal(p.ok, false);
      assert.equal(p.code, "governance-missing");
      assert.match(p.reason, /tool-firewall/);
      assert.match(p.reason, /never started with weaker protection/);
      // and it consumed no budget: the refusal happened before the reservation
      assert.equal(globalThis[EFFORT_KEY].snapshot().usage.total, 0);
    } finally { e.done(); w.cleanup(); }
  },

  "overrides can add extensions but can never drop a required protection or disable isolation": async () => {
    const w = world({ registered: ["tool-firewall", "delegation-guard", "effort"], fixture: { "delegation-guard": { childGovernance: true }, effort: { childGovernance: true }, "tool-firewall": { childGovernance: true }, todo: {}, memory: {} }, env: { PI_KIT_SUBAGENT_EXTENSIONS: "memory", PI_KIT_SUBAGENT_ISOLATE: "0" } });
    const e = await withEffort();
    try {
      const p = prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "worker" });
      assert.equal(p.ok, true, p.reason);
      assert.ok(argsOf(p).includes("tool-firewall") && argsOf(p).includes("delegation-guard"), "the override list cannot remove protections");
      assert.ok(argsOf(p).includes("memory"), "the override list still adds what was asked for");
      assert.ok(!argsOf(p).includes("todo"), "the override replaces the optional defaults");
      assert.equal(p.args[0], "--no-extensions", "PI_KIT_SUBAGENT_ISOLATE=0 no longer disables isolation");
      assert.equal(p.env.PI_KIT_SUBAGENT_ISOLATE, undefined, "the knob is not passed on");
    } finally { e.done(); w.cleanup(); }
  },

  "launches reserve against the effort budget and carry the child's tier; exhaustion refuses before any spawn": async () => {
    const w = world({ registered: ["delegation-guard", "effort"] });
    const e = await withEffort("focused"); // one child in total
    try {
      const first = prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "scout", scout: true, requestedTier: "exhaustive" });
      assert.equal(first.ok, true, first.reason);
      assert.equal(first.childTier, "focused", "a child is never above its parent");
      assert.equal(first.env.PI_KIT_EFFORT, "focused");
      assert.equal(first.env.PI_KIT_EFFORT_CAP, "focused");
      assert.ok(first.env.PI_KIT_EFFORT_LEDGER);
      first.slot.settle("failed");
      const second = prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "worker" });
      assert.equal(second.ok, false, "a failed child is not refunded");
      assert.equal(second.code, "total");
      assert.match(second.reason, /\/effort/);
      // completion review is mandatory verification: it still runs at any tier
      assert.equal(prepareChild({ cwd: process.cwd(), kind: "mandatory", role: "reviewer" }).ok, true);
    } finally { e.done(); w.cleanup(); }
  },

  "without the effort extension a discretionary launch is refused (fail closed) but mandatory verification is not": async () => {
    const w = world({ registered: ["delegation-guard"] });
    try {
      delete globalThis[EFFORT_KEY];
      const denied = prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "worker" });
      assert.equal(denied.ok, false);
      assert.equal(denied.code, "no-effort");
      assert.equal(prepareChild({ cwd: process.cwd(), kind: "mandatory", role: "reviewer" }).ok, true);
    } finally { w.cleanup(); }
  },

  "the subagent side refuses to launch when delegation-guard is not loaded, and survives a guard that throws": async () => {
    const w = world();
    try {
      delete globalThis[DELEGATION_KEY];
      const none = launchMod.prepareChildLaunch({ cwd: process.cwd(), kind: "discretionary", role: "worker" });
      assert.equal(none.ok, false);
      assert.equal(none.code, "no-guard");
      assert.match(none.reason, /delegation-guard/);
      globalThis[DELEGATION_KEY] = { prepareChild() { throw new Error("boom"); } };
      const broken = launchMod.prepareChildLaunch({ cwd: process.cwd(), kind: "discretionary", role: "worker" });
      assert.equal(broken.ok, false);
      assert.equal(broken.code, "guard-error");
    } finally { w.cleanup(); }
  },

  "grandchildren: the same rules apply from inside a child, with the same or a lower tier and the shared ledger": async () => {
    const w = world({ registered: ["tool-firewall", "delegation-guard", "effort"], fixture: { "delegation-guard": { childGovernance: true }, effort: { childGovernance: true }, "tool-firewall": { childGovernance: true }, subagent: { avenue: "third_party" } } });
    const parent = await withEffort("thorough");
    try {
      const child = prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "delegator", requestedTier: "standard", needsSubagent: true });
      assert.equal(child.ok, true, child.reason);
      assert.ok(argsOf(child).includes("subagent"), "a delegator child gets the subagent extension");
      // Become the child process: its env pins the tier and shares the parent's ledger.
      const restore = ["PI_KIT_EFFORT", "PI_KIT_EFFORT_CAP", "PI_KIT_EFFORT_LEDGER", "PI_KIT_CHILD_REQUIRE"].map((k) => setEnv(k, child.env[k]));
      try {
        const inner = await withEffort(child.env.PI_KIT_EFFORT);
        const grand = prepareChild({ cwd: process.cwd(), kind: "discretionary", role: "worker", requestedTier: "exhaustive" });
        assert.equal(grand.ok, true, grand.reason);
        assert.equal(grand.childTier, "standard", "a grandchild is never above its parent's tier");
        assert.ok(argsOf(grand).includes("tool-firewall"), "the boundary reaches the grandchild");
        assert.equal(grand.env.PI_KIT_EFFORT_LEDGER, child.env.PI_KIT_EFFORT_LEDGER, "descendants share one ledger, so no fresh budget");
        inner.done();
      } finally { restore.reverse().forEach((f) => f()); }
    } finally { parent.done(); w.cleanup(); }
  },

  "every other launch path (completion reviewer, conductor specialist, conductor validator) refuses without the guard and spawns nothing": async () => {
    const w = world();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-cwd-"));
    try {
      delete globalThis[DELEGATION_KEY];
      fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".pi", "agents", "recon.md"), "---\nname: recon\ntools: read, grep\n---\nRecon.\n");
      fs.writeFileSync(path.join(cwd, ".pi", "agents", "validator.md"), "---\nname: validator\ntools: read, grep, find, ls\n---\nValidate.\n");
      const review = await verifyGateMod.runReviewerProcess(cwd, "task", {});
      assert.equal(review.ok, false);
      assert.match(review.reason, /delegation-guard extension is not loaded/);
      const specialist = await conductorMod.runSpecialistProcess(cwd, "recon", "scan", 1);
      assert.equal(specialist.ok, false);
      assert.match(specialist.reason, /delegation-guard extension is not loaded/);
      const validator = await validatorMod.runValidatorProcess(cwd, "task");
      assert.equal(validator.ok, false);
      assert.match(validator.reason, /delegation-guard extension is not loaded/);
    } finally { rmWorkspace(cwd); w.cleanup(); }
  },

  "a conductor specialist is a discretionary child: refused at E1 with the reason, before any spawn": async () => {
    const w = world({ registered: ["delegation-guard", "effort", "tool-firewall"] });
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-cwd-"));
    const e = await withEffort("minimal");
    try {
      // install the real guard registry next to the real effort registry
      const pi = fakePi();
      guard(pi.api);
      fs.mkdirSync(path.join(cwd, ".pi", "agents"), { recursive: true });
      fs.writeFileSync(path.join(cwd, ".pi", "agents", "recon.md"), "---\nname: recon\ntools: read, grep\n---\nRecon.\n");
      const specialist = await conductorMod.runSpecialistProcess(cwd, "recon", "scan", 1);
      assert.equal(specialist.ok, false);
      assert.match(specialist.reason, /E1 Minimal does not delegate/);
      assert.equal(globalThis[EFFORT_KEY].snapshot().usage.total, 0);
    } finally { rmWorkspace(cwd); e.done(); w.cleanup(); }
  },

  "child side: a missing protection blocks every tool call and exits with EX_CONFIG": async () => {
    const w = world({ registered: ["delegation-guard", "tool-firewall"], env: { PI_KIT_CHILD_REQUIRE: "tool-firewall,protected-paths,delegation-guard" } });
    const realExit = process.exit;
    const realWrite = process.stderr.write.bind(process.stderr);
    const exits = [];
    const written = [];
    process.exit = (code) => { exits.push(code); };
    process.stderr.write = (c) => { written.push(String(c)); return true; };
    const priorExitCode = process.exitCode;
    try {
      const pi = fakePi();
      guard(pi.api);
      const notes = [];
      await pi.handlers.get("session_start")({ reason: "startup" }, { hasUI: true, ui: { notify: (m, l) => notes.push({ m, l }) } });
      await new Promise((r) => setTimeout(r, 120));
      assert.deepEqual(exits, [78], "the child exits visibly");
      assert.match(written.join(""), /missing required protection \(protected-paths\)/);
      assert.equal(notes[0].l, "error");
      const verdict = await pi.handlers.get("tool_call")({ toolName: "bash", input: { command: "ls" } });
      assert.equal(verdict.block, true);
      assert.match(verdict.reason, /Every tool call is refused/);
    } finally {
      process.exit = realExit;
      process.stderr.write = realWrite;
      process.exitCode = priorExitCode;
      w.cleanup();
    }
  },

  "child side: a complete child runs normally; a root session (no requirements) is untouched": async () => {
    const w = world({ registered: ["delegation-guard", "tool-firewall"], env: { PI_KIT_CHILD_REQUIRE: "tool-firewall,delegation-guard" } });
    const realExit = process.exit;
    const exits = [];
    process.exit = (code) => { exits.push(code); };
    try {
      let pi = fakePi();
      guard(pi.api);
      await pi.handlers.get("session_start")({ reason: "startup" }, { hasUI: false });
      assert.equal(await pi.handlers.get("tool_call")({ toolName: "read", input: {} }), undefined);
      delete process.env.PI_KIT_CHILD_REQUIRE;
      pi = fakePi();
      guard(pi.api);
      await pi.handlers.get("session_start")({ reason: "startup" }, { hasUI: false });
      assert.equal(await pi.handlers.get("tool_call")({ toolName: "bash", input: {} }), undefined);
      await new Promise((r) => setTimeout(r, 80));
      assert.deepEqual(exits, []);
    } finally { process.exit = realExit; w.cleanup(); }
  },

  "every extension that declares childGovernance registers itself as a protection": () => {
    const seen = [];
    for (const avenue of ["src", "third_party"]) {
      const dir = path.join(ROOT, "packages", "extensions", avenue);
      for (const name of fs.readdirSync(dir)) {
        const manifest = path.join(dir, name, "extension.json");
        if (!fs.existsSync(manifest) || JSON.parse(fs.readFileSync(manifest, "utf8")).childGovernance !== true) continue;
        seen.push(name);
        const files = fs.readdirSync(path.join(dir, name)).filter((f) => f.endsWith(".ts"));
        const src = files.map((f) => fs.readFileSync(path.join(dir, name, f), "utf8")).join("\n");
        assert.ok(src.includes('Symbol.for("pi-kit.protections")'), `${name} must register itself in the protections registry so a child can verify it loaded`);
      }
    }
    assert.ok(seen.includes("effort") && seen.includes("delegation-guard"), `governance set: ${seen.join(", ")}`);
  },

  "every shipped profile includes effort and delegation-guard together with subagent": () => {
    for (const file of fs.readdirSync(path.join(ROOT, "packages", "kit", "profiles")).filter((f) => f.endsWith(".json"))) {
      const include = JSON.parse(fs.readFileSync(path.join(ROOT, "packages", "kit", "profiles", file), "utf8")).include;
      assert.ok(include.includes("effort") && include.includes("delegation-guard"), `${file}: effort and delegation-guard are in every profile`);
      if (include.includes("subagent")) assert.ok(include.includes("delegation-guard") && include.includes("effort"), `${file}: subagent without its guard`);
    }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}\n    ${error?.stack || error}`);
  }
}
restoreEnv();
if (failed) {
  console.error(`\n[delegation-guard-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[delegation-guard-smoke] all ${Object.keys(tests).length} checks passed`);
