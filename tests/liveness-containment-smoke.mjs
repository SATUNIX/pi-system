import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createEventBus } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/event-bus.js';
import { loadExtension, loadModule, fakePi, tmpWorkspace, rmWorkspace, setEnv } from '../packages/core/eval/harness.mjs';

const ws = tmpWorkspace('pi-liveness-containment-');
const restore = setEnv('PI_KIT_LOOP_MAX', 'invalid');
const restoreMode = setEnv('PI_KIT_GUARD_MODE', 'suggest');
try {
  const loopModule = await loadModule('extensions/autonomous-loop/index.ts');
  for (const value of ['NaN', 'Infinity', '-1', '0', '', '2x', '1.5', '1001']) assert.equal(loopModule.iterationLimit(value), 20);
  assert.equal(loopModule.iterationLimit('3'), 3);
  const events = createEventBus();
  const context = id => ({ cwd: ws, hasUI: false, sessionManager: { getSessionId: () => id }, ui: { notify() {}, setStatus() {} } });
  const ctx = context('owner-A');
  const loop = fakePi(); loop.api.events = events; loopModule.default(loop.api);
  await loop.handlers.get('session_start')({}, ctx);
  await loop.commands.get('loop').handler('finish synthetic task', ctx);
  for (let i = 0; i < 30; i++) await loop.handlers.get('agent_end')({}, ctx);
  assert.equal(loop.steers.length, 20, 'malformed configuration retains finite bound');

  await loop.commands.get('loop').handler('second synthetic task', ctx);
  const other = fakePi(); other.api.events = events; loopModule.default(other.api);
  await other.handlers.get('session_start')({}, context('owner-B'));
  assert.ok(fs.existsSync(path.join(ws, '.pi/autonomous-loop.armed.json')), 'child startup cannot delete parent arm marker');
  events.emit('pi-kit:recovery-blocked', { cwd: ws, sessionId: 'owner-B' });
  await loop.handlers.get('agent_end')({}, ctx);
  assert.equal(loop.steers.length, 21, 'foreign session cannot disarm parent');

  const recovery = fakePi(); recovery.api.events = events;
  (await loadExtension('extensions/recovery-orchestrator/index.ts'))(recovery.api);
  await recovery.handlers.get('session_start')({}, ctx);
  for (let i = 0; i < 3; i++) await recovery.commands.get('recover').handler('same-task', ctx);
  await loop.handlers.get('agent_end')({}, ctx);
  assert.equal(loop.steers.length, 21, 'recovery cap disarms same-session automatic loop before more starts');
  const blocked = JSON.parse(fs.readFileSync(path.join(ws, '.pi/recovery/blocked-owner-A.json'), 'utf8'));
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.sessionId, 'owner-A');

  const researchWs = path.join(ws, 'research'); fs.mkdirSync(researchWs);
  const researchCtx = { ...ctx, cwd: researchWs };
  const guard = fakePi();
  // Read-only session: no write-capable tool active, so "reads since last edit" is not a
  // stall and must never auto-escalate even after many reads.
  guard.api.getActiveTools = () => ['read', 'grep', 'find', 'ls'];
  (await loadExtension('extensions/progress-guard/index.ts'))(guard.api);
  await guard.handlers.get('session_start')({}, researchCtx);
  for (let i = 0; i < 20; i++) {
    await guard.handlers.get('tool_call')({ toolName: 'read', input: { path: `fact-${i}.md` } }, researchCtx);
    await guard.handlers.get('turn_end')({}, researchCtx);
  }
  assert.ok(!fs.existsSync(path.join(researchWs, '.pi/recovery/escalation.json')), 'a read-only session cannot trip the reads-since-edit stall');
  assert.ok(!fs.existsSync(path.join(researchWs, '.pi/ctx-contributions/progress-guard.json')));

  // Write-capable session, suggest mode: a recurring stall must now inject the review/delegate
  // checkpoint AND write the recovery marker on its own — the automatic replacement for the
  // manual /reflect, no mode switch required.
  const workWs = path.join(ws, 'work'); fs.mkdirSync(workWs);
  const workCtx = { ...ctx, cwd: workWs };
  const guard2 = fakePi(); // getActiveTools includes write/edit -> write-capable
  (await loadExtension('extensions/progress-guard/index.ts'))(guard2.api);
  await guard2.handlers.get('session_start')({}, workCtx);
  for (let i = 0; i < 12; i++) {
    await guard2.handlers.get('tool_call')({ toolName: 'read', input: { path: `src/file${i}.ts` } }, workCtx);
    await guard2.handlers.get('turn_end')({}, workCtx);
  }
  assert.ok(fs.existsSync(path.join(workWs, '.pi/recovery/escalation.json')), 'a recurring stall must auto-escalate even in suggest mode');
  assert.ok(fs.existsSync(path.join(workWs, '.pi/ctx-contributions/sessions/owner-A/progress-guard.json')), 'the review/delegate checkpoint must be injected automatically');
  assert.ok(!fs.existsSync(path.join(workWs, '.pi/ctx-contributions/progress-guard.json')), 'a session-id contribution must not land in the legacy flat directory');
  console.log('PASS liveness containment: finite limits, per-instance ownership, same-session recovery disarm, durable blocker, read-only stall suppression, automatic suggest-mode escalation');
} finally { restore(); restoreMode(); rmWorkspace(ws); }
