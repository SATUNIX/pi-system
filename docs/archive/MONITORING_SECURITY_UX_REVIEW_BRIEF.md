# Pi kit review brief: monitoring, security, agent control and usability

## Status in this repository

Ported into `pi-system` on 2026-09-16. This brief is an explicit release gate, not a
completed review. This section records only what is evidenced in this repository; it does
not claim the full gate is discharged.

Evidence currently found here:

- `tests/subagent-observability-smoke.mjs` exists and is wired into CI —
  `.github/workflows/ci.yml` runs `npm run smoke:subagent-observability`. It pins the
  subagent run-log, run-registry, `subagent_status` and `subagent_stop` contract.
  Verified locally:
  `env -u PI_KIT_SUBAGENT_STATE_DIR node tests/subagent-observability-smoke.mjs` → passes.
- `tests/liveness-containment-smoke.mjs` exists (`npm run smoke:liveness-containment`).
  Verified locally: `node tests/liveness-containment-smoke.mjs` → passes. It pins finite
  loop limits under malformed configuration, per-instance ownership, same-session
  recovery disarm, durable blocker state, and suggest-only research mode.

Still open:

- `npm run smoke:liveness-containment` is **not** wired into `.github/workflows/ci.yml` —
  only the observability smoke is. CI coverage of the liveness/containment contract is
  therefore incomplete.
- The brief's final independent adversarial agentic red-team phase (see "Final agentic
  red-team phase and acceptance evidence" below) has no corresponding evidence in this
  repository. The two smoke suites do not, on their own, discharge that release gate.

---

Requested by the operator on 10 September 2026. Status: handoff for a future review and implementation session; this document is not a completed security review or an implementation plan approved for execution.

Target repository: `C:\Users\Anthony Grace\Cyber\Development\Gitlab\repos\misc-agents-pi-kit`.

## Objective and required order

Make the kit demonstrably safer and easier to operate, with trustworthy monitoring, attributable agent activity, understandable controls, and reliable progress. Security should support productive authorized work, not cause opaque blocks, prompt fatigue, retry loops, or unnecessary steering.

Follow this sequence:

1. **Code review first.** Pin the checkout, dependency versions, installed artifact and runtime configuration. Trace the actual load/execute paths and document the trust boundaries before proposing fixes. Read existing `reviews/` and improvement evidence as historical findings to revalidate, not proof of the current state. Distinguish source, generated lite packages, active profile, loaded extensions and the running process. Include installer/export drift, extension hook ordering, Windows and Linux behavior, and CLI/TUI/headless/web differences.
2. **Independent specialist subagent reviews.** After the baseline code review, assign multiple subagents separate bounded review areas listed below. Give them the same baseline and evidence requirements. Obtain independent findings before reconciling them; avoid one reviewer merely repeating another's conclusions. The coordinator validates material findings and resolves disagreements.
3. **Create the implementation plan from those findings.** Produce a prioritized backlog with reproduction evidence, threat/UX impact, affected components, proposed design, dependencies, acceptance criteria, tests, migration and rollback. Distinguish observed defects, plausible risks and optional enhancements. Record unresolved decisions and explicit deferrals. Do not mistake this brief for that evidence-based plan.
4. **Implement and verify the uplifts.** Use bounded changes with component, integration and representative user-workflow validation. Preserve the human review/merge boundary. Verify the exported and actually loaded kit, not just source files or manifest presence.
5. **Final adversarial validation phase.** After the review and implementation work, run independent agentic red teams in disposable, authorized labs against the custom harness. Deliberately test whether agents can bypass controls, tamper with logging or escape monitoring. Triage findings, patch weaknesses, add regression cases, and repeat independent validation. This is a release gate, not a substitute for the initial review. Ordinary security regression tests also belong throughout implementation.

This handoff does not request installing/reloading the kit or experimenting against the existing live Pi session. Keep that session and its progress intact. No full review, subagent review cycle or adversarial exercise was performed while writing this note.

## Comparison and evidence available at handoff

- The GitLab checkout was clean at inspection, at `d6aa736789102599b163edffeb2caebcb2e28870`, an import commit dated 10 September 2026. Its reset/import history does not establish how many releases ahead it is.
- Local Pi settings still reference `OffSec\AI Area\misc-agents-pi-kit\dist\pi-kit-lite`, not this GitLab checkout. The installed CLI reports package version 0.76.0. Both kit package manifests say 1.0.0, so those labels cannot establish feature parity or provenance.
- The GitLab source has a broader extension set than the installed lite artifact, including task-graph, recovery-orchestrator and verifier-board. This is partly a full-versus-lite comparison; more directories do not establish greater reliability or security.
- GitLab `extensions/verify-gate/index.ts` differs: it includes bounded execution, dirty/final-turn conditions and bounded correction behavior. These are source observations, not proof that the operator's unnecessary-steering problem is fixed.
- SHA-256 comparisons found the following GitLab files byte-identical to their installed lite counterparts: `vendor/subagent/index.ts`, `extensions/trace-ledger/index.ts`, `extensions/tool-firewall/index.ts`, and `vendor/custom-footer/index.ts`. Moving to this checkout alone therefore does not supply changes in those implementations.
- Four observed child Pi processes used `--mode json --no-session`. The configured launcher consumes private stdout/stderr pipes in the parent. Separate child session transcripts are not persisted by that mode. File contents on disk cannot prove which bytes an earlier process loaded if files changed afterward.
- Workspace `.pi/trace.jsonl` and `.pi/tool-firewall-audit.jsonl` were updating while the older parent session JSONL was stale. We did not inspect task prompts, commands or transcript content to judge progress, establish a loop, or confirm complete coverage of every child.
- The installed trace logger stores a tool target, truncated to 200 characters; the firewall audit stores action hashes and decisions without the original command. Shared logs lack reliable per-agent/call correlation. The headless firewall `ask` path returns a blocked result instead of showing an interactive approval prompt.
- A passive external monitor is available at `C:\Users\Anthony Grace\Cyber\Development\OffSec\tools\pi-watch\pi_watch.py`, with a README and five synthetic reader tests. It observes OS counters and persisted logs, not private token streams. It is a temporary inspection aid, not the desired integrated monitoring/control system.

## Operator-reported pain points to reproduce

- No working/useful status bar for the current workflow.
- Cannot navigate between parent and child agents or inspect their ongoing work and tool calls in the UI.
- Cannot see planned TODO steps, active background shells, child tasks and the systems/resources being used in one coherent view.
- Missing tool-call approval prompts when work is delegated; unclear whether children are working, waiting for approval, blocked, retrying or looping.
- Parent session JSONL does not expose current child activity; action hashes do not answer which command ran.
- Approximately seven million tokens reported consumed during the long session, without enough visibility to judge progress. Reconcile provider usage, cached input and any repeated accounting before drawing conclusions about spend or waste.
- Automatic steering such as a "definition of done not met" prompt appears when it is not relevant or needed.

Treat these as reproduction targets, not already proven root causes.

## Specialist review assignments

Each reviewer must provide file/line evidence, a minimal reproduction or explicit uncertainty, expected versus actual behavior, impact, mitigation options and proposed acceptance tests.

| Area | Required focus |
| --- | --- |
| Firewall and authorization | Tool/action allowlists, risk classification, approval scope, action hashes, command interpretation, policy precedence, headless behavior, enforcement before execution, and coverage of extension/MCP/background execution paths. |
| Agent safety and isolation | Parent/child authority inheritance, delegation and recursion, prompt injection through untrusted inputs, credentials and filesystem/network boundaries, cancellation, recovery, budgets and policy mutation. |
| Monitoring and detection | Event coverage, per-agent attribution, streaming and durable logs, ECS mapping, tamper resistance, loss/backpressure visibility, token/cost accounting and behavior detections. |
| UX and accessibility | Status/footer composition, parent/child navigation, live tool inspection, approval queues, plans/TODOs, shells, keyboard use, discoverability and readable explanations. |
| Lifecycle and reliability | Long tasks, process ownership, suspend/resume/cancel, crash recovery, compaction, resource leaks, blocked-call loops, completion criteria and unsolicited steering. |
| Integration and validation | Export/install/runtime parity, cross-platform/profile behavior, test realism, supply-chain/extension loading and whether security and UX claims survive actual Pi runs. |

Keep final adversarial reviewers independent of the implementers where practical. Bound reviewer/model/tool budgets and make the review subagents themselves visible to the operator.

## Monitoring and Elastic Common Schema uplift

Design one event contract spanning parent sessions, child runs, tools, approvals, background shells, model requests, recovery and completion. Provide live subscriptions with reconnect/replay plus durable records independent of whether the parent tool call has completed. Give each agent a browsable timeline; do not depend on consuming another process's private pipe or waiting for a final child result.

Adopt a pinned, tested ECS version and record `ecs.version`. Use appropriate standard fields such as `@timestamp`, `event.id`, `event.action`, `event.outcome`, `event.reason`, `event.duration`, process identity, and trace correlation. `trace.id`, `transaction.id` and `span.id` are ECS tracing fields. Verify field types, allowed categorization values and duration units against the pinned schema. Sources: [ECS reference](https://www.elastic.co/docs/reference/ecs), [tracing fields](https://www.elastic.co/docs/reference/ecs/ecs-tracing), and [ECS getting started](https://github.com/elastic/ecs/blob/main/docs/reference/ecs-getting-started.md).

Define a documented custom namespace for Pi-specific session/agent/parent IDs, task IDs, tool-call IDs, approval IDs, policy versions, action digests, model usage, steering reasons and detection evidence. Avoid changing ECS field semantics to fit agent concepts. IDs must survive navigation/reconnect and relate tool intent, policy evaluation, approval, actual execution and result. Distinguish an authorization decision from execution success.

Required behavior:

- Show the command/arguments and working directory, with explicit secret redaction and truncation markers. A digest is a correlation/integrity aid, not a substitute for human-readable action details. Provide an access-controlled detail/artifact path for full non-secret records where needed.
- Persist attempted, allowed, approval-pending, blocked, started, updated, completed, failed and cancelled activity with clear ownership. Do not require exposing private model reasoning to explain work; observable actions, outputs and concise status are sufficient.
- Keep concurrent writers from corrupting or silently rewriting evidence. Specify sequence/gap detection, rotation, retention, disk-full behavior, backpressure and crash recovery. Record collector health and loss counters visibly.
- Separate local durable collection from asynchronous Elastic delivery. Define behavior during collector/export outages by action risk; avoid both silent audit loss and blocking all ordinary work because Elastic is temporarily unavailable.
- Protect logging and policy administration from ordinary agent tool authority. Review trust boundaries for independent collection and tamper evidence; application-written hashes alone do not establish integrity against an equally privileged process.
- Validate JSON/schema and ingestion mappings with representative events. Include dashboards for agent trees, pending approvals, errors/retries, repeated actions, tool latency, log gaps and resource/token consumption. Report measured versus estimated usage without double-counting parent/child or cached tokens.

## Tool firewall, risk classes and action authorization

Move to explicit allowlisting of approved capabilities and bounded actions, rather than relying on a deny-pattern list around an otherwise permissive shell. Unknown or ambiguous actions must not silently execute. Pair this with safe useful defaults, understandable approval flows and tests showing normal authorized work remains usable.

Review classification by effects and scope: read/write, target paths, executable/interpreter, network destination, credentials, privilege, destructive impact and reversibility. A tool named "read" is not automatically safe for every path; a blanket "bash allowed" rule is not an adequate security boundary. Inspect composed commands, scripts, wrappers, indirect calls and all supported operating systems. Define what the harness can enforce and what requires OS/container isolation.

Approvals must show the actual action, risk explanation, actor and scope. Specify canonicalization and digest versioning; bind approvals to the relevant tool, arguments, target, policy and execution context. Review time-of-check/time-of-use changes, replay, delegated reuse and expiry. A matching action hash alone must not grant authority. Safely scoped reusable grants can reduce repeated prompts, with visible revocation and policy-change invalidation.

Route child approvals to an operator-visible parent/control queue with clear requesting-agent identity. Headless work should enter a visible pending/blocked state with a resolution path, not repeatedly retry the same denied action or silently widen its permissions. Parent, child, extension, MCP and background tool paths need consistent enforcement coverage.

## UX, agent control and steering

- Provide a reliable status bar showing active task, real execution state, agent/shell counts, pending approvals, last meaningful event, logging health and budget/usage. Distinguish model wait, tool execution, user wait, retry and idle; do not present activity as proof of progress.
- Let the operator navigate parent/child trees, view per-agent task/model/status, follow live tools and outputs, inspect history and return without disrupting work. Include background shell IDs, ownership, working directory, start time and output access.
- Show the current plan/TODO steps and link progress claims to completed actions or artifacts. Make stale plans and blocked dependencies visible.
- Design explicit pause/steer/resume/cancel controls with clear scope and preserved progress. Explain whether "pause" stops new scheduling, waits for an in-flight action, or suspends anything; never imply an already-running external action has stopped when it has not.
- Review footer/status extension conflicts and actual TUI rendering. Validate small terminals, keyboard navigation, accessibility, reconnects and long-running sessions.
- Make automatic steering attributable and bounded. Record the originating extension, rule, evidence and task it applies to. Only apply definition-of-done enforcement to an explicit active goal with relevant unmet criteria; distinguish ordinary discussion, read-only investigation and completed tasks. Prevent stale-goal, intermediate-turn and duplicate-extension correction loops. Show why steering occurred and how to resolve or dismiss an inapplicable condition through authorized controls.

## Final agentic red-team phase and acceptance evidence

Use disposable Windows/Linux labs with synthetic repositories, fake secrets, controlled services and strict runtime/token budgets. Agents may attack only the designated harness and lab fixtures; do not target the user's active session, real credentials or unrelated systems. Write engagement boundaries and keep independent observer evidence outside the tested agent's authority.

Test adversarial task pressure and malicious repository/tool-output instructions intended to induce policy bypass, disguised/reformulated actions after denials, authority laundering through delegation, approval replay/mutation, alternate execution routes, secret access, logging suppression/corruption, policy tampering, control-channel abuse and resource exhaustion. Test both prevention and detection; a failed bypass attempt should remain attributable and visible. Do not assume every retry or command reformulation is malicious.

For every case, record the objective, baseline, expected boundary, actual tool/process effects, collector evidence, detection/response, reproducibility and regression test. Use harmless canaries or synthetic side effects to establish whether execution occurred. Keep hidden/held-out cases for independent evaluation. Patch failures and retest.

The plan must set measurable acceptance thresholds from baseline measurements: event completeness/correlation, display and approval latency, log-loss detection, detection false positives, unsafe executions prevented, ordinary task completion, unnecessary approvals/steers, recovery success and resource overhead. Compare the old and uplifted kit on equivalent benign and adversarial workflows. Passing smoke tests, producing ECS-shaped JSON, or blocking every tool is not sufficient evidence of a secure and usable agent.

Deliver a consolidated review, evidence-based implementation plan, verified implementation, operator guide and final adversarial report with remaining limitations. The operator remains the senior reviewer and merge authority.
