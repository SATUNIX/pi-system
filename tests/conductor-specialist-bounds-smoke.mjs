#!/usr/bin/env node
// Offline bounds smoke for conductor specialist children: stream cap, idle watchdog, wall-clock
// ceiling, clean exit, and abort. Fully deterministic — fake child, no pi, no network.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { loadModule } from "../packages/core/eval/harness.mjs";

const { streamSpecialistChild, specialistBounds } = await loadModule("extensions/conductor/index.ts");

// The bounds timers are unref'd (a real spawned child keeps the loop alive). A fake child does
// not, so hold the loop open for the duration of the assertions.
const keepalive = setInterval(() => {}, 1000);

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; queueMicrotask(() => child.emit("close", null)); return true; };
  return child;
}

// 1. Defaults, overrides, and safe fallback for unusable values (never an unbounded cap).
{
  const d = specialistBounds({});
  assert.equal(d.streamCapBytes, 256 * 1024 * 1024, "default stream cap");
  assert.equal(d.idleTimeoutMs, 15 * 60 * 1000, "default idle timeout");
  assert.equal(d.maxRuntimeMs, 0, "wall-clock disabled by default");

  const o = specialistBounds({
    PI_KIT_SPECIALIST_STREAM_CAP_BYTES: "65536",
    PI_KIT_SPECIALIST_IDLE_TIMEOUT_MS: "50",
    PI_KIT_SPECIALIST_MAX_RUNTIME_MS: "500",
  });
  assert.deepEqual(o, { streamCapBytes: 65536, idleTimeoutMs: 50, maxRuntimeMs: 500 });

  const bad = specialistBounds({ PI_KIT_SPECIALIST_STREAM_CAP_BYTES: "1", PI_KIT_SPECIALIST_IDLE_TIMEOUT_MS: "-5" });
  assert.equal(bad.streamCapBytes, 256 * 1024 * 1024, "below-floor cap falls back to default");
  assert.equal(bad.idleTimeoutMs, 15 * 60 * 1000, "negative idle falls back to default");
}

// 2. A runaway child is killed at the cap and reports it.
{
  const bounds = { streamCapBytes: 64 * 1024, idleTimeoutMs: 0, maxRuntimeMs: 0 };
  const child = fakeChild();
  const p = streamSpecialistChild(child, bounds, undefined);
  child.stdout.write("x".repeat(bounds.streamCapBytes * 2));
  const r = await p;
  assert.equal(r.killed, "stream-cap", "stream cap must be reported honestly");
  assert.equal(r.code, 1);
}

// 3. A silent child is killed promptly by the idle watchdog.
{
  const bounds = { streamCapBytes: 1024 * 1024, idleTimeoutMs: 60, maxRuntimeMs: 0 };
  const child = fakeChild();
  const started = Date.now();
  const r = await streamSpecialistChild(child, bounds, undefined);
  assert.equal(r.killed, "idle-timeout");
  assert.ok(Date.now() - started < 2000, "idle kill must resolve promptly");
}

// 4. A child that keeps dribbling output (defeating the idle watchdog) is bounded by wall-clock.
{
  const bounds = { streamCapBytes: 4 * 1024 * 1024, idleTimeoutMs: 200, maxRuntimeMs: 100 };
  const child = fakeChild();
  const drip = setInterval(() => child.stdout.write("{}\n"), 20);
  try {
    const r = await streamSpecialistChild(child, bounds, undefined);
    assert.equal(r.killed, "wall-clock");
  } finally { clearInterval(drip); }
}

// 5. A clean child resolves code 0 and its message_end is captured.
{
  const bounds = { streamCapBytes: 1024 * 1024, idleTimeoutMs: 500, maxRuntimeMs: 0 };
  const child = fakeChild();
  const p = streamSpecialistChild(child, bounds, undefined);
  queueMicrotask(() => {
    child.stdout.write(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }) + "\n");
    child.emit("close", 0);
  });
  const r = await p;
  assert.equal(r.killed, undefined, "a clean child is not reported as killed");
  assert.equal(r.code, 0);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].role, "assistant");
}

// 6. An abort signal stops the child and is reported as such.
{
  const bounds = { streamCapBytes: 1024 * 1024, idleTimeoutMs: 0, maxRuntimeMs: 0 };
  const ac = new AbortController();
  const child = fakeChild();
  const p = streamSpecialistChild(child, bounds, ac.signal);
  ac.abort();
  const r = await p;
  assert.equal(r.killed, "signal");
}

console.log("[conductor-specialist-bounds-smoke] OK");
clearInterval(keepalive);