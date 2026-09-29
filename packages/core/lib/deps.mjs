/**
 * Preflight dependency checks. Warns for optional deps, fails for required ones.
 */
import { execSync } from "node:child_process";

function check(cmd, name, required = true) {
  try {
    execSync(cmd, { stdio: "pipe" });
    return true;
  } catch {
    if (required) {
      console.error(`[deps] FAIL: ${name} is required but not found.`);
      process.exit(1);
    } else {
      console.warn(`[deps] WARN: ${name} not found — some features will be unavailable.`);
      return false;
    }
  }
}

export function preflight({ needsDocker = false, needsPi = true } = {}) {
  check("node --version", "node");
  check("git --version", "git");
  if (needsPi) check("pi --version", "pi");
  if (needsDocker) check("docker info", "docker", false);
}
