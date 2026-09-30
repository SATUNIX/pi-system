#!/usr/bin/env node
/**
 * F2 regression coverage: the install marker must record the companion external
 * sources (packages/core/sources.json) under `companions`, and uninstall.mjs must
 * pass exactly those strings to `pi remove`.
 *
 * Fully hermetic: no network, no real `pi`, no verify gate. The real
 * packages/core/install.mjs runs as a subprocess with:
 *   - PI_CODING_AGENT_DIR pointing at a throwaway agent dir (settings.json +
 *     .pi-kit.json live there, never the operator's),
 *   - PI_LEAN_CTX_BIN pointing at a nonexistent path, which deterministically
 *     drops the optional pi-lean-ctx companion (its CLI is absent),
 *   - a fake `pi` (a shell script) first on PATH that logs every argv to a file.
 * It is invoked with `--all --settings-only --mode local`: --settings-only skips
 * the verify gate, --all skips the package-narrowing path, so the only external
 * effect under test is the marker write and the `pi install` calls.
 *
 * Pre-seeding settings.json with the kit entry and one companion (pi-lens) also
 * exercises the already-registered branch: the marker must still record pi-lens
 * even though this run does not reinstall it, while the three genuinely missing
 * companions are installed and recorded.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL = path.join(ROOT, "packages", "core", "install.mjs");
const UNINSTALL = path.join(ROOT, "packages", "core", "uninstall.mjs");
const SOURCES = path.join(ROOT, "packages", "core", "sources.json");

// pi-lean-ctx is the only companion that can be dropped by a prerequisite; the test
// forces its CLI to be unavailable so the expected set is deterministic.
const { external } = JSON.parse(fs.readFileSync(SOURCES, "utf8"));
const EXPECTED_COMPANIONS = external
  .filter((e) => e.mode === "reference" && e.name !== "pi-lean-ctx")
  .map((e) => e.source);
assert.ok(EXPECTED_COMPANIONS.length >= 2, "sources.json should have reference companions");

// B-022: uninstall is already non-interactive, so `--yes` is documented and forwarded
// (install.mjs passes it through) but must not produce a dead binding again.
{
  const uninstallSrc = fs.readFileSync(UNINSTALL, "utf8");
  assert.ok(
    !/const yes\s*=\s*has\("--yes"\)/.test(uninstallSrc),
    "uninstall.mjs must not declare an unused `const yes = has(\"--yes\")` binding",
  );
  console.log("  OK: uninstall.mjs has no unused --yes binding");
}

function baseEnv(agentDir, binDir, logPath) {
  return {
    ...process.env,
    PI_CODING_AGENT_DIR: agentDir,
    PI_LEAN_CTX_BIN: path.join(agentDir, "definitely-not-installed-lean-ctx"),
    PI_FAKE_LOG: logPath,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
}

function run(cmd, args, env, cwd = ROOT) {
  const result = spawnSync(cmd, args, { cwd, env, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`${cmd} ${args.join(" ")} exited ${result.status}`);
  }
  return result;
}

// WU-1: a project-scope install must write its marker under the project's .pi/ (not the
// global agent dir), and a no-`--scope` uninstall from the project dir must auto-detect
// that marker, remove the kit with `-l`, and leave a pre-existing global marker untouched.
function testProjectScopeMarkerAndUninstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-marker-project-"));
  const projectDir = path.join(dir, "project");
  const agentDir = path.join(dir, "agent");
  const binDir = path.join(dir, "bin");
  const logPath = path.join(dir, "pi-calls.log");
  try {
    fs.mkdirSync(projectDir, { recursive: true });
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    // Fake `pi` first on PATH: record every invocation, do nothing else.
    const fakePi = path.join(binDir, "pi");
    fs.writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_FAKE_LOG"\nexit 0\n`);
    fs.chmodSync(fakePi, 0o755);

    // 1. Pre-seed a GLOBAL marker that must survive byte-identical.
    const globalMarkerPath = path.join(agentDir, ".pi-kit.json");
    fs.writeFileSync(
      globalMarkerPath,
      JSON.stringify({ kitSource: "global-sentinel", scope: "global", companions: [] }, null, 2),
    );
    const globalSentinel = fs.readFileSync(globalMarkerPath);

    // 2. Project-scope install from the project dir.
    run(
      process.execPath,
      [INSTALL, "--all", "--no-externals", "--settings-only", "--mode", "local", "--scope", "project"],
      baseEnv(agentDir, binDir, logPath),
      projectDir,
    );

    // 3. Project marker in the cwd; global marker untouched.
    const projectMarkerPath = path.join(projectDir, ".pi", ".pi-kit.json");
    assert.ok(fs.existsSync(projectMarkerPath), "project install must write <cwd>/.pi/.pi-kit.json");
    const projectMarker = JSON.parse(fs.readFileSync(projectMarkerPath, "utf8"));
    assert.equal(projectMarker.scope, "project", "project marker must record scope: project");
    assert.deepEqual(fs.readFileSync(globalMarkerPath), globalSentinel, "project install must not clobber the global marker");

    // 4. Uninstall with no --scope from the project dir.
    run(process.execPath, [UNINSTALL, "--yes"], baseEnv(agentDir, binDir, logPath), projectDir);

    // 5. Auto-detected project scope: `-l`, project marker gone, global sentinel survives.
    const uninstallLog = fs.readFileSync(logPath, "utf8");
    const kitRemovals = uninstallLog.split("\n").filter((l) => l.startsWith(`remove ${ROOT}`));
    assert.ok(kitRemovals.length > 0, "project uninstall must remove the kit");
    assert.ok(kitRemovals.every((l) => l.endsWith(" -l")), "project uninstall must pass -l and never a plain removal");
    assert.ok(!fs.existsSync(projectMarkerPath), "project uninstall must remove the project marker");
    assert.deepEqual(fs.readFileSync(globalMarkerPath), globalSentinel, "project uninstall must not touch the global marker");

    console.log("  OK: project install/uninstall write and remove .pi/.pi-kit.json, use -l, and leave the global marker intact");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Backward compatibility: no `--scope` and no project marker in the cwd falls back to the
// global marker and removes the kit without `-l`.
function testGlobalScopeAutoDetect() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-marker-globalauto-"));
  const agentDir = path.join(dir, "agent");
  const binDir = path.join(dir, "bin");
  const logPath = path.join(dir, "pi-calls.log");
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const fakePi = path.join(binDir, "pi");
    fs.writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_FAKE_LOG"\nexit 0\n`);
    fs.chmodSync(fakePi, 0o755);

    fs.writeFileSync(
      path.join(agentDir, ".pi-kit.json"),
      JSON.stringify({ kitSource: ROOT, scope: "global", companions: [] }, null, 2),
    );

    run(process.execPath, [UNINSTALL, "--yes"], baseEnv(agentDir, binDir, logPath), dir);
    const kitRemovals = fs.readFileSync(logPath, "utf8").split("\n").filter((l) => l.startsWith(`remove ${ROOT}`));
    assert.ok(kitRemovals.length > 0, "global uninstall must remove the kit");
    assert.ok(kitRemovals.every((l) => !l.endsWith(" -l")), "auto-detected global uninstall must not pass -l");
    assert.ok(!fs.existsSync(path.join(agentDir, ".pi-kit.json")), "global uninstall must remove the global marker");

    console.log("  OK: no --scope with only a global marker removes the kit without -l");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// B-014: `--no-externals` must record no companions in the marker, and a subsequent
// uninstall must therefore remove none of them. Uses the same hermetic harness as the
// `--all` scenario above (throwaway agent dir, fake pi, no network, no verify gate).
function testNoExternalsRecordsNoCompanions() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-marker-noext-"));
  const agentDir = path.join(dir, "agent");
  const binDir = path.join(dir, "bin");
  const logPath = path.join(dir, "pi-calls.log");
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    // Fake `pi` first on PATH: record every invocation, do nothing else.
    const fakePi = path.join(binDir, "pi");
    fs.writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_FAKE_LOG"\nexit 0\n`);
    fs.chmodSync(fakePi, 0o755);

    // Kit already registered so the run exercises only the external/marker path.
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [ROOT] }, null, 2),
    );

    run(process.execPath, [INSTALL, "--all", "--no-externals", "--settings-only", "--mode", "local", "--scope", "global"], baseEnv(agentDir, binDir, logPath));

    const marker = JSON.parse(fs.readFileSync(path.join(agentDir, ".pi-kit.json"), "utf8"));
    assert.ok(Array.isArray(marker.companions), "marker must record a companions array");
    assert.deepEqual(marker.companions, [], "--no-externals must record no companions in the marker");

    const installLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "";
    for (const src of EXPECTED_COMPANIONS) {
      assert.ok(!installLog.includes(`install ${src}`), `--no-externals must not install companion ${src}`);
    }

    // Uninstall reads the marker; with an empty companions array it must not remove any.
    run(process.execPath, [UNINSTALL, "--scope", "global", "--yes"], baseEnv(agentDir, binDir, logPath));
    const uninstallLog = fs.readFileSync(logPath, "utf8");
    for (const src of EXPECTED_COMPANIONS) {
      assert.ok(!uninstallLog.includes(`remove ${src}`), `uninstall must not remove companion ${src} when --no-externals recorded none`);
    }
    assert.ok(uninstallLog.includes(`remove ${ROOT}`), "uninstall must still remove the kit itself");

    console.log("  OK: --no-externals records companions: [] and uninstall removes none");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// B-028: switching to a profile that no longer selects a companion must not drop it
// from the marker, otherwise a later uninstall orphans the still-registered package.
// `quick` does not include pi-lens, and its only own companion (pi-lean-ctx) is dropped
// by the absent-CLI gate, so the fresh selection is empty while the prior marker holds
// pi-lens. The marker must retain it and uninstall must still remove it.
function testPreviousCompanionsRetained() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-marker-retain-"));
  const agentDir = path.join(dir, "agent");
  const binDir = path.join(dir, "bin");
  const logPath = path.join(dir, "pi-calls.log");
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const fakePi = path.join(binDir, "pi");
    fs.writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_FAKE_LOG"\nexit 0\n`);
    fs.chmodSync(fakePi, 0o755);

    const priorCompanion = EXPECTED_COMPANIONS[0];
    // Prior state: kit + pi-lens registered, and the marker already tracks pi-lens.
    fs.writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ packages: [ROOT, priorCompanion] }, null, 2),
    );
    fs.writeFileSync(
      path.join(agentDir, ".pi-kit.json"),
      JSON.stringify({ kitSource: ROOT, scope: "global", profile: "autonomous", companions: [priorCompanion] }, null, 2),
    );

    run(process.execPath, [INSTALL, "--profile", "quick", "--settings-only", "--mode", "local", "--scope", "global"], baseEnv(agentDir, binDir, logPath));

    const marker = JSON.parse(fs.readFileSync(path.join(agentDir, ".pi-kit.json"), "utf8"));
    assert.ok(
      marker.companions.includes(priorCompanion),
      `a companion from the previous profile must stay recorded (got ${JSON.stringify(marker.companions)})`,
    );

    // Uninstall reads the same marker and must still remove the carried-over companion.
    run(process.execPath, [UNINSTALL, "--scope", "global", "--yes"], baseEnv(agentDir, binDir, logPath));
    const uninstallLog = fs.readFileSync(logPath, "utf8");
    assert.ok(
      uninstallLog.includes(`remove ${priorCompanion}`),
      "uninstall must still remove a companion carried over from the previous profile",
    );

    console.log("  OK: a companion from the previous profile stays recorded and is removed on uninstall");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// WU-2: settings.json containing the JSON literal `null` is valid JSON but not a settings
// object. readSettings must fall back to {} rather than returning null, which callers such as
// findPackageEntry dereference (`settings.packages`).
function testNullSettingsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-marker-null-"));
  const agentDir = path.join(dir, "agent");
  const binDir = path.join(dir, "bin");
  const logPath = path.join(dir, "pi-calls.log");
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const fakePi = path.join(binDir, "pi");
    fs.writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_FAKE_LOG"\nexit 0\n`);
    fs.chmodSync(fakePi, 0o755);

    // Valid JSON, but not an object.
    fs.writeFileSync(path.join(agentDir, "settings.json"), "null");

    const result = run(
      process.execPath,
      [INSTALL, "--dry-run", "--settings-only", "--profile", "balanced"],
      baseEnv(agentDir, binDir, logPath),
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.ok(!output.includes("Cannot read properties of null"), `a null settings.json must not crash (got: ${output})`);
    assert.ok(!output.includes("TypeError"), `a null settings.json must not produce a stack trace (got: ${output})`);

    console.log("  OK: a null settings.json is treated as empty and does not crash");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// F3: `--capture-overrides` must tolerate a marker profile with no profiles/<name>.json.
// `--only` records profile "custom" and `--all` records "all"; neither file exists. The
// capture path falls back to the empty baseline and the marker's recorded extensions
// instead of aborting with exit 1.
function testCaptureOverridesCustomProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-marker-capture-"));
  const agentDir = path.join(dir, "agent");
  const binDir = path.join(dir, "bin");
  const projectDir = path.join(dir, "project");
  const logPath = path.join(dir, "pi-calls.log");
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(projectDir, { recursive: true });

    const fakePi = path.join(binDir, "pi");
    fs.writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_FAKE_LOG"\nexit 0\n`);
    fs.chmodSync(fakePi, 0o755);

    // Kit already registered, so the `--settings-only` run skips re-registration and the
    // entry is present for capture-overrides to compare against.
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ packages: [ROOT] }, null, 2),
    );

    // A `--only` install records profile "custom"; no profiles/custom.json exists.
    run(
      process.execPath,
      [INSTALL, "--only", "context-sieve", "--settings-only", "--mode", "local", "--scope", "project"],
      baseEnv(agentDir, binDir, logPath),
      projectDir,
    );
    const markerPath = path.join(projectDir, ".pi", ".pi-kit.json");
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    assert.equal(marker.profile, "custom", "a --only install must record profile: custom");

    // Before the fix this aborted with exit 1 ("Profile not found: .../custom.json");
    // run() throws on a nonzero status.
    const capture = run(
      process.execPath,
      [INSTALL, "--capture-overrides", "--scope", "project"],
      baseEnv(agentDir, binDir, logPath),
      projectDir,
    );
    const output = `${capture.stdout}\n${capture.stderr}`;
    assert.ok(
      !output.includes("Profile not found"),
      `capture-overrides must not abort when the marker profile has no JSON (got: ${output})`,
    );
    assert.match(output, /\[install\] capture-overrides:/, "capture path must have run");

    console.log("  OK: --capture-overrides tolerates a custom (--only) marker profile");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// F4: `--dry-run` must not run the verify gate. The gate shells out with a bare `node`,
// so a fake `node` first on PATH records the invocation while the outer installer keeps
// running under its absolute process.execPath.
function testDryRunSkipsVerifyGate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-marker-dryrun-"));
  const agentDir = path.join(dir, "agent");
  const binDir = path.join(dir, "bin");
  const logPath = path.join(dir, "pi-calls.log");
  const nodeLog = path.join(dir, "node-calls.log");
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const fakePi = path.join(binDir, "pi");
    fs.writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_FAKE_LOG"\nexit 0\n`);
    fs.chmodSync(fakePi, 0o755);

    // Only the gate's bare `node` reaches this shim; the installer is spawned via
    // process.execPath, an absolute path.
    const fakeNode = path.join(binDir, "node");
    fs.writeFileSync(fakeNode, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_NODE_LOG"\nexit 0\n`);
    fs.chmodSync(fakeNode, 0o755);

    const env = { ...baseEnv(agentDir, binDir, logPath), PI_NODE_LOG: nodeLog };
    run(
      process.execPath,
      [INSTALL, "--dry-run", "--mode", "local", "--profile", "balanced", "--scope", "global"],
      env,
    );

    const nodeCalls = fs.existsSync(nodeLog) ? fs.readFileSync(nodeLog, "utf8") : "";
    assert.ok(
      !nodeCalls.includes("verify.mjs"),
      `--dry-run must not run the verify gate (node calls: ${JSON.stringify(nodeCalls)})`,
    );

    console.log("  OK: --dry-run does not run the verify gate");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// B-031: a --dry-run preview must not require `pi` or `git` on PATH. The installer is
// launched by absolute process.execPath, so PATH can be an empty dir; resolveCommand
// for both tools returns null, and the dry-run check must warn and continue instead of
// exiting 1.
function testDryRunWithoutRequiredTools() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-marker-dryrun-no-tools-"));
  const agentDir = path.join(dir, "agent");
  const binDir = path.join(dir, "bin");
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const result = spawnSync(
      process.execPath,
      [INSTALL, "--dry-run", "--mode", "local", "--settings-only", "--profile", "balanced", "--scope", "global"],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          PI_LEAN_CTX_BIN: path.join(agentDir, "no-lean-ctx"),
          PATH: binDir,
        },
        encoding: "utf8",
      },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, `--dry-run without pi/git must exit 0 (stdout: ${result.stdout} stderr: ${result.stderr})`);
    assert.ok(!/FAIL: pi is required/.test(output), `--dry-run must not fail on a missing pi (got: ${output})`);
    assert.match(output, /\[install\] pi-system/, `a --dry-run preview must proceed without pi/git (got: ${output})`);

    console.log("  OK: --dry-run does not require pi/git on PATH");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// F5/B-025: an unknown --scope must be rejected instead of silently becoming project
// scope (and registering the kit globally).
function testInvalidScopeRejected() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-marker-scope-"));
  const agentDir = path.join(dir, "agent");
  const binDir = path.join(dir, "bin");
  const logPath = path.join(dir, "pi-calls.log");
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });

    const fakePi = path.join(binDir, "pi");
    fs.writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_FAKE_LOG"\nexit 0\n`);
    fs.chmodSync(fakePi, 0o755);

    const result = spawnSync(
      process.execPath,
      [INSTALL, "--dry-run", "--settings-only", "--scope", "bogus", "--profile", "balanced"],
      { cwd: ROOT, env: baseEnv(agentDir, binDir, logPath), encoding: "utf8" },
    );
    assert.equal(result.status, 1, `--scope bogus must exit 1 (stdout: ${result.stdout})`);
    assert.match(
      `${result.stdout}\n${result.stderr}`,
      /unknown --scope "bogus"/,
      "an invalid --scope must print a clear error",
    );

    console.log("  OK: an invalid --scope is rejected with exit 1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Regression: an `--all` install leaves the settings entry as a bare string (whole package,
// unfiltered). captureDrift reads extensions only from an object entry, so treating a string
// as `{}` saw zero actual extensions and wrote a remove-everything overrides.json. Capture
// must instead report nothing to compare and leave overrides untouched.
function testCaptureOverridesAllStringEntryDoesNotRemoveAll() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-marker-capture-all-"));
  const agentDir = path.join(dir, "agent");
  const binDir = path.join(dir, "bin");
  const projectDir = path.join(dir, "project");
  const logPath = path.join(dir, "pi-calls.log");
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });

    const fakePi = path.join(binDir, "pi");
    fs.writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_FAKE_LOG"\nexit 0\n`);
    fs.chmodSync(fakePi, 0o755);

    // Kit already registered so the `--settings-only` run does not rely on the fake pi.
    fs.writeFileSync(
      path.join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ packages: [ROOT] }, null, 2),
    );

    run(
      process.execPath,
      [INSTALL, "--all", "--no-externals", "--settings-only", "--mode", "local", "--scope", "project"],
      baseEnv(agentDir, binDir, logPath),
      projectDir,
    );
    assert.equal(
      typeof JSON.parse(fs.readFileSync(path.join(projectDir, ".pi", "settings.json"), "utf8")).packages[0],
      "string",
      "an --all install must leave the kit entry as a bare string",
    );

    const capture = run(
      process.execPath,
      [INSTALL, "--capture-overrides", "--scope", "project"],
      baseEnv(agentDir, binDir, logPath),
      projectDir,
    );

    const output = `${capture.stdout}\n${capture.stderr}`;
    assert.match(output, /\[install\] capture-overrides:/, `capture path must have run (got: ${output})`);
    const overridesFile = path.join(agentDir, "pi-kit", "overrides.json");
    assert.equal(fs.existsSync(overridesFile), false, "capture must not create overrides.json for an incomparable entry");

    console.log("  OK: --capture-overrides on an --all (string entry) writes no remove-all");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Regression: an object entry without an `extensions` array (e.g. a hand-written
// `{ source }` registration, or a legacy entry) is just as incomparable as a bare
// string. captureDrift would read zero actual extensions and write a remove-all.
function testCaptureOverridesObjectWithoutExtensions() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-marker-capture-noext-"));
  const agentDir = path.join(dir, "agent");
  const binDir = path.join(dir, "bin");
  const projectDir = path.join(dir, "project");
  const logPath = path.join(dir, "pi-calls.log");
  const settingsPath = path.join(projectDir, ".pi", "settings.json");
  try {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });

    const fakePi = path.join(binDir, "pi");
    fs.writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_FAKE_LOG"\nexit 0\n`);
    fs.chmodSync(fakePi, 0o755);

    fs.writeFileSync(settingsPath, JSON.stringify({ packages: [ROOT] }, null, 2));
    run(
      process.execPath,
      [INSTALL, "--only", "context-sieve", "--settings-only", "--mode", "local", "--scope", "project"],
      baseEnv(agentDir, binDir, logPath),
      projectDir,
    );

    // Drop the extension list from the (object) entry while keeping it registered.
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    settings.packages[0] = { source: ROOT };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    const capture = run(
      process.execPath,
      [INSTALL, "--capture-overrides", "--scope", "project"],
      baseEnv(agentDir, binDir, logPath),
      projectDir,
    );

    const output = `${capture.stdout}\n${capture.stderr}`;
    assert.match(output, /\[install\] capture-overrides:/, `capture path must have run (got: ${output})`);
    const overridesFile = path.join(agentDir, "pi-kit", "overrides.json");
    assert.equal(fs.existsSync(overridesFile), false, "capture must not create overrides.json for an incomparable entry");

    console.log("  OK: --capture-overrides on an object entry without extensions writes no remove-all");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// I1: an operator-owned but corrupt overrides.json must never be silently clobbered.
// --capture-overrides refuses (exit 1) before writing; a normal install warns and ignores it.
// Both the unparseable-JSON and the valid-JSON-but-not-an-object cases are covered.
function testCaptureOverridesRefusesInvalidOverrides() {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "pi-kit-marker-corrupt-overrides-"),
  );
  const agentDir = path.join(dir, "agent");
  const binDir = path.join(dir, "bin");
  const projectDir = path.join(dir, "project");
  const logPath = path.join(dir, "pi-calls.log");
  try {
    fs.mkdirSync(path.join(agentDir, "pi-kit"), { recursive: true });
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });

    const fakePi = path.join(binDir, "pi");
    fs.writeFileSync(
      fakePi,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_FAKE_LOG"\nexit 0\n`,
    );
    fs.chmodSync(fakePi, 0o755);

    // Kit already registered, so a marker/entry exists for capture-overrides to compare against.
    fs.writeFileSync(
      path.join(projectDir, ".pi", "settings.json"),
      JSON.stringify({ packages: [ROOT] }, null, 2),
    );

    const overridesFile = path.join(agentDir, "pi-kit", "overrides.json");

    // First: unparseable JSON. Second: valid JSON but not an object.
    for (const corrupt of [
      `{ "extensions": { "add": ["task-graph",] } }`,
      "[1,2,3]",
    ]) {
      fs.writeFileSync(overridesFile, corrupt);
      const before = fs.readFileSync(overridesFile);

      // Must refuse before the marker/entry checks, so the file can never be overwritten.
      const capture = spawnSync(
        process.execPath,
        [INSTALL, "--capture-overrides", "--scope", "project"],
        {
          cwd: projectDir,
          env: baseEnv(agentDir, binDir, logPath),
          encoding: "utf8",
        },
      );
      assert.equal(
        capture.status,
        1,
        `capture-overrides on an invalid overrides.json must exit 1 (stderr: ${capture.stderr})`,
      );
      assert.match(
        capture.stderr,
        /refusing to overwrite/,
        "capture-overrides must say it is refusing to overwrite",
      );
      assert.deepEqual(
        fs.readFileSync(overridesFile),
        before,
        "capture-overrides must not touch an invalid overrides.json",
      );

      // A normal install warns and continues with the empty fallback, file bytes intact.
      const install = spawnSync(
        process.execPath,
        [INSTALL, "--settings-only", "--mode", "local", "--scope", "project"],
        {
          cwd: projectDir,
          env: baseEnv(agentDir, binDir, logPath),
          encoding: "utf8",
        },
      );
      assert.equal(
        install.status,
        1,
        `a normal profile install must fail closed on unreadable overrides (stderr: ${install.stderr})`,
      );
      assert.match(
        install.stderr + install.stdout,
        /invalid overrides|not valid JSON|must contain a JSON object/,
        "a normal install must explain the invalid overrides refusal",
      );
      assert.deepEqual(
        fs.readFileSync(overridesFile),
        before,
        "a normal install must not touch an invalid overrides.json",
      );
    }

    console.log(
      "  OK: an invalid overrides.json is refused by capture and normal profile installs without clobbering it",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-kit-marker-"));
const agentDir = path.join(dir, "agent");
const binDir = path.join(dir, "bin");
const logPath = path.join(dir, "pi-calls.log");
try {
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(binDir, { recursive: true });

  // Fake `pi` first on PATH: record every invocation, do nothing else.
  const fakePi = path.join(binDir, "pi");
  fs.writeFileSync(fakePi, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$PI_FAKE_LOG"\nexit 0\n`);
  fs.chmodSync(fakePi, 0o755);

  // Pre-seed: kit already registered (local checkout) and pi-lens already installed.
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ packages: [ROOT, EXPECTED_COMPANIONS[0]] }, null, 2),
  );

  run(process.execPath, [INSTALL, "--all", "--settings-only", "--mode", "local", "--scope", "global"], baseEnv(agentDir, binDir, logPath));

  const marker = JSON.parse(fs.readFileSync(path.join(agentDir, ".pi-kit.json"), "utf8"));
  assert.ok(Array.isArray(marker.companions), "marker must record a companions array");
  assert.deepEqual(marker.companions, EXPECTED_COMPANIONS, "marker.companions must list every managed companion in sources.json order");
  assert.ok(!marker.companions.includes(external.find((e) => e.name === "pi-lean-ctx").source), "a skipped companion must not be recorded");

  const installLog = fs.readFileSync(logPath, "utf8");
  assert.ok(!installLog.includes(`install ${EXPECTED_COMPANIONS[0]}`), "an already-registered companion must not be reinstalled");
  for (const src of EXPECTED_COMPANIONS.slice(1)) {
    assert.ok(installLog.includes(`install ${src}`), `missing companion ${src} must be installed`);
  }

  // Uninstall reads the same marker and must remove each recorded companion.
  run(process.execPath, [UNINSTALL, "--scope", "global", "--yes"], baseEnv(agentDir, binDir, logPath));
  const uninstallLog = fs.readFileSync(logPath, "utf8");
  for (const src of EXPECTED_COMPANIONS) {
    assert.ok(uninstallLog.includes(`remove ${src}`), `uninstall must pass "${src}" to pi remove`);
  }
  assert.ok(uninstallLog.includes(`remove ${ROOT}`), "uninstall must still remove the kit itself");

  console.log(`  OK: marker records ${marker.companions.length} companion(s); uninstall removes them all`);

  testNoExternalsRecordsNoCompanions();
  testProjectScopeMarkerAndUninstall();
  testGlobalScopeAutoDetect();
  testPreviousCompanionsRetained();
  testNullSettingsFile();
  testCaptureOverridesCustomProfile();
  testDryRunSkipsVerifyGate();
  testDryRunWithoutRequiredTools();
  testInvalidScopeRejected();
  testCaptureOverridesAllStringEntryDoesNotRemoveAll();
  testCaptureOverridesObjectWithoutExtensions();
  testCaptureOverridesRefusesInvalidOverrides();

  console.log("\n[install-marker-smoke] all checks passed");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
