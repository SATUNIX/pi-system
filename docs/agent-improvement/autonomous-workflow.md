# Autonomous Pi improvement workflow

Invoke `pi-improve` with “run the pi improvement workflow” or “improve pi using your skills”. The seven maintained Codex skills are in [codex-skills/pi-improve](codex-skills/pi-improve/SKILL.md) and sibling phase folders. Install them into `~/.codex/skills/` together, preserving relative sibling links. The existing Claude skills inspired the six phases and evidence contract; Codex uses its available tools rather than Claude-specific Agent/Skill commands.

## Branch and review contract

`main` → `improvement/pi-autonomous` → `improvement/pi/<cycle-id>`.

Bootstrap the integration branch from a freshly fetched `main`. Workflow and shared evaluation infrastructure can be bootstrapped there before sibling cycles start. Each cycle pins that integration tip, uses a separate worktree and unique artifact directory, and opens a PR **back to the integration branch**. Cycles never merge each other. The human reviews and merges cycle PRs, then reviews the integration PR to `main`. Do not deploy changes that depend on either pending merge. Recheck remote heads before submission; report overlap/dependencies without rewriting reviewed history.

Use the original six-phase artifact layout in [README](README.md), with these additive manifest fields:

```json
{
  "schemaVersion": 2,
  "integrationBranch": "improvement/pi-autonomous",
  "integrationBaseCommit": "full SHA",
  "cycleBranch": "improvement/pi/UTC-cycle-id",
  "baselineRef": "origin/main",
  "harnessCommit": "full SHA",
  "dependencies": [],
  "outcome": "pending",
  "reviewStatus": "not_submitted",
  "pullRequest": null
}
```

`outcome` is pending/successful/partial/failed/inconclusive. `reviewStatus` is not_submitted/awaiting_human_review/changes_requested/merged. Phase completion means artifacts and checks completed; it never means human approval. Use atomic temp-file replacement for manifests. Find cycles across known worktrees and fetched cycle branches, not just one checkout. Resume only the selected cycle; an active sibling is not a reason to ask to abandon it.

The coordinator explicitly discovers this document through the integration worktree or `git show` when the default checkout is older. Refresh pending PR status, but exclude `awaiting_human_review` cycles from automatic resume. Select the latest actionable matching cycle or a new independent sibling. Do not use the old single-checkout `inject-cycle-state.mjs` as authoritative multi-worktree discovery. Compare main/integration ancestry: if main advanced, retain a separate integration-base comparison so unrelated changes cannot masquerade as cycle improvements.

When inference is unavailable, retry once per invocation, persist each blocked case and its exact pending command/configuration, and complete independent offline work. `validationStatus` additionally allows blocked/partial. An offline-supported fix may be submitted as a draft PR explicitly pending live checks; it is not successful live validation. Resume only outstanding checks when the backend recovers.

## Runtime and repeatability

Fetch first and record full SHAs; leave existing checkouts untouched. Prefer detached baseline worktrees. Record image ID/digest, Pi version, Node version, model/provider/API protocol, context/output settings, surface, exact case prompts, limits, selected checks, and whether baseline/candidate trees are clean. Shared model capacity is a confounder: serialize paired runs by default and report sample counts. Never invent missing usage or treat timeout consumption as zero.

The opt-in live runner (`packages/core/eval/live/README.md`) uses the Fleet Pi runtime image with a read-only kit mount, disposable synthetic workspaces, internal lab network and fixed inference relay. It does not modify the installed host Pi. Run a coding case and a local synthetic API authorization case; never infer permission for real engagement targets from a request to improve Pi. Keep credentials out of agent containers and committed evidence. Verify effective isolation, not just flags. Bound wall time, tools and inference requests. Clean up exact cycle-owned resources on success or failure; retain artifacts.

Example from a cycle checkout (inspect `--help`/source for current supported flags):

```powershell
node packages/core/eval/live/run.mjs --kit '<detached-baseline>' --provider pentest --cases hello,clarification,coding,cyber --timeout 180
node packages/core/eval/live/run.mjs --provider pentest --cases hello,clarification,coding,cyber --timeout 180
npm run verify
npm run test:security
npm run eval
```

Use existing configured model credentials in `~/.pi/agent/models.json` without printing them. If the image is unavailable, read `packages/kit/skills/wrapper-runtime-maintainer/SKILL.md` and the installed compose-workload skill before changing/building runtime definitions. Record unavailable live tests as blocked, not passed, while completing safe offline work.

Raw evidence defaults to `.pi/live-eval/<run-id>` and is untrusted model/target content. Review and redact before committing compact evidence under the cycle's `03-evidence/`. Commit summaries with exact run IDs, task outcomes, independent assertions, usage completeness, hashes and reproduction commands. Keep durable sanitized supporting evidence sufficient for reviewers; do not rely only on a local absolute path. Report report-writing quality separately from request-matrix completion. Missing reports, truncated events, infrastructure errors and skipped cases must remain visible.

## Agent-authenticated Gitea

Repository: `agrace1-standard/misc-agents-pi-kit`. Existing origin SSH can be used for read-only fetch; its human key must not be used for push. Current internal API is `http://10.0.2.73:3080/api/v1`; check current reachability/configuration rather than assuming this remains valid. The existing dedicated credential target is `git:http://coding-agent-a01@10.0.2.73:3080/agrace1-standard/misc-tooling-offsec-scripts.git` in Windows Credential Manager. Retrieve only that target via CredRead or a path-specific credential helper; verify username and authenticated `/user` response equal `coding-agent-a01`. Keep the secret in process memory. No generic credential fallback.

Use a dedicated remote such as `agent` with a username-qualified Pi repository URL, `credential.useHttpPath=true` locally and a process-local askpass/credential helper that supplies only the verified agent credential. Do not change global identity, global helpers or the human origin. Structure PR bodies as API JSON or a UTF-8 body file. Include problem, evidence, change, tests, known limitations and pinned integration base. Check existing PRs by head/base before creating to make submission idempotent. Report the actual server-assigned number.

Verified on 2026-09-08: this account cannot push upstream but owns the existing fork `coding-agent-a01/misc-agents-pi-kit`. Use remote `agent-fork` with `http://coding-agent-a01@10.0.2.73:3080/coding-agent-a01/misc-agents-pi-kit.git`. Both integration and sibling cycle branches are published there, with cycle PRs targeting that fork's integration branch. The aggregate PR uses head `coding-agent-a01:improvement/pi-autonomous` against upstream `agrace1-standard/misc-agents-pi-kit:main`. Record integrationRepository and upstreamRepository in manifests and fetch both remotes on resumption. A denied direct push is not a reason to use the human credential.

## Selecting valuable improvements

Rank by demonstrated task/reliability benefit, evidence confidence, implementation cost, risk and validation strength. Reproduce before attributing causality. Preserve negative and inconclusive findings. Prioritize incorrect completion/verification, lost state, unsupported security claims, unbounded work and measurement false passes. Efficiency means correct work per tokens/time, not shorter output at the expense of correctness. A small fixture sample supports a specific regression claim, not production readiness or broad pentest effectiveness.
