# Feature: Animated ASCII Cat Status Indicator
> Draft only, not authoritative but something like this would be a nice addition to give the system some personality. seeing what current extensions we have that fit in nicely with this etc. if we are adding it lets see what we currently have and how it can be extended to add in this animation nicely. 
## Summary

Replace or augment the current generic loading/status indicator with a small animated ASCII cat that reflects the current application or agent state.

The cat should appear immediately to the left of status text such as:

```text
=^..^=  Thinking...   |
=^..^=  Crunching...  /
=^..^=  Working...    -
```

Alternatively, where the layout permits a two-line indicator:

```text
 /\_/\
 (o.o)  Thinking...   |
```

The objective is to provide a small amount of personality and ambient feedback without making the terminal UI noisy or distracting.

The implementation should use only the 95 printable US-ASCII characters by default.

---

## Goals

* Provide visually distinct states for common agent/application activity.
* Animate state changes without requiring terminal graphics or Unicode.
* Keep animations small enough for a TUI footer/status area.
* Avoid layout movement when animation frames change.
* Retain the existing spinner where useful.
* Allow the cat and spinner to communicate different information:

  * Cat = semantic state.
  * Spinner = ongoing activity/progress.
* Make animations subtle when idle and more active while work is occurring.
* Make the system extensible so new states/animations can be added without changing rendering logic.
* Work correctly in basic terminals, SSH sessions, multiplexers, and minimal environments.
* Avoid adding significant rendering overhead.

---

# Proposed Layout

## Preferred: single-line status

```text
=^..^=  Thinking...   |
```

Example:

```text
=^o.^=  Thinking...   /
```

Advantages:

* Only consumes one terminal row.
* Suitable for existing footer/status-line implementations.
* Easy to integrate beside the current spinner.
* Animation does not affect surrounding layout.

Recommended format:

```text
<CAT>  <STATUS TEXT>  <SPINNER>
```

For example:

```text
=^..^=  Ready
=^o.^=  Thinking...   |
=^.o^=  Thinking...   /
=^..^=  Running tool  -
=^?^=   Waiting...
=^.^=   Complete
=^!^=   Warning
=^x.x^= Error
```

The cat should occupy a fixed-width region.

---

# Alternative: two-line cat

Where vertical space is available:

```text
 /\_/\
 (o.o)  Thinking...   |
```

This provides a more recognisable cat while remaining extremely small.

The same state machine can support both renderers.

Configuration could expose:

```text
cat_style = "compact"
```

or:

```text
cat_style = "head"
```

Where:

```text
compact:

=^..^=

head:

 /\_/\
 (o.o)
```

The compact renderer should be the default for a footer.

---

# Architecture

The animation system should be separated into:

```text
Agent/Application State
        |
        v
Status State Resolver
        |
        +---- status text
        |
        +---- cat animation
        |
        +---- spinner/progress indicator
        |
        v
TUI Status Renderer
```

The renderer should not contain application-state logic.

Instead, application events should resolve to a semantic status.

Example:

```text
IDLE
THINKING
WORKING
TOOL
WAITING
SUCCESS
WARNING
DENIED
ERROR
SLEEPING
```

The animation engine then selects the appropriate animation definition.

Conceptually:

```text
state -> animation -> frame -> renderer
```

---

# Core States

## 1. IDLE

Meaning:

* Agent is ready.
* No task is currently running.
* Waiting for user input.
* Normal resting state.

Static representation:

```text
=^..^=
```

Idle should deliberately have very little movement.

The cat should mostly remain:

```text
=^..^=
```

with occasional blinking or eye movement.

### Blink animation

```text
=^..^=
=^..^=
=^..^=
=^--^=
=^..^=
```

Recommended timing:

```text
frame duration: 150-250 ms during blink
blink interval: random/semi-random 4-10 seconds
```

Do not continuously loop the blink sequence.

### Look animation

```text
=^..^=
=^o.^=
=^..^=
=^.o^=
=^..^=
```

This can occur much less frequently than blinking.

Recommended:

```text
every 10-30 seconds
```

The idle animation should feel ambient rather than like a loading indicator.

---

# 2. THINKING

Meaning:

* Model inference is occurring.
* Agent is reasoning/planning.
* A response has not yet started.
* Internal processing is underway.

Base:

```text
=^..^=
```

Animation:

```text
=^o.^=
=^.o^=
=^..^=
=^.o^=
=^o.^=
=^..^=
```

Alternative scanning animation:

```text
=^o..^=
=^.o.^=
=^..o^=
=^.o.^=
=^o..^=
```

If strict fixed width is required, prefer the first animation.

Suggested display:

```text
=^o.^=  Thinking...   |
=^.o^=  Thinking...   /
=^..^=  Thinking...   -
```

Recommended frame interval:

```text
250-400 ms
```

---

# 3. CRUNCHING / COMPUTING

Meaning:

* Heavy processing.
* Analysis.
* Local computation.
* Large context processing.
* Data transformation.

Animation:

```text
=^..^=
=^.:^=
=^::^=
=^:.^=
=^..^=
```

Suggested display:

```text
=^.:^=  Crunching...  |
=^::^=  Crunching...  /
=^:.^=  Crunching...  -
=^..^=  Crunching...  \
```

Recommended interval:

```text
150-300 ms
```

This should look more active than THINKING.

---

# 4. WORKING

Meaning:

* General task execution.
* Agent has moved from planning into execution.
* Work is progressing but no more specific state applies.

Animation:

```text
=^..^=
=^o.^=
=^oo^=
=^.o^=
=^..^=
```

Display:

```text
=^o.^=  Working...    |
=^oo^=  Working...    /
=^.o^=  Working...    -
```

Recommended interval:

```text
200-350 ms
```

---

# 5. TOOL EXECUTION

Meaning:

* Agent is actively executing a tool.
* Shell command.
* File operation.
* Search.
* API call.
* External integration.

Animation:

```text
=^..^=
=^>.^=
=^>>^=
=^.>^=
=^..^=
```

Example:

```text
=^>.^=  Running tool...  |
=^>>^=  Running tool...  /
=^.>^=  Running tool...  -
```

If the tool name is available:

```text
=^>.^=  Running bash...     |
=^>.^=  Searching files...  /
=^>.^=  Fetching...         -
```

Do not expose internal tool names if the application's existing UX intentionally abstracts them.

---

# 6. STREAMING / RESPONDING

Meaning:

* Model has begun producing output.
* Tokens/content are actively arriving.

The animation should be quieter than THINKING because the visible output already indicates progress.

Animation:

```text
=^..^=
=^.^=
=^..^=
=^.^=
```

Or:

```text
=^..^=
=^.^=
=^..^=
```

Recommended interval:

```text
400-700 ms
```

---

# 7. WAITING

Meaning:

* Waiting on an external operation.
* Waiting on network response.
* Waiting for another agent/process.
* Waiting on a long-running task.

Animation:

```text
=^..^=
=^...^=
=^..^=
=^...^=
```

Example:

```text
=^...^=  Waiting...   |
```

This should animate more slowly than active computation.

Recommended:

```text
500-900 ms
```

---

# 8. WAITING FOR USER

Meaning:

* User input is required.
* Approval is required.
* Confirmation is required.
* Agent cannot continue autonomously.

Primary representation:

```text
=^?^=
```

Animation:

```text
=^..^=
=^?^=
=^..^=
=^?^=
```

Example:

```text
=^?^=  Waiting for input
```

For approval:

```text
=^?^=  Approval required
```

Recommended interval:

```text
600-1000 ms
```

The spinner should normally stop in this state because the application is not actively progressing.

---

# 9. APPROVAL / SECURITY GATE

Useful for applications with tool approval, autonomy gates, permission checks, or HITL controls.

While a decision is being evaluated:

```text
=^?.^=
=^. ?^=
```

For fixed-width implementations, prefer:

```text
=^?.^=
=^.?^=
=^?.^=
```

Display:

```text
=^?.^=  Checking action...  |
```

Once human approval is required:

```text
=^?^=  Approval required
```

---

# 10. SUCCESS

Meaning:

* Operation completed successfully.
* Tool returned successfully.
* Task completed.

Static:

```text
=^.^=
```

Short completion animation:

```text
=^..^=
=^.^=
=^-^=
=^.^=
```

Recommended behavior:

1. Play animation once.
2. Hold success face briefly.
3. Return to IDLE.

Example:

```text
=^.^=  Complete
```

Recommended duration:

```text
750-1500 ms total
```

Do not loop success indefinitely.

---

# 11. WARNING

Meaning:

* Recoverable issue.
* Degraded operation.
* Unexpected condition.
* User attention may be useful.

Static:

```text
=^!^=
```

Animation:

```text
=^..^=
=^!!^=
=^..^=
=^!!^=
```

Alternative:

```text
=^!^=
=^..^=
=^!^=
```

Example:

```text
=^!^=  Warning
```

Warnings should not animate indefinitely if doing so becomes distracting.

---

# 12. DENIED / BLOCKED

Meaning:

* Tool call rejected.
* Security policy blocked an action.
* Permission denied.
* Autonomy gate rejected execution.

Static:

```text
=^>.<^=
```

Animation:

```text
=^..^=
=^>.<^=
=^#.#^=
=^>.<^=
```

Example:

```text
=^>.<^=  Action denied
```

Play once or briefly, then transition to WAITING, IDLE, or another appropriate state.

---

# 13. ERROR

Meaning:

* Operation failed.
* Unhandled tool failure.
* Agent error.
* Fatal/non-recoverable state.

Static:

```text
=^x.x^=
```

Animation:

```text
=^x.x^=
=^X.x^=
=^x.X^=
=^X.X^=
=^x.x^=
```

This creates a small glitch effect.

Example:

```text
=^X.X^=  Error
```

Recommended behavior:

* Play glitch animation once or twice.
* Settle on:

```text
=^x.x^=
```

Do not continuously flash.

---

# 14. RETRYING

Meaning:

* Previous operation failed.
* Automatic retry/backoff is occurring.

Animation:

```text
=^x.^=
=^..^=
=^.x^=
=^..^=
```

Example:

```text
=^x.^=  Retrying...   |
```

This differentiates a recoverable retry from ERROR.

---

# 15. CANCELLED

Meaning:

* User cancelled an operation.
* Task execution was intentionally stopped.

Animation:

```text
=^..^=
=^-.-^=
=^---^=
```

Settle on:

```text
=^-.-^=
```

Example:

```text
=^-.-^=  Cancelled
```

Then return to idle.

---

# 16. SLEEPING / INACTIVE

Optional state for long-running applications.

Meaning:

* Application has been idle for an extended period.
* Agent is intentionally dormant.

Animation:

```text
=^-.-^=
=^---^=
=^-.-^=
```

Optional sleep indicator:

```text
=^-.-^= z
=^-.-^= zZ
=^-.-^= zZz
=^-.-^=
```

If strict width stability is important:

```text
=^-.-^= ...
=^-.-^= ..z
=^-.-^= .zz
=^-.-^= zzz
```

Sleeping should animate very slowly.

Recommended:

```text
800-1500 ms per animation frame
```

with pauses between sequences.

---

# 17. ALERT / ATTENTION

Meaning:

* Important state change.
* Immediate attention required.
* Different from a normal warning.

Static:

```text
=^O.O^=
```

Animation:

```text
=^o.o^=
=^O.O^=
=^o.o^=
=^O.O^=
```

Example:

```text
=^O.O^=  Attention required
```

---

# State Transition Model

A typical lifecycle might be:

```text
                 +----------+
                 |   IDLE   |
                 +----+-----+
                      |
                  user input
                      |
                      v
                +----------+
                | THINKING |
                +----+-----+
                     |
              plan/action ready
                     |
                     v
                +---------+
                | WORKING |
                +----+----+
                     |
             +-------+-------+
             |               |
             v               v
          +------+        +-------+
          | TOOL |        | WAIT  |
          +--+---+        +---+---+
             |                |
             +-------+--------+
                     |
                +----+----+
                |         |
                v         v
            +-------+   +-------+
            |SUCCESS|   | ERROR |
            +---+---+   +---+---+
                |           |
                +-----+-----+
                      |
                      v
                    IDLE
```

Additional branches:

```text
TOOL
 |
 +--> APPROVAL CHECK
        |
        +--> APPROVED --> TOOL
        |
        +--> USER INPUT --> WAITING FOR USER
        |
        +--> DENIED --> BLOCKED
```

---

# State Priority

Multiple internal states may exist simultaneously.

The status renderer should therefore use an explicit priority rather than whichever event happened most recently.

Suggested priority:

```text
ERROR
ALERT
DENIED
WAITING_FOR_USER
WARNING
TOOL
CRUNCHING
THINKING
WORKING
STREAMING
WAITING
SUCCESS
IDLE
SLEEPING
```

Exact priority can be adjusted to match application semantics.

---

# Animation Data Model

Animations should be data-driven rather than implemented as individual rendering functions.

Example conceptual structure:

```text
animations:
  idle:
    frames:
      - "=^..^="
    interval: null

  thinking:
    frames:
      - "=^o.^="
      - "=^.o^="
      - "=^..^="
      - "=^.o^="
    inte
```

