# Roadmap

This page is the authoritative roadmap for the Pi System kit.

> Version numbers in the history below (`0.4.x` to `1.0.0`) belong to the internal development
> line. Public npm versioning restarted at `0.2.1-beta.0`; see `CHANGELOG.md`.

## Production readiness (1.0.0) — status

The `0.4.1 → 1.0.0` production-readiness plan is complete. All nine epics landed
(`0.4.2`–`1.0.0`); the plan's **Part A corrections are all resolved against HEAD**:

| Epic | Version | Verified by |
| --- | --- | --- |
| 1. Trust baseline & cross-platform hygiene | 0.4.2 | `verify.mjs` stub/drift guards; `smoke:epic1` |
| 2. Safety boundary hardening | 0.4.3 | `test:security`; firewall default-deny + parity checks |
| 3. Organization, catalogue & docs-nav | 0.5.0 | catalogue/matrix drift + docs-nav checks |
| 4. Verification auto-wiring + eval harness | 0.5.1 | `npm run eval` (verify-gate + orchestrator fixtures) |
| 5. Recovery & autonomy depth | 0.6.0 | eval recovery fixtures (arm→auto, oscillation, escalation) |
| 6. Memory & self-improvement / dream mode | 0.7.0 | eval memory fixtures (synthesis, score, propose, dream allowlist) |
| 7. Documentation & onboarding completeness | 0.8.0 | `smoke:docs`; verify-check reference |
| 8. Release engineering & supply chain | 0.9.0 | `CHANGELOG.md`, `npm run release`, `v0.9.0` tag, CI matrix |
| 9. Production readiness capstone | 1.0.0 | profile-regression matrix; security sign-off; this freeze |

Part A corrections (from the plan): #1 firewall default-allow → **default-deny** (Epic 2);
# 2 `remote-review` stub → **quarantined** (Epic 1); #3 manifest/profile drift → **verify-enforced**
(Epic 1); #4 no tags/CHANGELOG → **`v0.9.0` + CHANGELOG** (Epic 8); #5 uncalibrated `status` →
**recalibrated** (Epic 1); #6 `secret-guard` regex-only → **content-aware** (Epic 2); #7 skills
catalogue → **generated + drift-checked** (Epic 3); #8 pi-version untested range → **floor/ceiling
CI matrix** (Epic 8). All eight resolved.

Anything not implementable live under the offline hardening constraints (no live model, no
`pi -p`, no remote push) was delivered as a deterministic offline equivalent and noted where it
appears (dream mode, profile regression, docs nav vs `mkdocs build`).

## Independent review and hardening pass (2026-08-05)

The "complete" claim above described what the nine-epic implementation *believed* it had
delivered. A subsequent independent two-round adversarial review (`reviews/FINAL-review.md`,
reviewing commit `8d3b205`) found it was not release-ready: profile selection wasn't applied at
install time, shipped policies blocked first-party tools, common destructive-command and
secret-exfiltration variants bypassed the safety boundary, the lockfile couldn't reproduce a
clean install, and the capstone "full profile regression" gate was a metadata check rather than
the plan's real install+verify+eval regression — among other blocking and high findings.

A hardening pass on `hardening/production-readiness-plan-fixes` fixed the review's blocking
findings (F-01–F-06) and the release-gating high findings it named (path authorization, broken
non-experimental tools, recovery behavior, release/install documentation), each verified against
the review's own independent-repro evidence and covered by new offline regression tests — see
that branch's commit history for the fix-by-fix detail. Explicitly **not** attempted, and not
claimed as fixed: capabilities that would require a live model call to build or verify honestly
(fully executable multi-agent orchestration invoking `subagent` from another extension — not
supported by Pi's public extension API in any case; candidate-sensitive skill scoring comparing
enabled vs. disabled task success) remain scoped to the experimental profile and are tracked as
forward work, not silently marked done.

## Direction

- The catalogue repo remains canonical for source extensions, skills, prompts, themes, and metadata.
- `@satunix/pi-system` is the one published package. Profiles, not separate packages, choose
  what loads; `lite` is the small-model profile (the split `@satunix/pi-system-lite` surface was
  retired in 0.2.1-beta.0).
- Releases are git tags on the private GitLab: `next` tracks `main`, `latest` tracks release
  tags, and `/update` keeps pi, the kit and linked packages current. npm delivery is built and
  paused (`packages/core/distribution.json`, `docs/releasing.md`).
- Documentation, searchable docs, status UI, themes, and verification are release criteria.

## Current Release Criteria

- Non-technical users can install with one command and pick a profile from the docs.
- The `lite` profile narrows extensions, skills and prompts for small models.
- The GitOps status bar shows tokens, estimated cost, model, branch, and context.
- Pricing defaults to zero for local models and can be changed without restarting Pi.
- MkDocs builds a searchable static docs site.
- Capability deployment docs link back here for package and extension work.

## Near-Term Work

- Add profiles only when they serve a clear audience.
- Add package verification for theme resources and generated docs links.
- Add live Pi compatibility testing for footer rendering once the target Pi TUI API stabilizes.
- Promote proven extensions into standalone repos only when ownership or release cadence requires it.

## Background Capability Layer (done — 2026-07)

High-ROI, mostly-background packages integrated to raise coding quality and cut context cost while
keeping the visible tool surface minimal. See `docs/capability-research-workflow.md` for the method
and `packages/core/sources.json` for pinned versions.

- `pi-lens` — real-time LSP/type/lint/structural + impact diagnostics on every edit (external ref;
  balanced+; opt-in for lite via `PI_KIT_OPTIONAL_PI_LENS=1`).
- `pi-lean-ctx` — transparent bash/read/grep output compression + session cache (external ref; all
  profiles; in lite by default).
- `caveman` (vendored) — compresses conversational output to human/sub-agents; session-flips **off**
  when a report/doc skill or prompt is invoked; never compresses file/code/report content.
- `pi-impact-analyzer`, `pi-readseek` — passive blast-radius + hash-anchored lean file I/O
  (external ref; long-horizon / autonomous / self-improving).

## Future Direction

- **Routines / scheduled runs.** Pi has no native cron/routine trigger (unlike Claude Code
  routines). Plan an external scheduler (`pi -p` print mode via Windows Task Scheduler / cron /
  systemd) or a self-scheduling extension to fire the agent on a schedule for maintenance,
  babysitting, and unattended tasks.
- **Dream mode.** ✅ **Implemented offline in 0.7.0 (Epic 6).** `skill-forge` deterministically
  mines `trace-ledger` to synthesise candidate skills (reviewable proposals, never a live
  model, never auto-installed); `self-improvement`'s `/improve` proposes a reviewable AGENTS.md
  diff and applies it only when armed; `packages/core/dream.mjs` (`npm run dream`) is the scheduled-pass
  stand-in that updates ONLY allowlisted internal state (`AGENTS.md`, `.pi/memory`, `GOAL.yaml`),
  enforced at runtime by `protected-paths`' new allowlist mode (`PI_KIT_WRITE_ALLOWLIST`).
  Remaining: wiring an actual external scheduler (`pi -p` via cron/Task Scheduler) to invoke it
  unattended — deferred, since this kit is hardened offline (no live model runs).

## Agent Orchestration (done — 2026-07)

Autonomous "agent team" delegation is implemented as kit extensions (no pi-core changes). See
`docs/agent-orchestration.md`.

- `packages/extensions/third_party/subagent` — restored to the full mechanism (single / parallel / chain, per-agent
  model + tool restriction, JSON streaming), self-contained on pi's public API.
- `orchestrator` — materializes `planner`/`implementer`/`reviewer`/`scout` role agents into
  `.pi/agents`, scores task complexity, and steers the main agent into plan → implement → validate
  when non-trivial (`PI_KIT_ORCH_THRESHOLD`, `/orchestrate`).
- `goal-core`, `task-graph`, `verifier-board` — promoted from stubs to real coordination substrate
  (mission goal, shared DAG board, definition-of-done gate).
- Lite ships the chain flow; full adds scout, parallel implementers (via `branch-lab` worktrees),
  the DAG, the verdict gate, and optional `pi-subagents`.

Remaining orchestration follow-ups:

- ~~Wire `record_verdict` into `verify-gate`/`dual-review` automatically (currently agent-driven).~~
  **Done (0.5.1, Epic 4):** `verify-gate` auto-records its result to the verifier board
  (`.pi/verdicts.json`); `orchestrator` refuses "mission complete" while any verdict fails
  or no trusted source (`verify`/`review`/`validator:<id>`) has passed
  (`agent_end` gate). Covered by `npm run eval`.
- Optional first-class `pi-subagents` background-job integration.

## Production-Readiness Plan (0.4.1 → 1.0.0)

The `0.4.2 → 1.0.0` hardening was executed against the plan in
[`improvement-roadmap.md`](improvement-roadmap.md)
(superseded, kept for historical reference), epic by epic. That document's
"Part A — Corrections" enumerates where the earlier roadmap
docs were stale; those corrections are now resolved in code and reflected here and in
`improvement-roadmap.md`.

## Historical References

`docs/PI_KIT_REPO_PLAN.md` (now marked **superseded**), workspace `_consolidation` notes, and
`../PI_SYSTEM_TRACKER.md` are historical or tracking references. They should not override this
roadmap unless this page is updated.
