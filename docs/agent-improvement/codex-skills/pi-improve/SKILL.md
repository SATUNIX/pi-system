---
name: pi-improve
description: Use when asked to improve Pi, run the Pi improvement workflow, test the latest Pi kit, or resume an autonomous Pi reliability, token-efficiency, coding or pentest improvement cycle. Tests the pi-system checkout in disposable labs, records evidence, implements supported fixes and submits cycle PRs.
---

# Pi improvement coordinator

Default repository is the local `pi-system` monorepo checkout (a Git common directory that may be shared across worktrees). Resolve its Git common directory and read the root AGENTS.md. Preserve existing worktrees and local changes. Historical machine notes in `~/.claude/skills/pi-improve*/` are useful context, not evidence of today's runtime.

Read the kit's `docs/agent-improvement/README.md` and `docs/agent-improvement/autonomous-workflow.md`. If the default checkout lacks the latter, use `git worktree list --porcelain` to locate `improvement/pi-autonomous` (initial worktree: sibling `pi-autonomous-workflow`), or read it with `git show agent-fork/improvement/pi-autonomous:docs/agent-improvement/autonomous-workflow.md` after fetching the fork remote documented below. Do not switch a dirty checkout. The latter document defines Codex branch/review semantics and supersedes the older Claude-only dispatch/path assumptions. Run phase skills below progressively; they are installed together and their maintained sources live beside this skill in `docs/agent-improvement/codex-skills/`.

## Invocation and durable state

- `improve pi using your skills`, `run the pi improvement workflow`, or `$pi-improve`: resume a compatible unfinished cycle, otherwise start a focused cycle. Default to a coding task, a synthetic authorization task and a cheap lifecycle control when no focus is supplied.
- `status`: read manifests and remote PR state, report only.
- `new <focus>`: create a sibling cycle without abandoning existing cycles.
- `resume <cycle-id>`: resume from committed artifacts, verify resource ownership and current dependencies; retry recoverable environment errors once. Continue independent work when one item is blocked.
- Several requested focus areas may use independent agents, each with its own worktree, branch, manifest and containers. Serialize model calls by default to avoid shared-backend timing contamination; parallelize live inference only with recorded capacity and contention.

Cycles awaiting human review get a remote status refresh, not repeated implementation/testing unless review changes are requested. Exclude them from automatic resume selection. Prefer the most recently updated actionable cycle matching the requested focus; otherwise create one independent sibling within scope. Record this selection. With unavailable inference, retry once per invocation, record every affected case as blocked with pending commands/configuration, and continue offline-supported work. Such work may be submitted as a draft PR with `validationStatus: blocked` or `partial`, never as live-validated success. Resume only outstanding cases after backend recovery.

Fetch the remote and record the exact latest merged default-branch SHA. Record any newer committed candidate separately; unreviewed commits never become an unlabeled baseline. Start or fetch `improvement/pi-autonomous` as the shared integration branch. Create `improvement/pi/<UTC-cycle-id>` from its pinned tip in a separate worktree. Never silently pull, reset, merge or cherry-pick another cycle into the integration branch. Record base SHA and dependencies.

Check main/integration ancestry. If main advanced beyond integration, test latest main for the requested current-state assessment and the pinned integration base for causal before/after comparison. Label both. Request human integration update through a PR when needed; never attribute unrelated base differences to the cycle's fix.

## Phase routing

1. [pi-improve-baseline](../pi-improve-baseline/SKILL.md): pin baseline/runtime/model, define cases and budgets before running.
2. [pi-improve-evaluate](../pi-improve-evaluate/SKILL.md): run isolated live tasks, retain failures and protected evidence.
3. [pi-improve-report-triage](../pi-improve-report-triage/SKILL.md): independently score outputs, reproduce material findings, commit ranked report.
4. [pi-improve-plan](../pi-improve-plan/SKILL.md): choose fixes supported by evidence; user instruction to improve authorizes routine implementation planning.
5. [pi-improve-implement](../pi-improve-implement/SKILL.md): implement in the cycle worktree, test and commit with finding traceability.
6. [pi-improve-verify-review](../pi-improve-verify-review/SKILL.md): paired reruns and holdouts, review, submit PR to integration branch.

Check required artifacts before advancing; atomically update `cycle-state.json`. Files, tests and remote PR state are authoritative, not an agent's completion claim. Separate evaluation outcome, implementation status and review status. End a submitted cycle as `awaiting_human_review`; do not claim merged/deployed/completed integration. Start additional cycles only within the user's requested scope; one invocation is not permission for an unlimited loop.

## Submission identity and boundary

Use repository-local `Coding-Agent-A01 <coding-agent-a01@gmpk.net>`. Push and call Gitea as `coding-agent-a01` with its Windows Credential Manager credential; verify `/api/v1/user` before writes. Never print tokens or place them in files, Git URLs or process arguments. Use a username-qualified agent remote and local HTTP path isolation. See the workflow's credential procedure. Do not use the human SSH push identity. Open/update cycle PRs targeting `improvement/pi-autonomous`; a final integration PR targets `main`. The human reviews and merges both levels. No self-approval, self-merge or deployment dependent on unmerged changes.

The repository coordinates and fork names in this section describe the historical submission target for the predecessor kit. Re-verify the current remote, fork owner and default branch for this monorepo before using them; do not assume `misc-agents-pi-kit` still names the repository. The existing submission repository was the fork `coding-agent-a01/misc-agents-pi-kit`: the dedicated account has no upstream push permission. Integration and cycle branches/PRs live in that fork; the integration PR goes from `coding-agent-a01:improvement/pi-autonomous` to `agrace1-standard/misc-agents-pi-kit:main`. Fetch the fork integration tip through the `agent-fork` remote for new cycles, and fetch upstream `origin/main` for latest merged baseline. Record both repository owners in manifests. Do not ask for broader privileges when the fork workflow suffices.

Use [scripts/gitea-agent.ps1](scripts/gitea-agent.ps1) from the cycle worktree for the tested credential/identity/submission procedure. `-Action user` verifies identity; `-Action list -Owner coding-agent-a01` discovers open cycle PRs; `-Action push -Owner coding-agent-a01 -Branch <cycle-branch>` pushes without force; `-Action pr -Owner coding-agent-a01 -Branch <cycle-branch> -Base improvement/pi-autonomous -Title <title> -BodyFile <UTF8-file>` creates/updates the matching PR. For the aggregate PR use `-Owner agrace1-standard -HeadOwner coding-agent-a01 -Branch improvement/pi-autonomous -Base main`. Review the concrete diff/body before invoking mutations. The helper stores no credential and never falls back to a human identity.

Final report: baseline/candidate SHAs, model/profile, task results and sample sizes, measured tokens/timing with uncertainty, ranked improvements and deferred work, report paths, PR numbers, remaining review/deployment boundary. Never represent offline fixture success as live-agent competence.
