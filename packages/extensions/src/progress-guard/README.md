# progress-guard

The auto-boost / anti-loop layer. It watches for cheap "stuck" signals and helps the agent
break out — by prompting a self-reflection and, on autonomous runs, nudging it to delegate
the stuck work to a fresh sub-agent. It is **assistance, not bug-fixing**.

## What it detects

From the tool calls it observes (it maintains its own small window; it also complements the
`trace-ledger` facts on disk):

- **Repetition** — the same action (tool + args) repeats `PI_KIT_GUARD_REPEAT` times
  (default 3) in the recent window.
- **Oscillation** — a strictly alternating A→B→A run since the last write
  (`PI_KIT_GUARD_OSC`, default 3).
- **Read-without-progress** — `PI_KIT_GUARD_STALL` reads (default 10) since the last edit.
  The threshold is 10, not 6: a fresh session often opens with 6–9 orienting reads, and firing
  there was a false positive. In a session with **no write-capable tool active** (a read-only
  role) the read-stall signal is suppressed entirely — there is no edit the agent could make,
  so "reads since last edit" is not a stall.

A write/edit that actually **succeeds** resets the stall counter and stands down any active
nudge — progress clears the signal. A failed write/edit attempt does not (AG-06): otherwise
a loop that repeatedly attempts the same failing edit would silently reset its own
detection on every attempt, before the result was even known.

## What it does (the autonomy dial)

`PI_KIT_GUARD_MODE` (overridable per session with `/boost`):

- **`auto`** — inject a guidance nudge via a `context-sieve` contribution **and** notify.
  The autonomous profile should set `PI_KIT_GUARD_MODE=auto`.
- **`suggest`** (default) — notify a suggestion only for the first firings; never inject the
  light nudge.

### Automatic review / delegate escalation

Once the **same signature keeps recurring** (`PI_KIT_GUARD_ESCALATE`, default 2 firings), the
stronger **review/delegate checkpoint** is injected **unconditionally** — in either mode and
with no `/reflect` or `/boost` needed. It is written as a `context-sieve` contribution *and*
as a `.pi/recovery/escalation.json` marker so `recovery-orchestrator` can act on it. This is the
automatic replacement for the manual `/reflect` step. Escalation counts every firing turn, not
just the ones the cooldown let a nudge through, so a slowly-repeating stall can still escalate.

It **never blocks a tool** and **never emits a system prompt** — all guidance goes through a
`context-sieve` ctx-contribution (context-sieve is the sole injection authority). The light
nudge is debounced per signal (`COOLDOWN_TURNS`).

## Commands

| Command | Effect |
| --- | --- |
| `/reflect` | Optional manual checkpoint. The recurring-loop checkpoint is injected automatically; use this only when you want one on demand. |
| `/boost on` | Auto-nudge on detected loops for this session. |
| `/boost off` | Suggest-only; clears any active nudge. |
| `/boost status` | Show mode, reads-since-edit, window size, and thresholds. |

## Configuration

| Env | Default | Meaning |
| --- | --- | --- |
| `PI_KIT_GUARD_MODE` | `suggest` | `auto` or `suggest`. |
| `PI_KIT_GUARD_REPEAT` | `3` | Repeat count that trips the loop signal. |
| `PI_KIT_GUARD_STALL` | `10` | Reads since last edit that trip the stall signal. |
| `PI_KIT_GUARD_OSC` | `3` | Minimum alternating A→B→A run that trips the oscillation signal. |
| `PI_KIT_GUARD_ESCALATE` | `2` | Firings of one signature before the automatic review/delegate checkpoint. |

## Relationship to other pieces

```
trace-ledger (facts)  ─┐
progress-guard         ─┼─ detect → reflect → (auto) nudge → delegate
self-reflection-and-recovery (skill the nudge points to)
      │ still stuck after delegating
      ▼
docs/recovery-orchestration-mode.md  (deep multi-agent root-cause; design)
```
