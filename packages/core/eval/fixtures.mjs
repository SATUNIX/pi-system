// Eval fixtures v1. Each fixture is deterministic and offline: it drives a real extension
// with fixture inputs and asserts the observable behaviour. Add fixtures here; run.mjs
// executes all of them and fails the suite on any regression.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadExtension, loadModule, fakePi, setEnv, tmpWorkspace, rmWorkspace, assert, ROOT, isolateKitEnv } from "./harness.mjs";

// A small deterministic trace fixture used by the memory/self-improvement fixtures.
function seedTrace(ws) {
  fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
  const lines = [];
  for (let i = 0; i < 4; i++) {
    lines.push(JSON.stringify({ kind: "call", tool: "read", target: "src/app.ts", argsHash: "a" }));
    lines.push(JSON.stringify({ kind: "result", tool: "read", target: "src/app.ts", status: "ok" }));
    lines.push(JSON.stringify({ kind: "call", tool: "grep", target: "TODO", argsHash: "b" }));
    lines.push(JSON.stringify({ kind: "result", tool: "grep", target: "TODO", status: "ok" }));
  }
  fs.writeFileSync(path.join(ws, ".pi", "trace.jsonl"), lines.join("\n") + "\n");
}

export const fixtures = [
  // ---- Safety: attended ask_human returns the operator's selected answer ----
  {
    name: "human-console/attended-question",
    category: "security",
    async run() {
      const register = await loadExtension("extensions/human-console/index.ts");
      const pi = fakePi(); register(pi.api);
      const ws = tmpWorkspace("pi-kit-eval-human-");
      try {
        const result = await pi.tools.get("ask_human").execute("1", { question: "Continue?", options: ["continue"] }, undefined, undefined, { cwd: ws, hasUI: true, ui: { select: async () => "continue" } });
        assert(/continue/.test(result.content[0].text), "attended question must return the selected answer");
      } finally { rmWorkspace(ws); }
    },
  },
  // ---- Security: tool-firewall default-deny + destructive-command layer (Epic 2) ----
  {
    name: "firewall/destructive-denied-benign-allowed",
    category: "security",
    async run() {
      const ws = tmpWorkspace("pi-kit-eval-fw-");
      const restoreIsolation = isolateKitEnv();
      const restoreAgentDir = setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent"));
      const restoreAudit = setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(ws, "a.jsonl"));
      const restorePolicy = setEnv("PI_KIT_FIREWALL_POLICY", undefined); // shipped policy
      const restoreHumanTimeout = setEnv("PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS", "1");
      // The firewall broker's poll timer is unref'd in production; this offline fixture has no
      // other ref'd handle while it awaits the headless broker timeout, so hold the loop open.
      const keepAlive = setInterval(() => {}, 1000);
      try {
        const register = await loadExtension("extensions/tool-firewall/index.ts");
        const pi = fakePi();
        register(pi.api);
        await pi.handlers.get("session_start")({}, { hasUI: true, ui: { notify() {} } });
        const headless = { hasUI: false, ui: {} };
        const call = (t, i) => pi.handlers.get("tool_call")({ toolName: t, input: i }, headless);
        assert((await call("bash", { command: "rm -rf /tmp/x" }))?.block === true, "rm -rf must deny");
        assert((await call("bash", { command: "echo hi" })) === undefined, "echo must allow");
        assert((await call("weird_unknown_tool", {}))?.block === true, "unknown tool must fail closed");
      } finally {
        clearInterval(keepAlive);
        restorePolicy();
        restoreAudit();
        restoreHumanTimeout();
        restoreAgentDir();
        restoreIsolation();
        rmWorkspace(ws);
      }
    },
  },
  // ---- Security: secret-guard content + bash-bypass (Epic 2) ----
  {
    name: "secret-guard/blocks-secrets-and-exfil",
    category: "security",
    async run() {
      const register = await loadExtension("extensions/secret-guard/index.ts");
      const pi = fakePi();
      register(pi.api);
      const ctx = { hasUI: false, ui: { notify() {} } };
      const call = (t, i) => pi.handlers.get("tool_call")({ toolName: t, input: i }, ctx);
      assert((await call("write", { path: ".env", content: "X=1" }))?.block === true, ".env write must block");
      assert(
        (await call("write", { path: "a.js", content: "AKIAIOSFODNN7EXAMPLE" }))?.block === true,
        "AWS key content must block",
      );
      assert((await call("bash", { command: "base64 config/.env" }))?.block === true, "base64 .env must block");
      assert((await call("bash", { command: "ls -la" })) === undefined, "ls must allow");
    },
  },
  // ---- Verification: verify-gate auto-records a verdict (Epic 4 Sprint 4.1) ----
  {
    name: "verify-gate/records-pass-and-fail-verdicts",
    category: "verification",
    async run() {
      const mod = await loadModule("extensions/verify-gate/index.ts");
      assert(typeof mod.recordVerifyVerdict === "function", "recordVerifyVerdict must be exported");
      const ws = tmpWorkspace("pi-kit-eval-vg-");
      try {
        mod.recordVerifyVerdict(ws, "verify", false, "type check failed");
        let board = JSON.parse(fs.readFileSync(path.join(ws, ".pi", "verdicts.json"), "utf8"));
        assert(board.verdicts.verify.pass === false, "failing verdict must be recorded");
        mod.recordVerifyVerdict(ws, "verify", true, "npm run verify passed");
        board = JSON.parse(fs.readFileSync(path.join(ws, ".pi", "verdicts.json"), "utf8"));
        assert(board.verdicts.verify.pass === true, "passing verdict must overwrite");
      } finally {
        rmWorkspace(ws);
      }
    },
  },
  // ---- Verification: finish-reason-retry rewrite actually matches pi's retry regex ----
  {
    name: "finish-reason-retry/rewrite-matches-pi-retry-regex",
    category: "verification",
    async run() {
      const mod = await loadModule("extensions/finish-reason-retry/index.ts");
      assert(typeof mod.toRetryableErrorMessage === "function", "toRetryableErrorMessage must be exported");
      const rewritten = mod.toRetryableErrorMessage("Provider finish_reason: error");
      // pi's _isRetryableError regex (agent-session.js) must classify the rewritten message as retryable.
      assert(mod.RETRYABLE_PROVIDER_ERROR.test(rewritten), "rewritten errorMessage must match pi's retryable regex");
      assert(/provider returned error/i.test(rewritten), "must carry the retryable marker");
      const pi = fakePi();
      mod.default(pi.api);
      const out = await pi.handlers.get("message_end")({ message: { role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: error" } });
      assert(out?.message?.errorMessage && /provider returned error/i.test(out.message.errorMessage), "handler must rewrite the retryable finish_reason");
      const untouched = await pi.handlers.get("message_end")({ message: { role: "assistant", stopReason: "error", errorMessage: "Provider finish_reason: content_filter" } });
      assert(untouched === undefined, "other finish_reasons must not be rewritten");
    },
  },
  // ---- Verification: record_verdict cannot forge independent (trusted) verdict sources ----
  {
    name: "verifier-board/record-verdict-refuses-trusted-sources",
    category: "verification",
    async run() {
      const mod = await loadModule("extensions/verifier-board/index.ts");
      assert(typeof mod.isTrustedVerdictSource === "function", "isTrustedVerdictSource must be exported");
      for (const s of ["review", "verify", "validator:exp-1"]) assert(mod.isTrustedVerdictSource(s), `${s} must be trusted`);
      for (const s of ["tests", "reviewer", "manual-check"]) assert(!mod.isTrustedVerdictSource(s), `${s} must not be trusted`);
      const ws = tmpWorkspace("pi-kit-eval-trusted-");
      try {
        const pi = fakePi();
        mod.default(pi.api);
        const call = (source) => pi.tools.get("record_verdict").execute("id", { source, pass: true, summary: "forged" }, undefined, undefined, { cwd: ws });
        for (const source of ["review", "verify", "validator:exp-1"]) {
          const res = await call(source);
          assert(/Refused/.test(res.content[0].text), `record_verdict must refuse trusted source ${source}`);
        }
        assert(!fs.existsSync(path.join(ws, ".pi", "verdicts.json")), "no board write for a refused source");
        const ok = await call("tests");
        assert(/Recorded tests: PASS/.test(ok.content[0].text), "non-trusted source must still record");
        const board = JSON.parse(fs.readFileSync(path.join(ws, ".pi", "verdicts.json"), "utf8"));
        assert(board.verdicts.tests?.pass === true && board.verdicts.review === undefined, "only the non-trusted verdict is stored");
      } finally {
        rmWorkspace(ws);
      }
    },
  },
  // ---- End-to-end: a failing /verify auto-records a FAIL verdict and blocks completion ----
  // (Epic 4 Sprint 4.1 DoD — a broken verify is the deterministic stand-in for a broken tsc.)
  {
    name: "verify-gate+orchestrator/failing-verify-blocks-mission-complete",
    category: "verification",
    async run() {
      const vg = await loadModule("extensions/verify-gate/index.ts");
      const orch = await loadModule("extensions/orchestrator/index.ts");
      const ws = tmpWorkspace("pi-kit-eval-e2e-");
      try {
        // A fixture project whose `verify` script deterministically fails (stands in for a broken tsc).
        fs.writeFileSync(
          path.join(ws, "package.json"),
          JSON.stringify({ name: "eval-fixture", scripts: { verify: 'node -e "process.exit(1)"' } }),
        );
        const pi = fakePi();
        vg.default(pi.api);
        await pi.handlers.get("session_start")({}, { cwd: ws });
        await pi.commands.get("verify").handler("", { cwd: ws, ui: { setStatus() {}, notify() {} } });

        const board = JSON.parse(fs.readFileSync(path.join(ws, ".pi", "verdicts.json"), "utf8"));
        assert(board.verdicts.verify.pass === false, "failing /verify must auto-record a FAIL verdict");
        assert(orch.missionCompleteBlocked(ws).blocked === true, "failing verdict must block mission-complete");
      } finally {
        rmWorkspace(ws);
      }
    },
  },
  // ---- Orchestration: mission-complete gate refuses done on failing verdict (Epic 4 4.1) ----
  {
    name: "orchestrator/refuses-mission-complete-on-failing-verdict",
    category: "orchestration",
    async run() {
      const restoreIsolation = isolateKitEnv();
      const mod = await loadModule("extensions/orchestrator/index.ts");
      assert(typeof mod.missionCompleteBlocked === "function", "missionCompleteBlocked must be exported");
      const ws = tmpWorkspace("pi-kit-eval-orch-");
      const restore = setEnv("PI_KIT_ORCH_DISABLE", undefined);
      const restoreVerify = setEnv("PI_KIT_VERIFY_ON_TURN", "1");
      try {
        fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
        const verdicts = path.join(ws, ".pi", "verdicts.json");
        fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { verify: "node test.mjs" } }));

        // Failing verdict -> blocked + a diagnostic fires at the final turn.
        fs.writeFileSync(verdicts, JSON.stringify({ verdicts: { verify: { pass: false, summary: "tsc broke", at: "t" } } }));
        assert(mod.missionCompleteBlocked(ws).blocked === true, "failing verdict must block completion");
        const pi = fakePi();
        mod.default(pi.api);
        await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
        await pi.handlers.get("tool_result")({ toolName: "edit", isError: false }, { cwd: ws });
        await pi.handlers.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } }, { cwd: ws, ui: { notify() {}, setStatus() {} } });
        assert(pi.steers.length === 1, "final turn must diagnose unverified work");
        assert(/verification diagnostic/.test(pi.steers[0].message.content), "diagnostic must explain the block");

        // All-pass -> not blocked, no steer.
        fs.writeFileSync(verdicts, JSON.stringify({ verdicts: { verify: { pass: true, summary: "ok", at: "t" } } }));
        assert(mod.missionCompleteBlocked(ws).blocked === false, "all-pass must allow completion");
        const pi2 = fakePi();
        mod.default(pi2.api);
        await pi2.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
        await pi2.handlers.get("tool_result")({ toolName: "edit", isError: false }, { cwd: ws });
        await pi2.handlers.get("turn_end")({ message: { role: "assistant", stopReason: "stop" } }, { cwd: ws, ui: { notify() {}, setStatus() {} } });
        assert(pi2.steers.length === 0, "no steer when the board is all-PASS");
      } finally {
        restoreVerify();
        restore();
        restoreIsolation();
        rmWorkspace(ws);
      }
    },
  },
  // ---- Recovery: arming autonomous-loop flips progress-guard to auto (Epic 5 Sprint 5.1) ----
  {
    name: "progress-guard/autonomous-arm-flips-mode-to-auto",
    category: "recovery",
    async run() {
      const mod = await loadModule("extensions/progress-guard/index.ts");
      assert(typeof mod.resolveMode === "function", "resolveMode must be exported");
      const ws = tmpWorkspace("pi-kit-eval-arm-");
      const restore = setEnv("PI_KIT_GUARD_MODE", undefined); // no operator env var
      try {
        fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
        assert(mod.resolveMode(ws, null) === "suggest", "no marker + no env -> suggest");
        const marker = path.join(ws, ".pi", "autonomous-loop.armed.json");
        // A legacy marker with no heartbeat (WU-11) must not pin auto mode: only a fresh,
        // parseable `at` within the TTL keeps the loop armed.
        fs.writeFileSync(marker, JSON.stringify({ armed: true }));
        assert(mod.resolveMode(ws, null) === "suggest", "legacy marker without `at` -> suggest");
        fs.writeFileSync(marker, JSON.stringify({ armed: true, at: new Date().toISOString() }));
        assert(mod.resolveMode(ws, null) === "auto", "fresh arm marker present -> auto with no env var");
      } finally {
        restore();
        rmWorkspace(ws);
      }
    },
  },
  // ---- Recovery: A→B→A oscillation detection (Epic 5 Sprint 5.2) ----
  {
    name: "progress-guard/oscillation-detected",
    category: "recovery",
    async run() {
      const mod = await loadModule("extensions/progress-guard/index.ts");
      assert(typeof mod.findOscillation === "function", "findOscillation must be exported");
      assert(mod.findOscillation(["read|a", "read|b", "read|a"]) !== null, "A→B→A must be flagged");
      assert(mod.findOscillation(["read|a", "read|b", "read|c"]) === null, "A→B→C is not oscillation");
      assert(mod.findOscillation(["read|a", "read|a", "read|a"]) === null, "repeat (not alternating) is not oscillation");
    },
  },
  // ---- Recovery: progress-guard escalation drives recovery-orchestrator (Epic 5 Sprint 5.3) ----
  {
    name: "recovery-orchestrator/escalation-enters-recovery-flow",
    category: "recovery",
    async run() {
      const mod = await loadModule("extensions/recovery-orchestrator/index.ts");
      assert(typeof mod.planRecovery === "function", "planRecovery must be exported");
      const ws = tmpWorkspace("pi-kit-eval-rec-");
      try {
        // Simulate progress-guard escalation for a stuck signature.
        fs.mkdirSync(path.join(ws, ".pi", "recovery"), { recursive: true });
        fs.writeFileSync(
          path.join(ws, ".pi", "recovery", "escalation.json"),
          JSON.stringify({ signature: "repeat:abc", reason: "repeated action", count: 3, at: "t" }),
        );
        const pi = fakePi();
        mod.default(pi.api);
        await pi.handlers.get("session_start")({}, { cwd: ws, ui: { notify() {} } });
        // session_start clears escalation; re-arm it (as progress-guard would mid-session).
        fs.writeFileSync(
          path.join(ws, ".pi", "recovery", "escalation.json"),
          JSON.stringify({ signature: "repeat:abc", reason: "repeated action", count: 3, at: "t" }),
        );
        await pi.handlers.get("turn_end")({}, { cwd: ws, ui: { notify() {} } });

        // A steering contribution was written and a recovery report scaffold created.
        const contrib = path.join(ws, ".pi", "ctx-contributions", "recovery-orchestrator.json");
        assert(fs.existsSync(contrib), "recovery must write a context-sieve contribution");
        assert(/fresh scouts|top 10|primary/.test(fs.readFileSync(contrib, "utf8")), "steer must describe the §2 flow");
        const reports = fs.readdirSync(path.join(ws, ".pi", "recovery")).filter((f) => f.endsWith(".md"));
        assert(reports.length === 1, "recovery must write exactly one report scaffold");
        // Escalation consumed (won't re-enter for the same marker).
        assert(!fs.existsSync(path.join(ws, ".pi", "recovery", "escalation.json")), "escalation marker must be consumed");
      } finally {
        rmWorkspace(ws);
      }
    },
  },
  // ---- Memory: skill-forge synthesises a CONFORMING SKILL.md from a trace (Epic 6 Sprint 6.1) ----
  {
    name: "skill-forge/synthesises-conforming-skill",
    category: "memory",
    async run() {
      const mod = await loadModule("extensions/skill-forge/index.ts");
      assert(typeof mod.mineTrace === "function" && typeof mod.synthesiseSkillMd === "function", "miner/synthesiser exported");
      const ws = tmpWorkspace("pi-kit-eval-forge-");
      try {
        seedTrace(ws);
        const register = mod.default;
        const pi = fakePi();
        register(pi.api);
        const res = await pi.tools.get("skill_synthesise").execute("1", { skill_name: "read-once-flow", category: "efficiency" }, null, null, { cwd: ws });
        assert(/wrote candidate skill/.test(res.content[0].text), "synthesise must write a candidate");
        const skillMd = fs.readFileSync(path.join(ws, ".pi", "skill-proposals", "read-once-flow", "SKILL.md"), "utf8");
        // Must pass Epic 3's frontmatter lint: name + description + category.
        const fm = skillMd.slice(0, skillMd.indexOf("\n---", 3));
        for (const key of ["name", "description", "category"]) {
          assert(new RegExp(`\\n?${key}:\\s*\\S`).test(fm), `synthesised SKILL.md must have ${key}`);
        }
        assert(/## Procedure/.test(skillMd) && /## Done/.test(skillMd), "runbook sections present");
      } finally {
        rmWorkspace(ws);
      }
    },
  },
  // ---- Memory: skill_score returns a real eval-tied number (Epic 6 Sprint 6.1) ----
  {
    name: "skill-forge/score-is-eval-tied",
    category: "memory",
    async run() {
      // Verify the harness the scorer relies on exposes --json with passed/total.
      const out = execFileSync("node", ["packages/core/eval/run.mjs", "--json", "--category", "security"], { cwd: ROOT, encoding: "utf8" });
      let parsed;
      try {
        parsed = JSON.parse(out);
      } catch (error) {
        throw new Error(`eval --json produced invalid JSON: ${String(error?.message ?? error)}`);
      }
      assert(typeof parsed.passed === "number" && typeof parsed.total === "number" && parsed.total > 0, "eval --json must expose passed/total for scoring");
      assert(parsed.passed === parsed.total, "security fixtures must pass (score baseline)");
    },
  },
  // ---- Self-improvement: /improve proposes a reviewable diff, applies only when armed (6.2) ----
  {
    name: "self-improvement/proposes-diff-without-autocommit",
    category: "memory",
    async run() {
      const mod = await loadModule("extensions/self-improvement/index.ts");
      assert(typeof mod.buildProposal === "function", "buildProposal exported");
      const ws = tmpWorkspace("pi-kit-eval-improve-");
      const restoreArm = setEnv("PI_KIT_SELF_IMPROVE_ARM", undefined);
      try {
        seedTrace(ws);
        fs.writeFileSync(path.join(ws, "AGENTS.md"), "# AGENTS.md\n");
        const proposal = mod.buildProposal(ws);
        assert(proposal.hasSignal === true, "seeded repeated reads must yield a signal");
        assert(/^--- a\/AGENTS\.md/m.test(proposal.diff), "proposal must include a unified diff preview");

        // Unarmed /improve: writes a proposal artifact but does NOT touch AGENTS.md.
        const pi = fakePi();
        mod.default(pi.api);
        await pi.commands.get("improve").handler("", { cwd: ws, ui: { notify() {} } });
        assert(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8") === "# AGENTS.md\n", "unarmed /improve must NOT modify AGENTS.md");
        const proposals = fs.readdirSync(path.join(ws, ".pi", "self-improvement"));
        assert(proposals.length >= 1, "a reviewable proposal artifact must be written");

        // Armed /improve: applies to AGENTS.md.
        await pi.commands.get("improve").handler("arm", { cwd: ws, ui: { notify() {} } });
        assert(/Learned notes/.test(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8")), "armed /improve must append to AGENTS.md");
      } finally {
        restoreArm();
        rmWorkspace(ws);
      }
    },
  },
  // ---- Dream mode: only allowlisted paths are modified, enforced via protected-paths (6.3) ----
  {
    name: "dream-mode/touches-only-allowlisted-paths",
    category: "memory",
    async run() {
      const ws = tmpWorkspace("pi-kit-eval-dream-");
      try {
        seedTrace(ws);
        fs.writeFileSync(path.join(ws, "AGENTS.md"), "# AGENTS.md\n");
        fs.mkdirSync(path.join(ws, "src"), { recursive: true });
        fs.writeFileSync(path.join(ws, "src", "app.ts"), "export const x = 1;\n");
        const srcBefore = fs.readFileSync(path.join(ws, "src", "app.ts"), "utf8");

        execFileSync("node", ["packages/core/dream.mjs", "--cwd", ws], { cwd: ROOT, encoding: "utf8" });

        // Allowlisted paths updated; non-allowlisted source untouched.
        assert(/Learned notes \(dream mode\)/.test(fs.readFileSync(path.join(ws, "AGENTS.md"), "utf8")), "dream must update AGENTS.md");
        assert(fs.existsSync(path.join(ws, ".pi", "memory", "dream-notes.md")), "dream must write a memory note");
        assert(fs.readFileSync(path.join(ws, "src", "app.ts"), "utf8") === srcBefore, "dream must NOT touch src/");

        // Verify via protected-paths that the same allowlist blocks a stray write.
        const pp = await loadExtension("vendor/protected-paths/index.ts");
        const restore = setEnv("PI_KIT_WRITE_ALLOWLIST", "AGENTS.md;.pi/memory;GOAL.yaml");
        try {
          const pi = fakePi();
          pp(pi.api);
          const blocked = await pi.handlers.get("tool_call")({ toolName: "write", input: { path: "src/app.ts" } }, { hasUI: false, ui: {} });
          assert(blocked?.block === true, "protected-paths allowlist must block a non-allowlisted write");
          const allowed = await pi.handlers.get("tool_call")({ toolName: "write", input: { path: "AGENTS.md" } }, { hasUI: false, ui: {} });
          assert(allowed === undefined, "protected-paths allowlist must permit an allowlisted write");
        } finally {
          restore();
        }
      } finally {
        rmWorkspace(ws);
      }
    },
  },
  // ---- Orchestration: delegation trigger fires on complex, not trivial, input (Epic 4 4.2) ----
  {
    name: "orchestrator/delegation-trigger-on-complex-only",
    category: "orchestration",
    async run() {
      const restoreIsolation = isolateKitEnv();
      const register = await loadExtension("extensions/orchestrator/index.ts");
      const ws = tmpWorkspace("pi-kit-eval-orch2-");
      const restore = setEnv("PI_KIT_ORCH_DISABLE", undefined);
      try {
        const pi = fakePi();
        register(pi.api);
        const ctx = { cwd: ws, ui: { notify() {}, setStatus() {} } };
        await pi.handlers.get("session_start")({}, ctx);
        const contrib = path.join(ws, ".pi", "ctx-contributions", "orchestrator.json");

        await pi.handlers.get("input")(
          { source: "interactive", text: "Implement a new authentication system across multiple services and refactor the whole billing module thoroughly." },
          ctx,
        );
        assert(fs.existsSync(contrib), "complex task must write a delegation directive");

        await pi.handlers.get("input")({ source: "interactive", text: "hi there" }, ctx);
        assert(!fs.existsSync(contrib), "trivial task must not delegate");
      } finally {
        restore();
        restoreIsolation();
        rmWorkspace(ws);
      }
    },
  },
];
