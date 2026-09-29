#!/usr/bin/env node
/**
 * Version for a `next` (main-branch) snapshot publish.
 *
 * Snapshots must sort ABOVE the release they were built after and BELOW the release that
 * follows, because `pi update` only moves forward (semver `gt`):
 *
 *   package.json 0.2.1-beta.0  ->  0.2.1-beta.0.next.20260924061500.g1a2b3c4
 *                                  (> 0.2.1-beta.0, < 0.2.1-beta.1 and 0.2.1)
 *   package.json 0.2.1         ->  0.2.2-next.20260924061500.g1a2b3c4
 *                                  (> 0.2.1, < 0.2.2)
 *
 * The UTC timestamp keeps successive snapshots of one base version ordered; the `g<sha>`
 * suffix records the commit (prefixed so an all-digit sha is never a numeric identifier).
 *
 * Usage:
 *   node packages/core/snapshot-version.mjs [--sha <sha>] [--time <ISO>]   # print it
 *   node packages/core/snapshot-version.mjs --write                         # also set package.json
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT } from "./lib/paths.mjs";

const args = process.argv.slice(2);
const get = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : null);

export function snapshotVersion(base, sha, when = new Date()) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(base);
  if (!m) throw new Error(`not a release version: ${base}`);
  const [, major, minor, patch, pre] = m;
  if (pre && /(^|\.)next(\.|$)/.test(pre)) throw new Error(`already a snapshot version: ${base}`);
  const stamp = when.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const commit = `g${String(sha).slice(0, 7).toLowerCase()}`;
  if (!/^g[0-9a-f]{7}$/.test(commit)) throw new Error(`not a git sha: ${sha}`);
  return pre ? `${major}.${minor}.${patch}-${pre}.next.${stamp}.${commit}` : `${major}.${minor}.${Number(patch) + 1}-next.${stamp}.${commit}`;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("snapshot-version.mjs")) {
  const pkgPath = path.join(WORKSPACE_ROOT, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const sha = get("--sha") ?? process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: WORKSPACE_ROOT, encoding: "utf8" }).trim();
  const when = get("--time") ? new Date(get("--time")) : new Date();
  const version = snapshotVersion(pkg.version, sha, when);
  if (args.includes("--write")) {
    pkg.version = version;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
  console.log(version);
}
