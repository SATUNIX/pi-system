// A deterministic FAKE runtime for the engine (tests/autonomy-run-smoke.mjs and friends). It is a
// test double, not a real provider run: no container is started, no model is called and no
// network is touched. What is real is everything the engine does with git and files: the host
// mirror, the worker's bare repository and workspace (a clone edited by scripted "sessions"),
// the bundle transport, write-area enforcement, and the acceptance checks, which are ACTUALLY
// EXECUTED (from the contract's definitions, in a clean clone of the accepted head with the
// held-out overlay applied and a scrubbed environment) so a fake worker cannot make a check pass
// by editing files in its own repository.
//
// A "session" is a script: an async function called once per turn with a context (write, commit,
// emit, spend, elapse, ask, exit ...). Time is virtual: sleep() advances a shared clock and runs
// pending turns, so a whole run takes milliseconds and is reproducible.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HostRepo } from "../lib/hostrepo.mjs";
import { BARE_REPO_CONFIG } from "../lib/mirror.mjs";
import { meteredUsd } from "../relay.mjs";

const GIT = ["-c", "core.hooksPath=/dev/null", "-c", "user.name=fake worker", "-c", "user.email=worker@example.invalid", "-c", "commit.gpgsign=false"];
const git = (cwd, args, opts = {}) => spawnSync("git", [...GIT, ...args], { cwd, encoding: "utf8", ...opts });

/** Thrown from a script (or a hook) to simulate the supervisor process being killed: no cleanup runs. */
export const kill = () => Object.assign(new Error("simulated kill of the supervisor"), { simulateKill: true });

/** Shared "container engine": which fake containers are alive. A crash leaves them behind, like a real one would. */
export class FakeEngine {
  constructor() { this.containers = new Set(); this.removed = []; }
}

export class FakeRuntime {
  /**
   * @param {{ store: object, cfg: object, contract: object, script?: Function, engine?: FakeEngine, clock?: {now: number}, review?: Function, boundary?: object,
   *   tickMs?: number, manager?: Function, checkTimeoutMs?: number, hooks?: { onSleep?: Function } }} o
   */
  constructor({ store, cfg, contract, script = async () => {}, engine = new FakeEngine(), clock = { now: Date.parse("2026-09-30T00:00:00Z") }, review, boundary, tickMs = 60_000, manager, checkTimeoutMs = 20_000, hooks = {} }) {
    Object.assign(this, { store, cfg, contract, script, engine, clock, tickMs, checkTimeoutMs, hooks });
    this.p = store.p;
    this.repo = new HostRepo({ gitDir: this.p.mirror, cfg });
    this.reviewFn = review ?? (() => ({ verdict: "APPROVE", reason: "matches the specification", concerns: [] }));
    this.managerFn = manager ?? (() => { throw new Error("no manager configured"); });
    this.boundaryReport = boundary ?? { pass: true, checks: [{ name: "fake boundary probe", ok: true, detail: "" }] };
    this.agents = new Map();
    this.logs = [];
    this.calls = { preflight: 0, prepare: 0, bringUp: 0, tearDown: 0, snapshot: 0, deploy: [], checks: [], reviews: [], workers: [] };
    this.uiResponses = [];
    this.serviceUp = false;
    this.workerProblemText = null;
    this.turnCount = 0;
    this.scriptError = null;
  }

  now() { return this.clock.now; }
  log(line) { this.logs.push(line); }

  async sleep(ms) {
    this.clock.now += ms;
    this.sleeps = (this.sleeps ?? 0) + 1;
    await this.hooks.onSleep?.(this, this.sleeps);
    await this.pump();
  }

  // --- zone ------------------------------------------------------------------------------------
  async preflight() { this.calls.preflight++; }

  async prepare() {
    this.calls.prepare++;
    this.repo.init();
    const baseSha = this.repo.seedBase();
    spawnSync("git", ["init", "--quiet", "--bare", this.p.remote]);
    for (const [k, v] of BARE_REPO_CONFIG) spawnSync("git", ["--git-dir", this.p.remote, "config", k, v]);
    const pushed = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "--git-dir", this.p.mirror, "push", "--quiet", this.p.remote, `refs/heads/${this.cfg.branch}:refs/heads/${this.cfg.branch}`], { encoding: "utf8" });
    if (pushed.status !== 0) throw new Error(`seeding the worker repository failed: ${pushed.stderr}`);
    const cloned = git(os.tmpdir(), ["clone", "--quiet", "--branch", this.cfg.branch, this.p.remote, this.p.work]);
    if (cloned.status !== 0) throw new Error(`cloning the workspace failed: ${cloned.stderr}`);
    return { baseSha };
  }

  async bringUp() {
    this.calls.bringUp++;
    if (!this.repo.g) this.repo.open();
    return this.boundaryReport;
  }

  async tearDown() { this.calls.tearDown++; }

  async cleanupOrphans() {
    const removed = [...this.engine.containers];
    for (const name of removed) { this.engine.containers.delete(name); this.engine.removed.push(name); }
    return removed;
  }

  workerProblem() { return this.workerProblemText; }

  // --- the worker ---------------------------------------------------------------------------------
  startWorker({ step, attempt, effort, onEvent, resetWorkspace }) {
    const name = `${this.cfg.namePrefix}-agent-${String(step).padStart(2, "0")}-${attempt}`;
    let resolveExit;
    const exited = new Promise((r) => { resolveExit = r; });
    const agent = { name, alive: true, queue: [], onEvent, exited, resolveExit, prompts: [], effort, attempt, step, resetWorkspace, aborted: false, openDialogs: new Set() };
    agent.send = (msg) => {
      if (!agent.alive) return;
      if (msg.type === "prompt" || msg.type === "steer") { agent.prompts.push(msg); agent.queue.push(msg); }
      else if (msg.type === "extension_ui_response") { this.uiResponses.push(msg); agent.openDialogs.delete(msg.id); }
      else if (msg.type === "abort") agent.aborted = true;
    };
    agent.stop = async () => { if (!agent.alive) return; agent.alive = false; this.engine.containers.delete(name); resolveExit({ code: 143 }); };
    if (resetWorkspace) this.resetWork();
    this.agents.set(name, agent);
    this.engine.containers.add(name);
    this.calls.workers.push({ name, step, attempt, effort });
    return agent;
  }

  async pump() {
    for (const agent of [...this.agents.values()]) {
      while (agent.alive && agent.queue.length) {
        const msg = agent.queue.shift();
        await this.runTurn(agent, msg);
      }
    }
  }

  async runTurn(agent, msg) {
    this.turnCount++;
    const rt = this;
    const flags = { settle: true, exit: null };
    const emit = (ev) => { if (agent.alive) agent.onEvent(ev); };
    emit({ type: "agent_start" });
    const ctx = {
      turn: this.turnCount, step: agent.step, attempt: agent.attempt, kind: msg.type, message: msg.message, prompts: agent.prompts.map((p) => p.message), effort: agent.effort, workspace: this.p.work, runtime: rt, agent,
      emit,
      write: (rel, content) => { const f = path.join(this.p.work, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); },
      read: (rel) => { try { return fs.readFileSync(path.join(this.p.work, rel), "utf8"); } catch { return null; } },
      remove: (rel) => fs.rmSync(path.join(this.p.work, rel), { recursive: true, force: true }),
      /** commit everything and push it to the bare repository, as a diligent worker would */
      commit: (message, { push = true } = {}) => {
        git(this.p.work, ["add", "-A"]);
        const c = git(this.p.work, ["commit", "--quiet", "-m", message]);
        if (c.status !== 0 && !/nothing to commit/.test(c.stdout + c.stderr)) throw new Error(`fake worker commit failed: ${c.stderr || c.stdout}`);
        if (push) { const r = git(this.p.work, ["push", "--quiet", "origin", `HEAD:refs/heads/${this.cfg.branch}`]); if (r.status !== 0) throw new Error(`fake worker push failed: ${r.stderr}`); }
      },
      git: (args) => git(this.p.work, args),
      spend: (usd) => { fs.mkdirSync(this.p.meter, { recursive: true }); fs.appendFileSync(path.join(this.p.meter, "usage.jsonl"), `${JSON.stringify({ at: new Date(this.clock.now).toISOString(), costUsd: usd, model: this.contract.model.worker })}\n`); },
      store: this.store,
      elapse: (minutes) => { this.clock.now += minutes * 60_000; },
      tool: (name, args = {}) => emit({ type: "tool_execution_start", toolName: name, args }),
      /** open a dialog the way pi extensions do; a question blocks the (fake) session until the supervisor stops it */
      ask: (req) => { const id = `q${this.turnCount}-${agent.openDialogs.size}-${Math.random().toString(36).slice(2, 6)}`; agent.openDialogs.add(id); emit({ type: "extension_ui_request", id, ...req }); return id; },
      exit: (code = 0) => { flags.exit = code; },
      crash: () => { flags.exit = 137; },
      hang: () => { flags.settle = false; },
      noSettle: () => { flags.settle = false; },
    };
    try {
      await this.script(ctx);
    } catch (error) {
      if (error?.simulateKill) throw error;
      this.scriptError = error;
      throw error;
    }
    if (!agent.alive) return;
    if (flags.exit !== null) { agent.alive = false; this.engine.containers.delete(agent.name); agent.resolveExit({ code: flags.exit }); return; }
    if (agent.openDialogs.size) return; // a dialog nobody answered: the (fake) session is waiting, like a real one
    if (flags.settle) emit({ type: "agent_settled" });
  }

  // --- git transport --------------------------------------------------------------------------------
  async snapshotWork() {
    this.calls.snapshot++;
    git(this.p.work, ["add", "-A", "--", ".", ":(exclude).pi"]);
    const diff = git(this.p.work, ["diff", "--cached", "--quiet"]);
    if (diff.status !== 0) git(this.p.work, ["commit", "--quiet", "-m", "checkpoint (uncommitted work)"]);
    const head = git(this.p.work, ["rev-parse", "HEAD"]).stdout.trim();
    const remoteHead = spawnSync("git", ["--git-dir", this.p.remote, "rev-parse", `refs/heads/${this.cfg.branch}`], { encoding: "utf8" }).stdout.trim();
    if (head !== remoteHead) git(this.p.work, ["push", "--quiet", "origin", `HEAD:refs/heads/${this.cfg.branch}`]);
  }

  async fetchWorkerBundle() {
    fs.mkdirSync(this.p.bundles, { recursive: true });
    const out = path.join(this.p.bundles, "agent.bundle");
    fs.rmSync(out, { force: true });
    const r = spawnSync("git", ["--git-dir", this.p.remote, "bundle", "create", "--quiet", out, `refs/heads/${this.cfg.branch}`], { encoding: "utf8" });
    return r.status === 0 ? { bundle: out } : { error: r.stderr.trim() };
  }

  async deploy({ sha }) {
    this.calls.deploy.push(sha);
    for (const s of this.contract.permissions.network.services) {
      s.workspaceMounts.forEach((m, i) => {
        const dest = path.join(this.p.deploy, s.name, String(i));
        fs.rmSync(dest, { recursive: true, force: true });
        fs.mkdirSync(dest, { recursive: true });
        const src = path.join(this.p.work, m.source);
        if (fs.existsSync(src) && !fs.lstatSync(src).isSymbolicLink()) fs.cpSync(src, dest, { recursive: true });
      });
    }
    this.serviceUp = true;
  }

  // --- trusted checks ---------------------------------------------------------------------------------
  async runCheck({ check, sha }) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "autonomy-fake-check-"));
    const started = Date.now();
    try {
      const bundle = path.join(tmp, "in.bundle");
      this.repo.bundleBranch(bundle);
      const clone = path.join(tmp, "src");
      spawnSync("git", ["clone", "--quiet", "--no-checkout", "--branch", this.cfg.branch, bundle, clone], { encoding: "utf8" });
      const co = git(clone, ["checkout", "--quiet", "--detach", sha]);
      if (co.status !== 0) return { exitCode: 125, timedOut: false, tail: `checkout failed: ${co.stderr}`, seconds: 0 };
      for (const o of this.contract.acceptance.overlay) {
        const from = path.join(this.p.overlay, o.target);
        const to = path.join(clone, o.target);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        fs.copyFileSync(from, to);
      }
      // The definition comes from the contract held in the run directory (checks.json), never from the clone.
      const defs = JSON.parse(fs.readFileSync(this.p.checks, "utf8")).checks;
      const def = defs.find((c) => c.id === check.id);
      this.calls.checks.push({ id: check.id, sha, definition: def.run });
      const cwd = path.join(clone, def.cwd ?? "");
      const env = { PATH: process.env.PATH, HOME: tmp, CI: "1", LANG: "C" };
      const timeoutMs = Math.min(def.timeoutMinutes * 60_000, this.checkTimeoutMs);
      const [cmd, args] = Array.isArray(def.run) ? [def.run[0], def.run.slice(1)] : ["sh", ["-c", def.run]];
      return await new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let out = ""; let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
        child.stdout.on("data", (c) => { if (out.length < 2e6) out += c; });
        child.stderr.on("data", (c) => { if (out.length < 2e6) out += c; });
        child.on("error", (e) => { clearTimeout(timer); resolve({ exitCode: 127, timedOut: false, tail: String(e.message), seconds: 0 }); });
        child.on("close", (code) => { clearTimeout(timer); resolve({ exitCode: code ?? 1, timedOut, tail: out.slice(-4000), seconds: Math.round((Date.now() - started) / 1000) }); });
      });
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  }

  async serviceHealth({ check }) {
    // A service is "up" once something has been deployed into it: its staged directory holds files.
    const dir = path.join(this.p.deploy, check.service, "0");
    const up = this.serviceUp && fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
    return { ok: up, detail: up ? `${check.service} answered ${check.expectStatus}` : `${check.service} is not serving yet` };
  }

  usageUsd() {
    try { return meteredUsd(fs.readFileSync(path.join(this.p.meter, "usage.jsonl"), "utf8")); } catch { return 0; }
  }

  async review(bundle) {
    this.calls.reviews.push(bundle);
    return this.reviewFn(bundle);
  }

  /** Host-side model calls (the manager and the merge review of self-improve): scripted, told which model was asked. */
  complete(model) { return async (system, user) => this.managerFn(system, user, model); }

  /** Point the worker's repository and workspace at the mirror's working branch (a new cycle, or a reset); unmerged cycles' tags become attempts/<run>/cycle-NN. */
  async setWorkerBranch(_sha, extraRefs = []) {
    const { branch, run } = this.cfg;
    spawnSync("git", ["--git-dir", this.p.remote, "fetch", "--quiet", "--no-tags", this.p.mirror, `+refs/heads/${branch}:refs/heads/${branch}`], { encoding: "utf8" });
    for (const ref of extraRefs) spawnSync("git", ["--git-dir", this.p.remote, "fetch", "--quiet", "--no-tags", this.p.mirror, `+${ref}:refs/heads/attempts/${run}/${ref.split("/").pop()}`], { encoding: "utf8" });
    this.resetWork();
  }

  resetWork() {
    const { branch } = this.cfg;
    git(this.p.work, ["fetch", "--quiet", "origin"]);
    git(this.p.work, ["checkout", "--quiet", "-B", branch, `origin/${branch}`]);
    git(this.p.work, ["reset", "--quiet", "--hard", `origin/${branch}`]);
    git(this.p.work, ["clean", "-fdq"]);
  }
}
