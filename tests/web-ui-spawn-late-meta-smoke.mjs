#!/usr/bin/env node
// Offline regression smoke for B-107: the spawn registry must be re-keyed from
// the localId to the pi session id whether the id arrives early (via get_state)
// or late (via a session_meta event). Before the fix, the late path only called
// setPiSessionId, so getSession(proc.localId) still returned the proc while the
// early re-key path returned null — the two paths disagreed.
//
// PI_BIN is pointed at a stub child that answers get_state without a sessionId
// (so no early re-key) and emits session_meta ~200ms later.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let homeDir = null;
let projectDir = null;
let cwdDir = null;
let binDir = null;
let proc = null;
let failed = false;

function check(name, fn) {
  try {
    fn();
    console.log(`  ok - ${name}`);
  } catch (error) {
    failed = true;
    console.error(`  not ok - ${name}`);
    console.error(error && error.stack ? error.stack : error);
  }
}

try {
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-late-home-"));
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-late-proj-"));
  cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-late-cwd-"));
  binDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-ui-late-bin-"));

  // Stub `pi --mode rpc` child: answers get_state without a sessionId, then
  // emits a raw session_meta event (spawn.js wraps raw events itself), and stays
  // alive until stdin closes or SIGTERM.
  const stub = `#!/usr/bin/env node
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    if (req && req.type === "get_state") {
      process.stdout.write(JSON.stringify({ type: "response", id: req.id, command: "get_state", success: true, data: {} }) + "\\n");
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ type: "session_meta", sessionId: "pi-late-S", sessionFile: "/tmp/x.jsonl" }) + "\\n");
      }, 200);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;
  const stubPath = path.join(binDir, "pi-stub.mjs");
  fs.writeFileSync(stubPath, stub, "utf8");
  fs.chmodSync(stubPath, 0o755);

  // config.js captures HOME, the agent dirs and PI_BIN at import time, so set
  // every env var before the dynamic import.
  process.env.HOME = homeDir;
  process.env.PI_CODING_AGENT_DIR = path.join(homeDir, ".pi", "agent");
  process.env.PI_CONSOLE_PROJECT_AGENTS = projectDir;
  process.env.PI_BIN = stubPath;

  const { createSession, getSession } = await import(
    "../packages/web-ui/server/spawn.js"
  );

  proc = await createSession({ cwd: cwdDir });

  // Wait for the late session_meta to land (poll, up to 4s).
  const deadline = Date.now() + 4000;
  while (proc.piSessionId !== "pi-late-S" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  check("late session_meta sets the pi session id (B-107)", () => {
    assert.equal(proc.piSessionId, "pi-late-S");
  });

  check("getSession resolves the proc by pi session id (B-107)", () => {
    assert.equal(getSession("pi-late-S"), proc);
  });

  check("getSession no longer resolves the stale localId (B-107)", () => {
    assert.equal(getSession(proc.localId), null);
  });
} finally {
  if (proc) {
    try {
      proc.kill();
    } catch {
      /* best-effort */
    }
  }
  for (const dir of [homeDir, projectDir, cwdDir, binDir]) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

if (failed) {
  console.error("web-ui-spawn-late-meta smoke: FAIL");
  process.exit(1);
}
console.log("web-ui-spawn-late-meta smoke: OK");
