#!/usr/bin/env node
/**
 * AG-01 regression coverage: orchestrator must be the real producer of a task-difficulty
 * classification, the shipped kit roles carry no model override (and are no longer copied
 * into projects), and the subagent model policy must choose either the active parent model
 * or role frontmatter.
 * Fully offline — no live pi, no network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ROOT, loadExtension, loadModule, fakePi, tmpWorkspace, rmWorkspace, setEnv, isolateKitEnv } from "../packages/core/eval/harness.mjs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

async function loadOrchestrator() {
  const register = await loadExtension("extensions/orchestrator/index.ts");
  const pi = fakePi();
  register(pi.api);
  return pi;
}

// orchestrator must write .pi/task-classification.json on every non-trivial input -
// the real signal provider-router now consumes (previously nothing ever wrote a
// task_type at all).
async function testOrchestratorWritesClassification() {
  const ws = tmpWorkspace("pi-kit-classify-");
  const restore = setEnv("PI_KIT_ORCH_DISABLE", undefined);
  try {
    const pi = await loadOrchestrator();
    const ctx = { cwd: ws, ui: { notify() {}, setStatus() {} } };
    await pi.handlers.get("session_start")({}, ctx);

    await pi.handlers.get("input")(
      { source: "interactive", text: "Implement a new authentication system across multiple services and refactor the whole billing module thoroughly." },
      ctx,
    );
    const classFile = path.join(ws, ".pi", "task-classification.json");
    assert.ok(fs.existsSync(classFile), "a complex input must write a classification file");
    const complex = JSON.parse(fs.readFileSync(classFile, "utf8"));
    assert.equal(complex.taskType, "complex");
    assert.ok(complex.score >= 3);

    await pi.handlers.get("input")({ source: "interactive", text: "hi there, quick question for you" }, ctx);
    const simple = JSON.parse(fs.readFileSync(classFile, "utf8"));
    assert.equal(simple.taskType, "simple", "a trivial-scoring input must reclassify as simple, not leave the stale complex verdict");
  } finally {
    restore();
    rmWorkspace(ws);
  }
}

async function testRoleAgentsHaveNoInjectedModel() {
  const ws = tmpWorkspace("pi-kit-rolemodel-");
  const restoreDisable = setEnv("PI_KIT_ORCH_DISABLE", undefined);
  try {
    const pi = await loadOrchestrator();
    await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
    assert.ok(!fs.existsSync(path.join(ws, ".pi", "agents")), "orchestrator must not copy roles into the project");

    const planner = fs.readFileSync(path.join(ROOT, "packages", "kit", "agents", "planner.md"), "utf8");
    assert.doesNotMatch(planner, /^model:/m, "orchestrator must not inject a model override");

    // Frontmatter integrity: name/description/tools must survive untouched.
    assert.match(planner, /^name: planner$/m);
    assert.match(planner, /^tools:/m);
  } finally {
    restoreDisable();
    rmWorkspace(ws);
  }
}

async function testSubagentModelPolicy() {
  const ws = tmpWorkspace("pi-kit-subagent-model-");
  try {
    const subagent = await loadModule("vendor/subagent/index.ts");
    const role = [{ name: "planner", description: "x", model: "gemma4:latest", systemPrompt: "", source: "user", filePath: "x" }];
    const launches = [];
    const spawnChild = (_exe, args) => {
      launches.push(args);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    };
    await subagent.runSingleAgent(ws, role, "planner", "task", undefined, undefined, undefined, undefined, spawnChild, "ollama/qwen3.8-uncensored", true);
    assert.deepEqual(launches[0].slice(launches[0].indexOf("--model"), launches[0].indexOf("--model") + 2), ["--model", "ollama/qwen3.8-uncensored"]);
    await subagent.runSingleAgent(ws, role, "planner", "task", undefined, undefined, undefined, undefined, spawnChild, "ollama/qwen3.8-uncensored", false);
    assert.deepEqual(launches[1].slice(launches[1].indexOf("--model"), launches[1].indexOf("--model") + 2), ["--model", "gemma4:latest"]);

  } finally {
    rmWorkspace(ws);
  }
}

const restoreIsolation = isolateKitEnv();
const tests = [
  ["orchestrator writes a real task classification on every input", testOrchestratorWritesClassification],
  ["kit roles carry no model and are not copied into projects", testRoleAgentsHaveNoInjectedModel],
  ["subagent model policy inherits or uses role models", testSubagentModelPolicy],
];

let failed = 0;
try {
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
} finally {
  restoreIsolation();
}
if (failed > 0) {
  console.error(`\n[model-routing-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[model-routing-smoke] all ${tests.length} checks passed`);
