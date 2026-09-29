#!/usr/bin/env node
/**
 * Offline checks for the configurable auto-compact threshold in vendor/trigger-compact.
 * The upstream extension hardcoded the threshold at 100k tokens, which fires far too early
 * on large-context-window models. This pins:
 *   1. The built-in 100k default still applies with no env var and no saved setting.
 *   2. PI_KIT_COMPACT_THRESHOLD_TOKENS overrides the default and locks /compact-threshold.
 *   3. /compact-threshold <amount> (plain int or "500k"/"1.2m" shorthand) persists to
 *      <agent dir>/pi-kit/trigger-compact.json and a fresh load of the module picks it up.
 *   4. A threshold at or above the model's context window is rejected, not silently accepted.
 *   5. /compact-threshold reset clears the saved override back to the built-in default.
 *   6. The turn_end hook still only fires on an upward crossing of whatever the current
 *      threshold is (unchanged edge-triggered behavior from upstream).
 *   7. pi's own `compaction.enabled: false` (the /settings auto-compact toggle, global or
 *      project) stops automatic compaction — the reported "off in settings but still
 *      compacts" bug — while manual /trigger-compact still works.
 *   8. /compact-threshold off|on toggles just this trigger and survives a reset.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace, setEnv } from "../packages/core/eval/harness.mjs";

function fakeCtx(contextWindow = 1_300_000) {
  const notices = [];
  const compactCalls = [];
  return {
    hasUI: true,
    ui: { notify: (msg, level) => notices.push({ msg, level }) },
    getContextUsage: () => ({ tokens: 0, contextWindow, percent: 0 }),
    compact: (opts) => compactCalls.push(opts),
    notices,
    compactCalls,
  };
}

async function withAgentDir(fn) {
  const dir = tmpWorkspace("pi-kit-trigger-compact-agentdir-");
  const restore = setEnv("PI_CODING_AGENT_DIR", dir);
  try {
    await fn(dir);
  } finally {
    restore();
    rmWorkspace(dir);
  }
}

async function crossThreshold(pi, ctx, below, above) {
  await pi.handlers.get("turn_end")(undefined, { ...ctx, getContextUsage: () => ({ tokens: below, contextWindow: ctx.getContextUsage().contextWindow, percent: null }) });
  await pi.handlers.get("turn_end")(undefined, { ...ctx, getContextUsage: () => ({ tokens: above, contextWindow: ctx.getContextUsage().contextWindow, percent: null }) });
}

async function testDefaultThreshold() {
  await withAgentDir(async () => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const ctx = fakeCtx();
    await crossThreshold(pi, ctx, 90_000, 110_000);
    assert.equal(ctx.compactCalls.length, 1, "must auto-compact once the default 100k threshold is crossed");

    const belowCtx = fakeCtx();
    await pi.commands.get("compact-threshold").handler("", belowCtx);
    assert.match(belowCtx.notices.at(-1).msg, /100k tokens \[default\]/);
  });
}

async function testEnvOverrideLocksCommand() {
  await withAgentDir(async () => {
    const restore = setEnv("PI_KIT_COMPACT_THRESHOLD_TOKENS", "250000");
    try {
      const pi = fakePi();
      (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
      const ctx = fakeCtx();

      await crossThreshold(pi, ctx, 200_000, 260_000);
      assert.equal(ctx.compactCalls.length, 1, "env-configured threshold (250k) must still drive auto-compact");

      const lockedCtx = fakeCtx();
      await pi.commands.get("compact-threshold").handler("500k", lockedCtx);
      assert.match(lockedCtx.notices.at(-1).msg, /locked by PI_KIT_COMPACT_THRESHOLD_TOKENS/);
      assert.equal(lockedCtx.notices.at(-1).level, "error");
    } finally { restore(); }
  });
}

async function testCommandPersistsAndReloads() {
  await withAgentDir(async (agentDir) => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const ctx = fakeCtx();

    await pi.commands.get("compact-threshold").handler("500k", ctx);
    assert.match(ctx.notices.at(-1).msg, /set to 500k tokens/);
    assert.equal(ctx.notices.at(-1).level, "info");

    const saved = JSON.parse(fs.readFileSync(path.join(agentDir, "pi-kit", "trigger-compact.json"), "utf8"));
    assert.equal(saved.thresholdTokens, 500_000, "500k shorthand must resolve to 500000");

    // A fresh module load (simulating a new pi session) must pick up the saved value.
    const pi2 = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi2.api);
    const ctx2 = fakeCtx();

    await crossThreshold(pi2, ctx2, 490_000, 510_000);
    assert.equal(ctx2.compactCalls.length, 1, "reloaded module must auto-compact at the persisted 500k, not the 100k default");

    const belowOldDefaultCtx = fakeCtx();
    await pi2.handlers.get("turn_end")(undefined, { ...belowOldDefaultCtx, getContextUsage: () => ({ tokens: 50_000, contextWindow: 1_300_000, percent: null }) });
    await pi2.handlers.get("turn_end")(undefined, { ...belowOldDefaultCtx, getContextUsage: () => ({ tokens: 150_000, contextWindow: 1_300_000, percent: null }) });
    assert.equal(belowOldDefaultCtx.compactCalls.length, 0, "150k must not trigger compaction once the threshold is 500k");
  });
}

async function testRejectsThresholdAtOrAboveContextWindow() {
  await withAgentDir(async (agentDir) => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const ctx = fakeCtx(200_000);

    await pi.commands.get("compact-threshold").handler("200000", ctx);
    assert.match(ctx.notices.at(-1).msg, /at or above the 200k context window/);
    assert.equal(ctx.notices.at(-1).level, "error");
    assert.equal(fs.existsSync(path.join(agentDir, "pi-kit", "trigger-compact.json")), false, "a rejected threshold must not be persisted");
  });
}

async function testReset() {
  await withAgentDir(async (agentDir) => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const ctx = fakeCtx();

    await pi.commands.get("compact-threshold").handler("500k", ctx);
    assert.equal(fs.existsSync(path.join(agentDir, "pi-kit", "trigger-compact.json")), true);

    const resetCtx = fakeCtx();
    await pi.commands.get("compact-threshold").handler("reset", resetCtx);
    assert.match(resetCtx.notices.at(-1).msg, /reset to default \(100k tokens\)/);
    assert.equal(fs.existsSync(path.join(agentDir, "pi-kit", "trigger-compact.json")), false, "reset must remove the saved override");

    await crossThreshold(pi, ctx, 90_000, 110_000);
    assert.equal(ctx.compactCalls.length, 1, "after reset, auto-compact must fire at the 100k default again");
  });
}

async function testNullSettingsFileFallsBackToDefault() {
  await withAgentDir(async (agentDir) => {
    const settingsDir = path.join(agentDir, "pi-kit");
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, "trigger-compact.json"), "null");

    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const ctx = fakeCtx();
    await crossThreshold(pi, ctx, 90_000, 110_000);
    assert.equal(ctx.compactCalls.length, 1, "a `null` settings file must fall back to the 100k default, not throw");
  });
}

async function testRespectsPiAutoCompactionSetting() {
  await withAgentDir(async (dir) => {
    const ws = tmpWorkspace("pi-kit-trigger-compact-ws-");
    try {
      const pi = fakePi();
      (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
      fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ compaction: { enabled: false } }));
      const ctx = { ...fakeCtx(), cwd: ws };
      await crossThreshold(pi, ctx, 90_000, 110_000);
      assert.equal(ctx.compactCalls.length, 0, "compaction.enabled=false in global settings must stop auto-compaction");

      // A project setting overrides the global one (pi's merge order), in both directions.
      // Both writes get the same mtime, as they do within one timestamp tick on a coarse-clock
      // filesystem (CI overlayfs): the settings cache must still see the second one.
      const projectSettings = path.join(ws, ".pi", "settings.json");
      const sameTick = new Date(Date.UTC(2026, 0, 1));
      fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
      fs.writeFileSync(projectSettings, JSON.stringify({ compaction: { enabled: true } }));
      fs.utimesSync(projectSettings, sameTick, sameTick);
      await crossThreshold(pi, ctx, 90_000, 110_000);
      assert.equal(ctx.compactCalls.length, 1, "a project compaction.enabled=true re-enables it for that project");
      fs.writeFileSync(projectSettings, JSON.stringify({ compaction: { enabled: false }, other: 1 }));
      fs.utimesSync(projectSettings, sameTick, sameTick);
      await crossThreshold(pi, ctx, 90_000, 110_000);
      assert.equal(ctx.compactCalls.length, 1, "a project compaction.enabled=false disables it even if global is on");

      await pi.commands.get("trigger-compact").handler("", ctx);
      assert.equal(ctx.compactCalls.length, 2, "manual /trigger-compact always works");

      const statusCtx = { ...fakeCtx(), cwd: ws };
      await pi.commands.get("compact-threshold").handler("status", statusCtx);
      assert.match(statusCtx.notices.at(-1).msg, /OFF \(pi auto-compaction is disabled/);
    } finally {
      rmWorkspace(ws);
    }
  });
}

async function testKitOffSwitch() {
  await withAgentDir(async () => {
    const pi = fakePi();
    (await loadExtension("vendor/trigger-compact/index.ts"))(pi.api);
    const ctx = fakeCtx();
    await pi.commands.get("compact-threshold").handler("300k", ctx);
    await pi.commands.get("compact-threshold").handler("off", ctx);
    await crossThreshold(pi, ctx, 290_000, 310_000);
    assert.equal(ctx.compactCalls.length, 0, "/compact-threshold off stops the trigger");
    await pi.commands.get("compact-threshold").handler("reset", ctx);
    await crossThreshold(pi, ctx, 90_000, 110_000);
    assert.equal(ctx.compactCalls.length, 0, "reset restores the default threshold but keeps the trigger off");
    await pi.commands.get("compact-threshold").handler("on", ctx);
    await crossThreshold(pi, ctx, 90_000, 110_000);
    assert.equal(ctx.compactCalls.length, 1, "/compact-threshold on re-enables it");
  });
}

const tests = [
  ["pi compaction.enabled (global/project) gates auto-compaction; manual still works", testRespectsPiAutoCompactionSetting],
  ["/compact-threshold off|on toggles the trigger and survives reset", testKitOffSwitch],
  ["built-in 100k default applies and is reported as such", testDefaultThreshold],
  ["env var overrides the default and locks the TUI command", testEnvOverrideLocksCommand],
  ["/compact-threshold persists and a fresh module load honors it", testCommandPersistsAndReloads],
  ["a threshold at/above the context window is rejected, not saved", testRejectsThresholdAtOrAboveContextWindow],
  ["/compact-threshold reset clears the saved override", testReset],
  ["a corrupt `null` settings file falls back to the 100k default", testNullSettingsFileFallsBackToDefault],
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
  console.error(`\n[trigger-compact-threshold-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[trigger-compact-threshold-smoke] all ${tests.length} checks passed`);
