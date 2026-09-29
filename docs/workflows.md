# Workflows

A **workflow** is a saved chain of subagent steps. It runs on a **deterministic executor**, so
code rather than a model decides what runs next. Steps pass work to each other through a
shared **run directory** (the blackboard). A review gate can loop back to an earlier step.
An interrupted run can be resumed.

Use a workflow when the same multi-step delegation keeps coming up: plan → implement →
review, reproduce → fix → verify, or fan out → synthesise. For a one-off delegation, the
`subagent` tool (single, parallel or chain) is enough.

## Running

| Surface | Use |
| --- | --- |
| `/workflow list` | Available workflows and their inputs (`*` = required) |
| `/workflow run feature goal="add rate limiting to /api/orders"` | Start a run in the background. The footer shows progress, and the summary is posted into the session when it finishes. `/workflow run` with no name opens a picker. |
| `/workflow status [run-id]` | Recent runs, or one run's steps |
| `/workflow stop <run-id>` | Stop an active run (it can be resumed) |
| `/workflow resume <run-id>` | Continue an interrupted or failed run from its current step |
| `workflow_run` tool | The agent runs a workflow itself: `{name, inputs}`, `{name: "list"}`, or `{resume: "<run-id>"}` |
| `workflow_status` tool | The agent inspects runs |

Esc cancels a `workflow_run` started by the agent. The current step's subagent is stopped,
the run is marked `interrupted`, and it can be resumed.

## Where workflows live

| Location | Source | Trust |
| --- | --- | --- |
| `packages/kit/workflows/*.md` | shipped with the kit (`feature`, `bugfix`, `research`) | trusted |
| `~/.pi/agent/workflows/*.md` | yours, available in every project | trusted |
| `.pi/workflows/*.md` | the project's | needs interactive approval, or its SHA-256 listed in `PI_KIT_TRUSTED_WORKFLOWS` (`;`-separated) |

A later location overrides an earlier one with the same `name`.

## Format

A workflow is a Markdown file. The YAML frontmatter is the definition; the body is
documentation for people.

```yaml
---
name: feature                       # lowercase id; what /workflow run uses
description: One line shown in /workflow list
inputs:
  goal: { description: What to build, required: true }
  area: { description: Where to look, default: the whole repository }
vault: false                        # true: copy the finished run into the memory vault
steps:
  - id: scout                       # unique across the workflow
    agent: scout                    # a role: scout, planner, implementer, reviewer, delegator, or yours
    task: |
      Map the code relevant to: {{inputs.goal}} (look in {{inputs.area}})
  - id: plan
    agent: planner
    skills: [task-decomposition]    # SKILL.md bodies preloaded into this step's subagent
    task: |
      Plan {{inputs.goal}} using these findings:
      {{steps.scout.output}}
  - id: implement
    agent: implementer
    task: |
      Implement: {{steps.plan.output}}
      Previous review, if any: {{steps.review.output?}}
  - id: review
    agent: reviewer
    task: "Review against the plan: {{steps.plan.output}}"
    gate:
      pass: "/##\\s*Verdict\\s*\\n+\\s*PASS/"   # text, or /regex/ (case-insensitive)
      retry: implement                            # an earlier top-level step to go back to
      max_loops: 2
---
```

### Step fields

| Field | Meaning |
| --- | --- |
| `id` | Required. `a-z0-9_-`, starting with a letter. |
| `agent` | The role to run. Required unless `skill` is given (which defaults the role to `implementer`). |
| `skill` | Shorthand for a step that exists to apply one skill: the skill is preloaded and the role defaults to `implementer`. |
| `task` | Required. The subagent's task, a template (see below). The subagent can't see anything else, so make it self-contained. |
| `skills` | Extra skills preloaded into the subagent's system prompt. |
| `tools` | Restrict the subagent's tools, e.g. `[read, grep, find, ls]`. |
| `extensions` | Extra kit extensions for the isolated child, e.g. `[memory-vault]` so it can call `memory_save`. |
| `model`, `thinking` | Per-step model (`provider/id`) and thinking level. The default is the role's `model:`, else the session model. |
| `max_runtime` | Wall-clock limit for this step: `90s`, `20m`, `2h`. |
| `outputs` | Files (relative to the run directory) the step must write. It fails if they are missing. |
| `when` | `{ step: <earlier id>, status: passed \| failed \| skipped }` (or a list). Otherwise the step is skipped. |
| `gate` | After the step passes, its output must match `pass`. If it doesn't, go back to `retry` (up to `max_loops`, default 2). When the loops run out, the run fails. |
| `continue_on_error` | A failure of this step doesn't fail the run. |
| `parallel` | A list of steps run concurrently (up to 4 at once) instead of `agent`/`task`. The group passes when every member passes. Groups can't nest. |

### Templates

| Expression | Value |
| --- | --- |
| `{{inputs.<name>}}` | A run input (after defaults) |
| `{{steps.<id>.output}}` | That step's final answer (for a parallel group: every member's answer under `## <id>`) |
| `{{steps.<id>.status}}` | `passed`, `failed`, `skipped`, … |
| `{{file:<path>}}` | A file in the run directory (up to 64 KiB). Paths can't leave the run directory. |
| `{{run.dir}}`, `{{run.id}}`, `{{loop}}` | Run directory, run id, current gate loop |

Add `?` to make a missing value empty instead of an error, for example
`{{steps.review.output?}}` on the first pass through a gate loop. Values are inserted
verbatim; nothing inside them is re-expanded.

## The blackboard (run directory)

Each run gets `.pi/workflows/runs/<run-id>/`:

```
state.json          status, current step, gate loops, per-step status/attempts/cost/run ids
steps/<id>.md       every step's final answer (what {{steps.<id>.output}} reads)
<anything else>     artefacts steps were asked to write, e.g. plan.md, report.md
```

Every step's subagent is told the run directory and the files already in it, so tasks can
say "write your findings to `findings.md`" and later steps can use `{{file:findings.md}}`.
Read-only roles (scout, planner) can't write files. Use their `{{steps.<id>.output}}`
instead. With `vault: true`, a passed run is copied to
`~/.pi/vault/Projects/<project>/Workflows/<run-id>/`, so it can be picked up from another
session or opened in Obsidian.

Each step is an ordinary subagent run, so it also has a log under `.pi/subagent/`
(`/subagents`, `subagent_status id=<run>`). The step's run ids are recorded in
`state.json`. A corrupt or wrong-shape `state.json` is ignored and not listed by
`/workflow status`, rather than crashing the status listing. The persisted state must
also carry a non-negative integer `cursor` and a finite `executions` count, or it is
treated as corrupt and skipped the same way. Each entry in `steps` must be a mapping whose
`status` is one of the known step statuses and whose `attempts` and `cost` are numbers and
`runIds` is an array of strings, and every value in `loops` must be a number; otherwise the
whole state is treated as corrupt.

## Execution rules

- Steps run top to bottom. A failing step fails the run, unless it has `continue_on_error`.
- Gates loop back to `retry`, and every step from there to the gate runs again.
- A run is capped at 60 step executions, counting loops.
- Resuming re-runs the interrupted step (in a parallel group, only the members that hadn't
  passed) and continues from there. `inputs` and finished outputs are kept.
- Subagents in a workflow get the same isolation as any subagent: `--no-extensions` plus
  the enabled safety extensions and the step's `extensions`. A subagent can't start another
  workflow.

## Shipped workflows

- **feature**: scout → plan → implement ↔ review (gate).
- **bugfix**: reproduce → diagnose → fix ↔ verify (gate). The reviewer re-runs the
  reproduction itself.
- **research**: three parallel scouts (code, tests, history) → synthesis → durable facts
  saved to memory; the run is copied to the vault.

## Writing your own: checklist

1. Put it in `~/.pi/agent/workflows/<name>.md` (all projects) or `.pi/workflows/`.
2. Give every task everything the subagent needs. It sees only its task, preloaded skills,
   and the run-directory note.
3. Pass results between steps with `{{steps.<id>.output}}`. Use files only when a writing
   role produces an artefact.
4. Gate on something the role reliably prints (the reviewer's `## Verdict` line).
5. `/workflow list` shows validation errors for files that don't parse.
