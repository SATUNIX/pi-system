// Shared helpers for the web-ui security tests (not a test itself).
//
// Every test here starts the REAL packages/web-ui/server/server.js as a child process on a
// loopback port, inside a sandbox of temp directories (HOME, pi agent dir, sessions dir,
// runtime dir), and talks to it over real HTTP. Nothing touches the developer's ~/.pi, real
// credentials or any network beyond 127.0.0.1.
//
// PI_CONSOLE_TEST_SERVER=/path/to/server.js runs the same tests against another copy of the
// server (used to show that the tests fail against the pre-hardening implementation).
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER_JS = process.env.PI_CONSOLE_TEST_SERVER
  ? path.resolve(process.env.PI_CONSOLE_TEST_SERVER)
  : path.join(REPO, "packages", "web-ui", "server", "server.js");
export const WEB_UI_DIR = path.join(REPO, "packages", "web-ui");

export function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

/** A tiny check runner: prints ok/not ok, remembers failure, exits non-zero at the end. */
export function makeRunner(name) {
  let failed = 0;
  let passed = 0;
  return {
    async check(label, fn) {
      try {
        await fn();
        passed++;
        console.log(`  ok - ${label}`);
      } catch (error) {
        failed++;
        console.error(`  not ok - ${label}`);
        console.error(error && error.stack ? error.stack : error);
      }
    },
    finish() {
      if (failed > 0) {
        console.error(`${name}: FAIL (${failed} failed, ${passed} passed)`);
        process.exit(1);
      }
      console.log(`${name}: OK (${passed} checks)`);
    },
  };
}

// ---------------------------------------------------------------- sandbox ---
const STUB_SOURCE = `#!/usr/bin/env node
// Stand-in for \`pi --mode rpc\`: records what it is given and answers every command.
const fs = require("node:fs");
const log = process.env.STUB_LOG;
const record = (obj) => { if (log) fs.appendFileSync(log, JSON.stringify(obj) + "\\n"); };
record({ event: "start", pid: process.pid, argv: process.argv.slice(2), tokenEnv: process.env.PI_CONSOLE_TOKEN ?? null, tokenFileEnv: process.env.PI_CONSOLE_TOKEN_FILE ?? null });
if (process.env.STUB_IGNORE_SIGTERM === "1") process.on("SIGTERM", () => record({ event: "sigterm-ignored" }));
else process.on("SIGTERM", () => process.exit(0));
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let cmd; try { cmd = JSON.parse(line); } catch { continue; }
    record({ event: "cmd", cmd });
    const data = cmd.type === "get_state" ? { sessionId: "stub-" + process.pid, sessionFile: null }
      : cmd.type === "get_session_stats" ? { tokens: { input: 1, output: 1, total: 2 }, cost: 0 } : {};
    process.stdout.write(JSON.stringify({ type: "response", id: cmd.id, command: cmd.type, success: true, data }) + "\\n");
  }
});
process.stdin.on("end", () => { if (process.env.STUB_IGNORE_SIGTERM !== "1") process.exit(0); });
setInterval(() => {}, 1000);
`;

export function makeSandbox(prefix = "pi-web-ui-sec-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dirs = {
    root,
    home: path.join(root, "home"),
    agentDir: path.join(root, "home", ".pi", "agent"),
    sessionsDir: path.join(root, "sessions"),
    lensDir: path.join(root, "lens"),
    projectAgents: path.join(root, "project-agents"),
    runtimeDir: path.join(root, "runtime"),
    cwd: path.join(root, "cwd"),
    bin: path.join(root, "bin"),
    stubLog: path.join(root, "stub.jsonl"),
  };
  for (const key of ["agentDir", "sessionsDir", "lensDir", "projectAgents", "runtimeDir", "cwd", "bin"]) {
    fs.mkdirSync(dirs[key], { recursive: true });
  }
  const stub = path.join(dirs.bin, "pi-stub");
  fs.writeFileSync(stub, STUB_SOURCE, { mode: 0o755 });
  return {
    ...dirs,
    stub,
    userAgents: path.join(dirs.home, ".pi", "agents"),
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
    /** Parsed lines the stub pi recorded. */
    stubEvents() {
      try {
        return fs
          .readFileSync(dirs.stubLog, "utf8")
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
      } catch {
        return [];
      }
    },
  };
}

/** Write a minimal pi session file the way pi would (used as a read-only fixture). */
export function writeSessionFixture(sandbox, id, { cwd = sandbox.cwd, text = "hello fixture" } = {}) {
  const dir = path.join(sandbox.sessionsDir, "--fixture--");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
  const lines = [
    { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } },
    { type: "message", id: "m2", parentId: "m1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "ack" }], timestamp: 2 } },
  ];
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
  // Not "recently active": keep resumed-session logic out of the way.
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(file, old, old);
  return file;
}

/** A free loopback port (bind to 0, read it, release it). */
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/** A clean environment for a server child: only what the sandbox and the test specify. */
export function baseEnv(sandbox, extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: sandbox.home,
    USERPROFILE: sandbox.home,
    PI_CODING_AGENT_DIR: sandbox.agentDir,
    PI_CODING_AGENT_SESSION_DIR: sandbox.sessionsDir,
    PI_LENS_DIR: sandbox.lensDir,
    PI_CONSOLE_PROJECT_AGENTS: sandbox.projectAgents,
    PI_CONSOLE_RUNTIME_DIR: sandbox.runtimeDir,
    PI_CONSOLE_DEFAULT_CWD: sandbox.cwd,
    PI_BIN: sandbox.stub,
    STUB_LOG: sandbox.stubLog,
    ...extra,
  };
}

// ---------------------------------------------------------------- server ---
/**
 * Start server.js. Resolves once it answers /api/health; rejects (with exit code and the
 * captured output) if it exits first. `expectExit: true` instead resolves with the exit result,
 * for configurations the server must refuse.
 */
export async function startServer(sandbox, { env = {}, port, expectExit = false } = {}) {
  const chosen = port ?? (await freePort());
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd: WEB_UI_DIR,
    env: baseEnv(sandbox, { PI_CONSOLE_PORT: String(chosen), ...env }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  const handle = {
    child,
    port: chosen,
    stdout: () => stdout,
    stderr: () => stderr,
    output: () => stdout + stderr,
    exited,
    async stop(signal = "SIGTERM") {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      const result = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 10_000))]);
      if (result === "timeout") {
        child.kill("SIGKILL");
        await exited;
      }
      return result;
    },
  };
  if (expectExit) {
    const result = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 4000))]);
    if (result === "timeout") {
      await handle.stop();
      throw new Error(`server did not exit as expected. output:\n${handle.output()}`);
    }
    return { ...handle, exit: result };
  }
  for (let i = 0; i < 100; i++) {
    const early = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 50))]);
    if (early) throw new Error(`server exited early (${JSON.stringify(early)}). output:\n${handle.output()}`);
    try {
      const res = await request(chosen, { path: "/api/health", timeout: 500 });
      if (res.status === 200) return handle;
    } catch {
      /* not up yet */
    }
  }
  await handle.stop();
  throw new Error(`server did not become healthy. output:\n${handle.output()}`);
}

// ------------------------------------------------------------------ http ---
/**
 * One HTTP request. Host defaults to the loopback authority the server expects; pass
 * `host` to override it or `noHost: true` to send none. `chunks` sends a chunked body.
 */
export function request(port, { method = "GET", path: reqPath = "/", headers = {}, body, chunks, host, noHost = false, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = { ...headers };
    if (!noHost && !Object.keys(finalHeaders).some((k) => k.toLowerCase() === "host")) {
      finalHeaders.Host = host ?? `127.0.0.1:${port}`;
    }
    if (body !== undefined && !chunks) finalHeaders["Content-Length"] = Buffer.byteLength(body);
    const req = http.request(
      { host: "127.0.0.1", port, method, path: reqPath, headers: finalHeaders, setHost: false, agent: false },
      (res) => {
        const parts = [];
        res.on("data", (chunk) => parts.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(parts).toString("utf8");
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text,
            json() {
              return JSON.parse(text);
            },
          });
        });
        res.on("error", reject);
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error(`request timed out: ${method} ${reqPath}`)));
    req.on("error", reject);
    if (chunks) for (const piece of chunks) req.write(piece);
    else if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Bearer + JSON helper for an authenticated request. */
export function authed(port, token, options = {}) {
  const headers = { Authorization: `Bearer ${token}`, ...(options.headers || {}) };
  if (options.method && options.method !== "GET" && !Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }
  return request(port, { ...options, headers });
}

/** Open an SSE stream and resolve with the status, headers and whatever arrives first. */
export function openSse(port, reqPath, headers = {}, { host } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: "GET", path: reqPath, headers: { Host: host ?? `127.0.0.1:${port}`, Accept: "text/event-stream", ...headers }, setHost: false, agent: false },
      (res) => {
        let text = "";
        let ended = false;
        res.setEncoding("utf8");
        res.on("data", (chunk) => (text += chunk));
        res.on("end", () => (ended = true));
        res.on("close", () => (ended = true));
        resolve({
          status: res.statusCode,
          headers: res.headers,
          received: () => text,
          ended: () => ended,
          close: () => req.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** Send a raw request head over a socket (for request-target forms http.request cannot make). */
export function rawRequest(port, rawHead) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => socket.write(rawHead));
    let data = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (data += chunk));
    socket.on("close", () => resolve(data));
    socket.on("error", reject);
    setTimeout(() => socket.destroy(), 2000);
  });
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(predicate, { timeoutMs = 5000, stepMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return false;
}
