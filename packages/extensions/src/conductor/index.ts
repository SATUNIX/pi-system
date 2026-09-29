import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import os from "node:os";
import { Type } from "typebox";
import { pendingValidatorFindings, registerValidatorTools } from "./validate/validator.ts";

// conductor: durable, restartable engagement lifecycle state. It only contributes
// context for context-sieve to inject; it never injects a system prompt itself.

export const PHASES = [
  "intake",
  "authorisation",
  "scoping",
  "recon-planning",
  "execution",
  "evidence",
  "independent-validation",
  "reporting",
  "close-out",
] as const;

type Phase = (typeof PHASES)[number];

interface EngagementHistory {
  phase: Phase;
  at: string;
  note?: string;
}

export interface RecursionBudget {
  maxDepth: number;
  maxDispatches: number;
  dispatchesUsed: number;
}

interface Engagement {
  version: 2;
  phase: Phase;
  startedAt: string;
  updatedAt: string;
  history: EngagementHistory[];
  recursion: RecursionBudget;
}

interface TraceEntry {
  ts: string;
  turn: number;
  kind: "call" | "result";
  tool: string;
  target?: string;
  argsHash: string;
  status?: "ok" | "error";
}

const VERDICT_MAX_AGE_MS = Number(process.env.PI_KIT_VERDICT_MAX_AGE_MS) || 24 * 60 * 60 * 1000;
const EXT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_RECURSION_BUDGET: Readonly<RecursionBudget> = Object.freeze({ maxDepth: 2, maxDispatches: 8, dispatchesUsed: 0 });
const AGENT_NAME = /^[a-z0-9][a-z0-9-]*$/;
const LOCK_STALE_MS = 60_000;
// Shell access is deliberately excluded in Phase 4: a bash-capable child could invoke
// pi directly and evade the wrapper-owned durable reservation boundary.
const SPECIALIST_ALLOWED_TOOLS = new Set(["read", "grep", "find", "ls", "write", "edit"]);
const DEFAULT_PROTECTED_PATHS = [".env", ".git/", "node_modules/"];

// The child runner resolves validator from .pi/agents. Preserve operator edits and
// use temp+rename so another turn never observes a partial role template.
function materializeValidatorAgent(cwd: string): void {
  const source = path.join(EXT_DIR, "agents", "validator.md");
  const target = path.join(cwd, ".pi", "agents", "validator.md");
  if (fs.existsSync(target)) return;
  const content = fs.readFileSync(source, "utf8");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, content, "utf8");
  try { fs.renameSync(temp, target); } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* ignore */ }
    if (!fs.existsSync(target)) throw error;
  }
}

function engagementFile(cwd: string): string {
  return path.join(cwd, ".pi", "engagement", "engagement.json");
}

// B-005: contribution files are scoped per session so concurrent sessions sharing a cwd
// (child agents do) cannot overwrite each other. The resolver is duplicated in each producer
// (not imported) because every extension must stay independently extractable
// (packages/core/verify.mjs self-containment lint).
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
let currentSessionId: string | undefined;

function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_RE.test(value);
}

function resolveSessionId(sessionManager?: unknown): string | undefined {
  try {
    const id = (sessionManager as { getSessionId?: () => unknown } | undefined)?.getSessionId?.();
    return isSessionId(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

function contribDir(cwd: string, sessionId: string | undefined = currentSessionId): string {
  const base = path.join(cwd, ".pi", "ctx-contributions");
  return isSessionId(sessionId) ? path.join(base, "sessions", sessionId) : base;
}

function contributionFile(cwd: string): string {
  return path.join(contribDir(cwd), "conductor.json");
}

function isPhase(value: unknown): value is Phase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

function isEngagement(value: unknown): value is Engagement {
  const record = value as Partial<Engagement> | null;
  const budget = record?.recursion as Partial<RecursionBudget> | undefined;
  const validBudget = !!budget && typeof budget.maxDepth === "number" && Number.isSafeInteger(budget.maxDepth) && budget.maxDepth >= 0 &&
    typeof budget.maxDispatches === "number" && Number.isSafeInteger(budget.maxDispatches) && budget.maxDispatches > 0 &&
    typeof budget.dispatchesUsed === "number" && Number.isSafeInteger(budget.dispatchesUsed) && budget.dispatchesUsed >= 0;
  return !!record && record.version === 2 && isPhase(record.phase) && typeof record.startedAt === "string" &&
    typeof record.updatedAt === "string" && Array.isArray(record.history) && validBudget;
}

function readEngagement(cwd: string): Engagement | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(engagementFile(cwd), "utf8")) as unknown;
    if (isEngagement(parsed)) return parsed;
    // Phase 1-3 records are safely upgraded on their next durable mutation.
    const legacy = parsed as { version?: unknown; phase?: unknown; startedAt?: unknown; updatedAt?: unknown; history?: unknown } | null;
    if (legacy?.version === 1 && isPhase(legacy.phase) && typeof legacy.startedAt === "string" && typeof legacy.updatedAt === "string" && Array.isArray(legacy.history)) {
      return { version: 2, phase: legacy.phase, startedAt: legacy.startedAt, updatedAt: legacy.updatedAt, history: legacy.history, recursion: { ...DEFAULT_RECURSION_BUDGET } };
    }
    return null;
  } catch {
    return null;
  }
}

// Atomic write: a reader on another turn never sees a partially-written engagement record.
function saveEngagement(cwd: string, engagement: Engagement): void {
  const file = engagementFile(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(engagement, null, 2), "utf8");
  fs.renameSync(temp, file);
}

function isStale(at: unknown): boolean {
  if (typeof at !== "string") return false;
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return false;
  return Date.now() - parsed > VERDICT_MAX_AGE_MS;
}

// Sources reserved for independent, non-model writers. Kept in parity with verifier-board's
// isTrustedVerdictSource (self-containment forbids importing it): an untrusted-only board
// must not satisfy completion (WU-1 trust hardening).
const TRUSTED_SOURCE_PATTERNS: RegExp[] = [/^verify$/i, /^review$/i, /^validator:/i];

function isTrustedVerdictSource(source: unknown): boolean {
  const s = typeof source === "string" ? source.trim() : "";
  return s.length > 0 && TRUSTED_SOURCE_PATTERNS.some((p) => p.test(s));
}

// verify-gate's in-flight marker, read without importing verify-gate (self-containment).
// The TTL mirrors verify-gate.isVerifyPendingActive (PI_KIT_VERIFY_PENDING_TTL_MS,
// default 30 min) so a marker left by a SIGKILLed/crashed session cannot block
// phase advance forever.
function verifyPending(cwd: string): boolean {
  const file = path.join(cwd, ".pi", "verify-pending.json");
  try {
    const raw = fs.readFileSync(file, "utf8");
    let startedAt = Date.parse(JSON.parse(raw)?.startedAt ?? "");
    if (Number.isNaN(startedAt)) startedAt = fs.statSync(file).mtimeMs;
    const ttl = Number(process.env.PI_KIT_VERIFY_PENDING_TTL_MS);
    const ttlMs = Number.isFinite(ttl) && ttl > 0 ? Math.floor(ttl) : 30 * 60 * 1000;
    return Date.now() - startedAt <= ttlMs;
  } catch {
    return false;
  }
}

// Kept in parity with verifier-board/orchestrator's own copies: self-containment
// forbids importing another extension, so this fail-closed read-only gate is local.
export function verifierBoardBlocked(cwd: string): { blocked: boolean; failing: string[] } {
  if (verifyPending(cwd)) return { blocked: true, failing: ["verify (in progress)"] };
  const file = path.join(cwd, ".pi", "verdicts.json");
  let board: unknown;
  try {
    if (!fs.existsSync(file)) return { blocked: true, failing: ["(no verdicts recorded — verification has not run)"] };
    board = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { blocked: true, failing: ["(verdict board unreadable or corrupt)"] };
  }
  const verdicts = (board as { verdicts?: unknown } | null)?.verdicts;
  if (!verdicts || typeof verdicts !== "object" || Array.isArray(verdicts)) {
    return { blocked: true, failing: ["(verdict board malformed)"] };
  }
  const sources = Object.keys(verdicts as Record<string, unknown>);
  if (sources.length === 0) return { blocked: true, failing: ["(no verdicts recorded yet)"] };
  const failing = sources.filter((source) => {
    const verdict = (verdicts as Record<string, { pass?: unknown; at?: unknown }>)[source];
    return !verdict || verdict.pass !== true || isStale(verdict.at);
  });
  if (failing.length > 0) return { blocked: true, failing };
  // Every recorded source passes and is fresh, but completion also requires at least one
  // trusted, independent source (WU-1).
  if (!sources.some((source) => isTrustedVerdictSource(source))) {
    return { blocked: true, failing: ["(no trusted verdict source — need verify, review, or validator:<id>)"] };
  }
  return { blocked: false, failing: [] };
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function appendTrace(cwd: string, entry: TraceEntry): void {
  try {
    const file = path.join(cwd, ".pi", "trace.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* best effort: audit logging never breaks an engagement operation */
  }
}

function auditTransition(cwd: string, now: string, tool: string, target: string, status: "ok" | "error"): void {
  appendTrace(cwd, { ts: now, turn: 0, kind: "result", tool, target, argsHash: shortHash(`${tool}:${target}`), status });
}

function recursionStatus(budget: RecursionBudget, depth = currentDepth()): string {
  return `depth ${depth}/${budget.maxDepth} · dispatches ${budget.dispatchesUsed}/${budget.maxDispatches}`;
}

function setRecursionStatus(ui: { setStatus?: (key: string, text: string) => void } | undefined, engagement: Engagement | null): void {
  if (engagement) ui?.setStatus?.("conductor-recursion", `Conductor: ${recursionStatus(engagement.recursion)}`);
}

function currentDepth(): number {
  const raw = process.env.PI_KIT_CONDUCTOR_DEPTH;
  if (raw === undefined) return 0;
  return /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) ? Number(raw) : -1;
}

export function withEngagementLock<T>(cwd: string, operation: () => T): T | { ok: false; reason: string } {
  const lock = path.join(cwd, ".pi", "engagement", "recursion.lock");
  let fd: number | undefined;
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    try { fd = fs.openSync(lock, "wx"); } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true }); } catch { /* fail closed below */ }
      try { fd = fs.openSync(lock, "wx"); } catch { return { ok: false, reason: "engagement ledger is busy or unreadable" }; }
    }
    try { return operation(); } finally {
      try { if (fd !== undefined) fs.closeSync(fd); } catch { /* release best effort */ }
      try { fs.rmSync(lock, { force: true }); } catch { /* stale lock is fail-closed */ }
    }
  } catch { return { ok: false, reason: "engagement ledger is unavailable" }; }
}

export type SpecialistRunResult = { ok: true; output: string } | { ok: false; reason: string };
export type SpecialistRunner = (cwd: string, agent: string, task: string, childDepth: number, signal?: AbortSignal, onUpdate?: (text: string) => void) => Promise<SpecialistRunResult>;

function agentDefinition(cwd: string, agent: string): { prompt: string; tools: string[] } | null {
  try {
    const source = fs.readFileSync(path.join(cwd, ".pi", "agents", `${agent}.md`), "utf8");
    const tools = source.match(/^tools:\s*(.+)\s*$/m)?.[1].split(",").map((tool) => tool.trim()).filter(Boolean) ?? [];
    return tools.length > 0 && tools.every((tool) => SPECIALIST_ALLOWED_TOOLS.has(tool)) ? { prompt: source.replace(/^---\n[\s\S]*?\n---\s*/, ""), tools } : null;
  } catch { return null; }
}
export function specialistProtectedPaths(): string {
  const inherited = process.env.PI_KIT_PROTECTED_PATHS?.split(";").map((entry) => entry.trim()).filter(Boolean) ?? [...DEFAULT_PROTECTED_PATHS];
  if (!inherited.some((entry) => entry.replace(/\\/g, "/").replace(/\/+$/, "") === ".pi/engagement")) inherited.push(".pi/engagement/");
  return inherited.join(";");
}
function finalAssistantOutput(messages: Array<{ role?: unknown; content?: unknown }>): string { for (let i = messages.length - 1; i >= 0; i--) { const message = messages[i] as { role?: string; content?: Array<{ type?: string; text?: string }> }; const found = message.role === "assistant" ? message.content?.find((part) => part.type === "text" && typeof part.text === "string")?.text : undefined; if (found) return found; } return ""; }
// A compiled `pi` host passes its own executable as process.execPath; prepending the cli.js
// script then makes pi parse that path as the first prompt. Only a JS runtime gets the script.
const SPECIALIST_JS_RUNTIMES = new Set(["node", "nodejs", "bun", "deno"]);
function specialistArgv(cli: string, args: string[], execPath: string = process.execPath): string[] {
  const runtime = execPath.replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.(?:exe|cmd|bat)$/, "") ?? "";
  return SPECIALIST_JS_RUNTIMES.has(runtime) ? [cli, ...args] : [...args];
}

export interface SpecialistBounds {
  streamCapBytes: number;
  idleTimeoutMs: number;
  maxRuntimeMs: number;
}

// Bounds mirror PI_KIT_SUBAGENT_* but are separate: a conductor specialist is a different
// process class with its own budget. A specialist with no bound could stream or hang forever
// and pin the parent tool call.
export function specialistBounds(env: Record<string, string | undefined> = process.env): SpecialistBounds {
  const int = (raw: string | undefined, fallback: number, min: number): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= min ? Math.floor(n) : fallback;
  };
  return {
    streamCapBytes: int(env.PI_KIT_SPECIALIST_STREAM_CAP_BYTES, 256 * 1024 * 1024, 64 * 1024),
    idleTimeoutMs: int(env.PI_KIT_SPECIALIST_IDLE_TIMEOUT_MS, 15 * 60 * 1000, 0),
    maxRuntimeMs: int(env.PI_KIT_SPECIALIST_MAX_RUNTIME_MS, 0, 0),
  };
}

export interface SpecialistChildStream {
  code: number;
  stderr: string;
  messages: Array<{ role?: unknown; content?: unknown }>;
  killed?: string;
}

// Stream one specialist child with the shared budgets. Exported so the kill behaviour can be
// exercised offline with a fake child (tests/conductor-specialist-bounds-smoke.mjs).
export function streamSpecialistChild(
  proc: any,
  bounds: SpecialistBounds,
  signal: AbortSignal | undefined,
  onUpdate?: (text: string) => void,
): Promise<SpecialistChildStream> {
  return new Promise((resolve) => {
    let buffer = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const messages: Array<{ role?: unknown; content?: unknown }> = [];
    let exited = false;
    let killed: string | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let wallTimer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => stop("signal");
    const cleanup = () => {
      exited = true;
      if (escalation) clearTimeout(escalation);
      if (idleTimer) clearTimeout(idleTimer);
      if (wallTimer) clearTimeout(wallTimer);
      signal?.removeEventListener("abort", onAbort);
    };
    const stop = (reason: string) => {
      if (exited || killed) return;
      killed = reason;
      try { proc.kill("SIGTERM"); } catch { /* already gone */ }
      escalation = setTimeout(() => { if (!exited) { try { proc.kill("SIGKILL"); } catch { /* already gone */ } } }, 5000);
      escalation.unref();
    };
    const armIdle = () => {
      if (exited || bounds.idleTimeoutMs <= 0) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => stop("idle-timeout"), bounds.idleTimeoutMs);
      idleTimer.unref();
    };
    const line = (raw: string) => {
      try {
        const event = JSON.parse(raw) as { type?: string; message?: { role?: unknown; content?: unknown } };
        if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) { messages.push(event.message); onUpdate?.("received child progress"); }
      } catch { /* only JSON stream messages are trusted */ }
    };
    proc.stdout?.on("data", (data: Buffer) => {
      if (exited) return;
      armIdle();
      stdoutBytes += data.length;
      if (stdoutBytes > bounds.streamCapBytes) { stop("stream-cap"); return; }
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.forEach(line);
    });
    proc.stderr?.on("data", (data: Buffer) => {
      if (exited) return;
      armIdle();
      stderrBytes += data.length;
      if (stderrBytes > bounds.streamCapBytes) { stop("stream-cap"); return; }
      stderr += data.toString();
    });
    proc.once("close", (code: number | null) => {
      cleanup();
      if (buffer.trim()) line(buffer);
      resolve({ code: killed ? 1 : (code ?? 1), stderr, messages, killed });
    });
    proc.once("error", (error: unknown) => {
      cleanup();
      resolve({ code: 1, stderr: stderr || String(error), messages, killed });
    });
    if (signal) { if (signal.aborted) stop("signal"); else signal.addEventListener("abort", onAbort, { once: true }); }
    armIdle();
    if (bounds.maxRuntimeMs > 0) { wallTimer = setTimeout(() => stop("wall-clock"), bounds.maxRuntimeMs); wallTimer.unref(); }
  });
}

export const runSpecialistProcess: SpecialistRunner = async (cwd, agent, task, childDepth, signal, onUpdate) => {
  if (signal?.aborted) return { ok: false, reason: "specialist cancelled before launch" };
  const definition = agentDefinition(cwd, agent); if (!definition) return { ok: false, reason: `specialist role is missing a materialized tool restriction: ${agent}` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conductor-specialist-")); const promptFile = path.join(dir, "agent.md");
  try {
    fs.writeFileSync(promptFile, definition.prompt, { encoding: "utf8", mode: 0o600 });
    const bounds = specialistBounds();
    const cli = fileURLToPath(new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
    const args = ["--mode", "json", "-p", "--no-session", "--tools", definition.tools.join(","), "--append-system-prompt", promptFile, `Task: ${task}`];
    const proc = spawn(process.execPath, specialistArgv(cli, args), { cwd, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PI_KIT_INTERNAL_CHILD: "1", PI_KIT_CONDUCTOR_DEPTH: String(childDepth), PI_KIT_PROTECTED_PATHS: specialistProtectedPaths() } });
    const result = await streamSpecialistChild(proc, bounds, signal, onUpdate ? (text) => onUpdate(`[${agent}] ${text}`) : undefined);
    if (signal?.aborted) return { ok: false, reason: "specialist cancelled" };
    if (result.killed) return { ok: false, reason: `specialist child stopped by ${result.killed}` };
    if (result.code !== 0) return { ok: false, reason: result.stderr.trim() || `specialist child exited ${result.code}` };
    const output = finalAssistantOutput(result.messages);
    return output ? { ok: true, output } : { ok: false, reason: "specialist child returned no assistant output" };
  } catch (error) { return { ok: false, reason: `specialist child failed: ${String((error as Error)?.message ?? error)}` }; }
  finally { try { fs.unlinkSync(promptFile); } catch { /* ignore */ } try { fs.rmdirSync(dir); } catch { /* ignore */ } }
};

export async function dispatchSpecialist(cwd: string, agent: string, task: string, runner: SpecialistRunner = runSpecialistProcess, signal?: AbortSignal, onUpdate?: (text: string) => void): Promise<SpecialistRunResult> {
  if (signal?.aborted) return { ok: false, reason: "specialist cancelled before reservation" };
  const depth = currentDepth();
  if (!AGENT_NAME.test(agent) || !task.trim()) {
    const reason = "specialist agent name and non-empty task are required";
    auditTransition(cwd, new Date().toISOString(), "conductor:dispatch_specialist", `${agent}; ${reason}`, "error");
    return { ok: false, reason };
  }
  // Validate materialized role policy before consuming an irreversible budget slot.
  if (!agentDefinition(cwd, agent)) {
    const reason = `specialist role is missing a materialized tool restriction: ${agent}`;
    auditTransition(cwd, new Date().toISOString(), "conductor:dispatch_specialist", `${agent}; ${reason}`, "error");
    return { ok: false, reason };
  }
  const reserved = withEngagementLock(cwd, () => {
    const engagement = readEngagement(cwd);
    if (!engagement) return { ok: false as const, reason: "no valid engagement record; start an engagement first" };
    if (depth < 0) return { ok: false as const, reason: "invalid conductor depth marker; refusing specialist dispatch" };
    if (depth >= engagement.recursion.maxDepth) return { ok: false as const, reason: `depth cap reached (${depth}/${engagement.recursion.maxDepth})` };
    if (engagement.recursion.dispatchesUsed >= engagement.recursion.maxDispatches) return { ok: false as const, reason: `dispatch budget exhausted (${engagement.recursion.dispatchesUsed}/${engagement.recursion.maxDispatches})` };
    engagement.recursion.dispatchesUsed++; engagement.updatedAt = new Date().toISOString(); saveEngagement(cwd, engagement);
    // Attempt reservation audits before releasing the engagement writer lock.
    auditTransition(cwd, engagement.updatedAt, "conductor:dispatch_specialist", `${agent}@${depth + 1}; cap allowed`, "ok");
    auditTransition(cwd, engagement.updatedAt, "conductor:dispatch_budget_consumed", recursionStatus(engagement.recursion, depth), "ok");
    return { ok: true as const, childDepth: depth + 1, budget: engagement.recursion };
  });
  if (!reserved.ok) { auditTransition(cwd, new Date().toISOString(), "conductor:dispatch_specialist", `${agent}; ${reserved.reason}`, "error"); return reserved; }
  const result = await runner(cwd, agent, task, reserved.childDepth, signal, onUpdate); auditTransition(cwd, new Date().toISOString(), "conductor:dispatch_specialist", agent, result.ok ? "ok" : "error"); return result;
}

function registerSpecialistTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "dispatch_specialist", label: "Conductor: bounded specialist dispatch",
    description: "Dispatch a materialized specialist in an isolated child process after durably enforcing Conductor recursion and per-run dispatch caps.",
    parameters: Type.Object({ agent: Type.String({ description: "Materialized synthesized agent name" }), task: Type.String({ description: "Scoped specialist task" }) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const result = await dispatchSpecialist(ctx.cwd, params.agent, params.task, runSpecialistProcess, signal, (message) => onUpdate?.({ content: [{ type: "text" as const, text: message }], details: undefined }));
      setRecursionStatus(ctx.ui, readEngagement(ctx.cwd));
      return { content: [{ type: "text" as const, text: result.ok ? `Specialist:${params.agent} completed.\n${result.output}` : `Specialist dispatch refused: ${result.reason}` }], details: undefined };
    },
  });
}

function writeContribution(cwd: string, engagement: Engagement | null): void {
  try {
    const file = contributionFile(cwd);
    if (!engagement) {
      fs.rmSync(file, { force: true });
      return;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      id: "conductor",
      priority: 80,
      budgetTokens: 300,
      content: `## Engagement\nPhase: ${engagement.phase} (started ${engagement.startedAt})`,
    }), "utf8");
  } catch {
    /* best effort */
  }
}

export default function (pi: ExtensionAPI) {
  registerValidatorTools(pi, { prepare: materializeValidatorAgent });
  registerSpecialistTool(pi);
  pi.on("before_agent_start", async (_event, ctx) => {
    currentSessionId = resolveSessionId(ctx.sessionManager);
    const cwd = ctx.cwd ?? process.cwd();
    try { materializeValidatorAgent(cwd); } catch { /* dispatch refuses if it cannot resolve the role */ }
    const engagement = readEngagement(cwd);
    writeContribution(cwd, engagement);
    setRecursionStatus(ctx.ui, engagement);
    return undefined;
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    if (event.toolName !== "subagent") return undefined;
    if (!readEngagement(ctx.cwd ?? process.cwd())) return undefined;
    return { block: true, reason: "conductor: an engagement is active; use dispatch_specialist for bounded delegation" };
  });

  pi.registerCommand("engagement", {
    description: "Manage engagement lifecycle: /engagement start | status | phase <name>",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd ?? process.cwd();
      const input = (args ?? "").trim();
      const [subcommand, ...rest] = input.split(/\s+/);

      if (subcommand === "start") {
        const started = withEngagementLock(cwd, () => {
          const existing = readEngagement(cwd);
          if (existing) return { ok: false as const, existing };
          const now = new Date().toISOString();
          const engagement: Engagement = { version: 2, phase: "intake", startedAt: now, updatedAt: now, history: [{ phase: "intake", at: now }], recursion: { ...DEFAULT_RECURSION_BUDGET } };
          saveEngagement(cwd, engagement);
          auditTransition(cwd, now, "conductor:engagement_start", "intake", "ok");
          return { ok: true as const, engagement };
        });
        if (!started.ok && "existing" in started) {
          const existing = started.existing;
          ctx.ui.notify(`engagement: already started — current phase: ${existing.phase}`, "info");
          return;
        }
        if (!started.ok) { ctx.ui.notify(`engagement: ${started.reason}`, "error"); return; }
        writeContribution(cwd, started.engagement);
        setRecursionStatus(ctx.ui, started.engagement);
        ctx.ui.notify("engagement: started at phase intake", "info");
        return;
      }

      if (subcommand === "status" || subcommand === "") {
        const engagement = readEngagement(cwd);
        if (!engagement) {
          ctx.ui.notify("engagement: none started — use /engagement start", "info");
          return;
        }
        const gate = verifierBoardBlocked(cwd);
        const pending = pendingValidatorFindings(cwd);
        const gateText = gate.blocked || pending.length > 0 ? `gate: BLOCKED — ${[...gate.failing, ...pending.map((id) => `validator:${id} (pending)`)].join(", ")}` : "gate: passing";
        setRecursionStatus(ctx.ui, engagement);
        ctx.ui.notify(`engagement: ${engagement.phase}\nstarted: ${engagement.startedAt}\nhistory entries: ${engagement.history.length}\nrecursion: ${recursionStatus(engagement.recursion)}\n${gateText}`, gate.blocked || pending.length > 0 ? "warning" : "info");
        return;
      }

      if (subcommand === "phase") {
        const next = rest.join(" ");
        const advanced = withEngagementLock(cwd, () => {
          const engagement = readEngagement(cwd);
          if (!engagement) return { ok: false as const, message: "engagement: none started — run /engagement start first" };
          const now = new Date().toISOString();
          if (!isPhase(next)) { auditTransition(cwd, now, "conductor:phase_advance", `${engagement.phase}->${next}`, "error"); return { ok: false as const, message: `engagement: unknown phase '${next}'. Known phases: ${PHASES.join(", ")}` }; }
          if (PHASES.indexOf(next) <= PHASES.indexOf(engagement.phase)) { auditTransition(cwd, now, "conductor:phase_advance", `${engagement.phase}->${next}`, "error"); return { ok: false as const, message: `engagement: phase can only move forward from ${engagement.phase}; '${next}' was rejected` }; }
          const gate = verifierBoardBlocked(cwd); const pending = pendingValidatorFindings(cwd);
          if (gate.blocked || pending.length > 0) { auditTransition(cwd, now, "conductor:phase_advance", `${engagement.phase}->${next}`, "error"); return { ok: false as const, message: `engagement: phase advance blocked by verification — ${[...gate.failing, ...pending.map((id) => `validator:${id} (pending)`)].join(", ")}` }; }
          const previous = engagement.phase;
          engagement.phase = next; engagement.updatedAt = now; engagement.history.push({ phase: next, at: now }); saveEngagement(cwd, engagement);
          auditTransition(cwd, now, "conductor:phase_advance", `${previous}->${next}`, "ok");
          return { ok: true as const, previous, engagement };
        });
        if (!advanced.ok) { ctx.ui.notify("message" in advanced ? advanced.message : `engagement: ${advanced.reason}`, "error"); return; }
        writeContribution(cwd, advanced.engagement);
        setRecursionStatus(ctx.ui, advanced.engagement);
        ctx.ui.notify(`engagement: advanced from ${advanced.previous} to ${next}`, "info");
        return;
      }

      ctx.ui.notify("engagement: use /engagement start | status | phase <name>", "error");
    },
  });
}
