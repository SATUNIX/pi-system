#!/usr/bin/env node
/**
 * Offline checks for extensions/compress: /compress builds a deterministic
 * summary with no model call, leaves /compact and auto-compaction untouched,
 * fits its budget, and cancels instead of falling back to the LLM summarizer.
 */
import assert from "node:assert/strict";
import { loadModule, fakePi, setEnv } from "../packages/core/eval/harness.mjs";

const mod = await loadModule("extensions/compress/index.ts");
const { COMPRESS_MARKER, buildCompressedSummary } = mod;

function load() {
  const pi = fakePi();
  mod.default(pi.api);
  return pi;
}

// Drives the real command handler through a fake ctx.compact that behaves like
// pi's AgentSession.compact(): emit session_before_compact, honour cancel.
function fakeCtx(pi, preparation, branchEntries = []) {
  const notes = [];
  const ctx = {
    hasUI: true,
    ui: { notify: (message, level) => notes.push({ message, level }) },
    compact: (opts) => {
      ctx.done = (async () => {
        const event = { type: "session_before_compact", preparation, branchEntries, customInstructions: opts.customInstructions };
        ctx.event = event;
        const result = await pi.handlers.get("session_before_compact")(event);
        ctx.result = result;
        if (result?.cancel) return opts.onError(new Error("Compaction cancelled"));
        if (!result?.compaction) return opts.onError(new Error("fell through to native LLM compaction"));
        opts.onComplete(result.compaction);
      })();
    },
  };
  ctx.notes = notes;
  return ctx;
}

const BIG_OUTPUT = "SECRET_TOOL_OUTPUT ".repeat(5000);

function sampleMessages() {
  return [
    { role: "user", content: "Build a cache layer for the API client and add tests." },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "PRIVATE_REASONING about options" },
        { type: "text", text: "I will read the client first." },
        { type: "toolCall", id: "t1", name: "read", arguments: { path: "src/client.ts" } },
      ],
    },
    { role: "toolResult", toolCallId: "t1", toolName: "read", isError: false, content: [{ type: "text", text: BIG_OUTPUT }] },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "t2", name: "edit", arguments: { path: "src/cache.ts", oldText: "a", newText: "b" } },
        { type: "toolCall", id: "t3", name: "bash", arguments: { command: "npm test -- cache" } },
      ],
    },
    { role: "toolResult", toolCallId: "t2", toolName: "edit", isError: false, content: [{ type: "text", text: "ok" }] },
    { role: "toolResult", toolCallId: "t3", toolName: "bash", isError: true, content: [{ type: "text", text: "1 failing" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "Added an LRU cache.\n```ts\nconst a = 1;\nconst b = 2;\n```\nOne test still fails on TTL expiry." }],
    },
    { role: "bashExecution", command: "git status", output: "clean", exitCode: 0, cancelled: false, truncated: false },
    { role: "user", content: [{ type: "text", text: "Fix the TTL test." }, { type: "image", data: "x", mimeType: "image/png" }] },
    { role: "assistant", content: [{ type: "text", text: "Fixed: the clock mock was not advanced." }] },
  ];
}

function preparationFor(messages, extra = {}) {
  return {
    firstKeptEntryId: "entry-kept",
    messagesToSummarize: messages,
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 48000,
    previousSummary: undefined,
    fileOps: { read: new Set(["src/client.ts"]), written: new Set(), edited: new Set(["src/cache.ts"]) },
    settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
    ...extra,
  };
}

async function testIgnoresNativeCompaction() {
  const pi = load();
  const hook = pi.handlers.get("session_before_compact");
  const prep = preparationFor(sampleMessages());
  assert.equal(await hook({ preparation: prep, customInstructions: undefined }), undefined, "auto-compaction and bare /compact stay native");
  assert.equal(await hook({ preparation: prep, customInstructions: "focus on the cache" }), undefined, "/compact <text> stays native");
}

async function testCommandBuildsDeterministicSummary() {
  const pi = load();
  const prep = preparationFor(sampleMessages());
  const ctx = fakeCtx(pi, prep);
  await pi.commands.get("compress").handler("keep the TTL decision", ctx);
  await ctx.done;
  assert.ok(ctx.event.customInstructions.startsWith(COMPRESS_MARKER), "command tags its own compaction");
  const c = ctx.result.compaction;
  assert.equal(c.firstKeptEntryId, "entry-kept", "reuses pi's cut point");
  assert.equal(c.tokensBefore, 48000);
  const s = c.summary;
  assert.match(s, /Build a cache layer/, "keeps the user ask");
  assert.match(s, /Fix the TTL test\. \[image\]/, "keeps later asks, marks images");
  assert.match(s, /One test still fails on TTL expiry/, "keeps assistant replies");
  assert.match(s, /\[code: ts, 2 lines\]/, "replaces code blocks");
  assert.doesNotMatch(s, /const a = 1/, "drops code body");
  assert.doesNotMatch(s, /SECRET_TOOL_OUTPUT/, "drops tool output");
  assert.doesNotMatch(s, /PRIVATE_REASONING/, "drops thinking");
  assert.match(s, /Tools: read, edit, bash · 1 failed \(bash\) · files: src\/client\.ts, src\/cache\.ts · ran: `npm test -- cache`/);
  assert.match(s, /User ran `git status` \(exit 0\)/);
  assert.match(s, /## Operator note\nkeep the TTL decision/);
  assert.match(s, /<read-files>\nsrc\/client\.ts\n<\/read-files>/);
  assert.match(s, /<modified-files>\nsrc\/cache\.ts\n<\/modified-files>/);
  assert.deepEqual(c.details, {
    compressor: "pi-kit-compress", version: 1, readFiles: ["src/client.ts"], modifiedFiles: ["src/cache.ts"], turns: 2, omittedTurns: 0,
  });
  assert.ok(s.length < 2500, `summary is small (${s.length} chars)`);
  assert.equal(buildCompressedSummary(ctx.event, "keep the TTL decision").summary, s, "same input, same output");
  assert.match(ctx.notes.at(-1).message, /^compress: 2 turns -> \d+ chars \(was ~48000 tokens/);
}

async function testBudgetKeepsFirstAndNewestTurns() {
  const restore = setEnv("PI_KIT_COMPRESS_MAX_CHARS", "4000");
  try {
    const messages = [];
    for (let i = 1; i <= 200; i++) {
      messages.push({ role: "user", content: `ASK_${i} ${"detail ".repeat(40)}` });
      messages.push({ role: "assistant", content: [{ type: "text", text: `REPLY_${i} ${"words ".repeat(60)}` }] });
    }
    const { summary, details } = buildCompressedSummary({
      preparation: preparationFor(messages, { previousSummary: "PRIOR ".repeat(2000), fileOps: undefined }),
    });
    assert.ok(summary.length <= 4000, `fits the budget (${summary.length})`);
    assert.match(summary, /ASK_1 /, "turn 1 always kept");
    assert.match(summary, /ASK_200 /, "newest turn kept");
    assert.doesNotMatch(summary, /ASK_100 /, "middle turns dropped");
    assert.match(summary, new RegExp(`\\[… ${details.omittedTurns} older turns omitted`));
    assert.equal(details.turns, 200);
    assert.ok(details.omittedTurns > 150);
    assert.match(summary, /## Earlier summary\nPRIOR/, "earlier summary kept, clipped");
  } finally { restore(); }
}

async function testRefusesWhenNothingToCompress() {
  const pi = load();
  const ctx = fakeCtx(pi, preparationFor([]));
  await pi.commands.get("compress").handler("", ctx);
  await ctx.done;
  assert.equal(ctx.result?.cancel, true, "cancels instead of writing an empty summary");
  assert.match(ctx.notes.at(-1).message, /not compacted - nothing older than the kept recent window/);
}

async function testBuildFailureCancelsInsteadOfFallingBack() {
  const pi = load();
  const prep = preparationFor(sampleMessages());
  Object.defineProperty(prep, "fileOps", { get() { throw new Error("boom"); } });
  const ctx = fakeCtx(pi, prep);
  await pi.commands.get("compress").handler("", ctx);
  await ctx.done;
  assert.equal(ctx.result?.cancel, true, "never lets pi run the LLM summarizer with the marker");
  assert.match(ctx.notes.at(-1).message, /summary build failed: boom/);
}

async function testCarriesFileListsAcrossCompressions() {
  const branchEntries = [
    { type: "message", id: "a" },
    { type: "compaction", id: "c1", fromHook: true, details: { compressor: "pi-kit-compress", readFiles: ["docs/old.md"], modifiedFiles: ["src/old.ts"] } },
  ];
  const { details } = buildCompressedSummary({ preparation: preparationFor(sampleMessages()), branchEntries });
  assert.deepEqual(details.readFiles, ["docs/old.md", "src/client.ts"]);
  assert.deepEqual(details.modifiedFiles, ["src/cache.ts", "src/old.ts"]);
}

async function testSplitTurnPrefixIsIncluded() {
  const prefix = [
    { role: "user", content: "PREFIX_ASK refactor everything" },
    { role: "assistant", content: [{ type: "toolCall", id: "p", name: "read", arguments: { path: "a.ts" } }] },
  ];
  const { summary } = buildCompressedSummary({
    preparation: preparationFor([], { isSplitTurn: true, turnPrefixMessages: prefix }),
  });
  assert.match(summary, /### Turn 1 \(continues in the kept messages below\)\nUser: PREFIX_ASK/);
}

async function testIsFast() {
  const messages = [];
  for (let i = 0; i < 5000; i++) {
    messages.push({ role: "user", content: `ask ${i}` });
    messages.push({ role: "assistant", content: [{ type: "text", text: "reply" }, { type: "toolCall", id: `${i}`, name: "bash", arguments: { command: "ls" } }] });
    messages.push({ role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: BIG_OUTPUT.slice(0, 20000) }] });
  }
  const started = performance.now();
  buildCompressedSummary({ preparation: preparationFor(messages) });
  const ms = performance.now() - started;
  assert.ok(ms < 2000, `15k messages compress in ${ms.toFixed(0)} ms`);
}

const tests = [
  testIgnoresNativeCompaction,
  testCommandBuildsDeterministicSummary,
  testBudgetKeepsFirstAndNewestTurns,
  testRefusesWhenNothingToCompress,
  testBuildFailureCancelsInsteadOfFallingBack,
  testCarriesFileListsAcrossCompressions,
  testSplitTurnPrefixIsIncluded,
  testIsFast,
];
let failed = 0;
for (const t of tests) {
  try {
    await t();
    console.log(`  ok  ${t.name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${t.name}\n${err.stack}`);
  }
}
if (failed) {
  console.error(`compress-smoke: ${failed}/${tests.length} failed`);
  process.exit(1);
}
console.log(`compress-smoke: ${tests.length}/${tests.length} passed`);
