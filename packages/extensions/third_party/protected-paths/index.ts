import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import fs from "node:fs";

import os from "node:os";

// Protected paths depend on the firewall policy (the same `policy` tool-firewall reads):
//   coding  — secrets, key files and the agent-control/audit surfaces. `.git/`,
//             `node_modules/` and `.pi/agents/` are ordinary work there.
//   pentest — everything in coding plus repository internals, dependencies, agent
//             definitions and the engagement records.
// PI_KIT_PROTECTED_PATHS (semicolon-separated) can only ADD entries.
const CODING_PROTECTED = [
  ".env", "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
  ".pi/human-console/", ".pi/human-console-audit.jsonl",
  // Agent-control and audit surfaces. A write here can forge a verdict, silence the audit
  // trail, re-arm autonomous mode, or weaken the firewall for a later session.
  ".pi/auto-mode.json", ".pi/verdicts.json", ".pi/trace.jsonl",
  ".pi/tool-firewall-audit.jsonl", ".pi/ctx-contributions/",
  "packages/core/policies/",
  "packages/extensions/src/tool-firewall/default-policy.json",
];
const PENTEST_PROTECTED = [
  ...CODING_PROTECTED,
  ".git/", "node_modules/", ".pi/agents/", ".pi/pentest/", ".pi/engagement/",
];

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
}

function firewallConfigPath(): string {
  return process.env.PI_KIT_FIREWALL_CONFIG?.trim() || path.join(agentDir(), "pi-kit", "firewall.json");
}

// Self-contained mirror of tool-firewall's resolvePolicy: env, then firewall.json, then coding.
// An unreadable config falls back to coding, whose list still covers secrets and control files.
export function firewallPolicy(): "coding" | "pentest" {
  const env = process.env.PI_KIT_FIREWALL_PROFILE?.trim().toLowerCase();
  if (env === "pentest" || env === "coding") return env;
  try {
    const policy = JSON.parse(fs.readFileSync(firewallConfigPath(), "utf8"))?.policy;
    if (policy === "pentest") return "pentest";
  } catch {
    /* no config: coding */
  }
  return "coding";
}

// The firewall's own state lives outside the workspace; a write there would re-arm auto
// mode, plant learned approvals or erase session taints.
function firewallStatePaths(): string[] {
  const dir = path.join(agentDir(), "pi-kit");
  return [
    firewallConfigPath(),
    process.env.PI_KIT_FIREWALL_FEEDBACK?.trim() || path.join(dir, "firewall-feedback.jsonl"),
    // Remembered approvals: a planted entry here would let an action run without asking.
    process.env.PI_KIT_FIREWALL_APPROVALS?.trim() || path.join(dir, "firewall-approvals.json"),
    process.env.PI_KIT_FIREWALL_SESSIONS_DIR?.trim() || path.join(dir, "firewall-sessions"),
    // The tool I/O capture log (tool-capture): the agent must not rewrite its own record.
    process.env.PI_KIT_CAPTURE_DIR?.trim() || path.join(dir, "capture"),
  ].map(normalizeSlashes);
}

function getProtectedPaths(cwd: string): string[] {
  const defaults = firewallPolicy() === "pentest" ? PENTEST_PROTECTED : CODING_PROTECTED;
  const env = process.env.PI_KIT_PROTECTED_PATHS;
  // PI_KIT_PROTECTED_PATHS can only ADD to the defaults. It previously replaced them, so a
  // child handed a custom list silently lost .env and control-surface protection.
  const base = env ? [...defaults, ...env.split(";").map(p => p.trim()).filter(Boolean)] : defaults;
  const configuredConsole = process.env.PI_KIT_HUMAN_CONSOLE_DIR?.trim();
  const dynamic = configuredConsole ? [normalizeSlashes(path.resolve(cwd, normalizeSlashes(configuredConsole)))] : [];
  return [...base, ...firewallStatePaths(), ".pi/human-console/", ".pi/human-console-audit.jsonl", ...dynamic];
}

// Optional ALLOWLIST mode (Epic 6 Sprint 6.3, dream mode): when PI_KIT_WRITE_ALLOWLIST is
// set (semicolon-separated prefixes), any write/edit to a path NOT under an allowlisted
// prefix is blocked. This lets a scheduled "dream" pass touch only AGENTS.md / memory /
// GOAL.yaml and nothing else — protected-paths becomes the enforcement point.
function getWriteAllowlist(): string[] | null {
  const env = process.env.PI_KIT_WRITE_ALLOWLIST;
  if (!env) return null;
  const list = env.split(";").map(p => p.trim()).filter(Boolean);
  return list.length ? list : null;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

// H-01 fix: the previous implementation matched via `normalized.includes(entry)`, a raw
// substring test. That let "src/AGENTS.md.backdoor" satisfy an "AGENTS.md" allowlist
// entry, and ".pi/memory-escape/file.txt" satisfy a ".pi/memory" entry — neither is
// actually the allowlisted file/directory, they just happen to share a text prefix.
// Real path-boundary matching: a directory-style entry (contains "/") matches only the
// exact path or a genuine descendant (segment boundary, not string prefix); a bare
// filename entry matches only an exact basename, never a prefix/substring of a longer
// name.
function resolveEntry(entry: string, cwd: string): string {
  return canonicalPath(path.resolve(cwd, normalizeSlashes(entry).replace(/\/+$/, "")));
}

function canonicalPath(value: string): string {
  let result: string;
  try { result = fs.realpathSync(value); } catch {
    const parent = path.dirname(value);
    result = parent === value ? value : path.join(canonicalPath(parent), path.basename(value));
  }
  return process.platform === "win32" ? result.toLowerCase() : result;
}

function matchesDirectoryOrExactEntry(candidateAbs: string, entryAbs: string): boolean {
  return candidateAbs === entryAbs || candidateAbs.startsWith(entryAbs + path.sep);
}

function isAllowlisted(filePath: string, allowlist: string[], cwd: string): boolean {
  const candidateAbs = canonicalPath(path.resolve(cwd, normalizeSlashes(filePath)));
  return allowlist.some(entry => {
    const normalizedEntry = normalizeSlashes(entry).replace(/\/+$/, "");
    if (normalizedEntry.includes("/")) {
      return matchesDirectoryOrExactEntry(candidateAbs, resolveEntry(entry, cwd));
    }
    // Bare filename: exact basename match only — never a prefix/substring (this is
    // exactly what let "AGENTS.md.backdoor" satisfy an "AGENTS.md" entry).
    return candidateAbs === resolveEntry(entry, cwd);
  });
}

// Denylist can stay slightly broader than the allowlist (over-blocking here is safe,
// fail-closed; it's the allowlist where over-matching is the security defect), but must
// still respect real path segment boundaries rather than matching anywhere in the string.
function isProtected(filePath: string, protectedList: string[], cwd: string): boolean {
  // Same canonical (realpath, win32-lowercased) form as resolveEntry, or directory
  // entries never match on Windows and symlinks escape the denylist.
  const candidateAbs = canonicalPath(path.resolve(cwd, normalizeSlashes(filePath)));
  const segments = normalizeSlashes(candidateAbs).split("/").filter(Boolean);
  const base = segments[segments.length - 1] ?? "";
  // `.env` protection covers secret files; checked-in templates (.env.example / .env.sample)
  // are non-secret and exempt. Real `.env` and `.env.<other>` still match below.
  if (base === ".env.example" || base === ".env.sample") return false;
  return protectedList.some(entry => {
    const slashed = normalizeSlashes(entry).replace(/\/+$/, "");
    const normalizedEntry = process.platform === "win32" ? slashed.toLowerCase() : slashed;
    if (normalizedEntry.includes("/")) {
      return matchesDirectoryOrExactEntry(candidateAbs, resolveEntry(entry, cwd));
    }
    return segments.includes(normalizedEntry) || base === normalizedEntry || base.startsWith(`${normalizedEntry}.`);
  });
}

// H-01 fix, second bypass: this extension only inspected `write`/`edit` tool input,
// so a `bash` redirect/copy to the exact same disallowed path was invisible to it. Pull
// candidate write targets out of a shell command the same content-aware way tool-firewall
// and secret-guard already do for their own threat classes. Deliberately narrow (a known
// set of write primitives, not a full shell parser), but the set covers the common ways
// a shell rewrites a file — a single missed primitive is a full bypass of this gate.
// Over-extraction is safe: every candidate is still checked against the real path
// boundary in `isProtected`/`isAllowlisted`, and these patterns only fire on commands
// that write, so plain reads are never matched.
function bashWriteTargets(command: string): string[] {
  const targets: string[] = [];
  const stripQuotes = (t: string) => t.replace(/^["']|["']$/g, "");
  const push = (value: string | undefined) => {
    const stripped = value ? stripQuotes(value) : "";
    if (stripped) targets.push(stripped);
  };
  // Output redirection and `tee`.
  for (const m of command.matchAll(/>{1,2}\s*([^\s|;&<>]+)/g)) push(m[1]);
  for (const m of command.matchAll(/\btee\b(?:\s+-a)?\s+([^\s|;&]+)/g)) push(m[1]);
  // cp/mv: last argument is the destination that gets created/overwritten.
  for (const m of command.matchAll(/\b(?:cp|mv)\b(?:\s+-\S+)*\s+\S+\s+([^\s|;&]+)/g)) push(m[1]);
  // `dd of=<file>` (the output operand).
  for (const m of command.matchAll(/\bdd\b[^\n|;&]*?\bof=([^\s|;&]+)/g)) push(m[1]);
  // `sed -i`/`perl -i` rewrite every file operand in place. Scan all operands after the
  // flag (skipping flags and the inline s/…/…/ program) so a protected operand is caught
  // wherever it sits in the argument list, not only when it happens to be last.
  for (const m of command.matchAll(/\b(?:sed|perl)\b[^\n|;&]*?\s-i\S*([^\n|;&]*)/g)) {
    for (const rawToken of m[1].split(/\s+/)) {
      const stripped = stripQuotes(rawToken);
      if (!stripped || stripped.startsWith("-") || looksLikeInlineProgram(rawToken, stripped)) continue;
      push(stripped);
    }
  }
  // install/ln: last argument is the created destination.
  for (const m of command.matchAll(/\b(?:install|ln)\b[^\n|;&]*\s+([^\s|;&]+)\s*(?:[|;&]|$)/g)) push(m[1]);
  // curl -o <file> / wget -O <file>.
  for (const m of command.matchAll(/\bcurl\b[^\n|;&]*?\s-o\s*([^\s|;&]+)/g)) push(m[1]);
  for (const m of command.matchAll(/\bwget\b[^\n|;&]*?\s-O\s*([^\s|;&]+)/g)) push(m[1]);
  // sponge <file> soaks stdin and writes it to the named file.
  for (const m of command.matchAll(/\bsponge\b(?:\s+-\S+)*\s+([^\s|;&]+)/g)) push(m[1]);
  // `python -c "open('file','w')..."` (w/a/x and binary/plus variants).
  for (const m of command.matchAll(/\bopen\s*\(\s*["']([^"']+)["']\s*,\s*["'][wax][bt+]*["']/g)) push(m[1]);
  return targets.filter(Boolean);
}

// sed/perl inline programs (`s/…/…/`, `y/…/…/`, a quoted one-liner) are code, not file
// operands. Only used to filter tokens following a `-i` flag.
function looksLikeInlineProgram(rawToken: string, stripped: string): boolean {
  if (/^[sy][/|#]/.test(stripped)) return true;
  if (/^["']/.test(rawToken) && !stripped.includes("/") && !/\.[A-Za-z0-9]{1,8}$/.test(stripped)) return true;
  return false;
}

// Protections registry (shared, in-process; see tool-firewall/README.md). Each mandatory protection
// (tool-firewall, secret-guard, protected-paths) records its name here when its factory has
// installed its hooks, so a trusted launcher can check that a session loaded what it must have
// loaded. Extensions are self-contained, so every one carries this same small helper: whichever
// loads first creates the registry, the others add to it. It is a consistency check, not a
// boundary against code running in the same process.
const PROTECTIONS_KEY = Symbol.for("pi-kit.protections");
function registerProtection(name: string): void {
  try {
    const g = globalThis as unknown as Record<symbol, any>;
    let reg = g[PROTECTIONS_KEY];
    if (!reg || typeof reg.add !== "function" || typeof reg.has !== "function") {
      reg = new (class ProtectionRegistry extends Set<string> {})();
      g[PROTECTIONS_KEY] = reg;
    }
    reg.add(name);
    if (typeof reg.list !== "function") Object.defineProperty(reg, "list", { value: () => [...reg].map(String).sort(), enumerable: false, configurable: true });
  } catch {
    /* the registry must never break the protection itself */
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const toolName = event.toolName;
    const input = event.input as Record<string, unknown>;
    const cwd = ctx.cwd || process.cwd();

    let candidatePaths: string[] = [];
    if (toolName === "write" || toolName === "edit") {
      const filePath = input.path as string | undefined;
      if (filePath) candidatePaths = [filePath];
    } else if (toolName === "bash") {
      const command = (input.command as string | undefined) ?? (input.cmd as string | undefined) ?? (input.script as string | undefined);
      if (command) candidatePaths = bashWriteTargets(command);
    }
    if (candidatePaths.length === 0) return undefined;

    const protectedList = getProtectedPaths(cwd);
    const allowlist = getWriteAllowlist();
    for (const filePath of candidatePaths) {
      // Denylist always applies.
      if (isProtected(filePath, protectedList, cwd)) {
        const msg = `protected-paths: blocked ${toolName} to protected path: ${filePath}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        return { block: true, reason: msg };
      }
      // Allowlist mode (dream/print-mode): block anything not explicitly allowlisted.
      if (allowlist && !isAllowlisted(filePath, allowlist, cwd)) {
        const msg = `protected-paths: allowlist mode — blocked ${toolName} to non-allowlisted path: ${filePath}`;
        if (ctx.hasUI) ctx.ui.notify(msg, "warning");
        return { block: true, reason: msg };
      }
    }

    return undefined;
  });
  // Only once the hook is installed: a factory that failed earlier never registers.
  registerProtection("protected-paths");
}
