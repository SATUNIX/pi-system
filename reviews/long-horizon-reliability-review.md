# Reviewer E — Long-Horizon Reliability, Context/Memory & Recovery Engineering

Date: 2026-08-04  
Branch: `hardening/production-readiness-plan`  
Reviewed HEAD: `8d3b205e99d0da561de1d4df62d44b87d757c05a`

## Verdict

**A small local model cannot be trusted to complete a genuinely hard, multi-hour task under the current `long-horizon` or `autonomous` harness without close operator supervision.** There is useful instrumentation and prompt steering here, but not a closed reliability control loop.

The real pieces are narrower than the product-level claims:

- `context-sieve` really prioritizes and injects extension contributions before a model turn, but its promised compaction instructions do not reach Pi's compactor, its per-contribution budgets are ignored, and it does not budget conversation history or tool output.
- `trace-ledger` really records lightweight call/result facts, but it neither measures goal progress nor captures enough outcome data to drive recovery or learning.
- `progress-guard` catches exact repetition and strict two-action oscillation. It does not reliably escalate its read-stall path, and any attempted write is treated as progress before the result is known.
- `recovery-orchestrator` is exactly the scaffolding established in H-06: it writes a report template and prompt instructions. It does not execute or validate recovery, and its attempt state is session-local.
- `memory-local` is a manually invoked persistent note store/search tool, not automatic working memory. The self-improvement components do not form a mine → candidate → candidate-sensitive score → promote/revert loop, as established in M-02.
- the “done means verified” contract can report false success when verification is absent, still running, unreadable, malformed, or unwritable. M-04 is therefore not merely bookkeeping fragility; it is an end-to-end false-completion path.

No additional release-blocking finding is assigned because the existing final review is already “do not tag” and the directly exposed failures below are best aligned with its high/medium scale. There are **three new or materially sharpened high-severity capability failures**.

## Scope and method

I treated `reviews/FINAL-review.md` as established baseline fact, especially H-04, H-06, M-02, M-03, M-04, and M-05. Design intent came from `LATEST_PLAN_2026-08-04T042958Z.md:60-86` and `docs/roadmap.md:72-105`. I read the extension and installed Pi runtime source directly rather than trusting manifests.

Verification was offline. I used source tracing, the repository's fake-Pi TypeScript harness (`kit/eval/harness.mjs:1-59`), temporary OS workspaces, and a non-mutating npm missing-script check. No live Pi/model/backend, provider call, or external network request was made.

## Findings

### Blocking

None newly assigned in this focused pass.

### High

#### E-H01 — Context preservation at compaction is an inert hook mutation

**Extends M-05 and shows the same “announces a mitigation, does not perform it” pattern as its `pi-lean-ctx` item.** It is also structurally similar to H-03: locally sensible output is produced at a hook site but the runtime path does not consume it.

The live-turn part of `context-sieve` is real. It reads contributions, sorts them by descending priority, fits whole contributions under an approximate character budget, and returns a modified `systemPrompt` (`extensions/context-sieve/index.ts:66-104`). Pi consumes a `before_agent_start` `systemPrompt` result (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:795-816`; aggregation at `node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:746-798`). Recovery/goal directives can therefore be visible on ordinary subsequent turns.

The compaction-preservation path is not real:

- `context-sieve` assigns its goal-aware template to `event.customInstructions` and returns `undefined` (`extensions/context-sieve/index.ts:106-128`). `custom-compaction` uses the same mutation pattern (`vendor/custom-compaction/index.ts:18-23`).
- The public compact result contract supports only `cancel` or a complete `compaction`; it has no custom-instruction override (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:425-430,772-775`).
- The extension runner keeps only a truthy handler return for session-before events (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:516-537`).
- Manual compaction constructs an event containing the current instruction string, but after emitting it Pi passes the original local `customInstructions` variable to `compact(...)` (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1288-1319`). Automatic compaction always passes `undefined` (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1521-1559`). Nothing reads the mutated event field after the handlers return.

**Concrete hand trace:** for automatic compaction, Pi creates `{customInstructions: undefined}` at `agent-session.js:1523-1530`; `context-sieve` mutates that temporary object; the runner returns no result because the handler returned `undefined`; Pi reaches `compact(..., undefined, ...)` at `:1557-1559`. The intended instruction to preserve “active goal, current plan step, pending verifier results, and last handoff” (`extensions/context-sieve/index.ts:15-18`) never reaches the summarizer.

**Impact on a hard task:** persistent contribution files can re-inject the goal/recovery directive after compaction, but the actual working history—current plan step, evidence already gathered, changed-file rationale, pending verdict details, and handoff—is left to Pi's default summary. A small model loses precisely the state that the dedicated compaction path claims to preserve. This is high rather than blocking because default Pi compaction still occurs and some goal state is separately re-injected.

**Required direction:** use a supported compaction contract (return a complete `compaction`, or change/adapt to a Pi API that explicitly accepts instruction overrides), and add an installed-runtime test proving the final compactor input contains the goal, plan, pending verification, and recovery state.

#### E-H02 — The anti-loop → recovery bridge misses ordinary stalls and failed-edit cycles

**Sharpens M-03 and H-06.** Threshold calibration is not the only weakness. State/signature logic prevents escalation for a common advertised signal, while “progress” is credited before success is known.

What works:

- Exact argument hashes are counted in a 40-call window, and strict two-signature alternation is recognized (`extensions/progress-guard/index.ts:19-47,159-177`).
- In auto mode, a detected signal writes a model-visible contribution; after two actions on the same signature it writes a recovery marker (`extensions/progress-guard/index.ts:230-257`).
- Offline fake-handler reproduction with one identical `read` per turn first wrote an escalation marker on the **seventh** identical call: the first nudge occurs once the third repeat exists, then the four-turn cooldown delays the second action (`extensions/progress-guard/index.ts:19-20,161-171,236-255`).

What fails:

1. **An ongoing read stall cannot accumulate toward recovery.** The signature is `stall:${readsSinceWrite}` (`extensions/progress-guard/index.ts:178-181`). Each additional read changes it (`stall:6`, `stall:7`, ...), so each signature's `actCounts` remains 1 and never reaches the default escalation count of 2 (`:241-255`).
2. **A write tool call is treated as progress even when the edit later fails.** State resets on `tool_call` solely from the tool name (`extensions/progress-guard/index.ts:207-227`). There is no `tool_result` handler. A small model can repeatedly gather five reads, attempt a different failing edit, and reset the stall/oscillation state forever.
3. **Semantic loops evade the detector.** Repetition requires identical hashed inputs, and oscillation requires exactly two coarse signatures alternating (`extensions/progress-guard/index.ts:39-47,161-180`). Small changes to query, command, target, or edit text avoid both; no verifier delta, error class, file diff, or goal-progress signal is considered.

**Concrete offline repro:** using the repository's fake-Pi harness against the real registered handlers in fresh OS temp state:

```text
12 distinct read calls, each followed by turn_end:
DISTINCT_READS_12_NUDGE=true
DISTINCT_READS_12_ESCALATION=false

Four cycles of 5 distinct reads + a distinct attempted edit (24 calls total):
READ5_FAILED_EDIT_X4_NUDGE=false
READ5_FAILED_EDIT_X4_ESCALATION=false
```

The second simulation intentionally did not provide a successful result; the guard could not distinguish that from progress because it never observes results. The first simulation proves that the advertised read-stall path nudges but cannot invoke recovery while reads continue.

Even when a marker is produced, H-06 remains decisive: recovery only writes instructions/report scaffolding (`extensions/recovery-orchestrator/index.ts:169-197`). Additional reliability gaps sharpen it:

- verdict state is read, but both passing and failing boards take the same path; the empty `if` has no control effect (`extensions/recovery-orchestrator/index.ts:58-67,126-139`);
- attempt counts live only in an in-memory `Map`, while session start clears the recovery marker and contribution (`:159-167`), so the cap is not durable across a crash/restart;
- no handler clears a recovery directive when a fix is verified, records an outcome in `trace-ledger`, or compares against the checkpoint/verdict that the design requires (`docs/recovery-orchestration-mode.md:45-55,68-108`);
- the report fixture asserts only a contribution, keywords, a blank report, and marker deletion (`kit/eval/fixtures.mjs:184-216`).

**How far a run gets:** an exact-repeat loop receives a nudge at repeat 3 and a recovery instruction/report at repeat 7, but no automatic repair attempt follows. A varied read/edit loop can run until the model stops, Pi exhausts context, or `autonomous-loop` uses its 20 follow-ups; the loop cap counts completed agent runs, not tool actions or verified progress (`extensions/autonomous-loop/index.ts:79-98`). Nothing ensures the task is complete at exhaustion.

**Impact:** these are the failure patterns expected from a small local model—over-reading, changing its attempted edit slightly, and retrying failed mutations. The advertised safeguard either keeps adding advice or never fires. This is high because it breaks the main automatic transition into the already-incomplete recovery layer in non-experimental `long-horizon` and `autonomous` profiles.

#### E-H03 — “Done means verified” can produce a clean-looking false success

**Materially sharpens M-04.** The failure is not limited to malformed-file bookkeeping: absence and asynchronous timing are explicitly treated as permission to finish, and `/verify` can pass without running any project check.

The inconsistent contracts are visible in source:

- `verifier-board` correctly reports an empty board as overall FAIL (`extensions/verifier-board/index.ts:38-43,69-76`).
- `orchestrator` treats a missing file, missing/invalid `verdicts`, or any read/parse error as `{blocked:false}` (`extensions/orchestrator/index.ts:108-122`). Its `agent_end` gate steers only when an already-readable verdict has `pass:false` (`:137-155`).
- `/verify` runs `npm run verify --if-present` and treats process exit zero as PASS (`extensions/verify-gate/index.ts:9-15,53-61`). npm returns zero when the script is absent. Offline repro in this checkout: `npm run __pi_kit_missing_verify__ --if-present` exited **0**.
- automatic per-turn verification is off unless `PI_KIT_VERIFY_ON_TURN=1`; when enabled, it spawns and deliberately does not await the child (`extensions/verify-gate/index.ts:65-93`). Pi emits `turn_end` handlers before `agent_end` handlers (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:351-376`), so the completion gate can read the old/empty board before the child `close` callback records a failure.
- verdict writes are non-atomic and every persistence error is swallowed (`extensions/verify-gate/index.ts:22-37`), as established in M-04.

**Concrete false-success scenario:**

1. Start a long autonomous task in a normal npm project that has `test`/`build` but no script literally named `verify`.
2. The model invokes `/verify`. `npm run verify --if-present` executes nothing and exits 0; the UI says PASS and `verify-gate` attempts to record a passing verdict.
3. If the board write succeeds, `orchestrator` sees all PASS. If it fails, is malformed, or no verification was invoked, `orchestrator` also returns `blocked:false`.
4. The model reports completion. Neither the absence of required verdict sources nor the absence of an actual test/build run causes a block.

A second scenario exists with `PI_KIT_VERIFY_ON_TURN=1`: a prior PASS (or no board) is visible at `agent_end` while the current verification child is still running. The task may be declared complete before the failing close callback records FAIL.

The current eval covers a project whose explicit `verify` script deterministically fails, then separately tests a readable failing board (`kit/eval/fixtures.mjs:90-150`). It does not cover absent scripts, required-verdict completeness, I/O failure, malformed state, or the non-awaited lifecycle race.

**Impact:** a many-hour run can silently return wrong output while every visible harness status is green or absent. Verification is the final trust boundary for a weaker model; fail-open behavior here defeats the entire “done means verified” strategy. High is warranted even though M-04 was medium as a general code-quality finding.

### Medium

#### E-M01 — Context budgeting is real only for extension snippets, not the long-horizon context

The priority sorter is functional, but the scope and enforcement are materially narrower than “context budget/prioritization” suggests:

- only `.pi/ctx-contributions/*.json` content is budgeted; conversation history, tool results, file reads, sub-agent results, and the base system prompt are outside this budget (`extensions/context-sieve/index.ts:66-104`);
- the declared `budgetTokens` per contribution is never referenced after parsing; selection uses raw `content.length` and a single global `budgetTokens * 4` cap (`extensions/context-sieve/index.ts:5-10,73-90`);
- contributions are accepted whole or dropped whole, with no per-source quota/truncation, so one large high-priority item can crowd out every smaller lower-priority item (`:71-90`);
- an invalid `PI_KIT_CTX_BUDGET_TOKENS` becomes `NaN`, making `used + len > budgetChars` false and disabling the cap (`:73-85`);
- compaction contributions are neither sorted nor budgeted (`:106-127`), although E-H01 means they currently do not reach the compactor anyway.

The adjacent `pi-lean-ctx` mitigation remains the established M-05 announcement-without-action case: `session-helpers` says compression “is disabled,” but merely displays a notice and never unloads/disables the extension (`extensions/session-helpers/index.ts:104-120`). Also, the help text says “Compaction is also automatic in this kit (context-sieve)” (`:15-25`), while `context-sieve` only reacts to compaction and never calls `ctx.compact`; `trigger-compact` is the component that actually requests it, at a fixed 100,000-token crossing (`vendor/trigger-compact/index.ts:3-29`).

This is medium because ordinary contribution injection provides genuine value, but it is not a general context governor and its compaction continuity claim is broken.

#### E-M02 — Persistent memory exists, but there is no automatic, task-scoped recall loop

`memory-local` genuinely stores notes and offers keyword/optional embedding search (`extensions/memory-local/index.ts:170-240`). It does not register any `session_start`, `before_agent_start`, compaction, or goal hook; all recall and storage depend on the model choosing the correct tool at the correct time. The default store is user-global rather than project/task-scoped (`extensions/memory-local/index.ts:20-28`), so retrieval can mix unrelated repositories unless the operator configures a directory.

Reliability is modest:

- malformed JSON is silently treated as an empty memory/index (`extensions/memory-local/index.ts:89-109`);
- memory and vector index are separate direct writes with no atomic rename, journal, lock, or generation pairing (`:111-127`);
- a subsequent store after a corrupt read can overwrite the corpus represented by the now-empty cache;
- the trace/memory tools are also affected by F-02's default headless policy, which already proves `memory_store` becomes approval-required/denied in the intended autonomous composition.

`memory-mem0` is an experimental explicit tool adapter, not an automatic replacement for working memory (`extensions/memory-mem0/index.ts:107-158`). Its default MCP path returns transport failures as ordinary text tool results (`:115-147`), so trace-ledger's `event.isError`-based error rate may not count a failed memory operation.

This memory layer can preserve an operator/model-authored fact. It does not automatically restore the goal-relevant facts a small model needs after compaction or across sessions, measure retrieval usefulness, or prevent stale/foreign memories from influencing a task.

#### E-M03 — There is no end-to-end self-improvement loop or measurable capability gain

**Extends M-02 rather than duplicating it.** The exact mine → synthesise → score → apply path stops at several boundaries:

1. **Mine:** `trace-ledger` records timestamp, turn, tool, target, argument hash, and ok/error (`extensions/trace-ledger/index.ts:18-26,115-151`). It does not record the active goal, task/work-unit ID, files actually changed, verifier outcomes, recovery transitions, skill/model used, stop reason, or whether the task succeeded. `skill-forge` can therefore mine frequency, adjacent tool-name bigrams, repeated reads, and error rate—but not successful strategies (`extensions/skill-forge/index.ts:54-83`).
2. **Synthesise:** `skill_synthesise` is real when manually called, but it converts global tool bigrams into a generic runbook proposal (`extensions/skill-forge/index.ts:85-125,150-178`). Nothing invokes it from `/improve` or dream mode, and the proposal is never installed/promoted automatically.
3. **Score:** `skill_score` ignores the candidate beyond writing its name and returns the unchanged kit-wide eval pass rate (`extensions/skill-forge/index.ts:136-147,181-203`), the established M-02 defect. The claimed score fixture does not call `skill_score`; it only verifies that an unrelated security-category eval exposes passed/total (`kit/eval/fixtures.mjs:249-259`).
4. **Apply/promote:** there is no held-out task run with candidate disabled/enabled, weighted utility/safety score, promotion threshold, rollback, versioning, or consumer that moves a passing proposal into `skills/`. `skill_archive` is a separate manually called filesystem operation (`extensions/skill-forge/index.ts:206-233`).
5. **`/improve` bypasses the chain:** it directly turns repeated reads and a high aggregate error rate into static AGENTS.md notes (`extensions/self-improvement/index.ts:48-83,110-140`). It never calls synthesis or score, never measures whether the note changes behavior, and appending the same section can accumulate duplicates (`:90-107`).
6. **Dream mode duplicates the shortcut:** it mines only repeated-read counts and writes those notes to AGENTS.md plus `.pi/memory/dream-notes.md` (`kit/dream.mjs:58-66,84-108`). It does not use skill-forge, the eval scorer, or a promote/revert decision.

Therefore **there is no mechanism today by which the kit can demonstrate that it gets better at long-horizon work across sessions.** It can persist notes and generate reviewable artifacts, but no candidate's causal effect is tested. Medium matches the baseline because these components are confined by intent to the experimental self-improving tier, though F-01 currently undermines profile isolation.

### Low

#### E-L01 — Trace retention is not bounded during the long session it is meant to observe

The ledger claims a 500-line bound, but trimming runs only at `session_start` (`extensions/trace-ledger/index.ts:13-16,70-80,111-113`). Every call/result during an active multi-hour session appends without checking length (`:60-68,115-151`). The file can grow for the entire run, then the next session discards all but the last 500 lines. That means early planning/recovery evidence is lost precisely when a later self-improvement pass begins, while disk growth remains unbounded during the run. The operational impact is low because records are small, but the retention model should be made explicit and task-aware.

### Nice-to-have

#### E-N01 — Long-horizon telemetry should distinguish “attempted,” “changed,” and “verified”

The existing `tool_call`/`tool_result` split is a useful base. Add a stable work-unit/goal ID and explicit transitions for mutation attempted, mutation actually changed files, verifier delta, checkpoint, recovery entered/exited, stop reason, and final mergeability. This would let the guard, recovery controller, and improvement scorer share evidence rather than each maintaining a different weak approximation.

## Concrete long-run failure timeline

A plausible small-model autonomous run fails as follows:

1. The initial complex request receives contribution-based steering. Whether the model actually follows it is outside Reviewer E's lane, but long-horizon state is not enforced by a workflow engine.
2. The model reads broadly. At six reads the guard writes a nudge. As reads continue, the changing `stall:N` signature prevents deep escalation (E-H02).
3. The model attempts an edit that fails because the match is wrong. Merely calling the edit tool clears stall/oscillation state; failure is not observed. Five more reads and another varied failed edit can repeat without any signal.
4. Exact repetition eventually fares slightly better: the seventh identical action creates a marker. Recovery consumes it and writes a blank report plus instructions, but spawns no fresh scout, fork, repair agent, checkpoint, or verifier (H-06/E-H02).
5. As context fills, default Pi compaction occurs. `context-sieve`'s intended goal/plan/verdict/handoff preservation instructions never reach the compactor (E-H01). Persistent goal/recovery contribution text may reappear, but the evidence and current plan can be summarized away.
6. The model eventually declares success. With no board, malformed/unwritable state, a missing `verify` npm script, or a still-running async check, the orchestrator does not block completion (E-H03/M-04).
7. A later dream/improvement pass produces “read this file once” notes from the tail of the trace. It does not prove a better result on the failed task or promote a validated skill (E-M03/M-02).

## Capability gap analysis

Rank is impact on a real multi-hour, many-file task (1 = largest).

| Rank | Safeguard | Design intent | Actual current behavior | What catches failure vs. quietly passes | Gap severity |
|---:|---|---|---|---|---|
| 1 | Verification / definition of done | `/verify` records real checks; orchestrator refuses completion until all verdicts pass (`LATEST_PLAN_2026-08-04T042958Z.md:60-66`; `docs/roadmap.md:101-105`) | Only an existing explicit FAIL blocks. Missing/malformed/unwritable boards allow completion; absent npm `verify` scripts return PASS; auto checks are not awaited | A readable recorded `pass:false` is caught. No check, absent script, I/O failure, malformed state, stale PASS, and lifecycle races quietly pass | **High** |
| 2 | Anti-loop + recovery | Calibrated repeat/stall/oscillation signals drive fresh scouts, incumbent fork, ranked causes, primary/backup plan, checkpointed delegated repair, and validation (`LATEST_PLAN_2026-08-04T042958Z.md:68-76`) | Exact repeat/strict oscillation can nudge/escalate; read stall cannot accumulate; attempted writes reset progress; recovery writes instructions/scaffold only; attempt state is ephemeral | Exact stable signatures produce a visible nudge/report. Varied semantic loops and failed-edit cycles can run silently; triggered recovery still depends on the same stuck model obeying prose | **High** |
| 3 | Context continuity | One authority budgets context and preserves goal, current plan, pending verifier results, and handoff across compaction | Live contribution priority/injection works. Per-source budgets and total history/tool-output control do not. Compaction instruction mutation is discarded by Pi | High-priority contribution overflow is recorded in `sieve-budget.json`; loss inside compaction is not detected | **High** for compaction path; **Medium** for budget scope |
| 4 | Memory / self-improvement | Trace solved work, synthesize/score skills, propose safely, and improve future sessions (`LATEST_PLAN_2026-08-04T042958Z.md:78-86`) | Manual notes/search and heuristic proposals exist; trace lacks outcomes; scorer is candidate-insensitive; no promotion/revert loop; `/improve` and dream mode bypass synthesis/scoring | Syntax/frontmatter and allowlisted writes are checked. Behavioral usefulness, retrieval quality, and capability delta are never measured | **Medium** (experimental exposure) |

## Highest-leverage next investment

1. **Build one durable, executable task/recovery state machine.** Give every work unit and failure signature persisted state; derive progress from successful file deltas plus verifier deltas, not tool names; invoke fresh scouts/fork/repair through real APIs; checkpoint; await validation; choose backup/rollback; persist attempt caps and outcomes across restarts. This replaces the weakest-model-dependent prompt choreography with harness-enforced transitions.
2. **Make verification a fail-closed completion protocol.** Declare required checks per repository/task, reject an empty board, treat missing scripts and I/O/schema errors as failures, write atomically, await the current verification generation before `agent_end`, expire stale verdicts after relevant edits, and test the complete lifecycle against installed Pi event order. A small model can be imperfect if the harness reliably refuses incorrect completion.
3. **Create outcome-rich traces and a candidate-sensitive learning/eval loop.** Record task/work-unit IDs, model/skill selection, file and verifier deltas, recovery/stop reasons, and final outcome; make memory retrieval automatic but task-scoped; replay representative held-out tasks with a candidate enabled/disabled; promote only on measured improvement and revert regressions. Until this exists, “self-improvement” should remain labeled artifact generation, not capability compounding.
