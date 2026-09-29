---
name: self-reflection-and-recovery
category: efficiency
description: Spend few tool calls, notice when you are looping or not progressing, and break out by reflecting, changing approach or delegating. Use when the same command or read repeats, a fix didn't work, or several turns pass without progress.
disable-model-invocation: true
triggers: ["going in circles", "stuck in a loop", "you're looping", "you are looping", "same error again", "still failing", "keeps failing", "try something different", "not making progress"]
---

# Self-Reflection and Recovery

The expensive failure isn't a hard bug. It's looping on a wrong assumption while burning
context. This skill covers the everyday habit of spending few calls, and how to notice a loop
and break out of it.

## Everyday habits
- **Gather to act, not to feel safe.** Collect the minimum you need for the next concrete
  change, then make it.
- **One good search beats many reads.** Batch independent calls. Reserve sequential calls
  for real dependencies.
- **Distil output.** After a big result, keep the few facts that matter. Don't carry raw
  dumps forward.
- **Soft ceiling.** Many calls with no edit or verification is a signal, not a reason to
  keep going.

## Triggers (any of)
- The same command or read keeps repeating with small variations. `/trace` shows this.
- A fix didn't work, or made things worse.
- Several turns of reading with no edit, no verification, and no change in the goal.
- You're oscillating between the same 2–3 actions.

## Break-out procedure
1. **Reflect, cheaply.** In one short step: "What's the goal? What have I actually tried?
   Am I progressing or repeating? What's the smallest *different* next action?"
2. **On track:** take that next different action and carry on.
3. **Stuck:** change the approach, or **delegate**. Send a fresh-context `scout` or
   `planner` subagent the goal, the target and the acceptance check, and ask it to report
   back only the answer you need (file:line, cause, decision). See `agent-orchestration`.
4. **Still stuck after delegating:** do a deep root-cause pass
   (`docs/recovery-orchestration-mode.md`) or escalate to the operator.

## Anti-patterns
- Re-running a failed command unchanged, hoping for a different result.
- Reading more and more instead of forming a different hypothesis.
- Grinding on a stuck sub-task alone instead of delegating the exploration.

## Done
You resumed with a genuinely different next action, or a fresh context returned the
distilled answer, and no call was repeated needlessly along the way.
