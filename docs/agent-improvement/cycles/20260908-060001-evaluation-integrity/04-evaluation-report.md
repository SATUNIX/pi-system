# Evaluation report

Baseline harness: `858ecc0a1dd085efd61c4372aac75769a5c9738c`; latest merged kit assessed by the coordinator: `4a7050ffb1912ed02631e7c2b43f98e4994a7165`. These findings concern the new harness, not defects attributed to merged Pi or measurements of model competence.

Two deterministic repetitions of the extracted, unchanged cyber scorer each falsely passed a complete request matrix with an empty existing finding. Two incomplete-matrix null controls correctly failed. Two missing-target-log probes each threw uncaught ENOENT instead of emitting a case result. Evidence: `03-evidence/baseline-probe.mjs` and `baseline-probe.log`. The source comparison establishes the timing boundary and raw usage behavior. No inference was used; model/profile and token consumption are not applicable. Probe wall time was not recorded and must not be inferred from the baseline suite logs.

Baseline checks passed: verify, both security smoke tests, and 13/13 offline eval fixtures. Their logs are retained. The scheduled live smoke has not run; the coordinator serializes model capacity. Its status is pending, not a pass.

| Rank | Finding | Confidence / impact | Recommendation |
| --- | --- | --- | --- |
| 1 | EI-01: missing or malformed evidence can abort the case loop before summary persistence | High, deterministic reliability failure | Convert case exceptions into durable error results and continue later cases; fail closed on malformed required evidence. |
| 2 | EI-02: a report path plus request matrix is called cyber PASS even for empty prose | High, deterministic false success | Require nonempty report deliverable and publish behavioral outcome separately from explicitly pending independent report review. Do not invent a prose grader. |
| 3 | EI-03: duration includes host scoring and usage lacks totals/completeness | High for boundary/schema, benefit limited to honest measurement | Record agent-process, scoring and total durations separately; sum available usage and label missing or interrupted coverage. |

These changes improve evaluability and prevent unsupported reliability/efficiency conclusions. They cannot demonstrate better engineering outcomes or pentest report factual quality. Defer automatic report grounding, broader benchmarks and runtime behavior changes to independent cycles.
