# Improvement plan

Authorized by the user request to test and implement improvements. Report/findings were committed as `8fe936b` before this plan. Human approval is required at PR merge, not for this implementation.

## I-EI-01: preserve failed evidence and case coverage (EI-01)

Principles: reliability and observability. Extract evidence scoring into `kit/eval/live/scoring.mjs`; add a reusable case boundary that persists each result, including exceptions. Update `run.mjs` to execute every selected case through that boundary and close child resources in finally. Required event/lifecycle/target/verification evidence must distinguish missing, malformed and valid records. Preserve available usage on later scoring failure. Expected benefit: every attempted case has a durable result; one corrupted artifact cannot discard later cases. Risks: stricter evidence checks expose previously hidden failures; report them honestly. Acceptance: absent/corrupt target and verdict files yield structured error outcomes; a subsequent case still passes. Holdout: malformed/truncated event and lifecycle records. Rollback: revert implementation commit.

## I-EI-02: distinguish cyber behavior from report review (EI-02)

Principles: effectiveness and observability. Score exact target request paths and the six-case authorization matrix; require nonempty report content. Publish `behavioralPassed`, `reportReview.status=pending`, and an outcome that cannot be read as fully reviewed PASS. Matrix artifacts retain missing controls. Expected benefit: empty report false passes become failures and prose quality remains explicitly unreviewed. Risks: summary consumers must distinguish behavioral success from reviewed success. Acceptance: complete matrix with empty/whitespace report fails; nonempty report gives behavior success plus pending review; incomplete matrix fails. Holdout: unrelated paths must not count as invoice requests. Rollback: revert implementation commit.

## I-EI-03: correct efficiency accounting (EI-03)

Principles: efficiency and observability. Preserve existing raw usage while adding available token/cost sums, coverage counts, reasons for incompleteness and nullable authoritative totals. Agent duration ends on process completion; scoring and case totals get independent fields. Expected benefit: consumers can compare agent time separately and never treat missing failed-run usage as zero. Risks: provider usage fields differ; absent fields stay unknown rather than being inferred. Acceptance: multiple completed messages, cache tokens, absent/partial usage, malformed stream and interrupted generation produce expected sums and completeness. Holdout: failed process with known completed usage retains observed consumption but marks it a lower bound. Rollback: revert implementation commit.

## Verification and deferrals

Run `node --test tests/live-evaluation-integrity.test.mjs`, `npm run verify`, `npm run test:security`, and `npm run eval` on final code. Run serialized live smoke only after coordinator grants capacity; label a backend failure or absent slot separately from offline success. Do not modify prompts, package/runtime versions, governance, profiles, or sibling cycle code. No dependency on sibling changes. Defer automatic prose grading and generalized competence/efficiency claims. Submit this cycle to `improvement/pi-autonomous` through the coordinator without self-merge.
