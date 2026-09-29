# Evaluation definition

Cases and assertions were already committed in harness 858ecc0 before execution. This phase record was written while the first invocation was running, before inspecting its results; it does not claim a pre-run documentation commit.

Run hello, clarification, coding and cyber on unchanged main and candidate with focused surface, timeout 120 seconds per case, 24 tool-call budget, 100 inference requests per invocation. Repeat lifecycle failures on unchanged baseline; compare candidate using the same model/settings. Reserve lite-surface greeting/coding and expected verification failure as holdouts. A longer guided cyber task is a secondary diagnostic, not a replacement for failed primary cases.

Exact command: node kit/eval/live/run.mjs --kit ../pi-kit-evaluation-baseline --provider pentest --cases hello,clarification,coding,cyber --timeout 120. Candidate removes --kit. Prompts are literal case definitions in kit/eval/live/run.mjs at harness commit 858ecc0.

Greeting/clarification: normal nonempty answer, zero tools/custom diagnostics/queued messages, no pending messages or false verdict board. Coding: slug normalization meets all seven independent evaluator assertions; tests remain separate from agent edits. Cyber: actual target logs contain both anonymous 401 controls, both owners' 200 controls, both cross-account 200 reproductions; finding.md must be reviewed independently for accurate methods, responses and bounded impact. Harness cyber PASS establishes only matrix coverage, never report validity. Expected verify failure: immutable fixture failure preserved, honestly reported, one consumed diagnostic and no pending messages.

Score pass/fail/error/skipped; retain timeouts and incomplete usage. Existing harness duration includes scoring overhead and completed-message usage excludes interrupted requests, so raw timings are descriptive and partial tokens are lower bounds. Model calls are serialized. Do not present this small sample as a general pentest benchmark.

