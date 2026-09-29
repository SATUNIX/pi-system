# Improvement campaign 2026-09-22 — working notes and raw evidence

Branch: `improvement/campaign-20260922` (local only; not pushed).

This file records raw evidence gathered during the campaign, including defects observed
during the campaign itself. It is folded into `docs/improvement-campaign-20260922.md`
at the end; it is kept separate so the evidence is not lost if the campaign stops early.

## Phase 1 — scout sweep dispatch

Six read-only `scout` subagents dispatched in parallel at `2026-09-22T08:13:50Z`:

| area | run id | registry status |
| --- | --- | --- |
| 1 subagent extension | `2026-09-22T08-13-50-772Z-scout` | completed |
| 2 progress-guard/recovery/conductor | `2026-09-22T08-13-50-775Z-scout` | completed |
| 3 orchestrator/task-graph/verifier/gate | `2026-09-22T08-13-50-776Z-scout` | **error** (failed) |
| 4 security layer | `2026-09-22T08-13-50-776Z-scout` | completed |
| 5 context-sieve/compaction | `2026-09-22T08-23-43-475Z-scout` | completed |
| 6 install/verify/catalog/tests | `2026-09-22T08-24-02-808Z-scout` | completed |

### Observed failure — Area 3

Area 3's scout did not answer the assigned question. It drifted into
`node_modules/@earendil-works/pi-coding-agent/dist/` and returned an outline of the
vendored pi CLI instead of findings about `packages/extensions/src/orchestrator`,
`task-graph`, `verifier-board`, and `verify-gate`. The upstream provider terminated the
response before completion:

```
[Upstream error from Relace: The model stopped before completing the response.]
```

Registry record for the failure (`status: "error"`, `exitCode: 0`, turns 19):

```
{"ts":"2026-09-22T08:24:02.808Z","id":"2026-09-22T08-13-50-776Z-scout","event":"end",
 "agent":"scout","depth":0,"status":"error","exitCode":0,"turns":19,
 "model":"openrouter/deepseek/deepseek-v4.1-flash","cost":0.020280636,
 "attempts":1}
```

There is **no retry** despite `attempts: 1` and the run being a provider-side
truncation, not a deterministic task failure (`classifyFailure` saw `exitCode 0`).

Area 3 was re-dispatched (see below).

### Observed defect — subagent run-id collision (corroborates Area 1 finding 6)

Two parallel runs, Area 3 and Area 4, were assigned the **same run id**
`2026-09-22T08-13-50-776Z-scout`, because the id is
`<ISO timestamp with : and . replaced>-<sanitised agent name>` and both were the
`scout` agent dispatched in the same millisecond. Raw registry (`.pi/subagent/runs.jsonl`):

```
{"ts":"2026-09-22T08:13:50.776Z","id":"2026-09-22T08-13-50-776Z-scout","event":"start",...,"task":"AREA 3 ..."}
{"ts":"2026-09-22T08:13:50.776Z","id":"2026-09-22T08-13-50-776Z-scout","event":"spawn","pid":41931,...}
{"ts":"2026-09-22T08:13:50.776Z","id":"2026-09-22T08-13-50-776Z-scout","event":"start",...,"task":"AREA 4 ..."}
{"ts":"2026-09-22T08:13:50.777Z","id":"2026-09-22T08-13-50-776Z-scout","event":"spawn","pid":41932,...}
{"ts":"2026-09-22T08:24:02.808Z","id":"2026-09-22T08-13-50-776Z-scout","event":"end",...,"status":"error",...}   <- Area 3
{"ts":"2026-09-22T08:35:23.821Z","id":"2026-09-22T08-13-50-776Z-scout","event":"end",...,"status":"stop",...}    <- Area 4
```

Consequences observed live:

- The two runs shared one log file
  (`.pi/subagent/2026-09-22T08-13-50-776Z-scout.log`, 2.8 MB) — the Area 3 header is
  followed by Area 4's header and content, i.e. the file is interleaved, not isolated.
- `subagent_status` listed only **5** rows for **6** logical runs.
- The final `end` record (`status: "stop"`, Area 4) **overwrites** the earlier
  `status: "error"` row when status is derived, so the failed run is masked as completed.

This is the same defect Area 1 reported statically as finding 6 (`logging.ts:50`,
`live.ts:16`, `runner.ts:342`), now reproduced by the campaign dispatch itself.

### Supporting observation — registry does not reconcile dead PIDs (Area 1 finding 4)

All six logical runs are finished, yet the registry carries a `spawn` record with no
matching `end` for the colliding id's first attempt, and status only clears a row on an
`end` event. `processAlive(pid)` (`live.ts:49`) is never consulted by `status.ts`.

## Phase 3 — crash found during the campaign (WU-14)

The 1-hour run that ended when pi exited was caused by a real product defect, not by
the campaign tooling. Root cause (`packages/extensions/src/human-console/index.ts`):

- `processOne` awaited the UI confirm and then called `fs.unlinkSync(file)` unguarded.
- It was invoked as `void processOne(ctx, file)` with no rejection handler.
- A second resolver (another watcher, operator cleanup, or the requester's own timeout)
  removing the pending file first made `unlinkSync` throw `ENOENT` as an unhandled
  rejection, which terminated the pi process.

Fix committed in `962f720`:

- Guard the `unlinkSync` (missing file = success).
- `.catch()` the `void processOne(...)` call so a pending-file race can never crash the host.
- Best-effort removal of the requester's own pending file in `brokerRequest`.
- Deterministic regression case added to `tests/human-console-broker-smoke.mjs`.

This is tracked as **WU-14** (P0, independent, verify `npm run smoke:human-console-broker`).
It is distinct from the planned WU-1..WU-13 and was landed first so later subagent
dispatches cannot re-trigger the crash.

## Additional defects found while recovering (WU-15, WU-16) and an operator action

- **WU-15 (P1, done):** subagent children were observed with the resolved
  `node_modules/@earendil-works/pi-coding-agent/dist/cli.js` path as their *first user
  message* instead of the delegated task, leaving them with no instructions (they then
  asked the operator what to do). Current source produces the correct `Task: <task>`
  prompt; a prompt-integrity regression now asserts the spawn argv in
  `tests/subagent-containment-smoke.mjs`. Commit `3534c84`.
- **WU-16 (P1, done):** every project agent was told to `ask_human` when blocked. A headless
  child's request is written to the repo-wide `.pi/human-console/` queue, which every
  interactive session in the repo polls — so one confused child broadcasts a question to
  *all* sessions. Agent definitions (`.pi/agents/*` + `packages/kit/agents/*`) now forbid
  `ask_human` and require a `## Blocked` report to the parent instead. Commit `03daea3`.
  Channel isolation (session-scoped rather than repo-global human-console queue) is noted
  as a follow-up but NOT implemented: it changes operator visibility and needs a decision.
- **Operator action (outside the repo):** auto-compaction is now disabled in
  `~/.pi/agent/settings.json` — both pi core (`"compaction": { "enabled": false }`) and the
  kit threshold extension (`trigger-compact` removed from the package extension list).
  Backup: `~/.pi/agent/settings.json.bak-<timestamp>`.
