# Skills & Efficiency Improvement Plan

> **Status: Phases 1–3 implemented** (see §"Implementation Sequencing" below — Phase 1
> `0.2.1`, Phase 2 `0.3.0`, Phase 3 `0.4.0`, all ✅ DONE 2026-07-24). The header below
> describing "plan / not yet implemented" is the *original* framing kept for historical
> context (this doc predates the phases landing) - do not read it as the current state.
> This covered three intertwined tracks: (A) expanding the bare skills, (B) making the
> agent do more with fewer tool calls, and (C) an auto-boost / anti-loop backend
> (`progress-guard`, further hardened in the 2026-08-05 independent-review pass — see
> [`roadmap.md`](roadmap.md#independent-review-and-hardening-pass-2026-08-05)) that
> self-reflects and delegates when the agent stalls. It supersedes nothing; it extends
> `recovery-orchestration-mode.md` (which stays the deep root-cause layer, and which the
> same hardening pass grounded in real trace-ledger data rather than a blank template).

## 0. Why

Two problems observed in real use of the **lite** surface on a small local model:

1. **Skills are bare.** 30 of 31 SKILL.md files are 4–18 lines — principles, not
   procedures. They give the model a slogan, not a runbook.
2. **The agent thrashes and loops.** It made many redundant file-read tool calls and
   got stuck repeating similar commands without progressing.

### Root causes found during investigation

| Finding | Consequence |
|---|---|
| Skills use **progressive disclosure** — only the `description` is always in context; the body loads on demand via `read`. Pi's own docs note *"models don't always do this"* for small models. | Expanding skill bodies is **context-safe**, but small models may never load them. Loading reliability is a separate problem to solve. |
| The **lite** surface deliberately strips the efficiency tools: `pi-readseek`, `pi-lens`, `pi-impact-analyzer` are `long-horizon+`; `trace-ledger` is not in lite either. | The small model that most needs cheap file navigation and loop detection is the one denied it. Direct cause of the read-thrash. |
| **`trace-ledger` is a stub** (`packages/extensions/src/trace-ledger/index.ts` hooks the events but returns `undefined`). | There is no action history, so nothing can detect "same command N times" or "no progress." Loop detection has no substrate. |
| `pi-lean-ctx` was in lite, but its compression bridge needs an external `lean-ctx` CLI (leanctx.com) that isn't installed — it failed with `spawn ENOENT` and never actually compressed. | Dropped from the lite surface in 0.4.1; `pi-readseek` (working native binary) is the navigation win there instead. |
| `caveman` (terse-output) is in lite. | Output-side savings already available; ensure it is actually enabled at a useful level. |

## Part A — Skills expansion & improvement

### A1. A standard skill shape

Adopt one template so every skill is a runbook, not a slogan. Keep the always-in-context
`description` tight (it is the only part that costs tokens until loaded) and push depth
into the body and `references/`.

```
packages/kit/skills/<name>/
├── SKILL.md          # frontmatter + when-to-use + procedure + heuristics + anti-patterns
├── references/       # deep material loaded on demand (checklists, tables, examples)
└── scripts/          # optional helper scripts the model can invoke
```

SKILL.md sections (target 40–90 lines):
- **Frontmatter** — sharp `description` ("what + when"), optional `allowed-tools`,
  optional `metadata` (tier, profiles).
- **When to use / when NOT to use** — explicit trigger and anti-trigger.
- **Procedure** — numbered, each step with an action + a stop condition.
- **Decision heuristics** — the judgement calls (e.g. "read a range, not the file, when
  the symbol is known").
- **Anti-patterns** — the failure modes this skill exists to prevent (loops, over-reading).
- **Done / verification** — what "finished" looks like.
- **References** — links to `references/*.md` for depth.

### A2. Per-skill assessment (current → action)

| Group | Skills | Now | Action |
|---|---|---|---|
| Core coding/general | `coding-agent-workflow`, `general-agent-workflow`, `task-decomposition`, `codebase-orientation`, `patch-hygiene`, `verification-loop` | 8–18 ln | **Rewrite to runbooks.** These are the daily drivers and the ones most implicated in the loop problem — add explicit read-budget and "you already have enough, act" guidance. |
| Context / small-model | `small-model-execution`, `context-compression`, `long-horizon-checkpointing`, `mcp-tool-use`, `mcp-only-operations` | 8–24 ln | **Expand + de-`pi_system_governance`-couple.** Several hard-code `pi_system_governance.*` MCP calls that only exist in the pentest domain; gate that behind "if governance domain loaded." |
| Orchestration / recovery | `agent-orchestration` (good, 38 ln), `recovery-debugging` (8 ln), `hypothesis-lifecycle` | mixed | Keep `agent-orchestration` as the template exemplar; **rewrite `recovery-debugging`** into a real runbook and link it to Part C. |
| Pentest / governance | `action-card-builder`, `api-testing`, `authz-idor-testing`, `burp-web-triage`, `endpoint-inventory`, `evidence-review`, `finding-writing`, `methodology-mapper`, `scope-roe-governance`, `supply-chain-review`, `code-security-review`, `report-export-review`, `tool-policy-classifier` | 4–14 ln | **Expand selectively.** These are domain skills (not in lite). Deepen the high-value ones (`authz-idor-testing`, `api-testing`, `finding-writing`, `code-security-review`); leave niche ones as concise pointers with `references/`. |
| Docs | `documentation-workflow` | 15 ln | Expand; align with the `docs-*` prompts. |
| Kit maintainers | `governance-extension-maintainer`, `validation-test-maintainer`, `wrapper-runtime-maintainer` | 14 ln | Expand into contributor runbooks; cross-link `CONTRIBUTING.md` and `WRITING_EXTENSIONS.md`. |

### A3. New skills to add

- **`efficient-file-navigation`** — search/structural-map before reading; read ranges not
  whole files; never re-read unchanged files; use `readseek`
  structural maps where available. *Directly targets the read-thrash.*
- **`tool-budgeting`** — "do more with less": batch independent calls, prefer one grep
  over many reads, summarize output before continuing, set a per-task read ceiling.
- **`self-reflection-and-recovery`** — the model-facing companion to Part C: how to
  fork-and-reflect, recognise a loop, and delegate a stuck sub-task to a scout.
- **`delegation-context-budgeting`** — how much context each sub-agent needs (target
  files + hypothesis + acceptance check, nothing else); complements `agent-orchestration`.
- **`fork-and-compact-discipline`** — when to `/compact`, `/fork`, `/new`; pairs with the
  `session-helpers` extension.

### A4. Making small models actually load skills

Progressive disclosure fails silently on small models. Mitigations, layered:
- Keep descriptions **trigger-shaped** ("Use when …") so the model self-selects.
- Have the **orchestrator** (already steering plan→implement→validate) name the relevant
  skill in its `ctx-contribution` so the steer says "load skill X via `/skill:name`."
- For critical always-relevant guidance (read-budget, loop-avoidance), consider a **very
  short always-on nugget** injected by `context-sieve` (cheap) that points to the fuller
  skill — belt-and-suspenders.
- Use `disable-model-invocation: true` only for operator-only skills (maintainers), to
  keep the auto-selected set focused.

## Part B — Efficiency: do more with less

### B1. Implement `trace-ledger` for real

Turn the stub into a bounded action ledger — the substrate for B/C:
- On `tool_call`: append `{ ts, tool, targetPath?, argsHash, turn }`.
- On `tool_result`: append status (ok/error) + a size/lines figure.
- Store a **bounded ring buffer** in `.pi/trace.jsonl` (cap N, e.g. 500) + an in-memory
  window for fast queries.
- Expose a read-only query the guard (Part C) uses: "last K tool calls," "count of
  argsHash," "distinct files read this task."
- Add `trace-ledger` to lite/quick (it is behaviour-only, near-zero visible surface).

### B2. Bring cheap navigation to the small-model surface

The core fix for the read-thrash. Options (decision in Part G):
- **B2a (chosen, verified):** add `pi-readseek` to the lite surface (hash-anchored
  read/edit/grep + structural code maps + AST search). **Windows/Node 24 build verified
  2026-07-24:** `@jarkkojs/readseek` ships a native CLI binary (`readseek.exe`, win32-x64)
  that pi-readseek shells out to — installs clean and `readseek --version` runs. Not a
  Node addon, so there is no `.node`/ABI concern.
- **B2b:** keep lite pure and add a new **`lite-plus`** surface that includes readseek +
  trace-ledger + the guard, for local models on non-trivial repos.
- `pi-readseek` is the lite navigation win. `pi-lean-ctx` was dropped from lite in 0.4.1
  because its compression needs the external `lean-ctx` CLI (absent by default → ENOENT); it
  remains only in the full-kit profiles for setups that install that binary.

### B3. Read/tool-call budgeting (soft guardrail)

- The `efficient-file-navigation` + `tool-budgeting` skills (Part A) are the guidance.
- Optional enforcement: a small advisory that, when `trace-ledger` shows the same file
  read ≥3× or >N reads with no edit, injects a one-line `ctx-contribution`: "You have
  read these files already — you have enough to act." Advisory, never a hard block
  (hard blocks on `read` would be worse than the disease).

### B4. Output-side savings

- Ensure `caveman` runs at a useful level by default in lite (terse output).
- Confirm `context-sieve` compaction template preserves goal/plan/verifier state so
  post-compaction the model does not re-read everything to rebuild context.

## Part C — Auto-boost / anti-loop / self-reflection (backend assistance)

This is the flagship. It is **assistance, not bug-fixing** (per the request): keep the
agent progressing, don't try to author fixes. It escalates to the deeper
`recovery-orchestration-mode` only when assistance is not enough.

### C1. Detect "stuck" (from `trace-ledger`)

Soft signals, any of:
- **Repetition:** same `argsHash` (or same tool+target) ≥ N times in the last window.
- **Oscillation:** alternating between the same 2–3 actions with no edit/verify between.
- **No progress:** K turns with reads but no writes/verifications, or goal unchanged.
- **Churn:** repeated edit→revert on the same file.
Thresholds via env (`PI_KIT_GUARD_REPEAT`, `PI_KIT_GUARD_STALL_TURNS`, …), default small.

### C2. Self-reflect in a fork (the "am I on track?" check)

On a soft signal, run a **cheap reflection** — a forked/isolated context (or a `scout`
subagent) asked: *"Goal = <goal>. Recent actions = <ledger digest>. Are we progressing,
or looping? If looping, what is the single smallest different next action?"*
- **On track →** inject nothing (or a one-line nudge) and continue. No interruption.
- **Looping →** escalate to C3.
The reflection must NOT see the main context's full transcript — just the goal + ledger
digest — so it is cheap and not re-anchored.

### C3. Delegate to fresh sub-agents (save main-context tool calls)

When looping, hand the stuck sub-task to a fresh-context specialist (`subagent`), which
does the work in its own window and **reports back only the distilled result** — the
answer, the file:line, the decision — not the raw tool output. This is the core
"do more with less": the expensive exploration happens in a disposable context, and the
main chat receives a few tokens of conclusion.

### C4. Guidance injection (never a system prompt)

All nudges go through a `context-sieve` **`ctx-contribution`** (context-sieve is the sole
injection authority; follow the orchestrator's pattern). Examples:
- "You have read these 6 files; you have enough — make the edit."
- "This is the 3rd variation of the same command; step back — delegate the lookup to a
  scout and continue."

### C5. Autonomy dial & safety

- **Autonomous profile:** guard acts automatically (reflect + delegate).
- **Interactive profiles:** guard *suggests* ("Looks like a loop — want me to delegate
  this?") and offers manual `/reflect` and `/boost` commands (add to `session-helpers`).
- **Debounce:** fire at most once per signal window; never recurse into itself.
- **Bounded fan-out:** cap reflections/delegations per task; if still stuck, escalate to
  `recovery-orchestration-mode` (deep multi-agent RCA) or to the operator.
- **Non-destructive:** assistance only; any delegated *write* checkpoints first.

### C6. How the pieces relate

```
trace-ledger (facts)
      │  detects
      ▼
progress-guard (Part C: reflect → nudge → delegate)   ← NEW extension
      │  still stuck after N
      ▼
recovery-orchestration-mode (deep root-cause: scouts + forked top-10 + plan)  ← design doc
```

## Part D — Extension / config changes (summary)

| Item | Change |
|---|---|
| `trace-ledger` | **Implement** the ledger (B1). Add to lite/quick. |
| `progress-guard` | **New** extension (Part C): detect + reflect + delegate + nudge. |
| `session-helpers` | Add manual `/reflect` and `/boost`; optional `/skill <name>` loader helper. |
| `context-sieve` | Confirm compaction template; accept guard/guidance contributions. |
| Surfaces | Add `trace-ledger` + `progress-guard` (+ `readseek` per Part G) to lite, or introduce `lite-plus`. |
| Skills | ~31 rewritten to the A1 template + ~5 new (A3). |

## Part E — Docs to keep in sync

- New: `docs/skills-catalogue.md` (auto-generatable from frontmatter), `docs/efficiency-and-loops.md` (Parts B/C for users).
- Update: `getting-started.md`, `install-surfaces.md`, `EXTENSIONS.md`, `NORTH_STAR.md`
  (guard fits the verification/observability layers), `recovery-orchestration-mode.md`
  (link the guard as its trigger), `mkdocs.yml` nav.
- Regenerate `docs/EXTENSIONS.md` / catalogue via `npm run catalog`.

## Part F — Phased implementation (this branch)

Each phase ends with `node packages/core/verify.mjs`, both epic smoke tests, a docs pass, an export
(`npm run export:lite`), and a version bump.

- **Phase 1 — efficiency hotfix (`0.2.1`, patch): ✅ DONE (2026-07-24).** Implemented the
  real `trace-ledger` (ledger + repeat-read notice + `/trace`); added
  `efficient-file-navigation` + `tool-budgeting` skills; added `pi-readseek` **and**
  `trace-ledger` to the lite surface (readseek build verified). Exported, `verify` +
  smoke green. `caveman` already present in lite.
- **Phase 2 — skills expansion (`0.3.0`, minor): ✅ DONE (2026-07-24).** Rewrote 27 skills to
  the runbook template (workflow, context, recovery, docs, 5 high-value pentest, 3
  maintainer), fixed 2 skills that had no frontmatter (wouldn't load), added 3 new skills
  (self-reflection-and-recovery, delegation-context-budgeting, fork-and-compact-discipline),
  de-coupled hard `pi_system_governance.*` calls, curated the lite skill set, wired an
  orchestrator skill-load pointer, and added the skills catalogue doc. Niche pentest skills
  kept as concise pointers (per decision).
- **Phase 3 — auto-boost (`0.4.0`, minor): ✅ DONE (2026-07-24).** Built `progress-guard`
  (detect repeat / read-stall → self-reflect → nudge/delegate) with manual `/reflect` and
  `/boost`, the autonomy dial (`PI_KIT_GUARD_MODE` auto/suggest; auto recommended on
  autonomous), guidance via `context-sieve` contribution only (never a system prompt).
  Wired into all profiles + lite. Added `docs/efficiency-and-loops.md` and linked
  `recovery-orchestration-mode` as the deep escalation.

## Part G — Decisions

**Resolved (2026-07-24):**
1. **Phase order:** efficiency first (Phase 1). ✅
2. **Navigation:** add `pi-readseek` to the **lite** surface *if it builds cleanly on
   Windows*; fall back to a `lite-plus` surface only if the native build fails. ✅
3. **Reflection model:** **same local model** to start (cheap, offline). Design the guard
   so the model is swappable via `provider-router` later, but do not require a 2nd model. ✅

**Still open (revisit at the relevant phase):**
4. **Auto-delegation aggressiveness (Phase 3):** automatic on `autonomous` only, or also
   `balanced`? How many delegations before escalating to the operator?
5. **Pentest skills (Phase 2):** deepen all, or keep niche ones as thin pointers to
   `references/`?

## Part H — Risks

- **Native deps (readseek/lens) on Windows** — `pi-readseek` verified working on this box
  (native CLI binary, not an addon). `pi-lens`/`pi-impact-analyzer` still to verify if
  pulled into lower tiers.
- **Tool-surface bloat** — every added model-visible tool costs a small model attention;
  prefer behaviour-only extensions (ledger, guard, lean-ctx) over new visible tools.
- **Over-eager auto-delegation** — could add overhead on tasks that were fine; the
  autonomy dial + debounce + bounded fan-out mitigate this.
- **Skill-loading reliability** — if small models still ignore skills, lean harder on the
  orchestrator steer + short always-on nuggets.

## Related

- `docs/recovery-orchestration-mode.md` — deep root-cause escalation (Part C6).
- `docs/agent-orchestration.md`, `packages/kit/skills/agent-orchestration/SKILL.md` — the delegation
  template to mirror.
- `packages/extensions/src/orchestrator/`, `packages/extensions/src/context-sieve/`, `packages/extensions/src/trace-ledger/`,
  `packages/extensions/third_party/caveman/`, external `pi-lean-ctx` / `pi-readseek`.
