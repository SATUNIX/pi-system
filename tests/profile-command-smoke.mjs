#!/usr/bin/env node
/**
 * Offline checks for session-helpers' `/profile` command.
 *
 * `/profile` is the TUI front-end to the same profile switch the CLI installer
 * performs: it locates the kit checkout, picks a profile, spawns
 * `node <installer> --profile <name> --yes --settings-only` (no verify gate, no
 * re-registration), and reloads. These tests drive the
 * real command handler with a fake pi API and a fake `pi.exec`, so nothing is
 * installed and no real settings are written.
 *
 * Guards the failure modes that matter: an unknown profile must not run the
 * installer, switching to the current profile must be a no-op, an installer
 * non-zero exit must surface the error AND must not reload, and the argv handed
 * to the installer must be exactly the documented one. Both supported kit
 * layouts are covered: the monorepo (packages/core/install.mjs +
 * packages/kit/profiles) and a legacy flat kit (kit/install.mjs + profiles/).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, loadModule, rmWorkspace, setEnv } from "../packages/core/eval/harness.mjs";

const mod = await loadModule("extensions/session-helpers/index.ts");
const { default: sessionHelpers, findKitRoot, listProfiles, resolveKitLayout, loadedKitExtensions, unfilteredNpmKitEntry, unfilteredKitEntry } = mod;

function writeProfiles(profilesDir) {
  fs.mkdirSync(profilesDir, { recursive: true });
  fs.writeFileSync(
    path.join(profilesDir, "autonomous.json"),
    JSON.stringify({ name: "autonomous", description: "set-and-walk-away" }),
  );
  fs.writeFileSync(
    path.join(profilesDir, "balanced.json"),
    JSON.stringify({ name: "balanced", description: "daily driver" }),
  );
  fs.writeFileSync(
    path.join(profilesDir, "self-improving.json"),
    JSON.stringify({ name: "self-improving", description: "full capability" }),
  );
}

// Legacy flat kit checkout: <root>/kit/install.mjs + <root>/profiles/.
function makeKitRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-root-"));
  fs.mkdirSync(path.join(root, "kit"), { recursive: true });
  fs.writeFileSync(path.join(root, "kit", "install.mjs"), "// stub\n");
  writeProfiles(path.join(root, "profiles"));
  return root;
}

// Monorepo checkout: <root>/packages/core/install.mjs + <root>/packages/kit/profiles/.
function makeMonorepoRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-mono-"));
  fs.mkdirSync(path.join(root, "packages", "core"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "core", "install.mjs"), "// stub\n");
  writeProfiles(path.join(root, "packages", "kit", "profiles"));
  return root;
}

function makeAgentDir(currentProfile, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-agent-"));
  fs.writeFileSync(
    path.join(dir, ".pi-kit.json"),
    JSON.stringify({ kitSource: "/nonexistent", profile: currentProfile, ...extra }),
  );
  return dir;
}

// Wires the real command into a fake pi, and captures every pi.exec invocation.
function loadCommand() {
  const pi = fakePi();
  sessionHelpers(pi.api);
  const calls = [];
  pi.api.exec = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: "", stderr: "", code: pi.execCode ?? 0 };
  };
  return { pi, calls, handler: pi.commands.get("profile").handler };
}

function fakeCtx({ hasUI = false, select, confirm } = {}) {
  const ctx = {
    hasUI,
    notes: [],
    statuses: [],
    reloaded: 0,
    ui: {
      notify: (message, level) => ctx.notes.push({ message, level }),
      select: select ?? (async () => undefined),
      confirm: confirm ?? (async () => true),
      setStatus: (key, value) => ctx.statuses.push({ key, value }),
    },
  };
  ctx.reload = async () => {
    ctx.reloaded += 1;
  };
  return ctx;
}

const tests = {
  "an npm kit entry (any channel) is the kit's own entry for an installed copy": async () => {
    const root = makeMonorepoRoot();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@satunix/pi-system", version: "0.2.1-beta.0" }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-npm-"));
    const settings = path.join(dir, "settings.json");
    try {
      fs.writeFileSync(settings, JSON.stringify({ packages: ["npm:pi-lens@3.8.63", { source: "npm:@satunix/pi-system@next", extensions: ["packages/extensions/third_party/todo/index.ts", "packages/extensions/src/save/index.ts"] }] }));
      assert.deepEqual(loadedKitExtensions(settings, root), ["todo", "save"]);
      assert.equal(unfilteredNpmKitEntry(settings), false);
      fs.writeFileSync(settings, JSON.stringify({ packages: ["npm:@satunix/pi-system"] }));
      assert.equal(loadedKitExtensions(settings, root), null, "a bare npm entry is unfiltered");
      assert.equal(unfilteredNpmKitEntry(settings), true);
    } finally {
      rmWorkspace(root);
      rmWorkspace(dir);
    }
  },

  "a git kit entry (any ref, https or ssh form) is the kit's own entry for pi's clone": async () => {
    const root = makeMonorepoRoot();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@satunix/pi-system", version: "0.2.1-beta.0" }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-git-"));
    const settings = path.join(dir, "settings.json");
    try {
      fs.writeFileSync(settings, JSON.stringify({ packages: [{ source: "git:github.com/SATUNIX/pi-system@v0.2.1-beta.0", extensions: ["packages/extensions/third_party/todo/index.ts"] }] }));
      assert.deepEqual(loadedKitExtensions(settings, root), ["todo"]);
      assert.equal(unfilteredKitEntry(settings), false);
      for (const bare of ["git:github.com/SATUNIX/pi-system", "git:git@github.com:SATUNIX/pi-system@v0.2.1-beta.0"]) {
        fs.writeFileSync(settings, JSON.stringify({ packages: [bare] }));
        assert.equal(unfilteredKitEntry(settings), true, bare);
      }
      fs.writeFileSync(settings, JSON.stringify({ packages: ["git:github.com/example/other-tool"] }));
      assert.equal(unfilteredKitEntry(settings), false, "other git packages are not the kit");
    } finally {
      rmWorkspace(root);
      rmWorkspace(dir);
    }
  },

  "a bare npm install gets the default profile applied on the first interactive session": async () => {
    const root = makeMonorepoRoot();
    const agent = makeAgentDir("balanced");
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["npm:@satunix/pi-system"] }));
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { pi, calls } = loadCommand();
      const start = pi.handlers.get("session_start");
      await start({}, fakeCtx({ hasUI: false }));
      assert.equal(calls.length, 0, "print/JSON sessions never rewrite settings");
      const ctx = fakeCtx({ hasUI: true });
      await start({}, ctx);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args.slice(1), ["--profile", "balanced", "--yes", "--settings-only", "--scope", "global"]);
      assert.equal(calls[0].options.cwd, root, "a global auto-profile runs the installer from the kit root");
      assert.ok(ctx.notes.some((n) => /applied the "balanced" profile/.test(n.message)));
      const restoreOff = setEnv("PI_KIT_AUTO_PROFILE", "0");
      try {
        await start({}, fakeCtx({ hasUI: true }));
        assert.equal(calls.length, 1, "PI_KIT_AUTO_PROFILE=0 turns it off");
      } finally {
        restoreOff();
      }
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "a project-scoped auto-profile runs the installer in the project": async () => {
    const root = makeMonorepoRoot();
    const agent = makeAgentDir("balanced");
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-project-auto-"));
    fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@satunix/pi-system"] }));
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { pi, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      ctx.cwd = project;
      await pi.handlers.get("session_start")({}, ctx);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args.slice(1), ["--profile", "balanced", "--yes", "--settings-only", "--scope", "project"]);
      assert.equal(calls[0].options.cwd, project, "a project auto-profile must run install.mjs in the project");
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
      rmWorkspace(project);
    }
  },

  "registers /profile with a description": async () => {
    const pi = fakePi();
    sessionHelpers(pi.api);
    assert.ok(pi.commands.has("profile"), "/profile must be registered");
    assert.ok(pi.commands.get("profile").description.length > 0);
  },

  "findKitRoot honours PI_KIT_ROOT (legacy layout)": async () => {
    const root = makeKitRoot();
    const restore = setEnv("PI_KIT_ROOT", root);
    try {
      assert.equal(findKitRoot(), root);
    } finally {
      restore();
      rmWorkspace(root);
    }
  },

  "findKitRoot honours PI_KIT_ROOT (monorepo layout)": async () => {
    const root = makeMonorepoRoot();
    const restore = setEnv("PI_KIT_ROOT", root);
    try {
      assert.equal(findKitRoot(), root);
    } finally {
      restore();
      rmWorkspace(root);
    }
  },

  "resolveKitLayout finds the monorepo installer and profiles": async () => {
    const root = makeMonorepoRoot();
    try {
      const layout = resolveKitLayout(root);
      assert.ok(layout, "monorepo layout must resolve");
      assert.equal(layout.installer, path.join(root, "packages", "core", "install.mjs"));
      assert.equal(layout.profilesDir, path.join(root, "packages", "kit", "profiles"));
    } finally {
      rmWorkspace(root);
    }
  },

  "resolveKitLayout rejects a non-kit directory": async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-empty-"));
    try {
      assert.equal(resolveKitLayout(dir), null);
    } finally {
      rmWorkspace(dir);
    }
  },

  // A checkout, git clone and npm install all keep the monorepo layout, so with no override
  // and no usable marker the kit is the package the extension was loaded from (here: this
  // repository). This is what makes /profile work after `pi install npm:@satunix/pi-system`.
  "findKitRoot falls back to the package it was loaded from": async () => {
    const agent = makeAgentDir("balanced", { kitSource: "npm:@satunix/pi-system" });
    const restoreRoot = setEnv("PI_KIT_ROOT", undefined);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
      assert.equal(findKitRoot(), repoRoot);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(agent);
    }
  },

  // F1: a marker file containing the literal JSON `null` must not make readMarker return
  // null and findKitRoot dereference it. The reader must fall back to {} and findKitRoot
  // must fall through to the package it was loaded from, exactly as for a missing marker.
  "findKitRoot survives a null JSON marker": async () => {
    const agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-null-marker-"));
    fs.writeFileSync(path.join(agent, ".pi-kit.json"), "null");
    const restoreRoot = setEnv("PI_KIT_ROOT", undefined);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
      assert.equal(findKitRoot(), repoRoot, "a null marker must be treated like an absent marker");
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(agent);
    }
  },

  "listProfiles reads names + descriptions, sorted": async () => {
    const root = makeKitRoot();
    try {
      assert.deepEqual(
        listProfiles(root).map((p) => p.name),
        ["autonomous", "balanced", "self-improving"],
      );
    } finally {
      rmWorkspace(root);
    }
  },

  "listProfiles works for the monorepo layout": async () => {
    const root = makeMonorepoRoot();
    try {
      assert.deepEqual(
        listProfiles(root).map((p) => p.name),
        ["autonomous", "balanced", "self-improving"],
      );
    } finally {
      rmWorkspace(root);
    }
  },

  "/profile list marks the current profile and lists all": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("balanced");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      await handler("list", ctx);
      const text = ctx.notes.map((n) => n.message).join("\n");
      assert.match(text, /autonomous/);
      assert.match(text, /self-improving/);
      assert.match(text, /\*\s+balanced/);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "unknown profile is rejected without running the installer": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("balanced");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      await handler("does-not-exist", ctx);
      assert.equal(calls.length, 0, "installer must not run for an unknown profile");
      assert.match(ctx.notes.at(-1).message, /unknown profile/);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "switching to the current profile is a no-op": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      await handler("autonomous", ctx);
      assert.equal(calls.length, 0, "installer must not run when the profile is unchanged");
      assert.equal(ctx.reloaded, 0);
      assert.match(ctx.notes.at(-1).message, /already on/);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "direct switch runs the documented install argv and reloads": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      await handler("self-improving", ctx);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].command, process.execPath, "installer must run under the node binary");
      assert.deepEqual(calls[0].args, [
        path.join(root, "kit", "install.mjs"),
        "--profile",
        "self-improving",
        "--yes",
        "--settings-only",
      ]);
      assert.equal(calls[0].options.cwd, root);
      assert.equal(ctx.reloaded, 1, "a successful switch must reload");
      assert.match(ctx.notes.at(-1).message, /switched to "self-improving"/);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "monorepo switch drives packages/core/install.mjs": async () => {
    const root = makeMonorepoRoot();
    const agent = makeAgentDir("autonomous");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      await handler("self-improving", ctx);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args, [
        path.join(root, "packages", "core", "install.mjs"),
        "--profile",
        "self-improving",
        "--yes",
        "--settings-only",
      ]);
      assert.equal(calls[0].options.cwd, root);
      assert.equal(ctx.reloaded, 1);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "installer failure surfaces the error and does not reload": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { pi, handler } = loadCommand();
      pi.execCode = 1;
      const ctx = fakeCtx({ hasUI: true });
      await handler("self-improving", ctx);
      assert.equal(ctx.reloaded, 0, "a failed install must not reload");
      const last = ctx.notes.at(-1);
      assert.equal(last.level, "error");
      assert.match(last.message, /install failed \(exit 1\)/);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "picker selection switches to the chosen profile": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({
        hasUI: true,
        select: async (_title, options) => options.find((o) => o.startsWith("balanced")),
        confirm: async () => true,
      });
      await handler("", ctx);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args.slice(1), ["--profile", "balanced", "--yes", "--settings-only"]);
      assert.equal(ctx.reloaded, 1);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "cancelling the picker does nothing": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true, select: async () => undefined });
      await handler("", ctx);
      assert.equal(calls.length, 0);
      assert.equal(ctx.reloaded, 0);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "non-UI with no argument prints usage and does not install": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: false });
      await handler("", ctx);
      assert.equal(calls.length, 0);
      assert.equal(ctx.reloaded, 0);
      assert.match(ctx.notes.at(-1).message, /usage: \/profile/);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "findKitRoot falls back to the marker kitSource": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("balanced", { kitSource: root });
    const restoreRoot = setEnv("PI_KIT_ROOT", undefined);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      assert.equal(findKitRoot(), root);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "passes the recorded install scope back to the installer": async () => {
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous", { scope: "project" });
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      await handler("self-improving", ctx);
      assert.deepEqual(calls[0].args.slice(1), [
        "--profile",
        "self-improving",
        "--yes",
        "--settings-only",
        "--scope",
        "project",
      ]);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },
  "a project marker in the cwd forwards --scope project and uses the project settings path": async () => {
    const root = makeKitRoot();
    // A global marker that must be ignored in favour of the project one.
    const agent = makeAgentDir("autonomous", { scope: "global" });
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-project-"));
    fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(project, ".pi", ".pi-kit.json"), JSON.stringify({ profile: "autonomous", scope: "project" }));
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      ctx.cwd = project;
      await handler("status", ctx);
      const settingsPath = path.join(project, ".pi", "settings.json");
      assert.ok(ctx.notes.at(-1).message.includes(`Settings: ${settingsPath}`), "status must read the project settings file");
      assert.match(ctx.notes.at(-1).message, /Current: autonomous/);
      await handler("self-improving", ctx);
      assert.equal(calls.length, 1);
      assert.deepEqual(calls[0].args.slice(1), ["--profile", "self-improving", "--yes", "--settings-only", "--scope", "project"]);
      assert.equal(calls[0].options.cwd, project, "a project-scoped switch must run install.mjs in the project");
      assert.equal(ctx.reloaded, 1);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
      rmWorkspace(project);
    }
  },

  "a project settings entry without a project marker still scopes /profile to the project": async () => {
    // The inconsistent state WU-1 guards: <project>/.pi/settings.json has the kit
    // entry, but <project>/.pi/.pi-kit.json is absent, so readMarker falls back to the
    // global marker. The settings entry is authoritative for scope, so /profile must
    // still pass --scope project and run install.mjs in the project.
    const root = makeKitRoot();
    const agent = makeAgentDir("autonomous", { scope: "global" });
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-project-entry-"));
    fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ packages: [root] }));
    assert.ok(!fs.existsSync(path.join(project, ".pi", ".pi-kit.json")), "no project marker");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      ctx.cwd = project;
      await handler("self-improving", ctx);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].args.includes("--scope"), calls[0].args.join(" "));
      assert.equal(calls[0].args[calls[0].args.indexOf("--scope") + 1], "project", "the project settings entry makes /profile project-scoped");
      assert.equal(calls[0].options.cwd, project, "a project-scoped switch must run install.mjs in the project");
      assert.equal(ctx.reloaded, 1);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
      rmWorkspace(project);
    }
  },

  "a legacy-named kit root still scopes a project settings entry to the project": async () => {
    // F3: an npm kit entry points at a checkout whose package.json still carries the legacy
    // "pi-system" name. kit-update's isKitRoot accepts that name, so /profile must agree:
    // without a project marker the settings entry is still authoritative for scope.
    const root = makeMonorepoRoot();
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "pi-system", version: "0.2.1-beta.0" }));
    const agent = makeAgentDir("autonomous", { scope: "global" });
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-profile-legacy-"));
    fs.mkdirSync(path.join(project, ".pi"), { recursive: true });
    fs.writeFileSync(path.join(project, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:@satunix/pi-system"] }));
    assert.ok(!fs.existsSync(path.join(project, ".pi", ".pi-kit.json")), "no project marker");
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      ctx.cwd = project;
      await handler("self-improving", ctx);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].args.includes("--scope"), calls[0].args.join(" "));
      assert.equal(calls[0].args[calls[0].args.indexOf("--scope") + 1], "project", "a legacy-named kit root must still make /profile project-scoped (fails on pre-fix code)");
      assert.equal(calls[0].options.cwd, project, "a project-scoped switch must run install.mjs in the project");
      assert.equal(ctx.reloaded, 1);
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
      rmWorkspace(project);
    }
  },

  "status detects the actually-loaded set, not the marker": async () => {
    const root = makeMonorepoRoot();
    for (const n of ["alpha", "beta", "gamma"]) {
      fs.mkdirSync(path.join(root, "packages", "extensions", "src", n), { recursive: true });
      fs.writeFileSync(path.join(root, "packages", "extensions", "src", n, "index.ts"), "");
    }
    const profiles = path.join(root, "packages", "kit", "profiles");
    fs.writeFileSync(path.join(profiles, "balanced.json"), JSON.stringify({ name: "balanced", description: "d", include: ["alpha", "beta", "pi-lens"] }));
    fs.writeFileSync(path.join(profiles, "autonomous.json"), JSON.stringify({ name: "autonomous", description: "d", include: ["alpha", "beta", "gamma"] }));
    const agent = makeAgentDir("autonomous", { kitSource: root });
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: [{ source: root, extensions: ["packages/extensions/src/alpha/index.ts", "packages/extensions/src/beta/index.ts"] }] }));
    const restoreRoot = setEnv("PI_KIT_ROOT", root);
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const { handler, calls } = loadCommand();
      const ctx = fakeCtx({ hasUI: true });
      await handler("status", ctx);
      assert.match(ctx.notes.at(-1).message, /Current: balanced/, "the loaded set matches balanced even though the marker says autonomous");
      await handler("balanced", ctx);
      assert.equal(calls.length, 0, "re-selecting the profile that is really in effect is a no-op");
      // Drift: drop beta by hand -> custom, and the picker offers to keep the edit.
      fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: [{ source: root, extensions: ["packages/extensions/src/alpha/index.ts"] }] }));
      const ctx2 = fakeCtx({ hasUI: true, confirm: async (title) => title.startsWith("Keep") });
      await handler("status", ctx2);
      assert.match(ctx2.notes.at(-1).message, /custom \(closest: balanced/);
      assert.match(ctx2.notes.at(-1).message, /missing vs balanced: beta/);
      await handler("autonomous", ctx2);
      assert.ok(calls.at(-1).args.includes("--capture-overrides"), "hand edits are captured on the first switch when the operator agrees");
    } finally {
      restoreRoot();
      restoreAgent();
      rmWorkspace(root);
      rmWorkspace(agent);
    }
  },

  "/compaction on|off writes pi's setting, preserves the rest, and reloads": async () => {
    const agent = makeAgentDir("balanced");
    fs.writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ theme: "t", compaction: { enabled: true, reserveTokens: 9000 } }));
    const restoreAgent = setEnv("PI_CODING_AGENT_DIR", agent);
    try {
      const pi = fakePi();
      sessionHelpers(pi.api);
      const handler = pi.commands.get("compaction").handler;
      const ctx = fakeCtx({ hasUI: true });
      ctx.cwd = agent;
      await handler("off", ctx);
      const saved = JSON.parse(fs.readFileSync(path.join(agent, "settings.json"), "utf8"));
      assert.deepEqual(saved, { theme: "t", compaction: { enabled: false, reserveTokens: 9000 } });
      assert.equal(ctx.reloaded, 1, "pi keeps settings in memory, so the change needs a reload");
      await handler("status", ctx);
      assert.match(ctx.notes.at(-1).message, /Auto-compaction \(pi\): OFF/);
      await handler("trigger off", ctx);
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(agent, "pi-kit", "trigger-compact.json"), "utf8")), { enabled: false });
      await handler("trigger on", ctx);
      assert.equal(fs.existsSync(path.join(agent, "pi-kit", "trigger-compact.json")), false);
      fs.writeFileSync(path.join(agent, "settings.json"), "{ broken");
      await handler("on", ctx);
      assert.equal(ctx.notes.at(-1).level, "error", "an unparseable settings file is never rewritten");
      assert.equal(fs.readFileSync(path.join(agent, "settings.json"), "utf8"), "{ broken");
    } finally {
      restoreAgent();
      rmWorkspace(agent);
    }
  },
};

let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.error(`  FAIL ${name}\n${err.stack}`);
  }
}
const total = Object.keys(tests).length;
if (failed) {
  console.error(`profile-command-smoke: ${failed}/${total} failed`);
  process.exit(1);
}
console.log(`profile-command-smoke: ${total}/${total} passed`);
