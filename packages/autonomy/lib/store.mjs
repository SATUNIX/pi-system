// The run's persistent record: state.json (only the supervisor that holds the run lock writes
// it), the append-only supervisor log and the control inbox other commands use to talk to a
// running supervisor (pause, cancel, steer, answer, reconfigure). Files are written atomically.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { appendJsonl, readJson, writeJsonAtomic } from "./fsutil.mjs";
import { STATE_SCHEMA_VERSION, transition } from "./lifecycle.mjs";
import { runPaths, stateHome } from "./paths.mjs";

export const CONTROL_KINDS = ["pause", "unpause", "cancel", "steer", "answer", "reconfigure"];

export class RunStore {
  constructor(run, { home = stateHome(), now = () => new Date() } = {}) {
    this.run = run;
    this.home = home;
    this.now = now;
    this.p = runPaths(run, home);
  }

  exists() { return fs.existsSync(this.p.state); }

  readState() {
    const s = readJson(this.p.state, null);
    if (s && s.schemaVersion !== STATE_SCHEMA_VERSION) throw new Error(`state.json of run ${this.run} has schemaVersion ${s.schemaVersion}; this supervisor reads ${STATE_SCHEMA_VERSION}`);
    return s;
  }

  writeState(state) { writeJsonAtomic(this.p.state, state); return state; }

  /** Read, transform with `fn(state) -> state`, write. */
  update(fn) {
    const next = fn(this.readState());
    return this.writeState(next);
  }

  transition(to, info = {}) {
    return this.update((s) => transition(s, to, { at: this.now().toISOString(), ...info }));
  }

  readContract() { return readJson(this.p.contract, null); }

  log(line) {
    const out = `${this.now().toISOString()} ${line}`;
    try { fs.mkdirSync(this.p.root, { recursive: true }); fs.appendFileSync(this.p.log, `${out}\n`); } catch { /* the log is best effort */ }
    return out;
  }

  event(step, event) {
    appendJsonl(path.join(this.p.steps, String(step).padStart(2, "0"), "events.jsonl"), { at: this.now().toISOString(), ...event });
  }

  // --- control inbox ----------------------------------------------------------------------
  enqueue(kind, payload = {}) {
    if (!CONTROL_KINDS.includes(kind)) throw new Error(`unknown control message ${kind}`);
    // Time first, then a per-process counter, so messages from one process keep their order even within a millisecond.
    const name = `${this.now().toISOString().replace(/[:.]/g, "-")}-${String((this.seq = (this.seq ?? 0) + 1)).padStart(6, "0")}-${randomBytes(3).toString("hex")}-${kind}.json`;
    writeJsonAtomic(path.join(this.p.control, name), { kind, payload, at: this.now().toISOString() });
    return name;
  }

  /** Pending control messages, oldest first. */
  pending() {
    let names;
    try { names = fs.readdirSync(this.p.control).filter((n) => n.endsWith(".json")).sort(); } catch { return []; }
    return names.flatMap((name) => {
      const msg = readJson(path.join(this.p.control, name), null);
      return msg && CONTROL_KINDS.includes(msg.kind) ? [{ name, ...msg }] : [];
    });
  }

  ack(name) {
    const done = path.join(this.p.control, "done");
    fs.mkdirSync(done, { recursive: true });
    try { fs.renameSync(path.join(this.p.control, name), path.join(done, name)); } catch { /* already handled */ }
  }
}

/** The runs under a state home, newest first, with just enough to list them. */
export function listRuns(home = stateHome()) {
  let names;
  try { names = fs.readdirSync(home); } catch { return []; }
  return names.flatMap((run) => {
    const s = readJson(runPaths(run, home).state, null);
    return s ? [{ run, template: s.template, status: s.status, updatedAt: s.updatedAt, outcome: s.outcome }] : [];
  }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
