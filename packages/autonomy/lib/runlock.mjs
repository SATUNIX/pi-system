// Exactly ONE supervisor owns a run. The lock is a file in the run directory holding the owner's
// pid, process start time, host name and a heartbeat. A duplicate `start` (or `resume`) refuses
// while the owner is alive; after a crash the lock is stale, and the next supervisor takes it
// over, removes the orphans (lib/runtime.mjs) and continues.
//
// Liveness, in order of trust:
//   same host    pid alive AND process start time equal to the recorded one (a reused pid has a
//                different start time). If the start time cannot be read, fall back to the heartbeat.
//   other host   heartbeat age only (clock skew larger than staleMs would defeat this; documented).
// A same-host owner that is alive but silent is "wedged": it is never taken over automatically,
// because two supervisors on one run would repeat side effects.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** A stable identifier of a running process's start, or null when unavailable. */
export function processStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return `proc:${rest[19]}`; // field 22 (starttime, clock ticks since boot); rest starts at field 3
  } catch { /* not Linux, or no such process */ }
  try {
    const r = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 5000 });
    const text = r.status === 0 ? r.stdout.trim() : "";
    return text ? `ps:${text}` : null;
  } catch { return null; }
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

/**
 * Judge a lock record. Pure given its inputs.
 * @returns {{ state: "alive"|"stale"|"wedged", why: string }}
 */
export function assessLock(rec, { host, now, isAlive = pidAlive, startTimeOf = processStartTime, staleMs }) {
  const age = now - Date.parse(rec.heartbeatAt ?? 0);
  if (rec.host === host) {
    if (!isAlive(rec.pid)) return { state: "stale", why: `process ${rec.pid} no longer exists` };
    const start = startTimeOf(rec.pid);
    if (rec.startTime && start) {
      if (start !== rec.startTime) return { state: "stale", why: `pid ${rec.pid} was reused by another process` };
      return age > staleMs ? { state: "wedged", why: `process ${rec.pid} is alive but has not written a heartbeat for ${Math.round(age / 1000)}s` } : { state: "alive", why: `process ${rec.pid} is running` };
    }
    return age > staleMs ? { state: "stale", why: `process ${rec.pid} exists but its start time cannot be verified and the heartbeat is ${Math.round(age / 1000)}s old` } : { state: "alive", why: `process ${rec.pid} is running` };
  }
  return age > staleMs ? { state: "stale", why: `held from ${rec.host}; heartbeat ${Math.round(age / 1000)}s old` } : { state: "alive", why: `held from ${rec.host}; heartbeat ${Math.round(age / 1000)}s old` };
}

export function createRunLock({ file, host = os.hostname(), pid = process.pid, now = () => Date.now(), isAlive = pidAlive, startTimeOf = processStartTime, staleMs = 120_000, heartbeatMs = 5000 } = {}) {
  const token = randomBytes(8).toString("hex");
  const startTime = startTimeOf(pid);
  let timer = null;
  let held = false;

  const record = (at) => ({ schemaVersion: 1, pid, startTime, host, token, acquiredAt: at, heartbeatAt: at });
  const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
  const writeAtomic = (rec) => {
    const tmp = `${file}.${token}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(rec)}\n`);
    fs.renameSync(tmp, file);
  };

  const lock = {
    token,
    get held() { return held; },
    /** Who holds the lock and whether they are alive; null when there is no lock. */
    inspect() {
      if (!fs.existsSync(file)) return null;
      const rec = read();
      if (!rec) {
        let young = false;
        try { young = now() - fs.statSync(file).mtimeMs < 10_000; } catch { /* vanished */ }
        return { holder: null, state: young ? "alive" : "stale", why: young ? "lock is being written" : "lock file is corrupt" };
      }
      return { holder: rec, ...assessLock(rec, { host, now: now(), isAlive, startTimeOf, staleMs }) };
    },
    /** @returns {{ acquired: boolean, tookOver?: object, reason?: string, holder?: object }} */
    acquire() {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let tookOver = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.writeFileSync(file, `${JSON.stringify(record(new Date(now()).toISOString()))}\n`, { flag: "wx" });
          held = true;
          return { acquired: true, ...(tookOver ? { tookOver } : {}) };
        } catch (e) {
          if (e.code !== "EEXIST") throw e;
        }
        const seen = lock.inspect();
        if (!seen) continue; // vanished between the attempts
        if (seen.state !== "stale") return { acquired: false, reason: seen.state === "wedged" ? `run is owned by a wedged supervisor: ${seen.why}. Stop that process, then resume.` : `run is already being supervised (${seen.why})`, holder: seen.holder };
        try { fs.renameSync(file, `${file}.stale-${token}`); tookOver = { ...(seen.holder ?? {}), why: seen.why }; } catch (e) { if (e.code !== "ENOENT") throw e; }
        try { fs.rmSync(`${file}.stale-${token}`, { force: true }); } catch { /* best effort */ }
      }
      return { acquired: false, reason: "could not acquire the run lock (contention)" };
    },
    /** Refresh the heartbeat. Returns false when the lock is no longer ours. */
    heartbeat() {
      const rec = read();
      if (!rec || rec.token !== token) { held = false; return false; }
      writeAtomic({ ...rec, heartbeatAt: new Date(now()).toISOString() });
      return true;
    },
    start(onLost) {
      timer = setInterval(() => { if (!lock.heartbeat()) { clearInterval(timer); timer = null; onLost?.(); } }, heartbeatMs);
      timer.unref?.();
    },
    release() {
      if (timer) { clearInterval(timer); timer = null; }
      const rec = read();
      if (rec?.token === token) fs.rmSync(file, { force: true });
      held = false;
    },
  };
  return lock;
}
