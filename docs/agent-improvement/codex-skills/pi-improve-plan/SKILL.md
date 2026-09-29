---
name: pi-improve-plan
description: Use when performing the plan phase of the Pi improvement workflow. Turn validated Pi performance findings into bounded, measurable implementation work and explicit deferrals.
---

# Pi improvement: plan

Read committed evaluation report/findings and the root-cause source files. For each validated finding either propose a scoped fix or explicitly defer with reason. Record finding ID, principle, files, hypothesis, expected measurable benefit, risk, acceptance test, regression/holdout and rollback in 06-improvement-plan.md.

A request to test and implement improvements authorizes routine code changes; do not introduce a separate approval gate for drafting or executing this plan. Human review remains at the PR merge boundary. Do not weaken real engagement governance to make a synthetic benchmark pass.

Keep sibling cycles independent from the pinned integration base. Record an explicit dependency if a fix requires an unmerged sibling; implement independent portions while waiting. Set approvedImprovementIds as authorized scope, not as a claim of human PR approval. Commit plan before code. Next: ../pi-improve-implement/SKILL.md.

