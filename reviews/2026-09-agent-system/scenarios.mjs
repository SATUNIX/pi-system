// Baseline counterexamples, not a production acceptance suite. No inference or native tools.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { loadExtension, loadModule } from '../../kit/eval/harness.mjs';

const output = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(output, '../..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-system-review-'));
const initialCwd = process.cwd();
const oldEnv = { ...process.env };
const trace = [];
let serial = 0;
let fakeVerifyCalls = 0;
let forbiddenCalls = 0;
const fixedNow = 1789344000000;
const realNow = Date.now;
const realRandom = Math.random;
Date.now = () => fixedNow + serial++;
Math.random = () => 0.646;
function forbidden() { forbiddenCalls++; throw new Error('Review forbids native execution/network'); }
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFileSync', 'fork']) cp[name] = forbidden;
cp.execFile = (file, args, options, callback) => {
  if (file !== 'npm' || args.join(' ') !== 'run verify') return forbidden();
  fakeVerifyCalls++;
  callback(null, 'scripted verification passed', '');
};
net.connect = net.createConnection = http.request = http.get = https.request = https.get = forbidden;
globalThis.fetch = forbidden;
syncBuiltinESMExports();
for (const key of Object.keys(process.env)) if (key.startsWith('PI_KIT_') || key.startsWith('PI_ALLOW_')) delete process.env[key];
process.env.PI_KIT_VERIFY_ON_TURN = '1';
process.env.PI_KIT_GUARD_MODE = 'suggest';
process.chdir(workspace);

function dir(name) { const p = path.join(workspace, name); fs.mkdirSync(p, { recursive: true }); return p; }
function put(cwd, name, value) { const p = path.join(cwd, name); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof value === 'string' ? value : JSON.stringify(value)); }
const final = { message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'reported blocker' }] } };

// Ordinary lifecycle emit matches Pi 0.76 runner order/catch-and-continue. Input and
// tool_call use their short-circuit forms. Custom followups bypass input; user
// followups traverse input(source=extension), per AgentSession.sendUserMessage.
async function runtime(names, cwd, extraUi = {}) {
  const handlers = new Map(), commands = new Map(), tools = new Map(), queue = [];
  const ctx = { cwd, hasUI: false, ui: { notify() {}, setStatus() {}, ...extraUi } };
  const api = {
    on(name, fn) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(fn); },
    registerCommand(name, value) { commands.set(name, value); }, registerTool(t) { tools.set(t.name, t); },
    getCommands: () => [...commands.keys()].map(name => ({ name })),
    getActiveTools: () => ['read', 'write', 'edit', 'bash', 'subagent'],
    sendMessage(message, options) { queue.push({ kind: 'custom', message, options }); },
    sendUserMessage(message, options) { queue.push({ kind: 'user', message, options }); },
  };
  for (const name of names) (await loadExtension(name))(api);
  async function emit(name, event = {}) {
    let result;
    for (const handler of handlers.get(name) ?? []) {
      try {
        const r = await handler({ type: name, ...event }, ctx);
        if (r !== undefined) result = r;
        if ((name === 'tool_call' && r?.block) || (name === 'input' && r?.action === 'handled') || r?.cancel) break;
      } catch (e) {
        trace.push({ event: 'handler-error', name, error: e.message });
        if (['tool_call', 'input'].includes(name)) throw e;
      }
    }
    return result;
  }
  async function drain(max = 10) {
    let turns = 0;
    while (queue.length && turns < max) {
      const message = queue.shift();
      trace.push({ event: 'consume', kind: message.kind, customType: message.message?.customType });
      if (message.kind === 'user') await emit('input', { source: 'extension', text: message.message });
      await emit('turn_end', final); await emit('agent_end'); turns++;
    }
    return { turns, queued: queue.length };
  }
  await emit('session_start');
  return { api, emit, commands, tools, ctx, queue, drain, handlers };
}
async function scenario(id, run) {
  const start = trace.length;
  const observed = await run();
  const events = trace.splice(start);
  trace.push({ id, status: 'baseline-confirmed', observed, events });
}
const orch = 'extensions/orchestrator/index.ts', verify = 'extensions/verify-gate/index.ts';
try {
  await scenario('S00-pinned-runtime-dispatch-contract', async () => {
    const { ExtensionRunner } = await import('../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js');
    const events = [];
    const receiver = {
      createContext: () => ({}), isSessionBeforeEvent: () => false,
      emitError: () => events.push('error-observed'),
      extensions: [{ handlers: new Map([['turn_end', [() => events.push('first'), () => { throw new Error('fixture'); }, () => events.push('third')]], ['tool_call', [() => ({ block: true }), () => events.push('should-not-run')]]]) }],
    };
    await ExtensionRunner.prototype.emit.call(receiver, { type: 'turn_end' });
    assert.deepEqual(events, ['first', 'error-observed', 'third']);
    const blocked = await ExtensionRunner.prototype.emitToolCall.call(receiver, { type: 'tool_call' });
    assert.equal(blocked.block, true); assert.equal(events.length, 3);
    return { actualRuntimeMethod: 'Pi 0.76 ExtensionRunner.emit/emitToolCall', events, toolShortCircuit: true };
  });
  await scenario('S01-read-only-simple-completion', async () => {
    const r = await runtime([orch, verify], dir('simple'));
    await r.emit('input', { source: 'interactive', text: 'Please explain what a verifier does.' });
    await r.emit('turn_end', final); assert.equal(r.queue.length, 0);
    return { corrections: 0, result: 'partial fix holds for simple read-only question' };
  });
  await scenario('S02-complex-read-only-applicability', async () => {
    const r = await runtime([orch], dir('complex'));
    await r.commands.get('orchestrate').handler('on', r.ctx);
    await r.emit('input', { source: 'interactive', text: 'Review the entire architecture and provide a read-only plan.' });
    await r.emit('turn_end', final); assert.equal(r.queue.length, 1);
    const consumed = await r.drain(); assert.equal(consumed.turns, 1); assert.equal(consumed.queued, 0);
    return { corrections: 1, writesRequiredByTask: false, bounded: true };
  });
  for (const order of [[orch, verify], [verify, orch]]) {
    await scenario(`S03-handler-order-${order[0].split('/')[1]}`, async () => {
      const cwd = dir(`order-${serial++}`); put(cwd, 'package.json', { scripts: { verify: 'scripted only' } });
      const r = await runtime(order, cwd);
      await r.emit('input', { source: 'interactive', text: 'Fix a small typo.' });
      await r.emit('tool_result', { toolName: 'edit', isError: false });
      await r.emit('turn_end', final);
      const corrections = r.queue.length;
      assert.equal(corrections, order[0] === orch ? 1 : 0);
      assert.equal(JSON.parse(fs.readFileSync(path.join(cwd, '.pi/verdicts.json'))).verdicts.verify.pass, true);
      await r.drain(); return { order, corrections, actualVerification: 'scripted pass', result: 'order-dependent stale diagnostic' };
    });
  }
  await scenario('S04-board-provenance-and-freshness', async () => {
    const cwd = dir('boards'); const { missionCompleteBlocked } = await loadModule(orch);
    const observations = {};
    observations.missing = missionCompleteBlocked(cwd).blocked;
    for (const [name, board] of Object.entries({ corrupt: '{', empty: { verdicts: {} }, stale: { verdicts: { verify: { pass: true, at: '2000-01-01' } } }, unrelated: { verdicts: { arbitraryWorker: { pass: true, at: 'invalid' } } } })) {
      put(cwd, '.pi/verdicts.json', board); observations[name] = missionCompleteBlocked(cwd).blocked;
    }
    assert.deepEqual(observations, { missing: true, corrupt: true, empty: true, stale: true, unrelated: false }); return observations;
  });
  await scenario('S05-shell-write-not-dirty', async () => {
    const cwd = dir('shell-dirty'); put(cwd, 'package.json', { scripts: { verify: 'scripted only' } });
    const r = await runtime([verify], cwd); const before = fakeVerifyCalls;
    await r.emit('tool_result', { toolName: 'bash', input: { command: 'synthetic file edit' }, isError: false });
    await r.emit('turn_end', final); assert.equal(fakeVerifyCalls, before); return { verificationRuns: 0 };
  });
  await scenario('S06-shared-session-start-deletes-context', async () => {
    const cwd = dir('shared'); await runtime(['extensions/context-sieve/index.ts'], cwd);
    put(cwd, '.pi/ctx-contributions/parent.json', { id: 'parent', content: 'parent work', priority: 100, budgetTokens: 100 });
    await runtime(['extensions/context-sieve/index.ts'], cwd);
    const exists = fs.existsSync(path.join(cwd, '.pi/ctx-contributions/parent.json')); assert.equal(exists, false); return { parentContributionSurvivesChildStart: exists };
  });
  await scenario('S07-compaction-discards-later-correction', async () => {
    const cwd = dir('compact'); const r = await runtime(['extensions/context-sieve/index.ts'], cwd);
    put(cwd, '.pi/GOAL.yaml', 'goal: review fixture');
    const res = await r.emit('session_before_compact', { preparation: { messagesToSummarize: [{ role: 'user', content: 'A'.repeat(9000) }, { role: 'user', content: 'CORRECTION_KEEP_THIS_TASK_READ_ONLY' }], firstKeptEntryId: 'retained', tokensBefore: 20000 } });
    assert.ok(res.compaction.summary.includes('truncated')); assert.ok(!res.compaction.summary.includes('CORRECTION_KEEP_THIS_TASK_READ_ONLY'));
    return { correctionPreserved: false, charsBudget: 8000 };
  });
  await scenario('S08-task-dependency-bypass', async () => {
    const r = await runtime(['extensions/task-graph/index.ts'], dir('tasks'));
    const call = (tool, p) => r.tools.get(tool).execute('fixture', p, undefined, undefined, r.ctx);
    await call('task_create', { title: 'A' }); await call('task_create', { title: 'B', depends_on: ['t1'] });
    const blocked = await call('task_complete', { id: 't2' }); assert.match(blocked.content[0].text, /Cannot complete/);
    const bypass = await call('task_update', { id: 't2', status: 'done' }); assert.match(bypass.content[0].text, /done/);
    return { taskComplete: blocked.content[0].text, taskUpdate: bypass.content[0].text };
  });
  await scenario('S09-suggest-mode-enters-recovery', async () => {
    const cwd = dir('research'); const r = await runtime(['extensions/progress-guard/index.ts', 'extensions/recovery-orchestrator/index.ts'], cwd);
    for (let i = 0; i < 10; i++) { await r.emit('tool_call', { toolName: 'read', input: { path: `fact-${i}.md` } }); await r.emit('turn_end', final); }
    const files = fs.readdirSync(path.join(cwd, '.pi/ctx-contributions'));
    assert.ok(files.includes('recovery-orchestrator.json')); return { mode: 'suggest', uniqueProductiveReads: 10, recoveryContribution: true };
  });
  await scenario('S10-invalid-loop-cap-and-terminal-followups', async () => {
    process.env.PI_KIT_LOOP_MAX = 'invalid';
    const r = await runtime(['extensions/autonomous-loop/index.ts'], dir('loop'));
    await r.commands.get('loop').handler('synthetic impossible task', r.ctx);
    await r.emit('agent_end'); const consumed = await r.drain(25);
    assert.equal(consumed.queued, 1); await r.commands.get('loop').handler('stop', r.ctx);
    assert.equal(r.queue.length, 1); const late = await r.drain(); assert.equal(late.turns, 1);
    return { simulatedTurnsAtCutoff: 25, continuationStillQueued: true, turnsAfterStop: 1, claim: 'bounded counterexample; not infinite real inference' };
  });
  await scenario('S11-security-composition-inert-inputs', async () => {
    const cwd = dir('security'); process.chdir(cwd);
    const r = await runtime(['extensions/secret-guard/index.ts', 'vendor/protected-paths/index.ts', 'extensions/tool-firewall/index.ts'], cwd);
    const results = {};
    for (const [name, toolName, input] of [
      ['credential-read', 'read', { path: '.env' }],
      ['audit-overwrite', 'write', { path: '.pi/tool-firewall-audit.jsonl', content: 'synthetic' }],
      ['policy-overwrite', 'write', { path: 'extensions/tool-firewall/default-policy.json', content: '{}' }],
      ['headless-approval', 'unknown_fixture_tool', {}],
      ['known-destructive-denied', 'bash', { command: 'Remove-Item -Recurse synthetic-fixture' }],
    ]) results[name] = Boolean((await r.emit('tool_call', { toolName, input }))?.block);
    assert.equal(results['credential-read'], false); assert.equal(results['headless-approval'], true); assert.equal(results['known-destructive-denied'], true);
    return { blocked: results, effects: 'handler decisions only; no command/read/write execution' };
  });
  await scenario('S12-ledger-truncation-and-attribution', async () => {
    const cwd = dir('ledger'); const r = await runtime(['extensions/trace-ledger/index.ts'], cwd);
    await r.emit('tool_call', { toolName: 'bash', toolCallId: 'call-fixture', input: { command: 'echo SYNTHETIC_TOKEN=canary ' + 'x'.repeat(210) } });
    const record = JSON.parse(fs.readFileSync(path.join(cwd, '.pi/trace.jsonl'), 'utf8').trim());
    assert.equal(record.target.length, 200); assert.ok(record.target.includes('SYNTHETIC_TOKEN=canary')); assert.equal(record.toolCallId, undefined);
    return { targetChars: record.target.length, secretRedaction: false, truncationMarker: false, toolCallId: false, ecsVersion: false };
  });
  await scenario('S13-installed-old-dod-approximation', async () => {
    const installedFile = path.join(os.homedir(), 'Cyber/Development/OffSec/AI Area/misc-agents-pi-kit/dist/pi-kit-lite/extensions/orchestrator/index.ts');
    if (!fs.existsSync(installedFile)) return { status: 'unavailable', reason: 'historical installed artifact absent' };
    const r = await runtime([path.relative(root, installedFile)], dir('legacy'));
    r.api.getActiveTools = () => ['read'];
    await r.emit('input', { source: 'extension', text: 'Deliver a read-only plan.' });
    await r.emit('agent_end');
    assert.match(r.queue[0].message, /Definition of done NOT met/);
    const consumed = await r.drain(25); assert.equal(consumed.queued, 1);
    return { simulatedTurnsAtCutoff: 25, repeatedDoD: true, queueStillNonempty: true, limitation: 'actual installed hook with scripted scheduling; agent_end streaming race and live incident delivery NOT reproduced' };
  });
  await scenario('S14-five-extension-recovery-cap-does-not-stop-loop', async () => {
    process.env.PI_KIT_LOOP_MAX = '3';
    const r = await runtime([orch, verify, 'extensions/autonomous-loop/index.ts', 'extensions/progress-guard/index.ts', 'extensions/recovery-orchestrator/index.ts'], dir('composition'));
    await r.commands.get('loop').handler('report an impossible blocker', r.ctx);
    for (let i = 0; i < 5; i++) await r.commands.get('recover').handler('same-fixture', r.ctx);
    await r.emit('turn_end', final);
    const content = fs.readFileSync(path.join(r.ctx.cwd, '.pi/ctx-contributions/recovery-orchestrator.json'), 'utf8');
    assert.match(content, /give up gracefully/);
    await r.emit('agent_end'); const queuedAtCap = r.queue.length; assert.equal(queuedAtCap, 1);
    const consumed = await r.drain(10); assert.equal(consumed.turns, 3); assert.equal(consumed.queued, 0);
    return { recoveryCapped: true, modelTurnsAfterCap: consumed.turns, independentLoopEventuallyBounded: true, schedulerBlocked: false };
  });
  assert.ok(!trace.some(x => x.events?.some(e => e.event === 'handler-error')), 'Unexpected handler errors invalidate evidence');
  assert.equal(forbiddenCalls, 0, 'No attempted native/network execution permitted');
  fs.writeFileSync(path.join(output, 'scenario-results.json'), JSON.stringify({ baseline: '6460ef6392dc290038f5ad79835861f9e5e06134', seed: 646, runtime: process.version, fakeVerifyCalls, forbiddenCalls, cases: trace }, null, 2) + '\n');
  console.log(`Confirmed ${trace.length} baseline scenarios; ${fakeVerifyCalls} scripted verifies; no model/network/native execution.`);
} finally {
  Date.now = realNow;
  Math.random = realRandom;
  process.chdir(initialCwd);
  for (const k of Object.keys(process.env)) if (!(k in oldEnv)) delete process.env[k];
  Object.assign(process.env, oldEnv);
  const resolved = path.resolve(workspace);
  assert.ok(path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('pi-system-review-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
