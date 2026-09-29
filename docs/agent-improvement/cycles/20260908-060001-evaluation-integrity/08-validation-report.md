# Validation report

Measurement-integrity fixes passed validation. The live agent smoke on the pinned, unchanged kit behavior failed both completion cases; the coding artifact itself passed all seven independent assertions. These are separate outcomes.

## Revisions and environment

Original latest merged baseline: `4a7050ffb1912ed02631e7c2b43f98e4994a7165`; workflow/harness integration base: `858ecc0a1dd085efd61c4372aac75769a5c9738c`. Live smoke candidate: `fb78d730d427b09be876069d22fdd30f659963be`. Final source: `5094ee8` (only UUID run naming and network ownership cleanup changed after live smoke; validated offline). No sibling cycle code was incorporated.

During the session the human merged upstream PR #6. Latest upstream is now `329c344996056a2664b4e63ebc72ea24fef12858`, verified via the shared repository's origin/main. It includes verifier behavior fixes absent from this cycle's pinned kit. This cycle was not rebased and its old-base smoke must not be presented as a fresh assessment of that newer main. The coordinator owns the latest-main assessment.

Live run `pi-eval-1788852302507`, one hello and one coding attempt, used focused surface, provider pentest, model `qwen3.8-27b-uncensored`, protocol openai-responses, Pi 0.76.0, host Node v24.14.0, and image `sha256:f7e2db957dbcee1dd8668625def48e1721c87dff984fa942a0edc629e0a95294`. Explicit model context/output limits were absent from configuration and captured requests; backend defaults remain unknown. Bounds: 180 seconds per case plus cleanup, 24 tool calls per case, 100 relay requests per invocation. Inference was serialized with sibling cycles. Small offline checks/validator cleanup probes overlapped this run, so host contention may affect wall time.

## Live outcomes and consumption

| Case | Completion outcome | Agent time | Scoring time | Observed tokens | Evidence |
| --- | --- | --- | --- | --- | --- |
| hello | Failed: one queued steering item, lifecycle pending=true; zero tools | 66,543 ms | 2 ms | 1,597; complete visible usage | Host stream and lifecycle retained; a benign greeting alone did not hide the existing queue failure. |
| coding | Error: timed out, exit137, no agent_end/lifecycle completion; five tools | 180,300 ms | 377 ms | 8,351 lower bound; authoritative total null | Correct slug implementation passed seven independent isolated assertions; full task completion failed. |

Observed failed-run consumption was at least 9,948 tokens including cache usage. Complete provider billing, hidden retries and unreported interrupted usage are unknown; provider-reported zero prices do not establish free billing. Case wall times include setup/scoring separately (66,549 ms and 180,681 ms); neither measures pure inference latency. No speed or token-efficiency improvement is claimed from these single observations.

The first failed result was written before coding started. Both results persisted despite the latter's absent lifecycle evidence. The runner exited1 and removed every exact run-owned container/network. `03-evidence/live-smoke/` retains summary, runtime, isolation, reduced host events, source hashes and coding output. `coding-artifact-recheck.log` records the successful seven-assertion recheck without another model call.

## Controlled before/after and holdouts

| Concern | Baseline evidence | Final validation |
| --- | --- | --- |
| Empty cyber report false pass | Two complete-matrix probes falsely passed; two incomplete-matrix nulls failed | Empty and whitespace reports fail; complete matrix plus nonempty prose is behavioral success with pending independent evidence review, passed=null and CLI exit2. |
| Missing/corrupt evidence loses cases | Two missing-target probes threw uncaught ENOENT | Missing, malformed, empty and wrong-shape target evidence; missing/corrupt boards; bad lifecycle/events all yield structured failures. A later healthy case still persists. |
| Incomplete event accounting | Raw completed-message usage only | Multiple messages/cache tokens, absent/invalid fields, interrupted generation and unfinished follow-ups preserve observed sums with null complete totals. |
| Evaluator time inflates agent time | Coding validator ran before the single duration stopped | Injected-clock test separates 350 ms scoring from 23 ms captured agent time; real smoke also publishes both boundaries. |
| Process timeout/cleanup | Parent review identified unowned validator names and a stop-dependent CLI wait | A real hung child exits even if stop throws. Two no-inference Docker timeout probes removed their exact validators. Initial probe's case-sensitive error-text assertion was corrected and retained as a test-only failure record. |
| Concurrent run isolation | Timestamp-only ID and unconditional network cleanup | UUID IDs plus networkCreated guard; syntax/source review and required offline checks passed after this final change. |

Final checks: 31/31 integrity tests, repository verify, both security fixtures and 13/13 offline eval fixtures passed. Logs are retained. Alternate controls include wrong invoice paths, prior-case requests, structurally malformed records, missing agent_end and a second unfinished follow-up. Real hello/clarification event schemas reused from the coordinator's run were compatible; those two extracts are reused evidence, not new samples.

## Review, limitations and remaining boundary

The coordinator independently reviewed code and reran 31 tests, requesting pending-review exit2, bounded CLI fallback, exact validator cleanup and UUID/network ownership. Those changes are included. Report evidence can be reviewed autonomously; only PR merge requires the human. No merge, deployment or credential writes were performed by this cycle agent.

Agent prompts/extensions/governance were unchanged. This work prevents false evaluation conclusions; it does not improve model reasoning or guarantee useful security reporting. Unsupported security-report extrapolation is a separate known focus under coordinator review, not fixed here. Global Docker/network setup failures before case execution and an unavailable output filesystem still require workflow-level error reporting. An abrupt host kill can still require exact-resource manual cleanup.

The deterministic findings are resolved without observed regression. Submit this cycle for review against the integration branch; preserve the newer-main metadata and distinguish code validation from the failed old-base live behavior.
