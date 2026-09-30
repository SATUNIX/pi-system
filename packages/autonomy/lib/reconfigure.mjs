// `reconfigure`: the ONLY way effort, budgets or recovery limits change for an existing run. It
// cannot touch permissions, network, credentials, promotion, the image or the acceptance
// definitions (those are the boundary the operator authorised; changing them means a new run).
// Resume and interactive effort changes inside a worker never reach this path.
import { resolveContract } from "./contract.mjs";

export const RECONFIGURABLE = ["effort", "budget", "recovery"];

/**
 * @param {{ contract: object, state: object, changes: object, effort?: object }} o
 * @returns {{ ok: boolean, problems: string[], next?: { effort: object, limits: { budget: object, recovery: object } }, before?: object, after?: object }}
 */
export function planReconfigure({ contract, state, changes, effort }) {
  if (!changes || typeof changes !== "object" || Array.isArray(changes) || !Object.keys(changes).length) return { ok: false, problems: [`nothing to change; reconfigurable: ${RECONFIGURABLE.join(", ")}`] };
  const refused = Object.keys(changes).filter((k) => !RECONFIGURABLE.includes(k));
  if (refused.length) return { ok: false, problems: [`${refused.join(", ")} cannot be reconfigured: it is part of the authorised boundary (only ${RECONFIGURABLE.join(", ")} can change). Start a new run with a new authorisation instead.`] };
  const before = { effort: state.effort, budget: state.limits.budget, recovery: state.limits.recovery };
  const want = {
    effort: changes.effort === undefined ? { tier: state.effort.tier, cap: state.effort.cap } : typeof changes.effort === "object" && changes.effort !== null ? { tier: changes.effort.tier ?? state.effort.tier, cap: changes.effort.cap ?? state.effort.cap } : { tier: changes.effort },
    budget: { ...state.limits.budget, ...(changes.budget ?? {}) },
    recovery: { ...state.limits.recovery, ...(changes.recovery ?? {}) },
  };
  // A bare tier keeps the current cap unless it would exceed it; the resolver checks tier <= cap.
  if (typeof changes.effort !== "object" && changes.effort !== undefined) want.effort.cap = state.effort.cap;
  // Validate by resolving a candidate contract: the same rules as at start.
  const { objective, authorisation: _a, ...rest } = contract;
  const candidate = { ...rest, objective: { title: objective.title, spec: objective.spec, backlog: objective.backlog }, effort: want.effort, budget: want.budget, recovery: want.recovery, authorisation: undefined };
  const r = resolveContract(JSON.parse(JSON.stringify(candidate)), { effort });
  const problems = r.problems.filter((p) => p.level === "error" && /^(effort|budget|recovery)/.test(p.path)).map((p) => `${p.path}: ${p.message}`);
  if (problems.length) return { ok: false, problems };
  const after = { effort: r.contract.effort, budget: r.contract.budget, recovery: r.contract.recovery };
  return { ok: true, problems: [], before, after, next: { effort: after.effort, limits: { budget: after.budget, recovery: after.recovery } } };
}
