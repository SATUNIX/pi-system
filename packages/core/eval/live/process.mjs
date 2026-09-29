// Bound the host CLI too: a failed container stop must not leave the case promise pending.
import { spawn, spawnSync } from "node:child_process";
export async function runBoundedProcess({ command, args, stdio, timeoutMs, stop }) {
  const child = spawn(command, args, { stdio });
  let timedOut = false;
  const completed = new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
  const timer = setTimeout(() => {
    timedOut = true;
    try { stop(); }
    catch { /* The owning runner retains exact container names for cleanup. */ }
    finally { child.kill("SIGKILL"); }
  }, timeoutMs);
  try { return { exitCode: await completed, timedOut }; }
  finally { clearTimeout(timer); }
}

export function runNamedValidation({ name, args, timeoutMs = 30_000 }) {
  try {
    return spawnSync("docker", ["run", "--rm", "--name", name, ...args], { encoding: "utf8", timeout: timeoutMs });
  } finally {
    spawnSync("docker", ["rm", "-f", name], { timeout: 10_000, stdio: "ignore" });
  }
}
