# Agent Improvement Loop

For Codex, use the [autonomous improvement workflow](autonomous-workflow.md) and
its [linked skill coordinator](codex-skills/pi-improve/SKILL.md). It preserves
the six-phase evidence layout below and adds independent cycle worktrees,
fork-based submission, resumable validation and human PR merge gates. Its
Codex-specific discovery and review rules supersede the older Claude-only
dispatch assumptions below.

A repeatable, file-driven workflow for live-testing the deployed pi agent in a
sandbox, evaluating it against real tasks, and turning validated findings into
implemented, verified improvements. Run it with `/pi-improve`.

This document is the **authoritative schema and process reference**. It is the
source of truth — not any single conversation. A fresh Claude Code session (or
a different phase's subagent, with no memory of prior turns) must be able to
resume a cycle correctly by reading this document plus the cycle's own
artefacts under `cycles/<cycle-id>/`.

The coordinator and phase skills that drive this workflow are versioned in this
doc tree under `docs/agent-improvement/codex-skills/` (see "Where the workflow
itself lives" below). This document does not duplicate their operating
instructions; it defines the contract they all read and write.

## Why file-driven, not conversation-driven

Each phase may run in its own subagent with no access to earlier phases'
conversation history (by design — see "Context architecture" below). The only
things a phase can rely on are: this document, the cycle manifest
(`cycle-state.json`), prior phases' committed artefacts, and its own explicit
inputs. Nothing about the cycle's state may live only in chat history.

## Context architecture

The loop is a coordinator plus six dedicated phase skills, not one long
conversation:

- **Coordinator** (`/pi-improve`, skill `pi-improve`): reads `cycle-state.json`,
  decides the next phase, dispatches it to a fresh subagent (via the `subagent`
  tool, using the phase's dedicated skill — see
  `codex-skills/pi-improve*/SKILL.md`; the documented delegation roles live in
  `.pi/agents/`), validates the phase's required outputs
  exist, updates the manifest, and reports a short status line back to the
  user. It does not itself do phase work.
- **Phase skills** (`pi-improve-baseline`, `pi-improve-evaluate`,
  `pi-improve-report-triage`, `pi-improve-plan`, `pi-improve-implement`,
  `pi-improve-verify-review`): each is loaded by its own subagent, which has no
  parent conversation history. A phase skill's instructions must be fully
  self-sufficient given this document, the manifest, and repo state.

This harness does not expose a verified `context: fork` / `background: false`
skill-frontmatter mechanism (checked against the bundled skill/command/agent
documentation before building this — no such fields are documented). The
`Agent`/`subagent` tool is the confirmed, real mechanism for genuine context
isolation plus tool-restricted subagents, so the coordinator uses it directly:
each phase's subagent loads its dedicated skill definition in
`codex-skills/pi-improve-<phase>/SKILL.md` and is invoked synchronously (the
coordinator always needs the phase's result before deciding the next step). A
phase's *skill* file is what that subagent loads first to get its detailed
instructions — this still gives on-demand
loading of detailed instructions and keeps the coordinator's own context small,
it is just realized through `Agent` + `Skill` together rather than a single
unverified frontmatter key.

Phase skills may also be invoked directly and manually (`/pi-improve-baseline`,
etc.) for debugging or resuming a single phase without going through the
coordinator.

## Cycle directory layout

```text
docs/agent-improvement/cycles/<cycle-id>/
├── cycle-state.json          # the manifest — authoritative process state
├── 01-baseline.md            # Phase 1 output
├── 02-evaluation-definition.md   # Phase 1 output (selected tests, criteria)
├── 03-evidence/               # Phase 2 output — raw logs, traces, measurements
│   ├── run-<n>-<test>.log
│   ├── trace-<n>.jsonl
│   └── ...
├── 04-evaluation-report.md   # Phase 3 output — committed before Phase 4 starts
├── 05-findings.json          # Phase 3 output — validated + rejected findings
├── 06-improvement-plan.md    # Phase 4 output — the approved plan
├── 07-implementation-record.md  # Phase 5 output
├── 08-validation-report.md   # Phase 6 output
└── 09-final-summary.md       # Phase 6 output — cycle close-out
```

Cycle evidence (the per-cycle `cycles/<cycle-id>/**` artefacts) is intentionally
not stored in this repository — only this schema document and the workflow
skills are tracked here. The `cycles/` directory is kept as the expected,
gitignored-once-populated destination for cycle artefacts; see
`cycles/.gitkeep`.

`<cycle-id>` is `YYYYMMDD-HHMMSS-<short-slug>` (UTC), e.g.
`20260806-141500-orchestrator-delegation`. The slug is a short (2-4 word)
hint at the cycle's focus, chosen by the coordinator from the user's request
or, if none given, from the prior cycle's `recommended future evaluations`.

The exact filenames may gain repo-specific variants over time, but the
six-phase structure and the manifest's required fields (below) must stay
consistent across cycles — later tooling and cross-cycle analysis depends on
it.

## `cycle-state.json` schema

```jsonc
{
  "cycleId": "20260806-141500-orchestrator-delegation",
  "focus": "one-line human description of what this cycle is evaluating/improving",
  "currentPhase": 3,                 // 1-6
  "phaseStatus": "in_progress",      // pending | in_progress | complete | failed | blocked
  "phases": {
    // one entry per phase, added as each starts
    "1": { "name": "baseline", "status": "complete", "startedAt": "...", "completedAt": "...", "commit": "<sha or null>" },
    "2": { "name": "evaluate", "status": "in_progress", "startedAt": "..." }
  },
  "repos": {
    // one entry per repo this cycle touches; paths are absolute, resolved once at cycle start.
    // In this monorepo a cycle normally touches one repo, "pi-system".
    "pi-system": { "path": "/abs/path/to/pi-system", "baselineCommit": "<sha>", "latestCommit": "<sha>", "branch": "main" }
  },
  "sandbox": {
    "engine": "docker-compose",
    "composeFiles": ["packages/container/capability/compose/compose.yaml", "packages/container/capability/compose/compose.dev.yaml"],
    "projectName": "pi-agent-<cycle-id>",
    "dataRoot": "//srv/data/pi-system-<cycle-id>",
    "model": { "provider": "lmstudio-container", "id": "prism-ml/bonsai-27b", "contextLength": 32768 }
  },
  "selectedTests": ["<benchmark-or-task-id>", "..."],
  "requiredArtifacts": {
    // per phase number, list of paths that must exist before the manifest can advance past it
    "1": ["01-baseline.md", "02-evaluation-definition.md"],
    "2": ["03-evidence/"],
    "3": ["04-evaluation-report.md", "05-findings.json"],
    "4": ["06-improvement-plan.md"],
    "5": ["07-implementation-record.md"],
    "6": ["08-validation-report.md", "09-final-summary.md"]
  },
  "validatedFindingIds": ["F1", "F3"],
  "rejectedFindingIds": ["F2"],
  "approvedImprovementIds": ["I1", "I2"],
  "modifiedFiles": ["packages/extensions/src/orchestrator/index.ts", "..."],
  "testCommands": ["npm run verify", "npm run test:security", "npm run eval"],
  "validationStatus": "not_started",  // not_started | passed | failed
  "blockers": [],
  "nextPhase": 4,
  "createdAt": "2026-08-06T14:15:00Z",
  "updatedAt": "2026-08-06T15:02:00Z"
}
```

Write this file atomically (write to `cycle-state.json.tmp`, then rename) from
every phase and from the coordinator. Never advance `currentPhase` /
`nextPhase` until the phase's `requiredArtifacts` exist and pass the
structural checks in its own skill (e.g. `05-findings.json` parses as JSON and
has at least the `validated`/`rejected` arrays).

## The six phases

| # | Skill | Produces | Gate before advancing |
| --- | --- | --- | --- |
| 1 | `pi-improve-baseline` | Baseline record, environment/config, selected tests, success criteria, sandbox requirements, baseline commit | Outputs exist and are internally consistent (tests named actually exist/are runnable) |
| 2 | `pi-improve-evaluate` | Test execution records, evidence directory, traces, resource/cost measurements, security observations, reproduction steps | Sandbox torn down or documented as still running; every selected test has a completion status (pass/fail/error/skipped) |
| 3 | `pi-improve-report-triage` | Committed evaluation report, validated + rejected findings with IDs | **Falsifiability/significance gate** (below) applied to every finding before it is marked validated; report committed to git before Phase 4 starts |
| 4 | `pi-improve-plan` | Self-contained improvement plan, one entry per validated finding | Every finding in `validatedFindingIds` is either addressed by a plan item or explicitly deferred with a reason |
| 5 | `pi-improve-implement` | Implementation commits, updated tests/docs, finding-to-commit traceability | Only approved plan items were touched; `git status` clean at end (everything committed) |
| 6 | `pi-improve-verify-review` | Before/after comparison, regression + holdout results, security review, plan-conformance review, final summary | Cycle only marked `complete` if evidence shows measurable improvement with no unacceptable regression |

See each phase's own skill (`codex-skills/pi-improve-<phase>/SKILL.md`) for
its detailed procedure.

## Falsifiability and significance gate (Phase 3)

A finding may only enter `validatedFindingIds` if all of the following hold —
this is what keeps the loop from generating implementation churn over noise:

1. **Reproducible.** A second, independent run of the same test (same sandbox,
   same inputs) reproduces the same observed behavior — or the failure mode is
   a category matched in at least two different tests/runs. A single
   unreproduced anomaly is `rejected` (or `inconclusive` if evidence is
   ambiguous) with a note, not `validated`.
2. **Falsifiable and actually tested against the null hypothesis.** State what
   would have falsified the finding, and confirm that check was actually done
   (e.g. "the model's stated block reason was checked against the tool
   result's real payload, not assumed wrong from vibes").
3. **Attributable to a specific, identifiable root cause** — not just "the
   agent seemed off." If the root cause can't be pinned to a file, config
   value, prompt, or documented model limitation, it is `inconclusive`.
4. **Material to at least one improvement principle** (task effectiveness,
   reliability/robustness, efficiency, security/safety, agentic capability,
   observability/evaluability, maintainability/organisation, generalisability/
   scalability — see "Improvement principles" below). A cosmetic or
   preference-only observation with no principle it clearly serves is
   `rejected`.
5. **Worth the implementation cost.** Even a real, reproducible finding may be
   `validated-but-deferred` if its fix cost clearly exceeds its benefit at
   this repo's current maturity — record this explicitly rather than silently
   dropping it.

Every rejected or inconclusive finding must still be recorded (in
`05-findings.json`, not silently discarded) with the reason it didn't pass the
gate — this is itself useful signal for later cycles and prevents re-litigating
the same non-finding.

## Improvement principles

Every plan item (Phase 4) must name which of these principles it serves, the
observed failure/opportunity it addresses, its likely root cause, expected
measurable benefit, implementation risk, validation method, and regression
safeguard. See `04-evaluation-report.md`'s findings and `06-improvement-plan.md`
for the concrete template.

- **Task effectiveness** — correct, complete, relevant, verifiable outcomes
  that satisfy the original task requirements.
- **Reliability and robustness** — consistent behavior, handling of
  unexpected conditions, recovery from failure, no dependence on fragile
  assumptions or ideal inputs.
- **Efficiency** — less wasted reasoning, tool calls, duplicated work,
  latency, tokens, and compute, without reducing output quality.
- **Security and safety** — reduced likelihood/impact of prompt injection,
  unsafe tool use, privilege misuse, data exposure, policy bypass, compromised
  dependencies, or other adversarial/unintended behavior.
- **Agentic capability** — better goal understanding, planning, tool
  selection/use, context management, delegation, result verification, mistake
  recovery, and capacity for longer-horizon/more-complex tasks.
- **Observability and evaluability** — decisions, actions, state, evidence,
  failures, and performance that are measurable, traceable, reproducible, and
  easy to inspect.
- **Maintainability and organisation** — prompts, skills, tools, memory,
  policies, workflows, tests, and configuration that stay modular, documented,
  version-controlled, and easy to change without unintended effects.
- **Generalisability and scalability** — improvements that work across
  different tasks, environments, models, and workloads, and keep working as
  task volume, complexity, context size, and agent concurrency increase.

Weigh these against minimizing regressions, unnecessary complexity, resource
cost, and avoidable human intervention — a plan item that trades a small gain
on one principle for a larger loss on another (e.g. "more capable" at the cost
of "much less observable") needs that trade-off named explicitly, not buried.

## Where the workflow itself lives

- Coordinator skill: `codex-skills/pi-improve/SKILL.md`
- Phase skills: `codex-skills/pi-improve-{baseline,evaluate,report-triage,plan,implement,verify-review}/SKILL.md`
- Delegation roles available to the coordinator: `.pi/agents/` in this monorepo
  (`delegator`, `planner`, `implementer`, `reviewer`, `scout`).
- Compact-preservation instructions: this repo's `CLAUDE.md`. The state
  re-injection hook body is `docs/agent-improvement/scripts/inject-cycle-state.mjs`.

These skills are versioned here under `docs/agent-improvement/codex-skills/` so
the workflow travels with the repo it improves. Historically the same workflow
was also driven from personal, cross-repo tooling (`~/.claude/skills/pi-improve*/`
and `~/.claude/agents/pi-improve-*.md`) that is not tracked here. What must stay
versioned in-repo is everything the workflow *produces*: this schema document
and every cycle's artefacts.

## Sandbox requirements (all cycles)

- Live testing always runs inside the container sandbox (dev mode: non-root
  user, `cap_drop: ALL`, `no-new-privileges`, read-only root filesystem,
  read-only kit mount, ephemeral `tmpfs` `/workspace`) — never directly
  against the host filesystem. See `packages/container/capability/compose/compose.yaml`
  / `compose.dev.yaml` and `packages/core/eval/live/README.md` for the actual
  isolation properties of the live runner. On Windows/MSYS Git-Bash, bind-mount
  sources need real `C:/...` paths while VM-internal paths use `//srv/...`; do
  not set `MSYS_NO_PATHCONV=1` as a blanket fix.
- Use a fresh, cycle-scoped `PI_AGENT_DATA_ROOT` and compose project name per
  cycle (`pi-agent-<cycle-id>`) so cycles never collide or leak state into
  each other.
- Tear the sandbox down (`docker compose down`) at the end of Phase 2 and
  again at the end of Phase 6 — do not leave containers running between
  phases or after a cycle closes.

## Benchmarks and test selection (Phase 1/2)

Prefer one or two focused, fast tasks per cycle over a full benchmark suite —
the goal is a fast, repeatable signal, not a leaderboard run. Reasonable
sources, pick what fits the cycle's focus:

- A small number of items from a public agentic benchmark (e.g. Cybench,
  Terminal-Bench) run standalone, not through the benchmark's full harness, if
  that's simpler to wire into this sandbox.
- A hand-written task exercising a specific capability under review (e.g. "ask
  it to claim mission-complete without running tests, confirm verify-gate
  blocks it" — exactly the kind of test used in the 2026-08-06 session that
  seeded this workflow).
- A regression re-run of a task that previously found a bug, to confirm a fix
  actually holds (see `docs/archive/` and prior cycles' `04-evaluation-report.md`
  for candidates).

Record exactly which tasks were run and why in `02-evaluation-definition.md` —
this is part of what makes a cycle's evidence reproducible.
