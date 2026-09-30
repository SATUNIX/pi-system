#!/usr/bin/env node
/**
 * Standalone installer for the Pi Console web UI.
 *
 * The UI is two things in this repo:
 *   - packages/web-ui/            the zero-dependency server + browser assets
 *   - the `web-console` extension the `/console` (alias `/webui`) slash command
 *
 * This script:
 *   1. checks prerequisites (Node >= 20, the pi CLI, the server files)
 *   2. registers the `web-console` extension with pi via the kit installer when no
 *      kit is installed yet, and explains how to enable it when one already is
 *   3. prints how to start the UI
 *
 * It is non-destructive: it never rewrites an existing kit install's extension set.
 *
 * Usage:
 *   node packages/web-ui/install.mjs [--start] [--dry-run] [--help]
 *
 *   --start     also launch the server now and print the URL
 *   --dry-run   show what would happen without running the installer
 */
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB_UI_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(WEB_UI_DIR, "..", "..");
const INSTALLER = path.join(ROOT, "packages", "core", "install.mjs");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const dryRun = has("--dry-run");
const start = has("--start");

if (has("--help") || has("-h")) {
  console.log(`Usage: node packages/web-ui/install.mjs [--start] [--dry-run]`);
  process.exit(0);
}

const problems = [];

function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function resolveCommand(name) {
  const pathEnv = process.env.Path || process.env.PATH || "";
  const exts = process.platform === "win32" ? [".cmd", ".exe", ".bat", ""] : [""];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      if (fs.existsSync(path.join(dir, `${name}${ext}`))) return path.join(dir, `${name}${ext}`);
    }
  }
  return null;
}

function readMarker() {
  // Match uninstall.mjs: a project marker in the cwd wins, otherwise the global marker.
  const projectMarker = path.join(process.cwd(), ".pi", ".pi-kit.json");
  const file = fs.existsSync(projectMarker) ? projectMarker : path.join(agentDir(), ".pi-kit.json");
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

console.log("[web-ui] Pi Console installer\n");

// 1. Prerequisites
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
  problems.push(`Node.js >= 20 is required (found ${process.version}).`);
}
if (!fs.existsSync(path.join(WEB_UI_DIR, "server", "server.js"))) {
  problems.push(`Server entrypoint missing: ${path.join(WEB_UI_DIR, "server", "server.js")}`);
}
if (!fs.existsSync(INSTALLER)) {
  problems.push(`Kit installer missing: ${INSTALLER}`);
}
const piBin = resolveCommand("pi");
if (!piBin) problems.push("The `pi` CLI was not found on PATH; install it before registering the extension.");

if (problems.length > 0) {
  for (const p of problems) console.error(`[web-ui] FAIL: ${p}`);
  process.exit(1);
}
console.log(`  node:      ${process.version}`);
console.log(`  pi:        ${piBin}`);
console.log(`  web ui:    ${WEB_UI_DIR}`);
console.log("");

// 2. Register the /console extension (additively / non-destructively)
const marker = readMarker();
if (marker) {
  const installed = Array.isArray(marker.extensions) ? marker.extensions : [];
  if (installed.includes("web-console")) {
    console.log("[web-ui] The web-console extension is already installed - /console will work after /reload.");
  } else if (marker.profile && marker.profile !== "custom") {
    // Reconcile the existing profile install so it picks up web-console. This is the
    // same idempotent reinstall the /profile command performs; it does not drop any
    // extension the profile already included.
    const cmd = [INSTALLER, "--profile", marker.profile, "--yes"];
    if (marker.scope) cmd.push("--scope", marker.scope);
    if (marker.mode === "git" && marker.ref) cmd.push("--mode", "git", "--git-ref", marker.ref);
    if (dryRun) {
      console.log(`[web-ui] Dry run: would reconcile the existing "${marker.profile}" install: node ${cmd.slice(1).join(" ")}`);
    } else {
      console.log(`[web-ui] Existing "${marker.profile}" kit install found - reconciling to add web-console...`);
      try {
        execFileSync(process.execPath, cmd, { cwd: ROOT, stdio: "inherit" });
      } catch {
        console.error("[web-ui] FAIL: the kit installer did not complete. See its output above.");
        process.exit(1);
      }
    }
  } else {
    console.log(
      "[web-ui] A custom kit install already exists and does not include web-console. Not touching it.\n" +
        "[web-ui] Enable it by reinstalling with a profile that includes it, e.g.:\n" +
        "[web-ui]   node packages/core/install.mjs --profile balanced --yes",
    );
  }
} else if (dryRun) {
  console.log(`[web-ui] Dry run: would run ${INSTALLER} --only web-console --yes`);
} else {
  console.log("[web-ui] No kit install found - registering the web-console extension...");
  try {
    execFileSync(process.execPath, [INSTALLER, "--only", "web-console", "--yes"], { cwd: ROOT, stdio: "inherit" });
  } catch {
    console.error("[web-ui] FAIL: the kit installer did not complete. See its output above.");
    process.exit(1);
  }
}

// 3. How to start
const port = process.env.PI_CONSOLE_PORT || "8123";
const host = process.env.PI_CONSOLE_HOST || "127.0.0.1";
const url = `http://${host}:${port}`;

if (start) {
  const runtime = path.join(WEB_UI_DIR, ".runtime");
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  const log = fs.openSync(path.join(runtime, "server.log"), "a");
  // The server requires an access token. Generate one and hand it over as an owner-only file
  // (not on the command line or in the log), unless the operator supplied their own or turned
  // authentication off. The login URL is printed to this terminal only.
  const childEnv = { ...process.env };
  let token = process.env.PI_CONSOLE_TOKEN || null;
  const authOff = String(process.env.PI_CONSOLE_AUTH || "").toLowerCase() === "off";
  if (!authOff && !token && !process.env.PI_CONSOLE_TOKEN_FILE) {
    token = crypto.randomBytes(32).toString("hex");
    const tokenFile = path.join(runtime, "console.token");
    fs.rmSync(tokenFile, { force: true });
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600, flag: "wx" });
    childEnv.PI_CONSOLE_TOKEN_FILE = tokenFile;
  }
  const child = spawn(process.execPath, [path.join(WEB_UI_DIR, "server", "server.js")], {
    cwd: WEB_UI_DIR,
    detached: true,
    stdio: ["ignore", log, log],
    env: childEnv,
  });
  child.unref();
  fs.closeSync(log);
  console.log(`\n[web-ui] Started the server (pid ${child.pid}) at ${url}`);
  if (token) console.log(`[web-ui] Login link (keep it private): ${url}/#token=${token}`);
  else if (authOff) console.log("[web-ui] WARNING: PI_CONSOLE_AUTH=off - authentication is disabled (loopback development only).");
  else console.log("[web-ui] The access token comes from PI_CONSOLE_TOKEN_FILE.");
}

console.log(`
[web-ui] Done.

Start it:
  In pi:   /console            (alias: /webui) - prints the login link
  Shell:   node packages/web-ui/server/server.js  (prints the login link on a terminal)

Then open the login link (it looks like ${url}/#token=...).

The server binds ${host} and requires an access token; a non-loopback bind is refused unless
PI_CONSOLE_ALLOW_REMOTE=1 is set. Keep it on loopback.
`);