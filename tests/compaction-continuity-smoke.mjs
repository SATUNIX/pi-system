#!/usr/bin/env node
/**
 * Offline compaction containment checks: preserve the native compactor's full
 * prepared input and do not delete/import another session's startup directives.
 * Native model-generated summary quality is outside this no-inference test.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace, setEnv } from "../packages/core/eval/harness.mjs";

function fakePreparation(overrides = {}) {
  return { messagesToSummarize: [], firstKeptEntryId: "entry-1", tokensBefore: 15000, ...overrides };
}

async function testNativeCompactionPreservesPreparedInput() {
  const ws = tmpWorkspace("pi-kit-native-compact-");
  try {
    const pi = fakePi();
    (await loadExtension("extensions/context-sieve/index.ts"))(pi.api);
    await pi.handlers.get("session_start")({}, { cwd: ws });
    fs.writeFileSync(path.join(ws, ".pi", "GOAL.yaml"), "goal: old goal\n");
    fs.writeFileSync(path.join(ws, ".pi", "ctx-contributions", "current.json"), JSON.stringify({
      id: "current", priority: 5, budgetTokens: 100, content: "Current handoff",
    }));
    const event = {
      customInstructions: "Preserve the operator correction",
      preparation: fakePreparation({ messagesToSummarize: [
        { role: "user", content: "Old hypothesis " + "x".repeat(12000) },
        { role: "user", content: "CORRECTION: stop implementation; report the blocker." },
      ] }),
    };
    const before = structuredClone(event);
    const result = await pi.handlers.get("session_before_compact")(event);
    assert.equal(result, undefined, "native summarizer must receive the full prepared transcript");
    assert.deepEqual(event, before, "do not mutate readonly compaction inputs or discard late corrections");
    const prompt = await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
    assert.match(prompt.systemPrompt, /Current handoff/, "current contributions remain available after compaction");
    assert.doesNotMatch(prompt.systemPrompt, /old goal/, "do not separately reimport unscoped GOAL.yaml");
  } finally { rmWorkspace(ws); }
}

async function testStartupPreservesForeignContributions() {
  const ws = tmpWorkspace("pi-kit-contribution-owner-");
  try {
    const dir = path.join(ws, ".pi", "ctx-contributions");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "orchestrator.json");
    const raw = JSON.stringify({ id: "orchestrator", content: "Parent private directive", priority: 1 });
    fs.writeFileSync(file, raw);
    // Genuine prior-session leftover: an old mtime well beyond the epoch grace window.
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(file, old, old);
    const pi = fakePi();
    (await loadExtension("extensions/context-sieve/index.ts"))(pi.api);
    await pi.handlers.get("session_start")({}, { cwd: ws });
    const orch = fakePi();
    (await loadExtension("extensions/orchestrator/index.ts"))(orch.api);
    await orch.handlers.get("session_start")({}, { cwd: ws });
    assert.equal(fs.readFileSync(file, "utf8"), raw, "child startup cannot delete parent state");
    assert.equal(await pi.handlers.get("before_agent_start")({ systemPrompt: "base" }), undefined,
      "unchanged preexisting directives must not be imported into child prompt");
  } finally { rmWorkspace(ws); }
}

async function testCustomCompactionUsesNativeFallback() {
  const ws = tmpWorkspace("pi-kit-compact-custom-");
  const templatePath = path.join(ws, "template.md");
  fs.writeFileSync(templatePath, "Preserve the deployment checklist above all else.");
  const restore = setEnv("PI_KIT_COMPACT_TEMPLATE", templatePath);
  try {
    const pi = fakePi();
    (await loadExtension("extensions/custom-compaction/index.ts"))(pi.api);
    const notices = [];
    await pi.handlers.get("session_start")({}, { cwd: ws, hasUI: true, ui: { notify: message => notices.push(message) } });
    assert.equal(notices.length, 1);
    assert.match(notices[0], /unsupported.*native summarization/);
    const event = {
      customInstructions: "Keep the latest correction",
      preparation: fakePreparation({ messagesToSummarize: [{ role: "user", content: "x".repeat(12000) + "LATEST CORRECTION" }] }),
    };
    const before = structuredClone(event);
    assert.equal(await pi.handlers.get("session_before_compact")(event), undefined);
    assert.deepEqual(event, before, "configured template must not remove later transcript state");
  } finally { restore(); rmWorkspace(ws); }
}

const tests = [
  ["native compaction receives full unchanged transcript and custom instructions", testNativeCompactionPreservesPreparedInput],
  ["startup preserves and excludes unchanged foreign contributions", testStartupPreservesForeignContributions],
  ["configured template falls back to native compaction with notice", testCustomCompactionUsesNativeFallback],
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
  console.error(`\n[compaction-continuity-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[compaction-continuity-smoke] all ${tests.length} checks passed`);
