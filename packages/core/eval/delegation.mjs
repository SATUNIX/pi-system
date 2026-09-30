// Test helper: a real delegation registry (the effort and delegation-guard extensions) for code
// that launches children through subagent's runAgent. Launches are refused without it, so tests
// that fake the child process still need the guard in place, exactly as a real profile has it.
//
//   const d = await installDelegation({ tier: "exhaustive", limits: { maxConcurrent: 8, maxTotal: 64 } });
//   ... runAgent(...) ...
//   d.cleanup();
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakePi, loadModule, rmWorkspace } from "./harness.mjs";

export async function installDelegation({ tier = "exhaustive", limits = { maxConcurrent: 8, maxTotal: 64, maxScouts: 8 }, protections = ["tool-firewall", "protected-paths"] } = {}) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-delegation-"));
  const saved = { agent: process.env.PI_CODING_AGENT_DIR, effort: process.env.PI_KIT_EFFORT, config: process.env.PI_KIT_EFFORT_CONFIG };
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_KIT_EFFORT = tier;
  fs.mkdirSync(path.join(agentDir, "pi-kit"), { recursive: true });
  fs.writeFileSync(path.join(agentDir, "pi-kit", "effort.json"), JSON.stringify({ schemaVersion: 1, limits: { [tier]: limits } }));
  const guard = await loadModule("extensions/delegation-guard/index.ts");
  const effort = await loadModule("extensions/effort/index.ts");
  delete globalThis[Symbol.for("pi-kit.effort")];
  globalThis[Symbol.for("pi-kit.protections")] = new Set(protections);
  // One fake pi per extension: the fake keeps a single handler per event name.
  const effortPi = fakePi();
  const guardPi = fakePi();
  effort.default(effortPi.api);
  guard.default(guardPi.api);
  const ctx = { hasUI: false, cwd: process.cwd(), ui: {}, sessionManager: { getSessionId: () => "test" } };
  await effortPi.handlers.get("session_start")({ reason: "startup" }, ctx);
  await guardPi.handlers.get("session_start")({ reason: "startup" }, ctx);
  await effortPi.handlers.get("before_agent_start")({ systemPrompt: "" }, ctx);
  return {
    guard,
    effort,
    registry: () => globalThis[Symbol.for("pi-kit.effort")],
    /** Begin a new user turn (a fresh delegation scope). */
    newTurn: () => effortPi.handlers.get("before_agent_start")({ systemPrompt: "" }, ctx),
    cleanup() {
      for (const [key, value] of [["PI_CODING_AGENT_DIR", saved.agent], ["PI_KIT_EFFORT", saved.effort]]) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete globalThis[Symbol.for("pi-kit.effort")];
      delete globalThis[Symbol.for("pi-kit.delegation")];
      delete globalThis[Symbol.for("pi-kit.protections")];
      rmWorkspace(agentDir);
    },
  };
}
