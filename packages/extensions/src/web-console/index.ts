import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// web-console adds `/console` (alias `/webui`): start, stop, and check the bundled
// Pi Console web UI that ships in packages/web-ui of this repo.
//
// It does exactly one thing: launch the existing zero-dependency server
// (`packages/web-ui/server/server.js`) as a detached Node process and report the URL.
// It never proxies sessions itself, never writes Pi session files, and does not
// change any other extension's behaviour. The server binds loopback only; see
// packages/web-ui/README.md for the security posture.
//
// Self-containment rule: import only node:* builtins and pi peers.
// No sibling imports, no packages/core imports.

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8123;
const HEALTH_TIMEOUT_MS = 800;
const READY_POLLS = 24;
const READY_POLL_MS = 250;

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function readMarker(cwd: string = process.cwd()): { kitSource?: string } {
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

/**
 * Locate `packages/web-ui`. Precedence:
 *   1. PI_KIT_WEBUI_ROOT override
 *   2. relative to this extension (<root>/packages/extensions/src/web-console -> <root>/packages/web-ui)
 *   3. the checkout recorded in the install marker (.pi-kit.json)
 * Returns null rather than guessing, so a generated npm surface (which does not
 * ship the web UI) degrades to a clear message.
 */
export function findWebUiRoot(): string | null {
  const hasServer = (dir: string) => isFile(path.join(dir, "server", "server.js"));

  const override = process.env.PI_KIT_WEBUI_ROOT?.trim();
  if (override && hasServer(override)) return override;

  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const local = path.resolve(here, "..", "..", "..", "web-ui");
    if (hasServer(local)) return local;
  } catch {
    /* import.meta.url unavailable (non-ESM loader) - fall through */
  }

  const marker = readMarker();
  if (marker.kitSource) {
    const fromMarker = path.join(marker.kitSource, "packages", "web-ui");
    if (hasServer(fromMarker)) return fromMarker;
  }

  return null;
}

function consoleHost(): string {
  const host = process.env.PI_CONSOLE_HOST?.trim();
  return host || DEFAULT_HOST;
}

function consolePort(): number {
  const port = Number.parseInt(process.env.PI_CONSOLE_PORT ?? "", 10);
  return Number.isFinite(port) && port > 0 ? port : DEFAULT_PORT;
}

function consoleUrl(): string {
  return `http://${consoleHost()}:${consolePort()}`;
}

function runtimeDir(webUiRoot: string): string {
  return path.join(webUiRoot, ".runtime");
}

function pidFile(webUiRoot: string): string {
  return path.join(runtimeDir(webUiRoot), "server.pid");
}

function logFile(webUiRoot: string): string {
  return path.join(runtimeDir(webUiRoot), "server.log");
}

function readPid(webUiRoot: string): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(pidFile(webUiRoot), "utf8").trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return (error as { code?: string }).code === "EPERM";
  }
}

// Whether `pid` is this web UI's server, from its command line. "unknown" where the
// platform has no /proc (macOS, Windows): callers then fall back to the health probe.
// Checking identity (not health) lets stop kill a hung console and never a pid the OS
// has reused for an unrelated process.
function consoleProcess(pid: number, webUiRoot: string): "console" | "other" | "unknown" {
  let raw: string;
  try {
    raw = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
  } catch {
    return "unknown";
  }
  const serverJs = path.join(webUiRoot, "server", "server.js");
  return raw.split("\0").includes(serverJs) ? "console" : "other";
}

function healthCheck(timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      { host: consoleHost(), port: consolePort(), path: "/api/health", timeout: timeoutMs },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface StartResult {
  /** A new child was spawned by this call. */
  started: boolean;
  /** A server was already answering / reachable. */
  alreadyRunning: boolean;
  pid: number | null;
  url: string;
  healthy: boolean;
}

async function startServer(webUiRoot: string): Promise<StartResult> {
  const url = consoleUrl();
  const existing = readPid(webUiRoot);
  // The health probe is authoritative: a live-but-unrelated process whose pid was
  // reused must not make /console start claim the console is already running. One
  // probe covers both the already-running path and the stale-pid path.
  if (await healthCheck()) {
    return { started: false, alreadyRunning: true, pid: existing, url, healthy: true };
  }
  // A console process that is alive but not answering holds the port; a second server
  // would fail to bind. Report it so the operator can /console stop it.
  if (existing && processAlive(existing) && consoleProcess(existing, webUiRoot) === "console") {
    return { started: false, alreadyRunning: true, pid: existing, url, healthy: false };
  }

  fs.mkdirSync(runtimeDir(webUiRoot), { recursive: true });
  const out = fs.openSync(logFile(webUiRoot), "a");
  let child;
  try {
    child = spawn(process.execPath, [path.join(webUiRoot, "server", "server.js")], {
      cwd: webUiRoot,
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env },
    });
    child.unref();
  } finally {
    fs.closeSync(out);
  }

  const pid = child.pid ?? null;
  if (pid) {
    try {
      fs.writeFileSync(pidFile(webUiRoot), `${pid}\n`);
    } catch {
      /* pid file is a convenience; health check is the source of truth */
    }
  }

  let healthy = false;
  for (let i = 0; i < READY_POLLS; i++) {
    if (await healthCheck(READY_POLL_MS)) {
      healthy = true;
      break;
    }
    await sleep(READY_POLL_MS);
  }

  return { started: true, alreadyRunning: false, pid, url, healthy };
}

export interface StopResult {
  stopped: boolean;
  pid: number | null;
}

async function stopServer(webUiRoot: string): Promise<StopResult> {
  const pid = readPid(webUiRoot);
  if (!pid || !processAlive(pid)) return { stopped: false, pid };
  // Only signal the pid when it is the console: a stale pid file could point at an
  // unrelated process that reused the pid. Where the command line cannot be read, a
  // console answering on the configured host/port is the best evidence available.
  const owner = consoleProcess(pid, webUiRoot);
  if (owner === "other" || (owner === "unknown" && !(await healthCheck()))) return { stopped: false, pid };
  try {
    process.kill(pid, "SIGTERM");
    try {
      fs.rmSync(pidFile(webUiRoot), { force: true });
    } catch {
      /* ignore */
    }
    return { stopped: true, pid };
  } catch {
    return { stopped: false, pid };
  }
}

function openBrowser(url: string): void {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    const child = spawn(opener, args, { detached: true, stdio: "ignore" });
    child.unref();
  } catch {
    /* best effort; the URL is always printed too */
  }
}

function notify(ctx: ExtensionCommandContext, message: string, level: "info" | "error"): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

const USAGE = [
  "Usage: /console [start|stop|status|open]",
  "  start   Launch the Pi Console web UI (default).",
  "  stop    Stop the server this command started.",
  "  status  Report whether it is running and where.",
  "  open    Start it if needed, then open the URL in a browser.",
].join("\n");

const ACTIONS = new Set(["start", "stop", "status", "open"]);

async function handleConsole(args: string, ctx: ExtensionCommandContext): Promise<void> {
  const sub = (args.trim().split(/\s+/)[0] || "start").toLowerCase();

  if (sub === "help" || sub === "-h" || sub === "--help") {
    notify(ctx, USAGE, "info");
    return;
  }
  if (!ACTIONS.has(sub)) {
    notify(ctx, `console: unknown action "${sub}"\n\n${USAGE}`, "error");
    return;
  }

  const webUiRoot = findWebUiRoot();
  if (!webUiRoot) {
    notify(
      ctx,
      [
        "console: could not locate packages/web-ui.",
        "Run this from the pi-system checkout, or set PI_KIT_WEBUI_ROOT=/path/to/packages/web-ui.",
        "Generated npm surfaces do not ship the web UI.",
      ].join(" "),
      "error",
    );
    return;
  }

  const url = consoleUrl();

  if (sub === "stop") {
    const result = await stopServer(webUiRoot);
    notify(
      ctx,
      result.stopped
        ? `console: stopped the web UI (pid ${result.pid}).`
        : "console: no server started by this command is running.",
      "info",
    );
    return;
  }

  if (sub === "status") {
    const pid = readPid(webUiRoot);
    const healthy = await healthCheck();
    notify(
      ctx,
      [
        `console: ${healthy ? "running" : "not reachable"} at ${url}`,
        pid ? `pid ${pid}` : "no pid file (server may have been started outside /console)",
        `root ${webUiRoot}`,
      ].join("\n"),
      "info",
    );
    return;
  }

  // start | open
  if (ctx.hasUI) ctx.ui.setStatus("console", "starting web UI...");
  let result: StartResult;
  try {
    result = await startServer(webUiRoot);
  } catch (error) {
    if (ctx.hasUI) ctx.ui.setStatus("console", undefined);
    notify(ctx, `console: failed to start the web UI: ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }
  if (ctx.hasUI) ctx.ui.setStatus("console", undefined);

  if (sub === "open") openBrowser(result.url);

  const lines: string[] = [];
  if (result.alreadyRunning && !result.healthy) {
    lines.push(
      `console: a web UI server (pid ${result.pid ?? "?"}) is running but ${result.url}/api/health does not respond.`,
    );
    lines.push(`Run /console stop, then /console start. Log: ${logFile(webUiRoot)}`);
  } else if (result.alreadyRunning) {
    lines.push(`console: web UI already running at ${result.url}`);
  } else if (result.healthy) {
    lines.push(`console: web UI started at ${result.url}`);
    if (result.pid) lines.push(`pid ${result.pid} · logs ${logFile(webUiRoot)}`);
  } else {
    lines.push(
      `console: server process launched (pid ${result.pid ?? "?"}) but ${result.url}/api/health did not respond yet.`,
    );
    lines.push(`Check the log: ${logFile(webUiRoot)}`);
  }
  lines.push("Loopback only, no authentication - do not expose it to a network.");
  notify(ctx, lines.join("\n"), "info");
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("console", {
    description: "Start/stop the bundled Pi Console web UI. Usage: /console [start|stop|status|open].",
    handler: handleConsole,
  });
  pi.registerCommand("webui", {
    description: "Alias for /console - start/stop the bundled Pi Console web UI.",
    handler: handleConsole,
  });
}