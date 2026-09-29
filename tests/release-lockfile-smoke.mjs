#!/usr/bin/env node
/**
 * packages/core/release.mjs regression coverage (F-05 lockfile maintenance + H-08 release-cutter
 * safety). A full functional test would need real `npm install --package-lock-only`
 * network access and mutate git state, which this repo's test suite deliberately avoids
 * (see packages/core/eval/harness.mjs and every other tests/*.mjs - all offline, no network, no
 * git mutation). Instead this asserts against the script's own source, the same static-
 * analysis technique packages/core/verify.mjs already uses for its security pattern parity check.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(ROOT, "packages", "core", "release.mjs"), "utf8");

function check(name, fn) {
  try {
    fn();
    console.log(`  OK: ${name}`);
    return true;
  } catch (error) {
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error.message}`);
    return false;
  }
}

const results = [
  // F-05: lockfile maintenance.
  check("version bump regenerates the lockfile", () => {
    assert.match(src, /npm install --package-lock-only/, "must run `npm install --package-lock-only` after bumping package.json");
  }),
  check("release gate verifies the lockfile reproduces a clean install", () => {
    assert.match(src, /npm ci --dry-run/, "must run `npm ci --dry-run` as part of the release gate (F-05's exact failure mode)");
  }),
  check("release commit stages package-lock.json alongside package.json", () => {
    assert.match(src, /\["package\.json", "package-lock\.json", \.\.\.workspaceManifests/, "the release commit must include package-lock.json and every workspace manifest");
    assert.match(src, /run\("git add README\.md"\)/, "the release commit must include README.md (its version badge moves with the version)");
    assert.match(src, /git add \$\{manifests\.join/, "the release commit must stage those manifests");
  }),

  // H-08: release-cutter safety.
  check("clean-tree check has no package.json/package-lock.json exemption", () => {
    assert.doesNotMatch(
      src,
      /filter\(\(l\)\s*=>\s*!\/package/,
      "the clean-tree check must not exempt package.json/package-lock.json from requiring a clean tree - doing so let arbitrary dirty content be swept into the release commit",
    );
  }),
  check("version must be strictly forward of the current version", () => {
    assert.match(src, /compareSemver\(version, prev\) <= 0/, "must compute and check version monotonicity (semver precedence, prerelease-aware)");
    assert.match(src, /is not forward of current/, "must fail with a clear message when the version does not strictly increase");
  }),
  check("release gate runs the full per-profile capstone matrix (lite included) and the package check", () => {
    assert.match(src, /readdirSync\(PROFILES_DIR\)/, "the profile loop must cover every profile file, so a new profile (lite) cannot be skipped");
    assert.match(src, /profile-check\.mjs --profile \$\{file\.replace/, "must run profile-check per profile");
    assert.match(src, /pack-check\.mjs/, "must prove the published package packs and works from its unpacked copy");
    assert.match(src, /lockfile-check\.mjs/, "must run the lockfile integrity check");
  }),
  check("release gate runs a real, strict MkDocs build", () => {
    assert.match(src, /mkdocs build --strict/, "must run a real `mkdocs build --strict`, not only the lighter custom link-checker");
  }),
  check("dry-run actually exercises the validation gates", () => {
    const alwaysCount = (src.match(/\{\s*always:\s*true\s*\}/g) || []).length;
    assert.ok(alwaysCount >= 8, `most validation gates must run even in --dry-run (found ${alwaysCount} \`always: true\` gates, expected >= 8) - a dry-run that skips every gate provides no real preflight evidence`);
  }),
];

const failed = results.filter(r => !r).length;
if (failed > 0) {
  console.error(`\n[release-lockfile-smoke] ${failed}/${results.length} FAILED`);
  process.exit(1);
}
console.log(`\n[release-lockfile-smoke] all ${results.length} checks passed`);
