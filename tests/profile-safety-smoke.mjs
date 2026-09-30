#!/usr/bin/env node
/**
 * Profile installs fail closed on safety-critical configuration and tolerate stale non-security
 * overrides; a failed --settings-only run rolls every file back.
 *
 *  - overrides.json: names that no longer exist (renamed/removed extensions, skills, prompts) are
 *    skipped with a WARN and the switch succeeds; removing a mandatory protection extension
 *    (tool-firewall, secret-guard, protected-paths) or an unreadable file stops the run.
 *  - firewall: a profile or an existing firewall.json naming an unknown policy/mode, or a
 *    firewall.json that does not parse, stops the run instead of silently becoming the default
 *    ("pentset" used to become the looser "coding" policy).
 *  - rollback: an installer that dies after it has rewritten settings.json leaves every switch file
 *    byte-identical to before.
 *
 * The installer under test is the real packages/core/install.mjs with a fake `pi` on PATH.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolateKitEnv } from "../packages/core/eval/harness.mjs";
import {
  MANDATORY_PROTECTION_EXTENSIONS, checkFirewallConfig, firewallConfigFor, normalizeOverrides, readFirewallConfigChecked, readOverridesChecked, reconcileOverrides, writeFirewallConfig,
} from "../packages/core/lib/profiles.mjs";

const restoreEnv = isolateKitEnv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "packages", "core", "install.mjs");
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const kit = { extensionExists: (n) => ["alpha", "beta", "tool-firewall", "protected-paths"].includes(n), skills: ["s1", "s2"], prompts: ["p1"], file: "overrides.json" };

// --- unit: reconcileOverrides / readOverridesChecked / firewall strictness ---------------------------
function testReconcile() {
  const o = normalizeOverrides({
    extensions: { add: ["alpha", "ghost"], remove: ["beta", "gone"] },
    skills: { exclude: ["s1", "nope"], include: ["also-nope"] },
    prompts: { exclude: ["p1"], include: ["missing"] },
  });
  const r = reconcileOverrides(o, kit);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.overrides.extensions, { add: ["alpha"], remove: ["beta"] });
  assert.deepEqual(r.overrides.skills, { exclude: ["s1"], include: [] });
  assert.deepEqual(r.overrides.prompts, { exclude: ["p1"], include: [] });
  assert.equal(r.warnings.length, 5);
  assert.ok(r.warnings.some((w) => /extensions\.add "ghost" no longer exists/.test(w)));
  assert.ok(r.warnings.some((w) => /skills\.include "also-nope"/.test(w)));
}

function testMandatoryRemovalIsAnError() {
  assert.deepEqual(MANDATORY_PROTECTION_EXTENSIONS, ["tool-firewall", "secret-guard", "protected-paths"]);
  for (const name of MANDATORY_PROTECTION_EXTENSIONS) {
    const r = reconcileOverrides(normalizeOverrides({ extensions: { remove: [name] } }), { ...kit, extensionExists: () => true });
    assert.equal(r.errors.length, 1, name);
    assert.match(r.errors[0], new RegExp(`mandatory protection extension "${name}"`));
    assert.match(r.errors[0], /Delete .* from extensions\.remove/);
  }
  // Even when the extension name is unknown to this kit, a mandatory name is never quietly dropped.
  const r = reconcileOverrides(normalizeOverrides({ extensions: { remove: ["tool-firewall"] } }), { ...kit, extensionExists: () => false });
  assert.equal(r.errors.length, 1);
}

function testReadOverridesChecked() {
  const dir = tmp("pi-kit-ovr-");
  try {
    const file = path.join(dir, "overrides.json");
    assert.equal(readOverridesChecked(file).error, null, "absent is fine");
    fs.writeFileSync(file, "{ nope");
    assert.match(readOverridesChecked(file).error, /is not valid JSON/);
    fs.writeFileSync(file, "[]");
    assert.match(readOverridesChecked(file).error, /must contain a JSON object/);
    fs.writeFileSync(file, "null");
    assert.match(readOverridesChecked(file).error, /must contain a JSON object/);
    fs.writeFileSync(file, JSON.stringify({ extensions: { add: ["a"] } }));
    assert.deepEqual(readOverridesChecked(file).overrides.extensions.add, ["a"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function testFirewallStrictness() {
  const coding = { name: "x", firewall: { mode: "manual", policy: "coding" } };
  assert.throws(() => firewallConfigFor({ name: "typo", firewall: { policy: "pentset" } }, {}), /unknown firewall policy "pentset"/);
  assert.throws(() => firewallConfigFor({ name: "typo", firewall: { mode: "yolo" } }, {}), /unknown firewall mode "yolo"/);
  assert.throws(() => firewallConfigFor({ name: "typo", firewall: "strict" }, {}), /"firewall" must be an object/);
  assert.throws(() => firewallConfigFor(coding, { policy: "pentest-strict" }), /unknown policy "pentest-strict"/);
  assert.throws(() => firewallConfigFor(coding, { mode: "always" }), /unknown mode "always"/);
  // Unchanged behaviour for valid input.
  assert.deepEqual(firewallConfigFor({ name: "n" }, {}), { mode: "manual", policy: "coding", source: "profile" }, "a profile with no firewall block keeps the safe defaults");
  const dir = tmp("pi-kit-fw-");
  try {
    const file = path.join(dir, "firewall.json");
    assert.deepEqual(readFirewallConfigChecked(file), {}, "absent is fine");
    fs.writeFileSync(file, "{broken");
    assert.throws(() => readFirewallConfigChecked(file), /not valid JSON/);
    assert.throws(() => writeFirewallConfig(coding, file), /not valid JSON/);
    assert.equal(fs.readFileSync(file, "utf8"), "{broken", "an unreadable firewall config is never overwritten");
    fs.writeFileSync(file, "[]");
    assert.throws(() => checkFirewallConfig(coding, file), /must be a JSON object/);
    fs.writeFileSync(file, JSON.stringify({ policy: "loose", mode: "auto", source: "user" }));
    assert.throws(() => checkFirewallConfig(coding, file), /unknown policy "loose"/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// --- e2e with the real installer -----------------------------------------------------------------
function world() {
  const dir = tmp("pi-kit-safety-");
  const agent = path.join(dir, "agent");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(path.join(agent, "pi-kit"), { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  // pi stub: succeeds, except when asked to install pi-lens (a companion) - used to inject a late failure.
  fs.writeFileSync(path.join(bin, "pi"), '#!/bin/sh\ncase "$*" in *pi-lens*) [ -n "$FAIL_COMPANION" ] && exit 1;; esac\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ theme: "dark", packages: [ROOT] }, null, 2));
  return { dir, agent, bin, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function install(w, profile, extraArgs = [], extraEnv = {}) {
  const env = { ...process.env, PI_CODING_AGENT_DIR: w.agent, PI_LEAN_CTX_BIN: path.join(w.dir, "no-lean-ctx"), PATH: `${w.bin}${path.delimiter}${process.env.PATH ?? ""}`, ...extraEnv };
  return spawnSync(process.execPath, [INSTALL, "--profile", profile, "--yes", "--settings-only", "--mode", "local", ...extraArgs], { cwd: w.dir, env, encoding: "utf8" });
}

const files = (w) => [path.join(w.agent, "settings.json"), path.join(w.agent, ".pi-kit.json"), path.join(w.agent, "pi-kit", "firewall.json"), path.join(w.agent, "pi-kit", "overrides.json"), path.join(w.agent, ".env")];
const digest = (w) => Object.fromEntries(files(w).map((f) => [f, fs.existsSync(f) ? crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex") : null]));
const extensionsOf = (w) => JSON.parse(fs.readFileSync(path.join(w.agent, "settings.json"), "utf8")).packages.find((p) => (typeof p === "string" ? p : p.source) === ROOT).extensions.map((e) => e.match(/\/([^/]+)\/index\.ts$/)[1]);

function testStaleOverridesWarnAndSkip() {
  const w = world();
  try {
    const first = install(w, "quick", ["--no-externals"]);
    assert.equal(first.status, 0, first.stderr);
    const baseline = extensionsOf(w);
    const overrides = { extensions: { add: ["renamed-away-ext", "verify-gate"], remove: ["old-removed-ext"] }, skills: { exclude: ["skill-that-was-deleted"] }, prompts: { include: ["prompt-that-was-deleted"] } };
    fs.writeFileSync(path.join(w.agent, "pi-kit", "overrides.json"), JSON.stringify(overrides));
    const r = install(w, "balanced", ["--no-externals"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /WARN: .*extensions\.add "renamed-away-ext" no longer exists/);
    assert.match(r.stderr, /WARN: .*extensions\.remove "old-removed-ext" no longer exists/);
    assert.match(r.stderr, /WARN: .*skills\.exclude "skill-that-was-deleted"/);
    assert.match(r.stderr, /WARN: .*prompts\.include "prompt-that-was-deleted"/);
    const names = extensionsOf(w);
    assert.ok(!names.includes("renamed-away-ext"));
    assert.ok(names.includes("tool-firewall") && names.includes("protected-paths"), "protections stay");
    assert.ok(names.includes("verify-gate"), "a valid override still applies");
    assert.notDeepEqual(names, baseline, "the switch really happened");
    assert.equal(JSON.parse(fs.readFileSync(path.join(w.agent, ".pi-kit.json"), "utf8")).profile, "balanced");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(w.agent, "pi-kit", "overrides.json"), "utf8")), overrides, "the operator's file is not rewritten");
  } finally { w.done(); }
}

function testMandatoryRemovalStopsTheRun() {
  for (const name of ["tool-firewall", "protected-paths", "secret-guard"]) {
    const w = world();
    try {
      assert.equal(install(w, "quick", ["--no-externals"]).status, 0);
      fs.writeFileSync(path.join(w.agent, "pi-kit", "overrides.json"), JSON.stringify({ extensions: { remove: [name] } }));
      const before = digest(w);
      const r = install(w, "balanced", ["--no-externals"]);
      assert.equal(r.status, 1, name);
      assert.match(r.stderr, new RegExp(`FAIL: .*removes the mandatory protection extension "${name}"`));
      assert.match(r.stderr, /Refusing to apply it/);
      assert.deepEqual(digest(w), before, "nothing changed");
    } finally { w.done(); }
  }
}

function testMalformedOverridesStopTheRun() {
  const w = world();
  try {
    assert.equal(install(w, "quick", ["--no-externals"]).status, 0);
    fs.writeFileSync(path.join(w.agent, "pi-kit", "overrides.json"), '{"extensions": {"remove": ["tool-firewall"]');
    const before = digest(w);
    const r = install(w, "balanced", ["--no-externals"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /FAIL: .*overrides\.json is not valid JSON.*Fix or delete it, then retry; nothing was changed/);
    assert.deepEqual(digest(w), before);
  } finally { w.done(); }
}

function testFirewallFailuresStopTheRun() {
  const cases = [
    ["unknown policy in the existing file", JSON.stringify({ mode: "manual", policy: "pentest-strict", source: "user" }), /unknown policy "pentest-strict"/],
    ["unknown mode in the existing file", JSON.stringify({ mode: "always", policy: "coding" }), /unknown mode "always"/],
    ["unparseable existing file", "{ not json", /not valid JSON/],
    ["existing file that is not an object", "[]", /must be a JSON object/],
  ];
  for (const [name, content, pattern] of cases) {
    const w = world();
    try {
      assert.equal(install(w, "quick", ["--no-externals"]).status, 0);
      fs.writeFileSync(path.join(w.agent, "pi-kit", "firewall.json"), content);
      const before = digest(w);
      const r = install(w, "balanced", ["--no-externals"]);
      assert.equal(r.status, 1, name);
      assert.match(r.stderr, pattern, name);
      assert.deepEqual(digest(w), before, `${name}: nothing changed`);
    } finally { w.done(); }
  }
}

function testInstallerFailureLateInTheRunRollsBack() {
  const w = world();
  try {
    assert.equal(install(w, "quick", ["--no-externals"]).status, 0);
    const before = digest(w);
    // balanced pulls the pi-lens companion; the stub fails that install AFTER settings.json was narrowed.
    const r = install(w, "balanced", [], { FAIL_COMPANION: "1" });
    assert.notEqual(r.status, 0, "the companion failure must fail the run");
    assert.match(r.stderr, /Rolled back \d+ configuration file\(s\); nothing was changed\./);
    assert.deepEqual(digest(w), before, "settings.json, marker, firewall.json, overrides.json and .env are back as they were");
    assert.equal(extensionsOf(w).includes("verify-gate"), false, "the narrowed extension list did not survive");
  } finally { w.done(); }
}

function testCleanInstallStillWorks() {
  const w = world();
  try {
    const r = install(w, "lite", ["--no-externals"]);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /\[install\] Done\./);
    const fw = JSON.parse(fs.readFileSync(path.join(w.agent, "pi-kit", "firewall.json"), "utf8"));
    assert.deepEqual({ policy: fw.policy, mode: fw.mode }, { policy: "coding", mode: "manual" });
    for (const name of ["tool-firewall", "protected-paths"]) assert.ok(extensionsOf(w).includes(name), `${name} is in lite`);
  } finally { w.done(); }
}

const tests = [
  ["reconcileOverrides drops stale names with warnings", testReconcile],
  ["removing a mandatory protection extension is an error", testMandatoryRemovalIsAnError],
  ["readOverridesChecked distinguishes absent from unreadable", testReadOverridesChecked],
  ["firewall config: unknown values and unreadable files fail closed", testFirewallStrictness],
  ["installer: stale overrides warn and the switch succeeds", testStaleOverridesWarnAndSkip],
  ["installer: overrides that remove a protection stop the run untouched", testMandatoryRemovalStopsTheRun],
  ["installer: a malformed overrides.json stops the run untouched", testMalformedOverridesStopTheRun],
  ["installer: an unsafe firewall.json stops the run untouched", testFirewallFailuresStopTheRun],
  ["installer: a failure late in --settings-only rolls every file back", testInstallerFailureLateInTheRunRollsBack],
  ["installer: a clean install still works", testCleanInstallStillWorks],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL ${name}\n${error.stack}`);
  }
}
restoreEnv();
if (failed) {
  console.error(`profile-safety-smoke: ${failed}/${tests.length} failed`);
  process.exit(1);
}
console.log(`profile-safety-smoke: ${tests.length}/${tests.length} passed`);
