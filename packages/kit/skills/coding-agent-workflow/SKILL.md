---
name: coding-agent-workflow
category: coding-workflow
description: Reliable small-step coding — repo maintenance, bug fixes, features, refactors. Use for any change to a codebase. Emphasizes locating before reading, one active step, smallest change, and verifying.
---

# Coding Agent Workflow

The reliable loop for changing code without thrashing or over-reaching.

## When to use
- Repository maintenance, bug fixes, feature work, refactors — any code change.

## Procedure
1. **Orient cheaply.** Read local instructions (CLAUDE.md/AGENTS.md), then *locate* the
   relevant code by searching — do not browse files. See `codebase-navigation`.
2. **Scope the write set.** Name the specific files you expect to change. If the list is
   large or spans independent areas, decompose (`task-decomposition`) or delegate
   (`agent-orchestration`).
3. **One active step.** Finish the current step before starting the next. Do not open new
   threads of work mid-edit.
4. **Match the codebase.** Reuse existing patterns, helpers, and naming. Read like the
   surrounding code; do not import new conventions without reason.
5. **Smallest change that satisfies the goal.** No opportunistic refactors, no unrelated
   files, no reformatting churn (`patch-hygiene`).
6. **Verify.** Run the smallest check that can disprove the change (`verification-loop`).
7. **Report.** Changed files, verification result, and any residual risk.

## Decision heuristics
- Don't fully understand the module? Get the one fact you need, not a tour.
- Change touches 3+ independent areas? Decompose or delegate rather than hold it all.
- Tempted to "clean up while I'm here"? Don't — separate change, separate intent.

## Anti-patterns
- Reading many files to "understand everything" before making a one-line fix.
- Re-reading files already in context (`/trace` shows repeats).
- Bundling an unrelated refactor into a fix.
- Reverting user changes not part of the task.

## Done
The narrow change is made, the closest validation passes, and you can name exactly what
changed and what risk remains. Never revert user changes unless explicitly asked.
