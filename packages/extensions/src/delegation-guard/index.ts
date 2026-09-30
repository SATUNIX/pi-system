import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Self-containment rule: import only node:* builtins and the pi peer. No sibling-extension
// imports. See CONTRIBUTING.md.
//
// delegation-guard is the ONE place that decides how a child pi session is launched. Every
// launch path (the subagent tool and workflows, the completion reviewer, conductor specialists
// and validators) asks it for the child's extension arguments and environment instead of
// building them itself, so no path can forget a protection:
//
//   - the child loads the mandatory protections (tool-firewall, secret-guard, protected-paths)
//     and any task-specific governance the parent runs (pentest governance), every extension whose
//     manifest says `childGovernance: true` and that the PARENT actually has loaded;
//   - a protection that cannot be located, or an override that tries to drop one, refuses the
//     launch (fail closed, with the reason), never a silently weaker child;
//   - the launch reserves against the shared effort ledger (budgets bind at every depth) and the
//     child inherits its tier as a pin and a cap;
//   - inside the child this same extension checks, before any tool runs, that every required
//     protection registered itself; if one did not, the child blocks every tool call and exits
//     with EX_CONFIG so the parent sees a visible failure, not a quiet gap.
//
// The registry lives on globalThis so extensions stay self-contained.

export const DELEGATION_KEY = Symbol.for("pi-kit.delegation");
export const PROTECTIONS_KEY = Symbol.for("pi-kit.protections");
export const EFFORT_KEY = Symbol.for("pi-kit.effort");
const EX_CONFIG = 78;

/** The three protections every child needs whenever its parent has them. */
export const MANDATORY_PROTECTIONS = ["tool-firewall", "secret-guard", "protected-paths"] as const;
/** Kit extensions a child gets by default when the operator has them enabled (not governance). */
export const DEFAULT_COMPANIONS = ["finish-reason-retry", "todo"];

// --- what is registered in this process -------------------------------------------------------

type Protections = { has(name: string): boolean; list?(): string[]; add?(name: string): unknown };

function protections(): Protections | null {
  const value = (globalThis as Record<symbol, unknown>)[PROTECTIONS_KEY] as Protections | Set<string> | undefined;
  if (!value) return null;
  if (typeof (value as Protections).has === "function") return value as Protections;
  return null;
}

/** Register a protection name in the shared registry (creates it as a Set when absent). */
export function registerProtection(name: string): void {
  const g = globalThis as Record<symbol, unknown>;
  const existing = g[PROTECTIONS_KEY] as (Set<string> & Protections) | undefined;
  if (!existing) g[PROTECTIONS_KEY] = new Set<string>([name]);
  else if (typeof existing.add === "function") existing.add(name);
}

function loadedProtections(): string[] {
  const p = protections();
  if (!p) return [];
  if (typeof p.list === "function") return p.list();
  return [...((p as unknown) as Iterable<string>)];
}

// --- locating extensions and their manifests --------------------------------------------------

function extensionsRoot(): string {
  const override = process.env.PI_KIT_EXTENSIONS_ROOT?.trim();
  if (override) return override;
  // <root>/packages/extensions/src/delegation-guard/index.ts -> <root>/packages/extensions
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

export function kitExtensionPath(name: string): string | null {
  if (name.includes("/") || name.endsWith(".ts")) {
    const p = path.resolve(name);
    return fs.existsSync(p) ? p : null;
  }
  for (const avenue of ["src", "third_party"]) {
    const p = path.join(extensionsRoot(), avenue, name, "index.ts");
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Names of kit extensions whose manifest declares `childGovernance: true`. */
export function governanceExtensions(): string[] {
  const names: string[] = [];
  for (const avenue of ["src", "third_party"]) {
    const dir = path.join(extensionsRoot(), avenue);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith("_")) continue;
      if (readJson(path.join(dir, name, "extension.json"))?.childGovernance === true) names.push(name);
    }
  }
  return names.sort();
}

/** Kit extensions the operator enabled (global + project settings), or null when the kit entry is unfiltered / not found. */
export function enabledKitExtensions(cwd: string): Set<string> | null {
  let found: Set<string> | null = null;
  for (const file of [path.join(agentDir(), "settings.json"), path.join(cwd, ".pi", "settings.json")]) {
    const packages = Array.isArray(readJson(file)?.packages) ? ((readJson(file)?.packages as unknown[]) ?? []) : [];
    for (const pkg of packages) {
      if (!pkg || typeof pkg !== "object") continue;
      const entry = pkg as { source?: unknown; extensions?: unknown };
      if (typeof entry.source !== "string" || !Array.isArray(entry.extensions)) continue;
      const names = (entry.extensions as unknown[])
        .filter((e): e is string => typeof e === "string" && !e.startsWith("!"))
        .map((e) => e.match(/(?:src|third_party)\/([^/]+)\/index\.ts$/)?.[1])
        .filter((n): n is string => Boolean(n));
      if (names.length > 0) found = new Set(names);
    }
  }
  return found;
}

// --- the launch contract ----------------------------------------------------------------------

export type LaunchKind = "discretionary" | "recovery" | "mandatory";

export interface ChildRequest {
  /** The child's working directory (settings are read from here for project scope). */
  cwd: string;
  kind: LaunchKind;
  /** Agent name or purpose label, used for budgeting and messages. */
  role: string;
  scout?: boolean;
  readOnly?: boolean;
  requestedTier?: string;
  /** Extra kit extensions (names or absolute paths), e.g. from role frontmatter. They only add. */
  extraExtensions?: string[];
  /** The child may delegate further (its tool list names `subagent`). */
  needsSubagent?: boolean;
  /** Environment to derive the child's from (defaults to this process's). */
  baseEnv?: Record<string, string | undefined>;
  /**
   * "isolated" (default): the child loads exactly the guard's extension set (`--no-extensions`).
   * "ambient": the child keeps loading the operator's installed extensions (for launchers whose
   * children need tools those extensions provide, e.g. MCP servers in a pentest specialist); the
   * guard hands back no extension arguments, only the environment, and the child's own
   * delegation-guard then verifies that every required protection is loaded, failing closed when
   * one is not.
   */
  isolation?: "isolated" | "ambient";
}

export interface LaunchSlot {
  id: string | null;
  attach(pid: number | undefined): void;
  settle(outcome: string): void;
}

export type Prepared =
  | { ok: true; args: string[]; env: Record<string, string | undefined>; loaded: string[]; required: string[]; slot: LaunchSlot; childTier: string }
  | { ok: false; code: string; reason: string };

interface EffortRegistry {
  reserve(input: { kind: LaunchKind; role: string; scout?: boolean; readOnly?: boolean; requestedTier?: string }):
    | { ok: true; id: string | null; childTier: string; env: Record<string, string>; attach(pid: number | undefined): void; settle(outcome: string): void }
    | { ok: false; code: string; reason: string };
}

const refuse = (code: string, reason: string): Prepared => ({ ok: false, code, reason });

/**
 * Names the child must load: every governance extension (manifest `childGovernance: true`) that
 * the parent process actually registered, plus the mandatory protections the parent has. When
 * this process has no protections registry at all (nothing to inherit), only this guard itself.
 */
export function requiredForChild(): string[] {
  const parent = protections();
  const governance = governanceExtensions();
  const required = new Set<string>();
  for (const name of governance) if (parent?.has(name)) required.add(name);
  for (const name of MANDATORY_PROTECTIONS) if (parent?.has(name)) required.add(name);
  required.add("delegation-guard");
  required.add("effort");
  return [...required];
}

export function prepareChild(request: ChildRequest): Prepared {
  const effort = (globalThis as Record<symbol, unknown>)[EFFORT_KEY] as EffortRegistry | undefined;
  if (!effort) {
    if (request.kind !== "mandatory") return refuse("no-effort", "the effort extension is not loaded, so delegation cannot be budgeted. Add `effort` to the profile (it is in every shipped profile) or work directly.");
  }

  const required = requiredForChild();
  const ambient = request.isolation === "ambient";
  const paths = new Map<string, string>();
  const missing: string[] = [];
  for (const name of ambient ? [] : required) {
    const p = kitExtensionPath(name);
    if (p) paths.set(name, p);
    else missing.push(name);
  }
  if (missing.length) {
    return refuse("governance-missing", `cannot start a child: required protection${missing.length === 1 ? "" : "s"} ${missing.join(", ")} could not be located next to this extension (${extensionsRoot()}). A child is never started with weaker protection than its parent. Reinstall the kit.`);
  }

  // Optional additions never remove anything: defaults the operator enabled, an operator
  // override list (PI_KIT_SUBAGENT_EXTENSIONS), and what the role asks for.
  const env = { ...(request.baseEnv ?? process.env) } as Record<string, string | undefined>;
  const enabled = enabledKitExtensions(request.cwd);
  const overrideRaw = env.PI_KIT_SUBAGENT_EXTENSIONS;
  const base = overrideRaw !== undefined ? overrideRaw.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_COMPANIONS;
  const extras = new Set<string>();
  for (const name of base) if (overrideRaw !== undefined || !enabled || enabled.has(name)) extras.add(name);
  for (const name of request.extraExtensions ?? []) extras.add(name);
  if (request.needsSubagent) extras.add("subagent");
  const optional = new Map<string, string>();
  for (const name of ambient ? [] : extras) {
    if (paths.has(name)) continue;
    const p = kitExtensionPath(name);
    if (p) optional.set(name, p); // an unknown optional extension is skipped: it is not a protection
  }

  const reservation = effort
    ? effort.reserve({ kind: request.kind, role: request.role, scout: request.scout, readOnly: request.readOnly, requestedTier: request.requestedTier })
    : ({ ok: true as const, id: null, childTier: "standard", env: {}, attach() {}, settle() {} });
  if (!reservation.ok) return refuse(reservation.code, reservation.reason);

  // Order matters, as it does in a profile: this guard first (its blocking hook must run before
  // any other extension's), then the path/secret guards that may precede the firewall, then the
  // firewall, then the remaining governance, then optional companions.
  const front = ["delegation-guard", "protected-paths", "secret-guard", "tool-firewall"];
  const ordered: Array<[string, string]> = [
    ...front.filter((n) => paths.has(n)).map((n) => [n, paths.get(n)!] as [string, string]),
    ...[...paths].filter(([n]) => !front.includes(n)).sort(([a], [b]) => a.localeCompare(b)),
    ...optional,
  ];
  const args: string[] = [];
  if (!ambient) {
    args.push("--no-extensions");
    for (const [, p] of ordered) args.push("-e", p);
  }

  // The knobs that could weaken a child are not passed on; the child derives them again.
  delete env.PI_KIT_SUBAGENT_ISOLATE;
  env.PI_KIT_INTERNAL_CHILD = "1";
  env.PI_KIT_CHILD_REQUIRE = required.join(",");
  for (const [key, value] of Object.entries(reservation.env)) env[key] = value;

  return { ok: true, args, env, loaded: ordered.map(([n]) => n), required, slot: { id: reservation.id, attach: reservation.attach, settle: reservation.settle }, childTier: reservation.childTier };
}

export interface DelegationRegistry {
  version: 1;
  prepareChild(request: ChildRequest): Prepared;
  requiredForChild(): string[];
}

// --- child side -----------------------------------------------------------------------------

/** The required protection names this child process was told to have, from PI_KIT_CHILD_REQUIRE. */
export function childRequirements(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PI_KIT_CHILD_REQUIRE ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function missingProtections(required: string[]): string[] {
  const loaded = new Set(loadedProtections());
  return required.filter((name) => !loaded.has(name));
}

export default function (pi: ExtensionAPI) {
  registerProtection("delegation-guard");
  const registry: DelegationRegistry = { version: 1, prepareChild, requiredForChild };
  (globalThis as Record<symbol, unknown>)[DELEGATION_KEY] = registry;

  let blocked: string | null = null;

  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    (globalThis as Record<symbol, unknown>)[DELEGATION_KEY] = registry;
    const required = childRequirements();
    if (required.length === 0) return; // a root session
    const missing = missingProtections(required);
    if (missing.length === 0) return;
    blocked = `delegation-guard: this child session is missing required protection${missing.length === 1 ? "" : "s"} (${missing.join(", ")}) that its parent has. Every tool call is refused.`;
    process.stderr.write(`${blocked}\n`);
    if (ctx.hasUI) ctx.ui.notify(blocked, "error");
    // A child that cannot enforce the boundary must not run: exit visibly so the parent reports
    // a launch failure rather than treating an unprotected child as healthy.
    process.exitCode = EX_CONFIG;
    setTimeout(() => process.exit(EX_CONFIG), 50);
  });

  pi.on("tool_call", async () => {
    if (blocked) return { block: true, reason: blocked };
    return undefined;
  });

  pi.on("session_shutdown", async () => {
    if ((globalThis as Record<symbol, unknown>)[DELEGATION_KEY] === registry) delete (globalThis as Record<symbol, unknown>)[DELEGATION_KEY];
  });
}
