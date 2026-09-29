#!/usr/bin/env node
// Supervisor for the autonomous improvement run (docs/autonomy.md).
//
//   node packages/autonomy/supervisor.mjs start  --config run.json
//   node packages/autonomy/supervisor.mjs resume --run <id>
//   node packages/autonomy/supervisor.mjs status --run <id>
//   node packages/autonomy/supervisor.mjs stop   --run <id>
//   node packages/autonomy/supervisor.mjs boundary --config run.json   (probe only)
//
// Deterministic: it starts containers, drives pi over RPC (lib/cycle.mjs), takes the agent's
// branch in, gates, tags and reviews each cycle, fast-forwards the integration branch
// (experimental/main) to every cycle that passes, publishes that branch and the run's tags to
// the operator's remote, and calls the manager model only on the events in lib/triggers.mjs.
// The run directory ($PI_AUTONOMY_HOME/<run>, default ~/.local/state/pi-autonomy/<run>) holds
// everything; nothing is written to ~/.pi.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readConfig, resolveConfig, writeJsonAtomic } from "./lib/config.mjs";
import { runStop, reportOutcome, nothingFoundInARow } from "./lib/triggers.mjs";
import { decide, openRouterComplete } from "./lib/manager.mjs";
import { reviewCycle } from "./lib/review.mjs";
import { lineParser, missingHarness } from "./lib/rpc.mjs";
import { runCycle } from "./lib/cycle.mjs";
import { BARE_REPO_CONFIG } from "./lib/mirror.mjs";
import * as gm from "./lib/gitmirror.mjs";
import * as dk from "./lib/docker.mjs";
import { meteredUsd } from "./relay.mjs";
import { modelEntries, agentModelsJson } from "./lib/models.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_HOME = process.env.PI_AUTONOMY_HOME || path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "pi-autonomy");

export function runPaths(run) {
  const root = path.join(STATE_HOME, run);
  return {
    root, config: path.join(root, "config.json"), state: path.join(root, "state.json"), log: path.join(root, "supervisor.log"),
    pid: path.join(root, "supervisor.pid"), stop: path.join(root, "STOP"), mirror: path.join(root, "mirror.git"),
    remote: path.join(root, "remote.git"), work: path.join(root, "work"), agentState: path.join(root, "agent-state"),
    meter: path.join(root, "meter"), bundles: path.join(root, "bundles"), gateWork: path.join(root, "gate-work"),
    cycles: path.join(root, "cycles"), tmp: path.join(root, "tmp"), references: path.join(root, "references"),
  };
}

// --- small process helpers ------------------------------------------------------------------
// The container engine binary, docker or podman (cfg.engine). Both take the same arguments
// here; lib/docker.mjs adds the podman-specific user-namespace flag.
let ENGINE = "docker";

function docker(args, { timeoutMs = 120_000, input, allowFail = false } = {}) {
  const r = spawnSync(ENGINE, args, { encoding: "utf8", timeout: timeoutMs, input, maxBuffer: 32 * 1024 * 1024 });
  if (r.error || r.status !== 0) {
    if (allowFail) return null;
    const err = r.error?.message ?? r.stderr.trim();
    throw new Error(`${ENGINE} ${args[0]} failed: ${/permission denied.*docker/i.test(err) ? `${err} (use "engine": "podman", or give your user Docker access; see docs/autonomy.md)` : err}`);
  }
  return r.stdout.trim();
}

/** Run a container to completion without blocking the event loop; resolves {code, stdout, stderr}. */
function dockerAsync(args, { timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(ENGINE, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (c) => { if (stdout.length < 4e6) stdout += c; });
    child.stderr.on("data", (c) => { if (stderr.length < 4e6) stderr += c; });
    const name = args[args.indexOf("--name") + 1];
    const timer = setTimeout(() => { spawnSync(ENGINE, ["rm", "-f", name], { stdio: "ignore", timeout: 30_000 }); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: String(e) }); });
  });
}

const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
const pad = (n) => String(n).padStart(2, "0");

function openRouterKey() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
  const entry = readJson(path.join(agentDir, "auth.json"), {})?.openrouter;
  const key = typeof entry === "string" ? entry : entry?.key;
  if (!key) throw new Error("No OpenRouter key: set OPENROUTER_API_KEY or log in to openrouter in pi (~/.pi/agent/auth.json)");
  return key;
}

// --- the run --------------------------------------------------------------------------------
class Run {
  constructor(cfg) {
    this.cfg = cfg;
    ENGINE = cfg.engine;
    this.p = runPaths(cfg.run);
    this.g = gm.hostGit(this.p.mirror);
    this.state = readJson(this.p.state, null);
    this.relay = null;
    this.signalled = false;
    this.lastPushed = null;
    this.lastPublishError = null;
  }

  log(line) {
    const out = `${new Date().toISOString()} ${line}`;
    console.log(out);
    fs.appendFileSync(this.p.log, out + "\n");
  }

  save() { writeJsonAtomic(this.p.state, this.state); }

  // Spend: the relay's meter (agent inference) plus the manager's own calls.
  spentUsd() {
    const read = (f) => { try { return meteredUsd(fs.readFileSync(path.join(this.p.meter, f), "utf8")); } catch { return 0; } };
    return read("usage.jsonl") + read("manager.jsonl");
  }

  preflight() {
    docker(["version"]);
    docker(["image", "inspect", this.cfg.image, "--format", "{{.Id}}"]);
    this.apiKey = openRouterKey();
  }

  // The run's model specs (context window, output limit, prices) for the agent's models.json.
  async writeModelSpecs() {
    let entries = [];
    try {
      const res = await fetch(`${this.cfg.upstream.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(30_000) });
      entries = modelEntries((await res.json()).data, this.cfg.models);
    } catch (e) { this.log(`model specs unavailable (${e.message}); pi falls back to its defaults`); }
    const missing = this.cfg.models.filter((id) => !entries.some((m) => m.id === id));
    if (missing.length) this.log(`model specs: ${missing.join(", ")} not in the upstream list`);
    fs.mkdirSync(this.p.agentState, { recursive: true });
    writeJsonAtomic(path.join(this.p.agentState, "run-models.json"), agentModelsJson(entries));
    for (const m of entries) this.log(`model ${m.id}: context ${m.contextWindow}, max output ${m.maxTokens}, $${m.cost.input}/$${m.cost.output} per M tokens`);
  }

  // Seed: mirror.git from the operator's remote; the integration branch adopted from the remote
  // (with main merged in when main has moved on) or created from main with the seed files; the
  // cycle's working branch at its head; the agent's bare repo.
  seed() {
    const { cfg, p } = this;
    if (fs.existsSync(p.state)) throw new Error(`run ${cfg.run} already exists at ${p.root}; use resume`);
    for (const d of [p.root, p.work, p.agentState, p.meter, p.bundles, p.gateWork, p.cycles, p.tmp]) fs.mkdirSync(d, { recursive: true });
    writeJsonAtomic(p.config, Object.fromEntries(Object.entries(cfg).filter(([k]) => !["branch", "integrationBranch", "tagPrefix", "reviewModel", "models"].includes(k))));
    gm.initMirror(p.mirror);
    const base = gm.fetchBase(this.g, cfg);
    if (gm.remoteHasRunTags(this.g, cfg)) throw new Error(`tags ${cfg.tagPrefix}* already exist on ${cfg.gitRemote}; pick a new run id`);
    const vars = { RUN: cfg.run, BRANCH: cfg.integrationBranch, BASE: base.slice(0, 12), BASE_REF: cfg.baseRef, DATE: new Date().toISOString().slice(0, 10), CYCLES: cfg.cycles };
    const seedArgs = { seedDir: path.join(HERE, "seed"), tmpDir: p.tmp, vars };
    const sync = gm.syncIntegration(this.g, cfg);
    if (sync.state === "absent") {
      gm.seedBranch(this.g, cfg, seedArgs);
      this.log(`created ${cfg.integrationBranch} from ${cfg.baseRef} ${base.slice(0, 12)} with the seed files`);
    } else {
      this.log(`continuing ${cfg.integrationBranch} at ${sync.head.slice(0, 12)}`);
      if (gm.fileAt(this.g, sync.head, "autonomy/CHARTER.md") === null) gm.seedBranch(this.g, cfg, { ...seedArgs, parent: sync.head });
      const m = gm.mergeBaseIntoIntegration(this.g, cfg);
      if (m.merged) this.log(`merged ${cfg.baseRef} ${base.slice(0, 12)} into ${cfg.integrationBranch} (${m.sha.slice(0, 12)})`);
      if (m.conflict) this.log(`${cfg.baseRef} does not merge cleanly into ${cfg.integrationBranch}; continuing without it (merge it by hand to bring it in)`);
    }
    const head = gm.startCycleBranch(this.g, cfg);
    // remote.git is created here while it is still pristine; after the agent starts the host
    // only reaches it through containers.
    spawnSync("git", ["init", "--quiet", "--bare", p.remote]);
    for (const [k, v] of BARE_REPO_CONFIG) spawnSync("git", ["--git-dir", p.remote, "config", k, v]);
    const pushed = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "--git-dir", p.mirror, "push", "--quiet", p.remote, `refs/heads/${cfg.branch}:refs/heads/${cfg.branch}`], { encoding: "utf8" });
    if (pushed.status !== 0) throw new Error(`seeding the agent repo failed: ${pushed.stderr}`);
    this.snapshotReferences();
    this.state = { run: cfg.run, createdAt: new Date().toISOString(), baseSha: base, seedSha: head, lastGoodSha: head,
      cyclesDone: 0, merged: 0, current: null, status: "running", history: [] };
    this.save();
    this.lastPushed = gm.publish(this.g, cfg, null).state;
    this.log(`run ${cfg.run} starts from ${cfg.integrationBranch} ${head.slice(0, 12)}; published to ${cfg.gitRemote}`);
  }

  // Reference repos: tracked files at HEAD only, so no .git internals or untracked local files
  // (credentials, .env) reach the container.
  snapshotReferences() {
    for (const [name, src] of Object.entries(this.cfg.references ?? {})) {
      const dest = path.join(this.p.references, name);
      fs.mkdirSync(dest, { recursive: true });
      const archive = spawnSync("git", ["-C", src, "archive", "--format=tar", "HEAD"], { maxBuffer: 512 * 1024 * 1024 });
      if (archive.status !== 0) throw new Error(`reference ${name}: git archive failed in ${src}`);
      const untar = spawnSync("tar", ["-x", "-C", dest], { input: archive.stdout });
      if (untar.status !== 0) throw new Error(`reference ${name}: extract failed`);
      const sha = spawnSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      this.log(`reference ${name}: ${src} at ${sha.slice(0, 12)} -> /reference/${name} (read-only)`);
    }
  }

  // --- containers ---
  networks() {
    for (const args of dk.networkCreateArgs(this.cfg)) {
      if (docker(["network", "inspect", args.at(-1)], { allowFail: true }) === null) docker(args);
    }
    if (docker(["network", "inspect", dk.names(this.cfg).net, "--format", "{{.Internal}}"]) !== "true") {
      throw new Error(`network ${dk.names(this.cfg).net} exists but is not internal; remove it and resume`);
    }
  }

  async startRelay() {
    const { cfg } = this;
    const n = dk.names(cfg);
    docker(["rm", "-f", n.relay], { allowFail: true });
    docker(dk.relayRunArgs(cfg, this.p, path.join(HERE, "relay.mjs")));
    docker(["network", "connect", "--alias", "inference", n.net, n.relay]);
    const child = spawn(ENGINE, dk.relayExecArgs(cfg), { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", (c) => fs.appendFileSync(path.join(this.p.meter, "relay.log"), c));
    child.stdin.end(JSON.stringify({ upstream: cfg.upstream, apiKey: this.apiKey, meterFile: "/meter/usage.jsonl",
      maxUsd: cfg.budget.totalUsd, models: cfg.models, headers: { "X-Title": `pi-autonomy ${cfg.run}` } }) + "\n");
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("relay did not start within 20s")), 20_000);
      child.stdout.on("data", (c) => { if (String(c).includes("ready")) { clearTimeout(timer); resolve(); } });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`relay exited (${code})`)); });
    });
    child.removeAllListeners("exit");
    child.on("exit", (code) => { if (this.relay === child) { this.relay = null; this.log(`relay exited (${code}); restarting on the next tick`); } });
    this.relay = child;
    this.log("relay ready");
  }

  async ensureRelay() { if (!this.relay) await this.startRelay(); }

  teardown() {
    const n = dk.names(this.cfg);
    this.relay?.kill(); this.relay = null;
    docker(["rm", "-f", n.relay], { allowFail: true });
    for (const net of [n.net, n.egress]) docker(["network", "rm", net], { allowFail: true });
  }

  // The boundary probe (tests/boundary-probe.mjs) in a container started with the agent's exact
  // arguments. Run before every start and resume; any failure stops the run before cycle work.
  async boundary() {
    const args = dk.agentRunArgs(this.cfg, this.p, { n: 0, attempt: "probe", reset: false }).filter((a) => a !== "-i");
    const at = args.lastIndexOf(this.cfg.image);
    const keyHash = createHash("sha256").update(this.apiKey).digest("hex");
    const probe = [...args.slice(0, at), "--env", `AUTONOMY_KEY_SHA256=${keyHash}`, "--mount", `type=bind,source=${path.join(HERE, "tests", "boundary-probe.mjs")},target=/probe.mjs,readonly`,
      "--entrypoint", "node", this.cfg.image, "/probe.mjs"];
    const r = await dockerAsync(probe, { timeoutMs: 180_000 });
    let report;
    try { report = JSON.parse(r.stdout.trim().split("\n").at(-1)); } catch { throw new Error(`boundary probe gave no report (exit ${r.code}): ${r.stderr.trim().slice(-500)}`); }
    fs.writeFileSync(path.join(this.p.root, "boundary.json"), JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2) + "\n");
    for (const c of report.checks) if (!c.ok) this.log(`boundary FAIL ${c.name}: ${c.detail}`);
    if (!report.pass) throw new Error(`boundary check failed (${report.checks.filter((c) => !c.ok).length} of ${report.checks.length}); see ${path.join(this.p.root, "boundary.json")}`);
    this.log(`boundary verified: ${report.checks.length} checks passed`);
  }

  // --- git mirroring ---
  async syncFromAgent() {
    const bundle = path.join(this.p.bundles, "agent.bundle");
    fs.rmSync(bundle, { force: true });
    const r = await dockerAsync(dk.bundleRunArgs(this.cfg, this.p), { timeoutMs: 120_000 });
    if (r.code !== 0 || !fs.existsSync(bundle)) return { error: `bundle failed: ${r.stderr.trim().slice(-300)}` };
    try {
      const res = gm.ingestBundle(this.g, this.cfg, bundle);
      if (res.diverged && !this.warnedDiverged) { this.warnedDiverged = true; this.log(`agent branch diverged from the accepted head (agent ${res.agent.slice(0, 12)}); not accepted`); }
      if (!res.diverged) this.warnedDiverged = false;
      return res;
    } catch (e) { return { error: e.message }; }
  }

  publishRemote() {
    try {
      const r = gm.publish(this.g, this.cfg, this.lastPushed);
      this.lastPushed = r.state;
      if (this.lastPublishError) { this.log("push to remote recovered"); this.lastPublishError = null; }
    } catch (e) {
      if (e.message !== this.lastPublishError) this.log(`push to remote failed (will retry): ${e.message}`);
      this.lastPublishError = e.message;
    }
  }

  headSha() { return this.g(["rev-parse", `refs/heads/${this.cfg.branch}`]); }

  // --- the post-cycle gate ---
  async gate(n, sha) {
    const dir = path.join(this.p.cycles, pad(n));
    const bundle = path.join(this.p.bundles, `gate-${pad(n)}.bundle`);
    gm.bundleBranch(this.g, this.cfg, bundle);
    fs.rmSync(this.p.gateWork, { recursive: true, force: true });
    fs.mkdirSync(this.p.gateWork, { recursive: true });
    const started = Date.now();
    const r = await dockerAsync(dk.gateRunArgs(this.cfg, this.p, { bundleFile: bundle, sha }), { timeoutMs: this.cfg.gate.timeoutMinutes * 60_000 });
    const detail = readJson(path.join(this.p.gateWork, "result.json"), null);
    try { fs.copyFileSync(path.join(this.p.gateWork, "gate.log"), path.join(dir, "gate.log")); } catch { /* no log */ }
    fs.rmSync(bundle, { force: true });
    // The container's exit status is the verdict; result.json is detail (written by gate.sh
    // after the checks, but in a container that also ran the branch's own code).
    const result = { sha, green: r.code === 0, exitCode: r.code, seconds: Math.round((Date.now() - started) / 1000),
      steps: Array.isArray(detail?.steps) ? detail.steps.slice(0, 20) : [], stderrTail: r.stderr.trim().slice(-2000) };
    writeJsonAtomic(path.join(dir, "gate.json"), result);
    return result;
  }

  // Point the agent's branch at sha (from mirror.git). extraRefs travel along, so an unmerged
  // cycle's tag appears in the agent's repo as attempts/<run>/cycle-NN.
  async setAgentBranch(sha, extraRefs = []) {
    const bundle = gm.bundleBranch(this.g, this.cfg, path.join(this.p.bundles, "setref.bundle"), extraRefs);
    const r = await dockerAsync(dk.setAgentRefRunArgs(this.cfg, this.p, { bundleFile: bundle, sha }), { timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`setting the agent's branch failed: ${r.stderr.trim().slice(-300)}`);
  }

  // A new cycle starts from the integration head: take in anything the operator pushed to it,
  // then move the working branch (host and agent) there.
  async startCycle(n) {
    const { cfg } = this;
    const sync = gm.syncIntegration(this.g, cfg);
    if (sync.state === "diverged") return { stop: "integration_diverged", detail: `${cfg.integrationBranch} on ${cfg.gitRemote} (${sync.remote.slice(0, 12)}) and here (${sync.head.slice(0, 12)}) have diverged; reconcile them, then resume` };
    if (sync.state === "absent") throw new Error(`${cfg.integrationBranch} exists neither here nor on ${cfg.gitRemote} (a run started before integration branches?); start a new run`);
    if (sync.state === "adopted") this.log(`${cfg.integrationBranch} moved on the remote; continuing from ${sync.head.slice(0, 12)}`);
    const head = gm.startCycleBranch(this.g, cfg);
    const last = this.state.history.at(-1);
    const extra = last && !last.merged && last.head !== head ? [`refs/tags/${cfg.tagPrefix}cycle-${pad(last.n)}`] : [];
    await this.setAgentBranch(head, extra);
    this.log(`cycle ${pad(n)} branch set to ${cfg.integrationBranch} ${head.slice(0, 12)}`);
    return { head };
  }

  // RESET_TO_LAST_GOOD: the working branch back to the integration head, host then agent.
  async resetToLastGood(n) {
    const res = gm.resetBranch(this.g, this.cfg, { abandonedTag: `abandoned-${pad(n)}` });
    this.publishRemote();
    await this.setAgentBranch(res.to);
    this.log(`reset ${this.cfg.branch} ${res.from.slice(0, 12)} -> ${res.to.slice(0, 12)} (abandoned head tagged ${this.cfg.tagPrefix}abandoned-${pad(n)})`);
  }

  // --- the agent ---
  startAgent(n, { attempt, onEvent, reset }) {
    const dir = path.join(this.p.cycles, pad(n));
    const events = fs.createWriteStream(path.join(dir, `events-${attempt}.jsonl`), { flags: "a" });
    const stderr = fs.createWriteStream(path.join(dir, `agent-${attempt}.log`), { flags: "a" });
    const child = spawn(ENGINE, dk.agentRunArgs(this.cfg, this.p, { n, attempt, reset }), { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.pipe(stderr);
    child.stdin.on("error", () => {});
    child.stdout.on("data", lineParser((msg) => {
      if (msg.type === "response" && msg.id === "harness-check") {
        const missing = missingHarness(msg);
        if (missing.length) {
          this.harnessFailure = `the kit harness did not load (missing commands: ${missing.join(", ")}); see ${path.join(dir, `agent-${attempt}.log`)}`;
          this.log(`HARNESS FAIL: ${this.harnessFailure}`);
        } else if (!this.harnessOk) { this.harnessOk = true; this.log("harness verified: kit commands registered"); }
        return;
      }
      // Streaming deltas and partial tool output are most of the volume and none of the signal.
      if (msg.type !== "message_update" && msg.type !== "tool_execution_update") events.write(JSON.stringify({ at: new Date().toISOString(), ...msg }) + "\n");
      onEvent(msg);
    }, (bad) => stderr.write(`[non-json stdout] ${bad.slice(0, 500)}\n`)));
    const exited = new Promise((resolve) => child.on("close", (code) => { events.end(); resolve({ code: code ?? 1 }); }));
    // Before any work: is the long-horizon harness loaded? (pi answers commands in order.)
    child.stdin.write(JSON.stringify({ id: "harness-check", type: "get_commands" }) + "\n");
    const name = dk.names(this.cfg).agent(n, attempt);
    this.agentName = name;
    return {
      send: (msg) => { if (child.stdin.writable) child.stdin.write(JSON.stringify(msg) + "\n"); },
      exited,
      stop: async () => {
        if (child.exitCode !== null) return;
        if (child.stdin.writable) { child.stdin.write(JSON.stringify({ type: "abort" }) + "\n"); child.stdin.end(); }
        const done = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 30_000))]);
        if (!done) { docker(["rm", "-f", name], { allowFail: true }); await exited; }
      },
    };
  }

  cycleDir(n) { return `autonomy/cycles/${this.cfg.run}/${pad(n)}`; }

  cyclePrompt(n) {
    const { cfg, state } = this;
    const last = state.history.at(-1);
    let previous = "This is the first cycle of this run; earlier runs' cycles, if any, are recorded under autonomy/cycles/.";
    if (last) {
      previous = `Cycle ${pad(last.n)} ended ${last.outcome} (${last.reason}); post-cycle gate ${last.gate}${last.gate === "red" ? ` (failing: ${last.gateFailing?.join(", ") || "see the gate log"})` : ""}; `;
      if (last.merged) {
        previous += `merged into ${cfg.integrationBranch}. Its report is ${this.cycleDir(last.n)}/report.md.`;
        if (last.mode === "improve") previous += " It was an improve cycle, so this cycle starts with a consolidation pass over what it changed (bugs, edge cases, missing tests, docs drift, leftover complexity) before anything else.";
        if (last.reportOutcome === "nothing found") previous += ` Its review found nothing to do${nothingFoundInARow(state.history) > 1 ? ` (${nothingFoundInARow(state.history)} cycles in a row)` : ""}; look where it did not (its review.md says what it checked), and consider improve mode.`;
      }
      else if (last.gate === "skipped") previous += last.outcome === "reset" ? `its work was abandoned (tag ${cfg.tagPrefix}abandoned-${pad(last.n)}).` : "it made no commits.";
      else previous += `not merged into ${cfg.integrationBranch}: ${last.mergeReason}. This cycle starts without that work. Its commits, report and handoff are on \`origin/attempts/${cfg.run}/cycle-${pad(last.n)}\`: read its ${this.cycleDir(last.n)}/report.md and HANDOFF.md there first, and bring over what is sound (cherry-pick, fix what the rejection names, re-verify) before new work.`;
    }
    const vars = { NN: pad(n), CYCLE: n, CYCLES: cfg.cycles, RUN: cfg.run, BRANCH: cfg.branch, INTEGRATION: cfg.integrationBranch, CYCLE_DIR: this.cycleDir(n), BASE_REF: cfg.baseRef,
      BUDGET_USD: cfg.budget.perCycleUsd, HARD_BUDGET_USD: cfg.budget.perCycleHardUsd, SOFT_HOURS: +(cfg.limits.softMinutes / 60).toFixed(1), HARD_HOURS: +(cfg.limits.hardMinutes / 60).toFixed(1), PREVIOUS: previous };
    return fs.readFileSync(path.join(HERE, "prompts", "cycle.md"), "utf8").replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.hasOwn(vars, k) ? String(vars[k]) : m));
  }

  // Host-side model calls (manager and merge review); their spend is metered with the run's.
  complete(model, { timeoutMs } = {}) {
    const meterFile = path.join(this.p.meter, "manager.jsonl");
    return openRouterComplete({
      apiKey: this.apiKey, model, upstream: this.cfg.upstream, timeoutMs,
      onUsage: (u) => fs.appendFileSync(meterFile, JSON.stringify({ at: new Date().toISOString(), model, costUsd: u.cost ?? 0 }) + "\n"),
    });
  }

  manager() {
    const complete = this.complete(this.cfg.managerModel);
    return (bundle) => decide(bundle, complete);
  }

  runtime(n, { resume }) {
    const dir = path.join(this.p.cycles, pad(n));
    const startSha = this.state.current?.startSha ?? this.headSha();
    const manager = this.manager();
    let firstLaunch = true;
    return {
      tickMs: this.cfg.mirrorSeconds * 1000,
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      startAgent: ({ attempt, onEvent }) => {
        // Uncommitted work from a previous cycle is discarded on the cycle's first launch; a
        // restarted session keeps the workspace.
        const reset = firstLaunch && !resume;
        firstLaunch = false;
        this.log(`cycle ${pad(n)} session ${attempt} starting${reset ? " (workspace reset to the branch)" : ""}`);
        return this.startAgent(n, { attempt, onEvent, reset });
      },
      headSha: async () => this.headSha(),
      reportExists: async () => gm.fileAt(this.g, `refs/heads/${this.cfg.branch}`, `${this.cycleDir(n)}/report.md`) !== null,
      meterUsd: async () => this.spentUsd(),
      totalUsd: async () => this.spentUsd(),
      stopRequested: () => this.signalled || Boolean(this.harnessFailure) || fs.existsSync(this.p.stop),
      manager: async (bundle) => {
        const d = await manager(bundle);
        fs.appendFileSync(path.join(dir, "decisions.jsonl"), JSON.stringify({ at: new Date().toISOString(), triggers: bundle.triggers, ...d }) + "\n");
        return d;
      },
      extras: async () => ({
        gitLog: gm.logSince(this.g, startSha, `refs/heads/${this.cfg.branch}`),
        plan: gm.fileAt(this.g, `refs/heads/${this.cfg.branch}`, `${this.cycleDir(n)}/plan.md`),
        handoff: gm.fileAt(this.g, `refs/heads/${this.cfg.branch}`, "autonomy/HANDOFF.md"),
      }),
      gates: async () => this.state.history.map((h) => h.gate).filter((g) => g === "green" || g === "red"),
      resetToLastGood: async () => { await this.syncFromAgent(); await this.resetToLastGood(n); },
      publish: async () => {
        await this.ensureRelay().catch((e) => this.log(`relay restart failed: ${e.message}`));
        const r = await this.syncFromAgent();
        if (r.error && r.error !== this.lastSyncError) this.log(`sync from agent: ${r.error}`);
        this.lastSyncError = r.error ?? null;
        this.publishRemote();
      },
      log: (line) => this.log(line),
    };
  }

  async loop() {
    const { cfg, p } = this;
    fs.writeFileSync(p.pid, String(process.pid));
    const onSignal = (sig) => { this.log(`${sig}: stopping after the current tick; resume continues this cycle`); this.signalled = true; };
    process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);
    try {
      this.networks();
      await this.writeModelSpecs();
      await this.startRelay();
      await this.boundary();
      for (;;) {
        const stop = this.signalled ? "signal" : runStop({ totalCostUsd: this.spentUsd(), cyclesDone: this.state.cyclesDone, stopFile: fs.existsSync(p.stop),
          nothingFoundInARow: this.state.current ? 0 : nothingFoundInARow(this.state.history) }, cfg);
        if (stop) { this.finish(stop); break; }
        const resume = Boolean(this.state.current);
        const n = this.state.current?.n ?? this.state.cyclesDone + 1;
        fs.mkdirSync(path.join(p.cycles, pad(n)), { recursive: true });
        if (!resume) {
          const started = await this.startCycle(n);
          if (started.stop) { this.log(started.detail); this.finish(started.stop); break; }
        }
        this.state.current = { n, startedAt: this.state.current?.startedAt ?? new Date().toISOString(), startSha: this.state.current?.startSha ?? this.headSha() };
        this.save();
        this.log(`cycle ${pad(n)}/${cfg.cycles} ${resume ? "resuming" : "starting"}; spent $${this.spentUsd().toFixed(2)} of $${cfg.budget.totalUsd}`);
        const result = await runCycle({
          n, cfg, rt: this.runtime(n, { resume }), prompt: this.cyclePrompt(n), cycleDir: this.cycleDir(n),
          restartBriefing: resume ? `The previous session of this cycle was interrupted. Re-read autonomy/HANDOFF.md and this cycle's files under ${this.cycleDir(n)}/, check \`git status\` and \`git log\`, then continue the cycle from where it stopped.` : undefined,
        });
        if (this.signalled) {
          this.state.status = "interrupted"; this.save();
          this.log(`cycle ${pad(n)} interrupted; state kept for resume`);
          break;
        }
        await this.closeCycle(n, result);
        if (this.harnessFailure) { this.finish("harness_missing"); break; }
        if (result.outcome === "aborted") { this.finish(fs.existsSync(p.stop) ? "stop_file" : "aborted"); break; }
      }
    } finally {
      this.teardown();
      fs.rmSync(p.pid, { force: true });
    }
  }

  // Gate, tag and (when it qualifies) review and merge the cycle into the integration branch.
  async closeCycle(n, result) {
    const { cfg } = this;
    await this.syncFromAgent();
    const sha = this.headSha();
    const start = this.g(["rev-parse", `refs/heads/${cfg.integrationBranch}`]);
    const changed = sha !== start;
    let gate = { green: false, skipped: true };
    if (changed) {
      this.log(`cycle ${pad(n)} gate on ${sha.slice(0, 12)}`);
      gate = await this.gate(n, sha);
    }
    const failing = (gate.steps ?? []).filter((s) => s.code !== 0).map((s) => s.name);
    const declared = result.outcome === "completed" ? reportOutcome(gm.fileAt(this.g, sha, `${this.cycleDir(n)}/report.md`)) : { outcome: null, mode: null };
    gm.tag(this.g, cfg, `cycle-${pad(n)}`, sha);
    const merge = await this.mergeDecision(n, { result, sha, start, changed, gate });
    if (merge.merge) {
      const r = gm.integrate(this.g, cfg, sha);
      merge.merged = r.merged;
      if (!r.merged) merge.reason = r.reason;
    }
    if (merge.merged) { this.state.lastGoodSha = sha; this.state.merged = (this.state.merged ?? 0) + 1; }
    this.publishRemote();
    const entry = { n, outcome: result.outcome, reason: result.reason, attempts: result.attempts, start, head: sha,
      gate: gate.skipped ? "skipped" : gate.green ? "green" : "red", gateFailing: failing,
      reportOutcome: declared.outcome, mode: declared.mode, merged: Boolean(merge.merged), mergeReason: merge.reason, review: merge.review ?? null, costUsd: +result.costUsd.toFixed(4),
      decisions: result.decisions.map(({ decision, reason, triggers }) => ({ decision, reason, triggers })),
      startedAt: this.state.current.startedAt, endedAt: new Date().toISOString() };
    writeJsonAtomic(path.join(this.p.cycles, pad(n), "summary.json"), entry);
    this.state.history.push(entry);
    this.state.cyclesDone = n;
    this.state.current = null;
    this.save();
    this.log(`cycle ${pad(n)} done: ${entry.outcome}, gate ${entry.gate}${failing.length ? ` (${failing.join(", ")})` : ""}, $${entry.costUsd}; tagged ${cfg.tagPrefix}cycle-${pad(n)}; ${entry.merged ? `merged into ${cfg.integrationBranch}` : `not merged (${entry.mergeReason})`}`);
  }

  // Only a completed, gate-green cycle with commits is reviewed; only a MERGE verdict merges.
  async mergeDecision(n, { result, sha, start, changed, gate }) {
    const { cfg } = this;
    if (!changed) return { merge: false, reason: "no commits" };
    if (result.outcome !== "completed") return { merge: false, reason: `cycle ${result.outcome} (${result.reason})` };
    if (!gate.green) return { merge: false, reason: "post-cycle gate red" };
    if (!cfg.integration.review) return { merge: true, reason: "gate green (review disabled)" };
    const at = (file) => gm.fileAt(this.g, sha, file);
    const diff = this.g(["diff", "--no-color", start, sha, "--", ".", ":(exclude)package-lock.json"], { allowFail: true });
    this.log(`cycle ${pad(n)} merge review (${cfg.reviewModel})`);
    const review = await reviewCycle({
      run: cfg.run, cycle: n, outcome: result.outcome, integrationBranch: cfg.integrationBranch, gateSteps: gate.steps,
      charter: at("autonomy/CHARTER.md"), report: at(`${this.cycleDir(n)}/report.md`), verify: at(`${this.cycleDir(n)}/verify.md`),
      gitLog: gm.logSince(this.g, start, sha), diff,
    }, this.complete(cfg.reviewModel, { timeoutMs: 300_000 }));
    writeJsonAtomic(path.join(this.p.cycles, pad(n), "review.json"), { at: new Date().toISOString(), model: cfg.reviewModel, ...review });
    const reason = `review ${review.verdict}: ${review.reason}${review.concerns.length ? ` Concerns: ${review.concerns.join("; ")}` : ""}`;
    return { merge: review.verdict === "MERGE", reason, review: review.verdict };
  }

  finish(reason) {
    // A signal is a service stop (systemctl stop, reboot), not a decision to end the run.
    this.state.status = reason === "cycles_done" ? "done" : reason === "signal" ? "interrupted" : "stopped";
    this.state.stopReason = reason;
    this.save();
    this.log(`run ${this.state.status}: ${reason}`);
  }
}

// --- CLI ------------------------------------------------------------------------------------
function arg(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

function alive(pidFile) {
  const pid = Number(readJson(pidFile, null));
  if (!pid) return null;
  try { process.kill(pid, 0); return pid; } catch { return null; }
}

function status(run) {
  const p = runPaths(run);
  const state = readJson(p.state, null);
  if (!state) throw new Error(`no run ${run} under ${STATE_HOME}`);
  const cfg = resolveConfig(readJson(p.config, {}));
  const runner = new Run(cfg);
  const pid = alive(p.pid);
  console.log(`run ${run}: ${pid ? `running (pid ${pid})` : state.status}${state.stopReason ? ` [${state.stopReason}]` : ""}${fs.existsSync(p.stop) ? " — STOP requested" : ""}`);
  console.log(`integration ${cfg.integrationBranch} on ${cfg.gitRemote}; cycles ${state.cyclesDone}/${cfg.cycles}, ${state.merged ?? 0} merged; spent $${runner.spentUsd().toFixed(2)} of $${cfg.budget.totalUsd}`);
  if (state.current) console.log(`current: cycle ${pad(state.current.n)} since ${state.current.startedAt} (${Math.round((Date.now() - Date.parse(state.current.startedAt)) / 60_000)} min)`);
  for (const h of state.history.slice(-10)) {
    console.log(`  ${pad(h.n)} ${h.outcome.padEnd(9)} ${(h.reportOutcome === "nothing found" ? "nothing" : h.mode ?? "-").padEnd(7)} gate ${h.gate.padEnd(7)} ${h.merged ? "merged " : "kept   "} $${h.costUsd.toFixed(2).padStart(6)} ${h.head.slice(0, 10)} ${h.decisions.map((d) => d.decision).join(",")}${h.merged ? "" : ` (${h.mergeReason ?? ""})`.slice(0, 120)}`);
  }
  if (state.current) {
    const decisions = path.join(p.cycles, pad(state.current.n), "decisions.jsonl");
    const last = fs.existsSync(decisions) ? fs.readFileSync(decisions, "utf8").trim().split("\n").at(-1) : null;
    if (last) { const d = JSON.parse(last); console.log(`last manager decision: ${d.decision} — ${d.reason}`); }
  }
  console.log(`logs: ${p.log}`);
}

async function main(argv) {
  const [cmd] = argv;
  if (cmd === "start") {
    const file = arg(argv, "--config");
    if (!file) throw new Error("start needs --config <run.json> (see packages/autonomy/run.example.json)");
    const cfg = readConfig(file);
    const runner = new Run(cfg);
    runner.preflight();
    runner.seed();
    await runner.loop();
  } else if (cmd === "resume") {
    const run = arg(argv, "--run");
    const p = runPaths(run ?? "");
    const raw = readJson(p.config, null);
    if (!raw) throw new Error(`no run ${run} under ${STATE_HOME}`);
    if (alive(p.pid)) throw new Error(`run ${run} is already running (pid ${alive(p.pid)})`);
    fs.rmSync(p.stop, { force: true });
    const runner = new Run(resolveConfig(raw));
    runner.preflight();
    runner.state.status = "running"; delete runner.state.stopReason; runner.save();
    runner.lastPushed = null;
    await runner.loop();
  } else if (cmd === "boundary") {
    // Standalone check before a run: networks, relay and the probe, no seeding, no cycles.
    const file = arg(argv, "--config");
    if (!file) throw new Error("boundary needs --config <run.json>");
    const runner = new Run(readConfig(file));
    runner.preflight();
    for (const d of [runner.p.root, runner.p.work, runner.p.agentState, runner.p.meter, runner.p.references]) fs.mkdirSync(d, { recursive: true });
    if (!fs.existsSync(runner.p.remote)) spawnSync("git", ["init", "--quiet", "--bare", runner.p.remote]);
    for (const name of Object.keys(runner.cfg.references ?? {})) fs.mkdirSync(path.join(runner.p.references, name), { recursive: true });
    try { runner.networks(); await runner.startRelay(); await runner.boundary(); } finally { runner.teardown(); }
  } else if (cmd === "status") {
    status(arg(argv, "--run") ?? "");
  } else if (cmd === "stop") {
    const p = runPaths(arg(argv, "--run") ?? "");
    if (!fs.existsSync(p.state)) throw new Error("no such run");
    fs.writeFileSync(p.stop, new Date().toISOString() + "\n");
    console.log(`STOP written; the supervisor closes the current cycle at its next tick (≤ ${readJson(p.config, {}).mirrorSeconds ?? 30}s), gates and tags it, then exits. resume continues with the next cycle.`);
  } else {
    console.log("usage: supervisor.mjs start --config run.json | boundary --config run.json | resume --run <id> | status --run <id> | stop --run <id>");
    process.exit(cmd ? 2 : 0);
  }
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] ?? "")) {
  main(process.argv.slice(2)).catch((e) => { console.error(`[autonomy] ${e.message}`); process.exit(1); });
}
