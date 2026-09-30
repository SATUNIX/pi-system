#!/usr/bin/env node
// pi-autonomy: the operator's CLI for bounded autonomous runs (docs/autonomy.md).
//
//   pi-autonomy templates                       what kinds of run exist
//   pi-autonomy init --template <id> [--out run.json] [flags]   write a run contract (prompts on a terminal, flags otherwise)
//   pi-autonomy plan --config run.json [--authorise --by <name>]   validate, show the resolved boundary and its digest
//   pi-autonomy start --config run.json [--yes] [--detach]        confirm the boundary, then run
//   pi-autonomy status [--run <id>]  pause|resume|steer|cancel --run <id>   manage a run
//   pi-autonomy promote --run <id>              carry out an approval-gated promotion
//   pi-autonomy export --run <id> [--out dir]   results, evidence, usage, decisions and the work
//   pi-autonomy boundary --config run.json [--probe]   the boundary alone, or the live container probe
//   pi-autonomy reconfigure --run <id> [flags]  the only way effort or budgets change for an existing run
//
// Every command accepts --json and then prints exactly one JSON object ({ ok: true, ... } or
// { ok: false, error, code }). Exit codes: 0 ok; 1 error; 2 usage or invalid contract; 3 refused
// (authorisation, duplicate, lock, illegal state); a foreground `start`/`resume` ends with 0
// succeeded, 10 failed, 11 cancelled, 12 budget_exhausted, 13 parked (blocked, paused, signalled).
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { authorisationStatus, boundaryDigest, decideStart, renderBoundary } from "./lib/boundary.mjs";
import { num, parseArgs } from "./lib/cli-args.mjs";
import { formatProblems, providerIds, resolveContract } from "./lib/contract.mjs";
import { effortApi } from "./lib/effort.mjs";
import { randomSuffix } from "./lib/fsutil.mjs";
import { Engine } from "./lib/engine.mjs";
import { exportRun } from "./lib/export.mjs";
import { HostRepo } from "./lib/hostrepo.mjs";
import { isTerminal, resumeAction, transition } from "./lib/lifecycle.mjs";
import { stateHome } from "./lib/paths.mjs";
import { planReconfigure } from "./lib/reconfigure.mjs";
import { createRun } from "./lib/rundir.mjs";
import { createRunLock } from "./lib/runlock.mjs";
import { runtimeConfig } from "./lib/runcfg.mjs";
import { RunStore, listRuns } from "./lib/store.mjs";
import { describeTemplates, TEMPLATES } from "./lib/templates/index.mjs";
import { DockerRuntime } from "./lib/runtime.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export class CliError extends Error {
  constructor(code, message, extra = {}) { super(message); this.cliCode = code; this.extra = extra; }
}
const EXIT = { usage: 2, invalid: 2, refused: 3, error: 1 };

export function defaultDeps() {
  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return {
    env: process.env, home: stateHome(), stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, isTTY, pid: process.pid,
    effort: undefined, now: () => new Date(), signals: true, lockOptions: {},
    runtimeFactory: ({ contract, cfg, store, env }) => new DockerRuntime({ contract, cfg, store, env }),
    /** Ask a yes/no question on the terminal. */
    confirm: async (question, { stdin = process.stdin, stdout = process.stdout } = {}) => {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try { return /^y(es)?$/i.test((await rl.question(`${question} [yes/no] `)).trim()); } finally { rl.close(); }
    },
    ask: async (question, def = "") => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try { const a = (await rl.question(def ? `${question} [${def}] ` : `${question} `)).trim(); return a || def; } finally { rl.close(); }
    },
    /** Start `cli.mjs supervise --run <id>` detached, logging to the run's supervisor.log. */
    spawnSupervisor: (run, store) => {
      fs.mkdirSync(store.p.root, { recursive: true });
      const fd = fs.openSync(store.p.log, "a");
      const child = spawn(process.execPath, [path.join(HERE, "cli.mjs"), "supervise", "--run", run], { detached: true, stdio: ["ignore", fd, fd], env: process.env });
      child.unref();
      return child.pid;
    },
  };
}

// --- helpers -----------------------------------------------------------------------------------------
function loadConfig(file, deps, { checkFs = true } = {}) {
  if (!file) throw new CliError("usage", "--config <run.json> is required (create one with `pi-autonomy init`)");
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (e) { throw new CliError("invalid", `cannot read ${file}: ${e.code ?? e.message}`); }
  let raw;
  try { raw = JSON.parse(text); } catch (e) { throw new CliError("invalid", `${file} is not valid JSON: ${e.message}`); }
  const r = resolveContract(raw, { baseDir: path.dirname(path.resolve(file)), effort: deps.effort, checkFs });
  return { ...r, raw, file: path.resolve(file) };
}

const effortFor = (deps) => effortApi(deps.effort);

const RUN_ID = /^[a-z0-9][a-z0-9-]{2,40}$/; // the contract's own rule (lib/contract.mjs): a run id names branches, containers and a directory

function openStore(run, deps) {
  if (!run) throw new CliError("usage", "--run <id> is required (list runs with `pi-autonomy status`)");
  if (!RUN_ID.test(String(run))) throw new CliError("usage", `--run ${JSON.stringify(String(run).slice(0, 60))} is not a run id (3-41 characters: lowercase letters, digits and -); \`pi-autonomy status\` lists them`);
  const store = new RunStore(run, { home: deps.home, now: deps.now });
  if (!store.exists()) throw new CliError("refused", `no run ${run} under ${deps.home}`);
  if (store.readStateRaw()?.schemaVersion === undefined) throw new CliError("refused", `run ${run} was written by the previous supervisor (the v0 format) and cannot be driven by this one. Its work is intact in ${store.p.root} (remote.git and mirror.git hold the branches and tags). Start a new run with \`pi-autonomy init --template self-improve\`, or export what you need with git.`);
  return store;
}

const lockFor = (store, deps) => createRunLock({ file: store.p.lock, pid: deps.pid, ...deps.lockOptions });

function liveSupervisor(store, deps) {
  const seen = lockFor(store, deps).inspect();
  return seen && seen.state !== "stale" ? seen : null;
}

/** Run `fn` holding the run lock, for commands that change state while no supervisor is running. */
async function offline(store, deps, fn) {
  const lock = lockFor(store, deps);
  const got = lock.acquire();
  if (!got.acquired) throw new CliError("refused", got.reason);
  try { return await fn(); } finally { lock.release(); }
}

function loadRun(store) {
  const state = store.readState();
  const contract = store.readContract();
  if (!contract) throw new CliError("error", `run ${store.run} has no contract.json`);
  return { state, contract, cfg: runtimeConfig(contract) };
}

async function cleanupOrphans(store, deps, { contract, cfg }) {
  try { return await deps.runtimeFactory({ contract, cfg, store, env: deps.env }).cleanupOrphans(); } catch { return []; }
}

const usd = (n) => `$${Number(n).toFixed(2)}`;

function statusReport(store, deps) {
  const { state, contract } = loadRun(store);
  const lock = lockFor(store, deps).inspect();
  const latest = state.acceptance.latest;
  return {
    run: state.run, template: state.template, status: state.status, phase: state.phase, outcome: state.outcome, blocker: state.blocker,
    supervisor: lock ? { state: lock.state, why: lock.why, pid: lock.holder?.pid ?? null, host: lock.holder?.host ?? null, heartbeatAt: lock.holder?.heartbeatAt ?? null } : null,
    step: state.step, usage: state.usage, limits: state.limits, effort: state.effort,
    tasks: state.tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, checks: t.checks })),
    acceptance: latest ? { step: latest.step, sha: latest.sha, allRequiredPass: latest.allRequiredPass, results: latest.results.map((r) => ({ id: r.id, required: r.required, pass: r.pass })) } : null,
    review: state.acceptance.review,
    recovery: { stalls: state.recovery.stalls, softNudgesUsed: state.recovery.softNudgesUsed, hardRestartsUsed: state.recovery.hardRestartsUsed, totals: state.recovery.totals, violations: state.recovery.violations },
    worker: state.worker, promotion: { status: state.promotion.status, error: state.promotion.error ?? null, targets: state.promotion.targets ?? [] },
    questions: state.pendingQuestions ?? [], ui: state.ui ?? null, reconfigurations: state.reconfigurations.length,
    selfImprove: state.selfImprove ? { cycles: state.selfImprove.history.length, merged: state.selfImprove.merged, current: state.selfImprove.current?.n ?? null } : null,
    history: state.history.slice(-8), boundaryDigest: state.boundaryDigest, authorisation: state.authorisation,
    paths: { root: store.p.root, log: store.p.log, results: store.p.results }, title: contract.objective.title,
  };
}

function statusText(s) {
  const lines = [`run ${s.run} (${s.template}): ${s.status}${s.outcome ? ` [${s.outcome.reason}]` : ""}${s.phase ? `, phase ${s.phase}` : ""}`, `  ${s.title}`];
  lines.push(`  supervisor: ${s.supervisor ? `${s.supervisor.state} (${s.supervisor.why})` : "none"}`);
  lines.push(`  step ${s.step}; spent ${usd(s.usage.usd)} of ${usd(s.limits.budget.totalUsd)}, ${s.usage.steps}/${s.limits.budget.maxSteps} steps, ${Math.round(s.usage.minutes)}/${s.limits.budget.maxMinutes} min; effort ${s.effort.tier} (cap ${s.effort.cap})`);
  if (s.blocker) lines.push(`  BLOCKED (${s.blocker.kind}): ${s.blocker.question}${s.blocker.options?.length ? ` [${s.blocker.options.join(" | ")}]` : ""}\n  answer with: pi-autonomy resume --run ${s.run} --answer "..."`);
  if (s.tasks.length) { lines.push("  task board (from trusted results):"); for (const t of s.tasks) lines.push(`    [${t.status}] ${t.id}: ${t.title}`); }
  if (s.acceptance) lines.push(`  acceptance @ step ${s.acceptance.step}: ${s.acceptance.results.map((r) => `${r.id} ${r.pass ? "PASS" : "FAIL"}`).join(", ")}${s.acceptance.allRequiredPass ? " (all required pass)" : ""}`);
  if (s.review?.status && s.review.status !== "skipped") lines.push(`  review: ${s.review.status}${s.review.reason ? ` - ${s.review.reason}` : ""}`);
  lines.push(`  recovery: ${s.recovery.softNudgesUsed} nudge(s), ${s.recovery.hardRestartsUsed} restart(s) this episode; totals ${s.recovery.totals.softNudges}/${s.recovery.totals.hardRestarts}`);
  if (s.selfImprove) lines.push(`  cycles: ${s.selfImprove.cycles} done, ${s.selfImprove.merged} merged${s.selfImprove.current ? `, cycle ${s.selfImprove.current} in progress` : ""}`);
  if (s.promotion.status !== "none") lines.push(`  promotion: ${s.promotion.status}${s.promotion.error ? ` (${s.promotion.error})` : ""}${s.promotion.status === "awaiting_approval" ? `; approve with: pi-autonomy promote --run ${s.run}` : ""}`);
  lines.push(`  logs: ${s.paths.log}`);
  return lines.join("\n");
}

const exitFor = (status) => ({ succeeded: 0, failed: 10, cancelled: 11, budget_exhausted: 12 }[status] ?? 13);

// --- commands -----------------------------------------------------------------------------------------
const commands = {
  async templates(argv) {
    parseArgs(argv, { flags: ["json"] });
    const templates = describeTemplates().map((d) => ({ ...d, defaults: TEMPLATES[d.id].defaults() }));
    return { data: { templates }, text: templates.map((t) => `${t.id.padEnd(13)} ${t.finite ? "finite" : "cycling"}  ${t.title}\n${" ".repeat(22)}${t.summary}\n${" ".repeat(22)}needs: ${t.requires.join("; ")}\n${" ".repeat(22)}try:   pi-autonomy init --template ${t.id}`).join("\n\n") };
  },

  async init(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["template", "out", "run", "title", "spec", "spec-file", "repo", "repo-url", "ref", "budget-usd", "step-usd", "max-steps", "max-minutes", "effort", "model", "manager-model", "review-model", "provider", "upstream", "key-env", "promotion", "promotion-repo", "promotion-url", "promotion-branch", "integration-branch", "engine", "image"], lists: ["check", "backlog", "egress", "write-area", "service", "mount", "health", "credential"], flags: ["json", "force", "unattended", "attended", "no-review", "yes"] });
    const interactive = deps.isTTY && !opts.json && !opts.yes;
    let template = opts.template;
    if (!template && interactive) template = await deps.ask(`Template (${Object.keys(TEMPLATES).join(", ")})`, "implement");
    if (!TEMPLATES[template]) throw new CliError("usage", `--template must be one of ${Object.keys(TEMPLATES).join(", ")} (see \`pi-autonomy templates\`)`);
    const ask = async (q, given, def) => (given !== undefined ? given : interactive ? await deps.ask(q, def) : def);
    const stamp = deps.now().toISOString().slice(0, 10).replace(/-/g, "");
    const run = await ask("Run id", opts.run, `${template === "self-improve" ? "improve" : template}-${stamp}-${randomSuffix(4)}`);
    const title = await ask("Title", opts.title, template === "self-improve" ? "Improve the repository in reviewed cycles" : undefined);
    const raw = { schemaVersion: 1, run, template, objective: { title }, inputs: {}, acceptance: { checks: [], review: !opts["no-review"] }, permissions: { network: {}, unattended: {} }, budget: {}, promotion: { policy: opts.promotion ?? (template === "self-improve" ? "local-branch" : "none") } };
    let spec = opts.spec;
    if (opts["spec-file"]) raw.objective.specFile = opts["spec-file"];
    else if (spec !== undefined) raw.objective.spec = spec;
    else if (interactive && template !== "self-improve") raw.objective.spec = await deps.ask("Specification (one line, or use --spec-file)", "");
    const repoPath = await ask("Repository path (blank for an empty start)", opts.repo, "");
    if (repoPath) raw.inputs.repository = { path: repoPath, ref: opts.ref ?? "main" };
    else if (opts["repo-url"]) raw.inputs.repository = { url: opts["repo-url"], ref: opts.ref ?? "main" };
    else raw.inputs.repository = null;
    for (const c of opts.check ?? []) {
      const i = c.indexOf("=");
      if (i < 1) throw new CliError("usage", `--check needs id=command (got ${JSON.stringify(c)})`);
      const cmd = c.slice(i + 1).trim();
      raw.acceptance.checks.push({ id: c.slice(0, i), run: cmd.startsWith("[") ? JSON.parse(cmd) : cmd, timeoutMinutes: 15, required: true });
    }
    if (!raw.acceptance.checks.length && interactive) {
      for (;;) { const c = await deps.ask("Acceptance check as id=command (blank to finish)", ""); if (!c) break; const i = c.indexOf("="); if (i > 0) raw.acceptance.checks.push({ id: c.slice(0, i), run: c.slice(i + 1).trim(), timeoutMinutes: 15, required: true }); }
    }
    raw.objective.backlog = (opts.backlog ?? []).map((b, i) => { const [id, ...t] = b.includes(":") ? b.split(":") : [`T${i + 1}`, b]; return { id: id.trim(), title: t.join(":").trim() }; });
    if (!raw.objective.backlog.length) delete raw.objective.backlog;
    // Unattended operation is the point of a run, and it is opt-in: written explicitly so the boundary shows it.
    const unattended = opts.attended ? false : opts.unattended ?? (interactive ? /^y/i.test(await deps.ask("Run without approval prompts inside the zone? (y/n)", "y")) : false);
    raw.permissions.unattended = { authorised: Boolean(unattended), autoApprove: Boolean(unattended) };
    const egress = opts.egress ?? [];
    raw.permissions.network.egress = egress.map((e) => { const [host, ...ports] = e.split(":"); return { host, ports: ports.length ? ports.map(Number) : [443] }; });
    if (opts["write-area"]) raw.permissions.writeAreas = opts["write-area"];
    if ((opts.credential ?? []).length) raw.permissions.credentials = { names: opts.credential };
    const services = (opts.service ?? []).map((s) => {
      const m = s.match(/^([^=]+)=(.+)@(\d+)$/);
      if (!m) throw new CliError("usage", `--service needs name=image@port (got ${JSON.stringify(s)})`);
      return { name: m[1], image: m[2], port: Number(m[3]), workspaceMounts: [], health: { path: "/" } };
    });
    for (const mo of opts.mount ?? []) { const m = mo.match(/^([^=]+)=([^:]+):(\/.+)$/); const svc = services.find((s) => s.name === m?.[1]); if (!svc) throw new CliError("usage", `--mount needs name=source:/target for a declared --service (got ${JSON.stringify(mo)})`); svc.workspaceMounts.push({ source: m[2], target: m[3] }); }
    for (const h of opts.health ?? []) { const m = h.match(/^([^=]+)=(\/.*)$/); const svc = services.find((s) => s.name === m?.[1]); if (!svc) throw new CliError("usage", `--health needs name=/path for a declared --service`); svc.health = { path: m[2] }; }
    if (services.length) { raw.permissions.network.services = services; raw.permissions.network.serviceImages = [...new Set(services.map((s) => s.image))]; }
    else if (template === "deploy") { const ex = JSON.parse(fs.readFileSync(path.join(HERE, "examples", "deploy.json"), "utf8")); raw.permissions.network.services = ex.permissions.network.services; raw.permissions.network.serviceImages = ex.permissions.network.serviceImages; if (!raw.acceptance.checks.some((c) => c.type === "service-health")) raw.acceptance.checks.push({ id: "service-up", type: "service-health", service: ex.permissions.network.services[0].name, path: "/", expectStatus: 200, required: true }); }
    const budget = { totalUsd: num(opts["budget-usd"], "budget-usd"), perStepUsd: num(opts["step-usd"], "step-usd"), maxSteps: num(opts["max-steps"], "max-steps"), maxMinutes: num(opts["max-minutes"], "max-minutes") };
    for (const [k, v] of Object.entries(budget)) if (v !== undefined) raw.budget[k] = v;
    if (!Object.keys(raw.budget).length) delete raw.budget;
    if (opts.effort) raw.effort = opts.effort;
    if (opts.model || opts.provider || opts["manager-model"] || opts["review-model"]) raw.model = { ...(opts.provider ? { provider: opts.provider } : {}), ...(opts.model ? { worker: opts.model } : {}), ...(opts["manager-model"] ? { manager: opts["manager-model"] } : {}), ...(opts["review-model"] ? { review: opts["review-model"] } : {}) };
    if (opts.upstream || opts["key-env"]) raw.providerSettings = { ...(opts.upstream ? { upstream: opts.upstream } : {}), ...(opts["key-env"] ? { apiKeyEnv: opts["key-env"] } : {}) };
    if (raw.promotion.policy === "local-branch") raw.promotion.destinations = [{ kind: "local-branch", ...(opts["promotion-repo"] ? { repo: opts["promotion-repo"] } : {}), branch: opts["promotion-branch"] ?? opts["integration-branch"] ?? (template === "self-improve" ? "pi-autonomy/integration" : `pi/${run}`) }];
    if (raw.promotion.policy === "push") raw.promotion.destinations = [{ kind: "git-remote", url: opts["promotion-url"], branch: opts["promotion-branch"] ?? `pi/${run}` }];
    if (template === "self-improve") raw.templateOptions = { integration: { branch: opts["integration-branch"] ?? "pi-autonomy/integration", review: !opts["no-review"] } };
    if (opts.engine || opts.image) raw.runtime = { ...(opts.engine ? { engine: opts.engine } : {}), ...(opts.image ? { image: opts.image } : {}) };
    const out = path.resolve(opts.out ?? "run.json");
    const r = resolveContract(raw, { baseDir: path.dirname(out), effort: deps.effort, checkFs: false });
    if (!r.ok && !opts.force) throw new CliError("invalid", `the contract is not valid yet:\n${formatProblems(r.problems)}\nFix the flags (or pass --force to write it anyway and edit it by hand).`, { problems: r.problems });
    // "wx" creates the file only if it does not exist, in one step: no window between checking and writing.
    try { fs.writeFileSync(out, `${JSON.stringify(raw, null, 2)}\n`, { flag: opts.force ? "w" : "wx" }); } catch (e) { if (e?.code === "EEXIST") throw new CliError("refused", `${out} exists; pass --force to overwrite it`); throw e; }
    return { data: { path: out, run, template, valid: r.ok, problems: r.problems, contract: raw, next: [`pi-autonomy plan --config ${out}`, `pi-autonomy start --config ${out}`] }, text: `wrote ${out}${r.problems.length ? `\n${formatProblems(r.problems)}` : ""}\nnext: pi-autonomy plan --config ${out}   (shows exactly what the run may touch, and its digest)` };
  },

  async plan(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["config", "by", "digest"], flags: ["json", "authorise", "authorize", "yes"] });
    const cfg = loadConfig(opts.config, deps);
    const authorise = opts.authorise || opts.authorize;
    if (!cfg.contract) throw new CliError("invalid", formatProblems(cfg.problems), { problems: cfg.problems });
    const b = renderBoundary(cfg.contract, { effort: effortFor(deps) });
    // --digest <hex>: authorise only the boundary the caller was shown. Without it, whatever the file holds at this moment is authorised.
    if (opts.digest !== undefined && authorise && opts.digest !== b.digest) throw new CliError("refused", `the boundary changed since it was shown to you (shown ${String(opts.digest).slice(0, 12)}, now ${b.digest.slice(0, 12)}): nothing was authorised. Run \`plan\` again and read it.`, { shown: opts.digest, digest: b.digest });
    const auth = authorisationStatus(cfg.contract, b.digest);
    const data = { ok: cfg.ok, run: cfg.contract.run, template: cfg.contract.template, legacy: cfg.legacy, problems: cfg.problems, digest: b.digest, boundary: b.json.boundary, invariants: b.json.invariants, authorisation: auth, effort: cfg.contract.effort };
    if (authorise) {
      if (!cfg.ok) throw new CliError("invalid", `cannot authorise an invalid contract:\n${formatProblems(cfg.problems)}`, { problems: cfg.problems });
      if (cfg.legacy) throw new CliError("refused", "a deprecated v0 config cannot carry an authorisation; write a schemaVersion 1 contract first (`init`)");
      const by = opts.by ?? os.userInfo().username;
      const ok = deps.isTTY && !opts.json ? await deps.confirm(`${b.text}\n\nAuthorise this boundary (digest ${b.digest.slice(0, 12)}) as ${by}?`) : Boolean(opts.yes);
      if (!ok) throw new CliError("refused", opts.yes === undefined && !deps.isTTY ? "no terminal to confirm on: pass --yes after showing the boundary to the person who owns it" : "not authorised");
      const raw = JSON.parse(fs.readFileSync(cfg.file, "utf8"));
      raw.authorisation = { boundaryDigest: b.digest, by, at: deps.now().toISOString() };
      fs.writeFileSync(cfg.file, `${JSON.stringify(raw, null, 2)}\n`);
      data.authorisation = { status: "authorised", by, at: raw.authorisation.at };
      data.wrote = cfg.file;
    }
    const text = [cfg.problems.length ? `${formatProblems(cfg.problems)}\n` : "", b.text, "", `authorisation: ${data.authorisation.status}${data.authorisation.status === "authorised" ? ` by ${data.authorisation.by} at ${data.authorisation.at}` : data.authorisation.status === "mismatch" ? " (the contract changed since it was authorised)" : ""}`, cfg.ok ? "" : "The contract has errors; fix them before starting."].filter((x) => x !== "").join("\n");
    return { data, text };
  },

  async boundary(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["config", "run"], flags: ["json", "probe"] });
    if (opts.run) {
      const store = openStore(opts.run, deps);
      const { state, contract } = loadRun(store);
      const effective = { ...contract, effort: state.effort, budget: state.limits.budget, recovery: state.limits.recovery };
      const b = renderBoundary(effective, { effort: effortFor(deps) });
      const probe = JSON.parse(fs.existsSync(store.p.boundary) ? fs.readFileSync(store.p.boundary, "utf8") : "null");
      return { data: { run: state.run, digest: b.digest, authorisedDigest: state.boundaryDigest, matchesAuthorisation: b.digest === state.boundaryDigest, boundary: b.json.boundary, invariants: b.json.invariants, lastProbe: probe }, text: `${b.text}\n\n${state.boundaryDigest === b.digest ? "matches the authorised boundary" : `differs from the authorised boundary ${state.boundaryDigest.slice(0, 12)} (effort or limits were reconfigured)`}${probe ? `\nlast probe: ${probe.checks.filter((c) => c.ok).length}/${probe.checks.length} passed at ${probe.at}` : ""}` };
    }
    const cfg = loadConfig(opts.config, deps);
    if (!cfg.ok) throw new CliError("invalid", formatProblems(cfg.problems), { problems: cfg.problems });
    const b = renderBoundary(cfg.contract, { effort: effortFor(deps) });
    if (!opts.probe) return { data: { digest: b.digest, boundary: b.json.boundary, invariants: b.json.invariants, problems: cfg.problems }, text: b.text };
    const report = await probeOnly(cfg.contract, deps);
    return { data: { digest: b.digest, probe: report, pass: report.pass }, text: `${report.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : `: ${c.detail}`}`).join("\n")}\nboundary ${report.pass ? "verified" : "NOT verified"} (${report.checks.filter((c) => c.ok).length}/${report.checks.length})`, exit: report.pass ? 0 : 3 };
  },

  async start(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["config", "by"], flags: ["json", "yes", "detach"] });
    const cfg = loadConfig(opts.config, deps);
    if (!cfg.ok) throw new CliError("invalid", `the contract has errors:\n${formatProblems(cfg.problems)}`, { problems: cfg.problems });
    if (cfg.legacy) deps.stderr.write("warning: deprecated v0 config mapped onto the self-improve template; write a schemaVersion 1 contract (`pi-autonomy init`)\n");
    const b = renderBoundary(cfg.contract, { effort: effortFor(deps) });
    const decision = decideStart({ contract: cfg.contract, digest: b.digest, yes: Boolean(opts.yes), isTTY: deps.isTTY && !opts.json });
    if (decision.action === "refuse") throw new CliError("refused", decision.message, { refusal: decision.code, digest: b.digest });
    if (!opts.json) deps.stdout.write(`${b.text}\n\n`);
    let authorisation = decision.authorisation;
    if (decision.action === "confirm") {
      const ok = await deps.confirm(`Authorise this boundary (digest ${b.digest.slice(0, 12)}) and start run ${cfg.contract.run}?`);
      if (!ok) throw new CliError("refused", "not authorised; nothing was started");
      authorisation = { boundaryDigest: b.digest, by: opts.by ?? os.userInfo().username, at: deps.now().toISOString(), via: "interactive" };
    } else if (authorisation.via === "tty-yes") authorisation = { ...authorisation, by: opts.by ?? os.userInfo().username, at: deps.now().toISOString() };
    let store;
    try { store = createRun({ contract: cfg.contract, authorisation, home: deps.home, now: deps.now, boundaryEffort: effortFor(deps) }); } catch (e) { throw new CliError("refused", e.message); }
    if (opts.detach) {
      const pid = deps.spawnSupervisor(cfg.contract.run, store);
      return { data: { run: cfg.contract.run, started: true, detached: true, pid, digest: b.digest, authorisation, root: store.p.root, log: store.p.log }, text: `run ${cfg.contract.run} started (supervisor pid ${pid}); follow it with: pi-autonomy status --run ${cfg.contract.run}` };
    }
    const state = await supervise(store, deps, {});
    return { data: { run: cfg.contract.run, started: true, detached: false, status: state.status, outcome: state.outcome, root: store.p.root }, text: `run ${state.run}: ${state.status}${state.outcome ? ` (${state.outcome.reason})` : ""}\nresults: pi-autonomy export --run ${state.run}`, exit: exitFor(state.status) };
  },

  /** Internal: become the supervisor of an existing run (used by --detach and by resume). */
  async supervise(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run"], flags: ["json"] });
    const store = openStore(opts.run, deps);
    const state = await supervise(store, deps, {});
    return { data: { run: state.run, status: state.status, outcome: state.outcome }, text: `run ${state.run}: ${state.status}`, exit: exitFor(state.status) };
  },

  async status(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run"], flags: ["json"] });
    if (!opts.run) {
      const runs = listRuns(deps.home);
      return { data: { runs, home: deps.home }, text: runs.length ? runs.map((r) => `${r.run.padEnd(28)} ${r.template.padEnd(12)} ${r.status}${r.outcome?.reason ? ` [${r.outcome.reason}]` : ""}${r.legacy ? " (written by the v0 supervisor; read-only)" : ""}`).join("\n") : `no runs under ${deps.home}` };
    }
    const report = statusReport(openStore(opts.run, deps), deps);
    return { data: report, text: statusText(report) };
  },

  async pause(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run", "reason"], flags: ["json"] });
    const store = openStore(opts.run, deps);
    const state = store.readState();
    if (isTerminal(state.status) || state.status === "budget_exhausted") throw new CliError("refused", `run ${state.run} is ${state.status}; nothing to pause`);
    if (state.status === "paused") return { data: { run: state.run, status: "paused", already: true }, text: "already paused" };
    if (liveSupervisor(store, deps)) { store.enqueue("pause", { reason: opts.reason ?? "operator" }); return { data: { run: state.run, delivered: "supervisor", note: "the supervisor pauses at its next tick" }, text: "pause sent to the running supervisor; it stops the worker and parks the run at its next tick" }; }
    const ctx = loadRun(store);
    await offline(store, deps, async () => { await cleanupOrphans(store, deps, ctx); store.transition("paused", { reason: opts.reason ?? "operator", by: "operator" }); });
    return { data: { run: state.run, status: "paused", delivered: "state" }, text: "no supervisor was running; the run is paused. `resume` continues it." };
  },

  async resume(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run", "answer"], flags: ["json", "approve", "deny", "detach"] });
    const store = openStore(opts.run, deps);
    const state = store.readState();
    const action = resumeAction(state, { answer: opts.answer, approve: opts.approve, deny: opts.deny });
    if (state.status === "succeeded" && ["pending", "awaiting_approval"].includes(state.promotion.status) === false) throw new CliError("refused", action.message);
    if (!action.ok && state.status !== "succeeded") throw new CliError("refused", action.message, { state: state.status });
    const live = liveSupervisor(store, deps);
    const deliver = () => {
      if (state.status === "paused") store.enqueue("unpause", {});
      if (state.status === "blocked") store.enqueue("answer", { text: opts.answer ?? "", approve: Boolean(opts.approve), deny: Boolean(opts.deny) });
    };
    if (live) { deliver(); return { data: { run: state.run, delivered: "supervisor", status: state.status }, text: `sent to the running supervisor (${live.why})` }; }
    deliver();
    if (opts.detach) { const pid = deps.spawnSupervisor(state.run, store); return { data: { run: state.run, resumed: true, detached: true, pid }, text: `run ${state.run} resumed (supervisor pid ${pid})` }; }
    const after = await supervise(store, deps, {});
    return { data: { run: after.run, resumed: true, status: after.status, outcome: after.outcome }, text: `run ${after.run}: ${after.status}${after.outcome ? ` (${after.outcome.reason})` : ""}`, exit: exitFor(after.status) };
  },

  async steer(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run", "message"], flags: ["json"] });
    if (!opts.message?.trim()) throw new CliError("usage", "--message <text> is required");
    const store = openStore(opts.run, deps);
    const state = store.readState();
    if (isTerminal(state.status)) throw new CliError("refused", `run ${state.run} is ${state.status}`);
    if (liveSupervisor(store, deps)) { store.enqueue("steer", { message: opts.message }); return { data: { run: state.run, delivered: "supervisor" }, text: "steering sent to the running supervisor" }; }
    await offline(store, deps, async () => { store.update((s) => { s.steers = [...(s.steers ?? []), { at: deps.now().toISOString(), message: opts.message.slice(0, 2000) }].slice(-50); return s; }); });
    return { data: { run: state.run, delivered: "state" }, text: "no supervisor is running; the message is recorded and reaches the worker when the run resumes" };
  },

  async cancel(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run", "reason"], flags: ["json"] });
    const store = openStore(opts.run, deps);
    const state = store.readState();
    if (isTerminal(state.status)) throw new CliError("refused", `run ${state.run} is already ${state.status}`);
    if (liveSupervisor(store, deps)) { store.enqueue("cancel", { reason: opts.reason ?? "operator" }); return { data: { run: state.run, delivered: "supervisor" }, text: "cancel sent to the running supervisor; it stops the worker, keeps the work and ends the run as cancelled" }; }
    const ctx = loadRun(store);
    await offline(store, deps, async () => { await cleanupOrphans(store, deps, ctx); store.transition("cancelled", { reason: "operator", detail: opts.reason ?? "operator", by: "operator" }); });
    return { data: { run: state.run, status: "cancelled", delivered: "state" }, text: "no supervisor was running; the run is cancelled" };
  },

  async promote(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run"], flags: ["json", "yes"] });
    const store = openStore(opts.run, deps);
    const { state, contract, cfg } = loadRun(store);
    if (state.status !== "succeeded") throw new CliError("refused", `only a succeeded run is promoted (this one is ${state.status})`);
    if (liveSupervisor(store, deps)) throw new CliError("refused", "a supervisor still owns this run; wait for it to finish");
    const repo = new HostRepo({ gitDir: store.p.mirror, cfg }).open();
    const sha = cfg.integrationBranch && repo.g(["rev-parse", "--verify", "--quiet", `refs/heads/${cfg.integrationBranch}`], { allowFail: true }) ? repo.g(["rev-parse", `refs/heads/${cfg.integrationBranch}`]) : repo.head();
    const engine = new Engine({ contract, cfg, store, rt: { repo, now: () => Date.now(), log: () => {} }, template: TEMPLATES[contract.template], effortApi: effortFor(deps) });
    engine.state = state;
    const targets = engine.template.promotion.targets(contract, cfg, sha);
    if (!targets.length) return { data: { run: state.run, status: "none", targets: [] }, text: "this run's promotion policy is none: nothing to promote. Use `export` to take the results out." };
    const approved = contract.promotion.requiresOperatorApproval ? (deps.isTTY && !opts.json ? await deps.confirm(`Promote ${sha.slice(0, 12)}:\n${targets.map((t) => `  - ${t.description}`).join("\n")}\nApprove?`) : Boolean(opts.yes)) : true;
    if (!approved) throw new CliError("refused", contract.promotion.requiresOperatorApproval ? `this promotion needs your approval: ${targets.map((t) => t.description).join("; ")}. Re-run with --yes, or from a terminal.` : "not approved");
    const r = await offline(store, deps, async () => engine.promote({ sha, approved: true }));
    if (r.status === "failed") throw new CliError("error", `promotion failed: ${r.error}`, { targets: r.targets.map((t) => t.description) });
    return { data: { run: state.run, status: r.status, sha, targets: r.targets.map((t) => t.description), done: r.done }, text: `promotion ${r.status}: ${r.targets.map((t) => t.description).join("; ")}` };
  },

  async export(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run", "out"], flags: ["json"] });
    const store = openStore(opts.run, deps);
    const { state, contract, cfg } = loadRun(store);
    const repo = new HostRepo({ gitDir: store.p.mirror, cfg });
    if (fs.existsSync(store.p.mirror)) repo.open();
    const out = path.resolve(opts.out ?? path.join(store.p.results, deps.now().toISOString().replace(/[:.]/g, "-")));
    let result;
    try { result = exportRun({ store, repo, contract, state, out, now: deps.now }); } catch (e) { throw new CliError("refused", e.message); }
    const m = result.manifest;
    return { data: { run: state.run, out: result.dir, status: m.status, outcome: m.outcome, head: m.head, files: m.files.map((f) => f.path), missing: m.missing, manifest: path.join(result.dir, "manifest.json") }, text: `exported ${m.files.length} file(s) for ${state.run} (${m.status}) to ${result.dir}${m.missing.length ? `\nnot available: ${m.missing.join(", ")}` : ""}` };
  },

  async reconfigure(argv, deps) {
    const { opts } = parseArgs(argv, { values: ["run", "effort", "effort-cap", "budget-usd", "step-usd", "max-steps", "max-minutes", "soft-nudges", "hard-restarts", "max-attempts", "reason"], flags: ["json", "yes"] });
    const store = openStore(opts.run, deps);
    const { state, contract } = loadRun(store);
    if (isTerminal(state.status)) throw new CliError("refused", `run ${state.run} is ${state.status}; reconfigure only changes runs that can still continue`);
    const changes = {};
    if (opts.effort || opts["effort-cap"]) changes.effort = { ...(opts.effort ? { tier: opts.effort } : {}), ...(opts["effort-cap"] ? { cap: opts["effort-cap"] } : {}) };
    const budget = { totalUsd: num(opts["budget-usd"], "budget-usd"), perStepUsd: num(opts["step-usd"], "step-usd"), maxSteps: num(opts["max-steps"], "max-steps"), maxMinutes: num(opts["max-minutes"], "max-minutes") };
    for (const [k, v] of Object.entries(budget)) if (v !== undefined) (changes.budget ??= {})[k] = v;
    const recovery = { softNudges: num(opts["soft-nudges"], "soft-nudges"), hardRestarts: num(opts["hard-restarts"], "hard-restarts"), maxAttemptsPerStep: num(opts["max-attempts"], "max-attempts") };
    for (const [k, v] of Object.entries(recovery)) if (v !== undefined) (changes.recovery ??= {})[k] = v;
    const plan = planReconfigure({ contract, state, changes, effort: effortFor(deps) });
    if (!plan.ok) throw new CliError("invalid", plan.problems.join("\n"), { problems: plan.problems });
    const summary = JSON.stringify({ before: plan.before, after: plan.after }, null, 2);
    const ok = deps.isTTY && !opts.json ? await deps.confirm(`Change this run's limits?\n${summary}\nThis is logged in the run's state.`) : Boolean(opts.yes);
    if (!ok) throw new CliError("refused", `reconfigure changes the run's effort or budgets, so it needs your confirmation: re-run with --yes (from a terminal it asks).\n${summary}`);
    if (liveSupervisor(store, deps)) { store.enqueue("reconfigure", { changes, by: "operator", reason: opts.reason }); return { data: { run: state.run, delivered: "supervisor", before: plan.before, after: plan.after }, text: "sent to the running supervisor; it applies the change at its next tick and logs it" }; }
    await offline(store, deps, async () => {
      store.update((s) => {
        s.reconfigurations = [...s.reconfigurations, { at: deps.now().toISOString(), by: "operator", before: plan.before, after: plan.after, reason: opts.reason ?? null }].slice(-200);
        s.effort = plan.next.effort; s.limits = plan.next.limits;
        return s.status === "budget_exhausted" ? transition(s, "paused", { reason: "limits raised", by: "reconfigure", at: deps.now().toISOString() }) : s;
      });
    });
    const now = store.readState();
    return { data: { run: state.run, delivered: "state", status: now.status, before: plan.before, after: plan.after }, text: `reconfigured (${Object.keys(changes).join(", ")}); the run is ${now.status}${now.status === "paused" ? ". Continue it with: pi-autonomy resume --run " + state.run : ""}` };
  },
};

// --- supervising a run ----------------------------------------------------------------------------------
/** Take the run lock, build the runtime and drive the engine until the run ends or parks. */
export async function supervise(store, deps, { runtime } = {}) {
  const { state, contract, cfg } = loadRun(store);
  const lock = lockFor(store, deps);
  const got = lock.acquire();
  if (!got.acquired) throw new CliError("refused", got.reason);
  if (isTerminal(state.status) && !(state.status === "succeeded" && ["pending", "awaiting_approval"].includes(state.promotion.status))) { lock.release(); throw new CliError("refused", resumeAction(state).message); }
  const rt = runtime ?? deps.runtimeFactory({ contract, cfg, store, env: deps.env });
  const engine = new Engine({ contract, cfg, store, rt, template: TEMPLATES[contract.template], lock, effortApi: effortFor(deps), deps: { exportRun: ({ engine: e, out }) => exportRun({ store, repo: rt.repo, contract, state: e.state, out }) } });
  const onSignal = () => { engine.signalled = true; };
  if (deps.signals) { process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal); }
  try {
    const takeover = ["running", "recovering"].includes(state.status) || Boolean(got.tookOver);
    if (state.status === "succeeded") { rt.repo.open?.(); engine.state = state; await engine.promote({ sha: rt.repo.head(), approved: false }); lock.release(); return store.readState(); }
    return await engine.run({ takeover });
  } finally {
    if (deps.signals) { process.off("SIGINT", onSignal); process.off("SIGTERM", onSignal); }
  }
}

/** The live container probe, standalone (`boundary --probe`): networks, relay, proxy, services and the probe, then teardown. */
async function probeOnly(contract, deps) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-autonomy-probe-"));
  const probeContract = { ...contract, run: `probe-${randomSuffix(6)}` };
  try {
    const store = createRun({ contract: probeContract, authorisation: { boundaryDigest: boundaryDigest(probeContract), by: "probe", at: deps.now().toISOString(), via: "probe" }, home, now: deps.now, boundaryEffort: effortFor(deps) });
    const cfg = runtimeConfig(probeContract);
    const rt = deps.runtimeFactory({ contract: probeContract, cfg, store, env: deps.env });
    await rt.preflight();
    fs.mkdirSync(store.p.remote, { recursive: true });
    spawnSync("git", ["init", "--quiet", "--bare", store.p.remote]);
    for (const name of Object.keys(cfg.references ?? {})) fs.mkdirSync(path.join(store.p.references, name), { recursive: true });
    try { return await rt.bringUp({ contract: probeContract, cfg, state: store.readState(), log: (l) => deps.stderr.write(`${l}\n`) }); } finally { await rt.tearDown(); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}

// --- entry ---------------------------------------------------------------------------------------------------
const USAGE = `usage: pi-autonomy <command> [options]   (add --json to any command)
  templates                              what kinds of run exist
  init --template <id> [--out run.json]  write a run contract (prompts on a terminal; flags otherwise)
  plan --config run.json [--authorise --by <name> --yes]   validate; show the resolved boundary and its digest
  start --config run.json [--yes] [--detach]               confirm the boundary, then run
  status [--run <id>]                    one run, or all runs
  pause | steer --message <text> | cancel --run <id>
  resume --run <id> [--answer <text> | --approve | --deny]
  promote --run <id> [--yes]             carry out an approval-gated promotion
  export --run <id> [--out <dir>]        results, evidence, usage, decisions, the work
  boundary --config run.json [--probe] | --run <id>
  reconfigure --run <id> [--effort E4 --effort-cap E4 --budget-usd n --step-usd n --max-steps n --max-minutes n --soft-nudges n --hard-restarts n --max-attempts n] [--yes]`;

/**
 * Run one command. Returns the exit code; writes to deps.stdout / deps.stderr.
 * @param {string[]} argv
 * @param {object} [overrides] dependency overrides (tests)
 */
export async function main(argv, overrides = {}) {
  const deps = { ...defaultDeps(), ...overrides };
  const [cmd, ...rest] = argv;
  const json = rest.includes("--json");
  const emit = (obj) => deps.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") { deps.stdout.write(`${USAGE}\n`); return cmd ? 0 : 2; }
  if (!commands[cmd]) { const msg = `unknown command ${cmd}`; if (json) emit({ ok: false, error: msg, code: "usage" }); else deps.stderr.write(`${msg}\n${USAGE}\n`); return EXIT.usage; }
  try {
    const r = await commands[cmd](rest, deps);
    if (json) emit({ ok: true, command: cmd, ...r.data });
    else if (r.text) deps.stdout.write(`${r.text}\n`);
    return r.exit ?? 0;
  } catch (e) {
    if (e?.simulateKill) throw e; // tests only: the fake runtime's stand-in for the process being killed is not a command error
    const code = e instanceof CliError ? e.cliCode : e?.code === "usage" ? "usage" : e?.code === "lock_lost" ? "refused" : "error";
    if (json) emit({ ok: false, command: cmd, error: e.message, code, ...(e.extra ?? {}) });
    else deps.stderr.write(`[pi-autonomy] ${e.message}\n`);
    return EXIT[code] ?? 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
