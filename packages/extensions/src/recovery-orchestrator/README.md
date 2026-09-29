# recovery-orchestrator

The deep root-cause recovery layer (`docs/recovery-orchestration-mode.md`, §2). It is the
escalation target for `progress-guard`: when assistance (nudging) hasn't broken a loop,
`progress-guard` writes `.pi/recovery/escalation.json`, and on the next `turn_end` this
extension enters recovery **once** for that signature.

## What it does

1. Writes a **recovery report scaffold** to `.pi/recovery/<attempt>-<signature>.md` (scout
   findings, incumbent top-10, ranked synthesis, primary + backup plan, outcome).
2. Drops a high-priority **`context-sieve` contribution** steering the §2 flow: fan out fresh
   scouts, `/fork` the incumbent for the top-10 causes, synthesise, plan primary + backup
   (checkpoint first), delegate the repair to an `implementer`, then re-`/verify`.
3. Bounds attempts per signature (`PI_KIT_RECOVERY_MAX_ATTEMPTS`, default 2). Past the cap it
   tells the operator to escalate (dual-review / remote-review) instead of spawning more.

## What it does NOT do

- It never edits code or reverts changes — it plans and steers. Repairs happen through the
  delegated `implementer` after a `git-checkpoint`.
- It never emits a system prompt — `context-sieve` is the sole injection authority.
- It does not spawn sub-agents itself; the model drives `subagent`/`/fork` per the steer.

## Trigger

- **Automatic:** `progress-guard` escalation marker (a repeat/oscillation/stall signature
  nudged `PI_KIT_GUARD_ESCALATE` times).
- **Manual:** `/recover [signature]`.

## Env

- `PI_KIT_RECOVERY_MAX_ATTEMPTS` (default 2) — recovery attempts per signature before giving
  up to the operator.
- `PI_KIT_RECOVERY_SCOUTS` (default 3) — how many fresh scouts the steer asks for.

Ships in `long-horizon`, `autonomous`, and `self-improving` (the recovery-heavy tiers).
