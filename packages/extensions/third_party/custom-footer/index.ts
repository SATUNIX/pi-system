import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { todoFilePath, resolveSessionId, readTodos } from "./todo-read.ts";

// GitOps status bar (custom-footer).
//
// 1. Footer: replaces pi's built-in footer through the supported setFooter(factory)
//    API with a colored, width-aware 3-line bar: location + model, context + tokens,
//    extension status chips + todo progress. Session token totals are computed from
//    the session entries (like pi's own footer), so a resumed session shows real totals.
//    If rendering ever throws, it falls back to a plain line instead of an empty footer.
// 2. Working line: while the agent runs, a 1 s ticker sets the working message to
//    "<activity>… 1m 04s · ↑12.3k ↓~850". The activity follows the running tool, the
//    stream kind (thinking / writing / tool call), or rotates through phrases.
// 3. Tips: a one-line tip widget during runs. /tips on|off (persisted).
// 4. Todos: a checklist widget above the editor from this session's todo file
//    (<cwd>/.pi/todos/<session>.md; see ../todo/todo-file.ts). /footer todos on|off.
//
// Settings persist in <agent dir>/pi-kit/ui.json. Accounting continues while hidden.

type FooterCtx = ExtensionContext;
type Theme = { fg: (color: string, text: string) => string; bold: (text: string) => string };

type Pricing = {
  inputPerMTok?: number;
  outputPerMTok?: number;
  cacheReadPerMTok?: number;
  cacheWritePerMTok?: number;
  source: string;
};

export type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; cost: number };

export type FooterMode = "default" | "light" | "heavy";
type UiSettings = { footer: boolean; mode: FooterMode; tips: boolean; todos: boolean };

const DEFAULT_PRICING: Pricing = { source: "unconfigured (cost unknown)" };
const TIP_WIDGET = "pi-kit-tips";
const TODO_WIDGET = "pi-kit-todos";
const TICK_MS = 1000;
const PHRASE_ROTATE_MS = 8000;
const TIP_ROTATE_MS = 30000;

// ---------------------------------------------------------------------------
// Pricing (unchanged contract: .pi-kit/costs.json, ~/.pi/agent/pi-kit/costs.json, env)
// ---------------------------------------------------------------------------

function numberFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

function readPricingFile(filePath: string): Partial<Pricing> | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
  const values = {
    inputPerMTok: numberFrom(raw.inputPerMTok ?? raw.input_per_mtok ?? raw.input),
    outputPerMTok: numberFrom(raw.outputPerMTok ?? raw.output_per_mtok ?? raw.output),
    cacheReadPerMTok: numberFrom(raw.cacheReadPerMTok ?? raw.cache_read_per_mtok ?? raw.cacheRead),
    cacheWritePerMTok: numberFrom(raw.cacheWritePerMTok ?? raw.cache_write_per_mtok ?? raw.cacheWrite),
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)) as Partial<Pricing>;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function pricingPaths(cwd: string): string[] {
  return [path.join(cwd, ".pi-kit", "costs.json"), path.join(agentDir(), "pi-kit", "costs.json")];
}

function loadPricing(cwd: string, previous: Pricing): { pricing: Pricing; warning?: string } {
  let pricing: Pricing = { ...DEFAULT_PRICING };
  try {
    for (const filePath of pricingPaths(cwd)) {
      const filePricing = readPricingFile(filePath);
      if (!filePricing) continue;
      pricing = { ...pricing, ...filePricing, source: filePath };
      break;
    }
  } catch (error) {
    return { pricing: previous, warning: `GitOps status bar kept prior pricing because cost config could not be read: ${(error as Error).message}` };
  }
  const envOverrides: Partial<Pricing> = {
    inputPerMTok: numberFrom(process.env.PI_KIT_COST_INPUT_PER_MTOK),
    outputPerMTok: numberFrom(process.env.PI_KIT_COST_OUTPUT_PER_MTOK),
    cacheReadPerMTok: numberFrom(process.env.PI_KIT_COST_CACHE_READ_PER_MTOK),
    cacheWritePerMTok: numberFrom(process.env.PI_KIT_COST_CACHE_WRITE_PER_MTOK),
  };
  const activeEnvKeys = Object.entries(envOverrides).filter(([, value]) => value !== undefined);
  if (activeEnvKeys.length > 0) pricing = { ...pricing, ...Object.fromEntries(activeEnvKeys), source: `${pricing.source} + env override` };
  return { pricing };
}

export function estimateCost(totals: UsageTotals, pricing: Pricing): number | undefined {
  const pairs = [[totals.input, pricing.inputPerMTok], [totals.output, pricing.outputPerMTok],
    [totals.cacheRead, pricing.cacheReadPerMTok], [totals.cacheWrite, pricing.cacheWritePerMTok]];
  if (pairs.every(([, rate]) => rate === undefined) || pairs.some(([count, rate]) => count !== 0 && rate === undefined)) {
    return totals.cost > 0 ? totals.cost : undefined;
  }
  return pairs.reduce<number>((sum, [count, rate]) => sum + (count ?? 0) * (rate ?? 0) / 1_000_000, 0);
}

// ---------------------------------------------------------------------------
// Formatting helpers (ANSI-aware; no pi-tui dependency)
// ---------------------------------------------------------------------------

const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x07]*\x07/g;

export function visibleWidth(text: string): number {
  return [...text.replace(ANSI, "")].length;
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  let out = "";
  let seen = 0;
  const re = /(\x1b\[[0-9;]*m)|([\s\S])/gu;
  for (const m of text.matchAll(re)) {
    if (m[1]) { out += m[1]; continue; }
    if (seen >= width - 1) break;
    out += m[2];
    seen++;
  }
  return `${out}\x1b[0m…`;
}

function spread(left: string, right: string, width: number): string {
  const lw = visibleWidth(left);
  const rw = visibleWidth(right);
  if (!right) return truncate(left, width);
  if (lw + 2 + rw <= width) return left + " ".repeat(width - lw - rw) + right;
  if (rw + 10 > width) return truncate(left, width);
  return truncate(left, width - rw - 2) + "  " + right;
}

export function fmtTokens(value: number): string {
  if (value < 1000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (value < 10_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return `${Math.round(value / 1_000_000)}M`;
}

export function fmtCost(value: number | undefined): string {
  if (value === undefined) return "unknown";
  if (value === 0) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function shortCwd(cwd: string): string {
  const home = os.homedir();
  const rel = path.relative(home, cwd);
  const inside = rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  const shown = inside ? (rel ? `~${path.sep}${rel}` : "~") : cwd;
  const parts = shown.split(/[\\/]/);
  return parts.length > 4 ? [parts[0], "…", ...parts.slice(-2)].join(path.sep) : shown;
}

function currentBranch(cwd: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000, windowsHide: true }).trim() || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export function sessionTotals(entries: unknown): { totals: UsageTotals; partial: boolean } {
  const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
  let partial = false;
  if (!Array.isArray(entries)) return { totals, partial };
  for (const entry of entries) {
    const msg = (entry as { type?: string; message?: { role?: string; usage?: Record<string, any>; stopReason?: string } })?.message;
    if ((entry as { type?: string })?.type !== "message" || msg?.role !== "assistant") continue;
    const u = msg.usage;
    if (!u) { partial = true; continue; }
    totals.input += numberFrom(u.input) ?? 0;
    totals.output += numberFrom(u.output) ?? 0;
    totals.cacheRead += numberFrom(u.cacheRead) ?? 0;
    totals.cacheWrite += numberFrom(u.cacheWrite) ?? 0;
    totals.total += numberFrom(u.totalTokens) ?? ((numberFrom(u.input) ?? 0) + (numberFrom(u.output) ?? 0) + (numberFrom(u.cacheRead) ?? 0) + (numberFrom(u.cacheWrite) ?? 0));
    totals.cost += numberFrom(u.cost?.total) ?? 0;
  }
  return { totals, partial };
}

export type TodoItem = { id: number; text: string; state: "open" | "active" | "done" };

export function readTodoItems(cwd: string, sessionId?: string): TodoItem[] {
  try {
    return readTodos(todoFilePath(cwd, sessionId)).todos
      .map((t) => ({ id: t.id, text: t.text.trim(), state: t.state }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export type FooterState = {
  cwd: string;
  branch?: string;
  sessionName?: string;
  provider?: string;
  model?: string;
  thinking?: string;
  context?: { tokens?: number | null; contextWindow?: number; percent?: number | null };
  totals: UsageTotals;
  partial: boolean;
  cost?: number;
  run?: { startedAt: number; endedAt?: number; input: number; output: number; estOutput: number };
  statuses: Array<[string, string]>;
  todos: TodoItem[];
  now: number;
};

type Glyphs = {
  ascii: boolean;
  marker: string;
  separator: string;
  filled: string;
  empty: string;
  input: string;
  output: string;
  cache: string;
  done: string;
  active: string;
  open: string;
  more: string;
};

export function footerGlyphs(theme: Theme): Glyphs {
  // These themes intentionally use only characters available on a standard keyboard.
  const ascii = /(?:^|[-_])(iso|ansi|tty|ascii)(?:[-_]|$)/i.test((theme as any).name ?? "");
  return ascii ? {
    ascii, marker: ">", separator: " | ", filled: "=", empty: "-", input: "in:", output: "out:", cache: "cache:",
    done: "[x]", active: "[>]", open: "[ ]", more: "...",
  } : {
    ascii, marker: "●", separator: " │ ", filled: "█", empty: "░", input: "↑", output: "↓", cache: "⟲",
    done: "✔", active: "▸", open: "☐", more: "…",
  };
}

function bar(pct: number, cells: number, theme: Theme, glyphs: Glyphs): string {
  const filled = Math.max(0, Math.min(cells, Math.round((pct / 100) * cells)));
  const color = pct > 90 ? "error" : pct > 70 ? "warning" : "success";
  return theme.fg(color, glyphs.filled.repeat(filled)) + theme.fg("dim", glyphs.empty.repeat(cells - filled));
}

function statusColor(text: string): string {
  if (/\b(fail|failed|error|blocked|denied|lost=[1-9])/i.test(text)) return "error";
  if (/\b(warn|stale|partial|no script|pending)/i.test(text)) return "warning";
  if (/\b(pass|passed|ok|ready|on|done|lost=0)\b/i.test(text)) return "success";
  if (/running|…|\.\.\./i.test(text)) return "accent";
  return "text";
}

export function statusChip(key: string, raw: string, theme: Theme): string {
  const text = raw.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
  const label = key.replace(/^pi-kit-/, "");
  // Many extensions already prefix their own name ("trace-ledger: lost=0").
  const prefixed = text.match(/^([\w.-]+):\s*(.*)$/);
  const name = prefixed && prefixed[1].toLowerCase() === label.toLowerCase() ? prefixed[1] : label;
  const value = prefixed && prefixed[1].toLowerCase() === label.toLowerCase() ? prefixed[2] : text;
  return `${theme.fg("dim", name)} ${theme.fg(statusColor(value), value)}`;
}

function thinkingColor(level?: string): string {
  switch (level) {
    case "minimal": return "thinkingMinimal";
    case "low": return "thinkingLow";
    case "medium": return "thinkingMedium";
    case "high": return "thinkingHigh";
    case "xhigh": return "thinkingXhigh";
    default: return "thinkingOff";
  }
}

export function renderFooter(state: FooterState, theme: Theme, width: number, mode: FooterMode = "default"): string[] {
  const glyphs = footerGlyphs(theme);
  const sep = theme.fg("borderMuted", glyphs.separator);
  const narrow = width < 90;

  // Line 1: where + model
  const project = path.basename(state.cwd) || state.cwd;
  const left1 = [
    theme.fg("accent", glyphs.marker) + " " + theme.bold(theme.fg("text", project)),
    narrow ? "" : theme.fg("dim", shortCwd(state.cwd)),
    state.branch ? theme.fg("muted", "on ") + theme.fg("mdLink", state.branch) : theme.fg("dim", "no git"),
    state.sessionName ? theme.fg("muted", `${glyphs.ascii ? "session " : "• "}${state.sessionName}`) : "",
  ].filter(Boolean).join(" ");
  const right1 = [
    state.provider && !narrow ? theme.fg("dim", state.provider + " ") : "",
    theme.fg("accent", state.model ?? "no model"),
    state.thinking && state.thinking !== "off" ? theme.fg("dim", glyphs.ascii ? " | " : " · ") + theme.fg(thinkingColor(state.thinking), `think ${state.thinking}`) : "",
  ].join("");

  // Line 2: context + tokens + run
  const ctx = state.context ?? {};
  const pct = typeof ctx.percent === "number" ? ctx.percent : undefined;
  const ctxText = pct === undefined
    ? theme.fg("dim", `ctx ?/${fmtTokens(ctx.contextWindow ?? 0)}`)
    : `${theme.fg("dim", "ctx ")}${bar(pct, narrow ? 8 : 12, theme, glyphs)} ${theme.fg(pct > 90 ? "error" : pct > 70 ? "warning" : "text", `${pct.toFixed(0)}%`)}${theme.fg("dim", ` ${fmtTokens(ctx.tokens ?? 0)}/${fmtTokens(ctx.contextWindow ?? 0)}`)}`;
  const t = state.totals;
  const tokens = [
    theme.fg("success", `${glyphs.input}${fmtTokens(t.input)}`),
    theme.fg("accent", `${glyphs.output}${fmtTokens(t.output)}`),
    t.cacheRead ? theme.fg("muted", `${glyphs.cache}${fmtTokens(t.cacheRead)}`) : "",
    state.cost !== undefined ? theme.fg("warning", fmtCost(state.cost)) : "",
    state.partial ? theme.fg("warning", "partial") : "",
  ].filter(Boolean).join(" ");
  const left2 = [ctxText, `${theme.fg("dim", "session ")}${tokens}`].join(sep);
  let right2 = "";
  if (state.run) {
    const live = state.run.endedAt === undefined;
    const elapsed = (state.run.endedAt ?? state.now) - state.run.startedAt;
    const out = state.run.output + state.run.estOutput;
    right2 = `${theme.fg("dim", live ? "run " : "last run ")}${theme.fg(live ? "accent" : "muted", fmtDuration(elapsed))} ${theme.fg("success", `${glyphs.input}${fmtTokens(state.run.input)}`)} ${theme.fg("accent", `${glyphs.output}${state.run.estOutput > 0 ? "~" : ""}${fmtTokens(out)}`)}`;
  }

  if (mode === "light") {
    const compact = [
      theme.fg("accent", glyphs.marker), theme.bold(theme.fg("text", project)),
      state.branch ? theme.fg("mdLink", state.branch) : "",
      theme.fg("dim", "ctx"), pct === undefined ? "?" : theme.fg(pct > 90 ? "error" : pct > 70 ? "warning" : "text", `${pct.toFixed(0)}%`),
      theme.fg("success", `${glyphs.input}${fmtTokens(t.input)}`), theme.fg("accent", `${glyphs.output}${fmtTokens(t.output)}`),
    ].filter(Boolean).join(sep);
    return [truncate(compact, width)];
  }

  const lines = mode === "heavy"
    ? [truncate(left1, width), truncate(right1, width), spread(left2, right2, width)]
    : [spread(left1, right1, width), spread(left2, right2, width)];

  // Line 3: todos + status chips
  const chips: string[] = [];
  if (state.todos.length) {
    const done = state.todos.filter((i) => i.state === "done").length;
    chips.push(`${theme.fg("dim", "todos")} ${theme.fg(done === state.todos.length ? "success" : "accent", `${done}/${state.todos.length}`)}`);
  }
  for (const [key, value] of state.statuses) {
    if (key === "custom-footer" || !value?.trim()) continue;
    chips.push(statusChip(key, value, theme));
  }
  if (chips.length) lines.push(truncate(chips.join(sep), width));
  else if (mode === "heavy") lines.push(theme.fg("dim", "status no extension status"));
  return lines;
}

export function renderTodoWidget(items: TodoItem[], theme: Theme, max = 8): string[] {
  if (!items.length) return [];
  const done = items.filter((i) => i.state === "done").length;
  const cells = 10;
  const filled = Math.round((done / items.length) * cells);
  const glyphs = footerGlyphs(theme);
  const header = `${theme.bold(theme.fg("accent", "Todos"))} ${theme.fg(done === items.length ? "success" : "text", `${done}/${items.length}`)} ${theme.fg("success", glyphs.filled.repeat(filled))}${theme.fg("dim", glyphs.empty.repeat(cells - filled))}`;
  if (done === items.length) return [`${header} ${theme.fg("success", "all done")}`];
  // Show active first, then open, then the most recent done items, capped.
  const order = [...items.filter((i) => i.state === "active"), ...items.filter((i) => i.state === "open"), ...items.filter((i) => i.state === "done")];
  const shown = order.slice(0, max).sort((a, b) => a.id - b.id);
  const lines = [header];
  for (const item of shown) {
    if (item.state === "done") lines.push(`  ${theme.fg("success", glyphs.done)} ${theme.fg("dim", `#${item.id} ${item.text}`)}`);
    else if (item.state === "active") lines.push(`  ${theme.fg("accent", glyphs.active)} ${theme.bold(theme.fg("text", `#${item.id} ${item.text}`))}`);
    else lines.push(`  ${theme.fg("muted", glyphs.open)} ${theme.fg("text", `#${item.id} ${item.text}`)}`);
  }
  if (items.length > shown.length) lines.push(theme.fg("dim", `  ${glyphs.more} ${items.length - shown.length} more`));
  return lines;
}

// ---------------------------------------------------------------------------
// Working line
// ---------------------------------------------------------------------------

export const PHRASES = [
  "Working", "Thinking it through", "Connecting the dots", "Checking assumptions", "Planning the next step",
  "Weighing the options", "Following the thread", "Cross-referencing", "Tracing the logic", "Gathering context",
  "Mapping the terrain", "Untangling", "Triangulating", "Recalibrating", "Crunching", "Pondering",
  "Sifting through details", "Lining things up", "Double-checking", "Piecing it together",
];

export function toolPhrase(toolName: string, args: any): string {
  const clip = (s: unknown, n = 40) => {
    const v = String(s ?? "").replace(/\s+/g, " ").trim();
    return v.length > n ? `${v.slice(0, n - 1)}…` : v;
  };
  const base = (p: unknown) => (typeof p === "string" ? path.basename(p) : "");
  switch (toolName) {
    case "read": return `Reading ${base(args?.path) || "a file"}`;
    case "edit": return `Editing ${base(args?.path) || "a file"}`;
    case "write": return `Writing ${base(args?.path) || "a file"}`;
    case "bash": return args?.command ? `Running \`${clip(args.command)}\`` : "Running a command";
    case "grep": case "find": case "ls": return "Searching the workspace";
    case "subagent": case "dispatch_specialist": case "dispatch_validator": return "Delegating to a subagent";
    case "todo": return "Updating the todo list";
    case "verify_completion": return "Verifying completion";
    case "record_verdict": case "verdict_status": return "Checking the verifier board";
    default:
      if (/^memory/.test(toolName)) return "Consulting memory";
      return `Using ${toolName}`;
  }
}

export type Tip = { text: string; requires?: string };

export const TIPS: Tip[] = [
  { text: "/compress shrinks the context instantly, with no model call.", requires: "compress" },
  { text: "/save writes a snapshot of this session to disk or the vault. It does not compact.", requires: "save" },
  { text: "/verify runs an independent reviewer against the goal and todo list.", requires: "verify" },
  { text: "/verdicts shows what done means and what still blocks completion.", requires: "verdicts" },
  { text: "/goal <text> sets the mission goal that the verifier checks.", requires: "goal" },
  { text: "/kit lists every kit command.", requires: "kit" },
  { text: "/handoff writes a resume note for the next session.", requires: "handoff" },
  { text: "/footer status shows token and cost detail. /footer toggles this bar." },
  { text: "/footer todos off hides the todo checklist." },
  { text: "/tips off hides these tips." },
  { text: "/fork branches from an earlier message. The original branch stays." },
  { text: "/tree moves between branches of this session." },
  { text: "!command runs a shell command. !!command keeps the output out of context." },
  { text: "/model switches the model. /settings opens the settings menu." },
  { text: "/new starts a fresh session. Run /save first to keep a snapshot." },
  { text: "Press Esc to interrupt the agent." },
];

function pick<T>(list: T[], avoid?: T): T {
  if (list.length <= 1) return list[0];
  let item = list[Math.floor(Math.random() * list.length)];
  if (item === avoid) item = list[(list.indexOf(item) + 1) % list.length];
  return item;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function settingsFile(): string {
  return path.join(agentDir(), "pi-kit", "ui.json");
}

function loadSettings(): UiSettings {
  const defaults: UiSettings = { footer: true, mode: "default", tips: process.env.PI_KIT_TIPS !== "0", todos: process.env.PI_KIT_TODO_WIDGET !== "0" };
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return {
      footer: typeof raw.footer === "boolean" ? raw.footer : defaults.footer,
      mode: raw.mode === "light" || raw.mode === "heavy" || raw.mode === "default" ? raw.mode : defaults.mode,
      tips: process.env.PI_KIT_TIPS === "0" ? false : typeof raw.tips === "boolean" ? raw.tips : defaults.tips,
      todos: process.env.PI_KIT_TODO_WIDGET === "0" ? false : typeof raw.todos === "boolean" ? raw.todos : defaults.todos,
    };
  } catch {
    return defaults;
  }
}

function saveSettings(settings: UiSettings): void {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2));
  } catch {
    /* best effort */
  }
}

function commandArgs(args: unknown): string[] {
  if (Array.isArray(args)) return args.map((a) => String(a).toLowerCase());
  if (typeof args === "string") return args.trim().split(/\s+/).filter(Boolean).map((a) => a.toLowerCase());
  return [];
}

function onOff(value: string | undefined, current: boolean): boolean {
  if (value === "on" || value === "true" || value === "1") return true;
  if (value === "off" || value === "false" || value === "0") return false;
  return !current;
}

function footerMode(value: string | undefined): FooterMode | undefined {
  return value === "default" || value === "light" || value === "heavy" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  let settings = loadSettings();
  let pricing = { ...DEFAULT_PRICING };
  let ctxRef: FooterCtx | undefined;
  let requestRender: (() => void) | undefined;
  let footerInstalled = false;
  let cache: Omit<FooterState, "now" | "statuses"> & { statusProvider?: () => Array<[string, string]> } = {
    cwd: process.cwd(),
    totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
    partial: false,
    todos: [],
  };

  // Current agent run (user prompt -> agent_end).
  let run: FooterState["run"];
  let activity: { label: string; until: number } | undefined;
  let phrase = PHRASES[0];
  let phraseAt = 0;
  let tip: Tip | undefined;
  let tipAt = 0;
  let ticker: ReturnType<typeof setInterval> | undefined;

  const hasTui = (ctx?: FooterCtx) => !!ctx && ctx.hasUI !== false && !!ctx.ui;

  function refresh(ctx: FooterCtx | undefined): void {
    if (!ctx) return;
    ctxRef = ctx;
    const cwd = ctx.cwd ?? process.cwd();
    let entries: unknown = [];
    try { entries = (ctx as any).sessionManager?.getEntries?.() ?? []; } catch { /* stale ctx */ }
    const { totals, partial } = sessionTotals(entries);
    let context: FooterState["context"];
    try { context = (ctx.getContextUsage?.() ?? undefined) as FooterState["context"]; } catch { context = undefined; }
    let thinking: string | undefined;
    try { thinking = (pi as any).getThinkingLevel?.(); } catch { thinking = undefined; }
    let sessionName: string | undefined;
    try { sessionName = (ctx as any).sessionManager?.getSessionName?.(); } catch { sessionName = undefined; }
    const sessionId = resolveSessionId((ctx as any).sessionManager);
    cache = {
      ...cache,
      cwd,
      branch: cache.statusProvider ? cache.branch : currentBranch(cwd),
      sessionName,
      provider: (ctx.model as any)?.provider,
      model: ctx.model?.id,
      thinking,
      context: context ? { ...context, contextWindow: context.contextWindow ?? (ctx.model as any)?.contextWindow } : { contextWindow: (ctx.model as any)?.contextWindow },
      totals,
      partial,
      cost: estimateCost(totals, pricing),
      todos: readTodoItems(cwd, sessionId),
    };
    updateTodoWidget(ctx);
    requestRender?.();
  }

  function state(): FooterState {
    let statuses: Array<[string, string]> = [];
    try { statuses = cache.statusProvider?.() ?? []; } catch { statuses = []; }
    return { ...cache, run, statuses, now: Date.now() };
  }

  function installFooter(ctx: FooterCtx): void {
    if (!hasTui(ctx) || typeof (ctx.ui as any).setFooter !== "function") return;
    (ctx.ui as any).setFooter((tui: any, theme: Theme, footerData: any) => {
      requestRender = () => { try { tui?.requestRender?.(); } catch { /* ignore */ } };
      cache.statusProvider = () => [...(footerData?.getExtensionStatuses?.() ?? new Map()).entries()].sort(([a]: [string], [b]: [string]) => a.localeCompare(b));
      const unsubscribe = footerData?.onBranchChange?.(() => { cache.branch = footerData.getGitBranch?.() ?? undefined; requestRender?.(); });
      cache.branch = footerData?.getGitBranch?.() ?? cache.branch;
      return {
        render(width: number): string[] {
          try {
            return renderFooter(state(), theme, width, settings.mode);
          } catch (error) {
            const t = cache.totals;
            return [truncate(`pi-kit status bar error (${String((error as Error)?.message ?? error)}) | ↑${fmtTokens(t.input)} ↓${fmtTokens(t.output)} | ${cache.model ?? "no model"}`, width)];
          }
        },
        invalidate() {},
        dispose() {
          try { unsubscribe?.(); } catch { /* ignore */ }
          requestRender = undefined;
          cache.statusProvider = undefined;
        },
      };
    });
    footerInstalled = true;
  }

  function removeFooter(ctx: FooterCtx): void {
    if (!hasTui(ctx)) return;
    try { (ctx.ui as any).setFooter?.(undefined); } catch { /* ignore */ }
    footerInstalled = false;
  }

  function updateTodoWidget(ctx: FooterCtx): void {
    if (!hasTui(ctx) || typeof (ctx.ui as any).setWidget !== "function") return;
    const theme = (ctx.ui as any).theme as Theme | undefined;
    if (!settings.todos || !theme || !cache.todos.length) {
      (ctx.ui as any).setWidget(TODO_WIDGET, undefined);
      return;
    }
    (ctx.ui as any).setWidget(TODO_WIDGET, renderTodoWidget(cache.todos, theme));
  }

  function availableTips(): Tip[] {
    let names = new Set<string>();
    try { names = new Set((pi.getCommands?.() ?? []).map((c: any) => String(c.name).replace(/^\//, ""))); } catch { /* ignore */ }
    return TIPS.filter((t) => !t.requires || names.has(t.requires));
  }

  function workingText(now: number): string {
    const theme = (ctxRef?.ui as any)?.theme as Theme | undefined;
    const fg = (c: string, s: string) => (theme ? theme.fg(c, s) : s);
    const ellipsis = theme && footerGlyphs(theme).ascii ? "..." : "…";
    if (now - phraseAt > PHRASE_ROTATE_MS) { phrase = pick(PHRASES, phrase); phraseAt = now; }
    const label = activity && activity.until > now ? activity.label : phrase;
    if (!run) return `${label}${ellipsis}`;
    const out = run.output + run.estOutput;
    const glyphs = theme ? footerGlyphs(theme) : footerGlyphs({ fg: (_color, text) => text, bold: (text) => text });
    return `${label}${ellipsis} ${fg("dim", "(")}${fg("text", fmtDuration(now - run.startedAt))}${fg("dim", glyphs.ascii ? " | " : " · ")}${fg("success", `${glyphs.input}${fmtTokens(run.input)}`)} ${fg("accent", `${glyphs.output}${run.estOutput > 0 ? "~" : ""}${fmtTokens(out)}`)}${fg("dim", ")")}`;
  }

  function tick(): void {
    const ctx = ctxRef;
    if (!hasTui(ctx) || !run || run.endedAt !== undefined) return;
    const now = Date.now();
    try { (ctx!.ui as any).setWorkingMessage?.(workingText(now)); } catch { /* ignore */ }
    if (settings.tips) {
      if (!tip || now - tipAt > TIP_ROTATE_MS) {
        const tips = availableTips();
        tip = tips.length ? pick(tips, tip) : undefined;
        tipAt = now;
        const theme = (ctx!.ui as any).theme as Theme | undefined;
        if (tip && theme) (ctx!.ui as any).setWidget?.(TIP_WIDGET, [`${theme.fg("dim", "  ⎿ Tip: ")}${theme.fg("muted", tip.text)}`]);
      }
    }
    requestRender?.();
  }

  function stopTicker(ctx?: FooterCtx): void {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
    tip = undefined;
    const c = ctx ?? ctxRef;
    if (hasTui(c)) {
      try { (c!.ui as any).setWidget?.(TIP_WIDGET, undefined); } catch { /* ignore */ }
      try { (c!.ui as any).setWorkingMessage?.(); } catch { /* ignore */ }
    }
  }

  function reloadPricing(ctx: FooterCtx): void {
    const result = loadPricing(ctx.cwd ?? process.cwd(), pricing);
    pricing = result.pricing;
    if (result.warning) ctx.ui?.notify?.(result.warning, "warning");
  }

  pi.on("session_start", async (_event, ctx) => {
    settings = loadSettings();
    run = undefined;
    stopTicker(ctx as FooterCtx);
    reloadPricing(ctx as FooterCtx);
    if (settings.footer) installFooter(ctx as FooterCtx);
    refresh(ctx as FooterCtx);
  });

  pi.on("agent_start", async (_event, ctx) => {
    ctxRef = ctx as FooterCtx;
    run = { startedAt: Date.now(), input: 0, output: 0, estOutput: 0 };
    phrase = pick(PHRASES);
    phraseAt = Date.now();
    tip = undefined;
    if (ticker) clearInterval(ticker);
    if (hasTui(ctx as FooterCtx)) {
      ticker = setInterval(tick, TICK_MS);
      (ticker as any).unref?.();
      tick();
    }
  });

  pi.on("message_update", async (event: any) => {
    if (!run) return;
    const e = event?.assistantMessageEvent;
    const now = Date.now();
    if (e?.type === "text_delta" || e?.type === "thinking_delta" || e?.type === "toolcall_delta") {
      run.estOutput += Math.max(0, String(e.delta ?? "").length / 4);
      if (!activity || activity.until < now || !activity.label.startsWith("Running")) {
        activity = { label: e.type === "thinking_delta" ? "Thinking" : e.type === "text_delta" ? "Writing the response" : "Preparing a tool call", until: now + 1500 };
      }
    }
  });

  pi.on("message_end", async (event: any, ctx) => {
    const msg = event?.message;
    if (run && msg?.role === "assistant") {
      run.input += numberFrom(msg.usage?.input) ?? 0;
      run.output += numberFrom(msg.usage?.output) ?? 0;
      run.estOutput = 0;
    }
    refresh(ctx as FooterCtx);
  });

  pi.on("tool_execution_start", async (event: any) => {
    activity = { label: toolPhrase(event?.toolName ?? "tool", event?.args), until: Number.MAX_SAFE_INTEGER };
  });

  pi.on("tool_execution_end", async (event: any, ctx) => {
    activity = undefined;
    if (["todo", "write", "edit"].includes(event?.toolName)) refresh(ctx as FooterCtx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    refresh(ctx as FooterCtx);
  });

  pi.on("agent_end", async (_event, ctx) => {
    if (run) run.endedAt = Date.now();
    activity = undefined;
    stopTicker(ctx as FooterCtx);
    refresh(ctx as FooterCtx);
  });

  pi.on("model_select", async (_event, ctx) => refresh(ctx as FooterCtx));
  pi.on("thinking_level_select", async (_event, ctx) => refresh(ctx as FooterCtx));

  pi.registerCommand("footer", {
    description: "GitOps status bar: /footer default|light|heavy|off, /footer config, /footer status, /footer reload, /footer todos on|off",
    handler: async (args, ctx) => {
      const footerCtx = ctx as FooterCtx;
      const [arg, value] = commandArgs(args);
      if (arg === "status") {
        refresh(footerCtx);
        const t = cache.totals;
        footerCtx.ui?.notify?.(
          `GitOps status bar: ${settings.footer ? settings.mode : "off"}; tips ${settings.tips ? "on" : "off"}; todos ${settings.todos ? "on" : "off"}; pricing source: ${pricing.source}; input ${t.input}; output ${t.output}; cache read ${t.cacheRead}; total ${t.total}; estimated cost ${fmtCost(cache.cost)}; session totals${cache.partial ? " (partial usage)" : ""}`,
          "info",
        );
        return;
      }
      if (arg === "reload") {
        reloadPricing(footerCtx);
        refresh(footerCtx);
        footerCtx.ui?.notify?.(`GitOps status bar pricing reloaded from ${pricing.source}`, "info");
        return;
      }
      if (arg === "todos") {
        settings.todos = onOff(value, settings.todos);
        saveSettings(settings);
        refresh(footerCtx);
        footerCtx.ui?.notify?.(`todo checklist ${settings.todos ? "on" : "off"}`, "info");
        return;
      }
      if (arg === "config" || arg === "settings") {
        const choice = await footerCtx.ui?.select?.("Status bar", ["default", "light", "heavy", "off"]);
        if (!choice) return;
        if (choice === "off") {
          settings.footer = false;
          saveSettings(settings);
          removeFooter(footerCtx);
          footerCtx.ui?.notify?.("GitOps status bar disabled (pi's built-in footer restored)", "info");
          return;
        }
        settings.footer = true;
        settings.mode = choice as FooterMode;
        saveSettings(settings);
        installFooter(footerCtx);
        refresh(footerCtx);
        footerCtx.ui?.notify?.(`GitOps status bar set to ${settings.mode}`, "info");
        return;
      }
      const mode = footerMode(arg);
      if (mode) {
        settings.footer = true;
        settings.mode = mode;
        saveSettings(settings);
        installFooter(footerCtx);
        refresh(footerCtx);
        footerCtx.ui?.notify?.(`GitOps status bar set to ${settings.mode}`, "info");
        return;
      }
      settings.footer = arg === "on" ? true : arg === "off" ? false : !settings.footer;
      saveSettings(settings);
      if (settings.footer) {
        installFooter(footerCtx);
        refresh(footerCtx);
        footerCtx.ui?.notify?.("GitOps status bar enabled", "info");
      } else {
        removeFooter(footerCtx);
        footerCtx.ui?.notify?.("GitOps status bar disabled (pi's built-in footer restored)", "info");
      }
    },
  });

  pi.registerCommand("tips", {
    description: "Show or hide usage tips while the agent works: /tips on|off",
    handler: async (args, ctx) => {
      const [value] = commandArgs(args);
      settings.tips = onOff(value, settings.tips);
      saveSettings(settings);
      if (!settings.tips) {
        try { (ctx as any).ui?.setWidget?.(TIP_WIDGET, undefined); } catch { /* ignore */ }
      }
      (ctx as FooterCtx).ui?.notify?.(`tips ${settings.tips ? "on" : "off"}`, "info");
    },
  });

  // exposed for tests
  (pi as any).__footerDebug = { state, workingText, isInstalled: () => footerInstalled };
}
