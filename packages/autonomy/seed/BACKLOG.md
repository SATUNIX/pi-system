# Backlog

Carried across cycles. Each item has an ID, a status (`open`, `in-progress`, `done`,
`dropped`, `proposal`) and its evidence. Items come from audits, reviews and the operator's
own notes. Treat them as **hypotheses**: check each one against the code first, and record the
result (confirmed, already fixed, or wrong) before you work on it. Add new items with evidence
as you find them. Never delete an item: close it with a reason.

| ID | Status | Priority | Item | Source / evidence |
|----|--------|----------|------|-------------------|
| B-000 | open | P1 | **Smoke tests depend on ambient `PI_KIT_*` env.** This harness runs pi with `PI_KIT_AUTO_MODE=0` and `PI_KIT_FIREWALL_POLICY` set, and your shell commands inherit them. Under that environment `auto-mode-smoke`, `firewall-gate-smoke`, `human-console-broker-smoke` and `shutdown-hook-gating-smoke` fail while the post-cycle gate (clean environment) passes. Make the tests hermetic (clear the kit's env for the extension under test, then restore it), preferably with one shared helper. | Autonomy dry run 2026-09-24: 5/72 `check:all` failures in the agent's environment on the seed commit |
| B-001 | open | P2 | **Evaluate agentic-repo-kit for adoption.** A snapshot is at `/reference/agentic-repo-kit` (read-only; start with its README.md and CONTRACT.md). Compare its git-native leases, work-type routing, gate detection and review flow with this kit's orchestration (task-graph, verifier-board, handoff, the `autonomy/` cycle files). Recommend adopt / adapt specific parts / reject, with the evidence and an integration sketch. Deliverable: `autonomy/proposals/agentic-repo-kit.md`. Evaluation only; don't vendor it in. | Operator request |
| B-002 | open | P1 | **Install doc path works only from the clone's parent folder.** The documented `node pi-system/packages/core/install.mjs` fails with MODULE_NOT_FOUND (`pi-system/pi-system/...`) when it's run from inside the clone. Make the docs state the working directory explicitly (or give a cwd-independent command), and add a docs smoke check that pins it. | Operator hit it installing v0.2.1-beta.0 (docs/INSTALL.md, docs/getting-started.md) |
| B-003 | open | P1 | **Tests may write to the real agent dir.** Firewall session fixtures appeared in the operator's `~/.pi/agent/pi-kit/firewall-sessions` during a local release gate. Find the test(s) that don't isolate `PI_CODING_AGENT_DIR`/`HOME`, and make the test harness fail if a test touches the real agent dir. | Operator machine, fixture files timed during `npm run release` |
| B-004 | open | P2 | **Stale role copies in `~/.pi/agents` cause a subagent notice.** Old copies of the kit's agent roles in the user agent dir shadow or duplicate the shipped ones. Detect stale copies (compare with the shipped roles) and offer or perform a safe cleanup via install or `/update`. Document it. | Operator machine |
| B-005 | open | P2 | Context-contribution files are shared per directory across concurrent sessions (orchestrator and progress-guard contributions can cross sessions). Use a per-session contribution directory. | docs/review-2026-09-23.md, Deferred |
| B-006 | open | P3 | Skill triggers match only the prompt text; file-glob triggers aren't implemented. | docs/review-2026-09-23.md, Deferred |
| B-007 | open | P2 | Re-verify the open items in `docs/improvement-campaign-20260922-findings.md` (areas 1–6). Close the ones already fixed, with evidence, and turn the confirmed ones into backlog items. | docs/improvement-campaign-20260922-findings.md |
| B-008 | open | P3 | `docs/future-work.md` and `docs/improvement-roadmap.md`: check the roadmap status banners against the code and fix any that are stale. | CLAUDE.md, audit-doc precedent |
