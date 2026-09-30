#!/usr/bin/env node
/**
 * M-06 regression coverage: an invalid custom firewall rule must warn loudly, not vanish
 * silently (a false sense of security — the operator believes an unenforced rule is
 * active). Fully offline — no live pi, no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadExtension, fakePi, setEnv } from "../packages/core/eval/harness.mjs";

async function testInvalidRegexWarnsLoudly() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-fw-warn-"));
  const policyPath = path.join(workspace, "policy.json");
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      defaults: { unknown: "deny" },
      tools: { bash: { decision: "allow" } },
      command_rules: {
        deny: [
          { pattern: "\\bvalid\\b", risk_class: "destructive", reason: "a valid rule" },
          { pattern: "(unterminated[", risk_class: "destructive", reason: "a broken rule" },
        ],
      },
    }),
  );
  const restorePolicy = setEnv("PI_KIT_FIREWALL_POLICY", policyPath);
  const restoreEnv = [setEnv("PI_CODING_AGENT_DIR", path.join(workspace, "agent")), setEnv("PI_KIT_AUTO_MODE", "0"), setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "1"), setEnv("PI_KIT_HUMAN_CONSOLE_DIR", path.join(workspace, "console"))];
  try {
    const register = await loadExtension("extensions/tool-firewall/index.ts");
    const pi = fakePi();
    register(pi.api);
    const notes = [];
    await pi.handlers.get("session_start")({}, { ui: { notify: (m, lvl) => notes.push([m, lvl]) } });

    const warning = notes.find(([m, lvl]) => lvl === "warning" && /skipped/.test(m));
    assert.ok(warning, "an invalid regex rule must produce a loud warning notification, not silently vanish");
    assert.match(warning[0], /invalid regex/);

    // The valid rule alongside it must still compile and be enforced.
    const call = (toolName, input) => pi.handlers.get("tool_call")({ toolName, input }, { hasUI: false, ui: {} });
    const result = await call("bash", { command: "run the valid thing" });
    assert.equal(result?.block, true, "a valid rule in the same policy must still be enforced despite a sibling invalid rule");
  } finally {
    restorePolicy();
    restoreEnv.reverse().forEach((r) => r());
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function testStatefulFlagsAreStripped() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-fw-gflag-"));
  const policyPath = path.join(workspace, "policy.json");
  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      defaults: { unknown: "deny" },
      tools: { bash: { decision: "allow" } },
      command_rules: { deny: [{ pattern: "\\becho\\b", flags: "g", risk_class: "destructive", reason: "no echo" }, { pattern: 123, risk_class: "destructive", reason: "a broken rule" }] },
    }),
  );
  const restorePolicy = setEnv("PI_KIT_FIREWALL_POLICY", policyPath);
  const restoreEnv = [setEnv("PI_CODING_AGENT_DIR", path.join(workspace, "agent")), setEnv("PI_KIT_AUTO_MODE", "0"), setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "1"), setEnv("PI_KIT_HUMAN_CONSOLE_DIR", path.join(workspace, "console"))];
  try {
    const register = await loadExtension("extensions/tool-firewall/index.ts");
    const pi = fakePi();
    register(pi.api);
    const notes = [];
    await pi.handlers.get("session_start")({}, { hasUI: false, ui: { notify: (m, lvl) => notes.push([m, lvl]) } });

    // The stateful "g" flag must be dropped loudly rather than travelling onto the compiled rule.
    const warning = notes.find(([m, lvl]) => lvl === "warning" && /dropped stateful regex flag/.test(m));
    assert.ok(warning, "a stateful g/y flag on a command rule must warn that it was dropped");
    assert.match(warning[0], /command_rules\.deny\[0\]/);

    // The g-flagged rule is adjusted (flag dropped) but still enforced — it must NOT be reported
    // as skipped/not enforced, which would wrongly imply the live rule is inactive.
    const adjusted = notes.find(([m, lvl]) => lvl === "warning" && /adjusted but still enforced/.test(m));
    assert.ok(adjusted, "a stateful g/y rule must be reported as adjusted but still enforced, not skipped");
    assert.match(adjusted[0], /command_rules\.deny\[0\]/);
    assert.doesNotMatch(adjusted[0], /skipped \(not enforced\)/);

    // A genuinely skipped rule (non-string pattern) must still be reported as skipped/not enforced.
    const skipped = notes.find(([m, lvl]) => lvl === "warning" && /skipped \(not enforced\)/.test(m));
    assert.ok(skipped, "a genuinely skipped rule must be reported as skipped (not enforced)");
    assert.match(skipped[0], /command_rules\.deny\[1\]/);
    assert.match(skipped[0], /no string "pattern"/);

    // A "g"-flagged deny rule advances lastIndex on the first .test(), so without sanitisation the
    // second identical call is skipped (fail open). With the flag stripped both calls deny.
    const call = (toolName, input) => pi.handlers.get("tool_call")({ toolName, input }, { hasUI: false, ui: {} });
    const first = await call("bash", { command: "echo hi" });
    assert.equal(first?.block, true, "the deny rule must block the first matching command");
    assert.match(first.reason, /policy rule: no echo/);
    const second = await call("bash", { command: "echo hi" });
    assert.equal(second?.block, true, "a g-flagged deny rule must not be skipped on a later call (fail open)");
    assert.match(second.reason, /policy rule: no echo/);
  } finally {
    restorePolicy();
    restoreEnv.reverse().forEach((r) => r());
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function testNonStatefulFlagsKeepWorking() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-fw-iflags-"));
  const policyPath = path.join(workspace, "policy.json");
  fs.writeFileSync(
    policyPath,
    JSON.stringify({ defaults: { unknown: "deny" }, tools: { bash: { decision: "allow" } }, command_rules: { deny: [{ pattern: "\\bhello\\b", flags: "i", reason: "no hello" }] } }),
  );
  const restorePolicy = setEnv("PI_KIT_FIREWALL_POLICY", policyPath);
  const restoreEnv = [setEnv("PI_CODING_AGENT_DIR", path.join(workspace, "agent")), setEnv("PI_KIT_AUTO_MODE", "0"), setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "1"), setEnv("PI_KIT_HUMAN_CONSOLE_DIR", path.join(workspace, "console"))];
  try {
    const register = await loadExtension("extensions/tool-firewall/index.ts");
    const pi = fakePi();
    register(pi.api);
    const notes = [];
    await pi.handlers.get("session_start")({}, { hasUI: false, ui: { notify: (m, lvl) => notes.push([m, lvl]) } });
    assert.ok(!notes.some(([m, lvl]) => lvl === "warning" && /dropped stateful/.test(m)), "non-stateful flags must not be reported as dropped");
    const call = (toolName, input) => pi.handlers.get("tool_call")({ toolName, input }, { hasUI: false, ui: {} });
    const result = await call("bash", { command: "HELLO there" });
    assert.equal(result?.block, true, "an i-flagged rule must still match case-insensitively");
    assert.match(result.reason, /policy rule: no hello/);
  } finally {
    restorePolicy();
    restoreEnv.reverse().forEach((r) => r());
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

async function testValidPolicyProducesNoWarning() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-fw-nowarn-"));
  const policyPath = path.join(workspace, "policy.json");
  fs.writeFileSync(
    policyPath,
    JSON.stringify({ defaults: { unknown: "deny" }, command_rules: { deny: [{ pattern: "\\bfine\\b" }] } }),
  );
  const restorePolicy = setEnv("PI_KIT_FIREWALL_POLICY", policyPath);
  const restoreEnv = [setEnv("PI_CODING_AGENT_DIR", path.join(workspace, "agent")), setEnv("PI_KIT_AUTO_MODE", "0"), setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "1"), setEnv("PI_KIT_HUMAN_CONSOLE_DIR", path.join(workspace, "console"))];
  try {
    const register = await loadExtension("extensions/tool-firewall/index.ts");
    const pi = fakePi();
    register(pi.api);
    const notes = [];
    await pi.handlers.get("session_start")({}, { ui: { notify: (m, lvl) => notes.push([m, lvl]) } });
    assert.ok(!notes.some(([, lvl]) => lvl === "warning"), "a fully valid policy must not produce a rule-skipped warning");
  } finally {
    restorePolicy();
    restoreEnv.reverse().forEach((r) => r());
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

const tests = [
  ["an invalid custom rule warns loudly and doesn't silently vanish", testInvalidRegexWarnsLoudly],
  ["a stateful g flag is dropped and its deny rule keeps firing", testStatefulFlagsAreStripped],
  ["non-stateful flags (i) keep working and are not reported as dropped", testNonStatefulFlagsKeepWorking],
  ["a fully valid custom policy produces no warning", testValidPolicyProducesNoWarning],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

if (failed > 0) {
  console.error(`\n[firewall-policy-warnings-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[firewall-policy-warnings-smoke] all ${tests.length} checks passed`);
