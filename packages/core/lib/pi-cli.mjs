// Running the `pi` CLI on behalf of the installer and the uninstaller.
//
// The strings passed to `pi install` and `pi remove` are data: a package source read from settings.json, a state
// marker under the agent directory, an environment variable or a checkout path. None of them may be able to run a
// command, so on POSIX the arguments go to the process as a vector and no shell is involved. On Windows pi is a
// `.cmd` shim that Node will only start through a shell, so an argument with a shell metacharacter is refused
// instead of being quoted and hoped for.
import { spawnSync } from "node:child_process";

const CONTROL = /[\0\r\n]/;
const WINDOWS_UNSAFE = /["&|<>^%!`]/;

/** The command as shown to the operator (display only; never executed). */
export const displayCommand = (args) => `pi ${args.map((a) => (/^[\w@:/.+=~-]+$/.test(a) ? a : JSON.stringify(a))).join(" ")}`;

/**
 * Run `bin args...` and throw when it fails to start or exits non-zero, as `execSync` did.
 * @param {string} bin the pi executable (a path, or "pi" to look it up on PATH)
 * @param {string[]} args
 * @param {{ stdio?: "inherit" | "pipe", platform?: string, spawn?: typeof spawnSync }} [o]
 */
export function runPi(bin, args, { stdio = "inherit", platform = process.platform, spawn = spawnSync } = {}) {
  for (const a of args) {
    if (typeof a !== "string") throw new Error("refusing to pass a non-string argument to pi");
    if (CONTROL.test(a)) throw new Error(`refusing to pass an argument with a control character to pi: ${JSON.stringify(a.slice(0, 80))}`);
  }
  const windows = platform === "win32";
  if (windows) for (const a of args) if (WINDOWS_UNSAFE.test(a)) throw new Error(`refusing to pass ${JSON.stringify(a.slice(0, 80))} to pi on Windows: it contains a shell metacharacter`);
  const command = windows && /\s/.test(bin) ? `"${bin}"` : bin;
  const r = spawn(command, args, { stdio, shell: windows, windowsHide: true });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    const error = new Error(`pi ${args[0] ?? ""} exited with ${r.status ?? r.signal}`.trim());
    error.status = r.status;
    error.stderr = r.stderr;
    throw error;
  }
  return r;
}
