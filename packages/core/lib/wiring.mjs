/**
 * Test wiring: which test files does the CI gate actually run?
 *
 * `check-all` enumerates the `smoke:*` / `test:*` scripts in package.json. A test file that no
 * script names is never run, so it can rot (or never have passed) behind a green pipeline. This
 * module finds those files, scripts that point at a file that does not exist, and test files that
 * assert nothing, so a suite that silently does zero work is reported instead of counted as a pass.
 *
 * A test suite is wired when a package.json script names it. A shared helper (a file that is not
 * itself a suite, such as a harness) is wired when a wired file mentions its name. A suite is never
 * wired by being mentioned: comments and docs name other suites all the time, and that must not
 * excuse a suite nobody runs. Files that genuinely cannot run in CI
 * (they need a container engine) are listed in MANUAL_ONLY with the reason, so the exception is
 * visible and reviewed rather than an accident.
 */
import fs from "node:fs";
import path from "node:path";

/** Files that are deliberately not part of check:all, with why. Keys are repo-relative, posix. */
export const MANUAL_ONLY = {
  "packages/autonomy/tests/boundary-probe.mjs": "needs a container engine (Docker or Podman); run by the operator as the container-boundary check",
  "packages/container/capability/tests/smoke.sh": "needs a container engine and the capability image; run by the operator",
  "packages/container/capability/tests/validate-compose.sh": "needs a container engine (docker compose config); run by the operator",
};

const TEST_DIR = /(^|\/)(tests?|__tests__)\//;
const TEST_EXT = /\.(mjs|cjs|js|sh|py)$/;
const SKIP_DIRS = new Set(["node_modules", ".git", ".claude", ".cache", "dist", "site", "coverage"]);
const ASSERTION_MARKS = /\bassert\b|\bthrow new Error\b|process\.exit\(\s*[1-9]|\bexit 1\b|\bset -e\b|\bunittest\b|\bpytest\b/;

// A suite is something a script must run; anything else in a tests/ directory is a helper.
const SUITE = /(?:-smoke|-test|-tests|\.test|\.spec)\.(?:mjs|cjs|js)$|\.(?:sh|py)$/;

const toPosix = (p) => p.split(path.sep).join("/");

/** Every test file under `root`: anything in a `tests/`, `test/` or `__tests__/` directory. */
export function listTestFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (TEST_EXT.test(entry.name)) {
        const rel = toPosix(path.relative(root, full));
        if (TEST_DIR.test(rel)) out.push(rel);
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Files the scripts run directly: `node x.mjs`, `bash x.sh`, `python x.py`, ignoring flags. */
export function scriptTargets(scripts) {
  const targets = new Map();
  const re = /(?:^|[\s&;|(])(?:node|bash|sh|python3?)\s+((?:-{1,2}[^\s]+\s+)*)([^\s&;|)]+\.(?:mjs|cjs|js|sh|py))/g;
  for (const [name, command] of Object.entries(scripts ?? {})) {
    for (const match of String(command).matchAll(re)) {
      const file = match[2].replace(/^\.\//, "");
      if (!targets.has(file)) targets.set(file, []);
      targets.get(file).push(name);
    }
  }
  return targets;
}

/**
 * @returns {{ unwired: string[], missingTargets: {script: string, file: string}[], noAssertions: string[], manual: {file: string, reason: string}[] }}
 */
export function findWiringProblems({ root, scripts, manual = MANUAL_ONLY } = {}) {
  const files = listTestFiles(root);
  const targets = scriptTargets(scripts);
  const wired = new Set();
  for (const file of files) if (targets.has(file)) wired.add(file);

  // A helper a wired file mentions by name is wired too (a shared harness). Suites are not.
  const text = new Map();
  const read = (file) => {
    if (!text.has(file)) { try { text.set(file, fs.readFileSync(path.join(root, file), "utf8")); } catch { text.set(file, ""); } }
    return text.get(file);
  };
  let grew = true;
  while (grew) {
    grew = false;
    for (const file of files) {
      if (wired.has(file) || SUITE.test(file)) continue;
      const base = path.posix.basename(file);
      for (const other of wired) {
        if (read(other).includes(base)) { wired.add(file); grew = true; break; }
      }
    }
  }

  const missingTargets = [];
  for (const [file, names] of targets) {
    if (!TEST_DIR.test(file) && !/(^|\/)scripts\/.*smoke/.test(file)) continue;
    if (!fs.existsSync(path.join(root, file))) missingTargets.push({ script: names[0], file });
  }

  const unwired = files.filter((f) => !wired.has(f) && !(f in manual));
  // Only files a script runs directly are judged: a shared helper asserts nothing by design.
  const noAssertions = [...wired].filter((f) => targets.has(f) && /\.(mjs|cjs|js)$/.test(f) && !ASSERTION_MARKS.test(read(f))).sort();
  const manualUsed = Object.entries(manual)
    .filter(([file]) => files.includes(file))
    .map(([file, reason]) => ({ file, reason }));
  return { unwired, missingTargets, noAssertions, manual: manualUsed };
}

export function describeProblems(problems) {
  const lines = [];
  for (const f of problems.unwired) lines.push(`unwired test (no package.json script runs it, no wired test mentions it): ${f}`);
  for (const m of problems.missingTargets) lines.push(`script "${m.script}" runs a file that does not exist: ${m.file}`);
  for (const f of problems.noAssertions) lines.push(`test asserts nothing (no assert, throw or non-zero exit): ${f}`);
  return lines;
}
