#!/usr/bin/env node
/**
 * Offline checks for the kit-update extension (`/update` and the background update check).
 *
 * Everything runs against a scratch agent dir (PI_CODING_AGENT_DIR), a scratch kit root
 * (PI_KIT_ROOT), a fake registry (an injected fetch) and a fake git (injected), so nothing
 * touches the network or the real pi settings. Git delivery (release tags and main of the
 * kit's repository) and npm delivery (dist-tags) are both covered, as is the delivery switch. Covers: channel detection for every install shape, the snapshot
 * ordering `pi update` relies on, what counts as an update (and what is only a notice),
 * the exact commands /update runs, and that a failed step neither continues nor reloads.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.mjs";
import { snapshotVersion } from "../packages/core/snapshot-version.mjs";

const mod = await loadModule("extensions/kit-update/index.ts");
const { default: kitUpdate, compareVersions, parseNpmSource, parseGitSource, gitSourceWithRef, releaseTags, latestRelease, detectKitInstall, checkForUpdates, hasUpdates, summaryLine, formatReport, planUpdate, planChannelSwitch, shouldCheckNow } = mod;

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

// A kit package root as pi installs it: <agent>/npm/node_modules/@satunix/pi-system.
function makeWorld({ kitSource = "npm:@satunix/pi-system", kitVersion = "0.2.1-beta.0", packages = [], installed = {}, marker = { profile: "balanced", scope: "global" } } = {}) {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-update-agent-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-update-cwd-"));
  const kitRoot = path.join(agent, "npm", "node_modules", "@satunix", "pi-system");
  writeJson(path.join(kitRoot, "package.json"), { name: "@satunix/pi-system", version: kitVersion });
  fs.mkdirSync(path.join(kitRoot, "packages", "core"), { recursive: true });
  fs.writeFileSync(path.join(kitRoot, "packages", "core", "install.mjs"), "// stub\n");
  writeJson(path.join(kitRoot, "packages", "core", "sources.json"), { external: [{ name: "pi-lens", source: "npm:pi-lens@3.9.0" }] });
  for (const [name, version] of Object.entries(installed)) writeJson(path.join(agent, "npm", "node_modules", ...name.split("/"), "package.json"), { name, version });
  writeJson(path.join(agent, "settings.json"), { packages: [{ source: kitSource, extensions: ["packages/extensions/third_party/todo/index.ts"] }, ...packages] });
  if (marker) writeJson(path.join(agent, ".pi-kit.json"), marker);
  const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
  const restoreRoot = setEnv("PI_KIT_ROOT", kitRoot);
  return {
    agent,
    cwd,
    kitRoot,
    cleanup() {
      restoreAgent();
      restoreRoot();
      rmWorkspace(agent);
      rmWorkspace(cwd);
    },
  };
}

const GIT_SOURCE = "git:github.com/SATUNIX/pi-system";
const SHA_OLD = "1".repeat(40);
const SHA_MAIN = "2".repeat(40);

// A kit as pi clones a git package: <agent>/git/<host>/<path>, with its distribution.json.
function makeGitWorld({ kitSource = `${GIT_SOURCE}@v0.2.1-beta.0`, kitVersion = "0.2.1-beta.0", delivery = "git", marker = { profile: "balanced", scope: "global" } } = {}) {
  const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-update-agent-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-update-cwd-"));
  const kitRoot = path.join(agent, "git", "github.com", "SATUNIX", "pi-system");
  writeJson(path.join(kitRoot, "package.json"), { name: "@satunix/pi-system", version: kitVersion });
  fs.mkdirSync(path.join(kitRoot, "packages", "core"), { recursive: true });
  fs.writeFileSync(path.join(kitRoot, "packages", "core", "install.mjs"), "// stub\n");
  writeJson(path.join(kitRoot, "packages", "core", "sources.json"), { external: [] });
  writeJson(path.join(kitRoot, "packages", "core", "distribution.json"), { delivery, git: { source: GIT_SOURCE, branch: "main", tagPrefix: "v" } });
  writeJson(path.join(agent, "settings.json"), { packages: [{ source: kitSource, extensions: ["packages/extensions/third_party/todo/index.ts"] }] });
  if (marker) writeJson(path.join(agent, ".pi-kit.json"), marker);
  const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
  const restoreRoot = setEnv("PI_KIT_ROOT", undefined);
  return {
    agent,
    cwd,
    kitRoot,
    cleanup() {
      restoreAgent();
      restoreRoot();
      rmWorkspace(agent);
      rmWorkspace(cwd);
    },
  };
}

// Fake git: `ls-remote` answers with the given tags and main commit, `rev-parse HEAD` with head.
function fakeGit({ tags = [], main = SHA_MAIN, head = SHA_OLD, reachable = true, branch = "main", upstream = null, contains = false } = {}) {
  const calls = [];
  const git = async (args) => {
    calls.push(args.join(" "));
    if (args.includes("ls-remote")) {
      if (!reachable) return null;
      if (args.includes("origin")) return upstream ? `${upstream}\trefs/heads/${branch}\n` : "";
      return [...tags.map((t, i) => `${String(i + 3).repeat(40)}\trefs/tags/v${t}`), `${main}\trefs/heads/main`, `${"9".repeat(40)}\trefs/heads/feature`].join("\n") + "\n";
    }
    if (args.includes("--abbrev-ref")) return `${branch}\n`;
    if (args.includes("rev-parse")) return `${head}\n`;
    if (args.includes("merge-base")) return contains ? "" : null;
    return null;
  };
  return { git, calls };
}

function fakeRegistry(tags) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const name = decodeURIComponent(url.split("/-/package/")[1].replace("/dist-tags", ""));
    if (!(name in tags)) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => tags[name] };
  };
  return { fetchImpl, calls };
}

const TAGS = {
  "@earendil-works/pi-coding-agent": { latest: "0.87.1" },
  "@satunix/pi-system": { latest: "0.2.1-beta.1", next: "0.2.1-beta.1.next.20260930010203.gabcdef1" },
  "pi-lens": { latest: "3.9.4" },
  "pi-readseek": { latest: "0.5.0" },
  "some-tool": { latest: "2.0.0" },
};

const tests = {
  "semver precedence matches what pi update relies on": () => {
    assert.ok(compareVersions("0.2.1-beta.1", "0.2.1-beta.0") > 0);
    assert.ok(compareVersions("0.2.1", "0.2.1-beta.9") > 0);
    assert.ok(compareVersions("0.2.1-beta.10", "0.2.1-beta.9") > 0);
    assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  },

  "next snapshots sort between the release they follow and the next one": () => {
    const when = new Date("2026-09-24T06:15:00Z");
    const beta = snapshotVersion("0.2.1-beta.0", "1a2b3c4d5e", when);
    assert.equal(beta, "0.2.1-beta.0.next.20260924061500.g1a2b3c4");
    assert.ok(compareVersions(beta, "0.2.1-beta.0") > 0);
    assert.ok(compareVersions(beta, "0.2.1-beta.1") < 0);
    const later = snapshotVersion("0.2.1-beta.0", "1a2b3c4d5e", new Date("2026-09-24T06:16:00Z"));
    assert.ok(compareVersions(later, beta) > 0, "later snapshots of one base must sort higher");
    const stable = snapshotVersion("0.2.1", "0000000aaa", when);
    assert.equal(stable, "0.2.2-next.20260924061500.g0000000");
    assert.ok(compareVersions(stable, "0.2.1") > 0 && compareVersions(stable, "0.2.2") < 0);
    assert.throws(() => snapshotVersion(beta, "1a2b3c4", when), /already a snapshot/);
  },

  "parses npm sources with scopes, tags and pins": () => {
    assert.deepEqual(parseNpmSource("npm:@satunix/pi-system"), { name: "@satunix/pi-system", spec: null });
    assert.deepEqual(parseNpmSource("npm:@satunix/pi-system@next"), { name: "@satunix/pi-system", spec: "next" });
    assert.deepEqual(parseNpmSource("npm:pi-lens@3.8.63"), { name: "pi-lens", spec: "3.8.63" });
    assert.equal(parseNpmSource("git:github.com/x/y"), null);
  },

  "detects the channel of an npm install": () => {
    for (const [source, channel, pinned] of [
      ["npm:@satunix/pi-system", "latest", false],
      ["npm:@satunix/pi-system@next", "next", false],
      ["npm:@satunix/pi-system@0.2.1-beta.0", "0.2.1-beta.0", true],
    ]) {
      const w = makeWorld({ kitSource: source });
      try {
        const kit = detectKitInstall(w.cwd);
        assert.equal(kit.kind, "npm");
        assert.equal(kit.channel, channel);
        assert.equal(kit.pinned, pinned);
        assert.equal(kit.version, "0.2.1-beta.0");
      } finally {
        w.cleanup();
      }
    }
  },

  "reports kit, pi and linked package updates": async () => {
    const w = makeWorld({
      packages: ["npm:pi-lens@3.8.63", "npm:some-tool", "npm:pi-readseek@0.4.26"],
      installed: { "pi-lens": "3.8.63", "some-tool": "1.0.0", "pi-readseek": "0.4.26" },
    });
    try {
      const { fetchImpl } = fakeRegistry(TAGS);
      const report = await checkForUpdates(w.cwd, fetchImpl, "0.85.1");
      assert.equal(report.kit.available, true);
      assert.equal(report.kit.target, "0.2.1-beta.1");
      assert.equal(report.pi.available, true);
      const byName = Object.fromEntries(report.packages.map((p) => [p.name, p.action]));
      assert.deepEqual(byName, { "pi-lens": "reconcile", "some-tool": "update", "pi-readseek": "pinned" });
      assert.ok(hasUpdates(report));
      assert.match(summaryLine(report), /pi-system 0\.2\.1-beta\.0 → 0\.2\.1-beta\.1 \(latest\).*pi 0\.85\.1 → 0\.87\.1.*2 linked packages/);
    } finally {
      w.cleanup();
    }
  },

  "the next channel compares against the next dist-tag": async () => {
    const w = makeWorld({ kitSource: "npm:@satunix/pi-system@next" });
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1");
      assert.equal(report.kit.target, TAGS["@satunix/pi-system"].next);
      assert.equal(report.kit.available, true);
      assert.equal(report.pi.available, false);
    } finally {
      w.cleanup();
    }
  },

  "a pinned kit and pinned-only packages are notices, not updates": async () => {
    const w = makeWorld({ kitSource: "npm:@satunix/pi-system@0.2.1-beta.0", packages: ["npm:pi-readseek@0.4.26"], installed: { "pi-readseek": "0.4.26" } });
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1");
      assert.equal(report.kit.available, false);
      assert.match(report.kit.note, /pinned/);
      assert.equal(hasUpdates(report), false);
      assert.equal(summaryLine(report), "Everything is up to date.");
    } finally {
      w.cleanup();
    }
  },

  "an unreachable registry reports nothing available and flags it": async () => {
    const w = makeWorld();
    try {
      const report = await checkForUpdates(w.cwd, async () => { throw new Error("ENOTFOUND"); }, "0.85.1");
      assert.equal(report.offline, true);
      assert.equal(hasUpdates(report), false);
    } finally {
      w.cleanup();
    }
  },

  "update all updates the kit, packages and pi, then re-applies the profile": async () => {
    const w = makeWorld({ packages: ["npm:pi-lens@3.8.63", "npm:some-tool"], installed: { "pi-lens": "3.8.63", "some-tool": "1.0.0" } });
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.85.1");
      const { steps } = planUpdate(report, "all");
      const argv = steps.map((s) => s.args.join(" "));
      assert.equal(argv[0], "update npm:@satunix/pi-system");
      assert.equal(argv[1], "update npm:some-tool");
      assert.ok(argv[2].endsWith("install.mjs --profile balanced --yes --settings-only --scope global"), argv[2]);
      assert.equal(argv[3], "update --self", "pi updates last (it needs a restart)");
    } finally {
      w.cleanup();
    }
  },

  "a project marker wins over the global marker for update plans": async () => {
    const w = makeWorld({ marker: { profile: "global-prof", scope: "global" } });
    try {
      writeJson(path.join(w.cwd, ".pi", ".pi-kit.json"), { profile: "proj-prof", scope: "project", kitSource: "npm:@satunix/pi-system" });
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.85.1");
      assert.equal(report.cwd, w.cwd, "the report records the cwd the check ran in");
      const { steps, notes } = planUpdate(report, "all");
      const reconcile = steps.find((s) => s.label === "re-apply the proj-prof profile");
      assert.ok(reconcile, "the project marker's profile must be reconciled, not the global one");
      assert.ok(reconcile.args.join(" ").endsWith("install.mjs --profile proj-prof --yes --settings-only --scope project"), reconcile.args.join(" "));
      assert.ok(!notes.some((n) => /No recorded profile to re-apply/.test(n)), "the project marker must supply the profile");
    } finally {
      w.cleanup();
    }
  },

  "channel switch rewrites the kit source with pi install and re-applies the profile": async () => {
    const w = makeWorld();
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1");
      const next = planChannelSwitch(report, "next").steps.map((s) => s.args.join(" "));
      assert.equal(next[0], "install npm:@satunix/pi-system@next");
      assert.ok(next[1].includes("--profile balanced"));
      assert.equal(planChannelSwitch(report, "latest").steps[0].args.join(" "), "install npm:@satunix/pi-system");
      assert.equal(planChannelSwitch(report, "beta; rm -rf /").steps.length, 0, "channel names are validated");
    } finally {
      w.cleanup();
    }
  },

  "an update whose command exits 0 but changed nothing is reported as a failure, never as success": async () => {
    const w = makeWorld();
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeRegistry(TAGS).fetchImpl;
    try {
      const pi = fakePi();
      kitUpdate(pi.api);
      const calls = [];
      pi.api.exec = async (command, args) => {
        calls.push(args.join(" "));
        return { stdout: "Already up to date", stderr: "", code: 0 };
      };
      const notes = [];
      let reloaded = 0;
      const ctx = {
        hasUI: true,
        cwd: w.cwd,
        ui: { notify: (m, l) => notes.push({ m, l }), setStatus() {}, confirm: async () => true, select: async () => undefined },
        reload: async () => { reloaded++; },
      };
      await pi.commands.get("update").handler("kit", ctx);
      assert.equal(calls.length, 1, "later steps are not run after a failed verification");
      assert.equal(reloaded, 0, "no reload after an update that did not happen");
      const error = notes.find((n) => n.l === "error");
      assert.ok(error && /did not take effect/.test(error.m) && /still 0\.2\.1-beta\.0|is 0\.2\.1-beta\.0/.test(error.m), error?.m);
      assert.ok(!notes.some((n) => /Updated/.test(n.m)), "no success message");
    } finally {
      globalThis.fetch = realFetch;
      w.cleanup();
    }
  },

  "a session without a UI still gets the outcome, on stderr": async () => {
    const w = makeWorld();
    const realFetch = globalThis.fetch;
    const realWrite = process.stderr.write.bind(process.stderr);
    globalThis.fetch = fakeRegistry(TAGS).fetchImpl;
    const written = [];
    try {
      const pi = fakePi();
      kitUpdate(pi.api);
      pi.api.exec = async () => ({ stdout: "", stderr: "npm ERR! network", code: 1 });
      process.stderr.write = (chunk) => { written.push(String(chunk)); return true; };
      const ctx = { hasUI: false, cwd: w.cwd, ui: {}, reload: async () => {} };
      await pi.commands.get("update").handler("", ctx);
      await pi.commands.get("update").handler("kit", ctx);
      await pi.commands.get("update").handler("bogus", ctx);
      process.stderr.write = realWrite;
      const text = written.join("");
      assert.match(text, /pi-system update status/, "no argument prints the status instead of doing nothing");
      assert.match(text, /Non-interactive session/);
      assert.match(text, /"update pi-system to [^"]+" failed: exit 1[\s\S]*npm ERR! network/, "a failed step is reported with its output");
      assert.match(text, /unknown option "bogus"/);
    } finally {
      process.stderr.write = realWrite;
      globalThis.fetch = realFetch;
      w.cleanup();
    }
  },

  "an install registered from the retired private source migrates to the public one without contacting it": async () => {
    const legacy = "git:gitlab.home.internal/lab/pi-system";
    const w = makeGitWorld({ kitSource: `${legacy}@v0.2.1-beta.0`, marker: { profile: "balanced", scope: "global", channel: "0.2.1-beta.0", kitSource: `${legacy}@v0.2.1-beta.0` } });
    const restoreEnv = setEnv("PI_SYSTEM_GIT_SOURCE", "git:git@gitlab.home.internal:lab/pi-system");
    try {
      const { git, calls } = fakeGit({ tags: ["0.2.4-beta.0"] });
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", git);
      assert.equal(report.kit.legacy, true);
      assert.equal(report.kit.available, true);
      assert.deepEqual(calls.filter((c) => c.includes("ls-remote")), [], "the retired remote is never contacted");
      assert.match(report.kit.note, /retired private source/);
      assert.match(report.kit.note, /PI_SYSTEM_GIT_SOURCE=git:git@gitlab.home.internal:lab\/pi-system names the retired source and is ignored/);
      assert.match(summaryLine(report), /retired private source/);
      assert.match(formatReport(report), /retired private source/);
      const plan = planUpdate(report, "kit");
      assert.equal(plan.steps.length, 1);
      const args = plan.steps[0].args.join(" ");
      assert.match(args, /install\.mjs --mode git --channel latest --profile balanced --yes$/, args);
      assert.ok(!/gitlab/.test(args), "the plan never names the private host");
      // A user following main stays on main.
      writeJson(path.join(w.agent, ".pi-kit.json"), { profile: "balanced", scope: "global", channel: "next", kitSource: legacy });
      writeJson(path.join(w.agent, "settings.json"), { packages: [{ source: legacy, extensions: [] }] });
      const next = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", git);
      assert.match(planUpdate(next, "kit").steps[0].args.join(" "), /--channel next/);
    } finally {
      restoreEnv();
      w.cleanup();
    }
  },

  "a stale PI_SYSTEM_GIT_SOURCE naming the retired source is ignored, other overrides are kept": () => {
    const restore = setEnv("PI_SYSTEM_GIT_SOURCE", "git:git@gitlab.home.internal:lab/pi-system");
    try {
      const d = mod.readDistribution(null);
      assert.equal(d.gitSource, null, "no source is invented from the retired override");
      assert.equal(d.ignoredEnvSource, "git:git@gitlab.home.internal:lab/pi-system");
      assert.ok(mod.isLegacyGitSource("https://gitlab.home.internal/root/pi-system.git"));
      assert.ok(!mod.isLegacyGitSource("git:github.com/SATUNIX/pi-system"));
      assert.ok(!mod.isLegacyGitSource("git:github.com/example/pi-system"));
      process.env.PI_SYSTEM_GIT_SOURCE = "git:github.com/example/pi-system";
      const fork = mod.readDistribution(null);
      assert.equal(fork.gitSource, "git:github.com/example/pi-system", "a fork override is the user's choice");
      assert.equal(fork.ignoredEnvSource, null);
    } finally {
      restore();
    }
  },

  "/update runs the confirmed plan, stops on failure and does not reload": async () => {
    const w = makeWorld({ packages: ["npm:some-tool"], installed: { "some-tool": "1.0.0" } });
    const realFetch = globalThis.fetch;
    globalThis.fetch = fakeRegistry(TAGS).fetchImpl;
    try {
      const pi = fakePi();
      kitUpdate(pi.api);
      const calls = [];
      let failAt = 1;
      pi.api.exec = async (command, args) => {
        calls.push(args.join(" "));
        return { stdout: "", stderr: calls.length === failAt ? "boom" : "", code: calls.length === failAt ? 1 : 0 };
      };
      const notes = [];
      let reloaded = 0;
      const ctx = {
        hasUI: true,
        cwd: w.cwd,
        ui: { notify: (m, l) => notes.push({ m, l }), setStatus() {}, confirm: async () => true, select: async () => undefined },
        reload: async () => { reloaded++; },
      };
      const handler = pi.commands.get("update").handler;
      await handler("all", ctx);
      assert.equal(calls.length, 1, "must stop at the first failing step");
      assert.equal(reloaded, 0, "a failed update must not reload");
      assert.ok(notes.some((n) => n.l === "error" && /failed/.test(n.m)));

      failAt = 0;
      calls.length = 0;
      // A real `pi update` moves the installed package; simulate that effect so the post-update
      // verification (the update must have taken effect, not merely exited 0) can confirm it.
      pi.api.exec = async (command, args) => {
        calls.push(args.join(" "));
        if (args[0] === "update" && args[1] === "npm:@satunix/pi-system") writeJson(path.join(w.kitRoot, "package.json"), { name: "@satunix/pi-system", version: TAGS["@satunix/pi-system"].latest });
        // The installer rewrites the install marker when it re-applies the profile.
        if (String(args[0]).endsWith("install.mjs")) writeJson(path.join(w.agent, ".pi-kit.json"), { profile: "balanced", scope: "global", installedAt: new Date().toISOString() });
        return { stdout: "", stderr: "", code: 0 };
      };
      await handler("kit", ctx);
      assert.deepEqual(calls[0], "update npm:@satunix/pi-system");
      assert.equal(reloaded, 1, "a successful kit update reloads");
      assert.ok(notes.some((n) => /Updated \(verified\)/.test(n.m)), "success says the result was verified");

      await handler("status", ctx);
      assert.ok(notes.at(-1).m.includes("pi-system update status"));
    } finally {
      globalThis.fetch = realFetch;
      w.cleanup();
    }
  },

  "parses git sources the way pi identifies them": () => {
    assert.deepEqual(parseGitSource("git:github.com/SATUNIX/pi-system@v0.2.1-beta.0"), { repo: "https://github.com/SATUNIX/pi-system", host: "github.com", path: "SATUNIX/pi-system", ref: "v0.2.1-beta.0" });
    assert.deepEqual(parseGitSource("git:git@github.com:SATUNIX/pi-system"), { repo: "git@github.com:SATUNIX/pi-system", host: "github.com", path: "SATUNIX/pi-system", ref: null });
    assert.equal(parseGitSource("npm:x"), null);
    assert.equal(gitSourceWithRef(`${GIT_SOURCE}@v1.0.0`, "v1.1.0"), `${GIT_SOURCE}@v1.1.0`);
    assert.equal(gitSourceWithRef(`${GIT_SOURCE}@v1.0.0`, null), GIT_SOURCE);
    assert.deepEqual(releaseTags("a\trefs/tags/v0.2.1-beta.0\nb\trefs/tags/v0.2.1-beta.0^{}\nc\trefs/tags/junk\nd\trefs/tags/v0.2.0\n"), ["0.2.0", "0.2.1-beta.0"]);
    assert.equal(latestRelease(["0.2.1-beta.0", "0.2.1-beta.1"]), "0.2.1-beta.1", "betas are latest until a stable release exists");
    assert.equal(latestRelease(["0.2.0", "0.2.1-beta.3"]), "0.2.0", "then latest is the newest stable release");
  },

  "detects the channel of a git install": () => {
    for (const [source, marker, channel, pinned] of [
      [`${GIT_SOURCE}@v0.2.1-beta.0`, { profile: "balanced" }, "latest", false],
      [GIT_SOURCE, { profile: "balanced" }, "next", false],
      [`${GIT_SOURCE}@v0.2.1-beta.0`, { profile: "balanced", kitSource: `${GIT_SOURCE}@v0.2.1-beta.0`, channel: "0.2.1-beta.0" }, "0.2.1-beta.0", true],
    ]) {
      const w = makeGitWorld({ kitSource: source, marker });
      try {
        const kit = detectKitInstall(w.cwd);
        assert.equal(kit.kind, "git");
        assert.equal(kit.channel, channel);
        assert.equal(kit.pinned, pinned);
        assert.equal(kit.root, w.kitRoot, "the kit root is pi's clone of the git source");
        assert.equal(kit.version, "0.2.1-beta.0");
      } finally {
        w.cleanup();
      }
    }
  },

  "git latest: a newer release tag is an update, applied by re-pointing the tag": async () => {
    const w = makeGitWorld();
    try {
      const { git } = fakeGit({ tags: ["0.2.1-beta.0", "0.2.1-beta.1"] });
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", git);
      assert.equal(report.kit.available, true);
      assert.equal(report.kit.target, "0.2.1-beta.1");
      assert.equal(report.kit.tags.latest, "0.2.1-beta.1");
      assert.match(summaryLine(report), /pi-system 0\.2\.1-beta\.0 → 0\.2\.1-beta\.1 \(latest\)/);
      assert.match(formatReport(report), /\[git, channel latest\]/);
      const argv = planUpdate(report, "kit").steps.map((s) => s.args.join(" "));
      assert.equal(argv[0], `install ${GIT_SOURCE}@v0.2.1-beta.1`);
      assert.ok(argv[1].endsWith("install.mjs --profile balanced --yes --settings-only --scope global"), argv[1]);
    } finally {
      w.cleanup();
    }
  },

  "git latest: up to date when the newest tag is installed": async () => {
    const w = makeGitWorld();
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ tags: ["0.2.1-beta.0"] }).git);
      assert.equal(report.kit.available, false);
      assert.equal(hasUpdates(report), false);
    } finally {
      w.cleanup();
    }
  },

  "git next: a new commit on main is an update, applied with pi update": async () => {
    const w = makeGitWorld({ kitSource: GIT_SOURCE });
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ head: SHA_OLD, main: SHA_MAIN }).git);
      assert.equal(report.kit.available, true);
      assert.equal(report.kit.target, `main@${SHA_MAIN.slice(0, 7)}`);
      assert.equal(planUpdate(report, "kit").steps[0].args.join(" "), `update ${GIT_SOURCE}`);
      const same = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ head: SHA_MAIN, main: SHA_MAIN }).git);
      assert.equal(same.kit.available, false);
    } finally {
      w.cleanup();
    }
  },

  "git pinned: newer tags are a notice, not an update": async () => {
    const w = makeGitWorld({ marker: { profile: "balanced", kitSource: `${GIT_SOURCE}@v0.2.1-beta.0`, channel: "0.2.1-beta.0" } });
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ tags: ["0.2.1-beta.0", "0.2.1-beta.1"] }).git);
      assert.equal(report.kit.available, false);
      assert.match(report.kit.note, /pinned to 0\.2\.1-beta\.0/);
    } finally {
      w.cleanup();
    }
  },

  "git unreachable: nothing available, flagged, never prompts": async () => {
    const w = makeGitWorld();
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ reachable: false }).git);
      assert.equal(report.offline, true);
      assert.equal(report.kit.available, false);
      assert.match(report.kit.note, /could not reach https:\/\/github\.com\/SATUNIX\/pi-system/);
    } finally {
      w.cleanup();
    }
  },

  "a project-scoped install runs the installer in the project, not the kit root": async () => {
    const w = makeGitWorld(); // a global marker lives in the agent dir
    try {
      // Project settings entry, but no project marker: the inconsistent state where the
      // settings entry is authoritative for the scope.
      writeJson(path.join(w.cwd, ".pi", "settings.json"), {
        packages: [{ source: GIT_SOURCE, extensions: ["packages/extensions/third_party/todo/index.ts"] }],
      });
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ tags: ["0.2.1-beta.0", "0.2.1-beta.1"] }).git);
      assert.equal(report.kit.scope, "project", "the project settings entry makes the install project-scoped");

      const reconcile = planUpdate(report, "all").steps.find((s) => s.label.startsWith("re-apply"));
      assert.ok(reconcile, "the recorded profile must be re-applied");
      assert.ok(reconcile.args.join(" ").endsWith("--scope project"), reconcile.args.join(" "));
      assert.equal(reconcile.cwd, w.cwd, "reconcile must run install.mjs in the project");
      assert.notEqual(reconcile.cwd, w.kitRoot);

      const installer = planChannelSwitch(report, "next").steps.find((s) => s.label.includes("switch pi-system"));
      assert.ok(installer, "the channel switch must go through the kit installer");
      assert.ok(installer.args.join(" ").includes("--scope project"), installer.args.join(" "));
      assert.equal(installer.cwd, w.cwd, "installer must run install.mjs in the project");
      assert.notEqual(installer.cwd, w.kitRoot);
    } finally {
      w.cleanup();
    }
  },

  "a global-scope update still runs the installer from the kit root": async () => {
    const w = makeWorld();
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.85.1");
      const reconcile = planUpdate(report, "all").steps.find((s) => s.label.startsWith("re-apply"));
      assert.ok(reconcile, "the recorded profile must be re-applied");
      assert.ok(reconcile.args.join(" ").endsWith("--scope global"), reconcile.args.join(" "));
      assert.equal(reconcile.cwd, w.kitRoot, "global scope keeps the kit root as the installer cwd");
    } finally {
      w.cleanup();
    }
  },

  "the real installer writes the project settings and marker under the project, not the kit root": () => {
    const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-update-project-install-"));
    const project = path.join(dir, "project");
    const kitRoot = path.join(dir, "kitroot");
    const agent = path.join(dir, "agent");
    const binDir = path.join(dir, "bin");
    try {
      for (const d of [project, kitRoot, agent, binDir]) fs.mkdirSync(d, { recursive: true });
      // A fake `pi` first on PATH only has to answer `--version`: the kit is pre-registered, so
      // the installer takes the settings-only path and never calls `pi install`.
      const fakePi = path.join(binDir, "pi");
      fs.writeFileSync(fakePi, "#!/bin/sh\nexit 0\n");
      fs.chmodSync(fakePi, 0o755);
      // Project settings entry, but only a global marker: the inconsistent state where the
      // settings entry is authoritative for scope.
      writeJson(path.join(project, ".pi", "settings.json"), { packages: [repoRoot] });
      writeJson(path.join(agent, ".pi-kit.json"), { profile: "balanced", scope: "global" });
      const env = {
        ...process.env,
        PI_CODING_AGENT_DIR: agent,
        PI_LEAN_CTX_BIN: path.join(agent, "no-lean-ctx"),
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
      };
      // Drive the caller's reconcile step rather than install.mjs directly, so the plan's cwd
      // and args are what the real installer actually receives.
      const report = {
        kit: { kind: "npm", root: repoRoot, source: "npm:@satunix/pi-system", scope: "project", available: true, target: "0.2.1-beta.1", channel: "latest" },
        packages: [],
        pi: { available: false },
        cwd: project,
      };
      const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
      let step;
      try {
        step = planUpdate(report, "kit").steps.find((s) => s.label.startsWith("re-apply"));
      } finally {
        restoreAgent();
      }
      assert.ok(step, "the project settings entry must yield a reconcile step");
      assert.equal(step.args[step.args.indexOf("--scope") + 1], "project", step.args.join(" "));
      assert.equal(step.cwd, project, "the reconcile step must run install.mjs in the project");
      assert.notEqual(step.cwd, kitRoot);

      const result = spawnSync(step.command, step.args, { cwd: step.cwd, env, encoding: "utf8" });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const marker = path.join(project, ".pi", ".pi-kit.json");
      assert.ok(fs.existsSync(marker), "the project marker must be written under the project");
      assert.equal(JSON.parse(fs.readFileSync(marker, "utf8")).scope, "project");
      // The profile filter is written to the project settings file too, not just the marker.
      const settings = JSON.parse(fs.readFileSync(path.join(project, ".pi", "settings.json"), "utf8"));
      const entry = (settings.packages ?? []).find((p) => {
        const source = typeof p === "string" ? p : p?.source;
        return typeof source === "string" && path.resolve(project, ".pi", source) === repoRoot;
      });
      assert.ok(entry, "the project settings entry must be written under the project");
      assert.ok(Array.isArray(entry.extensions) && entry.extensions.length > 0, "the profile's extension filter must reach the project settings");
      assert.ok(!fs.existsSync(path.join(kitRoot, ".pi")), "the kit root must not gain a .pi/ directory");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },

  "git channel switch goes through the kit installer, then re-applies the profile": async () => {
    const w = makeGitWorld();
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ tags: ["0.2.1-beta.0"] }).git);
      for (const channel of ["next", "latest", "0.2.1-beta.0"]) {
        const argv = planChannelSwitch(report, channel).steps.map((s) => s.args.join(" "));
        assert.ok(argv[0].endsWith(`install.mjs --mode git --channel ${channel} --profile balanced --yes --settings-only`), argv[0]);
        assert.ok(argv[1].endsWith("install.mjs --profile balanced --yes --settings-only --scope global"), argv[1]);
      }
      assert.equal(planChannelSwitch(report, "main; rm -rf /").steps.length, 0);
    } finally {
      w.cleanup();
    }
  },

  "a kit release that changes the delivery moves the install over": async () => {
    const w = makeGitWorld({ delivery: "npm" });
    try {
      const report = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ tags: ["0.2.1-beta.0"] }).git);
      assert.equal(report.kit.migrateTo, "npm");
      assert.ok(hasUpdates(report));
      assert.match(summaryLine(report), /moves to npm delivery/);
      const argv = planUpdate(report, "kit").steps.map((s) => s.args.join(" "));
      assert.equal(argv.length, 1);
      assert.ok(argv[0].endsWith("install.mjs --mode npm --channel latest --profile balanced --yes"), argv[0]);
    } finally {
      w.cleanup();
    }
  },

  "a local checkout is behind only when upstream has commits it does not contain": async () => {
    const w = makeWorld({ kitSource: "../kit" });
    try {
      // Register the scratch kit root as a local path.
      writeJson(path.join(w.agent, "settings.json"), { packages: [{ source: w.kitRoot }] });
      const behind = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ head: SHA_OLD, upstream: SHA_MAIN, contains: false }).git);
      assert.equal(behind.kit.kind, "local");
      assert.equal(behind.kit.available, true);
      assert.equal(planUpdate(behind, "all").steps[0].args.join(" "), `-C ${w.kitRoot} pull --ff-only`);
      const ahead = await checkForUpdates(w.cwd, fakeRegistry(TAGS).fetchImpl, "0.87.1", fakeGit({ head: SHA_OLD, upstream: SHA_MAIN, contains: true }).git);
      assert.equal(ahead.kit.available, false, "local commits ahead of upstream are not an update");
    } finally {
      w.cleanup();
    }
  },

  "the background check is throttled": () => {
    const w = makeWorld();
    try {
      assert.equal(shouldCheckNow(), true);
      writeJson(path.join(w.agent, "pi-kit", "update-check.json"), { checkedAt: new Date().toISOString() });
      assert.equal(shouldCheckNow(), false);
      assert.equal(shouldCheckNow(Date.now() + 25 * 60 * 60 * 1000), true);
    } finally {
      w.cleanup();
    }
  },

  "session start does nothing without a UI or when disabled": async () => {
    const w = makeWorld();
    const restore = setEnv("PI_KIT_UPDATE_CHECK", "0");
    try {
      const pi = fakePi();
      kitUpdate(pi.api);
      let fetched = 0;
      const realFetch = globalThis.fetch;
      globalThis.fetch = async () => { fetched++; return { ok: false, json: async () => ({}) }; };
      try {
        await pi.handlers.get("session_start")({}, { hasUI: true, cwd: w.cwd, ui: { notify() {}, setStatus() {} } });
        restore();
        await pi.handlers.get("session_start")({}, { hasUI: false, cwd: w.cwd, ui: { notify() {}, setStatus() {} } });
      } finally {
        globalThis.fetch = realFetch;
      }
      assert.equal(fetched, 0);
    } finally {
      restore();
      w.cleanup();
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
  console.error(`\n[kit-update-smoke] ${failed} check(s) failed`);
  process.exit(1);
}
console.log(`\n[kit-update-smoke] all ${Object.keys(tests).length} checks passed`);
