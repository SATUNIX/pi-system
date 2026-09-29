---
name: pi-improve-verify-review
description: Use when performing the verify-review phase of the Pi improvement workflow. Validate Pi changes against baseline and holdouts, review evidence and submit cycle PRs for human merge.
---

# Pi improvement: verify-review

Read committed plan/report and actual diffs. Rerun motivating cases with the same model/profile/settings and at least one holdout or alternate surface. Record repeated failures too; separate behavioral improvement from measurement changes. Run required offline checks once on final code and relevant regressions. Retain supporting sanitized evidence.

Review correctness, isolation, credential handling, evidence integrity, timeout/cleanup and unbounded retries. Use a bounded independent subagent review when available and authorized; still verify reported artifacts locally. A model reviewer cannot approve or merge a PR.

Write 08-validation-report.md and 09-final-summary.md with before/after, sample counts, measurements and uncertainty, accepted fixes, deferrals and next evaluations. Update outcome separately from review status. Commit and push through verified coding-agent-a01 credentials. Open or update one PR from the cycle branch to improvement/pi-autonomous; check existing head/base PRs first.

Set reviewStatus=awaiting_human_review and record actual PR number/base/head. Recheck remote head after pushing. Do not merge/approve cycle or integration PRs, and do not deploy dependent changes. Report concrete results and wait for the human merge; future invocations can resume or run independent siblings. Coordinator: ../pi-improve/SKILL.md.

