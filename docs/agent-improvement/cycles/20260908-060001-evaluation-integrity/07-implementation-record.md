# Implementation record

The report/findings commit is `8fe936b`; the plan commit is `fb0c342`. New implementation commits, all authored with repository-local Coding-Agent-A01 identity:

- `c01a015`: EI-01/EI-02/EI-03. Extract strict evidence scoring and usage coverage to `kit/eval/live/scoring.mjs`; wrap selected cases with persistence/continuation; preserve file-descriptor/timer cleanup; separate agent/scoring/case duration; represent cyber automated success as pending independent review. Document result fields in `kit/eval/live/README.md`. Add 26 regressions in `tests/live-evaluation-integrity.test.mjs`.
- `58e2963`: EI-01 holdout review found that an unfinished follow-up could reuse an earlier agent_end and structurally invalid message records needed tighter validation. Count agent starts/ends and require message roles/content shape; add two holdout regressions (28 total).

Final code checks passed: 28/28 integrity tests, `npm run verify`, both `npm run test:security` fixtures, and 13/13 `npm run eval` fixtures. Logs are in `03-evidence/candidate-*`. `node --check kit/eval/live/run.mjs` and `git diff --check` also passed. Required checks were repeated after the two holdout corrections.

The actual protected hello/clarification streams from coordinator-owned run `pi-eval-1788851845914` were inspected read-only to verify event schemas. Reduced lifecycle/role/usage extracts, source SHA-256 values and summaries are retained under `03-evidence/schema-*` and `real-stream-schema-check.log`. They are reused evidence, not independent samples or agent improvements credited to this cycle. Both have complete usage coverage under the new scorer.

No changes to model/provider, prompts, kit extensions, Docker isolation, deployed runtime or sibling worktrees. A live smoke awaits the coordinator's serialized inference slot. A broad automatic report-grounding grader remains deferred. Global Docker/network setup failures before the case loop still require workflow-level blocked-run reporting; this change guarantees case-result continuation once case execution starts. Unexpected filesystem persistence failure remains fatal because no durable result can be promised on an unavailable output filesystem.

Coordinator clarification: report factual quality can be assessed autonomously by an independent reviewer against protected logs. The human-only gate is PR merge. Raw runner results stay pending review and must not be presented as full report approval.

Final review commits: `470bf3f` clarifies independent evidence review; `fb78d73` adds pending-review exit2, bounded host process termination and named validator cleanup; `5094ee8` adds UUID IDs and successful-network-creation ownership. The last change followed live smoke without new inference. Final suite count is 31 (all passed). Named validator cleanup additionally passed two deliberate Docker timeouts. The full review and live outcomes are recorded in 08/09.
