#!/usr/bin/env node
/**
 * Dream mode (Epic 6 Sprint 6.3) — OFFLINE, deterministic implementation.
 *
 * The roadmap's "Future Direction / Dream mode" is a scheduled print-mode (`pi -p`) run that
 * reviews prior session activity and improves the kit's *internal* state (memory,
 * GOAL.yaml-style files) — never the operator-facing surface. It does NOT write AGENTS.md: that
 * file is loaded into the model's context and committed, and trace-derived notes carry the
 * machine-local paths of whoever ran the session. Because this kit is hardened
 * offline (no live model, no `pi -p`), this script is the deterministic stand-in: it mines
 * the trace-ledger and updates ONLY allowlisted internal paths, then self-verifies that it
 * touched nothing else. A real scheduled run would invoke `pi -p` with
 * PI_KIT_WRITE_ALLOWLIST set so `protected-paths` enforces the same allowlist at runtime.
 *
 * Usage:
 *   node packages/core/dream.mjs [--cwd <dir>] [--dry-run]
 *
 * Allowlist (the ONLY paths dream mode may modify):
 *   .pi/memory/** , GOAL.yaml , .pi/self-improvement/**
 */
import fs from "node:fs";
import path from "node:path";
import { WORKSPACE_ROOT, DOCS_DIR, PROFILES_DIR, FIRST_PARTY_DIR, THIRD_PARTY_DIR, SKILLS_DIR, PROMPTS_DIR, THEMES_DIR, SCHEMA_DIR, POLICIES_DIR, SOURCES_PATH, CORE_DIR, ENV_EXAMPLE, extensionRelPath } from "./lib/paths.mjs";

const args = process.argv.slice(2);
const get = (flag, def = null) => (args.indexOf(flag) >= 0 ? args[args.indexOf(flag) + 1] : def);
const dryRun = args.includes("--dry-run");
const CWD = path.resolve(get("--cwd", process.cwd()));

const ALLOWLIST = [path.join(".pi", "memory"), "GOAL.yaml", path.join(".pi", "self-improvement")];
const READ_HINT = /^(read|grep|glob|ls|find|cat|search|rg)/i;

function isAllowlisted(rel) {
  const n = rel.replace(/\\/g, "/");
  return ALLOWLIST.some((a) => {
    const needle = a.replace(/\\/g, "/");
    return n === needle || n.startsWith(needle + "/") || n === needle;
  });
}

function readTrace() {
  try {
    return fs
      .readFileSync(path.join(CWD, ".pi", "trace.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function mineNotes(entries) {
  const calls = entries.filter((e) => e.kind === "call" && e.tool);
  const readCounts = new Map();
  for (const e of calls) if (e.target && READ_HINT.test(e.tool)) readCounts.set(e.target, (readCounts.get(e.target) ?? 0) + 1);
  return [...readCounts.entries()]
    .filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([target, n]) => `Read \`${target}\` once — observed ${n}× in a prior session.`);
}

// Guarded write: refuses (throws) if the target escapes the allowlist. This is the belt to
// protected-paths' braces; a real run also has protected-paths enforcing PI_KIT_WRITE_ALLOWLIST.
const written = [];
function guardedWrite(rel, content) {
  if (!isAllowlisted(rel)) throw new Error(`dream: refused to write non-allowlisted path: ${rel}`);
  const abs = path.join(CWD, rel);
  if (dryRun) {
    written.push(rel + " (dry-run)");
    return;
  }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  written.push(rel);
}

const entries = readTrace();
const notes = mineNotes(entries);

if (notes.length === 0) {
  console.log(`[dream] mined ${entries.length} entries; no recurring inefficiency to record. No changes.`);
  process.exit(0);
}

// Record a memory note (allowlisted, untracked: `.pi/` is gitignored).
guardedWrite(
  path.join(".pi", "memory", "dream-notes.md"),
  [`# Dream-mode memory notes`, "", `Updated from ${entries.length} trace entries.`, "", ...notes.map((n) => `- ${n}`), ""].join("\n"),
);

console.log(`[dream] updated ${written.length} allowlisted path(s): ${written.join(", ")}`);
console.log(`[dream] allowlist: ${ALLOWLIST.join(", ")} (nothing else may be modified).`);
