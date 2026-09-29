---
description: Scout + planner produce an implementation plan (no code changes)
---
Use the `subagent` tool with `agentScope: "both"` and chain mode to plan (do NOT implement):

1. `scout` — gather all code relevant to: $@
2. `planner` — produce a concrete implementation plan for "$@" using the scout's findings (use the `{previous}` placeholder)

Return the plan. Do not modify any files.
