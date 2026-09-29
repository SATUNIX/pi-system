# Subagent Delegation, Agent Definitions, and Standardization — Review

Date: 2026-09-16. Research and review only — no production code was changed as part of
this document. Scope: (1) why subagents "typically fail or error out," (2) quality of the
current agent role definitions, (3) proposed new specialist roles for coding tasks, (4) the
current parallelism model, (5) agent-to-agent communication, and (6) whether to standardize
on an external protocol (the operator specifically asked about A2A/Agent2Agent).

This builds on, and does not repeat, `reviews/2026-09-agent-system/` — a much larger
security/containment-focused review baselined at commit `6460ef6` (2026-09-14). That review's
findings are cited by ID (`DS-*`, `L-*`, `OI-*`) throughout and each is marked **fixed since
baseline**, **still open**, or **not reverified this pass** against current source, per that
review's own instruction not to treat prior audit docs as ground truth without re-checking.
Two subagent-specific fixes already landed after that baseline: `93fed1d` (honest
stream-cap/timeout reporting) and `49e92d8` (killed subagents keep partial output). This
session also fixed two adjacent delegation/config bugs today, referenced where relevant: the
`pi-subagents`/`packages/extensions/third_party/subagent` tool-name collision, and `provider-router`'s default model
override.

## Executive summary

Ranked by how directly each explains "subagents fail or error out":

1. **The `subagent` tool silently spawns with zero agents available unless the caller
   explicitly passes `agentScope: "both"` or `"project"`.** The default (`"user"`) reads
   `~/.pi/agent/agents`, which does not exist on this machine — a manual or non-orchestrator
   `subagent` call returns `Unknown agent: "X". Available: none.` (`packages/extensions/third_party/subagent/index.ts:419`).
   Orchestrator's own injected directives always pass `agentScope: "both"`, but the kit's own
   comment admits small models often skip the directive (`packages/extensions/src/orchestrator/index.ts:94-96`).
2. **Project-scoped agents — where planner/implementer/reviewer/scout actually live — are
   hard-blocked in headless mode with no documented unblock path.** They need either an
   interactive confirm or an exact match in `PI_KIT_TRUSTED_PROJECT_ROLES`
   (`packages/extensions/third_party/subagent/index.ts:445-452`), an env var that appears nowhere else in the repo — no
   `.env.example` entry, no README. Any headless run (which is what child processes are, and
   what `autonomous`/`self-improving` profiles are for) gets
   `"Blocked: project-local agents require interactive operator approval."` with no way to
   self-serve past it.
3. **Two independently-implemented subagent launchers exist and only one got hardened.**
   `packages/extensions/third_party/subagent/index.ts`'s `runSingleAgent` has stream caps, an idle timeout, and honest
   kill-reason reporting (from `93fed1d`/`49e92d8`). `packages/extensions/src/conductor/index.ts`'s
   `runSpecialistProcess` (lines 236-258) is a second, separate spawn/parse/kill
   implementation with **no stream cap and no idle timeout at all** — none of the reliability
   work applied there. The two are mutually exclusive at runtime (conductor blocks the
   `subagent` tool outright while an engagement is active, lines 335-339), so which failure
   modes you hit depends on whether an engagement happens to be open.
4. **A genuinely well-built fix for "I need more specialist agents" already exists in the repo
   and is dead code.** `packages/extensions/src/conductor/synth/agent-synth.ts` deterministically synthesizes
   least-privilege specialist role files from the skills catalogue, has safety invariants
   (rejects bad tool names, bad agent names, newline injection), and is covered by a passing
   test (`tests/conductor-agent-synth-smoke.mjs`). But nothing in `conductor/index.ts` imports
   it — `dispatch_specialist` can only read agent files that already exist on disk
   (`conductor/index.ts:223-229`), it cannot create one. `packages/kit/skills/dynamic-agent-synthesis/SKILL.md`
   instructs models to use a synthesis workflow that no tool call in the current build can
   reach. This is the highest-leverage fix available for "more specialist agents" — wiring up
   what's already built beats hand-writing more static `.md` files.
5. **Malformed child stdout is silently dropped, and there is no retry logic anywhere in the
   subagent path.** `packages/extensions/third_party/subagent/index.ts:304-311` parses child stdout line-by-line as
   JSON and discards anything that doesn't parse, with no error surfaced. A failed or killed
   child is reported exactly once; any retry is left entirely to the parent model's judgment
   in the moment, not to the extension.
6. **A2A (Agent2Agent) is the wrong transport for this kit, but three of its concepts are
   worth adopting locally.** A2A is designed for independent agents run by different parties
   over a network with no shared process tree or filesystem — none of that describes a parent
   `pi` process spawning child `pi` processes it fully owns. Its Agent Card, task lifecycle
   state machine, and typed Message/Artifact envelope are good ideas that translate cleanly
   into a local schema without adopting HTTP/JSON-RPC. See [§7](#7-standardization-a2a-protocol-and-alternatives).
7. **There is no shared schema across the file-based blackboard the agents actually
   communicate through.** Every extension hand-rolls its own JSON shape for its own state
   file, and `verifierBoardBlocked` is duplicated byte-for-byte between `orchestrator.ts` and
   `conductor.ts` because "self-containment forbids importing another extension"
   (`packages/extensions/src/conductor/index.ts:145-146`) — a real architectural constraint, but one that
   guarantees drift between the two copies over time.

## 1. Two delegation mechanisms, not one

| | `subagent` tool (`packages/extensions/third_party/subagent/index.ts`) | `dispatch_specialist` tool (`packages/extensions/src/conductor/index.ts`) |
|---|---|---|
| Launcher | `runSingleAgent` / `spawn` | `runSpecialistProcess` (separate implementation) |
| Modes | single, parallel (concurrency-limited), chain | single dispatch per call |
| Concurrency | `MAX_PARALLEL_TASKS=8`, `DEFAULT_CONCURRENCY=4` (env: `PI_KIT_SUBAGENT_CONCURRENCY`) | `maxDepth` / `maxDispatches` from `.pi/engagement/engagement.json`, lock-guarded |
| Stream cap | 64 MiB stdout + 64 MiB stderr, independently counted (raised from 2 MiB → 16 MiB → 64 MiB across `93fed1d`/`49e92d8`) | **none found** |
| Idle timeout | `PI_KIT_SUBAGENT_IDLE_TIMEOUT_MS`, default disabled, resets per byte | **none found** |
| Kill honesty | reports `"stream-cap"` / `"timeout"` / `"signal"` distinctly since `93fed1d`; keeps partial output since `49e92d8` | not reviewed for kill-reason granularity — worth checking before relying on it |
| Tool restriction | passed straight through as `--tools`, enforced by pi's own CLI filtering | additionally pre-validated against `SPECIALIST_ALLOWED_TOOLS = {read, grep, find, ls, write, edit}` (line 65) — **no bash**, stricter than `subagent` |
| Role source | `~/.pi/agent/agents` and/or `.pi/agents/*.md`, gated by `agentScope` | reads an existing `.pi/agents/<name>.md` only — cannot synthesize one |
| Available when | always | only while `.pi/engagement/engagement.json` shows an active engagement; blocks `subagent` outright while active |

Per `docs/proposals/root-orchestrator-conductor.md` (line ~224-225), conductor is explicitly
"layer 4... one level of abstraction above the current orchestrator" — orchestrator is
composed-under, not replaced. That framing is sound. What's not sound is that the two systems
independently reimplemented the same primitive (spawn a child pi process, parse its
output, report a result) with materially different reliability properties, rather than one
sharing the other's hardened launcher.

**orchestrator** itself (`packages/extensions/src/orchestrator/index.ts`) never calls `subagent`
programmatically — on `input` it scores task complexity (`scoreComplexity`, lines 44-56) and
writes a steering directive to `.pi/ctx-contributions/orchestrator.json` telling the *model*
to call the tool itself. It also non-destructively materializes the four static roles into
`.pi/agents/` (lines 23-42) and fails closed on a missing/corrupt/empty verdicts board before
allowing "mission complete" (`missionCompleteBlocked`, lines 237-261).

## 2. Why subagents fail or error out — concrete, source-anchored

Ranked roughly by how often an operator would actually hit each one:

1. **Empty roster by default.** Confirmed directly: `~/.pi/agent/agents` does not exist on
   this machine, and `agentScope` defaults to `"user"` (`packages/extensions/third_party/subagent/index.ts:419,
   ?? "user"`). Any `subagent` call that doesn't explicitly request `"both"` or `"project"`
   gets `Unknown agent: "X". Available: none.` — a confusing error that looks like a typo'd
   agent name, not a scope default problem.
2. **Headless project-agent block with an undiscoverable escape hatch.** Confirmed:
   `PI_KIT_TRUSTED_PROJECT_ROLES` is read at `packages/extensions/third_party/subagent/index.ts:82-84,445` and is the
   *only* non-interactive path past the project-role approval gate
   (`ctx.hasUI` false → block, lines 447-452), and it is genuinely undocumented — not in
   `.env.example`, not in any README under `packages/extensions/third_party/subagent/`. Since orchestrator's directives
   always request `agentScope: "both"` (which includes project agents), and headless/CI/
   autonomous-profile usage is exactly the scenario with no `ctx.hasUI`, this is a load-bearing
   gap for the autonomous use case the kit is explicitly built for.
3. **Conductor's launcher has none of the hardening the primary launcher got.** No stream
   cap, no idle timeout found in `packages/extensions/src/conductor/index.ts` (grepped for
   `STREAM_CAP`/`idle`/`IDLE`, zero matches). A specialist dispatched through
   `dispatch_specialist` can hang indefinitely or accumulate unbounded output with none of the
   `93fed1d`/`49e92d8` protections — those fixes were applied to one of the two launchers, not
   both.
4. **Silent data loss on malformed child output.** `packages/extensions/third_party/subagent/index.ts:304-311` parses
   child stdout line-by-line as JSON, `catch { return; }` on failure — any line a child writes
   that isn't valid JSON (a stray console.log, a crash trace before the JSON stream starts,
   etc.) simply vanishes with no warning surfaced to the parent or the operator.
5. **No retry logic anywhere in the delegation path.** A killed, failed, or malformed-output
   child is reported once. Whether to retry is left entirely to the parent model's in-context
   judgment (typically steered by directive text like "loop back to an implementer with the
   must-fix list") — there is no extension-level retry/backoff for transient failures (a model
   provider hiccup, a stream-cap kill on an otherwise-fine task with a chatty tool).
6. **The concurrency pool doesn't check the abort signal between queue items.** The
   work-stealing pool (`mapWithConcurrencyLimit`, lines 173-191) dequeues and launches the next
   task in its `while(true)` loop without checking `signal.aborted` first — an abort mid-batch
   still launches whatever's left in the queue. This matches `DS-04`'s concern about
   "repeated parent calls... fresh local concurrency allowance" and is still true in current
   source.
7. **Already fixed this session, worth noting as resolved delegation-adjacent bugs:** the
   `pi-subagents`/`packages/extensions/third_party/subagent` tool-name collision (both hardcode a tool literally named
   `subagent`; fixed by removing `pi-subagents` from the two profiles that co-selected it), and
   `provider-router` silently overriding the operator's configured model with a hardcoded
   default whenever no explicit routing policy was set (fixed by making unconfigured routing a
   true no-op). Neither is a subagent-launcher bug, but both produced symptoms that look like
   "the delegation system is misbehaving" from the operator's seat, and are now closed.

### Reconciliation with `reviews/2026-09-agent-system`

| Finding | Baseline claim | Status per this pass |
|---|---|---|
| Stream-cap/kill honesty (part of DS-02/DS-06 evidence) | Killed children reported as generic "aborted"; output discarded | **Fixed** — `93fed1d`, `49e92d8` |
| DS-02 (process-tree cancellation) | No reliable process-tree completion contract | **Still open** — SIGTERM→SIGKILL escalation exists (`packages/extensions/third_party/subagent/index.ts:288-294`) but no process-group/job-object ownership; a child that spawns descendants can orphan them. Not re-executed this pass (static read only). |
| DS-04 (independent budgets can't enforce a mission limit) | Repeated parent calls get fresh local concurrency allowance | **Still open** — confirmed via the abort-not-checked-between-items gap above, and conductor/`subagent` have two separate, uncoordinated budget systems (§4) |
| DS-05 (duplicate/delayed/out-of-order messages) | No idempotency/TTL/epoch handling | **Not reverified this pass** — dual-review extension not read; treat as still open per the review's own text |
| DS-06 (unbounded child stream collection) | Unbounded stdout/stderr | **Partially fixed** for `packages/extensions/third_party/subagent` (now capped, independently counted); **still open** for conductor's `runSpecialistProcess` (no cap found) |
| DS-11 (missing approval/navigation protocol) | Headless approval has no durable queue | **Still open**, and this pass adds a concrete instance: the undocumented `PI_KIT_TRUSTED_PROJECT_ROLES` escape hatch is the only non-interactive path and it's undiscoverable |
| L02 (shared-cwd startup deletes another session's contributions) | Parent contribution deleted | **Not reverified this pass** |
| L05/L09 (verdict provenance, recovery doesn't stop scheduling) | No task/revision/check provenance on verdicts; recovery is advice-only | **Not reverified this pass** — but §1's table shows conductor's `verifierBoardBlocked` is a second, hand-synced copy of the same gate logic, which is an amplifier for any drift-based instance of L05 |
| Stage C of `06-implementation-plan.md` ("common spawn/status/message/cancel/result adapters") | Proposed, not yet built | **Confirmed still not built** — the audit above is direct evidence for *why* it's needed: two launchers, two budget systems, two copies of the verdict gate |

## 3. Agent-to-agent communication: current state

No message bus, no pub/sub, no typed envelope. Every channel is a JSON or Markdown file under
`.pi/`, each with its own ad hoc shape:

| Path | Writer(s) | Reader(s) | Format |
|---|---|---|---|
| `.pi/agents/*.md` | orchestrator (materialize), conductor (`materializeValidatorAgent`, atomic write) | `packages/extensions/third_party/subagent` (`discoverAgents`), conductor (`agentDefinition`) | Markdown + YAML frontmatter, no schema |
| `.pi/task-classification.json` | orchestrator | `provider-router` | `{score, taskType, at}`, ad hoc |
| `.pi/ctx-contributions/*.json` | orchestrator, conductor, goal-core, recovery-orchestrator | context-sieve | `{id, priority, budgetTokens, content}` — the closest thing to a shared convention already in the codebase |
| `.pi/task-graph.json` | planner (via `task_create`/`task_next`/`task_complete`) | implementers, verifier-board | ad hoc JSON DAG |
| `.pi/verdicts.json` | verify-gate, reviewer subagents, conductor validator | orchestrator, conductor (duplicated gate logic) | `{verdicts: {source: {pass, at, summary}}}` |
| `.pi/GOAL.yaml` | goal-core | verifier-board, context-sieve | YAML |
| `.pi/engagement/engagement.json` | conductor only, lock-guarded | conductor only | versioned (`version: 2`) — the most schematized file found |
| `.pi/engagement/recursion.lock` | conductor | conductor | lock file, stale after 60s |
| `.pi/trace.jsonl` | conductor, trace-ledger | recovery-orchestrator | JSONL, append-only |
| `.pi/verify-pending.json` | verify-gate | orchestrator, conductor | existence-as-signal |
| `.pi/human-console/pending`, `/resolved` | human-console | — | not inspected this pass |

Three extensions worth naming individually:

- **task-graph**: persistent DAG at `.pi/task-graph.json`, planner emits tasks with
  dependencies, implementers claim/complete them. Polling-based blackboard, no push.
- **goal-core**: owns the one-line mission goal across compaction (`.pi/GOAL.yaml` +
  a ctx-contribution). Read by verifier-board and context-sieve.
- **recovery-orchestrator**: escalation-only — reads `.pi/recovery/escalation.json` (written
  by progress-guard) and `.pi/trace.jsonl`, writes a report scaffold and a high-priority
  ctx-contribution. Explicitly non-destructive, never edits code.

The `.pi/ctx-contributions/*.json` shape is the one place a convention already exists across
extension boundaries. Everything else is bespoke per file, and the duplicated
`verifierBoardBlocked` (§1) is the direct, already-observed cost of that: two hand-synced
copies of the same fail-closed gate, kept in sync by a code comment, not by the type system.

## 4. Parallelism

Two independent, uncoordinated concurrency/budget systems:

- `packages/extensions/third_party/subagent`: `MAX_PARALLEL_TASKS=8` hard cap, `DEFAULT_CONCURRENCY=4` default
  (env-overridable via `PI_KIT_SUBAGENT_CONCURRENCY`), enforced by a manual work-stealing pool.
  This is a **per-call** limit — nothing tracks total concurrent children across multiple
  `subagent` calls in the same session.
- `packages/extensions/src/conductor`: `maxDepth` / `maxDispatches`, persisted in
  `.pi/engagement/engagement.json` and enforced under a lock file
  (`recursion.lock`, 60s staleness). This is a **durable, cross-call** budget, structurally
  more robust than `subagent`'s per-call limit — but it only applies to `dispatch_specialist`,
  and the two systems have no shared accounting. A session that uses both mechanisms in
  sequence (engagement closes, falls back to `subagent`) gets no combined budget at all.

None of the five orchestration-facing skills (`agent-orchestration`, `dynamic-agent-synthesis`,
`delegation-context-budgeting`, `fork-and-compact-discipline`, `task-decomposition`) mention
the concurrency knobs at all — a model following the documented guidance has no way to know
it's capped at 8 parallel / 4 concurrent by default, or that the cap is configurable.

## 5. Agent role definitions — quality review

Read: `.pi/agents/{planner,implementer,reviewer,scout}.md` (materialized copies of
`packages/extensions/src/orchestrator/agents/*.md`, the canonical source) and
`packages/extensions/src/conductor/agents/validator.md`.

**Strengths**: consistent frontmatter (`name`, `description`, `tools`), consistent
"Output format" section per role that's concrete and machine-parseable (headers, bullet
conventions), each role has a clear single responsibility, and the handoff chain
(scout → planner → implementer → reviewer) is coherent and well-suited to a small-model
hot path (scout/planner explicitly note "do not read whole files unnecessarily").

**Inconsistencies found**:

- `implementer.md` has **no `tools:` line at all** — the only one of the five with unrestricted
  tool access. That may be intentional (it needs write/edit/bash to implement), but it's
  undocumented as a deliberate choice versus an oversight, and it means tool-restriction
  enforcement for this role depends entirely on the caller not restricting it, since there's no
  declared allowlist to check against.
- Enforcement differs by launcher (§1): `subagent` trusts the CLI's own `--tools` filtering;
  `dispatch_specialist` additionally validates against a hardcoded allowlist before launch. A
  role's `tools:` line means something stricter when dispatched through conductor than through
  `subagent` — that's a real behavioral difference an operator authoring a new role wouldn't
  expect from reading the frontmatter alone.
- None of the five roles declare inputs/outputs/a completion contract beyond the prose
  "Output format" section — there's no machine-checkable schema a caller or verifier could
  validate a response against. (This is the same gap A2A's Agent Card is designed to close —
  see §7.)

**Coverage gaps** (no existing role covers): debugging/root-cause isolation (distinct from
"implementer," which assumes a plan already exists), test-writing specifically, refactor-only
work (vs. feature implementation), performance/profiling, dependency/build/upgrade work,
docs-writing, and a coding-focused security reviewer (the kit already has strong
security-domain *skills* — `authz-idor-testing`, `api-testing`, `code-security-review` — but
no *agent role* that pairs one of those skills with an isolated-context delegation contract).

## 6. The agent-synth gap (highest-leverage fix)

`packages/extensions/src/conductor/synth/agent-synth.ts` exports `synthesizeAgent`/`writeSynthesizedAgent`:
deterministic template assembly from the skills catalogue, with real safety invariants (rejects
invalid tool names, invalid agent names, newline injection — verified by
`packages/core/verify.mjs`'s "agent-synth output contract" check and a passing
`tests/conductor-agent-synth-smoke.mjs`). Confirmed by direct grep: **no file under
`packages/extensions/src/conductor/` imports it**, and the only caller anywhere in the repo is that one
test. `dispatch_specialist` can only read an agent file that already exists
(`agentDefinition`, `packages/extensions/src/conductor/index.ts:223-229`) — it has no path to create one.
`packages/kit/skills/dynamic-agent-synthesis/SKILL.md` (line 9) tells models to use a synthesis workflow
that, per this grep, no tool call in the current build can reach.

`docs/proposals/root-orchestrator-conductor.md` marks this as Phase 2 of the design,
"implemented," and status "promoted 2026-08-27" — that status line is stale relative to the
current source and should be corrected (per this repo's own `CLAUDE.md` guidance to verify
roadmap docs against code, not trust them). The proposal's §8 also lists seed role templates
(`recon`, `web-exploit`, `authz`, `api`, `reporter`) meant to live in
`packages/extensions/src/conductor/agents/*.md`; only `validator.md` exists there today.

Practically: this means the *design* for "more specialist agents, generated well" already
exists and has already been thought through carefully (least-privilege tool grants, deterministic
templates, safety invariants) — the gap is purely in wiring, not in design work. Any effort
spent hand-authoring N new static `.md` role files should be weighed against the smaller effort
of exposing `agent-synth` through a tool `dispatch_specialist` (or a new dedicated tool) can
actually call.

## 7. Standardization: A2A protocol and alternatives

### What A2A actually is

A2A (Agent2Agent) is an open protocol, donated by Google to the **Linux Foundation** in June
2025, now governed by a multi-vendor Technical Steering Committee (AWS, Cisco, Google, IBM
Research, Microsoft, Salesforce, SAP, ServiceNow), at v1.0 with 150+ supporting organizations
as of April 2026 ([a2aproject/A2A](https://github.com/a2aproject/A2A);
[Wikipedia](https://en.wikipedia.org/wiki/Agent2Agent)). Mechanically: an **Agent Card**
published at a well-known HTTPS endpoint (`/.well-known/agent-card.json`, optionally
cryptographically signed in v1.0) advertises an agent's skills and transport bindings; agents
talk over **JSON-RPC 2.0 over HTTPS** (gRPC/HTTP+JSON also supported), with SSE streaming and
webhook push notifications for long-running work; a **Task** moves through an 8-state machine
(`submitted, working, input_required, auth_required, completed, failed, canceled, rejected`);
a **Message** carries typed **Parts** (text/file/structured-data) and a completed task yields
**Artifacts**.

A2A and MCP solve different problems and are commonly used together, not as alternatives: MCP
is agent→tool/resource (vertical), A2A is agent→agent (horizontal)
([Atlan](https://atlan.com/know/mcp/mcp-vs-a2a-protocol/)). This kit already depends on MCP in
places (`packages/extensions/src/mcp-router`, `packages/kit/skills/mcp-only-operations`, `packages/kit/skills/mcp-tool-use`) — that's
an orthogonal, already-adopted layer, not something this review is questioning.

### Fit assessment: poor, and precisely so

Google's own Agent Development Kit docs (the team that originated A2A) state the dividing line
directly: local sub-agents run "within the same application process," communicating "directly
in memory, without network overhead"; remote agents run "as separate services, communicating
over a network." ADK recommends A2A when the target is "a separate, standalone service,"
"maintained by a different team or organization," needs "different programming languages or
agent frameworks," or wants "a strong, formal contract" between independently-versioned
components — and recommends **against** it for "internal code organization,"
"performance-critical internal operations," a sub-agent needing "direct access to the main
agent's internal state," or "simple helper functions"
([google.github.io/adk-docs/a2a/intro](https://google.github.io/adk-docs/a2a/intro/)).

None of A2A's target conditions match this kit. `packages/extensions/third_party/subagent` spawns
`pi --mode json -p --no-session` as a **child process of the same parent**, owned start-to-finish
by one operator, on one machine. There is no cross-organization trust boundary to broker — a
signed Agent Card authenticates a *stranger*; here every "agent" is the same `pi` binary
invoked with a different role prompt. No prior art surfaced of A2A being used as the *primary*
transport for same-process/same-machine subagent orchestration; every real-world discussion
found frames it for cross-service delegation. Adding an HTTP server, TLS, and a
capability-discovery endpoint to broker what is currently a `child_process.spawn()` call this
kit already fully owns would add real attack surface (directly relevant to `DS-01`/`DS-07-09`'s
already-flagged containment concerns) to solve a distributed-trust problem this kit does not
have.

### What's worth borrowing anyway

Three A2A *concepts*, not its transport, map cleanly onto gaps this review already found:

1. **Agent Card → a real capability manifest per role.** Today's `.pi/agents/*.md` frontmatter
   only declares `name`/`description`/`tools` (§5) — no declared inputs/outputs, no completion
   contract, no version. A2A's Agent Card is a fuller model to steal the *shape* of: structured
   skills, declared I/O, a compatibility signal — enough for `dispatch_specialist` or
   `subagent` to validate a role before spawning it rather than discovering a mismatch
   mid-task. This is a different concern from `extension.json` (which is about installing an
   *extension*, not describing what a spawned *role* can do).
2. **Task lifecycle state machine → replace ad hoc status strings with one shared enum.**
   A2A's `submitted → working → input_required/auth_required → completed/failed/canceled/rejected`
   is close in shape to what `reviews/2026-09-agent-system/06-implementation-plan.md` already
   proposed independently: `queued → running → waiting-for-tool/agent/approval/user, reviewing
   or recovering → succeeded/failed/blocked/cancelled`. That this kit's own prior review
   converged on a near-identical shape *without* reference to A2A is a good independent signal
   the state machine is right; the recommendation is to align terminology with A2A's
   well-known names where they overlap (external readers and future tooling recognize them)
   while keeping the extra states this kit's fault model needs and A2A doesn't have
   (`blocked`, `recovering` — A2A assumes a single external service, not a local
   verification/recovery layer).
3. **Message/Parts/Artifact → one typed envelope instead of N bespoke file formats.** §3's
   table is the evidence: every hand-off point in this kit (`task-classification.json`,
   `verdicts.json`, the task-graph board, the ctx-contribution files) has its own ad hoc shape,
   no `id`/`sender`/`recipient`/`in-reply-to`/`TTL`/`ack` fields, and no idempotency handling —
   directly the gap behind `DS-05` ("duplicate/delayed/out-of-order messages") and `DS-11`
   ("missing approval/navigation protocol"). A2A's envelope is a reasonable skeleton to copy
   locally: one shared type, reused everywhere, instead of a new shape per extension.

### Contrast: other local-orchestration prior art

All four below are **in-process**, the same shape as this kit — reinforcing that A2A's
network shape is the outlier, not the norm, for this kind of tool:

| Framework | Core pattern | Shape |
|---|---|---|
| Anthropic's own multi-agent research system | Lead agent decomposes work, spawns subagents each with their own context/tools, run in parallel; dedicated citation agent; state persisted by the lead across long tasks. Reports weeks spent iterating on *delegation prompts* to fix concrete failure modes, not protocol changes. ~15× token cost vs. single-agent for the accuracy gain. | In-process, orchestrator-worker |
| LangGraph | Directed graph, conditional-edge handoffs, full state checkpointing (replayable) | In-process, closest existing prior art to this kit's task-graph/goal-core/orchestrator trio |
| AutoGen/AG2 | Conversable agents exchanging structured messages inside a shared `GroupChat` | In-process, closer to shared-memory pub/sub than a formal task contract |
| CrewAI | Role-based "crews," declared process (sequential/hierarchical), shared context | In-process, closest existing analogue to this kit's role-based `.pi/agents/*.md` design |
| OpenAI Agents SDK | Handoffs are literal tool calls — one agent's model invokes a "handoff" tool that transfers control + history to a named specialist | In-process, closest to this kit's "spawn a role with a task string" model but with the handoff as a typed call, not free text |

### Recommendation

Do not adopt A2A's transport (HTTP/JSON-RPC, Agent Cards over a network, signed capability
discovery) — there's no network boundary, no cross-organization trust boundary, and no
cross-framework interop need here, and adopting it would add operational and security surface
to solve a problem this kit doesn't have. Do adopt, as a **local, file/in-process schema** with
no new network-facing process:

- a structured **agent capability card** per role, extending `.pi/agents/*.md` frontmatter
  (not replacing `extension.json`, a different concern);
- a **formal task lifecycle state machine**, A2A-aligned naming where it overlaps, extended
  with `blocked`/`recovering` for this kit's fault model — this doesn't create new work so much
  as confirm the direction `06-implementation-plan.md`'s Stage B/C already proposed, with
  external validation for the shape;
- a **typed message/artifact envelope** (id, sender, recipient, in-reply-to, TTL, ack) reused
  across `task-classification.json` / `verdicts.json` / the task-graph board / ctx-contributions,
  replacing N ad hoc shapes with one.

None of this requires tracking an external spec version or taking on a protocol dependency —
it's "borrow the concepts, skip the wire format."

## 8. Proposed new specialist agent roles

Per §6, the architecturally consistent way to add these is wiring `agent-synth` into a
callable path (so roles are generated from the skills catalogue with least-privilege tool
grants and the existing safety invariants) rather than hand-authoring N more static files that
then need to be kept in sync by hand. The specs below are written to be usable either way —
as `agent-synth` templates or as interim hand-authored `.md` files in
`packages/extensions/src/orchestrator/agents/` — with tool grants chosen to satisfy conductor's stricter
`SPECIALIST_ALLOWED_TOOLS` allowlist (§1) wherever plausible, so a role works under either
launcher without modification.

| Role | Purpose | Suggested tools | Notes |
|---|---|---|---|
| `debugger` | Isolate root cause of a reported failure (distinct from `implementer`, which assumes a plan already exists) | `read, grep, find, ls, bash` (read-only bash: reproduce, inspect logs/stack traces) | Output should include a minimal repro and a root-cause statement, handed to `implementer` for the fix — mirrors the existing scout→planner handoff shape |
| `test-author` | Write or extend tests for a specified change, without touching production code | `read, grep, find, ls, write, edit` | Scope restriction ("tests only") should be explicit in the prompt, since tool grants alone (`write`/`edit`) can't express a path restriction |
| `refactorer` | Restructure code without changing behavior, for a named target only | `read, grep, find, ls, write, edit` | Should require an existing test/verify command to run before/after as its own completion contract, distinct from `implementer`'s "new functionality" framing |
| `perf-profiler` | Investigate a performance complaint, produce a profiling report + hypothesis (read-only, like `scout`/`planner`) | `read, grep, find, ls, bash` | Read-only by design — profiling findings should be reviewed before anyone implements a fix |
| `dependency-upgrader` | Investigate a dependency/build upgrade, produce a compatibility report and migration plan | `read, grep, find, ls, bash` | Read-only investigation role; actual upgrade execution stays with `implementer` |
| `docs-writer` | Write/update documentation for a completed change | `read, grep, find, ls, write, edit` | Should read the actual diff (`git diff`) the way `reviewer` does, not just the plan, to avoid documenting intent instead of what shipped |
| `security-code-reviewer` | Security-focused review pass, distinct from `reviewer`'s general correctness/completeness gate | `read, grep, find, ls, bash` | This kit already has strong security-domain skills (`code-security-review`, `authz-idor-testing`, `api-testing`) with no agent role that pairs one with an isolated-context delegation contract — this role is the missing link, not new domain knowledge |

## 9. Recommended priority order (research framing only — not a commit to implement)

**Near-term, low-risk, no architecture change:**
- Document `PI_KIT_TRUSTED_PROJECT_ROLES` (README + `.env.example`) and/or change the
  headless-block error message to name it explicitly, so the escape hatch is discoverable.
- Reconsider the `agentScope` default — either default to `"both"` (matches what orchestrator
  always requests anyway) or make the `Unknown agent... Available: none.` error name the
  active scope and suggest `agentScope: "both"`, so the failure mode is self-diagnosing.
- Apply the same stream-cap/idle-timeout hardening from `93fed1d`/`49e92d8` to conductor's
  `runSpecialistProcess`.
- Surface a warning (not silent drop) when a child's stdout line fails JSON parsing.
- Add an explicit `tools:` line (or an explicit documented-intentional comment) to
  `implementer.md`.
- Add concurrency-knob and retry/error-handling guidance to `packages/kit/skills/agent-orchestration` and/or
  `packages/kit/skills/delegation-context-budgeting`.
- Correct `docs/proposals/root-orchestrator-conductor.md`'s Phase 2 status from "implemented"
  to reflect that `agent-synth` is unwired at runtime.

**Medium-term:**
- Wire `agent-synth` into a callable path (new tool, or extend `dispatch_specialist`) so
  specialist roles can actually be synthesized on demand, closing the gap in §6 and making §8's
  roles (and future ones) cheap to add without hand-authored files.
- Add the seed role templates `docs/proposals/root-orchestrator-conductor.md` §8 already
  specifies but never landed.

**Longer-term (this is genuinely Stage C of `06-implementation-plan.md`, not new scope):**
- Unify `packages/extensions/third_party/subagent` and conductor's `dispatch_specialist` behind one spawn/status/
  message/cancel/result adapter, so reliability fixes only need to happen once.
- Introduce the A2A-inspired local schema from §7 (capability card, task lifecycle enum,
  typed envelope) as the shared contract that adapter and the blackboard files in §3 both use.

## Sources

- Direct source reads: `packages/extensions/third_party/subagent/index.ts`, `packages/extensions/third_party/subagent/agents.ts`,
  `packages/extensions/src/orchestrator/index.ts`, `packages/extensions/src/conductor/index.ts`,
  `packages/extensions/src/conductor/synth/agent-synth.ts`, `packages/extensions/src/task-graph/index.ts`,
  `packages/extensions/src/goal-core/index.ts`, `packages/extensions/src/verifier-board/index.ts`,
  `packages/extensions/src/recovery-orchestrator/index.ts`, `.pi/agents/*.md`,
  `packages/extensions/src/orchestrator/agents/*.md`, `packages/extensions/src/conductor/agents/validator.md`,
  `docs/proposals/root-orchestrator-conductor.md`, `packages/kit/skills/agent-orchestration/SKILL.md`,
  `packages/kit/skills/dynamic-agent-synthesis/SKILL.md`, `packages/kit/skills/delegation-context-budgeting/SKILL.md`,
  `packages/kit/skills/fork-and-compact-discipline/SKILL.md`, `packages/kit/skills/task-decomposition/SKILL.md`,
  `CHANGELOG.md`, `git log`/`git show` on `93fed1d` and `49e92d8`.
- Prior review: `reviews/2026-09-agent-system/00-specification.md` through
  `07-acceptance-matrix.md` (baseline `6460ef6`, 2026-09-14).
- External, fetched 2026-09-16: [a2aproject/A2A](https://github.com/a2aproject/A2A),
  [Agent2Agent — Wikipedia](https://en.wikipedia.org/wiki/Agent2Agent),
  [A2A protocol architecture — Tyk](https://tyk.io/learning-center/a2a-protocol-architecture-and-technical-specification/),
  [A2A protocol explained — Eco](https://eco.com/support/en/articles/14845481-a2a-agent-to-agent-protocol-explained),
  [MCP vs A2A — Atlan](https://atlan.com/know/mcp/mcp-vs-a2a-protocol/),
  [MCP vs A2A — TrueFoundry](https://www.truefoundry.com/blog/mcp-vs-a2a),
  [Google ADK: local vs. remote agents](https://google.github.io/adk-docs/a2a/intro/),
  [Anthropic multi-agent research system, summarized](https://blog.bytebytego.com/p/how-anthropic-built-a-multi-agent).
