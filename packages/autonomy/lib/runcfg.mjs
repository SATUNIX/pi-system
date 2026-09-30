// The flat configuration the container builders, host git functions and cycle loop consume,
// derived in ONE place from the resolved contract. (lib/config.mjs still resolves the flat v0
// shape for the pure modules' tests; a real run always goes contract -> runtimeConfig.)
import { SELF_IMPROVE_LIMITS } from "./templates/self-improve.mjs";

/**
 * @param {object} contract resolved contract
 * @param {{ namePrefix?: string, effort?: {tier: string, cap: string} }} [opts]
 *   namePrefix: container/network name prefix (default `pi-exp-<run>`); tests pass a
 *   `pi-autonomy-test-` prefix so nothing they create can be confused with a real run's.
 */
export function runtimeConfig(contract, opts = {}) {
  const r = contract.runtime;
  const t = contract.templateOptions ?? {};
  const integration = t.integration ?? { branch: null, review: false };
  const promotion = contract.promotion;
  const repo = contract.inputs.repository;
  const localDest = promotion.destinations.find((d) => d.kind === "local-branch");
  const remoteDest = promotion.destinations.find((d) => d.kind === "git-remote");
  // Where the integration branch is synchronised and published: nowhere unless promotion says so.
  const integrationRemote = promotion.policy === "push" ? remoteDest?.url ?? null : promotion.policy === "local-branch" ? localDest?.repo ?? null : null;
  const hardUsd = t.perStepHardUsd ?? 2 * contract.budget.perStepUsd;
  return {
    contract,
    run: contract.run,
    template: contract.template,
    namePrefix: opts.namePrefix ?? `pi-exp-${contract.run}`,
    branch: `pi/${contract.run}`,
    tagPrefix: `pi/${contract.run}/`,
    integrationBranch: integration.branch,
    baseRef: repo?.ref ?? "HEAD",
    baseSource: repo?.path ?? repo?.url ?? null,
    integrationRemote,
    gitRemote: integrationRemote,
    image: r.image,
    engine: r.engine,
    container: { memory: r.memory, cpus: r.cpus, pids: r.pids, tmpSize: r.tmpSize, user: r.user },
    gate: { memory: t.gate?.memory ?? r.memory, cpus: t.gate?.cpus ?? "4", timeoutMinutes: Math.max(1, ...contract.acceptance.checks.map((c) => c.timeoutMinutes)) },
    gitIdentity: r.gitIdentity,
    references: contract.inputs.references,
    mirrorSeconds: r.mirrorSeconds,
    provider: contract.model.provider,
    model: contract.model.worker,
    managerModel: contract.model.manager,
    reviewModel: contract.model.review,
    models: [...new Set([contract.model.worker, contract.model.manager, contract.model.review, ...contract.model.extra].filter(Boolean))],
    upstream: contract.providerSettings.upstream,
    // Self-improve (lib/cycle.mjs and lib/triggers.mjs read these).
    cycles: contract.budget.maxSteps,
    integration: { branch: integration.branch, review: integration.review !== false, reviewModel: contract.model.review },
    budget: { perCycleUsd: contract.budget.perStepUsd, perCycleHardUsd: hardUsd, totalUsd: contract.budget.totalUsd },
    limits: { ...SELF_IMPROVE_LIMITS, ...(t.limits ?? {}) },
  };
}
