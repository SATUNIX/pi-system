// What the host may publish from the run's bare repository to GitLab. The container can push
// anything to its bare repo (it has no other remote); only the integration branch
// (experimental/main) and the run's exp/<run>/ tags leave the machine, fast-forward only, with
// the operator's own git credentials on the host. Nothing is ever force-pushed: the cycle's
// working branch, the only branch that moves backwards, stays on this machine.

/** Refspecs to push, from `git for-each-ref` output lines "<sha> <refname>". */
export function publishRefspecs(forEachRef, cfg) {
  const branch = `refs/heads/${cfg.integrationBranch}`;
  const tagPrefix = `refs/tags/${cfg.tagPrefix}`;
  const specs = [];
  for (const line of String(forEachRef).split("\n")) {
    const ref = line.trim().split(/\s+/)[1];
    if (!ref) continue;
    if (ref === branch || (ref.startsWith(tagPrefix) && isSafeRefTail(ref.slice(tagPrefix.length)))) specs.push(`${ref}:${ref}`);
  }
  return specs;
}

function isSafeRefTail(tail) {
  return /^[A-Za-z0-9._-]+$/.test(tail) && !tail.includes("..");
}

/** Receive settings for the run's bare repo: no history rewrites, no deletions from inside. */
export const BARE_REPO_CONFIG = [
  ["receive.denyNonFastForwards", "true"],
  ["receive.denyDeletes", "true"],
  ["receive.fsckObjects", "true"],
];
