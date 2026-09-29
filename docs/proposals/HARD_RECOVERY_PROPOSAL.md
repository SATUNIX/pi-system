# Proposal: Two-Stage Steering and Hard Recovery for Pi Agents

> Status: Proposal for pi-system/docs/proposals
> Scope: Parent agents, subagents, long-horizon sessions, and read-only or editing tasks
> Goal: Restore goal-directed work after soft steering fails, without constraining normal exploration or granting a recovery model new authority

## Summary

Keep the existing soft recovery as the first response to a suspected loop. Add a hard recovery for a repeated no-progress signal soon after soft recovery. Hard recovery pauses the current run, asks a separate bounded recovery model to reconstruct the active task from trusted sources, validates its answer, and installs a concise task checkpoint. It uses recovery-mode deterministic compaction only if Pi can remove the troublesome recent window through a supported API; otherwise it starts a clean top-level continuation. It must not treat the recovery model's output as a new user instruction.

This is a working-state change. A second reminder appended to an already confused context is insufficient. The agent should resume with the actual user goal, explicit constraints, correct workspace and todo scope, verified completed work, and a short action plan. It should not inherit the prior sequence of speculative interpretations and repetitive tool results as authoritative context.

The mechanism is available to parent agents and subagents. A parent receives a child's recovery status and any impact on assigned work; it does not silently reinterpret that child's task or merge unverified output.

## Existing names and proposed components

Names observed in the supplied session; code owners and APIs should be verified before implementation:

| Name | Observed role | Treatment in this proposal |
| --- | --- | --- |
| progress-guard | Detects repeated or stalled actions and creates a review/delegate checkpoint. Its context contribution identified a repeat signature and the self-reflection-and-recovery skill. | Keep as the soft-stage detector. Extend it to emit structured progress and recovery events. |
| /reflect and self-reflection-and-recovery | Manual reflection command and skill referenced by existing steering. Their exact request-injection paths require code inspection. | Provide the soft recovery prompt and a manual way to request hard recovery if reflection fails. |
| context-sieve | Injects task-context and delegation guidance. | Assemble a compact checkpoint after hard recovery; respect current user constraints over generic delegation advice. |
| todo | Per-session task state, persisted relative to the session working directory in the observed case. | Read through the tool's authoritative session identity or storage API, not by guessing a repo-root path. Treat entries as fallible assistant-written state. |
| task-classification | Classified the short steering message in the observed session. | Classify the active goal, not the last short user utterance in isolation. |
| orchestrator-verification | Emits a completion diagnostic. | Check that recovery actually restored task progression; do not accept a claim that no task exists when user turns establish one. |
| tool-firewall and human-console | Tool approval and human escalation. | Retain their authority. Recovery must neither bypass approval nor replay an interrupted write. |
| /compress and pi-kit-compress | Actual implementation supplied: a marker-gated session_before_compact hook replaces Pi's LLM summary with deterministic string processing, while Pi chooses the cut point and keeps the recent window verbatim. | Reuse its normal behavior unchanged for ordinary compression. Add a dedicated recovery mode and an internal completion API, and address the kept-window limitation before claiming hard recovery removed a loop. |

New names are proposals: Recovery Coordinator, Recovery Analyst, Task Checkpoint, and Recovery Journal. These can be one extension plus small adapters; they do not require a new multi-agent framework.

## Actual /compress contract and compatibility gap

The supplied TypeScript implements /compress as a command calling ctx.compact with a special customInstructions marker. Its session_before_compact handler returns a deterministic CompactionEntry with the same firstKeptEntryId and tokensBefore supplied by Pi's preparation. buildCompressedSummary processes only messagesToSummarize and, for split turns, turnPrefixMessages. Messages after Pi's cut point remain verbatim. Normal /compact and automatic compaction do not use this handler. The command completes asynchronously via onComplete/onError; its callback can run after the extension context becomes stale.

The normal summary drops tool outputs, reasoning, images, and fenced code; it retains clipped assistant text, digests of tool calls, selected notes, and capped file lists. It clips each user message to at most 600 characters under the default budget, retains the first and newest summarized turns, may omit middle turns, and carries forward a capped previous summary. Its header says user asks are kept, but the implementation does not guarantee preservation of every full user message. A later task or a decisive constraint can be clipped or omitted. Its first turn may be an earlier unrelated request. Assistant assertions and custom notes can also survive in clipped form. The file lists are path hints, not evidence that writes succeeded.

Consequently, plain /compress cannot be the hard-recovery operation: the current repetitive turns may be inside the recent kept window, and the deterministic summary alone cannot reconstruct the active goal reliably. The Recovery Coordinator must build its authoritative Task Checkpoint from the immutable user-message record and verified state before compaction. It must verify exactly which messages Pi would keep. If the harmful recent window cannot be removed through a supported Pi cut-point or session API, hard recovery must create a fresh top-level continuation from the validated checkpoint and durable evidence pointers instead. Do not spoof firstKeptEntryId inside the hook while Pi still retains a different set of entries.

The supplied compressor is still valuable as a normal fast compaction path and as a deterministic summary builder for the supported portion of a recovery transaction. Recovery should extend it with an explicit mode; it must not repurpose the free-form /compress note as the Task Checkpoint, because the note is capped at 1,000 characters by default and is not provenance-validated.

## Desired behavior

### 1. Normal work

The agent may explore, use its tools, and change approach freely. A counter should measure whether actions produce new task-relevant information or advance a deliverable, not impose a fixed number of reads or penalize a legitimate repeated test after a change.

### 2. Soft recovery

When progress-guard detects a likely loop, it issues one visible, concise reflection checkpoint. The checkpoint includes the current task identifier, the repeated observation, the last distinct useful finding, and a request to choose a different next action. It may point to self-reflection-and-recovery. It cannot recommend a subagent if the current user task forbids subagents.

Record a soft-recovery event with its signal family, fingerprint, current task, tool sequence, and time. Start a short observation window, measured in subsequent agent/tool decisions as well as elapsed time. A pause for human approval must not consume the window.

A manual /reflect enters the same bookkeeping path if its invocation is observable. It can also offer /recover hard as an operator command. A manual reflection should never count as proof that behavior changed.

### 3. Hard recovery trigger

Trigger hard recovery when a materially similar no-progress signal recurs within the observation window after soft recovery, or when the agent directly contradicts a trusted result it just received and persists after one correction. Examples include repeatedly discovering the same cwd, repeatedly searching for a todo already returned by the todo tool, or claiming a tool does not exist after successfully calling it.

Normalize by intent and observed result, not exact shell text. Different commands asking where the same todo is should be recognized as the same search. Treat distinct hypotheses and changed inputs as progress. The detector should have a low-confidence category that only prompts soft reflection.

Suggested initial thresholds to tune by replay: one soft event, then hard recovery after two more similar no-progress decisions within roughly six decisions; an immediate hard trigger for a high-confidence contradiction repeated once. These are configuration defaults, not task limits.

### 4. Pause at a safe boundary

The Recovery Coordinator moves the run to PAUSING, blocks dispatch of new model-generated tool calls, and waits for a defined quiescence boundary. It records pending tool IDs and approval state. It must never assume an in-flight command was cancelled or undo an action that already executed.

For cancellable read calls, cancel or let them finish and record the outcome. For writes and external actions, wait for completion or a controlled timeout, then reconcile their actual outcome before constructing a checkpoint. Do not automatically resubmit an interrupted call. An approval awaiting a human remains pending under the original policy; hard recovery must not turn it into an allowance. If the command has already been approved and executed, record that fact. A recovery cannot manufacture a rollback.

If safe quiescence cannot be established, enter PAUSED_NEEDS_RECONCILIATION and report the ambiguous action. Do not compress away the evidence of a possible side effect.

## Recovery inputs and trust boundary

The Recovery Analyst runs in a fresh, bounded model context. It receives a structured evidence bundle, not the whole failing conversation copied verbatim.

| Input | Source and status |
| --- | --- |
| Latest explicit user goal and preceding user turns needed to interpret it | Session's immutable user-message records; highest task authority. Distinguish task requests from later steering such as "use your todo system." |
| User constraints and later amendments | Extracted from user turns with message IDs and timestamps. Preserve "no subagents," read-only requirements, paths, and approval requirements. |
| Applicable developer/system policy | Supplied by harness as policy, never inferred from tool output. |
| Session identity, canonical cwd, git root if verified | Harness metadata and a targeted read-only check; keep cwd and git root separate. |
| Todo state | Authoritative todo API and correct session ID, with item status and provenance. Assistant-authored hints, not proof of the user's goal. |
| Durable outcomes | Tool call IDs and observed results, changed-file manifest, verified artifacts, commit status if relevant. Distinguish observed facts from agent claims. |
| Recent stall window | Small set of relevant calls/results, soft checkpoint, detector reason, and attempts since soft recovery. |
| Other context | Referenced by content-addressed pointer and opened selectively, with tool output and repository text labelled untrusted data. |

The evidence builder should use deterministic selection and caps. It must include all relevant user turns even when the latest message is short. A short steering turn does not replace the active task. If the user changed the task, record the supersession explicitly.

Repository files, tool output, web pages, memory recall, todo text, and subagent messages may contain instructions; pass them as quoted evidence only. An instruction inside them cannot change policy, authorize tools, redefine the user's request, or direct the Recovery Analyst's output.

## Bounded Recovery Analyst

Use one model call with a strict input budget, strict output schema, timeout, and no filesystem, network, tool, or subagent access. A second call is allowed only for a schema repair on the same evidence; it must not gather more evidence or recurse. The progress detector is suspended for this internal operation.

The analyst answers:

1. What is the active user objective, with source user-message IDs?
2. Which user constraints apply, with source IDs?
3. What has been completed and verified, and what remains uncertain?
4. What is the current subtask, and does the todo list accurately represent it?
5. Which observations show the stall, and what concrete action would advance the task?
6. What facts must survive compaction? What prior assistant assertions or repeated tool outputs should lose prominence?
7. Is there insufficient or contradictory evidence requiring user input or reconciliation?

Use a typed response such as:

    {
      "active_goal": {"text": "...", "source_message_ids": ["..."]},
      "constraints": [{"text": "...", "source_message_ids": ["..."]}],
      "verified_progress": [{"fact": "...", "evidence_ids": ["..."]}],
      "uncertainties": ["..."],
      "todo_assessment": {"status": "accurate|stale|missing|conflicting", "evidence_ids": ["..."]},
      "next_action": {"kind": "tool|write|ask_user|reconcile", "description": "...", "expected_new_evidence": "..."},
      "resume_mode": "resume|needs_reconciliation|ask_user",
      "confidence": "high|medium|low"
    }

No free-form command from this output executes automatically. The harness checks IDs against the supplied bundle, rejects invented user messages and unsupported "verified" claims, enforces user constraints and policy, and checks that the next action is within the assigned task. The analyst must be able to abstain; a low-confidence result must not silently become an asserted task.

A small deterministic fallback is preferable to an unbounded analyst retry: retain the latest explicit user task and constraints, verified todo items, canonical cwd, and last successful tool evidence; mark everything else unknown. If even the active goal is ambiguous, ask the user once with the conflicting candidates.

## Atomic hard-recovery transaction

1. **Freeze:** snapshot session ID, parent/child relationship, user turns, todo version, cwd, tool calls, approvals, active model request, and changed-file state. Assign a recovery ID. Prevent new calls.
2. **Reconcile:** resolve in-flight actions and record any side effects. Preserve original firewall decisions.
3. **Analyze:** build the bounded evidence bundle and call the Recovery Analyst. Validate its structured result against message and evidence IDs.
4. **Prepare:** create a Task Checkpoint from validated facts and inspect Pi's proposed firstKeptEntryId, messagesToSummarize, split-turn prefix, and kept recent messages. Retain the full user turns and action records in durable history; do not assume the compressor's clipped summary contains them.
5. **Choose a supported context operation:** if Pi exposes a safe API to select a recovery cut point and replace the problematic recent window, use recovery-mode compaction with the validated checkpoint. Otherwise create a fresh top-level continuation with the checkpoint, current policy and tool schemas, explicit durable-evidence references, and clean recent context. The old branch remains available for audit. An ordinary /compress call is insufficient when the loop is in Pi's kept window.
6. **Install:** place the Task Checkpoint in a dedicated high-salience harness context slot of the resulting run. Bind it to the current session or continuation, user-task version, todo version, and cwd. Explicitly mark it as a reconstruction of existing instructions, not a new source of authority. Do not smuggle it through the capped /compress operator note.
7. **Verify and resume:** inspect the actual assembled next model request. Confirm the active goal and constraints are intact, the repeated recent context is absent, the checkpoint is present exactly once, and the tool and cwd state match the snapshot. Resume with one narrow next action and expected evidence. The agent retains freedom to choose implementation details within the task.
8. **Commit or leave paused:** write the Recovery Journal and unfreeze only after verification. If the underlying session API supports rollback, restore the pre-recovery snapshot on failure. Otherwise leave the original branch paused and do not start the fresh continuation. Never imply that callback completion alone proves the next request was assembled correctly.

The checkpoint should be short enough to read first and concrete enough to act upon:

    Active user goal: write two proposals in docs/proposals, grounded in this repo.
    User constraints: no subagents; no implementation work requested.
    Session cwd: /.../docs/proposals
    Git root: /.../pi-system
    Todo: five items; item 1 in progress; item 2 onward open.
    Verified: repo instructions and proposals directory inspected; no proposal files created.
    Stall: repeated cwd/todo searches after todo list succeeded.
    Next: read relevant schema registration and skill-router files, record findings for proposal 1.
    Success evidence: identified registration points and per-profile tool exposure; then advance todo.

This is illustrative; actual contents must be reconstructed and validated for each run. A user prohibition on subagents applies to both the recovery plan and resumed work.

### Recovery-mode compressor changes

Implement a distinct, structured internal mode for pi-kit-compress. The normal /compress command and its existing summary format remain usable. The recovery mode accepts a validated checkpoint ID and supported cut-point plan, never free-form model-authored customInstructions. Keep the marker as a dispatch identifier and attach a versioned recovery ID in CompactionEntry details. Preserve the existing compressor identifier or teach previousCompressFiles to recognize both modes so repeated compression does not silently discard read/modified-file hints. Those hints never replace the independent side-effect ledger.

Build the recovery summary with an explicit priority order: validated active goal and constraint references first; verified work, todo assessment, cwd and git root, and next action second; optional historical digest last. Reserve enough character budget for the checkpoint before any earlier summary or turn excerpts. Do not import a previousSummary or assistant/custom text as task authority in recovery mode. Make omission explicit when budget is insufficient; reject compaction rather than truncate a required constraint. Keep source user-message IDs and an audit pointer to their complete original text, not merely their clipped rendering. Optional history remains quoted background and can be retrieved by ID.

Pi's preparation determines the ordinary compaction cut point. The hook must not claim to drop a recent loop unless the supported API actually changes what is kept. A preview should compute a hash of the candidate next request's protected messages, kept window, summary, and checkpoint. Following compaction, recompute that hash from the actual assembled request, allowing only documented differences such as generated IDs. If the kept window still includes the repeated loop, fail the recovery path and use a fresh continuation.

Wrap ctx.compact's onComplete/onError callbacks in a single-use internal completion handle tied to recovery ID and session revision. A callback may run after reload, so it should write to durable coordinator state and must not depend on a captured ExtensionContext or a UI notification. Serialize compaction requests per session. The current lastRefusal variable is shared across invocations; replace it with per-request refusal state or a strict single-flight guard before hard recovery uses the hook. Validate the returned details and firstKeptEntryId before resuming.

For ordinary /compress, consider making its header precise: individual user messages can be clipped, middle turns omitted, and the first summarized turn need not be the active task. Put these counts in details and surface a warning when a long user instruction was clipped. Do not silently convert ordinary /compress into recovery mode; the latter has stronger evidence, cut-point, and validation requirements.

## Subagent behavior

A child has an assigned scope and a parent task, plus any inherited user constraints. Recover the child against that assignment and the relevant original user turns, not against the latest instruction to the parent alone. If a child is paused, the parent sees RECOVERING and must not treat partial child output as completed work.

If the child has unverified edits or an in-flight write, reconcile those in its own workspace before resuming. Preserve the parent-child task mapping and a versioned assignment. If the parent changes or cancels the task while the child recovers, reject the old checkpoint and re-evaluate or stop the child. A child may not spawn another agent merely because the recovery prompt recommends delegation; the original authorization and task scope still govern.

Escalate to the parent when the child cannot identify its assignment or recover within one hard-recovery attempt. The parent can reassign remaining work using a fresh scoped child if allowed, or continue itself. Do not silently merge an uncertain child result.

## Recursion, cooldown, and failure behavior

Hard recovery itself is not eligible for progress-guard or /reflect triggers. Deduplicate recovery IDs and require a single active transaction per session. After resume, observe a grace window in which the agent must produce the expected new evidence or make a clearly different attempt. A repeated signal in that window should not start an endless series of model calls and compactions.

Allow at most one automatic hard recovery for the same task/signature in a configurable window. If it immediately fails, pause the run and show the checkpoint, what was attempted, what is blocking progress, and the next operator choice. A materially new task or new failure signature may start a separate cycle. Reset counters only after verified progress, not after the model says it has reflected.

Operator controls should include: show recovery journal; trigger hard recovery; resume from validated checkpoint; and cancel recovery while preserving the prior session snapshot. These controls must not approve pending tool actions.

## Progress signals

Combine cheap deterministic signals with selective reasoning. Do not require every task to use todos.

- **Repeated observation:** canonicalize searches by target and result class. Detect different shell commands that repeatedly ask the same question and return equivalent evidence.
- **Contradiction:** compare claims about cwd, tool availability, task existence, or todo status with recent authoritative results.
- **Deliverable movement:** observe new relevant files, accepted edits, verified test outcomes, todo transitions with evidence, or a useful blocker report.
- **Action diversity:** a changed hypothesis, narrower search, read of a newly identified file, or legitimate rerun after modification counts as a different action.
- **Tool routing:** a relevant routed skill can improve the task, but lack of skill_search alone does not prove a loop.
- **Approval state:** time waiting for a human is neither agent progress nor a repeat decision.
- **Task type:** goals without files or todos use user-visible answers, verified findings, or completion criteria.

Avoid global quotas on reads, token count, or elapsed time. The recovery threshold concerns redundant actions without new evidence.

## Security and reliability invariants

- Only user and higher-priority instructions authorize changes of task or scope. The Recovery Analyst supplies analysis, not authority.
- No tool call executes between the freeze boundary and successful resume. Existing in-flight calls are reconciled, not replayed.
- Firewall decisions and human approvals remain attached to their original action hashes. Recovery cannot reuse approval for a changed call.
- The transcript and audit remain intact even when active context is compacted or a clean continuation is created. Logs identify what was omitted from the model request. Ordinary /compress's clipped user text is never the sole copy of a user instruction.
- A checkpoint cites source IDs for the goal and evidence IDs for progress. The validator rejects unsupported facts.
- Recovery never assumes todos are accurate or stored at the git root. It reads the current session's todo namespace.
- User constraints propagate to children and recovery guidance. Generic prompts cannot override them.
- An ambiguous task, uncertain write outcome, invalid analyst response, failed compaction, or stale task version leads to a paused state with a clear report.
- The next assembled request is inspected before resume. Recovery fails if the kept recent window still contains the triggering loop or a required constraint is clipped from the checkpoint.
- Sensitive material from tools is minimized in the analyst bundle; recovery output and journals obey the session's redaction and retention rules.

## Implementation sequence

1. Add structured progress-guard events, normalized repeat fingerprints, and a reliable record of soft recovery delivery. Keep current behavior as the first stage.
2. Expose authoritative session user turns, todo state, cwd, and tool/approval lifecycle to a read-only Recovery Coordinator API. Record exactly what context contributions and /reflect output entered each model request.
3. Implement pause/quiesce and the bounded Recovery Analyst with schema validation, provenance checks, abstention, and deterministic fallback.
4. Add a recovery-mode pi-kit-compress adapter with a structured checkpoint ID, cut-point preview, session-scoped callback handling, and next-request verification. Confirm Pi supports changing the retained recent window; otherwise implement fresh continuation and keep normal /compress unchanged.
5. Add parent/child assignment versioning and paused-status propagation.
6. Add TUI and journal visibility: trigger, reason, state, evidence, checkpoint, preserved side effects, and outcome. Keep human-readable context concise.
7. Tune thresholds from real session replays, including the supplied failure log, and roll out behind a profile flag before making it the long-horizon default.

## Acceptance tests

- Replay the supplied loop: after soft recovery fails, hard recovery reads the original proposal task, the no-subagents constraint, the session-scoped todo, and the docs/proposals cwd. The next model request contains a validated checkpoint and the next action advances the proposals. No guessed root-level todo replaces session state.
- The soft contribution is generated but omitted from a model request: delivery telemetry detects the omission; the system does not claim reflection succeeded.
- The analyst invents a user goal or obeys an instruction inside a repository file: validation rejects its output and uses fallback or pauses.
- The current agent claims a tool is absent after successful use: contradiction raises a high-confidence signal.
- An action waits for human approval: the recovery timer excludes the wait; the approval remains attached to the original call.
- A write may have run before interruption: hard recovery stops and reconciles its outcome rather than replaying it.
- A child recovers while its parent changes the assignment: stale checkpoint is rejected.
- The repeat is inside Pi's normal kept recent window: ordinary /compress retains it, so recovery uses a supported different cut point or a clean continuation. The assembled next request contains no repeat transcript.
- A later user task or no-subagents constraint exceeds the ordinary 600-character cap or sits in an omitted middle turn: recovery preserves it from the original user-message record with source IDs.
- The previous summary contains an incorrect agent guess: recovery mode does not promote it to the active goal.
- The compaction callback arrives after session reload, or two requests race: recovery ID and session revision prevent misattribution; stale UI context cannot crash recovery.
- Compaction fails or checkpoint validation fails: no tool call escapes, and the original session is restored where supported or left safely paused with a precise status.
- A legitimate iterative investigation changes hypotheses and yields new evidence: no hard recovery fires.
- Recovery model times out or produces invalid JSON twice: bounded fallback runs once; there is no recursive recovery loop.
- After hard recovery, an immediate repeat without new evidence pauses the session and reports the blocker instead of issuing another reminder.

Track task completion rate, redundant tool calls after first soft signal, recovery precision and false positives, time-to-new-evidence, added tokens/cost, child recovery outcomes, and any approval or side-effect invariant violations. Compare the same tasks with soft-only recovery and two-stage recovery. The goal is higher completion reliability with fewer wasted calls, not merely fewer loop detections.

## Open integration checks

The supplied TypeScript establishes the compressor's summary and hook behavior, but not Pi's full session mutation API or context assembly. Before coding, inspect the actual extension contracts for progress-guard, /reflect, context-sieve, todo, Pi's compaction cut point, session replacement, subagent lifecycle, and the model request assembler. The earlier session does not establish whether a soft contribution or manual reflection entered every model request; capture assembled-request metadata. Confirm whether Pi can safely move the kept-window boundary and perform a recoverable session transition. If either capability is unavailable, implement a fresh top-level continuation with the validated checkpoint and leave the original branch intact. Do not approximate removal of recent context by appending another prompt or by changing firstKeptEntryId only in the compressor's return object.