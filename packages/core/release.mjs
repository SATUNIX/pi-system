#!/usr/bin/env node
/**
 * Release cutter (Epic 8 Sprint 8.2, hardened post-independent-review — H-08). Produces
 * ONE reviewable release commit + an annotated tag `vX.Y.Z`. It runs the full gate first
 * and refuses to release if anything is red.
 *
 * IMPORTANT: this script NEVER pushes. Pushing is a deliberate, separate manual step after
 * the tag is reviewed (`git push origin main --follow-tags`). There is no --push flag. The
 * pushed `v*` tag is the release: installs on the `latest` channel see it through /update, and
 * the GitHub Actions release workflow re-runs the gate (see docs/releasing.md).
 *
 * Usage:
 *   node packages/core/release.mjs <version> [--dry-run]
 *   node packages/core/release.mjs 0.2.4-beta.1
 *   node packages/core/release.mjs 0.2.4
 *   node packages/core/release.mjs <version> --bump-only   # sync version fields + lockfile only:
 *                                                          # no gates, no commit, no tag
 *
 * --bump-only is for preparing a release branch: it needs the CHANGELOG section but not a clean
 * tree, and it creates no commit and no tag. The operator later runs the full command, which
 * (finding every version field already at <version> and no earlier tag) only gates and tags.
 */
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT, PACKAGES_DIR } from "./lib/paths.mjs";
import { SEMVER, compareSemver } from "./lib/semver.mjs";
import { setReadmeBadgeVersion } from "./lib/version-badge.mjs";

const ROOT = WORKSPACE_ROOT;
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const bumpOnly = args.includes("--bump-only");
const version = args.find((a) => SEMVER.test(a));

function fail(msg) {
  console.error(`[release] FAIL: ${msg}`);
  process.exit(1);
}
// H-08 fix: dry-run previously skipped every gate (`run()` only executed when
// `!dryRun`), so it provided no real preflight evidence. Every READ-ONLY validation gate
// below is now marked `always: true` and genuinely runs in dry-run too; only steps that
// mutate committed source state (the version bump, the lockfile regen, and the final
// git add/commit/tag) stay gated behind `!dryRun`. Surface exports and the docs build
// write only to gitignored `dist/`/`site/`, so they run unconditionally as well.
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    fail(`invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function gitLines(command) {
  try {
    return execSync(command, { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  } catch (error) {
    fail(`git command failed: ${command} (${error instanceof Error ? error.message : String(error)})`);
  }
}

// A fixed command line is a string. Anything that carries the version or a path goes through git() as an argv array to a
// literal `git`, never through a shell.
function run(cmd, opts = {}) {
  console.log(`[release] > ${cmd}`);
  if (!dryRun || opts.always) {
    try {
      execSync(cmd, { cwd: ROOT, stdio: "inherit" });
    } catch (error) {
      fail(`command failed: ${cmd} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}

function git(args) {
  const shown = `git ${args.map((a) => (/^[\w@:/.+=,-]+$/.test(a) ? a : JSON.stringify(a))).join(" ")}`;
  console.log(`[release] > ${shown}`);
  if (dryRun) return;
  try {
    execFileSync("git", args, { cwd: ROOT, stdio: "inherit" });
  } catch (error) {
    fail(`command failed: ${shown} (${error instanceof Error ? error.message : String(error)})`);
  }
}

const escapeRegExp = (text) => text.replace(/[\\^$.*+?()[\]{}|/-]/g, "\\$&");

if (!version) fail("missing <version> (expected X.Y.Z or X.Y.Z-pre.N)");
if (/(^|[.-])next\./.test(version)) fail("snapshot (next) versions are published from main by CI, not released");

// 1. CHANGELOG gate: the version must already have a section (docs before release).
const changelogPath = path.join(ROOT, "CHANGELOG.md");
if (!fs.existsSync(changelogPath)) fail("CHANGELOG.md missing");
const changelog = fs.readFileSync(changelogPath, "utf8");
if (!new RegExp(`^##\\s*\\[${escapeRegExp(version)}\\]`, "m").test(changelog)) {
  fail(`CHANGELOG.md has no "## [${version}]" section — document the release first`);
}

// 2. Clean tree, with NO exclusions (H-08 fix: previously package.json/package-lock.json
// were excluded unconditionally, so arbitrary pre-existing dirty content in either would
// be silently swept into the release commit alongside the version bump this script makes
// itself). Everything, including package.json, must be clean before we touch anything.
const status = bumpOnly ? [] : gitLines("git status --porcelain");
if (status.length > 0) {
  fail(`working tree not clean — commit or stash first:\n${status.join("\n")}`);
}

// 3. Tag must not already exist.
const existingTags = gitLines("git tag -l");
if (existingTags.includes(`v${version}`)) fail(`tag v${version} already exists`);

// 4. Version must move strictly forward (H-08 fix: previously accepted any digit-only
// version with no monotonicity check, so a downgrade or a repeat of an already-shipped
// version could be tagged as if it were new).
const pkgPath = path.join(ROOT, "package.json");
const pkg = readJson(pkgPath);
const prev = pkg.version;
// The first publish releases the version already in package.json; afterwards it must advance.
const firstRelease = existingTags.filter((t) => /^v\d/.test(t)).length === 0 && version === prev;
if (!firstRelease && compareSemver(version, prev) <= 0) fail(`version ${version} is not forward of current ${prev} (must strictly increase)`);

// 5. Bump package.json (and every workspace, which versions in lockstep), the README's version
// badge, and regenerate package-lock.json so the two stay in lockstep -
// previously only package.json was bumped/staged, so the lockfile's root version and
// resolved dependency tree silently drifted from every release onward (F-05).
console.log(`[release] version ${prev} -> ${version}`);
const workspaceManifests = fs
  .readdirSync(PACKAGES_DIR)
  .map((dir) => path.join(PACKAGES_DIR, dir, "package.json"))
  .filter((file) => fs.existsSync(file));
if (!dryRun && (!firstRelease || bumpOnly)) {
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  for (const file of workspaceManifests) {
    const ws = readJson(file);
    ws.version = version;
    fs.writeFileSync(file, JSON.stringify(ws, null, 2) + "\n");
  }
  const readmePath = path.join(ROOT, "README.md");
  fs.writeFileSync(readmePath, setReadmeBadgeVersion(fs.readFileSync(readmePath, "utf8"), version));
  run("npm install --package-lock-only --ignore-scripts");
}
if (bumpOnly) {
  console.log(`\n[release] --bump-only: version fields, README badge and lockfile now say ${version}${dryRun ? " (dry-run: nothing written)" : ""}. No gates were run, nothing was committed or tagged.`);
  process.exit(0);
}

// 6. Full gate. MkDocs is part of it and is the one tool that is not an npm dependency, so find out now, not after
// the whole suite, that it is missing (`run` exits on failure, so a check after it could never report this).
// `npm ci` next, so a lockfile that can't reproduce a clean install blocks the release rather than shipping one
// (F-05's exact failure mode). Then `npm run check:all`: the repository's single definition of "all the checks"
// (what CI runs): the manifest, profile and catalogue checks, every smoke and security suite, the per-profile
// install checks, the clean-install test on the packed tarball, the test-wiring check and the Mermaid check.
// Then the checks that are not npm scripts of that kind: the lockfile check and a real, strict MkDocs build
// (the lighter link checker does not catch every class of broken link; requirements-docs.txt is the prerequisite).
try {
  execSync("python -m mkdocs --version", { cwd: ROOT, stdio: "ignore" });
} catch {
  fail("MkDocs is not installed — the docs build is part of the release gate. Run: python -m pip install --user -r requirements-docs.txt");
}
run("npm ci --dry-run --ignore-scripts", { always: true });
run("npm run check:all", { always: true });
run("node packages/core/lockfile-check.mjs", { always: true });
run("python -m mkdocs build --strict", { always: true });

// 7. The one published package packs cleanly and works from its unpacked copy.
run("node packages/core/pack-check.mjs", { always: true });

// 8. One reviewable commit + annotated tag. NO push.
if (!firstRelease) {
  const manifests = ["package.json", "package-lock.json", ...workspaceManifests.map((f) => path.relative(ROOT, f))];
  git(["add", ...manifests]);
  git(["add", "README.md"]); // its version badge moves with the version
  git(["commit", "-m", `chore(release): ${version}`]);
}
git(["tag", "-a", `v${version}`, "-m", `Release ${version}`]);

console.log(`\n[release] Done: ${firstRelease ? "" : "committed + "}tagged v${version} (local only).`);
console.log(`[release] NOT pushed. To publish after review: git push origin main --follow-tags`);
console.log(`[release] Pushing the v${version} tag makes it the \`latest\` release for git installs; the GitHub release workflow (manual) re-runs the gate before any npm publish.`);
if (dryRun) console.log("[release] (dry-run: validation gates ran for real; no files changed, no commit/tag created)");
