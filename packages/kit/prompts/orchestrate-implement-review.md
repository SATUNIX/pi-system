---
description: Planner → implementer → reviewer, looping until the reviewer passes
---
Use the `subagent` tool with `agentScope: "both"` to deliver: $@

1. `planner` — investigate and plan (read-only).
2. `implementer` — execute the plan (use `{previous}`). If the planner marked independent work units,
   spawn implementers in parallel with the `tasks` array; otherwise run sequentially.
3. `reviewer` — validate the result (use `{previous}`). If its Verdict is FAIL, run `implementer`
   again with the reviewer's must-fix list, then `reviewer` again.

If the `record_verdict` / `verdict_status` tools are available, record the reviewer's verdict and
treat `verdict_status` = PASS as the definition of done. Do not report the task complete until the
reviewer passes.
