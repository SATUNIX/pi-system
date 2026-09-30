// Template `self-improve`: the original behaviour of packages/autonomy, now ONE optional
// template. Repeated cycles (review, plan, improve, verify, record) on a repository, each merged
// into one configurable integration branch only when it completes, passes the gate and passes a
// merge review; fix / improve / consolidate modes; a manager model that is asked only on
// triggers; a stop when reviews keep finding nothing. Nothing is published unless the
// contract's promotion policy and destinations say so.
export const SELF_IMPROVE_LIMITS = { softMinutes: 180, hardMinutes: 300, idleMinutes: 20, noCommitMinutes: 90, managerCallsPerCycle: 3, redGatesInARow: 2, guardEscalations: 3, nothingFoundToStop: 3 };

const describe = () => ({
  id: "self-improve",
  title: "Improve a repository in cycles",
  summary: "Repeated improvement cycles on a repository: each cycle reviews, plans, improves and verifies, and is merged into one integration branch after a green gate and a merge review. Ends on the cycle, budget or time limit, or when several reviews in a row find nothing to do. Optional: it is one template among several.",
  finite: false,
  requires: ["inputs.repository (the repository to improve)", "promotion policy (none, local-branch or push)"],
  optional: ["templateOptions.integration.branch (default pi-autonomy/integration)", "templateOptions.cycleLimits", "inputs.references"],
});

const defaults = () => ({
  objective: { title: "Autonomous improvement", spec: "" },
  acceptance: { review: true, checks: [{ id: "gate", run: ["/opt/autonomy/gate.sh"], timeoutMinutes: 60, required: true, description: "the repository's offline gate (tests, security tests, docs build, secret scan)" }], overlay: [] },
  permissions: { writeAreas: ["**"], network: { egress: [], services: [], serviceImages: [] }, credentials: { names: [] }, outputs: { destinations: [] }, unattended: { authorised: false, autoApprove: false } },
  model: { provider: "openrouter" },
  effort: "standard",
  budget: { totalUsd: 100, perStepUsd: 5, maxSteps: 50, maxMinutes: 14_400 },
  recovery: { softNudges: 2, hardRestarts: 1, maxAttemptsPerStep: 8 },
  promotion: { policy: "local-branch", destinations: [], requiresOperatorApproval: false },
  templateOptions: { integration: { branch: "pi-autonomy/integration", review: true }, perStepHardUsd: null, limits: { ...SELF_IMPROVE_LIMITS }, gate: { memory: "6g", cpus: "4" } },
});

function validate(contract, { err, warn }) {
  const repo = contract.inputs.repository;
  if (!repo) err("inputs.repository", "the self-improve template improves an existing repository: set inputs.repository (path or url, and ref)");
  const t = contract.templateOptions;
  const ib = t.integration?.branch;
  const allowed = ["integration", "perStepHardUsd", "limits", "gate"];
  for (const key of Object.keys(t)) if (!allowed.includes(key)) warn(`templateOptions.${key}`, "unknown key ignored");
  if (typeof ib !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/.test(ib) || ib.includes("..") || ib.endsWith("/") || ib.endsWith(".lock")) err("templateOptions.integration.branch", "must be a valid branch name");
  else if (["main", "master", "head", "trunk", "develop", "development", "production", "prod", "stable"].includes(ib.toLowerCase()) || /^(release|releases|hotfix|refs)(\/|$)/i.test(ib) || ib === repo?.ref) err("templateOptions.integration.branch", `"${ib}" is a protected name or the base ref; the integration branch is a separate branch a person reviews and merges from`);
  const l = t.limits ?? {};
  const { idleMinutes, noCommitMinutes, softMinutes, hardMinutes, nothingFoundToStop } = { ...SELF_IMPROVE_LIMITS, ...l };
  if (!(idleMinutes > 0 && noCommitMinutes > 0 && softMinutes > 0 && hardMinutes > softMinutes)) err("templateOptions.limits", "must be positive, with hardMinutes > softMinutes");
  if (!Number.isInteger(nothingFoundToStop) || nothingFoundToStop < 1) err("templateOptions.limits.nothingFoundToStop", "must be an integer >= 1");
  const hard = t.perStepHardUsd ?? 2 * contract.budget.perStepUsd;
  if (!(hard >= contract.budget.perStepUsd) || !(contract.budget.totalUsd >= hard)) err("templateOptions.perStepHardUsd", "must satisfy budget.perStepUsd <= perStepHardUsd <= budget.totalUsd");
  const p = contract.promotion;
  if (p.policy === "none") warn("promotion.policy", 'policy "none": merged cycles stay in the run\'s own mirror; use `export` to take them out. A later run cannot continue this run\'s integration branch.');
  if (p.policy === "local-branch") {
    for (const d of p.destinations) if (d.branch !== ib) err("promotion.destinations", `a self-improve local-branch destination must be the integration branch "${ib}"`);
  }
  if (p.policy === "push") for (const d of p.destinations) if (d.branch !== ib) err("promotion.destinations", `a self-improve push destination must be the integration branch "${ib}" (the working branch is never published)`);
  if (!contract.acceptance.checks.some((k) => k.required)) err("acceptance.checks", "needs at least one required check (the gate every cycle must pass)");
}

export default {
  id: "self-improve",
  describe,
  defaults,
  validate,
  finite: false,
};
