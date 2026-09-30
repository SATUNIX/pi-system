/**
 * Effort policy for toolchain code (the autonomy runner, verify, docs generation, tests).
 *
 * The single source of truth is packages/extensions/src/effort/policy/effort.json plus the
 * prompt templates beside it. The runtime copy of this logic lives in the `effort` extension
 * (extensions may not import toolchain code); tests/effort-smoke.mjs checks that the two agree
 * on aliases, clamping and limits so they cannot drift.
 *
 * Effort is an execution policy only: it never selects a model, a thinking level, a profile or
 * a permission. See docs/effort.md.
 */
import fs from "node:fs";
import path from "node:path";
import { FIRST_PARTY_DIR } from "./paths.mjs";

// The policy lives inside the effort extension (self-contained, extractable); the toolchain reads it in place.
export const EFFORT_POLICY_DIR = path.join(FIRST_PARTY_DIR, "effort", "policy");
export const EFFORT_POLICY_PATH = path.join(EFFORT_POLICY_DIR, "effort.json");

const LIMIT_KEYS = ["maxConcurrent", "maxTotal", "maxScouts"];
const isCount = (v) => Number.isInteger(v) && v >= 0;

/** Validate the policy shape. Returns a list of problems (empty when valid). */
export function validateEffortPolicy(policy, baseDir = EFFORT_POLICY_DIR) {
  const problems = [];
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return ["effort policy is not an object"];
  if (policy.schemaVersion !== 1) problems.push(`schemaVersion must be 1 (got ${JSON.stringify(policy.schemaVersion)})`);
  const tiers = Array.isArray(policy.tiers) ? policy.tiers : [];
  if (tiers.length !== 5) problems.push(`exactly five tiers are required (got ${tiers.length})`);
  const seen = new Set();
  const aliases = new Set();
  let previous = null;
  for (const [index, tier] of tiers.entries()) {
    const where = `tiers[${index}]`;
    if (!tier || typeof tier !== "object") { problems.push(`${where} is not an object`); continue; }
    if (!/^[a-z]+$/.test(tier.id ?? "")) problems.push(`${where}.id must be lower-case letters`);
    if (seen.has(tier.id)) problems.push(`${where}.id "${tier.id}" is duplicated`);
    seen.add(tier.id);
    if (tier.level !== index + 1) problems.push(`${where}.level must be ${index + 1} (tiers are ordered)`);
    if (tier.code !== `E${index + 1}`) problems.push(`${where}.code must be E${index + 1}`);
    if (typeof tier.label !== "string" || !tier.label) problems.push(`${where}.label is required`);
    for (const alias of [tier.id, tier.code?.toLowerCase(), String(tier.level), ...(tier.aliases ?? [])]) {
      if (alias === undefined) continue;
      const key = String(alias).toLowerCase();
      if (aliases.has(key) && ![tier.id, tier.code?.toLowerCase(), String(tier.level)].includes(key)) problems.push(`${where}: alias "${key}" is used by another tier`);
      aliases.add(key);
    }
    for (const key of LIMIT_KEYS) if (!isCount(tier.limits?.[key])) problems.push(`${where}.limits.${key} must be a non-negative integer`);
    if (tier.limits && tier.limits.maxScouts > tier.limits.maxTotal) problems.push(`${where}: maxScouts cannot exceed maxTotal (scouts count within the shared total)`);
    if (tier.limits && tier.limits.maxConcurrent > tier.limits.maxTotal) problems.push(`${where}: maxConcurrent cannot exceed maxTotal`);
    if (previous) for (const key of LIMIT_KEYS) if (tier.limits?.[key] < previous.limits?.[key]) problems.push(`${where}.limits.${key} must not fall below the previous tier's`);
    previous = tier;
    if (typeof tier.promptFile !== "string" || !fs.existsSync(path.join(baseDir, tier.promptFile))) problems.push(`${where}.promptFile "${tier.promptFile}" does not exist`);
  }
  if (!seen.has(policy.default)) problems.push(`default "${policy.default}" is not a tier id`);
  if (typeof policy.sharedPromptFile !== "string" || !fs.existsSync(path.join(baseDir, policy.sharedPromptFile))) problems.push(`sharedPromptFile "${policy.sharedPromptFile}" does not exist`);
  for (const key of LIMIT_KEYS) if (!isCount(policy.ceilings?.[key]) || policy.ceilings[key] < 1) problems.push(`ceilings.${key} must be a positive integer`);
  for (const tier of tiers) for (const key of LIMIT_KEYS) if (tier?.limits?.[key] > policy.ceilings?.[key]) problems.push(`tier ${tier.id}: ${key} ${tier.limits[key]} exceeds the platform ceiling ${policy.ceilings[key]}`);
  const r = policy.recovery;
  if (!r || !isCount(r.maxInvocations) || !isCount(r.maxConcurrent) || !Array.isArray(r.roles)) problems.push("recovery needs maxInvocations, maxConcurrent and roles");
  return problems;
}

/** Load and validate the policy; throws with every problem when it is not valid. */
export function loadEffortPolicy(file = EFFORT_POLICY_PATH) {
  const policy = JSON.parse(fs.readFileSync(file, "utf8"));
  const problems = validateEffortPolicy(policy, path.dirname(file));
  if (problems.length) throw new Error(`invalid effort policy ${file}:\n  ${problems.join("\n  ")}`);
  return policy;
}

/** Canonical tier id for a name, E1..E5 or 1..5 (any case); null when it is not a tier. Never throws. */
export function normalizeTier(input, policy = loadEffortPolicy()) {
  if (typeof input === "number") input = String(input);
  if (typeof input !== "string") return null;
  const key = input.trim().toLowerCase();
  if (!key) return null;
  for (const tier of policy.tiers) {
    if (key === tier.id || key === tier.code.toLowerCase() || key === String(tier.level) || (tier.aliases ?? []).includes(key)) return tier.id;
  }
  return null;
}

export const tierOf = (id, policy = loadEffortPolicy()) => policy.tiers.find((t) => t.id === id) ?? null;

/** "E3 Standard" for display. */
export function tierLabel(id, policy = loadEffortPolicy()) {
  const tier = tierOf(id, policy);
  return tier ? `${tier.code} ${tier.label}` : String(id);
}

/** A child may be at most as high as its parent's effective cap. Unknown values clamp to the cap. */
export function clampTier(requested, cap, policy = loadEffortPolicy()) {
  const capTier = tierOf(normalizeTier(cap, policy) ?? policy.default, policy);
  const want = tierOf(normalizeTier(requested, policy) ?? capTier.id, policy);
  return want.level > capTier.level ? capTier.id : want.id;
}

/** The limits of a tier, optionally overridden by user configuration, never above the platform ceilings. */
export function tierLimits(id, policy = loadEffortPolicy(), overrides = {}) {
  const tier = tierOf(id, policy) ?? tierOf(policy.default, policy);
  const out = {};
  for (const key of LIMIT_KEYS) {
    const wanted = isCount(overrides?.[tier.id]?.[key]) ? overrides[tier.id][key] : tier.limits[key];
    out[key] = Math.min(wanted, policy.ceilings[key]);
  }
  out.maxScouts = Math.min(out.maxScouts, out.maxTotal);
  out.maxConcurrent = Math.min(out.maxConcurrent, out.maxTotal);
  return out;
}

/** The text injected for a tier: the shared policy, then the tier's own contribution. */
export function renderEffortPrompt(id, policy = loadEffortPolicy(), baseDir = EFFORT_POLICY_DIR) {
  const tier = tierOf(id, policy) ?? tierOf(policy.default, policy);
  const read = (file) => fs.readFileSync(path.join(baseDir, file), "utf8").trim();
  return `${read(policy.sharedPromptFile)}\n\n${read(tier.promptFile)}`;
}
