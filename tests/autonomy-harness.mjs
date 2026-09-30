// Shared harness for the DETERMINISTIC FAKE-RUNTIME tests of the run engine (autonomy-run-smoke.mjs,
// autonomy-selfimprove-smoke.mjs, autonomy-cli-smoke.mjs). Builds a real run directory, a FakeRuntime
// (packages/autonomy/tests/fake-runtime.mjs) and an Engine around one contract. Not a real-provider run.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { assert, implementRaw, rm, tempDir, testEffort } from "./autonomy-helpers.mjs";
import { resolveContract } from "../packages/autonomy/lib/contract.mjs";
import { boundaryDigest } from "../packages/autonomy/lib/boundary.mjs";
import { createRun } from "../packages/autonomy/lib/rundir.mjs";
import { runtimeConfig } from "../packages/autonomy/lib/runcfg.mjs";
import { Engine } from "../packages/autonomy/lib/engine.mjs";
import { TEMPLATES } from "../packages/autonomy/lib/templates/index.mjs";
import { createRunLock } from "../packages/autonomy/lib/runlock.mjs";
import { exportRun } from "../packages/autonomy/lib/export.mjs";
import { FakeEngine, FakeRuntime } from "../packages/autonomy/tests/fake-runtime.mjs";

void spawnSync;
const roots = [];
export const cleanup = () => { for (const d of roots) rm(d); };
export const scratch = () => { const d = tempDir("autonomy-run-"); roots.push(d); return d; };

export const NODE_EXIT = (expr) => ["node", "-e", `process.exit((${expr}) ? 0 : 1)`];
export const ANSWER = "require('fs').readFileSync('answer.txt','utf8')";

/** A finite task: worker-visible check `unit`, plus a HELD-OUT check the worker cannot see or influence. */
export function taskRaw(dir, over = {}) {
  const heldOut = path.join(dir, "held-out.mjs");
  fs.writeFileSync(heldOut, "import fs from 'node:fs'; process.exit(fs.readFileSync('answer.txt', 'utf8') === '42\\n' ? 0 : 1);\n");
  return implementRaw({
    objective: { title: "Write the answer", spec: "Put the answer to everything in answer.txt (with a trailing newline).", backlog: [{ id: "T1", title: "answer.txt says 42", acceptance: ["unit", "held-out"] }, { id: "T2", title: "Keep the change small" }] },
    acceptance: {
      checks: [{ id: "unit", run: NODE_EXIT(`${ANSWER}.trim() === '42'`), timeoutMinutes: 1, required: true }, { id: "held-out", run: ["node", "tests/held-out.mjs"], timeoutMinutes: 1, required: true }],
      overlay: [{ source: heldOut, target: "tests/held-out.mjs" }], review: true,
    },
    budget: { totalUsd: 10, perStepUsd: 2, maxSteps: 12, maxMinutes: 600 },
    ...over,
  });
}

/** Build a run directory, a fake runtime and an engine factory around one contract. */
export function harness(raw, { script, review, boundary, tickMs, hooks, cfgOverride = {}, manager, clock = { now: Date.parse("2026-09-30T00:00:00Z") }, fakeEngine = new FakeEngine(), contractOpts = {} } = {}) {
  const home = scratch();
  const resolved = resolveContract(raw, { effort: testEffort, baseDir: home, ...contractOpts });
  assert.equal(resolved.ok, true, JSON.stringify(resolved.problems));
  const digest = boundaryDigest(resolved.contract);
  const store = createRun({ contract: resolved.contract, authorisation: { boundaryDigest: digest, by: "test", at: "2026-09-30T00:00:00.000Z", via: "contract" }, home, now: () => new Date(clock.now), boundaryEffort: testEffort });
  const contract = JSON.parse(fs.readFileSync(store.p.contract, "utf8"));
  const cfg = { ...runtimeConfig(contract, { namePrefix: "pi-autonomy-test-run" }), ...cfgOverride };
  const h = { home, store, contract, cfg, clock, fakeEngine, digest };
  h.runtime = (s = script) => new FakeRuntime({ store, cfg, contract, script: s, engine: fakeEngine, clock, review, boundary, tickMs, hooks, manager });
  h.lock = (pid, alive = () => true, heartbeatMs = 3_600_000) => createRunLock({ file: store.p.lock, pid, host: "test-host", now: () => clock.now, isAlive: alive, startTimeOf: (p) => `start-${p}`, staleMs: 120_000, heartbeatMs });
  h.engine = ({ rt = h.runtime(), pid = 1001, lock = h.lock(pid) } = {}) => {
    const acquired = lock.acquire();
    assert.equal(acquired.acquired, true, acquired.reason);
    return { engine: new Engine({ contract, cfg, store, rt, template: TEMPLATES[contract.template], lock, effortApi: testEffort, deps: { exportRun: ({ engine, out }) => exportRun({ store, repo: rt.repo, contract, state: engine.state, out }) } }), rt, lock, acquired };
  };
  h.state = () => store.readState();
  return h;
}


export function fakeAlive(engine) { return [...engine.containers]; }

// --- helpers for the smaller scenarios -----------------------------------------------------------
export const simpleRaw = (over = {}) => implementRaw({
  objective: { title: "Write the answer", spec: "Put 42 in answer.txt.", backlog: [] },
  acceptance: { checks: [{ id: "unit", run: NODE_EXIT(`${ANSWER}.trim() === '42'`), timeoutMinutes: 1, required: true }], review: false },
  budget: { totalUsd: 10, perStepUsd: 2, maxSteps: 12, maxMinutes: 600 },
  ...over,
});
export const solve = (t) => { t.write("answer.txt", "42\n"); t.commit("answer"); };
export const junk = (t) => { t.write("junk.txt", String(t.turn)); t.commit(`junk ${t.turn}`); }; // activity that never passes the check
export async function runOnce(h, opts = {}) {
  const made = h.engine(opts);
  await made.engine.run(opts.run ?? {});
  return { ...made, state: h.state() };
}
