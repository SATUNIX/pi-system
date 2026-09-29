#!/usr/bin/env node
/**
 * Eval harness v1 (Epic 4 Sprint 4.2). Runs every fixture in packages/core/eval/fixtures.mjs,
 * prints a scorecard, and exits non-zero if ANY fixture regresses. Deterministic and
 * fully offline — no model backend, no network. This is the measurement flywheel: a
 * regression in the safety boundary, verification wiring, or orchestration flow fails CI.
 *
 * Usage:
 *   node packages/core/eval/run.mjs [--category security|verification|orchestration] [--json]
 */
import { fixtures } from "./fixtures.mjs";

const args = process.argv.slice(2);
const categoryFilter = args.includes("--category") ? args[args.indexOf("--category") + 1] : null;
const asJson = args.includes("--json");

const selected = categoryFilter ? fixtures.filter((f) => f.category === categoryFilter) : fixtures;

const results = [];
for (const fixture of selected) {
  const start = Date.now();
  try {
    await fixture.run();
    results.push({ name: fixture.name, category: fixture.category, pass: true, ms: Date.now() - start });
  } catch (error) {
    results.push({
      name: fixture.name,
      category: fixture.category,
      pass: false,
      ms: Date.now() - start,
      error: String(error?.message || error),
    });
  }
}

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;

if (asJson) {
  console.log(JSON.stringify({ total: results.length, passed, failed, results }, null, 2));
} else {
  console.log("\n[eval] pi-kit eval harness v1\n");
  const byCat = {};
  for (const r of results) (byCat[r.category] ||= []).push(r);
  for (const cat of Object.keys(byCat).sort()) {
    console.log(`  ${cat}`);
    for (const r of byCat[cat]) {
      console.log(`    ${r.pass ? "PASS" : "FAIL"}  ${r.name} (${r.ms}ms)${r.error ? `\n          ${r.error}` : ""}`);
    }
  }
  console.log(`\n[eval] ${passed}/${results.length} fixtures passed${failed ? `, ${failed} FAILED` : ""}.`);
}

if (results.length === 0) {
  console.error("[eval] no fixtures ran — check --category filter");
  process.exit(1);
}
process.exit(failed > 0 ? 1 : 0);
