# Verifier reliability cycle summary

Latest committed main `329c344996056a2664b4e63ebc72ea24fef12858` passed the fresh greeting and coding samples: 9.880 seconds / zero tools / 1,557 recorded tokens, and 54.532 seconds / six tools / 11,036 recorded tokens respectively. Coding passed seven evaluator-owned checks. Both sessions exited cleanly without queued steering or pending messages.

Historical baseline `4a7050f` reproduced false verification after greetings and a stale-context exception after an otherwise correct coding artifact. The scoped verifier/orchestrator implementation `441edc7` resolves those observed lifecycle failures and passes the clarification, focused/lite greeting and expected-verification-failure cases. Required offline checks passed, including 13 evaluation fixtures. The human merged the same verifier implementation upstream in PR #6 while this cycle was running; this cycle supplies paired evidence and remaining-risk analysis, not a second new implementation gain.

Security performance remains insufficient. Both predeclared 120-second synthetic authorization runs timed out, and the candidate lacked a finding at cutoff. A separate guided 300-second diagnostic also timed out after eight tools and at least 20,971 recorded tokens. It completed the request matrix and wrote a report, but still included unsupported generalizations, a sequential-ID claim and an incorrect evidence reference. No Terminal-Bench or ExploitGym score is established by these synthetic samples, and no reliable overall token-efficiency gain is claimed.

The best next improvements, in priority order, are:

1. Require successful bounded task completion and evidence-linked report claims; distinguish completed target controls, report accuracy and session completion in scoring.
2. Remove extension load-order sensitivity with an explicit verification-completion contract and regression coverage for both orders. Current observed installation order is safe, but reversed order loses a diagnostic after prior PASS, an edit and failing verification.
3. Broaden coding evaluation with pinned Terminal-Bench tasks, fixed private holdouts, repeated champion/challenger comparisons and complete token/time accounting before promoting changes.
4. Cover shell-only edits, non-npm verification and workspace-bound freshness; these were outside the implemented fix.

The full attempt ledger and sanitized evidence are in `08-validation-report.md` and `03-evidence/`. Raw event streams and credentials are excluded; source stream hashes are retained. Outcome is partial because coding/lifecycle checks pass while security completion and report quality remain unresolved. Submitted as [cycle PR #2](http://10.0.2.73:3080/coding-agent-a01/misc-agents-pi-kit/pulls/2) to `improvement/pi-autonomous`; review status is awaiting_human_review and is recorded separately from the partial outcome in `cycle-state.json`. No agent merge or deployment is authorized by a successful test.
