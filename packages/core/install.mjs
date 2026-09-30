#!/usr/bin/env node
/**
 * Scripted installer for pi-system.
 * Wraps pi's CLI: pi install, pi config. Idempotent / reconciling.
 *
 * Usage:
 *   node packages/core/install.mjs [--profile <quick|balanced|long-horizon|autonomous|self-improving|pentest|lite>]
 *                        [--only <names>] [--all] [--scope <global|project>] [--mode <local|git|npm>]
 *                        [--channel <latest|next|X.Y.Z>] [--git-ref <ref>] [--yes] [--dry-run] [--uninstall]
 *                        [--no-externals] [--settings-only] [--capture-overrides]
 *
 *   --mode local         Register this checkout in place (edits apply on /reload). The default
 *                        when run from a git checkout without --channel.
 *   --mode git|npm       Register the released kit instead, delivered from the kit's git
 *                        repository (release tags and main) or the npm package. The default is
 *                        `delivery` in packages/core/distribution.json (PI_KIT_DELIVERY overrides).
 *                        Run from a copy pi installed itself, the installer keeps that delivery.
 *   --channel            latest (the newest release, the default), next (every commit on main)
 *                        or a pinned X.Y.Z[-pre]. On its own it implies the configured delivery.
 *   --git-ref <ref>      Git delivery only: register an arbitrary branch, tag or commit.
 *
 *   --settings-only      Fast path used by the in-TUI /profile command: skip the verify gate,
 *                        and skip re-registering the kit and companions that are already
 *                        registered. Only rewrites the kit's settings entry (then /reload).
 *   --capture-overrides  Save hand edits in the current settings entry (vs the installed
 *                        profile) to <agent dir>/pi-kit/overrides.json so later profile
 *                        switches keep them. Alone: capture and exit.
 */
import { execSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { resolveProfile } from "./lib/resolve.mjs";
import { readSources } from "./lib/sources.mjs";
import { mergePackageBlock, removeOtherKitEntries, leanCtxBinaryAvailable, globalSettingsPath, globalAgentDir, readSettings, findPackageEntry, writeSettingsAtomic, isKitNpmSource, isKitGitSource } from "./lib/settings.mjs";
import { readDistribution, isChannel, parseGitSource, gitSourceFor, channelOfGitSource, releaseTags, latestRelease, lsRemoteTags, isLegacyGitSource } from "./lib/distribution.mjs";
import { readOverrides, writeOverrides, isEmptyOverrides, applyExtensionOverrides, excludedSkills, excludedPrompts, skillFilterPatterns, promptFilterPatterns, captureDrift, overridesPath, canonicalProfileName, writeFirewallConfig, firewallConfigPath } from "./lib/profiles.mjs";
import { resolve as resolveName } from "./lib/resolve.mjs";
import { WORKSPACE_ROOT, PROFILES_DIR, FIRST_PARTY_DIR, THIRD_PARTY_DIR, SOURCES_PATH, ENV_EXAMPLE, extensionRelPath } from "./lib/paths.mjs";

const ROOT = WORKSPACE_ROOT;

const args = process.argv.slice(2);
const get = (flag, def) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const has = flag => args.includes(flag);

// The split lite surface is now the lite profile of the single package.
const legacySurface = get("--surface", null);
if (legacySurface && legacySurface !== "lite") {
  console.error(`[install] --surface was removed: pi-system ships as one package. Use --profile <name> instead.`);
  process.exit(1);
}
if (legacySurface) console.warn("[install] --surface lite is deprecated; installing the lite profile (--profile lite).");
const explicitProfile = args.includes("--profile") || Boolean(legacySurface);
const profile = canonicalProfileName(legacySurface ? "lite" : get("--profile", "balanced"));
const onlyNames = get("--only", null)?.split(",").map(n => n.trim());
const all = has("--all");
const scope = get("--scope", "global");
const dryRun = has("--dry-run");
const uninstall = has("--uninstall");
const noExternals = has("--no-externals");
const settingsOnly = has("--settings-only");
const captureOverrides = has("--capture-overrides");
const explicitChannel = get("--channel", null);
const legacyGitRef = get("--git-ref", null);

if (uninstall) {
  // uninstall.mjs reads the state marker, so it also removes the companions this installer
  // registered, whichever copy of the kit (git, npm or checkout) is installed.
  // Forward --scope only when the operator passed it: without --scope uninstall.mjs
  // auto-detects the marker (project .pi/.pi-kit.json in the cwd, else the global one),
  // so the documented `install.mjs --uninstall` from the repo root finds a project install.
  const forwarded = [...(args.includes("--scope") ? ["--scope", scope] : []), ...(dryRun ? ["--dry-run"] : []), ...(has("--yes") ? ["--yes"] : [])];
  const result = spawnSync(process.execPath, [path.join(WORKSPACE_ROOT, "packages", "core", "uninstall.mjs"), ...forwarded], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}


let distribution;
try {
  distribution = readDistribution();
} catch (error) {
  console.error(`[install] ${error.message}`);
  process.exit(1);
}

const settingsPath = scope === "global"
  ? globalSettingsPath()
  : path.join(process.cwd(), ".pi", "settings.json");
// The state marker follows the scope: a project install records its marker under the
// project's .pi/ so it never clobbers the global ~/.pi/agent marker (and vice versa).
const markerPath = scope === "global"
  ? path.join(globalAgentDir(), ".pi-kit.json")
  : path.join(process.cwd(), ".pi", ".pi-kit.json");

// A copy pi installed itself lives under <agent dir>/git or <agent dir>/npm (or .pi/git, .pi/npm
// for project scope). Run from there (by /profile, /update or the first-run auto-profile), the
// installer keeps registering that same delivery instead of the clone as a local checkout.
function managedInstallKind(root) {
  const parts = path.resolve(root).split(path.sep);
  if (parts.includes("node_modules")) return "npm";
  const gitIdx = parts.lastIndexOf("git");
  if (gitIdx > 0 && (parts[gitIdx - 1] === path.basename(globalAgentDir()) || parts[gitIdx - 1] === ".pi")) return "git";
  return null;
}
// A git checkout installs itself in place unless a release channel is asked for.
const isCheckout = fs.existsSync(path.join(WORKSPACE_ROOT, ".git"));
const managedKind = managedInstallKind(WORKSPACE_ROOT);
const defaultMode = managedKind ?? (explicitChannel || legacyGitRef ? distribution.delivery : isCheckout ? "local" : distribution.delivery);
const mode = get("--mode", legacyGitRef ? "git" : defaultMode);
if (!["local", "git", "npm"].includes(mode)) {
  console.error(`[install] unknown --mode "${mode}" (expected local, git or npm)`);
  process.exit(1);
}
if (explicitChannel && !isChannel(explicitChannel)) {
  console.error(`[install] invalid --channel "${explicitChannel}" (expected latest, next or an exact version such as 0.2.4-beta.0)`);
  process.exit(1);
}

function readMarkerFile() {
  try {
    return JSON.parse(fs.readFileSync(markerPath, "utf8"));
  } catch {
    return null;
  }
}

function registeredKitSource(match) {
  const settings = readSettings(settingsPath);
  for (const entry of settings.packages ?? []) {
    const src = typeof entry === "string" ? entry : entry?.source;
    if (typeof src === "string" && match(src)) return src;
  }
  return null;
}

// The channel recorded when this source was installed (the marker), if it is the same package.
function recordedChannel(source) {
  const marker = readMarkerFile();
  if (!marker?.channel || typeof marker.kitSource !== "string") return null;
  const a = parseGitSource(marker.kitSource);
  const b = parseGitSource(source);
  const same = a && b ? a.key === b.key && a.ref === b.ref : marker.kitSource === source;
  return same ? marker.channel : null;
}

// npm delivery: an explicit --channel wins; otherwise keep the channel the kit is already
// registered on (so /profile never moves a user between latest and next), otherwise follow
// this copy's own version (a main snapshot means next).
function ownVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version ?? "";
  } catch {
    return "";
  }
}
function npmKitSource() {
  const pkg = distribution.npm.package;
  if (!explicitChannel) {
    const existing = registeredKitSource(isKitNpmSource);
    if (existing) {
      const spec = existing.slice(4).replace(/^@?[^@]+/, "").replace(/^@/, "");
      return { source: existing, channel: spec || "latest" };
    }
  }
  const channel = explicitChannel ?? (/[.-]next\./.test(ownVersion()) ? "next" : "latest");
  // Unversioned tracks latest in `pi update`; a dist-tag or exact version is kept as given.
  return { source: channel === "latest" ? `npm:${pkg}` : `npm:${pkg}@${channel}`, channel };
}

// git delivery: `next` is the unpinned repository (pi follows its default branch), a release is
// its `v<version>` tag, and `latest` resolves to the newest release tag with `git ls-remote`.
// With no --channel, the registered source and its recorded channel are kept.
//
// A registration from a retired private source (distribution.json git.legacySources) is never
// reused: the kit is registered from the public source instead, on the channel the install was
// following (`next` stays `next`; a release or a pin becomes `latest`, because a private tag
// does not exist publicly). `legacyMigration` records what was replaced so the rest of the
// installer can preserve hand edits and remove the old copy.
let legacyMigration = null;
function gitKitSource() {
  const registered = registeredKitSource(isKitGitSource);
  const legacy = registered && isLegacyGitSource(registered, distribution.git.legacySources) ? registered : null;
  if (distribution.git.ignoredEnvSource) {
    console.warn(`[install] Ignoring PI_SYSTEM_GIT_SOURCE=${distribution.git.ignoredEnvSource}: it names the retired private source. Unset it; the kit installs from ${distribution.git.source}.`);
  }
  const base = distribution.git.source || (legacy ? "" : registered) || "";
  if (!parseGitSource(base)) {
    console.error(`[install] no usable git source for the kit ("${base}"). Set git.source in packages/core/distribution.json or PI_SYSTEM_GIT_SOURCE=git:<host>/<owner>/pi-system.`);
    process.exit(1);
  }
  // A registration on some other (non-legacy) fork is the user's choice and is kept when no
  // explicit source override or --channel says otherwise.
  const keepRegistered = registered && !legacy && !process.env.PI_SYSTEM_GIT_SOURCE?.trim();
  const effectiveBase = keepRegistered ? registered : base;
  if (legacyGitRef) {
    const next = legacyGitRef === distribution.git.branch;
    return { source: gitSourceFor(effectiveBase, next ? null : legacyGitRef), channel: next ? "next" : legacyGitRef };
  }
  if (!explicitChannel && registered && !legacy) {
    return { source: registered, channel: recordedChannel(registered) ?? channelOfGitSource(registered, distribution.git.tagPrefix) };
  }
  let channel = explicitChannel ?? "latest";
  if (legacy) {
    const before = recordedChannel(legacy) ?? channelOfGitSource(legacy, distribution.git.tagPrefix);
    if (!explicitChannel) channel = before === "next" ? "next" : "latest";
    legacyMigration = { from: legacy, channel };
    console.warn(`[install] Migrating the kit from the retired private source ${legacy} to ${distribution.git.source} (channel ${channel}).`);
  }
  if (channel === "next") return { source: gitSourceFor(effectiveBase, null), channel };
  if (channel !== "latest") return { source: gitSourceFor(effectiveBase, `${distribution.git.tagPrefix}${channel}`), channel };
  const repo = parseGitSource(effectiveBase).repo;
  let versions;
  try {
    versions = releaseTags(lsRemoteTags(repo), distribution.git.tagPrefix);
  } catch (error) {
    console.error(`[install] could not list release tags of ${repo}: ${(error.stderr || error.message || "").toString().trim()}`);
    console.error("[install] Check network access to the repository (git ls-remote), or install --channel next.");
    process.exit(1);
  }
  const version = latestRelease(versions);
  if (!version) {
    console.error(`[install] ${repo} has no release tags (${distribution.git.tagPrefix}X.Y.Z) yet. Install --channel next to follow main, or see docs/releasing.md.`);
    process.exit(1);
  }
  return { source: gitSourceFor(effectiveBase, `${distribution.git.tagPrefix}${version}`), channel: "latest" };
}

const kit = mode === "local"
  ? { source: ROOT, channel: null }
  : mode === "npm"
    ? npmKitSource()
    : gitKitSource();
const kitSource = kit.source;

function run(cmd) {
  console.log(`  > ${cmd}`);
  if (!dryRun) execSync(cmd, { stdio: "inherit" });
}

function resolveCommand(name) {
  const pathEnv = process.env.Path || process.env.PATH || "";
  const extensions = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function shellQuote(value) {
  return `"${value.replace(/"/g, '\\"')}"`;
}

// --- Load profile from profiles/<name>.json ---
function loadProfile(name) {
  const p = path.join(PROFILES_DIR, `${canonicalProfileName(name)}.json`);
  if (!fs.existsSync(p)) {
    console.error(`[install] Profile not found: ${p}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// --- Collect all extension names from in-repo + vendor ---
function allExtensionNames() {
  const names = [];
  for (const full of [FIRST_PARTY_DIR, THIRD_PARTY_DIR]) {
    if (!fs.existsSync(full)) continue;
    for (const name of fs.readdirSync(full)) {
      if (name.startsWith("_")) continue;
      if (fs.statSync(path.join(full, name)).isDirectory()) names.push(name);
    }
  }
  // Also add external names from sources.json
  const sourcesPath = SOURCES_PATH;
  if (fs.existsSync(sourcesPath)) {
    const { external } = readSources(sourcesPath);
    for (const e of external) names.push(...(e.provides ?? [e.name]));
  }
  return [...new Set(names)];
}

// --- Capture hand edits as overrides (before anything is rewritten) ---
// Also runs automatically when the kit is migrated off a retired private source: the old
// entry is about to be replaced, so its hand edits (extensions added or removed, skill and
// prompt exclusions) become overrides first and survive the move.
if (captureOverrides || legacyMigration) {
  const marker = readMarkerFile();
  const settings = readSettings(settingsPath);
  const idx = findPackageEntry(settings, legacyMigration?.from ?? kitSource, settingsPath);
  if (!marker?.profile || idx === -1) {
    console.log("[install] capture-overrides: no installed kit profile/entry to compare against; nothing captured.");
  } else if (!isEmptyOverrides(readOverrides())) {
    console.log(`[install] capture-overrides: ${overridesPath()} already has overrides; left unchanged.`);
  } else {
    let installedDef;
    try { installedDef = loadProfile(marker.profile); } catch { installedDef = { include: [] }; }
    // Compare extensions against what was actually installed (the marker), not the profile
    // file as it is today — the profile may have changed since.
    const baseline = { ...installedDef, include: Array.isArray(marker.extensions) ? marker.extensions : installedDef.include ?? [] };
    const entry = settings.packages[idx];
    const drift = captureDrift(typeof entry === "string" ? {} : entry, baseline, (name) => resolveName(name)?.avenue !== "external" && resolveName(name) !== null);
    if (isEmptyOverrides(drift)) {
      console.log("[install] capture-overrides: settings match the installed profile; nothing to capture.");
    } else if (dryRun) {
      console.log(`[install] Dry run: would write overrides ${JSON.stringify(drift)}`);
    } else {
      writeOverrides(drift);
      console.log(`[install] capture-overrides: saved hand edits to ${overridesPath()}: ${JSON.stringify(drift)}`);
    }
  }
  if (captureOverrides && !explicitProfile && !onlyNames && !all) process.exit(0);
}

// Determine selected name set
let selected;
let profileDef = null;
const overrides = readOverrides();
if (all) {
  selected = allExtensionNames();
} else if (onlyNames) {
  selected = onlyNames;
} else {
  profileDef = loadProfile(profile);
  // Operator overrides apply on top of every profile so a switch never undoes hand edits.
  selected = applyExtensionOverrides(profileDef.include ?? [], overrides);
}

// Profile installs also own the kit's skill/prompt filters (schema v2). --only / --all leave
// whatever filters the entry already has.
const packageFilters = profileDef
  ? {
      skills: skillFilterPatterns(excludedSkills(profileDef, overrides)),
      prompts: promptFilterPatterns(excludedPrompts(profileDef, overrides)),
    }
  : {};

// Full-package installs (--all) intentionally load everything; --profile and --only must
// load exactly `selected`.
// F-01 fix: previously `selected` was computed but never used to narrow what pi
// actually loads at runtime - the installer always registered the whole wildcard
// root package (packages/core/lib/settings.mjs's mergePackageBlock existed to do this but was
// never called from here). resolveProfile() resolves each selected name to its
// in-repo/vendor/external avenue and throws on typos/unresolved names; mergePackageBlock
// rewrites the package entry pi install just wrote into settings.json to an object
// form scoped to exactly the resolved in-repo/vendor extensions (external companions
// are installed separately as their own package entries in step 3 below).
const shouldFilterExtensions = !all;
let resolvedResources = null;
if (shouldFilterExtensions) {
  try {
    resolvedResources = resolveProfile(selected);
  } catch (error) {
    console.error(`[install] FAIL: ${error.message}`);
    process.exit(1);
  }
}
const extensionPatterns = resolvedResources
  ? resolvedResources
      .filter(r => r.avenue !== "external")
      .map(r => extensionRelPath(r.name, r.avenue))
  : null;

// --- Preflight: check required tools ---
function check(cmd, name, required = true) {
  if (dryRun && resolveCommand(name)) return true;
  try { execSync(cmd, { stdio: "pipe" }); return true; }
  catch {
    if (resolveCommand(name)) return true;
    if (required) { console.error(`[install] FAIL: ${name} is required`); process.exit(1); }
    console.warn(`[install] WARN: ${name} not found - some features will be unavailable`);
    return false;
  }
}

// git is needed to register a checkout or clone a git source.
if (mode !== "npm") check("git --version", "git");
check("pi --version", "pi");
const piBin = shellQuote(resolveCommand("pi") || "pi");

console.log(`\n[install] pi-system`);
console.log(`  profile:      ${all ? "all" : onlyNames ? "--only" : profile}`);
console.log(`  extensions:   ${selected.join(", ") || "(none)"}`);
console.log(`  filter:       ${shouldFilterExtensions ? `${extensionPatterns.length} in-package extension(s) enabled, rest disabled` : "(none - full package)"}`);
console.log(`  scope:        ${scope}`);
console.log(`  mode:         ${mode}${kit.channel ? ` (channel ${kit.channel})` : ""}`);
console.log(`  source:       ${kitSource}`);
console.log(`  settings:     ${settingsPath}`);
console.log(`  no-externals: ${noExternals}`);
if (profileDef) console.log(`  hidden:       ${packageFilters.skills.length} skill(s), ${packageFilters.prompts.length} prompt(s)${isEmptyOverrides(overrides) ? "" : ` (overrides: ${overridesPath()})`}`);
if (settingsOnly) console.log("  mode:         settings-only (no verify gate, no re-registration)");
console.log(`  dry-run:      ${dryRun}`);
console.log("");

// 1. Verify gate (skipped for --settings-only: switching which already-verified extensions
// load does not change any code, and the gate made every /profile switch slow and fallible).
// Only a local checkout is gated: a release (git tag or npm) and main were checked in CI, and
// the gate would check this copy, not the one being registered.
if (!settingsOnly && mode === "local") {
  console.log("[install] Running verify gate...");
  try {
    execSync("node packages/core/verify.mjs", { cwd: ROOT, stdio: "inherit" });
  } catch {
    console.error("[install] Verify gate failed. Fix errors before installing.");
    process.exit(1);
  }
}

// Registered as exactly this source? (A git or npm entry on another ref/channel is the same
// package to pi, but must be re-registered to move it; local paths are normalized by pi.)
const isRegistered = (source) => {
  const settings = readSettings(settingsPath);
  const idx = findPackageEntry(settings, source, settingsPath);
  if (idx === -1) return false;
  if (mode === "local") return true;
  const entry = settings.packages[idx];
  return (typeof entry === "string" ? entry : entry?.source) === source;
};

// 2. Register the kit
const scopeFlag = scope === "project" ? " -l" : "";
if (settingsOnly && isRegistered(kitSource)) {
  console.log("\n[install] Kit already registered; updating its settings entry only.");
} else {
  console.log("\n[install] Registering kit with pi...");
  run(`${piBin} install "${kitSource}"${scopeFlag}`);
}

// 2b. Narrow the registered package to the profile/--only selection (F-01 fix).
// `pi install` always registers the full wildcard package; without this step every
// profile - including "quick" - would still load every extension, including
// quarantined stubs and experimental extensions.
if (shouldFilterExtensions) {
  if (dryRun) {
    console.log(`\n[install] Dry run: would narrow package to ${extensionPatterns.length} extension(s): ${extensionPatterns.join(", ") || "(none)"}`);
  } else {
    try {
      mergePackageBlock(settingsPath, kitSource, resolvedResources, packageFilters);
      console.log(`[install] Narrowed package to ${extensionPatterns.length} extension(s) in ${settingsPath}`);
    } catch (error) {
      console.error(`[install] FAIL: ${error.message} - install would silently load the full package.`);
      process.exit(1);
    }
  }
}

// Keep exactly one copy of the kit registered: a checkout, a git clone and the npm package
// (and the retired dist/pi-kit-* surfaces) all ship the same tools, so any other copy left
// registered would collide on every shared extension, skill, prompt and theme name.
if (!dryRun) {
  // pi removes the retired copy's clone as well as its settings entry; if that fails the
  // settings entry is still dropped below and the orphaned clone is harmless.
  if (legacyMigration) {
    try {
      execSync(`${piBin} remove "${legacyMigration.from}"${scopeFlag}`, { stdio: "pipe" });
      console.log(`[install] Removed the retired registration ${legacyMigration.from}.`);
    } catch {
      console.warn(`[install] Could not run \`pi remove ${legacyMigration.from}\`; dropping its settings entry instead.`);
    }
  }
  removeOtherKitEntries(settingsPath, kitSource);
}

// Companion sources this install is responsible for, recorded in the state marker so
// uninstall.mjs can remove them again. Filled inside the block below (empty with
// --no-externals), so it is declared here where the marker write can still see it.
const markerCompanions = [];

// 3. Install companion external sources (reference mode only, unless --no-externals)
if (!noExternals) {
  const sourcesPath = SOURCES_PATH;
  if (fs.existsSync(sourcesPath)) {
    const { external } = readSources(sourcesPath);
    const companions = external.filter(e =>
      e.mode === "reference" &&
      selected.some(n => (e.provides ?? [e.name]).includes(n))
    ).filter(e => {
      if (e.name !== "pi-lean-ctx" || leanCtxBinaryAvailable()) return true;
      console.warn("[install] Skipping pi-lean-ctx: its required lean-ctx CLI is not available on PATH (set PI_LEAN_CTX_BIN or LEAN_CTX_BIN after installing it).");
      return false;
    });
    // Record every companion this install is responsible for: the ones just installed and
    // the ones already registered at the kit's pin (a companion registered at a different
    // version is reinstalled below, so it too is ours). A companion dropped by the
    // prerequisite filter above - currently only pi-lean-ctx without its CLI - was never
    // registered by us and is deliberately left out, so uninstall never tries to remove a
    // package this install did not add. The strings are the exact `source` values
    // uninstall.mjs passes back to `pi remove`.
    markerCompanions.push(...companions.map(c => c.source));
    // A companion registered at a different pinned version is reinstalled at the kit's pin
    // (`pi install` updates the existing entry in place), so a kit update carries its
    // reviewed companion versions with it.
    const missing = companions.filter(c => {
      const settings = readSettings(settingsPath);
      const idx = findPackageEntry(settings, c.source, settingsPath);
      if (idx === -1) return true;
      const entry = settings.packages[idx];
      return (typeof entry === "string" ? entry : entry?.source) !== c.source;
    });
    if (missing.length > 0) {
      console.log(`\n[install] Installing ${missing.length} companion external(s)...`);
      for (const c of missing) {
        run(`${piBin} install "${c.source}"${scopeFlag}`);
      }
    } else if (companions.length > 0) {
      console.log(`\n[install] ${companions.length} companion external(s) already registered.`);
    }
  }
}

// 4. Scaffold .env if absent
const envExample = ENV_EXAMPLE;
const envTarget = path.join(globalAgentDir(), ".env");
if (!fs.existsSync(envTarget) && fs.existsSync(envExample)) {
  if (!dryRun) {
    console.log(`\n[install] Scaffolding ${envTarget} from .env.example...`);
    fs.mkdirSync(path.dirname(envTarget), { recursive: true });
    fs.copyFileSync(envExample, envTarget);
  } else {
    console.log(`\n[install] Dry run: would scaffold ${envTarget} from .env.example`);
  }
}

// 4b. Firewall policy and default mode from the profile (tool-firewall and protected-paths read it).
if (profileDef) {
  if (dryRun) {
    console.log(`[install] Dry run: would set firewall ${profileDef.firewall?.mode ?? "manual"}/${profileDef.firewall?.policy ?? "coding"} in ${firewallConfigPath()}`);
  } else {
    try {
      const fw = writeFirewallConfig(profileDef);
      console.log(`[install] Firewall: mode ${fw.mode}${fw.source === "user" ? " (kept, set with /auto)" : ""}, policy ${fw.policy} -> ${firewallConfigPath()}`);
    } catch (error) {
      console.error(`[install] WARN: could not write ${firewallConfigPath()}: ${error.message}`);
    }
  }
}

// 5. Record state marker for uninstall
if (!dryRun) {
  // Carry over companions already recorded by a previous install: a profile switch that
  // no longer selects them must not orphan a package `pi` still has registered. A
  // companion stays tracked until it is actually removed from settings.json.
  const priorCompanions = readMarkerFile()?.companions;
  const carriedCompanions = Array.isArray(priorCompanions) ? priorCompanions : [];
  const marker = {
    kitSource,
    profile: all ? "all" : onlyNames ? "custom" : profile,
    extensions: selected,
    overrides: isEmptyOverrides(overrides) ? null : overridesPath(),
    scope,
    mode,
    ref: mode === "git" ? parseGitSource(kitSource)?.ref ?? null : null,
    channel: kit.channel,
    companions: [...new Set([...carriedCompanions, ...markerCompanions])],
    installedAt: new Date().toISOString(),
  };
  writeSettingsAtomic(markerPath, marker);
}

const webConsoleSelected = selected.includes("web-console");
console.log(`
[install] Done.

Next steps:
  1. Start pi:      pi          (or /reload if pi is already running)
  2. Check loaded:  pi list
  3. Switch later:  /profile    Updates: /update
${webConsoleSelected ? "\nWeb console: run /console in pi (alias /webui), or 'npm run install:web' for a standalone setup.\n" : ""}`);
