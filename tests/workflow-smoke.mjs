#!/usr/bin/env node
// Offline workflow executor checks. The "child" is an in-process fake: it reads its task from
// stdin, finds the run directory in the appended system prompt, and answers deterministically.
//   1. validation rejects bad definitions; the shipped kit workflows parse.
//   2. sequential order + templating ({{inputs.*}}, {{steps.x.output}}, optional "?").
//   3. parallel groups run every member and combine their outputs.
//   4. review gates loop back and stop at max_loops.
//   5. declared outputs are enforced (a step must write the files it promises).
//   6. `when` skips a step whose condition is unmet.
//   7. an interrupted run resumes without redoing finished steps.
//   8. templates cannot read outside the run directory; a missing required value fails the step.
//   9. project workflows need approval (blocked headless).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { ROOT, loadModule, fakePi, tmpWorkspace, rmWorkspace, setEnv, isolateKitEnv } from "../packages/core/eval/harness.mjs";
import { installDelegation } from "../packages/core/eval/delegation.mjs";

// Launches go through delegation-guard (mandatory protections + effort budget); fake children still need it in place.
const __delegation = await installDelegation();
process.on("exit", () => __delegation.cleanup());

const ws = tmpWorkspace("pi-kit-workflow-");
const restores = [isolateKitEnv(), setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")), setEnv("PI_KIT_SUBAGENT_STATE_DIR", path.join(ws, "subagent-state"))];
let checks = 0;
const ok = (label) => {
  checks++;
  console.log(`  OK: ${label}`);
};

const agents = ["scout", "planner", "implementer", "reviewer"].map((name) => ({ name, description: name, systemPrompt: "", source: "kit", filePath: name }));

// Fake child. `behave(task, runDir)` returns the reply text (may write files, may return
// { hang: true } to never finish).
function fakeSpawner(behave, calls) {
  return (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    const promptFile = args[args.indexOf("--append-system-prompt") + 1];
    const runDir = fs.readFileSync(promptFile, "utf8").match(/shared directory is: (.+)/)?.[1]?.trim();
    let stdin = "";
    child.stdin.setEncoding("utf8");
    child.stdin.on("data", (d) => (stdin += d));
    child.stdin.on("end", () => {
      const task = stdin.replace(/^Task: /, "");
      calls.push(task);
      const reply = behave(task, runDir);
      if (reply && reply.hang) return;
      child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: reply }], stopReason: "stop" } }) + "\n");
      child.emit("close", 0);
    });
    return child;
  };
}

function wf(yaml) {
  return `---\n${yaml.trim()}\n---\n\nbody\n`;
}

try {
  const W = await loadModule("vendor/subagent/workflow.ts");
  const keepalive = setInterval(() => {}, 1000);
  const run = async (def, inputs, behave, extra = {}) => {
    const calls = [];
    const { workflow, errors } = W.parseWorkflow(wf(def), path.join(ws, "w.md"), "user");
    assert.deepEqual(errors, []);
    const state = extra.state ?? W.newRunState(workflow, W.resolveInputs(workflow, inputs).inputs);
    const final = await W.executeWorkflow(workflow, state, { cwd: ws, agents, spawnChild: fakeSpawner(behave, calls), signal: extra.signal });
    return { final, calls, workflow, dir: path.join(W.runsRoot(ws), final.id) };
  };

  // 1. Validation + shipped workflows.
  {
    const bad = W.parseWorkflow(wf(`
name: bad
steps:
  - id: a
    agent: scout
    task: x
  - id: a
    agent: scout
  - id: c
    agent: reviewer
    task: y
    when: { step: zzz }
    gate: { pass: PASS, retry: later }
  - id: later
    agent: scout
    task: z
`), "bad.md", "user");
    const text = bad.errors.join("\n");
    assert.match(text, /needs a task/);
    assert.match(text, /duplicate step ids: a/);
    assert.match(text, /when\.step "zzz"/);
    assert.match(text, /gate\.retry/);
    const { workflows, errors } = W.discoverWorkflows(ws);
    assert.deepEqual(errors, [], "shipped workflows must parse");
    assert.deepEqual(workflows.map((w) => w.name).sort(), ["bugfix", "feature", "research"]);
    ok("validation rejects bad definitions; shipped workflows parse");
  }

  // 2. Order + templating.
  {
    const { final, calls, dir } = await run(`
name: seq
inputs:
  goal: { required: true }
  extra: { default: "none" }
steps:
  - id: first
    agent: scout
    task: "look at {{inputs.goal}} ({{inputs.extra}})"
  - id: second
    agent: planner
    task: "plan from: {{steps.first.output}} / prior {{steps.nope.output?}}!"
`, { goal: "auth" }, (task) => (task.startsWith("look") ? "SCOUT-FINDINGS $& $1" : "PLAN"));
    assert.equal(final.status, "passed");
    assert.deepEqual(calls, ["look at auth (none)", "plan from: SCOUT-FINDINGS $& $1 / prior !"]);
    assert.equal(fs.readFileSync(path.join(dir, "steps", "second.md"), "utf8"), "PLAN");
    ok("steps run in order; outputs, defaults and optional refs template verbatim");
  }

  // 3. Parallel.
  {
    const { final, calls, dir } = await run(`
name: par
steps:
  - id: fan
    parallel:
      - { id: one, agent: scout, task: "angle one" }
      - { id: two, agent: scout, task: "angle two" }
  - id: merge
    agent: planner
    task: "merge {{steps.fan.output}}"
`, {}, (task) => (task.startsWith("angle") ? `R:${task}` : "MERGED"));
    assert.equal(final.status, "passed");
    assert.equal(calls.filter((c) => c.startsWith("angle")).length, 2);
    const merged = calls.find((c) => c.startsWith("merge"));
    assert.match(merged, /## one\n\nR:angle one/);
    assert.match(merged, /## two\n\nR:angle two/);
    assert.ok(fs.existsSync(path.join(dir, "steps", "fan.md")));
    ok("parallel members all run and their outputs combine for later steps");
  }

  // 4. Gates.
  {
    let reviews = 0;
    const gate = `
name: gated
steps:
  - id: implement
    agent: implementer
    task: "implement. feedback: {{steps.review.output?}}"
  - id: review
    agent: reviewer
    task: "review {{steps.implement.output}}"
    gate: { pass: "/##\\\\s*Verdict\\\\s*\\\\n+\\\\s*PASS/", retry: implement, max_loops: 2 }
`;
    const { final, calls } = await run(gate, {}, (task) => {
      if (task.startsWith("implement")) return "DONE";
      reviews++;
      return reviews < 2 ? "## Verdict\nFAIL\n\n## Summary\nfix the null check" : "## Verdict\nPASS";
    });
    assert.equal(final.status, "passed");
    assert.equal(calls.filter((c) => c.startsWith("implement")).length, 2, "one loop back to implement");
    assert.match(calls[2], /feedback: ## Verdict\nFAIL/, "the retried step sees the failing review");
    assert.equal(final.loops.review, 1);
    const never = await run(gate, {}, (task) => (task.startsWith("implement") ? "DONE" : "## Verdict\nFAIL"));
    assert.equal(never.final.status, "failed");
    assert.match(never.final.error, /gate review did not pass after 2 loop/);
    assert.equal(never.calls.filter((c) => c.startsWith("implement")).length, 3);
    ok("gates loop back with the review attached and stop at max_loops");
  }

  // 5 + 6. Outputs and when.
  {
    const def = `
name: outs
steps:
  - id: write
    agent: implementer
    task: "write report"
    outputs: [report.md]
  - id: celebrate
    agent: scout
    task: "celebrate"
    when: { step: write, status: failed }
  - id: read
    agent: scout
    task: "read {{file:report.md}}"
`;
    const good = await run(def, {}, (task, runDir) => {
      if (task.startsWith("write")) fs.writeFileSync(path.join(runDir, "report.md"), "REPORT-BODY");
      return "ok";
    });
    assert.equal(good.final.status, "passed");
    assert.equal(good.final.steps.celebrate.status, "skipped");
    assert.ok(good.calls.includes("read REPORT-BODY"), "a later step reads an artefact from the blackboard");
    const bad = await run(def, {}, () => "ok");
    assert.equal(bad.final.status, "failed");
    assert.match(bad.final.error, /declared output\(s\) not written: report\.md/);
    ok("declared outputs are enforced; artefacts flow through {{file:}}; when skips");
  }

  // 7. Resume after interruption.
  {
    const def = `
name: resumable
steps:
  - id: a
    agent: scout
    task: "step a"
  - id: b
    agent: implementer
    task: "step b after {{steps.a.output}}"
`;
    const ac = new AbortController();
    const first = await run(def, {}, (task) => {
      if (task.startsWith("step b")) {
        setTimeout(() => ac.abort(), 5);
        return { hang: true };
      }
      return "A-OUT";
    }, { signal: ac.signal });
    assert.equal(first.final.status, "interrupted");
    assert.equal(first.final.steps.a.status, "passed");
    const state = W.loadState(ws, first.final.id);
    const resumed = await run(def, {}, (task) => (task.startsWith("step a") ? "SHOULD-NOT-RUN" : "B-OUT"), { state });
    assert.equal(resumed.final.status, "passed");
    assert.deepEqual(resumed.calls, ["step b after A-OUT"], "only the interrupted step re-runs");
    ok("an interrupted run resumes from the interrupted step");
  }

  // 8. Template safety.
  {
    const esc = await run(`
name: escape
steps:
  - id: a
    agent: scout
    task: "{{file:../../../../etc/passwd}}"
`, {}, () => "x");
    assert.equal(esc.final.status, "failed");
    assert.match(esc.final.error, /escapes the run directory/);
    const miss = await run(`
name: missing
inputs:
  goal: { description: optional here }
steps:
  - id: a
    agent: scout
    task: "{{inputs.goal}}"
`, {}, () => "x");
    assert.equal(miss.final.status, "failed");
    assert.match(miss.final.error, /input not provided/);
    ok("templates cannot escape the run directory; missing required values fail the step");
  }

  // 9. Trust gating through the tool.
  {
    fs.mkdirSync(path.join(ws, ".pi", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(ws, ".pi", "workflows", "local.md"), wf(`
name: local
steps:
  - id: a
    agent: scout
    task: hi
`));
    const sub = await loadModule("vendor/subagent/index.ts");
    const pi = fakePi();
    sub.default(pi.api);
    const tool = pi.tools.get("workflow_run");
    const listed = await tool.execute("1", { name: "list" }, undefined, undefined, { cwd: ws, hasUI: false });
    assert.match(listed.content[0].text, /local \(project\)/);
    const blocked = await tool.execute("2", { name: "local" }, undefined, undefined, { cwd: ws, hasUI: false });
    assert.equal(blocked.isError, true);
    assert.match(blocked.content[0].text, /needs interactive approval/);
    ok("project workflows are blocked without approval");
  }

  // 10. Corrupt/wrong-shape run state must not crash status listing or summarising.
  {
    const roots = W.runsRoot(ws);
    fs.mkdirSync(roots, { recursive: true });
    const fullShape = (overrides = {}) =>
      JSON.stringify({
        version: 1,
        id: "x",
        workflow: "w",
        workflowFile: "/tmp/w.md",
        inputs: {},
        status: "running",
        cursor: 0,
        loops: {},
        steps: {},
        startedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        executions: 0,
        ...overrides,
      });
    const bad = {
      "bad-empty": "{}",
      "bad-array": "[]",
      "bad-nulls": '{"id":"x","status":"running","startedAt":null}',
      "bad-minimal": '{"id":"x","steps":{}}',
      "bad-no-started": fullShape({ startedAt: undefined }),
      "bad-status": fullShape({ status: "bogus" }),
      "bad-loops-array": fullShape({ loops: [] }),
      "bad-cursor-negative": fullShape({ cursor: -1 }),
      "bad-cursor-float": fullShape({ cursor: 0.5 }),
      "bad-no-executions": fullShape({ executions: undefined }),
      "bad-step-null": fullShape({ steps: { a: null } }),
      "bad-step-nonobject": fullShape({ steps: { a: "passed" } }),
      "bad-loops-nonnumber": fullShape({ loops: { a: "2" } }),
    };
    const goodStep = fullShape({ steps: { a: { status: "passed", attempts: 1, runIds: ["r1"], cost: 0.01 } }, loops: { a: 1 } });
    for (const [id, body] of Object.entries(bad)) {
      fs.mkdirSync(path.join(roots, id), { recursive: true });
      fs.writeFileSync(path.join(roots, id, "state.json"), body);
    }
    for (const id of Object.keys(bad)) assert.equal(W.loadState(ws, id), null, `${id} rejected by loadState`);
    fs.mkdirSync(path.join(roots, "good-step"), { recursive: true });
    fs.writeFileSync(path.join(roots, "good-step", "state.json"), goodStep);
    assert.notEqual(W.loadState(ws, "good-step"), null, "a well-formed step state is accepted");
    let runs = [];
    assert.doesNotThrow(() => {
      runs = W.listRuns(ws, 50);
    }, "listRuns tolerates a corrupt run-state file");
    for (const id of Object.keys(bad)) assert.ok(!runs.some((r) => r.id === id), `${id} skipped by listRuns`);
    assert.ok(runs.length > 0, "well-formed runs are still listed");
    assert.ok(runs.every((r) => typeof r.startedAt === "string"), "listed runs sort on a real startedAt");
    const partial = { id: "partial", workflow: "w", status: "running" };
    assert.doesNotThrow(() => W.summarizeRun(partial), "summarizeRun tolerates missing fields");
    assert.match(W.summarizeRun(partial, { steps: [{ id: "a" }] }), /pending/, "a missing step state is reported as pending");
    ok("corrupt run state is skipped/reported instead of crashing status");
  }

  clearInterval(keepalive);
  console.log(`[workflow-smoke] all ${checks} checks passed`);
} finally {
  for (const r of restores.reverse()) r();
  rmWorkspace(ws);
}
