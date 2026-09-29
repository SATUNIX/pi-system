#!/usr/bin/env node
// Replays the tool firewall's analyser and decision matrix over real pi session transcripts.
//
// For every tool call the model made, it reports what the gate would decide today in each mode
// (manual / auto without a judge / strict), counts per tier, and lists every call that would ask
// or deny, so tuning is driven by real history instead of guesses. Nothing is executed.
//
//   node packages/core/firewall-replay.mjs [--sessions DIR] [--mode auto|manual] [--policy coding|pentest]
//                                          [--show low|medium|high|critical] [--json] [--limit N]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadModule } from "./eval/harness.mjs";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const sessionsDir = opt("--sessions", path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent"), "sessions"));
const mode = opt("--mode", "auto");
const policyName = opt("--policy", "coding");
const show = new Set((opt("--show", "medium,high,critical") || "").split(",").filter(Boolean));
const limit = Number(opt("--limit", "400"));
const asJson = args.includes("--json");

const C = await loadModule("extensions/tool-firewall/classify.ts");
const Cfg = await loadModule("extensions/tool-firewall/config.ts");
const policy = JSON.parse(fs.readFileSync(new URL("../extensions/src/tool-firewall/default-policy.json", import.meta.url), "utf8"));

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

const cfg = Cfg.readConfig();
const hosts = Cfg.knownHosts(cfg);
const tiers = { low: 0, medium: 0, high: 0, critical: 0 };
const outcomes = { allow: 0, judge: 0, ask: 0, deny: 0 };
// Session allows modelled per session file: the operator picks "Allow for this session" on
// every card, so later actions similar to an allowed one (a shared family or host/root scope)
// go to the judge instead of asking (not under the pentest policy). The judge may still ask.
let askWithLeases = 0;
const rows = [];
let calls = 0;

for (const file of walk(sessionsDir)) {
  let cwd = os.homedir();
  const leased = new Set();
  const scoped = new Set();
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (const line of lines) {
    if (!line) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "session" && e.cwd) cwd = e.cwd;
    const content = e?.message?.role === "assistant" ? e.message.content : null;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (part?.type !== "toolCall") continue;
      calls++;
      const env = { cwd, workspace: Cfg.workspaceRoot(cwd), home: os.homedir(), tmpRoots: Cfg.tmpRoots(), knownHosts: hosts, policy: policyName };
      const rule = policy.tools?.[part.name];
      const a = C.classifyToolCall(part.name, part.arguments ?? {}, env, rule, policy.defaults?.unknown ?? "ask");
      const tier = C.effectiveTier(a, mode === "auto");
      tiers[tier]++;
      let outcome;
      if (tier === "critical") outcome = "deny";
      else if (tier === "low") outcome = "allow";
      else if (tier === "medium") outcome = mode === "auto" && policyName === "coding" ? "judge" : "ask";
      else outcome = "ask";
      outcomes[outcome]++;
      if (outcome === "ask") {
        const fams = C.familiesOf(a, mode === "auto");
        const scopes = [...new Set(a.findings.filter((f) => f.tier !== "low" && f.scope && f.scope !== "local").map((f) => f.scope))];
        const similar = fams.some((f) => leased.has(f)) || scopes.some((x) => scoped.has(x));
        if (policyName === "pentest" || !similar) {
          askWithLeases++;
          if (policyName !== "pentest") {
            for (const f of fams) leased.add(f);
            for (const x of scopes) scoped.add(x);
          }
        }
      }
      if (show.has(tier)) rows.push({ tier, outcome, tool: part.name, cwd, command: (part.arguments?.command ?? part.arguments?.path ?? JSON.stringify(part.arguments ?? {})).toString(), why: C.summarize(a, mode === "auto") || a.summary, sig: C.signatureOf(a, mode === "auto") });
    }
  }
}

if (asJson) {
  console.log(JSON.stringify({ calls, mode, policy: policyName, tiers, outcomes, askWithLeases, rows }, null, 2));
} else {
  console.log(`[firewall-replay] ${calls} tool calls from ${sessionsDir} (mode=${mode}, policy=${policyName}, known hosts: ${[...hosts].join(", ") || "none"})`);
  console.log(`  tiers:    low ${tiers.low}  medium ${tiers.medium}  high ${tiers.high}  critical ${tiers.critical}`);
  console.log(`  outcome:  allow ${outcomes.allow}  judge ${outcomes.judge}  ask-human ${outcomes.ask}  deny ${outcomes.deny}`);
  console.log(`  ask-human if every card is answered "allow for this session" (similar steps judged instead): ${askWithLeases}`);
  for (const r of rows.slice(0, limit)) {
    console.log(`\n  [${r.tier}/${r.outcome}] ${r.tool}: ${r.command.replace(/\s+/g, " ").slice(0, 220)}`);
    console.log(`      why: ${r.why.slice(0, 220)}`);
  }
}
