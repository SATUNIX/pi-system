# CLAUDE.md — working conventions for developing this repo with Claude Code

This file records development conventions for agents working *on* `pi-system`. It is
distinct from `AGENTS.md`, which is what the *shipped pi agent itself* reads about
installing and using the kit.

## Repo conventions

- Run `npm run verify` and `npm run test:security` before considering any change to
  `packages/core/`, `packages/extensions/` or `packages/kit/` done. For documentation
  changes, also run `python -m mkdocs build --strict`: the `docs-build` CI job is strict, and
  a link to a path outside `docs_dir` (for example `../packages/...`) aborts the build. Keep
  such references as code spans, not markdown links.
- Follow the existing commit-message convention (see recent `git log`):
  finding / root-cause / fix / verification in the body, not just a one-liner.
- Treat any roadmap or audit doc's summary as a hypothesis to verify against the actual code,
  not as ground truth — this repo has direct precedent for stale audit docs (see the status
  banner in `docs/improvement-roadmap.md`).
- Keep patches scoped. Do not run a repo-wide formatter, and do not "tidy" files you were not
  asked to change: whitespace churn over unrelated files makes the real diff unreviewable.
- Never commit on another agent's behalf, and never push to a protected branch.

## Agent improvement loop (`/pi-improve`)

This repo hosts the live-testing/improvement cycle system documented in full at
`docs/agent-improvement/README.md` — read that document, not this section, for the actual
process, schema, and phase definitions. The coordinator and phase skills that drive it are
versioned in this doc tree under `docs/agent-improvement/codex-skills/`, and the Codex
submission workflow is described in `docs/agent-improvement/autonomous-workflow.md`.

Personal, cross-repo Claude tooling that used to live at `~/.claude/skills/pi-improve*/` and
`~/.claude/agents/pi-improve-*.md` is **not** tracked here — `.claude/` is gitignored in this
repo.

### Compact preservation

If a `/compact` happens while `docs/agent-improvement/cycles/*/cycle-state.json` shows an
in-progress cycle, the compacted summary must preserve:

- The current cycle ID and its `focus`.
- Current branch/worktree, in every repo the cycle touches.
- Current phase and next phase.
- Baseline commit and latest commit, per repo.
- The cycle directory path and which artefacts already exist in it.
- `validatedFindingIds` and `approvedImprovementIds`.
- `modifiedFiles` and `testCommands` from the manifest.
- Any unresolved `blockers`.

Treat `cycle-state.json` and the committed artefacts under
`docs/agent-improvement/cycles/<cycle-id>/` as authoritative — discard raw logs, repeated
reasoning, superseded hypotheses, and rejected findings from the conversation; they are either
already in a committed artefact or were correctly triaged out and do not need to survive
compaction.

A `SessionStart` hook (personal and gitignored, e.g. `.claude/settings.local.json`)
re-injects a short factual summary of any in-progress cycle at the start of a fresh session,
reading only `cycle-state.json` — never an LLM-reinterpreted summary of prior conversation.
This is the primary recovery path after a cycle spans multiple sessions; the `PreCompact` hook
is a same-session reminder for the less common case of compacting mid-cycle within one long
coordinator session.
