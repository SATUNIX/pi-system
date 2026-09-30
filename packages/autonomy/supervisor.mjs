#!/usr/bin/env node
// The previous entry point of the autonomy kit, kept so existing scripts keep working.
//
// It is now a thin mapping onto the operator CLI (cli.mjs). The detached supervisor process
// that `start --detach` launches is `cli.mjs supervise --run <id>`, which this entry also accepts:
//
//   supervisor.mjs start    --config run.json   ->  cli.mjs start --config run.json
//   supervisor.mjs resume   --run <id>          ->  cli.mjs resume --run <id>
//   supervisor.mjs status   --run <id>          ->  cli.mjs status --run <id>
//   supervisor.mjs stop     --run <id>          ->  cli.mjs pause --run <id>      (park; `resume` continues)
//   supervisor.mjs boundary --config run.json   ->  cli.mjs boundary --config run.json --probe
//
// A v0 config file (the old shape: no schemaVersion, cycles/gitRemote/promotion at the top level)
// is mapped onto the self-improve template with a deprecation warning, and now needs an explicit
// gitRemote and promotion (the old defaults are gone). Anything else is passed straight to cli.mjs.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./cli.mjs";
import { runPaths as runPathsIn, stateHome } from "./lib/paths.mjs";

/** The run directory layout for a run id under the current state home (the shape lib/paths.mjs defines). */
export function runPaths(run) { return runPathsIn(run, stateHome()); }

/**
 * Map a legacy argument list onto cli.mjs.
 * @param {string[]} argv
 * @returns {{ argv: string[], notes: string[] }}
 */
export function mapLegacy(argv) {
  const [cmd, ...rest] = argv;
  const notes = [];
  if (cmd === "stop") {
    notes.push("`stop` is now `pause`: the worker is stopped and the run is parked; `resume` continues it and `cancel` ends it");
    return { argv: ["pause", ...rest], notes };
  }
  if (cmd === "boundary" && !rest.includes("--probe") && !rest.includes("--run")) {
    notes.push("`boundary --config` alone now prints the boundary without starting containers; `supervisor.mjs boundary` keeps its old meaning by adding --probe");
    return { argv: ["boundary", ...rest, "--probe"], notes };
  }
  if (cmd === "start" || cmd === "resume" || cmd === "status" || cmd === "boundary") notes.push(`supervisor.mjs is the legacy entry point; use \`pi-autonomy ${cmd}\` (packages/autonomy/cli.mjs)`);
  return { argv, notes };
}

/** Run a legacy invocation; returns the exit code. */
export async function legacyMain(argv, overrides = {}) {
  const { argv: mapped, notes } = mapLegacy(argv);
  const stderr = overrides.stderr ?? process.stderr;
  for (const n of notes) stderr.write(`[pi-autonomy] note: ${n}\n`);
  return main(mapped, overrides);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  legacyMain(process.argv.slice(2)).then((code) => process.exit(code));
}
