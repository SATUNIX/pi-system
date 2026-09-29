import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// Built-in fallback used only when nothing else sets a threshold: no env var, and no
// persisted <agent dir>/pi-kit/trigger-compact.json from a prior /compact-threshold run.
const DEFAULT_THRESHOLD_TOKENS = 100_000;
const MIN_THRESHOLD_TOKENS = 1_000;

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function settingsFile(): string {
  return path.join(agentDir(), "pi-kit", "trigger-compact.json");
}

type Settings = { thresholdTokens?: number; enabled?: boolean };

function loadPersisted(): Settings {
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    // Shape guard: a literal `null` (or an array) parses fine but has no fields to read.
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Settings) : {};
  } catch {
    return {};
  }
}

function loadPersistedThreshold(): number | undefined {
  const raw = loadPersisted();
  return typeof raw.thresholdTokens === "number" && Number.isFinite(raw.thresholdTokens) && raw.thresholdTokens >= MIN_THRESHOLD_TOKENS
    ? Math.floor(raw.thresholdTokens)
    : undefined;
}

function savePersisted(patch: Settings): void {
  const next: Settings = { ...loadPersisted(), ...patch };
  for (const key of Object.keys(next) as Array<keyof Settings>) if (next[key] === undefined) delete next[key];
  if (Object.keys(next).length === 0) {
    fs.rmSync(settingsFile(), { force: true }); // nothing saved: back to pure defaults
    return;
  }
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  const tmp = `${settingsFile()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, settingsFile());
}

function savePersistedThreshold(thresholdTokens: number): void {
  savePersisted({ thresholdTokens });
}

// The kit-level switch (/compact-threshold off|on). Separate from pi's own setting so an
// operator can keep pi's overflow protection while disabling this fixed-budget trigger.
function kitTriggerEnabled(): boolean {
  return loadPersisted().enabled !== false;
}

// pi's own auto-compaction switch: `compaction.enabled` in the global settings, overridden
// field-by-field by the project's .pi/settings.json (pi's merge order). This extension used to
// ignore it — and ctx.compact() does not check it either — so turning auto-compaction off in
// /settings still compacted at 100k tokens every time (the reported "off but still compacts").
// Cached by file mtime and size so the per-turn check costs two stat calls. mtime alone misses a
// rewrite within one timestamp tick on coarse-clock filesystems (overlayfs, older kernels).
const settingsCache = new Map<string, { mtimeMs: number; size: number; enabled: boolean | undefined }>();
function readCompactionEnabled(file: string): boolean | undefined {
  let mtimeMs: number;
  let size: number;
  try {
    ({ mtimeMs, size } = fs.statSync(file));
  } catch {
    settingsCache.delete(file);
    return undefined;
  }
  const cached = settingsCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.enabled;
  let enabled: boolean | undefined;
  try {
    const value = (JSON.parse(fs.readFileSync(file, "utf8")) as { compaction?: { enabled?: unknown } }).compaction?.enabled;
    enabled = typeof value === "boolean" ? value : undefined;
  } catch {
    enabled = cached?.enabled; // mid-write or corrupt: keep the last good value
  }
  settingsCache.set(file, { mtimeMs, size, enabled });
  return enabled;
}

export function piAutoCompactionEnabled(cwd: string): boolean {
  const project = readCompactionEnabled(path.join(cwd, ".pi", "settings.json"));
  if (project !== undefined) return project;
  return readCompactionEnabled(path.join(agentDir(), "settings.json")) ?? true;
}

function envThreshold(): number | undefined {
  const raw = process.env.PI_KIT_COMPACT_THRESHOLD_TOKENS;
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= MIN_THRESHOLD_TOKENS ? Math.floor(n) : undefined;
}

// Environment configuration is intentional for managed installs and takes priority, matching
// the rest of the kit's PI_KIT_* precedence convention (see e.g. PI_KIT_SUBAGENT_INHERIT_MODEL).
function resolveInitialThreshold(): number {
  return envThreshold() ?? loadPersistedThreshold() ?? DEFAULT_THRESHOLD_TOKENS;
}

// Accepts a plain integer or shorthand like "500k" / "1.2m".
function parseTokenAmount(raw: string): number | undefined {
  const m = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(k|m)?$/);
  if (!m) return undefined;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return undefined;
  const mult = m[2] === "k" ? 1_000 : m[2] === "m" ? 1_000_000 : 1;
  return Math.floor(value * mult);
}

function formatTokens(n: number): string {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000 && n % 1_000 === 0) return `${n / 1_000}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// Compaction callbacks are deferred: they fire after compaction finishes, by which point the
// session may have been replaced or reloaded. A ctx captured before that is stale, and reading
// `ctx.hasUI` on it throws ("This extension ctx is stale after session replacement or reload").
// Because the throw happens *inside* the compaction error handler, it surfaces as an unhandled
// extension error and kills the session instead of reporting the compaction failure. A dropped
// notification is always preferable to that.
function notifySafely(ctx: ExtensionContext, message: string, level: "info" | "error"): void {
  try {
    if (ctx.hasUI) ctx.ui.notify(message, level);
  } catch {
    /* stale ctx after reload — drop the notification */
  }
}

export default function (pi: ExtensionAPI) {
  let previousTokens: number | null | undefined;
  let thresholdTokens = resolveInitialThreshold();
  const envOverride = envThreshold();

  const triggerCompaction = (ctx: ExtensionContext, customInstructions?: string) => {
    notifySafely(ctx, "Compaction started", "info");
    ctx.compact({
      customInstructions,
      onComplete: () => notifySafely(ctx, "Compaction completed", "info"),
      onError: (error) => notifySafely(ctx, `Compaction failed: ${error.message}`, "error"),
    });
  };

  pi.on("turn_end", (_event, ctx) => {
    const usage = ctx.getContextUsage();
    const currentTokens = usage?.tokens ?? null;
    if (currentTokens === null) return;

    const crossedThreshold =
      previousTokens !== undefined &&
      previousTokens !== null &&
      previousTokens <= thresholdTokens;
    previousTokens = currentTokens;
    if (!crossedThreshold || currentTokens <= thresholdTokens) return;
    // Automatic compaction obeys both switches; the manual /trigger-compact always works.
    if (!kitTriggerEnabled() || !piAutoCompactionEnabled(ctx.cwd ?? process.cwd())) return;
    triggerCompaction(ctx);
  });

  pi.registerCommand("trigger-compact", {
    description: "Trigger compaction immediately, optionally with custom instructions",
    handler: async (args, ctx) => {
      const instructions = args.trim() || undefined;
      triggerCompaction(ctx, instructions);
    },
  });

  pi.registerCommand("compact-threshold", {
    description: "View or change the kit auto-compact trigger: /compact-threshold [amount|off|on|reset], e.g. /compact-threshold 500k",
    handler: async (args, ctx) => {
      const arg = args.trim();
      const window = ctx.getContextUsage()?.contextWindow;
      const windowNote = window ? ` (context window: ${formatTokens(window)})` : "";

      if (!arg || arg.toLowerCase() === "status") {
        const source = envOverride !== undefined ? "env override" : loadPersistedThreshold() !== undefined ? "saved" : "default";
        const piOn = piAutoCompactionEnabled(ctx.cwd ?? process.cwd());
        const state = !piOn ? "OFF (pi auto-compaction is disabled in /settings)" : !kitTriggerEnabled() ? "OFF (/compact-threshold off)" : "on";
        if (ctx.hasUI) ctx.ui.notify(`Auto-compact trigger: ${state} · threshold ${formatTokens(thresholdTokens)} tokens [${source}]${windowNote}`, "info");
        return;
      }

      if (arg.toLowerCase() === "off" || arg.toLowerCase() === "on") {
        const enable = arg.toLowerCase() === "on";
        try {
          savePersisted({ enabled: enable ? undefined : false });
        } catch {
          if (ctx.hasUI) ctx.ui.notify("Could not save the setting; it was not changed", "error");
          return;
        }
        const piNote = enable && !piAutoCompactionEnabled(ctx.cwd ?? process.cwd()) ? " — note: pi auto-compaction is still off in /settings, which also stops this trigger" : "";
        if (ctx.hasUI) ctx.ui.notify(`Kit auto-compact trigger ${enable ? "enabled" : "disabled"}${piNote}. Manual /compact and /trigger-compact still work.`, "info");
        return;
      }

      if (envOverride !== undefined) {
        if (ctx.hasUI) ctx.ui.notify("Auto-compact threshold is locked by PI_KIT_COMPACT_THRESHOLD_TOKENS; unset it to change this from the TUI", "error");
        return;
      }

      if (arg.toLowerCase() === "reset") {
        thresholdTokens = DEFAULT_THRESHOLD_TOKENS;
        try { savePersisted({ thresholdTokens: undefined }); } catch { /* best effort */ }
        if (ctx.hasUI) ctx.ui.notify(`Auto-compact threshold reset to default (${formatTokens(DEFAULT_THRESHOLD_TOKENS)} tokens)${windowNote}`, "info");
        return;
      }

      const parsed = parseTokenAmount(arg);
      if (parsed === undefined || parsed < MIN_THRESHOLD_TOKENS) {
        if (ctx.hasUI) ctx.ui.notify(`Invalid threshold "${arg}". Use a token count, e.g. 500000 or 500k`, "error");
        return;
      }
      if (window && parsed >= window) {
        if (ctx.hasUI) ctx.ui.notify(`${formatTokens(parsed)} is at or above the ${formatTokens(window)} context window — auto-compact would never fire. Not changed.`, "error");
        return;
      }

      thresholdTokens = parsed;
      try {
        savePersistedThreshold(parsed);
      } catch {
        if (ctx.hasUI) ctx.ui.notify(`Threshold set to ${formatTokens(parsed)} for this session, but saving to disk failed — it will not persist across restarts`, "error");
        return;
      }
      if (ctx.hasUI) ctx.ui.notify(`Auto-compact threshold set to ${formatTokens(parsed)} tokens${windowNote}`, "info");
    },
  });
}
