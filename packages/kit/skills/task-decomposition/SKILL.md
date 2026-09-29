---
name: task-decomposition
category: coding-workflow
description: Break work into small, reversible, independently-verifiable steps. Use when a request is multi-step or multi-file, before starting to edit, to decide the checklist and step order first — use agent-orchestration separately to decide whether any step should be delegated to a subagent.
disable-model-invocation: true
triggers: ["break this down", "break it down", "break down the", "step-by-step plan", "plan the steps", "decompose", "multi-step change", "multi-file change"]
---

# Task Decomposition

Turn a request into a short checklist of steps small enough to verify and reverse.

## When to use
- The request has multiple parts, touches multiple files, or has ordering constraints.
- You feel the urge to "just start" on something large.

## Procedure
1. **Restate the goal** in one sentence.
2. **List steps** as a short checklist (aim ≤ 6). Split anything you can't verify in one go.
3. For **each step** define:
   - a **narrow write set** (which files/resources it changes),
   - the **expected behaviour/result**,
   - the **verification** that proves it.
4. **Mark dependencies.** Note which steps are independent (can be delegated/parallelized)
   vs. which must be sequential.
5. **Keep exactly one active step.** Complete and verify it before starting the next.

## Decision heuristics
- A step you can't verify is too big — split it.
- Independent steps with disjoint files → candidates for parallel sub-agents
  (`agent-orchestration`).
- If the checklist keeps growing mid-task, you're discovering scope — pause and re-plan.

## Anti-patterns
- One giant step that does everything.
- Interleaving multiple active steps.
- Sneaking unrelated refactors into a step.

## Done
Every step is small, has a write set + verification, and you're working exactly one at a
time in dependency order.
