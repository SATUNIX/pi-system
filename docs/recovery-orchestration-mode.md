# Recovery Orchestration Mode

> The `recovery-orchestrator` extension implements this mode (design option A from §8).
> `progress-guard` detects loops, stalls and oscillation and, after `PI_KIT_GUARD_ESCALATE` nudges
> on the same signature, writes `.pi/recovery/escalation.json`; `recovery-orchestrator` then
> enters this deep mode once per signature: it writes a recovery report scaffold and steers the
> §2 flow via a `context-sieve` contribution (never a system prompt). It is non-destructive
> (plans and steers; the repair is a delegated `implementer` after a checkpoint) and bounded to
> `PI_KIT_RECOVERY_MAX_ATTEMPTS` per signature. Manual trigger: `/recover`. While recovery is
> active it opens the separate recovery budget in the [effort ledger](effort.md#how-delegation-is-budgeted)
> (two read-only scouts), so a session at the lowest effort can still get help when stuck. The
> `npm run eval` recovery fixtures cover it. This document is the specification of the method the
> extension drives.

## 1. Problem

Autonomous coding runs get *stuck*: the agent tries a fix, it doesn't work (or makes
things worse), it tries a variation, and it burns context looping on the same wrong
mental model. A single context that has already failed N times is the worst possible
place to diagnose the failure — it is anchored on its own bad hypothesis.

The fix is to **break context anchoring**: pull in fresh, independent investigators,
force the incumbent context to enumerate causes explicitly, then synthesise and
delegate the actual repair. This mode automates a method the operator already runs by
hand.

## 2. The method (operator's manual workflow, to be automated)

1. **Fan out fresh scouts.** Spawn 2–3 sub-agents with *fresh context* (no memory of the
   failed attempts) to independently investigate the code and report suspected bugs /
   issues. Independence is the point — they must not see each other's or the main
   agent's conclusions.
2. **Interrogate the incumbent (in a fork).** `/fork` the main chat so the loaded
   context is preserved but the branch is disposable. Ask the forked main agent, which
   *does* have the full history: "What problems have we observed? What are we actually
   struggling with? List the **top 10 most likely causes.**"
3. **Synthesise in the fork.** Feed the 2–3 scout reports *plus* the forked main agent's
   top-10 into the fork. Now one context holds every angle: fresh outside views and the
   history-aware inside view.
4. **Plan primary + backup.** From the combined evidence, write a plan to fix the single
   **most likely** cause, plus a **backup plan** to run if the primary fix fails or
   regresses.
5. **Delegate the repair.** Hand the fix to specialist sub-agents, each given *just the
   right amount of context* — the target files, the chosen hypothesis, the acceptance
   check — and nothing else.

## 3. Trigger conditions

### Automatic
- **No progress after a few attempts.** A repeat counter on the same failing signature
  (same failing command, same error class, same target file) crosses a threshold.
  Reuse the existing knob `PI_KIT_ORCH_THRESHOLD` (default `3`) or a dedicated
  `PI_KIT_RECOVERY_THRESHOLD`.
- **A fix didn't work.** The verification that was supposed to pass after an edit still
  fails (build/test/lint unchanged or still red).
- **A fix made it worse.** A previously-passing check now fails, or the failure count
  *increased* after an edit — a regression, the strongest signal.

### Manual
- A `/recover` (or `/unstuck`) command to invoke the same flow on demand, so the
  operator can trigger it before the auto-threshold if they can feel the loop starting.

### Anti-trigger / debounce
- Fire **at most once per unresolved signature** until either the plan completes or the
  signature changes — never re-enter on every turn.
- Suppress inside an already-running recovery (no recursive recovery).
- Require a real failure signal, not just "a turn ended" — otherwise it competes with
  normal orchestration.

## 4. Mapping onto existing kit primitives

This mode is an *orchestration* over pieces the kit already ships; it should not
reinvent them.

| Method step | Existing primitive |
|---|---|
| Fresh independent scouts | `subagent` tool + the `scout` role agent (`packages/kit/agents/scout.md`), fanned out 2–3× with `agentScope` isolating context |
| Fork the incumbent | pi built-in `/fork` (preserves loaded context on a disposable branch) |
| Enumerate top-10 causes | a recovery prompt (extend `packages/kit/prompts/code-recover.md`) run in the forked branch |
| Detect "fix failed / worse" | `verify-gate` + `verifier-board` verdicts; `git-checkpoint` diff vs last green checkpoint |
| Count attempts | `trace-ledger` (already records the action history) |
| Plan primary + backup | `spec-plan` / `plan-mode` for the plan artifact |
| Delegate repair | `orchestrator` → `implementer` role agent, one specialist per sub-task |
| Context assembly / injection | `context-sieve` is the **sole** injection authority — recovery drops a `ctx-contribution`, it does not inject a system prompt itself (follow the orchestrator's pattern) |
| Non-destructive rollback | `git-checkpoint` + `protected-paths` |

## 5. Context budgeting ("just the right amount")

The whole value is *who knows what*:

- **Scouts** get: the repo, the failing symptom, the acceptance check. **Not** the main
  agent's hypotheses or the attempt history — that would re-anchor them.
- **Forked incumbent** gets: everything it already has (that is the point of the fork).
- **Synthesis step** gets: scout reports + the top-10, and produces a *ranked* cause
  list with a single chosen primary.
- **Repair specialists** get: the chosen hypothesis, the specific target files, the
  acceptance check, and the backup trigger — not the full transcript, not the other
  candidate causes.

Keeping these context boundaries crisp is what makes the multi-agent approach beat a
single big context; blur them and you just pay more tokens for the same anchored answer.

## 6. Outputs / artifacts

- A **recovery report** (suggested: `.pi/pentest/hypotheses/` already exists as a home,
  or a new `.pi/recovery/<timestamp>.md`) containing: the failing signature, the 2–3
  scout findings, the incumbent's top-10, the ranked synthesis, the primary plan, and
  the backup plan.
- A `trace-ledger` entry marking recovery entered/exited and the outcome.
- Checkpoint before the repair so the backup plan (or a clean abort) is always available.

### Lifetime of the steering contribution

The recovery-orchestrator's steering contribution is intentionally session-scoped. It is written
when recovery is entered or the attempt cap is hit (`writeContribution` at
`recovery-orchestrator/index.ts:280,294,324,330`) and is cleared only on `session_start`
(`:263`), so it can persist for the rest of the session. It does not repeat verbatim within a
session because `context-sieve`'s message dedup (`context-sieve/index.ts:215-227`) suppresses an
unchanged message until compaction. Clearing it on recovery success is not implemented: there is
no clean completion signal — `boardPassing` in `planRecovery`
(`recovery-orchestrator/index.ts:213-215`) is a no-op. Treating recovery success as a clear
signal is a future product decision, not current behaviour.

## 7. Safety & autonomy fit

- **Non-destructive by default.** Recovery investigates and plans; it checkpoints before
  any repair and never reverts unrelated changes (same rule as `code-recover`).
- **Bounded fan-out.** Cap scouts (2–3) and cap total recovery attempts per signature to
  avoid a spawn storm on a genuinely hard bug — escalate to the operator instead.
- **Fits the autonomous profile.** It is a natural companion to `autonomous-loop`: the
  loop keeps working, and recovery is what the loop *does* when it detects it is stuck,
  rather than grinding. On non-autonomous profiles it should prefer to surface the plan
  and wait.
- **One injection authority.** Drop a `ctx-contribution` for `context-sieve`; do not
  emit a `systemPrompt`.

## 8. Proposed shape (for a later implementation)

Two candidates, not yet decided:

- **(A) An extension** `recovery-orchestrator` that hooks `turn_end` / `tool_result`,
  maintains the failing-signature counter, and on trigger writes a high-priority
  `ctx-contribution` steering the main agent through §2 (mirroring how `orchestrator`
  already steers plan→implement→validate). Registers `/recover`.
- **(B) A skill** `recovery-orchestration` (SKILL.md) that documents the §2 flow for the
  model to follow, with the *detection* left to `verifier-board` + `trace-ledger`. Lower
  effort, no new runtime code, but no automatic trigger.

Likely answer: **B first** (skill + prompt, immediately useful and safe), then **A** to
add the automatic stuck-detector once the flow is proven by hand.

## 9. Open questions

- **Signature definition.** What exactly counts as "the same problem"? (failing command
  string? error class? touched file set? a hash of all three?) This determines when the
  counter increments vs resets.
- **"Worse" metric.** Is regression measured by test count, a checkpoint diff, or an
  explicit `verifier-board` verdict flip? Needs a single source of truth.
- **Scout model.** Do scouts run on the same local model (cheap, but correlated blind
  spots) or a second provider via `provider-router` (more independent, needs a 2nd
  model)? Independence is worth more here than anywhere else in the kit.
- **Fork automation.** Can an extension drive `/fork` programmatically, or is the fork an
  operator action the mode only *prompts* for? (Check `session_before_fork` hook + the
  `withSession` command API.)
- **Budget ceiling.** Hard token / attempt ceiling before recovery gives up and escalates
  to the operator (or to `remote-review` / `dual-review`).

## 10. Related

- `packages/kit/skills/recovery-debugging/SKILL.md` — the current, minimal recover behaviour.
- `packages/kit/prompts/code-recover.md` — the current recover prompt (to be extended for §2).
- `packages/extensions/src/orchestrator/` — the delegation pattern to mirror.
- `packages/extensions/src/autonomous-loop/` — the loop this mode defends.
- `docs/agent-orchestration.md`, `docs/capability-research-workflow.md`.
