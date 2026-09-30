import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

// recovery-orchestrator: the DEEP root-cause layer that progress-guard escalates into
// (docs/recovery-orchestration-mode.md, §2). When assistance (nudging) hasn't broken a loop,
// progress-guard writes .pi/recovery/escalation.json; on the next turn this extension enters
// recovery for that signature exactly once and:
//   1. writes a recovery report scaffold (.pi/recovery/<n>-<sig>.md),
//   2. drops a high-priority ctx-contribution steering the §2 flow (fresh scouts + forked
//      top-10 + synthesis + primary/backup plan + delegated fix) — context-sieve is the sole
//      injection authority, so we NEVER emit a systemPrompt,
//   3. bounds attempts per signature and, past the cap, escalates to the operator instead of
//      spawning further.
// It is NON-DESTRUCTIVE: it only writes report + contribution files; it never edits code or
// reverts changes. Detection of "fix failed / worse" is delegated to the verifier board.

const CONTRIB_ID = "recovery-orchestrator";
const MAX_ATTEMPTS = intEnv("PI_KIT_RECOVERY_MAX_ATTEMPTS", 2);
const SCOUTS = intEnv("PI_KIT_RECOVERY_SCOUTS", 3);

function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

function escalationPath(cwd: string): string {
  return path.join(cwd, ".pi", "recovery", "escalation.json");
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

function contribPath(cwd: string): string {
  return path.join(contribDir(cwd), `${CONTRIB_ID}.json`);
}
function verdictsPath(cwd: string): string {
  return path.join(cwd, ".pi", "verdicts.json");
}

function safeSig(signature: string): string {
  return signature.replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
}

// H-06 fix, partial: recovery previously handed back a 100%-blank template - every
// section ("Scout findings", "top-10 causes", ...) was an empty placeholder for the
// model to fill from scratch, with zero grounding in what actually happened. Extension-
// to-extension programmatic invocation of `subagent` (real scout fan-out) is not
// available through Pi's public extension API (no cross-extension tool-call mechanism -
// only the model can call a registered tool), so this does not fabricate scout output;
// it grounds the report in the one thing genuinely available offline: the real recorded
// action history from trace-ledger's .pi/trace.jsonl (same JSONL contract skill-forge's
// mineTrace reads - self-contained duplicate parsing per this repo's extension rule).
interface TraceEntry {
  kind?: "call" | "result";
  tool?: string;
  target?: string;
  status?: "ok" | "error";
}

function readRecentTrace(cwd: string, n: number): TraceEntry[] {
  try {
    const lines = fs.readFileSync(path.join(cwd, ".pi", "trace.jsonl"), "utf8").split("\n").filter(Boolean);
    return lines
      .slice(-n)
      .map((l) => {
        try {
          return JSON.parse(l) as TraceEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is TraceEntry => !!e);
  } catch {
    return [];
  }
}

function traceGroundingSection(cwd: string): string {
  const entries = readRecentTrace(cwd, 30);
  if (entries.length === 0) return "(no trace-ledger data available for this session)";
  const calls = entries.filter((e) => e.kind === "call" && e.tool);
  const errors = entries.filter((e) => e.kind === "result" && e.status === "error").length;
  const toolCounts = new Map<string, number>();
  for (const e of calls) toolCounts.set(e.tool!, (toolCounts.get(e.tool!) ?? 0) + 1);
  const topTools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  const recentTargets = calls
    .filter((e) => e.target)
    .slice(-8)
    .map((e) => `${e.tool}:${e.target}`);
  return [
    `- ${calls.length} tool calls in the trace window, ${errors} result(s) recorded as error.`,
    `- Most-called tools: ${topTools.map(([t, c]) => `${t} (${c}×)`).join(", ") || "(none)"}.`,
    `- Most recent targets: ${recentTargets.join(" → ") || "(none recorded)"}.`,
  ].join("\n");
}

export interface Escalation {
  signature: string;
  reason: string;
  count: number;
  at: string;
}

export function readEscalation(cwd: string): Escalation | null {
  try {
    const raw = JSON.parse(fs.readFileSync(escalationPath(cwd), "utf8"));
    if (raw && typeof raw.signature === "string") return raw as Escalation;
  } catch {
    /* none */
  }
  return null;
}

function boardPassing(cwd: string): boolean {
  try {
    const board = JSON.parse(fs.readFileSync(verdictsPath(cwd), "utf8"));
    const v = board?.verdicts;
    if (!v || typeof v !== "object") return true;
    const keys = Object.keys(v);
    return keys.length === 0 || keys.every((k) => v[k]?.pass !== false);
  } catch {
    return true;
  }
}

function recoveryContent(esc: Escalation, attempt: number, reportRel: string): string {
  return [
    `## recovery-orchestration: stuck on '${esc.signature}' (attempt ${attempt}/${MAX_ATTEMPTS})`,
    "",
    `Signal: ${esc.reason} (repeated ${esc.count}×). Assistance did not break the loop — run the`,
    "deep root-cause pass instead of grinding in this anchored context:",
    "",
    `1. **Fan out ${SCOUTS} fresh scouts** via \`subagent\` (agentScope isolating context) — each`,
    "   investigates independently and reports suspected causes. They must NOT see this context's",
    "   hypotheses or the attempt history (that would re-anchor them).",
    "2. **Fork the incumbent** (\`/fork\`) and ask it, with full history: \"What are we struggling",
    "   with? List the **top 10 most likely causes.**\"",
    "3. **Synthesise** the scout reports + the top-10 into one ranked cause list; pick the single",
    "   most likely primary cause.",
    "4. **Plan primary + backup**: a fix for the primary cause, and a backup plan if it fails/regresses.",
    "   Checkpoint first (`git-checkpoint`) so the backup or a clean abort is always available.",
    "5. **Delegate the repair** to an `implementer` sub-agent with JUST: the chosen hypothesis, the",
    "   target files, and the acceptance check — then re-run `/verify` so the verifier board clears.",
    "",
    `Fill in the recovery report at \`${reportRel}\` as you go. Skill: \`recovery-debugging\`,`,
    "`agent-orchestration`. Full method: docs/recovery-orchestration-mode.md.",
  ].join("\n");
}

function reportScaffold(esc: Escalation, attempt: number, cwd: string): string {
  return [
    `# Recovery report — ${esc.signature}`,
    "",
    `- Attempt: ${attempt}/${MAX_ATTEMPTS}`,
    `- Failing signature: \`${esc.signature}\``,
    `- Signal: ${esc.reason} (repeated ${esc.count}×)`,
    `- Entered: ${esc.at}`,
    "",
    "## Recorded action history (real, from trace-ledger — not a fill-in placeholder)",
    traceGroundingSection(cwd),
    "",
    "## Scout findings (fresh, independent — fill in once scouts have actually run)",
    Array.from({ length: SCOUTS }, (_v, i) => `- scout ${i + 1}: `).join("\n"),
    "",
    "## Incumbent top-10 likely causes (from the fork)",
    Array.from({ length: 10 }, (_v, i) => `${i + 1}. `).join("\n"),
    "",
    "## Ranked synthesis + chosen primary cause",
    "- primary: ",
    "",
    "## Primary plan",
    "- ",
    "",
    "## Backup plan (if primary fails/regresses)",
    "- ",
    "",
    "## Outcome",
    "- ",
    "",
  ].join("\n");
}

// Pure planner used by the eval harness and the runtime hook: given cwd + current state,
// decide whether to enter recovery and produce the artifacts to write.
export function planRecovery(
  cwd: string,
  attemptsBySignature: Map<string, number>,
): { action: "none" | "enter" | "cap"; escalation?: Escalation; attempt?: number; reportRel?: string } {
  const esc = readEscalation(cwd);
  if (!esc) return { action: "none" };
  if (boardPassing(cwd) === false) {
    // board failing corroborates the stuck state; proceed
  }
  const prior = attemptsBySignature.get(esc.signature) ?? 0;
  const attempt = prior + 1;
  if (attempt > MAX_ATTEMPTS) return { action: "cap", escalation: esc, attempt };
  const reportRel = path.join(".pi", "recovery", `${attempt}-${safeSig(esc.signature)}.md`);
  return { action: "enter", escalation: esc, attempt, reportRel };
}

function writeContribution(cwd: string, content: string): void {
  try {
    const p = contribPath(cwd);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ id: CONTRIB_ID, priority: 90, budgetTokens: 480, content }), "utf8");
  } catch {
    /* best-effort */
  }
}

function clearEscalation(cwd: string): void {
  try { fs.rmSync(escalationPath(cwd), { force: true }); } catch { /* ignore */ }
}
function clearContribution(cwd: string): void {
  try { fs.rmSync(contribPath(cwd), { force: true }); } catch { /* ignore */ }
}

export default function (pi: ExtensionAPI) {
  let cwd = process.cwd();
  const attemptsBySignature = new Map<string, number>();

  function block(ctx: ExtensionContext, signature: string): void {
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? String(process.pid);
    const disposition = { state: "blocked", sessionId, cwd, signature, reason: "recovery attempt budget exhausted", at: new Date().toISOString() };
    // Same-session continuation owners can disarm synchronously before agent_end.
    // This is containment for the local loop, not a tree-wide scheduler/queue fence.
    pi.events?.emit("pi-kit:recovery-blocked", disposition);
    try {
      const file = path.join(cwd, ".pi", "recovery", `blocked-${safeSig(sessionId)}.json`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(disposition), "utf8");
    } catch (error) {
      ctx.ui?.notify?.(`recovery: could not persist blocked disposition: ${String(error)}`, "error");
    }
    ctx.ui?.setStatus?.("recovery-orchestrator", "blocked: recovery budget exhausted");
  }

  pi.on("session_start", async (_event, ctx) => {
    cwd = (ctx as ExtensionContext).cwd ?? process.cwd();
    currentSessionId = resolveSessionId((ctx as ExtensionContext).sessionManager);
    clearContribution(cwd);
    clearEscalation(cwd); // fresh session starts clean
  });

  // Enter recovery at most once per escalated signature; the operator/model clears it by
  // making progress (a write resets progress-guard, which stops re-escalating).
  pi.on("turn_end", async (_event, ctx) => {
    const c = ctx as ExtensionContext;
    cwd = c.cwd ?? cwd;
    const plan = planRecovery(cwd, attemptsBySignature);
    if (plan.action === "none") return;

    if (plan.action === "cap") {
      block(c, plan.escalation!.signature);
      attemptsBySignature.set(plan.escalation!.signature, plan.attempt!);
      clearEscalation(cwd);
      const msg = `recovery-orchestrator: '${plan.escalation!.signature}' still stuck after ${MAX_ATTEMPTS} recovery attempts — escalate to the operator (or dual-review).`;
      writeContribution(cwd, `## recovery: give up gracefully\n\n${msg}`);
      if (c.hasUI) c.ui.notify(msg, "error");
      return;
    }

    const { escalation: esc, attempt, reportRel } = plan;
    attemptsBySignature.set(esc!.signature, attempt!);
    try {
      const reportAbs = path.join(cwd, reportRel!);
      fs.mkdirSync(path.dirname(reportAbs), { recursive: true });
      if (!fs.existsSync(reportAbs)) fs.writeFileSync(reportAbs, reportScaffold(esc!, attempt!, cwd), "utf8");
    } catch {
      /* report is best-effort; the steer is the important part */
    }
    writeContribution(cwd, recoveryContent(esc!, attempt!, reportRel!));
    // Open the small recovery delegation budget (read-only scouts) for this request. Only this trusted
    // code path can: a minimal-effort session may not delegate at will, but it can recover. The budget
    // closes with the next user turn (docs/effort.md).
    try {
      ((globalThis as Record<symbol, unknown>)[Symbol.for("pi-kit.effort")] as { setRecoveryActive?(active: boolean, reason?: string): void } | undefined)?.setRecoveryActive?.(true, `recovery for ${esc!.signature}`);
    } catch { /* effort is optional here */ }
    clearEscalation(cwd); // consumed — don't re-enter for the same escalation marker
    if (c.hasUI) c.ui.notify(`recovery-orchestrator: entered recovery for '${esc!.signature}' (attempt ${attempt}/${MAX_ATTEMPTS}). See ${reportRel}.`, "warning");
  });

  pi.registerCommand("recover", {
    description: "Manually trigger recovery-orchestration for the current stuck state (/recover [signature]).",
    handler: async (args, ctx) => {
      const c = ctx as ExtensionContext;
      const dir = c.cwd ?? cwd;
      const signature = (args ?? "").trim() || "manual";
      // Seed an escalation the same way progress-guard would, then enter immediately.
      try {
        fs.mkdirSync(path.join(dir, ".pi", "recovery"), { recursive: true });
        fs.writeFileSync(
          escalationPath(dir),
          JSON.stringify({ signature, reason: "operator invoked /recover", count: 1, at: new Date().toISOString() }),
          "utf8",
        );
      } catch {
        /* ignore */
      }
      const plan = planRecovery(dir, attemptsBySignature);
      if (plan.action === "enter") {
        attemptsBySignature.set(plan.escalation!.signature, plan.attempt!);
        try {
          const reportAbs = path.join(dir, plan.reportRel!);
          fs.mkdirSync(path.dirname(reportAbs), { recursive: true });
          if (!fs.existsSync(reportAbs)) fs.writeFileSync(reportAbs, reportScaffold(plan.escalation!, plan.attempt!, dir), "utf8");
        } catch { /* ignore */ }
        writeContribution(dir, recoveryContent(plan.escalation!, plan.attempt!, plan.reportRel!));
        clearEscalation(dir);
        if (c.hasUI) c.ui.notify(`recovery-orchestrator: recovery queued for '${signature}'. See ${plan.reportRel}.`, "info");
      } else if (plan.action === "cap") {
        block(c, signature);
        clearEscalation(dir);
        writeContribution(dir, `## Recovery blocked\nRecovery budget exhausted for '${signature}'. Report the blocker; await an operator decision. Do not retry unchanged recovery.`);
        if (c.hasUI) c.ui.notify(`recovery-orchestrator: '${signature}' has hit the attempt cap — escalate to the operator.`, "warning");
      }
    },
  });
}
