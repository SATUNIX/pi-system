#!/usr/bin/env node
/**
 * WU-3 regression coverage: the extension hook contract must be accurate in three
 * places at once.
 *
 *   1. Every hook declared in an `extension.json` must exist in the schema enum
 *      (`packages/core/schema/extension.schema.json` → hooks.items.enum) and must
 *      actually be registered by a `pi.on("<hook>", ...)` in that extension's `.ts`
 *      files. `verify.mjs` only checks code -> manifest; this closes the reverse
 *      (manifest -> code) direction that let `todo` declare `session_start` while
 *      never registering it.
 *   2. The hooks table in `docs/WRITING_EXTENSIONS.md` must not name anything
 *      outside the schema enum (it used to list `message`, `session_end`, `compact`
 *      and `error`, none of which exist).
 *
 * Fully hermetic: reads local files only — no pi, docker, or network.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA = path.join(ROOT, "packages", "core", "schema", "extension.schema.json");
const DOC = path.join(ROOT, "docs", "WRITING_EXTENSIONS.md");
const EXTENSION_ROOTS = [
  path.join(ROOT, "packages", "extensions", "src"),
  path.join(ROOT, "packages", "extensions", "third_party"),
];

// The doc accidentally shipped these non-existent hooks; keep them called out so a
// regression is reported by name rather than merely as "not in enum".
const FICTIONAL_HOOKS = ["message", "session_end", "compact", "error"];

const schema = JSON.parse(fs.readFileSync(SCHEMA, "utf8"));
const hookEnum = schema.properties.hooks.items.enum;
assert.ok(Array.isArray(hookEnum) && hookEnum.length > 0, "schema hooks enum must be a non-empty array");
const hookSet = new Set(hookEnum);
// Hard assertions on the enum itself: a silent removal of a host hook must fail here.
// Pinned to the host set as of the 36-hook contract; do NOT compare against the installed
// package at runtime (that would couple the schema to a package version).
const REQUIRED_HOOKS = [
  "agent_settled",
  "before_provider_headers",
  "project_trust",
  "session_compact_failed",
  "session_info_changed",
  "ui_prompt_start",
  "ui_prompt_end",
];
assert.equal(hookEnum.length, 36, `schema hooks enum must contain exactly 36 hooks, found ${hookEnum.length}`);
assert.equal(hookSet.size, hookEnum.length, "schema hooks enum must not contain duplicates");
for (const hook of REQUIRED_HOOKS) {
  assert.ok(hookSet.has(hook), `schema hooks enum must contain host hook "${hook}"`);
}
console.log(`OK: loaded ${hookEnum.length} hooks from schema enum`);

// --- Walk every extension.json under both extension roots ---
function extensionDirs(root) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(root, e.name))
    .filter((dir) => fs.existsSync(path.join(dir, "extension.json")));
}

function listTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function registeredHooks(dir) {
  const hooks = new Set();
  const re = /pi\.on\(\s*["']([a-zA-Z_]+)["']/g;
  for (const file of listTsFiles(dir)) {
    const src = fs.readFileSync(file, "utf8");
    let m;
    while ((m = re.exec(src))) hooks.add(m[1]);
  }
  return hooks;
}

let extensionCount = 0;
for (const root of EXTENSION_ROOTS) {
  for (const dir of extensionDirs(root)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "extension.json"), "utf8"));
    const declared = manifest.hooks ?? [];
    assert.ok(Array.isArray(declared), `${manifest.name}: hooks must be an array`);
    const registered = registeredHooks(dir);
    for (const hook of declared) {
      assert.ok(hookSet.has(hook), `${manifest.name}: declared hook "${hook}" is not in the schema enum`);
      assert.ok(
        registered.has(hook),
        `${manifest.name}: declares hook "${hook}" but no pi.on("${hook}", ...) is registered in its .ts files`,
      );
    }
    extensionCount++;
  }
}
console.log(`OK: ${extensionCount} extension manifests declare only schema hooks that are registered in code`);

// --- B-021: targeted env[] allowlist for extensions whose manifest drifted from code ---
// Only these two are pinned; a general bidirectional env check would fail on many other
// extensions (skill-router, todo, verifier-board, orchestrator internal vars, ...).
const ENV_ALLOWLIST = {
  orchestrator: ["PI_KIT_ORCH_THRESHOLD", "PI_KIT_ORCH_DISABLE"],
  "branch-lab": ["PI_KIT_BRANCH_LEASES_FILE", "PI_KIT_MAX_BRANCHES"],
};
let envChecked = 0;
for (const root of EXTENSION_ROOTS) {
  for (const dir of extensionDirs(root)) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "extension.json"), "utf8"));
    const expected = ENV_ALLOWLIST[manifest.name];
    if (!expected) continue;
    const declaredEnv = manifest.env ?? [];
    assert.ok(Array.isArray(declaredEnv), `${manifest.name}: env must be an array`);
    assert.deepEqual(
      [...declaredEnv].sort(),
      [...expected].sort(),
      `${manifest.name}: env[] must declare exactly [${expected.join(", ")}], found [${declaredEnv.join(", ")}]`,
    );
    envChecked++;
  }
}
assert.equal(envChecked, Object.keys(ENV_ALLOWLIST).length, "the env[] allowlist must match extensions that exist");
console.log(`OK: ${envChecked} pinned extensions declare the exact env vars their code reads`);

// --- Parse the hooks table in the docs (the `## Hooks` section) ---
const docLines = fs.readFileSync(DOC, "utf8").split(/\r?\n/);
const hooksHeading = docLines.findIndex((l) => /^##\s+Hooks\s*$/.test(l));
assert.ok(hooksHeading !== -1, `${path.relative(ROOT, DOC)} must have a "## Hooks" section`);

const docHooks = [];
for (let i = hooksHeading + 1; i < docLines.length; i++) {
  const line = docLines[i];
  if (/^##\s/.test(line)) break; // next section
  if (!/^\s*\|/.test(line)) continue;
  const firstCell = line.split("|")[1]?.trim() ?? "";
  const m = firstCell.match(/^`([a-zA-Z_]+)`$/);
  if (m) docHooks.push(m[1]);
}
assert.ok(docHooks.length > 0, "the hooks table must name at least one hook");
console.log(`OK: parsed ${docHooks.length} hook names from the WRITING_EXTENSIONS.md hooks table`);

for (const hook of docHooks) {
  assert.ok(hookSet.has(hook), `WRITING_EXTENSIONS.md hooks table names "${hook}", which is not in the schema enum`);
}
for (const hook of REQUIRED_HOOKS) {
  assert.ok(
    docHooks.includes(hook),
    `WRITING_EXTENSIONS.md hooks table must document host hook "${hook}"`,
  );
}
for (const fictional of FICTIONAL_HOOKS) {
  assert.ok(
    !docHooks.includes(fictional),
    `WRITING_EXTENSIONS.md hooks table must not name the fictional hook "${fictional}"`,
  );
}
console.log("OK: documented hooks are a subset of the schema enum (no fictional hooks)");

console.log("OK: extension hook contract is consistent (manifest, code, schema, docs)");
