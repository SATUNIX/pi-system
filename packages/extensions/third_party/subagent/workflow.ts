/**
 * Workflows — declarative chains of subagent (and skill) steps, run by a deterministic executor.
 *
 * A workflow is a Markdown file with YAML frontmatter (the body is documentation). Code, not a
 * model, decides the step order: sequential steps, parallel groups, review gates that loop back
 * to an earlier step, and simple conditions. Every run gets a *blackboard* directory
 * (.pi/workflows/runs/<run-id>/): each step's final answer is saved as steps/<id>.md, steps are
 * told the directory and may write artefacts there, and later steps pull them in with
 * {{file:...}} or {{steps.<id>.output}}. state.json records progress, so an interrupted run
 * (Esc, crash, closed terminal) resumes where it stopped.
 *
 * See docs/workflows.md for the authoring guide.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { agentDir } from "./config.ts";
import type { AgentConfig } from "./agents.ts";
import { mapWithConcurrencyLimit, runAgent, type RunOverrides } from "./runner.ts";
import { getResultOutput, isFailedResult } from "./result.ts";
import type { SingleResult, SpawnChild } from "./types.ts";

const SUBAGENT_DIR = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------
// Definition

export interface StepDef {
  id: string;
  agent?: string;
  skill?: string;
  task?: string;
  outputs?: string[];
  model?: string;
  thinking?: string;
  tools?: string[];
  skills?: string[];
  extensions?: string[];
  maxRuntimeMs?: number;
  when?: { step: string; status: StepStatus | StepStatus[] };
  gate?: { pass: string; retry: string; maxLoops: number };
  continueOnError?: boolean;
  parallel?: StepDef[];
}

export interface WorkflowDef {
  name: string;
  description: string;
  inputs: Record<string, { description?: string; required?: boolean; default?: string }>;
  steps: StepDef[];
  vault: boolean;
  source: "kit" | "user" | "project";
  file: string;
}

export type StepStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "aborted";

const ID = /^[a-z][a-z0-9_-]{0,40}$/;

function parseDuration(value: unknown): number | undefined {
  if (typeof value === "number") return value > 0 ? value : undefined;
  const m = String(value ?? "").trim().match(/^(\d+)\s*(ms|s|m|h)?$/i);
  if (!m) return undefined;
  const unit = (m[2] ?? "ms").toLowerCase();
  return Number(m[1]) * (unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1000 : 1);
}

const strList = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === "string" && v.trim() ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

function parseStep(raw: any, where: string, errors: string[]): StepDef {
  if (!raw || typeof raw !== "object") {
    errors.push(`${where}: a step must be a mapping`);
    return { id: "invalid" };
  }
  const id = String(raw.id ?? "");
  if (!ID.test(id)) errors.push(`${where}: id "${id}" must match ${ID}`);
  const step: StepDef = { id };
  if (Array.isArray(raw.parallel)) {
    const members: StepDef[] = raw.parallel.map((s: unknown, i: number) => parseStep(s, `${where}.parallel[${i}]`, errors));
    step.parallel = members;
    for (const inner of members) if (inner.parallel) errors.push(`${where}: parallel groups cannot nest`);
    if (!members.length) errors.push(`${where}: parallel group is empty`);
  } else {
    step.agent = raw.agent ? String(raw.agent) : raw.skill ? "implementer" : undefined;
    step.skill = raw.skill ? String(raw.skill) : undefined;
    step.task = typeof raw.task === "string" ? raw.task : undefined;
    if (!step.agent) errors.push(`${where}: needs agent: or skill:`);
    if (!step.task?.trim()) errors.push(`${where}: needs a task`);
  }
  step.outputs = strList(raw.outputs);
  for (const o of step.outputs ?? []) if (path.isAbsolute(o) || o.split(/[\\/]/).includes("..")) errors.push(`${where}: output "${o}" must be a relative path inside the run dir`);
  step.model = raw.model ? String(raw.model) : undefined;
  step.thinking = raw.thinking ? String(raw.thinking) : undefined;
  step.tools = strList(raw.tools);
  step.extensions = strList(raw.extensions);
  step.skills = [...(strList(raw.skills) ?? []), ...(step.skill ? [step.skill] : [])];
  if (!step.skills.length) step.skills = undefined;
  step.maxRuntimeMs = parseDuration(raw.max_runtime ?? raw.maxRuntime);
  step.continueOnError = raw.continue_on_error === true || raw.continueOnError === true;
  if (raw.when) {
    const w = raw.when;
    const status = Array.isArray(w.status) ? w.status.map(String) : [String(w.status ?? "passed")];
    step.when = { step: String(w.step ?? ""), status: status as StepStatus[] };
  }
  if (raw.gate) {
    const g = raw.gate;
    step.gate = { pass: String(g.pass ?? g.expect ?? ""), retry: String(g.retry ?? g.on_fail ?? ""), maxLoops: Math.max(0, Math.min(Number(g.max_loops ?? g.maxLoops ?? 2), 10)) };
    if (!step.gate.pass) errors.push(`${where}: gate needs pass: (text or /regex/ the output must contain)`);
  }
  return step;
}

export function parseWorkflow(content: string, file: string, source: WorkflowDef["source"]): { workflow?: WorkflowDef; errors: string[] } {
  const errors: string[] = [];
  let fm: any;
  try {
    fm = parseFrontmatter<Record<string, unknown>>(content).frontmatter;
  } catch (error) {
    return { errors: [`${file}: invalid YAML frontmatter: ${String(error)}`] };
  }
  const name = String(fm.name ?? path.basename(file, ".md"));
  if (!ID.test(name)) errors.push(`name "${name}" must match ${ID}`);
  const inputs: WorkflowDef["inputs"] = {};
  if (fm.inputs && typeof fm.inputs === "object") {
    for (const [k, v] of Object.entries(fm.inputs as Record<string, any>)) {
      inputs[k] = typeof v === "object" && v ? { description: v.description, required: v.required === true, default: v.default !== undefined ? String(v.default) : undefined } : { description: String(v ?? "") };
    }
  }
  const steps = Array.isArray(fm.steps) ? fm.steps.map((s: unknown, i: number) => parseStep(s, `steps[${i}]`, errors)) : [];
  if (!steps.length) errors.push("steps: at least one step is required");
  // Ids are unique across the whole workflow (parallel members included); references resolve.
  const order: string[] = [];
  for (const s of steps) {
    order.push(s.id);
    for (const p of s.parallel ?? []) order.push(p.id);
  }
  const dup = order.filter((id, i) => order.indexOf(id) !== i);
  if (dup.length) errors.push(`duplicate step ids: ${[...new Set(dup)].join(", ")}`);
  steps.forEach((s: StepDef, i: number) => {
    const earlier = new Set(steps.slice(0, i).flatMap((x: StepDef) => [x.id, ...(x.parallel ?? []).map((p) => p.id)]));
    if (s.when && !earlier.has(s.when.step)) errors.push(`step ${s.id}: when.step "${s.when.step}" must name an earlier step`);
    if (s.gate && s.gate.retry && !earlier.has(s.gate.retry) && s.gate.retry !== s.id) errors.push(`step ${s.id}: gate.retry "${s.gate.retry}" must name this or an earlier top-level step`);
    if (s.gate && s.gate.retry && !steps.slice(0, i + 1).some((x: StepDef) => x.id === s.gate!.retry)) errors.push(`step ${s.id}: gate.retry must be a top-level step`);
  });
  if (errors.length) return { errors: errors.map((e) => `${path.basename(file)}: ${e}`) };
  return { workflow: { name, description: String(fm.description ?? ""), inputs, steps, vault: fm.vault === true, source, file }, errors };
}

// ---------------------------------------------------------------------------------------------
// Discovery: kit < user < project (project workflows are untrusted, like project roles)

export function workflowDirs(cwd: string): Array<{ dir: string; source: WorkflowDef["source"] }> {
  return [
    { dir: process.env.PI_KIT_WORKFLOWS_DIR?.trim() || path.resolve(SUBAGENT_DIR, "..", "..", "..", "kit", "workflows"), source: "kit" },
    { dir: path.join(agentDir(), "workflows"), source: "user" },
    { dir: path.join(cwd, ".pi", "workflows"), source: "project" },
  ];
}

export function discoverWorkflows(cwd: string): { workflows: WorkflowDef[]; errors: string[] } {
  const byName = new Map<string, WorkflowDef>();
  const errors: string[] = [];
  for (const { dir, source } of workflowDirs(cwd)) {
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md");
    } catch {
      continue;
    }
    for (const f of files) {
      const file = path.join(dir, f);
      const { workflow, errors: e } = parseWorkflow(fs.readFileSync(file, "utf8"), file, source);
      errors.push(...e);
      if (workflow) byName.set(workflow.name, workflow);
    }
  }
  return { workflows: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), errors };
}

export function workflowDigest(w: WorkflowDef): string {
  return crypto.createHash("sha256").update(fs.readFileSync(w.file)).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Run state (the blackboard)

export interface StepState {
  status: StepStatus;
  attempts: number;
  runIds: string[];
  output?: string; // truncated copy; the full text is steps/<id>.md
  error?: string;
  cost: number;
  startedAt?: string;
  endedAt?: string;
}

export interface RunState {
  version: 1;
  id: string;
  workflow: string;
  workflowFile: string;
  inputs: Record<string, string>;
  status: "running" | "passed" | "failed" | "interrupted";
  cursor: number; // index into steps of the next top-level step to run
  loops: Record<string, number>;
  steps: Record<string, StepState>;
  startedAt: string;
  updatedAt: string;
  error?: string;
  executions: number;
}

export const runsRoot = (cwd: string) => path.join(cwd, ".pi", "workflows", "runs");
const MAX_OUTPUT_IN_STATE = 4000;
const MAX_FILE_INCLUDE = 64 * 1024;
const MAX_EXECUTIONS = 60; // hard ceiling on step executions per run (loops included)

function saveState(dir: string, state: RunState): void {
  state.updatedAt = new Date().toISOString();
  const file = path.join(dir, "state.json");
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, file);
}

const RUN_STATES: ReadonlySet<string> = new Set(["running", "passed", "failed", "interrupted"]);
const STEP_STATUSES: ReadonlySet<string> = new Set(["pending", "running", "passed", "failed", "skipped", "aborted"]);

function isStepState(value: unknown): value is StepState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.status === "string" &&
    STEP_STATUSES.has(s.status) &&
    typeof s.attempts === "number" &&
    Number.isFinite(s.attempts) &&
    typeof s.cost === "number" &&
    Number.isFinite(s.cost) &&
    Array.isArray(s.runIds) &&
    s.runIds.every((r) => typeof r === "string")
  );
}

function isRunState(value: unknown): value is RunState {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
  return (
    typeof s.id === "string" &&
    typeof s.workflow === "string" &&
    typeof s.startedAt === "string" &&
    typeof s.status === "string" &&
    RUN_STATES.has(s.status) &&
    typeof s.cursor === "number" &&
    Number.isInteger(s.cursor) &&
    s.cursor >= 0 &&
    typeof s.executions === "number" &&
    Number.isFinite(s.executions) &&
    s.executions >= 0 &&
    isRecord(s.loops) &&
    Object.values(s.loops).every((n) => typeof n === "number") &&
    isRecord(s.steps) &&
    Object.values(s.steps).every(isStepState)
  );
}

export function loadState(cwd: string, id: string): RunState | null {
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(runsRoot(cwd), id, "state.json"), "utf8"));
    return isRunState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function listRuns(cwd: string, limit = 20): RunState[] {
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(runsRoot(cwd));
  } catch {
    return [];
  }
  return ids
    .map((id) => loadState(cwd, id))
    .filter((s): s is RunState => s !== null)
    .sort((a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? ""))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------------------------
// Templating

export class TemplateError extends Error {}

// {{inputs.x}}  {{steps.<id>.output}}  {{steps.<id>.status}}  {{file:rel/path}}  {{run.dir}}
// {{run.id}}  {{loop}}.  A trailing "?" makes a missing value empty instead of an error.
export function renderTemplate(template: string, ctx: { inputs: Record<string, string>; state: RunState; runDir: string; loop: number }): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_m, exprRaw: string) => {
    const optional = exprRaw.endsWith("?");
    const expr = optional ? exprRaw.slice(0, -1).trim() : exprRaw;
    const missing = (what: string) => {
      if (optional) return "";
      throw new TemplateError(`template {{${expr}}}: ${what}`);
    };
    if (expr === "run.dir") return ctx.runDir;
    if (expr === "run.id") return ctx.state.id;
    if (expr === "loop") return String(ctx.loop);
    if (expr.startsWith("inputs.")) {
      const v = ctx.inputs[expr.slice(7)];
      return v !== undefined && v !== "" ? v : missing("input not provided");
    }
    const stepRef = expr.match(/^steps\.([a-z][a-z0-9_-]*)\.(output|status)$/);
    if (stepRef) {
      const st = ctx.state.steps[stepRef[1]];
      if (stepRef[2] === "status") return st?.status ?? missing("unknown step");
      const file = path.join(ctx.runDir, "steps", `${stepRef[1]}.md`);
      return fs.existsSync(file) ? fs.readFileSync(file, "utf8") : missing(`step "${stepRef[1]}" has no output yet`);
    }
    if (expr.startsWith("file:")) {
      const rel = expr.slice(5).trim();
      const abs = path.resolve(ctx.runDir, rel);
      if (!abs.startsWith(ctx.runDir + path.sep)) throw new TemplateError(`template {{${expr}}}: path escapes the run directory`);
      if (!fs.existsSync(abs)) return missing(`file ${rel} does not exist in the run directory`);
      const buf = fs.readFileSync(abs);
      return buf.length > MAX_FILE_INCLUDE ? `${buf.subarray(0, MAX_FILE_INCLUDE).toString("utf8")}\n[... truncated at ${MAX_FILE_INCLUDE} bytes; read ${abs} for the rest]` : buf.toString("utf8");
    }
    throw new TemplateError(`template {{${expr}}}: unknown expression`);
  });
}

function gatePasses(pattern: string, output: string): boolean {
  const re = pattern.match(/^\/(.+)\/([a-z]*)$/);
  if (re) {
    try {
      return new RegExp(re[1], re[2].includes("i") ? re[2] : `${re[2]}i`).test(output);
    } catch {
      return false;
    }
  }
  return output.toLowerCase().includes(pattern.toLowerCase());
}

// ---------------------------------------------------------------------------------------------
// Executor

export interface ExecuteOptions {
  cwd: string;
  agents: AgentConfig[];
  signal?: AbortSignal;
  parentModel?: string;
  onProgress?: (text: string) => void;
  spawnChild?: SpawnChild;
  concurrency?: number;
  // "user" when the person typed the command (bounded by platform ceilings only); the model-callable
  // tool uses the default, "discretionary" (bounded by the effort tier).
  launchKind?: "discretionary" | "user";
}

function projectSlug(cwd: string): string {
  let dir = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, ".git"))) break;
    const parent = path.dirname(dir);
    if (parent === dir) {
      dir = path.resolve(cwd);
      break;
    }
    dir = parent;
  }
  return path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

export function newRunState(w: WorkflowDef, inputs: Record<string, string>): RunState {
  const now = new Date();
  const id = `${now.toISOString().replace(/[:.]/g, "-")}-${w.name}-${crypto.randomBytes(2).toString("hex")}`;
  return { version: 1, id, workflow: w.name, workflowFile: w.file, inputs, status: "running", cursor: 0, loops: {}, steps: {}, startedAt: now.toISOString(), updatedAt: now.toISOString(), executions: 0 };
}

export function resolveInputs(w: WorkflowDef, given: Record<string, string>): { inputs: Record<string, string>; missing: string[] } {
  const inputs: Record<string, string> = { ...given };
  const missing: string[] = [];
  for (const [k, spec] of Object.entries(w.inputs)) {
    if ((inputs[k] === undefined || inputs[k] === "") && spec.default !== undefined) inputs[k] = spec.default;
    if (spec.required && !inputs[k]) missing.push(k);
  }
  return { inputs, missing };
}

const BLACKBOARD_NOTE = (runDir: string, files: string[]) =>
  [
    "## Workflow run",
    `You are one step of an automated workflow. The run's shared directory is: ${runDir}`,
    "Write any files your task asks for into that directory (relative names are relative to it). Later steps read them.",
    files.length ? `Files already in the run directory: ${files.join(", ")}` : "",
    "End with a concise final answer: it is saved and passed to later steps.",
  ]
    .filter(Boolean)
    .join("\n");

function listRunFiles(runDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "state.json" || e.name.endsWith(".tmp")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  try {
    walk(runDir, "");
  } catch {
    /* empty */
  }
  return out.slice(0, 50);
}

async function runStep(step: StepDef, state: RunState, runDir: string, loop: number, opts: ExecuteOptions): Promise<StepState> {
  const st: StepState = state.steps[step.id] ?? { status: "pending", attempts: 0, runIds: [], cost: 0 };
  state.steps[step.id] = st;
  if (step.when) {
    const dep = state.steps[step.when.step]?.status;
    const wanted = Array.isArray(step.when.status) ? step.when.status : [step.when.status];
    if (!dep || !wanted.includes(dep)) {
      st.status = "skipped";
      st.endedAt = new Date().toISOString();
      return st;
    }
  }
  let task: string;
  try {
    task = renderTemplate(step.task ?? "", { inputs: state.inputs, state, runDir, loop });
  } catch (error) {
    st.status = "failed";
    st.error = error instanceof Error ? error.message : String(error);
    return st;
  }
  st.status = "running";
  st.attempts++;
  st.startedAt = new Date().toISOString();
  state.executions++;
  opts.onProgress?.(`${state.workflow} · ${step.id}${loop ? ` (loop ${loop})` : ""} · running ${step.agent}`);
  const overrides: RunOverrides = {
    model: step.model,
    thinking: step.thinking,
    tools: step.tools,
    skills: step.skills,
    extensions: step.extensions,
    maxRuntimeMs: step.maxRuntimeMs,
    appendSystemPrompt: BLACKBOARD_NOTE(runDir, listRunFiles(runDir)),
  };
  const result: SingleResult = await runAgent({
    defaultCwd: opts.cwd,
    agents: opts.agents,
    agentName: step.agent!,
    task,
    signal: opts.signal,
    parentModel: opts.parentModel,
    spawnChild: opts.spawnChild,
    overrides,
    launchKind: opts.launchKind,
    onUpdate: (t) => opts.onProgress?.(`${state.workflow} · ${step.id} · ${t}`),
  });
  if (result.runId) st.runIds.push(result.runId);
  st.cost += result.usage.cost;
  const output = result.finalOutput || getResultOutput(result);
  fs.mkdirSync(path.join(runDir, "steps"), { recursive: true });
  fs.writeFileSync(path.join(runDir, "steps", `${step.id}.md`), output);
  st.output = output.length > MAX_OUTPUT_IN_STATE ? `${output.slice(0, MAX_OUTPUT_IN_STATE)}…` : output;
  st.endedAt = new Date().toISOString();
  if (result.stopReason === "aborted" || opts.signal?.aborted) {
    st.status = "aborted";
    st.error = "cancelled";
    return st;
  }
  if (isFailedResult(result)) {
    st.status = "failed";
    st.error = result.errorMessage || result.stderr.slice(0, 500) || `exit ${result.exitCode}`;
    return st;
  }
  const missingOutputs = (step.outputs ?? []).filter((o) => !fs.existsSync(path.join(runDir, o)));
  if (missingOutputs.length) {
    st.status = "failed";
    st.error = `declared output(s) not written: ${missingOutputs.join(", ")}`;
    return st;
  }
  st.status = "passed";
  return st;
}

/**
 * Run (or resume) a workflow. Returns the final state; never throws for step failures.
 * Resuming re-runs the step that was interrupted and continues from there.
 */
export async function executeWorkflow(w: WorkflowDef, state: RunState, opts: ExecuteOptions): Promise<RunState> {
  const runDir = path.join(runsRoot(opts.cwd), state.id);
  fs.mkdirSync(runDir, { recursive: true });
  state.status = "running";
  state.error = undefined;
  saveState(runDir, state);
  const finish = (status: RunState["status"], error?: string) => {
    state.status = status;
    state.error = error;
    saveState(runDir, state);
    return state;
  };

  while (state.cursor < w.steps.length) {
    if (opts.signal?.aborted) return finish("interrupted", "cancelled");
    if (state.executions >= MAX_EXECUTIONS) return finish("failed", `stopped after ${MAX_EXECUTIONS} step executions (loop safety limit)`);
    const step = w.steps[state.cursor];
    const loop = step.gate ? (state.loops[step.id] ?? 0) : Object.values(state.loops).reduce((a, b) => Math.max(a, b), 0);

    let failed: string | undefined;
    if (step.parallel) {
      const group: StepState = state.steps[step.id] ?? { status: "pending", attempts: 0, runIds: [], cost: 0 };
      state.steps[step.id] = group;
      // Resuming an interrupted group re-runs only the members that had not passed.
      const resuming = group.status === "aborted" || group.status === "running";
      const todo = resuming ? step.parallel.filter((inner) => state.steps[inner.id]?.status !== "passed") : step.parallel;
      group.status = "running";
      group.startedAt = new Date().toISOString();
      saveState(runDir, state);
      await mapWithConcurrencyLimit(todo, opts.concurrency ?? 4, (inner) => runStep(inner, state, runDir, loop, opts));
      const results = step.parallel.map((inner) => state.steps[inner.id]);
      saveState(runDir, state);
      group.endedAt = new Date().toISOString();
      group.cost = results.reduce((a, r) => a + r.cost, 0);
      if (results.some((r) => r.status === "aborted")) {
        group.status = "aborted";
        return finish("interrupted", "cancelled");
      }
      const bad = step.parallel.filter((inner, i) => results[i].status === "failed" && !inner.continueOnError);
      group.status = bad.length ? "failed" : "passed";
      // A group's combined output: each member's answer under its id.
      const combined = step.parallel.map((inner) => `## ${inner.id}\n\n${fs.existsSync(path.join(runDir, "steps", `${inner.id}.md`)) ? fs.readFileSync(path.join(runDir, "steps", `${inner.id}.md`), "utf8") : "(no output)"}`).join("\n\n");
      fs.writeFileSync(path.join(runDir, "steps", `${step.id}.md`), combined);
      if (bad.length) failed = `parallel step(s) failed: ${bad.map((b) => `${b.id} (${state.steps[b.id].error})`).join("; ")}`;
    } else {
      const st = await runStep(step, state, runDir, loop, opts);
      saveState(runDir, state);
      if (st.status === "aborted") return finish("interrupted", "cancelled");
      if (st.status === "failed" && !step.continueOnError) failed = `step ${step.id} failed: ${st.error}`;
    }
    if (failed) return finish("failed", failed);

    // Review gate: a failing verdict loops back (bounded); exhausting the loops fails the run.
    if (step.gate && state.steps[step.id]?.status === "passed") {
      const output = fs.readFileSync(path.join(runDir, "steps", `${step.id}.md`), "utf8");
      if (!gatePasses(step.gate.pass, output)) {
        const used = state.loops[step.id] ?? 0;
        state.steps[step.id].status = "failed";
        if (!step.gate.retry || used >= step.gate.maxLoops) return finish("failed", `gate ${step.id} did not pass after ${used} loop(s) (needs "${step.gate.pass}")`);
        state.loops[step.id] = used + 1;
        state.cursor = w.steps.findIndex((s) => s.id === step.gate!.retry);
        opts.onProgress?.(`${state.workflow} · gate ${step.id} failed → back to ${step.gate.retry} (loop ${used + 1}/${step.gate.maxLoops})`);
        saveState(runDir, state);
        continue;
      }
    }
    state.cursor++;
    saveState(runDir, state);
  }
  finish("passed");
  if (w.vault) copyToVault(opts.cwd, runDir, state);
  return state;
}

// Optionally keep a finished run's artefacts in the memory vault for cross-session pick-up.
function copyToVault(cwd: string, runDir: string, state: RunState): void {
  try {
    const vault = process.env.PI_KIT_VAULT?.trim() || path.join(os.homedir(), ".pi", "vault");
    const dest = path.join(vault, "Projects", projectSlug(cwd), "Workflows", state.id);
    fs.cpSync(runDir, dest, { recursive: true });
  } catch {
    /* best effort */
  }
}

export function summarizeRun(state: RunState, w?: WorkflowDef): string {
  const steps = state.steps ?? {};
  const order = w ? w.steps.flatMap((s) => [s.id, ...(s.parallel ?? []).map((p) => `  ${p.id}`)]) : Object.keys(steps);
  const cost = Object.values(steps).reduce((a, s) => a + (s.cost || 0), 0);
  const lines = order.map((label) => {
    const id = label.trim();
    const st = steps[id];
    return `${label.startsWith("  ") ? "    " : "  "}${id}: ${st?.status ?? "pending"}${st?.attempts && st.attempts > 1 ? ` ×${st.attempts}` : ""}${st?.error ? ` — ${st.error.slice(0, 160)}` : ""}`;
  });
  return [`workflow ${state.workflow} · run ${state.id} · ${state.status}${state.error ? ` — ${state.error}` : ""}${cost ? ` · $${cost.toFixed(4)}` : ""}`, ...lines].join("\n");
}
