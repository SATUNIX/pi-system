#!/usr/bin/env node
/**
 * Offline checks for extensions/save: /save writes a snapshot to disk without
 * compacting, resolves vault projects safely, redacts secrets, queues the
 * memory-update prompt, and copies real compaction summaries to the same log.
 * The summarizer is injected, so no model call runs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadModule, fakePi, setEnv, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.mjs";

// Hermetic: /save falls back to the memory vault (~/.pi/vault) when it exists, so point that
// at a path that never exists unless a test sets PI_KIT_SAVE_VAULT itself.
process.env.PI_KIT_VAULT = path.join(process.env.TMPDIR || "/tmp", `pi-kit-save-smoke-no-vault-${process.pid}`);
const mod = await loadModule("extensions/save/index.ts");
const FIXED = new Date("2026-09-14T05:06:07Z");

function setup({ summary = "## Goal\nShip /save.\n\n## Next Steps\n1. Test it.", fail, gate } = {}) {
  const pi = fakePi();
  const calls = [];
  const jobs = [];
  // Every handler call runs through run(), which also awaits the background job.
  pi.run = async (args, ctx) => {
    await pi.commands.get("save").handler(args, ctx);
    await Promise.all(jobs.splice(0));
  };
  mod.registerSave(pi.api, {
    onJob: (job) => jobs.push(job),
    summarize: async (_ctx, instructions, signal) => {
      calls.push({ instructions, signal });
      if (gate) await gate;
      if (fail) throw new Error(fail);
      return summary;
    },
    now: () => FIXED,
  });
  return { pi, calls };
}

function fakeCtx(cwd, { hasUI = true, idle = true, select } = {}) {
  const notes = [];
  return {
    cwd,
    hasUI,
    notes,
    model: { provider: "pentest", id: "qwen3.8-27b" },
    isIdle: () => idle,
    getContextUsage: () => ({ tokens: 51234 }),
    sessionManager: { getSessionFile: () => path.join(cwd, "session.jsonl"), getEntries: () => [], getLeafId: () => null },
    ui: { notify: (message, level) => notes.push({ message, level }), select: select ?? (async () => undefined) },
    compact: () => { throw new Error("/save must never compact"); },
  };
}

function withVault(fn) {
  return async () => {
    const ws = tmpWorkspace("pi-kit-save-");
    const vault = path.join(ws, "vault");
    for (const p of ["Pi Agent Kit", "GitLab Migration"]) fs.mkdirSync(path.join(vault, "10_Projects", p), { recursive: true });
    const restores = [setEnv("PI_KIT_SAVE_VAULT", vault), setEnv("PI_KIT_SAVE_PROJECT", undefined), setEnv("PI_KIT_SAVE_DIR", undefined)];
    try { await fn(ws, vault); } finally { restores.reverse().forEach((r) => r()); rmWorkspace(ws); }
  };
}

function withoutVault(fn) {
  return async () => {
    const ws = tmpWorkspace("pi-kit-save-local-");
    const restores = [setEnv("PI_KIT_SAVE_VAULT", undefined), setEnv("PI_KIT_SAVE_PROJECT", undefined), setEnv("PI_KIT_SAVE_DIR", undefined)];
    try { await fn(ws); } finally { restores.reverse().forEach((r) => r()); rmWorkspace(ws); }
  };
}

const testParseArgs = async () => {
  assert.deepEqual(mod.parseArgs(`--project "Pi Agent Kit" --no-update check the TTL fix`), { project: "Pi Agent Kit", update: false, note: "check the TTL fix" });
  assert.deepEqual(mod.parseArgs("--project=Fabric"), { project: "Fabric", note: "" });
  assert.deepEqual(mod.parseArgs(""), { note: "" });
};

const testSaveToVaultProjectWithoutCompacting = withVault(async (ws, vault) => {
  const { pi, calls } = setup();
  const ctx = fakeCtx(ws);
  await pi.run(`--project "pi agent kit" halfway through tests`, ctx);
  const dir = path.join(vault, "10_Projects", "Pi Agent Kit");
  const latest = path.join(dir, "Latest Compact.md");
  const log = path.join(dir, "Compacts", "2026-09-14 " + stampLocal(FIXED) + " - save.md");
  assert.ok(fs.existsSync(latest), `latest written: ${ctx.notes.map((n) => n.message).join(" | ")}`);
  assert.ok(fs.existsSync(log), "log written");
  const text = fs.readFileSync(latest, "utf8");
  assert.equal(text, fs.readFileSync(log, "utf8"));
  assert.match(text, /^---\nkind: save\nsaved: 2026-09-14T05:06:07.000Z\nproject: "Pi Agent Kit"\n/);
  assert.match(text, /model: "pentest\/qwen3.8-27b"\ncontext_tokens: 51234\nnote: "halfway through tests"\n---/);
  assert.match(text, /The conversation was not compacted/);
  assert.match(text, /## Goal\nShip \/save\./);
  assert.match(calls[0].instructions, /check-in snapshot[\s\S]*Operator note: halfway through tests/);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(pi.steers.length, 1, "queues one memory-update prompt for a vault project");
  assert.match(pi.steers[0].message, /Current State\.md/);
  assert.equal(pi.steers[0].opts, undefined, "idle agent gets a normal prompt");
});

const testFollowUpWhenBusyAndNoUpdateFlag = withVault(async (ws) => {
  const { pi } = setup();
  await pi.run(`--project Fabric`, fakeCtx(ws)).catch(() => {});
  assert.equal(pi.steers.length, 0, "unknown project writes nothing and prompts nothing");

  fs.mkdirSync(path.join(process.env.PI_KIT_SAVE_VAULT, "10_Projects", "Fabric"));
  await pi.run(`--project Fabric`, fakeCtx(ws, { idle: false }));
  assert.deepEqual(pi.steers[0].opts, { deliverAs: "followUp" }, "busy agent gets a follow-up, never an error");

  await pi.run(`--project Fabric --no-update`, fakeCtx(ws));
  assert.equal(pi.steers.length, 1, "--no-update skips the prompt");
});

const testUnknownProjectAndTraversalRejected = withVault(async (ws) => {
  const { pi } = setup();
  const ctx = fakeCtx(ws);
  await pi.run(`--project "Pi Agent"`, ctx);
  assert.match(ctx.notes.at(-1).message, /nothing written - project "Pi Agent" does not exist .*Close matches: Pi Agent Kit/);
  assert.throws(() => mod.resolveTarget(ws, "../../etc"), /invalid project name/);
});

const testPickerAndLocalFallback = withVault(async (ws) => {
  const { pi } = setup();
  let offered;
  const ctx = fakeCtx(ws, { select: async (_t, options) => { offered = options; return options[0]; } });
  await pi.run("", ctx);
  assert.deepEqual(offered.slice(1), ["GitLab Migration", "Pi Agent Kit"], "picker lists vault projects");
  assert.ok(fs.existsSync(path.join(ws, ".pi", "snapshots", "Latest Compact.md")), "local choice writes to the workspace");
  assert.equal(pi.steers.length, 0, "no project -> no update prompt by default");
});

const testLocalDefaultWithoutVault = withoutVault(async (ws) => {
  const { pi } = setup();
  const ctx = fakeCtx(ws, { hasUI: false });
  await pi.run("--update", ctx);
  assert.ok(fs.existsSync(path.join(ws, ".pi", "snapshots", "Latest Compact.md")));
  assert.equal(pi.steers.length, 1, "--update forces the prompt");
});

const testSummarizerFailureWritesNothing = withoutVault(async (ws) => {
  const { pi } = setup({ fail: "no request auth for pentest" });
  const ctx = fakeCtx(ws);
  await pi.run("", ctx);
  assert.equal(fs.existsSync(path.join(ws, ".pi", "snapshots")), false);
  assert.match(ctx.notes.at(-1).message, /nothing written - no request auth/);
  assert.equal(ctx.notes.at(-1).level, "error");
});

const testRedactsSecrets = async () => {
  const text = mod.renderSnapshot(
    "token: glpat-ABCDEFGHIJKLMNOPQRST and AKIAABCDEFGHIJKLMNOP\npassword=hunter2hunter2\nkeep 10.10.0.13",
    { kind: "save", when: FIXED, cwd: "/w" },
  );
  assert.doesNotMatch(text, /glpat-|AKIAABCD|hunter2/);
  assert.match(text, /password=\[REDACTED\]/);
  assert.match(text, /keep 10\.10\.0\.13/, "normal detail survives");
};

const testCopiesCompactionSummaries = withVault(async (ws, vault) => {
  const { pi } = setup();
  const restore = setEnv("PI_KIT_SAVE_PROJECT", "GitLab Migration");
  try {
    const hook = pi.handlers.get("session_compact");
    await hook({ compactionEntry: { summary: "NATIVE_SUMMARY", details: { readFiles: [] } } }, fakeCtx(ws));
    const dir = path.join(vault, "10_Projects", "GitLab Migration");
    assert.match(fs.readFileSync(path.join(dir, "Latest Compact.md"), "utf8"), /kind: compact[\s\S]*Copied from a compaction summary[\s\S]*NATIVE_SUMMARY/);
    await hook({ compactionEntry: { summary: "COMPRESSED", details: { compressor: "pi-kit-compress" } } }, fakeCtx(ws));
    const logs = fs.readdirSync(path.join(dir, "Compacts")).sort();
    assert.deepEqual(logs.map((f) => f.replace(/^\S+ \d+ - /, "")), ["compact.md", "compress.md"]);
    assert.match(fs.readFileSync(path.join(dir, "Latest Compact.md"), "utf8"), /COMPRESSED/, "latest is the newest");

    const off = setEnv("PI_KIT_SAVE_ON_COMPACT", "0");
    try {
      await hook({ compactionEntry: { summary: "IGNORED" } }, fakeCtx(ws));
      assert.doesNotMatch(fs.readFileSync(path.join(dir, "Latest Compact.md"), "utf8"), /IGNORED/);
    } finally { off(); }
  } finally { restore(); }
});

const testInteractiveRunsInBackgroundHeadlessWaits = withoutVault(async (ws) => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { pi } = setup({ gate });
  const latest = path.join(ws, ".pi", "snapshots", "Latest Compact.md");

  const ui = fakeCtx(ws);
  await pi.commands.get("save").handler("", ui);
  assert.equal(fs.existsSync(latest), false, "interactive handler returns before the summary finishes");
  assert.match(ui.notes.at(-1).message, /in the background/);

  const second = fakeCtx(ws);
  await pi.commands.get("save").handler("", second);
  assert.match(second.notes.at(-1).message, /a save is already running/, "no parallel saves");

  release();
  // This call can hit the running guard. run() still awaits the first background job.
  await pi.run("", fakeCtx(ws, { hasUI: false }));
  assert.ok(fs.existsSync(latest), "background job writes after the summary resolves");

  const { pi: headless } = setup();
  const ws2 = path.join(ws, "headless");
  await headless.commands.get("save").handler("", fakeCtx(ws2, { hasUI: false }));
  assert.ok(fs.existsSync(path.join(ws2, ".pi", "snapshots", "Latest Compact.md")), "headless handler waits for the write");
});

const testSameSecondDoesNotOverwriteLog = withoutVault(async (ws) => {
  const { pi } = setup();
  await pi.run("", fakeCtx(ws));
  await pi.run("", fakeCtx(ws));
  assert.equal(fs.readdirSync(path.join(ws, ".pi", "snapshots", "Compacts")).length, 2);
});

function stampLocal(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const tests = {
  testParseArgs,
  testSaveToVaultProjectWithoutCompacting,
  testFollowUpWhenBusyAndNoUpdateFlag,
  testUnknownProjectAndTraversalRejected,
  testPickerAndLocalFallback,
  testLocalDefaultWithoutVault,
  testSummarizerFailureWritesNothing,
  testRedactsSecrets,
  testCopiesCompactionSummaries,
  testInteractiveRunsInBackgroundHeadlessWaits,
  testSameSecondDoesNotOverwriteLog,
};
let failed = 0;
for (const [name, t] of Object.entries(tests)) {
  try {
    await t();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n${err.stack}`);
  }
}
const total = Object.keys(tests).length;
if (failed) {
  console.error(`save-smoke: ${failed}/${total} failed`);
  process.exit(1);
}
console.log(`save-smoke: ${total}/${total} passed`);
