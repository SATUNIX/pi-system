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

// Extensions whose removal widens what the agent may do. An overrides.json that removes one of
// these is refused (fail closed) instead of being applied: a hand-edit that drops a guard must be
// made deliberately in pi's own settings, never carried silently across profile switches.
export const MANDATORY_PROTECTION_EXTENSIONS = ["tool-firewall", "secret-guard", "protected-paths"];

/**
 * Like readOverrides(), but a file that exists and cannot be trusted is reported, not swallowed.
 * A missing file is fine (no overrides). An unparseable one, or one that is not a JSON object, may
 * hold a `remove` of a protection we cannot see, so the caller must stop rather than guess.
 */
export function readOverridesChecked(file = overridesPath()) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { overrides: normalizeOverrides({}), error: null };
    return { overrides: normalizeOverrides({}), error: `${file} cannot be read (${error?.message ?? error})` };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { overrides: normalizeOverrides({}), error: `${file} must contain a JSON object like {"extensions":{"add":[],"remove":[]}}` };
    }
    return { overrides: normalizeOverrides(parsed), error: null };
  } catch (error) {
    return { overrides: normalizeOverrides({}), error: `${file} is not valid JSON (${error?.message ?? error})` };
  }
}

/**
 * Reconcile overrides with what this kit version ships. Names that no longer exist (an extension,
 * skill or prompt renamed or removed since the override was saved) are dropped with a warning: a
 * stale non-security override must not fail a whole profile switch. Removing a mandatory
 * protection extension is the opposite: it is an error, never applied.
 *
 * @param {ReturnType<typeof normalizeOverrides>} overrides
 * @param {{ extensionExists: (name: string) => boolean, skills: string[], prompts: string[], file?: string }} kit
 */
export function reconcileOverrides(overrides, kit) {
  const warnings = [];
  const errors = [];
  const where = kit.file ?? overridesPath();
  const keep = (names, exists, label, hint) =>
    names.filter((n) => {
      if (exists(n)) return true;
      warnings.push(`${where}: ${label} "${n}" no longer exists in this kit and was skipped${hint ? ` (${hint})` : ""}`);
      return false;
    });
  for (const name of overrides.extensions.remove) {
    if (MANDATORY_PROTECTION_EXTENSIONS.includes(name)) {
      errors.push(
        `${where} removes the mandatory protection extension "${name}". Refusing to apply it: that would silently switch a safety guard off. ` +
          `Delete "${name}" from extensions.remove (or delete the file), then retry.`,
      );
    }
  }
  const sanitized = normalizeOverrides({
    extensions: {
      add: keep(overrides.extensions.add, kit.extensionExists, "extensions.add", "renamed or removed; re-add its new name if you still want it"),
      remove: keep(overrides.extensions.remove, (n) => kit.extensionExists(n) || MANDATORY_PROTECTION_EXTENSIONS.includes(n), "extensions.remove"),
    },
    skills: {
      exclude: keep(overrides.skills.exclude, (n) => kit.skills.includes(n), "skills.exclude"),
      include: keep(overrides.skills.include, (n) => kit.skills.includes(n), "skills.include"),
    },
    prompts: {
      exclude: keep(overrides.prompts.exclude, (n) => kit.prompts.includes(n), "prompts.exclude"),
      include: keep(overrides.prompts.include, (n) => kit.prompts.includes(n), "prompts.include"),
    },
  });
  return { overrides: sanitized, warnings, errors };
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

export const FIREWALL_POLICIES = ["coding", "pentest"];
export const FIREWALL_MODES = ["auto", "manual"];

// The firewall gate is safety-critical configuration, so an unknown value is an error, not a
// default: `policy: "pentset"` used to become "coding" (the looser policy) without a word, and an
// existing file naming a policy this kit does not know used to be overwritten with the profile's.
function assertKnownFirewall(profileDef, existing, file) {
  const fw = profileDef?.firewall;
  if (fw !== undefined && fw !== null) {
    if (typeof fw !== "object" || Array.isArray(fw)) {
      throw new Error(`profile "${profileDef?.name}": "firewall" must be an object like {"mode":"manual","policy":"coding"}`);
    }
    if (fw.policy !== undefined && !FIREWALL_POLICIES.includes(fw.policy)) {
      throw new Error(`profile "${profileDef?.name}" names an unknown firewall policy ${JSON.stringify(fw.policy)} (known: ${FIREWALL_POLICIES.join(", ")}). Refusing to fall back to another policy.`);
    }
    if (fw.mode !== undefined && !FIREWALL_MODES.includes(fw.mode)) {
      throw new Error(`profile "${profileDef?.name}" names an unknown firewall mode ${JSON.stringify(fw.mode)} (known: ${FIREWALL_MODES.join(", ")}).`);
    }
  }
  if (existing && typeof existing === "object") {
    const at = file ? ` in ${file}` : "";
    if (existing.policy !== undefined && !FIREWALL_POLICIES.includes(existing.policy)) {
      throw new Error(`the existing firewall config${at} names an unknown policy ${JSON.stringify(existing.policy)} (known: ${FIREWALL_POLICIES.join(", ")}). Fix it or delete the file, then retry; it is not overwritten automatically because that could loosen the gate.`);
    }
    if (existing.mode !== undefined && !FIREWALL_MODES.includes(existing.mode)) {
      throw new Error(`the existing firewall config${at} names an unknown mode ${JSON.stringify(existing.mode)} (known: ${FIREWALL_MODES.join(", ")}). Fix it or delete the file, then retry.`);
    }
  }
}

/**
 * Read the existing firewall.json. Absent is fine ({}); present-but-unreadable, not an object, or
 * naming an unknown policy/mode is an error (fail closed, never a silent reset).
 */
export function readFirewallConfigChecked(file = firewallConfigPath()) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`cannot read the firewall config ${file}: ${error?.message ?? error}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`the firewall config ${file} is not valid JSON (${error?.message ?? error}). Fix or delete it, then retry; it is not overwritten automatically because it holds your firewall choices.`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`the firewall config ${file} must be a JSON object like {"mode":"manual","policy":"coding"}. Fix or delete it, then retry.`);
  }
  return parsed;
}

/** Validate everything writeFirewallConfig() would need, without writing: run before any other write. */
export function checkFirewallConfig(profileDef, file = firewallConfigPath()) {
  assertKnownFirewall(profileDef, readFirewallConfigChecked(file), file);
}

export function firewallConfigFor(profileDef, existing) {
  assertKnownFirewall(profileDef, existing);
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
  const existing = readFirewallConfigChecked(file);
  assertKnownFirewall(profileDef, existing, file);
  const next = firewallConfigFor(profileDef, existing);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, file);
  return next;
}

// --- whole-run rollback for `install.mjs --settings-only` -------------------------------------
// The installer writes several files in sequence (settings.json, firewall.json, overrides.json, the
// .env scaffold, the marker). Each write is atomic, but a failure between two of them used to leave
// a mixed configuration. snapshotFiles() records every file first; the installer restores them on
// any non-zero exit. (A SIGKILL cannot run code: the in-session /profile command snapshots too.)
export function snapshotFiles(paths) {
  const seen = new Set();
  const out = [];
  for (const p of paths) {
    const abs = path.resolve(p);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      out.push({ path: abs, existed: true, bytes: fs.readFileSync(abs), mode: fs.statSync(abs).mode & 0o7777 });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      out.push({ path: abs, existed: false, bytes: null, mode: null });
    }
  }
  return out;
}

/** Restore snapshots; returns the paths that could not be restored. Never throws. */
export function restoreSnapshots(snaps) {
  const failed = [];
  for (const s of snaps) {
    try {
      if (s.existed) {
        fs.mkdirSync(path.dirname(s.path), { recursive: true });
        const tmp = `${s.path}.${process.pid}.restore.tmp`;
        fs.writeFileSync(tmp, s.bytes);
        if (s.mode !== null) fs.chmodSync(tmp, s.mode);
        fs.renameSync(tmp, s.path);
      } else {
        fs.rmSync(s.path, { force: true });
      }
      // The lock a dying writer may have left beside it.
      fs.rmSync(`${s.path}.pi-kit.lock`, { force: true });
    } catch {
      failed.push(s.path);
    }
  }
  return failed;
}
