// The run lifecycle: explicit states, an explicit legal-transition table and the shape of
// state.json (the one authoritative record of a run). Pure functions over plain objects; the
// store (lib/store.mjs) persists them and only the supervisor that holds the run lock writes.
//
// Outcomes are never conflated:
//   succeeded         every required acceptance check passed in a trusted evaluation, and the
//                     required independent review approved
//   failed            the run cannot or must not continue; `outcome.reason` says why
//                     (boundary_violation, recovery_exhausted, step_attempts_exhausted, ...)
//   cancelled         an operator ended it
//   budget_exhausted  money, steps or active minutes ran out (reason total_usd | max_steps | max_minutes)
//   blocked           NOT terminal: a genuinely external blocker or an approval/answer is needed
import { clone } from "./fsutil.mjs";

export const STATE_SCHEMA_VERSION = 1;

export const STATES = ["setup", "ready", "running", "paused", "blocked", "recovering", "succeeded", "failed", "cancelled", "budget_exhausted"];
export const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/** The legal transitions. budget_exhausted is not terminal only for `reconfigure`. */
export const TRANSITIONS = {
  setup: ["ready", "failed", "cancelled"],
  ready: ["running", "paused", "failed", "cancelled"],
  running: ["paused", "blocked", "recovering", "succeeded", "failed", "cancelled", "budget_exhausted"],
  paused: ["running", "failed", "cancelled"],
  blocked: ["running", "paused", "failed", "cancelled"],
  recovering: ["running", "blocked", "paused", "failed", "cancelled", "budget_exhausted"],
  budget_exhausted: ["paused"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export const BUDGET_REASONS = ["total_usd", "max_steps", "max_minutes"];
export const FAILURE_REASONS = ["boundary_violation", "recovery_exhausted", "step_attempts_exhausted", "review_rejected", "setup_failed", "worker_unavailable", "lock_lost", "internal_error", "operator_failed", "promotion_failed"];

export class IllegalTransition extends Error {
  constructor(from, to, why) {
    super(`illegal transition ${from} -> ${to}${why ? `: ${why}` : ""}`);
    this.from = from;
    this.to = to;
    this.code = "illegal_transition";
  }
}

export const isTerminal = (status) => TERMINAL.has(status);
export const canTransition = (from, to) => (TRANSITIONS[from] ?? []).includes(to);

/** Why a run may not be marked succeeded yet, or null. */
export function evidenceProblem(state) {
  const latest = state.acceptance?.latest;
  if (!latest) return "no acceptance evaluation has been recorded";
  if (!latest.allRequiredPass) return "the latest trusted evaluation has failing required checks";
  const review = state.acceptance.review;
  if (review?.required && review.status !== "approved") return `independent review is required and its status is ${review.status}`;
  return null;
}

/**
 * Move a state to `to`. Returns a new state; throws IllegalTransition on anything not in the
 * table or failing a guard. `info`: { reason, by, at, detail, blocker }.
 */
export function transition(state, to, info = {}) {
  const from = state.status;
  if (!STATES.includes(to)) throw new IllegalTransition(from, to, "unknown state");
  if (!canTransition(from, to)) throw new IllegalTransition(from, to, isTerminal(from) ? `${from} is terminal` : undefined);
  const reason = info.reason ?? "";
  if (["failed", "cancelled", "budget_exhausted", "succeeded", "blocked"].includes(to) && !reason) throw new IllegalTransition(from, to, "a reason is required");
  if (to === "budget_exhausted" && !BUDGET_REASONS.includes(reason)) throw new IllegalTransition(from, to, `reason must be one of ${BUDGET_REASONS.join(", ")}`);
  if (to === "failed" && !FAILURE_REASONS.includes(reason)) throw new IllegalTransition(from, to, `reason must be one of ${FAILURE_REASONS.join(", ")}`);
  if (to === "succeeded") { const problem = evidenceProblem(state); if (problem) throw new IllegalTransition(from, to, problem); }
  if (from === "budget_exhausted" && info.by !== "reconfigure") throw new IllegalTransition(from, to, "an exhausted budget is only lifted by an explicit `reconfigure`");
  if (to === "blocked" && !info.blocker) throw new IllegalTransition(from, to, "a blocker record is required");
  const at = info.at ?? new Date().toISOString();
  const next = clone(state);
  next.status = to;
  next.updatedAt = at;
  next.blocker = to === "blocked" ? { ...info.blocker, since: at } : null;
  if (["succeeded", "failed", "cancelled", "budget_exhausted"].includes(to)) next.outcome = { status: to, reason, ...(info.detail ? { detail: String(info.detail).slice(0, 2000) } : {}), at };
  else if (from === "budget_exhausted") next.outcome = null; // lifted by reconfigure
  next.history = [...(state.history ?? []), { at, from, to, reason: reason || undefined, by: info.by ?? "supervisor", ...(info.detail ? { detail: String(info.detail).slice(0, 500) } : {}) }].slice(-500);
  return next;
}

/**
 * What `resume` means in each state.
 * @returns {{ ok: boolean, action?: string, to?: string, message: string }}
 */
export function resumeAction(state, { answer, approve = false, deny = false } = {}) {
  switch (state.status) {
    case "setup": return { ok: true, action: "redo_setup", message: "setup was interrupted; it is repeated (idempotently) and the run continues" };
    case "ready": return { ok: true, action: "start", to: "running", message: "start running" };
    case "running":
    case "recovering": return { ok: true, action: "takeover", to: "running", message: "the previous supervisor is gone: take over its lock, remove orphaned containers and continue from the recorded state (recovery counters continue, nothing already published is repeated)" };
    case "paused": return { ok: true, action: "unpause", to: "running", message: "continue from the recorded state" };
    case "blocked": {
      const kind = state.blocker?.kind;
      if (kind === "approval") {
        if (approve || deny) return { ok: true, action: "answer", to: "running", message: approve ? "approval given" : "approval denied" };
        return { ok: false, message: "the run is waiting for an approval: resume with --approve or --deny (and optionally --answer <note>)" };
      }
      if (typeof answer === "string" && answer.trim()) return { ok: true, action: "answer", to: "running", message: "answer recorded; the worker continues with it" };
      return { ok: false, message: `the run is blocked (${kind ?? "blocker"}): ${state.blocker?.question ?? state.reason ?? "see status"}. Resume with --answer "<your answer>"` };
    }
    case "budget_exhausted": return { ok: false, message: `the run stopped: ${state.outcome?.reason}. Raise the limit with \`reconfigure\`, which pauses the run, then resume it` };
    case "succeeded": return { ok: false, message: "the run already succeeded; use `export` to take the results out" };
    case "failed": return { ok: false, message: `the run failed (${state.outcome?.reason}); failed is terminal. Export what exists, and start a new run from it if you want to go on` };
    case "cancelled": return { ok: false, message: "the run was cancelled; cancelled is terminal" };
    default: return { ok: false, message: `unknown state ${state.status}` };
  }
}

/** Progress of the contract's backlog from trusted evaluation results: the one authoritative task board. */
export function boardFromContract(contract) {
  return contract.objective.backlog.map((item) => ({ id: item.id, title: item.title, checks: item.acceptance ?? [], status: "todo", evidence: [], updatedAt: null }));
}

/** A fresh state for a run that is about to be set up. */
export function newState({ contract, contractDigest, boundaryDigest, authorisation, effort, now = new Date().toISOString() }) {
  return {
    schemaVersion: STATE_SCHEMA_VERSION,
    run: contract.run,
    template: contract.template,
    contractDigest,
    boundaryDigest,
    authorisation,
    status: "setup",
    phase: null,
    blocker: null,
    outcome: null,
    step: 0,
    tasks: boardFromContract(contract),
    acceptance: { latest: null, history: [], review: { required: contract.acceptance.review, status: contract.acceptance.review ? "pending" : "skipped" } },
    worker: null,
    artefacts: [],
    usage: { usd: 0, minutes: 0, steps: 0 },
    recovery: { stalls: 0, softNudgesUsed: 0, hardRestartsUsed: 0, totals: { softNudges: 0, hardRestarts: 0 }, attemptsByTarget: {}, violations: 0, lastFingerprint: null, passingBefore: [] },
    effort: { ...effort },
    limits: { budget: { ...contract.budget }, recovery: { ...contract.recovery } },
    promotion: { policy: contract.promotion.policy, status: contract.promotion.policy === "none" ? "none" : "pending", done: {} },
    pendingQuestions: [],
    reconfigurations: [],
    history: [{ at: now, from: null, to: "setup", reason: "created", by: "supervisor" }],
    createdAt: now,
    updatedAt: now,
  };
}

/** Apply trusted check results to the task board. An item is done only when every check it names passed. */
export function applyResultsToBoard(tasks, results, { step, at = new Date().toISOString(), complete = false } = {}) {
  const byId = new Map(results.map((r) => [r.id, r]));
  return tasks.map((t) => {
    let status = t.status;
    let evidence = t.evidence;
    if (t.checks.length) {
      const rs = t.checks.map((id) => byId.get(id));
      if (rs.every((r) => r?.pass)) status = "done";
      else if (rs.some((r) => r && !r.pass)) status = t.status === "done" ? "todo" : "in_progress";
      evidence = rs.filter(Boolean).map((r) => `step ${step}: ${r.id} ${r.pass ? "pass" : "fail"}`);
    } else if (complete) {
      status = "done"; // items with no check of their own are covered by the run's overall acceptance
      evidence = [`step ${step}: covered by the run's acceptance`];
    }
    return status === t.status && evidence === t.evidence ? t : { ...t, status, evidence, updatedAt: at };
  });
}
