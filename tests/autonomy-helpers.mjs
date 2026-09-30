// Shared helpers for the tests/autonomy-*.mjs smoke tests.
//
// The effort policy lives in packages/core/lib/effort.mjs. Tests use that module when it is
// present and otherwise a small local stub with the same API (canonical tier ids minimal,
// focused, standard, thorough, exhaustive; default standard; aliases E1..E5 and 1..5), so the
// autonomy suite does not depend on which branch of the core package it is checked out with.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { coreEffort } from "../packages/autonomy/lib/effort.mjs";

const TIERS = ["minimal", "focused", "standard", "thorough", "exhaustive"];
const ALIASES = { min: "minimal", std: "standard", default: "standard", max: "exhaustive" };

export const stubEffort = {
  isStub: true,
  loadEffortPolicy: () => ({ default: "standard", tiers: TIERS.map((id, i) => ({ id, level: i + 1, code: `E${i + 1}`, label: id })) }),
  normalizeTier(input) {
    if (typeof input === "number") input = String(input);
    if (typeof input !== "string") return null;
    const key = input.trim().toLowerCase();
    if (TIERS.includes(key)) return key;
    if (ALIASES[key]) return ALIASES[key];
    const m = key.match(/^e?([1-5])$/);
    return m ? TIERS[Number(m[1]) - 1] : null;
  },
  clampTier(requested, cap) {
    const c = TIERS.indexOf(stubEffort.normalizeTier(cap) ?? "standard");
    const r = TIERS.indexOf(stubEffort.normalizeTier(requested) ?? TIERS[c]);
    return r > c ? TIERS[c] : TIERS[r];
  },
  tierLimits: (id) => ({ maxConcurrent: TIERS.indexOf(id), maxTotal: TIERS.indexOf(id) * 2, maxScouts: TIERS.indexOf(id) }),
  tierLabel: (id) => `E${TIERS.indexOf(id) + 1} ${id}`,
};

/** The effort API the suite runs against: core's when it exists in this checkout, else the stub. */
export const testEffort = coreEffort ?? stubEffort;

let checks = 0;
export function makeChecker(label) {
  return {
    async check(name, fn) {
      await fn();
      checks++;
      console.log(`  OK: ${name}`);
    },
    done() { console.log(`\n[${label}] all ${checks} checks passed${testEffort.isStub ? " (effort: local stub)" : ""}`); },
  };
}

export function tempDir(prefix = "autonomy-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });

/** A minimal valid finite-task contract; tests override what they exercise. */
export function implementRaw(over = {}) {
  return {
    schemaVersion: 1,
    run: "todo-api-1",
    template: "implement",
    objective: { title: "Todo API", spec: "Build a small todo API with tests.", backlog: [{ id: "T1", title: "Health endpoint", acceptance: ["unit"] }, { id: "T2", title: "Create todo" }] },
    inputs: { repository: null, references: {} },
    acceptance: { checks: [{ id: "unit", run: ["node", "--test"], timeoutMinutes: 5, required: true }], review: true },
    permissions: { unattended: { authorised: true, autoApprove: true } },
    ...over,
  };
}

export { assert };
