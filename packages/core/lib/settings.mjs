/**
 * Locate and safely merge pi settings.
 * Reads ~/.pi/agent/settings.json (global) or .pi/settings.json (project).
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { extensionRelPath } from "./paths.mjs";
import { parseGitSource } from "./distribution.mjs";

// Pi resolves its config directory from PI_CODING_AGENT_DIR when set (falling back to
// ~/.pi/agent) - see node_modules/@earendil-works/pi-coding-agent/docs/usage.md. Any
// deployment that sets this env var (e.g. pi-system's container, which
// points it at a durable data-root path distinct from $HOME) needs every kit script that
// locates pi's global config dir to agree, or `pi install`'s registration and the kit's
// own settings/marker reads+writes silently target different directories.
export function globalAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function globalSettingsPath() {
  return path.join(globalAgentDir(), "settings.json");
}

export function readSettings(settingsPath) {
  if (!fs.existsSync(settingsPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    // `null`, arrays and primitives are valid JSON but not settings objects; callers
    // dereference keys like `packages`, so fall back to {} instead of returning them.
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    console.warn(`[settings] Could not parse ${settingsPath}`);
    return {};
  }
}

// Serialise writers across processes (this installer, a /profile run, another pi session's
// installer) with an O_EXCL lock file, and replace the file atomically (tmp + rename) so pi —
// which reads settings.json at any time and writes it through its own locked writer — never
// observes a half-written file. A lock older than LOCK_STALE_MS is presumed abandoned.
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withSettingsLock(settingsPath, fn) {
  const lock = `${settingsPath}.pi-kit.lock`;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.writeFileSync(lock, String(process.pid), { flag: "wx" });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished between the failed create and the stat
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${lock}; remove it if no installer is running`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

export function writeSettingsAtomic(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  const tmp = `${settingsPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
  fs.renameSync(tmp, settingsPath);
}

// Read-modify-write under the lock. `mutate` returns false to skip writing.
// A settings file that exists but does not parse is never rewritten: readSettings() falls back
// to {} for reads, and writing that back would erase every other setting the operator has.
export function updateSettings(settingsPath, mutate) {
  return withSettingsLock(settingsPath, () => {
    let settings = {};
    if (fs.existsSync(settingsPath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
        settings = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch (error) {
        throw new Error(`Refusing to rewrite ${settingsPath}: it is not valid JSON (${error.message}). Fix it by hand first.`);
      }
    }
    const result = mutate(settings);
    if (result !== false) writeSettingsAtomic(settingsPath, settings);
    return result;
  });
}

function isPathLikeSource(source) {
  return !source.startsWith("npm:") && !parseGitSource(source);
}

/** The single published package name. */
export const KIT_PACKAGE_NAME = "@satunix/pi-system";

// Retired split packages (never published, but a local registration may exist from the old
// dist/pi-kit-* exports): cleaned up like any other duplicate copy of the kit.
const LEGACY_KIT_PACKAGE_NAMES = new Set([
  "@satunix/pi-system-lite",
  ...["quick", "balanced", "long-horizon", "autonomous", "self-improving", "pentest", "engagement"].map((n) => `@satunix/pi-${n}`),
]);

/** Package name of an `npm:` source, without its version/tag (`npm:@a/b@next` -> `@a/b`). */
export function npmSourceName(source) {
  if (typeof source !== "string" || !source.startsWith("npm:")) return null;
  const spec = source.slice(4).trim();
  const at = spec.indexOf("@", spec.startsWith("@") ? 1 : 0);
  return at === -1 ? spec : spec.slice(0, at);
}

/** True for a git source of a pi-system repository, on any ref. */
export function isKitGitSource(source) {
  const git = parseGitSource(source);
  return Boolean(git && /\/pi-system$/.test(git.key));
}

/** True for an npm source of this kit, on any channel or version. */
export function isKitNpmSource(source) {
  return npmSourceName(source) === KIT_PACKAGE_NAME;
}

// pi normalizes local package sources to a path relative to the settings file's
// directory before writing them to settings.json (see
// node_modules/@earendil-works/pi-coding-agent/dist/core/package-manager.js
// normalizePackageSourceForSettings), so a raw absolute kitSource will not
// string-match the entry `pi install` already wrote. Resolve both sides to an
// absolute path before comparing. npm sources match by package name and git sources by
// host/path, as pi's own package identity does, so `npm:x`, `npm:x@next` and `npm:x@1.2.3`
// are one entry, and so are `git:host/o/r` and `git:host/o/r@v1.2.3`.
function sourcesReferSamePackage(entrySource, kitSource, baseDir) {
  if (entrySource === kitSource) return true;
  const entryNpm = npmSourceName(entrySource);
  if (entryNpm || npmSourceName(kitSource)) return entryNpm !== null && entryNpm === npmSourceName(kitSource);
  const entryGit = parseGitSource(entrySource);
  const kitGit = parseGitSource(kitSource);
  if (entryGit || kitGit) return Boolean(entryGit && kitGit && entryGit.key === kitGit.key);
  if (!isPathLikeSource(entrySource) || !isPathLikeSource(kitSource)) return false;
  const resolveAbs = s => {
    const abs = path.isAbsolute(s) ? s : path.resolve(baseDir, s);
    return process.platform === "win32" ? abs.toLowerCase() : abs;
  };
  return resolveAbs(entrySource) === resolveAbs(kitSource);
}

// Index of the kit's package entry in settings.packages, or -1.
export function findPackageEntry(settings, kitSource, settingsPath) {
  const baseDir = path.dirname(settingsPath);
  return (settings.packages ?? []).findIndex(p => {
    const src = typeof p === "string" ? p : p?.source;
    return typeof src === "string" && sourcesReferSamePackage(src, kitSource, baseDir);
  });
}

/**
 * Narrow an already-registered package entry (written by `pi install <kitSource>`)
 * to only the given resolved extensions, so --profile/--only actually control what
 * pi loads instead of being install-marker metadata only.
 * Throws if no matching package entry exists yet - callers must `pi install` first;
 * silently appending a second entry would leave the original unfiltered entry active
 * and register the package twice.
 *
 * `filters.skills` / `filters.prompts` (pi filter patterns) replace those keys when given;
 * otherwise the entry's existing keys are preserved. Keys this function does not own (themes,
 * future pi keys) are always preserved — the entry used to be rebuilt from scratch, which
 * silently wiped hand-made skill/prompt exclusions on every profile switch.
 */
export function mergePackageBlock(settingsPath, kitSource, resolvedResources, filters = {}) {
  updateSettings(settingsPath, settings => {
    if (!settings.packages) settings.packages = [];
    const existingIdx = findPackageEntry(settings, kitSource, settingsPath);
    if (existingIdx === -1) {
      throw new Error(`No registered package entry found for ${kitSource} in ${settingsPath} - install it first`);
    }
    const existing = settings.packages[existingIdx];
    const entry = typeof existing === "string" ? { source: existing } : { ...existing };
    entry.extensions = resolvedResources
      .filter(r => r.avenue !== "external")
      .map(r => extensionRelPath(r.name, r.avenue));
    for (const key of ["skills", "prompts"]) {
      if (filters[key] === undefined) continue;
      if (filters[key].length) entry[key] = filters[key];
      else delete entry[key];
    }
    settings.packages[existingIdx] = entry;
  });
  console.log(`[settings] Updated ${settingsPath}`);
}

// Is `source` (as written in settings.json) a copy of this kit? npm: the package or a retired
// split package; git: a clone of a pi-system repository; local: a checkout whose package.json
// names the kit (current or pre-publish name) or a retired dist/pi-kit-* export.
function isKitSource(source, baseDir) {
  if (typeof source !== "string") return false;
  const npmName = npmSourceName(source);
  if (npmName) return npmName === KIT_PACKAGE_NAME || LEGACY_KIT_PACKAGE_NAMES.has(npmName);
  const git = parseGitSource(source);
  if (git) return /\/pi-system$/.test(git.key);
  const dir = path.isAbsolute(source) ? source : path.resolve(baseDir, source);
  if (path.basename(dir).startsWith("pi-kit-") && path.basename(path.dirname(dir)) === "dist") return true;
  try {
    const name = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name;
    return name === KIT_PACKAGE_NAME || name === "pi-system" || LEGACY_KIT_PACKAGE_NAMES.has(name);
  } catch {
    return false;
  }
}

/**
 * Keep exactly one registered copy of the kit: remove every other kit entry (another
 * checkout, a git clone, the npm package on another spec is the SAME entry and is kept, or a
 * retired dist/pi-kit-* / split npm package). Pi treats each as an independent package, and
 * two copies register every shared extension, skill, prompt and theme twice.
 */
export function removeOtherKitEntries(settingsPath, kitSource) {
  return updateSettings(settingsPath, settings => {
    if (!Array.isArray(settings.packages)) return false;
    const baseDir = path.dirname(settingsPath);
    const before = settings.packages.length;
    settings.packages = settings.packages.filter(entry => {
      const source = typeof entry === "string" ? entry : entry?.source;
      if (typeof source !== "string") return true;
      if (sourcesReferSamePackage(source, kitSource, baseDir)) return true;
      return !isKitSource(source, baseDir);
    });
    const removed = before - settings.packages.length;
    if (removed === 0) return false;
    console.log(`[settings] Removed ${removed} other registered copy(ies) of the kit from ${settingsPath}`);
    return removed;
  }) || 0;
}

/**
 * pi-lean-ctx starts an MCP bridge around a separately installed `lean-ctx`
 * executable. Installing the npm extension without that executable makes Pi
 * emit a connection-closed error on every startup, so the installer must only
 * register it when the prerequisite can be found.
 */
export function leanCtxBinaryAvailable({ env = process.env, pathEnv = env.Path || env.PATH || "", platform = process.platform } = {}) {
  const configured = env.PI_LEAN_CTX_BIN?.trim() || env.LEAN_CTX_BIN?.trim();
  if (configured) return fs.existsSync(configured);
  const extensions = platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const directory of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      if (fs.existsSync(path.join(directory, `lean-ctx${extension}`))) return true;
    }
  }
  return false;
}
