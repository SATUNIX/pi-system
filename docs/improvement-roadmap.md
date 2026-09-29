# High-ROI Improvement Roadmap

A prioritized, grounded plan for making the kit more correct, capable, usable, and
maintainable over time — and for raising the difficulty of tasks the agent can reliably
take on. This complements the release-criteria [roadmap](roadmap.md); where they overlap,
this page is the actionable, prioritized view.

**How to read it.** Each item is tagged **ROI** (value) × **Effort** (cost). Do high-ROI /
low-effort first. Findings are grounded in a review of the kit as of `0.4.1`.

> **Status note (2026-08-05):** this document is a point-in-time backlog snapshot from the
> `0.4.1` baseline and is **not** kept current line-by-line — several items below (recovery-
> orchestration, the eval harness, `record_verdict` auto-wiring, skill-forge/self-improvement,
> the release/versioning convention, the prioritized shortlist) describe work that has since
> landed; see the ✅ status callouts inline where present, and
> [`roadmap.md`](roadmap.md#independent-review-and-hardening-pass-2026-08-05) for the current,
> independently-reviewed state. Treat unmarked bullets here as historical context for *why*
> work was prioritized, not as a live TODO list.

Legend: 🔴 P0 correctness/bug · 🟠 P1 reliability/trust · 🟢 P2 capability lift · 🔵 P3
organization/usability · ⚙️ infra/quality.

---

## 0. The capability ladder (why this ordering)

The difficulty of task the agent can take on is gated, in order, by: (1) **trust** — does
the advertised capability actually work; (2) **efficiency** — can it stay on task without
drowning in context; (3) **recovery** — can it get unstuck; (4) **verification** — can it
prove its work; (5) **memory** — can it get better across sessions. Each rung below unlocks
harder tasks only if the ones beneath it hold.

| Rung | Unlocks | Enabling work (this doc) |
|---|---|---|
| 1. Trust | The agent isn't misled by fake tools/extensions | §1 stub audit |
| 2. Efficiency | Multi-file work without context blowout | §2 (readseek/ledger — mostly done), §5 auto-catalogue |
| 3. Recovery | Long autonomous runs that self-correct | §3 recovery-orchestration, progress-guard tuning |
| 4. Verification | "Done" means proven, not claimed | §4 verify auto-wiring, eval harness |
| 5. Memory | The kit improves itself over time | §4 skill-forge/self-improvement, dream mode |

---

## 1. 🔴 Trust: audit and fix stub extensions (**ROI: very high · Effort: low–med**)

> **Status (0.4.2 — Epic 1):** ✅ Landed. `mcp-router` + `remote-review` quarantined
> (`status: stub`, removed from every profile and the lite surface, `profiles: []`).
> `skill-forge` + `self-improvement` confined to the experimental `self-improving`
> profile pending real implementations in Epic 6. `verify.mjs` now fails on any
> `(stub)`/`TODO` string or `stub`/`experimental` status shipped in a non-experimental
> profile or the lite surface (Sprint 1.3).

Several extensions advertise capability they don't have. This is worse than missing —
the agent (and user) believe a feature exists.

- **`mcp-router` is a stub** yet ships in the **lite surface** and profiles. On every
  startup it prints `mcp-router: loaded (stub)`, and its `tool_call` hook does nothing.
  The `mcp-tool-use` / `mcp-only-operations` skills reference an MCP router/proxy that
  isn't implemented. **Fix:** implement real MCP discovery/routing, or remove it from the
  surfaces and drop the skill references until it exists. *(low effort to remove; med to
  implement.)*
- **`skill-forge` registers 3 model-visible tools** (`skill_synthesise`, `skill_score`,
  `skill_archive`) that all return `"TODO"`. A model can call them and get nothing — the
  worst kind of surface. **Fix:** hide them behind an env flag until implemented, or
  implement (see §4 memory).
- **`self-improvement`** — `/improve` returns `self-improvement: TODO`. Fine as a stub if
  it doesn't mislead; gate the command out of default profiles until real.
- **Action:** add a `verify.mjs` check that **fails on `(stub)` / `TODO` in any extension
  shipped in a non-experimental profile**, so this can't regress. *(⚙️ low effort, high
  leverage.)*

## 2. 🟠 Efficiency (mostly landed in 0.2–0.4 — remaining polish)

- **Auto-generate the skills catalogue** from frontmatter (`ROI: med · Effort: low`).
  `docs/skills-catalogue.md` is hand-maintained and will drift from the 36 skills. A
  `packages/core/skills-catalogue.mjs` (like `packages/core/registry.mjs`) removes the drift and can feed
  `verify`. 
- **Add `references/` depth to the heaviest skills** (`ROI: med · Effort: med`). The plan
  designed for it; none exist yet. Move long checklists (pentest, finding-writing) into
  `references/` so descriptions stay cheap and bodies stay skimmable.
- **Consider readseek for the full-kit lower tiers** now that the Windows binary is
  proven (`ROI: med · Effort: low`).

## 3. 🟢 Recovery & autonomy (raises max task length)

- **Implement `recovery-orchestration-mode`** (`ROI: high · Effort: high`). Today it's a
  design doc; `progress-guard` (0.4.0) is the shallow layer that would escalate into it.
  Building the deep multi-agent root-cause pass (fresh scouts + forked top-10 + primary/
  backup plan + delegated fix) is the single biggest lift to *hard-bug* autonomy.
- **Real profile detection for `progress-guard` auto-mode** (`ROI: med · Effort: low`).
  "Auto on autonomous" currently relies on the operator setting `PI_KIT_GUARD_MODE=auto`.
  Detect the autonomous profile (e.g. a marker the `autonomous-loop` extension sets when
  armed) so the dial is automatic, not manual.
- **Tune the guard on real runs** (`ROI: med · Effort: low`). The repeat/stall thresholds
  (3 / 6) are first guesses; mine `.pi/trace.jsonl` from real sessions and calibrate. Add
  oscillation detection (A→B→A) which the current heuristics miss.

## 4. 🟢 Verification & self-improvement (raises trust in "done")

> **Status (0.5.1 — Epic 4):** ✅ `record_verdict` auto-wired (verify-gate writes the board;
> orchestrator blocks mission-complete on a failing verdict). ✅ Eval harness v1 shipped
> (`npm run eval`, 6 offline fixtures, own CI job). `skill-forge`/`self-improvement`
> ("dream mode") remain for Epic 6.
>
> **Status (0.7.0 — Epic 6):** ✅ `skill-forge` (deterministic trace-mining synthesiser +
> eval-tied `skill_score` + archive), `self-improvement` `/improve` (reviewable diff, applies
> only when armed), and dream mode (`npm run dream`, allowlist-enforced via `protected-paths`)
> all shipped — real implementations, no live model. Covered by 4 new eval fixtures.

- **Auto-wire `record_verdict` into `verify-gate` / `dual-review`** (`ROI: high · Effort:
  med`). The roadmap already flags this: the definition-of-done gate is agent-driven today;
  wiring it to real verification makes "done" mean "verified."
- **Build an eval/benchmark harness** (`ROI: high · Effort: med–high`). There is no way to
  measure whether a change makes the agent *better*. Adopt the `skill-creator` eval pattern:
  a fixture set of tasks scored automatically, run in CI, so skill/extension changes are
  measured, not vibes. This is the flywheel for every other item here.
- **Implement `skill-forge` + `self-improvement` ("dream mode")** (`ROI: high · Effort:
  high`). Mine `trace-ledger` + session JSONL to synthesise/score/retire skills and update
  memory between sessions. Depends on the eval harness (to score) and memory. This is rung 5
  — the kit getting better on its own.

## 5. 🔵 Organization & usability

- **Restructure the docs nav** (`ROI: med · Effort: low`). The nav is a flat list mixing
  guides, design docs, and reference. Group into **Guides / Design & Roadmap / Reference**.
- **Add a capability matrix** (`ROI: med · Effort: low`). One table: profile → enabled
  extensions → *what class of task it's for* (quick fix · daily coding · long-horizon ·
  set-and-walk-away). New users currently infer this.
- **One-command install** (`ROI: high · Effort: low`). Today the working flow is
  export → `npm install` in dist → `pi install`, and `pi install` does **not** fetch npm
  deps (a real trap). Make `npm run install:lite` do all three and be the single documented
  path; keep `getting-started` in sync.
- **Consolidate the planning docs** (`ROI: low · Effort: low`). `PI_KIT_REPO_PLAN.md`,
  `roadmap.md`, this file, and the two design docs overlap. Keep this page as the live
  improvement roadmap and demote the historical plan.

## 6. 🔴/⚙️ Known bugs & cross-platform hardening

> **Status (0.4.2 — Epic 1):** ✅ `.gitattributes` added + repo LF-normalized; export
> EPERM fixed via `rmrf()` read-only retry; `npm run install:lite` now runs `npm install`
> inside the generated surface before `pi install` (or fails loudly); `pi-lean-ctx`
> binary now detected at `session_start` with a one-time warning instead of `spawn ENOENT`.
> Remaining: pi-version floor/ceiling pinning is deferred to Epic 8 (Sprint 8.3).

- **Add `.gitattributes`** (`ROI: high · Effort: trivial`). Every commit warns "LF will be
  replaced by CRLF." A `* text=auto eol=lf` (with binary excludes) ends the churn and keeps
  diffs clean cross-platform.
- **Fix the export EPERM on Windows** (`ROI: high · Effort: low`). `packages/core/export-package.mjs`
  `fs.rmSync(outputDir, {recursive,force})` fails when `dist/**/node_modules` holds a
  read-only native binary (readseek's `.exe`) — re-export currently needs a manual
  `chmod -R u+w` first. Add an `rmSync` retry that clears read-only attrs (or skip/preserve
  `node_modules`).
- **Gate `pi-lean-ctx` on its binary** (`ROI: med · Effort: low`). It's now out of lite, but
  the full-kit profiles still load it and it will `spawn ENOENT` wherever the external
  `lean-ctx` CLI isn't installed. Detect the binary at `session_start` and warn/disable
  cleanly instead of erroring, or document the install as a hard prerequisite.
- **Pin/test against the runtime pi version** (`ROI: med · Effort: low`). The kit builds
  against `@earendil-works/pi-coding-agent` 0.79.6 but the installed CLI is 0.76.0. Pin the
  dev dependency to the supported floor (or test both) so `tsc` reflects what actually runs.

## 7. ⚙️ Infra & quality

> **Status (0.9.0 — Epic 8):** ✅ CI expanded well beyond the two epic smokes (verify +
> docs:check + test:security + docs-smoke + eval job + pi-compat matrix + non-blocking audit).
> ✅ `CHANGELOG.md` + `npm run release` (bump/gate/export/annotated-tag, never pushes) shipped;
> the first git tag in repo history (`v0.9.0`) now exists — resolving the plan's Part A #4.

- **Expand CI beyond the two epic smokes** (`ROI: med · Effort: med`). Add: the stub/TODO
  guard (§1), skills frontmatter lint (every `SKILL.md` has `name`+`description`; this
  session found two that silently didn't load), and the auto-catalogue drift check.
- **A release/versioning convention** (`ROI: low · Effort: low`). The kit now moves in
  semver (0.2.1 hotfix, 0.3.0/0.4.0 minor). Add a short `CHANGELOG.md` and a
  `npm run release` that bumps + exports + tags, so surfaces and version stay in lockstep.

---

## Prioritized shortlist (do these first)

1. 🔴 `.gitattributes` — end the CRLF churn. *(trivial)*
2. 🔴 Stub audit: remove/hide `mcp-router` (from lite!), `skill-forge` tools,
   `self-improvement` command; add the `(stub)`/`TODO` verify check. *(low)*
3. 🔴 Fix export EPERM + make `npm run install:lite` the one-command path. *(low)*
4. 🟠 Auto-generate the skills catalogue + skills-frontmatter lint in CI. *(low)*
5. 🟢 Real profile detection + real-run tuning for `progress-guard`. *(low–med)*
6. 🟢 Eval/benchmark harness — the measurement flywheel. *(med–high)*
7. 🟢 Auto-wire `record_verdict` into verification. *(med)*
8. 🟢 Implement `recovery-orchestration-mode`. *(high — biggest autonomy lift)*
9. 🟢 Implement `skill-forge`/`self-improvement` on top of the eval harness. *(high)*
10. 🔵 Docs nav restructure + capability matrix. *(low)*

Items 1–4 are a natural **`0.4.2` hardening pass**; 5–7 a **`0.5.0` verification/tuning
minor**; 8–9 a **`0.6.0` autonomy/self-improvement minor**.
