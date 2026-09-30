// Promotion: moving the run's result outside the run directory. It is separate from in-zone
// deployment and from the worker: the worker never promotes, and nothing is pushed or written
// anywhere the contract's promotion policy and destinations do not name.
//
//   none          nothing leaves the run directory (use `export`)
//   local-branch  fast-forward a branch in a LOCAL repository; no remote is contacted
//   push          fast-forward push to a listed remote branch; needs the operator's approval
//                 (`promote`) unless promotion.requiresOperatorApproval is false
//
// Every step is idempotent and keyed in state.promotion: a key is recorded as started before
// the action and as done after it, and a run resumed after a crash checks the destination's
// actual ref before repeating anything, so a resume never publishes twice.

/** The concrete actions for a result commit. */
export function promotionTargets(contract, cfg, sha) {
  const p = contract.promotion;
  if (p.policy === "none") return [];
  return p.destinations.map((d) => {
    if (d.kind === "local-branch") {
      const repo = d.repo ?? contract.inputs.repository?.path ?? null;
      return { key: `local-branch|${repo ?? "mirror"}|${d.branch}|${sha}`, kind: "local-branch", repo, branch: d.branch, sha, description: repo ? `fast-forward branch ${d.branch} in ${repo}` : `branch ${d.branch} in the run's own mirror` };
    }
    // cfg.integrationRemote is derived from this very destination (lib/runcfg.mjs); it is the one place the runtime may point at a resolved address.
    const url = cfg?.integrationRemote && p.destinations.filter((x) => x.kind === "git-remote").length === 1 ? cfg.integrationRemote : d.url;
    return { key: `git-remote|${url}|${d.branch}|${sha}`, kind: "git-remote", url, branch: d.branch, tags: d.tags, sha, description: `push ${d.branch}${d.tags ? " and the run's tags" : ""} to ${url} (fast-forward only)` };
  });
}

/** Where the destination stands, without changing anything: does it already hold the sha? */
function alreadyThere(repo, target) {
  try {
    if (target.kind === "local-branch") return target.repo ? repo.remoteRefSha(target.repo, `refs/heads/${target.branch}`) === target.sha : repo.g(["rev-parse", "--verify", "--quiet", `refs/heads/${target.branch}`], { allowFail: true }) === target.sha;
    return repo.remoteRefSha(target.url, `refs/heads/${target.branch}`) === target.sha;
  } catch { return false; }
}

/**
 * Carry out (or report) the promotions for `sha`. Mutates nothing itself: it calls `save(fn)`
 * with a state updater, so the caller persists each step before the next one.
 * @returns {{ status: "none"|"awaiting_approval"|"done"|"failed", done: string[], error?: string, targets: object[] }}
 */
export function runPromotions({ repo, contract, cfg, state, sha, approved = false, targets: given, save, log = () => {} }) {
  const targets = given ?? promotionTargets(contract, cfg, sha);
  if (!targets.length) return { status: "none", done: [], targets };
  if (contract.promotion.requiresOperatorApproval && !approved) return { status: "awaiting_approval", done: [], targets };
  const done = [];
  for (const t of targets) {
    if (state.promotion.done?.[t.key]) { done.push(t.key); continue; }
    if (state.promotion.started?.[t.key] && alreadyThere(repo, t)) {
      save((s) => { s.promotion.done[t.key] = { at: new Date().toISOString(), result: "found in place after an interrupted attempt" }; });
      state.promotion.done[t.key] = true; done.push(t.key);
      log(`promotion ${t.description}: already in place (a previous attempt finished)`);
      continue;
    }
    save((s) => { s.promotion.started = { ...(s.promotion.started ?? {}), [t.key]: new Date().toISOString() }; });
    try {
      const result = t.kind === "local-branch" ? (t.repo ? repo.promoteLocal(t.repo, t.branch, t.sha) : { status: "in the run's mirror" }) : repo.promotePush(t.url, t.branch, t.sha, { tags: t.tags });
      save((s) => { s.promotion.done[t.key] = { at: new Date().toISOString(), result: result.status }; });
      state.promotion.done[t.key] = true; done.push(t.key);
      log(`promotion ${t.description}: ${result.status}`);
    } catch (error) {
      log(`promotion ${t.description} failed: ${error.message}`);
      return { status: "failed", done, error: error.message, targets };
    }
  }
  return { status: "done", done, targets };
}
