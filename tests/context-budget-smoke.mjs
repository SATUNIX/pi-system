#!/usr/bin/env node
/**
 * AG-07 regression coverage (the narrow contribution-budgeting mechanism, not the
 * broader unimplemented "budgets the whole prompt" claim). Fully offline — no live pi,
 * no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, loadModule, fakePi, tmpWorkspace, rmWorkspace, setEnv } from "../packages/core/eval/harness.mjs";

const sieveModule = await loadModule("extensions/context-sieve/index.ts");

async function loadSieve(ws) {
  const register = await loadExtension("extensions/context-sieve/index.ts");
  const pi = fakePi();
  register(pi.api);
  await pi.handlers.get("session_start")({}, { cwd: ws });
  return pi;
}

function writeContrib(ws, id, priority, budgetTokens, content) {
  const dir = path.join(ws, ".pi", "ctx-contributions");
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ id, priority, budgetTokens, content }));
}

// Independent repro: PI_KIT_CTX_BUDGET_TOKENS set to a non-numeric value previously
// parsed to NaN, and `used + len > NaN` is always false in JS, so budgeting silently
// disabled itself (everything included, unbounded) instead of falling back to a safe
// default.
async function testInvalidBudgetEnvFallsBackToDefault() {
  const ws = tmpWorkspace("pi-kit-ctxbudget-nan-");
  const restore = setEnv("PI_KIT_CTX_BUDGET_TOKENS", "not-a-number");
  try {
    const pi = await loadSieve(ws);
    // A contribution far larger than the real default budget (4096 tokens / ~16KB).
    writeContrib(ws, "huge", 5, 999999, "x".repeat(200000));
    await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
    const budget = JSON.parse(fs.readFileSync(path.join(ws, ".pi", "ctx-contributions", "sieve-budget.json"), "utf8"));
    assert.ok(budget.budget > 0 && Number.isFinite(budget.budget), "an invalid env value must fall back to a real positive default, not NaN");
    assert.ok(budget.totalTokens < 200000, "budgeting must actually be enforced, not silently disabled");
  } finally {
    restore();
    rmWorkspace(ws);
  }
}

// A contribution's own declared budgetTokens must be respected even when the global
// budget has plenty of room left.
async function testPerContributionBudgetEnforced() {
  const ws = tmpWorkspace("pi-kit-ctxbudget-own-");
  const restore = setEnv("PI_KIT_CTX_BUDGET_TOKENS", "100000"); // plenty of global room
  try {
    const pi = await loadSieve(ws);
    writeContrib(ws, "capped", 5, 50, "y".repeat(5000)); // own budget: 50 tokens = 200 chars
    const result = await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
    const includedLen = result.systemPrompt.length - "base\n\n".length;
    assert.ok(includedLen < 5000, "a contribution's own declared budgetTokens must cap it even with global room to spare");
    const budget = JSON.parse(fs.readFileSync(path.join(ws, ".pi", "ctx-contributions", "sieve-budget.json"), "utf8"));
    assert.deepEqual(budget.truncated, ["capped"]);
  } finally {
    restore();
    rmWorkspace(ws);
  }
}

// A contribution that mostly fits should be truncated to use the remaining budget, not
// dropped wholesale when only a small amount is over.
async function testTruncationInsteadOfWholesaleDrop() {
  const ws = tmpWorkspace("pi-kit-ctxbudget-trunc-");
  const restore = setEnv("PI_KIT_CTX_BUDGET_TOKENS", "100"); // 400 chars total
  try {
    const pi = await loadSieve(ws);
    writeContrib(ws, "a", 10, 1000, "a".repeat(100)); // fits fully
    writeContrib(ws, "b", 5, 1000, "b".repeat(500)); // would have been dropped wholesale before
    await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
    const budget = JSON.parse(fs.readFileSync(path.join(ws, ".pi", "ctx-contributions", "sieve-budget.json"), "utf8"));
    assert.ok(budget.included.includes("b"), "a contribution that mostly fits must be truncated into the summary, not dropped entirely");
    assert.ok(budget.truncated.includes("b"));
  } finally {
    restore();
    rmWorkspace(ws);
  }
}

// A contribution a producer re-writes with byte-identical content during the current
// session (goal-core re-materializes a surviving goal right after context-sieve's
// session_start handler, guidelines likewise) must still be included: it was written
// this session, even though its bytes match the session-start snapshot.
async function testRewrittenIdenticalContributionIsIncluded() {
  const ws = tmpWorkspace("pi-kit-ctxbudget-rewrite-");
  try {
    const dir = path.join(ws, ".pi", "ctx-contributions");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "goal-core.json");
    const body = JSON.stringify({ id: "goal-core", priority: 85, budgetTokens: 400, content: "## Active Goal\nShip it" });
    // Pre-existing from a prior session: captured by context-sieve's session_start snapshot.
    fs.writeFileSync(file, body);
    // Realistic leftover: an old mtime beyond the epoch grace window.
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(file, old, old);
    const pi = await loadSieve(ws);
    // Producer re-materializes the identical contribution during session_start.
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(file, body);
    const result = await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
    assert.ok(result && /Active Goal/.test(result.systemPrompt), "a re-written identical contribution must enter the prompt this session");
  } finally {
    rmWorkspace(ws);
  }
}

// Compaction leaves native summarization intact; current contributions still
// use the ordinary sorted, budgeted prompt assembly.
async function testCompactionContributionsAreSortedAndBudgeted() {
  const ws = tmpWorkspace("pi-kit-ctxbudget-compact-");
  const restore = setEnv("PI_KIT_CTX_BUDGET_TOKENS", "50"); // 200 chars total
  try {
    const pi = await loadSieve(ws);
    const dir = path.join(ws, ".pi", "ctx-contributions");
    fs.writeFileSync(path.join(dir, "low.json"), JSON.stringify({ id: "low", priority: 1, budgetTokens: 1000, content: "LOW_PRIORITY_MARKER" }));
    fs.writeFileSync(path.join(dir, "high.json"), JSON.stringify({ id: "high", priority: 99, budgetTokens: 1000, content: "HIGH_PRIORITY_MARKER" }));
    const result = await pi.handlers.get("session_before_compact")({
      preparation: { messagesToSummarize: [], firstKeptEntryId: "e1", tokensBefore: 1 },
    });
    assert.equal(result, undefined, "compaction must preserve the native summarizer");
    const prompt = await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
    const highIdx = prompt.systemPrompt.indexOf("HIGH_PRIORITY_MARKER");
    const lowIdx = prompt.systemPrompt.indexOf("LOW_PRIORITY_MARKER");
    assert.ok(highIdx >= 0 && (lowIdx === -1 || highIdx < lowIdx), "current contributions remain sorted and budgeted in prompt assembly");
  } finally {
    restore();
    rmWorkspace(ws);
  }
}

// Cache-friendly injection: per-turn contributions (memory recall, delegation directives)
// go into one hidden message, not the system prompt, so the provider's prompt cache survives;
// an unchanged block is not re-injected; compaction re-arms it.
async function testDynamicContributionsUseMessageChannel() {
  const ws = tmpWorkspace("pi-kit-ctxbudget-channel-");
  try {
    const pi = await loadSieve(ws);
    writeContrib(ws, "guidelines", 10, 500, "STATIC GUIDELINES");
    writeContrib(ws, "memory-local", 60, 400, "RECALLED MEMORY");
    const dir = path.join(ws, ".pi", "ctx-contributions");
    fs.writeFileSync(path.join(dir, "custom.json"), JSON.stringify({ id: "custom", priority: 5, budgetTokens: 100, content: "EXPLICIT MESSAGE", channel: "message" }));
    const r1 = await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
    assert.match(r1.systemPrompt, /STATIC GUIDELINES/);
    assert.doesNotMatch(r1.systemPrompt, /RECALLED MEMORY/, "dynamic content must not rewrite the system prompt");
    assert.equal(r1.message.display, false);
    assert.match(r1.message.content, /RECALLED MEMORY[\s\S]*EXPLICIT MESSAGE/, "message-channel blocks are merged by priority");
    const r2 = await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
    assert.equal(r2.message, undefined, "an unchanged block is not injected twice");
    assert.equal(r2.systemPrompt, r1.systemPrompt, "the system prompt stays byte-identical across turns");
    writeContrib(ws, "memory-local", 60, 400, "DIFFERENT MEMORY");
    const r3 = await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
    assert.match(r3.message.content, /DIFFERENT MEMORY/);
    await pi.handlers.get("session_compact")({}, { cwd: ws });
    const r4 = await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
    assert.match(r4.message.content, /DIFFERENT MEMORY/, "after compaction the block is injected again");
  } finally {
    rmWorkspace(ws);
  }
}

// Equal-priority contributions must be ordered by id (deterministic), and higher priority
// must still sort first.
async function testEqualPriorityOrderedById() {
  const { compareContributions } = sieveModule;
  assert.ok(compareContributions({ id: "b", priority: 5 }, { id: "a", priority: 5 }) > 0, "equal priority must order by id ascending");
  assert.ok(compareContributions({ id: "a", priority: 5 }, { id: "b", priority: 5 }) < 0, "the reverse comparison must be negative");
  assert.ok(compareContributions({ id: "a", priority: 9 }, { id: "b", priority: 1 }) < 0, "higher priority must still sort first");
}

// A non-finite/absent priority is coerced to 0 rather than dropped or producing NaN ordering.
async function testNonFinitePriorityNormalisedToZero() {
  const { normalizeContribution } = sieveModule;
  assert.equal(normalizeContribution({ id: "x", content: "y", priority: "high", budgetTokens: 1 }).priority, 0);
  assert.equal(normalizeContribution({ id: "x", content: "y", priority: 7, budgetTokens: 1 }).priority, 7);
  assert.equal(normalizeContribution({ id: "", content: "y", priority: 1 }), null, "an empty id must be rejected");
  assert.equal(normalizeContribution({ id: "x", content: 5, priority: 1 }), null, "a non-string content must be rejected");
}

// A contribution file larger than MAX_CONTRIBUTION_BYTES is skipped before JSON.parse, so its
// marker never reaches the prompt while a small valid sibling is still included.
async function testOversizedContributionFileSkippedBeforeParse() {
  const ws = tmpWorkspace("pi-kit-ctxbudget-oversize-");
  const restore = setEnv("PI_KIT_CTX_BUDGET_TOKENS", "1000000");
  try {
    const pi = await loadSieve(ws);
    const { MAX_CONTRIBUTION_BYTES } = sieveModule;
    writeContrib(ws, "small", 5, 1000, "SMALL_MARKER");
    const dir = path.join(ws, ".pi", "ctx-contributions");
    const oversized = "OVERSIZED_MARKER" + "x".repeat(MAX_CONTRIBUTION_BYTES);
    fs.writeFileSync(path.join(dir, "oversized.json"), JSON.stringify({ id: "oversized", priority: 1, budgetTokens: 1000, content: oversized }));
    assert.ok(fs.statSync(path.join(dir, "oversized.json")).size > MAX_CONTRIBUTION_BYTES, "the oversized fixture must exceed the cap");
    const result = await pi.handlers.get("before_agent_start")({ systemPrompt: "base" });
    assert.match(result.systemPrompt, /SMALL_MARKER/);
    assert.doesNotMatch(result.systemPrompt, /OVERSIZED_MARKER/, "an oversized contribution file must be skipped before parse");
  } finally {
    restore();
    rmWorkspace(ws);
  }
}

const tests = [
  ["an invalid budget env value falls back to a real default, not NaN", testInvalidBudgetEnvFallsBackToDefault],
  ["a contribution's own declared budgetTokens is enforced", testPerContributionBudgetEnforced],
  ["a mostly-fitting contribution is truncated, not dropped wholesale", testTruncationInsteadOfWholesaleDrop],
  ["a re-written identical contribution is still included this session", testRewrittenIdenticalContributionIsIncluded],
  ["native compaction preserves sorted/budgeted current prompt contributions", testCompactionContributionsAreSortedAndBudgeted],
  ["per-turn contributions use a deduplicated message, keeping the system prompt stable", testDynamicContributionsUseMessageChannel],
  ["equal-priority contributions are ordered by id, not directory order", testEqualPriorityOrderedById],
  ["a non-finite priority is normalised to 0", testNonFinitePriorityNormalisedToZero],
  ["an oversized contribution file is skipped before parse", testOversizedContributionFileSkippedBeforeParse],
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
  console.error(`\n[context-budget-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[context-budget-smoke] all ${tests.length} checks passed`);
