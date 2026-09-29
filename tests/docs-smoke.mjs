#!/usr/bin/env node
// Docs accuracy smoke (Epic 7 Sprint 7.1): extract fenced code blocks from the onboarding
// docs, validate every documented command references a real script / profile / file, and
// actually resolve the documented default profile. Deterministic; needs no pi/docker/network.
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readmeBadgeVersion, setReadmeBadgeVersion } from "../packages/core/lib/version-badge.mjs";
import { skillsCatalogueContent } from "../packages/core/skills-catalogue.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = ["README.md", "docs/getting-started.md", "docs/INSTALL.md", "packages/core/helpers/README.md"];

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const npmScripts = new Set(Object.keys(pkg.scripts ?? {}));

function fencedCommands(md) {
  const lines = [];
  let inFence = false;
  for (const raw of md.split(/\r?\n/)) {
    if (/^```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const line = raw.replace(/\s+#.*$/, "").replace(/^#.*$/, "").trim();
    if (line) lines.push(line);
  }
  return lines;
}

// Inline markdown links that live in fenced code blocks are examples, not links.
function stripFences(md) {
  const out = [];
  let inFence = false;
  for (const raw of md.split(/\r?\n/)) {
    if (/^```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(raw);
  }
  return out.join("\n");
}

let checked = 0;
const skipped = [];

for (const rel of DOCS) {
  const md = fs.readFileSync(path.join(ROOT, rel), "utf8");
  for (const cmd of fencedCommands(md)) {
    const tokens = cmd.split(/\s+/);
    // Node resolves the installer path against the current working directory, so
    // `node pi-system/...` only works from the clone's parent and breaks from inside the clone.
    assert.ok(
      !(tokens[0] === "node" && tokens[1]?.startsWith("pi-system/")),
      `${rel}: '${cmd}' only resolves from the clone's parent; use the clone root ('cd pi-system' then 'node packages/core/install.mjs ...')`,
    );
    const [bin, arg1] = tokens;

    // node packages/core/<script>.mjs ... -> script must exist; --profile arg must be real.
    if (bin === "node" && /^packages\/core\/.+\.mjs$/.test(arg1 || "")) {
      assert.ok(fs.existsSync(path.join(ROOT, arg1)), `${rel}: documented script missing: ${arg1}`);
      const pIdx = tokens.indexOf("--profile");
      if (pIdx >= 0 && tokens[pIdx + 1]) {
        assert.ok(fs.existsSync(path.join(ROOT, "packages", "kit", "profiles", `${tokens[pIdx + 1]}.json`)), `${rel}: --profile ${tokens[pIdx + 1]} has no profiles/*.json`);
      }
      checked++;
      continue;
    }

    // npm run <script> -> must exist in package.json.
    if (bin === "npm" && arg1 === "run" && tokens[2]) {
      assert.ok(npmScripts.has(tokens[2]), `${rel}: 'npm run ${tokens[2]}' not in package.json scripts`);
      checked++;
      continue;
    }

    // docker compose -f <file> ... -> compose file must exist.
    if (bin === "docker" && tokens.includes("-f")) {
      const f = tokens[tokens.indexOf("-f") + 1];
      assert.ok(fs.existsSync(path.join(ROOT, f)), `${rel}: docker compose file missing: ${f}`);
      checked++;
      continue;
    }

    // npx @satunix/pi-system --profile <name> -> the package's own installer; profile must be real.
    if (bin === "npx" && arg1 === pkg.name) {
      const pIdx = tokens.indexOf("--profile");
      if (pIdx >= 0 && tokens[pIdx + 1]) {
        assert.ok(fs.existsSync(path.join(ROOT, "packages", "kit", "profiles", `${tokens[pIdx + 1]}.json`)), `${rel}: --profile ${tokens[pIdx + 1]} has no profiles/*.json`);
      }
      checked++;
      continue;
    }

    // External / environment lines we can't run on a clean clone (pi, global npm, env=).
    if (bin === "pi" || (bin === "npm" && tokens.includes("-g")) || /=/.test(bin) || bin === "MEM0_API_URL") {
      skipped.push(cmd);
      continue;
    }

    skipped.push(cmd);
  }
}

// Relative-link existence check: every inline markdown link in a DOCS file must resolve on
// disk. External URLs, scheme-relative URLs, mailto: and bare #anchors are skipped.
let linksChecked = 0;
for (const rel of DOCS) {
  const md = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const dir = path.dirname(path.join(ROOT, rel));
  for (const m of stripFences(md).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const rawTarget = m[1].trim().split(/\s+/)[0];
    if (!rawTarget) continue;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(rawTarget)) continue; // absolute/external URL
    if (rawTarget.startsWith("#")) continue; // in-page anchor
    const target = rawTarget.split("#")[0];
    if (!target) continue;
    const resolved = path.resolve(dir, target);
    assert.ok(
      fs.existsSync(resolved),
      `${rel}: broken relative link '${rawTarget}' (resolved to ${path.relative(ROOT, resolved)})`,
    );
    linksChecked++;
  }
}

// Actually run the safe offline subset documented in the onboarding path.
execSync("node packages/core/profile-check.mjs --profile balanced", { cwd: ROOT, stdio: "pipe" });

// Secret-guard ships experimental/opt-in (empty `profiles`, `enabledByDefault: false`):
// no profile `include` lists it. Keep the docs honest about that — the security table
// must not claim it is in "every profile", and no profile description may name an
// extension its own include list lacks.
const securityMd = fs.readFileSync(path.join(ROOT, "docs", "security.md"), "utf8");
for (const line of securityMd.split(/\r?\n/)) {
  if (!line.includes("secret-guard")) continue;
  assert.ok(
    !/every profile/i.test(line),
    "docs/security.md must not claim secret-guard ships in every profile (it is opt-in/experimental)",
  );
}

const extensionNames = new Set();
for (const rootRel of ["packages/extensions/src", "packages/extensions/third_party"]) {
  const rootAbs = path.join(ROOT, rootRel);
  if (!fs.existsSync(rootAbs)) continue;
  for (const entry of fs.readdirSync(rootAbs, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const manifestPath = path.join(rootAbs, entry.name, "extension.json");
    if (!fs.existsSync(manifestPath)) continue;
    const name = JSON.parse(fs.readFileSync(manifestPath, "utf8")).name;
    if (name) extensionNames.add(name);
  }
}
const PROFILE_DIR = path.join(ROOT, "packages", "kit", "profiles");
for (const profileFile of fs.readdirSync(PROFILE_DIR).filter((f) => f.endsWith(".json"))) {
  const profile = JSON.parse(fs.readFileSync(path.join(PROFILE_DIR, profileFile), "utf8"));
  const include = new Set(profile.include ?? []);
  const description = profile.description ?? "";
  for (const name of extensionNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(^|[^a-z0-9-])${escaped}([^a-z0-9-]|$)`);
    if (!re.test(description)) continue;
    assert.ok(
      include.has(name),
      `${profileFile}: description names extension "${name}" that its include list lacks`,
    );
  }
}

// Regression guards for doc-drift fixes (commit cb77757 + companion carry-over wording).
// The injection-monopoly bullet once contained a duplicated, mangled fragment; ensure it
// never comes back. The companion-carry-over sentence must not claim a skipped companion
// is never recorded at all (earlier installs carry it over in the marker).
const capabilityMd = fs.readFileSync(path.join(ROOT, "docs", "capability-research-workflow.md"), "utf8");
assert.ok(
  !capabilityMd.includes("includeInCompact}`); context-sieve assembles them under a token budget"),
  "docs/capability-research-workflow.md contains the orphaned duplicated injection-monopoly fragment",
);
const profilesMd = fs.readFileSync(path.join(ROOT, "docs", "architecture", "profiles-and-install.md"), "utf8");
assert.ok(
  !profilesMd.includes("is not recorded, because this install never registered it"),
  "docs/architecture/profiles-and-install.md still claims a skipped companion is not recorded (earlier installs carry it over)",
);

// The README's version badge is the version in package.json (release.mjs moves both), and
// the rewrite round-trips shields.io's `-` escaping.
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
assert.equal(readmeBadgeVersion(readme), pkg.version, "README version badge must match package.json (release.mjs updates both)");
assert.equal(readmeBadgeVersion(setReadmeBadgeVersion(readme, "1.2.3-rc_1.4")), "1.2.3-rc_1.4");
assert.equal(setReadmeBadgeVersion(readme, pkg.version), readme);

// Regression guard (WU-6 / B-060): the skills catalogue used to claim EVERY skill's
// one-line description is always in context. Only skills without
// `disable-model-invocation: true` are; the rest are surfaced on demand. The emitted
// visible count must be derived from frontmatter, never hardcoded/stale.
const skillsCatalogueDoc = fs.readFileSync(path.join(ROOT, "docs", "skills-catalogue.md"), "utf8");
assert.ok(
  !skillsCatalogueDoc.includes("Only each skill's one-line description is always in context"),
  "docs/skills-catalogue.md still claims every skill description is always in context (only skills without disable-model-invocation are)",
);

const SKILLS_ROOT = path.join(ROOT, "packages", "kit", "skills");
let skillsTotal = 0;
let skillsVisible = 0;
for (const entry of fs.readdirSync(SKILLS_ROOT)) {
  const skillPath = path.join(SKILLS_ROOT, entry, "SKILL.md");
  if (!fs.existsSync(skillPath)) continue;
  skillsTotal++;
  const text = fs.readFileSync(skillPath, "utf8");
  const end = text.startsWith("---") ? text.indexOf("\n---", 3) : -1;
  const fm = end > 0 ? text.slice(3, end) : "";
  if (!/^disable-model-invocation:\s*true\s*$/m.test(fm)) skillsVisible++;
}
assert.ok(skillsTotal > 0, "expected at least one packages/kit/skills/*/SKILL.md");
const skillsHidden = skillsTotal - skillsVisible;

// The doc must be exactly what the generator emits (catches a stale hand-edit).
const generatedCatalogue = skillsCatalogueContent();
assert.equal(
  skillsCatalogueDoc,
  generatedCatalogue,
  "docs/skills-catalogue.md is stale vs packages/core/skills-catalogue.mjs (run npm run catalog)",
);

// Pin the visible/total counts to the frontmatter-derived ones so a hardcoded or wrong
// number in the generator is caught even when doc and generator agree with each other.
const visibleNoun = skillsVisible === 1 ? "skill" : "skills";
const hiddenVerb = skillsHidden === 1 ? "is" : "are";
assert.ok(
  generatedCatalogue.includes(`The ${skillsVisible} ${visibleNoun} without \`disable-model-invocation: true\``),
  `skills catalogue must state the frontmatter-derived visible count (${skillsVisible} of ${skillsTotal})`,
);
assert.ok(
  generatedCatalogue.includes(`the other ${skillsHidden} ${hiddenVerb} surfaced on demand`),
  `skills catalogue must state the frontmatter-derived on-demand count (${skillsHidden} of ${skillsTotal})`,
);

// The lite-profile subset counts ENABLED skills (the profile's `skills.only` allowlist),
// not skills in context. Derive the count from the profile so the wording and number
// cannot drift.
const liteProfile = JSON.parse(
  fs.readFileSync(path.join(ROOT, "packages", "kit", "profiles", "lite.json"), "utf8"),
);
const liteEnableCount = (liteProfile.skills?.only || []).length;
assert.ok(
  generatedCatalogue.includes(
    `The lite profile enables ${liteEnableCount} of ${skillsTotal} skills, for small local models:`,
  ),
  `skills catalogue must say the lite profile enables ${liteEnableCount} of ${skillsTotal} skills`,
);
assert.ok(
  !generatedCatalogue.includes("The lite profile shows "),
  "skills catalogue must not use the ambiguous 'lite profile shows' wording",
);

console.log(`[docs-smoke] OK: ${checked} documented commands validated, ${linksChecked} relative links resolved; balanced profile resolved; ${skipped.length} external lines skipped; skills catalogue visible ${skillsVisible}/${skillsTotal}.`);
