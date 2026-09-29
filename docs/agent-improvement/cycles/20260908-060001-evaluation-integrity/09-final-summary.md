# Cycle summary

Validated and implemented EI-01/EI-02/EI-03: evaluation failures are durable and later cases continue; security request-matrix success is separated from independent report review; token/timing completeness is explicit. Review follow-ups also prevent a pending report from giving CI a green exit, bound host process termination, clean up exact validator containers, and isolate simultaneous runs with UUID names and network ownership checks.

Final source commit: `5094ee8`; integration base: `858ecc0`; live candidate: `fb78d73`. Report and plan were committed before implementation (`8fe936b`, `fb0c342`). All 31 integrity regressions, verify, security and 13 offline eval fixtures pass. Two deliberate Docker validator timeouts cleaned up correctly.

Live old-base smoke (one attempt each) failed hello completion because of pending steering and timed out coding at 180 seconds. Coding still produced a correct artifact (7/7 independent checks). Observed consumption: 1,597 complete hello tokens plus at least 8,351 coding tokens; no measured speed or model-quality improvement is claimed. The scorer retained both failures and cleaned the lab.

Upstream main advanced during this cycle to `329c344996056a2664b4e63ebc72ea24fef12858` after human PR #6 merge. It contains verifier fixes absent from this pinned cycle; the coordinator separately assesses that latest main. Do not relabel this cycle's live smoke as current-main performance or silently rebase it.

Best next improvements: address observed report claims against protected request/response evidence, broaden coding tasks beyond one function, and test longer recovery sessions with explicit model budgets. Global setup/persistence failure reporting remains a bounded harness follow-up. These are deferred, not credited as implemented.

The complete evidence and comparisons are in `08-validation-report.md` and `03-evidence/`. Submitted as [cycle PR #1](http://10.0.2.73:3080/coding-agent-a01/misc-agents-pi-kit/pulls/1) to `improvement/pi-autonomous`; review status is awaiting_human_review. The human controls merge and any dependent deployment.
