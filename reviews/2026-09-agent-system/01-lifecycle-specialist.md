# Independent lifecycle, prompts, verification and recovery review

Reviewed 2026-09-14; source baseline `6460ef6392dc290038f5ad79835861f9e5e06134`. This report independently inspected implementation and tests, using the two root review briefs and `00-specification.md`. Historical long-horizon and delegation reviews were leads, not accepted findings. No production edits, installed-state changes, live Pi runs or model calls were performed. Counterexamples below are source-level event traces; the coordinator owns executable reproduction and pinned-runtime reconciliation. Source findings do not establish which bytes ran during the reported incident.

The system has useful bounded diagnostics, but task completion, recovery and scheduling are separate advisory mechanisms. It does not currently establish bounded spending or trustworthy task disposition under the review fault model.

## Scope and profile notation

`O`: orchestrator, present in quick, balanced, long-horizon, autonomous, engagement and self-improving. `C`: context-sieve, present in those except quick. `R`: recovery-orchestrator, present in long-horizon, autonomous, engagement and self-improving. `G`: task-graph/verifier-board, present with R. `V`: verify-gate, present with C. Full source loading includes these extensions. Lite applicability is conditional on exported resources and effective settings; names or package versions do not prove loaded bytes. External extensions may add interactions not established here.

Severity assesses the requested autonomous reliability contract. High means a material completion, ownership or spending invariant fails; medium means a narrower defect or configuration-dependent failure. Confidence below describes source behavior, not incident causality.

## Findings

### L01 — A complexity heuristic imposes an implementation/verdict contract on read-only requests

**High; high confidence. Profiles:** O, including quick/balanced without verifier-board.

**Evidence:** `extensions/orchestrator/index.ts:96-107`, `:110-137`, `:371-394`, `:337-363`; planner capability declaration `extensions/orchestrator/agents/planner.md:4-9`. Complexity is inferred from words and length. A request such as “Produce a comprehensive plan for the entire system architecture” scores at least three without authorizing implementation. If `subagent` is active, the hook sets `verificationRequired=true` and contributes “do NOT implement it directly,” followed by planner → implementer → reviewer and “Do NOT report the task done until the reviewer passes.” A missing board then produces a final-turn diagnostic even if the plan was correctly delivered.

**Expected → actual:** read-only task → completed plan; actual → implementation directive and unrelated board requirement. The newer diagnostic explicitly allows accurately reported blockers and is latched once, so this source does **not** reproduce the older unlimited all-PASS steer by itself. The manual `/orchestrate-plan` path correctly sets verificationRequired false (`:431-448`), but ordinary planning requests do not use that distinction.

**Blind spot:** `kit/eval/fixtures.mjs:339-359` checks complex/simple directive presence; it does not test a complex read-only contract or missing board-writer capabilities.

**Mitigation/test:** separate intent/capability/completion contracts from complexity/model routing. Test complex review, plan, discussion and coding requests in each profile; zero implementation instructions or board-driven corrections for read-only scope. Explicit implementation can require checks only after identifying a reachable verifier. **Uncertainty:** actual model compliance and child recursive behavior require runtime evaluation; neither is needed to establish the contradictory prompt.

### L02 — Workspace-scoped startup cleanup destroys other agents' live directives and reimports old goals

**High; high confidence. Profiles:** C/R and autonomous-loop; goal inheritance also affects O profiles.

**Evidence:** `extensions/context-sieve/index.ts:21-33`, `:120-127`; `extensions/orchestrator/index.ts:311-315`; `extensions/recovery-orchestrator/index.ts:219-222`; `extensions/autonomous-loop/index.ts:57-61`; `extensions/goal-core/index.ts:9-14`, `:63-68`.

**Sequence:** parent P in cwd W has an active loop, goal and recovery contribution. Child/session Q loads these extensions in W. Q's context-sieve deletes every contribution JSON; recovery deletes the shared escalation; autonomous-loop deletes the arm marker. Goal-core then imports W's persisted goal into Q without task/parent applicability. P's in-memory loop can remain active even though its visible marker has disappeared.

**Expected → actual:** initialization of Q's private state → deletion/replacement of P's control state and inheritance of workspace mission text. A child need not have model-visible write tools: extension startup performs the writes itself.

**Blind spot:** isolated temporary workspaces and one-session initialization in existing tests cannot expose overlapping ownership.

**Mitigation/test:** scope transient contributions and markers by session/agent/task epoch; let a single owner perform expiry and cleanup. Goal inheritance must be explicit in the spawn envelope. Two-session tests must preserve P's byte-identical live state across Q startup and reject unrelated goal inheritance. **Uncertainty:** particular child resource loading is launcher/runtime dependent; two independently launched sessions loading the same extensions are sufficient.

### L03 — Writable contribution files become system instructions without provenance or expiry

**High; high confidence. Profiles:** C; compaction persists selected directives.

**Evidence:** `extensions/context-sieve/index.ts:25-38`, `:83-111`, `:130-151`, `:175-197`. Any JSON file with a truthy id and string content is admitted; caller-provided priority determines order. There is no producer registry, task epoch, ownership check or expiration. Raw content is appended to `event.systemPrompt`. `includeInCompact` carries it into the replacement summary.

**Sequence:** an authorized extension, another session or any actor able to write this directory places a contribution; next prompt assembly promotes its content into system-prompt text, regardless of source/task validity. A legitimate recovery contribution likewise persists after recovery succeeds because recovery has no success cleanup path.

**Expected → actual:** authenticated, scoped directive/data handling → filesystem content gains instruction priority and can survive compaction. This is a trust/provenance defect; it is not a claim that an OS-isolated writer can cross its sandbox.

**Blind spot:** context-budget tests prove sorting/truncation, not origin, expiry, stale-task rejection or authority preservation.

**Mitigation/test:** trusted producer API and typed contributions with owner, epoch, origin and expiry; render untrusted content as labelled task data. Invalid/stale producers must not enter system instructions or compacted control state. Test stale recovery after verified repair and a foreign-session contribution. **Uncertainty:** filesystem/firewall protections change writer reachability, but do not supply missing provenance for legitimate concurrent producers.

### L04 — Custom compaction drops later corrections instead of summarizing working state

**High; high confidence. Profiles:** C, subject to competing compaction extensions.

**Evidence:** `extensions/context-sieve/index.ts:175-217`, especially `:201-209`. With any goal or compactable contribution, the extension replaces Pi's summarization. It serializes all `messagesToSummarize`, keeps the **first** 8,000 characters by default, and returns the original firstKeptEntryId. The continuity template asks to preserve state but no summarizer actually executes that instruction. `GOAL.yaml` is read whole outside the contribution budget (`:181-196`).

**Sequence:** long summarized region contains an early hypothesis, >8,000 characters of investigation, then a correction or a verified handoff near its end. Active goal activates this hook. Actual summary preserves the early hypothesis and truncates away the later correction, while the runtime may discard that entire summarized region.

**Expected → actual:** retain current decisions, corrections, pending work and evidence → retain an arbitrary oldest prefix plus persistent directives. Merely selecting a suffix would still be a lossy workaround, not a complete state contract.

**Blind spot:** `tests/compaction-continuity-smoke.mjs:61-71` checks that a short transcript marker survives; `tests/context-budget-smoke.mjs:97-99` checks contribution order. Neither proves late corrections survive a long summary region.

**Mitigation/test:** preserve Pi's real summarization with supported custom context, or construct a bounded structured checkpoint with explicit current state and evidence references. Test contradictory old/new instructions and a late blocker beyond the prefix; retained state must contain the correction and not present superseded plans as current. **Uncertainty:** already-kept messages may preserve some recent facts; place the counterexample in `messagesToSummarize`, not the retained region. Runtime adapter precedence remains coordinator work.

### L05 — Verdicts are caller assertions with no task/revision binding or required check set

**High; high confidence. Profiles:** G; O consumes the same workspace board even without G.

**Evidence:** `extensions/verifier-board/index.ts:77-91`, `:59-68`; `extensions/orchestrator/index.ts:249-253`, `:278-301`; `extensions/verify-gate/index.ts:77-95`.

**Sequence:** task A records one recent passing source. Task B changes artifacts or requires independent review. No relevant new verdict is recorded. The completion predicate still accepts A's pass because it only asks whether every existing entry is true and not older than 24 hours. Missing/unparseable timestamps are explicitly accepted as not stale. Conversely an unrelated old failure blocks B. Any caller with `record_verdict` can overwrite source `verify` or `reviewer` with a claimed PASS; caller identity and executed evidence are absent.

**Expected → actual:** all required checks attest the assigned task and artifact revision → any existing all-PASS workspace board suffices. Generation increments count writes, not artifact/check identity; readers do not compare them with task state. Textual reviewer output is not authenticated board evidence.

**Blind spot:** stale-age and missing-board tests do not prove completeness of required checks, artifact invalidation or authority of the recording actor.

**Mitigation/test:** require task/epoch/artifact digest, verifier identity, check definition, actual run outcome and required-check membership. Keep model-reported review observations separate from verifier-owned attestations. Test edit-after-PASS, unrelated task PASS/FAIL, missing required reviewer, spoofed `verify`, malformed/future timestamps. **Uncertainty:** this report does not claim the model actually fabricates results; ordinary stale reuse already violates the predicate.

### L06 — Task state APIs permit dependency bypass and cannot claim work transactionally

**High; high confidence. Profiles:** G.

**Evidence:** `extensions/task-graph/index.ts:42-54`, `:152-166`, `:192-205`, `:214-225`. `task_complete` checks prerequisites, but `task_update` accepts `status: done` directly. Claims are read-modify-rename without cross-process exclusion; the source explicitly acknowledges that limitation. Tasks have no owner, lease or fencing token (`:12-20`).

**Sequence A:** create A; create B depending on A; update B to done. Actual success bypasses the dependency gate. **Sequence B:** two processes read pending A before either saves; both claim A and return it. **Sequence C:** claimant crashes; A remains in_progress without owner/deadline, and `task_next` reports waiting on dependencies even if the problem is an abandoned claim (`:195-197`).

**Expected → actual:** legal dependency-aware owned transitions → unchecked alternate transition and duplicate/permanent claims. Verdict writers also use cross-process read-modify-rename (`verifier-board:48-56`, `verify-gate:83-95`), allowing lost source updates and duplicate generations.

**Blind spot:** `tests/task-graph-invariants-smoke.mjs:58-68` rejects an unknown status; it does not test a valid status via the wrong transition. Sequential claims do not exercise the process interleaving.

**Mitigation/test:** consolidate all state changes behind one transition validator and transactional owner; include leases/fencing for workers and serialized board writes. Test update-to-done dependency bypass, synchronized competing process claims, crash/reclaim, stale completion and simultaneous verdict recording. **Uncertainty:** process-race frequency is unmeasured; the missing atomic transaction is directly established.

### L07 — Shell/custom-tool edits do not trigger automatic verification or invalidate existing results

**High; high confidence. Profiles:** V with `PI_KIT_VERIFY_ON_TURN=1`, especially when O automatic delegation does not trigger.

**Evidence:** `extensions/verify-gate/index.ts:121-126`, `:141-154`; `extensions/orchestrator/index.ts:322-329`. Only successful tools named exactly `write` or `edit` mark the project dirty or activate the automatic check contract. Shell, subagent and custom tools can change files without that event name.

**Sequence:** simple request; assistant performs a permitted shell-based edit; assistant returns stop. Dirty remains false, so no automatic verifier runs. An earlier board PASS remains uninvalidated. Delegated edits have the same issue at the parent unless the child independently loads and triggers verification.

**Expected → actual:** relevant artifact mutation → required verification of new revision; actual → silent finalization with no check. Successful report/document write also marks the entire npm project dirty, illustrating the coarse applicability boundary.

**Blind spot:** `tests/verification-lifecycle-smoke.mjs` drives named write/edit events. Hook-only tests do not inspect actual artifact changes through other authorized execution paths.

**Mitigation/test:** derive dirty state from scoped artifact revisions/diffs or trustworthy execution effect reports, with declared verification requirements. Test equivalent write/edit/bash/custom-tool/subagent mutations and unrelated report writes. **Uncertainty:** automatic verification is opt-in and does not claim to cover all shell effects explicitly; this is a gap against the requested end-to-end verification contract.

### L08 — Suggest-only progress mode still escalates into automatic recovery directives; successful progress does not clear repeat history

**Medium; high confidence. Profiles:** progress-guard in all named profiles; automatic recovery impact requires R/C.

**Evidence:** `extensions/progress-guard/index.ts:159-183`, `:232-242`, `:257-272`; `extensions/recovery-orchestrator/index.ts:227-252`. Mode controls only the immediate nudge/notification. Escalation is written independently of mode. Recovery then writes a high-priority contribution. Successful write resets read/oscillation counters and last signature, but not `recent` or `actCounts`.

**Sequence A:** suggest mode; read ten distinct files over ten turns. Stall detects at six reads, then after the four-turn cooldown escalates at ten. Recovery writes system-directed scout/fork/repair instructions despite suggest-only mode. **Sequence B:** repeat a read three times; perform a successful edit; next turn still sees the old repeated read in recent and can escalate with old cumulative counts, despite progress.

**Expected → actual:** suggestions stay suggestions; completed progress retires the old detection → automatic recovery guidance and stale evidence reuse. Read-only research legitimately needs multiple reads; “make the edit now” (`progress-guard:197`) is inapplicable.

**Blind spot:** progress tests establish escalation and successful-write stall reset, but not suggest+recovery composition or repeat evidence across successful progress.

**Mitigation/test:** emit typed observations tagged by task/progress epoch; require explicit mode authorization for interventions, and invalidate old repeat evidence on verified domain progress. Test long successful read-only review, suggest-mode composition, and repeat/read → successful edit → final report. **Uncertainty:** when a newly written contribution reaches the model depends on before_agent_start timing; the unauthorized intervention artifact itself is deterministic.

### L09 — Recovery caps advice, not scheduling or spending, and does not confirm capability or outcome

**High; high confidence. Profiles:** R; continuation interactions with autonomous-loop.

**Evidence:** `extensions/recovery-orchestrator/index.ts:123-143`, `:182-195`, `:215-252`; `extensions/autonomous-loop/index.ts:87-97`. Recovery increments an in-memory count per signature, writes instructions/report, then consumes the escalation. At cap it writes “give up gracefully” and notifies the UI. It does not set a blocked task, cancel scheduled work, suspend a branch, or disarm autonomous-loop. A new signature or process gets a new budget. Board passing/failing does not change `planRecovery`'s decision (`:188-190`).

**Sequence:** stalled branch reaches the cap; next agent_end with loop active still queues “Continue: <goal>”. The branch has no durable blocked disposition or wake condition. Scout `/fork`, checkpoint, implementer and `/verify` instructions are emitted without confirming tool/role reachability. Commands described for operators are not a child control protocol.

**Expected → actual:** attempt exhaustion → dormant blocked branch with actionable owner/reason; actual → another persistent prompt layered onto independent schedulers. Recovery reports are scaffolds plus recent trace facts, not evidence that recovery attempts were executed or succeeded. Success does not clear recovery contribution.

**Blind spot:** `kit/eval/fixtures.mjs:191-216` and `tests/recovery-grounding-smoke.mjs` check report/contribution presence and trace text, not transition, tool reachability, outcome or bounded model requests. FakePi stores one handler per event and records messages without consuming turns (`kit/eval/harness.mjs:70-86`).

**Mitigation/test:** consolidate intervention arbitration with persisted task state and tree-wide budgets; recovery proposals must pass capability and policy preflight. At cap, no new work for that branch until an explicit relevant external change. Verify report completion, successful repair, stale directives, read-only workers and unsupported tools. **Uncertainty:** exact queued-message runtime behavior belongs to coordinator reproduction; no claim that this path alone caused the incident.

### L10 — Invalid autonomous-loop limits eliminate its iteration bound

**Medium; high confidence. Profiles:** autonomous-loop present in C profiles, armed manually; full/lite when loaded.

**Evidence:** `extensions/autonomous-loop/index.ts:5`, `:77-79`, `:87-97`. `parseInt` is unvalidated. With `PI_KIT_LOOP_MAX=invalid`, MAX_ITERATIONS becomes NaN; the `<=0` stop comparison is always false and decrement remains NaN.

**Sequence:** configure a nonnumeric limit, arm a goal, emit any number of eligible agent_end events. Every event queues another continuation; exhaustion never occurs. Even a valid limit counts agent-end callbacks, not tool actions, token usage or mission-tree work. Module state also survives a session_start callback because that callback deletes files but does not reset loopActive/goal/iterations (`:57-61`).

**Expected → actual:** invalid configuration fails closed or uses finite validated default → nominal cap silently disappears. Session reset can leave active invisible in-memory continuation state.

**Blind spot:** default-value/arming tests do not exercise malformed environment settings or reinitialization of an already armed extension instance.

**Mitigation/test:** validate a bounded positive finite integer, stop scheduling on explicit terminal task state, reset only through an owned lifecycle transition. Test empty/nonnumeric/negative/overflow limits and second session_start. **Uncertainty:** actual additional inference depends on pinned Pi's handling of agent_end follow-ups; the extension-level request bound demonstrably fails.

## Current lifecycle and prompt map

Operator input resets O's latches unless `source === extension`; heuristic complexity creates a shared contribution and optional board requirement. Context-sieve assembles files at before_agent_start. Tools mutate artifacts; only named write/edit events activate automatic V checks. Final assistant stop can execute V and O hooks; registration order matters and needs pinned-runtime tests. O emits one typed diagnostic per non-extension input epoch. Agent_end independently queues autonomous-loop user follow-ups. Guard turn_end writes observations as contribution/escalation files; recovery consumes them into more instructions. No authoritative transition binds these operations to task status, worker disposition or total spending.

Prompt origins are: operator input; role/project instructions; goal-core persisted goal; orchestrator complexity/manual directives; guard reflection; recovery instructions; autonomous goal contribution and direct continuation; verify/O custom messages; dual-review direct user follow-up (`extensions/dual-review/index.ts:19-35`); tool data; custom compaction. Files have content/priority/budget but no authenticated origin or epoch. O's newer explicit diagnostic and extension-source reset exemption are meaningful improvements; do not attribute the historical unconditional agent_end steer to this source version.

## Recommended order and acceptance focus

1. Contain applicability and scheduling: read-only scopes finish without verification debt; recovery cap creates a durable dormant blocker; malformed limits cannot remove bounds.
2. Introduce one task/epoch/control owner and transactional transitions. Scope files by ownership; keep structured worker results separate from user intent and verifier attestations.
3. Replace stale board assertions with required, revision-bound evidence; recognize effects through all execution paths.
4. Preserve current state through real compaction and retire stale contributions; gate interventions by explicit mode/capability.
5. Validate with multi-handler deterministic traces and actual pinned runtime event adapters. Require zero forbidden dependency transitions, duplicate claims, foreign-state cleanup, read-only verification corrections and post-cap continuations in the bounded scenario suite. Those are acceptance targets, not results claimed by this source review.

No implementation or live red-team validation is included. Coordinator reconciliation should deduplicate shared-state/provenance findings against delegation/security review and retain platform/runtime uncertainties explicitly.
