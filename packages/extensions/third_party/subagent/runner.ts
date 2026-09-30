/**
 * Subagent — running one isolated agent child.
 *
 * Builds the child argv/env, creates the run log, streams the child, and maps the outcome
 * onto a `SingleResult`. `runAgent` takes an options object; `runSingleAgent` is the
 * positional wrapper kept for existing callers and tests.
 *
 * A run is one logical unit with one log/registry entry, but it may make more than one
 * attempt: a *transient* failure (spawn failure, or a non-zero exit with no usable output)
 * is retried up to PI_KIT_SUBAGENT_RETRIES times. Usage is summed across attempts.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runChildProcess } from "./child-process.ts";
import { boundMessage, classifyFailure } from "./result.ts";
import { createRunLog, subagentStateDir } from "./logging.ts";
import { registerLive, unregisterLive } from "./live.ts";
import { isReadOnlyRole, isScoutRole, prepareChildLaunch } from "./launch.ts";
import { skillPreamble } from "./skills.ts";
import {
  DEFAULT_CHILD_APPROVAL_TIMEOUT_MS,
  DEFAULT_CHILD_STREAM_CAP,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_RUNTIME_MS,
  DEFAULT_RETRIES,
  LOG_SKIP_EVENT_TYPES,
  MAX_DEPTH_CEILING,
  MAX_STORED_MESSAGES,
  RETRY_BACKOFF_MS,
  envFlag,
  envInt,
} from "./config.ts";
import type { AgentConfig, Msg, SingleResult, SpawnChild, UsageStats } from "./types.ts";

// Operator-owned exact-role grants include the complete role definition, including its
// optional model frontmatter. The execution policy decides whether it is used.
export function projectRoleDigest(agent: AgentConfig): string {
  return crypto.createHash("sha256").update(JSON.stringify({ name: agent.name, systemPrompt: agent.systemPrompt, tools: agent.tools ?? [], model: agent.model ?? "" })).digest("hex");
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
  items: TIn[],
  concurrency: number,
  fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(concurrency, items.length));
  const results: TOut[] = new Array(items.length);
  let nextIndex = 0;
  const workers = new Array(limit).fill(null).map(async () => {
    while (true) {
      const current = nextIndex++;
      if (current >= items.length) return;
      results[current] = await fn(items[current], current);
    }
  });
  await Promise.all(workers);
  return results;
}

function writePromptTempFile(agentName: string, prompt: string): { dir: string; filePath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagent-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(dir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir, filePath };
}

function emptyUsage(): UsageStats {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
}

function addUsage(target: UsageStats, other: UsageStats): void {
  target.input += other.input;
  target.output += other.output;
  target.cacheRead += other.cacheRead;
  target.cacheWrite += other.cacheWrite;
  target.cost += other.cost;
  target.turns += other.turns;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  // Deliberately NOT unref'd: between attempts there is no child keeping the event loop
  // alive, so an unref'd timer would let the process exit mid-retry.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RunAgentOptions {
  defaultCwd: string;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  cwd?: string;
  step?: number;
  signal?: AbortSignal;
  // onUpdate is invoked once per streamed child message so the parent sees a live
  // "still working" signal instead of a silent tool call until the child closes.
  onUpdate?: (text: string) => void;
  // onSettled fires once when the run is completely done. `detached` is true when the
  // parent's signal had already aborted, i.e. the parent is no longer waiting on the
  // result — used to notify the operator that a detached child finished.
  onSettled?: (result: SingleResult, detached: boolean) => void;
  spawnChild?: SpawnChild;
  parentModel?: string;
  // Force every child onto the parent model, ignoring role `model:` frontmatter.
  inheritParentModel?: boolean;
  // Return immediately with a "detached" result; the child runs on and onSettled reports it.
  background?: boolean;
  // Per-call overrides (workflow steps), applied over the role definition.
  overrides?: RunOverrides;
  // "discretionary" (default): the agent's own delegation, bounded by the effort tier.
  // "user": a launch the person typed (a /workflow command), bounded only by the platform ceilings.
  launchKind?: "discretionary" | "user";
}

export interface RunOverrides {
  model?: string;
  thinking?: string;
  tools?: string[];
  skills?: string[];
  // Extra kit extensions for the isolated child (e.g. memory-vault for memory_save).
  extensions?: string[];
  maxRuntimeMs?: number;
  // Requested effort tier for the child; clamped to the parent's tier.
  effort?: string;
  // Appended to the role's system prompt (e.g. workflow blackboard conventions).
  appendSystemPrompt?: string;
}

export async function runAgent(options: RunAgentOptions): Promise<SingleResult> {
  const {
    defaultCwd,
    agents,
    agentName,
    task,
    cwd,
    step,
    signal,
    onUpdate,
    onSettled,
    spawnChild,
    parentModel,
    inheritParentModel = false,
    background = false,
    overrides = {},
    launchKind = "discretionary",
  } = options;

  // Deeper children receive PI_KIT_SUBAGENT_DEPTH+1; the tool layer refuses to spawn once
  // depth reaches PI_KIT_SUBAGENT_MAX_DEPTH.
  const childDepth = envInt("PI_KIT_SUBAGENT_DEPTH", 0, 0, MAX_DEPTH_CEILING) + 1;
  // Esc / a parent cancel stops the child: an interrupted delegation must not keep spending
  // tokens invisibly, and a chain must not be silently truncated behind a "detached" result.
  // Long work that should outlive the turn is requested explicitly with `background: true`.
  // PI_KIT_SUBAGENT_DETACH_SIGNAL=1 restores the old detach-on-cancel behaviour.
  const detachOnAbort = envFlag("PI_KIT_SUBAGENT_DETACH_SIGNAL", false);
  const abortSignal = background || detachOnAbort ? undefined : signal;

  const early: SingleResult = {
    agent: agentName,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: emptyUsage(),
    step,
  };
  if (abortSignal?.aborted) {
    return { ...early, exitCode: 1, stopReason: "aborted", errorMessage: "Subagent was aborted before launch" };
  }

  const agent = agents.find((a) => a.name === agentName);
  if (!agent) {
    const available = agents.map((a) => `"${a.name}"`).join(", ") || "none";
    return { ...early, exitCode: 1, stderr: `Unknown agent: "${agentName}". Available: ${available}.` };
  }

  // Model: an explicit per-call override, else the role's `model:` frontmatter, else the active
  // parent model. PI_KIT_SUBAGENT_INHERIT_MODEL=1 forces the parent model for every role.
  const selectedModel = overrides.model ?? (inheritParentModel ? parentModel : agent.model ?? parentModel);
  const thinking = overrides.thinking ?? agent.thinking;
  const tools = overrides.tools ?? agent.tools;
  const childCwd = cwd ?? defaultCwd;
  const baseArgs: string[] = ["--mode", "json", "-p", "--no-session"];
  if (selectedModel) baseArgs.push("--model", selectedModel);
  if (thinking) baseArgs.push("--thinking", thinking);
  if (tools && tools.length > 0) baseArgs.push("--tools", tools.join(","));
  // The extension arguments and environment come from delegation-guard per attempt (below): every
  // attempt is a new child execution, so it reserves against the effort budget again.

  const skills = [...new Set([...(agent.skills ?? []), ...(overrides.skills ?? [])])];
  const preload = skillPreamble(skills, childCwd);
  const systemPrompt = `${agent.systemPrompt.trim()}${preload.text}${overrides.appendSystemPrompt ? `\n\n${overrides.appendSystemPrompt.trim()}` : ""}`;

  const runLog = createRunLog(defaultCwd, agentName, task, childDepth - 1);
  runLog.write(`# model=${selectedModel ?? "(parent default)"}${thinking ? ` thinking=${thinking}` : ""}`);
  if (skills.length) runLog.write(`# skills=${skills.join(",")}${preload.missing.length ? ` missing=${preload.missing.join(",")}` : ""}`);

  const streamCap = envInt("PI_KIT_SUBAGENT_STREAM_CAP_BYTES", DEFAULT_CHILD_STREAM_CAP, 64 * 1024, Number.MAX_SAFE_INTEGER);
  const idleTimeoutMs = envInt("PI_KIT_SUBAGENT_IDLE_TIMEOUT_MS", DEFAULT_IDLE_TIMEOUT_MS, 0, Number.MAX_SAFE_INTEGER);
  const maxRuntimeMs = overrides.maxRuntimeMs ?? agent.maxRuntimeMs ?? envInt("PI_KIT_SUBAGENT_MAX_RUNTIME_MS", DEFAULT_MAX_RUNTIME_MS, 0, Number.MAX_SAFE_INTEGER);
  const heartbeatMs = envInt("PI_KIT_SUBAGENT_HEARTBEAT_MS", DEFAULT_HEARTBEAT_MS, 0, Number.MAX_SAFE_INTEGER);
  const maxAttempts = 1 + envInt("PI_KIT_SUBAGENT_RETRIES", DEFAULT_RETRIES, 0, 5);
  const retryBackoffMs = envInt("PI_KIT_SUBAGENT_RETRY_BACKOFF_MS", RETRY_BACKOFF_MS, 0, 60000);

  const runAttempt = async (): Promise<SingleResult> => {
    const result: SingleResult = {
      agent: agentName,
      task,
      exitCode: 0,
      messages: [],
      stderr: "",
      usage: emptyUsage(),
      step,
      logPath: runLog.logPath,
      runId: runLog.id,
      model: selectedModel,
    };
    // Reserve the launch: mandatory protections, effort budget and the child's environment.
    // Refused launches never spawn and are never retried.
    const prepared = prepareChildLaunch({
      cwd: childCwd,
      kind: launchKind,
      role: agentName,
      scout: isScoutRole(agent),
      readOnly: isReadOnlyRole(agent, tools),
      requestedTier: overrides.effort ?? agent.effort,
      extraExtensions: [...(agent.extensions ?? []), ...(overrides.extensions ?? [])],
      needsSubagent: tools?.includes("subagent") ?? false,
      baseEnv: { ...process.env },
    });
    if (!prepared.ok) {
      runLog.write(`# launch refused (${prepared.code}): ${prepared.reason}`);
      return { ...result, exitCode: 1, stopReason: "denied", errorMessage: `Subagent not started: ${prepared.reason}` };
    }
    runLog.write(`# extensions=${prepared.loaded.join(",")} tier=${prepared.childTier}${prepared.slot.id ? ` slot=${prepared.slot.id}` : ""}`);
    const args = [...baseArgs, ...prepared.args];
    let outcomeLabel = "error";
    let tmpDir: string | null = null;
    let tmpPath: string | null = null;
    const startedAt = Date.now();
    let lastTool: string | undefined;
    let lastTarget: string | undefined;

    const shortTarget = (value: string) => (value.length > 48 ? "…" + value.slice(-45) : value);
    const toolTarget = (input: unknown): string | undefined => {
      if (!input || typeof input !== "object") return undefined;
      const o = input as Record<string, unknown>;
      const cand = o.path ?? o.file_path ?? o.filePath ?? o.file ?? o.pattern ?? o.command ?? o.query;
      return typeof cand === "string" ? shortTarget(cand) : undefined;
    };
    const updateText = (suffix: string) => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const tool = lastTool ? ` · last ${lastTool}${lastTarget ? ` ${lastTarget}` : ""}` : "";
      return `[${agentName}]${step ? ` step ${step}` : ""} ${suffix} · ${elapsed}s${tool} · ${result.usage.turns} turn(s) · run ${runLog.id}`;
    };

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: { type?: string; message?: Msg; toolName?: string; args?: unknown; result?: { content?: unknown[] } };
      try {
        event = JSON.parse(line);
      } catch {
        runLog.write(`[unparsed] ${line.slice(0, 300)}`);
        return;
      }
      // Skip per-token deltas; message_end carries the full content and tool_* events show
      // the actions, so the log stays readable and small.
      const type = String(event.type ?? "");
      if (!LOG_SKIP_EVENT_TYPES.has(type)) runLog.write(line);

      // Current pi emits tool_execution_start/end (not tool_result_end). These are the most
      // useful live "what is the child doing right now" signals — without them the parent
      // tool call looked frozen during a long child tool, which is the reported stall.
      if (type === "tool_execution_start") {
        lastTool = event.toolName;
        lastTarget = toolTarget(event.args);
        onUpdate?.(updateText(`running ${event.toolName ?? "tool"}`));
        return;
      }
      if (type === "tool_execution_end") {
        onUpdate?.(updateText(`finished ${event.toolName ?? "tool"}`));
        return;
      }

      if ((type === "message_end" || type === "tool_result_end") && event.message) {
        const msg = event.message;
        // Bound memory: keep only the most recent messages (final answer is kept separately).
        if (result.messages.length >= MAX_STORED_MESSAGES) result.messages.shift();
        result.messages.push(boundMessage(msg));
        if (msg.role === "assistant") {
          result.usage.turns++;
          const u = msg.usage;
          if (u) {
            result.usage.input += u.input || 0;
            result.usage.output += u.output || 0;
            result.usage.cacheRead += u.cacheRead || 0;
            result.usage.cacheWrite += u.cacheWrite || 0;
            result.usage.cost += u.cost?.total || 0;
          }
          if (!result.model && msg.model) result.model = msg.model;
          if (msg.stopReason) result.stopReason = msg.stopReason;
          if (msg.errorMessage) result.errorMessage = msg.errorMessage;
          const assistantText = msg.content.filter((part) => part.type === "text" && part.text).map((part) => part.text as string).join("\n");
          if (assistantText) result.finalOutput = assistantText;
        }
        onUpdate?.(updateText(`${msg.role ?? "message"}${msg.stopReason ? ` (${msg.stopReason})` : ""}`));
      }
    };

    try {
      if (systemPrompt.trim()) {
        const tmp = writePromptTempFile(agent.name, systemPrompt);
        tmpDir = tmp.dir;
        tmpPath = tmp.filePath;
        args.push("--append-system-prompt", tmpPath);
      }
      // The task goes over stdin (merged into the prompt by print mode), never argv: see
      // ChildRunOptions.stdin.
      runLog.write(`# args=${args.join(" ")}`);

      const childEnv: Record<string, string | undefined> = {
        ...prepared.env,
        PI_KIT_INTERNAL_CHILD: "1",
        PI_KIT_SUBAGENT_DEPTH: String(childDepth),
        PI_KIT_SUBAGENT_STATE_DIR: subagentStateDir(defaultCwd),
      };
      // A headless child cannot answer its own tool-firewall "ask"; bound the broker wait so
      // an unanswered approval fails closed in minutes, not the 15-minute root default. The
      // parent's human-console still sees the request and an attentive operator can resolve it.
      if (!childEnv.PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS) {
        childEnv.PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS = String(envInt("PI_KIT_SUBAGENT_APPROVAL_TIMEOUT_MS", DEFAULT_CHILD_APPROVAL_TIMEOUT_MS, 1, Number.MAX_SAFE_INTEGER));
      }
      const outcome = await runChildProcess({
        args,
        stdin: `Task: ${task}`,
        cwd: childCwd,
        env: childEnv,
        signal: abortSignal,
        streamCap,
        idleTimeoutMs,
        maxRuntimeMs,
        heartbeatMs,
        spawnChild,
        onSpawn: (handle) => {
          prepared.slot.attach(handle.pid);
          runLog.attachPid(handle.pid);
          registerLive({
            id: runLog.id,
            agent: agentName,
            pid: handle.pid,
            startedAt: Date.now(),
            cwd: childCwd,
            logPath: runLog.logPath,
            terminate: handle.terminate,
          });
        },
        onLine: processLine,
        onStderr: (text) => {
          result.stderr += text;
          runLog.write(`[stderr] ${text.trimEnd()}`);
        },
        onKill: (reason) => runLog.write(`# killed=${reason}`),
        onHeartbeat: (hb) => onUpdate?.(updateText(`working (idle ${Math.round(hb.idleMs / 1000)}s, out ${Math.round(hb.stdoutBytes / 1024)}KiB)`)),
      });

      result.exitCode = outcome.exitCode;
      outcomeLabel = outcome.killReason ?? (outcome.spawnFailure ? "spawn-failed" : outcome.exitCode === 0 ? "ok" : `exit-${outcome.exitCode}`);
      if (outcome.spawnFailure) {
        result.stopReason = "error";
        result.errorMessage = `Subagent launch failed: ${outcome.spawnFailure}`;
      } else if (outcome.killReason === "signal") {
        result.stopReason = "aborted";
        result.errorMessage = "Subagent was aborted";
      } else if (outcome.killReason === "stream-cap") {
        // Distinct from "error": getResultOutput() treats this as recoverable and prefers
        // whatever partial answer the child already streamed over the bare error text.
        result.stopReason = "stream-cap";
        result.errorMessage = `Subagent terminated: output exceeded ${streamCap} bytes. Raise PI_KIT_SUBAGENT_STREAM_CAP_BYTES for exploration-heavy tasks.`;
      } else if (outcome.killReason === "timeout") {
        result.stopReason = "timeout";
        result.errorMessage = `Subagent terminated: no output for ${idleTimeoutMs} ms. Raise or unset PI_KIT_SUBAGENT_IDLE_TIMEOUT_MS on a slow server.`;
      } else if (outcome.killReason === "wall-clock") {
        result.stopReason = "wall-clock";
        result.errorMessage = `Subagent terminated: exceeded ${Math.round(maxRuntimeMs / 60000)} min wall-clock limit. Raise or unset PI_KIT_SUBAGENT_MAX_RUNTIME_MS for longer tasks.`;
      } else if (outcome.killReason === "stopped") {
        result.stopReason = "stopped";
        result.errorMessage = "Subagent stopped by operator";
      }
      return result;
    } catch (error) {
      return { ...result, exitCode: 1, errorMessage: `Subagent launch failed: ${String(error)}` };
    } finally {
      // Release the concurrency slot. The charge stays whatever happened: a failed, killed or
      // never-started child is not refunded.
      prepared.slot.settle(outcomeLabel);
      unregisterLive(runLog.id);
      if (tmpPath) try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      if (tmpDir) try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
    }
  };

  const settle = async (): Promise<SingleResult> => {
    let result: SingleResult;
    let attempts = 1;
    try {
      result = await runAttempt();
      while (attempts < maxAttempts && classifyFailure(result) === "transient") {
        runLog.write(`# transient failure (attempt ${attempts}: ${result.stopReason ?? `exit ${result.exitCode}`}); retrying in ${retryBackoffMs}ms`);
        await delay(retryBackoffMs);
        attempts++;
        const next = await runAttempt();
        addUsage(next.usage, result.usage);
        result = next;
      }
    } catch (error) {
      runLog.close("launch-error", { error: String(error) });
      return { ...early, exitCode: 1, errorMessage: `Subagent launch failed: ${String(error)}` };
    }

    result.attempts = attempts;
    const stop = result.stopReason ?? (result.exitCode === 0 ? "end" : "error");
    runLog.write(`# exit=${result.exitCode} stopReason=${stop} attempts=${attempts} turns=${result.usage.turns} model=${result.model ?? "?"} cost=${result.usage.cost}`);
    runLog.close(stop, { exitCode: result.exitCode, turns: result.usage.turns, model: result.model, cost: result.usage.cost, attempts });
    return result;
  };

  // The settle promise owns log finalization exactly once. onSettled is attached by the
  // path that resolves first, so a truly-detached run still notifies when it finishes later.
  const settlePromise = settle();
  settlePromise.catch(() => { /* handled by the awaited path or the detached watcher below */ });

  // Explicit background run: hand control straight back; the log, registry and onSettled carry
  // the outcome.
  if (background) {
    settlePromise.then((r) => onSettled?.(r, true), () => {});
    return { ...early, exitCode: 0, stopReason: "detached", detached: true, logPath: runLog.logPath, runId: runLog.id, model: selectedModel };
  }

  // Detach (default): if the parent cancels, stop *awaiting* the child and return control
  // immediately. The child keeps working; its log + registry record the outcome and
  // onSettled notifies the operator. Without this, "detach" was cosmetic — the parent still
  // blocked on the child, so a cancel or interrupt never actually returned control (the
  // reported "tool counter stops and the main agent does not continue").
  if (!abortSignal && signal) {
    const detached: SingleResult = { ...early, exitCode: 0, stopReason: "detached", detached: true, logPath: runLog.logPath, runId: runLog.id, model: selectedModel };
    if (signal.aborted) {
      settlePromise.then((r) => onSettled?.(r, true), () => {});
      return detached;
    }
    let detachResolve!: (value: "__detached__") => void;
    const onAbort = new Promise<"__detached__">((resolve) => { detachResolve = resolve; });
    const onAbortHandler = () => detachResolve("__detached__");
    signal.addEventListener("abort", onAbortHandler, { once: true });
    if (signal.aborted) detachResolve("__detached__"); // guard the check-then-subscribe race
    let winner: SingleResult | "__detached__";
    try {
      winner = await Promise.race([settlePromise, onAbort]);
    } finally {
      // Remove on both paths; after a fired {once:true} listener this is a safe no-op.
      signal.removeEventListener("abort", onAbortHandler);
    }
    if (winner === "__detached__") {
      settlePromise.then((r) => onSettled?.(r, true), () => {});
      return detached;
    }
    onSettled?.(winner as SingleResult, false);
    return winner as SingleResult;
  }

  const result = await settlePromise;
  onSettled?.(result, signal?.aborted === true);
  return result;
}

// Positional wrapper kept for existing callers/tests.
export async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number | undefined,
  signal: AbortSignal | undefined,
  onUpdate?: (text: string) => void,
  spawnChild?: SpawnChild,
  parentModel?: string,
  inheritParentModel = false,
): Promise<SingleResult> {
  return runAgent({
    defaultCwd,
    agents,
    agentName,
    task,
    cwd,
    step,
    signal,
    onUpdate,
    spawnChild,
    parentModel,
    inheritParentModel,
  });
}
