// Run configuration for the autonomous improvement runner (packages/autonomy). One JSON file per
// run; everything not given falls back to DEFAULTS. Durations are minutes, money is USD.
import fs from "node:fs";

export const DEFAULTS = {
  cycles: 50,
  model: "deepseek/deepseek-v4.1-flash",
  managerModel: "deepseek/deepseek-v4.1-flash",
  provider: "openrouter",
  upstream: "https://openrouter.ai/api/v1",
  image: "pi-autonomy:local",
  // Container engine: "podman" (rootless; no daemon, no docker group) or "docker".
  engine: "podman",
  gitRemote: "https://gitlab.home.internal/lab/pi-system.git",
  baseRef: "main",
  // Cycles build on one shared integration branch instead of a branch per run: each cycle
  // starts from its head, and a cycle that completes, passes the gate and passes the merge
  // review is fast-forwarded into it. Work that is not merged stays reachable through the
  // cycle's exp/<run>/cycle-NN tag. review: an independent LLM review (lib/review.mjs) before
  // every merge; reviewModel defaults to managerModel.
  integration: { branch: "experimental/main", review: true, reviewModel: null },
  // Extra model ids the relay will serve besides `model` (for example a subagent model).
  extraModels: [],
  // Read-only reference repositories for the agent: { name: "/path/to/git/repo" }. A
  // `git archive HEAD` snapshot (tracked files only) is taken at seed time and mounted at
  // /reference/<name>; the live repository is never mounted.
  references: {},
  // Author of the seed commit and of the agent's commits inside the container.
  gitIdentity: { name: "pi autonomy", email: "pi-autonomy@localhost" },
  // perCycleUsd: the manager reviews the cycle; perCycleHardUsd: the cycle is closed as partial
  // without asking; totalUsd: the run stops (and the relay refuses further requests).
  budget: { perCycleUsd: 5, perCycleHardUsd: 10, totalUsd: 100 },
  limits: {
    softMinutes: 180, // the manager reviews the cycle
    hardMinutes: 300, // the cycle is closed as partial, no manager call
    idleMinutes: 20, // no session events
    noCommitMinutes: 90, // events, but nothing pushed
    managerCallsPerCycle: 3,
    redGatesInARow: 2,
    guardEscalations: 3,
    nothingFoundToStop: 3, // cycles in a row whose report says "nothing found" end the run
  },
  mirrorSeconds: 30,
  // user: "host" runs containers as the operator's uid:gid, so bind-mounted run files stay
  // theirs (with podman, through --userns=keep-id). Rootless Docker wants "0:0", which maps
  // to the operator.
  container: { memory: "6g", cpus: "4", pids: 1024, tmpSize: "4g", user: "host" },
  gate: { timeoutMinutes: 60, memory: "6g", cpus: "4" },
};

const RUN_ID = /^[a-z0-9][a-z0-9-]{2,40}$/;

function merge(base, over) {
  const out = { ...base };
  for (const [key, value] of Object.entries(over ?? {})) {
    out[key] = value && typeof value === "object" && !Array.isArray(value) && base[key] && typeof base[key] === "object"
      ? merge(base[key], value)
      : value;
  }
  return out;
}

/** The effective config. Throws on anything that would make the run unsafe or ambiguous. */
export function resolveConfig(raw) {
  const cfg = merge(DEFAULTS, raw);
  const problems = [];
  if (!RUN_ID.test(cfg.run ?? "")) problems.push("run: lowercase id, 3-41 chars [a-z0-9-] (it names the working branch experimental/<run> and the tags exp/<run>/)");
  if (!Number.isInteger(cfg.cycles) || cfg.cycles < 1 || cfg.cycles > 500) problems.push("cycles: integer 1-500");
  const b = cfg.budget;
  if (b.perCycleHardUsd == null) b.perCycleHardUsd = 2 * b.perCycleUsd;
  if (!(b.perCycleUsd > 0) || !(b.perCycleHardUsd >= b.perCycleUsd) || !(b.totalUsd >= b.perCycleHardUsd)) problems.push("budget: 0 < perCycleUsd <= perCycleHardUsd <= totalUsd");
  const l = cfg.limits;
  if (!(l.idleMinutes > 0 && l.noCommitMinutes > 0 && l.softMinutes > 0 && l.hardMinutes > l.softMinutes)) problems.push("limits: positive, and hardMinutes > softMinutes");
  if (!Number.isInteger(l.nothingFoundToStop) || l.nothingFoundToStop < 1) problems.push("limits.nothingFoundToStop: integer >= 1");
  if (!/^https:\/\//.test(cfg.upstream)) problems.push("upstream: https URL");
  if (!/^[\w.-]+\/[\w.:-]+$/.test(cfg.model) || /:online\b/.test(cfg.model)) problems.push("model: provider/model id (no :online variants)");
  for (const name of Object.keys(cfg.references ?? {})) if (!/^[a-z0-9][a-z0-9._-]{0,40}$/.test(name)) problems.push(`references: bad name ${JSON.stringify(name)}`);
  if (!["podman", "docker"].includes(cfg.engine)) problems.push('engine: "podman" or "docker"');
  if (!Array.isArray(cfg.extraModels)) problems.push("extraModels: array of model ids");
  if (!/^[\w.-]+(:[\w.\/-]+)?$/.test(cfg.image)) problems.push("image: docker image reference");
  const ib = cfg.integration.branch;
  if (!/^experimental\/[a-z0-9][a-z0-9._-]{0,40}$/.test(ib ?? "") || ib.includes("..")) problems.push("integration.branch: experimental/<name>");
  if (problems.length) throw new Error(`invalid run config:\n  ${problems.join("\n  ")}`);
  // branch: the cycle's working branch, local to the host mirror and the agent's bare repo (it is
  // never pushed to gitRemote); integration: the branch that is published.
  return { ...cfg, branch: `experimental/${cfg.run}`, integrationBranch: ib, tagPrefix: `exp/${cfg.run}/`,
    reviewModel: cfg.integration.reviewModel ?? cfg.managerModel, models: [cfg.model, ...cfg.extraModels] };
}

export function readConfig(file) {
  return resolveConfig(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** Atomic JSON write (temp file + rename), so a crash never leaves half a state file. */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}
