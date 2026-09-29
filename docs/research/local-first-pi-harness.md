# Architecture for a Local-First Pi Coding Agent Harness

> **Status (2026-09-16):** aspirational design-proposal note, not a description of shipped current behaviour. The `context-sieve` extension shipped without custom compaction summaries: its `session_before_compact` hook is a no-op and pi's native summarization is left untouched (see [memory-compaction-context.md](../architecture/memory-compaction-context.md)). Treat the compaction-summary material below as a roadmap direction rather than a description of what exists.

## Recommended direction

The best way to build a long-horizon, local-first coding harness around Pi is to treat **Pi as the interactive control plane and session engine**, then layer a **TypeScript orchestration package** on top that adds persistent goals, a task DAG, verification lanes, memory selection, trace capture, and optional remote escalation for planning and review. Pi already gives you most of the right primitives for this: TypeScript extensions loaded without a compile step, runtime tool/command registration, prompt and payload interception, mutable tool-call inputs, session replacement, branching, compaction hooks, custom persistence via session entries, and package-based distribution. It also supports custom providers through configuration or extensions, including Ollama, LM Studio, vLLM, and OpenAI-compatible backends, which is exactly what you want for a small local model plus selective remote fallback.

My strongest recommendation is a **two-tier planner/executor design**. Put the **small local model** on the hot path for coding, shell, file inspection, and incremental edits. Reserve a **remote, frontier-capable model** for three narrow responsibilities only: goal decomposition, branch review, and final verification triage. This mirrors the most useful patterns from Claude Code's subagents and agent hooks, Codex's `/goal` and auto-review model, Hermes' delegation plus curator loop, and OpenHands' separation between agent core and application layers. The result is cheaper, more stable, and better suited to long-running work than asking a small model to do everything in one conversation.

## What Pi already gives you

Pi's extension surface is unusually strong for this use case. Extensions are loaded through `jiti`, so you can write them directly in TypeScript; they can register tools, slash commands, shortcuts, flags, custom renderers, and event handlers. At runtime, extensions can also add tools dynamically and toggle active tools, which is important for a harness that wants to move between planning mode, execution mode, and verification mode without restarting the session.

Pi's event model is the core enabler. `before_agent_start` can inspect and mutate the system prompt and its structured inputs, including loaded skills and context files. `input` can intercept, transform, or fully handle incoming user text before it reaches the agent. `context` can modify the message set for a turn. `before_provider_request` can rewrite the provider payload just before the LLM request is sent. Most importantly for a coding harness, `tool_call` can mutate tool arguments in place before execution, and later handlers see earlier mutations. That gives you a powerful interception layer for policy, routing, safety checks, and verifier shims.

Pi's session model is also well suited to long-horizon work. Sessions are stored as trees; `/tree` lets you branch in-place, `/fork` and `/clone` create new session files, and extensions can create fresh sessions programmatically with `ctx.newSession()`. Pi also supports branch summaries when moving across session branches, and auto-compaction when context exceeds the threshold. Both compaction and branch summaries expose extension hooks, so you can replace Pi's summaries with your own structured project state if you want a more deterministic long-horizon memory layer.

Pi's persistence model is simple but useful. `appendEntry()` lets you store JSON-serialisable extension state inside the session log, but that state does **not** automatically participate in the LLM context. That is a feature, not a bug, for a local harness: you can keep a large verifier board, DAG state, trace metadata, and run metrics in session entries or files, and inject only the selected summary back into the model when needed.

Pi skills and packages are good enough to build a reusable extension ecosystem around your harness. Pi loads skills from `~/.pi/agent/skills/`, `~/.agents/skills/`, `.pi/skills/`, trusted `.agents/skills/` directories, package resources, settings, and explicit CLI paths. Skills follow the Agent Skills standard and load on demand rather than in full at startup. Pi packages can bundle extensions, skills, prompts, and themes via conventional directories or a `pi` manifest in `package.json`, and can be installed from npm, git, or local paths.

For MCP, the important fact is that Pi's **practical** ecosystem already has multiple community MCP bridges in the official package catalogue, including `pi-mcp-adapter`, `pi-mcp-extension`, `@spences10/pi-mcp`, `@pi-unipi/mcp`, and `pi-mcporter`. That suggests a healthy ecosystem, but it also suggests that MCP is currently realised mostly through extensions rather than through one obvious, documented first-party core subsystem. For your harness, that means you should design your MCP layer as a pluggable adapter boundary, not assume one blessed implementation will be stable forever.

## Patterns worth copying from other agents

Claude Code's best ideas are its **deterministic hooks**, **on-demand skills**, and **isolated subagents**. Hooks can be shell commands, HTTP endpoints, prompt-based checks, agent-based verifiers, or MCP tool hooks; they receive structured JSON context and can be filtered by matcher. Skills live in project, personal, or plugin scopes, load on demand, support dynamic context injection with `!` command expansion, and can even run in a forked subagent context. Claude also cleanly separates persistent project guidance in `CLAUDE.md` from auto-written memory, and its permissions system distinguishes baseline policy from higher-order behaviour guidance. Those are exactly the right abstractions for building verification gates, ephemeral research workers, and a portable skills layer.

Codex's best ideas are **hierarchical project instructions**, **goal mode**, **tool-rewriting hooks**, **plugin packaging**, and the split between **sandbox policy** and **approval reviewer**. Codex loads `AGENTS.md` from global scope and from each directory from repo root to the current working directory. Its hooks can add developer-visible context, deny actions, or rewrite supported tool inputs. Its plugins are the distribution unit for skills, MCP servers, hooks, and apps. And its `/goal` feature explicitly frames long-running work as a durable objective with a validation loop and a verifiable stopping condition. For your Pi harness, that means your orchestrator should promote a goal object to a first-class entity, and every task should carry its own validator.

Hermes contributes the most useful ideas for **long-horizon persistence**. It separates `SOUL.md` identity from project `AGENTS.md`, supports isolated profiles with their own config, skills, sessions, and memory, has a durable Kanban board for multi-agent collaboration, and runs a curator pass that stops agent-created skills from accumulating into a mess. Its delegation tool spawns child agents with isolated context and toolsets, while its memory-provider architecture keeps built-in memory active and layers external providers on top. For your harness, the two patterns to steal are: keep **identity, policy, and project context separate**, and maintain a **durable board outside the live chat transcript**.

OpenHands and the SWE-agent family contribute the strongest architectural lessons. OpenHands V1 explicitly favours optional isolation over mandatory sandboxing, one mutable source of truth for state, strict separation between agent core and applications, and declarative composition of tools, prompts, LLMs, and contexts. SWE-agent shows the value of a single YAML-configured control plane plus demonstrations and trajectories as reusable behavioural assets. mini-SWE-agent goes even further: bash-only action, linear history, and stateless subprocess execution. For a small local model, those are not academic niceties; they are exactly the simplifications that reduce hidden state and improve recoverability.

The synthesis is straightforward. Copy **Claude's hookable lifecycle**, **Codex's durable goals and approval reviewer**, **Hermes' board and curator mindset**, **OpenHands' state separation**, and **mini-SWE-agent's ruthless simplicity around execution**. Do **not** copy heavy always-on subagent swarms, opaque memory magic, or mandatory container indirection for every step. Those help frontier models more than they help small local ones.

## Implementation-ready TypeScript architecture

The architecture I recommend is a **Pi package** called `@your-scope/pi-longhorizon` with one bootstrap extension and a set of internal modules. Pi should remain the runtime host; your package should add higher-order orchestration, persistent state, verification, memory selection, and external review routing. This fits naturally with Pi's package conventions and dynamic extension model.

```text
@your-scope/pi-longhorizon/
|- package.json
|- packages/extensions/src/
|  `- longhorizon.ts              # Pi entrypoint
|- packages/kit/skills/
|  |- plan-spec/
|  |  `- SKILL.md
|  |- write-implementation/
|  |  `- SKILL.md
|  |- verify-change/
|  |  `- SKILL.md
|  `- generate-skill/
|     `- SKILL.md
|- packages/kit/prompts/
|  |- planner.md
|  |- reviewer.md
|  `- verifier.md
`- src/
   |- core/
   |  |- goal-manager.ts
   |  |- dag-dispatcher.ts
   |  |- verifier-board.ts
   |  |- provider-router.ts
   |  |- session-brancher.ts
   |  |- context-selector.ts
   |  |- trace-recorder.ts
   |  `- state-store.ts
   |- hooks/
   |  |- input-router.ts
   |  |- tool-guard.ts
   |  |- compact-hook.ts
   |  `- provider-payload.ts
   |- commands/
   |  |- goal.ts
   |  |- plan.ts
   |  |- run.ts
   |  |- verify.ts
   |  |- review.ts
   |  |- branch.ts
   |  |- trace.ts
   |  `- skillgen.ts
   |- mcp/
   |  |- registry.ts
   |  |- adapters.ts
   |  `- bridge-tools.ts
   `- types/
      `- state.ts
```

The control flow should work like this. A user creates or resumes a **goal**. The goal manager writes the goal, constraints, acceptance tests, and preferred model policy into `.agent/goals/` and a mirrored compact state entry via `appendEntry()`. The DAG dispatcher expands that goal into small tasks with explicit dependencies and validators. The provider router decides whether each task runs on the local model or escalates to a remote planner or reviewer. The verifier board watches all file-changing work and forces each task through one or more validators before it is marked done. Meanwhile, the trace recorder keeps a machine-readable log outside the prompt, while the context selector injects only the minimum necessary state back into the next model turn. This is essentially Codex goal mode plus Hermes Kanban plus Claude hook gates, implemented with Pi's event system rather than with a separate daemon.

### Extension set

The following extension set is concrete enough to implement immediately.

| Extension | Responsibility | Input | Output | State files | Slash / CLI surface |
|---|---|---|---|---|---|
| `goal-core` | Owns durable goals, acceptance criteria, constraints, stop conditions | User objective, repo context, acceptance tests | Goal record, live status summary | `.agent/goals/*.json`, `.agent/index/goals.json` | `/goal`, `/goal-status`, `/goal-pause`, `/goal-clear` |
| `task-graph` | Breaks goals into a dependency DAG and schedules runnable tasks | Goal record, changed files, verifier status | Runnable task queue, blocked edges | `.agent/tasks/*.json`, `.agent/index/tasks.json` | `/plan`, `/next`, `/task-show`, `/task-requeue` |
| `context-sieve` | Injects only relevant context into prompts (no custom compaction summaries) | Task ID, changed files, branch state | Prompt appendix | `.agent/context/cache/*.json` | implicit, plus `/ctx-show` |
| `tool-firewall` | Intercepts and rewrites risky tool calls; routes mandatory wrappers | Tool call event | Allowed call, rewritten call, or block reason | `.agent/policy/audit.log` | `/policy`, `/policy-diff` |
| `verifier-board` | Tracks validators for each task and branch | Task completion candidate, changed files | pass/fail/flaky/deferred verdicts | `.agent/verifiers/*.json`, `.agent/index/verifiers.json` | `/verify`, `/verify-all`, `/failures` |
| `branch-lab` | Creates isolated Pi sessions for risky experiments and review lanes | Parent session, task or branch label | New Pi session with handoff summary | `.agent/branches/*.json` | `/branch`, `/branch-review`, `/branch-merge-note` |
| `remote-review` | Sends selected artefacts to a frontier model for planning or critique | Goal spec, patch, failing test bundle | Plan markdown, review findings | `.agent/reviews/*.json` | `/review`, `/review-plan`, `/escalate` |
| `skill-forge` | Generates or patches reusable skills from solved work | Trace bundle, validator results | New SKILL.md or skill patch | `.agent/skillgen/*.json`, `.agents/skills/*` | `/skillgen`, `/skill-patch` |
| `trace-ledger` | Records decisions, tool calls, timings, costs, and outcomes | Pi lifecycle events | NDJSON traces and summary manifests | `.agent/traces/*.ndjson`, `.agent/traces/index.json` | `/trace`, `/trace-export` |
| `mcp-router` | Normalises external MCP tool exposure and usage policy | MCP registry config, tool result | Stable internal tool aliases | `.agent/mcp/registry.json` | `/mcp-sync`, `/mcp-health` |

### Model routing policy

Use this routing matrix.

| Work type | Default model | Escalation trigger | Escalated model |
|---|---|---|---|
| File reads, grep, ls, small edits | local small model | none | none |
| Goal decomposition | remote optional | goal > 5 tasks or ambiguous acceptance criteria | remote planner |
| Large refactor plan | remote optional | cross-package or migration work | remote planner |
| Code writing after approved plan | local small model | repeated verifier failures | remote reviewer, then back local |
| Security review or high-risk shell plan | remote optional | policy class high | remote reviewer |
| Final merge/readiness review | remote optional | always for non-trivial goals | remote reviewer |

That policy preserves local-first economics while keeping the small model away from the tasks where it fails most often: planning under ambiguity, cross-file review, and "am I actually done?" judgement. Pi's provider flexibility makes this practical.

## Build roadmap and repository layout

### MVP

Ship four things only: `goal-core`, `tool-firewall`, `verifier-board`, and `trace-ledger`. Register `/goal`, `/verify`, `/trace`, and `/plan`. Use Pi's built-in branching and compaction rather than replacing them. Do not add automatic sub-sessions yet. Do not add external MCP orchestration beyond one chosen community MCP bridge. This is the smallest version that already beats a plain local coding agent for long tasks because it adds durable objectives, validator discipline, and replayable traces. Pi already supports the necessary commands, tool interception, session storage, and compaction hooks.

### First production release

Add `task-graph`, `context-sieve`, and `branch-lab`. This is where the harness becomes truly long-horizon: every goal becomes a DAG, each risky task can branch into a clean Pi session using `ctx.newSession()`, and the context selector starts writing custom compaction summaries so the local model sees stable, structured state instead of noisy conversational residue. Also add a lightweight AGENTS-compatible project bootstrap so the same repo guidance is useful in Pi, Codex, Hermes, and Claude-derived tools.

### Second production release

Add `remote-review` and `skill-forge`. The planner and reviewer lanes are optional and off by default. When enabled, the harness should escalate only the goal spec, compacted branch summary, changed files, and verifier evidence, not the full raw transcript. Then use solved traces plus passing verifiers to synthesise new portable skills under `.agents/skills/`. This is where you start compounding capability instead of just preserving progress. The design is directly inspired by Claude's forked-skill execution, Codex goal mode, and Hermes's skill-curation loop.

### Advanced lane

Add `mcp-router`, a policy engine for trusted/untrusted MCP servers, and a detached external orchestrator that can supervise multiple Pi sessions through RPC or JSON event streaming rather than only through in-process extension logic. Also add replay-based evals that run saved traces and task DAGs against fixed repos. This is the point where you begin borrowing more from OpenHands' clean separation of agent core, workspace, and application surfaces, while remaining Pi-native at the user interface layer.

### Recommended folder structure

Use a dual layout: **Pi-native files where Pi expects them**, and **harness-native files in `.agent/`**.

```text
repo/
|- AGENTS.md
|-.pi/
|  |- settings.json
|  |- packages/extensions/src/
|  |  `- bootstrap.ts
|  |- packages/kit/prompts/
|  `- packages/kit/themes/
|-.agents/
|  `- packages/kit/skills/
|     |- plan-spec/
|     |  `- SKILL.md
|     |- verify-change/
|     |  |- SKILL.md
|     |  `- scripts/
|     `- generate-skill/
|        `- SKILL.md
|-.agent/
|  |- goals/
|  |- tasks/
|  |- verifiers/
|  |- branches/
|  |- memories/
|  |  |- project-summary.md
|  |  |- decisions.md
|  |  `- failure-patterns.md
|  |- packages/kit/prompts/
|  |- workflows/
|  |- evals/
|  |- traces/
|  |- mcp/
|  |- cache/
|  `- state/
`- src/
```

Use `AGENTS.md` for repo rules, conventions, commands, ports, and definition of done. Use `.agents/skills/` for portable, on-demand procedures that can be reused outside Pi. Use `.agent/` for harness internals that should **not** be auto-loaded wholesale into every model turn. This split lines up well with Pi's skill discovery, Codex's `AGENTS.md`, Claude's distinction between persistent instructions and skills, and Hermes' split between project context and durable identity/memory.

## Pi-specific risks, workarounds, and pseudocode

The main Pi-specific risk is that its raw primitives are powerful enough to hurt you if you treat them like a fully opinionated orchestration framework. Three examples matter most. First, `tool_call` input is mutable and no re-validation happens after mutation, so your own rewrite layer must validate again before allowing execution. Second, sibling tool calls in the same assistant message are preflighted sequentially but executed concurrently, so you cannot safely assume one sibling's result is visible to another in the same turn. Third, session replacement has footguns: `ctx.newSession()` gives you a fresh replacement-session context, and reusing stale captured objects is explicitly unsafe.

The next risk is context drift. `appendEntry()` persistence does not reach the model automatically, `before_provider_request` payload rewrites are invisible to `ctx.getSystemPrompt()`, and Pi's compaction is general-purpose rather than goal-aware unless you override it. The workaround is to make your `.agent/` store the canonical state, then have one deterministic "context sieve" module construct the model-visible state at `before_agent_start`, `context`, and `session_before_compact`. In other words, do not let the raw transcript become your source of truth.

There is also an ecosystem risk around MCP. Pi's catalogue clearly has active MCP bridges, but they are multiple community packages rather than one obvious canonical implementation. Treat that as a portability boundary: wrap whichever MCP bridge you choose behind your own stable internal alias layer and record bridge results in traces so you can swap later.

A final operational risk is trust and package execution. Pi packages and extensions can execute arbitrary code and Pi asks for trust before loading project-local resources and packages. Your harness should therefore keep the minimum bootstrap in trusted `.pi/`, while storing most mutable logic and state in your own package and `.agent/` directory. For teams, publish your harness as a Pi package and treat project-local extensions as thin configuration only.

### Goal manager pseudocode

```ts
// src/core/goal-manager.ts
export type GoalStatus = "active" | "paused" | "done" | "failed";

export interface Goal {
  id: string;
  title: string;
  objective: string;
  constraints: string[];
  acceptance: string[];
  status: GoalStatus;
  createdAt: number;
  updatedAt: number;
  currentTaskIds: string[];
}

export class GoalManager {
  constructor(
    private readonly store: StateStore,
    private readonly pi: ExtensionAPI,
  ) {}

  async createGoal(input: {
    title: string;
    objective: string;
    constraints?: string[];
    acceptance?: string[];
  }): Promise<Goal> {
    const goal: Goal = {
      id: crypto.randomUUID(),
      title: input.title,
      objective: input.objective,
      constraints: input.constraints ?? [],
      acceptance: input.acceptance ?? [],
      status: "active",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      currentTaskIds: [],
    };

    await this.store.writeJson(`goals/${goal.id}.json`, goal);
    this.pi.appendEntry("agent-goal", {
      goalId: goal.id,
      title: goal.title,
      status: goal.status,
    });
    this.pi.setSessionName(goal.title);
    return goal;
  }

  async setStatus(goalId: string, status: GoalStatus): Promise<void> {
    const goal = await this.store.readJson<Goal>(`goals/${goalId}.json`);
    goal.status = status;
    goal.updatedAt = Date.now();
    await this.store.writeJson(`goals/${goal.id}.json`, goal);
    this.pi.appendEntry("agent-goal-status", { goalId, status, ts: Date.now() });
  }

  async buildModelSummary(goalId: string): Promise<string> {
    const goal = await this.store.readJson<Goal>(`goals/${goalId}.json`);
    return [
      `Goal: ${goal.objective}`,
      `Constraints: ${goal.constraints.join("; ") || "none"}`,
      `Acceptance: ${goal.acceptance.map((x, i) => `${i + 1}. ${x}`).join(" ") || "none"}`,
      `Open tasks: ${goal.currentTaskIds.length}`,
      `Status: ${goal.status}`,
    ].join("\n");
  }
}
```

This maps cleanly onto Pi because `appendEntry()` gives you durable non-context state, while `setSessionName()` and `before_agent_start` can turn the active goal back into concise prompt context when needed.

### Task DAG dispatcher pseudocode

```ts
// src/core/dag-dispatcher.ts
export type TaskStatus = "queued" | "running" | "blocked" | "passed" | "failed";

export interface TaskNode {
  id: string;
  goalId: string;
  title: string;
  prompt: string;
  dependsOn: string[];
  validators: string[];
  status: TaskStatus;
  branchSession?: string;
}

export class DagDispatcher {
  constructor(
    private readonly store: StateStore,
    private readonly brancher: SessionBrancher,
    private readonly router: ProviderRouter,
  ) {}

  async runnable(goalId: string): Promise<TaskNode[]> {
    const tasks = await this.store.globJson<TaskNode>(`tasks/${goalId}/*.json`);
    const done = new Set(tasks.filter(t => t.status === "passed").map(t => t.id));
    return tasks.filter(
      t => t.status === "queued" && t.dependsOn.every(dep => done.has(dep)),
    );
  }

  async dispatchNext(goalId: string, ctx: ExtensionContext): Promise<void> {
    const [task] = await this.runnable(goalId);
    if (!task) return;

    task.status = "running";
    await this.store.writeJson(`tasks/${goalId}/${task.id}.json`, task);

    const lane = await this.router.pickLane(task);
    if (lane === "branch") {
      const result = await this.brancher.spawnTaskSession(ctx, task);
      task.branchSession = result.sessionFile;
      await this.store.writeJson(`tasks/${goalId}/${task.id}.json`, task);
      return;
    }

    await ctx.sendUserMessage(
      `Execute task ${task.title}\n\n${task.prompt}`,
      { deliverAs: "followUp" },
    );
  }
}
```

The key choice here is that risky or noisy tasks can be pushed into a fresh Pi session rather than remaining in the main transcript, which is exactly what Pi's session tree and `ctx.newSession()` are good at.

### Verifier board pseudocode

```ts
// src/core/verifier-board.ts
export type Verdict = "pass" | "fail" | "flaky" | "deferred";

export interface VerificationRecord {
  taskId: string;
  verifier: string;
  command: string;
  verdict: Verdict;
  summary: string;
  ts: number;
}

export class VerifierBoard {
  constructor(private readonly store: StateStore) {}

  async run(task: TaskNode, shell: ShellRunner): Promise<Verdict> {
    let final: Verdict = "pass";

    for (const verifier of task.validators) {
      const command = this.lookup(verifier, task);
      const result = await shell.exec(command, { timeoutMs: 120_000 });

      const verdict: Verdict =
        result.code === 0 ? "pass":
        /timeout|flaky/i.test(result.stderr + result.stdout) ? "flaky":
        "fail";

      const rec: VerificationRecord = {
        taskId: task.id,
        verifier,
        command,
        verdict,
        summary: (result.stdout + "\n" + result.stderr).slice(0, 4000),
        ts: Date.now(),
      };

      await this.store.appendNdjson(`verifiers/${task.goalId}.ndjson`, rec);

      if (verdict === "fail") return "fail";
      if (verdict === "flaky") final = "flaky";
    }

    return final;
  }

  private lookup(name: string, task: TaskNode): string {
    const map: Record<string, string> = {
      lint: "npm run lint",
      typecheck: "npm run typecheck",
      test: "npm test -- --runInBand",
      build: "npm run build",
    };
    return map[name] ?? name;
  }
}
```

This is the core of the "small local model with hard validators" strategy: the model proposes changes, but the board decides whether the task advances. That is the most important guardrail borrowed from Codex goal mode and Claude agent hooks.

### Skill generator pseudocode

```ts
// src/core/skill-generator.ts
export class SkillGenerator {
  constructor(
    private readonly store: StateStore,
    private readonly remoteReviewer: RemoteReviewer,
  ) {}

  async suggestFromTrace(traceId: string): Promise<void> {
    const trace = await this.store.readJson<any>(`traces/${traceId}.json`);
    const passingPatterns = trace.steps.filter((s: any) => s.verdict === "pass");

    if (passingPatterns.length < 3) return;

    const prompt = [
      "Turn this repeated successful workflow into an Agent Skills-compatible SKILL.md.",
      "Keep it concise, procedural, and reusable.",
      "Include when-to-use, inputs, steps, validation, and failure signals.",
      JSON.stringify(passingPatterns.slice(-8), null, 2),
    ].join("\n\n");

    const draft = await this.remoteReviewer.generateSkill(prompt);
    const slug = this.slugify(trace.title);
    await this.store.writeText(`../.agents/skills/${slug}/SKILL.md`, draft);
  }

  private slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }
}
```

This deliberately writes to `.agents/skills/` rather than to opaque internal storage, because Pi, Claude, and Hermes all understand on-demand skills, and Codex treats skills as the authoring format even when plugins are the installable unit.

### Trace recorder pseudocode

```ts
// src/core/trace-recorder.ts
export interface TraceEvent {
  ts: number;
  kind:
    | "agent_start"
    | "turn_end"
    | "tool_call"
    | "tool_result"
    | "verify"
    | "review"
    | "compact";
  goalId?: string;
  taskId?: string;
  data: Record<string, unknown>;
}

export class TraceRecorder {
  constructor(private readonly store: StateStore) {}

  async record(ev: TraceEvent): Promise<void> {
    const day = new Date(ev.ts).toISOString().slice(0, 10);
    await this.store.appendNdjson(`traces/${day}.ndjson`, ev);
  }

  async summarizeRecent(goalId: string): Promise<string> {
    const events = await this.store.readRecentNdjson<TraceEvent>("traces", 500);
    const related = events.filter(e => e.goalId === goalId);
    const toolCalls = related.filter(e => e.kind === "tool_call").length;
    const verifierFails = related.filter(
      e => e.kind === "verify" && e.data["verdict"] === "fail",
    ).length;

    return [
      `Recent events: ${related.length}`,
      `Tool calls: ${toolCalls}`,
      `Verifier failures: ${verifierFails}`,
      `Last event: ${related.at(-1)?.kind ?? "none"}`,
    ].join("\n");
  }
}
```

Pi's lifecycle events make this easy to wire up: `agent_start`, `turn_end`, `tool_call`, `tool_result`, `session_before_compact`, and your own custom verifier events are enough to produce replayable traces and simple eval fixtures.

## Open questions and limitations

The biggest unresolved Pi-specific question is **which MCP bridge to standardise on**. The official Pi docs and package catalogue show an active MCP ecosystem, but the ecosystem currently looks extension-led rather than anchored on a single, clearly dominant first-party implementation. I would therefore choose one bridge for MVP, wrap it behind your own adapter layer, and leave swap-ability as an explicit design goal.

The second limitation is that Pi gives you the primitives for orchestration, but not a baked-in "goal board" abstraction like Hermes Kanban or Codex `/goal`. That is why the harness above creates its own first-class goal, task, verifier, branch, and trace state in `.agent/` and mirrors only selected summaries into the session. In practice, that is not a blocker; it is the right architecture for small local models because it keeps the transcript thin and the state explicit.
