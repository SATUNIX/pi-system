---
name: verification-loop
category: coding-workflow
description: Choose and run the smallest check that can disprove a change, then fix-and-rerun. Use after every edit to confirm it works before moving on or reporting done.
---

# Verification Loop

Don't declare success — prove it, with the cheapest check that could show you're wrong.

## When to use
- After any change, before moving to the next step or reporting done.

## Procedure
1. **Pick the smallest disproving check.** The narrowest test/command/assertion that would
   fail if the change is wrong — a single test over the whole suite, a targeted run over a
   full build.
2. **Run it.**
3. **On pass:** proceed. Record what you verified (so you don't re-verify needlessly).
4. **On fail:** read the *actual* failure output, form one specific fix, apply it, and
   **rerun the same check**. One change per iteration.
5. **If it can't run:** state the exact blocker (missing dep, no runtime, out of scope) and
   the residual risk — do not claim verified.

## Decision heuristics
- Same check failing 3×? Stop tweaking — your model of the problem is wrong. Step back,
  or delegate a diagnosis (`self-reflection-and-recovery`).
- Don't broaden the check to make it pass; fix the cause.

## Anti-patterns
- "It should work" with no check run.
- Changing several things at once between runs so you can't tell what fixed it.
- Re-running an unchanged failing command hoping for a different result.

## Done
The smallest disproving check passes, or the exact blocker and residual risk are stated
plainly.
