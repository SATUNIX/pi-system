#!/usr/bin/env node
/**
 * Profile regression (Epic 9 Sprint 9.1) — OFFLINE, real per-profile capstone matrix.
 *
 * F-06 fix: this previously only resolved names/maturity/ordering and never imported,
 * registered, installed, or evaluated a single extension - the capstone gate stayed
 * green through F-01 (profile filtering not applied), F-02 (first-party tools blocked),
 * H-02 (branch-lab wrong execute signature), and H-03 (provider-router notification
 * discarded). It now actually exercises two of the three DoD legs:
 *
 *   1. "install": resolve the profile's `include` list via packages/core/lib/resolve.mjs's
 *      resolveProfile() (fails loud on any dangling/unresolved name, exactly like
 *      packages/core/install.mjs now does) and replay the real settings.json narrowing
 *      packages/core/install.mjs performs via packages/core/lib/settings.mjs's mergePackageBlock() against
 *      a scratch settings file. Asserts the resulting filter is genuinely narrower
 *      than the full extension set and contains exactly the profile's own in-repo/
 *      vendor extensions — the review's own repro bar ("a genuinely narrowed extension
 *      set, not just resolve names").
 *   2. "load" (stands in for "verify" offline): transpile and register every resolved
 *      in-repo/vendor extension against a fake pi API (packages/core/eval/harness.mjs), firing
 *      session_start when the extension registers one, in a scratch cwd — catching
 *      import-time and registration-time breakage a name-only check cannot.
 *
 * "eval" (behavioral fixtures) is deliberately NOT re-run here: packages/core/eval/fixtures.mjs
 * tests extension behavior, which is identical code regardless of which profile happens
 * to include it, so re-running the fixed 13-fixture suite once per profile would add
 * CI time without new signal. It remains its own required `npm run eval` CI job.
 *
 * Also retained: non-experimental profiles carry no stub/experimental extension;
 * tool-firewall loads before pentest-governance-domain when both present.
 *
 * A live `pi install` + real-model run remains deliberately out of scope (the kit is
 * hardened offline by design); CI runs this across every profile as the matrix.
 *
 * Usage:
 *   node packages/core/profile-check.mjs --profile <name>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProfile } from "./lib/resolve.mjs";
import { mergePackageBlock, readSettings } from "./lib/settings.mjs";
import { loadExtension, fakePi } from "./eval/harness.mjs";
import { WORKSPACE_ROOT, DOCS_DIR, PROFILES_DIR, FIRST_PARTY_DIR, THIRD_PARTY_DIR, SKILLS_DIR, PROMPTS_DIR, THEMES_DIR, SCHEMA_DIR, POLICIES_DIR, SOURCES_PATH, CORE_DIR, ENV_EXAMPLE, extensionRelPath } from "./lib/paths.mjs";

const ROOT = WORKSPACE_ROOT;
const args = process.argv.slice(2);
const get = (flag) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : null);
const profileName = get("--profile");

let errors = 0;
const fail = (m) => {
  console.error(`  FAIL: ${m}`);
  errors++;
};

// Manifest index, kept for the stub/experimental + load-ordering checks.
const manifests = new Map();
for (const dir of [FIRST_PARTY_DIR, THIRD_PARTY_DIR]) {
  if (!fs.existsSync(dir)) continue;
  for (const n of fs.readdirSync(dir)) {
    if (n.startsWith("_")) continue;
    const mp = path.join(dir, n, "extension.json");
    if (fs.existsSync(mp)) manifests.set(n, JSON.parse(fs.readFileSync(mp, "utf8")));
  }
}

function withCwd(cwd, fn) {
  const previous = process.cwd();
  process.chdir(cwd);
  return Promise.resolve(fn()).finally(() => process.chdir(previous));
}

function checkStubsAndOrdering(includes, label, isExperimental) {
  for (const name of includes) {
    const meta = manifests.get(name);
    if (meta && !isExperimental && (meta.status === "stub" || meta.status === "experimental")) {
      fail(`${label}: non-experimental loadout includes ${meta.status} extension '${name}'`);
    }
  }
  const fw = includes.indexOf("tool-firewall");
  const gov = includes.indexOf("pentest-governance-domain");
  if (fw >= 0 && gov >= 0 && fw > gov) {
    fail(`${label}: tool-firewall must load before pentest-governance-domain`);
  }
}

// Step 1 ("install"): resolve every name and replay the real settings.json narrowing.
// Returns the resolved resource list, or null if resolution itself failed.
function checkInstallNarrowing(includes, label) {
  let resolved;
  try {
    resolved = resolveProfile(includes);
  } catch (error) {
    fail(`${label}: ${error.message}`);
    return null;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-check-"));
  const settingsPath = path.join(dir, "settings.json");
  try {
    fs.writeFileSync(settingsPath, JSON.stringify({ packages: [ROOT] }));
    mergePackageBlock(settingsPath, ROOT, resolved);
    const filter = readSettings(settingsPath).packages[0].extensions;

    const expected = resolved
      .filter((r) => r.avenue !== "external")
      .map((r) => extensionRelPath(r.name, r.avenue));
    const matches = filter.length === expected.length && expected.every((p) => filter.includes(p));
    if (!matches) {
      fail(`${label}: install-time filter [${filter.join(", ")}] does not match the resolved profile set [${expected.join(", ")}]`);
    }

    const allInRepoCount =
      fs.readdirSync(path.join(FIRST_PARTY_DIR)).filter((n) => !n.startsWith("_")).length +
      fs.readdirSync(path.join(THIRD_PARTY_DIR)).length;
    if (filter.length >= allInRepoCount) {
      fail(`${label}: install-time filter (${filter.length}) is not narrower than the full extension set (${allInRepoCount}) — profile scoping is not real`);
    } else {
      console.log(`  install: ${filter.length}/${allInRepoCount} in-repo extensions selected, ${resolved.length - expected.length} external`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return resolved;
}

// Step 2 ("load", stands in for "verify" offline): every resolved in-repo/vendor
// extension actually transpiles, imports, and registers against a fake pi API.
async function checkLoad(resolved, label) {
  const inRepo = resolved.filter((r) => r.avenue !== "external");
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-load-"));
  let loaded = 0;
  try {
    await withCwd(workspace, async () => {
      for (const r of inRepo) {
        const relativePath = extensionRelPath(r.name, r.avenue);
        try {
          const register = await loadExtension(relativePath);
          const pi = fakePi();
          register(pi.api);
          const sessionStart = pi.handlers.get("session_start");
          if (sessionStart) {
            await sessionStart({}, { hasUI: false, cwd: workspace, ui: { notify() {}, setStatus() {} }, sessionManager: { getEntries: () => [] } });
          }
          loaded++;
        } catch (error) {
          fail(`${label}: '${r.name}' failed to load/register: ${error?.stack || error?.message || error}`);
        }
      }
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
  console.log(`  load: ${loaded}/${inRepo.length} in-repo extensions registered cleanly`);
}

async function checkProfile(name) {
  console.log(`[profile-check] profile: ${name}`);
  const p = path.join(PROFILES_DIR, `${name}.json`);
  if (!fs.existsSync(p)) {
    fail(`profile ${name} not found`);
    return;
  }
  const def = JSON.parse(fs.readFileSync(p, "utf8"));
  const includes = def.include ?? [];
  if (includes.length === 0) {
    fail(`profile ${name} has no includes`);
    return;
  }
  checkStubsAndOrdering(includes, `profile ${name}`, !!def.experimental);
  const resolved = checkInstallNarrowing(includes, `profile ${name}`);
  if (resolved) await checkLoad(resolved, `profile ${name}`);
}

async function main() {
  if (profileName) {
    await checkProfile(profileName);
  } else {
    fail("specify --profile <name>");
  }
}

await main();

if (errors > 0) {
  console.error(`[profile-check] FAILED with ${errors} error(s)`);
  process.exit(1);
}
console.log("[profile-check] OK");
