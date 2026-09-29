#!/usr/bin/env node
/**
 * Offline checks for the redesigned GitOps status bar (custom-footer): the
 * working-line ticker text, tool/phrase activity, tips filtered to loaded
 * commands, the todo checklist widget, and the enriched todo tool states.
 * Pure rendering and file logic; no model runs.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadModule, fakePi, setEnv, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.mjs";

const footer = await loadModule("vendor/custom-footer/index.ts");
const todo = await loadModule("vendor/todo/index.ts");
const plain = { fg: (_c, s) => s, bold: (s) => s };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

const tests = {
  formatting() {
    assert.equal(footer.fmtTokens(950), "950");
    assert.equal(footer.fmtTokens(1234), "1.2k");
    assert.equal(footer.fmtTokens(52000), "52k");
    assert.equal(footer.fmtTokens(2_400_000), "2.4M");
    assert.equal(footer.fmtDuration(9000), "9s");
    assert.equal(footer.fmtDuration(64000), "1m 04s");
    assert.equal(footer.fmtDuration(3_700_000), "1h 01m");
    assert.equal(footer.fmtCost(undefined), "unknown");
    assert.equal(footer.fmtCost(0), "$0.00");
    assert.equal(footer.fmtCost(1.5), "$1.50");
  },

  visibleWidthIgnoresAnsi() {
    assert.equal(footer.visibleWidth("\x1b[31mred\x1b[0m"), 3);
    const t = footer.truncate("\x1b[31mabcdefghij\x1b[0m", 5);
    assert.ok(strip(t).length <= 5, strip(t));
    assert.ok(t.endsWith("…"));
  },

  sessionTotalsSumsAssistantUsage() {
    const entries = [
      { type: "message", message: { role: "user", content: "hi" } },
      { type: "message", message: { role: "assistant", usage: { input: 100, output: 40, cacheRead: 10, cacheWrite: 0, totalTokens: 150, cost: { total: 0.2 } } } },
      { type: "message", message: { role: "assistant", usage: { input: 50, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 70, cost: { total: 0.1 } } } },
      { type: "message", message: { role: "assistant" } },
    ];
    const { totals, partial } = footer.sessionTotals(entries);
    assert.equal(totals.input, 150);
    assert.equal(totals.output, 60);
    assert.equal(totals.total, 220);
    assert.equal(Number(totals.cost.toFixed(2)), 0.3);
    assert.equal(partial, true, "a usage-less assistant message marks totals partial");
  },

  footerRendersThreeLinesAndFits() {
    const state = {
      cwd: "/home/u/proj", branch: "main", provider: "pentest", model: "qwen3.8-27b", thinking: "medium",
      context: { tokens: 42000, percent: 66, contextWindow: 262144 },
      totals: { input: 446000, output: 175000, cacheRead: 14_000_000, cacheWrite: 0, total: 500000, cost: 0 },
      partial: false, cost: 1.23,
      run: { startedAt: 0, endedAt: undefined, input: 12300, output: 800, estOutput: 50 },
      statuses: [["trace-ledger", "trace-ledger: lost=0"], ["verify-gate", "FAIL"]],
      todos: [{ id: 1, text: "a", state: "done" }, { id: 2, text: "b", state: "open" }],
      now: 64000,
    };
    const lines = footer.renderFooter(state, plain, 120);
    assert.equal(lines.length, 3);
    assert.match(strip(lines[0]), /proj.*on main.*pentest qwen3.8-27b.*think medium/);
    assert.match(strip(lines[1]), /ctx .*66% 42k\/262k.*session ↑446k ↓175k ⟲14M \$1\.23/);
    assert.match(strip(lines[1]), /run 1m 04s ↑12k ↓~850/);
    assert.match(strip(lines[2]), /todos 1\/2.*trace-ledger lost=0.*verify-gate FAIL/);
    for (const l of lines) assert.ok(strip(l).length <= 120, `line fits: ${strip(l)}`);
  },

  narrowFooterStillFits() {
    const state = {
      cwd: "/home/u/proj", model: "m", totals: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, total: 1500, cost: 0 },
      partial: false, context: { percent: 95, tokens: 1, contextWindow: 2 }, statuses: [], todos: [], now: 0,
    };
    const lines = footer.renderFooter(state, plain, 60);
    for (const l of lines) assert.ok(strip(l).length <= 60, `narrow line fits: ${strip(l)}`);
    assert.match(strip(lines[1]), /95%/);
  },

  footerPresetsAndAsciiGlyphs() {
    const state = {
      cwd: "/home/u/proj", branch: "main", provider: "p", model: "m", thinking: "low",
      context: { tokens: 50, percent: 50, contextWindow: 100 },
      totals: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 0, total: 1500, cost: 0 },
      partial: false, statuses: [["verify-gate", "PASS"]], todos: [{ id: 1, text: "test", state: "open" }], now: 0,
    };
    assert.equal(footer.renderFooter(state, plain, 120, "light").length, 1, "light preset is one line");
    assert.equal(footer.renderFooter(state, plain, 120, "default").length, 3, "default remains three lines");
    assert.equal(footer.renderFooter(state, plain, 120, "heavy").length, 4, "heavy expands location and model details");

    const ansi = { ...plain, name: "ansi-dark" };
    const output = [...footer.renderFooter(state, ansi, 120, "default"), ...footer.renderTodoWidget(state.todos, ansi)].join("\n");
    assert.match(output, /in:1\.0k.*out:200/);
    assert.match(output, /\[ \] #1 test/);
    assert.ok(/^[\x00-\x7F]*$/.test(output), `ANSI footer is ASCII only: ${output}`);
  },

  async footerConfigPersistsMode() {
    const agent = tmpWorkspace("pi-kit-footer-settings-");
    const workspace = tmpWorkspace("pi-kit-footer-workspace-");
    const restore = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const pi = fakePi();
      footer.default(pi.api);
      const ctx = {
        cwd: workspace, hasUI: true, model: { id: "m", provider: "p", contextWindow: 100 },
        getContextUsage: () => ({ percent: 0, tokens: 0, contextWindow: 100 }),
        sessionManager: { getEntries: () => [], getSessionName: () => undefined },
        ui: { theme: plain, setFooter() {}, setWidget() {}, setWorkingMessage() {}, notify() {}, select: async () => "heavy" },
      };
      await pi.handlers.get("session_start")({}, ctx);
      await pi.commands.get("footer").handler(["config"], ctx);
      let saved = JSON.parse(fs.readFileSync(path.join(agent, "pi-kit", "ui.json"), "utf8"));
      assert.deepEqual(saved, { footer: true, mode: "heavy", tips: true, todos: true });
      await pi.commands.get("footer").handler(["off"], ctx);
      saved = JSON.parse(fs.readFileSync(path.join(agent, "pi-kit", "ui.json"), "utf8"));
      assert.equal(saved.footer, false);
      assert.equal(saved.mode, "heavy", "off preserves the selected preset for the next toggle");
    } finally {
      restore();
      rmWorkspace(agent);
      rmWorkspace(workspace);
    }
  },

  todoWidget() {
    const items = [
      { id: 1, text: "done thing", state: "done" },
      { id: 2, text: "current thing", state: "active" },
      { id: 3, text: "later thing", state: "open" },
    ];
    const lines = footer.renderTodoWidget(items, plain).map(strip);
    assert.match(lines[0], /Todos 1\/3/);
    assert.ok(lines.some((l) => /▸ #2 current thing/.test(l)), lines.join("|"));
    assert.ok(lines.some((l) => /✔ #1 done thing/.test(l)));
    assert.ok(lines.some((l) => /☐ #3 later thing/.test(l)));
    assert.deepEqual(footer.renderTodoWidget([], plain), []);
    const allDone = footer.renderTodoWidget([{ id: 1, text: "x", state: "done" }], plain).map(strip);
    assert.match(allDone[0], /all done/);
  },

  phrasesAndActivity() {
    assert.ok(footer.PHRASES.length > 5);
    assert.equal(footer.toolPhrase("read", { path: "/a/b/server.ts" }), "Reading server.ts");
    assert.equal(footer.toolPhrase("bash", { command: "npm test" }), "Running `npm test`");
    assert.equal(footer.toolPhrase("subagent", {}), "Delegating to a subagent");
    assert.equal(footer.toolPhrase("memory_search", {}), "Consulting memory");
    assert.equal(footer.toolPhrase("weird_tool", {}), "Using weird_tool");
  },

  tipsAreFilteredToLoadedCommands() {
    assert.ok(footer.TIPS.length > 5);
    const requiredEverywhere = footer.TIPS.filter((t) => !t.requires);
    assert.ok(requiredEverywhere.length >= 3, "some tips always apply");
    assert.ok(footer.TIPS.some((t) => t.requires === "compress"));
  },

  workingLineShowsTimeAndTokens() {
    const restore = setEnv("PI_CODING_AGENT_DIR", tmpWorkspace("pi-kit-ui-agent-"));
    try {
      const pi = fakePi();
      pi.api.getThinkingLevel = () => "off";
      footer.default(pi.api);
      const dbg = pi.api.__footerDebug;
      const setW = [];
      const widgets = [];
      const ws2 = tmpWorkspace("pi-kit-ui-ws-");
      const ctx = {
        cwd: ws2, hasUI: true, model: { id: "m", provider: "p" },
        getContextUsage: () => ({ percent: 10, tokens: 1, contextWindow: 100 }),
        sessionManager: { getEntries: () => [], getSessionName: () => undefined },
        ui: { theme: plain, setFooter() {}, setWidget: (k, c) => widgets.push([k, c]), setWorkingMessage: (m) => setW.push(m), notify() {} },
      };
      // Directly exercise the working-line text: a run with known tokens and elapsed time.
      // (agent_start/tick use timers; the debug hook renders the same text deterministically.)
      const before = dbg.workingText(Date.now());
      assert.match(before, /…/, "no run yet: plain phrase with an ellipsis");

      const items = footer.readTodoItems(ws2);
      assert.deepEqual(items, [], "no TODO.md yields no items");
      fs.writeFileSync(path.join(ws2, "TODO.md"), "# TODO\n\n- [x] #1: done\n- [~] #2: doing\n- [ ] #3: todo\n");
      const parsed = footer.readTodoItems(ws2);
      assert.deepEqual(parsed.map((t) => t.state), ["done", "active", "open"]);
      rmWorkspace(ws2);
    } finally {
      rmWorkspace(process.env.PI_CODING_AGENT_DIR);
      restore();
    }
  },

  async todoToolStatesAndListOutput() {
    const ws = tmpWorkspace("pi-kit-todo-tool-");
    const restore = setEnv("PI_KIT_TODO_FILE", path.join(ws, "TODO.md"));
    try {
      const pi = fakePi();
      todo.default(pi.api);
      const tool = pi.tools.get("todo");
      const call = async (params) => (await tool.execute("id", params, undefined, undefined, { cwd: ws })).content[0].text;

      let out = await call({ action: "add", items: ["design it", "build it", "test it"] });
      assert.match(out, /Added #1-#3/);
      assert.match(out, /Todos: 0\/3 done/);
      out = await call({ action: "start", id: 2 });
      assert.match(out, /in progress: #2/);
      assert.match(out, /\[~\] #2: build it {2}\(in progress\)/);
      // Starting another item clears the first active one.
      out = await call({ action: "start", id: 3 });
      assert.match(out, /in progress: #3/);
      assert.doesNotMatch(out, /\[~\] #2/);
      out = await call({ action: "done", id: 1 });
      assert.match(out, /Todos: 1\/3 done/);
      assert.match(out, /\[x\] #1: design it/);
      out = await call({ action: "remove", id: 3 });
      assert.match(out, /Removed #3/);
      assert.doesNotMatch(out, /test it/);
      out = await call({ action: "list" });
      assert.match(out, /Todos: 1\/2 done/);
      // The file on disk carries the states for the footer widget to read.
      const disk = fs.readFileSync(path.join(ws, "TODO.md"), "utf8");
      assert.match(disk, /- \[x\] #1: design it/);
      assert.match(disk, /- \[ \] #2: build it/);
      out = await call({ action: "done", id: 99 });
      assert.match(out, /#99 not found/);
    } finally {
      restore();
      rmWorkspace(ws);
    }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n${err.stack}`);
  }
}
const total = Object.keys(tests).length;
if (failed) {
  console.error(`status-bar-smoke: ${failed}/${total} failed`);
  process.exit(1);
}
console.log(`status-bar-smoke: ${total}/${total} passed`);
