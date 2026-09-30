// tool-firewall: the autonomy gate in front of every tool call.
//
// Each call is parsed into what it would actually do (shell.ts, classify.ts), placed in a tier
// (low / medium / high / critical) with reasons, checked against the session's history
// (trajectory.ts), and decided by the matrix below. Human decisions become calibrated
// precedents (feedback.ts); in auto mode a small model judges medium actions (judge.ts).
//
//   tier      manual      auto (coding)                           strict (pentest policy)
//   low       allow       allow                                   allow
//   medium    ask         judge: allow, or block + tell the agent ask
//   high      ask         exact repeat of a grant / learned exact       ask, no grants (deny headless)
//                         action; else the judge when you allowed
//                         similar (grant or approved families); a judge
//                         block asks you with how it differs
//   critical  deny        deny                                    deny
//
// Headless (subagents, print mode) asks go to the human-console broker and fail closed.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyToolCall, describeFamilies, effectiveTier, familiesFromSignature, maxTier, signatureOf, summarize, type Assessment, type ClassifyEnv, type Finding, type Tier } from "./classify.ts";
import { agentDir, configPath, feedbackPath, homeDir, knownHostsMeta, legacyAutoModePath, readConfig, resolveMode, resolvePolicy, tmpRoots, workspaceRoot, writeConfig, type FirewallConfig } from "./config.ts";
import { appendFeedback, exactStatus, forget, learnable, listLearned, operatorApproved, precedentsFor, redact, scopeRecords, readFeedback, statusFor, type FeedbackRecord } from "./feedback.ts";
import { appendJudgement, computeStats, distillInBackground, profileFor, readProfile, resetProfile, statsLine, distill } from "./profile.ts";
import { isUncertainBlock, runJudge, type Completer, type Verdict } from "./judge.ts";
import { loadSession, recordAction, rootSessionId, saveSession, trajectoryFindings, type SessionGrant, type SessionState } from "./trajectory.ts";
import { addApproval, approvalsPath, describeScope, findExact, floorFor, readApprovals, reportProblems, revokeApprovals, sessionApprovals, similarApprovals, LEARNED_APPROVAL_TTL_MS, SESSION_APPROVAL_TTL_MS, type Approval, type ApprovalsView } from "./approvals.ts";
import { createUnattended, unattendedDenial, type ProvenanceIo, type UnattendedState } from "./unattended.ts";
import { buildCard, buildDetail, CARD_MAX_LINES, CHOICE_ALLOW_ONCE, CHOICE_DENY_TELL, choicesFor, isSessionChoice } from "./card.ts";

type Decision = "allow" | "ask" | "deny";

type ToolRule = { decision?: Decision; risk_class?: string };

type CommandRule = { pattern: string; flags?: string; risk_class?: string; reason?: string; re?: RegExp };

type RuleSet = { deny: CommandRule[]; ask: CommandRule[] };

type FirewallPolicy = {
  defaults: { unknown: Decision };
  tools: Record<string, ToolRule>;
  // Operator rules: matched in every policy, against the raw command and each parsed step.
  command_rules: RuleSet;
  // Extra rules for the strict pentest policy, matched against the raw command text.
  pentest: RuleSet;
};

export type FirewallDeps = {
  // Model call for the auto-mode judge (tests inject a stub).
  complete?: Completer | null;
};

// Fail-closed fallback used ONLY if the shipped policy file cannot be read: unknown tools are
// denied rather than waved through.
const BUILTIN_FALLBACK: FirewallPolicy = {
  defaults: { unknown: "deny" },
  tools: {
    read: { decision: "allow", risk_class: "read_only" },
    grep: { decision: "allow", risk_class: "read_only" },
    glob: { decision: "allow", risk_class: "read_only" },
    ls: { decision: "allow", risk_class: "read_only" },
    find: { decision: "allow", risk_class: "read_only" },
  },
  command_rules: { deny: [], ask: [] },
  pentest: { deny: [], ask: [] },
};

let cachedPolicy: FirewallPolicy = BUILTIN_FALLBACK;
let cachedPolicyPath: string | null = null;
let cachedPolicyMtime = 0;
let cachedPolicyLabel = "builtin-fallback";
let lastPolicyWarnings: string[] = [];

function workspacePath(...parts: string[]): string {
  return path.join(process.cwd(), ...parts);
}

// The shipped starter policy lives inside the extension so it travels into every generated
// surface and installed profile.
function embeddedPolicyCandidates(): string[] {
  const candidates: string[] = [];
  try {
    candidates.push(fileURLToPath(new URL("./default-policy.json", import.meta.url)));
  } catch {
    /* import.meta.url unavailable */
  }
  candidates.push(workspacePath("extensions", "tool-firewall", "default-policy.json"));
  candidates.push(workspacePath("kit", "policies", "default.json"));
  return candidates;
}

function policyPath(): string | null {
  const configured = process.env.PI_KIT_FIREWALL_POLICY?.trim();
  if (configured) return configured;
  for (const candidate of embeddedPolicyCandidates()) if (fs.existsSync(candidate)) return candidate;
  return null;
}

function auditPath(): string {
  return process.env.PI_KIT_FIREWALL_AUDIT_LOG || workspacePath(".pi", "tool-firewall-audit.jsonl");
}

function normalizeDecision(value: unknown): Decision | null {
  return value === "allow" || value === "ask" || value === "deny" ? value : null;
}

// An invalid custom rule is reported loudly instead of silently never compiling (a false sense
// of security).
function compileCommandRules(rules: unknown, listLabel: string): CommandRule[] {
  if (rules === undefined) return [];
  if (!Array.isArray(rules)) {
    lastPolicyWarnings.push(`${listLabel} is not an array — ignored`);
    return [];
  }
  const out: CommandRule[] = [];
  rules.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") {
      lastPolicyWarnings.push(`${listLabel}[${index}] is not an object — skipped`);
      return;
    }
    const rule = raw as CommandRule;
    if (typeof rule.pattern !== "string") {
      lastPolicyWarnings.push(`${listLabel}[${index}] has no string "pattern" — skipped`);
      return;
    }
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, typeof rule.flags === "string" ? rule.flags : "");
    } catch (error) {
      lastPolicyWarnings.push(`${listLabel}[${index}] pattern is invalid regex (${String((error as Error)?.message ?? error)}) — skipped: ${rule.pattern}`);
      return;
    }
    out.push({ pattern: rule.pattern, flags: rule.flags, risk_class: typeof rule.risk_class === "string" ? rule.risk_class : "unknown", reason: typeof rule.reason === "string" ? rule.reason : rule.pattern, re });
  });
  return out;
}

function normalizePolicy(value: unknown): FirewallPolicy {
  if (!value || typeof value !== "object") return BUILTIN_FALLBACK;
  const raw = value as any;
  const tools: Record<string, ToolRule> = {};
  for (const [name, rule] of Object.entries<any>(raw.tools || {})) {
    const decision = normalizeDecision(rule?.decision);
    if (!decision) continue;
    tools[name] = { decision, risk_class: typeof rule.risk_class === "string" ? rule.risk_class : "unknown" };
  }
  return {
    defaults: { unknown: normalizeDecision(raw.defaults?.unknown) || "ask" },
    tools,
    command_rules: { deny: compileCommandRules(raw.command_rules?.deny, "command_rules.deny"), ask: compileCommandRules(raw.command_rules?.ask, "command_rules.ask") },
    pentest: { deny: compileCommandRules(raw.policies?.pentest?.command_rules?.deny, "policies.pentest.command_rules.deny"), ask: compileCommandRules(raw.policies?.pentest?.command_rules?.ask, "policies.pentest.command_rules.ask") },
  };
}

function statMtime(filePath: string | null): number {
  if (!filePath) return 0;
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

function reloadPolicy(): void {
  lastPolicyWarnings = [];
  const nextPath = policyPath();
  cachedPolicyPath = nextPath;
  let policy = BUILTIN_FALLBACK;
  if (nextPath && fs.existsSync(nextPath)) {
    try {
      policy = normalizePolicy(JSON.parse(fs.readFileSync(nextPath, "utf8")));
    } catch {
      policy = BUILTIN_FALLBACK;
    }
  }
  cachedPolicy = policy;
  cachedPolicyMtime = statMtime(nextPath);
  cachedPolicyLabel = cachedPolicy === BUILTIN_FALLBACK ? "builtin-fallback (deny unknown)" : nextPath || "builtin-fallback";
}

function getPolicy(): FirewallPolicy {
  const nextPath = policyPath();
  if (nextPath !== cachedPolicyPath || statMtime(nextPath) !== cachedPolicyMtime) reloadPolicy();
  return cachedPolicy;
}

function ruleCount(policy: FirewallPolicy): number {
  return Object.keys(policy.tools).length + policy.command_rules.deny.length + policy.command_rules.ask.length + policy.pentest.deny.length + policy.pentest.ask.length;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([l], [r]) => l.localeCompare(r)).map(([k, v]) => [k, sortJson(v)]));
}

// Deep-freezes approved tool arguments. A later mutation then throws (extensions are ES
// modules, so strict mode) and pi turns the throw into a blocked call: fail closed.
// Byte arrays cannot be frozen and are left as they are.
function seal(value: unknown, seen = new WeakSet<object>()): void {
  if (!value || typeof value !== "object" || ArrayBuffer.isView(value) || value instanceof ArrayBuffer || seen.has(value)) return;
  seen.add(value);
  for (const k of Object.keys(value)) {
    try {
      seal((value as Record<string, unknown>)[k], seen);
    } catch {
      /* getter threw */
    }
  }
  try {
    Object.freeze(value);
  } catch {
    /* exotic object */
  }
}

function actionHash(toolName: string, input: unknown): string {
  return crypto.createHash("sha256").update(stableJson({ toolName, input })).digest("hex");
}

function audit(record: Record<string, unknown>): void {
  try {
    const filePath = auditPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`);
  } catch {
    /* the audit log must never break a tool call */
  }
}

function toolNameFrom(event: any): string {
  return String(event?.toolName || event?.name || "unknown");
}

function commandTextFrom(input: any): string | null {
  const command = input?.command ?? input?.cmd ?? input?.script;
  return typeof command === "string" ? command : null;
}

// Collapse quote/backslash fragmentation before regex rules (`r''m`, `r\m`).
function deobfuscateShellText(command: string): string {
  return command.replace(/'{2,}|"{2,}/g, "").replace(/\\(?=[A-Za-z])/g, "");
}

function regexFindings(policy: FirewallPolicy, policyName: string, a: Assessment): Finding[] {
  const command = a.command;
  if (command === undefined) return [];
  const out: Finding[] = [];
  const texts = new Set([command, deobfuscateShellText(command), ...a.segments.map((s) => s.text)]);
  const sets: { rules: RuleSet; label: string }[] = [{ rules: policy.command_rules, label: "policy rule" }];
  if (policyName === "pentest") sets.push({ rules: policy.pentest, label: "pentest rule" });
  for (const { rules, label } of sets) {
    for (const rule of rules.deny) if ([...texts].some((t) => rule.re?.test(t))) out.push({ tier: "critical", effect: "security_control", code: "policy_deny_rule", detail: `${label}: ${rule.reason}`, key: `rule ${rule.pattern}` });
    for (const rule of rules.ask) if ([...texts].some((t) => rule.re?.test(t))) out.push({ tier: "high", effect: "unknown_exec", code: "policy_ask_rule", detail: `${label}: ${rule.reason}`, key: `rule ${rule.pattern}` });
  }
  return out;
}

function humanConsoleRoot(): string {
  return process.env.PI_KIT_HUMAN_CONSOLE_DIR?.trim() || workspacePath(".pi", "human-console");
}

// `unavailable` is set when the request could not even be filed (the console directory cannot be
// created or written): the outcome is UNCERTAIN, never "the operator declined".
type BrokerResult = { approved: boolean; timedOut: boolean; aborted?: boolean; unavailable?: string; timeoutMs?: number; choice?: string; note?: string };

// Headless requests go to the human console. `choices` lets a console that supports them offer
// the same menu as the interactive card (allow once / allow for the session / deny / deny and
// tell); an older console answers yes/no, which is treated as allow once / deny. The wait is always
// bounded: by PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS (default 15 minutes; subagents get a shorter one from
// their launcher) and by the turn's abort signal, so nothing waits on a console that is not there.
function brokerApproval(toolName: string, input: unknown, tier: Tier, reason: string, body: string, note: string | null, ctx: any, signal?: AbortSignal, choices?: string[]): Promise<BrokerResult> {
  const root = humanConsoleRoot();
  const pending = path.join(root, "pending");
  const resolved = path.join(root, "resolved");
  const id = crypto.randomUUID();
  const timeoutMs = Math.max(1, Number(process.env.PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS) || 900000);
  try {
    fs.mkdirSync(pending, { recursive: true });
    fs.mkdirSync(resolved, { recursive: true });
    fs.writeFileSync(
      path.join(pending, `${id}.json`),
      JSON.stringify({ id, kind: "approval", createdAt: new Date().toISOString(), requester: { pid: process.pid, sessionId: sessionIdOf(ctx), agent: ctx?.agent?.name || ctx?.agentName || "root" }, toolName, input, riskClass: tier, reason, title: `Approve tool call? (${ctx?.agent?.name || ctx?.agentName || (process.env.PI_KIT_INTERNAL_CHILD ? "subagent" : "headless session")})`, body, choices, autoModeRationale: note, timeoutMs }),
    );
  } catch (error) {
    return Promise.resolve({ approved: false, timedOut: false, unavailable: `could not file the request in the human console at ${root} (${String((error as Error)?.message ?? error)})`, timeoutMs });
  }
  audit({ event: "human_console_pending", toolName, id });
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setInterval>;
    const finish = (result: BrokerResult) => {
      clearInterval(timer);
      try {
        fs.unlinkSync(path.join(pending, `${id}.json`));
      } catch {
        /* already gone */
      }
      try {
        fs.unlinkSync(path.join(resolved, `${id}.json`));
      } catch {
        /* already gone */
      }
      resolve({ timeoutMs, ...result });
    };
    timer = setInterval(() => {
      try {
        const value = JSON.parse(fs.readFileSync(path.join(resolved, `${id}.json`), "utf8"));
        const choice = typeof value?.answer === "string" && choices?.includes(value.answer) ? value.answer : undefined;
        const note = typeof value?.note === "string" && value.note.trim() ? value.note.trim().slice(0, 500) : undefined;
        // Audit is best-effort (it swallows its own errors) and MUST never throw; finish()
        // is called regardless and MUST stay unconditional so the promise always settles.
        audit({ event: "human_console_resolved", toolName, id, approved: value?.approved === true, choice });
        finish({ approved: value?.approved === true, timedOut: false, choice, note });
        return;
      } catch {
        /* waiting */
      }
      if (signal?.aborted || Date.now() >= deadline) {
        // Invariant: audit() is non-throwing and best-effort; finish() must remain
        // unconditional (it is deliberately outside any try block) so the broker promise
        // always settles. The ordering here is not what makes this safe.
        audit({ event: "human_console_timeout", toolName, id, aborted: signal?.aborted || undefined });
        finish({ approved: false, timedOut: true, aborted: signal?.aborted || undefined });
      }
    }, Math.min(1000, timeoutMs));
    timer.unref?.();
  });
}

// An interactive prompt (card, confirm, note) is bounded too: pi's dialog options carry a timeout and
// an abort signal, and this wrapper also enforces both when a UI implementation ignores them (an
// RPC client that never answers, a UI that was closed), so a tool call never waits on a dialog that
// nobody can answer. PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS overrides the 15-minute default.
export function promptTimeoutMs(): number {
  const n = Number(process.env.PI_KIT_FIREWALL_PROMPT_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 900000;
}

type Prompted<T> = { kind: "answered"; value: T } | { kind: "timeout" } | { kind: "aborted" } | { kind: "error"; message: string };

function boundedPrompt<T>(ctx: any, run: (opts: { signal?: AbortSignal; timeout: number }) => Promise<T> | T): Promise<Prompted<T>> {
  const timeout = promptTimeoutMs();
  const signal: AbortSignal | undefined = ctx?.signal;
  return new Promise((resolve) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (r: Prompted<T>) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(r);
    };
    const onAbort = () => finish({ kind: "aborted" });
    if (signal?.aborted) return finish({ kind: "aborted" });
    timer = setTimeout(() => finish({ kind: "timeout" }), timeout);
    timer.unref?.();
    signal?.addEventListener?.("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => run({ signal, timeout }))
      .then((value) => finish({ kind: "answered", value }), (error) => finish({ kind: "error", message: String((error as Error)?.message ?? error) }));
  });
}

// What the operator, the agent and the audit log see for each way an action can end. Exactly one of
// these applies to every refusal, so the three situations are never confused:
//   HARD DENY         policy says never; no approval and no judge can override it.
//   UNCERTAIN         the automatic layers could not settle it (judge unsure, unavailable or timed out;
//                     an opaque command) or nobody could be asked. With an operator reachable it is
//                     escalated; without one it fails closed, bounded, with a message the agent can relay.
//   OPERATOR DECISION a human allowed or denied it; remembered only within the scope the card named.
// (A high-confidence block by the auto-mode judge is its own labelled case: final, with the reason.)
export type Outcome = "hard_deny" | "uncertain" | "operator_decision" | "judge_block";
const TAG: Record<Outcome, string> = { hard_deny: "HARD DENY", uncertain: "UNCERTAIN", operator_decision: "OPERATOR DECISION", judge_block: "AUTO-MODE BLOCK" };

function sessionIdOf(ctx: any): string {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id) return id;
  } catch {
    /* optional */
  }
  return ctx?.sessionId || `pid-${process.pid}`;
}

function textOf(value: any): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textOf).join("\n");
  if (value && typeof value === "object") return textOf(value.text ?? value.content ?? "");
  return "";
}

// The latest user request (not the session's first message).
// goal-core's session goal, if any: the judge weighs scope against it as well as the request.
function readGoal(cwd: string, workspace: string): string | undefined {
  for (const dir of new Set([cwd, workspace])) {
    try {
      const text = fs.readFileSync(path.join(dir, ".pi", "GOAL.yaml"), "utf8").trim();
      if (text) return text.slice(0, 2000);
    } catch {
      /* no goal here */
    }
  }
  return undefined;
}

function latestRequest(ctx: any, fallback: string): string {
  if (fallback) return fallback;
  try {
    const entries: any[] = ctx?.sessionManager?.getEntries?.() || [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const m = entries[i]?.message ?? entries[i];
      if (m?.role === "user") return textOf(m.content ?? m);
    }
  } catch {
    /* optional */
  }
  return "";
}

function judgeModelName(ctx: any, cfg: FirewallConfig): string | undefined {
  return process.env.PI_KIT_AUTO_MODE_MODEL?.trim() || cfg.judgeModel || (ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
}

// Default judge completer: the configured judge model, else the session model.
function modelCompleter(ctx: any, cfg: FirewallConfig): Completer | null {
  const registry = ctx?.modelRegistry;
  if (!registry) return null;
  let model = ctx.model;
  const wanted = process.env.PI_KIT_AUTO_MODE_MODEL?.trim() || cfg.judgeModel;
  if (wanted) {
    const slash = wanted.indexOf("/");
    const found = slash > 0 ? registry.find?.(wanted.slice(0, slash), wanted.slice(slash + 1)) : undefined;
    if (found) model = found;
  }
  if (!model) return null;
  const chosen = model;
  return async (system, prompt, signal) => {
    const auth = await registry.getApiKeyAndHeaders(chosen);
    if (!auth?.ok) throw new Error(`no request auth for ${chosen.provider}`);
    const headers = auth.headers ? Object.fromEntries(Object.entries(auth.headers).filter((e): e is [string, string] => typeof e[1] === "string")) : undefined;
    const reply = await completeSimple(chosen, { systemPrompt: system, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }] }, { apiKey: auth.apiKey, headers, signal, maxTokens: 300 });
    return reply.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
  };
}

const JUDGE_SAFE_STRICT = new Set(["read", "network_read"]);

// Protections registry (shared, in-process). Each mandatory protection (tool-firewall,
// secret-guard, protected-paths) records its name in globalThis[Symbol.for("pi-kit.protections")]
// once its factory has installed its hooks: a Set of names with `has(name)` and `list()` (sorted),
// so a trusted launcher can check that a session loaded what it must have loaded. Extensions are
// self-contained, so each carries this same small helper; whichever loads first creates the
// registry. It is a consistency check, not a boundary against code running in the same process.
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

export default function toolFirewall(pi: ExtensionAPI, deps: FirewallDeps | ((...args: any[]) => any) = {}) {
  const d: FirewallDeps = typeof deps === "function" ? {} : deps;
  let session: SessionState | null = null;
  let lastRequest = "";
  let lastDetail = "";
  let queue: Promise<unknown> = Promise.resolve();
  // Unattended mode is decided once, here, from the environment the supervisor built and the read-only
  // contract it names: nothing that happens later (a config file, /auto, a tool call, a changed variable)
  // can switch it on, and a changed contract switches it off (unattended.ts).
  // The provenance facts (mount table, owner) come from the OS; tests present their own through a global
  // that only code inside this process can set (a variable in the environment could be set by an agent).
  const provenanceIo = (globalThis as unknown as Record<symbol, ProvenanceIo | undefined>)[Symbol.for("pi-kit.test.unattended-provenance")];
  const unattended = createUnattended({ workspace: workspaceRoot(process.cwd()), cwd: process.cwd(), agentDir: agentDir(), policy: resolvePolicy(readConfig()).policy, io: provenanceIo });
  {
    const st = unattended.state();
    try {
      if (st.requested && !st.active) process.stderr.write(`tool-firewall: WARNING — unattended mode was requested (PI_KIT_UNATTENDED) but is NOT active: ${st.warnings[0]}. Failing closed: the normal interactive/headless approval rules apply, so anything above the routine tier needs an operator.\n`);
      else if (st.active) process.stderr.write(`tool-firewall: UNATTENDED mode (${st.boundary} boundary, contract sha256:${st.digest?.slice(0, 12)}${st.autoApprove ? ", auto-approve" : ", no auto-approve"}): no prompts and no judge inside the zone; hard denies and anything outside the zone fail closed.\n`);
    } catch {
      /* stderr unavailable */
    }
  }

  const sessionFor = (ctx: any): SessionState => {
    const id = sessionIdOf(ctx);
    if (!session || session.id !== id) session = loadSession(id);
    return session;
  };

  // ~/.ssh/config is writable by the agent (with an approval), so hosts it names are trusted only while
  // it is unchanged since the session started; a change means the firewall trusts firewall.json's hosts
  // alone until the operator runs /firewall reload.
  let sshBaseline: number | null = null;
  let sshWarned = false;
  let lastProblemKey = "";

  // Output is never silent: an interactive UI shows a notice; a headless session (print mode, a
  // subagent) has a no-op UI, so the text goes to stderr instead.
  const say = (ctx: any, text: string, level: "info" | "warning" | "error" = "info"): void => {
    try {
      if (ctx?.hasUI !== false && typeof ctx?.ui?.notify === "function") {
        ctx.ui.notify(text, level);
        return;
      }
    } catch {
      /* fall through to stderr */
    }
    try {
      process.stderr.write(`${text}\n`);
    } catch {
      /* stderr unavailable */
    }
  };

  // Malformed approval entries are ignored (never an allow); this makes sure someone is told: stderr
  // once per distinct set, the audit log, and a warning in an interactive session.
  const noteApprovalProblems = (view: ApprovalsView, ctx?: any): string[] => {
    const problems = reportProblems(view);
    const key = problems.join("|");
    if (key !== lastProblemKey) {
      lastProblemKey = key;
      if (problems.length) {
        audit({ event: "approvals_malformed", file: view.file, problems: problems.slice(0, 20) });
        try {
          if (ctx?.hasUI !== false) ctx?.ui?.notify?.(`tool-firewall: WARNING — ${problems.length} malformed item(s) in ${view.file} were ignored (never treated as an allow): ${problems.slice(0, 3).join("; ")}`, "warning");
        } catch {
          /* notification is best effort */
        }
      }
    }
    return problems;
  };

  const trustedHosts = (cfg: FirewallConfig, ctx?: any): Set<string> => {
    const kh = knownHostsMeta(cfg);
    if (sshBaseline === null) sshBaseline = kh.sshMtime;
    if (kh.sshMtime <= sshBaseline) return kh.hosts;
    if (!sshWarned) {
      sshWarned = true;
      audit({ event: "ssh_config_changed", note: "hosts named only in ~/.ssh/config are not trusted until /firewall reload" });
      say(ctx, "tool-firewall: ~/.ssh/config changed during this session, so hosts it names are not trusted for read-only ssh until you run /firewall reload (hosts in firewall.json still are)", "warning");
    }
    return new Set([...kh.fromConfig].filter((h) => !kh.untrusted.has(h)));
  };

  // The judge's view of a stored session approval.
  const toGrant = (a: Approval): SessionGrant => ({ at: Date.parse(a.createdAt), session: a.grantedBy.session, tool: a.tool, hash: a.hash, tier: a.tier, command: a.action.command, steps: a.action.steps, reasons: a.action.reasons, chain: a.action.chain, families: a.families, scopes: a.scopes });

  pi.on("session_start", async (_event: unknown, ctx: any) => {
    try {
      reloadPolicy();
      const policy = getPolicy();
      const cfg = readConfig();
      const mode = resolveMode(ctx?.cwd || process.cwd(), cfg).mode;
      const pol = resolvePolicy(cfg).policy;
      session = null;
      lastRequest = "";
      lastDetail = "";
      sshBaseline = knownHostsMeta(cfg).sshMtime;
      sshWarned = false;
      // Export the root session before any subagent is spawned, so children share its approvals.
      rootSessionId(sessionIdOf(ctx));
      ctx.ui?.notify?.(`tool-firewall: loaded (${cachedPolicyLabel}, default unknown=${policy.defaults.unknown}, rules=${ruleCount(policy)}, mode=${mode}, policy=${pol})`, "info");
      if (lastPolicyWarnings.length > 0) {
        audit({ event: "policy_rule_warnings", warnings: lastPolicyWarnings });
        ctx.ui?.notify?.(`tool-firewall: WARNING — ${lastPolicyWarnings.length} custom rule(s) in the policy were skipped (not enforced): ${lastPolicyWarnings.join("; ")}`, "warning");
      }
      noteApprovalProblems(readApprovals(), ctx);
      unattended.current(pol, { cwd: ctx?.cwd || process.cwd(), workspace: workspaceRoot(ctx?.cwd || process.cwd()) }); // a contract inside this workspace turns it off
      const st = unattended.state();
      if (st.requested && !st.active) ctx.ui?.notify?.(`tool-firewall: WARNING — unattended mode was requested but is NOT active (${st.warnings[0]}). Failing closed: normal approval rules apply.`, "warning");
      else if (st.active) ctx.ui?.notify?.(`tool-firewall: ${st.label} — contract sha256:${st.digest?.slice(0, 12)}; no prompts, no judge; hard denies and outside-the-zone actions fail closed`, "warning");
      unattended.publish();
    } catch (error) {
      cachedPolicy = BUILTIN_FALLBACK;
      audit({ event: "policy_load_error", error: String(error) });
      ctx.ui?.notify?.("tool-firewall: policy load failed; fail-closed (deny unknown) active", "warning");
    }
  });

  pi.on("before_agent_start", async (event: any) => {
    if (typeof event?.prompt === "string") lastRequest = event.prompt;
    return undefined;
  });

  // Decisions are serialised so parallel tool calls see each other's effects and only one
  // approval card is open at a time.
  pi.on("tool_call", (event: any, ctx: any) => {
    const run = queue.then(() => decide(event, ctx));
    queue = run.catch(() => undefined);
    return run;
  });

  async function decide(event: any, ctx: any): Promise<{ block: true; reason: string } | undefined> {
    const started = Date.now();
    const toolName = toolNameFrom(event);
    const input = event?.input || {};
    const hash = actionHash(toolName, input);
    const cwd = typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : process.cwd();
    const cfg = readConfig();
    const { mode } = resolveMode(cwd, cfg);
    const { policy: policyName } = resolvePolicy(cfg);
    const policy = getPolicy();
    const auto = mode === "auto";
    const s = sessionFor(ctx);
    const workspace = workspaceRoot(cwd);
    // Unattended: the state to decide by (null unless the supervisor's env + contract entered it and it still holds).
    const u: UnattendedState | null = unattended.current(policyName, { cwd, workspace });
    const contractEnv = process.env.PI_KIT_UNATTENDED_CONTRACT?.trim();
    const boundaryPaths = [...new Set([contractEnv, u?.contractPath].filter((x): x is string => !!x))];
    const env: ClassifyEnv = { cwd, workspace, home: homeDir(), tmpRoots: tmpRoots(), knownHosts: trustedHosts(cfg, ctx), policy: policyName, ...(boundaryPaths.length ? { boundaryPaths } : {}) };

    let a: Assessment;
    try {
      a = classifyToolCall(toolName, input, env, policy.tools[toolName], policy.defaults.unknown);
    } catch (error) {
      a = classifyToolCall(toolName, {}, env, undefined, "ask");
      a.findings.push({ tier: "high", effect: "opaque", code: "classifier_error", detail: `could not analyse this call (${String((error as Error)?.message ?? error)})`, key: `error ${toolName}` });
    }
    a.findings.push(...regexFindings(policy, policyName, a));
    const traj = trajectoryFindings(a, s);
    a.findings.push(...traj);
    a.effects = [...new Set(a.findings.map((f) => f.effect))];
    // The pentest policy never trusts auto-low shortcuts.
    const trustAuto = auto && policyName === "coding";
    const tier = effectiveTier(a, trustAuto);
    a.tier = a.findings.reduce<Tier>((t, f) => maxTier(t, f.tier), "low");
    const summary = summarize(a, trustAuto) || a.summary;
    a.summary = summary;
    const sig = signatureOf(a, trustAuto);
    const command = commandTextFrom(input);
    const uDenial = u ? unattendedDenial(a, u, workspace) : null;
    const uOutcome: "allow" | "deny" | null = !u ? null : tier === "critical" || uDenial ? "deny" : tier === "low" || u.autoApprove ? "allow" : "deny";
    const base = { toolName, toolCallId: typeof event?.toolCallId === "string" ? event.toolCallId : undefined, actionHash: hash, tier, mode: u ? "unattended" : mode, ...(u ? { unattended: { boundary: u.boundary, contract: u.digest?.slice(0, 12), autoApprove: u.autoApprove } } : {}), policy: policyName, workspace, effects: a.effects, reasons: a.findings.filter((f) => f.tier !== "low").map((f) => f.code), signature: sig, command: command !== null ? redact(command).slice(0, 2000) : undefined };
    // Immediate decisions (low → allow, critical → deny) are one tool_seen record carrying the
    // decider; anything that waits on a grant, precedent, judge or human gets tool_seen (ask)
    // followed by tool_approved / tool_blocked. Routine calls stay one line.
    const immediate = tier === "low" || tier === "critical" || uOutcome !== null;
    const seen = { event: "tool_seen", ...base, decision: uOutcome ?? (tier === "low" ? "allow" : tier === "critical" ? "deny" : "ask"), risk_class: tier, reason: summary };
    if (!immediate) audit(seen);

    const finish = (outcome: "allow" | "deny", decider: string, extra: Record<string, unknown> = {}) => {
      // What was approved is what runs: pi executes this same arguments object, and handlers
      // of extensions loaded after the firewall could otherwise change it after the decision.
      if (outcome === "allow") seal(event?.input);
      recordAction(s, a, tier, outcome, decider);
      if (outcome === "deny") s.stats.denied++;
      saveSession(s);
      const tail = { decider, latencyMs: Date.now() - started, ...extra };
      if (immediate) audit({ ...seen, ...tail, reason: summary, ...(extra.reason ? { block_reason: extra.reason } : {}) });
      else audit({ event: outcome === "allow" ? "tool_approved" : "tool_blocked", ...base, ...tail });
    };
    // Every refusal is exactly one of the labelled outcomes (see TAG), in the text the agent reads and
    // in the audit record.
    const blocked = (reason: string, decider: string, outcome: Outcome, extra: Record<string, unknown> = {}) => {
      finish("deny", decider, { outcome, reason, ...extra });
      return { block: true as const, reason };
    };

    if (tier === "critical") {
      const reason = `tool-firewall: denied ${toolName} [${TAG.hard_deny}] — ${summary}. This action is never allowed automatically, whatever an approval or the auto-mode judge says; if it is truly needed, ask the user to run it themselves.`;
      if (ctx?.hasUI) ctx.ui?.notify?.(`tool-firewall: denied ${toolName} (${summary}) — ${TAG.hard_deny}`, "warning");
      return blocked(reason, "policy", "hard_deny");
    }
    if (u) {
      // Inside the zone the container is the boundary: no prompt, no judge. Hard classes and anything that
      // needs authority outside the zone are refused, with a message the agent can relay.
      const contract = `egress: ${u.egress.join(", ") || "none"}; git remotes: ${u.remotes.join(", ") || "none"}`;
      if (uDenial?.kind === "hard") {
        if (ctx?.hasUI) ctx.ui?.notify?.(`tool-firewall: denied ${toolName} (${uDenial.what}) — ${TAG.hard_deny}, unattended run`, "warning");
        return blocked(`tool-firewall: denied ${toolName} [${TAG.hard_deny}: unattended run] — ${uDenial.what}. Destructive, security-control, credential-exfiltration and boundary actions are never allowed in an unattended run, and there is no operator to approve them. Nothing ran. Do not retry it: leave it out, carry on with work inside the container and list it in your report for the operator.`, "unattended", "hard_deny", { unattendedDenial: uDenial.code });
      }
      if (uDenial?.kind === "operator") {
        return blocked(`tool-firewall: denied ${toolName} [${TAG.uncertain}: no operator in this unattended run] — ${uDenial.what}. The policy says a person must decide this (an ask rule, or a tool the policy does not name), and an unattended run has nobody to ask. Nothing ran. Choose another approach, or say in your report that the operator must do this step.`, "unattended", "uncertain", { unattendedDenial: uDenial.code });
      }
      if (uDenial) {
        if (ctx?.hasUI) ctx.ui?.notify?.(`tool-firewall: denied ${toolName} (${uDenial.what}) — outside the unattended zone`, "warning");
        return blocked(`tool-firewall: denied ${toolName} [${TAG.hard_deny}: outside the unattended zone] — this command ${uDenial.what}. An unattended run cannot ask anyone, and its contract does not authorise it (${contract}). Nothing ran. Do not retry it: work inside the zone, and say in your report which destination or command needs the operator.`, "unattended", "hard_deny", { unattendedDenial: uDenial.code });
      }
      if (tier === "low") {
        finish("allow", "analyser");
        return undefined;
      }
      if (u.autoApprove) {
        finish("allow", "unattended", { boundary: u.boundary });
        return undefined;
      }
      return blocked(`tool-firewall: denied ${toolName} [${TAG.uncertain}: no operator in this unattended run] — ${summary}. The contract authorises unattended operation but not auto-approval, so this needs an operator, and nobody can be asked. Nothing ran. Choose a lower-impact approach, or say in your report that the operator must do this step.`, "unattended", "uncertain");
    }
    if (tier === "low") {
      finish("allow", "analyser");
      return undefined;
    }
    // Pentest approvals are per action: no session approvals (the card does not offer one).
    const strict = policyName === "pentest";
    const families = familiesFromSignature(sig);
    const scopes = [...new Set(a.findings.filter((f) => f.tier !== "low" && f.scope).map((f) => f.scope as string))];
    const root = rootSessionId(s.id);
    const steps = a.segments.filter((x) => x.tier !== "low").slice(0, 6).map((x) => redact(`${x.text.replace(/\s+/g, " ").slice(0, 140)} [${x.where}; ${x.effects.join(", ")}]`));
    const chain = traj.map((f) => redact(f.detail).slice(0, 400));
    const reasonsList = [...new Set(a.findings.filter((f) => f.tier !== "low").map((f) => redact(`[${f.tier}] ${f.detail}`).slice(0, 400)))].slice(0, 6);
    const canLearn = trustAuto && cfg.learn && learnable(a, tier);
    const match = { root, workspace, cwd, policy: policyName, tool: toolName, hash };
    const actionRecord = { command: command !== null ? redact(command).slice(0, 1500) : redact(summary).slice(0, 1500), summary: redact(summary).slice(0, 1500), steps, reasons: reasonsList, chain };

    // What may run without asking again: an approval that covers exactly this action here (approvals.ts).
    // Approvals are read from the file on every call, so a revocation applies to the next call. Never
    // under the pentest policy, and never for a hard deny (handled above).
    const view: ApprovalsView | null = strict ? null : readApprovals();
    if (view) noteApprovalProblems(view, ctx);
    const learnedScope = () => scopeRecords(readFeedback(), { workspace, since: view ? floorFor(view, workspace, hash) : 0 });
    // A learned exact action: approved repeatedly (3 times, in 2 sessions, within 30 days, after the last
    // denial) in THIS workspace. It is stored as an inspectable, revocable, expiring approval.
    const learnedApproval = (existing?: Approval): Approval | undefined => {
      if (!canLearn || !view) return undefined;
      const st = exactStatus(hash, Date.now(), learnedScope());
      if (st.status !== "learned") return undefined;
      if (existing) return existing;
      try {
        return addApproval({ context: "persistent", session: null, workspace, cwd, policy: policyName, tool: toolName, hash, families, scopes, tier: tier as "medium" | "high", grantedBy: { actor: "learned", via: "precedent", session: s.id, mode, policy: policyName, detail: `${st.approvals} approvals in ${st.sessions} sessions, within 30 days` }, action: actionRecord });
      } catch (error) {
        audit({ event: "approval_store_error", error: String((error as Error)?.message ?? error) });
        return undefined; // cannot store it, so it is not silently remembered: the operator is asked
      }
    };
    let approvalHit = view ? findExact(view, match) : undefined;
    if (approvalHit?.grantedBy.actor === "learned") approvalHit = learnedApproval(approvalHit); // a later denial, or learning switched off, suspends it
    else if (!approvalHit) approvalHit = learnedApproval();
    if (approvalHit) {
      if (approvalHit.context === "session") s.stats.grantHits++;
      else s.stats.learnedHits++;
      finish("allow", approvalHit.context === "session" ? "grant" : "precedent", { approval: approvalHit.id, approvalContext: approvalHit.context });
      return undefined;
    }

    // Everything similar to what the operator allowed goes to the judge: a session approval with a
    // shared family or scope, or families the operator has approved before in this workspace.
    const feedbackHere = scopeRecords(readFeedback(), { workspace, since: view ? floorFor(view, workspace) : 0 });
    const sessionList = view ? sessionApprovals(view, { root, workspace, policy: policyName }) : [];
    const similar = similarApprovals(sessionList, families, scopes);
    let judgeNote: string | undefined;
    let judgeView: { verdict: "allow" | "block"; reason: string } | undefined;
    let uncertainWhy: string | undefined; // set when the automatic layers could not settle it
    const highJudge = tier === "high" && canLearn && (similar.length > 0 || operatorApproved(sig, Date.now(), feedbackHere));
    const judgeAllowed = highJudge || (tier === "medium" && auto && (policyName === "coding" || a.effects.every((e) => JUDGE_SAFE_STRICT.has(e))));
    if (tier === "high" && similar.length && !highJudge) judgeNote = trustAuto ? "similar to a session allow, but this kind always needs you" : undefined;
    if (judgeAllowed) {
      const request = latestRequest(ctx, lastRequest);
      const turn = crypto.createHash("sha1").update(`${request}|${sessionList.map((g) => g.id).sort().join(",")}`).digest("hex").slice(0, 12);
      const cached = s.judgeCache[hash];
      let verdict: Verdict | null = cached && cached.turn === turn ? { verdict: cached.verdict, reason: cached.reason, ...(cached.confidence ? { confidence: cached.confidence } : {}), ...(cached.differs ? { differs: cached.differs } : {}) } : null;
      if (!verdict) {
        const complete = d.complete === undefined ? modelCompleter(ctx, cfg) : d.complete;
        audit({ event: "auto_mode_check_start", toolName, actionHash: hash, model: judgeModelName(ctx, cfg), grants: similar.length || undefined });
        s.stats.judged++;
        verdict = complete
          ? await runJudge(complete, { request, goal: readGoal(cwd, env.workspace), recent: s.recent, assessment: a, workspace: env.workspace, untrusted: s.untrusted, precedents: precedentsFor(sig), high: highJudge, grants: similar.map(toGrant), profile: strict ? undefined : profileFor(toolName, families) }, undefined, ctx?.signal)
          : null;
        if (verdict) {
          s.judgeCache[hash] = { ...verdict, turn };
          const keys = Object.keys(s.judgeCache);
          if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete s.judgeCache[k];
          appendJudgement({ tool: toolName, sig, tier, verdict: verdict.verdict, confidence: verdict.confidence, reason: verdict.differs ? `${verdict.reason} (differs: ${verdict.differs})` : verdict.reason, high: highJudge || undefined, grants: similar.length || undefined, session: s.id });
        }
      }
      if (verdict) judgeView = { verdict: verdict.verdict, reason: verdict.differs ?? verdict.reason };
      if (verdict?.verdict === "allow") {
        audit({ event: "auto_mode_approved", toolName, actionHash: hash, rationale: verdict.reason, high: highJudge || undefined, grants: similar.length || undefined });
        finish("allow", highJudge ? (similar.length ? "judge+grant" : "judge+precedent") : "judge", { rationale: verdict.reason });
        return undefined;
      }
      const unsure = isUncertainBlock(verdict);
      if (verdict?.verdict === "block" && highJudge) {
        s.stats.judgeBlocks++;
        audit({ event: "auto_mode_blocked", toolName, actionHash: hash, rationale: verdict.reason, differs: verdict.differs, confidence: verdict.confidence, high: true });
        judgeNote = unsure ? `not sure (${verdict.confidence} confidence) it fits what you allowed: ${verdict.differs ?? verdict.reason}` : `${similar.length ? "differs from your session allow" : "out of scope?"}: ${verdict.differs ?? verdict.reason}`;
        if (unsure) uncertainWhy = "judge_unsure";
      } else if (verdict?.verdict === "block" && !unsure) {
        // A high-confidence block is final: the agent gets the reason.
        s.stats.judgeBlocks++;
        audit({ event: "auto_mode_blocked", toolName, actionHash: hash, rationale: verdict.reason, differs: verdict.differs, confidence: verdict.confidence });
        if (ctx?.hasUI) ctx.ui?.notify?.(`tool-firewall: auto-mode blocked ${toolName} — ${verdict.reason}`, "warning");
        return blocked(`tool-firewall: auto-mode blocked ${toolName} — ${verdict.reason}${verdict.differs ? ` (${verdict.differs})` : ""}. [${TAG.judge_block}: judge, high confidence] If this step is really needed, explain why to the user and ask them to approve it.`, "judge", "judge_block", { rationale: verdict.reason });
      } else if (verdict?.verdict === "block") {
        // A block the judge is only unsure about is UNCERTAIN, not final: the operator decides.
        s.stats.judgeBlocks++;
        audit({ event: "auto_mode_blocked", toolName, actionHash: hash, rationale: verdict.reason, differs: verdict.differs, confidence: verdict.confidence, escalated: true });
        judgeNote = `unsure whether to block (${verdict.confidence} confidence): ${verdict.differs ?? verdict.reason}`;
        uncertainWhy = "judge_unsure";
      }
      if (!verdict) {
        judgeNote = "judge unavailable — asking you instead";
        uncertainWhy = "judge_unavailable";
        audit({ event: "auto_mode_judge_unavailable", toolName, actionHash: hash });
        if (ctx?.hasUI) ctx.ui?.notify?.(`tool-firewall: auto-mode judge unavailable for ${toolName} — falling back to manual approval`, "warning");
      }
    }
    // The classifier could not tell what this does (an unparsed or computed command): also UNCERTAIN.
    if (!uncertainWhy && a.findings.some((f) => f.tier !== "low" && (f.effect === "opaque" || f.code === "classifier_error"))) uncertainWhy = "classifier_unsure";

    // Ask a human.
    const precedent = statusFor(sig, Date.now(), feedbackHere);
    const allowSession = !strict;
    const judged = trustAuto && cfg.learn;
    const scopeText = describeFamilies(families);
    const covers = allowSession ? (judged ? `exact repeats run; similar steps${scopeText ? ` (${scopeText})` : ""} are judged against this` : "exact repeats run") : undefined;
    const sessionScope = allowSession ? `this session + workspace, ${Math.round(SESSION_APPROVAL_TTL_MS / 3_600_000)}h` : undefined;
    const uncertain = !!uncertainWhy;
    const extras = { tier, trajectory: traj, judgeNote, precedent, hash, signature: sig, mode, policy: policyName, covers, scope: sessionScope, uncertain };
    const card = buildCard(a, extras);
    lastDetail = buildDetail(a, extras);
    const choices = choicesFor(allowSession, judged);
    const grant = (via: "card" | "console", choice?: string) => {
      try {
        addApproval({ context: "session", session: root, workspace, cwd, policy: policyName, tool: toolName, hash, families, scopes, tier: tier as "medium" | "high", grantedBy: { actor: "operator", via, session: s.id, mode, policy: policyName, ...(choice ? { choice: choice.slice(0, 280) } : {}) }, action: actionRecord });
      } catch (error) {
        audit({ event: "approval_store_error", error: String((error as Error)?.message ?? error) });
        say(ctx, `tool-firewall: could not store the session allow (${String((error as Error)?.message ?? error)}); you will be asked again`, "warning");
      }
    };
    const record = (decision: "allow" | "deny", source: FeedbackRecord["source"], note?: string, choice?: string) => {
      s.stats.human++;
      try {
        appendFeedback({ sig, decision, tier, tool: toolName, summary: command ?? summary, project: env.workspace, session: s.id, source, note, hash, choice, steps, chain, judge: judgeView });
      } catch {
        /* learning is best effort */
      }
      // Every operator decision can refresh the global profile, off the hot path.
      if (cfg.learn && !strict) distillInBackground(d.complete === undefined ? modelCompleter(ctx, cfg) : d.complete);
      // The approval that just reached the learning threshold is stored now, so it is listed (and can be revoked) at once.
      if (decision === "allow") learnedApproval();
    };
    const denyReason = (note?: string) =>
      `tool-firewall: denied ${toolName} [${TAG.operator_decision}: denied] — the operator declined this action${note ? `: ${note}` : "."}${judgeView?.verdict === "block" ? ` (The auto-mode judge also flagged it: ${judgeView.reason}.)` : ""} Do not retry it; take a different approach or ask the user what they want.`;
    // Nobody answered: UNCERTAIN, refused, bounded, and worded for the agent to relay.
    const noAnswer = (why: "timeout" | "aborted" | "unavailable" | "error", via: "console" | "prompt", secs: number, detail?: string) => {
      const what =
        why === "aborted"
          ? "the request was cancelled (the turn was aborted) before anyone answered"
          : why === "unavailable"
            ? String(detail)
            : why === "error"
              ? `the approval prompt failed (${detail})`
              : via === "console"
                ? `none arrived within ${secs}s (headless: no attended session answered the human console)`
                : `none arrived within ${secs}s (the approval prompt was not answered)`;
      return blocked(`tool-firewall: denied ${toolName} [${TAG.uncertain}: no operator decision] — ${summary}. ${uncertain ? "The automatic checks could not settle this, and it" : "It"} needs operator approval, and ${what}. Nothing ran. Ask the user to approve it or to run it themselves, or choose a lower-impact approach; do not retry it unchanged.`, why === "timeout" ? (via === "console" ? "broker_timeout" : "prompt_timeout") : why, "uncertain", { why });
    };

    if (!ctx?.hasUI && policyName === "pentest" && tier === "high") return blocked(`tool-firewall: denied ${toolName} [${TAG.hard_deny}] — ${summary}. The pentest policy does not approve high-impact actions without an interactive operator.`, "policy", "hard_deny");

    if (uncertain) audit({ event: "tool_escalated", outcome: "uncertain", why: uncertainWhy, toolName, actionHash: hash, operator: ctx?.hasUI ? "interactive" : "console" });

    if (ctx?.hasUI && typeof ctx.ui?.select === "function") {
      const res = await boundedPrompt(ctx, (o) => ctx.ui.select(card, choices, o));
      if (res.kind === "aborted") return noAnswer("aborted", "prompt", 0);
      if (res.kind === "timeout") return noAnswer("timeout", "prompt", Math.round(promptTimeoutMs() / 1000));
      if (res.kind === "error") return noAnswer("error", "prompt", 0, res.message);
      const choice = res.value;
      if (choice === CHOICE_ALLOW_ONCE || isSessionChoice(choice)) {
        if (isSessionChoice(choice)) grant("card", choice);
        record("allow", isSessionChoice(choice) ? "grant" : "card", undefined, choice);
        finish("allow", "human", { outcome: "operator_decision", choice });
        return undefined;
      }
      let note: string | undefined;
      if (choice === CHOICE_DENY_TELL && typeof ctx.ui.input === "function") {
        const typed = await boundedPrompt(ctx, (o) => ctx.ui.input("Tell the agent why (it sees this):", "e.g. don't touch production; use the staging host", o));
        if (typed.kind === "answered" && typeof typed.value === "string") note = typed.value.trim() || undefined;
      }
      record("deny", "card", note, choice ?? "dismissed");
      return blocked(denyReason(note), "human", "operator_decision", { choice: choice ?? "dismissed" });
    }
    let approved: boolean;
    let source: FeedbackRecord["source"] = "card";
    let note: string | undefined;
    let picked: string | undefined;
    if (ctx?.hasUI && typeof ctx.ui?.confirm === "function") {
      const res = await boundedPrompt(ctx, (o) => ctx.ui.confirm("Approve tool call?", card, o));
      if (res.kind === "aborted") return noAnswer("aborted", "prompt", 0);
      if (res.kind === "timeout") return noAnswer("timeout", "prompt", Math.round(promptTimeoutMs() / 1000));
      if (res.kind === "error") return noAnswer("error", "prompt", 0, res.message);
      approved = res.value === true;
    } else {
      source = "broker";
      // The console adds a title line; keep the whole request within the line budget.
      const res = await brokerApproval(toolName, input, tier, summary, buildCard(a, { ...extras, maxLines: CARD_MAX_LINES - 1 }), judgeNote ?? null, ctx, ctx?.signal, choices);
      if (res.unavailable) return noAnswer("unavailable", "console", 0, `${res.unavailable}. No operator could be asked`);
      if (res.timedOut) return noAnswer(res.aborted ? "aborted" : "timeout", "console", Math.round((res.timeoutMs ?? 0) / 1000));
      approved = res.approved;
      note = res.note;
      picked = res.choice;
      if (approved && isSessionChoice(res.choice)) {
        grant("console", res.choice);
        source = "grant";
      }
    }
    if (!approved) {
      record("deny", source === "grant" ? "broker" : source, note, picked);
      return blocked(denyReason(note), "human", "operator_decision", { choice: picked });
    }
    record("allow", source, undefined, picked);
    finish("allow", "human", { outcome: "operator_decision", choice: picked });
    return undefined;
  }

  // ---- /firewall: inspect and revoke what the firewall remembers ---------------------------------

  const listApprovalLines = (view: ApprovalsView, root: string, workspace: string): string[] => {
    const out: string[] = [];
    for (const a of view.approvals) {
      const applies = a.workspace === workspace && (a.context === "persistent" || a.session === root);
      const grantedVia = a.grantedBy.actor === "learned" ? `learned (${a.grantedBy.detail ?? "repeated approvals"})` : `operator via ${a.grantedBy.via}${a.grantedBy.choice ? ` ("${a.grantedBy.choice.slice(0, 60)}")` : ""}`;
      out.push(
        `  ${a.context === "session" ? "SESSION   " : "PERSISTENT"} ${a.id}  ${a.tier.toUpperCase()}  ${a.tool}: ${a.action.command.replace(/\s+/g, " ").slice(0, 110)}`,
        `      scope: ${describeScope(a)}`,
        `      granted: ${grantedVia} at ${a.createdAt} · ${a.expiresAt ? `expires ${a.expiresAt}` : "no expiry"} · ${applies ? "applies here" : "not for this session/workspace"}`,
      );
    }
    return out;
  };

  const firewallList = (ctx: any): string => {
    const cwd = ctx?.cwd || process.cwd();
    const s = sessionFor(ctx);
    const root = rootSessionId(s.id);
    const workspace = workspaceRoot(cwd);
    const cfg = readConfig();
    const view = readApprovals();
    const problems = noteApprovalProblems(view, ctx);
    const kh = knownHostsMeta(cfg);
    const here = scopeRecords(readFeedback(), { workspace, since: floorFor(view, workspace) });
    const approvedKinds = listLearned(Date.now(), here).filter((l) => l.approvals > 0).length;
    const lines = [`tool-firewall approvals (${view.file}, schemaVersion 1) — session ${root}, workspace ${workspace}`];
    if (view.approvals.length) lines.push(...listApprovalLines(view, root, workspace));
    else lines.push("  no remembered approvals: every medium or high action asks (or goes to the judge in auto mode)");
    if (view.expired) lines.push(`  (${view.expired} expired approval(s) are ignored and dropped on the next write)`);
    if (problems.length) lines.push(`  IGNORED (malformed, never treated as an allow): ${problems.slice(0, 6).join("; ")}${problems.length > 6 ? "; …" : ""}`);
    lines.push(`  kinds you approved in this workspace that may reach the judge in auto mode: ${approvedKinds} (see /auto learned; /firewall revoke workspace clears them)`);
    const hostLines = [...new Set([...kh.fromConfig, ...kh.fromSsh])].sort().map((h) => `${h} [${kh.untrusted.has(h) ? "REVOKED" : `${kh.fromConfig.has(h) ? "firewall.json" : "~/.ssh/config"}`}]`);
    lines.push(`  known hosts (only lower READ-ONLY ssh and sudo -n reads in auto mode, coding policy): ${hostLines.join(", ") || "none"}`);
    lines.push("  revoke: /firewall revoke <id> | session | workspace | all | host:<name>  (takes effect on the next tool call)");
    return lines.join("\n");
  };

  const unattendedLine = (): string => {
    const st = unattended.state();
    if (st.active) return `  unattended: ACTIVE — ${st.boundary} boundary, contract sha256:${st.digest?.slice(0, 12)}, boundaryDigest ${st.boundaryDigest?.slice(0, 16)}, auto-approve ${st.autoApprove ? "yes" : "NO"}; egress: ${st.egress.join(", ") || "none"}; git remotes: ${st.remotes.join(", ") || "none"}; no prompts and no judge inside the zone, hard denies and outside-the-zone actions fail closed${st.warnings.length ? `; note: ${st.warnings.join("; ")}` : ""}`;
    if (st.requested) return `  unattended: NOT ACTIVE although requested — ${st.warnings.join("; ")} (fail closed: the normal interactive/headless rules apply)`;
    return "  unattended: off (only the supervisor can turn it on, with PI_KIT_UNATTENDED=1 and a read-only contract; nothing inside a session can)";
  };

  const firewallStatus = (ctx: any): string => {
    const policy = getPolicy();
    const cfg = readConfig();
    const cwd = ctx?.cwd || process.cwd();
    const m = resolveMode(cwd, cfg);
    const p = resolvePolicy(cfg);
    const s = sessionFor(ctx);
    const workspace = workspaceRoot(cwd);
    const view = readApprovals();
    const problems = noteApprovalProblems(view, ctx);
    const here = scopeRecords(readFeedback(), { workspace, since: floorFor(view, workspace) });
    const learned = listLearned(Date.now(), here).filter((l) => l.status === "learned").length;
    const kh = knownHostsMeta(cfg);
    const warningSuffix = lastPolicyWarnings.length > 0 ? ` skipped-rules=${lastPolicyWarnings.length}(!)` : "";
    const zone = unattended.state();
    const decides =
      zone.active && p.policy === "coding"
        ? `UNATTENDED zone (${zone.boundary}): ${zone.autoApprove ? "low, medium and high run with no prompt and no judge" : "only low runs; everything above fails closed (no operator, no auto-approve)"}; critical, hard-denied classes and anything outside the zone are refused (the mode above is not consulted)`
        : p.policy === "pentest"
        ? "pentest policy: medium and high ask the operator each time (denied headless); no session allows, no learning"
        : m.mode === "auto"
          ? "auto: low runs; medium is judged (a high-confidence block is final, an unsure one asks you); high runs only on an exact approval, else judge-if-similar, else asks you; critical is denied"
          : "manual: low runs; medium and high ask you; critical is denied; only an exact approval runs without asking";
    return [
      `tool-firewall: policy=${p.policy} (${p.source}) mode=${m.mode} (${m.source})`,
      `  decides: ${decides}`,
      `  runs without asking: low-tier actions in every mode (reads of non-credential paths, git reads, network GETs, workspace writes, dev tooling, tools read-named by convention)${m.mode === "auto" && p.policy === "coding" ? "; in auto mode also read-only ssh and sudo -n reads on known hosts" : "; read-only ssh/sudo -n on known hosts is NOT trusted in this mode and asks"}`,
      `  outcomes: HARD DENY (policy says never; no approval or judge overrides) · UNCERTAIN (judge/classifier unsure, unavailable or timed out: asks you, or fails closed when nobody can be asked) · OPERATOR DECISION (you allowed or denied; remembered only within the scope the card names)`,
      `  rules: ${cachedPolicyLabel} default-unknown=${policy.defaults.unknown} tool-rules=${Object.keys(policy.tools).length} operator-rules=${policy.command_rules.deny.length}/${policy.command_rules.ask.length} pentest-rules=${policy.pentest.deny.length}/${policy.pentest.ask.length}${warningSuffix}`,
      `  judge model: ${judgeModelName(ctx, cfg) ?? "unset"} · learning ${cfg.learn ? "on" : "off"} (${learned} learned here) · known hosts: ${[...kh.hosts].join(", ") || "none"}`,
      unattendedLine(),
      `  approvals: ${view.approvals.length} remembered (${view.approvals.filter((a) => a.context === "session").length} session, ${view.approvals.filter((a) => a.context === "persistent").length} persistent)${problems.length ? `, ${problems.length} malformed ignored (/firewall list)` : ""} — ${view.file}`,
      `  session: ${s.stats.actions} actions, ${s.stats.human} asked you, ${s.stats.judged} judged (${s.stats.judgeBlocks} blocked)${s.credentialReads.length ? `, secret reads: ${s.credentialReads.map((c) => c.what).slice(-3).join(", ")}` : ""}${s.untrusted ? ", web/untrusted content seen" : ""}`,
      `  audit=${auditPath()} config=${configPath()}`,
    ].join("\n");
  };

  const FIREWALL_USAGE = "usage: /firewall [status | list | revoke <id>… | revoke session | revoke workspace | revoke all | revoke host:<name> | reload | help]";

  const firewallCommand = async (args: string, ctx: any) => {
    const [subRaw = "status", ...rest] = (args || "").trim().split(/\s+/).filter(Boolean);
    const sub = subRaw.toLowerCase();
    try {
      if (sub === "status" || sub === "st") return say(ctx, firewallStatus(ctx), "info");
      if (sub === "list" || sub === "ls" || sub === "approvals") {
        if (rest.length) return say(ctx, `tool-firewall: /firewall list takes no arguments. ${FIREWALL_USAGE}`, "error");
        return say(ctx, firewallList(ctx), "info");
      }
      if (sub === "reload") {
        reloadPolicy();
        sshBaseline = knownHostsMeta(readConfig()).sshMtime;
        sshWarned = false;
        say(ctx, `tool-firewall: reloaded policy (${cachedPolicyLabel})`, "info");
        if (lastPolicyWarnings.length > 0) say(ctx, `tool-firewall: WARNING — ${lastPolicyWarnings.length} rule(s) skipped: ${lastPolicyWarnings.join("; ")}`, "warning");
        return;
      }
      if (sub === "help" || sub === "--help" || sub === "-h") return say(ctx, FIREWALL_USAGE, "info");
      if (sub === "revoke") {
        const cwd = ctx?.cwd || process.cwd();
        const scope = { root: rootSessionId(sessionFor(ctx).id), workspace: workspaceRoot(cwd) };
        const cfg = readConfig();
        const hosts = rest.filter((t) => /^host:/i.test(t));
        const others = rest.filter((t) => !/^host:/i.test(t));
        if (!rest.length) return say(ctx, `tool-firewall: nothing to revoke. ${FIREWALL_USAGE}`, "error");
        // Validate every target before changing anything: invalid arguments never mutate state.
        const kh = knownHostsMeta(cfg);
        const names = hosts.map((t) => t.slice(5).toLowerCase());
        const badHost = names.find((n) => !n || !(kh.fromConfig.has(n) || kh.fromSsh.has(n)) || kh.untrusted.has(n));
        if (badHost !== undefined) return say(ctx, `tool-firewall: "host:${badHost}" is not a trusted known host (see /firewall list). Nothing was changed.`, "error");
        const lines: string[] = [];
        if (others.length) {
          const r = revokeApprovals(others, scope);
          if (r.error) return say(ctx, `tool-firewall: ${r.error}. Nothing was changed.`, "error");
          lines.push(`revoked ${r.removed.length} approval(s)${r.removed.length ? `: ${r.removed.map((a) => `${a.id} (${a.context})`).join(", ")}` : ""}${r.resetLearning.length ? `; reset ${r.resetLearning.join(", ")}` : ""}`);
        }
        if (names.length) {
          writeConfig({ knownHosts: cfg.knownHosts.filter((h) => !names.includes(h.toLowerCase())), untrustedHosts: [...new Set([...cfg.untrustedHosts, ...names])], source: "user" });
          lines.push(`withdrew trust from ${names.map((n) => `host ${n}`).join(", ")}${names.some((n) => kh.fromSsh.has(n)) ? " (still named in ~/.ssh/config; the firewall no longer trusts it)" : ""}`);
        }
        return say(ctx, `tool-firewall: ${lines.join("; ")}. Takes effect on the next tool call.`, "info");
      }
      return say(ctx, `tool-firewall: unknown option "${subRaw}". ${FIREWALL_USAGE}`, "error");
    } catch (error) {
      return say(ctx, `tool-firewall: /firewall ${sub} failed: ${String((error as Error)?.message ?? error)}`, "error");
    }
  };

  pi.registerCommand("firewall", { description: "Tool firewall: /firewall [status | list | revoke <id>|session|workspace|all|host:<name> | reload]. Lists remembered approvals with their scope and revokes them.", handler: async (args: string, ctx: any) => void (await firewallCommand(args, ctx)) });
  pi.registerCommand("firewall:reload", { description: "Reload the tool-firewall policy from disk (alias of /firewall reload)", handler: async (_args: string, ctx: any) => void (await firewallCommand("reload", ctx)) });
  pi.registerCommand("firewall:status", { description: "Show tool-firewall status: policy, mode, judge, learning, approvals (alias of /firewall status)", handler: async (_args: string, ctx: any) => void (await firewallCommand("status", ctx)) });

  const autoCommand = async (args: string, ctx: any) => {
    const [option = "status", ...rest] = (args || "status").trim().split(/\s+/);
    const cwd = ctx?.cwd || process.cwd();
    const opt = option.toLowerCase();
    if (opt === "on" || opt === "off") {
      const enabled = opt === "on";
      try {
        writeConfig({ mode: enabled ? "auto" : "manual", source: "user" });
        const legacy = legacyAutoModePath(cwd);
        if (process.env.PI_KIT_AUTO_MODE_STATE_DIR || fs.existsSync(legacy)) {
          fs.mkdirSync(path.dirname(legacy), { recursive: true });
          fs.writeFileSync(legacy, JSON.stringify({ enabled }));
        }
        const eff = resolveMode(cwd);
        say(ctx, `auto-mode: ${enabled ? "enabled" : "disabled"}${eff.mode !== (enabled ? "auto" : "manual") ? ` (but ${eff.source} overrides it: ${eff.mode})` : ""}`, "info");
      } catch (error) {
        say(ctx, `auto-mode: could not ${enabled ? "enable" : "disable"} — failed to write ${configPath()} (${error instanceof Error ? error.message : String(error)})`, "error");
      }
      return;
    }
    if (opt === "status") {
      const cfg = readConfig();
      const m = resolveMode(cwd, cfg);
      say(ctx, `auto-mode: ${m.mode === "auto" ? "enabled" : "disabled"} (from ${m.source}) policy=${resolvePolicy(cfg).policy} model=${judgeModelName(ctx, cfg) ?? "unset (no session model available)"} learning=${cfg.learn ? "on" : "off"} state=${configPath()}`, "info");
      return;
    }
    if (opt === "learn") {
      const on = (rest[0] ?? "").toLowerCase();
      if (on !== "on" && on !== "off") return say(ctx, "auto-mode: usage /auto learn on|off", "error");
      writeConfig({ learn: on === "on" });
      return say(ctx, `auto-mode: learning from your decisions ${on === "on" ? "on" : "off"}`, "info");
    }
    if (opt === "learned") {
      // Learning is scoped to the workspace the decisions were made in, and to what was not revoked since.
      const workspace = workspaceRoot(cwd);
      const all = listLearned(Date.now(), scopeRecords(readFeedback(), { workspace, since: floorFor(readApprovals(), workspace) }));
      if (!all.length) return say(ctx, `auto-mode: no decisions recorded yet for ${workspace} (${feedbackPath()})`, "info");
      return say(ctx, [`auto-mode: precedents for ${workspace} (signature — approvals/sessions/denials — status)`, ...all.slice(0, 40).map((l) => `  ${l.sig} — ${l.approvals}/${l.sessions}/${l.denials} — ${l.status}`)].join("\n"), "info");
    }
    if (opt === "forget") {
      const sig = rest.join(" ");
      if (!sig) return say(ctx, "auto-mode: usage /auto forget <signature> (a trailing * matches a prefix)", "error");
      return say(ctx, `auto-mode: forgot ${forget(sig)} decision(s)`, "info");
    }
    if (opt === "stats") {
      const s = sessionFor(ctx);
      const per100 = s.stats.actions ? ((s.stats.human / s.stats.actions) * 100).toFixed(1) : "0";
      return say(ctx, `auto-mode: this session ${s.stats.actions} actions · asked you ${s.stats.human} (${per100}/100) · judged ${s.stats.judged} (${s.stats.judgeBlocks} blocked) · learned hits ${s.stats.learnedHits} · session-allow repeats ${s.stats.grantHits} · denied ${s.stats.denied}`, "info");
    }
    if (opt === "profile") {
      const sub = (rest[0] ?? "").toLowerCase();
      if (sub === "reset") return say(ctx, resetProfile() ? "auto-mode: learned profile cleared (decisions are kept; it is rebuilt from them later)" : "auto-mode: no learned profile to clear", "info");
      if (sub === "rebuild") {
        const complete = d.complete === undefined ? modelCompleter(ctx, readConfig()) : d.complete;
        if (!complete) return say(ctx, "auto-mode: no model available to rebuild the profile", "error");
        const p = await distill(complete).catch(() => null);
        return say(ctx, p ? `auto-mode: profile rebuilt from ${p.basedOn.decisions} decision(s) and ${p.basedOn.judgements} judgement(s)` : "auto-mode: profile rebuild failed (model gave no usable answer)", p ? "info" : "error");
      }
      const p = readProfile();
      const stats = (p?.stats?.length ? p.stats : computeStats()).slice(0, 12).map((v) => `  ${statsLine(v)}`);
      const lines = [
        p ? `auto-mode: learned profile (updated ${p.updated}, from ${p.basedOn.decisions} decisions, ${p.basedOn.judgements} judgements)` : "auto-mode: no learned profile yet (built in the background after a few decisions)",
        ...(p?.principles.length ? ["How you decide:", ...p.principles.map((x) => `  - ${x}`)] : []),
        ...(p?.cautions.length ? ["What you refuse:", ...p.cautions.map((x) => `  - ${x}`)] : []),
        ...(stats.length ? ["Most recent kinds:", ...stats] : []),
        "It informs the judge only; /auto profile rebuild | reset",
      ];
      return say(ctx, lines.join("\n"), "info");
    }
    if (opt === "explain") {
      const s = sessionFor(ctx);
      const n = Math.max(1, Math.min(20, Number(rest[0]) || 5));
      const lines = s.recent.slice(-n).map((r) => `  ${r.outcome.padEnd(5)} ${r.tier.padEnd(8)} by ${r.decider.padEnd(9)} ${r.tool}: ${r.summary.slice(0, 120)}`);
      const last = lastDetail ? ["auto-mode: last approval request (full detail)", lastDetail, ""] : [];
      return say(ctx, [...last, ...(lines.length ? ["auto-mode: recent decisions", ...lines] : ["auto-mode: no decisions yet this session"])].join("\n"), "info");
    }
    if (opt === "check") {
      const command = rest.join(" ");
      const cfg = readConfig();
      const env: ClassifyEnv = { cwd, workspace: workspaceRoot(cwd), home: homeDir(), tmpRoots: tmpRoots(), knownHosts: trustedHosts(cfg, ctx), policy: resolvePolicy(cfg).policy };
      const a = classifyToolCall("bash", { command }, env, getPolicy().tools.bash, getPolicy().defaults.unknown);
      const auto = resolveMode(cwd, cfg).mode === "auto";
      const sigc = signatureOf(a, auto);
      return say(ctx, buildDetail(a, { tier: effectiveTier(a, auto), trajectory: [], hash: actionHash("bash", { command }), signature: sigc, mode: auto ? "auto" : "manual", policy: env.policy, covers: env.policy === "pentest" ? undefined : describeFamilies(familiesFromSignature(sigc)) || undefined }), "info");
    }
    say(ctx, `auto-mode: unknown option "${option}" — use status|on|off|explain [n]|learned|forget <sig>|learn on|off|stats|profile [rebuild|reset]|check <command>`, "error");
  };

  pi.registerCommand("auto", { description: "Auto mode: /auto [status|on|off|explain [n]|learned|forget <sig>|learn on|off|stats|profile [rebuild|reset]|check <command>]", handler: autoCommand });
  pi.registerCommand("auto-mode", { description: "Alias of /auto", handler: autoCommand });
  // Only once every hook is installed: a factory that failed earlier never registers.
  registerProtection("tool-firewall");
}

