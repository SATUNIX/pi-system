#!/usr/bin/env node
/**
 * Verification gate. Runs on every push and before install.
 * Checks: schema validation, tsc --noEmit, self-containment lint,
 *         name-collision check, sources/manifest bundle cross-check.
 */
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { capabilityMatrixContent } from "./capability-matrix.mjs";
import { extensionsCatalogueDrift } from "./registry.mjs";
import { noticesContent } from "./gen-notices.mjs";
import { checkDocsNav } from "./docs-nav-check.mjs";
import { skillsCatalogueContent } from "./skills-catalogue.mjs";
import { WORKSPACE_ROOT, PROFILES_DIR, FIRST_PARTY_DIR, THIRD_PARTY_DIR, SKILLS_DIR, SCHEMA_DIR, POLICIES_DIR, SOURCES_PATH, CORE_DIR } from "./lib/paths.mjs";

const require = createRequire(import.meta.url);
const ROOT = WORKSPACE_ROOT;
const SCHEMA_PATH = path.join(SCHEMA_DIR, "extension.schema.json");
let Ajv;
try {
  Ajv = require("ajv");
} catch {
  console.error("[verify] ajv not found — run: npm install --save-dev ajv");
  process.exit(1);
}

const ajv = new Ajv.default({ strict: false });

// Read + parse a JSON file. Wraps both the read and the parse so a corrupt or
// missing file yields a clear, labelled error instead of an opaque SyntaxError.
function readJsonFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const schema = readJsonFile(SCHEMA_PATH);
const validate = ajv.compile(schema);

let errors = 0;

function fail(msg) {
  console.error(`  FAIL: ${msg}`);
  errors++;
}

// Extension avenues: packages/extensions/{src,third_party}.
const EXT_AVENUES = [
  { dir: FIRST_PARTY_DIR, avenue: "first-party" },
  { dir: THIRD_PARTY_DIR, avenue: "third-party" },
];
const extensionEntryPath = (name) => {
  for (const { dir } of EXT_AVENUES) {
    const candidate = path.join(dir, name, "index.ts");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
};

// Recursively collect `.ts` files under an extension dir as paths relative to
// extDir (e.g. "sub/bad.ts"), sorted for stable messages. Descends into every
// directory; non-.ts files are skipped.
function collectTsFiles(extDir) {
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryRel = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), entryRel);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push(entryRel);
      }
    }
  };
  walk(extDir, "");
  return out.sort();
}

const seenNames = new Map();

for (const { dir, avenue } of EXT_AVENUES) {
  if (!fs.existsSync(dir)) continue;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith("_")) continue;
    const extDir = path.join(dir, name);
    if (!fs.statSync(extDir).isDirectory()) continue;

    console.log(`\n[verify] ${avenue}/${name}`);

    // 1. extension.json exists and validates
    const metaPath = path.join(extDir, "extension.json");
    if (!fs.existsSync(metaPath)) {
      fail(`extension.json missing`);
      continue;
    }
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch (e) {
      fail(`extension.json parse error: ${e.message}`);
      continue;
    }
    if (!validate(meta)) {
      fail(`extension.json schema invalid: ${ajv.errorsText(validate.errors)}`);
      // A non-object manifest (e.g. literal `null`) makes every later deref
      // (meta.name, meta.hooks, ...) throw a TypeError that would abort the
      // whole gate and hide later checks. Report and move on instead.
      continue;
    }

    // 2. Name collision
    if (seenNames.has(meta.name)) {
      fail(`name collision: "${meta.name}" also in ${seenNames.get(meta.name)}`);
    } else {
      seenNames.set(meta.name, `${avenue}/${name}`);
    }

    // 3. Entry exists
    const entryPath = path.join(extDir, meta.entry || "index.ts");
    if (!fs.existsSync(entryPath)) {
      fail(`entry file missing: ${meta.entry}`);
      continue;
    }

    // 4. Self-containment lint: scan ALL .ts files in the extension dir.
    //    No import/export may reference a path that resolves outside the extension dir.
    //    No import of the toolchain lib (packages/core/lib).
    const tsFiles = collectTsFiles(extDir);
    const registeredHooks = new Set();
    for (const tsFile of tsFiles) {
      const src = fs.readFileSync(path.join(extDir, tsFile), "utf8");
      const importLines = src.split("\n").filter(l => /^\s*(import|export)\b/.test(l));
      for (const line of importLines) {
        const m = line.match(/from\s+["']([^"']+)["']/);
        if (!m) continue;
        const imp = m[1];
        // All relative imports must stay inside the extension dir
        if (imp.startsWith("./") || imp.startsWith("../")) {
          const resolved = path.resolve(path.dirname(path.join(extDir, tsFile)), imp);
          if (!resolved.startsWith(extDir + path.sep) && resolved !== extDir) {
            fail(`self-containment violation in ${tsFile}: imports outside extension dir: ${imp}`);
          }
        }
        // packages/core/lib is toolchain-only — never runtime
        if (imp.includes("packages/core/lib") || imp.includes("packages\\core\\lib") || imp.includes("kit/lib") || imp.includes("kit\\lib")) {
          fail(`self-containment violation in ${tsFile}: imports the toolchain lib (toolchain-only): ${imp}`);
        }
      }
      // Collect every pi.on("<event>", ...) registration for the hooks-drift check below.
      const hookRe = /pi\.on\(\s*["']([a-zA-Z_]+)["']/g;
      let hookMatch = hookRe.exec(src);
      while (hookMatch) {
        registeredHooks.add(hookMatch[1]);
        hookMatch = hookRe.exec(src);
      }
    }

    // 4b. Hooks manifest drift: every pi.on(...) event actually registered in code
    //     must be declared in extension.json's hooks[] array. One-directional
    //     (code -> manifest) since under-declaration (not over-declaration) is the
    //     observed failure mode — a stale hooks[] silently hides what an extension
    //     really reacts to from anyone reading the manifest.
    const declaredHooks = new Set(meta.hooks ?? []);
    for (const hook of registeredHooks) {
      if (!declaredHooks.has(hook)) {
        fail(`hooks manifest drift: ${avenue}/${name} registers pi.on("${hook}", ...) but extension.json hooks[] does not declare "${hook}"`);
      }
    }

    // 5b. system-prompt injection monopoly lint
    // Only extensions/context-sieve/index.ts may return { systemPrompt } from before_agent_start:
    // several extensions each rewriting the whole prompt fight over it. The one exception is the
    // effort extension, whose contribution must reach EVERY profile (context-sieve is not in
    // `quick`) and must apply at the user-turn boundary; it may only return the prompt through
    // withEffortBlock(), which replaces its own marked block and so can never duplicate or
    // clobber anything else.
    const ctxSieveEntry = extensionEntryPath("context-sieve");
    for (const tsFile of tsFiles) {
      const fullPath = path.join(extDir, tsFile);
      if (ctxSieveEntry && fullPath === ctxSieveEntry) continue;
      const src = fs.readFileSync(fullPath, "utf8");
      if (/return\s*\{\s*systemPrompt/.test(src)) {
        if (meta.name === "effort" && /return\s*\{\s*systemPrompt:\s*withEffortBlock\(/.test(src)) continue;
        fail(`self-injection violation in ${avenue}/${name}/${tsFile}: only context-sieve may return { systemPrompt } from before_agent_start (effort may, via withEffortBlock only)`);
      }
    }

    console.log(`  OK: ${meta.name} (${meta.status})`);
  }
}

// 5. tsc --noEmit
console.log("\n[verify] tsc --noEmit");
try {
  execSync("npx tsc --noEmit", { cwd: ROOT, stdio: "inherit" });
  console.log("  OK: type check passed");
} catch {
  console.error("  FAIL: type check failed");
  errors++;
}

// 6. sources.json validates
const sourcesPath = SOURCES_PATH;
let sources;
if (fs.existsSync(sourcesPath)) {
  console.log("\n[verify] sources.json");
  const sourcesSchema = readJsonFile(path.join(SCHEMA_DIR, "sources.schema.json"));
  const validateSources = ajv.compile(sourcesSchema);
  sources = readJsonFile(sourcesPath);
  if (validateSources(sources)) {
    console.log("  OK: sources.json valid");
  } else {
    fail(`sources.json schema invalid: ${ajv.errorsText(validateSources.errors)}`);
  }

  // 7. Bundle/sources cross-check: every bundle-mode entry in sources.json
  //    must also appear in package.json dependencies + bundledDependencies.
  console.log("\n[verify] bundle/sources cross-check");
  const pkgPath = path.join(ROOT, "package.json");
  const pkg = readJsonFile(pkgPath);
  const deps = Object.keys(pkg.dependencies ?? {});
  const bundled = pkg.bundledDependencies ?? [];

  const bundleEntries = (sources.external ?? []).filter(e => e.mode === "bundle");
  if (bundleEntries.length === 0) {
    console.log("  OK: no bundle-mode entries (nothing to cross-check)");
  } else {
    for (const entry of bundleEntries) {
      if (!deps.includes(entry.name)) {
        fail(`bundle-mode source "${entry.name}" missing from package.json dependencies`);
      }
      if (!bundled.includes(entry.name)) {
        fail(`bundle-mode source "${entry.name}" missing from package.json bundledDependencies`);
      }
    }
    if (errors === 0) console.log(`  OK: ${bundleEntries.length} bundle entry/entries match package.json`);
  }
}

// 8. Trust guards (Epic 1 Sprint 1.3): profile/manifest cross-validation +
//    stub/TODO quarantine.
{

  // Load profiles and classify experimental vs non-experimental.
  const profilesDir = path.join(PROFILES_DIR);
  const profiles = {};
  for (const f of fs.readdirSync(profilesDir)) {
    if (!f.endsWith(".json")) continue;
    profiles[f.replace(/\.json$/, "")] = readJsonFile(path.join(profilesDir, f));
  }
  const nonExperimentalProfiles = new Set(
    Object.entries(profiles).filter(([, p]) => !p.experimental).map(([name]) => name),
  );

  // Actual membership per extension name (which profiles' include lists reference it).
  const membership = new Map(); // name -> Set(profileName)
  for (const [pname, pdef] of Object.entries(profiles)) {
    for (const ext of pdef.include ?? []) {
      if (!membership.has(ext)) membership.set(ext, new Set());
      membership.get(ext).add(pname);
    }
  }


  // Manifests (in-repo + vendor) keyed by extension name.
  const manifests = new Map(); // name -> { meta, dir, tsFiles }
  for (const { dir, avenue } of EXT_AVENUES) {
    if (!fs.existsSync(dir)) continue;
    for (const n of fs.readdirSync(dir)) {
      if (n.startsWith("_")) continue;
      const extDir = path.join(dir, n);
      const mp = path.join(extDir, "extension.json");
      if (!fs.existsSync(mp)) continue;
      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(mp, "utf8"));
      } catch {
        continue; // already reported by the schema pass above
      }
      if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
        continue; // non-object manifest already reported by the schema pass above
      }
      const tsFiles = collectTsFiles(extDir);
      manifests.set(meta.name, { meta, dir: `${avenue}/${n}`, extDir, tsFiles });
    }
  }

  // External names declared in sources.json (legitimately manifest-less).
  const externalNames = new Set();
  if (sources) {
    for (const e of sources.external ?? []) {
      for (const name of e.provides ?? [e.name]) externalNames.add(name);
    }
  }

  // 8a. Profile <-> manifest bidirectional cross-validation.
  console.log("\n[verify] profile/manifest cross-check");
  // Forward: every non-external name referenced in a profile must have a manifest.
  for (const [name, inProfiles] of membership) {
    if (!manifests.has(name) && !externalNames.has(name)) {
      fail(`profile include "${name}" (in ${[...inProfiles].join(", ")}) has no extension.json and no sources.json entry`);
    }
  }
  // Bidirectional: declared profiles must exactly equal actual membership.
  for (const [name, { meta }] of manifests) {
    const declared = [...new Set(meta.profiles ?? [])].sort();
    const actual = [...(membership.get(name) ?? new Set())].sort();
    if (declared.join(",") !== actual.join(",")) {
      fail(
        `profile metadata drift for "${name}": extension.json profiles [${declared.join(", ")}] != profiles/*.json membership [${actual.join(", ")}]`,
      );
    }
    // A real (stable/beta) extension must ship in at least one profile.
    if ((meta.status === "stable" || meta.status === "beta") && actual.length === 0) {
      fail(`orphaned extension "${name}": status ${meta.status} but shipped in no profile`);
    }
  }
  if (errors === 0) console.log(`  OK: ${manifests.size} manifests consistent with profiles/*.json`);

  // 8a2. External source profile metadata must exactly match actual membership.
  console.log("\n[verify] external source/profile cross-check");
  const externalProfileErrors = errors;
  for (const entry of sources?.external ?? []) {
    const declared = [...new Set(entry.profiles ?? [])].sort();
    for (const name of entry.provides ?? [entry.name]) {
      const actual = [...(membership.get(name) ?? new Set())].sort();
      if (declared.join(",") !== actual.join(",")) {
        fail(
          `external source profile drift for "${name}" (source "${entry.name}"): sources.json profiles [${declared.join(", ")}] != profiles/*.json membership [${actual.join(", ")}]`,
        );
      }
    }
  }
  if (errors === externalProfileErrors) console.log("  OK: external source profiles consistent with profiles/*.json");

  // 8b. Stub/TODO quarantine: nothing shipped in a non-experimental profile or the
  //     may be a stub/experimental or emit "(stub)"/": TODO" strings.
  console.log("\n[verify] stub/TODO quarantine");
  let stubViolations = 0;
  for (const [name, { meta, dir, extDir, tsFiles }] of manifests) {
    const nonExpMembership = [...(membership.get(name) ?? new Set())].filter((p) =>
      nonExperimentalProfiles.has(p),
    );
    const shippedNonExperimentally = nonExpMembership.length > 0;
    if (!shippedNonExperimentally) continue;

    if (meta.status === "stub" || meta.status === "experimental") {
      fail(
        `stub/experimental extension "${name}" (status ${meta.status}) ships in non-experimental context [${nonExpMembership.join(", ")}]`,
      );
      stubViolations++;
    }
    for (const tsFile of tsFiles) {
      const src = fs.readFileSync(path.join(extDir, tsFile), "utf8");
      if (/\(stub\)/.test(src) || /:\s*TODO/.test(src)) {
        fail(`stub marker in ${dir}/${tsFile}: "(stub)"/": TODO" but extension ships in a non-experimental context`);
        stubViolations++;
      }
    }
  }
  if (stubViolations === 0) console.log("  OK: no stub/TODO extensions in any non-experimental profile");

  // 8c. Firewall starter policy: embedded copy must equal the canonical packages/core/policies mirror,
  //     and must default-deny unknown tools (never allow-all). (Epic 2 Sprint 2.1.)
  console.log("\n[verify] tool-firewall starter policy");
  const embeddedPolicyPath = path.join(FIRST_PARTY_DIR, "tool-firewall", "default-policy.json");
  const canonicalPolicyPath = path.join(POLICIES_DIR, "default.json");
  if (fs.existsSync(embeddedPolicyPath)) {
    if (fs.existsSync(canonicalPolicyPath)) {
      const embeddedRaw = fs.readFileSync(embeddedPolicyPath, "utf8");
      const canonicalRaw = fs.readFileSync(canonicalPolicyPath, "utf8");
      if (embeddedRaw !== canonicalRaw) {
        fail("tool-firewall/default-policy.json and packages/core/policies/default.json have diverged (must be byte-identical)");
      }
      let policy;
      try {
        policy = JSON.parse(embeddedRaw);
      } catch (error) {
        fail(`default-policy.json parse error: ${error.message}`);
        policy = null;
      }
      if (policy) {
        if (policy.defaults?.unknown === "allow") {
          fail("firewall starter policy defaults.unknown must not be 'allow' (default-deny requirement)");
        }
        // v2: shell commands are classified by the firewall's analyser (covered by
        // tests/firewall-shell-smoke.mjs); the regex deny list is the strict pentest policy's.
        const strict = policy.policies?.pentest?.command_rules ?? {};
        const denyCount = (policy.command_rules?.deny?.length || 0) + (strict.deny?.length || 0);
        if (denyCount === 0) fail("firewall starter policy has zero deny command_rules (operator + pentest)");
        if (errors === 0) console.log(`  OK: policy default unknown=${policy.defaults?.unknown}, pentest policy ${strict.deny?.length || 0} deny + ${strict.ask?.length || 0} ask rules, ${policy.command_rules?.deny?.length || 0} operator deny rules`);
      }
    } else {
      fail("packages/core/policies/default.json missing (canonical starter policy mirror)");
    }
  } else {
    fail("tool-firewall/default-policy.json missing (shipped starter policy)");
  }

  // 8d. Security pattern parity (Epic 2 Sprint 2.2 cross-link): the firewall's strict pentest
  //     policy must be at least as strict as pentest-governance-domain. Firewall pentest
  //     deny patterns >= pentest DESTRUCTIVE_COMMANDS; secret-guard PROTECTED_PATTERNS >=
  //     pentest PROTECTED_PATTERNS. (Coding policies classify shell commands structurally;
  //     tests/firewall-shell-smoke.mjs pins that each destructive class is still caught.)
  console.log("\n[verify] security pattern parity");
  const pentestSrcPath = path.join(FIRST_PARTY_DIR, "pentest-governance-domain", "index.ts");
  const secretGuardSrcPath = path.join(FIRST_PARTY_DIR, "secret-guard", "index.ts");
  if (fs.existsSync(pentestSrcPath) && fs.existsSync(secretGuardSrcPath) && fs.existsSync(embeddedPolicyPath)) {
    const pentestSrc = fs.readFileSync(pentestSrcPath, "utf8");
    const secretGuardSrc = fs.readFileSync(secretGuardSrcPath, "utf8");

    const extractArrayBlock = (src, varName) => {
      const start = src.indexOf(`const ${varName}`);
      if (start < 0) return "";
      const open = src.indexOf("[", start);
      const close = src.indexOf("];", open);
      return open >= 0 && close >= 0 ? src.slice(open + 1, close) : "";
    };
    const regexSources = (block) => {
      const out = [];
      const re = /\/((?:\\.|[^/\n])+)\/[gimsuy]*/g;
      let m = re.exec(block);
      while (m) {
        out.push(m[1]);
        m = re.exec(block);
      }
      return out;
    };
    const stringLiterals = (block) => {
      const out = [];
      const re = /"((?:\\.|[^"\\])*)"/g;
      let m = re.exec(block);
      while (m) {
        out.push(m[1].replace(/\\"/g, '"'));
        m = re.exec(block);
      }
      return out;
    };

    // Destructive-command parity: firewall deny >= pentest DESTRUCTIVE_COMMANDS.
    const pentestDestructive = regexSources(extractArrayBlock(pentestSrc, "DESTRUCTIVE_COMMANDS"));
    const policy = readJsonFile(embeddedPolicyPath);
    const firewallDeny = new Set([...(policy.command_rules?.deny || []), ...(policy.policies?.pentest?.command_rules?.deny || [])].map(r => r.pattern));
    const missingDestructive = pentestDestructive.filter(p => !firewallDeny.has(p));
    if (pentestDestructive.length === 0) {
      fail("could not extract DESTRUCTIVE_COMMANDS from pentest-governance-domain (parity check broken)");
    } else if (missingDestructive.length) {
      fail(`firewall starter policy is missing pentest DESTRUCTIVE_COMMANDS patterns: ${missingDestructive.join(" | ")}`);
    }

    // Protected-path parity: secret-guard PROTECTED_PATTERNS >= pentest PROTECTED_PATTERNS.
    const pentestProtected = stringLiterals(extractArrayBlock(pentestSrc, "PROTECTED_PATTERNS"));
    const secretGuardProtected = new Set(stringLiterals(extractArrayBlock(secretGuardSrc, "PROTECTED_PATTERNS")));
    const missingProtected = pentestProtected.filter(p => !secretGuardProtected.has(p));
    if (pentestProtected.length === 0) {
      fail("could not extract PROTECTED_PATTERNS from pentest-governance-domain (parity check broken)");
    } else if (missingProtected.length) {
      fail(`secret-guard PROTECTED_PATTERNS is missing pentest patterns: ${missingProtected.join(" | ")}`);
    }

    if (errors === 0) {
      console.log(`  OK: firewall covers ${pentestDestructive.length} destructive patterns; secret-guard covers ${pentestProtected.length} protected patterns`);
    }
  } else {
    console.log("  SKIP: parity sources not all present");
  }

  // 8e. Skills catalogue drift + skills frontmatter lint (Epic 3 Sprint 3.1).
  console.log("\n[verify] skills catalogue");
  const skillsCatalogueScript = path.join(CORE_DIR, "skills-catalogue.mjs");
  if (fs.existsSync(skillsCatalogueScript)) {
    // Kept in parity with packages/core/skills-catalogue.mjs's CATEGORY_ORDER by hand (duplicated,
    // not imported - importing that script would run its top-level doc-generation code
    // as a side effect). M-06 fix: previously only checked that "category:" was present
    // and non-empty, not that its VALUE was one of the recognized categories - a typo
    // silently filed the skill nowhere in the generated catalogue instead of failing loud.
    const KNOWN_SKILL_CATEGORIES = new Set([
      "coding-workflow", "efficiency", "context-and-small-models", "memory", "orchestration-recovery",
      "mcp-governance", "pentest", "evidence-reporting", "documentation", "maintainer", "uncategorised",
    ]);
    // Frontmatter lint: every SKILL.md must have name + description + a recognized category.
    const skillsDir = path.join(SKILLS_DIR);
    if (fs.existsSync(skillsDir)) {
      for (const name of fs.readdirSync(skillsDir)) {
        const mp = path.join(skillsDir, name, "SKILL.md");
        if (!fs.existsSync(mp)) continue;
        const text = fs.readFileSync(mp, "utf8");
        const fmEnd = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
        const fm = fmEnd > 0 ? text.slice(3, fmEnd) : "";
        for (const key of ["name", "description", "category"]) {
          if (!new RegExp(`\\n?${key}:\\s*\\S`).test(fm)) {
            fail(`skill ${name}/SKILL.md frontmatter missing "${key}:"`);
          }
        }
        const categoryMatch = fm.match(/\n?category:\s*(\S+)/);
        if (categoryMatch && !KNOWN_SKILL_CATEGORIES.has(categoryMatch[1])) {
          fail(`skill ${name}/SKILL.md has unrecognized category "${categoryMatch[1]}" — must be one of: ${[...KNOWN_SKILL_CATEGORIES].join(", ")}`);
        }
        // Trigger-shape lint: descriptions must be "what + when" (kit standard, see
        // docs/WRITING_EXTENSIONS.md "Writing skills"), not a bare purpose
        // statement — otherwise the model has nothing to match against for discovery.
        const descriptionMatch = fm.match(/\n?description:\s*(.+)/);
        if (descriptionMatch && !/\buse\b/i.test(descriptionMatch[1])) {
          fail(`skill ${name}/SKILL.md description lacks a "Use ..." trigger clause (kit standard: "what + when", see docs/WRITING_EXTENSIONS.md "Writing skills")`);
        }
      }
    }
    // Drift: committed doc must match a fresh regen.
    try {
      const current = fs.existsSync(path.join(ROOT, "docs", "skills-catalogue.md")) ? fs.readFileSync(path.join(ROOT, "docs", "skills-catalogue.md"), "utf8") : "";
      if (current !== skillsCatalogueContent()) throw new Error("skills catalogue is stale");
      if (errors === 0) console.log("  OK: docs/skills-catalogue.md matches frontmatter; all skills have name/description/category");
    } catch (error) {
      fail(`docs/skills-catalogue.md is stale — run 'npm run catalog' (${String(error.stdout || error.message).trim().split(/\r?\n/).slice(-2).join(" ")})`);
    }
  }

  // 8f. Capability matrix drift (Epic 3 Sprint 3.3).
  console.log("\n[verify] capability matrix");
  const capMatrixScript = path.join(CORE_DIR, "capability-matrix.mjs");
  if (fs.existsSync(capMatrixScript)) {
    try {
      const current = fs.existsSync(path.join(ROOT, "docs", "capability-matrix.md")) ? fs.readFileSync(path.join(ROOT, "docs", "capability-matrix.md"), "utf8") : "";
      if (current !== capabilityMatrixContent()) throw new Error("capability matrix is stale");
      console.log("  OK: docs/capability-matrix.md matches profiles/manifests");
    } catch {
      fail("docs/capability-matrix.md is stale — run 'npm run catalog'");
    }
  }

  // 8f-ter. Extensions catalogue drift (B-098): registry.mjs --write-docs output was
  // the only generated doc without a drift gate, so a hand-edited summary passed CI.
  console.log("\n[verify] extensions catalogue");
  const current = fs.existsSync(path.join(ROOT, "docs", "EXTENSIONS.md")) ? fs.readFileSync(path.join(ROOT, "docs", "EXTENSIONS.md"), "utf8") : "";
  const catalogueDrift = extensionsCatalogueDrift(current);
  if (catalogueDrift.error) {
    fail(`extensions catalogue check failed: ${catalogueDrift.error}`);
  } else if (catalogueDrift.stale) {
    fail("docs/EXTENSIONS.md is stale — run 'npm run catalog'");
  } else {
    console.log("  OK: docs/EXTENSIONS.md matches packages/core/registry.mjs");
  }

  // 8f-bis. Third-party notices drift (npm distribution Phase 1b).
  console.log("\n[verify] third-party notices");
  try {
    const noticesPath = path.join(ROOT, "THIRD_PARTY_NOTICES.md");
    const current = fs.existsSync(noticesPath) ? fs.readFileSync(noticesPath, "utf8") : "";
    if (current !== noticesContent()) throw new Error("third-party notices are stale");
    console.log("  OK: THIRD_PARTY_NOTICES.md matches third_party/*/SOURCE.md");
  } catch {
    fail("THIRD_PARTY_NOTICES.md is stale — run 'node packages/core/gen-notices.mjs'");
  }

  // 8g. Docs nav + internal links (offline stand-in for `mkdocs build --strict`).
  console.log("\n[verify] docs nav + links");
  const docsNavScript = path.join(CORE_DIR, "docs-nav-check.mjs");
  if (fs.existsSync(docsNavScript)) {
    try {
      if (!checkDocsNav()) throw new Error("docs nav/link check failed");
      console.log("  OK: mkdocs nav entries exist and internal doc links resolve");
    } catch (error) {
      const out = String(error.stdout || error.message).trim().split(/\r?\n/).filter(l => /FAIL/.test(l));
      fail(`docs nav/link check failed: ${out.join("; ") || "see node packages/core/docs-nav-check.mjs"}`);
    }
  }

  // 8h. Conductor agent-synth template contract (Phase 2).
  console.log("\n[verify] agent-synth output contract");
  const agentSynthPath = path.join(FIRST_PARTY_DIR, "conductor", "synth", "agent-synth.ts");
  if (fs.existsSync(agentSynthPath)) {
    const agentSynthSource = fs.readFileSync(agentSynthPath, "utf8");
    if (!agentSynthSource.includes("\n## Scope\n")) fail('agent-synth markdown template is missing its scope marker');
    if (!agentSynthSource.includes("\ntools: ${tools}\n")) fail("agent-synth markdown template is missing its tools marker");
    if (errors === 0) console.log("  OK: agent-synth template declares scope and tools markers");
  } else {
    fail("extensions/conductor/synth/agent-synth.ts is missing");
  }

  // 8i. Conductor validator least-privilege contract (Phase 3).
  console.log("\n[verify] validator role least-privilege contract");
  const validatorPath = path.join(FIRST_PARTY_DIR, "conductor", "agents", "validator.md");
  if (fs.existsSync(validatorPath)) {
    const validator = fs.readFileSync(validatorPath, "utf8");
    const tools = validator.match(/^tools:\s*(.*)$/m)?.[1] ?? "";
    if (/(^|,\s*)(write|edit|bash)(,|$)/.test(tools)) fail("validator.md tools frontmatter must not grant write, edit, or bash");
    else if (tools !== "read, grep, find, ls") fail("validator.md must declare exactly read, grep, find, ls tools");
    else if (errors === 0) console.log("  OK: validator role is limited to read, grep, find, ls");
  } else {
    fail("extensions/conductor/agents/validator.md is missing");
  }
}

if (errors > 0) {
  console.error(`\n[verify] FAILED with ${errors} error(s)`);
  process.exit(1);
} else {
  console.log("\n[verify] All checks passed.");
}
