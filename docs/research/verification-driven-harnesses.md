# Verification-Driven Harnesses for Local Coding Agents

## Executive synthesis

The strongest lesson from recent software-agent research is that **agent reliability is now shaped at least as much by the harness as by the base model**. Self-Harness defines the harness broadly as the surrounding system of prompts, tools, runtime mechanisms, verification rules, orchestration logic, and recovery procedures; in its experiments, changing the harness alone materially improved held-out performance across multiple base models without changing the model weights. Agentic Harness Engineering reaches a similar conclusion, arguing that observability over components, trajectories, and decisions is the key design pivot for harness evolution, not just better prompting.

That matters for your goal. If you want a **small local coding model** to become much more dependable, the most leverage comes from surrounding it with a layered verifier and recovery system: cheap static checks first, then executable validation, then critics and specialist review, then selective branching, rollback, and harness updates driven by traces. This is also the practical direction taken by production systems. Claude Code exposes deterministic hooks and specialised subagents; Codex separates sandboxing from approval review and can route boundary-crossing actions through a reviewer agent; OpenHands exposes a critic, security analysis, stuck detection, PR review, and "actually run the software" QA workflows; Hermes centres self-improving skills, isolated subagents, pre-commit verification, dangerous-command approval, and rollback.

The second lesson is that **benchmark choice now matters as much as benchmark score**. SWE-bench standardised repo-level issue resolution, and SWE-bench Verified improved it by manually curating 500 problems, but OpenAI now argues that Verified is increasingly contaminated and still contains many flawed or underspecified tests, recommending SWE-Bench Pro instead for frontier evaluation. Terminal-Bench 2.0, SWE-rebench, c-CRAB, RefactorBench, and SWE-bench's multilingual and multimodal extensions each measure failure modes that a patch-only benchmark misses: terminal work, contamination resistance, review quality, state tracking, cross-language generalisation, and visual understanding.

The design implication is straightforward: **treat prompts, workflow DAGs, tool wrappers, verifiers, and review policies as the objects being recursively improved**. Do not wait for fine-tuning. Record every run, score every stage, mine failures, propose minimal harness edits, regression-test them, and only promote changes that improve held-out performance and operational efficiency. That design is directly supported by Self-Harness, AFlow, Live-SWE-agent, AHE, and critic-rubric work.

## What the benchmark landscape says you should build

The benchmark family you choose determines what your local harness learns to care about. The current landscape points toward a **portfolio**, not a single score.

| Benchmark or family | What it measures best | Why it matters for a verifier-first local harness |
|---|---|---|
| SWE-bench | Repo-level issue resolution from real GitHub issues | Good historical baseline, but too easy to misuse as the only target |
| SWE-bench Verified | Human-filtered 500-task subset | Useful as a low-cost smoke test, but now risky as a headline metric because of flawed tests and contamination |
| SWE-Bench Pro | Longer-horizon, harder, more industrial tasks | Better north-star benchmark for realistic autonomous engineering |
| Terminal-Bench 2.0 | Hard terminal-native tasks with outcome-based tests | Best fit for harnesses built around shell execution, tool wrappers, and rollback |
| SWE-rebench and SWE-rebench V2 | Continually harvested, executable, large-scale tasks for RL and decontaminated eval | Strong template for building your own rolling local benchmark generator |
| RefactorBench | Multi-file refactoring and stateful reasoning | Excellent for measuring memory, plan consistency, and regression control |
| c-CRAB | Automated code review quality from human reviews turned into executable tests | Ideal for testing your reviewer and verifier agents, not just your fixer |
| SWE-bench Multilingual and Multimodal | Cross-language and visual issue resolution | Useful if your repos are not mostly Python, or if issues rely on screenshots and UI evidence |

Sources for the benchmark summary: SWE-bench's repository and site, SWE-bench Verified, OpenAI's February 2026 analysis of Verified, SWE-Bench Pro, Terminal-Bench 2.0, SWE-rebench, SWE-rebench V2, RefactorBench, c-CRAB, and the multilingual and multimodal SWE-bench extensions.

A few details are especially actionable. Terminal-Bench 2.0 uses **89 hard terminal tasks**, each with a containerised environment, instruction, tests, reference solution, and time limit; it is explicitly outcome-driven, and the tests verify final state rather than the exact command sequence. It can also adapt older benchmarks into the same task format, which is a strong architectural hint for your own local eval harness.

SWE-rebench is even more important for your use case because it moves beyond static public suites. The first version introduced an automated pipeline and released **over 21,000 interactive Python tasks**; V2 extends this to **32,079 tasks across 20 languages and 3,617 repositories**, plus a larger auxiliary set with installation instructions, fail-to-pass tests, and metadata. That makes SWE-rebench less of a leaderboard and more of a recipe for building your own **fresh, contamination-resistant, continuously replenished local benchmark suite**.

One caution is non-negotiable. OpenAI's February 2026 audit argues that SWE-bench Verified is now a poor frontier metric because many audited failures stem from **narrow or wide tests** rather than genuine reasoning limits, and because public-source contamination can silently inflate scores. For a small local model, contamination is less likely than for large frontier models, but the test-design problem still matters. So use Verified only as one lane in your suite, not as the sole arbiter of harness quality.

## A practical verifier stack from cheapest to strongest

A good local verifier stack should be **monotonic in cost and evidential strength**. The system should stop early on clear failures and escalate only when uncertainty remains.

### Cheap deterministic gates

Start with deterministic checks that cost almost nothing and catch obvious breakage: parse and syntax checks, compile or typecheck, lint, formatter diffs, dependency lockfile integrity, changed-file allowlists, and repo-specific invariants. Codex and Claude Code both expose lifecycle hooks precisely for this sort of deterministic enforcement; Claude's docs stress that hooks are deterministic in a way advisory prompt files are not, and both tools let you run checks at stop-time or around tool use.

This layer should also include **patch-shape validation**. Agentless is a useful reminder that a surprisingly strong baseline can come from a simple three-stage workflow of localisation, repair, and patch validation, without giving the model a large action space or complicated planning loop. For smaller local models, that simplicity is often a feature.

### Executable validation

The next layer is anything that **executes code or the application**. In order of usual cost: targeted unit tests relevant to touched files, reproduction tests for the reported bug, contract tests, type-level integration tests, then broader integration or end-to-end checks. Terminal-Bench's design and SWE-bench's protocol both reinforce that evaluation should focus on final container or repo state rather than the superficial elegance of the trace. OpenHands' automated QA guide goes further and explicitly distinguishes "run the test suite" from "actually run the software and behave like a user", calling the latter a distinct verification layer.

Your rule here should be: **the builder agent never decides unilaterally that it is done if executable evidence is still missing**. Hermes' bundled pre-commit verification skill states that no agent should verify its own work, and its Kanban worker guidance warns against marking coding work done based only on another agent's self-report.

### Trace-based critics and rubrics

After deterministic and executable checks, add a **critic layer** that scores the *process*, not just the patch. OpenHands' critic predicts task success in real time, outputs probabilities, and can trigger iterative refinement when scores fall below threshold. The critic-rubric paper is especially relevant to local harnesses because it shows how to learn a critic from sparse real-world outcomes and dense rubric features extracted from traces; the paper reports improvements in reranking, early stopping, and trajectory selection.

For a local system without fine-tuning, you can still implement a strong approximate version: define rubrics such as "searched before editing", "ran only relevant tests", "read failing output before patching", "touched confined files", "added regression test when fixing a bug", "stopped after green evidence rather than churning", and "did not repeatedly retry identical failing commands". OpenHands' stuck detector gives you several of these patterns almost for free by detecting repeated action-observation cycles, repeated action-error cycles, and monologues.

### Independent review agents

Then add a **review layer** that is separate from the builder. Claude Code's managed code review uses multiple specialised agents in parallel and then runs a verification step on candidate findings before posting severity-ranked comments. Codex's GitHub review focuses on serious issues, follows repository guidance from `AGENTS.md`, and posts only high-priority findings. Hermes' bundled verification skill explicitly uses an independent reviewer subagent and an auto-fix loop. c-CRAB is the benchmark proof that this layer should be evaluated in its own right: current review agents solve only around 40% of those tasks.

A practical pattern for local work is to run two independent reviewers: a **spec reviewer** and a **quality reviewer**. Hermes' subagent-driven development skill uses exactly that two-stage pattern, checking requirements first and code quality second.

### Search, branching, and expensive verification

Only after the earlier layers disagree or remain uncertain should you pay for **inference-time search**: best-of-N generation, branch-and-bound editing, or tree search. OpenHands showed a simple form of this by rolling out multiple trajectories and selecting the best with a critic; AFlow automates workflow search with MCTS over code-represented workflows; CodeTree explores alternative coding strategies and ranks, terminates, and expands branches using execution and agent feedback; Adaptive Generate-Rank-Verify formalises the general setting where cheap scores should decide when to pay for expensive verifier labels.

For a local small model, the practical rule is: **use search only when the task is high value, partial evidence suggests promise, and the verifier stack cannot yet separate near-misses from dead ends**.

### Recommended ordered stack

| Order | Verifier | Cost | Failure it catches |
|---|---|---|---|
| Lowest | Syntax, format, compile, typecheck, changed-file policy | Very low | Broken patches, unsafe paths, trivial regressions |
| Low | Targeted unit tests and bug reproduction | Low | Wrong fix, partial fix, obvious regressions |
| Low to medium | Diff heuristics and repo-specific invariant checks | Low to medium | Over-broad edits, architectural violations |
| Medium | Process critic over trace rubrics | Medium | Bad work pattern before full failure is visible |
| Medium | Independent spec reviewer | Medium | Misread task, incomplete requirement coverage |
| Medium | Independent quality reviewer | Medium | Hidden regression risk, missing tests, maintainability hazards |
| High | Application-level QA or end-to-end execution | High | Behavioural mismatches CI misses |
| Highest | Branching, best-of-N, tree search with reranking | Highest | Hard tasks where one-shot generation is insufficient |

This ordering is supported by the d benchmark and product literature, but the exact cut-offs should be tuned per repository and per model.

## Retry, recovery, traces, and the local benchmark suite

### Retry and recovery policy

A useful recovery policy is not "retry until budget exhausted". It should branch on **the kind of evidence you have**.

| Situation | Best recovery action | Why |
|---|---|---|
| The model never found the right area of code | Replan from localisation, do not keep editing | Agentless shows localisation is its own phase; repeated repair attempts on wrong files waste budget |
| The patch is near-correct but fails a narrow set of tests | Fork from current branch and try small corrective patches | Preserve progress while avoiding destructive churn |
| The agent repeats the same failing command or loop | Halt, surface a stuck event, and inject a "change strategy" prompt | OpenHands' stuck detector shows these patterns are detectable automatically |
| The agent made risky or broad edits | Roll back to checkpoint, replay with stricter write budget and reviewer gating | Hermes checkpoints and rollback, plus Crab-style checkpointing research, show rollback is cheap insurance |
| The diff passes cheap checks but not application behaviour | Escalate to QA verifier or specialist subagent | Review alone is not enough for behavioural bugs |
| The task splits naturally into bounded subtasks | Spawn specialists with isolated context | Claude, Codex, and Hermes all use isolated subagents to reduce context pollution |
| Boundary-crossing or unsafe tool use is required | Ask a verifier or approval reviewer before proceeding | Codex auto-review and Claude/Codex permission systems separate capability from approval |
| Evidence remains contradictory after two independent branches | Abandon or escalate to human | Avoid burning tokens on irreducible ambiguity |

Sources: Agentless, OpenHands stuck detector, Hermes checkpoints and security, Crab, Claude subagents, Codex approvals and subagents.

A practical budget policy for local models is:

- one **primary run**;
- one **localisation replan** if evidence shows the wrong files or wrong hypothesis;
- up to two **forked repair attempts** if the patch is one verifier away from green;
- one **specialist review cycle** for high-value tasks;
- then stop.

That sounds conservative, but it aligns with the research trend that **good verifiers improve search efficiency more than more blind retries do**.

### Trace schema for every run

Your trace schema should be detailed enough to support audit, replay, critic training, and harness evolution. Claude Code's hook model, OpenHands' JSONL headless mode, and Hermes' hook and Kanban systems all point toward **evented traces** as the right primitive.

A minimal schema:

```json
{
  "run_id": "uuid",
  "task_id": "repo#issue-or-local-task-id",
  "repo": {
    "name": "my-repo",
    "commit_base": "abc123",
    "branch": "agent/run-042"
  },
  "model": {
    "provider": "local",
    "name": "qwen2.5-coder-7b-instruct",
    "temperature": 0.2,
    "context_window": 32768
  },
  "harness": {
    "version": "h-0.7.3",
    "workflow": "repair-with-review",
    "prompt_set": "promptpack-12",
    "tool_wrapper_set": "tools-5",
    "verifier_set": "verify-9"
  },
  "task": {
    "kind": "bugfix|feature|refactor|review|qa",
    "description": "Fix failing auth refresh path",
    "success_target": ["targeted_tests", "qa_flow", "review_clean"]
  },
  "events": [
    {
      "ts": "2026-06-16T09:42:15Z",
      "type": "model_turn",
      "role": "assistant",
      "summary": "Plans reproduction steps",
      "tokens_in": 4120,
      "tokens_out": 218
    },
    {
      "ts": "2026-06-16T09:42:21Z",
      "type": "tool_call",
      "tool": "bash",
      "cmd": "pytest tests/auth/test_refresh.py -q",
      "exit_code": 1,
      "latency_ms": 5100
    },
    {
      "ts": "2026-06-16T09:42:28Z",
      "type": "edit",
      "files_touched": ["src/auth/session.ts"],
      "lines_added": 14,
      "lines_removed": 2
    },
    {
      "ts": "2026-06-16T09:43:01Z",
      "type": "verifier",
      "name": "spec_review",
      "score": 0.74,
      "verdict": "needs_fix"
    }
  ],
  "summary": {
    "files_touched": ["src/auth/session.ts", "tests/auth/test_refresh.py"],
    "failures": ["test_failure", "critic_low_score"],
    "retries": 2,
    "forks": 1,
    "rollback_count": 0,
    "tests": {
      "targeted_pass": true,
      "full_suite_pass": false,
      "qa_pass": null
    },
    "cost": {
      "wall_clock_s": 183,
      "input_tokens": 29120,
      "output_tokens": 4811
    },
    "success": false,
    "success_score": 0.63
  }
}
```

The `success_score` should not be binary. Compute it as a weighted composite of final verification outcome, critic score, regression count, retry count, diff containment, and time. That makes later harness comparison far easier than pass/fail alone. This recommendation is consistent with critic-rubric work and synthetic-verifier evaluation work, both of which argue for richer scoring than a single end-state bit.

### Local benchmark suite from your own repos

Build four lanes, each backed by reproducible fixtures:

| Lane | Task source | Success oracle |
|---|---|---|
| Issue repair | Past bug tickets and regressions from your repos | Reproduction test plus regression suite |
| Refactor and migration | Past refactors, dependency upgrades, API migrations | Snapshot tests, type checks, semantic diff checks |
| Code review | Historic PRs with human review comments | c-CRAB-style executable review tests or rubric match |
| Behavioural QA | User-visible changes and incident reproductions | Scripted browser, CLI, or API flows |

For collection, imitate SWE-rebench's pipeline at a smaller scale: extract committed fixes from your history, reconstruct the pre-fix commit, derive fail-to-pass tests, retain metadata about underspecification and overly narrow tests, and continuously add fresh tasks rather than freezing the suite.

For split policy, keep at least three partitions: **train-like development tasks** for harness tuning, **held-out internal tasks** for promotion decisions, and **fresh rolling tasks** for contamination resistance. That is the internal equivalent of combining static benchmarking with live or fresh-task evaluation.

## The self-improvement loop and the scoring rubric

### The loop

The best current pattern is a synthesis of Self-Harness, AHE, AFlow, and Live-SWE-agent:

1. **Collect traces** from ordinary task execution.
2. **Mine weakness clusters** from failed or costly traces.
3. **Propose small harness changes** tied to specific failure patterns.
4. **Evaluate candidates** on a held-in development split and a held-out regression split.
5. **Promote only if the change improves performance without unacceptable regressions**.
6. **Archive or roll back weak changes** and record why.
7. **Periodically consolidate skills and prompts** so the harness does not bloat.

That is extremely close to Self-Harness's three stages of Weakness Mining, Harness Proposal, and Proposal Validation. AHE adds a crucial operational refinement: every edit should become a **falsifiable contract** recorded in a change manifest, so the next evaluation round can decide whether to keep or revert it. Hermes' curator does the analogous maintenance job for accumulated skills, archiving or consolidating stale material rather than letting it pollute the library. AFlow contributes the idea that workflows are themselves code objects that can be searched and optimised.

### What the harness is allowed to change

Your self-improvement loop should operate over a clearly delimited action space:

| Change class | Example |
|---|---|
| Prompt edit | Add "reproduce before repair" rule |
| Tool wrapper | Safer `git diff`, test-runner wrapper, file guard |
| Verifier config | New targeted-test selector, stricter gate thresholds |
| Workflow DAG | Insert review step before full-suite run |
| Specialist agent | Add read-only localisation reviewer |
| Memory or skill | Add repo-specific debugging playbook |
| Sandbox and rollback policy | Tighten writable roots, add checkpoint before risky tools |
| Trace analysis rule | New failure-cluster detector |

AHE's strongest contribution here is the insistence on **component observability**: editable harness pieces should exist as files with clear boundaries so they can be modified, tested, attributed, and reverted independently.

### Promotion rubric for harness changes

Use a weighted rubric, not a single metric.

| Dimension | Suggested weight | How to score |
|---|---:|---|
| Held-out task success | 35 | Pass-rate delta on internal held-out suite |
| Regression safety | 20 | Negative weight for new failures on previously passing tasks |
| Cost efficiency | 15 | Improvement per wall-clock second and per token |
| Recovery quality | 10 | Fewer loops, retries, and abandoned runs |
| Diff containment | 5 | Fewer unnecessary files and lines touched |
| Verifier agreement | 5 | Better alignment between critic, tests, and reviewers |
| Transfer | 5 | Improvement across more than one repo or task lane |
| Operational simplicity | 5 | Fewer moving parts, easier rollback, smaller prompt footprint |

Promote only if the candidate clears three gates:

1. **Positive held-out delta**.
2. **Regression budget not exceeded**.
3. **Efficiency not materially worse unless the gain is large**.

This is the practical form of what Self-Harness calls regression-tested proposal validation and what AHE frames as falsifiable file-level contracts. It also fits OpenHands' critic-rubric philosophy: process signals matter, but outcome still wins.

### Concrete examples of good self-improvements

The literature suggests that the best harness edits are often *not* giant prompt rewrites. AHE reports that tools, middleware, and long-term memory carried the gains more reliably than the system prompt alone, which sometimes regressed. Live-SWE-agent similarly shows the value of runtime tool creation over a minimal bash-only base. Hermes' skill system and curator point in the same direction: compact reusable procedures and maintenance beats indiscriminate prompt accumulation.

That means your loop should preferentially propose:

- a new **tool wrapper** before a longer prompt;
- a new **review subagent** before a more verbose builder;
- a new **failure detector** before more retries;
- a new **repo-specific skill** before a global policy.

## Minimal TypeScript implementation path

A Node or TypeScript implementation can stay surprisingly small if you treat the harness as a set of files and pure functions.

### Suggested architecture

| Module | Purpose | Storage |
|---|---|---|
| `runner` | Executes a task workflow and emits events | JSONL append log + SQLite summary row |
| `tools` | Thin wrappers for bash, git, tests, file edits | None beyond trace events |
| `verifiers` | Static checks, test runners, critics, reviewers | SQLite tables for scores and verdicts |
| `policies` | Retry, fork, rollback, abandon decisions | Versioned JSON or TS configs |
| `bench` | Loads tasks from local repos and fixtures | Filesystem + SQLite metadata |
| `evolver` | Mines traces, proposes harness edits, evaluates them | Git branches + SQLite experiments table |
| `dashboard` | CLI or small web UI over runs and experiments | Reads SQLite and JSONL |

Use **JSONL for append-only raw events** and **SQLite for indexed summaries and experiment metadata**. OpenHands' headless JSONL mode is a good example of why JSON Lines are a useful interchange format, while Hermes' Kanban and SQLite-backed internal state are good examples of how lightweight database state can support multi-run coordination without a heavyweight platform.

### Minimal SQLite schema

```sql
create table runs (
  run_id text primary key,
  task_id text not null,
  repo text not null,
  base_commit text,
  harness_version text not null,
  workflow text not null,
  model_name text not null,
  started_at text not null,
  finished_at text,
  success integer not null,
  success_score real not null,
  wall_clock_s real,
  input_tokens integer,
  output_tokens integer,
  retries integer default 0,
  forks integer default 0,
  rollbacks integer default 0
);

create table verifier_results (
  id integer primary key autoincrement,
  run_id text not null,
  verifier_name text not null,
  stage text not null,
  score real,
  verdict text,
  payload_json text,
  foreign key (run_id) references runs(run_id)
);

create table file_touches (
  id integer primary key autoincrement,
  run_id text not null,
  path text not null,
  added integer default 0,
  removed integer default 0,
  foreign key (run_id) references runs(run_id)
);

create table harness_changes (
  change_id text primary key,
  parent_harness_version text not null,
  candidate_harness_version text not null,
  change_type text not null,
  manifest_json text not null,
  predicted_gain real,
  promoted integer default 0,
  evaluated_at text
);

create table benchmarks (
  task_id text primary key,
  lane text not null,
  repo text not null,
  difficulty text,
  oracle_type text not null,
  freshness_bucket text not null
);
```

### Minimal workflow DAG

Your first implementation does not need a general graph engine. A fixed DAG is enough:

`plan -> localise -> patch -> cheap gates -> targeted tests -> critic -> reviewer(s) -> full tests or QA -> done`

Only if the critic or reviewer says "close but not done" do you branch to:

`fork repair -> targeted retest -> compare -> choose`

Only if the task is risky or the diff is broad do you insert:

`checkpoint -> risky action -> verify -> rollback on failure`

This is already enough to capture the key lessons from Agentless, OpenHands, Claude Code, Codex, and Hermes.

### A first implementation sequence

Start in this order:

1. **Raw trace logging** with JSONL.
2. **Cheap verifier layer** with deterministic hooks around tool use and stop events.
3. **Targeted test selection** based on changed files or explicitly mapped tasks.
4. **Read-only spec reviewer** and **quality reviewer**.
5. **Retry policy** with replan, fork, and rollback.
6. **SQLite summaries and experiment tables**.
7. **Failure clustering** over traces.
8. **Harness proposal and evaluation loop**.

That sequencing mirrors the field: simple scaffolds plus strong verification and observability beat prematurely complicated agents. mini-SWE-agent's bash-only simplicity, Agentless's phased design, and Self-Harness's minimal-change philosophy all support this.

## Open questions and limitations

The most important unresolved question is **how far a small local critic can really substitute for a stronger reviewer model**. The critic-rubric results are promising, but much of the strongest evidence still comes from larger models or semi-supervised training pipelines rather than fully local, no-training deployments.

Benchmark choice also remains a live risk. SWE-bench Verified is still useful for continuity and low-cost regression checks, but it is no longer a clean measure of frontier progress according to OpenAI's 2026 analysis. Your internal benchmark suite should therefore emphasise fresh tasks, local repos, and explicit metadata about underspecification and test narrowness.

Finally, the research picture is clearest for SWE-bench, SWE-bench Verified, SWE-Bench Pro, Terminal-Bench, SWE-rebench, Self-Harness, AHE, Live-SWE-agent, OpenHands, Claude Code, Codex, and Hermes. It is less complete here for some adjacent items you mentioned, especially **SWE-EVO**, where the retrieved primary-source evidence was not central enough to support a detailed design recommendation in this report without risking overstatement.
