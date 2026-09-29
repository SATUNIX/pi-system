import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
// A compiled `pi` binary is its own process.execPath; only a JS runtime (node/bun/deno) needs
// the cli.js entry prepended. Prepending it unconditionally made a compiled pi read the script
// path as the child's first prompt (the WU-15 failure, fixed in subagent but copied here).
const PI_JS_RUNTIMES = new Set(["node", "nodejs", "bun", "deno"]);
function piChildArgv(cli: string, args: string[], execPath: string = process.execPath): string[] {
  const runtime = execPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "") ?? "";
  return PI_JS_RUNTIMES.has(runtime) ? [cli, ...args] : [...args];
}


const DUAL_REVIEW_MODEL = process.env.DUAL_REVIEW_MODEL ?? "";
const REVIEW_TIMEOUT_MS = 45000;

export default function (pi: ExtensionAPI, spawnChild: typeof spawn = spawn, runExecFile: typeof execFile = execFile) {
  let epoch = 0;
  const pending = new Set<() => void>();
  const invalidate = () => { epoch++; for (const stop of pending) stop(); };
  pi.on("input", async (event) => { if (event.source !== "extension") invalidate(); });
  pi.on("session_shutdown", async () => invalidate());
  pi.on("session_before_switch", async () => invalidate());
  if (!DUAL_REVIEW_MODEL) {
    pi.on("session_start", async (_event, ctx) => {
      ctx.ui.notify(
        "dual-review: DUAL_REVIEW_MODEL not set. Set it to a model name to enable second-model review. Extension loaded but /review will use the primary model.",
        "info",
      );
    });
  }

  function launchReviewer(diff: string, cwd: string, signal?: AbortSignal): void {
    if (signal?.aborted) return;
    const reviewEpoch = epoch;
    const prompt = `You are a code reviewer. Review the following diff for correctness, security, and style. Be concise.\n\n${diff.slice(0, 8000)}`;
    const args = DUAL_REVIEW_MODEL
      ? ["--print", prompt, "--no-session", "--model", DUAL_REVIEW_MODEL]
      : ["--print", prompt, "--no-session"];
    const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
    // The reviewer is a plain read-only model call: no kit/package extensions (formatters,
    // steering, memory) belong in it.
    const child = spawnChild(process.execPath, piChildArgv(cli, ["--no-extensions", "--tools", "read,grep,find,ls", ...args]), { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_KIT_INTERNAL_CHILD: "1" } });
    let out = "";
    let exited = false;
    let cancelled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      if (exited || cancelled) return;
      cancelled = true;
      child.kill("SIGTERM");
      escalation = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 5000);
      escalation.unref();
    };
    pending.add(stop);
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(() => {
      stop();
      out += "\n[reviewer timed out after 45s]";
    }, REVIEW_TIMEOUT_MS);
    const collect = (d: Buffer) => { out += d.toString(); if (out.length > 100_000) { out = out.slice(0, 100_000) + "\n[review output limit reached]"; stop(); } };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const cleanup = () => {
      exited = true;
      clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      pending.delete(stop);
      signal?.removeEventListener("abort", stop);
    };
    // Report a result at most once. Our own stop() (timeout/output cap) is not cancellation:
    // only an external abort or an epoch bump suppresses the report. Guarding on `reported`
    // keeps a spawn `error` followed by `close` from sending twice.
    let reported = false;
    const report = (content: string) => {
      if (reported || signal?.aborted || epoch !== reviewEpoch) return;
      reported = true;
      cleanup();
      pi.sendMessage({ customType: "dual-review-result", content, display: true }, { triggerTurn: false });
    };
    child.once("error", (error: Error) => {
      cleanup();
      report(`## Code Review (failed)\n\nReviewer failed to start: ${error.message}`);
    });
    child.on("close", async (code) => {
      cleanup();
      report(`## Code Review (${code === 0 ? "completed" : "failed"})\n\n${out.trim() || "(no output)"}`);
    });
  }

  function getGitDiff(args: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const gitArgs = args.trim() ? ["diff", "--", args.trim()] : ["diff"];
      runExecFile("git", gitArgs, { cwd, shell: false, windowsHide: true }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(stderr.trim() || err.message));
          return;
        }
        resolve(stdout);
      });
    });
  }

  pi.registerCommand("review", {
    description: "Spawn a reviewer agent on the current git diff. Optionally pass a path argument.",
    handler: async (args, ctx) => {
      ctx.ui.notify("dual-review: running git diff…", "info");
      let diff: string;
      try {
        diff = await getGitDiff(args, ctx.cwd);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`dual-review: git diff failed: ${message}`, "error");
        return;
      }
      if (!diff.trim()) {
        ctx.ui.notify("dual-review: no diff to review.", "info");
        return;
      }
      ctx.ui.notify("dual-review: reviewer launched. Result will follow.", "info");
      launchReviewer(diff, ctx.cwd);
    },
  });

  pi.registerTool({
    name: "dual_review",
    label: "Dual review",
    description: "Run a second-agent review on a diff or file. Returns immediately; review arrives as a displayed result without starting another turn.",
    parameters: Type.Object({
      content: Type.String({ description: "Diff or code to review" }),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      launchReviewer(params.content, ctx.cwd, signal);
      return {
        content: [{ type: "text" as const, text: "Review running… result will be displayed without starting another turn." }],
        details: undefined,
      };
    },
  });
}
