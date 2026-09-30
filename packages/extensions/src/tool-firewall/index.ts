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
import { configPath, feedbackPath, homeDir, knownHosts, legacyAutoModePath, readConfig, resolveMode, resolvePolicy, tmpRoots, workspaceRoot, writeConfig, type FirewallConfig } from "./config.ts";
import { appendFeedback, exactStatus, forget, learnable, listLearned, operatorApproved, precedentsFor, redact, statusFor, type FeedbackRecord } from "./feedback.ts";
import { appendJudgement, computeStats, distillInBackground, profileFor, readProfile, resetProfile, statsLine, distill } from "./profile.ts";
import { runJudge, type Completer, type Verdict } from "./judge.ts";
import { addGrant, loadSession, readGrants, recordAction, rootSessionId, saveSession, similarGrants, trajectoryFindings, type SessionGrant, type SessionState } from "./trajectory.ts";
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

type BrokerResult = { approved: boolean; timedOut: boolean; choice?: string; note?: string };

// Headless requests go to the human console. `choices` lets a console that supports them offer
// the same menu as the interactive card (allow once / allow for the session / deny / deny and
// tell); an older console answers yes/no, which is treated as allow once / deny.
function brokerApproval(toolName: string, input: unknown, tier: Tier, reason: string, body: string, note: string | null, ctx: any, signal?: AbortSignal, choices?: string[]): Promise<BrokerResult> {
  const root = humanConsoleRoot();
  const pending = path.join(root, "pending");
  const resolved = path.join(root, "resolved");
  try {
    fs.mkdirSync(pending, { recursive: true });
    fs.mkdirSync(resolved, { recursive: true });
  } catch {
    return Promise.resolve({ approved: false, timedOut: false });
  }
  const id = crypto.randomUUID();
  const timeoutMs = Math.max(1, Number(process.env.PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS) || 900000);
  fs.writeFileSync(
    path.join(pending, `${id}.json`),
    JSON.stringify({ id, kind: "approval", createdAt: new Date().toISOString(), requester: { pid: process.pid, sessionId: sessionIdOf(ctx), agent: ctx?.agent?.name || ctx?.agentName || "root" }, toolName, input, riskClass: tier, reason, title: `Approve tool call? (${ctx?.agent?.name || ctx?.agentName || (process.env.PI_KIT_INTERNAL_CHILD ? "subagent" : "headless session")})`, body, choices, autoModeRationale: note, timeoutMs }),
  );
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
      resolve(result);
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
        audit({ event: "human_console_timeout", toolName, id });
        finish({ approved: false, timedOut: true });
      }
    }, Math.min(1000, timeoutMs));
    timer.unref?.();
  });
}

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

  const sessionFor = (ctx: any): SessionState => {
    const id = sessionIdOf(ctx);
    if (!session || session.id !== id) session = loadSession(id);
    return session;
  };

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
      // Export the root session before any subagent is spawned, so children share its grants.
      rootSessionId(sessionIdOf(ctx));
      ctx.ui?.notify?.(`tool-firewall: loaded (${cachedPolicyLabel}, default unknown=${policy.defaults.unknown}, rules=${ruleCount(policy)}, mode=${mode}, policy=${pol})`, "info");
      if (lastPolicyWarnings.length > 0) {
        audit({ event: "policy_rule_warnings", warnings: lastPolicyWarnings });
        ctx.ui?.notify?.(`tool-firewall: WARNING — ${lastPolicyWarnings.length} custom rule(s) in the policy were skipped (not enforced): ${lastPolicyWarnings.join("; ")}`, "warning");
      }
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
    const env: ClassifyEnv = { cwd, workspace: workspaceRoot(cwd), home: homeDir(), tmpRoots: tmpRoots(), knownHosts: knownHosts(cfg), policy: policyName };

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
    const base = { toolName, toolCallId: typeof event?.toolCallId === "string" ? event.toolCallId : undefined, actionHash: hash, tier, mode, policy: policyName, effects: a.effects, reasons: a.findings.filter((f) => f.tier !== "low").map((f) => f.code), signature: sig, command: command !== null ? redact(command).slice(0, 2000) : undefined };
    // Immediate decisions (low → allow, critical → deny) are one tool_seen record carrying the
    // decider; anything that waits on a grant, precedent, judge or human gets tool_seen (ask)
    // followed by tool_approved / tool_blocked. Routine calls stay one line.
    const immediate = tier === "low" || tier === "critical";
    const seen = { event: "tool_seen", ...base, decision: tier === "low" ? "allow" : tier === "critical" ? "deny" : "ask", risk_class: tier, reason: summary };
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
    const blocked = (reason: string, decider: string, extra: Record<string, unknown> = {}) => {
      finish("deny", decider, { reason, ...extra });
      return { block: true as const, reason };
    };

    if (tier === "critical") {
      const reason = `tool-firewall: denied ${toolName} — ${summary}. This action is never allowed automatically; if it is truly needed, ask the user to run it themselves.`;
      if (ctx?.hasUI) ctx.ui?.notify?.(`tool-firewall: denied ${toolName} (${summary})`, "warning");
      return blocked(reason, "policy");
    }
    if (tier === "low") {
      finish("allow", "analyser");
      return undefined;
    }
    // Pentest approvals are per action: no session grants (the card does not offer one).
    const strict = policyName === "pentest";
    const families = familiesFromSignature(sig);
    const scopes = [...new Set(a.findings.filter((f) => f.tier !== "low" && f.scope).map((f) => f.scope as string))];
    const root = rootSessionId(s.id);
    const grants = strict ? [] : readGrants(root);
    const steps = a.segments.filter((x) => x.tier !== "low").slice(0, 6).map((x) => `${x.text.replace(/\s+/g, " ").slice(0, 140)} [${x.where}; ${x.effects.join(", ")}]`);
    const chain = traj.map((f) => f.detail);
    // Only exact repeats run without reasoning: the same action the operator allowed for the
    // session, or the same action approved repeatedly across sessions.
    if (grants.some((g) => g.hash === hash)) {
      s.stats.grantHits++;
      finish("allow", "grant");
      return undefined;
    }
    const canLearn = trustAuto && cfg.learn && learnable(a, tier);
    if (canLearn) {
      const st = exactStatus(hash);
      if (st.status === "learned") {
        s.stats.learnedHits++;
        finish("allow", "precedent", { approvals: st.approvals, sessions: st.sessions });
        return undefined;
      }
    }

    // Everything similar to what the operator allowed goes to the judge: a session grant with
    // a shared family or scope, or families the operator has approved before.
    const similar = similarGrants(grants, families, scopes);
    let judgeNote: string | undefined;
    let judgeView: { verdict: "allow" | "block"; reason: string } | undefined;
    const highJudge = tier === "high" && canLearn && (similar.length > 0 || operatorApproved(sig));
    const judgeAllowed = highJudge || (tier === "medium" && auto && (policyName === "coding" || a.effects.every((e) => JUDGE_SAFE_STRICT.has(e))));
    if (tier === "high" && similar.length && !highJudge) judgeNote = trustAuto ? "similar to a session allow, but this kind always needs you" : undefined;
    if (judgeAllowed) {
      const request = latestRequest(ctx, lastRequest);
      const turn = crypto.createHash("sha1").update(`${request}|${grants.length}`).digest("hex").slice(0, 12);
      const cached = s.judgeCache[hash];
      let verdict: Verdict | null = cached && cached.turn === turn ? { verdict: cached.verdict, reason: cached.reason, ...(cached.differs ? { differs: cached.differs } : {}) } : null;
      if (!verdict) {
        const complete = d.complete === undefined ? modelCompleter(ctx, cfg) : d.complete;
        audit({ event: "auto_mode_check_start", toolName, actionHash: hash, model: judgeModelName(ctx, cfg), grants: similar.length || undefined });
        s.stats.judged++;
        verdict = complete
          ? await runJudge(complete, { request, goal: readGoal(cwd, env.workspace), recent: s.recent, assessment: a, workspace: env.workspace, untrusted: s.untrusted, precedents: precedentsFor(sig), high: highJudge, grants: similar, profile: strict ? undefined : profileFor(toolName, families) }, undefined, ctx?.signal)
          : null;
        if (verdict) {
          s.judgeCache[hash] = { ...verdict, turn };
          const keys = Object.keys(s.judgeCache);
          if (keys.length > 200) for (const k of keys.slice(0, keys.length - 200)) delete s.judgeCache[k];
          appendJudgement({ tool: toolName, sig, tier, verdict: verdict.verdict, reason: verdict.differs ? `${verdict.reason} (differs: ${verdict.differs})` : verdict.reason, high: highJudge || undefined, grants: similar.length || undefined, session: s.id });
        }
      }
      if (verdict) judgeView = { verdict: verdict.verdict, reason: verdict.differs ?? verdict.reason };
      if (verdict?.verdict === "allow") {
        audit({ event: "auto_mode_approved", toolName, actionHash: hash, rationale: verdict.reason, high: highJudge || undefined, grants: similar.length || undefined });
        finish("allow", highJudge ? (similar.length ? "judge+grant" : "judge+precedent") : "judge", { rationale: verdict.reason });
        return undefined;
      }
      if (verdict?.verdict === "block" && highJudge) {
        s.stats.judgeBlocks++;
        audit({ event: "auto_mode_blocked", toolName, actionHash: hash, rationale: verdict.reason, differs: verdict.differs, high: true });
        judgeNote = `${similar.length ? "differs from your session allow" : "out of scope?"}: ${verdict.differs ?? verdict.reason}`;
      } else if (verdict?.verdict === "block") {
        s.stats.judgeBlocks++;
        audit({ event: "auto_mode_blocked", toolName, actionHash: hash, rationale: verdict.reason, differs: verdict.differs });
        if (ctx?.hasUI) ctx.ui?.notify?.(`tool-firewall: auto-mode blocked ${toolName} — ${verdict.reason}`, "warning");
        return blocked(`tool-firewall: auto-mode blocked ${toolName} — ${verdict.reason}${verdict.differs ? ` (${verdict.differs})` : ""}. If this step is really needed, explain why to the user and ask them to approve it.`, "judge", { rationale: verdict.reason });
      }
      if (!verdict) {
        judgeNote = "judge unavailable — asking you instead";
        audit({ event: "auto_mode_judge_unavailable", toolName, actionHash: hash });
        if (ctx?.hasUI) ctx.ui?.notify?.(`tool-firewall: auto-mode judge unavailable for ${toolName} — falling back to manual approval`, "warning");
      }
    }

    // Ask a human.
    const precedent = statusFor(sig);
    const allowSession = !strict;
    const judged = trustAuto && cfg.learn;
    const scopeText = describeFamilies(families);
    const covers = allowSession ? (judged ? `exact repeats run; similar steps${scopeText ? ` (${scopeText})` : ""} are judged against this` : "exact repeats run") : undefined;
    const extras = { tier, trajectory: traj, judgeNote, precedent, hash, signature: sig, mode, policy: policyName, covers };
    const card = buildCard(a, extras);
    lastDetail = buildDetail(a, extras);
    const choices = choicesFor(allowSession, judged);
    const grant = () => {
      const g: SessionGrant = { at: Date.now(), session: s.id, tool: toolName, hash, tier, command: command !== null ? redact(command).slice(0, 1500) : summary, steps, reasons: [...new Set(a.findings.filter((f) => f.tier !== "low").map((f) => `[${f.tier}] ${f.detail}`))].slice(0, 6), chain, families, scopes };
      addGrant(root, g);
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
    };
    const denyReason = (note?: string) =>
      `tool-firewall: denied ${toolName} — the operator declined this action${note ? `: ${note}` : "."}${judgeView?.verdict === "block" ? ` (The auto-mode judge also flagged it: ${judgeView.reason}.)` : ""} Do not retry it; take a different approach or ask the user what they want.`;

    if (!ctx?.hasUI && policyName === "pentest" && tier === "high") return blocked(`tool-firewall: denied ${toolName} — ${summary}. The pentest policy does not approve high-impact actions without an interactive operator.`, "policy");

    if (ctx?.hasUI && typeof ctx.ui?.select === "function") {
      const choice = await ctx.ui.select(card, choices);
      if (choice === CHOICE_ALLOW_ONCE || isSessionChoice(choice)) {
        if (isSessionChoice(choice)) grant();
        record("allow", isSessionChoice(choice) ? "grant" : "card", undefined, choice);
        finish("allow", "human", { choice });
        return undefined;
      }
      let note: string | undefined;
      if (choice === CHOICE_DENY_TELL && typeof ctx.ui.input === "function") note = (await ctx.ui.input("Tell the agent why (it sees this):", "e.g. don't touch production; use the staging host"))?.trim() || undefined;
      record("deny", "card", note, choice ?? "dismissed");
      return blocked(denyReason(note), "human", { choice: choice ?? "dismissed" });
    }
    let approved: boolean;
    let source: FeedbackRecord["source"] = "card";
    let note: string | undefined;
    let picked: string | undefined;
    if (ctx?.hasUI && typeof ctx.ui?.confirm === "function") approved = await ctx.ui.confirm("Approve tool call?", card);
    else {
      source = "broker";
      // The console adds a title line; keep the whole request within the line budget.
      const res = await brokerApproval(toolName, input, tier, summary, buildCard(a, { ...extras, maxLines: CARD_MAX_LINES - 1 }), judgeNote ?? null, ctx, ctx?.signal, choices);
      approved = res.approved;
      note = res.note;
      picked = res.choice;
      if (res.timedOut) return blocked(`tool-firewall: denied ${toolName} — ${summary}. It needs operator approval and none arrived (headless). Ask the user, or choose a lower-impact approach.`, "broker_timeout");
      if (approved && isSessionChoice(res.choice)) {
        grant();
        source = "grant";
      }
    }
    if (!approved) {
      record("deny", source === "grant" ? "broker" : source, note, picked);
      return blocked(denyReason(note), "human");
    }
    record("allow", source, undefined, picked);
    finish("allow", "human");
    return undefined;
  }

  pi.registerCommand("firewall:reload", {
    description: "Reload the tool-firewall policy from disk",
    handler: async (_args: string, ctx: any) => {
      reloadPolicy();
      ctx.ui.notify(`tool-firewall: reloaded policy (${cachedPolicyLabel})`, "info");
      if (lastPolicyWarnings.length > 0) ctx.ui.notify(`tool-firewall: WARNING — ${lastPolicyWarnings.length} rule(s) skipped: ${lastPolicyWarnings.join("; ")}`, "warning");
    },
  });

  pi.registerCommand("firewall:status", {
    description: "Show tool-firewall status: policy, mode, judge, learning, session taint",
    handler: async (_args: string, ctx: any) => {
      const policy = getPolicy();
      const cfg = readConfig();
      const cwd = ctx?.cwd || process.cwd();
      const m = resolveMode(cwd, cfg);
      const p = resolvePolicy(cfg);
      const s = sessionFor(ctx);
      const learned = listLearned().filter((l) => l.status === "learned").length;
      const warningSuffix = lastPolicyWarnings.length > 0 ? ` skipped-rules=${lastPolicyWarnings.length}(!)` : "";
      ctx.ui.notify(
        [
          `tool-firewall: policy=${p.policy} (${p.source}) mode=${m.mode} (${m.source})`,
          `  rules: ${cachedPolicyLabel} default-unknown=${policy.defaults.unknown} tool-rules=${Object.keys(policy.tools).length} operator-rules=${policy.command_rules.deny.length}/${policy.command_rules.ask.length} pentest-rules=${policy.pentest.deny.length}/${policy.pentest.ask.length}${warningSuffix}`,
          `  judge model: ${judgeModelName(ctx, cfg) ?? "unset"} · learning ${cfg.learn ? "on" : "off"} (${learned} learned) · known hosts: ${[...knownHosts(cfg)].join(", ") || "none"}`,
          `  session: ${s.stats.actions} actions, ${s.stats.human} asked you, ${s.stats.judged} judged (${s.stats.judgeBlocks} blocked), ${readGrants(rootSessionId(s.id)).length} session allow(s)${s.credentialReads.length ? `, secret reads: ${s.credentialReads.map((c) => c.what).slice(-3).join(", ")}` : ""}${s.untrusted ? ", web/untrusted content seen" : ""}`,
          `  audit=${auditPath()} config=${configPath()}`,
        ].join("\n"),
        "info",
      );
    },
  });

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
        ctx.ui.notify(`auto-mode: ${enabled ? "enabled" : "disabled"}${eff.mode !== (enabled ? "auto" : "manual") ? ` (but ${eff.source} overrides it: ${eff.mode})` : ""}`, "info");
      } catch (error) {
        ctx.ui.notify(`auto-mode: could not ${enabled ? "enable" : "disable"} — failed to write ${configPath()} (${error instanceof Error ? error.message : String(error)})`, "error");
      }
      return;
    }
    if (opt === "status") {
      const cfg = readConfig();
      const m = resolveMode(cwd, cfg);
      ctx.ui.notify(`auto-mode: ${m.mode === "auto" ? "enabled" : "disabled"} (from ${m.source}) policy=${resolvePolicy(cfg).policy} model=${judgeModelName(ctx, cfg) ?? "unset (no session model available)"} learning=${cfg.learn ? "on" : "off"} state=${configPath()}`, "info");
      return;
    }
    if (opt === "learn") {
      const on = (rest[0] ?? "").toLowerCase();
      if (on !== "on" && on !== "off") return ctx.ui.notify("auto-mode: usage /auto learn on|off", "error");
      writeConfig({ learn: on === "on" });
      return ctx.ui.notify(`auto-mode: learning from your decisions ${on === "on" ? "on" : "off"}`, "info");
    }
    if (opt === "learned") {
      const all = listLearned();
      if (!all.length) return ctx.ui.notify(`auto-mode: no decisions recorded yet (${feedbackPath()})`, "info");
      return ctx.ui.notify(["auto-mode: precedents (signature — approvals/sessions/denials — status)", ...all.slice(0, 40).map((l) => `  ${l.sig} — ${l.approvals}/${l.sessions}/${l.denials} — ${l.status}`)].join("\n"), "info");
    }
    if (opt === "forget") {
      const sig = rest.join(" ");
      if (!sig) return ctx.ui.notify("auto-mode: usage /auto forget <signature> (a trailing * matches a prefix)", "error");
      return ctx.ui.notify(`auto-mode: forgot ${forget(sig)} decision(s)`, "info");
    }
    if (opt === "stats") {
      const s = sessionFor(ctx);
      const per100 = s.stats.actions ? ((s.stats.human / s.stats.actions) * 100).toFixed(1) : "0";
      return ctx.ui.notify(`auto-mode: this session ${s.stats.actions} actions · asked you ${s.stats.human} (${per100}/100) · judged ${s.stats.judged} (${s.stats.judgeBlocks} blocked) · learned hits ${s.stats.learnedHits} · session-allow repeats ${s.stats.grantHits} · denied ${s.stats.denied}`, "info");
    }
    if (opt === "profile") {
      const sub = (rest[0] ?? "").toLowerCase();
      if (sub === "reset") return ctx.ui.notify(resetProfile() ? "auto-mode: learned profile cleared (decisions are kept; it is rebuilt from them later)" : "auto-mode: no learned profile to clear", "info");
      if (sub === "rebuild") {
        const complete = d.complete === undefined ? modelCompleter(ctx, readConfig()) : d.complete;
        if (!complete) return ctx.ui.notify("auto-mode: no model available to rebuild the profile", "error");
        const p = await distill(complete).catch(() => null);
        return ctx.ui.notify(p ? `auto-mode: profile rebuilt from ${p.basedOn.decisions} decision(s) and ${p.basedOn.judgements} judgement(s)` : "auto-mode: profile rebuild failed (model gave no usable answer)", p ? "info" : "error");
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
      return ctx.ui.notify(lines.join("\n"), "info");
    }
    if (opt === "explain") {
      const s = sessionFor(ctx);
      const n = Math.max(1, Math.min(20, Number(rest[0]) || 5));
      const lines = s.recent.slice(-n).map((r) => `  ${r.outcome.padEnd(5)} ${r.tier.padEnd(8)} by ${r.decider.padEnd(9)} ${r.tool}: ${r.summary.slice(0, 120)}`);
      const last = lastDetail ? ["auto-mode: last approval request (full detail)", lastDetail, ""] : [];
      return ctx.ui.notify([...last, ...(lines.length ? ["auto-mode: recent decisions", ...lines] : ["auto-mode: no decisions yet this session"])].join("\n"), "info");
    }
    if (opt === "check") {
      const command = rest.join(" ");
      const cfg = readConfig();
      const env: ClassifyEnv = { cwd, workspace: workspaceRoot(cwd), home: homeDir(), tmpRoots: tmpRoots(), knownHosts: knownHosts(cfg), policy: resolvePolicy(cfg).policy };
      const a = classifyToolCall("bash", { command }, env, getPolicy().tools.bash, getPolicy().defaults.unknown);
      const auto = resolveMode(cwd, cfg).mode === "auto";
      const sigc = signatureOf(a, auto);
      return ctx.ui.notify(buildDetail(a, { tier: effectiveTier(a, auto), trajectory: [], hash: actionHash("bash", { command }), signature: sigc, mode: auto ? "auto" : "manual", policy: env.policy, covers: env.policy === "pentest" ? undefined : describeFamilies(familiesFromSignature(sigc)) || undefined }), "info");
    }
    ctx.ui.notify(`auto-mode: unknown option "${option}" — use status|on|off|explain [n]|learned|forget <sig>|learn on|off|stats|profile [rebuild|reset]|check <command>`, "error");
  };

  pi.registerCommand("auto", { description: "Auto mode: /auto [status|on|off|explain [n]|learned|forget <sig>|learn on|off|stats|profile [rebuild|reset]|check <command>]", handler: autoCommand });
  pi.registerCommand("auto-mode", { description: "Alias of /auto", handler: autoCommand });
  // Only once every hook is installed: a factory that failed earlier never registers.
  registerProtection("tool-firewall");
}

