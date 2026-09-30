/**
 * Effort policy: the five tiers, their limits and prompt text.
 *
 * The data lives beside this file (policy/effort.json and the prompt templates) so the extension
 * stays self-contained; the toolchain reads the same files through packages/core/lib/effort.mjs and
 * tests/effort-smoke.mjs checks the two implementations agree.
 *
 * Effort is an execution policy only. Nothing here selects a model, a thinking level, a profile
 * or a permission.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface TierLimits {
  maxConcurrent: number;
  maxTotal: number;
  maxScouts: number;
}

export interface Tier {
  id: string;
  level: number;
  code: string;
  label: string;
  aliases: string[];
  promptFile: string;
  limits: TierLimits;
}

export interface EffortPolicy {
  schemaVersion: 1;
  default: string;
  sharedPromptFile: string;
  ceilings: TierLimits;
  recovery: { maxInvocations: number; maxConcurrent: number; roles: string[] };
  tiers: Tier[];
}

/** User-configurable limit overrides, per tier id (effort.json `limits`). */
export type LimitOverrides = Record<string, Partial<TierLimits>>;

const LIMIT_KEYS = ["maxConcurrent", "maxTotal", "maxScouts"] as const;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

export function policyDir(): string {
  const override = process.env.PI_KIT_EFFORT_POLICY_DIR?.trim();
  if (override) return override;
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "policy");
}

/** Problems with a parsed policy (empty when valid); mirrors packages/core/lib/effort.mjs. */
export function validatePolicy(policy: unknown, dir: string): string[] {
  const problems: string[] = [];
  const p = policy as Partial<EffortPolicy> | null;
  if (!p || typeof p !== "object" || Array.isArray(p)) return ["effort policy is not an object"];
  if (p.schemaVersion !== 1) problems.push("schemaVersion must be 1");
  const tiers = Array.isArray(p.tiers) ? p.tiers : [];
  if (tiers.length !== 5) problems.push(`exactly five tiers are required (got ${tiers.length})`);
  const ids = new Set<string>();
  tiers.forEach((tier, index) => {
    if (!tier || typeof tier !== "object") return void problems.push(`tiers[${index}] is not an object`);
    if (!/^[a-z]+$/.test(tier.id ?? "")) problems.push(`tiers[${index}].id must be lower-case letters`);
    if (ids.has(tier.id)) problems.push(`tiers[${index}].id "${tier.id}" is duplicated`);
    ids.add(tier.id);
    if (tier.level !== index + 1 || tier.code !== `E${index + 1}`) problems.push(`tiers[${index}] must be level ${index + 1} / code E${index + 1}`);
    for (const key of LIMIT_KEYS) if (!isCount(tier.limits?.[key])) problems.push(`tiers[${index}].limits.${key} must be a non-negative integer`);
    if (typeof tier.promptFile !== "string" || !fs.existsSync(path.join(dir, tier.promptFile))) problems.push(`tiers[${index}].promptFile is missing`);
  });
  if (!ids.has(p.default ?? "")) problems.push(`default "${p.default}" is not a tier id`);
  if (typeof p.sharedPromptFile !== "string" || !fs.existsSync(path.join(dir, p.sharedPromptFile))) problems.push("sharedPromptFile is missing");
  for (const key of LIMIT_KEYS) if (!isCount(p.ceilings?.[key]) || (p.ceilings?.[key] ?? 0) < 1) problems.push(`ceilings.${key} must be a positive integer`);
  const r = p.recovery;
  if (!r || !isCount(r.maxInvocations) || !isCount(r.maxConcurrent) || !Array.isArray(r.roles)) problems.push("recovery needs maxInvocations, maxConcurrent and roles");
  return problems;
}

/** Load and validate the policy; throws with every problem when it is not valid. */
export function loadPolicy(dir = policyDir()): EffortPolicy {
  const file = path.join(dir, "effort.json");
  const policy = JSON.parse(fs.readFileSync(file, "utf8"));
  const problems = validatePolicy(policy, dir);
  if (problems.length) throw new Error(`invalid effort policy ${file}: ${problems.join("; ")}`);
  return policy as EffortPolicy;
}

export const tierOf = (policy: EffortPolicy, id: string | null | undefined): Tier | null => policy.tiers.find((t) => t.id === id) ?? null;

/** Canonical tier id for a name, E1..E5 or 1..5 (any case); null when it is not a tier. Never throws. */
export function normalizeTier(policy: EffortPolicy, input: unknown): string | null {
  if (typeof input === "number") input = String(input);
  if (typeof input !== "string") return null;
  const key = input.trim().toLowerCase();
  if (!key) return null;
  for (const tier of policy.tiers) {
    if (key === tier.id || key === tier.code.toLowerCase() || key === String(tier.level) || tier.aliases.includes(key)) return tier.id;
  }
  return null;
}

/** A child may be at most as high as its parent's effective cap; unknown values clamp to the cap. */
export function clampTier(policy: EffortPolicy, requested: unknown, cap: unknown): string {
  const capTier = tierOf(policy, normalizeTier(policy, cap)) ?? tierOf(policy, policy.default)!;
  const want = tierOf(policy, normalizeTier(policy, requested)) ?? capTier;
  return want.level > capTier.level ? capTier.id : want.id;
}

/** A tier's limits, optionally overridden by user configuration, never above the platform ceilings. */
export function tierLimits(policy: EffortPolicy, id: string, overrides: LimitOverrides = {}): TierLimits {
  const tier = tierOf(policy, id) ?? tierOf(policy, policy.default)!;
  const out = {} as TierLimits;
  for (const key of LIMIT_KEYS) {
    const wanted = overrides[tier.id]?.[key];
    out[key] = Math.min(isCount(wanted) ? wanted : tier.limits[key], policy.ceilings[key]);
  }
  out.maxScouts = Math.min(out.maxScouts, out.maxTotal);
  out.maxConcurrent = Math.min(out.maxConcurrent, out.maxTotal);
  return out;
}

export function tierLabel(policy: EffortPolicy, id: string): string {
  const tier = tierOf(policy, id);
  return tier ? `${tier.code} ${tier.label}` : id;
}

/** The text injected for a tier: the shared policy, then the tier's own contribution. */
export function renderPrompt(policy: EffortPolicy, id: string, dir = policyDir()): string {
  const tier = tierOf(policy, id) ?? tierOf(policy, policy.default)!;
  const read = (file: string) => fs.readFileSync(path.join(dir, file), "utf8").trim();
  return `${read(policy.sharedPromptFile)}\n\n${read(tier.promptFile)}`;
}

export const PROMPT_START = "<!-- pi-kit:effort -->";
export const PROMPT_END = "<!-- /pi-kit:effort -->";

/**
 * Put exactly one effort block at the end of `systemPrompt`, replacing any earlier one. Applying
 * it twice (or after another handler already added a block) never duplicates the policy.
 */
export function withEffortBlock(systemPrompt: string, body: string): string {
  const stripped = systemPrompt.replace(new RegExp(`\\n*${escapeRe(PROMPT_START)}[\\s\\S]*?${escapeRe(PROMPT_END)}\\n*`, "g"), "\n\n").trimEnd();
  return `${stripped}\n\n${PROMPT_START}\n${body}\n${PROMPT_END}\n`;
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
