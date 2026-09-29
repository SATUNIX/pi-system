#!/usr/bin/env node
// SessionStart hook body for the pi-improve loop. Finds the most recently
// updated, non-complete cycle under docs/agent-improvement/cycles/ and prints
// a short, factual, machine-generated summary of cycle-state.json to stdout
// (Claude Code injects a hook's stdout as context at session start). Prints
// nothing if no cycle is in progress - this must be a no-op for every session
// that isn't resuming an improvement cycle.
//
// Deliberately prints only fields already in the manifest, not an
// LLM-generated reinterpretation - the whole point is a re-grounding summary
// that cannot itself have drifted from the authoritative state.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CYCLES_DIR = path.join(ROOT, "docs", "agent-improvement", "cycles");

function loadCycles() {
  if (!fs.existsSync(CYCLES_DIR)) return [];
  return fs
    .readdirSync(CYCLES_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => path.join(CYCLES_DIR, d.name, "cycle-state.json"))
    .filter(p => fs.existsSync(p))
    .map(p => {
      try {
        return { path: p, state: JSON.parse(fs.readFileSync(p, "utf8")) };
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

const cycles = loadCycles()
  .filter(c => c.state.phaseStatus !== "complete" && c.state.currentPhase !== undefined)
  .sort((a, b) => String(b.state.updatedAt || "").localeCompare(String(a.state.updatedAt || "")));

if (cycles.length === 0) process.exit(0);

const { state } = cycles[0];
const lines = [
  "[pi-improve] An improvement cycle is in progress - re-grounding from cycle-state.json, not conversation history:",
  `  cycleId: ${state.cycleId}`,
  `  focus: ${state.focus ?? "(none recorded)"}`,
  `  currentPhase: ${state.currentPhase} (${state.phaseStatus})`,
  `  nextPhase: ${state.nextPhase ?? "(unset)"}`,
  `  repos: ${Object.entries(state.repos || {}).map(([name, r]) => `${name}@${(r.latestCommit || r.baselineCommit || "?").slice(0, 12)}`).join(", ") || "(none recorded)"}`,
  `  validatedFindings: ${(state.validatedFindingIds || []).join(", ") || "(none yet)"}`,
  `  approvedImprovements: ${(state.approvedImprovementIds || []).join(", ") || "(none yet)"}`,
  `  blockers: ${(state.blockers || []).join("; ") || "(none)"}`,
  `  manifest: ${path.relative(ROOT, cycles[0].path)}`,
  "  Run /pi-improve to resume, or read the manifest and docs/agent-improvement/README.md directly before continuing.",
];

console.log(lines.join("\n"));
