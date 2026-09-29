#!/usr/bin/env node
/**
 * Offline checks for caveman's config parsing of `detailTriggers`.
 *
 * A malformed `~/.pi/agent/caveman.json` such as `{"detailTriggers":[null]}` used to be
 * accepted verbatim because loadConfig() only checked the array was non-empty. The shipped
 * `pi.on("input", ...)` handler then called `raw.toLowerCase()` on the null element and threw
 * on the next interactive prompt. These checks pin that:
 *   1. Non-string trigger elements are dropped; the malformed config still loads and an
 *      interactive input event does not throw.
 *   2. Valid triggers are unchanged: `/docs-*` still flips the session into detail mode.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace, setEnv } from "../packages/core/eval/harness.mjs";

function fakeCtx(cwd) {
  const statuses = [];
  const notices = [];
  return {
    cwd,
    ui: {
      setStatus: (key, value) => statuses.push({ key, value }),
      notify: (msg, level) => notices.push({ msg, level }),
    },
    sessionManager: { getEntries: () => [] },
    statuses,
    notices,
  };
}

async function withAgentHome(fn) {
  const home = tmpWorkspace("pi-kit-caveman-home-");
  const restoreHome = setEnv("HOME", home);
  const restoreLevel = setEnv("PI_KIT_CAVEMAN_LEVEL", undefined);
  try {
    const agentDir = path.join(home, ".pi", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    await fn(agentDir);
  } finally {
    restoreLevel();
    restoreHome();
    rmWorkspace(home);
  }
}

function writeConfig(agentDir, config) {
  fs.writeFileSync(path.join(agentDir, "caveman.json"), JSON.stringify(config), "utf8");
}

async function testMalformedTriggersDoNotThrow() {
  await withAgentHome(async (agentDir) => {
    writeConfig(agentDir, { detailTriggers: [null, "/docs-*"] });
    const pi = fakePi();
    (await loadExtension("vendor/caveman/index.ts"))(pi.api);

    const ws = tmpWorkspace("pi-kit-caveman-ws-");
    try {
      const ctx = fakeCtx(ws);
      await pi.handlers.get("session_start")(undefined, ctx);
      // Pre-fix this threw: matchesTrigger() ran null.toLowerCase() while iterating triggers.
      await pi.handlers.get("input")({ source: "interactive", text: "hello world" }, ctx);
      assert.equal(
        ctx.statuses.some((s) => s.value === "off (detail)"),
        false,
        "a non-matching prompt must not flip detail mode",
      );
    } finally {
      rmWorkspace(ws);
    }
  });
}

async function testValidTriggerFlipsDetailMode() {
  await withAgentHome(async (agentDir) => {
    writeConfig(agentDir, { detailTriggers: ["/docs-*"] });
    const pi = fakePi();
    // caveman persists state via appendEntry; fakePi does not model it, and the flip is
    // best-effort, so a no-op stand-in keeps the handler on the happy path.
    pi.api.appendEntry = () => {};
    (await loadExtension("vendor/caveman/index.ts"))(pi.api);

    const ws = tmpWorkspace("pi-kit-caveman-ws-");
    try {
      const ctx = fakeCtx(ws);
      await pi.handlers.get("session_start")(undefined, ctx);
      await pi.handlers.get("input")({ source: "interactive", text: "/docs-abc" }, ctx);
      assert.equal(
        ctx.statuses.some((s) => s.value === "off (detail)"),
        true,
        "/docs-abc must flip the session into detail mode",
      );
      assert.equal(
        ctx.notices.some((n) => /detailed writing detected/.test(n.msg)),
        true,
        "flipping detail mode must notify the user",
      );
    } finally {
      rmWorkspace(ws);
    }
  });
}

const tests = [
  ["malformed detailTriggers (null element) does not crash the input handler", testMalformedTriggersDoNotThrow],
  ["valid /docs-* trigger still flips detail mode", testValidTriggerFlipsDetailMode],
];

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  OK: ${name}`);
  } catch (error) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${error.stack || error.message}`);
  }
}

if (failed > 0) {
  console.error(`\n[caveman-smoke] ${failed}/${tests.length} FAILED`);
  process.exit(1);
}
console.log(`\n[caveman-smoke] all ${tests.length} checks passed`);
