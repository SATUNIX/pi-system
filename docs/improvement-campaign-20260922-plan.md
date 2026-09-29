# Improvement campaign 2026-09-22 — implementation plan

Produced by `planner` from `docs/improvement-campaign-20260922-findings.md`.
Work units are ordered for implementation. Each names its verification command.
See the findings file for `file:line` evidence.

## Work-unit table

| WU | Priority | Files | Verification command | Depends on | Independent? |
| ---- | ---------- | ------- | ---------------------- | ----------- | -------------- |
| WU-1 | P0 | `packages/extensions/src/secret-guard/index.ts`, `tests/secret-guard-smoke.mjs` | `npm run test:security` | — | yes |
| WU-2 | P0 | `packages/extensions/third_party/protected-paths/index.ts`, `tests/protected-paths-smoke.mjs` | `npm run smoke:protected-paths` | — | yes |
| WU-3 | P0 | `packages/extensions/third_party/subagent/result.ts`, `tests/subagent-containment-smoke.mjs` | `npm run smoke:subagent-containment` | — | yes |
| WU-4 | P0 | `packages/extensions/src/conductor/index.ts`, `tests/conductor-specialist-bounds-smoke.mjs` (new) | `node tests/conductor-specialist-bounds-smoke.mjs` | — | yes |
| WU-5 | P0 | `packages/extensions/src/context-sieve/index.ts`, `tests/context-budget-smoke.mjs`, `tests/compaction-continuity-smoke.mjs` | `npm run smoke:context-budget && npm run smoke:compaction-continuity` | — | yes |
| WU-6 | P0 | `packages/extensions/src/verify-gate/index.ts`, `tests/verify-failclosed-smoke.mjs` | `npm run smoke:verify-failclosed` | — | yes |
| WU-7 | P1 | `packages/extensions/src/verifier-board/index.ts`, `packages/extensions/src/orchestrator/index.ts`, `packages/extensions/src/conductor/index.ts`, `tests/verifier-board-trust-smoke.mjs` (new) | `node tests/verifier-board-trust-smoke.mjs` | WU-4 | no (shared conductor file) |
| WU-8 | P1 | `packages/extensions/third_party/trigger-compact/index.ts`, `tests/trigger-compact-threshold-smoke.mjs` | `npm run smoke:trigger-compact-threshold` | — | yes |
| WU-9 | P1 | `packages/core/verify.mjs`, `docs/WRITING_EXTENSIONS.md`, `packages/core/schema/extension.schema.json`, `packages/extensions/third_party/todo/extension.json`, `packages/extensions/src/save/extension.json`, `packages/extensions/src/session-helpers/extension.json`, `packages/extensions/third_party/custom-footer/extension.json`, `packages/extensions/third_party/trigger-compact/extension.json` | `npm run verify && npm run check:all` | — | yes |
| WU-10 | P2 | `packages/extensions/src/recovery-orchestrator/index.ts`, `tests/recovery-grounding-smoke.mjs` | `npm run smoke:recovery-grounding` | — | yes |
| WU-11 | P2 | `packages/extensions/src/progress-guard/index.ts`, `tests/progress-guard-agsix-smoke.mjs` | `npm run smoke:progress-guard` | — | yes |
| WU-12 | P2 | `package.json` | `node packages/core/check-all.mjs --list \| grep -E 'smoke:(conductor-specialist-bounds\|verifier-board-trust)'` | WU-4, WU-7 | no |
| WU-13 | P2 | `.github/workflows/ci.yml` | `npm run check:all` | — | yes |

## Unit specs

### WU-1: secret-guard scans the live `edit` schema (`edits[].newText`)

- Priority: P0. Findings: Area 4 F2.
- Files: `packages/extensions/src/secret-guard/index.ts`, `tests/secret-guard-smoke.mjs`.
- Change: `contentOf` only reads flat `content|text|new_string|newText|newString|data|body`, so the current `edit` input `{path, edits:[{oldText,newText}]}` is never content-scanned. Extend `contentOf` to traverse `input.edits` (array of objects) and collect every string `oldText`/`newText`/legacy `new_string`/`newString` value, then join as today. Do NOT touch `PROTECTED_PATTERNS` (parity check with `pentest-governance-domain`).
- Acceptance: `edit {path:"notes.md", edits:[{oldText:"", newText:"-----BEGIN OPENSSH PRIVATE KEY-----\n…"}]}` → `{block:true}`; `edit {path:"app.js", edits:[{oldText:"", newText:"const k='AKIAIOSFODNN7EXAMPLE';"}]}` → `{block:true}`; legacy `new_string` still passes; benign `edits` allowed.
- Verify: `npm run test:security`. Risk: low (guard `Array.isArray`).

### WU-2: protect control/audit paths by default; augment (not replace) `PI_KIT_PROTECTED_PATHS`

- Priority: P0. Findings: Area 4 F3, F4, F5, F6; Area 5 F2.
- Files: `packages/extensions/third_party/protected-paths/index.ts`, `tests/protected-paths-smoke.mjs`.
- Change: add to `DEFAULT_PROTECTED`: `.pi/auto-mode.json`, `packages/extensions/src/tool-firewall/default-policy.json`, `packages/core/policies/`, `.pi/tool-firewall-audit.jsonl`, `.pi/trace.jsonl`, `.pi/agents/`, `.pi/verdicts.json`, `.pi/ctx-contributions/`, `.pi/engagement/`. Fix `getProtectedPaths` so non-empty `PI_KIT_PROTECTED_PATHS` is unioned with `DEFAULT_PROTECTED` (env can only add). Ensure `bashWriteTargets` covers `>`/`tee`/`cp`/`mv` writes to those dirs.
- Acceptance: `write`/`edit` to each new path blocks; `bash "printf x > .pi/auto-mode.json"` and `bash "printf x > .pi/ctx-contributions/x.json"` block; with `PI_KIT_PROTECTED_PATHS="custom-thing"`, `.env`/`.git/` remain blocked; existing smoke passes.
- Verify: `npm run smoke:protected-paths`. Risk: medium.

### WU-3: subagent wall-clock kill is a limit, not a retryable transient failure

- Priority: P0. Findings: Area 1 F1, F2.
- Files: `packages/extensions/third_party/subagent/result.ts`, `tests/subagent-containment-smoke.mjs`.
- Change: add `wall-clock` to `isFailedResult`; treat it like `timeout`/`stream-cap` in `classifyFailure` (`hasWork ? "fatal" : "limit"`, never `transient`).
- Acceptance: `isFailedResult({stopReason:"wall-clock",…}) === true`; `classifyFailure(wall-clock, no output) === "limit"` and never `"transient"`; with output `=== "fatal"`; existing cases pass.
- Verify: `npm run smoke:subagent-containment`. Risk: low.

### WU-4: conductor `runSpecialistProcess` needs a stream cap and a watchdog

- Priority: P0. Findings: Area 2 F1, F2.
- Files: `packages/extensions/src/conductor/index.ts`, `tests/conductor-specialist-bounds-smoke.mjs` (new).
- Change: mirror `conductor/validate/validator.ts`. Add `PI_KIT_SPECIALIST_STREAM_CAP_BYTES` (default 256 MiB), `PI_KIT_SPECIALIST_IDLE_TIMEOUT_MS` (default 15 min, `0` disables), `PI_KIT_SPECIALIST_MAX_RUNTIME_MS` wall-clock; each kill calls `stop()` and resolves `{ok:false, reason:…}`. Extract child-driving into an exported helper (e.g. `runSpecialistChild(args, {spawn, bounds, signal})`) that `runSpecialistProcess` calls with real `spawn`; test injects a fake child `EventEmitter`/`PassThrough`.
- Acceptance: fake child past cap killed, buffer never exceeds cap; silent fake child killed within short window, resolves failure < 2 s; clean fake child exit 0 with valid `message_end` resolves `{ok:true, output}`; no timer leaks (unref/clear on close).
- Verify: `node tests/conductor-specialist-bounds-smoke.mjs`. Risk: medium. Budget-slot refund (Area 2 F3) is NOT addressed.

### WU-5: context-sieve snapshot suppression must be load-order independent

- Priority: P0. Findings: Area 5 F3.
- Files: `packages/extensions/src/context-sieve/index.ts`, `tests/context-budget-smoke.mjs`, `tests/compaction-continuity-smoke.mjs`.
- Change: replace per-session file snapshot with a module-scope session epoch (`BigInt(Date.now()) * 1_000_000n` captured once at module load); include any file whose `mtimeNs >= epoch`, exclude older. Update the two tests that encode the inverted assumption.
- Acceptance: contribution rewritten by another extension during `session_start` after module load is included; unchanged prior-session file (mtime < epoch) excluded; conductor contribution written from `before_agent_start` included same session; existing budget/truncation assertions pass.
- Verify: `npm run smoke:context-budget && npm run smoke:compaction-continuity`. Risk: medium.

### WU-6: verify-gate board writes take the shared lock; automatic path honors `PI_KIT_VERIFY_CMD`

- Priority: P0. Findings: Area 3 F1, F6.
- Files: `packages/extensions/src/verify-gate/index.ts`, `tests/verify-failclosed-smoke.mjs`.
- Change: add a local `withBoardLock` (O_EXCL lockfile + 60 s stale takeover, `.pi/verdicts.lock`) wrapping every read-modify-write in `recordVerifyVerdict`/`removeVerdict`. Make the automatic (`turn_end`) path use the same override resolution as `/verify` so `PI_KIT_VERIFY_CMD` is honored without a `package.json.scripts.verify`.
- Acceptance: concurrent writer holding `.pi/verdicts.lock` causes fail-closed/retry not clobber; sequential concurrent-writer test shows both verdicts survive; with `PI_KIT_VERIFY_CMD` set and no `verify` script, automatic path runs it and records the verdict; generation/no-temp-leftover assertions pass.
- Verify: `npm run smoke:verify-failclosed`. Risk: medium. `runCheck` shell-injection out of scope.

### WU-7: definition-of-done requires an independent (trusted) verdict source

- Priority: P1. Findings: Area 3 F2.
- Files: `packages/extensions/src/verifier-board/index.ts`, `packages/extensions/src/orchestrator/index.ts`, `packages/extensions/src/conductor/index.ts`, `tests/verifier-board-trust-smoke.mjs` (new).
- Change: `summarize.overall` requires all recorded sources pass AND at least one trusted source (`verify`, `review`, `validator:*`) present and passing. Apply same to orchestrator `missionCompleteBlocked` and conductor `verifierBoardBlocked`.
- Acceptance: board with only untrusted `{reviewer: PASS}` → `overall:false`, both blocked-checks `blocked:true`; `{verify: PASS}` or `{validator:<id>: PASS}` passes; any FAIL still fails; existing cases pass.
- Verify: `node tests/verifier-board-trust-smoke.mjs`. Depends WU-4. Risk: medium.

### WU-8: trigger-compact threshold must be bound to the model context window

- Priority: P1. Findings: Area 5 F8, F9.
- Files: `packages/extensions/third_party/trigger-compact/index.ts`, `tests/trigger-compact-threshold-smoke.mjs`.
- Change: apply the `>= window` guard to the env path (clamp or reject with a warning); fix the crossing detector so a resumed session already above threshold fires once.
- Acceptance: env threshold above window clamped/rejected so auto-compact can fire; first observed count already > threshold triggers once; existing cases pass.
- Verify: `npm run smoke:trigger-compact-threshold`. Risk: medium.

### WU-9: verification gate tightening + extension-authoring doc/schema truth

- Priority: P1. Findings: Area 6 F1, F2, F3, F4, F5, F6, F9.
- Files: `packages/core/verify.mjs`, `docs/WRITING_EXTENSIONS.md`, `packages/core/schema/extension.schema.json`, `packages/extensions/third_party/todo/extension.json`, `packages/extensions/src/save/extension.json`, `packages/extensions/src/session-helpers/extension.json`, `packages/extensions/third_party/custom-footer/extension.json`, `packages/extensions/third_party/trigger-compact/extension.json`.
- Change (validation-gate tightening — flagged, permitted): bidirectional hooks-drift check + fix `todo/extension.json`; recursive `.ts` scan (covers `conductor/synth/agent-synth.ts`, `conductor/validate/validator.ts`); freshness gate for `docs/EXTENSIONS.md`/`docs/registry.json`; cross-check `runtime.nodeBuiltins` against actual `node:*` imports + fix 4 manifests; add `provenance` to schema `required`; correct the fictional hooks table and the "imports limited to node/typebox" claim in `docs/WRITING_EXTENSIONS.md`.
- Acceptance: over-declared hook fails `npm run verify`; nested `.ts` violation detected; stale `EXTENSIONS.md` or drifted `nodeBuiltins` fails verify; deleting `provenance` fails schema; after fixes the tree passes.
- Verify: `npm run verify && npm run check:all`. Risk: high; may surface latent violations — fix within this unit, split into sequential commits if the set is large.

### WU-10: recovery-orchestrator validates escalation input and persists its attempt cap

- Priority: P2. Findings: Area 2 F6, F8.
- Files: `packages/extensions/src/recovery-orchestrator/index.ts`, `tests/recovery-grounding-smoke.mjs`.
- Change: validate every consumed field (bounded-string `reason`, numeric `count`, parseable `at`), reject malformed; persist attempt count alongside the marker so a restart cannot defeat the cap.
- Acceptance: malformed/oversized escalation rejected, never reaches injected content; fresh module load after N attempts still enforces cap; existing cases pass.
- Verify: `npm run smoke:recovery-grounding`. Risk: medium. Keep fail-closed default.

### WU-11: progress-guard escalation is idempotent and legacy markers respect TTL

- Priority: P2. Findings: Area 2 F5 (progress-guard half), F9.
- Files: `packages/extensions/src/progress-guard/index.ts`, `tests/progress-guard-agsix-smoke.mjs`.
- Change: write the escalation marker once per detection episode (skip when one already exists); treat missing/unparseable `at` in `autonomousArmed` as expired.
- Acceptance: repeated stuck turns produce the marker once; after consumer deletes it, not immediately re-written without a new detection; legacy `{armed:true}` with no `at` does not pin auto mode beyond TTL; existing cases pass.
- Verify: `npm run smoke:progress-guard`. Risk: medium. Only marker-write guard + `autonomousArmed`.

### WU-12: wire new smokes into `package.json` so `check:all` runs them

- Priority: P2. Files: `package.json`.
- Change: add `smoke:conductor-specialist-bounds` → `node tests/conductor-specialist-bounds-smoke.mjs` and `smoke:verifier-board-trust` → `node tests/verifier-board-trust-smoke.mjs`.
- Acceptance: `node packages/core/check-all.mjs --list` includes both; both scripts exit 0.
- Verify: `node packages/core/check-all.mjs --list | grep -E 'smoke:(conductor-specialist-bounds|verifier-board-trust)'`. Depends WU-4, WU-7. Risk: low.

### WU-13: GitHub CI runs the single check definition

- Priority: P2. Findings: Area 6 F7.
- Files: `.github/workflows/ci.yml`.
- Change: replace the hardcoded 28-line smoke subset with a single `npm run check:all` step (keep install/setup), matching `.gitlab-ci.yml`.
- Acceptance: workflow contains one `check:all` invocation, no per-smoke duplication; `npm run check:all` passes locally.
- Verify: `npm run check:all`. Risk: low.

## Not planned

- Area 4 F1 (secret-guard shipped in no profile): policy decision, not a code defect.
- Area 3 F3 (direct file write bypasses verdict board): no extension-level fix.
- Area 3 F4 (failed board sticky), F5 (`isStale` fails open): design/policy change.
- Area 3 F7, F8, F9, F10, F11, F12: need sequencing/ownership redesign or a live harness.
- Area 5 F1 (unscoped contribution admission): architecture change; partially mitigated by WU-2/WU-5.
- Area 5 F4-F7, F10-F15: feature-completeness/architecture.
- Area 1 F3-F13: need a live child/registry harness or process-level semantics decisions.
- Area 2 F3, F4, F7, F9, F10, F11: budget refund/design; cosmetic flood; heuristics need a behavioral harness.
- Area 4 F7-F18: OS-level containment, harness signal plumbing, or threat-model decision.
- Area 6 F8, F10, F11, F12, F13: low-value docs/hygiene; fold opportunistically.

## Sequencing

- Batch A (parallel, disjoint): WU-1, WU-2, WU-3, WU-5, WU-6, WU-8, WU-10, WU-11, WU-13.
- Batch B: WU-9 (verify.mjs, docs, schema, manifests).
- Batch C: WU-4, then WU-7 after WU-4 (shared conductor file).
- Batch D: WU-12 after WU-4 and WU-7.
- One commit per WU, each including its test change and passing its verification command.
  Run `npm run check:all` once after Batch C/D.
