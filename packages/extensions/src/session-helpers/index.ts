import type { ExecResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Self-containment rule: import only node:* builtins and typebox peer.
// No sibling imports. No toolchain-lib imports. See CONTRIBUTING.md.
//
// session-helpers adds manual, non-autonomous convenience commands on top of the
// kit's autonomous behaviour. The slash commands are explicit user actions. The one
// hook here is a session_start preflight that warns — once, cleanly — when the
// pi-lean-ctx extension is loaded but its external `lean-ctx` CLI is missing, which
// would otherwise surface only as an opaque `spawn ENOENT` (plan Sprint 1.1).

const CLEAR_GUIDE = [
  "pi has no /clear command, so nothing was cleared. Pick the reset you actually want:",
  "",
  "  /compact   Summarise and shrink the current context. Keeps the session, goal and thread.",
  "             This is the usual 'clear' for a long session that has grown heavy.",
  "  /compress  Instant /compact with no model call: keeps asks and replies, drops tool output.",
  "  /save      Write a snapshot of the session to disk or a vault project. Does not compact.",
  "  /new       Start a fresh session. Drops the current context entirely.",
  "             Run /handoff first if you want a clean way to resume the thread later.",
  "  /fork      Branch from an earlier message to try a different path (original is kept).",
  "",
  "Compaction is also automatic (pi's own auto-compaction; see /compaction to view or change it),",
  "so you rarely need to do it by hand.",
].join("\n");

const KIT_SHEET = [
  "pi-kit cheatsheet - type / in the composer to autocomplete any command.",
  "",
  "Session / context (pi built-ins, always available regardless of profile):",
  "  /new       Start a new session (closest match to Claude Code's /clear)",
  "  /compact   Compact the current context, keeping the thread",
  "  /fork      Fork a new branch from a previous user message",
  "  /clone     Duplicate the current session at this point",
  "  /tree      Navigate the session tree / switch branches",
  "  /resume    Resume a different session      /session  Session info and stats",
  "  /model     Switch model   /settings  Settings menu   /hotkeys  Key bindings",
  "",
  "pi-kit helpers:",
  "  /clear     How to reset context (guidance only - does not clear on its own)",
  "  /kit       Show this cheatsheet            /helpers  Alias for /kit",
  "  /footer    Toggle the GitOps status bar    (/footer status, /footer reload)",
  "  /todos     Show the working todo list      /goal     Show or set the current goal",
  "  /profile   Switch the active kit profile     /profile status  What is loaded vs profiles",
  "  /update    Check for and apply pi / kit / package updates (latest or next channel)",
  "  /compaction  Show or toggle auto-compaction (pi setting + kit trigger)",
  "",
  "Profile-dependent (present when the matching extension is loaded):",
  "  /verify  /orchestrate  /handoff  /trigger-compact  /compress  /save  /verdicts",
  "  /plan  /caveman  /firewall:status   /improve (self-improving profile only)",
].join("\n");

function show(ctx: ExtensionContext, content: string): void {
  // ctx.ui.notify is the kit's standard fire-and-forget output path (see custom-footer).
  // hasUI guards print/JSON modes where notify is a no-op.
  if (ctx.hasUI) ctx.ui.notify(content, "info");
}

// --- profile switching -------------------------------------------------------
// `/profile` is a TUI front-end for the same operation the CLI installer performs:
// reinstall the registered kit package with a different profile (`node
// packages/core/install.mjs --profile <name> --yes`), then reload so pi re-reads
// settings.json. The install logic stays single-sourced in the installer; this
// command only locates the kit checkout, picks a profile, and drives it.

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

// Kit layouts we can drive. The monorepo is the source of truth
// (<root>/packages/core/install.mjs + <root>/packages/kit/profiles); a legacy flat
// kit checkout keeps the installer at <root>/kit/install.mjs with profiles beside
// it. The published npm package keeps the monorepo layout. Anything else makes /profile
// degrade to a clear "set PI_KIT_ROOT" message rather than guessing.
export interface KitLayout {
  root: string;
  installer: string;
  profilesDir: string;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Resolve the installer + profiles for a kit root, or null if `root` is not a kit. */
export function resolveKitLayout(root: string): KitLayout | null {
  const monorepoInstaller = path.join(root, "packages", "core", "install.mjs");
  const monorepoProfiles = path.join(root, "packages", "kit", "profiles");
  if (isFile(monorepoInstaller) && isDir(monorepoProfiles)) {
    return { root, installer: monorepoInstaller, profilesDir: monorepoProfiles };
  }
  const legacyInstaller = path.join(root, "kit", "install.mjs");
  const legacyProfiles = path.join(root, "profiles");
  if (isFile(legacyInstaller) && isDir(legacyProfiles)) {
    return { root, installer: legacyInstaller, profilesDir: legacyProfiles };
  }
  return null;
}

function readMarker(cwd: string = process.cwd()): { kitSource?: string; profile?: string; scope?: string; mode?: string; ref?: string | null } {
  // Match uninstall.mjs: a project marker in the cwd wins, otherwise the global marker.
  const projectMarker = path.join(cwd, ".pi", ".pi-kit.json");
  const file = fs.existsSync(projectMarker) ? projectMarker : path.join(agentDir(), ".pi-kit.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

// Resolve the kit root. PI_KIT_ROOT wins (also what tests set), then the install marker's
// kitSource (a checkout path; npm and git sources are not paths and fall through), then the
// package this module was loaded from: a checkout, git clone or npm install of the kit all
// keep the monorepo layout, with this module at <kit>/packages/extensions/src/<name>/ (four
// levels up); a legacy flat kit has it at <kit>/extensions/<name>/ (two levels up). Returns
// null rather than guessing.
export function findKitRoot(): string | null {
  const override = process.env.PI_KIT_ROOT?.trim();
  if (override) return resolveKitLayout(override) ? override : null;
  const marker = readMarker();
  if (marker.kitSource && resolveKitLayout(marker.kitSource)) return marker.kitSource;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const installed of [path.resolve(here, "..", "..", "..", ".."), path.resolve(here, "..", "..")]) {
      if (resolveKitLayout(installed)) return installed;
    }
  } catch {
    /* import.meta.url unavailable (non-ESM loader) - fall through */
  }
  return null;
}

interface ProfileInfo {
  name: string;
  description: string;
}

export function listProfiles(kitRoot: string): ProfileInfo[] {
  const dir = resolveKitLayout(kitRoot)?.profilesDir ?? path.join(kitRoot, "profiles");
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const name = f.replace(/\.json$/, "");
      let description = "";
      try {
        description = (JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")).description ?? "").trim();
      } catch {
        /* a malformed profile is still selectable; the installer will reject it */
      }
      return { name, description };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

// --- actual loaded set vs profiles ------------------------------------------

function readJsonFile(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function sameDir(a: string, b: string): boolean {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return path.resolve(a) === path.resolve(b);
  }
}

export const KIT_PACKAGE = "@satunix/pi-system";

// True for `npm:@satunix/pi-system` on any channel or version.
export function isKitNpmSource(source: string): boolean {
  if (!source.startsWith("npm:")) return false;
  const body = source.slice(4);
  return body === KIT_PACKAGE || body.startsWith(`${KIT_PACKAGE}@`);
}

// True for a git source of a pi-system repository on any ref (`git:host/owner/pi-system[@ref]`,
// `git:git@host:owner/pi-system[@ref]`, or an https/ssh URL).
export function isKitGitSource(source: string): boolean {
  const url = source.startsWith("git:") ? source.slice(4) : /^(https?|ssh|git):\/\//i.test(source) ? source : null;
  if (!url) return false;
  return /[/:]pi-system(\.git)?(@[^/:]*)?$/i.test(url.trim());
}

// The kit's own package entry: a local path equal to kitRoot, or the npm or git package when
// kitRoot is pi's installed copy of it (<agent dir>/npm/node_modules/..., <agent dir>/git/...).
function isKitEntrySource(source: string, base: string, kitRoot: string): boolean {
  if (isKitNpmSource(source) || isKitGitSource(source)) {
    // Mirror kit-update's isKitRoot: accept the legacy "pi-system" package name and require
    // the monorepo installer, so /profile agrees with /update for legacy-named checkouts.
    const name = readJsonFile(path.join(kitRoot, "package.json"))?.name;
    return (name === KIT_PACKAGE || name === "pi-system") && fs.existsSync(path.join(kitRoot, "packages", "core", "install.mjs"));
  }
  if (source.startsWith("npm:") || source.startsWith("git:")) return false;
  return sameDir(path.resolve(base, source), kitRoot);
}

// Names of kit extensions in the kit's settings entry (null when the entry is missing or
// unfiltered, i.e. pi loads the whole package).
export function loadedKitExtensions(settingsFile: string, kitRoot: string): string[] | null {
  const settings = readJsonFile(settingsFile);
  const base = path.dirname(settingsFile);
  for (const pkg of Array.isArray(settings?.packages) ? settings.packages : []) {
    const source = typeof pkg === "string" ? pkg : pkg?.source;
    if (typeof source !== "string" || !isKitEntrySource(source, base, kitRoot)) continue;
    if (typeof pkg === "string" || !Array.isArray(pkg.extensions)) return null;
    return pkg.extensions
      .map((e: unknown) => (typeof e === "string" ? e.match(/(?:src|third_party)\/([^/]+)\/index\.ts$/)?.[1] : undefined))
      .filter((n: string | undefined): n is string => Boolean(n));
  }
  return null;
}

// Whether a settings file has a kit package entry at all, filtered or not. `loadedKitExtensions`
// treats an unfiltered entry as "the whole package" and returns null, so it cannot tell an absent
// entry from an unfiltered one; scope detection needs the latter (the project settings entry is
// authoritative even without a project marker).
function projectKitEntry(settingsFile: string, kitRoot: string): boolean {
  const settings = readJsonFile(settingsFile);
  const base = path.dirname(settingsFile);
  for (const pkg of Array.isArray(settings?.packages) ? settings.packages : []) {
    const source = typeof pkg === "string" ? pkg : pkg?.source;
    if (typeof source === "string" && isKitEntrySource(source, base, kitRoot)) return true;
  }
  return false;
}

function isKitExtension(kitRoot: string, name: string): boolean {
  return ["src", "third_party"].some((avenue) => isFile(path.join(kitRoot, "packages", "extensions", avenue, name, "index.ts")));
}

function readOverrides(): { add: string[]; remove: string[] } {
  const raw = readJsonFile(path.join(agentDir(), "pi-kit", "overrides.json"));
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return { add: list(raw?.extensions?.add), remove: list(raw?.extensions?.remove) };
}

export function hasOverridesFile(): boolean {
  return fs.existsSync(path.join(agentDir(), "pi-kit", "overrides.json"));
}

// The in-package extensions a profile would load once overrides are applied.
export function profileKitExtensions(kitRoot: string, profile: string): string[] {
  const layout = resolveKitLayout(kitRoot);
  const def = layout ? readJsonFile(path.join(layout.profilesDir, `${profile}.json`)) : null;
  const o = readOverrides();
  const include: string[] = Array.isArray(def?.include) ? def.include : [];
  const out = include.filter((n) => !o.remove.includes(n));
  for (const n of o.add) if (!out.includes(n)) out.push(n);
  return out.filter((n) => isKitExtension(kitRoot, n));
}

export function diffSets(from: string[], to: string[]): { add: string[]; remove: string[] } {
  return { add: to.filter((n) => !from.includes(n)), remove: from.filter((n) => !to.includes(n)) };
}

// Which profile the loaded set matches: exact, or the closest by symmetric difference.
export function matchProfile(kitRoot: string, loaded: string[], profiles: string[]): { exact?: string; closest?: string; distance: number } {
  let best: { name?: string; distance: number } = { distance: Number.POSITIVE_INFINITY };
  for (const name of profiles) {
    const d = diffSets(loaded, profileKitExtensions(kitRoot, name));
    const distance = d.add.length + d.remove.length;
    if (distance === 0) return { exact: name, closest: name, distance: 0 };
    if (distance < best.distance) best = { name, distance };
  }
  return { closest: best.name, distance: best.distance };
}

// The installer is a Node script. Under a compiled `pi` binary process.execPath is pi itself,
// and `pi install.mjs ...` would read the script path as a prompt — so only use execPath when
// it is a JS runtime, else the `node` on PATH.
function nodeBinary(): string {
  const exe = (process.execPath || "").replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.exe$/, "") ?? "";
  return exe === "node" || exe === "nodejs" ? process.execPath : "node";
}

// --- compaction status/toggle -------------------------------------------------
// pi's own auto-compaction is `compaction.enabled` (global settings, overridden by the
// project's .pi/settings.json). The kit's trigger-compact adds a fixed-budget trigger that
// now obeys the same switch plus its own on/off (<agent dir>/pi-kit/trigger-compact.json).

export interface CompactionState {
  enabled: boolean;
  source: "project" | "global" | "default";
  reserveTokens: number;
  keepRecentTokens: number;
  kitTrigger: { enabled: boolean; thresholdTokens: number | null };
}

export function compactionState(cwd: string): CompactionState {
  const project = readJsonFile(path.join(cwd, ".pi", "settings.json"))?.compaction ?? {};
  const global = readJsonFile(path.join(agentDir(), "settings.json"))?.compaction ?? {};
  const pick = (key: string) => (project[key] !== undefined ? project[key] : global[key]);
  const enabled = typeof project.enabled === "boolean" ? project.enabled : typeof global.enabled === "boolean" ? global.enabled : true;
  const source = typeof project.enabled === "boolean" ? "project" : typeof global.enabled === "boolean" ? "global" : "default";
  const kit = readJsonFile(path.join(agentDir(), "pi-kit", "trigger-compact.json")) ?? {};
  const envThreshold = Number(process.env.PI_KIT_COMPACT_THRESHOLD_TOKENS);
  return {
    enabled,
    source,
    reserveTokens: typeof pick("reserveTokens") === "number" ? pick("reserveTokens") : 16384,
    keepRecentTokens: typeof pick("keepRecentTokens") === "number" ? pick("keepRecentTokens") : 20000,
    kitTrigger: {
      enabled: kit.enabled !== false,
      thresholdTokens: Number.isFinite(envThreshold) && envThreshold > 0 ? envThreshold : typeof kit.thresholdTokens === "number" ? kit.thresholdTokens : 100_000,
    },
  };
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

// Set pi's global compaction.enabled, preserving every other setting. Refuses to touch a
// settings file that does not parse (writing {} back would erase the operator's config).
export function setGlobalCompactionEnabled(enabled: boolean): void {
  const file = path.join(agentDir(), "settings.json");
  let settings: any = {};
  if (fs.existsSync(file)) {
    settings = readJsonFile(file);
    if (!settings || typeof settings !== "object") throw new Error(`${file} is not valid JSON; not changed`);
  }
  settings.compaction = { ...(settings.compaction ?? {}), enabled };
  writeJsonAtomic(file, settings);
}

export function setKitTriggerEnabled(enabled: boolean): void {
  const file = path.join(agentDir(), "pi-kit", "trigger-compact.json");
  const current = readJsonFile(file) ?? {};
  if (enabled) delete current.enabled;
  else current.enabled = false;
  if (Object.keys(current).length === 0) fs.rmSync(file, { force: true });
  else writeJsonAtomic(file, current);
}

function formatK(n: number | null): string {
  if (n === null) return "?";
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

export function describeCompaction(state: CompactionState, kitLoaded: boolean): string {
  return [
    `Auto-compaction (pi): ${state.enabled ? "ON" : "OFF"}  [${state.source === "default" ? "default" : `${state.source} settings`}]`,
    `  compacts when context exceeds (window − ${formatK(state.reserveTokens)} reserve); keeps ~${formatK(state.keepRecentTokens)} recent tokens`,
    kitLoaded
      ? `Kit fixed-budget trigger (trigger-compact): ${!state.enabled ? "OFF (follows pi's switch)" : state.kitTrigger.enabled ? `ON at ${formatK(state.kitTrigger.thresholdTokens)} tokens` : "OFF (/compact-threshold off)"}`
      : "Kit fixed-budget trigger: not loaded in this profile",
    "",
    "Manual /compact always works. Change: /compaction on|off (pi), /compaction trigger on|off (kit).",
  ].join("\n");
}

// --- pi-lean-ctx binary preflight -------------------------------------------
// pi-lean-ctx routes bash/read/grep output through an external `lean-ctx` CLI that
// is NOT bundled and NOT on npm (see packages/core/sources.json). When it is loaded
// but the binary is absent, its MCP bridge fails with `spawn ENOENT`. We detect that
// here and warn once instead. Uses node builtins only (self-containment rule).

function isExpectedLeanCtx(): boolean {
  const override = process.env.PI_KIT_LEAN_CTX?.trim();
  if (override === "0" || override === "off" || override === "false") return false;
  if (override === "1" || override === "on" || override === "true") return true;
  // Auto-detect: is the pi-lean-ctx extension actually installed anywhere obvious?
  const candidates = [
    path.join(os.homedir(), ".pi", "agent", "extensions", "pi-lean-ctx"),
    path.join(os.homedir(), ".pi", "agent", "node_modules", "pi-lean-ctx"),
    path.join(process.cwd(), "node_modules", "pi-lean-ctx"),
  ];
  return candidates.some((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });
}

function leanCtxBinaryPresent(): boolean {
  const configured = process.env.PI_LEAN_CTX_BIN?.trim() || process.env.LEAN_CTX_BIN?.trim();
  if (configured) {
    try {
      return fs.existsSync(configured);
    } catch {
      return false;
    }
  }
  const pathEnv = process.env.PATH || process.env.Path || "";
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      try {
        if (fs.existsSync(path.join(dir, `lean-ctx${ext}`))) return true;
      } catch {
        /* ignore unreadable PATH entries */
      }
    }
  }
  return false;
}

// A bare `pi install git:<host>/<owner>/pi-system@<tag>` (or `npm:@satunix/pi-system`)
// registers the package unfiltered, so pi loads every extension in it, experimental ones
// included. The first session after that applies the default profile (settings only) and asks
// for a reload; `/profile` picks another. PI_KIT_AUTO_PROFILE=0 turns this off,
// PI_KIT_AUTO_PROFILE=<name> picks the profile.
export function unfilteredKitEntry(settingsFile: string): boolean {
  const settings = readJsonFile(settingsFile);
  for (const pkg of Array.isArray(settings?.packages) ? settings.packages : []) {
    const source = typeof pkg === "string" ? pkg : pkg?.source;
    if (typeof source !== "string" || !(isKitNpmSource(source) || isKitGitSource(source))) continue;
    return typeof pkg === "string" || !Array.isArray(pkg.extensions);
  }
  return false;
}

/** @deprecated use unfilteredKitEntry (also matches git installs). */
export const unfilteredNpmKitEntry = unfilteredKitEntry;

async function applyDefaultProfile(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  // Interactive sessions only: print/JSON runs and tests must never rewrite settings.
  if (!ctx.hasUI) return;
  const setting = process.env.PI_KIT_AUTO_PROFILE?.trim();
  if (["0", "off", "false", "no"].includes((setting ?? "").toLowerCase())) return;
  const cwd = (ctx as ExtensionCommandContext).cwd ?? process.cwd();
  const scope = unfilteredKitEntry(path.join(cwd, ".pi", "settings.json")) ? "project" : "global";
  if (scope === "global" && !unfilteredKitEntry(path.join(agentDir(), "settings.json"))) return;
  const kitRoot = findKitRoot();
  const layout = kitRoot ? resolveKitLayout(kitRoot) : null;
  if (!kitRoot || !layout) return;
  const profile = setting && listProfiles(kitRoot).some((p) => p.name === setting) ? setting : "balanced";
  const result = await pi.exec(nodeBinary(), [layout.installer, "--profile", profile, "--yes", "--settings-only", "--scope", scope], { cwd: scope === "project" ? cwd : kitRoot, timeout: 120_000 });
  if (result.code === 0) {
    ctx.ui.notify(`pi-system: applied the "${profile}" profile (the package was loading every extension). Run /reload to load it, or /profile to choose another.`, "info");
  } else {
    ctx.ui.notify(`pi-system: every extension is loaded because no profile is applied, and applying "${profile}" failed. Run /profile.\n${(result.stderr || result.stdout || "").trim().slice(-800)}`, "warning");
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    try {
      await applyDefaultProfile(pi, ctx);
    } catch {
      // Never break session start.
    }
    try {
      if (isExpectedLeanCtx() && !leanCtxBinaryPresent()) {
        show(
          ctx,
          [
            "session-helpers: pi-lean-ctx is loaded but the external `lean-ctx` CLI was not found on PATH.",
            "Output compression is disabled (the MCP bridge would fail with spawn ENOENT).",
            "Fix: install lean-ctx (leanctx.com) and add it to PATH, set PI_LEAN_CTX_BIN=/path/to/lean-ctx,",
            "or set PI_KIT_LEAN_CTX=0 to silence this notice. See docs/efficiency-and-loops.md.",
          ].join(" "),
        );
      }
    } catch {
      // Preflight must never break session start.
    }
  });

  pi.registerCommand("clear", {
    description: "How to reset context (pi has no native /clear). Non-destructive: prints guidance only.",
    handler: async (_args, ctx) => {
      show(ctx, CLEAR_GUIDE);
    },
  });

  pi.registerCommand("kit", {
    description: "Show the pi-kit slash-command cheatsheet (built-ins + kit helpers).",
    handler: async (_args, ctx) => {
      show(ctx, KIT_SHEET);
    },
  });

  pi.registerCommand("helpers", {
    description: "Alias for /kit - show the pi-kit slash-command cheatsheet.",
    handler: async (_args, ctx) => {
      show(ctx, KIT_SHEET);
    },
  });

  pi.registerCommand("compaction", {
    description: "Show or change auto-compaction: /compaction [status|on|off|trigger on|trigger off]",
    getArgumentCompletions: (prefix: string) =>
      ["status", "on", "off", "trigger on", "trigger off"].filter((v) => v.startsWith(prefix.trim())).map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      const c = ctx as ExtensionCommandContext;
      const cwd = c.cwd ?? process.cwd();
      const kitLoaded = pi.getCommands().some((cmd) => cmd.name === "compact-threshold");
      let arg = args.trim().toLowerCase();
      if (!arg && c.hasUI) {
        const state = compactionState(cwd);
        const options = [
          `${state.enabled ? "Turn OFF" : "Turn ON"} pi auto-compaction`,
          ...(kitLoaded && state.enabled ? [`${state.kitTrigger.enabled ? "Turn OFF" : "Turn ON"} the kit fixed-budget trigger (${formatK(state.kitTrigger.thresholdTokens)})`] : []),
          "Show status",
        ];
        const choice = await c.ui.select(`Auto-compaction is ${state.enabled ? "ON" : "OFF"}`, options);
        if (choice === undefined) return;
        arg = choice.startsWith("Show") ? "status" : choice.includes("kit") ? `trigger ${state.kitTrigger.enabled ? "off" : "on"}` : state.enabled ? "off" : "on";
      }
      if (!arg || arg === "status") {
        show(c, describeCompaction(compactionState(cwd), kitLoaded));
        return;
      }
      try {
        if (arg === "on" || arg === "off") {
          setGlobalCompactionEnabled(arg === "on");
          const state = compactionState(cwd);
          const projectNote = state.source === "project" && state.enabled !== (arg === "on") ? `\nNote: ${path.join(cwd, ".pi", "settings.json")} sets compaction.enabled=${state.enabled} and overrides the global setting for this project.` : "";
          show(c, `Auto-compaction ${arg === "on" ? "enabled" : "disabled"} (global settings). Reloading so pi picks it up...${projectNote}`);
          // pi keeps settings in memory; reload so its own threshold/overflow checks see the change.
          await c.waitForIdle?.();
          await c.reload();
          return;
        }
        if (arg === "trigger on" || arg === "trigger off") {
          setKitTriggerEnabled(arg === "trigger on");
          show(c, `Kit fixed-budget trigger ${arg === "trigger on" ? "enabled" : "disabled"}.${kitLoaded ? "" : " (trigger-compact is not loaded in this profile, so this has no effect until it is.)"}`);
          return;
        }
      } catch (error) {
        if (c.hasUI) c.ui.notify(`compaction: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      if (c.hasUI) c.ui.notify(`compaction: unknown option "${arg}". Use status, on, off, trigger on, trigger off.`, "error");
    },
  });

  pi.registerCommand("profile", {
    description:
      "Switch the pi-kit profile in place: `/profile` picker, `/profile <name>`, `/profile status`, `/profile list`. Rewrites the kit's settings entry (keeping overrides.json customisations) and reloads — no restart.",
    getArgumentCompletions: (prefix: string) => {
      const kitRoot = findKitRoot();
      const names = kitRoot ? listProfiles(kitRoot).map((p) => p.name) : [];
      return ["status", "list", ...names].filter((v) => v.startsWith(prefix.trim())).map((v) => ({ value: v, label: v }));
    },
    handler: async (args, ctx) => {
      const c = ctx as ExtensionCommandContext;
      const kitRoot = findKitRoot();
      const layout = kitRoot ? resolveKitLayout(kitRoot) : null;
      if (!kitRoot || !layout) {
        if (c.hasUI)
          c.ui.notify(
            "profile: could not locate the kit (needs its installer and a profiles directory). Set PI_KIT_ROOT to the kit path, or reinstall it (docs/INSTALL.md)",
            "error",
          );
        return;
      }

      const profiles = listProfiles(kitRoot);
      if (profiles.length === 0) {
        if (c.hasUI) c.ui.notify("profile: no profiles found in the kit checkout.", "error");
        return;
      }
      const projectCwd = c.cwd ?? process.cwd();
      const marker = readMarker(projectCwd);
      // The project settings entry is authoritative for scope, like kit-update's
      // isProjectScoped: in the inconsistent state (project entry, no project marker) the
      // global marker would otherwise make /profile re-register globally from the kit root.
      const projectSettingsFile = path.join(projectCwd, ".pi", "settings.json");
      const projectScoped = marker.scope === "project" || projectKitEntry(projectSettingsFile, kitRoot);
      const settingsFile = projectScoped ? projectSettingsFile : path.join(agentDir(), "settings.json");
      const loaded = loadedKitExtensions(settingsFile, kitRoot);
      // "Current" is what is actually configured, not what the marker last recorded: the two
      // drift when settings are edited by hand, and a stale marker made /profile refuse to
      // re-apply a profile ("already on X") that was no longer in effect.
      const match = loaded ? matchProfile(kitRoot, loaded, profiles.map((p) => p.name)) : { exact: undefined, closest: marker.profile, distance: 0 };
      // With no readable kit entry (missing or unfiltered) the marker is the only record.
      const current = match.exact ?? (loaded ? null : marker.profile ?? null);
      const currentLabel = current ?? (loaded ? `custom (closest: ${match.closest ?? "?"}, ${match.distance} difference${match.distance === 1 ? "" : "s"})` : `${marker.profile ?? "unknown"} (unfiltered package)`);
      const requested = args.trim();

      const diffLabel = (name: string) => {
        if (!loaded) return "";
        const d = diffSets(loaded, profileKitExtensions(kitRoot, name));
        return d.add.length || d.remove.length ? ` [+${d.add.length} −${d.remove.length}]` : "";
      };

      if (requested === "list" || requested === "--list" || requested === "status") {
        const lines = [`Current: ${currentLabel}`, `Settings: ${settingsFile}`, ""];
        if (requested === "status" && loaded && !current && match.closest) {
          const d = diffSets(profileKitExtensions(kitRoot, match.closest), loaded);
          if (d.add.length) lines.push(`  extra vs ${match.closest}: ${d.add.join(", ")}`);
          if (d.remove.length) lines.push(`  missing vs ${match.closest}: ${d.remove.join(", ")}`);
          lines.push("");
        }
        lines.push("Profiles:", ...profiles.map((p) => `  ${p.name === current ? "*" : " "} ${p.name}${diffLabel(p.name)} - ${p.description}`), "", "Switch with: /profile <name>");
        if (hasOverridesFile()) lines.push(`Overrides applied to every profile: ${path.join(agentDir(), "pi-kit", "overrides.json")}`);
        show(c, lines.join("\n"));
        return;
      }

      let target = requested;
      if (!target) {
        if (!c.hasUI) {
          c.ui.notify(`profile: usage: /profile <${profiles.map((p) => p.name).join("|")}>`, "error");
          return;
        }
        const labels = profiles.map((p) => `${p.name}${p.name === current ? " (current)" : ""}${diffLabel(p.name)} - ${p.description}`);
        const choice = await c.ui.select(`Switch pi-kit profile (current: ${currentLabel})`, labels);
        if (choice === undefined) return;
        target = profiles[labels.indexOf(choice)]?.name ?? "";
      }

      // Renamed profiles (mirrors PROFILE_ALIASES in packages/core/lib/profiles.mjs).
      if (target === "engagement") target = "pentest";
      if (!profiles.some((p) => p.name === target)) {
        if (c.hasUI) c.ui.notify(`profile: unknown profile "${target}". Known: ${profiles.map((p) => p.name).join(", ")}.`, "error");
        return;
      }
      if (target === current) {
        if (c.hasUI) c.ui.notify(`profile: already on "${target}" - nothing to do.`, "info");
        return;
      }

      // First switch after hand edits: offer to keep them (they would otherwise be replaced by
      // the profile's list, which is exactly how removed extensions kept coming back).
      let capture = false;
      if (c.hasUI && loaded && !current && !hasOverridesFile() && marker.profile) {
        capture = await c.ui.confirm(
          "Keep your customisations?",
          `Your settings differ from the "${marker.profile}" profile you installed (hand-edited extensions or skill/prompt filters). Save those edits to ~/.pi/agent/pi-kit/overrides.json so every profile keeps them?\n\nChoose No to switch to the plain "${target}" profile.`,
        );
      }

      if (c.hasUI) c.ui.setStatus("profile", `switching to ${target}...`);
      // Pass the install options the marker recorded straight back to the installer, so a
      // project-scoped install is not silently re-registered globally.
      const installArgs = [layout.installer, "--profile", target, "--yes", "--settings-only"];
      if (capture) installArgs.push("--capture-overrides");
      if (projectScoped) installArgs.push("--scope", "project");
      else if (marker.scope === "global") installArgs.push("--scope", "global");
      // The installer keeps the registered source and its recorded channel; only the delivery
      // is passed, so a checkout found by PI_KIT_ROOT never replaces a git or npm install.
      if (marker.mode === "git" || marker.mode === "npm") installArgs.push("--mode", marker.mode);

      let result: ExecResult;
      try {
        // install.mjs derives a project install's settings and marker paths from
        // process.cwd(), so a project-scoped switch must run in the user's project rather
        // than in the kit root. A global switch is unaffected.
        result = await pi.exec(nodeBinary(), installArgs, { cwd: projectScoped ? projectCwd : layout.root, timeout: 120_000 });
      } catch (error) {
        if (c.hasUI) {
          c.ui.setStatus("profile", undefined);
          c.ui.notify(`profile: could not run the installer: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
        return;
      }
      if (c.hasUI) c.ui.setStatus("profile", undefined);

      if (result.code !== 0) {
        const detail = (result.stderr || result.stdout || "").trim().slice(-1500);
        if (c.hasUI) c.ui.notify(`profile: install failed (exit ${result.code}).\n${detail}`, "error");
        return;
      }

      if (c.hasUI) c.ui.notify(`profile: switched to "${target}"${capture ? " (customisations saved to overrides.json)" : ""}. Reloading...`, "info");
      await c.waitForIdle?.();
      await c.reload();
      return;
    },
  });
}
