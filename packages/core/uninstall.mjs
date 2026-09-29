#!/usr/bin/env node
/**
 * Uninstall pi-system and its managed companion packages.
 * Reads the install state marker: <cwd>/.pi/.pi-kit.json for a project install,
 * otherwise ~/.pi/agent/.pi-kit.json. Without an explicit --scope the project marker
 * in the current directory wins when it exists; otherwise the global marker is used.
 *
 * Usage:
 *   node packages/core/uninstall.mjs [--scope <global|project>] [--dry-run] [--yes]
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { globalAgentDir } from "./lib/settings.mjs";
import { WORKSPACE_ROOT, DOCS_DIR, PROFILES_DIR, FIRST_PARTY_DIR, THIRD_PARTY_DIR, SKILLS_DIR, PROMPTS_DIR, THEMES_DIR, SCHEMA_DIR, POLICIES_DIR, SOURCES_PATH, CORE_DIR, ENV_EXAMPLE, extensionRelPath } from "./lib/paths.mjs";

const args = process.argv.slice(2);
const has = flag => args.includes(flag);
const get = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : def; };

const explicitScope = args.includes("--scope") ? get("--scope", "global") : null;
const dryRun = has("--dry-run");

// Resolve which marker to read and the effective scope from it:
//   - an explicit --scope forces the location (global -> agent dir, project -> <cwd>/.pi),
//   - otherwise a project marker in the cwd is preferred and the global one is the fallback,
//     so the documented `install.mjs --uninstall` from the repo root finds a project install.
const globalMarkerPath = path.join(globalAgentDir(), ".pi-kit.json");
const projectMarkerPath = path.join(process.cwd(), ".pi", ".pi-kit.json");
let markerPath;
let effectiveScope;
if (explicitScope === "project") {
  markerPath = projectMarkerPath;
  effectiveScope = "project";
} else if (explicitScope === "global") {
  markerPath = globalMarkerPath;
  effectiveScope = "global";
} else if (fs.existsSync(projectMarkerPath)) {
  markerPath = projectMarkerPath;
  effectiveScope = "project";
} else {
  markerPath = globalMarkerPath;
  effectiveScope = "global";
}

function run(cmd) {
  console.log(`  > ${cmd}`);
  if (!dryRun) execSync(cmd, { stdio: "inherit" });
}

console.log("\n[uninstall] pi-system");
console.log(`  scope:    ${effectiveScope}`);
console.log(`  dry-run:  ${dryRun}`);
console.log("");

// Read state marker
let marker = null;
if (fs.existsSync(markerPath)) {
  try {
    marker = JSON.parse(fs.readFileSync(markerPath, "utf8"));
    console.log(`[uninstall] Found state marker: source=${marker.kitSource}, profile=${marker.profile}`);
  } catch {
    console.warn("[uninstall] Could not parse state marker — will attempt removal by current path");
  }
}

const scopeFlag = effectiveScope === "project" ? " -l" : "";

// 1. Remove the kit package
const kitSource = marker?.kitSource ?? process.cwd();
console.log(`\n[uninstall] Removing kit (${kitSource})...`);
try {
  run(`pi remove "${kitSource}"${scopeFlag}`);
} catch (e) {
  console.warn(`[uninstall] WARN: pi remove failed: ${e.message}`);
}

// 2. Remove companion externals recorded in the marker
if (marker?.companions?.length > 0) {
  console.log(`\n[uninstall] Removing ${marker.companions.length} companion(s)...`);
  for (const src of marker.companions) {
    try { run(`pi remove "${src}"${scopeFlag}`); }
    catch (e) { console.warn(`[uninstall] WARN: pi remove ${src} failed: ${e.message}`); }
  }
}

// 3. Remove state marker
if (!dryRun && fs.existsSync(markerPath)) {
  fs.unlinkSync(markerPath);
  console.log(`[uninstall] Removed state marker: ${markerPath}`);
}

console.log(`
[uninstall] Done.

Next steps:
  1. Start pi:   pi
  2. Reload:     /reload
  3. Verify:     pi list  (kit should no longer appear)
`);
