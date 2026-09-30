// Bounded recovery for a run that is not making progress. Pure decisions over the persisted
// counters in state.recovery, so they survive a supervisor crash and a resume unchanged.
//
// The ladder, per stall episode: soft nudge(s) (a steering message in the same session), then
// hard restart(s) (a fresh pi session on the SAME workspace, briefed from verified state), then
// the run FAILS with reason recovery_exhausted. Nothing here resets spending, extends a budget
// or widens scope; the run's hard limits (budget, minutes, steps, cancellation, boundary
// violations) are checked by the engine and are never consulted through this module.
//
// Definitions (all from trusted, supervisor-observed facts, never from the worker's claims):
//   verified progress  a check passes that did not pass in the previous evaluation
//   activity           the accepted head moved (new commits with changes inside the write areas)
//   stall              neither of the above (or a rejected step / a dead worker)
// Episode counters (softNudgesUsed, hardRestartsUsed) reset only on verified progress. The
// totals never reset. Separately, attemptsByTarget counts worker turns spent on one backlog
// target (or on the run's acceptance) and is never reset: maxAttemptsPerStep bounds it.
import { clone } from "./fsutil.mjs";

export const MAX_CONSECUTIVE_VIOLATIONS = 2;

/** Newly passing checks since the previous evaluation. */
export function newlyPassing(previousPassing, results) {
  const before = new Set(previousPassing ?? []);
  return results.filter((r) => r.pass && !before.has(r.id)).map((r) => r.id);
}

/** The backlog target the worker is currently on: the first unfinished item with checks, else the run's acceptance. */
export function currentTarget(tasks) {
  const next = (tasks ?? []).find((t) => t.status !== "done" && t.checks.length > 0);
  return next ? `task:${next.id}` : "acceptance";
}

/**
 * @param {object} recovery state.recovery
 * @param {{ softNudges: number, hardRestarts: number, maxAttemptsPerStep: number }} limits state.limits.recovery
 * @param {{ verifiedProgress?: boolean, activity?: boolean, violation?: boolean, crashed?: boolean, target?: string, complete?: boolean }} ev
 * @returns {{ action: "none"|"nudge"|"restart"|"stop", reason: string, failure?: string, recovery: object }}
 */
export function decideRecovery(recovery, limits, ev) {
  const rec = clone(recovery);
  const totals = rec.totals ?? (rec.totals = { softNudges: 0, hardRestarts: 0 });
  if (ev.target && !ev.complete) {
    rec.attemptsByTarget[ev.target] = (rec.attemptsByTarget[ev.target] ?? 0) + 1;
    if (rec.attemptsByTarget[ev.target] >= limits.maxAttemptsPerStep) {
      return { action: "stop", failure: "step_attempts_exhausted", reason: `${rec.attemptsByTarget[ev.target]} worker turns spent on ${ev.target} without completing it (limit ${limits.maxAttemptsPerStep})`, recovery: rec };
    }
  }
  rec.violations = ev.violation ? (rec.violations ?? 0) + 1 : 0;
  if (rec.violations >= MAX_CONSECUTIVE_VIOLATIONS) {
    return { action: "stop", failure: "boundary_violation", reason: `${rec.violations} consecutive steps changed paths outside permissions.writeAreas`, recovery: rec };
  }
  if (ev.verifiedProgress) {
    rec.stalls = 0; rec.softNudgesUsed = 0; rec.hardRestartsUsed = 0;
    return { action: "none", reason: "verified progress", recovery: rec };
  }
  if (ev.activity && !ev.violation && !ev.crashed) {
    rec.stalls = 0;
    return { action: "none", reason: "the accepted head moved", recovery: rec };
  }
  rec.stalls = (rec.stalls ?? 0) + 1;
  if (!ev.crashed && rec.softNudgesUsed < limits.softNudges) {
    rec.softNudgesUsed++; totals.softNudges++;
    return { action: "nudge", reason: `stall ${rec.stalls}: soft nudge ${rec.softNudgesUsed} of ${limits.softNudges}`, recovery: rec };
  }
  if (rec.hardRestartsUsed < limits.hardRestarts) {
    rec.hardRestartsUsed++; totals.hardRestarts++;
    return { action: "restart", reason: `${ev.crashed ? "the worker session died" : `stall ${rec.stalls}`}: hard restart ${rec.hardRestartsUsed} of ${limits.hardRestarts}`, recovery: rec };
  }
  return { action: "stop", failure: "recovery_exhausted", reason: `no verified progress after ${rec.softNudgesUsed} nudge(s) and ${rec.hardRestartsUsed} hard restart(s)`, recovery: rec };
}
