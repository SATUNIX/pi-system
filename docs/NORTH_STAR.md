# North Star — the pi agent capability system

> **Lives at:** `pi-system/docs/NORTH_STAR.md` (the deploy repo links to it).
> **Sits above:** `docs/PI_KIT_REPO_PLAN.md` (how the repo is built) — this document is *why it exists and what it must become*.
> **Research basis:** the four documents in `docs/research/`, referenced inline:
> - `docs/research/durable-memory-and-workflow.md` — memory layers, task model, handoff, skill lifecycle, context-loading policy, MCP/SQLite/JSONL server. *(R1)*
> - `docs/research/local-first-pi-harness.md` — Pi as control plane + TypeScript orchestration, two-tier planner/executor, extension set, model routing. *(R2)*
> - `docs/research/verification-driven-harnesses.md` — layered verifier stack, recovery policy, trace schema, local benchmark suite, self-improvement loop, scoring rubric. *(R3)*
> - `docs/research/harness-engineering-long-horizon.md` — six-layer harness taxonomy, what leading harnesses add, long-horizon benchmark reality, reference architecture. *(R4)*

---

## 1. The North Star

**Build a local-first, portable, self-improving capability layer for the `pi` coding agent that makes a small local model dependable on both quick tasks and long, difficult, multi-file coding work — specialised to my repos, my languages, and my offensive-security domain — and that can be loaded onto any pi installation by cloning one repo.**

The thesis from the research is the reason this project exists: **reliability is now shaped at least as much by the harness as by the base model** (R3, R4). A carefully engineered harness can make a smaller, cheaper, fully-local model competitive far beyond its raw benchmark profile (R4). I am not chasing global model parity; I am chasing **task-shaped superiority** — beating out-of-the-box Codex or Claude Code *on my work*: my repos, languages, CI rules, tools, review criteria, and failure patterns (R4).

The win condition is not "more prompting." It is better decomposition, better durable state, better verifiers, better recovery loops, better observability, and reusable expertise packaged as skills and extensions (R3, R4).

---

## 2. Why two repos (and why this separation is load-bearing)

| Repo | Role | Analogy | Changes |
|---|---|---|---|
| **`pi-system`** | The **capability layer**: extensions, vendored/adapted upstream extensions, skills, prompt templates, profiles, the modifiable corpus, and the install/validation toolchain. | The *behaviour and knowledge*. | Often; experiment freely on branches. |
| **`pi-system`** | The **deployable substrate**: a containerised package of pinned pi **core**, base config, an entrypoint that bolts on the kit, healthcheck, build/release. | The *runnable body*. | Rarely; kept stable. |

**The boundary is the point.** Behaviour/knowledge lives in the kit; the runnable container lives in the deploy repo; the kit bolts onto *any* pi installation (the container, my laptop, a teammate's machine, CI) via pi's native package mechanism — `pi install` from local path, git, or project auto-install (see `PI_KIT_REPO_PLAN.md`). The kit never depends on the deploy repo. This is the local-first lesson from R2/R4: keep the substrate replaceable and the capability portable, so the same harness rides on top of whatever model/runtime is underneath.

This separation also encodes the strongest cross-vendor pattern in the research: **separate stable, version-controlled, reviewable instruction from cheap, iterable learned recall** (R1). Policy and capability are reviewed like code (the kit); operational state and memory iterate cheaply (the corpus + memory stores).

---

## 3. First principles (the design rules the whole system obeys)

Synthesised from R1–R4; every extension and profile must respect these.

1. **The harness is a first-class system layer, not a wrapper.** Optimise execution, context, memory, verification, recovery, and observability — not just the prompt (R4).
2. **Separate stable instruction from learned recall.** Policy/identity in versioned files; memory as a cheap, selectively-retained recall layer (R1).
3. **Progressive disclosure everywhere.** Load skill *names* at startup, bodies on demand; load memory *index*, details on trigger; load raw evidence only after tool evidence says it matters (R1, R4).
4. **Never confuse the trace with the active context.** Keep an append-only trace (JSONL); inject only selected summaries into the model. Files = human-reviewed durable knowledge, SQLite = operational state, JSONL = trace, vectors = retrieval acceleration (R1, R2).
5. **Every long task needs an explicit objective object.** A goal with a verifiable definition-of-done and per-task validators, restartable by a fresh agent from the working tree + the goal file alone (R1, R2, R4).
6. **The model never self-certifies "done."** A layered verifier stack decides task advancement, cheapest checks first, escalating only on uncertainty (R3).
7. **Recovery is evidence-driven, not retry-until-broke.** Replan / fork / rollback / escalate based on the *kind* of failure, on a bounded budget. Good verifiers beat blind retries (R3).
8. **Isolated workers, not one giant context.** Subagents / branches / worktrees for exploration, review, and risky edits — context isolation is the #1 lever for long tasks (R1, R4).
9. **DAG-capable, not DAG-obsessed.** Scale orchestration to the task. Simple scaffolds win for short tasks; pay for orchestration only when it buys information or control (R4).
10. **Two-tier model routing.** Small local model on the hot path (read, edit, shell, quick tasks); reserve a stronger remote (or second local) model for the three jobs small models fail most: goal decomposition, cross-file review, and "am I actually done?" triage (R2, R4).
11. **The harness improves itself from its own traces.** Mine weaknesses, propose small falsifiable harness edits, regression-test on a held-out split, promote only on gains (R3, R4).
12. **Specialise ruthlessly.** Tune to the work I actually do — my repos and offensive-security domain — because that is where a local stack can beat frontier defaults (R4).
13. **General capability lives in the kit; domain specifics layer on top via composition, never welded in.** If a capability is needed by more than one domain or more than one profile, it belongs in the kit as a general extension. Domain-specific rules (e.g., pentest scope/ROE, engagement approval cards) live in a domain extension that *composes* the general one — never reimplementing its logic. Per-engagement values (target lists, testing windows, specific scope for a job) live in the deploy repo's engagement config, never in the capability layer. This is the unifying rule behind tool-firewall/pentest-governance-domain separation, the memory/task MCP server ownership, and the context-sieve coordinator pattern. (ADR-D2, ADR-D3, ADR-D6)

---

## 4. The capability ladder (the levels I'm climbing)

Five tiers. Each is independently useful; each maps to extensions (§6) and profiles (§7). The agent should be excellent at the lower tiers before the higher ones are trusted.

| Tier | Name | The agent can… | Gated by |
|---|---|---|---|
| **T0** | **Safe substrate** | Not damage the repo or leak secrets; every action is checkpointed and recoverable; progress survives crashes. | guards + checkpoints + auto-commit |
| **T1** | **Durable quick-task agent** | Do fast, correct, low-ceremony edits; remember project facts across sessions; keep context lean. Beats a plain local agent on short tasks *without* added latency. | memory + handoff + context hygiene |
| **T2** | **Verified agent** | Never declare victory on broken code; run a layered verifier stack and self-correct from the feedback. | verify-gate → verifier-board |
| **T3** | **Long-horizon agent** | Hold an explicit goal + plan + task DAG; persist state to survive context resets; isolate risky work in branches/worktrees; run autonomous multi-hour/day loops; recover by evidence; produce handoff packets. | goal-core + task-graph + branch-lab + autonomous-loop |
| **T4** | **Self-improving specialist** | Record and score every run; mine failures; synthesise/curate skills; route hard jobs to a stronger reviewer; improve its own harness against a local benchmark suite; excel in my offensive-security domain. | trace-ledger + benchmark suite + skill-forge + self-improvement loop |

> The long-horizon benchmark reality (R3, R4) is the honest backdrop: agents that score well on narrow issue-resolution benchmarks still fall sharply on extended, multi-file evolution (e.g. ~65% on SWE-bench Verified → ~21% on SWE-EVO; leading systems under 25% pass@1 on SWE-Bench Pro; frontier agents below ~65% on Terminal-Bench 2.0). T3–T4 is genuinely hard; the ladder is how I get there without over-engineering T0–T1.

---

## 5. The six-layer architecture (mapped onto pi-kit)

The harness taxonomy from R4, with the memory model from R1, realised as pi extensions. Pi gives the primitives (TypeScript extensions, lifecycle hooks, tool interception, session trees + branch summaries + compaction hooks, `appendEntry` persistence, packages/skills) and deliberately ships *without* MCP, subagents, plan mode, or to-dos — so these layers are mine to build (R2, R4).

1. **Execution substrate** — isolation, writable-root/network policy, checkpoint, rollback, worktrees/containers as first-class APIs (R4). → guards, checkpointing, branch/worktree manager.
2. **Tool surface** — few, typed, observable tools; tool-call interception/rewrite with re-validation after mutation (a Pi footgun, R2); MCP behind a stable adapter boundary since pi's MCP is community-bridge-led, not first-party (R2, R4).
3. **Context & memory** — the seven-layer model from R1: identity (human-edited), policy (`AGENTS.md`), procedural (skills), semantic project memory (Markdown topic files + index), episodic task memory (summaries), trace (JSONL), retrieval (vector index over the above). Plus a context sieve that builds the model-visible state and overrides compaction (R1, R2).
4. **Orchestration** — explicit goals, a task DAG with a Kanban projection, isolated workers, the autonomous completion loop, and two-tier model routing (R1, R2, R4).
5. **Verification** — the monotonic-cost stack: cheap static gates → executable tests → process critic over trace rubrics → independent spec + quality reviewers → application/behavioural QA → search/branching for hard tasks (R3).
6. **Observability & self-improvement** — structured traces per turn, a local benchmark suite from my own repos, a skill forge + curator, and the weakness-mining → falsifiable-edit → regression-test → promote loop with a weighted scoring rubric (R3, R4).

---

## 6. The extension catalog (what's in the kit, and who builds it)

Organised by layer, tagged with the capability **tier** it unlocks and the **source** avenue (per `PI_KIT_REPO_PLAN.md`: `vendor` = adapt upstream, `build` = my custom code, `external` = its own repo bolted on). Status is the live tracker's job; this is the target set.

### Layer 1 — Execution substrate
| Extension | Tier | Source | Purpose |
|---|---|---|---|
| `secret-guard` | T0 | build | Block writing/committing secrets (`.env`, `*.key`, `*.pem`, creds). |
| `protected-paths` | T0 | vendor | Block writes to protected paths. |
| `dirty-repo-guard` | T0 | vendor | Force clean checkpoints between phases. |
| `git-checkpoint` | T0 | vendor | Per-turn stash checkpoint — instant rollback. |
| `auto-commit-on-exit` | T0 | vendor | Progress survives in git history. |
| `branch-lab` / worktree manager | T3 | build | Isolated pi sessions / git worktrees / containers per risky task (R2, R4). |

### Layer 2 — Tool surface
| Extension | Tier | Source | Purpose |
|---|---|---|---|
| `tool-firewall` / `permission-gate` | T0 | build/vendor | Intercept, re-validate (mutation footgun), rewrite or block risky tool calls; audit log (R2). |
| `mcp-router` | T3 | build/external | Normalise MCP tools behind stable internal aliases; record results in traces; swappable bridge (R2, R4). |

### Layer 3 — Context & memory
| Extension | Tier | Source | Purpose |
|---|---|---|---|
| `guidelines` | T1 | build | Always-on engineering rules appended to system prompt (Karpathy-style). |
| `todo` | T1 | vendor | Durable task list across turns. |
| `handoff` | T1 | vendor | Compress a session to resume fresh / pass to another agent (R1). |
| `custom-footer` / `status-line` | T1 | vendor | Glanceable state on long runs. |
| `spec-plan` | T1→T3 | build | Maintain `PLAN.md`; inject current plan; agent checks off steps (R1, R4). |
| `trigger-compact` + `custom-compaction` | T1 | build/vendor | Auto-compact at threshold; keep the right detail (R1). |
| `context-sieve` | T3 | build | Deterministically build model-visible state at `before_agent_start`/`context`/`session_before_compact`; the antidote to context drift (R2). |
| `memory-local` | T1 | build | Local JSONL + LM Studio embeddings: project facts recalled across sessions, no infra. |
| `memory-mem0` / memory+task **MCP server** | T1→T4 | build/external | The R1 server: SQLite (canonical operational state) + JSONL (trace) + Markdown topic files + vector index, exposed over MCP so pi/Claude Code/Codex can share it. |

### Layer 4 — Orchestration
| Extension | Tier | Source | Purpose |
|---|---|---|---|
| `goal-core` | T3 | build | First-class durable goal: objective, constraints, acceptance tests, stop condition; `/goal` (R1, R2, R4). |
| `task-graph` | T3 | build | Goal → dependency DAG with a Kanban projection; recursive but bounded decomposition; ready-task scheduling (R1, R4). |
| `subagent` | T3 | vendor | Delegate isolated subtasks to fresh-context workers (R4). |
| `autonomous-loop` | T3 | build | Ralph-Wiggum completion loop: implement → commit → verify → fix until done or capped; manual launch by default. |
| `provider-router` | T3 | build | Two-tier routing: local model hot path, remote/second-local for decomposition, review, and done-triage (R2, R4). |

### Layer 5 — Verification
| Extension | Tier | Source | Purpose |
|---|---|---|---|
| `verify-gate` | T2 | build | After edits, run the project's typecheck/lint/test in background; feed failures back as steering (R3). |
| `verifier-board` | T2→T3 | build | The full monotonic stack with verdicts (pass/fail/flaky/deferred); the model never advances a task unilaterally (R3). |
| `dual-review` | T2→T4 | build | Independent **spec reviewer** + **quality reviewer** (second model); no agent verifies its own work (R3). |
| `remote-review` / `escalate` | T3 | build | Send goal spec + compacted summary + diff + verifier evidence (not the raw transcript) to a frontier model for plan/critique (R2, R4). |

### Layer 6 — Observability & self-improvement
| Extension | Tier | Source | Purpose |
|---|---|---|---|
| `trace-ledger` | T2→T4 | build | Append structured events (tools, files, branch, verdicts, retries, cost, stop reason) to JSONL + SQLite summary; the substrate for everything in T4 (R3, R4). |
| local **benchmark suite** | T4 | build | Four+ lanes from my own repos (issue repair, refactor/migration, code review, behavioural QA, **offensive-security tooling**); fresh, contamination-resistant, SWE-rebench-style harvested fixtures (R3). |
| `skill-forge` + curator | T4 | build | Synthesise skills from repeated successful traces; validate, score (trigger precision/utility/freshness/safety), patch over rewrite, archive stale, never auto-delete (R1, R3, R4). |
| self-improvement loop | T4 | build | Weakness-mining → falsifiable harness edit (change manifest) → held-out eval → promote-or-revert, with the weighted rubric (R3, R4). My AlphaEvolve-style ambition, made disciplined. |

---

## 7. Profiles (task-shaped, mapped to tiers)

Profiles are name-lists resolved across avenues (`PI_KIT_REPO_PLAN.md` §7). They exist because **orchestration should scale to the task** (principle 9): a quick fix must not pay long-horizon overhead.

| Profile | Tiers | For | Notes |
|---|---|---|---|
| `quick` | T0–T1 | Fast edits, low latency | Guards + checkpoints + memory + todo. No verifier ceremony beyond cheap gates, no orchestration. |
| `balanced` *(default)* | T0–T3 core | Everyday work | Adds guidelines, spec-plan, verify-gate, local memory, autonomous-loop (manual), compaction. |
| `long-horizon` | T0–T3 full | Multi-hour/day tasks | Adds goal-core, task-graph, subagent, branch-lab, verifier-board, context-sieve, provider-router. |
| `autonomous` | T0–T3 + loop | Set-and-walk-away | `long-horizon` with the autonomous loop armed + notify + tighter guards. |
| `self-improving` | T0–T4 | Research / harness evolution | Everything: trace-ledger, benchmark suite, dual/remote review, skill-forge, the improvement loop. Needs Docker + a second model. |

---

## 8. What Claude Code does — and what I port into pi-kit

Researched against current Claude Code (mid-2026). Claude Code is "batteries-included" where pi is deliberately minimal; its feature set is the **menu of capabilities to recreate as pi extensions**, since pi's philosophy is to add these yourself (R2, R4).

| Claude Code feature | What it is | pi-kit equivalent |
|---|---|---|
| **CLAUDE.md + auto memory** | Always-loaded human rules vs learned, index-loaded memory | `AGENTS.md` (policy) + `guidelines` + `memory-local`/memory server (R1) |
| **Skills** (unified with slash commands; frontmatter controls auto-invoke / manual `/name` / subagent execution; `$ARGUMENTS`, `${SKILL_DIR}`; progressive disclosure) | On-demand procedural packages | pi skills (open Agent Skills format — pi supports it natively) + `skill-forge` curator |
| **Hooks** (25 lifecycle points: `PreToolUse`, `UserPromptSubmit`, `PermissionRequest`, `Stop`/`SubagentStop`, `PreCompact`/`PostCompact`; command/HTTP/MCP/prompt/agent-based) | Deterministic enforcement | pi lifecycle hooks → `secret-guard`, `tool-firewall`, `verify-gate`, compaction overrides |
| **Subagents / agent teams** (isolated context, own prompt/tools/model, parallel, nested) | Context isolation | `subagent` + `branch-lab` (pi sessions/worktrees) |
| **Plan mode** | Read-only scoping before edits | `plan-mode` (vendor) + `spec-plan` + `goal-core` |
| **Checkpoints / compaction / background tasks** | Rollback, context management, async work | `git-checkpoint`, `trigger-compact`/`custom-compaction`, `verify-gate` background runs |
| **Plugins** (versioned bundle: skills + subagents + commands + hooks + MCP) | Distribution unit | the pi **package** itself = the kit (`PI_KIT_REPO_PLAN.md`) |
| **`/review`, `/security-review`, multi-agent review** | Independent review | `dual-review`, `verifier-board`, `remote-review` |
| **`opusplan` hybrid** (strong planner, cheaper executor) | Model role split | `provider-router` two-tier routing (R2, R4) |
| **Headless / one-shot CLI** (GitHub Action, scheduled, pre-commit) | Automation | pi RPC/print mode + the deploy container in CI |
| **Permission modes / sandboxing / Auto Mode** | Safety + unattended autonomy | `permission-gate`, container substrate, `autonomous` profile |

**Net:** pi-kit's job is to give a *local* pi agent the capability surface that makes Claude Code strong — memory split, on-demand skills, deterministic hooks, isolated workers, planning, layered review, hybrid model routing — while staying local-first, portable, and specialised to my domain.

---

## 9. What works for long-horizon coding (the synthesis I'm building toward)

The convergent lessons across R1–R4, condensed. These are the behaviours the system must exhibit; failures here are what the self-improvement loop hunts.

- **Stable instruction ≠ learned recall.** Reproducible rules in `AGENTS.md`/skills; discoveries in memory. Don't put ephemeral findings in policy files (R1).
- **Progressive disclosure or drown.** Long runs die from loading too much, too early, too often. Metadata first, bodies on trigger, raw evidence last (R1, R4).
- **Durable trace + compact summaries.** Append-only JSONL trace as source of truth; the active window stays small via summaries and retrieval (R1, R2).
- **Explicit objective object + per-task validators.** Restartable from the working tree and the goal file alone — assume no memory of prior plans (R1, R2).
- **Verifier stack, cheapest first.** Static → executable → critic → spec/quality reviewers → behavioural QA → search. No self-certification (R3).
- **Evidence-based recovery on a budget.** Wrong files → replan localisation; near-miss → fork small repairs; loop detected → halt + change strategy; broad risky edits → rollback + stricter gating; contradictory after two branches → escalate/abandon (R3).
- **Isolated workers for exploration/review/risky edits** (R1, R4).
- **DAG only where subproblems are independent; otherwise stay sequential and use fork/rollback** (R4).
- **Two-tier routing**: local hot path, stronger model for decomposition/review/done-triage (R2, R4).
- **Simplicity is competitive.** Minimal scaffolds (Agentless, mini-SWE-agent) score surprisingly high; only pay for orchestration that adds information or control (R3, R4).
- **The harness improves from traces, not vibes.** Gains transfer best from tools, middleware, and long-term memory — *not* from prompt-only edits (R3, R4).

---

## 10. The agent's job — behavioural contract & acceptance criteria

"Everything I expect the agent to do." This is the contract a `/goal` or evaluation can be written against. The agent's behaviour scales with task size, but the **always-on** rules never relax.

### Always (every task, every tier)
1. Never write or commit secrets; never write protected paths.
2. Checkpoint before risky operations; leave the repo recoverable.
3. State assumptions explicitly; make minimal, surgical changes.
4. Read failing output before patching; never retry an identical failing command.
5. Never declare "done" without passing the verifier stack appropriate to the task.
6. Keep the active context lean; push detail to trace/memory, not the prompt.
7. Emit a structured trace event for every meaningful action.
8. Surface blockers; ask for a human decision on irreducible ambiguity or boundary-crossing/unsafe actions rather than guessing.

### Quick tasks (T0–T1, `quick`/`balanced`)
- Minimal ceremony, low latency; correct and verified by cheap gates + targeted tests.
- Recall relevant project facts automatically (no re-explaining).
- One primary attempt; one corrective fork if a near-miss; then stop and report.

### Long-horizon tasks (T3, `long-horizon`/`autonomous`)
- Create/maintain a goal with a verifiable definition-of-done and per-task validators.
- Decompose into a bounded task DAG; schedule ready tasks; isolate risky work in branches/worktrees.
- Persist goal/plan/task/verifier/handoff state so a fresh agent resumes from files alone.
- Run the autonomous loop within `--max-iterations`; commit each round; stop on completion promise or cap.
- Recover by the evidence-based policy; escalate to remote review on repeated verifier failure or cross-file ambiguity.
- At compaction, write a structured summary; on stop/pause/handoff, emit a handoff packet (SQLite row + Markdown note + JSONL event) (R1).

### Self-improving (T4, `self-improving`)
- Record every run with a non-binary `success_score` (outcome + critic + regressions + retries + diff containment + time) (R3).
- Mine failure clusters; propose small, falsifiable harness edits as change manifests.
- Evaluate candidates on held-out + fresh splits; promote only on positive delta within the regression and efficiency budget; archive/revert otherwise (R3, R4).
- Synthesise and curate skills from repeated successes; prefer patching; archive stale, don't auto-delete.

### Acceptance criteria (how I'll know it's working)
- Beats a plain local pi agent on my local benchmark suite across all lanes.
- On quick tasks: faster *and* at least as correct as `balanced` with no orchestration overhead.
- On long-horizon tasks: completes representative multi-file tasks that the plain agent abandons or breaks, with full audit trail and clean recovery.
- Reaches **task-shaped superiority** over Codex/Claude Code defaults on my repos and my offensive-security tooling lane (R4).

---

## 11. Domain specialisation & the local benchmark suite

The differentiator is specialisation (principle 12). Beyond general SWE, the agent targets **offensive-security tooling**: building and iterating pentest/red-team tooling, API security testing harnesses, and bug-bounty automation — the work I actually do. This becomes a first-class benchmark lane and a skill domain, and over the long arc feeds the self-improving harness intended for handoff to **Hermes** (durable identity/board/curator patterns from R1/R4 already inform the design).

The benchmark suite (R3) is the measuring stick and the training ground, built SWE-rebench-style from my own history:

| Lane | Source | Success oracle |
|---|---|---|
| Issue repair | Past bugs/regressions in my repos | Reproduction test + regression suite |
| Refactor / migration | Past refactors, dependency upgrades | Snapshot + type + semantic-diff checks |
| Code review | Historic PRs + review comments | c-CRAB-style executable review / rubric match |
| Behavioural QA | User-visible changes, incident repros | Scripted CLI/API/browser flows |
| **Offensive-security tooling** | My pentest/API-testing tooling tasks | Tool runs correctly against a known target/range; output schema valid |

Keep three partitions: development (for tuning), held-out internal (for promotion decisions), and fresh rolling tasks (for contamination resistance) (R3).

---

## 12. Roadmap to the North Star

Tier-by-tier; aligns with `PI_KIT_REPO_PLAN.md` phases and the deploy repo's container work.

1. **T0 — Safe substrate.** Guards, checkpoints, auto-commit, the kit toolchain + verify gate, the deploy container booting pi core. *Floor: the agent can't hurt anything and progress survives.*
2. **T1 — Durable quick-task agent.** `memory-local`, todo, handoff, guidelines, spec-plan, compaction, context hygiene. *Beats a plain local agent on short tasks with no added latency.*
3. **T2 — Verified agent.** `verify-gate` → `verifier-board`; cheap-first stack; self-correction. *No victory on broken code.*
4. **T3 — Long-horizon agent.** `goal-core`, `task-graph`, `subagent`/`branch-lab`, `autonomous-loop`, `provider-router`, `context-sieve`, `dual-review`. *Sustains multi-hour/day work with recovery and handoffs.*
5. **T4 — Self-improving specialist.** `trace-ledger`, the benchmark suite, `remote-review`, `skill-forge`+curator, the improvement loop, the offensive-security lane. *The harness gets better from its own traces; specialised to my domain; ready to feed Hermes.*

Build order within each tier follows the research's repeated counsel: **start simple, add only measured upgrades tied to real failure traces** (R3, R4).

---

## 13. Definition of done (for the project, not a task)

The system is "done enough to rely on" when:
- The kit installs onto any fresh pi with one command and is fully validated by its own verify gate (`PI_KIT_REPO_PLAN.md`).
- The deploy container builds reproducibly, boots pi core, and bolts on the kit in both dev and release modes.
- T0–T3 extensions are implemented, verified, and pass the §10 contract on the benchmark suite.
- T4 produces measurable, regression-safe harness improvements from real traces.
- The agent demonstrably reaches task-shaped superiority on my repos and offensive-security lane.

It is never *finished* — by design (T4). The repo is structured (`PI_KIT_REPO_PLAN.md`) so capabilities grow indefinitely: new extensions as folders, split-out repos bolted on, experimental agents on branches.

---

## 14. References

**Internal research (in `docs/research/`):**
- *(R1)* `durable-memory-and-workflow.md` — memory layers; task object; handoff protocol; skill lifecycle; context-loading policy; local memory/task MCP server (SQLite + JSONL + Markdown + vectors).
- *(R2)* `local-first-pi-harness.md` — Pi as control plane; two-tier planner/executor; extension set; model-routing matrix; Pi-specific footguns and pseudocode.
- *(R3)* `verification-driven-harnesses.md` — verifier stack; recovery policy; trace schema; local benchmark suite; self-improvement loop; promotion rubric.
- *(R4)* `harness-engineering-long-horizon.md` — six-layer harness taxonomy; what leading harnesses add; long-horizon benchmark reality; reference architecture; concrete pi extensions.

**Internal specs:**
- `docs/PI_KIT_REPO_PLAN.md` — repo structure, install model, modularity/portability.

**External (Claude Code, current as of mid-2026):**
- Claude Code overview — https://docs.claude.com/en/docs/claude-code/overview
- Claude Code docs map — https://docs.anthropic.com/en/docs/claude-code/claude_code_docs_map.md
- Feature/settings reference snapshots and community guides (skills↔slash-command unification, 25 hook lifecycle points, agent teams, worktree isolation, deferred tool loading, plugins, headless mode).