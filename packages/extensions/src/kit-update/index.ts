import type { ExecResult, ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Self-containment rule: import only node:* builtins and the pi peer.
// No sibling imports. No toolchain-lib imports. See CONTRIBUTING.md.
//
// kit-update tells the user when pi, the pi-system kit, or a package linked to it can be
// updated, and `/update` applies it. It drives pi's own package manager (`pi update`,
// `pi install`) rather than reimplementing it, then re-applies the active profile with the
// kit's installer so a new release's extensions and reviewed companion pins take effect.
//
// The kit is delivered from git (release tags `vX.Y.Z` and the main branch of its repository)
// or from npm (dist-tags of @satunix/pi-system); packages/core/distribution.json in the kit
// says which. Both have the same channels: `latest` (the newest release), `next` (every
// commit on main) and an exact version, which is a pin and is never moved except by an
// explicit `/update channel`. If a kit release changes the delivery, `/update kit` moves the
// install over, keeping its channel and profile.

export const KIT_PACKAGE = "@satunix/pi-system";
const PI_PACKAGE = "@earendil-works/pi-coding-agent";
const DAY_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const GIT_TIMEOUT_MS = 20_000;

// --- small helpers -------------------------------------------------------------

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function readJson(file: string): any {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

function isOff(value: string | undefined): boolean {
  return ["0", "off", "false", "no"].includes((value ?? "").trim().toLowerCase());
}

/** Package name and version/tag of an `npm:` source (`npm:@a/b@next` -> {name:"@a/b", spec:"next"}). */
export function parseNpmSource(source: string): { name: string; spec: string | null } | null {
  if (!source.startsWith("npm:")) return null;
  const body = source.slice(4).trim();
  const at = body.indexOf("@", body.startsWith("@") ? 1 : 0);
  return at === -1 ? { name: body, spec: null } : { name: body.slice(0, at), spec: body.slice(at + 1) };
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function isExactVersion(value: string | null | undefined): boolean {
  return typeof value === "string" && SEMVER.test(value);
}

/** Semver precedence (prerelease-aware). Unparseable versions compare as equal. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a.trim());
  const pb = SEMVER.exec(b.trim());
  if (!pa || !pb) return 0;
  for (let i = 1; i <= 3; i++) if (Number(pa[i]) !== Number(pb[i])) return Number(pa[i]) - Number(pb[i]);
  if (!pa[4] || !pb[4]) return pa[4] ? -1 : pb[4] ? 1 : 0;
  const xa = pa[4].split(".");
  const xb = pb[4].split(".");
  for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
    if (xa[i] === undefined) return -1;
    if (xb[i] === undefined) return 1;
    const na = /^\d+$/.test(xa[i]);
    const nb = /^\d+$/.test(xb[i]);
    if (na && nb && Number(xa[i]) !== Number(xb[i])) return Number(xa[i]) - Number(xb[i]);
    if (na !== nb) return na ? -1 : 1;
    if (xa[i] !== xb[i]) return xa[i] < xb[i] ? -1 : 1;
  }
  return 0;
}

// --- delivery (packages/core/distribution.json) ----------------------------------

/** The public source of the kit: what an install migrates to when its registered source is retired. */
export const PUBLIC_KIT_SOURCE = "git:github.com/SATUNIX/pi-system";

/** Retired private sources (host/path keys). distribution.json may list more; these are always treated as retired. */
const BUILTIN_LEGACY_SOURCES = ["gitlab.home.internal/lab/pi-system", "gitlab.home.internal/root/pi-system"];

export interface Distribution {
  /** null when the kit ships no distribution.json and PI_KIT_DELIVERY is unset. */
  delivery: "git" | "npm" | null;
  gitSource: string | null;
  branch: string;
  tagPrefix: string;
  /** Retired private sources (host/path keys, lower case): installs registered from one are migrated. */
  legacySources: string[];
  /** PI_SYSTEM_GIT_SOURCE when it names a retired source (ignored, and reported). */
  ignoredEnvSource: string | null;
}

export function readDistribution(root: string | null): Distribution {
  const config = root ? readJson(path.join(root, "packages", "core", "distribution.json")) : null;
  const raw = (process.env.PI_KIT_DELIVERY || config?.delivery || "").trim();
  const legacySources = [
    ...new Set([...BUILTIN_LEGACY_SOURCES, ...(Array.isArray(config?.git?.legacySources) ? config.git.legacySources.filter((v: unknown): v is string => typeof v === "string").map((v: string) => v.trim().toLowerCase()) : [])]),
  ];
  // An override that still names a retired source (the old SSH instructions told users to export
  // one) never reconnects an install to the private remote.
  const envSource = process.env.PI_SYSTEM_GIT_SOURCE?.trim() || "";
  const envIsLegacy = envSource !== "" && isLegacyGitSource(envSource, legacySources);
  const configured = typeof config?.git?.source === "string" && !isLegacyGitSource(config.git.source, legacySources) ? config.git.source : null;
  return {
    delivery: raw === "git" || raw === "npm" ? raw : null,
    gitSource: (envIsLegacy ? "" : envSource) || configured || null,
    branch: config?.git?.branch || "main",
    tagPrefix: config?.git?.tagPrefix ?? "v",
    legacySources,
    ignoredEnvSource: envIsLegacy ? envSource : null,
  };
}

export interface GitSource {
  /** What git clones (`https://host/owner/repo`, `git@host:owner/repo`, ...). */
  repo: string;
  host: string;
  path: string;
  ref: string | null;
}

/** Parse a pi git source (`git:host/owner/repo[@ref]`, `git:git@host:owner/repo[@ref]`, or a URL). */
export function parseGitSource(source: string | null | undefined): GitSource | null {
  if (typeof source !== "string") return null;
  const trimmed = source.trim();
  const hasPrefix = trimmed.startsWith("git:");
  const url = hasPrefix ? trimmed.slice(4).trim() : trimmed;
  if (!hasPrefix && !/^(https?|ssh|git):\/\//i.test(url)) return null;
  let host: string;
  let rest: string;
  let rebuild: (p: string) => string;
  const scp = url.match(/^git@([^:]+):(.+)$/);
  const proto = url.match(/^([a-z]+:\/\/[^/]+)\/(.+)$/i);
  if (scp) {
    host = scp[1];
    rest = scp[2];
    rebuild = (p) => `git@${scp[1]}:${p}`;
  } else if (proto) {
    host = proto[1].replace(/^[a-z]+:\/\/(?:[^@/]+@)?/i, "").replace(/:\d+$/, "");
    rest = proto[2];
    rebuild = (p) => `${proto[1]}/${p}`;
  } else {
    const slash = url.indexOf("/");
    if (slash < 0) return null;
    host = url.slice(0, slash);
    rest = url.slice(slash + 1);
    rebuild = (p) => `https://${host}/${p}`;
  }
  const at = rest.indexOf("@");
  const repoPath = (at < 0 ? rest : rest.slice(0, at)).replace(/\.git$/, "").replace(/\/+$/, "");
  if (!host || repoPath.split("/").length < 2) return null;
  return { repo: rebuild(repoPath), host, path: repoPath, ref: at < 0 ? null : rest.slice(at + 1) || null };
}

/** The same git source on another ref (`null`: unpinned, i.e. follows the default branch). */
export function gitSourceWithRef(source: string, ref: string | null): string {
  const parsed = parseGitSource(source);
  const base = parsed?.ref ? source.slice(0, source.length - parsed.ref.length - 1) : source;
  return ref ? `${base}@${ref}` : base;
}

/** True when `source` names one of the retired private sources (any ref or URL form). */
export function isLegacyGitSource(source: string | null | undefined, legacySources: string[] = BUILTIN_LEGACY_SOURCES): boolean {
  const git = parseGitSource(source);
  return Boolean(git && legacySources.includes(`${git.host}/${git.path}`.toLowerCase()));
}

function isKitGitSource(source: string): boolean {
  const git = parseGitSource(source);
  return Boolean(git && /(^|\/)pi-system$/i.test(git.path));
}

/** Release versions among `git ls-remote --tags` lines, oldest first. */
export function releaseTags(lsRemote: string, tagPrefix = "v"): string[] {
  const versions = new Set<string>();
  for (const line of lsRemote.split(/\r?\n/)) {
    const m = line.match(/\trefs\/tags\/(.+?)(\^\{\})?$/);
    if (m && m[1].startsWith(tagPrefix) && isExactVersion(m[1].slice(tagPrefix.length))) versions.add(m[1].slice(tagPrefix.length));
  }
  return [...versions].sort(compareVersions);
}

/** `latest`: the newest stable release, or the newest prerelease before any stable one exists. */
export function latestRelease(versions: string[]): string | null {
  const stable = versions.filter((v) => !v.includes("-"));
  const pool = stable.length ? stable : versions;
  return pool.length ? [...pool].sort(compareVersions)[pool.length - 1] : null;
}

/** The commit a branch points at, from `git ls-remote --heads` output. */
export function branchHead(lsRemote: string, branch: string): string | null {
  const m = lsRemote.match(new RegExp(`^([0-9a-f]{40})\\trefs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"));
  return m ? m[1] : null;
}

/** Runs git and resolves its stdout, or null when it fails. Never prompts for credentials. */
export type GitLike = (args: string[]) => Promise<string | null>;

export const runGit: GitLike = (args) =>
  new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes" },
      },
      (error, stdout) => resolve(error ? null : String(stdout)),
    );
  });

// --- where and how the kit is installed ------------------------------------------

export interface KitInstall {
  kind: "npm" | "local" | "git" | "none";
  scope: "user" | "project";
  /** The source string exactly as written in settings.json. */
  source: string | null;
  /** npm and git: "latest", "next", or the pinned version (npm: also any other dist-tag). */
  channel: string | null;
  pinned: boolean;
  /** The kit's package root on disk (for its installer and sources.json), when known. */
  root: string | null;
  version: string | null;
  /** git and local installs: the checked-out commit (filled in by checkForUpdates). */
  commit?: string | null;
  /** git only: the registered source is a retired private one; /update kit migrates it to the public source. */
  legacy?: boolean;
}

interface PackageEntry {
  source: string;
  scope: "user" | "project";
  settingsFile: string;
}

function settingsFiles(cwd: string): Array<{ file: string; scope: "user" | "project" }> {
  return [
    { file: path.join(cwd, ".pi", "settings.json"), scope: "project" },
    { file: path.join(agentDir(), "settings.json"), scope: "user" },
  ];
}

/** Every package entry pi would load, project scope first (it wins over user scope). */
export function packageEntries(cwd: string): PackageEntry[] {
  const out: PackageEntry[] = [];
  for (const { file, scope } of settingsFiles(cwd)) {
    const settings = readJson(file);
    for (const pkg of Array.isArray(settings?.packages) ? settings.packages : []) {
      const source = typeof pkg === "string" ? pkg : pkg?.source;
      if (typeof source === "string" && source.trim()) out.push({ source, scope, settingsFile: file });
    }
  }
  return out;
}

function gitInstallDir(git: GitSource, scope: "user" | "project", cwd: string): string {
  const root = scope === "project" ? path.join(cwd, ".pi", "git") : path.join(agentDir(), "git");
  return path.join(root, git.host, ...git.path.split("/"));
}

/** The channel recorded by the installer for this exact source, if it is the recorded one. */
function recordedChannel(source: string, cwd: string): string | null {
  const marker = readMarker(cwd);
  if (typeof marker.channel !== "string" || typeof marker.kitSource !== "string") return null;
  const a = parseGitSource(marker.kitSource);
  const b = parseGitSource(source);
  const same = a && b ? a.host === b.host && a.path === b.path && a.ref === b.ref : marker.kitSource === source;
  return same ? marker.channel : null;
}

function npmInstallDir(name: string, scope: "user" | "project", cwd: string): string {
  const root = scope === "project" ? path.join(cwd, ".pi", "npm") : path.join(agentDir(), "npm");
  return path.join(root, "node_modules", ...name.split("/"));
}

function installedVersionAt(dir: string): string | null {
  const v = readJson(path.join(dir, "package.json"))?.version;
  return typeof v === "string" ? v : null;
}

function isKitRoot(dir: string): boolean {
  const name = readJson(path.join(dir, "package.json"))?.name;
  return (name === KIT_PACKAGE || name === "pi-system") && fs.existsSync(path.join(dir, "packages", "core", "install.mjs"));
}

/** The kit root this extension was loaded from (PI_KIT_ROOT overrides, as for /profile). */
export function ownKitRoot(): string | null {
  const override = process.env.PI_KIT_ROOT?.trim();
  if (override) return isKitRoot(override) ? override : null;
  try {
    // <root>/packages/extensions/src/kit-update/index.ts
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
    return isKitRoot(root) ? root : null;
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

export function detectKitInstall(cwd: string): KitInstall {
  const own = ownKitRoot();
  for (const entry of packageEntries(cwd)) {
    const npm = parseNpmSource(entry.source);
    if (npm) {
      if (npm.name !== KIT_PACKAGE) continue;
      const dir = npmInstallDir(KIT_PACKAGE, entry.scope, cwd);
      const root = isKitRoot(dir) ? dir : own;
      const pinned = isExactVersion(npm.spec);
      return { kind: "npm", scope: entry.scope, source: entry.source, channel: npm.spec ?? "latest", pinned, root, version: root ? installedVersionAt(root) : null };
    }
    const git = parseGitSource(entry.source);
    if (git) {
      if (!isKitGitSource(entry.source)) continue;
      const dir = gitInstallDir(git, entry.scope, cwd);
      const root = isKitRoot(dir) ? dir : own;
      const prefix = readDistribution(root).tagPrefix;
      const inferred = !git.ref ? "next" : git.ref.startsWith(prefix) && isExactVersion(git.ref.slice(prefix.length)) ? "latest" : git.ref;
      const channel = recordedChannel(entry.source, cwd) ?? inferred;
      const legacy = isLegacyGitSource(entry.source, readDistribution(root).legacySources);
      return { kind: "git", scope: entry.scope, source: entry.source, channel, pinned: channel !== "latest" && channel !== "next", root, version: root ? installedVersionAt(root) : null, legacy };
    }
    const dir = path.resolve(path.dirname(entry.settingsFile), entry.source);
    if (isKitRoot(dir) || (own && sameDir(dir, own))) {
      return { kind: "local", scope: entry.scope, source: entry.source, channel: null, pinned: false, root: dir, version: installedVersionAt(dir) };
    }
  }
  return { kind: "none", scope: "user", source: null, channel: null, pinned: false, root: own, version: own ? installedVersionAt(own) : null };
}

// --- registry -------------------------------------------------------------------

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; json(): Promise<any> }>;

function registryBase(): string {
  return (process.env.PI_KIT_NPM_REGISTRY?.trim() || "https://registry.npmjs.org").replace(/\/+$/, "");
}

/** dist-tags of an npm package ({latest, next, ...}), or null when unreachable. */
export async function fetchDistTags(name: string, fetchImpl: FetchLike): Promise<Record<string, string> | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = `${registryBase()}/-/package/${name.replace("/", "%2f")}/dist-tags`;
    const res = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const tags = await res.json();
    return tags && typeof tags === "object" ? tags : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- the check ------------------------------------------------------------------

export interface PackageStatus {
  source: string;
  name: string;
  scope: "user" | "project";
  installed: string | null;
  /** The kit's reviewed pin for this companion (packages/core/sources.json), if any. */
  kitPin: string | null;
  latest: string | null;
  /** reconcile: registered spec differs from the kit's pin; update: unpinned and behind; pinned: newer exists but the spec is pinned. */
  action: "reconcile" | "update" | "pinned" | null;
}

export interface UpdateReport {
  /** The working directory the check ran in: which marker the runtime readers resolve. */
  cwd: string;
  checkedAt: string;
  pi: { current: string; latest: string | null; available: boolean };
  kit: KitInstall & {
    target: string | null;
    available: boolean;
    note: string | null;
    /** What each channel currently points at: npm dist-tags, or for git the newest release tag and main's commit. */
    tags: Record<string, string> | null;
    /** The delivery this install should move to (a kit release changed it), or null. */
    migrateTo: "git" | "npm" | null;
  };
  packages: PackageStatus[];
  /** True when at least one registry or git lookup failed (results may be incomplete). */
  offline: boolean;
}

function kitPins(root: string | null): Map<string, string> {
  const pins = new Map<string, string>();
  const sources = root ? readJson(path.join(root, "packages", "core", "sources.json")) : null;
  for (const e of Array.isArray(sources?.external) ? sources.external : []) {
    const npm = typeof e?.source === "string" ? parseNpmSource(e.source) : null;
    if (npm) pins.set(npm.name, e.source);
  }
  return pins;
}

export async function checkForUpdates(cwd: string, fetchImpl: FetchLike, piVersion: string = PI_VERSION, git: GitLike = runGit): Promise<UpdateReport> {
  const kit = detectKitInstall(cwd);
  const dist = readDistribution(kit.root);
  const migrateTo = dist.delivery && (kit.kind === "git" || kit.kind === "npm") && dist.delivery !== kit.kind ? dist.delivery : null;
  const pins = kitPins(kit.root);
  const others = packageEntries(cwd).filter((e) => {
    const npm = parseNpmSource(e.source);
    return npm && npm.name !== KIT_PACKAGE;
  });
  const names = [...new Set(others.map((e) => parseNpmSource(e.source)!.name))];
  const wantKitTags = kit.kind === "npm" || migrateTo === "npm";
  const [piTags, kitTags, ...pkgTags] = await Promise.all([
    fetchDistTags(PI_PACKAGE, fetchImpl),
    wantKitTags ? fetchDistTags(KIT_PACKAGE, fetchImpl) : Promise.resolve(null),
    ...names.map((n) => fetchDistTags(n, fetchImpl)),
  ]);
  const tagsByName = new Map(names.map((n, i) => [n, pkgTags[i]]));
  let offline = !piTags || (wantKitTags && !kitTags) || pkgTags.some((t) => !t);

  const piLatest = piTags?.latest ?? null;
  const pi = { current: piVersion, latest: piLatest, available: Boolean(piLatest && compareVersions(piLatest, piVersion) > 0) };

  let target: string | null = null;
  let available = false;
  let note: string | null = null;
  let tags: Record<string, string> | null = kitTags;
  let commit: string | null = null;
  if (migrateTo) {
    available = true;
    target = `${migrateTo} delivery`;
    note = `pi-system is now delivered from ${migrateTo}: /update kit moves this install (channel ${kit.channel ?? "latest"}, same profile)`;
  } else if (kit.kind === "npm") {
    if (kit.pinned) {
      note = `pinned to ${kit.channel}; /update channel latest|next to follow a channel`;
      target = kitTags?.latest ?? null;
    } else {
      target = kitTags?.[kit.channel ?? "latest"] ?? null;
      available = Boolean(target && kit.version && compareVersions(target, kit.version) > 0);
      if (kitTags && !target) note = `no "${kit.channel}" dist-tag is published`;
    }
  } else if (kit.kind === "git" && kit.legacy) {
    // Never contact the retired private remote: the move goes to the public source. A pinned
    // private tag does not exist publicly, so anything but `next` follows the newest release.
    const publicSource = dist.gitSource && !isLegacyGitSource(dist.gitSource, dist.legacySources) ? dist.gitSource : PUBLIC_KIT_SOURCE;
    const channel = kit.channel === "next" ? "next" : "latest";
    available = true;
    target = `${publicSource.replace(/^git:/, "")} (${channel})`;
    note = `pi-system is registered from a retired private source (${kit.source}); /update kit moves it to ${publicSource.replace(/^git:/, "")} on channel ${channel}, keeping the profile and your hand edits`;
    if (dist.ignoredEnvSource) note += `. PI_SYSTEM_GIT_SOURCE=${dist.ignoredEnvSource} names the retired source and is ignored; unset it`;
  } else if (kit.kind === "git") {
    const source = parseGitSource(kit.source)!;
    const [remote, head] = await Promise.all([git(["ls-remote", "--tags", "--heads", source.repo]), kit.root ? git(["-C", kit.root, "rev-parse", "HEAD"]) : Promise.resolve(null)]);
    commit = head?.trim() || null;
    if (remote === null) {
      offline = true;
      note = `could not reach ${source.repo} (git ls-remote failed: offline, or no git credentials for it)`;
    } else {
      const latest = latestRelease(releaseTags(remote, dist.tagPrefix));
      const main = branchHead(remote, dist.branch);
      tags = { latest: latest ?? "-", next: main ? `${dist.branch}@${main.slice(0, 7)}` : "-" };
      if (kit.channel === "next") {
        target = main ? `${dist.branch}@${main.slice(0, 7)}` : null;
        available = Boolean(main && commit && main !== commit);
      } else if (kit.channel === "latest") {
        target = latest;
        available = Boolean(latest && kit.version && compareVersions(latest, kit.version) > 0);
        if (!latest) note = `no release tags (${dist.tagPrefix}X.Y.Z) in ${source.repo} yet`;
      } else {
        target = latest;
        note = `pinned to ${kit.channel}; /update channel latest|next to follow a channel`;
      }
    }
  } else if (kit.kind === "local") {
    note = "local checkout: /update kit pulls it with git (fast-forward only)";
    if (kit.root) {
      const [head, branch] = await Promise.all([git(["-C", kit.root, "rev-parse", "HEAD"]), git(["-C", kit.root, "rev-parse", "--abbrev-ref", "HEAD"])]);
      commit = head?.trim() || null;
      const name = branch?.trim();
      if (commit && name && name !== "HEAD") {
        const remote = await git(["-C", kit.root, "ls-remote", "origin", `refs/heads/${name}`]);
        const upstream = remote ? branchHead(remote, name) : null;
        if (remote === null) offline = true;
        // Behind only if upstream moved to a commit this checkout does not already contain.
        const contained = upstream ? (await git(["-C", kit.root, "merge-base", "--is-ancestor", upstream, "HEAD"])) !== null : true;
        if (upstream && upstream !== commit && !contained) {
          available = true;
          target = `${name}@${upstream.slice(0, 7)}`;
        }
      }
    }
  } else {
    note = `pi-system is not registered in pi settings`;
  }

  const packages: PackageStatus[] = others.map((e) => {
    const npm = parseNpmSource(e.source)!;
    const installed = installedVersionAt(npmInstallDir(npm.name, e.scope, cwd));
    const latest = tagsByName.get(npm.name)?.latest ?? null;
    const kitPin = pins.get(npm.name) ?? null;
    let action: PackageStatus["action"] = null;
    if (kitPin && kitPin !== e.source) action = "reconcile";
    else if (!isExactVersion(npm.spec) && latest && installed && compareVersions(latest, installed) > 0) action = "update";
    else if (isExactVersion(npm.spec) && latest && compareVersions(latest, npm.spec!) > 0) action = "pinned";
    return { source: e.source, name: npm.name, scope: e.scope, installed, kitPin, latest, action };
  });

  return { cwd, checkedAt: new Date().toISOString(), pi, kit: { ...kit, commit, target, available, note, tags, migrateTo }, packages, offline };
}

/** Anything the user can act on (pinned-only notices do not count). */
export function hasUpdates(report: UpdateReport): boolean {
  return report.pi.available || report.kit.available || report.packages.some((p) => p.action === "reconcile" || p.action === "update");
}

export function summaryLine(report: UpdateReport): string {
  const parts: string[] = [];
  if (report.kit.legacy) parts.push("pi-system is on a retired private source and moves to the public one");
  else if (report.kit.migrateTo) parts.push(`pi-system moves to ${report.kit.migrateTo} delivery`);
  else if (report.kit.available) parts.push(`pi-system ${report.kit.version} → ${report.kit.target}${report.kit.channel ? ` (${report.kit.channel})` : ""}`);
  if (report.pi.available) parts.push(`pi ${report.pi.current} → ${report.pi.latest}`);
  const pkgs = report.packages.filter((p) => p.action === "reconcile" || p.action === "update");
  if (pkgs.length) parts.push(`${pkgs.length} linked package${pkgs.length === 1 ? "" : "s"}`);
  return parts.length ? `Updates available: ${parts.join(", ")}. Run /update.` : "Everything is up to date.";
}

export function formatReport(report: UpdateReport): string {
  const k = report.kit;
  const lines = ["pi-system update status", ""];
  const kitWhere =
    k.kind === "npm" || k.kind === "git"
      ? `${k.kind}, channel ${k.pinned ? `pinned ${k.channel}` : k.channel}${k.scope === "project" ? ", project scope" : ""}`
      : k.kind;
  const at = k.commit ? ` @${k.commit.slice(0, 7)}` : "";
  lines.push(`  pi-system  ${k.version ?? "?"}${at}  [${kitWhere}${k.legacy ? ", retired private source" : ""}]${k.available ? `  →  ${k.target}` : (k.kind === "npm" || k.kind === "git") && k.target && !k.pinned ? "  (up to date)" : ""}`);
  if (k.tags) lines.push(`             ${k.kind === "git" ? "available" : "published"}: latest ${k.tags.latest ?? "-"}, next ${k.tags.next ?? "-"}`);
  if (k.note) lines.push(`             ${k.note}`);
  lines.push(`  pi         ${report.pi.current}${report.pi.available ? `  →  ${report.pi.latest}` : report.pi.latest ? "  (up to date)" : "  (latest unknown)"}`);
  if (report.packages.length) {
    lines.push("", "  Linked packages:");
    for (const p of report.packages) {
      const state =
        p.action === "reconcile"
          ? `→ ${p.kitPin?.replace(/^npm:/, "")} (kit's reviewed pin)`
          : p.action === "update"
            ? `→ ${p.latest}`
            : p.action === "pinned"
              ? `pinned; ${p.latest} exists (the kit moves this pin after review)`
              : "up to date";
      lines.push(`    ${p.name.padEnd(22)} ${String(p.installed ?? "not installed").padEnd(12)} ${state}`);
    }
  }
  if (report.offline) lines.push("", "  Some registry or git lookups failed (offline?); results may be incomplete.");
  lines.push("", "  /update            pick what to update", "  /update all        update everything, re-apply the profile, reload", "  /update channel <latest|next|X.Y.Z>   switch the kit's release channel");
  return lines.join("\n");
}

// --- throttle state -------------------------------------------------------------

function stateFile(): string {
  return path.join(agentDir(), "pi-kit", "update-check.json");
}

function checkIntervalMs(): number {
  const hours = Number(process.env.PI_KIT_UPDATE_CHECK_HOURS);
  return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : DAY_MS;
}

export function shouldCheckNow(now = Date.now()): boolean {
  const last = Date.parse(readJson(stateFile())?.checkedAt ?? "");
  return !Number.isFinite(last) || now - last >= checkIntervalMs();
}

// --- actions --------------------------------------------------------------------

// Under a compiled pi binary process.execPath IS pi; otherwise rely on PATH.
function piBinary(): string {
  const exe = (process.execPath || "").replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.exe$/, "") ?? "";
  return exe === "pi" ? process.execPath : "pi";
}

function nodeBinary(): string {
  const exe = (process.execPath || "").replace(/\\/g, "/").split("/").pop()?.toLowerCase().replace(/\.exe$/, "") ?? "";
  return exe === "node" || exe === "nodejs" ? process.execPath : "node";
}

interface MarkerData {
  profile?: string;
  scope?: string;
  kitSource?: string;
  channel?: string;
  mode?: string;
  ref?: string | null;
}

/**
 * Resolve the install marker the way uninstall.mjs does: a project marker in the
 * working directory wins when it exists, otherwise the global marker under the agent
 * dir. A missing or unparseable marker yields {} rather than throwing.
 */
function readMarker(cwd: string): MarkerData {
  const projectMarker = path.join(cwd, ".pi", ".pi-kit.json");
  const file = fs.existsSync(projectMarker) ? projectMarker : path.join(agentDir(), ".pi-kit.json");
  return (readJson(file) as MarkerData | null) ?? {};
}

/**
 * The scope to pass back to the installer. The scope derived from settings
 * (`detectKitInstall`) is authoritative; the marker is the fallback so a project
 * install is never silently re-registered globally.
 */
function effectiveScope(kit: KitInstall, marker: MarkerData): "project" | "global" | null {
  if (kit.scope === "project" || marker.scope === "project") return "project";
  return marker.scope === "global" ? "global" : null;
}

/**
 * One command of an update plan. `verify` runs after the command exits 0 and returns a problem
 * description when the update did not actually take effect (a package manager that exits 0
 * without moving anything must never be reported as an update). `null` means verified.
 */
type Step = { label: string; command: string; args: string[]; cwd?: string; verify?: () => Promise<string | null> };

function tail(result: ExecResult): string {
  return (result.stderr || result.stdout || "").trim().split(/\r?\n/).slice(-12).join("\n");
}

/** Project scope from either the settings entry (authoritative) or the marker. */
function isProjectScoped(cwd: string, marker = readMarker(cwd)): boolean {
  return detectKitInstall(cwd).scope === "project" || marker.scope === "project";
}

/** Re-apply the recorded profile with the (possibly just updated) kit installer. */
function reconcileStep(kit: KitInstall, cwd: string, extraArgs: string[] = []): Step | null {
  const marker = readMarker(cwd);
  const profile = typeof marker.profile === "string" && !["custom", "all"].includes(marker.profile) ? marker.profile : null;
  const root = kit.kind === "npm" ? (kit.root ?? null) : kit.root;
  if (!profile || !root) return null;
  const installer = path.join(root, "packages", "core", "install.mjs");
  if (!fs.existsSync(installer)) return null;
  const args = [installer, "--profile", profile, "--yes", "--settings-only", ...extraArgs];
  const scope = effectiveScope(kit, marker);
  if (scope) args.push("--scope", scope);
  // install.mjs derives the project settings/marker paths from process.cwd(), so a project
  // install must run in the user's project, not in the kit root (which would write into the
  // kit checkout and never update the project). Global scope keeps the kit root as before.
  return { label: `re-apply the ${profile} profile`, command: nodeBinary(), args, cwd: scope === "project" ? cwd : root };
}

function recordedProfile(cwd: string): string {
  const marker = readMarker(cwd);
  return typeof marker.profile === "string" && !["custom", "all"].includes(marker.profile) ? marker.profile : "balanced";
}

/** Run the kit's installer from `root` to register the kit on another delivery or channel. */
function installerStep(root: string, label: string, mode: "git" | "npm", channel: string, settingsOnly: boolean, cwd: string): Step | null {
  const installer = path.join(root, "packages", "core", "install.mjs");
  if (!fs.existsSync(installer)) return null;
  const args = [installer, "--mode", mode, "--channel", channel, "--profile", recordedProfile(cwd), "--yes", ...(settingsOnly ? ["--settings-only"] : [])];
  // Project scope, like reconcileStep, must run install.mjs in the user's project so
  // process.cwd() inside it is the project rather than the kit root. The settings entry is
  // authoritative, so a project install without a marker (the inconsistent state) is still
  // treated as project scope.
  const project = isProjectScoped(cwd);
  if (project) args.push("--scope", "project");
  return { label, command: nodeBinary(), args, cwd: project ? cwd : root };
}

/** After the step: the kit must now be registered and installed at `expected`. */
function verifyKitVersion(cwd: string, expected: string): () => Promise<string | null> {
  return async () => {
    const after = detectKitInstall(cwd);
    if (after.version === expected) return null;
    return `pi-system is ${after.version ?? "not installed"} after the update, expected ${expected}`;
  };
}

/** After the step: the kit's checkout must be at the commit `next` pointed at (`main@abc1234`). */
function verifyKitCommit(root: string | null, target: string | null, git: GitLike): () => Promise<string | null> {
  return async () => {
    const want = target?.split("@")[1];
    if (!root || !want) return null;
    const head = (await git(["-C", root, "rev-parse", "HEAD"]))?.trim() ?? null;
    return head && head.startsWith(want) ? null : `pi-system is at ${head ? head.slice(0, 7) : "an unknown commit"} after the update, expected ${want}`;
  };
}

function verifyPackageVersion(name: string, scope: "user" | "project", cwd: string, expected: string): () => Promise<string | null> {
  return async () => {
    const now = installedVersionAt(npmInstallDir(name, scope, cwd));
    return now && compareVersions(now, expected) >= 0 ? null : `${name} is ${now ?? "not installed"} after the update, expected ${expected}`;
  };
}

/** After `pi update --self`: the pi on PATH must now report the new version (the running process still has the old one). */
function verifyPiVersion(pi: ExtensionAPI, cwd: string, expected: string): () => Promise<string | null> {
  return async () => {
    let out = "";
    try {
      const result = await pi.exec(piBinary(), ["--version"], { cwd, timeout: 30_000 });
      out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    } catch {
      return null; // cannot ask: not evidence either way
    }
    return out.includes(expected) ? null : `pi reports "${out.trim().split(/\r?\n/)[0] ?? ""}" after the update, expected ${expected}`;
  };
}

/** After the profile is re-applied: the install marker must have been rewritten by this step. */
function verifyReconciled(cwd: string, startedAt: () => number): () => Promise<string | null> {
  return async () => {
    const at = Date.parse((readMarker(cwd) as { installedAt?: string }).installedAt ?? "");
    return Number.isFinite(at) && at >= startedAt() - 1000 ? null : "the profile was not re-applied (the install marker was not rewritten)";
  };
}

export function planUpdate(report: UpdateReport, what: "all" | "kit" | "pi" | "packages", pi_: ExtensionAPI | null = null, git: GitLike = runGit): { steps: Step[]; notes: string[] } {
  const steps: Step[] = [];
  const notes: string[] = [];
  const kit = report.kit;
  const pi = piBinary();
  const scopeFlag = kit.scope === "project" ? ["-l"] : [];
  let kitChanged = false;
  let planStart = Date.now();
  const startedAt = () => planStart;

  if (what === "kit" || what === "all") {
    if (kit.kind === "git" && kit.legacy && kit.root) {
      // The retired private source is never contacted: the installer registers the public source
      // (capturing hand edits as overrides first) and applies the recorded profile itself.
      const channel = kit.channel === "next" ? "next" : "latest";
      const step = installerStep(kit.root, `move pi-system from the retired private source to the public source (${channel})`, "git", channel, false, report.cwd);
      if (step) {
        step.verify = async () => {
          const after = detectKitInstall(report.cwd);
          return after.kind === "git" && !after.legacy ? null : "pi-system is still registered from the retired private source";
        };
        steps.push(step);
      } else notes.push("pi-system: cannot locate the kit installer to leave the retired private source. Reinstall from the public repository (see docs/INSTALL.md).");
    } else if (kit.migrateTo && kit.root) {
      const channel = kit.channel && isChannelName(kit.channel) ? kit.channel : "latest";
      const step = installerStep(kit.root, `move pi-system to ${kit.migrateTo} delivery (${channel})`, kit.migrateTo, channel, false, report.cwd);
      if (step) steps.push(step);
      else notes.push(`pi-system: cannot locate the kit installer to move to ${kit.migrateTo} delivery.`);
    } else if (kit.kind === "npm" && kit.available && kit.source) {
      steps.push({ label: `update pi-system to ${kit.target}`, command: pi, args: ["update", kit.source], verify: kit.target ? verifyKitVersion(report.cwd, kit.target) : undefined });
      kitChanged = true;
    } else if (kit.kind === "git" && kit.available && kit.source) {
      if (kit.channel === "next") {
        steps.push({ label: `update pi-system to ${kit.target}`, command: pi, args: ["update", kit.source], verify: verifyKitCommit(kit.root, kit.target, git) });
      } else {
        const prefix = readDistribution(kit.root).tagPrefix;
        steps.push({ label: `update pi-system to ${kit.target}`, command: pi, args: ["install", gitSourceWithRef(kit.source, `${prefix}${kit.target}`), ...scopeFlag], verify: kit.target ? verifyKitVersion(report.cwd, kit.target) : undefined });
      }
      kitChanged = true;
    } else if (kit.kind === "local" && kit.root && (kit.available || what === "kit")) {
      steps.push({ label: "pull the local checkout (fast-forward only)", command: "git", args: ["-C", kit.root, "pull", "--ff-only"] });
      kitChanged = true;
    } else if (what === "kit" && kit.note) {
      notes.push(`pi-system: ${kit.note}`);
    }
  }
  if (what === "packages" || what === "all") {
    const unpinned = report.packages.filter((p) => p.action === "update");
    for (const p of unpinned) steps.push({ label: `update ${p.name} to ${p.latest}`, command: pi, args: ["update", p.source], verify: p.latest ? verifyPackageVersion(p.name, p.scope, report.cwd, p.latest) : undefined });
  }
  const needsReconcile = kitChanged || ((what === "packages" || what === "all") && report.packages.some((p) => p.action === "reconcile"));
  if (needsReconcile) {
    const step = reconcileStep(kit, report.cwd);
    if (step) {
      step.verify = verifyReconciled(report.cwd, startedAt);
      steps.push(step);
    } else notes.push("No recorded profile to re-apply; run /profile to apply one so new extensions and companion pins load.");
  }
  if ((what === "pi" || what === "all") && report.pi.available) {
    steps.push({ label: `update pi to ${report.pi.latest}`, command: pi, args: ["update", "--self"], verify: pi_ && report.pi.latest ? verifyPiVersion(pi_, report.cwd, report.pi.latest) : undefined });
  }
  planStart = Date.now(); // the marker must be rewritten after planning, i.e. by a step that runs later
  return { steps, notes };
}

function isChannelName(channel: string): boolean {
  return /^(latest|next|\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/.test(channel);
}

export function planChannelSwitch(report: UpdateReport, channel: string): { steps: Step[]; notes: string[] } {
  const plan = planChannelSwitchSteps(report, channel);
  const last = plan.steps[plan.steps.length - 1];
  // The recorded channel is what /update and the installer follow next time: confirm it moved.
  if (last && !last.verify) {
    last.verify = async () => {
      const after = detectKitInstall(report.cwd);
      return after.channel === channel ? null : `pi-system is on channel ${after.channel ?? "unknown"} after the switch, expected ${channel}`;
    };
  }
  return plan;
}

function planChannelSwitchSteps(report: UpdateReport, channel: string): { steps: Step[]; notes: string[] } {
  if (!isChannelName(channel)) {
    return { steps: [], notes: [`Unknown channel "${channel}". Use latest, next, or an exact version.`] };
  }
  const kit = report.kit;
  const steps: Step[] = [];
  const notes: string[] = [];
  const delivery = kit.migrateTo ?? (kit.kind === "npm" || kit.kind === "git" ? kit.kind : readDistribution(kit.root).delivery ?? "git");
  if (kit.kind === "npm" && delivery === "npm") {
    // `pi install` rewrites the existing entry's source in place and keeps its filters.
    const spec = channel === "latest" ? `npm:${KIT_PACKAGE}` : `npm:${KIT_PACKAGE}@${channel}`;
    steps.push({ label: `switch pi-system to ${channel}`, command: piBinary(), args: ["install", spec, ...(kit.scope === "project" ? ["-l"] : [])] });
    const step = reconcileStep(kit, report.cwd);
    if (step) steps.push(step);
  } else if (kit.root) {
    // The installer resolves the channel (for git, `latest` is the newest release tag), registers
    // it in place of the current copy, records the channel and applies the profile. Then the
    // profile is re-applied with the newly installed copy's own installer.
    const moving = kit.kind !== delivery;
    const label = moving ? `move pi-system from ${kit.kind} to ${delivery} (${channel}), profile ${recordedProfile(report.cwd)}` : `switch pi-system to ${channel}`;
    const step = installerStep(kit.root, label, delivery, channel, !moving, report.cwd);
    if (step) {
      steps.push(step);
      if (!moving) {
        const again = reconcileStep(kit, report.cwd);
        if (again) steps.push(again);
      }
    } else notes.push("Cannot locate the kit installer (packages/core/install.mjs). Reinstall the kit, or set PI_KIT_ROOT.");
  } else {
    notes.push("Cannot locate the kit. Reinstall it (see docs/INSTALL.md), or set PI_KIT_ROOT.");
  }
  return { steps, notes };
}

export interface StepOutcome {
  ok: boolean;
  done: string[];
  /** The step that failed, and why (non-zero exit, or exit 0 without the promised effect). */
  failed?: { label: string; reason: string };
}

/** Show `message`: in the UI when there is one, on stderr otherwise (print, JSON and RPC modes have no notify surface). */
function say(ctx: ExtensionCommandContext, message: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else process.stderr.write(`[update] ${message}\n`);
}

/**
 * Run the plan's commands in order, stopping at the first failure. A step succeeds only when
 * the command exits 0 AND its `verify` (when it has one) confirms the update took effect.
 */
export async function runPlan(pi: ExtensionAPI, cwd: string, steps: Step[], ui?: { setStatus(key: string, text: string | undefined): void }): Promise<StepOutcome> {
  const done: string[] = [];
  for (const step of steps) {
    ui?.setStatus("kit-update", `${step.label}...`);
    let result: ExecResult;
    try {
      result = await pi.exec(step.command, step.args, { cwd: step.cwd ?? cwd, timeout: 10 * 60_000 });
    } catch (error) {
      result = { stdout: "", stderr: error instanceof Error ? error.message : String(error), code: 1, killed: false } as ExecResult;
    }
    if (result.code !== 0) {
      ui?.setStatus("kit-update", undefined);
      return { ok: false, done, failed: { label: step.label, reason: `exit ${result.code}${result.killed ? " (timed out or killed)" : ""}\n${tail(result)}`.trim() } };
    }
    if (step.verify) {
      let problem: string | null = null;
      try {
        problem = await step.verify();
      } catch (error) {
        problem = `could not verify the result: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (problem) {
        ui?.setStatus("kit-update", undefined);
        return { ok: false, done, failed: { label: step.label, reason: `the command exited 0 but the update did not take effect: ${problem}` } };
      }
    }
    done.push(step.label);
  }
  ui?.setStatus("kit-update", undefined);
  return { ok: true, done };
}

async function runSteps(pi: ExtensionAPI, ctx: ExtensionCommandContext, steps: Step[]): Promise<StepOutcome> {
  const outcome = await runPlan(pi, ctx.cwd, steps, ctx.hasUI ? ctx.ui : undefined);
  if (!outcome.ok && outcome.failed) {
    say(ctx, `update: "${outcome.failed.label}" failed: ${outcome.failed.reason}${outcome.done.length ? `\nDone before it: ${outcome.done.join("; ")}.` : ""}\nNothing after it was run. Fix the cause and run /update again; /update status shows where things stand.`, "error");
  }
  return outcome;
}

// --- extension ------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const fetchImpl: FetchLike = (url, init) => fetch(url, init as RequestInit) as ReturnType<FetchLike>;
  let lastReport: UpdateReport | null = null;

  async function check(cwd: string): Promise<UpdateReport> {
    lastReport = await checkForUpdates(cwd, fetchImpl);
    try {
      writeJsonAtomic(stateFile(), { checkedAt: lastReport.checkedAt, summary: summaryLine(lastReport), available: hasUpdates(lastReport) });
    } catch {
      /* the throttle file is best-effort */
    }
    return lastReport;
  }

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    if (!ctx.hasUI || process.env.PI_OFFLINE || isOff(process.env.PI_KIT_UPDATE_CHECK)) return;
    const cwd = (ctx as ExtensionCommandContext).cwd ?? process.cwd();
    if (!shouldCheckNow()) {
      // Keep the reminder visible between checks without another network round trip.
      if (readJson(stateFile())?.available) ctx.ui.setStatus("kit-update", "updates: /update");
      return;
    }
    // Never block or break session start: the check runs in the background.
    void check(cwd)
      .then((report) => {
        if (!hasUpdates(report)) return;
        ctx.ui.setStatus("kit-update", "updates: /update");
        ctx.ui.notify(summaryLine(report), "info");
      })
      .catch(() => {});
  });

  pi.registerCommand("update", {
    description:
      "Check for and apply updates to pi, the pi-system kit (on its latest/next channel, from git or npm) and linked packages: `/update`, `/update status`, `/update all|kit|pi|packages`, `/update channel <latest|next|X.Y.Z>`.",
    getArgumentCompletions: (prefix: string) =>
      ["status", "all", "kit", "pi", "packages", "channel latest", "channel next"].filter((v) => v.startsWith(prefix.trim())).map((v) => ({ value: v, label: v })),
    handler: async (args, ctx) => {
      const c = ctx as ExtensionCommandContext;
      const cwd = c.cwd ?? process.cwd();
      let arg = args.trim().toLowerCase();

      if (c.hasUI) c.ui.setStatus("kit-update", "checking for updates...");
      const report = await check(cwd);
      if (c.hasUI) c.ui.setStatus("kit-update", hasUpdates(report) ? "updates: /update" : undefined);

      if (arg === "status" || arg === "check") {
        say(c, formatReport(report), "info");
        return;
      }

      if (!arg) {
        if (!c.hasUI) {
          // No selector without a UI: show where things stand, and how to apply it.
          say(c, `${formatReport(report)}\n\nNon-interactive session: run \`/update all|kit|pi|packages\` explicitly to apply.`, "info");
          return;
        }
        const options: Array<{ label: string; value: string }> = [];
        const pkgCount = report.packages.filter((p) => p.action === "reconcile" || p.action === "update").length;
        if (hasUpdates(report)) options.push({ label: "Update everything", value: "all" });
        if (report.kit.migrateTo) options.push({ label: `Move pi-system to ${report.kit.migrateTo} delivery`, value: "kit" });
        else if (report.kit.available && report.kit.kind !== "local") options.push({ label: `pi-system ${report.kit.version} → ${report.kit.target}`, value: "kit" });
        if (report.kit.kind === "local") options.push({ label: `Pull the local pi-system checkout (git, fast-forward only)${report.kit.available ? ` → ${report.kit.target}` : ""}`, value: "kit" });
        if (report.pi.available) options.push({ label: `pi ${report.pi.current} → ${report.pi.latest}`, value: "pi" });
        if (pkgCount) options.push({ label: `${pkgCount} linked package${pkgCount === 1 ? "" : "s"}`, value: "packages" });
        const other = (report.kit.kind === "npm" || report.kit.kind === "git") && report.kit.channel === "next" ? "latest" : "next";
        options.push({ label: `Switch pi-system channel to ${other}${other === "next" ? " (tracks main)" : " (releases)"}`, value: `channel ${other}` });
        options.push({ label: "Show details", value: "status" });
        const choice = await c.ui.select(hasUpdates(report) ? summaryLine(report) : "Everything is up to date.", options.map((o) => o.label));
        if (choice === undefined) return;
        arg = options.find((o) => o.label === choice)?.value ?? "status";
        if (arg === "status") {
          c.ui.notify(formatReport(report), "info");
          return;
        }
      }

      let plan: { steps: Step[]; notes: string[] };
      if (arg.startsWith("channel")) {
        const channel = arg.slice("channel".length).trim();
        if (!channel) {
          say(c, "update: usage: /update channel <latest|next|X.Y.Z>", "error");
          return;
        }
        plan = planChannelSwitch(report, channel);
      } else if (["all", "kit", "pi", "packages"].includes(arg)) {
        plan = planUpdate(report, arg as "all" | "kit" | "pi" | "packages", pi);
      } else {
        say(c, `update: unknown option "${arg}". Use status, all, kit, pi, packages or channel <name>.`, "error");
        return;
      }

      if (plan.steps.length === 0) {
        say(c, [...plan.notes, "Nothing to update."].join("\n"), "info");
        return;
      }
      if (c.hasUI) {
        const ok = await c.ui.confirm("Apply updates?", [...plan.steps.map((s) => `• ${s.label}`), ...plan.notes.map((n) => `Note: ${n}`)].join("\n"));
        if (!ok) return;
      }

      const outcome = await runSteps(pi, c, plan.steps);
      if (!outcome.ok) return;
      const piUpdated = plan.steps.some((s) => s.args.includes("--self"));
      const reloadNeeded = plan.steps.some((s) => !s.args.includes("--self"));
      try {
        fs.rmSync(stateFile(), { force: true }); // re-check on next start
      } catch {
        /* best-effort */
      }
      say(c, [`Updated (verified): ${outcome.done.join("; ")}.`, ...plan.notes, piUpdated ? "Restart pi to run the new pi version." : "", reloadNeeded ? "Reloading..." : ""].filter(Boolean).join("\n"), "info");
      if (reloadNeeded) {
        await c.waitForIdle?.();
        await c.reload();
      }
    },
  });
}
