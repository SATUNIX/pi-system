---
name: pi-improve-baseline
description: Use when performing the baseline phase of the Pi improvement workflow. Pin Pi improvement baselines and define coding or synthetic cybersecurity evaluations before a cycle runs.
---

# Pi improvement: baseline

Read the coordinator, repository AGENTS.md and cycle manifest. Fetch the remote, resolve latest merged main and integration tips, and record newer candidate commits separately. Create a detached clean baseline and a cycle worktree from the integration branch without changing existing checkouts.

Record full kit/harness/runtime SHAs, image ID, Pi/Node versions, model configuration excluding secrets, surface/extension list, budgets and dirty state. Inspect package.json and run verify, test:security and eval; distinguish pre-existing failures from new ones. Offline fixture passes are not live model results.

Define exact prompts and external acceptance checks in 02-evaluation-definition.md before running. Include coding with hidden host assertions, synthetic authorization controls with independently captured target logs, and a low-cost lifecycle control. Reserve at least one holdout or alternate surface. State repetitions and resource limits; serialize live model calls unless contention is explicitly measured.

Write 01-baseline.md, definition and initial manifest. Required files and runnable test names must agree. Commit before evaluation; no model credentials or raw model configuration. Next: ../pi-improve-evaluate/SKILL.md.

