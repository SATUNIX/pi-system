// When the supervisor calls the manager, and when it stops a cycle without asking. Pure: the
// supervisor passes the cycle's observed state and the clock.

/**
 * @param {object} s cycle state: startedAt, lastEventAt, lastCommitAt (ms), costUsd,
 *   extendedMinutes, managerCalls, exited ({code}|null), redGatesInARow, guardEscalations,
 *   softReviewed (bool), handled (Set of trigger keys already sent to the manager)
 * @returns {{ stop: string|null, triggers: string[] }}
 */
export function evaluate(s, now, cfg) {
  const l = cfg.limits;
  // Hard backstops: no manager, the cycle is closed as partial.
  if ((now - s.startedAt) / 60_000 >= l.hardMinutes) return { stop: "hard_limit", triggers: [] };
  // The manager may let a cycle run past its budget (CONTINUE); the hard budget is final.
  if ((s.costUsd ?? 0) >= (cfg.budget.perCycleHardUsd ?? 2 * cfg.budget.perCycleUsd)) return { stop: "cycle_budget_hard", triggers: [] };
  if ((s.managerCalls ?? 0) >= l.managerCallsPerCycle && pending(s, now, cfg).length) return { stop: "manager_calls_exhausted", triggers: [] };

  return { stop: null, triggers: pending(s, now, cfg) };
}

function pending(s, now, cfg) {
  const l = cfg.limits;
  const min = (ms) => ms / 60_000;
  const extra = s.extendedMinutes ?? 0;
  const handled = s.handled ?? new Set();
  const out = [];
  const add = (key) => { if (!handled.has(key)) out.push(key); };
  if (s.exited && s.exited.code !== 0) add(`crash:${s.exited.code}`);
  if (min(now - (s.lastEventAt ?? s.startedAt)) >= l.idleMinutes + extra) add(`idle:${Math.floor(extra)}`);
  if (min(now - (s.lastCommitAt ?? s.startedAt)) >= l.noCommitMinutes + extra) add(`no_commit:${Math.floor(extra)}`);
  if (!s.softReviewed && min(now - s.startedAt) >= l.softMinutes) add("soft_limit");
  if ((s.costUsd ?? 0) >= cfg.budget.perCycleUsd) add("cycle_budget");
  if ((s.redGatesInARow ?? 0) >= l.redGatesInARow) add(`red_gates:${s.redGatesInARow}`);
  if ((s.guardEscalations ?? 0) >= l.guardEscalations) add(`guard_escalations:${s.guardEscalations}`);
  return out;
}

/** Run-level stop: total budget, cycle count, or the operator's STOP file. */
export function runStop({ totalCostUsd, cyclesDone, stopFile, nothingFoundInARow = 0 }, cfg) {
  if (stopFile) return "stop_file";
  if (totalCostUsd >= cfg.budget.totalUsd) return "total_budget";
  if (cyclesDone >= cfg.cycles) return "cycles_done";
  // The agent reviewed the codebase and found nothing worth doing, several cycles running: the
  // rest of the budget would only buy churn.
  if (nothingFoundInARow >= cfg.limits.nothingFoundToStop) return "backlog_exhausted";
  return null;
}

/**
 * The outcome and mode a cycle report declares (prompts/cycle.md asks for `Outcome: ...` and
 * `Mode: ...` lines at the top). Tolerates markdown emphasis; null when absent.
 */
export function reportOutcome(text) {
  const head = String(text ?? "").split("\n").slice(0, 25).join("\n").replace(/[*_`]/g, "");
  const outcome = head.match(/^\s*outcome\s*:\s*(successful|partial|failed|nothing[ -]found)\b/im)?.[1].toLowerCase().replace("-", " ") ?? null;
  const mode = head.match(/^\s*mode\s*:\s*(fix|improve)\b/im)?.[1].toLowerCase() ?? null;
  return { outcome, mode };
}

/** Trailing run of completed cycles whose report said "nothing found". */
export function nothingFoundInARow(history) {
  let n = 0;
  for (let i = history.length - 1; i >= 0 && history[i].reportOutcome === "nothing found"; i--) n++;
  return n;
}
