# verifier-board

The definition-of-done gate. Checks, reviewers, and validators record verdicts
in `.pi/verdicts.json`. The latest verdict per source wins. The mission is not
complete until every verdict passes, none is stale
(`PI_KIT_VERDICT_MAX_AGE_MS`, default 24 hours), **and at least one trusted,
independent source is present and passing**. Trusted sources are `verify`,
`review`, and `validator:<id>` — the independent writers. An untrusted-only
board (for example a single self-recorded `reviewer` pass) never satisfies
done, however many PASSes it holds.

It is not tied to a test runner. Typical sources:

- `verify`: the project check command (verify-gate).
- `review`: verify-gate's independent completion reviewer.
- `validator:<id>`: conductor finding validators.
- any reviewer subagent, through `record_verdict`.

## Tools and command

| Name | What it does |
|---|---|
| `record_verdict` | Records a verdict with a summary and optional evidence. For results from a check or reviewer, not self-grading. |
| `verdict_status` | Shows each verdict, the goal, todo and task progress, the latest `.pi/verify-report.md`, and the next step. |
| `/verdicts` | Same view for the operator. `/verdicts clear` resets the board. |
