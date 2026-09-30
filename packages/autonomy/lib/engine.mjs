// The generic run engine. It owns everything that must not vary between kinds of run: the
// lifecycle and its persistence, the single-owner lock, the boundary checks, budgets and hard
// limits, control commands (pause, resume, steer, cancel, answer, reconfigure), the worker
// session, trusted acceptance evaluation, independent review, bounded recovery, promotion and
// evidence. A template (lib/templates/*) supplies the prompts and, for self-improve, its own
// step. Everything that touches containers, git transport, the clock or a model comes in
// through the runtime `rt` (lib/runtime.mjs for real, packages/autonomy/tests/fake-runtime.mjs
// for the offline tests).
//
// Runtime interface (rt):
//   repo: HostRepo, tickMs, now(), sleep(ms), log(line)
//   preflight(), prepare(ctx), bringUp(ctx) -> { pass, checks }, tearDown(), cleanupOrphans() -> [names]
//   startWorker({ step, attempt, resetWorkspace, effort, onEvent }) -> { name, send(msg), stop(), exited }
//   snapshotWork({ message }), fetchWorkerBundle() -> { bundle } | { error }
//   deploy({ sha }), runCheck({ check, sha }), serviceHealth({ check })
//   usageUsd(), review(bundle) -> { verdict, reason, concerns }, workerProblem?()
import fs from "node:fs";
import path from "node:path";
import { runAcceptance, summariseEvaluation } from "./acceptance.mjs";
import { buildBriefing } from "./briefing.mjs";
import { contractDigest } from "./contract.mjs";
import { applyResultsToBoard, resumeAction, transition } from "./lifecycle.mjs";
import { runPromotions } from "./promotion.mjs";
import { activityLine, operatorDecision } from "./rpc.mjs";
import { currentTarget, decideRecovery, newlyPassing } from "./recovery.mjs";
import { planReconfigure } from "./reconfigure.mjs";
import { clip } from "./templates/common.mjs";
import { BoundaryError, LockLost } from "./errors.mjs";
import { writeJsonAtomic } from "./fsutil.mjs";

export const IDLE_MINUTES = 20; // a worker session that emits nothing for this long is treated as stalled
export const MAX_ACTIVITY_LINES = 60;
const TERMINAL = ["succeeded", "failed", "cancelled"];

export { BoundaryError, LockLost };

export class Engine {
  /**
   * @param {{ contract: object, cfg: object, store: import("./store.mjs").RunStore, rt: object, template: object, lock?: object, effortApi?: object, deps?: object, log?: Function }} o
   */
  constructor({ contract, cfg, store, rt, template, lock = null, effortApi, deps = {}, log }) {
    Object.assign(this, { contract, cfg, store, rt, template, lock, effortApi, deps });
    this.repo = rt.repo;
    this.log = log ?? ((line) => { store.log(line); rt.log?.(line); });
    this.state = null;
    this.session = null;
    this.lastTickAt = null;
    this.lockLost = false;
    this.signalled = false;
    this.pendingFeedback = [];
    this.startReason = "first";
    this.lastEvaluation = null;
    this.lastActivity = [];
    this.uiAnswered = 0;
  }

  // --- state helpers ----------------------------------------------------------------------------
  save(fn) {
    if (fn) fn(this.state);
    this.state.updatedAt = new Date(this.rt.now()).toISOString();
    this.store.writeState(this.state);
  }

  go(to, info = {}) {
    const next = transition(this.state, to, { at: new Date(this.rt.now()).toISOString(), ...info });
    // In place, so every holder of `this.state` (a step that started before the transition) keeps seeing the live record.
    for (const k of Object.keys(this.state)) if (!(k in next)) delete this.state[k];
    Object.assign(this.state, next);
    this.store.writeState(this.state);
    this.log(`state ${to}${info.reason ? ` (${info.reason})` : ""}`);
  }

  get status() { return this.state.status; }
  get active() { return this.state.status === "running" || this.state.status === "recovering"; }
  stepDir(n = this.state.step) { return path.join(this.store.p.steps, String(n).padStart(2, "0")); }

  /** Accrue active minutes and check the contract has not changed under the run. */
  tick() {
    const now = this.rt.now();
    if (this.lastTickAt !== null && this.active) this.state.usage.minutes += (now - this.lastTickAt) / 60_000;
    this.lastTickAt = now;
    this.verifyContractIntact();
  }

  /** Spend only ever goes up: the higher of what state recorded and what the meters show now. */
  async refreshUsage() {
    const metered = await this.rt.usageUsd();
    if (metered > this.state.usage.usd) this.state.usage.usd = metered;
  }

  verifyContractIntact() {
    let digest;
    try { digest = contractDigest(JSON.parse(fs.readFileSync(this.store.p.contract, "utf8"))); } catch { digest = null; }
    if (digest !== this.state.contractDigest) throw new BoundaryError(`contract.json no longer matches the digest recorded when the run started (${digest ? digest.slice(0, 12) : "unreadable"} vs ${this.state.contractDigest.slice(0, 12)}): the run's definition was changed underneath it`);
  }

  limitReached({ atStepBoundary = false } = {}) {
    const s = this.state;
    const b = s.limits.budget;
    if (s.usage.usd >= b.totalUsd) return "total_usd";
    if (s.usage.minutes >= b.maxMinutes) return "max_minutes";
    if (atStepBoundary && s.usage.steps >= b.maxSteps) return "max_steps";
    return null;
  }

  ctx(extra = {}) {
    const publish = (name, text) => { fs.mkdirSync(this.store.p.public, { recursive: true }); fs.writeFileSync(path.join(this.store.p.public, path.basename(name)), text, { mode: 0o444 }); };
    return { engine: this, contract: this.contract, cfg: this.cfg, state: this.state, rt: this.rt, repo: this.repo, store: this.store, log: this.log, step: this.state.step, effort: this.state.effort, save: (fn) => this.save(fn), publish, ...extra };
  }

  // --- the run ---------------------------------------------------------------------------------
  /** Run (or resume) the supervisor loop until the run ends or parks. Returns the final state. */
  async run({ takeover = false } = {}) {
    let crashed = false;
    this.state = this.store.readState();
    try {
      if (this.lock) this.lock.start(() => { this.lockLost = true; });
      this.verifyContractIntact();
      if (takeover) {
        const removed = await this.rt.cleanupOrphans();
        if (removed.length) this.log(`removed ${removed.length} orphaned container(s) left by the previous supervisor: ${removed.join(", ")}`);
        this.save((s) => { s.worker = null; });
        this.startReason = "supervisor_restart";
      }
      if (this.status === "setup") await this.setup();
      else if (!["succeeded", "failed", "cancelled"].includes(this.status) && !(this.status === "budget_exhausted" && !this.store.pending().some((m) => m.kind === "reconfigure"))) await this.bringUp(); // the probe runs again on every resume
      if (this.status === "ready") this.go("running", { reason: "starting" });
      await this.loop();
    } catch (error) {
      if (error?.simulateKill) { crashed = true; throw error; }
      await this.handleFatal(error);
    } finally {
      // A supervisor that lost its lock must not touch state or containers: another one owns the run now.
      if (!crashed && !this.lockLost) {
        try { await this.stopWorker("supervisor exit"); } catch { /* best effort */ }
        try { await this.rt.tearDown(); } catch (e) { this.log(`teardown: ${e.message}`); }
        try { this.save(); } catch { /* ignore */ }
        this.lock?.release();
      }
    }
    return this.state;
  }

  async handleFatal(error) {
    if (error instanceof LockLost) { this.log("lock lost: another supervisor took over this run; stopping without touching state"); throw error; }
    if (error instanceof BoundaryError) {
      this.log(`BOUNDARY VIOLATION: ${error.message}`);
      try { await this.stopWorker("boundary violation"); } catch { /* ignore */ }
      if (TERMINAL.includes(this.status) || this.status === "budget_exhausted") { this.save((s) => { s.lastError = error.message; }); return; }
      this.go("failed", { reason: "boundary_violation", detail: error.message });
      return;
    }
    this.log(`fatal: ${error.stack ?? error.message}`);
    try { this.save((s) => { s.lastError = String(error.message).slice(0, 1000); }); } catch { /* ignore */ }
    throw error; // the run stays in its state and can be resumed
  }

  async setup() {
    const { rt, contract } = this;
    this.state.setup ??= {};
    await rt.preflight(contract);
    if (!this.state.setup.preparedAt) {
      const prep = await rt.prepare({ contract, cfg: this.cfg, state: this.state, log: this.log });
      this.save((s) => { s.setup.preparedAt = new Date(rt.now()).toISOString(); s.setup.base = prep?.baseSha ?? null; });
      this.log(`workspace prepared${prep?.baseSha ? ` from ${prep.baseSha.slice(0, 12)}` : ""}`);
    }
    if (this.template.seed) await this.template.seed(this.ctx());
    await this.bringUp();
    this.go("ready", { reason: "setup complete" });
  }

  async bringUp() {
    const report = await this.rt.bringUp({ contract: this.contract, cfg: this.cfg, state: this.state, log: this.log });
    if (report && report.pass === false) {
      const bad = (report.checks ?? []).filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).slice(0, 6);
      throw new BoundaryError(`the boundary probe failed (${bad.length} check(s)): ${bad.join("; ")}`);
    }
    this.save((s) => { s.setup ??= {}; s.setup.boundaryVerifiedAt = new Date(this.rt.now()).toISOString(); s.setup.boundaryChecks = report?.checks?.length ?? 0; });
  }

  // --- the loop --------------------------------------------------------------------------------
  async loop() {
    for (;;) {
      this.tick();
      if (this.lockLost) throw new LockLost();
      await this.applyControl();
      if (this.signalled) { this.log("signal: stopping; the run stays resumable"); return; }
      const st = this.status;
      if (TERMINAL.includes(st)) return;
      if (st === "budget_exhausted") return;
      if (st === "ready") { this.go("running", { reason: "resumed" }); continue; }
      if (st === "paused" || st === "blocked") { await this.rt.sleep(this.rt.tickMs); continue; } // parked: waiting for a control command
      await this.refreshUsage();
      const limit = this.limitReached({ atStepBoundary: true });
      if (limit) {
        await this.exhausted(limit);
        if (["budget_exhausted", "succeeded", "failed", "cancelled"].includes(this.status)) return;
        continue;
      }
      const problem = this.rt.workerProblem?.();
      if (problem) { await this.stopWorker("worker unusable"); this.go("failed", { reason: "worker_unavailable", detail: problem }); return; }
      if (this.template.runStep) await this.template.runStep(this.ctx());
      else await this.taskStep();
      this.save();
    }
  }

  async exhausted(reason) {
    if (reason === "max_steps" && this.template.onStepsDone) {
      const handled = await this.template.onStepsDone(this.ctx());
      if (handled === "handled") return;
    }
    await this.stopWorker(`limit ${reason}`);
    await this.syncFromWorker({ silent: true }).catch(() => {});
    this.go("budget_exhausted", { reason, detail: `spent $${this.state.usage.usd.toFixed(2)}, ${this.state.usage.steps} steps, ${Math.round(this.state.usage.minutes)} minutes` });
  }

  // --- control commands -------------------------------------------------------------------------
  async applyControl({ only } = {}) {
    for (const msg of this.store.pending()) {
      if (only && !only.includes(msg.kind)) continue;
      const p = msg.payload ?? {};
      try {
        switch (msg.kind) {
          case "cancel": await this.cancel(p.reason ?? "operator"); break;
          case "pause":
            if (this.active || this.status === "ready") {
              await this.stopWorker("paused");
              await this.syncFromWorker({ silent: true }).catch(() => {});
              this.go("paused", { reason: p.reason ?? "operator", by: "operator" });
            }
            break;
          case "unpause":
            if (this.status === "paused") { this.startReason = "resumed"; this.go("running", { reason: "resumed", by: "operator" }); }
            break;
          case "steer": this.steer(String(p.message ?? "").slice(0, 2000)); break;
          case "answer": this.answer(p); break;
          case "reconfigure": this.reconfigure(p); break;
          default: break;
        }
      } finally { this.store.ack(msg.name); }
      this.save();
    }
  }

  async cancel(reason) {
    if (TERMINAL.includes(this.status)) return;
    await this.stopWorker("cancelled");
    await this.syncFromWorker({ silent: true }).catch(() => {});
    this.go("cancelled", { reason: "operator", detail: reason, by: "operator" });
  }

  steer(message) {
    if (!message.trim()) return;
    this.state.steers = [...(this.state.steers ?? []), { at: new Date(this.rt.now()).toISOString(), message }].slice(-50);
    if (this.session && !this.session.dead && this.active && this.session.say) this.session.say(`Operator steering (authoritative): ${message}`);
    else this.pendingFeedback.push(`Operator steering (authoritative): ${message}`);
    this.log(`steer recorded (${message.length} characters)`);
  }

  answer(p) {
    if (this.status !== "blocked") { this.log("answer ignored: the run is not blocked"); return; }
    const r = resumeAction(this.state, { answer: p.text, approve: p.approve, deny: p.deny });
    if (!r.ok) { this.log(`answer refused: ${r.message}`); return; }
    const q = this.state.blocker;
    this.state.pendingAnswer = { text: String(p.text ?? "").slice(0, 2000), question: q?.question, kind: q?.kind, approved: p.approve ? true : p.deny ? false : undefined, at: new Date(this.rt.now()).toISOString() };
    this.startReason = "answer";
    this.go("running", { reason: "answered", by: "operator" });
  }

  reconfigure(p) {
    const plan = planReconfigure({ contract: this.contract, state: this.state, changes: p.changes, effort: this.effortApi });
    const at = new Date(this.rt.now()).toISOString();
    if (!plan.ok) { this.state.reconfigurations = [...this.state.reconfigurations, { at, by: p.by ?? "operator", refused: plan.problems }].slice(-200); this.log(`reconfigure refused: ${plan.problems.join("; ")}`); return; }
    this.state.reconfigurations = [...this.state.reconfigurations, { at, by: p.by ?? "operator", before: plan.before, after: plan.after, reason: p.reason ?? null }].slice(-200);
    this.state.effort = plan.next.effort;
    this.state.limits = plan.next.limits;
    this.log(`reconfigured: ${Object.keys(p.changes).join(", ")}`);
    if (this.status === "budget_exhausted") this.go("paused", { reason: "limits raised", by: "reconfigure" });
  }

  // --- worker session ---------------------------------------------------------------------------
  startSession({ step }) {
    const attempt = (this.state.sessions ?? 0) + 1;
    const session = {
      attempt, agent: null, settled: false, exited: null, blocker: null, dead: false, lastEventAt: this.rt.now(), activity: [],
      say: (message) => session.agent?.send(session.settled ? { type: "prompt", message } : { type: "steer", message }),
    };
    const unattended = this.contract.permissions.unattended;
    const onEvent = (ev) => {
      session.lastEventAt = this.rt.now();
      if (ev.type === "agent_start") session.settled = false;
      if (ev.type === "agent_settled") session.settled = true;
      if (ev.type === "extension_ui_request") {
        const d = operatorDecision(ev, unattended);
        if (d.action === "reply") { session.agent?.send(d.reply); this.uiAnswered++; }
        else if (d.action === "block" && !session.blocker) session.blocker = d.blocker;
      }
      const line = activityLine({ ...ev, at: this.rt.now() });
      if (line) { session.activity.push(line); if (session.activity.length > MAX_ACTIVITY_LINES) session.activity.shift(); }
    };
    session.agent = this.rt.startWorker({ step, attempt, resetWorkspace: false, effort: this.state.effort, onEvent });
    session.agent.exited.then((e) => { session.exited = e ?? { code: 1 }; session.dead = true; });
    this.state.sessions = attempt;
    this.save((s) => { s.worker = { container: session.agent.name, attempt, step, startedAt: new Date(this.rt.now()).toISOString() }; });
    this.session = session;
    return session;
  }

  /** Register a session that a template drives itself (self-improve's cycle loop), so pause, cancel and exit can stop it. */
  adoptAgent(agent) {
    this.session = { attempt: this.state.sessions ?? 0, agent, settled: false, exited: null, blocker: null, dead: false, lastEventAt: this.rt.now(), activity: [], say: null };
    agent.exited.then(() => { if (this.session?.agent === agent) this.session.dead = true; });
    this.save((s) => { s.worker = { container: agent.name, attempt: s.sessions ?? 0, step: s.step, startedAt: new Date(this.rt.now()).toISOString() }; });
    return this.session;
  }

  async stopWorker(why) {
    const s = this.session;
    this.session = null;
    if (this.state) this.state.worker = null;
    if (!s) return;
    this.lastActivity = s.activity;
    if (s.dead) return;
    s.dead = true;
    try { await s.agent.stop(); } catch (e) { this.log(`stopping the worker: ${e.message}`); }
    this.log(`worker session stopped (${why})`);
  }

  /** Wait for the current turn to end. Control commands, limits and the worker's own events end it. */
  async waitTurn(session, stepStartUsd) {
    for (;;) {
      await this.rt.sleep(this.rt.tickMs);
      this.tick();
      if (this.lockLost) throw new LockLost();
      await this.refreshUsage();
      await this.applyControl();
      if (!this.active || this.signalled) return { end: "interrupted" };
      const limit = this.limitReached();
      if (limit) return { end: "limit", limit };
      if (session.blocker) return { end: "blocked" };
      if (session.exited) return { end: "exited", exit: session.exited };
      if (session.settled) return { end: "settled" };
      if (this.state.usage.usd - stepStartUsd >= this.state.limits.budget.perStepUsd) { session.agent.send({ type: "abort" }); return { end: "step_budget" }; }
      if ((this.rt.now() - session.lastEventAt) / 60_000 >= IDLE_MINUTES) return { end: "idle" };
      const problem = this.rt.workerProblem?.();
      if (problem) return { end: "unusable", problem };
    }
  }

  // --- one step of a finite task ----------------------------------------------------------------
  async taskStep() {
    const s = this.state;
    const n = s.step + 1;
    s.step = n;
    s.phase = "work";
    this.save();
    this.log(`step ${n} starting`);
    const stepStartUsd = s.usage.usd;
    const fresh = !this.session || this.session.dead;
    let briefing = null;
    if (fresh) {
      if (!(this.startReason === "first" && n === 1)) briefing = await this.briefing(this.startReason);
      this.startSession({ step: n });
      if (this.status === "recovering") this.go("running", { reason: "recovery session started" });
    }
    const session = this.session;
    const feedback = this.pendingFeedback.splice(0);
    const message = this.template.stepPrompt({ contract: this.contract, state: this.state, step: n, fresh, briefing, evaluation: this.lastEvaluation, feedback });
    if (fresh) session.agent.send({ type: "prompt", message });
    else session.say(message);
    session.settled = false;
    session.lastEventAt = this.rt.now();
    this.startReason = "continue";

    const res = await this.waitTurn(session, stepStartUsd);
    s.usage.steps = n;
    await this.refreshUsage();
    if (res.end === "interrupted") { this.save(); return; }
    if (res.end === "limit") { await this.stopWorker(`limit ${res.limit}`); this.save(); return; } // the loop ends the run with the limit's outcome
    if (res.end === "unusable") { await this.stopWorker("worker unusable"); this.go("failed", { reason: "worker_unavailable", detail: res.problem }); return; }
    if (res.end === "blocked") { await this.enterBlocked(session.blocker); return; }
    let crashed = false;
    if (res.end === "exited") {
      crashed = res.exit.code !== 0;
      this.lastActivity = session.activity; this.session = null; s.worker = null;
      this.startReason = crashed ? "crash" : "session_ended";
    }
    if (res.end === "step_budget") this.pendingFeedback.push(`The per-step budget of $${s.limits.budget.perStepUsd} was reached, so your turn was stopped. Commit what works.`);
    if (res.end === "idle") this.pendingFeedback.push(`No activity for ${IDLE_MINUTES} minutes; your turn was treated as stalled.`);
    this.save();
    await this.evaluateStep({ n, crashed });
  }

  async enterBlocked(blocker) {
    const s = this.state;
    await this.stopWorker("blocked");
    await this.syncFromWorker({ silent: true }).catch(() => {});
    s.pendingQuestions = [...(s.pendingQuestions ?? []), { ...blocker, at: new Date(this.rt.now()).toISOString() }].slice(-20);
    this.flushUi({ blocked: 1 });
    this.go("blocked", { reason: blocker.kind, blocker, by: "supervisor" });
  }

  flushUi({ blocked = 0 } = {}) {
    const ui = this.state.ui ?? { autoAnswered: 0, blocked: 0 };
    this.state.ui = { autoAnswered: ui.autoAnswered + this.uiAnswered, blocked: ui.blocked + blocked };
    this.uiAnswered = 0;
  }

  /** Bring the worker's commits in: snapshot, bundle, accept only fast-forwards inside the write areas. */
  async syncFromWorker({ silent = false } = {}) {
    const { rt, repo, contract } = this;
    try { await rt.snapshotWork({ message: `checkpoint: step ${this.state.step}` }); } catch (e) { if (!silent) this.log(`snapshot: ${e.message}`); }
    const r = await rt.fetchWorkerBundle();
    if (r.error) { if (!silent) this.log(`bundle: ${r.error}`); return { error: r.error, head: repo.head(), moved: false }; }
    const res = repo.ingest(r.bundle, { areas: contract.permissions.writeAreas });
    if (res.violation) this.log(`refused: the worker's commits touch paths outside permissions.writeAreas: ${res.violation.slice(0, 8).join(", ")}`);
    if (res.diverged) this.log("the worker's branch diverged from the accepted head; not accepted");
    return res;
  }

  writeStepSummary(n, extra) {
    const s = this.state;
    const latest = s.acceptance.latest;
    writeJsonAtomic(path.join(this.stepDir(n), "summary.json"), { step: n, at: new Date(this.rt.now()).toISOString(), status: s.status, head: this.repo.head(), usd: s.usage.usd, minutes: Math.round(s.usage.minutes * 10) / 10, results: latest?.results?.map(({ id, pass, exitCode }) => ({ id, pass, exitCode })) ?? [], ...extra });
    s.artefacts = [...s.artefacts.filter((a) => !(a.kind === "step-summary" && a.step === n)), { kind: "step-summary", path: path.join("steps", String(n).padStart(2, "0"), "summary.json"), step: n, at: new Date(this.rt.now()).toISOString() }];
  }

  async evaluateStep({ n, crashed }) {
    const { contract, repo } = this;
    const s = this.state;
    const sync = await this.syncFromWorker();
    const head = repo.head();
    const lastHead = s.recovery.lastHead ?? s.setup?.base ?? null;
    const moved = head !== lastHead;
    s.recovery.lastHead = head;
    this.flushUi();

    // Acceptance: judged by the supervisor on the accepted head, from definitions outside the worker's reach.
    s.phase = "acceptance";
    let ev;
    if (s.acceptance.latest?.sha !== head) {
      if (contract.permissions.network.services.length) await this.rt.deploy({ sha: head });
      ev = await (this.template.evaluate ?? runAcceptance)({ rt: this.rt, contract, sha: head, step: n, dir: path.join(this.stepDir(n), "checks"), runRoot: this.store.p.root, log: this.log });
      this.save((st) => {
        st.acceptance.latest = summariseEvaluation(ev);
        st.acceptance.history = [...st.acceptance.history, { step: n, sha: head, allRequiredPass: ev.allRequiredPass }].slice(-20);
        for (const r of ev.results) st.artefacts.push({ kind: "check-evidence", path: r.evidence, step: n, at: r.at });
        st.tasks = applyResultsToBoard(st.tasks, ev.results, { step: n, at: ev.at });
      });
      this.lastEvaluation = ev;
    } else {
      ev = { ...s.acceptance.latest, results: this.lastEvaluation?.results ?? s.acceptance.latest.results };
      this.log("no new accepted commits since the last evaluation; the previous results stand");
    }
    const violation = sync.violation?.length ? sync.violation : null;
    if (violation) this.pendingFeedback.push(`Your changes were NOT accepted: they touch paths outside the allowed write areas (${contract.permissions.writeAreas.join(", ")}): ${violation.slice(0, 10).join(", ")}. Revert those paths (a revert commit is fine) and keep your work inside the allowed areas.`);

    if (!violation) s.recovery.violations = 0; // consecutive means consecutive: a clean step ends the streak
    // Complete? All required checks pass on an accepted head, then the review (if required) approves.
    const alreadyRejected = s.acceptance.review.status === "rejected" && s.acceptance.review.sha === head;
    if (ev.allRequiredPass && !violation && !alreadyRejected) {
      s.phase = "review";
      if (await this.completeIfApproved({ head, ev, n })) return;
    }

    // Recovery: bounded, from verified facts only.
    const verified = newlyPassing(s.recovery.passingBefore, ev.results);
    s.recovery.passingBefore = ev.results.filter((r) => r.pass).map((r) => r.id);
    const target = currentTarget(s.tasks);
    const d = decideRecovery(s.recovery, s.limits.recovery, { verifiedProgress: verified.length > 0, activity: moved && !violation, violation: Boolean(violation), crashed, target, complete: false });
    s.recovery = d.recovery;
    s.recovery.lastHead = head;
    s.recovery.passingBefore = ev.results.filter((r) => r.pass).map((r) => r.id);
    this.writeStepSummary(n, { action: d.action, reason: d.reason, newlyPassing: verified, moved, violation: violation ?? null, crashed });
    this.save();
    this.store.event(n, { type: "recovery", action: d.action, reason: d.reason, newlyPassing: verified, moved, violation: Boolean(violation), crashed });
    if (d.action === "stop") {
      this.log(`recovery: stop (${d.failure}): ${d.reason}`);
      await this.stopWorker("recovery exhausted");
      this.go("failed", { reason: d.failure, detail: d.reason });
      return;
    }
    if (d.action === "nudge") {
      this.log(`recovery: ${d.reason}`);
      this.pendingFeedback.push(nudgeText(ev, { moved, violation }));
    } else if (d.action === "restart") {
      this.log(`recovery: ${d.reason}`);
      await this.stopWorker("hard restart");
      this.startReason = "hard_restart";
      if (this.status === "running") this.go("recovering", { reason: d.reason });
    }
    this.save();
  }

  /** All required checks pass. Review if required, then succeed. Returns true when the run ended. */
  async completeIfApproved({ head, ev, n }) {
    const { contract, repo } = this;
    const s = this.state;
    if (contract.acceptance.review) {
      const start = s.setup?.base ?? null;
      const bundle = {
        run: contract.run, title: contract.objective.title, spec: contract.objective.spec, backlog: contract.objective.backlog,
        results: ev.results.map(({ id, required, pass, exitCode, tail }) => ({ id, required, pass, exitCode, tail })),
        gitLog: start ? repo.logSince(start, head) : repo.logOneline(null, head, 40), diff: start ? repo.diffText(start, head) : "", sha: head,
      };
      let verdict;
      try { verdict = await this.rt.review(bundle); } catch (e) { verdict = { verdict: "REJECT", reason: `review unavailable (${e.message}); not approved`, concerns: [], failed: true }; }
      await this.refreshUsage();
      const attempts = (s.acceptance.review.attempts ?? 0) + 1;
      const approved = verdict.verdict === "APPROVE";
      this.save((st) => { st.acceptance.review = { ...st.acceptance.review, required: true, status: approved ? "approved" : "rejected", verdict: verdict.verdict, reason: verdict.reason, concerns: verdict.concerns ?? [], sha: head, at: new Date(this.rt.now()).toISOString(), attempts }; });
      this.store.event(n, { type: "review", verdict: verdict.verdict, reason: verdict.reason });
      if (!approved) {
        this.pendingFeedback.push(`The independent review did not approve the change: ${clip(verdict.reason, 600)}${verdict.concerns?.length ? ` Concerns: ${verdict.concerns.join("; ")}` : ""} Address these against the ORIGINAL specification, then stop.`);
        if (attempts >= s.limits.recovery.maxAttemptsPerStep) {
          await this.stopWorker("review rejected");
          this.go("failed", { reason: "review_rejected", detail: `${attempts} reviews did not approve: ${verdict.reason}` });
          return true;
        }
        return false;
      }
    }
    this.save((st) => { st.tasks = applyResultsToBoard(st.tasks, ev.results, { step: n, complete: true }); });
    await this.stopWorker("acceptance passed");
    this.writeStepSummary(n, { action: "complete", reason: "acceptance passed" });
    this.save();
    this.go("succeeded", { reason: "acceptance_passed", detail: `${ev.results.filter((r) => r.pass).length}/${ev.results.length} checks passed at ${head.slice(0, 12)}` });
    await this.afterSuccess(head);
    return true;
  }

  /** Promotion (when the contract lets the supervisor do it unasked) and automatic outputs. Failures are recorded, not fatal: the run did succeed. */
  async afterSuccess(head) {
    this.save((s) => { s.phase = "promotion"; });
    try { await this.promote({ sha: head, approved: false }); } catch (e) { this.log(`promotion: ${e.message}`); }
    if (this.deps.exportRun) {
      for (const d of this.contract.permissions.outputs.destinations) {
        try { await this.deps.exportRun({ engine: this, out: d.path }); this.log(`results exported to ${d.path}`); } catch (e) { this.log(`export to ${d.path} failed: ${e.message}`); }
      }
    }
    this.save((s) => { s.phase = null; });
  }

  /** Promote `sha` per the contract. `approved` is the operator's explicit approval (the `promote` command). */
  async promote({ sha, approved }) {
    const targets = this.template.promotion?.targets?.(this.contract, this.cfg, sha);
    const r = runPromotions({ repo: this.repo, contract: this.contract, cfg: this.cfg, state: this.state, sha, approved, targets, save: (fn) => this.save(fn), log: this.log });
    this.save((s) => { s.promotion.status = r.status; s.promotion.error = r.error ?? null; s.promotion.targets = r.targets.map((t) => ({ key: t.key, description: t.description })); });
    return r;
  }

  /** The briefing a fresh session gets: verified state, operator words, and quarantined traces. */
  async briefing(why) {
    const { repo, state, contract } = this;
    const head = repo.head();
    const start = state.setup?.base;
    const answer = state.pendingAnswer;
    const steers = (state.steers ?? []).slice(-5).map((x) => x.message);
    const reasons = { hard_restart: "it was restarted by the supervisor's recovery", crash: "it crashed", supervisor_restart: "the supervisor was restarted", resumed: "the run was paused and resumed", answer: "the run was blocked on a question and has now been answered", session_ended: "it ended", continue: "it ended" };
    const text = buildBriefing({ contract, state, why: reasons[why] ?? why, head, log: repo.logOneline(start ?? null, head), changed: start ? repo.changedPaths(start, head) : [], activity: this.lastActivity, answer, steers });
    if (answer) this.save((s) => { s.pendingAnswer = null; });
    return text;
  }
}

function nudgeText(ev, { moved, violation }) {
  const failing = ev.results.filter((r) => !r.pass && r.required).map((r) => r.id);
  if (violation) return "Your last step made no accepted progress because it touched paths outside the allowed write areas.";
  return `Your last step ended without ${moved ? "any check newly passing" : "changing the accepted code"}. Required checks still failing: ${failing.join(", ") || "none listed"}. Read the check output above, make one concrete change that fixes the first failure, commit and push it. If you are stuck on something only a person can decide, ask with ask_human instead of stopping.`;
}
