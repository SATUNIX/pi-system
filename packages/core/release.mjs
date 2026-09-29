#!/usr/bin/env node
/**
 * Release cutter (Epic 8 Sprint 8.2, hardened post-independent-review — H-08). Produces
 * ONE reviewable release commit + an annotated tag `vX.Y.Z`. It runs the full gate first
 * and refuses to release if anything is red.
 *
 * IMPORTANT: this script NEVER pushes. Pushing is a deliberate, separate manual step after
 * the tag is reviewed (`git push origin main --follow-tags`). There is no --push flag. The
 * pushed `v*` tag is the release: installs on the `latest` channel see it through /update, and
 * the GitLab pipeline re-runs the gate and creates the GitLab Release (see docs/releasing.md).
 *
 * Usage:
 *   node packages/core/release.mjs <version> [--dry-run]
 *   node packages/core/release.mjs 0.2.1-beta.1
 *   node packages/core/release.mjs 0.2.1
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT, PROFILES_DIR, PACKAGES_DIR } from "./lib/paths.mjs";
import { SEMVER, compareSemver } from "./lib/semver.mjs";
import { setReadmeBadgeVersion } from "./lib/version-badge.mjs";

const ROOT = WORKSPACE_ROOT;
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
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

if (!version) fail("missing <version> (expected X.Y.Z or X.Y.Z-pre.N)");
if (/(^|[.-])next\./.test(version)) fail("snapshot (next) versions are published from main by CI, not released");

// 1. CHANGELOG gate: the version must already have a section (docs before release).
const changelogPath = path.join(ROOT, "CHANGELOG.md");
if (!fs.existsSync(changelogPath)) fail("CHANGELOG.md missing");
const changelog = fs.readFileSync(changelogPath, "utf8");
if (!new RegExp(`^##\\s*\\[${version.replace(/\./g, "\\.")}\\]`, "m").test(changelog)) {
  fail(`CHANGELOG.md has no "## [${version}]" section — document the release first`);
}

// 2. Clean tree, with NO exclusions (H-08 fix: previously package.json/package-lock.json
// were excluded unconditionally, so arbitrary pre-existing dirty content in either would
// be silently swept into the release commit alongside the version bump this script makes
// itself). Everything, including package.json, must be clean before we touch anything.
const status = gitLines("git status --porcelain");
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
if (!dryRun && !firstRelease) {
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

// 6. Full gate. `npm ci` first, so a lockfile that can't reproduce a clean install
// blocks the release rather than shipping one (F-05's exact failure mode). Includes the
// full per-profile + lite capstone matrix (H-08 fix: previously omitted entirely from
// the release gate despite being the plan's own capstone acceptance criterion) and a
// real, strict MkDocs build (H-08 fix: previously only the lighter custom link-checker
// ran, which does not catch every broken-link class a real `mkdocs build --strict` does
// - see docs/getting-started.md for the `requirements-docs.txt` prerequisite).
run("npm ci --dry-run --ignore-scripts", { always: true });
run("node packages/core/verify.mjs", { always: true });
run("npm run test:security", { always: true });
run("npm run eval", { always: true });
run("npm run smoke:docs", { always: true });
run("node packages/core/lockfile-check.mjs", { always: true });
for (const file of fs.readdirSync(PROFILES_DIR)) {
  if (!file.endsWith(".json")) continue;
  run(`node packages/core/profile-check.mjs --profile ${file.replace(/\.json$/, "")}`, { always: true });
}
try {
  run("python -m mkdocs build --strict", { always: true });
} catch {
  fail("MkDocs build failed or MkDocs is not installed — run: python -m pip install --user -r requirements-docs.txt");
}

// 7. The one published package packs cleanly and works from its unpacked copy.
run("node packages/core/pack-check.mjs", { always: true });

// 8. One reviewable commit + annotated tag. NO push.
if (!firstRelease) {
  const manifests = ["package.json", "package-lock.json", ...workspaceManifests.map((f) => path.relative(ROOT, f))];
  run(`git add ${manifests.join(" ")}`);
  run("git add README.md"); // its version badge moves with the version
  run(`git commit -m "chore(release): ${version}"`);
}
run(`git tag -a v${version} -m "Release ${version}"`);

console.log(`\n[release] Done: ${firstRelease ? "" : "committed + "}tagged v${version} (local only).`);
console.log(`[release] NOT pushed. To publish after review: git push origin main --follow-tags`);
console.log(`[release] Pushing the v${version} tag releases it: the GitLab pipeline re-runs the gate and creates the GitLab Release.`);
if (dryRun) console.log("[release] (dry-run: validation gates ran for real; no files changed, no commit/tag created)");
