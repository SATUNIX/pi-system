import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as ledger from "./ledger.ts";
import { clampTier, loadPolicy, normalizeTier, renderPrompt, tierLabel, tierLimits, tierOf, withEffortBlock } from "./policy.ts";
import type { EffortPolicy, LimitOverrides, TierLimits } from "./policy.ts";

// Self-containment rule: import only node:* builtins and the pi peer, plus this extension's own
// files. No sibling-extension imports. See CONTRIBUTING.md.
//
// effort is an execution policy: how deep and how broad the agent works, and how much it may
// delegate. It is independent of the model's thinking level, the profile and every permission
// (docs/effort.md). It owns
//   - the five tiers (policy/effort.json) and /effort,
//   - one prompt contribution per turn, replaced (never appended twice) at the user-turn boundary,
//   - the shared delegation ledger every launch point reserves against, at any depth,
//   - a small registry (globalThis[Symbol.for("pi-kit.effort")]) other extensions read: the footer
//     for the tier chip, delegation launch points for reservations.

export const REGISTRY_KEY = Symbol.for("pi-kit.effort");
const PROTECTIONS_KEY = Symbol.for("pi-kit.protections");

/** Tell the shared protections registry this extension is loaded (a child verifies it before running tools). */
function registerProtection(name: string): void {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[PROTECTIONS_KEY] as { add?: (n: string) => unknown } | undefined;
  if (!existing) g[PROTECTIONS_KEY] = new Set<string>([name]);
  else if (typeof existing.add === "function") existing.add(name);
}

export type EffortSource = "default" | "user" | "env" | "cap";

export interface EffortSnapshot {
  version: 1;
  /** Canonical tier id in force for the current turn. */
  tier: string;
  code: string;
  label: string;
  source: EffortSource;
  /** True when a run or a parent pinned the tier: /effort then only saves a default for later. */
  pinned: boolean;
  /** The highest tier this process may use (set for children), or null. */
  cap: string | null;
  limits: TierLimits;
  usage: ledger.Usage;
  ledger: string | null;
  /** A tier chosen with /effort that starts at the next user turn, when it differs from `tier`. */
  pendingTier: string | null;
  /** Problems reading the policy or the user's config (shown by /effort status). */
  warnings: string[];
  /** False when the policy could not be loaded: delegation is then refused, never unbudgeted. */
  healthy: boolean;
}

export interface ReserveInput {
  kind: ledger.LaunchKind;
  role: string;
  scout?: boolean;
  readOnly?: boolean;
  /** The child's requested tier; it is clamped to this process's tier (a child is never higher). */
  requestedTier?: string;
}

export type Reservation =
  | { ok: true; id: string | null; childTier: string; env: Record<string, string>; attach(pid: number | undefined): void; settle(outcome: string): void }
  | { ok: false; code: string; reason: string };

export interface EffortRegistry {
  version: 1;
  snapshot(): EffortSnapshot;
  reserve(input: ReserveInput): Reservation;
  /** Only the trusted recovery extension calls this; the model cannot open the recovery budget. */
  setRecoveryActive(active: boolean, reason?: string): void;
  onChange(listener: () => void): () => void;
}

/** A mandatory verification launch when no ledger exists: allowed, unbudgeted, carries no effort env. */
function unbudgeted(childTier: string): Reservation {
  const env: Record<string, string> = {};
  return { ok: true, id: null, childTier, env, attach: () => {}, settle: () => {} };
}

/** Tools through which the model starts children of its own accord. Hidden while the tier allows none. */
export const DELEGATION_TOOLS = ["subagent", "workflow_run"];

const USAGE_REFRESH_MS = 2000;
const LEDGER_KEEP_MS = 24 * 60 * 60 * 1000;
const MANDATORY_MAX = 6;

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function configPath(): string {
  return process.env.PI_KIT_EFFORT_CONFIG?.trim() || path.join(agentDir(), "pi-kit", "effort.json");
}

function ledgerDir(): string {
  return path.join(agentDir(), "pi-kit", "effort", "ledgers");
}

interface UserConfig {
  tier: string | null;
  limits: LimitOverrides;
  warnings: string[];
}

/** Read <agent dir>/pi-kit/effort.json. A missing file is normal; malformed content is ignored with a warning, never fatal. */
export function readConfig(policy: EffortPolicy, file = configPath()): UserConfig {
  const out: UserConfig = { tier: null, limits: {}, warnings: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") out.warnings.push(`ignored ${file}: not valid JSON`);
    return out;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    out.warnings.push(`ignored ${file}: not an object`);
    return out;
  }
  const cfg = raw as { default?: unknown; limits?: unknown };
  if (cfg.default !== undefined) {
    const tier = normalizeTier(policy, cfg.default);
    if (tier) out.tier = tier;
    else out.warnings.push(`ignored default "${String(cfg.default)}" in ${file}: not an effort tier`);
  }
  if (cfg.limits && typeof cfg.limits === "object" && !Array.isArray(cfg.limits)) {
    for (const [id, value] of Object.entries(cfg.limits as Record<string, unknown>)) {
      if (!tierOf(policy, id)) {
        out.warnings.push(`ignored limits for unknown tier "${id}" in ${file}`);
        continue;
      }
      if (!value || typeof value !== "object") continue;
      const limits: Partial<TierLimits> = {};
      for (const key of ["maxConcurrent", "maxTotal", "maxScouts"] as const) {
        const n = (value as Record<string, unknown>)[key];
        if (n === undefined) continue;
        if (typeof n === "number" && Number.isInteger(n) && n >= 0) limits[key] = n;
        else out.warnings.push(`ignored limits.${id}.${key} in ${file}: not a non-negative integer`);
      }
      out.limits[id] = limits;
    }
  }
  return out;
}

/** Save the default tier, keeping every other key in the file. Atomic. */
export function saveDefault(tier: string | null, file = configPath()): void {
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) existing = parsed as Record<string, unknown>;
  } catch {
    /* start from an empty file */
  }
  const next: Record<string, unknown> = { schemaVersion: 1, ...existing };
  if (tier === null) delete next.default;
  else next.default = tier;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
}

interface Resolved {
  tier: string;
  source: EffortSource;
  pinned: boolean;
  cap: string | null;
  warnings: string[];
}

/**
 * Precedence, highest first: a pin from the environment (PI_KIT_EFFORT: set by an autonomous run
 * or by the parent for a child), then the user's saved default, then the policy default. A cap
 * (PI_KIT_EFFORT_CAP, set for children) is applied last and can only lower the result. An invalid
 * pin is reported and ignored; an invalid cap fails closed to the lowest tier.
 */
export function resolveEffective(policy: EffortPolicy, env: NodeJS.ProcessEnv, config: UserConfig): Resolved {
  const warnings: string[] = [];
  let tier = policy.default;
  let source: EffortSource = "default";
  const saved = config.tier;
  if (saved) {
    tier = saved;
    source = "user";
  }
  let pinned = false;
  const pinRaw = env.PI_KIT_EFFORT?.trim();
  if (pinRaw) {
    const pin = normalizeTier(policy, pinRaw);
    if (pin) {
      tier = pin;
      source = "env";
      pinned = true;
    } else warnings.push(`ignored PI_KIT_EFFORT="${pinRaw}": not an effort tier`);
  }
  let cap: string | null = null;
  const capRaw = env.PI_KIT_EFFORT_CAP?.trim();
  if (capRaw) {
    cap = normalizeTier(policy, capRaw);
    if (!cap) {
      warnings.push(`PI_KIT_EFFORT_CAP="${capRaw}" is not an effort tier; using the lowest tier`);
      cap = policy.tiers[0].id;
    }
    const clamped = clampTier(policy, tier, cap);
    if (clamped !== tier) {
      tier = clamped;
      source = "cap";
    }
    pinned = true;
  }
  return { tier, source, pinned, cap, warnings };
}

function say(ctx: ExtensionCommandContext | ExtensionContext, text: string, level: "info" | "warning" | "error" = "info"): void {
  if (ctx.hasUI) ctx.ui.notify(text, level);
  else process.stderr.write(`[effort] ${text}\n`);
}

const isChildProcess = () => Boolean(process.env.PI_KIT_EFFORT_LEDGER?.trim());

export default function (pi: ExtensionAPI) {
  let policy: EffortPolicy | null = null;
  let loadError: string | null = null;
  try {
    policy = loadPolicy();
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  }

  let config: UserConfig = { tier: null, limits: {}, warnings: [] };
  let active: Resolved | null = null; // in force for the current turn
  let pending: Resolved | null = null; // chosen, applies at the next user turn
  let ledgerFile: string | null = process.env.PI_KIT_EFFORT_LEDGER?.trim() || null;
  let scopeSeq = 0;
  let sessionTotalBefore = 0;
  let sessionKey = `${process.pid}`;
  let usage: ledger.Usage = ledger.usageOf(null);
  let usageAt = 0;
  let warnedLoad = false;
  let recoveryOn = false;
  // Tools this extension took out of the active set, so it only ever puts back its own removals.
  const hidden = new Set<string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((l) => { try { l(); } catch { /* a listener must not break effort */ } });

  const recompute = (): Resolved | null => (policy ? resolveEffective(policy, process.env, config) : null);
  const label = (id: string) => (policy ? tierLabel(policy, id) : id);
  const limitsFor = (id: string): TierLimits => (policy ? tierLimits(policy, id, config.limits) : { maxConcurrent: 0, maxTotal: 0, maxScouts: 0 });

  function refreshUsage(force = false): void {
    if (!ledgerFile) return;
    const now = Date.now();
    if (!force && now - usageAt < USAGE_REFRESH_MS) return;
    usageAt = now;
    usage = ledger.usageOf(ledger.readLedger(ledgerFile));
  }

  function snapshot(): EffortSnapshot {
    refreshUsage();
    const a = active ?? recompute();
    const tier = a?.tier ?? "standard";
    const t = policy ? tierOf(policy, tier) : null;
    const pend = pending && pending.tier !== tier ? pending.tier : null;
    return {
      version: 1,
      tier,
      code: t?.code ?? "E3",
      label: t?.label ?? "Standard",
      source: a?.source ?? "default",
      pinned: a?.pinned ?? false,
      cap: a?.cap ?? null,
      limits: limitsFor(tier),
      usage,
      ledger: ledgerFile,
      pendingTier: pend,
      warnings: [...(loadError ? [loadError] : []), ...config.warnings, ...(a?.warnings ?? [])],
      healthy: policy !== null,
    };
  }

  /** Open a fresh delegation scope for a root session's user turn. Children reuse the parent's ledger. */
  function openScope(): void {
    if (isChildProcess() || !policy || !active) return;
    try {
      fs.mkdirSync(ledgerDir(), { recursive: true });
      if (ledgerFile) {
        const previous = ledger.readLedger(ledgerFile);
        if (previous) sessionTotalBefore = previous.sessionTotalBefore + previous.total;
      }
      const scope = `${sessionKey}-${++scopeSeq}`;
      ledgerFile = path.join(ledgerDir(), `${scope}.json`);
      ledger.createLedger(ledgerFile, {
        scope,
        tier: active.tier,
        limits: limitsFor(active.tier),
        recovery: { maxInvocations: policy.recovery.maxInvocations, maxConcurrent: policy.recovery.maxConcurrent, roles: policy.recovery.roles, active: false },
        sessionTotalBefore,
        sessionCeiling: policy.ceilings.maxTotal,
        mandatoryMax: MANDATORY_MAX,
        ceilings: policy.ceilings,
      });
      usage = ledger.usageOf(null);
      usageAt = Date.now();
    } catch (error) {
      ledgerFile = null; // delegation is refused ("no ledger"), never unbudgeted
      process.stderr.write(`[effort] could not open the delegation ledger: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  /**
   * Keep the model-launchable delegation tools out of the prompt while the tier allows no
   * delegation (E1): their descriptions cost about 850 tokens a turn and could only ever be
   * refused. They come back at the next user turn after a higher tier is chosen, and while the
   * trusted recovery extension has recovery active (recovery may start read-only scouts). Only
   * tools this extension removed are ever restored; a tool the profile or operator removed stays
   * removed. Skipped quietly on a pi without active-tool control.
   */
  function syncDelegationTools(): void {
    try {
      if (!active || typeof pi.getActiveTools !== "function" || typeof pi.setActiveTools !== "function") return;
      const noDelegation = limitsFor(active.tier).maxTotal === 0 && !recoveryOn;
      const current = pi.getActiveTools();
      let next = current;
      if (noDelegation) {
        const remove = DELEGATION_TOOLS.filter((t) => current.includes(t));
        remove.forEach((t) => hidden.add(t));
        if (remove.length) next = current.filter((t) => !remove.includes(t));
      } else if (hidden.size) {
        const restore = [...hidden].filter((t) => !current.includes(t));
        next = [...current, ...restore];
        hidden.clear();
      }
      if (next !== current) pi.setActiveTools(next);
    } catch {
      /* tool activation is an optimisation, never a reason to fail a turn */
    }
  }

  function pruneLedgers(): void {
    try {
      const dir = ledgerDir();
      for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (Date.now() - fs.statSync(file).mtimeMs > LEDGER_KEEP_MS) fs.rmSync(file, { force: true });
      }
    } catch {
      /* nothing to prune */
    }
  }

  const registry: EffortRegistry = {
    version: 1,
    snapshot,
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    setRecoveryActive(activeNow) {
      recoveryOn = activeNow;
      if (ledgerFile) ledger.setRecoveryActive(ledgerFile, activeNow);
      syncDelegationTools();
    },
    reserve(input: ReserveInput): Reservation {
      if (!policy || !active) {
        // Mandatory verification is not budgeted work, so an unhealthy policy must not disable it.
        if (input.kind === "mandatory") return unbudgeted(policy?.default ?? "standard");
        return { ok: false, code: "no-policy", reason: `the effort policy could not be loaded (${loadError ?? "unknown"}), so delegation cannot be budgeted. Fix it or work directly.` };
      }
      const file = ledgerFile;
      if (!file) {
        if (input.kind === "mandatory") return unbudgeted(active.tier);
        return { ok: false, code: "no-ledger", reason: "the delegation ledger for this request is unavailable, so delegation cannot be budgeted. Work directly." };
      }
      const childTier = clampTier(policy, input.requestedTier ?? active.tier, active.tier);
      const result = ledger.reserve(file, {
        kind: input.kind,
        role: input.role,
        scout: input.scout,
        readOnly: input.readOnly,
        requesterTier: active.tier,
        requesterLimits: limitsFor(active.tier),
        requesterLabel: label(active.tier),
      });
      if (!result.ok) {
        if (input.kind === "mandatory" && result.code === "no-ledger") return unbudgeted(childTier);
        refreshUsage(true);
        notify();
        return result;
      }
      const id = result.id;
      refreshUsage(true);
      notify();
      return {
        ok: true,
        id,
        childTier,
        env: { PI_KIT_EFFORT: childTier, PI_KIT_EFFORT_CAP: childTier, PI_KIT_EFFORT_LEDGER: file },
        attach: (pid) => ledger.attach(file, id, pid),
        settle: (outcome) => {
          ledger.settle(file, id, outcome);
          refreshUsage(true);
          notify();
        },
      };
    },
  };
  (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = registry;
  registerProtection("effort");

  pi.on("session_start", async (event: unknown, ctx: ExtensionContext) => {
    (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = registry;
    if (!policy) {
      if (!warnedLoad) {
        warnedLoad = true;
        say(ctx, `effort policy could not be loaded (${loadError}); delegation is disabled until it is fixed.`, "warning");
      }
      return;
    }
    config = readConfig(policy);
    active = pending = recompute();
    try {
      const id = (ctx.sessionManager as { getSessionId?: () => unknown } | undefined)?.getSessionId?.();
      if (typeof id === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(id)) sessionKey = id;
    } catch {
      /* keep the pid-based key */
    }
    if (!isChildProcess()) pruneLedgers();
    openScope();
    const reason = (event as { reason?: string } | undefined)?.reason;
    const warnings = [...config.warnings, ...(active?.warnings ?? [])];
    if (warnings.length && reason !== "reload") say(ctx, warnings.join("\n"), "warning");
    notify();
  });

  pi.on("session_shutdown", async () => {
    listeners.clear();
    recoveryOn = false;
    if ((globalThis as Record<symbol, unknown>)[REGISTRY_KEY] === registry) delete (globalThis as Record<symbol, unknown>)[REGISTRY_KEY];
  });

  // The user-turn boundary: a tier chosen with /effort takes effect here, the delegation scope is
  // renewed for the new request, and exactly one effort block replaces any earlier one.
  pi.on("before_agent_start", async (event: { systemPrompt?: string }) => {
    if (!policy) return undefined;
    if (pending && (!active || pending.tier !== active.tier || pending.source !== active.source)) {
      active = pending;
      notify();
    } else if (!active) active = recompute();
    if (!active) return undefined;
    recoveryOn = false; // the recovery budget is per request: it closes with the previous one
    openScope();
    syncDelegationTools();
    notify();
    const body = renderPrompt(policy, active.tier);
    return { systemPrompt: withEffortBlock(event.systemPrompt ?? "", body) };
  });

  function statusText(): string {
    const s = snapshot();
    const lines = [`Effort: ${s.code} ${s.label} (${s.source === "default" ? "default" : s.source === "user" ? "saved default" : s.source === "env" ? "pinned by PI_KIT_EFFORT" : "capped by the parent"})${s.pinned && s.source !== "env" ? "" : ""}`];
    if (s.pendingTier) lines.push(`  next message: ${label(s.pendingTier)}`);
    lines.push(`  limits: ${s.limits.maxConcurrent} concurrent, ${s.limits.maxTotal} total, ${s.limits.maxScouts} scout${s.limits.maxScouts === 1 ? "" : "s"} (children per request, counted at every depth)`);
    if (s.ledger) lines.push(`  this request: ${s.usage.live} running, ${s.usage.total}/${s.limits.maxTotal} used, ${s.usage.scouts}/${s.limits.maxScouts} scouts`);
    if (s.pinned) lines.push("  pinned: /effort saves a default for later sessions but does not change this one");
    for (const w of s.warnings) lines.push(`  warning: ${w}`);
    lines.push("Effort sets how deep and broad the work is and how much it delegates. It does not change the model, its thinking level, the profile or any permission.");
    return lines.join("\n");
  }

  function helpText(): string {
    if (!policy) return "Effort policy unavailable.";
    const rows = policy.tiers.map((t) => {
      const l = limitsFor(t.id);
      return `  ${t.code} ${t.label.padEnd(10)} ${String(l.maxConcurrent).padStart(2)} concurrent  ${String(l.maxTotal).padStart(2)} total  ${l.maxScouts} scout${l.maxScouts === 1 ? " " : "s"}   /effort ${t.id}`;
    });
    return [`Effort tiers (default ${label(policy.default)}):`, ...rows, "", "  /effort <name|E1..E5|1..5>   set and save the default (applies from your next message)", "  /effort status               show the tier, limits and this request's use", "  /effort reset                forget the saved default"].join("\n");
  }

  function choose(id: string, ctx: ExtensionCommandContext): void {
    if (!policy) return;
    try {
      saveDefault(id);
    } catch (error) {
      say(ctx, `effort: could not save ${label(id)} (${error instanceof Error ? error.message : String(error)}); it applies to this session only.`, "warning");
    }
    config = { ...config, tier: id };
    pending = recompute();
    notify();
    const s = snapshot();
    const applies = s.pinned ? "Saved as your default, but this session is pinned and keeps its tier." : active && active.tier === pending?.tier ? "Already in force." : "Applies from your next message.";
    say(ctx, `Effort set to ${label(id)}. ${applies}`, "info");
  }

  pi.registerCommand("effort", {
    description: "Choose how deep and broad the agent works and how much it delegates: `/effort` (picker), `/effort <minimal|focused|standard|thorough|exhaustive | E1..E5>`, `/effort status`, `/effort reset`. Independent of thinking level, profile and permissions.",
    getArgumentCompletions: (prefix: string) => {
      const options = policy ? [...policy.tiers.map((t) => t.id), ...policy.tiers.map((t) => t.code), "status", "reset", "help"] : ["status", "help"];
      return options.filter((v) => v.toLowerCase().startsWith(prefix.trim().toLowerCase())).map((v) => ({ value: v, label: v }));
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const arg = args.trim();
      if (!policy) return say(ctx, `effort: the policy could not be loaded (${loadError}).`, "error");
      const word = arg.toLowerCase();
      if (word === "status") return say(ctx, statusText());
      if (word === "help" || word === "?") return say(ctx, helpText());
      if (word === "reset") {
        try {
          saveDefault(null);
        } catch (error) {
          return say(ctx, `effort: could not update ${configPath()} (${error instanceof Error ? error.message : String(error)}).`, "error");
        }
        config = { ...config, tier: null };
        pending = recompute();
        notify();
        return say(ctx, `Saved default cleared; new sessions use ${label(policy.default)}.`);
      }
      if (!arg) {
        if (!ctx.hasUI) return say(ctx, `${statusText()}\n\n${helpText()}`);
        const s = snapshot();
        const options = policy.tiers.map((t) => `${t.code} ${t.label}${t.id === s.tier ? "  (current)" : ""} — ${limitsFor(t.id).maxTotal === 0 ? "no delegation" : `up to ${limitsFor(t.id).maxTotal} children`}`);
        const choice = await ctx.ui.select("Effort — depth and breadth of work (not thinking, profile or permissions)", options);
        if (choice === undefined) return;
        const picked = policy.tiers[options.indexOf(choice)];
        if (picked) choose(picked.id, ctx);
        return;
      }
      const tier = normalizeTier(policy, arg);
      if (!tier) return say(ctx, `effort: "${arg}" is not an effort level. Use ${policy.tiers.map((t) => `${t.id} (${t.code})`).join(", ")}. Nothing was changed.`, "error");
      choose(tier, ctx);
    },
  });
}
