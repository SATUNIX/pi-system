// How the kit is delivered to users: git (release tags and the main branch of the kit's git
// repository) or npm (dist-tags of the published package). packages/core/distribution.json
// holds the setting; PI_KIT_DELIVERY and PI_SYSTEM_GIT_SOURCE override it per machine.
//
// Both deliveries expose the same channels, so the installer, /profile and /update behave the
// same either way:
//   latest   the newest release (a stable release once one exists, otherwise the newest beta)
//   next     every commit on main
//   X.Y.Z    exactly that release, never moved automatically
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CORE_DIR } from "./paths.mjs";
import { parseSemver, compareSemver } from "./semver.mjs";

export const DISTRIBUTION_PATH = path.join(CORE_DIR, "distribution.json");

export function readDistribution(file = DISTRIBUTION_PATH, env = process.env) {
  let config = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) config = parsed;
  } catch {
    /* defaults below */
  }
  const delivery = (env.PI_KIT_DELIVERY || config.delivery || "git").trim();
  if (!["git", "npm"].includes(delivery)) throw new Error(`unknown kit delivery "${delivery}" (expected git or npm)`);
  return {
    delivery,
    git: {
      source: (env.PI_SYSTEM_GIT_SOURCE || config.git?.source || "").trim(),
      branch: config.git?.branch || "main",
      tagPrefix: config.git?.tagPrefix ?? "v",
    },
    npm: {
      package: config.npm?.package || "@satunix/pi-system",
    },
  };
}

const CHANNEL = /^(latest|next|\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?)$/;

export function isChannel(value) {
  return typeof value === "string" && CHANNEL.test(value);
}

// --- git sources -------------------------------------------------------------------------
// pi writes git packages as `git:<host>/<path>[@ref]`, `git:git@<host>:<path>[@ref]` or a
// protocol URL. Its package identity is host + path, ignoring the ref (see
// node_modules/@earendil-works/pi-coding-agent/dist/utils/git.js), and so is ours.

/** {repo, ref, key} of a git source, or null. `repo` is what git clones; `key` is host/path. */
export function parseGitSource(source) {
  if (typeof source !== "string") return null;
  const trimmed = source.trim();
  const hasPrefix = trimmed.startsWith("git:");
  const url = hasPrefix ? trimmed.slice(4).trim() : trimmed;
  if (!hasPrefix && !/^(https?|ssh|git):\/\//i.test(url)) return null;
  let host;
  let rest;
  let rebuild;
  const scp = url.match(/^git@([^:]+):(.+)$/);
  if (scp) {
    host = scp[1];
    rest = scp[2];
    rebuild = (p) => `git@${host}:${p}`;
  } else if (/^[a-z]+:\/\//i.test(url)) {
    const m = url.match(/^([a-z]+:\/\/[^/]+)\/(.+)$/i);
    if (!m) return null;
    host = m[1].replace(/^[a-z]+:\/\/(?:[^@/]+@)?/i, "").replace(/:\d+$/, "");
    rest = m[2];
    rebuild = (p) => `${m[1]}/${p}`;
  } else {
    const slash = url.indexOf("/");
    if (slash < 0) return null;
    host = url.slice(0, slash);
    rest = url.slice(slash + 1);
    rebuild = (p) => `https://${host}/${p}`;
  }
  const at = rest.indexOf("@");
  const repoPath = (at < 0 ? rest : rest.slice(0, at)).replace(/\.git$/, "").replace(/\/+$/, "");
  const ref = at < 0 ? null : rest.slice(at + 1) || null;
  if (!host || repoPath.split("/").length < 2) return null;
  return { repo: rebuild(repoPath), ref, key: `${host.toLowerCase()}/${repoPath.toLowerCase()}` };
}

/** The settings source for a git ref: `null` (next) is the unpinned repository, otherwise `<repo>@<ref>`. */
export function gitSourceFor(baseSource, ref) {
  const parsed = parseGitSource(baseSource);
  const base = parsed?.ref ? baseSource.slice(0, baseSource.length - parsed.ref.length - 1) : baseSource;
  return ref ? `${base}@${ref}` : base;
}

/** Release versions from `git ls-remote --tags` output (`<sha>\trefs/tags/v1.2.3`). */
export function releaseTags(lsRemoteOutput, tagPrefix = "v") {
  const versions = new Set();
  for (const line of String(lsRemoteOutput).split(/\r?\n/)) {
    const m = line.match(/\trefs\/tags\/(.+?)(\^\{\})?$/);
    if (!m || !m[1].startsWith(tagPrefix)) continue;
    const version = m[1].slice(tagPrefix.length);
    if (parseSemver(version)) versions.add(version);
  }
  return [...versions].sort(compareSemver);
}

/** The `latest` release among versions: the newest stable one, or the newest prerelease before any stable exists. */
export function latestRelease(versions) {
  const stable = versions.filter((v) => !parseSemver(v).prerelease);
  const pool = stable.length ? stable : versions;
  return pool.length ? [...pool].sort(compareSemver).at(-1) : null;
}

/** Channel implied by a registered git source when nothing else records it. */
export function channelOfGitSource(source, tagPrefix = "v") {
  const ref = parseGitSource(source)?.ref;
  if (!ref) return "next";
  return ref.startsWith(tagPrefix) && parseSemver(ref.slice(tagPrefix.length)) ? "latest" : ref;
}

/** `git ls-remote --tags` against a repository (uses the user's own git credentials). */
export function lsRemoteTags(repo, run = (args) => execFileSync("git", args, { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] })) {
  return run(["ls-remote", "--tags", repo]);
}
