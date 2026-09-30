/**
 * Workflows — tool and command registration (`workflow_run`, `workflow_status`, `/workflow`).
 */
import path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverAgents } from "./agents.ts";
import {
  discoverWorkflows,
  executeWorkflow,
  listRuns,
  loadState,
  newRunState,
  resolveInputs,
  runsRoot,
  summarizeRun,
  workflowDigest,
  type RunState,
  type WorkflowDef,
} from "./workflow.ts";
import type { ToolContext } from "./types.ts";

const active = new Map<string, AbortController>();

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], details: undefined, ...(isError ? { isError: true } : {}) };
}

function parentModelOf(ctx: ToolContext): string | undefined {
  const m = ctx.model;
  if (typeof m?.id !== "string" || !m.id) return undefined;
  return m.provider ? `${m.provider}/${m.id}` : m.id;
}

// Project workflows can run arbitrary delegated work, so like project roles they need the
// operator's approval (or an exact digest grant in PI_KIT_TRUSTED_WORKFLOWS).
async function trustError(w: WorkflowDef, ctx: ToolContext): Promise<string | null> {
  if (w.source !== "project") return null;
  const trusted = (process.env.PI_KIT_TRUSTED_WORKFLOWS ?? "").split(";");
  if (trusted.includes(workflowDigest(w))) return null;
  if (!ctx.hasUI || !ctx.ui?.confirm) return `Blocked: project workflow "${w.name}" needs interactive approval (or its digest in PI_KIT_TRUSTED_WORKFLOWS).`;
  const ok = await ctx.ui.confirm("Run project workflow?", `${w.name}: ${w.description}\nSource: ${w.file}\n\nOnly continue for trusted repositories.`);
  return ok ? null : "Cancelled: project workflow not approved.";
}

function listText(cwd: string): string {
  const { workflows, errors } = discoverWorkflows(cwd);
  const lines = workflows.map((w) => {
    const inputs = Object.entries(w.inputs).map(([k, v]) => `${k}${v.required ? "*" : ""}`).join(", ");
    return `- ${w.name} (${w.source}): ${w.description}${inputs ? ` — inputs: ${inputs}` : ""}`;
  });
  return [lines.length ? `Workflows:\n${lines.join("\n")}` : "No workflows found.", errors.length ? `\nInvalid workflow files:\n${errors.map((e) => `  ${e}`).join("\n")}` : ""].join("");
}

function parseKv(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  let lastKey: string | undefined;
  for (const a of args) {
    const m = a.match(/^([A-Za-z_][\w-]*)=(.*)$/);
    if (m) {
      out[m[1]] = m[2].replace(/^["']|["']$/g, "");
      lastKey = m[1];
    } else if (lastKey) out[lastKey] += ` ${a}`; // unquoted multi-word values: goal=fix the login bug
  }
  for (const k of Object.keys(out)) out[k] = out[k].replace(/^["']|["']$/g, "").trim();
  return out;
}

async function start(
  pi: ExtensionAPI,
  ctx: ToolContext,
  name: string,
  inputsGiven: Record<string, string>,
  opts: { resume?: RunState; signal?: AbortSignal; onProgress?: (t: string) => void; launchKind?: "discretionary" | "user" },
): Promise<{ state?: RunState; error?: string; workflow?: WorkflowDef }> {
  const cwd = ctx.cwd ?? process.cwd();
  const { workflows } = discoverWorkflows(cwd);
  const w = workflows.find((x) => x.name === name);
  if (!w) return { error: `Unknown workflow "${name}".\n${listText(cwd)}` };
  const trust = await trustError(w, ctx);
  if (trust) return { error: trust };
  let state = opts.resume;
  if (!state) {
    const { inputs, missing } = resolveInputs(w, inputsGiven);
    if (missing.length) return { error: `Missing required input(s) for ${name}: ${missing.join(", ")}. Inputs: ${Object.entries(w.inputs).map(([k, v]) => `${k}${v.required ? "*" : ""} (${v.description ?? ""})`).join("; ")}` };
    state = newRunState(w, inputs);
  }
  const controller = new AbortController();
  const onParentAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onParentAbort, { once: true });
  active.set(state.id, controller);
  try {
    const agents = discoverAgents(cwd, "user").agents;
    const final = await executeWorkflow(w, state, { cwd, agents, signal: controller.signal, parentModel: parentModelOf(ctx), onProgress: opts.onProgress, launchKind: opts.launchKind });
    return { state: final, workflow: w };
  } finally {
    active.delete(state.id);
    opts.signal?.removeEventListener("abort", onParentAbort);
  }
}

export function registerWorkflowTools(pi: ExtensionAPI): void {
  // Workflows orchestrate subagents; a subagent child never starts one itself.
  if (process.env.PI_KIT_INTERNAL_CHILD === "1") return;

  pi.registerTool({
    name: "workflow_run",
    label: "Workflow",
    description:
      "Run a saved workflow: a deterministic chain of subagent/skill steps with a shared run directory, review gates and resume. " +
      'Use name "list" to see available workflows and their inputs. Prefer a matching workflow over hand-building subagent chains.',
    promptSnippet: "Run a saved multi-step subagent workflow (list, or run by name with inputs)",
    parameters: Type.Object({
      name: Type.String({ description: 'Workflow name, or "list"' }),
      inputs: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Workflow inputs, e.g. {goal: \"...\"}" })),
      resume: Type.Optional(Type.String({ description: "Run id to resume instead of starting a new run" })),
    }),
    async execute(_id, params, signal, onUpdate, rawCtx) {
      const ctx = rawCtx as unknown as ToolContext;
      const cwd = ctx.cwd ?? process.cwd();
      if (params.name === "list") return textResult(listText(cwd));
      let resume: RunState | undefined;
      if (params.resume) {
        const s = loadState(cwd, params.resume);
        if (!s) return textResult(`No run "${params.resume}".`, true);
        if (s.status === "passed") return textResult(`Run ${s.id} already passed.`);
        resume = s;
      }
      const report = (t: string) => {
        onUpdate?.({ content: [{ type: "text", text: t }], details: undefined });
        try {
          ctx.ui?.setStatus?.("workflow", t.slice(0, 120));
        } catch {
          /* best effort */
        }
      };
      try {
        const r = await start(pi, ctx, resume?.workflow ?? params.name, params.inputs ?? {}, { resume, signal, onProgress: report });
        if (r.error) return textResult(r.error, true);
        const dir = path.join(runsRoot(cwd), r.state!.id);
        const last = r.workflow!.steps[r.workflow!.steps.length - 1];
        const tail = r.state!.status === "passed" ? `\n\nFinal step (${last.id}) output: ${dir}/steps/${last.id}.md` : r.state!.status === "interrupted" ? `\n\nResume with workflow_run {resume: "${r.state!.id}"} or /workflow resume ${r.state!.id}` : "";
        return textResult(`${summarizeRun(r.state!, r.workflow)}\n\nRun directory: ${dir}${tail}`, r.state!.status === "failed");
      } finally {
        try {
          ctx.ui?.setStatus?.("workflow", undefined);
        } catch {
          /* best effort */
        }
      }
    },
  });

  pi.registerTool({
    name: "workflow_status",
    label: "Workflow status",
    description: "Show recent workflow runs, or one run's step-by-step state (with id).",
    promptSnippet: "Inspect workflow runs",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    async execute(_id, params, _signal, _onUpdate, rawCtx) {
      const cwd = (rawCtx as unknown as ToolContext).cwd ?? process.cwd();
      if (params.id) {
        const s = loadState(cwd, params.id);
        return s ? textResult(`${summarizeRun(s)}\n\nRun directory: ${path.join(runsRoot(cwd), s.id)}`) : textResult(`No run "${params.id}".`, true);
      }
      const runs = listRuns(cwd, 10);
      return textResult(runs.length ? runs.map((r) => `- ${r.id}: ${r.status}${active.has(r.id) ? " (active)" : ""}${r.error ? ` — ${r.error.slice(0, 120)}` : ""}`).join("\n") : "No workflow runs yet.");
    },
  });

  pi.registerCommand("workflow", {
    description: "Workflows: /workflow list | run <name> key=value… | status [id] | resume <id> | stop <id>",
    getArgumentCompletions: (prefix: string) => {
      const words = prefix.trimStart().split(/\s+/);
      if (words.length <= 1) return ["list", "run ", "status", "resume ", "stop "].filter((v) => v.startsWith(words[0] ?? "")).map((v) => ({ value: v, label: v.trim() }));
      if (words[0] === "run" && words.length === 2) {
        const { workflows } = discoverWorkflows(process.cwd());
        return workflows.filter((w) => w.name.startsWith(words[1])).map((w) => ({ value: `run ${w.name} `, label: w.name, description: w.description }));
      }
      return null;
    },
    handler: async (args, rawCtx) => {
      const ctx = rawCtx as unknown as ToolContext & { ui: { notify(m: string, l?: string): void; select?(t: string, o: string[]): Promise<string | undefined>; input?(t: string, p?: string): Promise<string | undefined> } };
      const cwd = ctx.cwd ?? process.cwd();
      const [sub = "list", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const notify = (m: string, l = "info") => ctx.ui.notify(m, l);
      if (sub === "list") return notify(listText(cwd));
      if (sub === "status") {
        const id = rest[0];
        if (id) {
          const s = loadState(cwd, id);
          return notify(s ? `${summarizeRun(s)}\nRun directory: ${path.join(runsRoot(cwd), s.id)}` : `No run "${id}".`);
        }
        const runs = listRuns(cwd, 10);
        return notify(runs.length ? runs.map((r) => `${r.id}: ${r.status}${active.has(r.id) ? " (active)" : ""}`).join("\n") : "No workflow runs yet.");
      }
      if (sub === "stop") {
        const c = active.get(rest[0] ?? "");
        if (!c) return notify(`No active run "${rest[0] ?? ""}" in this session.`, "warning");
        c.abort();
        return notify(`Stopping ${rest[0]} (it can be resumed with /workflow resume ${rest[0]}).`);
      }
      if (sub === "run" || sub === "resume") {
        let name = rest[0];
        let inputs = parseKv(rest.slice(1));
        let resume: RunState | undefined;
        if (sub === "resume") {
          const s = loadState(cwd, rest[0] ?? "");
          if (!s) return notify(`No run "${rest[0] ?? ""}".`, "error");
          resume = s;
          name = s.workflow;
        } else if (!name) {
          const { workflows } = discoverWorkflows(cwd);
          if (!ctx.hasUI || !ctx.ui.select || !workflows.length) return notify(listText(cwd));
          const pick = await ctx.ui.select("Run workflow", workflows.map((w) => `${w.name} — ${w.description}`));
          if (!pick) return;
          name = pick.split(" — ")[0];
          const w = workflows.find((x) => x.name === name)!;
          for (const [k, spec] of Object.entries(w.inputs)) {
            const v = ctx.ui.input ? await ctx.ui.input(`${name}: ${k}${spec.required ? " (required)" : ""}`, spec.description) : undefined;
            if (v === undefined && spec.required) return;
            if (v) inputs = { ...inputs, [k]: v };
          }
        }
        // Commands run outside a turn: the workflow runs in the background, drives the footer,
        // and posts its summary into the session when done so the agent can pick it up.
        notify(`workflow ${name}: started${resume ? ` (resuming ${resume.id})` : ""}. /workflow status to follow, /workflow stop <id> to stop.`);
        void start(pi, ctx, name, inputs, { resume, launchKind: "user", onProgress: (t) => ctx.ui?.setStatus?.("workflow", t.slice(0, 120)) })
          .then((r) => {
            try {
              ctx.ui?.setStatus?.("workflow", undefined);
            } catch {
              /* session may be gone */
            }
            const text = r.error ? `workflow ${name}: ${r.error}` : `${summarizeRun(r.state!, r.workflow)}\nRun directory: ${path.join(runsRoot(cwd), r.state!.id)}`;
            try {
              pi.sendMessage({ customType: "workflow-result", content: text, display: true }, { deliverAs: "followUp", triggerTurn: false });
            } catch {
              notify(text, r.error || r.state?.status !== "passed" ? "warning" : "info");
            }
          })
          .catch((error) => notify(`workflow ${name} crashed: ${String(error)}`, "error"));
        return;
      }
      notify(`Unknown subcommand "${sub}". /workflow list | run <name> key=value… | status [id] | resume <id> | stop <id>`, "error");
    },
  });
}
