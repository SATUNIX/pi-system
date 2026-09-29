# Improvement campaign 2026-09-22 — consolidated scout findings

Read-only scout output, six areas, dispatched `2026-09-22T08:13–08:53Z`.
Evidence is `file:line` against branch `improvement/campaign-20260922`.
No fixes have been applied yet.

Severity key: HIGH = correctness/security/autonomy defect; MED = real defect, narrower
impact; LOW = hygiene, robustness, or false-positive risk.

---

## Area 1 — `subagent` extension (`packages/extensions/third_party/subagent/`)

1. **HIGH — wall-clock kill is auto-retried as "transient", defeating the runtime ceiling.**
   `classifyFailure` handles `timeout`/`stream-cap` as limits but omits `wall-clock`, so a
   wall-clock kill with no output falls through to the generic transient rule and is retried
   (default once), up to `maxAttempts` times — multiplying the 30-min ceiling.
   - `result.ts:44-46`: `if (result.stopReason === "timeout" || result.stopReason === "stream-cap") return hasWork ? "fatal" : "limit"; ... if (result.exitCode !== 0 && !hasWork) return "transient";`
   - `runner.ts:347-353`: retry loop `while (attempts < maxAttempts && classifyFailure(result) === "transient")`.
   - `runner.ts:325-327` sets `result.stopReason = "wall-clock"`, but nothing in `classifyFailure` special-cases it. Contradicts `SOURCE.md` ("Limits (timeout/stream-cap) ... are never auto-retried").

2. **MED — `isFailedResult` omits `wall-clock` (and `detached`), so a wall-clock stop can be reported as success.**
   - `result.ts:23-31`: checks only `exitCode`, `error`, `aborted`, `stream-cap`, `timeout`, `stopped` — no `wall-clock`.
   - `result.ts:60-64`: failure branch gated solely on `isFailedResult(result)`.
   - `tools.ts:225`: `results.filter((r) => !isFailedResult(r))` counts a detached/exit-0 run as success.

3. **MED — "detach" is await-level only, not process-level; parent-process death can still kill the child.**
   - `child-process.ts:58-63`: `spawnChild(...)` has `stdio: ["ignore","pipe","pipe"]` but no `detached: true`.
   - `child-process.ts:91-94`: unref'd SIGKILL escalation never runs after parent exit (EPIPE closes pipes).

4. **MED — status/live registry never reconciles dead PIDs; orphaned runs show "running" forever.**
   - `status.ts:30`: default row `status: "running"` for any registry entry without `end`.
   - `status.ts:38-44`: only `entry.event === "end"` clears it.
   - `status.ts:47-53`: live loop never validates the pid.
   - `live.ts:49-55`: `processAlive` exists but is only used by `stopRecordedRun` (`live.ts:72`).

5. **MED — `runs.jsonl` is never pruned; only `.log` files are.**
   - `logging.ts:23`: filter `name.endsWith(".log")`.
   - `logging.ts:115`: `readRunRegistry` reads the whole file every status call.
   - No prune/size cap for `registryPath` (`logging.ts:52,79,96`).

6. **LOW — run id can collide within a millisecond for the same agent, merging two runs.** *(Reproduced live — see `docs/improvement-campaign-20260922-notes.md`.)*
   - `logging.ts:50`: `` const id = `${nowIso().replace(/[:.]/g, "-")}-${agentName.replace(/[^\w-]+/g, "_")}` ``.
   - `live.ts:16`: `live.set(child.id, child)`.
   - `runner.ts:342`: `unregisterLive(runLog.id)`.
   - Observed: Area 3 and Area 4 both got `2026-09-22T08-13-50-776Z-scout`; shared log; first `end` (`error`) masked by second (`stop`).

7. **LOW — retries reuse the same runId/log and append duplicate `spawn` records; duration reflects only last attempt.**
   - `logging.ts:96`: appends `event:"spawn"` each attempt.
   - `status.ts:40-43`: `row.start = String(entry.ts)` for any non-`end` entry.
   - `runner.ts:288-298`: `onSpawn` → `runLog.attachPid(handle.pid)` per attempt.

8. **LOW — a detached run re-populates the TUI footer after the tool returned, stale status never cleared.**
   - `tools.ts:104-109`: `ctx.ui?.setStatus?.("subagent", text)`.
   - `tools.ts:287-288`: `finally { clearStatus(ctx) }` runs at detach time.
   - `tools.ts:131-135`: `settledNotifier` notifies only, never clears status.

9. **LOW — `subagent_status` tail reads the entire log (up to 64 MiB) to slice last N lines.**
   - `tools.ts:311`: `fs.readFileSync(logPath,"utf8").split(/\r?\n/)` then `.slice(-tail)`.
   - `config.ts:29`: `MAX_LOG_BYTES = 64 * 1024 * 1024`.

10. **LOW — headless approval default skipped when parent has `PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS=0`.**
    - `runner.ts:276-277`: guard `if (!childEnv.PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS)`; `"0"` is truthy-preserved.
    - `runner.ts:267`: `const childEnv = { ...process.env, ... }`.

11. **LOW — documented "nested runs aggregate in one state dir" can fail when a nested run uses a different cwd.**
    - `runner.ts:271`: `PI_KIT_SUBAGENT_STATE_DIR: subagentStateDir(defaultCwd)`.
    - `runner.ts:281`: child may run in `cwd`.
    - `logging.ts:11-14`: override resolved against cwd.

12. **LOW — `pruneRunLogs` can delete a still-running child's log (keeps 50 newest by mtime, no liveness check).**
    - `logging.ts:33-41`: sort by mtime, unlink `logs.slice(keep)`.
    - Called on every `createRunLog`: `logging.ts:58`.

13. **LOW — a subagent dispatched on an already-aborted parent tool call still spawns a child under default detach config.**
    - `runner.ts:133`: `const abortSignal = envFlag("PI_KIT_SUBAGENT_DETACH_SIGNAL", true) ? undefined : signal;`
    - `runner.ts:144`: `if (abortSignal?.aborted)` guard is dead by default.

Uncertainty: finding 2 reachability depends on whether the child traps SIGTERM and exits 0
(normally `code === null → resolve(1)` masks it). Finding 13 may be intentional. Whether pi
emits both `message_end` and `tool_result_end` for one message (double-cost) unverified.
Findings are static analysis; no tests exist alongside these files.

---

## Area 2 — `progress-guard`, `recovery-orchestrator`, `conductor`

**Conductor `dispatch_specialist` inline spawn: confirmed no stream cap and no watchdog.**

1. **HIGH — `runSpecialistProcess` has no stream/output byte cap — unbounded parent memory.**
   - `packages/extensions/src/conductor/index.ts:254`: spawn with `stdio:["ignore","pipe","pipe"]`; `let buffer=""; let stderr=""; const messages=[]`.
   - `index.ts:261`: appends every stdout/stderr chunk; `index.ts:260`: pushes every JSONL message.
   - Contrast `third_party/subagent/child-process.ts:127,140` (`stdoutBytes > streamCap`) and `config.ts:20` (`DEFAULT_CHILD_STREAM_CAP = 256*1024*1024`).
   - The conductor's own validator runner also lacks a stream cap (`conductor/validate/validator.ts`).

2. **HIGH — `runSpecialistProcess` has no watchdog (no idle timeout, no wall-clock ceiling).**
   - `conductor/index.ts:257` (`stop()`) bound only to the abort signal at `:262`.
   - `index.ts:256` `setTimeout` is only the 5 s SIGTERM→SIGKILL escalation after `stop()`, not a kill timer.
   - `index.ts:297` `await runner(...)` never resolves if the child wedges and `signal` never aborts.
   - Contrast `conductor/validate/validator.ts:22-25`: `VALIDATOR_IDLE_TIMEOUT_MS` (15 min) with `bumpIdle()`; and `third_party/subagent/child-process.ts:86-89` (idle + wall).
   - `validator.ts:22-23` comment says it mirrors `runSpecialistProcess` and "add[s] an idle watchdog" — the watchdog was added to the validator, never to the specialist.

3. **MEDIUM — count budgets do not bound a single run; a hung run permanently consumes budget.**
   - `conductor/index.ts:288-290`: only `maxDepth`/`maxDispatches`; `dispatchesUsed++` under lock before `await runner(...)` at `:297`.
   - A hung specialist freezes the tool call and cannot refund its dispatch slot.

4. **LOW — progress flood to parent UI (no throttle).**
   - `conductor/index.ts:260` calls `onUpdate?.(...)` per event, wired at `:306`.

5. **MEDIUM — progress-guard escalation is re-created every turn; recovery-orchestrator's cap branch re-fires every turn.**
   - `progress-guard/index.ts:335-337`: writes marker whenever `detections >= ESCALATE_AFTER`, not once.
   - `recovery-orchestrator/index.ts:269`: consumes and deletes it; rewritten next turn if still stuck.
   - `recovery-orchestrator/index.ts:193` returns `cap` every subsequent turn; `:250` `block()` re-runs: re-emits `pi-kit:recovery-blocked`, rewrites `blocked-<session>.json`, fires `"error"` notify each turn (`:253-255`).

6. **MEDIUM — recovery-orchestrator attempt cap is in-memory only; restart defeats it while the marker is cleared on session start.**
   - `recovery-orchestrator/index.ts:217`: `attemptsBySignature` per-process Map.
   - `:238`: `session_start` clears the marker, does not reset/persist the map.

7. **LOW — dead no-op: verifier board has no effect on recovery entry.**
   - `recovery-orchestrator/index.ts:188-190`: `if (boardPassing(cwd) === false) { /* comment */ }` — empty branch, return value discarded.
   - `boardPassing` fail-opens to `true` on missing/corrupt board (`:111-121`).

8. **LOW/MEDIUM — `readEscalation` trusts attacker-writable fields; escalation.json is an injection surface.**
   - `recovery-orchestrator/index.ts:101-109`: validates only `typeof raw.signature === "string"`; `reason`/`count`/`at` unvalidated.
   - Interpolated into injected contribution (`recoveryContent`, `:125-126`) and report scaffold (`:151`).
   - Any write-capable tool can create/overwrite `.pi/recovery/escalation.json`.
   - Contrast rigorous `isEngagement` validation in `conductor/index.ts:97-104`.

9. **LOW — `autonomousArmed` legacy marker disables the TTL, pinning auto mode indefinitely.**
   - `progress-guard/index.ts:61`: marker with `armed:true` but no `at` returns `true`.
   - `:63`: `at` failing `Date.parse` also returns `true`.
   - Comment `:52-56` says a marker older than TTL must NOT pin auto mode — legacy shape bypasses the check.

10. **LOW — progress-guard detection counts `turn_end` with no new action and can false-escalate.**
    - `progress-guard/index.ts:315-316`: `actCounts` increments on each `turn_end` with the same signature.
    - `detect()` `:175-201` derives from stale state not reset by non-action turns.

11. **LOW — progress-guard oscillation can fire on legitimate alternating reads.**
    - `progress-guard/index.ts:43-50`: `findOscillation` needs two distinct signatures in the tail of `sinceWrite`.
    - Signatures are `tool|target` (`:275`); `read|A, read|B, read|A` satisfies it.

Uncertainty: findings 1–2 confirmed by exhaustive absence of any byte counter / timer in
`runSpecialistProcess` (`conductor/index.ts:246-268`) and contrast with two sibling runners;
not tested end-to-end. Whether pi itself imposes a per-tool wall clock unconfirmed.
`dispatch_specialist` is `enabledByDefault:false` (profiles `self-improving,engagement`).
`tests/conductor-recursion-smoke.mjs` injects a fake runner and never exercises
`runSpecialistProcess`.

---

## Area 3 — `orchestrator`, `task-graph`, `verifier-board`, `verify-gate`

1. **HIGH — verify-gate writes verdicts with no board lock — lost-update race.**
   - `verify-gate/index.ts:152-167` (`updateBoard`) read → mutate → `writeFileAtomic`, no lock.
   - `verifier-board/index.ts:71-85` establishes `.pi/verdicts.lock`; comment `:59` says it is shared with conductor's validator.
   - `verifier-board/index.ts:198-208` (`record_verdict`) and `verify-gate/index.ts:173-183` (`recordVerifyVerdict`) can both load, mutate, and rename, dropping the other's verdict.
   - Mirrors the acknowledged gap at `task-graph/index.ts:68-73`.

2. **HIGH — definition-of-done can be satisfied by model-authored, non-trusted verdicts.**
   - `verifier-board/index.ts:172-177` reserves only `verify`, `review`, `validator:*`.
   - Guard `:193-197` applies only inside the `record_verdict` tool.
   - `summarize` `:89-97` treats every source equally; no trusted source required.
   - `verdict_status` reports PASS and `missionCompleteBlocked` returns `{blocked:false}` (`orchestrator/index.ts:245-270`).

3. **HIGH — gate bypassable by direct file write; `record_verdict` guard is not a boundary.**
   - Only enforcement is `verifier-board/index.ts:193-197`.
   - Any `write`/`edit` can rewrite `.pi/verdicts.json` (path `:38-40`); verify-gate writes the same file unlocked.
   - Anti-forgery is prose only: `orchestrator/index.ts:350-353`; gate is a steering message `:348-349`, not a harness block.

4. **MED — failed board is effectively sticky across tasks.**
   - Latest verdict per source wins (`verifier-board/index.ts:200-207`, `verify-gate/index.ts:174-178`), and `summarize` requires every recorded source to pass (`:96`).
   - Sources never aged out per task; removal paths: verify-gate `removeVerdict("verify")` (`verify-gate/index.ts:548-552`) and operator `/verdicts clear` (`verifier-board/index.ts:226-238`).
   - FAIL verdicts are never considered stale (`verifier-board/index.ts:32-36,92-96`).

5. **MED — `isStale` fails open — a pass with missing/unparseable `at` never expires.**
   - `verifier-board/index.ts:32-36`: `if (typeof at !== "string") return false;` and `if (Number.isNaN(parsed)) return false;`.
   - Parity copy `orchestrator/index.ts:208-212`.
   - `VERDICT_MAX_AGE_MS = Number(env) || default` (`verifier-board/index.ts:30`, `orchestrator/index.ts:206`) — cannot be set to 0/intent-off.

6. **MED — automatic check mode ignores `PI_KIT_VERIFY_CMD`.**
   - `verify-gate/index.ts:63-67`: `if (automatic && !hasVerifyScript(cwd)) return {ran:false,...}`.
   - `hasVerifyScript` `:45-56` only inspects `package.json.scripts.verify`.
   - `turn_end` also early-returns `:676-681`. Manual `/verify` respects the override; automatic path does not.

7. **MED — concurrent verify runs are not mutually excluded for board writes.**
   - `running` (`verify-gate/index.ts:595,619,656`) only guards `/verify` command vs `verify_completion` tool.
   - Automatic `turn_end` path `:669-699` never checks `running`; `/verify` interactive returns before completion `:640-642`.
   - `PI_KIT_VERIFY_REVIEW=0`, missing reviewer model, or absent definition-of-done records a FAIL `review` verdict `:545`, which sticks per finding 4.

8. **MED — partial-write window: `verify` PASS recorded before `review`, no rollback.**
   - `runVerification` records `verify` at `verify-gate/index.ts:521` before the review and before computing `pass` at `:555`.
   - If anything after 521 throws outside the reviewer try/catch, `finally` only clears the pending marker `:566-567`; no rollback.
   - Result: board with only the check PASS → `summarize.overall === true`, mission unblocked, no review recorded.

9. **MED-LOW — bad `PI_KIT_ORCH_THRESHOLD` silently disables autonomy.**
   - `orchestrator/index.ts:13`: `parseInt(env ?? "3", 10)` → `NaN`.
   - `orchestrator/index.ts:383`: `score >= NaN` always false; classification file written `"simple"` at `:188`.

10. **LOW — `correctionSent` latches off the orchestrator's own diagnostic before verification completes.**
    - `orchestrator/index.ts:317-328`: when `verifierOwnsResult` and the filtered `failing` list is empty, sets `correctionSent = true` and returns; a later `review` FAIL is never re-diagnosed for that request.

11. **LOW — orchestrator's duplicated pending-marker check can fail open.**
    - `orchestrator/index.ts:220-235` re-implements `isVerifyPendingActive`; outer `catch { return false }` swallows a stat failure → corrupt/unreadable marker treated as not pending.
    - Verify-gate copy `verify-gate/index.ts:105-115` kept in parity by convention only.

12. **LOW — `task_update` accepts arbitrary status transitions without an ownership token.**
    - `task-graph/index.ts:230-245` `task_next` marks next pending unblocked task `in_progress` atomically under lock.
    - `task_update` (`task-graph/index.ts:183-207`) can flip `in_progress → pending`, allowing re-claim. Concurrency locking itself is correct (`:33-57`).

Uncertainty: orchestrator/verify-gate `turn_end` ordering is host load order, not traced;
findings 1 and 10 are order-independent, the pending-marker race window is not.
Whether the host enforces a hard completion block beyond these extensions' own
`missionCompleteBlocked` consumer unverified (only caller is `orchestrator/index.ts:322`).
`runCheck` uses `execFile(..., { shell: true })` on `PI_KIT_VERIFY_CMD` (`verify-gate/index.ts:73`) —
command-injection implications not evaluated (out of stated focus).

---

## Area 4 — `tool-firewall`, `human-console`, `secret-guard`, `protected-paths`

1. **HIGH — `secret-guard` is not shipped in any profile or lite, contradicting "every profile + lite".**
   - `docs/security.md:10-11` claims it ships in every profile + lite; profile descriptions repeat it (`packages/kit/profiles/quick.json:3`, `balanced.json:3`).
   - Manifest: `"profiles": [], "enabledByDefault": false, "status": "experimental"` (`packages/extensions/src/secret-guard/extension.json:30-34`).
   - No profile `include` nor `packages/kit/surfaces/lite.json:8-25` names it. Install loads only `profileDef.include` (`packages/core/lib/resolve.mjs`).
   - `verify.mjs:343-346` exempts `experimental` from the orphan check, so the gap passes CI.
   - Consequence: default installs have no secret-content scan, no secret-read block, no glob/PowerShell exfil block, and a smaller protected set than `PROTECTED_PATTERNS` (`secret-guard/index.ts:35-51`).

2. **HIGH — secret-content scan misses the current `edit` tool schema (`edits[].newText`).**
   - `secret-guard/index.ts:254-261`: `contentOf` extracts only `content,text,new_string,newText,newString,data,body`.
   - Live `edit` input is `{ path, edits: [{ oldText, newText }] }` (`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/edit.js:18-24`); `edits` never traversed.
   - Regression test only exercises legacy `new_string` (`tests/secret-guard-smoke.mjs:39,95,116`).

3. **HIGH — active firewall policy file is writable from `bash` in default profiles; firewall reloads it mid-session.**
   - `policyPath()` honours `PI_KIT_FIREWALL_POLICY` else shipped JSON (`tool-firewall/index.ts:80-87`); `getPolicy()` re-reads on mtime change `:271-277`; `readPolicyFromDisk` accepts any parseable JSON `:249-257`.
   - `protected-paths` DEFAULT is only `.env`, `.git/`, `node_modules/`, `.pi/human-console/`, `.pi/human-console-audit.jsonl`, `.pi/pentest/` (`protected-paths/index.ts:6-10`).
   - Only `secret-guard` `PROTECTED_PATTERNS` (`:35-51`) protects it — off by default (finding 1), and only the repo-relative literal, not a custom `PI_KIT_FIREWALL_POLICY` path.

4. **HIGH — auto-mode state file `.pi/auto-mode.json` is agent-writable, self-enabling LLM-judge auto-approval.**
   - `autoModePath()` = `PI_KIT_AUTO_MODE_STATE_DIR/auto-mode.json` or `<cwd>/.pi/auto-mode.json` (`tool-firewall/index.ts:93-95`); `autoModeEnabled()` true on `{"enabled":true}` `:97-101`.
   - When enabled, an `ask` call whose judge returns `allow` runs with no human (`:413-416`).
   - File is in neither `protected-paths` DEFAULT (`:6-10`) nor `secret-guard` `PROTECTED_PATTERNS` (`:35-51`); `write` is allowed by shipped policy. `judgePrompt` itself is steerable `:67-73`.

5. **MEDIUM — default installs leave audit, agent-role, verdict, trace, engagement paths unprotected.**
   - `secret-guard` list (`.pi/tool-firewall-audit.jsonl`, `.pi/trace.jsonl`, `.pi/agents/`, `.pi/ctx-contributions/`, `.pi/verdicts.json`, `engagement/*.yaml`, `packages/core/policies/`, …) inert by default (finding 1).
   - `pentest-governance-domain` `PROTECTED_PATTERNS` (`:88-110`) omits all of those and is absent from `quick`.
   - Net: `quick`/`balanced` can tamper with firewall audit, trace ledger, agent role files, verdict store, `engagement/scope.yaml`/`roe.yaml`.

6. **MEDIUM — `PI_KIT_PROTECTED_PATHS` replaces the default denylist instead of augmenting (fail-open override).**
   - `protected-paths/index.ts:13-14`: `const base = env ? env.split(";")… : DEFAULT_PROTECTED`.
   - Any non-empty value drops `.env`, `.git/`, `node_modules/`, `.pi/pentest/`. Contradicts add-only model in `secret-guard` `:224-228`.

7. **MEDIUM — `bash` write-target extraction incomplete; several rewrite primitives unchecked.**
   - `protected-paths/index.ts:104-142` `bashWriteTargets`:
     - `cp`/`mv` regex `:115-116` misses `cp -t DIR src`, `cp -r a b dest` (wrong operand), only inspects last positional.
     - `perl -pi -e … file` missed (`:120` requires whitespace before `-i`).
     - No handling for `node -e`, `python3`, `ruby`, `patch`, `git checkout --`, `ed`, `busybox`, `rm` (non-recursive), `touch`, `chmod`, `awk` writing. Code itself states a single missed primitive is a full bypass `:99-103`.

8. **MEDIUM — command/exfil detection keyed to literal tool name `bash` and specific input keys.**
   - `secret-guard/index.ts:300`: shell checks only `if (toolName === "bash")`, keys `command|cmd|script` `:301`.
   - `tool-firewall/index.ts:300-303` likewise only `command|cmd|script`.
   - Any MCP/custom tool running a shell under another name/key is invisible.
   - `TRANSFER_VERB` (`secret-guard/index.ts:86-88`) omits `python`, `python3`, `node`, `ruby`, `perl`, `awk`, `sed`, `busybox`, `chmod`.

9. **MEDIUM — symlink-to-nonexistent-target bypasses realpath fallback in both path guards.**
   - `secret-guard.resolvedPath` `:156-161` and `protected-paths.canonicalPath` `:47-55` fall back to the link's own path when `realpathSync` throws.
   - A symlink `/tmp/x -> <protected>/newfile` resolves as `/tmp/x`, then the write creates the protected destination.

10. **MEDIUM — hard links bypass path checks entirely.**
    - Both guards canonicalize with `realpathSync` (does not reveal hard-link aliasing).
    - `ln <protected/file> /tmp/alias` then writing `/tmp/alias` overwrites the protected inode.
    - `ln` destination extraction only validates the last operand (`protected-paths/index.ts:129-130`); link source never considered.

11. **MEDIUM — approval `AbortSignal` never wired to the firewall's approval broker.**
    - `ToolCallEvent` has no `signal` (`.../dist/core/extensions/types.d.ts:585-626`); `agent-session.js:181-188` emits `{ type, toolName, toolCallId, input }` only.
    - `event?.signal` at `tool-firewall/index.ts:428` (and `pentest-governance-domain/index.ts:831`) always `undefined`.
    - `brokerApproval` `:108-129` cannot abort; rides out `Math.max(1, Number(PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS) || 900000)` `:111` (up to 15 min).
    - `human-console.processOne` `:77-98` is signal-less; only `brokerRequest` `:44` gets a signal.

12. **MEDIUM — firewall audit log append-only but not tamper-evident, truncatable by default.**
    - `audit()` plain `appendFileSync`, no hash chain (`tool-firewall/index.ts:338-341`); path overridable `PI_KIT_FIREWALL_AUDIT_LOG` `:89-91`.
    - `docs/security.md:58` promises "each decision is audited" but not integrity.
    - `.pi/tool-firewall-audit.jsonl` absent from `protected-paths` DEFAULT (finding 5); truncatable via `>`, non-recursive `rm`, partial `sed -i`. `human-console` audit (`human-console/index.ts:14`) equally unprotected.

13. **LOW/MEDIUM — regex `g`/`y` flags in command rules make deny matching stateful and intermittent.**
    - `compileCommandRules` copies flags verbatim (`tool-firewall/index.ts:198-207`); `commandDecisionFor` uses `rule.re?.test(command)` `:292,295`; `lastIndex` advances.
    - Shipped patterns use only `i`; override surface allows `g`/`y`.

14. **LOW — firewall policy reload evadable by restoring mtime (TOCTOU).**
    - `getPolicy()` reloads only when path or mtime differs (`tool-firewall/index.ts:271-277`); a tampered file with original mtime (`touch -r`) is never re-read; also a stat→read window.

15. **LOW — stale documentation says firewall defaults to allow-all.**
    - `tool-firewall/README.md` says "If no policy path is configured, the firewall uses a default allow-all policy" and shows `"unknown": "allow"`, contradicting `BUILTIN_FALLBACK` (`tool-firewall/index.ts:33-47`) and shipped default `ask` (`default-policy.json:5-7`).

16. **LOW — env-var manifest drift.**
    - `tool-firewall/index.ts` reads `PI_KIT_FIREWALL_POLICY`, `PI_KIT_FIREWALL_AUDIT_LOG` `:80-91`, `PI_KIT_AUTO_MODE_STATE_DIR` `:94`, `PI_KIT_INTERNAL_CHILD` `:136`.
    - `tool-firewall/extension.json` `env` lists only `PI_KIT_AUTO_MODE`, `PI_KIT_AUTO_MODE_MODEL`, `PI_KIT_HUMAN_CONSOLE_DIR`, `PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS`. Firewall vars are declared on `secret-guard/extension.json` instead.

17. **LOW — broker approval trusts file placement, not content.**
    - `brokerApproval` accepts any `resolved/<id>.json` with `approved === true` without checking `id`/requester (`tool-firewall/index.ts:115`); `human-console.brokerRequest` does validate `value?.id === id` (`human-console/index.ts:52`).
    - Pending files never deleted on timeout/abort (`:108-129`); approval records accumulate.

18. **LOW — `.env.example`/`.env.sample` exemption is a deliberate writable/readable hole.**
    - `secret-guard/index.ts:193-199` `isEnvTemplatePath` makes those basenames writable/readable; content still pattern-scanned `:293-295`.
    - A secret in a signature outside `SECRET_CONTENT_PATTERNS` (`:57-66`) written to `.env.example` is allowed.

Uncertainty: F3/F4 exploitability requires the model to take the write step; traced, not executed.
F1 severity depends on whether the "every profile + lite" text is aspirational or current.
Exact `edit` hook arg shape inferred from `dist/core/tools/edit.js:18-24`; not instrumented live.
`emitToolCall` does not try/catch handler throws (fail-closed), not exhaustively tested.
No in-repo `tool_call` handler mutates `event.input`; external/MCP modifiers not enumerated.
`process.cwd()` vs `ctx.cwd` divergence in firewall paths not runtime-confirmed.
Windows normalization and `PI_KIT_WRITE_ALLOWLIST` enforcement path unverified.

---

## Area 5 — `context-sieve`, compaction/checkpointing

1. **HIGH — `context-sieve` contribution admission is unscoped — any writer's raw text becomes system prompt.**
   - `context-sieve/index.ts:43-63`: `readContributions` admits any `*.json` in `.pi/ctx-contributions/` where `parsed.id` truthy and `parsed.content` is a string. No producer registry/token/epoch/expiry. `priority`/`budgetTokens` read but not type/range validated.
   - `:177`: admitted content appended verbatim to `event.systemPrompt + "\n\n" + assembled.join(...)`. No untrusted framing.
   - `packages/core/verify.mjs:195-204`: "injection monopoly" lint only rejects other extensions returning `{ systemPrompt }`; non-extension writers unconstrained.

2. **HIGH — model/tool-reachable injection into the system prompt via bash redirect.**
   - `secret-guard/index.ts:35-58` lists `.pi/ctx-contributions/` in `PROTECTED_PATTERNS`; `:283-296` blocks `write`/`edit`, but `:299-313` `bash` branch only blocks `TRANSFER_VERB` (`:86`). A redirect `printf ... > .pi/ctx-contributions/x.json` is not a transfer verb → not blocked.
   - `protected-paths/index.ts:6-11` DEFAULT omits `.pi/ctx-contributions/`; `:112-140` catches `>`/`tee`/`cp` only for protected dirs.
   - `tool-firewall/default-policy.json:16`: `bash` is `allow`.
   - Combined: agent/content can create a contribution that context-sieve promotes into the system prompt, defeating the single-authority model.

3. **HIGH — snapshot-suppression depends on load order; actual order inverts the assumption.**
   - `context-sieve/index.ts:19-25,53`: skips a contribution when `prior.raw === raw && prior.mtimeNs === currentMtimeNs(file)`; snapshot taken in `session_start` `:145-155`.
   - Comment `:19-25` and `goal-core/index.ts:65-66` assert context-sieve loads before goal-core/guidelines so their `session_start` writes look new.
   - Loader does not sort: `.../dist/core/extensions/loader.js:410-436,443-479` iterates `readdirSync`/`globSync` in place; `resource-loader.js:271-274` loads `cliEnabledExtensions + enabledExtensions`; `package-manager.js:1926-1947` re-sorts only by `resourcePrecedenceRank` (stable, same rank preserves insertion).
   - Observed order on this checkout (`globSync('packages/extensions/src/*/index.ts')`): guidelines idx 20, goal-core idx 21, context-sieve idx 25 — context-sieve's `session_start` runs **after** goal-core (`goal-core/index.ts:60-70`) and guidelines (`guidelines/index.ts:18-35`) rewrite their files. Snapshot captures the fresh write and skips it for the session.
   - Tests encode the inverted order: `tests/compaction-continuity-smoke.mjs:23-34`, `tests/context-budget-smoke.mjs:111-131`.

4. **MEDIUM — `includeInCompact` is a dead contract; compaction-carryover semantics removed.** (Closed 2026-09-24 in cycle perpetual-20260924/17: the field was removed from the `Contribution` interface and all producers; the rest of this dated finding stands.)
   - `context-sieve/index.ts:10` declares `includeInCompact?: boolean`; written by `goal-core/index.ts:38`, `recovery-orchestrator/index.ts:202`, `conductor/index.ts:326`, `autonomous-loop/index.ts:47`; never read.
   - `:186`: `session_before_compact` unconditionally returns `undefined`; no contribution-shaped summary.
   - Drift: `context-sieve/extension.json:4` and `docs/EXTENSIONS.md:13` still say "goal-aware compaction summary"; `custom-compaction/SOURCE.md:13` repeats it.

5. **MEDIUM — `custom-compaction` template is a silent no-op.**
   - `custom-compaction/index.ts:4-8` reads `PI_KIT_COMPACT_TEMPLATE` only to emit a warning; `:14` `session_before_compact` returns `undefined` unconditionally.
   - `extension.json` still declares the env var; `SOURCE.md:11` claims it "overrides context compaction".

6. **MEDIUM — `/compress` trigger authority is a shared string marker, not a command identity.**
   - `compress/index.ts:20,324-337`: deterministic summary selected whenever `event.customInstructions` starts with `[[pi-kit:compress]]`.
   - `/compact [[pi-kit:compress]]…` or any `ctx.compact({customInstructions: "[[pi-kit:compress]]…"})` triggers it. Only `/compress` `:354-360` is intended; no per-session nonce.

7. **MEDIUM — `/compress` drops tool output/reasoning/images/code and can lose prior file lists.**
   - `compress/index.ts:1-17,78-95,140-170,297-322`: keeps trimmed user/assistant text, one tool digest line per turn, `<modified-files>`/`<read-files>`.
   - `:212-226`: `previousCompressFiles` scans back and returns `{[],[]}` at the first `compaction` whose `details.compressor !== COMPRESSOR_ID` — a native compaction between two `/compress` runs severs cumulative file provenance.

8. **MEDIUM — `trigger-compact` absolute threshold not bound to model context window.**
   - `trigger-compact/index.ts:8,37-42`: validates only `>= MIN_THRESHOLD_TOKENS` (1000); env path never compared to the window.
   - The `>= window` guard exists only in the TUI command `:148`. A managed-install env value above the window makes auto-compact never fire.
   - Native compaction triggers at `contextWindow - reserveTokens` (`.../dist/core/compaction/compaction.js:149-152`; reserve default 16384, `dist/core/settings-manager.js:456-470`). The two thresholds are independent.

9. **MEDIUM — `trigger-compact` never fires when the session starts already above threshold.**
   - `trigger-compact/index.ts:97-106`: firing requires `previousTokens !== undefined && previousTokens <= thresholdTokens` then `currentTokens > thresholdTokens`.
   - Resumed session starting above threshold sets `previousTokens = currentTokens` (already > threshold); `crossedThreshold` stays false until usage drops below and re-crosses.

10. **LOW/MEDIUM — conductor writes its directive inside `before_agent_start`; current turn may miss it.**
    - `conductor/index.ts:321-337` writes `.pi/ctx-contributions/conductor.json` from its own `before_agent_start`.
    - `context-sieve/index.ts:157-177` assembles the prompt from the same event; handler order = load order; observed context-sieve idx 25 before conductor idx 26 → contribution assembled next turn. No ordering enforced.

11. **LOW — untrusted `priority`/`budgetTokens`; non-deterministic tie order; priority can dominate the global budget.**
    - `context-sieve/index.ts:111`: `sort((a,b) => b.priority - a.priority)`; non-numeric/undefined `priority` yields `NaN`; ties fall back to readdir order.
    - `:125-126`: `positiveIntOr(contrib.budgetTokens, Infinity)` — `budgetTokens <= 0`/non-numeric treated as unbounded.

12. **LOW — global budget covers only contributions; extension summary overstates scope.**
    - `context-sieve/index.ts:13,162-163`: `DEFAULT_BUDGET_TOKENS = 4096` applies only to `.pi/ctx-contributions/*.json`; base prompt/history/tool results unbudgeted.
    - `extension.json:4` / `docs/EXTENSIONS.md:13` say "enforces token budget" without qualifier. Limitation noted only in `reviews/long-horizon-reliability-review.md:127`.

13. **LOW — contribution files read whole into memory before parsing, no size bound.**
    - `context-sieve/index.ts:51-54`: reads each file fully and `JSON.parse`s; budget applied after parse.

14. **LOW — `sieve-budget.json` telemetry accumulates in the read directory; overwritten each `before_agent_start` (not unbounded).**
    - `context-sieve/index.ts:69-76`; excluded from admission `:53`.

15. **MEDIUM (composite) — checkpoint-state injection summary.**
    - `progress-guard` clears at `session_start` (`progress-guard/index.ts:245`), writes on detection `:324,336`.
    - `recovery-orchestrator` clears at `session_start` (`:235-240`), writes from `turn_end` `:243-268,304`.
    - `goal-core`/`guidelines` write at `session_start` (`goal-core/index.ts:60-70`, `guidelines/index.ts:18-35`) — subject to finding 3.
    - `conductor` writes at `before_agent_start` (`:321-337`) — subject to finding 10.
    - `autonomous-loop` writes on `/loop` and `agent_end` (`autonomous-loop/index.ts:98-108`); in-memory state resets at `session_start` `:72-85`; stale `autonomous-loop.json` would be snapshot-suppressed next session.
    - Because context-sieve emits no `session_before_compact` content (finding 4), checkpoints are re-injected only by re-reading files; any extension writing only at `session_start` before the snapshot, or after context-sieve in the same event, risks not appearing.

16. **INFORMATIONAL — no context-budget extension exists.**
    - Repo-wide grep for `context-budget`/`contextBudget`/`PI_KIT_CONTEXT` finds no implementing extension; only `tests/context-budget-smoke.mjs` (exercises context-sieve), `package.json:55`, `.github/workflows/ci.yml:41`, and the unrelated skill `packages/kit/skills/delegation-context-budgeting/SKILL.md`.
    - The "context budget" surface lives entirely inside `context-sieve` (`PI_KIT_CTX_BUDGET_TOKENS`, per-contribution `budgetTokens`).

Uncertainty: findings 3/10 derived by reading loader code, not running the real pi loader;
`globSync` order was deterministic across runs on this checkout but is not documented.
Stable-sort assumption (`package-manager.js:1936`) unverified at runtime.
Finding 2 assumes no other extension blocks bash writes to `.pi/ctx-contributions/`.
Finding 6 assumes pi passes `/compact <text>` customInstructions verbatim
(`agent-session.js:1244-1272`) — not confirmed for interactive mode.
Findings 8/9 do not trace whether native auto-compaction and `trigger-compact` race in one turn.
Finding 7 is code-reading, not executed. Older `reviews/*` docs cite stale context-sieve behavior.

---

## Area 6 — install/verify/catalog/schema/tests

1. **HIGH — `docs/WRITING_EXTENSIONS.md` hooks table is fictional.**
   - `docs/WRITING_EXTENSIONS.md:67-73` lists `message`, `session_end`, `compact`, `error` as lifecycle hooks.
   - None are in the schema enum (`packages/core/schema/extension.schema.json:36-52`) and none are registered (`grep pi.on` across `packages/extensions/` yields zero matches).
   - An author following the doc writes an invalid `extension.json` or registers a hook that never fires. The real 20-event set is nowhere documented.

2. **HIGH — `verify.mjs` hooks-drift check is one-directional and misses over-declared hooks; active instance.**
   - `packages/core/verify.mjs:186-193`: only flags code→manifest under-declaration (`for (const hook of registeredHooks) if (!declaredHooks.has(hook))`).
   - `packages/extensions/third_party/todo/extension.json` declares `hooks: ["session_start"]` but `todo/index.ts` contains no `pi.on` at all.

3. **MEDIUM — docs say `provenance.origin` is required; the schema does not enforce it.**
   - `docs/WRITING_EXTENSIONS.md:31` marks Required=yes; `extension.schema.json:6` requires only `["name","summary","category","entry","hooks","profiles","platforms","runtime","status"]` (no `provenance`).
   - Deleting `provenance` still passes Ajv; every current manifest happens to include it.

4. **MEDIUM — `verify.mjs` claims to "scan ALL .ts files" but is non-recursive.**
   - `packages/core/verify.mjs:152` comment vs flat `fs.readdirSync(extDir).filter(f => f.endsWith(".ts"))` `:154`.
   - Same flat list drives the `systemPrompt` injection-monopoly check `:198` and stub/TODO scan `:313,383`.
   - Two nested `.ts` files never scanned: `packages/extensions/src/conductor/synth/agent-synth.ts`, `packages/extensions/src/conductor/validate/validator.ts`.

5. **MEDIUM — `docs/EXTENSIONS.md` / `docs/registry.json` generated but have no drift gate.**
   - `packages/core/registry.mjs:46-63` writes both; `verify.mjs` has zero references to `EXTENSIONS.md`/`registry`.
   - By contrast `skills-catalogue.md` (`verify.mjs:486-534`) and `capability-matrix.md` (`:536-547`) have freshness checks.
   - Currently in sync (checked; 0 mismatches), so this is ungated-drift risk, not yet-stale content.

6. **MEDIUM — `runtime.nodeBuiltins` declarations never cross-checked against actual imports; 4 extensions drifted.**
   - Schema defines `runtime.nodeBuiltins` (`extension.schema.json:76`); docs promise it "Declares all external deps" (`docs/WRITING_EXTENSIONS.md:29`); verify reads `runtime` only via schema shape.
   - Undeclared built-ins:
     - `packages/extensions/src/save` imports `node:fs`, `node:path`
     - `packages/extensions/src/session-helpers` imports `node:fs`, `node:os`, `node:path`, `node:url`
     - `packages/extensions/third_party/custom-footer` imports `node:child_process`, `node:fs`, `node:os`, `node:path`
     - `packages/extensions/third_party/trigger-compact` imports `node:fs`, `node:os`, `node:path`

7. **MEDIUM — GitHub CI does not run the single check definition; 18 of 47 check scripts never execute there.**
   - `packages/core/check-all.mjs:5-8` states it exists because only a subset was wired into each CI surface; `.gitlab-ci.yml:48` runs `npm run -s check:all`.
   - `.github/workflows/ci.yml` hardcodes a subset (28 `npm run smoke:*` lines, `:18-48`) and never calls `check:all`.
   - Unrun in GitHub CI: `smoke:auto-mode`, `smoke:completion-review`, `smoke:compress`, `smoke:conductor`, `smoke:conductor-synth`, `smoke:conductor-validator`, `smoke:conductor-recursion`, `smoke:human-console-broker`, `smoke:lifecycle-containment`, `smoke:live-evaluation-integrity`, `smoke:liveness-containment`, `smoke:observability-contracts`, `smoke:save`, `smoke:shutdown-hook-gating`, `smoke:status-bar`, `smoke:todo-session`, `smoke:trigger-compact-threshold`, `smoke:memory-mcp`.

8. **MEDIUM — `docs/ARCHITECTURE.md` claims every `verify` check has a worked failure example; at least six do not.**
   - `docs/ARCHITECTURE.md:44`: "**Every check has a worked failure example in `WRITING_EXTENSIONS.md`.**"
   - Missing from the table (`docs/WRITING_EXTENSIONS.md:45-57`): `sources.json` schema validation (`verify.mjs:230-241`), bundle/sources cross-check (`:244-268`), external source/profile cross-check (`:350-364`), third-party notices drift (`:549-559`), conductor agent-synth contract (`:573-583`), validator least-privilege (`:585-597`).

9. **MEDIUM — docs claim imports limited to `node:*` + `typebox` and that verify fails on violations; neither is true.**
   - `docs/WRITING_EXTENSIONS.md:14`, `docs/ARCHITECTURE.md:21`.
   - Real extensions import `@earendil-works/pi-coding-agent` (47 occurrences, e.g. `save/index.ts:1-2`, `session-helpers/index.ts:1`).
   - `verify.mjs` only fails on relative escapes `:164-168` and `packages/core/lib` imports `:171-173`; plain npm imports never checked.

10. **LOW — `_template/extension.json` is schema-invalid and exempt from the schema gate.**
    - `_template/extension.json` `"name": "_template"` fails pattern `^[a-z][a-z0-9-]*$` (`extension.schema.json:12`).
    - `verify.mjs:119` skips dirs starting with `_`. `new-extension.mjs` rewrites the name, but a manual copy that forgets to rename is not caught until after the copy.

11. **LOW — `verify.mjs` duplicates the skill-category list by hand from `skills-catalogue.mjs`.**
    - `verify.mjs:487-497` re-declares `KNOWN_SKILL_CATEGORIES`, "duplicated, not imported" (comment `:490-493`), mirroring `skills-catalogue.mjs:27-38` `CATEGORY_ORDER`.
    - Adding a category to the generator without editing `verify.mjs` makes valid skills fail, and vice versa.

12. **LOW — `sources.schema.json` omits the `optional` property that `sources.json` uses.**
    - `sources.json` sets `"optional": true` on `pi-lean-ctx`; `sources.schema.json:9-21` does not list `optional` and does not set `additionalProperties:false`; passes only by permissiveness.

13. **LOW — stale schema path in a superseded doc.**
    - `docs/PI_KIT_REPO_PLAN.md:191` references `kit/schema/extension.schema.json`; the file now lives at `packages/core/schema/extension.schema.json`. Doc self-identifies as superseded.

Uncertainty: no missing test files — every `node <path>` target in `package.json` scripts
exists; every `loadModule(...)` path in `tests/*.mjs` resolves. `docs/skills-catalogue.md`,
`capability-matrix.md`, `EXTENSIONS.md`, `registry.json`, profile↔manifest membership all
matched a fresh recomputation; findings 5/6 are absence-of-check findings with a live drift
only for `runtime.nodeBuiltins`. Did not run `npm run verify`/`catalog` or any writing smoke.
Schema enum contains 9 events no extension registers (intentional headroom vs ported drift —
unresolved). `registers` commands use a leading `/` while code registers without; treated as
no-drift. `@earendil-works/pi-coding-agent` imports assumed SDK/type-only.
