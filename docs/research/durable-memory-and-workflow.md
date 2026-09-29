# Durable Memory and Workflow Architecture for Long-Horizon Coding Agents

> **Status (2026-09-23):** superseded for memory by `memory-vault` (see [memory.md](../memory.md)) and for chaining by [workflows](../workflows.md). Kept as research context.

## What the current agent ecosystem already gets right

The clearest cross-vendor pattern is that durable agent systems work best when they **separate stable instructions from learned recall**. Claude Code distinguishes `CLAUDE.md` from auto memory: `CLAUDE.md` holds human-authored rules and workflows, while auto memory stores learned patterns and is loaded only through a concise `MEMORY.md` index plus topic files. Codex makes the same distinction explicitly, advising teams to keep required guidance in `AGENTS.md` or checked-in docs and treat memories as a local recall layer rather than the sole source of mandatory rules. Hermes does likewise with `SOUL.md` for identity, `MEMORY.md` for environment and project facts, and `USER.md` for preferences. This split is the right foundation for a durable local coding agent, because policies need version control and review, while memory needs cheap iteration and selective retention.

The second durable pattern is **progressive disclosure**. Claude Code loads a skill body only when the skill is actually used. Codex does the same and explicitly caps the initial skill catalogue to roughly 2% of the model's context window, loading full `SKILL.md` content only after selection. Pi follows the same model: at startup it scans skill names and descriptions, then loads the full skill on demand. The Agent Skills specification formalises this as a three-stage process: metadata at startup, `SKILL.md` on activation, and scripts or references only when required. This is not just a convenience feature; it is the key architectural principle for preventing long-running agents from drowning themselves in context.

The third strong pattern is **durable trace plus compact summaries**. Pi stores sessions as JSONL trees with branching, then creates compaction summaries and branch summaries that preserve progress while keeping the active window small. Claude exposes transcript paths to hooks, supports `PreCompact` and `PostCompact`, and documents explicit patterns for re-injecting critical context after compaction. Hermes keeps bounded memory small and uses session search over stored sessions when the agent needs to recall specifics rather than always loading them into prompt context. Together, these systems suggest a robust design rule: never confuse the full execution trace with the active prompt context; keep the trace append-only and retrieve or summarise from it selectively.

The fourth pattern is **parallelism through isolated workers, not one giant context**. Claude subagents run in their own context windows with separate permissions and tool access. Codex subagents likewise run in parallel and can be configured with distinct models, instructions, and sandbox policies; Codex also supports worktrees and thread handoff between Local and Worktree. Hermes offers two complementary models: synchronous delegation for fresh-context subtasks, and a durable SQLite-backed Kanban board for long-lived cross-profile work. Git worktrees are the underlying local-first primitive that makes this credible: a single repository can host multiple linked working trees so different branches and experiments can proceed in parallel without clobbering one another.

A final lesson is that **long-horizon work needs an explicit objective object**. Codex Goal mode gives the agent a persistent objective with a stopping condition and recommends checkpointed progress logs; the ExecPlans guidance goes even further and says a multi-hour plan should be usable by a fresh agent with only the current working tree and the plan file, assuming no memory of prior plans. Hermes' Kanban completion metadata similarly expects changed files, verification commands, dependencies, blocked reasons, and residual risks. Those ideas combine naturally into a durable task object for local coding agents.

## Proposed durable memory architecture

The architecture below is a synthesis of Claude's checked-in instructions plus topic memory, Codex's `AGENTS.md` layering and memories, Hermes' bounded persistent memory plus session search, Pi's JSONL session tree, and the Agent Skills progressive disclosure model. It is designed to be **local-first, portable, inspectable, and partially agent-agnostic**.

### The memory layers

Use seven distinct layers.

**Identity memory** should live in a human-edited file, equivalent to Hermes `SOUL.md`, for the agent's durable operating identity: style, risk posture, default coding habits, and non-project-specific behavioural rules. Hermes makes this the first slot in the system prompt and keeps it outside per-project discovery, which is the right model for a stable local agent persona.

**Policy memory** should live in repository files, primarily `AGENTS.md`, with nested overrides for subprojects. Codex documents explicit discovery order from global scope to current directory, and the AGENTS.md standard says the nearest file should take precedence for edited files. This layer is for build commands, test commands, conventions, security rules, review expectations, PR ritual, and anything that must be reproducible by humans and machines alike. Do not put ephemeral discoveries here.

**Procedural memory** should live in **skills**. Skills are the right home for reusable workflows, because all four ecosystems studied treat them as on-demand procedural packages rather than always-on prompt text. Keep each skill focused, triggerable by description, and small enough to load cheaply; put bulk material in `references/` and executable helpers in `scripts/`. The Agent Skills specification recommends keeping the main `SKILL.md` under 500 lines and using progressive disclosure for the rest.

**Semantic project memory** should be stored in **versioned Markdown topic files plus SQLite metadata**. Claude's auto memory model is the cleanest template: maintain a concise `MEMORY.md` index that is always loaded, and move details into topic files that are read only when needed. For your local system, keep this layer under an agent-home project directory, not inside the repository unless you explicitly want to commit it. Good examples are `architecture.md`, `debugging.md`, `api-conventions.md`, `fixtures.md`, `third-party-quirks.md`, and `decisions.md`.

**Episodic task memory** should be stored as **task-scoped summaries in SQLite and optionally mirrored to Markdown handoff notes**. This layer records what happened on a task: decisions taken, files explored, experiments run, failures observed, and what changed the plan. CoALA's distinction is useful here: episodic memory stores experience from earlier decision cycles, while semantic memory stores general knowledge about the world or system. Episodic memory is cheaper and safer to write than procedural memory, and it is the right place for "what we tried and what happened".

**Trace memory** should be preserved as an **append-only session JSONL log**. Pi's session format is the best concrete model here: each line is a typed event in a session tree, supporting in-place branching, summaries, and extension state that does not automatically enter the LLM context. Keep raw tool calls, results, messages, verifier outputs, and linked artefacts here. This layer is the source of truth for auditing, replay, summarisation, and future memory extraction.

**Retrieval memory** should be stored in a **local vector index backed by SQLite IDs**, not as the main source of truth. MemGPT shows the value of a hierarchical memory system that pages information between active context and external storage. LightMem and SimpleMem both reinforce a related design: keep online retrieval fast and bounded, and do heavier consolidation asynchronously. In practice, that means embeddings are an index over semantic and episodic artefacts, not the only copy of them.

### What should live where

Use this content partitioning rule.

`AGENTS.md` should contain: setup, test and verification commands, code style, security rules, repository topology, deployment constraints, branch conventions, and human review requirements. It should be versioned and reviewed like code. This follows the AGENTS.md standard and Codex's guidance on custom instructions.

`SKILL.md` and supporting skill files should contain: reusable methods, repeatable checklists, strongly scoped workflows, format instructions, and helper scripts. Claude, Codex and Pi all support this pattern directly, and the Agent Skills spec standardises it.

Project-memory Markdown should contain: high-value discoveries that are likely to matter again across sessions and branches. Claude's topic-file pattern is ideal here. Examples include "how to run integration tests with local fixtures", "which logs are misleading", or "service X requires this bootstrap sequence".

SQLite should be the **canonical operational store**. Hermes uses SQLite for its durable Kanban board, and its session search uses FTS5 rather than stuffing everything into prompt memory. Your server should use SQLite for tasks, dependency edges, claims and leases, worktrees, verifier runs, memory metadata, skill registry, handoffs, embeddings metadata, and artefact references. SQLite is portable, easy to snapshot, and audit-friendly.

The vector store should hold embeddings only for retrievable artefacts: topic-memory files, episodic notes, session summaries, verifier failures, doc snippets, and skill descriptions. Use SQLite row IDs as stable foreign keys so you can rebuild the vector index without changing canonical identifiers. This turns retrieval into an acceleration layer, not a second database of record. That is an inference from MemGPT-style hierarchical storage and LightMem-style split between online retrieval and offline consolidation.

Session JSONL should record the full trace of reasoning-adjacent external events: prompts, tool calls, tool results, file writes, branch movements, task claims, verifier outcomes, and summaries. Pi shows why an append-only tree is valuable: you can fork, compact, summarise abandoned branches, and reconstruct extension state cleanly.

The upshot is a simple rule: **files are for human-reviewed durable knowledge, SQLite is for operational state, JSONL is for trace, and vectors are for retrieval acceleration**. That is the most durable combination supported by the evidence from current agent systems.

## Proposed task model and workflow board

The right operational model is a **DAG as source of truth, with a Kanban projection for humans and workers**. Airflow's DAG abstraction is useful here because it treats tasks as discrete units of work plus dependencies and completion rules. Temporal's task queues are useful for dispatch semantics because tasks persist in queues and workers poll only when they have spare capacity, enabling load balancing and recovery. Hermes contributes the local-agent version of this idea: a durable SQLite-backed board, explicit dependency links, assignees, workspace kind and handoff metadata.

### The task object schema

This schema is the recommended canonical object for long-horizon coding work. It combines Codex Goal mode, ExecPlans, Hermes handoff metadata, Pi branch summaries, and Git worktree state into one durable envelope.

```ts
export type TaskStatus =
  | "backlog"
  | "ready"
  | "claimed"
  | "running"
  | "blocked"
  | "awaiting_verification"
  | "completed"
  | "failed"
  | "cancelled"
  | "archived";

export type VerifierStatus =
  | "not_started"
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "partial"
  | "skipped";

export interface EvidenceRef {
  id: string;                       // stable ID in SQLite
  kind: "file" | "command" | "log" | "diff" | "url" | "summary" | "artifact";
  uri: string;                      // file://, task://, session://, artifact://
  label: string;
  hash?: string;                    // sha256 of immutable content where applicable
  createdAt: string;                // ISO-8601
  notes?: string;
}

export interface Blocker {
  kind: "dependency" | "missing_context" | "failing_test" | "tooling" | "human_decision" | "external";
  summary: string;
  details?: string;
  blockingTaskIds?: string[];
  openedAt: string;                 // ISO-8601
  resolvedAt?: string;              // ISO-8601
}

export interface BranchState {
  repoRoot: string;
  branchName: string;
  baseRef: string;                  // e.g. origin/main
  worktreePath?: string;
  containerId?: string;
  detachedHead?: boolean;
  dirty?: boolean;
  lastCommit?: string;
}

export interface VerifierState {
  status: VerifierStatus;
  requiredChecks: string[];         // canonical verifier IDs
  lastCommands?: string[];          // e.g. npm test, pytest -q
  lastRunAt?: string;
  passedChecks?: string[];
  failedChecks?: string[];
  failureSummary?: string;
  artifactIds?: string[];           // EvidenceRef IDs
}

export interface TaskSummary {
  situation: string;                // where we are now
  changesMade: string[];
  findings: string[];
  risks: string[];
  nextBestActions: string[];
}

export interface TaskNode {
  id: string;
  parentGoalId: string;             // durable goal object
  title: string;
  goal: string;                     // one clear objective
  definitionOfDone: string;         // verifiable stopping condition
  constraints: string[];            // safety, scope, tech, deadlines
  assumptions: string[];
  status: TaskStatus;
  priority: number;                 // lower = higher priority
  assignee?: string;                // agent/profile/worker name
  roleHint?: string;                // explorer, implementer, reviewer, verifier
  labels: string[];
  dependencies: string[];           // task IDs this task waits for
  dependents?: string[];            // optional denormalised cache
  subtasks: string[];               // child task IDs
  evidence: EvidenceRef[];
  blockers: Blocker[];
  branch: BranchState;
  verifier: VerifierState;
  handoffSummary: TaskSummary;
  contextPointers: string[];        // memory/resource IDs to preload
  createdAt: string;
  updatedAt: string;
  claimedAt?: string;
  completedAt?: string;
  archivedAt?: string;
}
```

### How the board should behave

The DAG should be the canonical structure, but every task should also appear in a board lane derived from status. Suggested lanes are `backlog`, `ready`, `running`, `blocked`, `awaiting_verification`, and `completed`. That gives humans the visual Kanban they expect, while preserving dependency semantics and recursive decomposition underneath. Hermes already models tasks with assignee, dependency links and workspace kind; your system should generalise that into a richer task graph rather than flattening everything into a purely manual board.

Task decomposition should be **recursive but bounded**. CoALA's account of Soar is relevant: when there is an impasse, the system creates a subgoal, which is a classic form of hierarchical task decomposition. Hermes also defaults delegation depth conservatively and warns that deeper spawn trees multiply cost quickly. Codex likewise keeps `agents.max_depth` at `1` by default and warns about broad fan-out and resource consumption. The practical implication is: decompose until subtasks become verifiable within one worker's context and tooling, but cap recursion unless there is a strong reason to go deeper.

The board should support two execution modes. For **short-lived synchronous subtasks**, use fresh-context workers that return summaries, like Claude subagents or Hermes `delegate_task`. For **durable multi-hour or multi-day tasks**, enqueue them on the board with explicit leases, retries and handoff packets, more like Hermes Kanban or a Temporal-style persisted task queue. The mistake to avoid is using subagents for everything; Hermes documents that synchronous delegation is not durable and is cancelled if the parent turn is interrupted.

### Parallel execution with worktrees or containers

Every runnable task should declare a **workspace mode**: `same-tree`, `worktree`, or `container`. Worktrees are best for code modification on a shared Git repository because Git explicitly supports multiple linked working trees and allows more than one branch to be checked out at a time. Codex's worktree model adds an important operational lesson: background work should usually happen in a dedicated worktree, and handoff should move a thread between local and worktree safely instead of trying to keep the same mutable branch in two places at once. Hermes' board already stores workspace kind, which confirms this is the right abstraction for local multi-agent work.

A recommended default is:

- exploration, review and triage tasks: read-only worktree or container
- implementation tasks: writable worktree per task
- heavy build/test or environment-sensitive tasks: container if reproducibility matters more than IDE continuity
- local foreground debugging by the human: hand the task back to the main checkout rather than keeping the branch live in two working trees.

## Proposed handoff protocol and skill lifecycle

### The handoff protocol

A good handoff packet should let a fresh agent resume with minimal loss. Codex worktrees preserve thread identity across handoff between Local and Worktree. Pi can summarise an abandoned branch and attach that summary near the new position. Hermes explicitly recommends machine-readable completion metadata with changed files, verification commands, dependencies, blocked reason, retry notes and residual risks. ExecPlans go even further and assume the next agent has only the working tree and the plan file. These converge on one principle: **every durable handoff needs a compact narrative plus a machine-parseable state record**.

Use this packet shape for every stop, pause, claim transfer or verifier escalation:

```json
{
  "task_id": "task_01J...",
  "handoff_type": "pause|claim_transfer|verification|blocked|complete",
  "from_agent": "impl-worker-3",
  "to_agent": "review-worker-1",
  "goal": "Implement auth token refresh without regressing session expiry behaviour",
  "definition_of_done": "All auth tests pass; token refresh path covered; no new lint/type errors",
  "current_state": {
    "status": "awaiting_verification",
    "branch": "agent/task_01J_auth-refresh",
    "worktree": "/worktrees/task_01J_auth-refresh",
    "base_ref": "origin/main"
  },
  "what_changed": [
    "src/auth/refresh.ts",
    "src/auth/session.ts",
    "tests/auth/refresh.test.ts"
  ],
  "evidence_ids": [
    "ev_cmd_123",
    "ev_diff_456",
    "ev_log_789"
  ],
  "verification": {
    "commands_run": ["pnpm test tests/auth/refresh.test.ts", "pnpm lint"],
    "status": "partial",
    "failures": ["one unrelated flaky test in tests/auth/session-expiry.test.ts"]
  },
  "blockers": [],
  "risks": [
    "time skew edge cases not tested against mobile client"
  ],
  "next_actions": [
    "run full auth suite",
    "inspect flaky expiry test",
    "validate refresh path with clock skew fixture"
  ],
  "context_to_preload": [
    "resource://task/task_01J",
    "resource://memory/project/auth-subsystem",
    "resource://artifact/ev_diff_456"
  ],
  "summary_markdown": "Short human-readable summary here"
}
```

Operationally, every handoff should create three things at once: a **SQLite row** linked to the task, a **Markdown note** in the task artefact folder for human inspection, and a **session JSONL event** so the trace remains complete. That gives you auditability, retrieval, and easy manual debugging without duplicating the entire state blob into prompt context. This is an implementation recommendation derived from Pi's typed session entries, Hermes' machine-readable task metadata, and Codex's persistent worktree-thread pairing.

### The skill lifecycle

The strongest lifecycle model today comes from combining the Agent Skills specification with Hermes' curator. The open standard defines structure, progressive disclosure and validation; Hermes adds actual lifecycle management through usage tracking, `active -> stale -> archived` states, staging and approval gates, consolidation, and dry-run review. Codex adds practical authoring and distribution guidance: use skills as the authoring format, then package them as plugins when they need broader distribution. Claude adds live change detection and per-skill tool approval.

A durable lifecycle should therefore be:

**Create.** Allow either human-authored skills or agent-suggested skills extracted from repeated successful traces. Keep them local first, as both Codex and Hermes recommend in practice.

**Validate.** Run structural validation against the Agent Skills spec, including frontmatter, naming, description quality and reference paths. The specification explicitly recommends `skills-ref validate`. Also run a dry-run semantic check: is the trigger description precise, is the `SKILL.md` concise, and are supporting files correctly referenced?

**Use.** Track at least four counters: viewed, selected, successfully completed, and verifier-passing uses. Hermes already tracks viewed, used and patched.

**Score.** Score each skill on trigger precision, execution utility, freshness and safety. This is a design recommendation, but it is closely aligned with Hermes' curator goals and the emerging research direction that studies how skill organisation changes runtime behaviour. Progressive disclosure matters; skill organisation is not merely cosmetic.

**Update.** Prefer patching over wholesale rewriting when the workflow stays the same but details drift. Hermes explicitly prefers patch-style updates for token efficiency.

**Archive and merge.** After prolonged non-use, move a skill to `.archive/` rather than deleting it immediately. Hermes defaults to stale after 30 days and archive after 90, and its curator can consolidate overlapping skills while preserving support files correctly. Use similar thresholds unless your environment is unusually fast-moving.

**Delete.** Delete only after an archive grace period and only for agent-created or explicitly local skills. Hermes' default stance is conservative: archive, do not auto-delete. That is the right default for a coding agent that may need to explain itself later.

## Context loading policy

Your system should be opinionated here. Most context drift comes from loading too much, too early, too often.

### What to load eagerly

At session start, load only the things that must shape every turn: the active identity file, the merged `AGENTS.md` chain for the current directory, the currently claimed task card, the current goal, and the latest handoff summary if the task is being resumed. This follows the pattern from Codex instruction discovery, Hermes frozen memory snapshot, and Claude's "load concise index, not all topic files" design.

Also load a **small working set of memory**, not the entire store. Hermes' bounded built-in memory is a useful sanity check here: critical facts should be in always-on memory because they are small and repeatedly useful; everything else belongs in searchable traces or retrievable topic files. Pi's compaction model reinforces the same point from the opposite direction: keep the active window small and preserve the rest through summaries and retrieval.

### What to load lazily

Load skill bodies lazily, exactly as Claude, Codex, Pi and the Agent Skills spec all recommend. Keep skill descriptions short and triggerable, then let the agent pull in `SKILL.md` only on match or explicit invocation. If the skill points to `references/` or `scripts/`, those should load only when the conditions in the skill say they are relevant.

Load project-memory topic files lazily too. Claude's auto memory index is the best concrete model: the index should say what exists and when to open it, while the detailed files remain cold until needed.

### What to load by retrieval

Retrieve from vector search or FTS only when the agent has evidence that recall is needed: "what did we learn last week about flaky test X?", "which branch already tried strategy Y?", "where did we record the launch sequence for local Kafka?". Hermes explicitly distinguishes always-on memory from on-demand session search, and Pi's branch summaries show how retrieved summaries can stand in for replaying old branches.

A practical rule is:

- use SQLite/FTS for exact recall of past sessions, commands, file names, verifier failures and task IDs
- use vector search for fuzzy recall across topic-memory files, episodic summaries and doc snippets
- prefer exact recall before semantic recall when the query names a file, symbol, branch or task directly. This is a design recommendation grounded in the different roles these systems already play in Hermes and Pi.

### What to load only after tool evidence

Large logs, diff hunks, raw transcripts, broad codebase trees and bulky documentation should only enter prompt context after the agent has tool evidence that they matter. Claude's subagent guidance exists partly to avoid flooding the main context with verbose intermediate discoveries. Pi's branch summaries and compaction pipeline exist for the same reason. Do not preload enormous artefacts "just in case". Ask the agent to read or retrieve them after it sees a failing test, stack trace, missing symbol or specific dependency edge.

In short, the loading order should be: **identity and policy first, task state second, skill metadata third, skills and memory details on trigger, raw evidence only after tool evidence**. That is the cleanest synthesis of the systems reviewed.

## TypeScript implementation plan for a local memory and task server

The best fit is a **single local server with SQLite as the source of truth, exposed over MCP** so Pi, Claude Code, Codex and Hermes can all use the same durable memory and workflow layer with minimal glue. MCP is specifically meant to expose tools, resources and prompts in a standardised way, and the official TypeScript SDK supports building servers with resources, prompts, tools, and standard transports such as stdio and Streamable HTTP.

### Storage layout

Use a local data root such as:

```text
~/.pi-memory/
  agent.db                 # SQLite canonical store
  sessions/
    <session-id>.jsonl     # append-only trace events
  memories/
    projects/<project-id>/
      MEMORY.md
      architecture.md
      debugging.md
      decisions.md
    identity/
      SOUL.md
  packages/kit/skills/
    local/<skill-name>/...
    archive/<skill-name>/...
  handoffs/
    <task-id>/<timestamp>.md
  artifacts/
    <artifact-id>/*
  indexes/
    embeddings/...
```

This mirrors patterns already proven in Claude (`~/.claude/projects/.../memory/`), Hermes (`~/.hermes/memories/`, `~/.hermes/skills/`, `~/.hermes/kanban.db`), Pi (`~/.pi/agent/sessions/`) and Codex (`~/.codex`, `.codex`, `.agents/skills`).

### SQLite schema modules

Split the database into logical modules:

- `goals`, `tasks`, `task_edges`, `task_claims`, `task_runs`, `handoffs`
- `workspaces`, `worktrees`, `containers`, `branches`
- `artifacts`, `evidence_refs`, `verification_runs`
- `memories`, `memory_topics`, `memory_links`
- `skills`, `skill_versions`, `skill_usage`, `skill_scores`, `skill_archive`
- `sessions`, `session_entries`, `branch_summaries`, `compactions`

This mirrors Hermes' durable board and Pi's typed session entries while keeping operational state queryable without reading prompt files.

### MCP surface

Expose three MCP capability families.

**Resources** should expose read-mostly state that clients can mount into context safely. Good examples are `resource://goal/<id>`, `resource://task/<id>`, `resource://task/<id>/handoff/latest`, `resource://memory/project/<project-id>/MEMORY.md`, `resource://board/ready`, and `resource://session/<id>/summary`. MCP resources are explicitly intended for file-like contextual data.

**Tools** should mutate operational state or perform focused searches. At minimum: `task_create`, `task_update`, `task_claim`, `task_complete`, `task_block`, `task_unblock`, `task_add_dependency`, `task_list_ready`, `handoff_create`, `handoff_apply`, `memory_write`, `memory_search`, `session_append`, `session_search`, `skill_register`, `skill_validate`, `skill_promote`, `skill_archive`, `verifier_enqueue`, `verifier_report`, `workspace_create_worktree`, `workspace_release_worktree`. MCP tools are the right primitive for this because they are schema-described model-callable functions.

**Prompts** should package reusable handoff and planning workflows, such as `resume-task`, `decompose-goal`, `prepare-handoff`, `write-skill-from-trace`, and `review-verifier-failure`. MCP prompts are explicitly for structured templates with arguments, which maps neatly onto these recurring workflows.

### Integration strategy per client

For **Pi**, implement the server as an MCP endpoint plus a Pi extension or package. Pi is deliberately minimal and pushes workflow-specific behaviour into extensions, skills, templates and packages; it also supports persistent extension state with `appendEntry`, custom tools, and SDK/RPC usage. That makes Pi the easiest place to prototype the orchestration layer.

For **Claude Code**, integrate the MCP server for task and memory operations, while continuing to use `CLAUDE.md`, project skills, hooks, and subagents natively. The most useful hook integrations are `SessionStart` to load the active task, `PreCompact`/`PostCompact` to refresh task summaries, `SubagentStart` to inject task-specific context into workers, and `PostToolUse` for non-blocking verification or indexing jobs.

For **Codex**, expose the same MCP server as a plugin dependency or direct MCP server, while continuing to use `AGENTS.md`, skills, goals, worktrees and custom agents natively. Codex already treats plugins and MCP servers as reusable workflows, and custom agents can carry role-specific configuration while the shared server holds the durable state.

For **Hermes**, use the server to complement, not replace, Hermes' own bounded memory and Kanban. Hermes already supports profiles, delegation and external memory providers. The cleanest integration is to map Hermes task operations to the shared task model and let Hermes continue using its own `SOUL.md`, built-in memory and profile isolation where that remains useful.

### Recommended implementation sequence

Start with a small but durable slice.

Build **phase one** around SQLite, JSONL traces, and the MCP surface for tasks, handoffs, and exact search. You can defer embeddings initially; Hermes' session search shows that FTS-backed retrieval already covers a lot of practical recall.

Then add **phase two**: project-memory topic files and vector retrieval over summaries and topic docs, with asynchronous consolidation inspired by LightMem and SimpleMem. Keep online recall bounded and push heavier consolidation offline.

Then add **phase three**: skill telemetry and curator functions, including validation, staged approval, score computation, stale/archive transitions and merge suggestions. Hermes provides the clearest production sketch for this.

Finally add **phase four**: worker orchestration helpers for worktree/container leasing, verifier routing, and resumable background jobs. Use Codex and Hermes as the behavioural model, but keep the authoritative task state in your own server.

## Open questions and limitations

Some areas are still moving targets. Public Codex documentation clearly covers Goal mode, worktrees, skills, plugins and custom agents, but `PLANS.md` and ExecPlans are documented in the OpenAI Cookbook rather than as a first-class runtime feature of the product, so they should be treated as a strong pattern rather than a guaranteed built-in primitive.

Pi is intentionally minimal and explicitly omits built-in sub-agents and plan mode, so any durable multi-agent workflow layer around Pi will need to be implemented through extensions, packages or external services rather than relying on native orchestration.

Hermes' fast-moving feature set is unusually rich, but some of its lifecycle and multi-agent orchestration details are still evolving rapidly in public documentation and issues. The core patterns used here - bounded built-in memory, external memory providers, profiles, delegation, curator and SQLite Kanban - are documented and high-confidence, but the exact UI and ergonomics will likely continue to change.

The architecture proposed here is therefore best understood as a **portable synthesis of stable ideas** from current agent systems, not a claim that any one of them already implements the full design end to end. The good news is that the pieces now exist: checked-in instructions, progressive-disclosure skills, compact/bounded memory, append-only traces, task boards, worktrees, and MCP as the interoperability layer.
