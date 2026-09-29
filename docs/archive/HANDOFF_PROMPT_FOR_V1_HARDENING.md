# Handoff prompt — paste this into a fresh Claude Code session (Opus 5)

Operator note (not part of the prompt): set the session model to Opus 5 first (e.g. `/model opus`), extract the codebase zip, then paste everything below the line as your first message.

---

## Role and objective

You are taking `misc-agents-pi-kit` from its current pre-1.0 state to a fully production-ready `v1.0.0` by executing an already-written, already-verified production-readiness plan end to end, then subjecting your own completed work to adversarial peer review from two independent subagents, and closing every finding those reviewers confirm.

## Before you touch anything

1. Extract the codebase, `cd` into `misc-agents-pi-kit`.
2. `git log --oneline -20`, `git branch -a`, `git status` — orient yourself. You should be on (or should create, if not already present) branch `hardening/production-readiness-plan`. Do not touch `main`.
3. `npm install`. `node_modules/`, `dist/`, and `site/` were deliberately deleted before this codebase was zipped — they are gitignored build/dependency caches, stripped purely to keep the transfer small. Nothing of substance was lost; just regenerate them.
4. Read, in full, in this order:
   - `docs/roadmap.md` — the authoritative release-criteria roadmap.
   - `docs/improvement-roadmap.md` — a prioritized, ROI/Effort-tagged findings doc from an earlier audit.
   - `LATEST_PLAN_2026-08-04T042958Z.md` (repo root) — the Epic → Sprint → Definition-of-Done production-readiness plan (0.4.1 → 1.0.0). It supersedes neither of the above two docs but corrects and extends them (see its "Part A — Corrections" section for exactly where and why). **This file is your primary work order. Treat its Epic/Sprint/DoD text as authoritative — do not paraphrase it from memory or drift from what it actually says.**
   - Any `AGENTS.md` / `CLAUDE.md` present, for repo-specific working conventions.
   - `kit/verify.mjs`, the `scripts` block in `package.json`, and `.gitea/workflows/ci.yml` — understand what "passing" already means in this repo before you add to it.

## What you are building

Take the plan's 9 epics (0.4.2 → 1.0.0) from a written plan to a merged, verified, locally-tagged reality:

1. Trust Baseline & Cross-Platform Hygiene
2. Safety Boundary Hardening
3. Organization, Catalogue & Docs-Nav Automation
4. Verification Auto-Wiring + Eval Harness v1
5. Recovery & Autonomy Depth
6. Memory & Self-Improvement
7. Documentation & Onboarding Completeness
8. Release Engineering & Supply Chain Maturity
9. Production Readiness Capstone

Work them **in order**. The plan states explicit dependencies (e.g. Epic 6 depends on Epic 4's eval harness and Epic 1's stub resolution; Epic 2's security fixes depend on Epic 1's manifest-metadata cleanup being trustworthy first). Do not reorder for convenience.

## Hard constraints — read before you start, not after

- **Never push to any remote.** `git remote -v` will show a `git@git-gitea:...` origin. Do not `git push` anything, at any point, including the final `v1.0.0` tag Epic 9 calls for — create it locally only. All commits, branches, and tags stay on this machine.
- **No live agent runs.** Do not invoke the real `pi` CLI against a live model backend (local Ollama, Anthropic, or otherwise), do not arm `autonomous-loop` for a real session, do not trigger `self-improvement` / `skill-forge` / "dream mode" against a live model, and do not make any outbound network call to a model provider. All behavioral verification must be **offline and deterministic**: `npm run verify`, the new `npm run test:security` (Epic 2), the new `npm run eval` harness (Epic 4) — all running against fixtures/mocks, never a live model. If a sprint's written Definition of Done seems to call for a live run, implement it as a scripted fixture/simulation instead and say so explicitly in your final report. Do not skip the DoD, and do not fake having done a live run.
- **Scope is this repo only.** Do not modify anything outside `misc-agents-pi-kit/`. If you notice something relevant in a sibling capability repo, note it in your final report; do not touch it.
- **No new stubs, ever.** This plan exists *because* a prior version of this kit shipped extensions (`mcp-router`, `skill-forge`, `self-improvement`, `remote-review`) that printed `"(stub)"`/`"TODO"` while enabled in real, non-experimental profiles — the single worst finding in the whole audit. Do not repeat that pattern anywhere, including in new code for Epics 4–6. If an epic's full scope is genuinely too large to implement for real in one pass, implement a **smaller real thing** (narrower scope, fewer cases) rather than a fake placeholder, and say so explicitly. Do not silently under-deliver against a Definition of Done and mark it complete.
- **A sprint is not done until its literal, written Definition of Done passes.** Run the actual command/check named in the DoD and observe the actual result before moving on. "The code looks right" is not a Definition of Done.
- **Commit per sprint** (or per coherent unit of work within a large sprint), with a clear conventional message — this repo's history already uses `feat(x): ...` / `fix(x): ...` / `docs: ...`; follow that. Do not squash the whole plan into one commit; the commit history is part of the deliverable.
- **Keep the two upstream roadmap docs honest as you go**, not just at the end. Epic 9's docs-freeze sprint requires `docs/roadmap.md` and `docs/improvement-roadmap.md` to be verified true against HEAD — update the relevant section whenever you close something it references, rather than batching it all into one rushed pass at the end.
- **Reuse existing patterns; don't reinvent.** E.g. Epic 3's `kit/skills-catalogue.mjs` should be modeled directly on the existing `kit/registry.mjs`; new `verify.mjs` checks should follow its existing `fail()`/error-count pattern; new extensions should follow the existing `extension.json` schema and `ExtensionAPI` conventions used throughout `extensions/*/index.ts`. Read a couple of existing, real (non-stub) extensions before writing new ones so new code matches house style.

## Execution loop (repeat per epic, per sprint)

1. Read the sprint's full text in `LATEST_PLAN_2026-08-04T042958Z.md`.
2. Implement it.
3. Run its literal Definition of Done check(s). If it fails, fix it — do not proceed on a failing DoD.
4. Commit.
5. Move to the next sprint.

If a sprint's DoD is ambiguous or requires a nontrivial judgment call (e.g. the exact default-deny policy shape for Epic 2 Sprint 2.1, or which fixtures Epic 4's eval harness starts with), make the most conservative, clearly-documented choice and record the decision and rationale in your final report rather than guessing silently or stalling.

## After all 9 epics: independent adversarial review

Once the plan is fully executed (or as fully executed as genuinely possible under the "no fake stubs" constraint), **spawn exactly two independent review subagents** using your Task/subagent tool, in parallel, with **no visibility into each other's findings or into your own implementation narrative** — each must form its own view from the repo state alone, not from your summary of what you did. This mirrors the kit's own `dual-review`/`verifier-board` philosophy — use it on the kit itself.

Give each reviewer the repo path and instruct them to be genuinely adversarial: their job is to find reasons the "production ready" claim is false, not to confirm it. Assign distinct, non-overlapping angles so together they cover the full surface without redundant work:

**Reviewer 1 — Functional & behavioral correctness.** Does the kit actually work, end to end, as documented?
- Walk every extension in every shipped (non-experimental) profile and confirm it does what its `extension.json` description and any user-facing `/command` claim — not a stub, not a partial implementation dressed as complete.
- Re-run `npm run verify`, `npm run test:security`, `npm run eval`, and every `tests/*.mjs` smoke test yourself; don't trust that they were run — run them again.
- Deliberately try to break the Epic 2 safety boundary (tool-firewall default-deny, secret-guard content-aware detection) — think like an attacker trying to get an unknown/destructive tool call past the firewall, or exfiltrate a secret past secret-guard via an encoding or copy trick. This epic exists specifically because the *previous* default (silent allow-all) was a real, live security hole — treat "did we actually fix it" as the highest-stakes question in this review.
- Check whether the eval harness and any new tests are truly deterministic and offline, or secretly assume a live model/network.
- Confirm extension↔profile manifest metadata is now fully consistent (Epic 1/3), not just partially fixed.

**Reviewer 2 — Structure, organization, and production-readiness posture.** Is this a coherent, well-organized, maintainable, production-grade system, or a pile of individually-working parts?
- Assess overall repo organization: does the extensions/skills/vendor/profiles/kit/docs layout make sense to a newcomer? Anything duplicated, orphaned, or inconsistent (naming, structure, conventions) across the 25+ extensions and 36 skills?
- Audit documentation truthfulness: does every doc referenced from `mkdocs.yml`'s nav match current reality? Does `docs/roadmap.md` still say anything now false? Does `LATEST_PLAN_...md`'s own "Part A — Corrections" list reflect what's now actually resolved?
- Audit release readiness: `CHANGELOG.md`, git tags, version pinning, CI coverage (`.gitea/workflows/ci.yml` and `.github/workflows/ci.yml`) — could a new maintainer cut a real release confidently from this state?
- Look for anything the 9-epic plan itself didn't anticipate — gaps in the plan, not just gaps in its execution. The plan is a first draft from a prior audit; it may itself be incomplete.
- Sanity-check that nothing was pushed to any remote and no live agent/model calls occurred anywhere in the session (check `.pi/trace.jsonl` if present, and the actual commands run) — confirm the hard constraints above were honored, don't take it on faith.

Both reviewers should report findings with file:line references where applicable, a severity (blocking / high / medium / low / nice-to-have), and — for anything blocking or high — concrete evidence or a repro, not a vague concern.

## Triage and close-out

1. Read both reviewers' reports in full.
2. Fix every **blocking** or **high** severity finding, re-run the relevant DoD/verification command, and confirm the fix. Do not defer blocking findings.
3. For **medium/low/nice-to-have** findings: fix them if low-risk and quick; otherwise log them explicitly as deferred follow-up (append to `docs/improvement-roadmap.md` or a new "Post-1.0 backlog" section) with a one-line reason. Do not silently drop them, and do not silently fix-and-hide them either.
4. Re-run the full verification suite (`npm run verify`, `test:security`, `eval`, all smoke tests) one final time after fixes.
5. If Epic 9's Definition of Done is now genuinely met, create the local `v1.0.0` tag via Epic 8's release script — do not push it.

## Final report

Produce one final summary covering:
- Per-epic status: done / partially done (exact scope delivered vs. planned) / deferred (with reason). No epic should be silently skipped without explanation.
- Full verification results — paste the actual final output of `npm run verify`, `test:security`, `eval`.
- Both reviewers' findings and the disposition of each (fixed / deferred-and-logged / disputed-and-why).
- Explicit confirmation: nothing was pushed to any remote; no live agent/model runs occurred; scope stayed inside `misc-agents-pi-kit/`.
- Current branch name, HEAD commit, and whether `v1.0.0` was tagged.

Work autonomously through all of this without stopping to ask for approval at each sprint — the plan and the constraints above are your approval. Only stop and ask if you hit a genuine ambiguity that would materially change the shape of the system (not a routine implementation choice), or a constraint conflict you cannot resolve safely on your own judgment.
