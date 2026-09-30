import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Self-containment rule: only node:* builtins and the pi peer. The extension does not import the
// autonomy package: it runs its operator CLI (packages/autonomy/cli.mjs) as a child process and
// speaks its `--json` protocol, exactly as an operator at a shell would.
//
// /autonomy is the operator's way to start and manage autonomous runs from inside pi. It is a
// COMMAND, not a tool: the model cannot start, steer, authorise or promote a run, because an
// autonomous run spends money and acts without prompts inside its boundary, and only a person
// may decide that. Every decision that matters is confirmed on screen with the boundary in front
// of the person, and without a screen the CLI's own rule applies: a run starts only from a contract
// that already carries an authorisation for exactly this boundary.

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function cliPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_AUTONOMY_CLI?.trim();
  return override || path.resolve(HERE, "..", "..", "..", "autonomy", "cli.mjs");
}

export interface CliResult {
  code: number | null;
  /** The parsed `--json` object, or null when the CLI printed none. */
  json: Record<string, any> | null;
  stdout: string;
  stderr: string;
}

/** Run the CLI once. Always resolves (a missing CLI or a crash is a result, not an exception). */
export function runCli(args: string[], { json = true, cwd, timeoutMs = 120_000, env = process.env }: { json?: boolean; cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}): Promise<CliResult> {
  const cli = cliPath(env);
  return new Promise((resolve) => {
    if (!fs.existsSync(cli)) return resolve({ code: null, json: null, stdout: "", stderr: `the autonomy CLI is not installed at ${cli} (it ships with the kit's packages/autonomy directory)` });
    const child = spawn(process.execPath, [cli, ...args, ...(json ? ["--json"] : [])], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let parsed: Record<string, any> | null = null;
      if (json) {
        try {
          const value = JSON.parse(stdout);
          if (value && typeof value === "object" && !Array.isArray(value)) parsed = value;
        } catch { /* the CLI printed no JSON object */ }
      }
      resolve({ code, json: parsed, stdout, stderr });
    };
    const timer = setTimeout(() => { child.kill("SIGKILL"); stderr += `\ntimed out after ${timeoutMs / 1000}s`; finish(null); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; if (stdout.length > 8_000_000) child.kill("SIGKILL"); });
    child.stderr.on("data", (d) => { stderr += d; if (stderr.length > 1_000_000) stderr = stderr.slice(-500_000); });
    child.on("error", (error) => { stderr += `\n${error.message}`; finish(null); });
    child.on("close", (code) => finish(code));
  });
}

/** Split a command line into words, honouring single and double quotes. No shell is involved anywhere. */
export function splitArgs(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || current) { words.push(current); current = ""; started = false; }
    } else current += ch;
  }
  if (started || current) words.push(current);
  return words;
}

const RUN_ID = /^[a-z0-9][a-z0-9-]{2,40}$/;

const USAGE = [
  "Autonomous runs: /autonomy <command>",
  "  templates                              what kinds of run exist",
  "  init <template> [flags]                write a run contract (flags as `pi-autonomy init`), e.g. --out run.json --spec \"...\" --check unit=\"npm test\"",
  "  plan <run.json>                        validate it and show the boundary and its digest",
  "  start <run.json> [--foreground]        show the boundary, ask you to confirm it, then start (in the background unless --foreground)",
  "  status [run]                           one run, or all of them",
  "  pause <run> | cancel <run>             stop a run's worker (the work is kept)",
  "  resume <run> [answer text | --approve | --deny]",
  "  steer <run> <message>                  send the worker one message",
  "  promote <run>                          carry out an approval-gated promotion",
  "  export <run> [dir]                     results, evidence, usage, decisions and the work",
  "  boundary <run.json> | boundary --run <run>",
  "  reconfigure <run> [--effort E4 --budget-usd n ...]   the only way effort or budgets change for a run",
  "Nothing starts without you confirming the boundary. Runs need a container engine; see docs/autonomy.md.",
].join("\n");

function say(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  else process.stderr.write(`[autonomy] ${text}\n`);
}

const errorText = (r: CliResult): string => {
  const j = r.json;
  if (j && j.ok === false) {
    const problems = Array.isArray(j.problems) ? `\n${j.problems.map((p: any) => `  ${p.level ?? "error"} ${p.path ?? ""}: ${p.message ?? p}`).join("\n")}` : "";
    return `${j.error ?? "the command failed"}${problems}`;
  }
  return (r.stderr || r.stdout || "the command failed").trim().slice(0, 4000);
};

export default function autonomyRun(pi: ExtensionAPI) {
  const resolveFile = (ctx: ExtensionCommandContext, file: string): string => path.resolve(ctx.cwd ?? process.cwd(), file);

  async function show(ctx: ExtensionCommandContext, args: string[]): Promise<CliResult> {
    const r = await runCli(args, { json: false, cwd: ctx.cwd });
    say(ctx, (r.stdout || r.stderr).trim() || "(no output)", r.code === 0 ? "info" : "error");
    return r;
  }

  /** Run a command through the CLI's JSON protocol, and report its text output or its failure. */
  async function run(ctx: ExtensionCommandContext, args: string[]): Promise<CliResult> {
    const text = await runCli(args, { json: false, cwd: ctx.cwd });
    say(ctx, (text.stdout || text.stderr).trim() || "(no output)", text.code === 0 ? "info" : "error");
    return text;
  }

  async function start(ctx: ExtensionCommandContext, words: string[]): Promise<void> {
    const foreground = words.includes("--foreground");
    const file = words.find((w) => !w.startsWith("--"));
    if (!file) return say(ctx, "usage: /autonomy start <run.json> [--foreground]", "error");
    const config = resolveFile(ctx, file);
    const planned = await runCli(["plan", "--config", config], { cwd: ctx.cwd });
    if (!planned.json || planned.json.ok !== true) return say(ctx, `cannot start: ${errorText(planned)}`, "error");
    const plan = planned.json;
    const text = await runCli(["plan", "--config", config], { json: false, cwd: ctx.cwd });
    const boundary = (text.stdout || "").trim();
    const digest = String(plan.digest ?? "");
    const detach = !foreground;

    if (ctx.hasUI) {
      const who = os.userInfo().username;
      const ok = await ctx.ui.confirm(
        `Authorise this boundary and start run ${plan.run}?`,
        `${boundary}\n\nThis run acts without approval prompts inside the boundary above and spends money up to its budget. Only you can authorise it (digest ${digest.slice(0, 12)}).`,
      );
      if (!ok) return say(ctx, "Not authorised. Nothing was started.", "info");
      if (plan.authorisation?.status !== "authorised") {
        const auth = await runCli(["plan", "--config", config, "--authorise", "--yes", "--by", who], { cwd: ctx.cwd });
        if (!auth.json || auth.json.ok !== true) return say(ctx, `could not record the authorisation: ${errorText(auth)}`, "error");
      }
    } else if (plan.authorisation?.status !== "authorised") {
      return say(ctx, `not started: there is no screen to confirm the boundary on, and ${file} does not carry an authorisation for it (digest ${digest.slice(0, 12)}). Authorise it once at a terminal with \`pi-autonomy plan --config ${file} --authorise\`.`, "error");
    }

    const started = await runCli(["start", "--config", config, "--yes", ...(detach ? ["--detach"] : [])], { cwd: ctx.cwd, timeoutMs: detach ? 120_000 : 24 * 60 * 60 * 1000 });
    if (!started.json || started.json.ok !== true) return say(ctx, `not started: ${errorText(started)}`, "error");
    const s = started.json;
    say(ctx, detach
      ? `Run ${s.run} started (supervisor pid ${s.pid}). Follow it with /autonomy status ${s.run}; results with /autonomy export ${s.run}. Logs: ${s.log}`
      : `Run ${s.run} ended: ${s.status}${s.outcome ? ` (${s.outcome.reason})` : ""}. Results: /autonomy export ${s.run}`);
  }

  /** Commands that change a run and first show the CLI's own account of what would change, then ask. */
  async function confirmed(ctx: ExtensionCommandContext, args: string[], title: string): Promise<void> {
    const first = await runCli(args, { cwd: ctx.cwd });
    if (first.json?.ok === true) return say(ctx, (await runCli(args, { json: false, cwd: ctx.cwd })).stdout.trim() || "done");
    // A refusal that says it needs approval carries the description of what would happen.
    const needs = first.json?.ok === false && first.json?.code === "refused" && /needs your (approval|confirmation)|--yes/.test(String(first.json.error ?? ""));
    if (!needs) return say(ctx, errorText(first), "error");
    if (!ctx.hasUI) return say(ctx, `${errorText(first)}\n(no screen to confirm on; run the command at a terminal)`, "error");
    const ok = await ctx.ui.confirm(title, String(first.json!.error));
    if (!ok) return say(ctx, "Not confirmed. Nothing changed.", "info");
    const done = await runCli([...args, "--yes"], { json: false, cwd: ctx.cwd });
    say(ctx, (done.stdout || done.stderr).trim() || "done", done.code === 0 ? "info" : "error");
  }

  pi.registerCommand("autonomy", {
    description: "Start and manage autonomous runs in a hardened container: /autonomy templates|init|plan|start|status|pause|resume|steer|cancel|promote|export|boundary|reconfigure. A run only starts after you confirm its boundary.",
    getArgumentCompletions: (prefix: string) =>
      ["templates", "init", "plan", "start", "status", "pause", "resume", "steer", "cancel", "promote", "export", "boundary", "reconfigure", "help"]
        .filter((v) => v.startsWith(prefix.trim().toLowerCase()))
        .map((v) => ({ value: v, label: v })),
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const words = splitArgs(args);
      const cmd = (words.shift() ?? "help").toLowerCase();
      const runId = (): string | null => {
        const id = words[0];
        if (!id || !RUN_ID.test(id)) { say(ctx, `usage: /autonomy ${cmd} <run>  (a run id such as todo-api-1; \`/autonomy status\` lists them)`, "error"); return null; }
        return id;
      };
      switch (cmd) {
        case "help":
        case "?":
          return say(ctx, USAGE);
        case "templates": {
          const r = await runCli(["templates"], { cwd: ctx.cwd });
          if (!r.json || r.json.ok !== true) return say(ctx, errorText(r), "error");
          return say(ctx, (r.json.templates as any[]).map((t) => `${t.id} (${t.finite ? "finite" : "cycling"}): ${t.title}\n  ${t.summary}\n  needs: ${(t.requires ?? []).join("; ")}`).join("\n\n"));
        }
        case "init": {
          const template = words.shift();
          if (!template || template.startsWith("-")) return say(ctx, "usage: /autonomy init <template> [--out run.json] [--spec \"...\"] [--check id=command] ...  (see /autonomy templates)", "error");
          const out = words.includes("--out") ? [] : ["--out", "run.json"];
          const r = await runCli(["init", "--template", template, ...out, ...words], { cwd: ctx.cwd });
          if (!r.json || r.json.ok !== true) return say(ctx, `init failed: ${errorText(r)}`, "error");
          return say(ctx, `Wrote ${r.json.path}${(r.json.problems ?? []).length ? `\n${(r.json.problems as any[]).map((p) => `  ${p.level} ${p.path}: ${p.message}`).join("\n")}` : ""}\nNext: /autonomy plan ${path.basename(String(r.json.path))}`);
        }
        case "plan": {
          if (!words[0]) return say(ctx, "usage: /autonomy plan <run.json>", "error");
          await show(ctx, ["plan", "--config", resolveFile(ctx, words[0])]);
          return;
        }
        case "boundary": {
          if (words[0] === "--run" && words[1]) { await show(ctx, ["boundary", "--run", words[1]]); return; }
          if (!words[0]) return say(ctx, "usage: /autonomy boundary <run.json> | boundary --run <run>", "error");
          await show(ctx, ["boundary", "--config", resolveFile(ctx, words[0])]);
          return;
        }
        case "start":
          return start(ctx, words);
        case "status": {
          if (words[0] && !RUN_ID.test(words[0])) return say(ctx, "usage: /autonomy status [run]", "error");
          await run(ctx, ["status", ...(words[0] ? ["--run", words[0]] : [])]);
          return;
        }
        case "pause": {
          const id = runId();
          if (id) await run(ctx, ["pause", "--run", id]);
          return;
        }
        case "cancel": {
          const id = runId();
          if (!id) return;
          if (ctx.hasUI && !(await ctx.ui.confirm(`Cancel run ${id}?`, "The worker is stopped and the run ends as cancelled. The work is kept and can still be exported."))) return say(ctx, "Not cancelled.");
          await run(ctx, ["cancel", "--run", id]);
          return;
        }
        case "resume": {
          const id = runId();
          if (!id) return;
          const rest = words.slice(1);
          const approve = rest.includes("--approve");
          const deny = rest.includes("--deny");
          const answer = rest.filter((w) => w !== "--approve" && w !== "--deny").join(" ").trim();
          if (approve && ctx.hasUI && !(await ctx.ui.confirm(`Approve for run ${id}?`, "You are answering the run's pending approval with yes. Check `/autonomy status` for what it is asking."))) return say(ctx, "Not approved.");
          if (approve && !ctx.hasUI) return say(ctx, "approving a run's request needs a screen to confirm on", "error");
          await run(ctx, ["resume", "--run", id, "--detach", ...(approve ? ["--approve"] : []), ...(deny ? ["--deny"] : []), ...(answer ? ["--answer", answer] : [])]);
          return;
        }
        case "steer": {
          const id = runId();
          if (!id) return;
          const message = words.slice(1).join(" ").trim();
          if (!message) return say(ctx, "usage: /autonomy steer <run> <message>", "error");
          await run(ctx, ["steer", "--run", id, "--message", message]);
          return;
        }
        case "promote": {
          const id = runId();
          if (id) await confirmed(ctx, ["promote", "--run", id], `Promote the result of run ${id}?`);
          return;
        }
        case "export": {
          const id = runId();
          if (!id) return;
          await run(ctx, ["export", "--run", id, ...(words[1] ? ["--out", resolveFile(ctx, words[1])] : [])]);
          return;
        }
        case "reconfigure": {
          const id = runId();
          if (id) await confirmed(ctx, ["reconfigure", "--run", id, ...words.slice(1)], `Change run ${id}'s limits?`);
          return;
        }
        default:
          return say(ctx, `unknown command "${cmd}".\n${USAGE}`, "error");
      }
    },
  });
}
