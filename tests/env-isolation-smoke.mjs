#!/usr/bin/env node
// Regression for kit env isolation. The autonomy runtime and a developer's shell export
// PI_KIT_* / PI_CODING_AGENT_DIR, which change firewall decisions and state paths. Smoke tests
// must clear them with isolateKitEnv() (packages/core/eval/harness.mjs) before loading the
// extension under test; eval fixtures must relocate their own state. This test proves both:
//   1. isolateKitEnv() clears kit-owned variables and its closure restores them exactly;
//   2. the four smoke tests that inherited the ambient env pass under a polluted environment;
//   3. `npm run eval` writes no firewall sessions under the ambient PI_CODING_AGENT_DIR;
//   4. tests/epic1-smoke.mjs writes no firewall sessions under an isolated HOME.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, isolateKitEnv, rmWorkspace, setEnv, tmpWorkspace } from "../packages/core/eval/harness.mjs";

// 1. Unit: isolateKitEnv clears kit-owned variables, and the closure restores exactly.
{
  const restorePolicy = setEnv("PI_KIT_FIREWALL_POLICY", "sentinel-policy");
  const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", "sentinel-agent-dir");
  const restoreUpdate = setEnv("PI_KIT_UPDATE_CHECK", "sentinel-update");
  try {
    const restore = isolateKitEnv();
    assert.equal(process.env.PI_KIT_FIREWALL_POLICY, undefined, "PI_KIT_FIREWALL_POLICY must be cleared");
    assert.equal(process.env.PI_CODING_AGENT_DIR, undefined, "PI_CODING_AGENT_DIR must be cleared");
    assert.equal(process.env.PI_KIT_UPDATE_CHECK, undefined, "PI_KIT_UPDATE_CHECK must be cleared");
    restore();
    assert.equal(process.env.PI_KIT_FIREWALL_POLICY, "sentinel-policy", "the closure must restore PI_KIT_FIREWALL_POLICY exactly");
    assert.equal(process.env.PI_CODING_AGENT_DIR, "sentinel-agent-dir", "the closure must restore PI_CODING_AGENT_DIR exactly");
    assert.equal(process.env.PI_KIT_UPDATE_CHECK, "sentinel-update", "the closure must restore PI_KIT_UPDATE_CHECK exactly");
  } finally {
    restoreUpdate();
    restoreAgentDir();
    restorePolicy();
  }
}

const ws = tmpWorkspace("pi-kit-env-isolation-");
const homeProbe = tmpWorkspace("pi-kit-env-isolation-home-");
const permissivePolicyPath = path.join(ws, "firewall.json");
const probe = tmpWorkspace("pi-kit-env-isolation-probe-");
try {
  fs.writeFileSync(
    permissivePolicyPath,
    JSON.stringify({ defaults: { unknown: "allow" }, tools: {}, command_rules: { deny: [], ask: [] } }),
  );

  // 2. Integration: the previously-failing smoke tests must pass with a polluted ambient env.
  const pollutedEnv = {
    ...process.env,
    PI_KIT_FIREWALL_POLICY: permissivePolicyPath,
    PI_KIT_AUTO_MODE: "0",
    PI_CODING_AGENT_DIR: path.join(ws, "agent"),
    PI_KIT_FIREWALL_ROOT_SESSION: "polluted-session",
    PI_KIT_INTERNAL_CHILD: "1",
    PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS: "120000",
  };
  for (const file of [
    "tests/auto-mode-smoke.mjs",
    "tests/firewall-gate-smoke.mjs",
    "tests/human-console-broker-smoke.mjs",
    "tests/shutdown-hook-gating-smoke.mjs",
  ]) {
    const result = spawnSync(process.execPath, [file], { cwd: ROOT, env: pollutedEnv, encoding: "utf8", timeout: 180000 });
    assert.equal(result.status, 0, `${file} must pass with ambient kit env: status=${result.status}\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  console.log("[env-isolation-smoke] polluted smoke runs pass");

  // 3. Eval isolation: the firewall fixture must not write to the ambient agent dir.
  const evalResult = spawnSync(process.execPath, ["packages/core/eval/run.mjs"], {
    cwd: ROOT,
    env: { ...process.env, PI_CODING_AGENT_DIR: probe, PI_KIT_FIREWALL_POLICY: permissivePolicyPath },
    encoding: "utf8",
    timeout: 300000,
  });
  assert.equal(evalResult.status, 0, `npm run eval must pass with ambient kit env: status=${evalResult.status}\n${evalResult.stdout ?? ""}\n${evalResult.stderr ?? ""}`);
  assert.ok(
    !fs.existsSync(path.join(probe, "pi-kit", "firewall-sessions")),
    `eval must not write firewall sessions under PI_CODING_AGENT_DIR (${probe})`,
  );

  // 4. Smoke isolation: epic1-smoke.mjs must not write firewall sessions under HOME.
  const homeEnv = { ...process.env, HOME: homeProbe };
  delete homeEnv.PI_CODING_AGENT_DIR;
  delete homeEnv.PI_KIT_FIREWALL_SESSIONS_DIR;
  const smokeResult = spawnSync(process.execPath, ["tests/epic1-smoke.mjs"], {
    cwd: ROOT,
    env: homeEnv,
    encoding: "utf8",
    timeout: 180000,
  });
  assert.equal(smokeResult.status, 0, `epic1-smoke.mjs must pass with ambient HOME: status=${smokeResult.status}\n${smokeResult.stdout ?? ""}\n${smokeResult.stderr ?? ""}`);
  assert.ok(
    !fs.existsSync(path.join(homeProbe, ".pi", "agent", "pi-kit", "firewall-sessions")),
    `epic1-smoke.mjs must not write firewall sessions under HOME (${homeProbe})`,
  );

  console.log("[env-isolation-smoke] OK");
} finally {
  rmWorkspace(ws);
  rmWorkspace(probe);
  rmWorkspace(homeProbe);
}
