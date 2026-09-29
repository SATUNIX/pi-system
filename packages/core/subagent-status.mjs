#!/usr/bin/env node
/**
 * subagent-status — inspect subagent runs from a terminal (outside pi).
 *
 * The `subagent` extension writes one tailable log per run plus a registry:
 *   <state-dir>/<run-id>.log     full child event stream (deltas skipped) + stderr + lifecycle
 *   <state-dir>/runs.jsonl       one start/end record per run
 * where <state-dir> defaults to the nearest `.pi/subagent` found upward from the cwd.
 *
 * Usage:
 *   node packages/core/subagent-status.mjs                     # list recent runs
 *   node packages/core/subagent-status.mjs --id <run>          # show a run's log tail
 *   node packages/core/subagent-status.mjs --id <run> --follow # keep streaming the log
 *   node packages/core/subagent-status.mjs --limit 20 --dir <path> --json
 */
import fs from "node:fs";
import path from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

function findStateDir() {
  const explicit = arg("--dir");
  if (explicit) return path.resolve(explicit);
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, ".pi", "subagent");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(process.cwd(), ".pi", "subagent");
}

function readRuns(dir) {
  const file = path.join(dir, "runs.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

function groupRuns(entries) {
  const byId = new Map();
  for (const e of entries) {
    const id = String(e.id);
    const run = byId.get(id) ?? { id, agent: String(e.agent ?? "?"), status: "running", start: "", end: "", task: "", log: String(e.log ?? "") };
    if (e.log) run.log = String(e.log);
    if (e.event === "end") {
      run.status = String(e.status ?? "end");
      run.end = String(e.ts ?? "");
      if (e.turns !== undefined) run.turns = Number(e.turns);
      if (e.cost !== undefined) run.cost = Number(e.cost);
      if (e.attempts !== undefined) run.attempts = Number(e.attempts);
    } else {
      run.start = String(e.ts ?? run.start);
      if (e.task) run.task = String(e.task);
    }
    byId.set(id, run);
  }
  return [...byId.values()].sort((a, b) => (a.start < b.start ? 1 : -1));
}

function fmtDuration(run) {
  if (!run.start || !run.end) return run.status === "running" ? "running" : "—";
  const ms = Date.parse(run.end) - Date.parse(run.start);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 1000)}s`;
}

const dir = findStateDir();
const id = arg("--id");

if (id) {
  const logPath = path.join(dir, `${id}.log`);
  if (!fs.existsSync(logPath)) {
    console.error(`No log for run "${id}" under ${dir}`);
    process.exit(1);
  }
  const tail = Math.max(1, Number(arg("--tail", "60")) || 60);
  const lines = fs.readFileSync(logPath, "utf8").split(/\r?\n/);
  process.stdout.write(lines.slice(-tail).join("\n") + "\n");
  if (has("--follow")) {
    process.stderr.write(`--- following ${logPath} (Ctrl-C to stop) ---\n`);
    let pos = fs.statSync(logPath).size;
    setInterval(() => {
      let size;
      try {
        size = fs.statSync(logPath).size;
      } catch {
        return;
      }
      if (size <= pos) return;
      const fd = fs.openSync(logPath, "r");
      const buf = Buffer.alloc(size - pos);
      fs.readSync(fd, buf, 0, size - pos, pos);
      fs.closeSync(fd);
      process.stdout.write(buf.toString());
      pos = size;
    }, 500);
  }
} else {
  const runs = groupRuns(readRuns(dir));
  if (has("--json")) {
    process.stdout.write(JSON.stringify(runs, null, 2) + "\n");
  } else if (runs.length === 0) {
    console.log(`No subagent runs recorded under ${dir}`);
  } else {
    const limit = Math.max(1, Number(arg("--limit", "20")) || 20);
    console.log(`State dir: ${dir}\n`);
    console.log("STATUS     DURATION  TURNS  COST      ATT  AGENT        RUN                                     TASK");
    for (const run of runs.slice(0, limit)) {
      const task = run.task.length > 40 ? `${run.task.slice(0, 37)}...` : run.task;
      const turns = run.turns !== undefined ? String(run.turns) : "";
      const cost = run.cost && Number.isFinite(run.cost) ? `$${run.cost.toFixed(4)}` : "";
      const att = run.attempts && run.attempts > 1 ? `x${run.attempts}` : "";
      console.log(`${run.status.padEnd(10)} ${fmtDuration(run).padEnd(9)} ${turns.padEnd(6)} ${cost.padEnd(9)} ${att.padEnd(4)} ${run.agent.padEnd(12)} ${run.id.padEnd(39)} ${task}`);
    }
    console.log(`\nTail a run:  node packages/core/subagent-status.mjs --id <run>`);
    console.log(`Live:        node packages/core/subagent-status.mjs --id <run> --follow`);
    console.log(`Raw logs:    ls -lat ${dir}/*.log  /  tail -f ${dir}/<run>.log`);
  }
}
