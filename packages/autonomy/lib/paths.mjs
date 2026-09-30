// Where a run lives. Everything is under one directory, $PI_AUTONOMY_HOME/<run> (default
// ~/.local/state/pi-autonomy/<run>); nothing is written to ~/.pi.
import os from "node:os";
import path from "node:path";

export function stateHome(env = process.env) {
  return env.PI_AUTONOMY_HOME || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "pi-autonomy");
}

/**
 * The run directory layout.
 *
 * Supervisor-held (the worker never mounts these writable, and most it never sees):
 *   contract.json, state.json, supervisor.lock, control/, checks.json, overlay/, public/ (mounted
 *   read-only at /run), mirror.git, steps/, egress/, deploy/, meter/, results/, supervisor.log
 * Worker side (written by containers): remote.git, work/, agent-state/
 */
export function runPaths(run, home = stateHome()) {
  const root = path.join(home, run);
  const p = (...parts) => path.join(root, ...parts);
  return {
    root, contract: p("contract.json"), state: p("state.json"), log: p("supervisor.log"), lock: p("supervisor.lock"), control: p("control"),
    checks: p("checks.json"), overlay: p("overlay"), public: p("public"), mirror: p("mirror.git"), steps: p("steps"), egress: p("egress"), deploy: p("deploy"), meter: p("meter"), results: p("results"),
    remote: p("remote.git"), work: p("work"), agentState: p("agent-state"), bundles: p("bundles"), gateWork: p("gate-work"), tmp: p("tmp"), references: p("references"),
    boundary: p("boundary.json"), services: p("services"),
  };
}

/** The directories a container may bind-mount from: the run directory and the supervisor's own scripts. */
export const mountRoots = (p, extra = []) => [p.root, ...extra];
