#!/usr/bin/env node
/**
 * Generate docs/skills-catalogue.md from each skill's SKILL.md frontmatter.
 * Modeled on packages/core/registry.mjs. Deterministic so verify.mjs can diff a fresh regen
 * against the committed doc.
 *
 * Usage:
 *   node packages/core/skills-catalogue.mjs            # write docs/skills-catalogue.md
 *   node packages/core/skills-catalogue.mjs --check    # exit 1 if committed doc is stale
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKSPACE_ROOT, DOCS_DIR, PROFILES_DIR, FIRST_PARTY_DIR, THIRD_PARTY_DIR, SKILLS_DIR, PROMPTS_DIR, THEMES_DIR, SCHEMA_DIR, POLICIES_DIR, SOURCES_PATH, CORE_DIR, ENV_EXAMPLE, extensionRelPath } from "./lib/paths.mjs";

const ROOT = WORKSPACE_ROOT;
const DOC_PATH = path.join(ROOT, "docs", "skills-catalogue.md");
const LITE_PROFILE = path.join(PROFILES_DIR, "lite.json");

// Ordered categories -> display headings. A skill with an unknown/missing category is
// surfaced under "Uncategorised" so it can't silently vanish from the catalogue.
const CATEGORY_ORDER = [
  ["coding-workflow", "Coding & general workflow"],
  ["efficiency", "Efficiency & anti-loop"],
  ["context-and-small-models", "Context & small models"],
  ["memory", "Memory"],
  ["orchestration-recovery", "Orchestration & recovery"],
  ["mcp-governance", "MCP & governance operations"],
  ["pentest", "Pentest assessment"],
  ["evidence-reporting", "Evidence & reporting"],
  ["documentation", "Documentation"],
  ["maintainer", "Kit maintainers"],
  ["uncategorised", "Uncategorised"],
];

function parseFrontmatter(text) {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  const fm = {};
  for (const line of text.slice(3, end).split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return fm;
}

function firstSentence(description) {
  if (!description) return "";
  // Keep up to the first sentence-ending period followed by a space (or end of string).
  const m = description.match(/^(.*?\.)(?:\s|$)/);
  const sentence = m ? m[1] : description;
  return sentence.replace(/\s+/g, " ").trim();
}

function collectSkills() {
  const skills = [];
  for (const name of fs.readdirSync(SKILLS_DIR).sort()) {
    const mp = path.join(SKILLS_DIR, name, "SKILL.md");
    if (!fs.existsSync(mp)) continue;
    const fm = parseFrontmatter(fs.readFileSync(mp, "utf8"));
    skills.push({
      name: fm.name || name,
      category: fm.category || "uncategorised",
      description: fm.description || "",
      // A skill with `disable-model-invocation: true` does NOT keep its description
      // always in context; it is discovered on demand (skill_search / trigger hints).
      disableModelInvocation: fm["disable-model-invocation"] === "true",
    });
  }
  return skills;
}

// Skills whose one-line description stays in context (no disable-model-invocation flag),
// vs. those surfaced on demand. Derived from frontmatter so the rendered wording can't
// drift from the actual skill set.
function visibleSkillCount(skills) {
  return skills.filter((s) => !s.disableModelInvocation).length;
}

// Deterministic prose describing which descriptions are always in context. Counts come
// from frontmatter (never hardcoded) so adding a skill regenerates the doc correctly.
function visibilitySentences(skills) {
  const visible = visibleSkillCount(skills);
  const hidden = skills.length - visible;
  const visibleNoun = visible === 1 ? "skill" : "skills";
  const hiddenVerb = hidden === 1 ? "is" : "are";
  return [
    `Skills are on-demand runbooks. The ${visible} ${visibleNoun} without \`disable-model-invocation: true\` keep`,
    `their one-line description in context; the other ${hidden} ${hiddenVerb} surfaced on demand by`,
    "`skill_search` and trigger hints, and any `SKILL.md` body loads when the task matches",
    "(or via `/skill:<name>`). See",
  ];
}

function render() {
  const skills = collectSkills();
  const knownCategories = new Set(CATEGORY_ORDER.map(([cat]) => cat));
  const byCategory = new Map();
  for (const s of skills) {
    // M-06 fix: previously the render loop below only walked the FIXED CATEGORY_ORDER
    // list, so a skill with an unrecognized/misspelled category (present, but not one
    // of the known values - unlike a missing category, which already fell back to
    // "uncategorised") was silently absent from byCategory's iteration entirely: it
    // never printed here, but also never showed under "Uncategorised". Fold unrecognized
    // categories into "uncategorised" too, and warn loudly so a typo is caught at
    // generation time instead of a skill silently vanishing from the catalogue.
    const cat = knownCategories.has(s.category) ? s.category : "uncategorised";
    if (cat !== s.category) {
      console.warn(`[skills-catalogue] WARNING: skill '${s.name}' has unrecognized category '${s.category}' — filed under "Uncategorised". Valid categories: ${[...knownCategories].join(", ")}`);
    }
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push(s);
  }

  const lines = [
    "# Skills Catalogue",
    "",
    "> Auto-generated by `packages/core/skills-catalogue.mjs` from each `SKILL.md` frontmatter.",
    "> Do not hand-edit; run `npm run catalog` after adding or recategorising a skill.",
    "",
    ...visibilitySentences(skills),
    "[the skills plan](skills-and-efficiency-improvement-plan.md) for the format and rationale.",
    "",
  ];

  for (const [cat, heading] of CATEGORY_ORDER) {
    const items = byCategory.get(cat);
    if (!items || items.length === 0) continue;
    lines.push(`## ${heading}`);
    for (const s of items.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`- **${s.name}** — ${firstSentence(s.description)}`);
    }
    lines.push("");
  }

  // Lite profile subset (read from the profile's allowlist so it can't drift).
  if (fs.existsSync(LITE_PROFILE)) {
    const lite = JSON.parse(fs.readFileSync(LITE_PROFILE, "utf8"));
    const liteSkills = (lite.skills?.only || []).slice().sort();
    lines.push("## Lite profile subset", "");
    lines.push(
      `The lite profile enables ${liteSkills.length} of ${skills.length} skills, for small local models:`,
    );
    lines.push(liteSkills.map((s) => `\`${s}\``).join(", ") + ".");
    lines.push("");
  }

  return lines.join("\n");
}

export function skillsCatalogueContent() {
  return render();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const content = skillsCatalogueContent();
  if (check) {
    const current = fs.existsSync(DOC_PATH) ? fs.readFileSync(DOC_PATH, "utf8") : "";
    if (current !== content) {
      console.error("[skills-catalogue] STALE: docs/skills-catalogue.md differs from a fresh regen.");
      console.error("[skills-catalogue] Run: npm run catalog");
      process.exit(1);
    }
    console.log("[skills-catalogue] OK: docs/skills-catalogue.md is up to date.");
  } else {
    fs.writeFileSync(DOC_PATH, content);
    console.log(`[skills-catalogue] Wrote ${path.relative(ROOT, DOC_PATH)} (${collectSkills().length} skills).`);
  }
}
