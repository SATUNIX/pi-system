/**
 * Profile resolution shared by the installer (`install.mjs`) and the in-TUI `/profile`
 * command (which drives the installer, since extensions may not import toolchain code).
 *
 * A profile selects extensions (`include`) and, since schema v2, which kit skills and prompt
 * templates are hidden (`skills.excludeCategories` / `skills.exclude` / `prompts.exclude`), or
 * which are the only ones shown (`skills.only` / `prompts.only`, used by the lite profile).
 * Operator customisations live in `<agent dir>/pi-kit/overrides.json` and are applied on top of
 * every profile, so switching profiles never silently undoes a hand-made change (previously a
 * re-install re-added removed extensions and wiped skill/prompt filters).
 *
 * overrides.json:
 *   {
 *     "extensions": { "add": ["name"], "remove": ["name"] },
 *     "skills":     { "exclude": ["name"], "include": ["name"] },
 *     "prompts":    { "exclude": ["name"], "include": ["name"] }
 *   }
 */
import fs from "node:fs";
import path from "node:path";
import { globalAgentDir, readSettings } from "./settings.mjs";
import { PROFILES_DIR, WORKSPACE_ROOT } from "./paths.mjs";

export const SKILLS_DIR = path.join(WORKSPACE_ROOT, "packages", "kit", "skills");
export const PROMPTS_DIR = path.join(WORKSPACE_ROOT, "packages", "kit", "prompts");

export function overridesPath() {
  return path.join(globalAgentDir(), "pi-kit", "overrides.json");
}

const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);

export function normalizeOverrides(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  return {
    extensions: { add: list(o.extensions?.add), remove: list(o.extensions?.remove) },
    skills: { exclude: list(o.skills?.exclude), include: list(o.skills?.include) },
    prompts: { exclude: list(o.prompts?.exclude), include: list(o.prompts?.include) },
  };
}

export function readOverrides(file = overridesPath()) {
  try {
    return normalizeOverrides(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return normalizeOverrides({});
  }
}

export function isEmptyOverrides(o) {
  return [o.extensions.add, o.extensions.remove, o.skills.exclude, o.skills.include, o.prompts.exclude, o.prompts.include].every((a) => a.length === 0);
}

// Renamed profiles keep working under their old name.
export const PROFILE_ALIASES = { engagement: "pentest" };

export function canonicalProfileName(name) {
  return PROFILE_ALIASES[name] ?? name;
}

export function loadProfileDef(name, dir = PROFILES_DIR) {
  const file = path.join(dir, `${canonicalProfileName(name)}.json`);
  if (!fs.existsSync(file)) throw new Error(`Profile not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function listProfiles(dir = PROFILES_DIR) {
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
}

// Profile include list with operator overrides applied (order-preserving, de-duplicated).
export function applyExtensionOverrides(include, overrides) {
  const remove = new Set(overrides.extensions.remove);
  const out = include.filter((n) => !remove.has(n));
  for (const n of overrides.extensions.add) if (!out.includes(n)) out.push(n);
  return out;
}

function frontmatterField(text, key) {
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const m = fm?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
}

export function kitSkills(dir = SKILLS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => fs.existsSync(path.join(dir, n, "SKILL.md")))
    .map((name) => ({ name, category: frontmatterField(fs.readFileSync(path.join(dir, name, "SKILL.md"), "utf8"), "category") }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function kitPrompts(dir = PROMPTS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "APPEND_SYSTEM.md").map((f) => f.replace(/\.md$/, "")).sort();
}

// Names of kit skills hidden by a profile + overrides.
// An `only` allowlist, when present, hides everything not on it.
function outsideOnly(def, name) {
  const only = list(def?.only);
  return only.length > 0 && !only.includes(name);
}

export function excludedSkills(profileDef, overrides, skills = kitSkills()) {
  const cats = new Set(list(profileDef?.skills?.excludeCategories));
  const names = new Set([...list(profileDef?.skills?.exclude), ...overrides.skills.exclude]);
  const include = new Set(overrides.skills.include);
  return skills
    .filter((s) => (cats.has(s.category) || names.has(s.name) || outsideOnly(profileDef?.skills, s.name)) && !include.has(s.name))
    .map((s) => s.name);
}

export function excludedPrompts(profileDef, overrides, prompts = kitPrompts()) {
  const names = new Set([...list(profileDef?.prompts?.exclude), ...overrides.prompts.exclude]);
  const include = new Set(overrides.prompts.include);
  return prompts.filter((p) => (names.has(p) || outsideOnly(profileDef?.prompts, p)) && !include.has(p));
}

// pi package-filter patterns (relative to the package root). `!pattern` excludes.
export function skillFilterPatterns(excluded) {
  return excluded.map((n) => `!packages/kit/skills/${n}/SKILL.md`);
}

export function promptFilterPatterns(excluded) {
  return excluded.map((n) => `!packages/kit/prompts/${n}.md`);
}

function namesFromPatterns(patterns, re) {
  return list(patterns)
    .filter((p) => p.startsWith("!"))
    .map((p) => p.match(re)?.[1])
    .filter(Boolean);
}

/**
 * Derive overrides from the difference between what a profile installs and what the operator's
 * settings entry actually contains (hand edits made before overrides existed), so the first
 * profile switch preserves them. Only hand-made changes are captured: extensions added or
 * removed, and skill/prompt exclusions the profile would not apply itself.
 *
 * `entry` is the kit's package entry from settings.json, `profileDef` the marker's profile,
 * `isInPackage(name)` tells kit extensions from external companions (which live in their own
 * package entries and so never appear in the kit entry).
 */
export function captureDrift(entry, profileDef, isInPackage) {
  const actualExt = list(entry?.extensions)
    .map((p) => p.match(/(?:src|third_party)\/([^/]+)\/index\.ts$/)?.[1])
    .filter(Boolean);
  const profileExt = list(profileDef?.include).filter(isInPackage);
  const none = normalizeOverrides({});
  const profileSkillEx = new Set(excludedSkills(profileDef, none));
  const profilePromptEx = new Set(excludedPrompts(profileDef, none));
  return normalizeOverrides({
    extensions: {
      add: actualExt.filter((n) => !profileExt.includes(n)),
      remove: profileExt.filter((n) => !actualExt.includes(n)),
    },
    skills: { exclude: namesFromPatterns(entry?.skills, /skills\/([^/]+)\/SKILL\.md$/).filter((n) => !profileSkillEx.has(n)) },
    prompts: { exclude: namesFromPatterns(entry?.prompts, /prompts\/([^/]+)\.md$/).filter((n) => !profilePromptEx.has(n)) },
  });
}

export function writeOverrides(overrides, file = overridesPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(normalizeOverrides(overrides), null, 2) + "\n");
  fs.renameSync(tmp, file);
}

export { readSettings };

// --- tool-firewall config (<agent dir>/pi-kit/firewall.json) ---
// A profile's `firewall` field sets the firewall policy (coding | pentest) and default mode
// (auto | manual). The policy always follows the profile: switching to or from pentest must
// never keep the other profile's gate. The mode follows the profile too, unless the operator
// chose it with /auto (source "user") and the policy is unchanged. judgeModel, learn and
// knownHosts are the operator's and are always kept.
export function firewallConfigPath() {
  return process.env.PI_KIT_FIREWALL_CONFIG?.trim() || path.join(globalAgentDir(), "pi-kit", "firewall.json");
}

export function firewallConfigFor(profileDef, existing) {
  const prev = existing && typeof existing === "object" ? existing : {};
  const policy = profileDef?.firewall?.policy === "pentest" ? "pentest" : "coding";
  const profileMode = profileDef?.firewall?.mode === "auto" ? "auto" : "manual";
  const keepUserMode = prev.source === "user" && prev.policy === policy && (prev.mode === "auto" || prev.mode === "manual");
  return {
    ...prev,
    mode: keepUserMode ? prev.mode : profileMode,
    policy,
    source: keepUserMode ? "user" : "profile",
  };
}

export function writeFirewallConfig(profileDef, file = firewallConfigPath()) {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* absent or unreadable: start from the profile */
  }
  const next = firewallConfigFor(profileDef, existing);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return next;
}
