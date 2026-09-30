#!/usr/bin/env node
// Protections registry: tool-firewall, secret-guard and protected-paths each record their name in
// globalThis[Symbol.for("pi-kit.protections")] once their hooks are installed, so a trusted
// launcher can check that a session loaded its mandatory protections. Offline; no model.
import assert from "node:assert/strict";
import path from "node:path";
import { loadExtension, fakePi, setEnv, tmpWorkspace, rmWorkspace, isolateKitEnv } from "../packages/core/eval/harness.mjs";

const KEY = Symbol.for("pi-kit.protections");
const ALL = ["protected-paths", "secret-guard", "tool-firewall"];
const ws = tmpWorkspace("pi-kit-protections-");
const restores = [isolateKitEnv(), setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")), setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(ws, "audit.jsonl"))];
let checks = 0;
const ok = (label) => {
  checks++;
  console.log(`  OK: ${label}`);
};
const reset = () => {
  delete globalThis[KEY];
};

const firewall = await loadExtension("extensions/tool-firewall/index.ts");
const guard = await loadExtension("extensions/secret-guard/index.ts");
const paths = await loadExtension("vendor/protected-paths/index.ts");
const loaders = { "tool-firewall": firewall, "secret-guard": guard, "protected-paths": paths };

try {
  // 1. Nothing is registered until a factory runs; each factory registers at factory time (no
  //    session_start needed) and only its own name.
  reset();
  assert.equal(globalThis[KEY], undefined);
  for (const [name, factory] of Object.entries(loaders)) {
    const pi = fakePi();
    factory(pi.api);
    const reg = globalThis[KEY];
    assert.ok(reg, `${name} creates the registry when it is the first to load`);
    assert.equal(reg.has(name), true, `${name} registered itself`);
    assert.equal(typeof reg.list, "function");
  }
  assert.deepEqual(globalThis[KEY].list(), ALL, "list() is the sorted set of registered names");
  assert.equal(globalThis[KEY].has("tool-capture"), false, "has() is false for a protection that did not load");
  ok("each protection registers itself at factory time; has()/list() report exactly what loaded");

  // 2. Load order does not matter and a partial load is visible (a launcher can tell what is missing).
  for (const order of [["secret-guard", "protected-paths"], ["protected-paths", "tool-firewall", "secret-guard"]]) {
    reset();
    for (const name of order) loaders[name](fakePi().api);
    assert.deepEqual(globalThis[KEY].list(), [...order].sort());
    assert.equal(globalThis[KEY].has("tool-firewall"), order.includes("tool-firewall"));
  }
  ok("registration is order independent and a missing protection is visible");

  // 3. /reload-style re-instantiation: the factories run again with a fresh pi API. The registry
  //    stays complete, holds no duplicates, and each fresh instance has its own hooks.
  reset();
  const first = { firewall: fakePi(), guard: fakePi(), paths: fakePi() };
  firewall(first.firewall.api);
  guard(first.guard.api);
  paths(first.paths.api);
  const registry = globalThis[KEY];
  const second = { firewall: fakePi(), guard: fakePi(), paths: fakePi() };
  firewall(second.firewall.api);
  guard(second.guard.api);
  paths(second.paths.api);
  assert.equal(globalThis[KEY], registry, "the registry object survives re-instantiation");
  assert.deepEqual(globalThis[KEY].list(), ALL);
  assert.equal(globalThis[KEY].size, 3, "no duplicate entries after a reload");
  for (const p of Object.values(second)) assert.equal(typeof p.handlers.get("tool_call"), "function", "the re-instantiated protection installed its hook");
  ok("registered again after a /reload-style re-instantiation, without duplicates");

  // 4. A factory that fails before its hooks are installed does not register (a launcher must not be
  //    told a protection is present when it never armed).
  reset();
  const broken = { on() { throw new Error("cannot install hook"); }, registerTool() {}, registerCommand() {} };
  for (const [name, factory] of Object.entries(loaders)) {
    assert.throws(() => factory(broken), /cannot install hook/);
    assert.equal(globalThis[KEY]?.has(name) ?? false, false, `${name} must not register when its hook could not be installed`);
  }
  ok("a protection whose hooks failed to install is not registered");

  // 5. A foreign or stale object under the key never prevents registration and never breaks a protection.
  for (const foreign of [new Set(["legacy"]), {}, "junk", 42, null]) {
    globalThis[KEY] = foreign;
    guard(fakePi().api);
    const reg = globalThis[KEY];
    assert.equal(reg.has("secret-guard"), true);
    assert.equal(typeof reg.list, "function");
    assert.ok(reg.list().includes("secret-guard"));
  }
  globalThis[KEY] = Object.freeze(new Set());
  assert.doesNotThrow(() => firewall(fakePi().api), "an unusable registry must not break the protection itself");
  ok("a foreign, frozen or garbage registry object is tolerated");

  // 6. The registry is a Set of names: enumerable and iterable by other extensions.
  reset();
  for (const factory of Object.values(loaders)) factory(fakePi().api);
  assert.deepEqual([...globalThis[KEY]].sort(), ALL);
  assert.equal(Object.keys(globalThis[KEY]).length, 0, "list() is not an enumerable own property");
  ok("registry is iterable like a Set of names");

  console.log(`[protections-registry-smoke] all ${checks} checks passed`);
} finally {
  reset();
  for (const r of restores.reverse()) r();
  rmWorkspace(ws);
}
