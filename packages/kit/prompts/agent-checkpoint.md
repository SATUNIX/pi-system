---
mode: checkpoint
token_budget: small
requires_mcp_tool: pi_system_governance.checkpoint_append
output_block: task_state
---

# Agent Checkpoint

Summarize the current task for continuation.

Preserve:

- Objective and current state
- Constraints and approvals
- Files inspected
- Files changed
- Decisions and rationale
- Failed attempts
- Validation run and results
- Pending next step

Exclude secrets and sensitive target data.

Return this stable block:

```text
task_state:
  objective:
  status:
  constraints:
  files_inspected:
  files_changed:
  decisions:
  failed_attempts:
  validation:
  evidence_ids:
  verification_ids:
  next_step:
```

Then append the same content through `pi_system_governance.checkpoint_append`.
