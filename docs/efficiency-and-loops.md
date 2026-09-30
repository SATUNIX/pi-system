# Efficiency and Loops

How the kit helps the agent do more with fewer tool calls, and recover when it starts
looping — especially on small local models.

## The problem

Small models tend to (1) read the same files repeatedly, (2) over-gather before acting, and
(3) repeat near-identical commands without progressing. Left alone this burns context and
stalls.

## The layers

### 1. Cheaper file I/O (behaviour-only)
- **`pi-readseek`** provides hash-anchored read/edit/grep plus structural code maps and AST
  search, so navigating a repo costs far fewer calls than full-file reads.
- **`caveman`** keeps the agent's own output terse.

These need no model action — they just make each call cheaper. **`pi-lean-ctx`** (which
compresses bash/read/grep output) is opt-in and in no profile: it needs the external `lean-ctx`
CLI and adds shell and edit tools the firewall does not classify as shell (see
[Supply chain](supply-chain.md)). The `lite` surface relies on `pi-readseek` instead.

### 2. Facts: `trace-ledger`
Records every tool call/result to `.pi/trace.jsonl` (tool, target, args hash, ok/error),
warns once when the same file is read 3×, and answers `/trace` (calls, errors, distinct
files read, top repeated reads). It's the data the guard reasons over.

### 3. Guidance: skills
Loaded on demand (the orchestrator points the model at them):
- **`codebase-navigation`** — locate before reading; read ranges; read once.
- **`self-reflection-and-recovery`** — fewest calls to a verified result; a loop self-check.
- **`self-reflection-and-recovery`** — notice looping → reflect → delegate.
- **`agent-orchestration`** — give each sub-agent only what it needs.
- **`context-management`** — reset context without losing the thread.

### 4. Auto-boost: `progress-guard`
Detects three cheap "stuck" signals — the same action **repeating**, an A→B→A
**oscillation** (alternating between two actions with no edit between), or many **reads
since the last edit** — and helps break out:
- **`suggest`** mode (default): notifies a suggestion; you run `/reflect` or delegate.
- **`auto`** mode: injects a guidance nudge (via a `context-sieve` contribution — never a
  system prompt) that tells the model to reflect and, if looping, delegate the stuck step to
  a fresh sub-agent that returns only the answer.

**Auto mode is automatic on unattended runs:** arming `autonomous-loop`
(`/loop <goal>`) writes `.pi/autonomous-loop.armed.json`, and `progress-guard` flips to
`auto` when that marker is present — no `PI_KIT_GUARD_MODE=auto` needed. `/boost on|off`
still overrides per session.

It never blocks a tool. A write clears the signal.

### 5. Deep escalation: `recovery-orchestrator`
When assistance isn't enough — the same signature keeps firing after
`PI_KIT_GUARD_ESCALATE` (default 2) nudges — `progress-guard` writes
`.pi/recovery/escalation.json` and `recovery-orchestrator` enters the deep
[recovery-orchestration mode](recovery-orchestration-mode.md): it writes a recovery report
scaffold and steers the multi-agent root-cause pass (fresh scouts + a forked top-10 of
causes + a primary/backup plan + a delegated fix). Non-destructive; bounded to
`PI_KIT_RECOVERY_MAX_ATTEMPTS` (default 2) per signature before escalating to the operator.
Manual trigger: `/recover`. Ships in `long-horizon`/`autonomous`/`self-improving`.

## Threshold calibration

The detection thresholds are first-principles defaults, validated against **scripted
fixtures** in the eval harness (`packages/core/eval/fixtures.mjs`) rather than mined from live sessions
— this kit is hardened offline, so no live-session `.pi/trace.jsonl` corpus was used to fit
them. The reasoning:

| Signal | Env | Default | Rationale |
|---|---|---|---|
| Repeat | `PI_KIT_GUARD_REPEAT` | 3 | 1–2 identical actions are normal (retry after a fix); the 3rd identical action with no progress is the earliest point a loop is unambiguous without false-firing on legitimate retries. |
| Oscillation | `PI_KIT_GUARD_OSC` | 3 | A→B→A (length 3, exactly 2 distinct alternating actions) is the shortest run that distinguishes a genuine ping-pong loop from normal interleaving. Shorter would fire on ordinary A→B→C work. |
| Read stall | `PI_KIT_GUARD_STALL` | 10 | Ten reads with no edit is well past "orient then act"; a model that thrashes typically exceeds this. Lower risks nagging during legitimate investigation. It is ignored entirely in a session with no write-capable tool active. |
| Escalate | `PI_KIT_GUARD_ESCALATE` | 2 | Nudge twice; if the same signature still recurs, assistance isn't working — hand off to the deep recovery pass rather than nudging indefinitely. |
| Recovery cap | `PI_KIT_RECOVERY_MAX_ATTEMPTS` | 2 | Two deep root-cause passes per signature; past that, escalate to the operator instead of spawning further. |

Re-tune by exporting the env vars above; they have not been fitted to a corpus of real
sessions.

## Quick reference

| Want | Use |
|---|---|
| See if you're repeating reads/commands | `/trace` |
| Force a self-reflection now | `/reflect` |
| Auto-nudge on loops this session | `/boost on` |
| Enter deep recovery now | `/recover` |
| Tune sensitivity | `PI_KIT_GUARD_REPEAT`, `PI_KIT_GUARD_STALL`, `PI_KIT_GUARD_OSC` |
| Auto-boost on autonomous runs | arm `/loop <goal>` (automatic) or `PI_KIT_GUARD_MODE=auto` |
