// The host's view of a run's work: one bare repository (mirror.git) that only the supervisor
// writes. The worker's commits arrive only as a bundle (plain data) produced by a network-less
// container, are accepted only if they fast-forward, and every path they touch is checked
// against permissions.writeAreas before they count. The host never runs git inside a
// repository the worker can write (a planted hook or config key there would run with the
// operator's credentials). Promotion out of the mirror is fast-forward only and never forced.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import * as gm from "./gitmirror.mjs";
import { pathsOutsideAreas } from "./glob.mjs";

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export class HostRepo {
  /** @param {{ gitDir: string, cfg: object }} opts cfg: lib/runcfg.mjs runtimeConfig(contract) */
  constructor({ gitDir, cfg }) {
    this.gitDir = gitDir;
    this.cfg = cfg;
    this.g = null;
  }

  init() {
    this.g = gm.initMirror(this.gitDir);
    return this;
  }

  open() {
    this.g = gm.hostGit(this.gitDir);
    return this;
  }

  identity() {
    return ["-c", `user.name=${this.cfg.gitIdentity.name}`, "-c", `user.email=${this.cfg.gitIdentity.email}`];
  }

  /**
   * The run's starting point on refs/heads/<branch>: the configured base (fetched, committed
   * history only) or, with no repository given, one empty commit. Returns the start sha.
   */
  seedBase() {
    const { cfg, g } = this;
    let start;
    if (cfg.baseSource) start = gm.fetchBase(g, cfg);
    else {
      const tree = g(["hash-object", "-t", "tree", "-w", "--stdin"], { input: "" }) || EMPTY_TREE;
      start = g([...this.identity(), "commit-tree", tree, "-m", `chore: start run ${cfg.run}\n\nAn empty starting point: this run was given no repository.`]);
    }
    g(["update-ref", `refs/heads/${cfg.branch}`, start]);
    return start;
  }

  head() { return this.g(["rev-parse", `refs/heads/${this.cfg.branch}`]); }

  /**
   * Take the worker's branch from a bundle. Only a fast-forward of the accepted head is
   * accepted, and only if every path it changes is inside `areas` (permissions.writeAreas):
   * otherwise the accepted head stays where it was and the offending paths are reported.
   * @returns {{ head: string, moved: boolean, diverged: boolean, agent?: string, violation?: string[] }}
   */
  ingest(bundle, { areas } = {}) {
    const { g, cfg } = this;
    g(["fetch", "--quiet", "--no-tags", bundle, `+refs/heads/${cfg.branch}:refs/agent/head`]);
    const agent = g(["rev-parse", "refs/agent/head"]);
    const accepted = g(["rev-parse", `refs/heads/${cfg.branch}`]);
    if (agent === accepted) return { head: accepted, moved: false, diverged: false };
    if (g(["merge-base", "--is-ancestor", accepted, agent], { allowFail: true }) === null) return { head: accepted, moved: false, diverged: true, agent };
    if (areas) {
      const outside = pathsOutsideAreas(this.changedPaths(accepted, agent), areas);
      if (outside.length) return { head: accepted, moved: false, diverged: false, agent, violation: outside };
    }
    g(["update-ref", `refs/heads/${cfg.branch}`, agent, accepted]);
    return { head: agent, moved: true, diverged: false };
  }

  /** Paths whose content differs between two commits (renames count as delete + add). */
  changedPaths(from, to) {
    if (!from || from === to) return [];
    const out = this.g(["diff", "--name-only", "--no-renames", "-z", from, to]);
    return out ? out.split("\0").filter(Boolean) : [];
  }

  /** Changed paths that permissions.writeAreas does not allow. */
  outsideWriteAreas(from, to, areas) { return pathsOutsideAreas(this.changedPaths(from, to), areas); }

  diffText(from, to, max = 60_000) {
    const text = this.g(["diff", "--no-color", "--no-ext-diff", from, to, "--", ".", ":(exclude)package-lock.json"], { allowFail: true }) ?? "";
    return text.length <= max ? text : `${text.slice(0, max / 2)}\n...[${text.length - max} characters cut]...\n${text.slice(-max / 2)}`;
  }

  logSince(from, to) { return gm.logSince(this.g, from, to); }

  logOneline(from, to, n = 15) { return this.g(["log", `-${n}`, "--format=%h %s", from ? `${from}..${to}` : to], { allowFail: true }) ?? ""; }

  fileAt(ref, file) { return gm.fileAt(this.g, ref, file); }

  bundleBranch(out, extraRefs = []) { return gm.bundleBranch(this.g, this.cfg, out, extraRefs); }

  tag(name, sha) { return gm.tag(this.g, this.cfg, name, sha); }

  /** Everything worth taking away: the work branch, the integration branch if any, the run's tags. */
  exportBundle(out) {
    const { cfg, g } = this;
    const refs = [`refs/heads/${cfg.branch}`];
    if (cfg.integrationBranch && g(["rev-parse", "--verify", "--quiet", `refs/heads/${cfg.integrationBranch}`], { allowFail: true })) refs.push(`refs/heads/${cfg.integrationBranch}`);
    const tags = g(["for-each-ref", "--format=%(refname)", `refs/tags/${cfg.tagPrefix}`], { allowFail: true });
    if (tags) refs.push(...tags.split("\n").filter(Boolean));
    g(["bundle", "create", "--quiet", out, ...refs]);
    return refs;
  }

  /** A binary-safe patch of from..to. */
  exportPatch(out, from, to) {
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", `--git-dir=${this.gitDir}`, "diff", "--binary", "--no-color", "--no-ext-diff", from, to], { maxBuffer: 512 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`git diff failed: ${String(r.stderr).slice(0, 300)}`);
    fs.writeFileSync(out, r.stdout);
    return r.stdout.length;
  }

  // --- promotion: fast-forward only, never forced ----------------------------------------------
  /** The sha a ref has in another repository (a local path or a URL), or null. */
  remoteRefSha(where, ref) {
    const out = this.g(["ls-remote", where, ref], { allowFail: true });
    const first = out?.split("\n")[0]?.split(/\s+/)[0];
    return first || null;
  }

  /** Fast-forward `branch` in a LOCAL repository to `sha`. */
  promoteLocal(repoPath, branch, sha) {
    const { g } = this;
    g(["update-ref", "refs/promote/head", sha]);
    const ref = `refs/heads/${branch}`;
    const before = spawnSync("git", ["-C", repoPath, "rev-parse", "--verify", "--quiet", ref], { encoding: "utf8" }).stdout.trim() || null;
    if (before === sha) return { status: "unchanged", from: before, to: sha };
    const r = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "-C", repoPath, "fetch", "--quiet", "--no-tags", this.gitDir, `refs/promote/head:${ref}`], { encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (r.status !== 0) throw new Error(`promotion to ${repoPath} ${branch} failed (only fast-forwards are made; a branch that is checked out there cannot be updated): ${r.stderr.trim().split("\n").slice(-2).join(" | ")}`);
    return { status: "updated", from: before, to: sha };
  }

  /** Push `sha` to `branch` of a remote (fast-forward only; tags of this run when asked). */
  promotePush(url, branch, sha, { tags = false } = {}) {
    const { g, cfg } = this;
    g(["update-ref", "refs/promote/head", sha]);
    const specs = [`refs/promote/head:refs/heads/${branch}`];
    if (tags) for (const t of (g(["for-each-ref", "--format=%(refname)", `refs/tags/${cfg.tagPrefix}`], { allowFail: true }) ?? "").split("\n").filter(Boolean)) specs.push(`${t}:${t}`);
    g(["push", "--quiet", "--porcelain", url, ...specs]);
    return { status: "pushed", to: sha };
  }
}
