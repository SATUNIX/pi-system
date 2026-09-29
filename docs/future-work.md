# Future work

Tracked improvements and open investigations. Each item records the reported symptom, the
evidence found so far, ranked hypotheses, the smallest useful next step, and acceptance
criteria. Items are not ordered by severity; see the priority table.

Nothing here is a decision — where an item implies a behaviour change in a safety mechanism
(tool approval, compaction, subagents), the change must be reviewed as a change to that
mechanism, not as a bug fix.

| # | Item | Risk if unfixed | Effort |
| --- | --- | --- | --- |
| [8](#8-tools-executing-before-or-without-human-approval) | Tools executing before/without human approval | High — safety mechanism may not be doing what the operator assumes | M |
| [2](#2-auto-compaction-runs-even-when-disabled) + [3](#3-cannot-change-the-auto-compaction-threshold-from-the-tui) | Compaction cannot be reliably turned off or tuned from the TUI | High — unrecoverable context loss mid-task | M |
| [1](#1-subagent-stability-and-reliability) | Subagent stability and reliability | High — silent loss of work, wrong "done" reports | M |
| [4](#4-long-context-reliability-in-planning-and-assessment) | Long-context reliability in planning and assessment | Medium — plan quality silently degrades | L |
| [7](#7-review-the-tool-firewall) | Tool-firewall review | Medium — bypass classes and false positives | M |
| [5](#5-review-planning-context-injection-and-the-current-skills) + [6](#6-review-skill-disclosure-and-skill-use) | Planning/context-injection and skill reviews | Medium — effort spent on unused or duplicated machinery | L |
| [9](#9-checks-that-never-run-in-ci) | Checks that never run in CI | Medium — green CI over untested code | S (done: both surfaces run check:all) |

---

## 1. Subagent stability and reliability

**Symptom.** Delegated work is unreliable: children fail, hang, or finish without
returning a result; the parent cannot always tell whether work was done.

**Evidence.**

- Deferred compaction callbacks read `ctx` after a compaction-triggered session reload,
  throwing *inside* the error path: `trigger-compact` and `compress` both did this.
  Reproduced from a real run's error text ("This extension ctx is stale after session
  replacement or reload"). Fixed on 2026-09-16 (`notifySafely` in
  `packages/extensions/third_party/trigger-compact/index.ts`, guarded `notify` in
  `packages/extensions/src/compress/index.ts`).
- A reviewer subagent ran 33 turns and ended **without emitting any final message**: its
  log ends with `{"type":"compaction_start","reason":"manual"}` and contains only tool
  calls and thinking. The parent received no output at all. A second attempt behaved the
  same way. That is a silent loss of a whole unit of work.
- Crashed runs are recorded with a non-terminal status: `subagent_status` showed
  `status=toolUse` for runs that were already over, so "finished" and "abandoned" are hard
  to distinguish from the outside.
- Retry plumbing exists but is shallow: `DEFAULT_RETRIES = 1`,
  `RETRY_BACKOFF_MS = 2000` (`packages/extensions/third_party/subagent/config.ts:46-47`),
  overridable by `PI_KIT_SUBAGENT_RETRIES` / `PI_KIT_SUBAGENT_RETRY_BACKOFF_MS`
  (`subagent/runner.ts:163-164`), covered by `tests/subagent-nesting-smoke.mjs`.

**Hypotheses (ranked).**

1. A child that compacts mid-run loses the pending final-message emission, so the parent
   gets nothing. Evidence is the log ending exactly at `compaction_start`.
2. Result propagation assumes a clean end and treats "no result" as "empty result" rather
   than an error, so the parent continues with an empty deliverable.
3. Remaining stale-`ctx` reads in other deferred callbacks beyond the two fixed.

**Next steps.**

- Persist each child's final assistant message (and a machine-readable outcome record) to
  its own log/run record, and return it even when the run ends via compaction or abort.
- Make "child produced no output" a loud parent-visible error, never an empty string.
- Add a smoke that forces a compaction inside a child and asserts a result is still
  returned (this is the regression test for hypothesis 1).
- Audit remaining deferred callbacks for `ctx` reads; extend `notifySafely` where needed.
- Terminal statuses: a run that ended without a result should be recorded as
  `ended-without-result`, not left looking live.

**Acceptance.** A child that compacts mid-run still yields its last assistant message plus
a status; a failed child surfaces a non-empty error to the parent; the new smoke runs in
CI; `subagent_status` never reports a non-terminal status for a finished run.

**Pointers.** `docs/research/subagent-delegation-review.md` (DS-series findings),
`packages/extensions/third_party/subagent/`, `tests/subagent-*smoke.mjs`,
`docs/archive/DELEGATION_LIVENESS_REVIEW_BRIEF.md`.

---

## 2. Auto-compaction runs even when disabled

**Symptom.** Auto-compaction is turned off, but sessions still compact.

**Evidence.** There are **three independent compaction triggers**, and only some are
controlled by the setting that looks like "the" switch:

- **pi core, threshold.** Triggers when `contextTokens > contextWindow - reserveTokens`
  (`reserveTokens` default 16384). Settings live in `~/.pi/agent/settings.json` or
  `<project-dir>/.pi/settings.json`:
  `{"compaction": {"enabled": true, "reserveTokens": 16384, "keepRecentTokens": 20000}}`.
  "Disable auto-compaction with `enabled: false`. You can still compact manually with
  `/compact`." (pi docs, `docs/compaction.md` → Settings.)
- **pi core, overflow.** Compaction events carry `reason: "manual" | "threshold" |
  "overflow"` (pi docs, `docs/json.md:17-18`). Forced compaction to stay inside the model
  window is not the same switch as threshold compaction, so "disabled" does not mean
  "never compacts".
- **Kit `trigger-compact`.** Fires `/compact` when the session crosses its *own*
  threshold — `DEFAULT_THRESHOLD_TOKENS = 100_000`
  (`packages/extensions/third_party/trigger-compact/index.ts:8`), persisted in
  `<agent dir>/pi-kit/trigger-compact.json`. This is completely independent of pi's
  `compaction.enabled`, so with core disabled and this extension loaded, the session still
  compacts at 100k tokens.

**Hypotheses (ranked).**

1. The kit trigger fires even though core auto-compaction is off (strongest: nothing in
   `trigger-compact` consults `compaction.enabled`).
2. Settings precedence: `<project-dir>/.pi/settings.json` overrides the user-level file,
   so `enabled: false` written to one of them may not be the file in force.
3. `reason: "overflow"` compaction is being read as "auto-compaction still on".

**Next steps.**

- Make `trigger-compact` respect `compaction.enabled: false` (treat it as "kit trigger
  off" too), and log which trigger fired and why.
- Record the compaction `reason` and the effective policy in the session audit so a later
  "why did it compact?" question is answerable from evidence.
- Document the three triggers in one place (`docs/getting-started.md` or
  `docs/efficiency-and-loops.md`) with the exact precedence, and state plainly that
  `overflow` compaction cannot be disabled.
- Status-bar segment showing the effective trigger threshold and whether each layer is on.

**Acceptance.** With core `compaction.enabled: false` **and** the kit trigger off, a long
session shows no threshold-triggered compaction; only manual and overflow compaction occur
and each is labelled with its reason.

---

## 3. Cannot change the auto-compaction threshold from the TUI

**Symptom.** The token threshold cannot be changed from inside pi.

**Evidence.**

- The only TUI control is `/compact-threshold [amount|reset]`
  (`packages/extensions/third_party/trigger-compact/index.ts:118-160`). It refuses to
  change anything when the env var is set:
  `"Auto-compact threshold is locked by PI_KIT_COMPACT_THRESHOLD_TOKENS; unset it to
  change this from the TUI"` (`index.ts:132`; documented at `docs/INSTALL.md:119`).
- It has no *off* position: only an amount or `reset`, and `reset` returns to 100k
  (`index.ts:8,137`).
- It writes to the kit's own file (`<agent dir>/pi-kit/trigger-compact.json`), **not** to
  pi's `settings.json`. So it never changes pi core's effective threshold, which is
  `contextWindow - reserveTokens`.
- pi core's knobs (`enabled`, `reserveTokens`, `keepRecentTokens`) are settings-file keys;
  neither the kit nor pi's documented surface offers a TUI command for them.

**Next steps.**

- Add a TUI command that edits the pi-core compaction settings for the chosen scope
  (user or project), showing the **effective threshold in tokens** computed from
  `contextWindow - reserveTokens`, and warning when a project file shadows the user file.
- Add `off` to `/compact-threshold` (and, per item 2, make it mean "both layers off" or
  say clearly which layer it turned off).
- When the env lock is in force, report where it was set from, instead of only refusing.

**Acceptance.** An operator can disable or retune auto-compaction entirely from the TUI,
with no hand-editing of JSON and no need to unset env vars, and the command reports the
resulting effective trigger token count.

---

## 4. Long-context reliability in planning and assessment

**Symptom.** As context grows, planning and assessment quality degrades; earlier decisions
and constraints stop being honoured.

**Evidence.**

- Compaction serialises the conversation to text and **truncates tool results to 2000
  characters** (pi docs, `docs/compaction.md` → Message Serialization). Large reads, test
  logs and diffs — often the material a plan was derived from — are exactly what gets
  truncated, and `keepRecentTokens` defaults to 20k.
- The kit injects steering context rather than persisting it: `context-sieve` plus
  `.pi/ctx-contributions/*.json`, and `orchestrator` injects a planner→implementer→reviewer
  contribution above a complexity threshold. Across a compaction these are re-derived, and
  `tests/compaction-continuity-smoke.mjs` exists precisely because contributions can be
  lost or duplicated.
- Roles that carry the planning contract are prompts, not artefacts:
  `packages/kit/agents/*.md` (`delegator`, `planner`, `reviewer`, `scout`,
  `implementer`).

**Next steps.**

- Build a *long-context planning* eval: a task whose binding constraint is stated early,
  followed by enough work to force compaction, then a request that must respect that
  constraint. Compare: (a) as-is; (b) with a persisted plan artefact re-injected after
  compaction; (c) with planning delegated to a fresh child seeded only from the artefact.
- Extend compaction's `details` (or the kit's own compaction hook) to carry the plan
  artefact and the open-decisions list, so post-compaction state is structural rather than
  summarised prose.
- Measure, don't assume: record the eval's pass/fail per variant as the evidence for
  whichever fix is adopted.

**Acceptance.** An eval fixture that fails today (a constraint stated before compaction is
violated afterwards) and passes after the change, wired into `packages/core/eval`.

---

## 5. Review: planning, context injection, and the current skills

**Symptom.** No single review establishes what the planning/injection machinery does, what
overlaps, and whether the skill set is proportionate.

**Scope.**

- Planning and injection: `context-sieve` (+ `.pi/ctx-contributions/*.json`), `orchestrator`
  (complexity threshold and flow steering), `conductor`, `spec-plan`, `goal-core`,
  `task-graph`, `progress-guard`.
- The skill set as shipped: the catalogue in `packages/kit/skills/**`, generated into
  `docs/skills-catalogue.md`, selected per profile in `packages/kit/profiles/*.json`.

**Evidence to gather.** For every injection: what it says, when it fires, how large it is,
what it costs, and what would notice if it were removed. For every skill: which profile
ships it, whether any doc or role file references it, and whether it duplicates another.

**Deliverable.** A written review under `docs/research/` with (a) an injection inventory,
(b) redundancy and conflict findings, (c) skills that are unreferenced or superseded, and
(d) recommendations each backed by an eval or a session observation — plus raised
future-work items for anything not fixed inline.

**Pointers.** `docs/agent-orchestration.md`, `docs/efficiency-and-loops.md`,
`docs/skills-and-efficiency-improvement-plan.md`, `docs/capability-research-workflow.md`,
`docs/proposals/root-orchestrator-conductor.md`.

---

## 6. Review: skill disclosure and skill use

**Symptom.** It is unclear which skills the agent is actually shown, in what form, and
whether any of them get used.

**Evidence.**

- Skills are files with validated frontmatter: `verify.mjs` asserts the docs catalogue
  matches frontmatter and that every skill has `name`/`description`/`category`
  ("skills catalogue" check), so the metadata is trustworthy — but nothing measures *use*.
- Selection is profile-driven (`packages/kit/profiles/*.json`, including the `lite`
  profile's `skills.only` allowlist); `install.mjs` filters by profile.
- There is tooling around authoring rather than use: `skill-forge`, `skill-archive`,
  `skill-score` (`packages/extensions/src/skill-forge`, and the `skill_*` first-party
  tools), plus `docs/registry.json`.

**Open questions.** Is only the frontmatter description disclosed (progressive disclosure)
or is a skill body always loaded? Are all skills in a profile reachable by the agent? Is
there any record of a skill being read or applied?

**Next steps.**

- Define the disclosure contract explicitly and verify it against the loader rather than
  the docs.
- Instrument skill reads (trace-ledger event or a dedicated audit line), then report
  per-skill use over real sessions.
- Use that report to retire unused skills or fold them into the roles that need them.

**Acceptance.** A documented disclosure contract that matches observed behaviour, a
per-skill usage report from real sessions, and a CI-visible check that every shipped skill
is loadable with valid frontmatter.

---

## 7. Review: the tool firewall

**Symptom.** The firewall's coverage and its false-positive rate are unverified.

**Evidence.**

- Policy: an embedded starter policy in `packages/extensions/src/tool-firewall/`
  (`default-policy.json`, default **unknown = ask**, 15 deny + 8 ask command rules) with a
  canonical mirror at `packages/core/policies/default.json`; `verify.mjs` asserts the two
  are byte-identical and that the policy defaults to deny/ask, never allow-all.
- Audit trail: `.pi/tool-firewall-audit.jsonl` (`tool-firewall/index.ts:89-91`).
- Load order matters: tool-firewall composes before governance (see the comment at
  `packages/extensions/src/pentest-governance-domain/index.ts:43-50`).
- Known weaknesses are pattern-matching in both directions. **Over-blocking is confirmed
  from this session's own operation**: commands as ordinary as
  `grep -n "process.env." file` and `grep '\.env' file` were denied as "touching protected
  evidence, audit, engagement, or repository control paths", because protection is a
  substring match on `.env`. Workarounds had to be invented (`grep -E "env[.]example"`),
  which means an operator-visible cost on every such command. The same substring match is
  what made the installer's template un-creatable (fixed separately on 2026-09-16).
  Under-matching is the mirror risk: aliases, shell functions, `sh -c` indirection,
  redirection targets, encoded payloads and PowerShell equivalents.

**Next steps.**

- Build a table of bypass *and* false-positive cases — attempt, expected, observed — and
  turn it into `tests/` cases.
- Fix the `.env`-class over-blocking by matching path *tokens* rather than raw substrings,
  while keeping the fail-closed default for genuinely protected paths.
- Confirm the firewall's own behaviour when the policy file is missing or malformed
  (should fail closed; assert it).
- Re-check that unknown tools are `ask`, not silently allowed, in every shipped profile.

**Acceptance.** A bypass/false-positive matrix in tests; ordinary developer commands
(grep/find for a protected-looking string) are allowed unless they actually reference a
protected path; unknown tools remain ask/deny.

---

## 8. Tools executing before (or without) human approval

**Symptom.** Reported as "some tools execute before human approval". This is the most
safety-sensitive item and it is **real by design in more than one place** — the problem is
that the design is not visible where it matters.

**Evidence — three mechanisms that execute without a human in the loop.**

1. **Auto mode approves by model, not by person.** With auto mode on
   (`PI_KIT_AUTO_MODE=1` or `.pi/auto-mode.json`; `tool-firewall/index.ts:97-103`), each
   ask-class call is sent to a judge model; on `decision === "allow"` the firewall
   **returns immediately and the tool runs** — `auto_mode_approved` is audited, but no
   approval prompt is raised and no human-console record is written
   (`tool-firewall/index.ts:413-416`). Escalation to manual approval happens only when the
   judge denies or is unavailable (fail-closed, `:417-425`).
2. **Governance exempts tool sets before the approval step.** `READ_ONLY_TOOLS` and
   `KIT_FIRST_PARTY_TOOLS` return allow *before* any approval check
   (`pentest-governance-domain/index.ts:42-59, 764-771`). The first-party set includes
   `subagent` — so a delegation is not itself approved, and the delegated work runs in a
   child process whose approvals depend on that child's own environment — plus the
   `todo`/task/verdict/memory/`skill_*` tools.
3. **With no engagement configured (or `PI_ALLOW_DIRECT_TOOLS=1`), direct `bash`/`write`/
   `edit` are allowed outright** (`directToolsAllowed`, and the MCP-only check at
   `pentest-governance-domain/index.ts:777`). Only protected-path and destructive-command
   checks remain. On a machine with no `engagement/` directory, the pentest approval flow
   is simply inactive, which is easy to mistake for "approvals are on".

Two ordering caveats worth recording with the above:

- Approval is **per tool call, not per effect**: one approved `mcp` call can drive an
  arbitrary number of server-side actions.
- Operator-entered TUI shell commands do not pass through `tool_call` at all, so they are
  never in this flow.

For completeness, the human-console path itself is fail-closed: a timeout resolves to
`approved: false` and blocks (`pentest-governance-domain/index.ts:738-744`, 15-minute
default). The gap is not there.

**Next steps.**

- Make auto mode unmistakable: a persistent status-bar indicator, a one-time warning when
  it is enabled, and a rationale recorded **for approvals too** — today
  `autoModeRationale` is only surfaced on escalation, so an auto-approved action leaves no
  explanation.
- Decide deliberately whether `subagent` (and the other first-party tools) should skip
  approval, and if so record the parent's authority with the delegated task so the child's
  actions are attributable.
- Report the active approval posture at session start ("no engagement configured: pentest
  approvals are inactive") instead of leaving it silent.
- Document the per-call-not-per-effect limit on MCP approvals.
- Add a smoke asserting exactly which tool classes bypass approval, so the set cannot
  change silently.

**Acceptance.** Every tool class has a documented, testable approval rule; auto-approved
calls carry a rationale in the audit and an indicator in the UI; a session with no
engagement says so at startup.

---

## 9. Checks that never run in CI

**Status 2026-09-24: addressed for GitLab and GitHub; both surfaces run `check:all`.**

**Symptom.** CI is green, but a large part of the check suite never runs there.

**Evidence.** `.github/workflows/ci.yml` invoked only a subset of the check scripts in
`package.json`. Scripts defined but never referenced by it included: `smoke:auto-mode`,
`smoke:completion-review`, `smoke:compress`, `smoke:conductor`,
`smoke:conductor-synth`, `smoke:conductor-validator`, `smoke:conductor-recursion`,
`smoke:human-console-broker`, `smoke:lifecycle-containment`,
`smoke:live-evaluation-integrity`, `smoke:liveness-containment`,
`smoke:observability-contracts`, `smoke:save`, `smoke:shutdown-hook-gating`,
`smoke:status-bar`, `smoke:todo-session`, `smoke:trigger-compact-threshold` and
`smoke:memory-mcp`. Worse, the project is hosted on GitLab, which does not execute
`.github/workflows/` at all, and the monorepo branch carried no `.gitlab-ci.yml` — the
adoption commit dropped the GitLab initial commit's Auto-DevOps placeholder — so nothing
ran the suite in practice.

**What was added.**

- `packages/core/check-all.mjs` and `npm run check:all`: enumerates the checks from
  `package.json` — every `smoke:*` and `test:*` script, plus `verify`, `eval`,
  `docs:check` and `profile:check` once per shipped profile and surface — so a new check
  cannot be forgotten. 58 runs, ~45 s, green.
- `.gitlab-ci.yml`: a Node job running `check:all`, a job generating and packing the
  export surfaces, and a Python job running `mkdocs build --strict`.

Running the full suite immediately found two real problems, which is the point of the
item:

- **`smoke:observability-contracts` was failing.** The trace-ledger `/trace` summary does
  report skipped corrupt lines, but the assertion only accepted the wording from a
different branch, so the check had silently rotted. It now asserts the actual contract:
  corruption is surfaced, and a ledger that has records is not reported as "no actions
  recorded yet". The test also no longer uses `new Function` to evaluate the pinned
  runtime's footer method — that is now a sandboxed `vm.runInNewContext`.
- **`profile:check` fails without a target argument.** `check:all` now runs it once per
  profile and per surface, which is what CI's matrix did by hand.

**Remaining.** The `.github/workflows/ci.yml` narrower-list concern is now addressed:
that workflow calls `check:all` (`.github/workflows/ci.yml:36-40`), matching
`.gitlab-ci.yml`, so the two surfaces cannot diverge. Confirm which GitLab runners
this project receives: the jobs are untagged, and the predecessor composed
`root/ci-templates` (`baseline.yml`, `heavy.yml`) from its instance — re-add that include
if this project runs beside those templates.

**Acceptance.** `npm run check:all` is the single definition of "the checks", both CI
surfaces run it (or record why not), and a newly added `smoke:*` script is picked up
without editing a workflow.

---

## Related records

- `docs/SUPERSESSION.md` — what was carried over from the predecessor corpus, and the
  still-unported candidates (`post-tool-use`, `file-trigger`, `judge-api`,
  `lm-model-manager.sh`, the held-out eval split/lineage).
- `docs/legacy-repo-deletion-readiness.md` — evidence that the predecessor repo's useful
  content is accounted for before it is deleted.
- `docs/research/subagent-delegation-review.md`,
  `docs/archive/DELEGATION_LIVENESS_REVIEW_BRIEF.md`,
  `docs/archive/MONITORING_SECURITY_UX_REVIEW_BRIEF.md` (a release gate),
  `reviews/` — earlier review findings.
- `docs/improvement-roadmap.md`, `docs/roadmap.md`, `docs/NORTH_STAR.md` — the wider plan
  these items sit inside.
