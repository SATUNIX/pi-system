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
