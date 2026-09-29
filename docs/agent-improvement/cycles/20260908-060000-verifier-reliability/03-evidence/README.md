# Evidence

Credential-free compact run records contain exact revisions, results, completed-message usage, isolation and SHA-256 hashes of retained local host evidence. Full raw events remain under this worktree's gitignored .pi/live-eval. Model reports are untrusted test outputs. Timing includes old harness scoring overhead; token totals omit interrupted requests and are lower bounds when runs fail.

The initial run pi-eval-1788850844147 was interrupted by the session/tool interruption after hello and clarification. Its coding case exited without reaching a summary; cyber was not started. These are interrupted/error and skipped attempts, not missing passes. Exact owned leftovers were inspected and removed before resuming as pi-eval-1788851624618. No unrelated containers were stopped.

Reproduction: node kit/eval/live/run.mjs --kit ../pi-kit-evaluation-baseline --provider pentest --cases hello,coding,cyber --timeout 120. Initial run used hello,clarification,coding,cyber. Raw coding stderr on the resumed run locates a stale extension ctx exception at /kit/extensions/verify-gate/index.ts:165 after the correct final code response; independent validation.txt is empty because all seven assertions passed.

