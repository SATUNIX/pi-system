#!/usr/bin/env node
/**
 * Offline checks for kit delivery (packages/core/distribution.json): git sources, channels,
 * release-tag selection, settings identity, and which source the installer registers from a
 * checkout, from pi's own git clone of the kit, and with the npm delivery switch.
 *
 * The installer runs in --dry-run against a scratch agent dir, so nothing touches the real pi
 * settings. `latest` over git needs `git ls-remote` and is covered by the pure functions here
 * and by tests/kit-update-smoke.mjs, not by a network call.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDistribution, parseGitSource, gitSourceFor, releaseTags, latestRelease, channelOfGitSource, isChannel, isLegacyGitSource } from "../packages/core/lib/distribution.mjs";
import { findPackageEntry, removeOtherKitEntries } from "../packages/core/lib/settings.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GIT = "git:github.com/SATUNIX/pi-system";
const LEGACY = "git:legacy.example.invalid/lab/pi-system";

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function scratch(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Dry-run the installer at `installer` with a scratch agent dir; returns the printed mode/source.
function dryRun(installer, args, { agent, env = {} } = {}) {
  const result = spawnSync(process.execPath, [installer, ...args, "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_KIT_DELIVERY: "", PI_SYSTEM_GIT_SOURCE: "", ...env },
  });
  const out = `${result.stdout}\n${result.stderr}`;
  return {
    status: result.status,
    out,
    mode: out.match(/^\s+mode:\s+(\S+.*)$/m)?.[1]?.trim() ?? null,
    source: out.match(/^\s+source:\s+(\S+)$/m)?.[1] ?? null,
  };
}

const tests = {
  "distribution.json selects git delivery from the public GitHub repository": () => {
    const d = readDistribution(undefined, {});
    assert.equal(d.delivery, "git");
    assert.equal(d.git.source, GIT);
    assert.equal(d.git.tagPrefix, "v");
    assert.ok(d.git.legacySources.every((s) => /^sha256:[a-f0-9]{64}$/.test(s)));
    assert.equal(readDistribution(undefined, { PI_KIT_DELIVERY: "npm" }).delivery, "npm");
    // The old SSH instructions told users to export the private source; it must not stick.
    const stale = readDistribution(undefined, { PI_SYSTEM_GIT_SOURCE: "git:git@legacy.example.invalid:lab/pi-system" });
    assert.equal(stale.git.source, GIT, "a retired override falls back to the public source");
    assert.equal(stale.git.ignoredEnvSource, "git:git@legacy.example.invalid:lab/pi-system");
    assert.ok(isLegacyGitSource("https://legacy.example.invalid/root/pi-system.git", d.git.legacySources));
    assert.ok(!isLegacyGitSource(GIT, d.git.legacySources));
    assert.equal(readDistribution(undefined, { PI_SYSTEM_GIT_SOURCE: "git:git@h.x:o/pi-system" }).git.source, "git:git@h.x:o/pi-system");
    assert.throws(() => readDistribution(undefined, { PI_KIT_DELIVERY: "ftp" }), /unknown kit delivery/);
  },

  "readDistribution ignores a non-object distribution.json": () => {
    const dir = scratch("pi-kit-dist-nonobject-");
    try {
      const file = path.join(dir, "distribution.json");
      for (const payload of [null, "[]", '"nope"']) {
        fs.writeFileSync(file, payload === null ? "null" : payload);
        const d = readDistribution(file, {});
        assert.equal(d.delivery, "git", `delivery for ${payload === null ? "null" : payload}`);
        assert.equal(d.git.source, "");
        assert.equal(d.git.branch, "main");
        assert.equal(d.git.tagPrefix, "v");
        assert.equal(d.npm.package, "@satunix/pi-system");
      }
      fs.writeFileSync(file, JSON.stringify({ delivery: "npm" }));
      assert.equal(readDistribution(file, {}).delivery, "npm");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  "git sources parse to pi's identity (host/path, ref ignored)": () => {
    assert.deepEqual(parseGitSource(`${GIT}@v0.2.1-beta.0`), { repo: "https://github.com/SATUNIX/pi-system", ref: "v0.2.1-beta.0", key: "github.com/satunix/pi-system" });
    assert.equal(parseGitSource("git:git@github.com:SATUNIX/pi-system").key, "github.com/satunix/pi-system");
    assert.equal(parseGitSource("https://github.com/SATUNIX/pi-system.git").repo, "https://github.com/SATUNIX/pi-system");
    assert.equal(parseGitSource("npm:@satunix/pi-system"), null);
    assert.equal(parseGitSource("/home/me/pi-system"), null);
    assert.equal(gitSourceFor(`${GIT}@v1.0.0`, "v1.1.0"), `${GIT}@v1.1.0`);
    assert.equal(gitSourceFor(`${GIT}@v1.0.0`, null), GIT);
    assert.equal(channelOfGitSource(GIT), "next");
    assert.equal(channelOfGitSource(`${GIT}@v1.0.0`), "latest");
    assert.equal(channelOfGitSource(`${GIT}@feature-x`), "feature-x");
  },

  "latest is the newest stable tag, or the newest beta before any stable release": () => {
    const lsRemote = ["a\trefs/tags/v0.2.1-beta.0", "a\trefs/tags/v0.2.1-beta.0^{}", "b\trefs/tags/v0.2.1-beta.1", "c\trefs/tags/nightly", "d\trefs/heads/main"].join("\n");
    assert.deepEqual(releaseTags(lsRemote), ["0.2.1-beta.0", "0.2.1-beta.1"]);
    assert.equal(latestRelease(releaseTags(lsRemote)), "0.2.1-beta.1");
    assert.equal(latestRelease(["0.2.0", "0.2.1-beta.4"]), "0.2.0");
    assert.equal(latestRelease([]), null);
    for (const ok of ["latest", "next", "0.2.1-beta.0", "1.0.0"]) assert.ok(isChannel(ok), ok);
    for (const bad of ["main", "v1.0.0", "1.0", "latest; rm -rf /"]) assert.ok(!isChannel(bad), bad);
  },

  "settings: one git registration of the kit, whatever its ref": () => {
    const dir = scratch("pi-kit-dist-settings-");
    try {
      const settingsPath = path.join(dir, "settings.json");
      writeJson(settingsPath, { packages: [`${GIT}@v0.2.1-beta.0`, "git:github.com/example/other-tool", "npm:pi-lens@3.8.63"] });
      const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
      assert.equal(findPackageEntry(settings, GIT, settingsPath), 0, "next and a release tag are the same package");
      assert.equal(findPackageEntry(settings, "git:git@github.com:SATUNIX/pi-system@v9.0.0", settingsPath), 0, "ssh and https forms are the same package");
      writeJson(settingsPath, { packages: [`${GIT}@v0.2.1-beta.0`, "npm:@satunix/pi-system@next", "git:github.com/example/other-tool"] });
      assert.equal(removeOtherKitEntries(settingsPath, `${GIT}@v0.2.1-beta.1`), 1, "the npm copy of the kit is removed");
      assert.deepEqual(JSON.parse(fs.readFileSync(settingsPath, "utf8")).packages, [`${GIT}@v0.2.1-beta.0`, "git:github.com/example/other-tool"]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  "installer from a checkout: local by default, the configured delivery with --channel": () => {
    const agent = scratch("pi-kit-dist-agent-");
    const installer = path.join(ROOT, "packages", "core", "install.mjs");
    try {
      const local = dryRun(installer, ["--profile", "lite"], { agent });
      assert.equal(local.status, 0, local.out);
      assert.equal(local.mode, "local");
      assert.equal(local.source, ROOT);
      const next = dryRun(installer, ["--channel", "next", "--profile", "lite"], { agent });
      assert.equal(next.mode, "git (channel next)", next.out);
      assert.equal(next.source, GIT);
      const pinned = dryRun(installer, ["--channel", "0.2.1-beta.0"], { agent });
      assert.equal(pinned.source, `${GIT}@v0.2.1-beta.0`);
      const npm = dryRun(installer, ["--channel", "next"], { agent, env: { PI_KIT_DELIVERY: "npm" } });
      assert.equal(npm.mode, "npm (channel next)", npm.out);
      assert.equal(npm.source, "npm:@satunix/pi-system@next");
      const bad = dryRun(installer, ["--channel", "main"], { agent });
      assert.notEqual(bad.status, 0);
      assert.match(bad.out, /invalid --channel/);
    } finally {
      fs.rmSync(agent, { recursive: true, force: true });
    }
  },

  "installer migrates a retired private registration to the public source and keeps hand edits": () => {
    const agent = scratch("pi-kit-dist-agent-");
    const installer = path.join(ROOT, "packages", "core", "install.mjs");
    try {
      // A user of the old private delivery: registered from GitLab, following main, with one
      // extension removed and one added by hand.
      writeJson(path.join(agent, "settings.json"), { packages: [{ source: LEGACY, extensions: ["packages/extensions/src/secret-guard/index.ts", "packages/extensions/third_party/todo/index.ts", "packages/extensions/src/save/index.ts"] }] });
      writeJson(path.join(agent, ".pi-kit.json"), { kitSource: LEGACY, channel: "next", profile: "lite", extensions: ["secret-guard", "todo"], scope: "global" });
      const run = dryRun(installer, ["--profile", "lite", "--yes", "--mode", "git"], { agent, env: { PI_SYSTEM_GIT_SOURCE: "git:git@legacy.example.invalid:lab/pi-system" } });
      // --channel is not given, so `next` (the recorded channel) is kept: no network is needed.
      assert.equal(run.status, 0, run.out);
      assert.match(run.out, /Ignoring PI_SYSTEM_GIT_SOURCE=git:git@legacy.example.invalid:lab\/pi-system/);
      assert.match(run.out, /Migrating the kit from the retired private source git:legacy.example.invalid\/lab\/pi-system/);
      assert.equal(run.mode, "git (channel next)", run.out);
      assert.equal(run.source, GIT, "registers the public source, never the private one");
      assert.match(run.out, /would write overrides/, "hand edits are captured before the old entry goes");
      assert.ok(!/pi install "git:gitlab/.test(run.out), "the private source is never installed");
    } finally {
      fs.rmSync(agent, { recursive: true, force: true });
    }
  },

  "a fork registration that is not the retired source is left alone": () => {
    const agent = scratch("pi-kit-dist-agent-");
    const installer = path.join(ROOT, "packages", "core", "install.mjs");
    try {
      const fork = "git:github.com/example/pi-system@v0.2.4-beta.0";
      writeJson(path.join(agent, "settings.json"), { packages: [fork] });
      writeJson(path.join(agent, ".pi-kit.json"), { kitSource: fork, channel: "latest", profile: "lite" });
      const run = dryRun(installer, ["--profile", "lite", "--yes", "--mode", "git"], { agent });
      assert.equal(run.status, 0, run.out);
      assert.equal(run.source, fork);
      assert.ok(!/Migrating the kit/.test(run.out));
    } finally {
      fs.rmSync(agent, { recursive: true, force: true });
    }
  },

  "installing the latest release with no tags yet fails with an actionable message": () => {
    const agent = scratch("pi-kit-dist-agent-");
    const installer = path.join(ROOT, "packages", "core", "install.mjs");
    try {
      // A local bare repository stands in for the public remote (git rewrites the URL, so no
      // network is touched): it has a main branch and no release tags.
      const remote = path.join(agent, "remote.git");
      execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
      const rewrite = (to) => ({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${to}.insteadOf`, GIT_CONFIG_VALUE_0: "https://git.example.test/o/pi-system" });
      const source = "git:git.example.test/o/pi-system";
      const run = dryRun(installer, ["--channel", "latest", "--profile", "lite"], { agent, env: { PI_SYSTEM_GIT_SOURCE: source, ...rewrite(`file://${remote.replace(/\\/g, "/")}`) } });
      assert.notEqual(run.status, 0);
      assert.match(run.out, /has no release tags \(vX\.Y\.Z\) yet\. Install --channel next/, run.out);
      const missing = `file://${path.join(agent, "missing.git").replace(/\\/g, "/")}`;
      const unreachable = dryRun(installer, ["--channel", "latest", "--profile", "lite"], { agent, env: { PI_SYSTEM_GIT_SOURCE: source, ...rewrite(missing) } });
      assert.notEqual(unreachable.status, 0);
      assert.match(unreachable.out, /could not list release tags/);
      assert.match(unreachable.out, /Check network access to the repository/);
    } finally {
      fs.rmSync(agent, { recursive: true, force: true });
    }
  },

  "installer from pi's git clone keeps the registered git source and channel": () => {
    const agent = scratch("pi-kit-dist-agent-");
    const clone = path.join(agent, "git", "github.com", "SATUNIX", "pi-system");
    try {
      // A copy of the tracked kit where pi clones git packages (a .git dir, like a real clone).
      fs.mkdirSync(clone, { recursive: true });
      const files = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "packages/core", "packages/kit/profiles", "packages/extensions", "package.json"], { cwd: ROOT, encoding: "utf8" }).split("\0").filter(Boolean);
      for (const f of files) {
        if (!fs.existsSync(path.join(ROOT, f))) continue;
        fs.mkdirSync(path.dirname(path.join(clone, f)), { recursive: true });
        fs.copyFileSync(path.join(ROOT, f), path.join(clone, f));
      }
      fs.mkdirSync(path.join(clone, ".git"));
      const tagged = `${GIT}@v0.2.1-beta.0`;
      writeJson(path.join(agent, "settings.json"), { packages: [tagged] });
      const installer = path.join(clone, "packages", "core", "install.mjs");
      const run = dryRun(installer, ["--profile", "lite", "--yes", "--settings-only"], { agent });
      assert.equal(run.status, 0, run.out);
      assert.equal(run.mode, "git (channel latest)", "a clone pi installed is never registered as a local checkout");
      assert.equal(run.source, tagged);
      writeJson(path.join(agent, ".pi-kit.json"), { kitSource: tagged, channel: "0.2.1-beta.0", profile: "lite" });
      assert.equal(dryRun(installer, ["--profile", "lite", "--settings-only"], { agent }).mode, "git (channel 0.2.1-beta.0)", "the recorded channel wins");
    } finally {
      fs.rmSync(agent, { recursive: true, force: true });
    }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}\n    ${error?.stack || error}`);
  }
}
if (failed) {
  console.error(`\n[distribution-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[distribution-smoke] all ${Object.keys(tests).length} checks passed`);
