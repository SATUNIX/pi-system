# Agentic Delegation, Orchestration & Model-Routing Review

Date: 2026-08-04  
Branch: `hardening/production-readiness-plan`

## Verdict

The kit contains one genuinely useful agentic primitive: `vendor/subagent` can launch isolated Pi subprocesses in single, bounded-parallel, and sequential-chain modes. Its per-agent model and tool configuration is not decorative. When present in agent frontmatter, `model` becomes a real `--model` argument and `tools` becomes a real `--tools` allowlist; Pi consumes both when it constructs the child session.

That primitive is not assembled into the autonomous, difficulty-aware harness the roadmap claims. Out of the box:

- the intended autonomous/headless profile blocks the parent `subagent` call before its implementation runs (a direct operational consequence of established baseline F-02);
- none of the four shipped roles specifies a model, so child workers use the operator's saved/default model;
- the only automatic model router is established-broken H-03, and its strong-model input signal has no production writer anyway;
- complexity scoring writes a prompt directive but never invokes, monitors, retries, or verifies a plan → implement → review workflow;
- the “DAG” is a non-transactional JSON list that permits duplicate claims, missing/cyclic dependencies, premature completion, and invalid states; and
- worktree-isolated fan-out is unusable through four of `branch-lab`'s five public tools (established H-02).

Therefore the explicit bottom line is: **no task-appropriate model is automatically selected and used based on task difficulty today.** With the shipped role files, the parent and its subprocess workers resolve to the operator-configured model. A task-appropriate *role* can run with a genuinely different restricted toolset, but only after the main model obeys advisory text and calls `subagent`; a custom operator-authored role can also select a different model. Those are real manual/configured capabilities, not an end-to-end adaptive orchestrator.

## Scope, method, and accepted baseline

I read `reviews/FINAL-review.md` in full and treated its findings as established facts rather than re-litigating them. This report sharpens F-02, H-02, H-03, H-04, M-01, M-04, and M-05 where they intersect the agentic runtime path.

I assessed the implementation against the plan's executable recovery/verification DoDs (`LATEST_PLAN_2026-08-04T042958Z.md:56-83`) and the roadmap's completed “Agent Orchestration” claim (`docs/roadmap.md:87-106`). I read the extension and installed Pi runtime source directly. Verification was offline: source tracing plus fake-Pi handler calls in fresh OS temporary directories. No live Pi/model/backend invocation or external network call occurred.

`node_modules` was already present and included the Pi runtime needed for source-level consumption tracing, so no install was needed. The checked branch was `hardening/production-readiness-plan`.

## End-to-end trace: what `vendor/subagent` really does

### Agent configuration discovery is real

`discoverAgents` reads user/project Markdown roles, parses comma-separated `tools`, preserves an optional `model`, and stores the body as the system prompt (`vendor/subagent/agents.ts:26-74,97-115`). Project roles override same-named user roles in `both` scope (`vendor/subagent/agents.ts:104-113`). The orchestrator materializes its shipped roles into `.pi/agents` without overwriting operator edits (`extensions/orchestrator/index.ts:19-36,130-135`).

### Single, parallel, and chain execution are real

The public tool uses Pi's correct five-argument execute signature (`vendor/subagent/index.ts:268-281`). It enforces exactly one of single, parallel, or chain mode (`:285-296`).

- **Single:** calls one child and returns its final assistant text (`:353-358`).
- **Parallel:** accepts at most eight tasks and runs at most four concurrently (`:25-27,103-121,337-350`). This is real subprocess fan-out.
- **Chain:** runs sequentially, replaces every `{previous}` marker with the preceding child's final assistant output, and stops on the first failed child (`:316-334`).

Every child is a fresh `pi --mode json -p --no-session` process (`vendor/subagent/index.ts:158-181`), so context isolation is real. An agent body is placed in a mode-0600 temporary file and passed through `--append-system-prompt` (`:123-129,166-173`), then removed in `finally` (`:246-249`).

### Per-agent model selection and tool restriction are enforced when configured

The subagent implementation appends `--model <agent.model>` and `--tools <comma-list>` (`vendor/subagent/index.ts:158-164`). Pi's CLI parser stores both (`node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js:40-42,85-90`). The model is resolved into session options (`node_modules/@earendil-works/pi-coding-agent/dist/main.js:263-291`) and passed into session construction (`:545-571`). The tool list is copied into session options (`node_modules/@earendil-works/pi-coding-agent/dist/main.js:329-342`), becomes an allowlist (`node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:131-135`), and filters both built-in and extension tool registries (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1825-1853,1867-1887`). This is a hard runtime restriction, not prompt advice.

The shipped roles exercise only half of this mechanism. `planner`, `reviewer`, and `scout` have real restricted `tools` frontmatter (`extensions/orchestrator/agents/planner.md:1-5`; `reviewer.md:1-5`; `scout.md:1-5`). `implementer` intentionally has no tool allowlist (`implementer.md:1-7`) and therefore receives the full loaded tool surface. **None of the four files has `model:`.** With `--no-session` and no CLI model, Pi falls back to saved/default model selection (`node_modules/@earendil-works/pi-coding-agent/dist/core/sdk.js:83-112`). Thus different shipped roles get different tools, but not different models.

### JSON consumption is real; parent-facing streaming is not

Pi JSON print mode emits each agent event as JSONL (`node_modules/@earendil-works/pi-coding-agent/dist/modes/print-mode.js:79-93`). The child parser buffers stdout by lines, parses JSON, records `message_end` messages, accumulates assistant usage, and captures model/stop/error state (`vendor/subagent/index.ts:182-225`). The event name matches Pi core's actual `message_end` emission (`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:202-248,507-508`).

However, this is internal stream *consumption*, not streaming back to the parent. The public execute callback is named `_onUpdate` and never used (`vendor/subagent/index.ts:279`); every returned result has `details: undefined` and omits accumulated usage/cost/turn counts (`:292-295,327-334,350,356-358`). A long child run is silent until completion. See D-M01.

## Hook-return audit: isolated contract misuse, broader wiring problem

I exhaustively searched in-repo extension/vendor source for `model_select`, `setModel`, `setActiveTools`, provider-request routing, and returns containing model/tool choices. `provider-router` is the only in-repo extension attempting model choice through a hook return (`extensions/provider-router/index.ts:55-61`). There is no other hidden model router.

The ignored-return defect is **not systemic across Pi hook returns**. It is isolated to using a notification event as though it were a transform event:

| Hook site | Extension behavior | Pi contract/consumer | Result |
|---|---|---|---|
| `model_select` | `provider-router` returns `{model}` (`extensions/provider-router/index.ts:55-61`) | The public handler has no result type (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:563-570,833`); Pi sets and persists the model before emitting and ignores results (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1083-1109`) | **Discarded** (H-03) |
| `before_agent_start` | `context-sieve` returns a replacement `systemPrompt` (`extensions/context-sieve/index.ts:66-103`) | Runner chains it (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:746-798`) and session installs it for the turn (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:795-817`) | **Consumed** |
| `tool_call` | `tool-firewall`, `protected-paths`, and `plan-mode` return `{block,reason}` (for example `extensions/tool-firewall/index.ts:279-330`; `vendor/protected-paths/index.ts:38-63`; `vendor/plan-mode/index.ts:47-55`) | Runner short-circuits on block (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:639-656`); agent core converts it to an error without executing the tool (`node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:360-413`) | **Consumed** |
| `session_before_switch` / `session_before_fork` | `dirty-repo-guard` returns `{cancel:true}` (`vendor/dirty-repo-guard/index.ts:3-35`) | Runner recognizes session-before events and returns immediately on cancel (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/runner.js:516-537`) | **Consumed** |

The systemic pattern is instead **advisory/scaffold behavior presented as execution**: provider routing returns through an unsupported event; orchestrator routing writes instructions and depends on model compliance; `mcp-router` registers a `tool_call` hook that always returns `undefined` (`extensions/mcp-router/index.ts:3-10`); tests assert locally produced values/files rather than downstream effects. The technical failure shapes differ, but all avoid proving that a selected route actually runs.

## Findings

### Blocking

#### D-B01 — The intended autonomous profile blocks delegation before `subagent.execute` (sharpens F-02)

This is not a duplicate root cause; it is the concrete end-to-end consequence for the central agent-team claim.

- `subagent` is a custom tool named `subagent` (`vendor/subagent/index.ts:268-279`).
- The shipped firewall policy names only nine tools and does not include it (`extensions/tool-firewall/default-policy.json:3-15`). Unknown tools become `ask`; headless `ask` returns `{block:true}` (`extensions/tool-firewall/index.ts:200-205,279-307`).
- Pi enforces the block before executing the registered tool (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:178-198`; nested `pi-agent-core/dist/agent-loop.js:360-413`). Therefore `vendor/subagent/index.ts:279` is never reached.
- Even if the firewall policy were manually expanded, `pentest-governance-domain` blocks every non-read-only direct tool unless `PI_ALLOW_DIRECT_TOOLS=1` (`extensions/pentest-governance-domain/index.ts:603-617`). The autonomous/long-horizon profiles include both governance extensions and `subagent` (`profiles/autonomous.json:4-13`; `profiles/long-horizon.json:4-13`). Baseline F-01 further establishes that full-package profile metadata does not isolate these resources at runtime.

**Concrete trace/repro:** the first review independently drove a headless production-shaped `subagent` call and received `approval required ... no interactive UI`; Pi's pre-tool call path above proves that is terminal before the child spawn. The same trace also explains why changing `vendor/subagent` alone cannot restore autonomous delegation.

**Impact:** the flagship set-and-walk-away path has zero child-agent capability under shipped defaults. Single, chain, and parallel implementations may be correct in isolation, but autonomous execution cannot reach them.

**Severity:** blocking, consistent with baseline F-02's blocking classification.

### High

#### D-H01 — Difficulty-dependent model routing is absent at both the decision input and decision output (extends H-03 and M-01)

H-03 already proves the returned `{model}` is discarded. Two additional facts make the strong-model path even less real:

1. `provider-router` reads `task_type` only from `.pi/ctx-contributions/goal-core.json` (`extensions/provider-router/index.ts:34-42`). Real `goal-core` writes only `id`, priority, budget, content, and compaction metadata (`extensions/goal-core/index.ts:27-44`). No production source in the repo writes `task_type`, `taskType`, `goal_decomposition`, `cross_file_review`, or `done_triage`; the only writer is the test.
2. None of the shipped subagent roles declares `model:` (`extensions/orchestrator/agents/*.md` frontmatter cited above), so subprocess model selection falls back to the operator default even if orchestration delegates.

**Concrete offline repro:** after loading real `goal-core`, setting the goal to `Implement cross-file auth review`, then invoking the provider handler, the result was `{"model":"gemma4:latest"}`—the hot path, not the strong path. The existing smoke instead hand-writes a synthetic `{task_type:"goal_decomposition"}` shape that production never emits, then asserts the handler's ignored return (`tests/epic2-smoke.mjs:133-150`).

**Impact:** task difficulty cannot change the parent model, and shipped child roles do not change it either. The two-tier small-local/strong-model strategy is absent, not merely unreliable.

**Severity:** high. This materially sharpens H-03 rather than duplicating it.

#### D-H02 — Complexity scoring changes a prompt, not an executable or verified workflow

The scorer is real heuristic code (`extensions/orchestrator/index.ts:39-50`). For a score at/above threshold it writes a high-priority contribution containing plan/implement/review instructions (`:53-101,158-179`). `context-sieve` then injects that contribution through a supported `before_agent_start` result, so the directive is genuinely model-visible (`extensions/context-sieve/index.ts:66-103` and Pi consumers cited in the hook table).

Nothing in `orchestrator` invokes `subagent`, creates/claims tasks, evaluates child results, recognizes reviewer PASS/FAIL, retries implementation, or drives branch worktrees. It registers no tool and only the `/orchestrate` mode-control command (`extensions/orchestrator/index.ts:125-205`). Its definition-of-done logic merely reads an existing verdict file after an agent run (`:108-155`). The repository documentation accurately admits that there is “no hidden background spawn” and a subagent runs only if the main model calls it (`docs/agent-orchestration.md:27-35`), contradicting stronger “auto-invoked” wording at `docs/agent-orchestration.md:3-5` and the roadmap's completed autonomous-team framing.

The claimed manual deterministic entry points do not exist either: `/orchestrate-plan` and `/orchestrate-implement-review` appear only in documentation (`docs/agent-orchestration.md:43-46`); the source registers only `orchestrate` (`extensions/orchestrator/index.ts:181-204`).

**Concrete offline repro:** a fake-Pi complex request produced `directive=true`, `registeredTools=0`, `sentMessages=0`, and `commands=orchestrate`. The committed eval asserts only that the contribution file exists and disappears for a trivial prompt (`kit/eval/fixtures.mjs:332-359`). It never observes a child, role order, retry, or verdict.

**Impact:** the weakest component—the small local parent model—must correctly recognize and execute the entire orchestration protocol from prose. The harness does not take that planning burden away from it, recover from skipped steps, or prove a reviewer loop occurred.

**Severity:** high. This is core strategic capability represented by a steering prompt rather than a controller.

#### D-H03 — Goal/task/verdict files do not enforce a trustworthy multi-step “verified done” invariant (extends M-04 and M-05)

The three pieces persist state, but they do not form a control plane:

- `goal-core` sets a goal only through a manual `/goal` command and writes a prompt contribution (`extensions/goal-core/index.ts:47-53,60-89`). There is no automatic binding between the incoming task, the task graph, and verdict sources.
- `task_create` accepts missing, self, and cyclic dependencies without validation (`extensions/task-graph/index.ts:69-92`, baseline M-05). `task_next` reads the first unblocked task but does not atomically claim it or mark it in progress (`:131-145`). `task_complete` marks a task done without checking dependencies (`:147-160`). `task_update` casts any string to the status union (`:95-112`). All updates are plain read/modify/write JSON (`:30-44`), so parallel workers can lose each other's updates.
- `verifier-board` lets any caller overwrite the latest verdict for any arbitrary `source` (`extensions/verifier-board/index.ts:50-66`). It records assertions, not provenance or executed evidence. Orchestrator checks only explicit `pass === false` entries and never checks whether a goal exists, tasks remain, required verifier sources are present, or any verification was run (`extensions/orchestrator/index.ts:108-122`). Missing/malformed board state fails open, as established in M-04.
- The gate runs on `agent_end` and sends another user steering message (`extensions/orchestrator/index.ts:137-155`); Pi has already streamed/persisted the assistant response before `agent_end`, then continues only because the handler queued another message (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:265-301,351-375,655-690,1013-1041`). This is a corrective loop, not a transaction that prevents a completion message.

**Concrete offline repro against real handlers:** create `t1`, create `t2` depending on `t1`, call `task_next` twice, complete `t2`, then update `t1` with status `teleported`. Actual outputs were:

```text
claim1=Next: t1 — root
claim2=Next: t1 — root
premature=Completed t2. 1 task(s) remaining.
invalid=Updated t1: teleported
```

No concurrency race was required to demonstrate duplicate assignment; actual concurrent subprocesses add lost-update risk.

**Impact:** two implementers can take the same task; dependent work can be declared done before prerequisites; an incomplete task graph can coexist with an all-PASS or absent verdict board; and corrupted state is interpreted as no blocker. A hard multi-file task cannot rely on this triad for ordering or completion integrity.

**Severity:** high. This extends the previously noted cycle and fail-open defects into the complete coordination invariant.

#### D-H04 — Worktree-isolated parallel implementation is currently broken; only shared-worktree fan-out remains (cross-references H-02 and H-04)

Established H-02 is confirmed by source: `branch_create`, `branch_switch`, `branch_discard`, and `branch_merge` treat argument one as params (`extensions/branch-lab/index.ts:156-167,181-220`) rather than Pi's public `execute(toolCallId, params, signal, onUpdate, ctx)` signature. `branch_list` is the lone tool unaffected because it accepts no params (`:170-179`). A production-shaped `branch_create.execute("call-1", {taskId:"review-task"}, ...)` therefore passes the call ID string into `taskIdFrom` and fails before Git, exactly as the baseline reproduction recorded.

Even if those signatures were repaired, `branch-lab` is only a lease/worktree CRUD surface. It never launches an agent into a worktree. The main model must call `branch_create`, parse the returned filesystem path, and pass that path as each `subagent` task's optional `cwd` (`vendor/subagent/index.ts:252-266,337-344`). Orchestrator contains no such calls. H-04 separately removes the expected restore point before a later fork can use it, weakening rollback for failed experiments.

**Current capability classification:**

- Subagent single/chain/parallel subprocess fan-out: **mechanism works**, subject to D-B01 in shipped autonomous execution.
- Parallel implementers in one shared working directory: **mechanically available** through `subagent.tasks`; safe only for genuinely disjoint files and still exposed to shared JSON/Git races.
- Harness-managed worktree fan-out: **confirmed broken** through its public tools.
- Manual workaround: an operator can pre-create worktrees outside these tools and pass explicit `cwd` values, or the parent can use raw Git commands if policy permits. That is not `branch-lab` capability.

**Impact:** the full profile's advertised distinction—parallel implementers isolated in worktrees (`docs/agent-orchestration.md:37-41`)—does not exist at runtime. Shared-worktree parallel edits can clobber each other, and the task/verdict stores are not concurrency-safe.

**Severity:** high, consistent with H-02; this report clarifies that parallel subprocesses survive but isolated implementation does not.

### Medium

#### D-M01 — “JSON streaming” is consumed internally but hidden from the parent and observability layer

`runSingleAgent` parses JSONL incrementally and accumulates usage/cost/turns (`vendor/subagent/index.ts:182-225`), but `_onUpdate` is unused and every tool response discards the accumulated metadata (`:279,292-295,327-334,350,356-358`). Parallel output is capped only after each entire child output is accumulated (`:96-100,345-350`). There is also no child timeout; only parent abort signals terminate a subprocess (`:227-237`).

**Impact:** a many-minute local-model worker appears as one silent tool call. The parent cannot inspect intermediate progress, usage, active model confirmation, or a stuck child, which makes reliable long-horizon supervision and targeted cancellation harder.

**Severity:** medium. Delegated final output still works, so this is not a claim that the subprocess mechanism is fake.

#### D-M02 — Orchestration tests validate local artifacts, not the downstream contract (extends M-01)

There is no committed smoke/eval that invokes `subagent` with a fake local executable and verifies actual argv, JSON events, tool restrictions, modes, failure propagation, or concurrency. The provider test fabricates a task-type field production never writes and asserts an ignored return (`tests/epic2-smoke.mjs:133-150`). The orchestrator test asserts only directive-file presence (`kit/eval/fixtures.mjs:332-359`). Branch-lab smoke calls the same incorrect execute shape as production code (`tests/epic1-smoke.mjs:143-155`, baseline H-02).

**Impact:** the green suite proves isolated producers, not routing consumption or a plan → implement → validate run. It allowed all four high findings above to present as completed capability.

**Severity:** medium after deduplication, consistent with baseline M-01; the concrete runtime failures carry higher severity.

## Direct answers to the review questions

### Is `provider-router` evidence of a systemic ignored-hook-return pattern?

No. At least three other return-bearing hook categories—prompt replacement, tool blocking, and session cancellation—are explicitly consumed by Pi core. `provider-router` is an isolated contract misuse hidden by an unsafe cast. The broader systemic issue is weaker but still serious: several routing/orchestration claims stop at a notification, instruction file, no-op hook, or test-local artifact rather than proving downstream execution.

### Does complexity scoring gate real plan → implement → validate delegation?

It gates whether a real system-prompt directive is present. It does **not** gate or execute the workflow. Delegation, role sequence, parallelization, reviewer interpretation, retry, task recording, and verdict recording remain decisions for the parent model.

### Can goal-core/task-graph/verifier-board be trusted for a genuinely hard task?

No. They are useful human/model-readable state files, but there is no validated DAG, exclusive claim/lease, dependency-respecting transition, atomic update, required-verifier set, evidence provenance, or unified completion predicate. “Verified done” is advisory state, not an enforced invariant.

### Is there a working path around broken `branch-lab` tools?

Yes, but it bypasses the advertised isolation layer: `subagent.tasks` can run up to four children concurrently in the same cwd, and callers may manually supply different pre-existing `cwd` paths. There is no working harness-controlled create → dispatch → merge path through `branch-lab` today.

### Does a task-appropriate model or subagent get selected differently by difficulty today?

- **Model:** no, not out of the box. H-03 discards the parent route; its input signal is never produced; shipped child roles have no model assignment. Parent and children use operator configuration.
- **Subagent role:** possibly, but indirectly. Complexity adds instructions, and if the parent follows them it can choose planner/implementer/reviewer/scout. Tool restrictions then differ genuinely. The harness does not itself enforce that selection or confirm it occurred.
- **Custom configuration:** an operator-authored role with `model:` and `tools:` is honored by the real subprocess path. This is manual capability, not dynamic difficulty routing.

## Constraint and mutation confirmation

- No remote push occurred.
- No tag was created, moved, or deleted.
- No live Pi agent, live model/backend, or provider call occurred.
- No external network request occurred.
- Temporary-state reproductions used the existing offline fake-Pi harness and were removed.
- The only file intentionally created or modified by Reviewer D is `reviews/agentic-delegation-orchestration-review.md`.

## Highest-leverage next investment

1. **Build an executable orchestration controller with a persisted state machine.** On a typed complex-task decision, the controller—not the parent model—should invoke planner, create validated work units, atomically lease them to workers, collect structured results, run independent verification, and loop failed items with bounded retries. Make policy compatibility part of this path so the autonomous profile can actually call its own tools. This removes the largest amount of protocol-following burden from the small model.

2. **Implement routing at a supported decision point and ship explicit role/model policy.** Produce a typed task classification from the actual request; resolve available models; choose parent/child model and thinking/tool budgets before inference; and verify the selected model in child results. Assign shipped roles deliberate defaults (for example strong planner/reviewer, cheap implementer/scout) with operator overrides and failure fallback. Do not use post-selection notification returns.

3. **Replace JSON boards/worktree hints with transactional execution invariants and end-to-end offline tests.** Enforce an acyclic graph, valid state transitions, atomic claim/lease/heartbeat/retry, dependency-respecting completion, required evidence-backed verdicts, and worktree create → child cwd → verify → merge/rollback. Test the real public execute signatures and subprocess argv/JSON behavior using a fake local `pi` executable—no provider required—plus adversarial fixtures for child crash, timeout, duplicate claim, conflict, verifier fail, and recovery.
