---
name: recovery-debugging
category: orchestration-recovery
description: Recover after a failed command, bad patch, or interrupted session. Use when the working state is broken or uncertain — stop, assess, preserve user work, and fix forward narrowly or ask for direction.
disable-model-invocation: true
triggers: ["broke the build", "build is broken", "broken build", "bad patch", "revert the change", "undo the change", "undo my change", "working tree is broken", "interrupted session", "recover from"]
---

# Recovery Debugging

When state is broken or unclear, the worst move is to keep changing things. Stop and get
your bearings first.

## When to use
- A command failed, a patch went wrong, or a session was interrupted and you're unsure of
  the state.

## Procedure
1. **Stop editing.** Do not pile on more changes to a state you don't understand.
2. **Assess** — in read-only steps: working-tree status, the recent diff, the failing
   command's actual output, and the latest checkpoint (`context-management`) or
   git-checkpoint.
3. **Preserve user work.** Never revert or discard changes that aren't yours to revert.
4. **Fix forward narrowly.** Make the smallest change that returns to a known-good state,
   then verify (`verification-loop`).
5. **If the state is ambiguous,** state exactly what's unclear and ask the operator for
   direction rather than guessing.

## When you're stuck, not just broken
If you've already tried a few fixes and they didn't work — or made it worse — this is a
loop, not a bug hunt. Escalate:
- Self-reflect and, if looping, delegate a fresh diagnosis
  (`self-reflection-and-recovery`).
- For a deep root-cause pass, see `docs/recovery-orchestration-mode.md` (fresh scouts +
  forked top-10 causes + a primary/backup plan).

## Anti-patterns
- Making more edits before understanding the current state.
- Reverting the user's unrelated changes to "clean up."
- Re-running the failing action unchanged.

## Done
State is back to known-good with a verified narrow fix, or the exact ambiguity is surfaced
to the operator.
