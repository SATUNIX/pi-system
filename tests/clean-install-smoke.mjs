#!/usr/bin/env node
// Clean install from the real artefact, run by the real pi runtime.
//
// `npm pack` the repository exactly as a release would, unpack the tarball into an empty directory
// (so nothing can lean on the checkout: no tests/, docs/ or node_modules of this repo), install the
// kit from that copy into a throw-away HOME and agent directory for every shipped profile, and start
// the real `pi` in RPC mode with it. RPC mode loads every extension without needing a model or a
// network, and answers `get_commands` with what the extensions registered. A profile passes when
// pi starts, reports no extension error, and offers the commands the kit promises.
//
// This never touches the operator's pi installation: HOME and PI_CODING_AGENT_DIR are temporary.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../packages/core/eval/harness.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const shell = process.platform === "win32";
const PROFILES = fs.readdirSync(path.join(ROOT, "packages", "kit", "profiles")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
const TIMEOUT_MS = 90_000;

// Commands every profile must offer, and ones only some may. Names come from the shipped manifests,
// not from this list alone: the profile's own extension set decides what to expect.
const EVERY_PROFILE = ["effort", "update", "profile"];

let checks = 0;
const ok = (name) => { checks += 1; console.log(`  ok  ${name}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-clean-install-"));
const cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", shell, ...options });
  return result;
}

/** Talk to `pi --mode rpc`: send one command, wait for its response, return it with the events seen. */
function rpc(agentDir, home, cwd, command) {
  return new Promise((resolve, reject) => {
    const pi = spawn("pi", ["--mode", "rpc", "--offline", "--no-session"], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir },
      stdio: ["pipe", "pipe", "pipe"],
      shell,
    });
    const events = [];
    let stderr = "";
    let buffer = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { pi.stdin.end(); } catch { /* already closed */ }
      pi.kill("SIGKILL");
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error(`pi did not answer within ${TIMEOUT_MS / 1000}s\nstderr: ${stderr.slice(-800)}`)), TIMEOUT_MS);
    pi.stderr.on("data", (d) => { stderr += d; });
    pi.on("error", (error) => finish(error));
    pi.on("exit", (code) => finish(new Error(`pi exited early (${code})\nstderr: ${stderr.slice(-800)}`)));
    pi.stdout.on("data", (d) => {
      buffer += d;
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.type === "response" && message.id === command.id) return finish(null, { response: message, events, stderr });
        events.push(message);
      }
    });
    // Give the extensions a moment to finish loading before the first command.
    setTimeout(() => pi.stdin.write(`${JSON.stringify(command)}\n`), 2500);
  });
}

try {
  // 1. Pack and unpack the real artefact.
  const packDir = path.join(tmp, "pack");
  fs.mkdirSync(packDir);
  const pack = run(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], { cwd: ROOT });
  assert.equal(pack.status, 0, `npm pack failed:\n${pack.stdout}\n${pack.stderr}`);
  const tarball = path.join(packDir, JSON.parse(pack.stdout)[0].filename);
  const unpacked = path.join(tmp, "artefact");
  fs.mkdirSync(unpacked);
  const untar = run("tar", ["-xzf", tarball, "-C", unpacked, "--strip-components=1"]);
  assert.equal(untar.status, 0, untar.stderr);
  assert.ok(!fs.existsSync(path.join(unpacked, "tests")), "the artefact ships no tests directory");
  assert.ok(!fs.existsSync(path.join(unpacked, "node_modules")), "the artefact ships no node_modules");
  assert.ok(fs.existsSync(path.join(unpacked, "packages", "core", "install.mjs")), "the artefact ships the installer");
  ok("npm pack produced a tarball that unpacks to a directory with no tests/ and no node_modules");

  const pkg = JSON.parse(fs.readFileSync(path.join(unpacked, "package.json"), "utf8"));
  if (Object.keys(pkg.dependencies ?? {}).length > 0) {
    const install = run(npm, ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: unpacked });
    assert.equal(install.status, 0, `runtime dependency install failed:\n${install.stderr}`);
    ok("the artefact's runtime dependencies install");
  } else {
    ok("the artefact has no runtime dependencies to install");
  }

  // 2. Every profile: install from the artefact, start real pi, look at what loaded.
  for (const profile of PROFILES) {
    const home = path.join(tmp, `home-${profile}`);
    const agentDir = path.join(tmp, `agent-${profile}`);
    const work = path.join(tmp, `work-${profile}`);
    for (const dir of [home, agentDir, work]) fs.mkdirSync(dir, { recursive: true });
    run("git", ["init", "-q"], { cwd: work });

    const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir, PI_LEAN_CTX_BIN: path.join(home, "no-lean-ctx") };
    const install = run(process.execPath, [path.join(unpacked, "packages", "core", "install.mjs"), "--profile", profile, "--yes", "--settings-only", "--mode", "local", "--no-externals"], { cwd: work, env });
    assert.equal(install.status, 0, `${profile}: install failed:\n${install.stdout}\n${install.stderr}`);
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
    const entry = settings.packages?.find((p) => typeof p === "object");
    assert.ok(entry, `${profile}: settings.json has a package entry`);
    const selected = (entry.extensions ?? []).length;
    assert.ok(selected >= 10, `${profile}: the profile selected extensions (${selected})`);

    const { response, events, stderr } = await rpc(agentDir, home, work, { id: "commands", type: "get_commands" });
    assert.equal(response.success, true, `${profile}: get_commands failed: ${JSON.stringify(response)}`);
    const commands = new Map(response.data.commands.map((c) => [c.name, c]));
    for (const name of EVERY_PROFILE) assert.ok(commands.has(name), `${profile}: /${name} is registered (have: ${[...commands.keys()].sort().join(", ")})`);
    // Every command must come from the artefact, not from a checkout of this repository.
    for (const [name, command] of commands) {
      const from = command.sourceInfo?.path ?? "";
      if (command.source === "extension") assert.ok(!from.startsWith(ROOT + path.sep), `${profile}: /${name} loaded from the checkout (${from}), not the artefact`);
    }
    const errors = events.filter((e) => /error/i.test(e.type ?? "") || (e.method === "notify" && e.notifyType === "error"));
    assert.deepEqual(errors, [], `${profile}: pi reported extension errors: ${JSON.stringify(errors).slice(0, 600)}`);
    assert.ok(!/failed to load|cannot find module|unhandled/i.test(stderr), `${profile}: pi wrote load errors to stderr:\n${stderr.slice(-600)}`);
    ok(`profile ${profile}: installed from the artefact, real pi loaded ${selected} extensions with no error and offers ${commands.size} commands`);
  }
} finally {
  cleanup();
}

console.log(`[clean-install-smoke] OK (${checks} checks)`);
