# Review brief: coherent multi-agent execution, delegation and recovery

Date: 10 September 2026. Target: `C:\Users\Anthony Grace\Cyber\Development\Gitlab\repos\misc-agents-pi-kit`.

**Purpose:** let a fresh Codex session expand this brief into a rigorous review specification, then conduct the review and create an evidence-based improvement plan. The objective is a coordinated harness in which multiple agents can plan, implement, review, exchange information and recover without uncontrolled delegation or self-sustaining correction loops.

Read alongside [MONITORING_SECURITY_UX_REVIEW_BRIEF.md](MONITORING_SECURITY_UX_REVIEW_BRIEF.md). This document deepens the execution/delegation/liveness requirements; it does not replace the ECS, security, UX or final adversarial-validation requirements in that brief.

This is a source-grounded handoff, not a completed full review, a proven reproduction of the incident, or an instruction to reload an active Pi session. No implementation changes or model evaluations were made while preparing it. "Foolproof" must mean explicit contracts, bounded failure and convincing evidence within a stated threat/fault model, not a claim that arbitrary agent behavior can always succeed.

## 1. Incident and intended outcome

The operator enabled LiteLLM request/response visibility and reports that an active Pi run was severely stuck: repeated "Definition of done NOT met" prompts from the harness kept extending work, a subagent recognized its predicament but lacked write/control capabilities to resolve it, and loop detection fired without producing an effective exit. Delegated checks and self-review did not provide real recovery. Earlier visible changes in workspace trace/firewall files came from another session; they were not evidence of this run's progress. Roughly seven million tokens had already been reported consumed earlier in the incident.

Treat the operator's observation as the primary incident report. Obtain a minimally scoped, redacted sequence of affected LiteLLM turns if available, with request IDs, agent correlation where possible, effective prompts, tool requests/results and usage. Do not pull every conversation or infer a root cause solely from token counts. Separate repeated input/cache accounting from new generation and aggregate spend. Preserve evidence without changing the active process.

The desired system must:

- Maintain one understandable task/agent hierarchy, with independently scoped workers and a responsible coordinator.
- Support asynchronous spawn, status, messaging, result delivery, review and cancellation with durable identities and observable ownership.
- Let read-only agents finish a plan/review, report an inability to continue, or request assistance without needing to edit harness state or bypass a firewall.
- Detect lack of progress and actually change scheduling/state, rather than continually adding prompts about being stuck.
- Continue useful authorized work where possible; stop spending on an impossible branch and expose a durable, actionable blocker where it is not.
- Make parent/child work, tool calls, pending approvals, background shells, plans and interventions visible and navigable.
- Keep recovery and supervision subject to the same authorization boundaries; a rescue agent is not permission to disable safeguards.

## 2. Baselines and concrete source leads

GitLab HEAD at handoff: `d6aa736789102599b163edffeb2caebcb2e28870` (clean-slate import). The only pre-existing untracked item found was the companion monitoring/security/UX brief. Recheck the baseline and local modifications before starting work.

Pi settings at inspection referenced `OffSec\AI Area\misc-agents-pi-kit\dist\pi-kit-lite`; the installed CLI package was 0.76.0. The active artifact differs from GitLab source. Both kit manifests use 1.0.0. Do not assume an import date, package version or passing source test describes the bytes loaded by the incident's processes.

Source anchors below are starting points, not an exhaustive finding list. Line numbers refer to the inspected checkout unless explicitly marked **installed lite**.

| Lead | Observation and review question |
| --- | --- |
| **Installed lite** `extensions/orchestrator/index.ts:317` | Its `agent_end` hook checks a workspace verdict board and sends `Definition of done NOT met ... only finish when the board is all-PASS` using `sendUserMessage(... deliverAs: "steer")`. No per-task applicability or correction budget is visible in this hook. The wording matches the reported incident; actual runtime delivery must still be reproduced. |
| GitLab `extensions/orchestrator/index.ts:272`, `:337`, `:373` | Missing/empty/corrupt verdict boards block completion. The newer hook uses final `turn_end`, `verificationRequired`, `correctionSent`, and a typed follow-up diagnostic. Non-extension input resets state. This is a meaningful partial fix; test reset semantics, all prompt sources, child inheritance and multi-extension composition before claiming the incident is solved. |
| `extensions/verify-gate/index.ts:141` | Automatic verification is dirty/final-turn gated and bounded; standalone correction has its own latch. Trace ordering with orchestrator and changes made through shell/custom tools, not just `write`/`edit`. Determine what makes a verification contract applicable. |
| `extensions/progress-guard/index.ts:190`, `:210`, `:231`, `:246` | Read/repeat/oscillation heuristics inject guidance or notify; successful write-like results reset some progress state. Escalation is a workspace file. Read-only planning/review can legitimately make progress without writes. Detector output does not itself suspend scheduling. |
| `extensions/recovery-orchestrator/index.ts:123`, `:182`, `:219`, `:227` | Recovery writes a report scaffold and context contribution; instructions ask the model to fan out scouts, `/fork`, repair and `/verify`. The attempt-cap path writes "give up gracefully" guidance and optionally notifies. Identify the actual owner that stops further turns: no scheduler stop is performed in this path itself. Session startup clears shared escalation/contribution files. |
| `extensions/autonomous-loop/index.ts:87` | A separate `agent_end` hook sends `Continue: ...` follow-ups with its own iteration counter. Prove that local counters across extensions jointly bound total activity and cannot revive blocked/cancelled/completed work. |
| `extensions/context-sieve/index.ts:22`, `:130`, `:175`; `extensions/goal-core/index.ts:9`, `:63` | Contributions and goals are keyed under the working directory; contributions are appended to the system prompt and carried into compaction. Review provenance, expiry, task/agent scope and interaction with direct message injection. Child startup must not delete or inherit another agent's transient directives accidentally. |
| `vendor/subagent/index.ts:163`, `:182`, `:218`, `:269`, `:307` | Children use `--mode json -p --no-session`, ignored stdin and private pipes; completed-message progress is consumed by the parent. Single/parallel/chain modes have per-call concurrency limits, but the function does not supply a full bidirectional persistent agent protocol. `agentScope` selects role definition directories; it is not a runtime isolation boundary. Review headless project-agent trust and partial failure handling. |
| `vendor/subagent/index.ts:234` | Cancellation signals the launched process and tests `proc.killed` before escalation. Verify real process-tree exit, shell wrappers, descendants, timer/listener cleanup and preservation of evidence on Windows/Linux. Do not equate "signal sent" with "child finished". |
| `extensions/orchestrator/agents/planner.md`, `reviewer.md`, `implementer.md` | Planner is read-only. Reviewer provides a textual PASS/FAIL and has a listed tool subset. Implementer has broader tools. Determine who receives each result, verifies provenance and persists it; a textual reviewer response must not magically imply a valid verifier-board entry or authority to edit the board. |
| `extensions/conductor/index.ts:242`, `:253`, `:327` | Conductor has a separate specialist spawn path and recursion/dispatch budget; it blocks generic `subagent` during an engagement. Compare this with recovery instructions that demand generic `subagent`. Test actual tool availability, policy and graph reachability for every supported profile. |
| `extensions/dual-review/index.ts:19`, `:33`, `:67` | Review spawns another process, returns immediately and later injects output as a user follow-up. Inspect missing structured job identity, task applicability, cancellation, stale results and whether a review result can be mistaken for new user intent. |
| `extensions/task-graph/index.ts:42`, `:187`; `extensions/verifier-board/index.ts:46`, `:77` | Atomic rename protects readers from torn JSON, but is not a transaction over concurrent read-modify-write operations. The graph source explicitly defers cross-process mutual exclusion. Inspect duplicate claims, lost verdict updates, leases and source/artifact identity. `record_verdict` accepts caller-provided source/pass values: establish trusted attestation ownership. |
| `extensions/tool-firewall/index.ts:343`; `kit/sources.json:40` | Approval-required headless calls fail closed. An optional `pi-subagents@0.32.0` source is listed separately from the vendored launcher. Establish exactly which delegation implementations are loaded, which controls cover them, and whether duplicate tool/command registration or incompatible semantics occur. Do not assume listing an optional dependency activates it. |
| `kit/eval/harness.mjs:70`, `:79`, `:86` | `fakePi()` stores one handler per event name in a `Map`, so later registration replaces earlier registration; it records steers but does not run their follow-on turns. Useful isolated tests cannot prove multi-extension dispatch order or absence of recursive steering. |

The launcher, trace-ledger, tool-firewall and custom-footer implementations were byte-identical between the installed lite artifact and GitLab source in the previous comparison. The GitLab orchestrator and verify-gate have newer behavior. Preserve this distinction throughout the review.

## 3. Review process and deliverables

First expand this brief into an explicit review specification: goals, exclusions, exact supported runtimes/profiles, incident baseline, threat/fault model, deliverables and test matrix. Do not jump to a replacement architecture before mapping the existing flows.

Then perform a baseline code/architecture review and commission **multiple independent specialist subagents** for: (a) runtime state and scheduling; (b) delegation/messaging and process ownership; (c) prompt assembly, steering and compaction; (d) verification/review contracts; (e) deadlock/livelock detection and recovery; (f) authorization/isolation; (g) observability/UX; (h) deterministic simulation and integration fidelity. Bound their scopes and budgets, require evidence and counterexamples, and have a coordinator reconcile disagreements and cross-area interactions. Use separate output artifacts or branches to avoid reviewers overwriting one another.

For each material finding record: affected baseline/profile, minimal event sequence, exact applicable prompt/control, expected state transition, observed transition, why existing tests miss it, severity/confidence, mitigation choices, regression test and residual uncertainty. Assess whether a feature should be fixed, consolidated, replaced or removed; adding another guard is not the default remedy.

Produce these artifacts before implementation:

1. Runtime/resource inventory and trust-boundary map.
2. Lifecycle/state-transition model, prompt-provenance catalog and sequence diagrams for normal/failure paths.
3. Incident reproduction or a clearly labelled approximation plus source-based hypotheses.
4. Independent reviews and reconciled findings.
5. Deterministic scenario suite with counterexample traces.
6. Architecture decisions and prioritized implementation/migration plan with acceptance thresholds.

Preserve the human review/merge boundary. Conduct the final isolated agentic red-team phase only after the planned uplifts and ordinary tests, as specified in the companion brief.

## 4. Trace the whole execution flow

Map actual code and runtime events for:

`operator request -> task contract -> plan -> capability checks -> spawn -> child context -> tool authorization -> execution -> result -> child report -> parent integration -> independent verification -> task disposition`.

For each arrow answer: who owns it, which state is authoritative, what IDs correlate it, which capabilities are needed, whether it can wait, how it times out, whether it survives restart, which event makes progress, and what happens if delivery/execution fails.

Cover branching and re-entry: parallel children; parent receiving a new user message while awaiting children; review requiring rework; partial success; child needing clarification; pending approval; background tools; cancellation; process crashes; compaction; suspended UI; logging failure; network/model timeout; two sessions in the same working directory. Enumerate every route that starts another model request or subprocess, including custom extensions that spawn outside the normal tool path.

Maintain separate meanings for **a model turn ending**, **a worker reporting**, **a task finishing**, **a review passing**, and **a mission completing**. A planner finishing its plan does not assert the overall implementation is complete. A worker reporting a blocker must be allowed to return even if the mission cannot be marked successful.

## 5. State and scheduling contracts to design and test

Evaluate a single authoritative scheduling/control layer. Extensions should submit typed observations and proposed interventions to it, rather than independently perpetuating the run. This is a design candidate to validate, not a requirement to rewrite everything as one module.

Specify states such as queued, running, waiting-for-tool, waiting-for-agent, waiting-for-approval, waiting-for-user, reviewing, recovering, succeeded, failed, blocked and cancelled. Define legal transitions, transition owner, entry/exit conditions, deadlines and whether model work is scheduled. A blocked branch is dormant pending a concrete external change; it is not periodically prompted to fix an impossible condition.

Required invariants:

- Every nonterminal wait has an owner, reason and resolution event/deadline. No unsatisfiable dependency silently drains tokens.
- Only an accepted state transition schedules automatic continuation. Replaying the same diagnostic for the same unchanged state does not schedule another turn.
- Scope closure/cancellation invalidates queued continuations and late results. New user intent creates or explicitly revises a task epoch; it must not silently revive old goals.
- Task claims and shared state transitions are transactional or single-writer serialized, with leases/fencing where needed. Restarted/expired workers cannot publish stale authoritative results.
- Resource limits are enforced by the harness across the entire delegation tree: concurrency, depth, total spawn count, model requests, tokens/cost where measurable, elapsed time, retries and recovery interventions. Re-spawning an agent or renaming a signature cannot replenish the mission budget.
- Reporting a blocker, acknowledging cancellation and publishing a final result remain possible through a narrow control protocol even for workers with no write tools. Those capabilities must not grant filesystem or policy-modification authority.
- Completion and verification are scoped to the assigned task, relevant checks and artifact revision. No global all-PASS condition for every conversation or read-only child.

Define bounded liveness properties under explicit assumptions: a runnable task makes observable domain progress, transitions to a declared wait, or returns a reasoned disposition within a budget. External approvals/services may never respond, so guarantee bounded spending and visibility, not forced completion. Differentiate deadlock (cyclic waits), livelock (activity with unchanged state) and starvation (ready work never scheduled).

## 6. Delegation and communication protocol

Compare existing vendored subagent, conductor, dual-review and optional external subagent paths against one required contract. Prefer consolidation/adapters where appropriate; avoid multiple hidden schedulers with incompatible budgets and identities.

Specify a worker handle and spawn envelope: mission/task/parent/agent IDs, role, task epoch, bounded objective, input artifact references, allowed tools/resources, working directory, deadline/budget, expected result format and completion criteria. Check that a child's permitted capabilities can actually satisfy that contract before dispatch. "Read-only planner required to write a verdict to finish" must be rejected as unsatisfiable before inference.

Support explicit operations conceptually equivalent to spawn, get-status, list-children, send-message, await-event/result, request-help, cancel and acknowledge-result. Names and transport remain architecture decisions. Persistent SDK sessions, RPC workers or a broker are candidates; private print-mode stdout alone is not a bidirectional session transport. Verify support against the pinned Pi runtime and its real event semantics.

Messages need IDs, sender/recipient identity, task/epoch correlation, type, reply-to, TTL and delivery/acknowledgement state. Use idempotent handling rather than assuming exactly-once delivery. Distinguish questions, answers, progress, artifacts, review findings, intervention proposals and operator commands. Peer messages are task data, not higher-priority authority. Authenticate routing and validate permission to address the recipient; do not let arbitrary content spoof an operator or parent.

Permit useful peer exchange within scope while preventing broadcast storms and reply ping-pong. Define bounded mailboxes, backpressure, response deadlines, deduplication and behavior when agents are busy/offline. Parent and child waits must not form cycles; ready workers must not occupy all execution slots while waiting for queued descendants. Trace the wait-for graph and reserve control capacity.

Return structured dispositions: completed, blocked, failed, cancelled or needs-review, with concise summary, evidence/artifact references, checks actually run, remaining uncertainty and resource usage. Do not confuse process exit 0, assistant text saying PASS or a syntactically valid report with successful work. Define how partial parallel results are preserved and how parent synthesis reconciles conflicts.

Use separate worktrees/directories for conflicting implementation tasks or enforce explicit file ownership. Shared read access can be efficient, but an isolated context window does not isolate filesystem writes, `.pi` state, credentials or authority. Scope state and logs by session/agent as well as workspace. Do not make each scout inherit the entire parent transcript or require raw-log dumps in every message.

## 7. Prompt and verification review

Inventory every prompt source: operator input, role/system prompts, project instructions, goals, context contributions, direct `sendUserMessage`/`sendMessage`, tool output, reviewer reports, recovery prompts and compaction summaries. Record origin, effective priority, triggering event, task/role scope, expiry, token budget, reset conditions and whether it creates a new turn. Test the assembled prompt seen by the model, not only the string an extension writes.

Pay particular attention to non-user follow-ups being interpreted as fresh user input and resetting correction counters; role restrictions contradicted by parent completion prompts; stale recovery contributions surviving compaction; independent extensions clearing each other's files; truncation removing important constraints or the escape route; and commands mentioned in prompts that are only available to a human UI operator. Do not instruct a headless worker to type `/verify` or `/fork` unless an actual authorized control path exists.

Replace generic "do not stop until all PASS" steering with a typed diagnosis tied to relevant unmet criteria and a reachable next step. A task may legitimately finish by accurately reporting a failure, producing a failing regression test, delivering a plan, or documenting an external blocker. Keep that disposition distinct from satisfying the entire mission. Treat an inapplicable check as explicitly not applicable, not as a fabricated PASS.

Review verdict ownership, evidence and freshness: expected check set, verification command, artifact/hash/generation, actual exit/output, trusted producer and reviewed scope. A planner/reviewer need not edit the board; an authorized coordinator can persist authenticated structured results. Prevent arbitrary workers from manufacturing their own authoritative acceptance. Time-based freshness alone is not proof that the current artifact was checked. Define invalidation after edits through shell, MCP/custom tools and other workers.

Prove that an unchanged failure triggers at most the permitted bounded response; failed remediation is different evidence only when an actual authorized attempt changed the relevant state. Separate infrastructure-unavailable, permission-blocked, verification-pending, expected test failure and actual task defect. Each needs an appropriate transition, not the same repeat prompt.

## 8. Loop detection, rescue and independent supervision

Detect behavior using evidence appropriate to task type: accepted facts/findings for research, completed subtasks, artifact revisions, new test evidence, resolved dependencies or useful decisions. Writes, tool success, token generation and heartbeats are not universal measures of progress. A no-op write or irrelevant successful tool must not reset the detector; a productive read-only review must not be forced to write just to escape it.

Track repeated denied calls, repeated diagnostic/state pairs, equivalent attempts with cosmetic argument changes, review/implementation oscillation, circular agent questions and continuing model spend without new domain evidence. Separate legitimate polling/retries from failure loops. Use explicit timers for states where no `turn_end` arrives.

Design a bounded response ladder: identify and expose the condition; stop duplicate automatic scheduling; preserve a checkpoint and causal trace; choose a different allowed tactic or request a missing prerequisite; invoke a bounded independent diagnostic reviewer if useful; validate a proposed redirection; resume only if a relevant precondition changed; otherwise park the branch and report the blocker. Unaffected independent work may continue within the mission budget.

The critical control is outside the stuck model: it must not depend on that model agreeing to stop or writing a file it cannot write. At the recovery cap, transition the scheduler to a visible wait/blocked/failed disposition and suppress pending auto-continuations. A message saying "give up gracefully" is not the transition.

Support optional supervisor/rescue agents reading bounded trace summaries and relevant artifacts through a restricted interface. Deterministic watchdogs enforce budgets and transitions; models can diagnose and propose changes. Give supervisors a separate small rescue reserve within the overall cap so worker saturation cannot prevent escalation, but do not spawn a rescuer for every repeated action or allow recursive rescuer trees.

Require interventions to carry reason, evidence, target task, expected state change, authorized scope, budget and expiry. The coordinator/control layer validates and applies them, records acknowledgement and measures whether progress resumed. Handle conflicting or stale advice deterministically. Supervisors cannot silently change the user's goal, disable policy/logging, escalate privileges, fabricate a verdict, or reclassify a denied action to force execution. Human escalation must be actionable, with saved progress and the specific missing decision/capability.

## 9. Deterministic simulations before live inference

Build a composition-capable test runtime alongside the existing isolated tests. Register **all handlers per event**, reproduce actual dispatch/short-circuit ordering and exception behavior from the pinned Pi implementation, and execute queued follow-ups through subsequent input/turn/agent-end cycles. Model streaming, cancellation and compaction events explicitly. A list of queued strings is not an event-loop simulation.

Use a fake monotonic clock, deterministic IDs, seeded scheduling, scripted model responses, fake tools and controlled subprocess fixtures. Default to no network/model access; fail tests if a real inference/spawn slips through. Provide a reproducible seed and minimal event trace for failures. Keep a pure state-model oracle separate from the production code so assertions are not tautologies. Differentially check simulated event semantics against the real runtime with a local scripted provider/process where feasible, without paid inference.

Required scenarios and assertions:

| Scenario | Required behavior |
| --- | --- |
| Read-only planner, no verifier board | Plan/result can return; no demand to write a board or endless completion correction. |
| Repeated old DoD prompt against a restricted child | Reproduce the amplification, then show bounded scheduling and a reachable result/blocker path. |
| Missing, corrupt, stale or unrelated board | Accurate scoped diagnostic; never false PASS, never infinite retry. |
| No verify script or intentionally failing-test task | Correct applicability/disposition; no coerced all-PASS mutation. |
| Orchestrator + verify-gate + autonomous-loop + progress/recovery | Test legal handler orders and queued follow-ups; globally bounded continuation. |
| Extension/reviewer follow-up arrives as input | Does not masquerade as new operator intent or replenish budgets. |
| Guard escalates but recovery lacks tools | Capability failure detected; no repeated instructions to use unavailable tools. |
| Conductor active while recovery requests generic subagent | Correct dispatch route or declared incompatibility, not retry ping-pong. |
| Approval required in a headless child | One durable visible request/blocker; no repeated denied-call inference loop. |
| Productive long research with many reads | No false forced-write recovery; domain progress recognized. |
| No-op writes or alternating cosmetic commands | No false progress reset hiding livelock. |
| Worker reports "I am stuck" | Control protocol reaches coordinator even without filesystem write permission. |
| Two sessions/children share cwd and start concurrently | No cross-session goal, prompt, marker, task or verdict contamination. |
| Two workers claim/update the same task | One authoritative owner; no lost update, duplicate completion or stale lease write. |
| Parent waits for child that asks parent a question | Question can be serviced without deadlock or consuming unlimited model turns. |
| All slots occupied by parents awaiting queued descendants | Scheduler detects/prevents starvation; control/rescue still operates. |
| Duplicate/delayed/out-of-order messages | Idempotent processing, stale-epoch rejection and no reply storm. |
| Repeated contradictory reviewer findings | Evidence reconciliation and bounded rework; disagreement becomes explicit blocker if unresolved. |
| Budget exhaustion followed by respawn/restart | Remaining budget persists; no reset-by-new-process escape. |
| Cancellation during streaming/tool/shell execution | Scope stops scheduling, descendants accounted for, late messages fenced, side effects accurately reported. |
| Child crashes, hangs or emits malformed/partial JSON | Bounded detection and recovery; useful partial results retained. |
| Pending verification process dies | Deadline/ownership resolves the marker; no permanent anonymous pending state. |
| New user goal, clarification or cancellation during recovery | Correct epoch/intent handling; stale diagnostic cannot revive old work. |
| Compaction/reconnect/restart during delegation | Ownership, budgets, pending work and decisions survive without stale prompt amplification. |
| Slow/missing logs, disk full or lost events | Visible degraded state and risk-based policy; no silent claim of trustworthy monitoring. |
| Terminal/blocked state with queued auto-follow-ups | No new model call until an authorized relevant transition occurs. |
| Final response without tool calls while still spending | Watchdog handles the lack of tool/turn evidence and enforces bounds. |

Use property-based event generation and fault injection to explore interleavings. Find and minimize cycles in the state/transition graph where spend increases while task state and evidence do not. Include persistent state and reset paths; per-signature counters alone cannot rule out global loops. Mutation-test important guards so the suite demonstrably fails when deduplication, caps, capability validation or task scoping are removed.

Existing starting points include `tests/verification-lifecycle-smoke.mjs`, `progress-guard-agsix-smoke.mjs`, `recovery-grounding-smoke.mjs`, `subagent-progress-smoke.mjs`, `task-graph-invariants-smoke.mjs`, `conductor-recursion-smoke.mjs`, `conductor-validator-smoke.mjs`, `compaction-continuity-smoke.mjs`, and `kit/eval/harness.mjs`. Reuse useful cases, but do not treat current passing unit smoke tests as a composed-system liveness guarantee.

## 10. Observability, UX and acceptance

Use the companion ECS contract for causal event correlation. Every spawn, state transition, message, tool/approval, verification, prompt injection, budget change, loop signal and intervention must be attributable to a task/agent/epoch. Capture prompt provenance and effective directive summaries without requiring hidden model reasoning. Keep secret-redacted command/argument visibility; hashes alone are insufficient for diagnosis.

The UI should expose the agent tree, active plan, worker scope, current tool/shell, wait reason/owner, pending approvals/messages, remaining budgets, last meaningful progress and intervention history. Let the operator inspect a child and return without sending a prompt or interrupting work. Display whether a rescue proposal is pending, applied, rejected or ineffective. Keep status/footer behavior reliable when several extensions update it.

Show provenance and coverage limits: model/proxy exchange, harness-authorized tool, observed local execution and persisted result are different evidence. LiteLLM bodies can corroborate model behavior but cannot substitute for agent identity or OS execution telemetry. File modification time alone is not proof of this session's progress.

Set numerical acceptance thresholds after baseline measurement: upper bounds on redundant model turns and recovery calls; detection-to-state-change latency; message delivery/approval visibility; log completeness; crash/cancel cleanup; resource overhead; benign task completion and false loop alerts. Include successful normal workflows, research-only tasks, mixed agent collaboration and deliberately unsatisfiable cases. Improvements must reduce runaway spending and operator confusion without making routine work approval-heavy or preventing authorized delegation.

The next session should finish with a consolidated review and concrete plan, not merely revised prompts or another monitoring banner. Implementation should proceed in stages: contain unbounded continuation, establish task/control identities and budgets, unify delegation and messaging, make verification/reporting reachable, implement independent recovery, then integrate the complete UI/telemetry and run final adversarial validation. Adjust this ordering when evidence justifies it.

## Suggested opening instruction for the next Codex session

> Read DELEGATION_LIVENESS_REVIEW_BRIEF.md and MONITORING_SECURITY_UX_REVIEW_BRIEF.md. First expand them into an explicit review specification grounded in the current checkout and identify the installed/runtime baseline separately. Then conduct the baseline code review and delegate independent specialist reviews across execution state, prompts, delegation/messaging, verification, recovery, security, UX and simulation fidelity. Reconcile the findings and reproduce material control-flow failures with deterministic no-inference simulations. Produce the architecture decisions, prioritized implementation plan, acceptance matrix and evidence artifacts before beginning broad implementation. Preserve the active Pi session and the human review/merge boundary. Optimize for secure useful progress, bounded failure and operator visibility; do not solve loops by fabricating PASS, weakening firewalls, or adding more unbounded steering prompts.
