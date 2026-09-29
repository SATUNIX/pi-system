#!/usr/bin/env node
// Offline web-console extension smoke: resolves packages/web-ui, starts the
// zero-dependency server on an isolated loopback port, and exercises
// /console start|status|stop. No model, no network beyond loopback.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadExtension, fakePi, setEnv, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.mjs";

const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A long-lived process whose only purpose is to occupy a pid. It never binds the
// console port, so a stale pid file pointing at it must not be mistaken for the server.
function spawnInert() {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
}

function health(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function waitHealthy(port) {
  for (let i = 0; i < 60; i++) {
    if (await health(port)) return true;
    await wait(100);
  }
  return false;
}

async function run() {
  const ws = tmpWorkspace("pi-kit-web-console-");
  const webUiRoot = path.resolve("packages", "web-ui");
  const port = 18000 + Math.floor(Math.random() * 2000);
  const restore = [
    setEnv("PI_KIT_WEBUI_ROOT", webUiRoot),
    setEnv("PI_CONSOLE_PORT", String(port)),
    setEnv("PI_CONSOLE_HOST", "127.0.0.1"),
    // No install marker, so findWebUiRoot cannot fall back to a real checkout.
    setEnv("PI_CODING_AGENT_DIR", ws),
  ];

  const notifications = [];
  const ctx = { hasUI: true, ui: { notify: (message, level) => notifications.push({ message, level }), setStatus: () => {} } };
  const inert = [];
  let stopped = false;
  const pidPath = path.join(webUiRoot, ".runtime", "server.pid");
  const writePid = (pid) => {
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, `${pid}\n`);
  };

  try {
    const register = await loadExtension("extensions/web-console/index.ts");
    const pi = fakePi();
    register(pi.api);

    const consoleCmd = pi.commands.get("console");
    const webuiCmd = pi.commands.get("webui");
    assert.ok(consoleCmd, "/console must be registered");
    assert.ok(webuiCmd, "/webui alias must be registered");

    // Not running yet.
    await consoleCmd.handler("status", ctx);
    assert.match(notifications.at(-1).message, /not reachable/);

    // Unknown action fails closed with usage.
    await consoleCmd.handler("bogus", ctx);
    assert.equal(notifications.at(-1).level, "error");
    assert.match(notifications.at(-1).message, /unknown action/);

    // start-trust (B-090): a live but unrelated pid in the pid file must not make
    // /console start report alreadyRunning/healthy without probing /api/health.
    const stalePid = spawnInert();
    inert.push(stalePid);
    assert.ok(stalePid.pid, "inert child must have a pid");
    writePid(stalePid.pid);
    await consoleCmd.handler("start", ctx);
    const startMessage = notifications.at(-1).message;
    assert.doesNotMatch(startMessage, /already running/, "a live stale pid must not short-circuit the health probe");
    assert.match(startMessage, /web UI started/);
    assert.ok(await waitHealthy(port), "a fresh server must start despite the stale pid file");

    // Status reports running.
    await consoleCmd.handler("status", ctx);
    assert.match(notifications.at(-1).message, /running/);

    // Start again is idempotent.
    await consoleCmd.handler("start", ctx);
    assert.match(notifications.at(-1).message, /already running/);

    // Stop and confirm the port is dead.
    await consoleCmd.handler("stop", ctx);
    stopped = true;
    assert.match(notifications.at(-1).message, /stopped the web UI/);
    for (let i = 0; i < 40 && (await health(port)); i++) await wait(50);
    assert.equal(await health(port), false, "server must be stopped after /console stop");

    // stop-safety (B-090): a stale pid file pointing at an unrelated live process must
    // not be SIGTERMed while no console is answering the health endpoint.
    const bystander = spawnInert();
    inert.push(bystander);
    assert.ok(bystander.pid, "bystander must have a pid");
    writePid(bystander.pid);
    await consoleCmd.handler("stop", ctx);
    assert.match(notifications.at(-1).message, /no server started/);
    assert.ok(alive(bystander.pid), "stop must not SIGTERM a pid that is not the console");
    assert.ok(fs.existsSync(pidPath), "a failed stop must keep the pidfile");

    // hung console (Linux, where the pid's command line is readable): a console process
    // that holds the pid file but does not answer /api/health must be reported by start
    // (not duplicated) and killed by stop.
    if (fs.existsSync(`/proc/${process.pid}/cmdline`)) {
      const hung = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", path.join(webUiRoot, "server", "server.js")], { stdio: "ignore" });
      inert.push(hung);
      writePid(hung.pid);
      await consoleCmd.handler("start", ctx);
      assert.match(notifications.at(-1).message, /is running but .* does not respond/, "start must report a hung console");
      assert.equal(await health(port), false, "start must not launch a second server over a hung one");
      await consoleCmd.handler("stop", ctx);
      assert.match(notifications.at(-1).message, /stopped the web UI/, "stop must kill a hung console");
      for (let i = 0; i < 40 && alive(hung.pid); i++) await wait(50);
      assert.equal(alive(hung.pid), false, "the hung console must be gone after stop");
    }

    console.log("web-console smoke: OK");
  } finally {
    for (const child of inert) {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
    if (!stopped) {
      // Best-effort cleanup if the test failed mid-run.
      try {
        const register = await loadExtension("extensions/web-console/index.ts");
        const pi = fakePi();
        register(pi.api);
        await pi.commands.get("console").handler("stop", ctx);
      } catch {
        /* ignore */
      }
    }
    for (const r of restore.reverse()) r();
    rmWorkspace(ws);
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});