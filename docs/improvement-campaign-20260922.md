# Improvement campaign — 2026-09-22

Branch: `improvement/campaign-20260922` (local only, not pushed).
Base: `monorepo` @ `334726b`.

This campaign ran a plan → review → implement → validate loop against the pi-system
kit, aiming at reliability and correctness of existing extensions. It also had to
absorb two live incidents that occurred *during* the campaign: a pi crash and a
subagent-prompt corruption that flooded every interactive session in the repo.

## 1. Method

1. Six read-only `scout` subagents swept the extension surface (subagent, recovery/
   conductor, orchestrator/verify-gate, security layer, context/compaction, install/
   verify tooling). Findings were consolidated in
   `docs/improvement-campaign-20260922-findings.md` (~83 findings).
2. A `planner` subagent turned the findings into a prioritised work-unit table with a
   named verification command per unit: `docs/improvement-campaign-20260922-plan.md`
   (WU-1 … WU-13).
3. Work units were implemented, checked, and committed on the campaign branch.
4. Validation: `npm run verify`, `npm run check:all`, `npm run eval`, plus the unit
   smokes named in the plan.

Subagent dispatch was unreliable in this environment (see §6), so several units were
implemented and verified directly in the main session. That is a deviation from the
"implementer then independent reviewer subagent" intent and is called out honestly in
§5.

## 2. Live incidents fixed

### 2.1 pi crashed — `human-console` unguarded `unlinkSync` (WU-14)

`packages/extensions/src/human-console/index.ts` `processOne` awaited the UI confirm
and then called `fs.unlinkSync(file)` with no guard, and was invoked as
`void processOne(ctx, file)` with no rejection handler. When a second resolver
(another watcher, operator cleanup, or the requester's own timeout) removed the
pending file first, the `unlinkSync` threw `ENOENT` as an unhandled rejection and
terminated pi.

Fixed in `962f720`: guard the unlink, `.catch()` the `processOne` call, best-effort
remove the requester's own pending file in `brokerRequest`. Regression case added to
`tests/human-console-broker-smoke.mjs`.

### 2.2 Child received the wrong prompt — compiled-binary host (WU-15)

Observed: subagent children were launched with
`node_modules/@earendil-works/pi-coding-agent/dist/cli.js` as their *first user
message* instead of the delegated task, so they had no instructions and asked the
operator what to do.

Root cause: `child-process.ts` did `spawn(process.execPath, [cli, ...args])`
unconditionally. When pi runs as a standalone compiled binary, `process.execPath` **is**
pi, so this invoked `pi <cli.js> --mode json …` and pi parsed the `cli.js` path as the
first positional prompt. A `node cli.js …` reproduction could not reproduce it, which
is why it survived earlier review.

Fixed in `65209ea`: `piChildArgv()` prepends the script only when `execPath`'s basename
is a known JS runtime (`node`/`nodejs`/`bun`/`deno`); a compiled host gets the bare
args. Regression covers compiled, node, bun, and `node.exe` hosts. The same pattern was
applied to the conductor specialist spawn in `a7ae54d`.

### 2.3 One child's question was broadcast to every session (WU-16)

Every project agent was instructed to `ask_human` when blocked. A headless child's
request is written to the repo-global `.pi/human-console/` queue, which every
interactive pi session on the repo polls — so one confused child disrupted unrelated
sessions. Fixed in `03daea3`: agent definitions (`.pi/agents/*` + `packages/kit/
agents/*`) forbid `ask_human` and require a `## Blocked` report to the parent instead.
Channel isolation (a session-scoped queue) is a follow-up, not implemented — it changes
operator visibility and needs a decision.

### 2.4 Operator action (outside the repo)

Auto-compaction was disabled in `~/.pi/agent/settings.json`: pi core
(`"compaction": { "enabled": false }`) and the kit threshold extension (`trigger-compact`
removed from the package extension list). Backup kept at
`~/.pi/agent/settings.json.bak-<timestamp>`. Note the kit's `trigger-compact` has no
off-switch of its own; disabling it also removes the `/compact-threshold` and
`/trigger-compact` commands (core `/compact` is unaffected).

## 3. Work units landed

| WU | Change | Commit | Verification |
| ---- | -------- | -------- | -------------- |
| WU-14 | human-console crash guard | `962f720` | `smoke:human-console-broker` |
| WU-16 | agents stop calling `ask_human` | `03daea3` | n/a (prompt contract) |
| WU-15 | prompt-integrity regression | `3534c84` | `smoke:subagent-containment` |
| WU-15b | compiled-host argv + WU-11 progress-guard | `65209ea`* | `smoke:subagent-containment`, `smoke:progress-guard` |
| WU-1 | secret-guard scans `edits[].newText` | `2cc8463` | `npm run test:security` |
| WU-3 | `wall-clock` is a limit, never auto-retried | `c9d4722` | `smoke:subagent-containment` |
| WU-11 | escalation marker once per episode + `at` TTL | `65209ea`*, `ab922ba`* | `smoke:progress-guard` |
| WU-4 | conductor specialist stream cap / idle / wall-clock | `a7ae54d` | `smoke:conductor-specialist-bounds` |
| WU-12 | run the new smoke in `check:all` (bounds half) | `55314c3` | `check-all.mjs --list` |
| WU-2 | protect control/audit paths; env augments defaults | `dbfcc2a` | `smoke:protected-paths` |
| WU-6 | verify-gate board lock + `PI_KIT_VERIFY_CMD` | `cdfb160`* | `smoke:verify-failclosed` |
| WU-13 | GitHub CI runs `check:all` instead of a hardcoded smoke subset | `0c930f4` | `npm run check:all` |

`*` These commits were created by an **external `auto-commit-on-exit` from another
session** sharing this working tree, so the message is not the intended scoped one and
the commit content is broader than the work unit. The code is correct and verified; the
history is just not as clean as intended. `cdfb160` in particular contains a large
rewrite of `verify-gate/index.ts` produced by the crashed run; it passes
`smoke:verify-failclosed` but was not produced as a minimal diff and would benefit from
review.

Work units that were already satisfied on the base (notably WU-6's lock and command
resolution) were not re-implemented.

## 4. Deferred (planned, not done)

These units were planned but are **not implemented or verified** in this campaign:

- **WU-5** context-sieve snapshot suppression made load-order independent (no epoch in
  the source).
- **WU-7** definition-of-done requires an independent/trusted verdict source. — **Implemented
  after the campaign in cycle `perpetual-20260924/03` (commit `31fb368`): all recorded sources
  must pass and at least one trusted source (`verify`, `review`, `validator:*`) must be present
  and passing, enforced in `verifier-board`, `orchestrator` and `conductor`.**
- **WU-8** trigger-compact env threshold bound to the context window.
- **WU-9** verify.mjs/docs/schema tightening (hooks drift, recursive `.ts` scan,
  freshness gate, `nodeBuiltins` cross-check, `provenance` required).
- **WU-10** recovery-orchestrator input validation and persisted attempt cap.

## 5. Validation and honesty about independence

Run at the tip of the branch, all passing:

- `npm run verify` — OK.
- `npm run check:all` — **all 60 checks passed** (40.8s).
- `npm run eval` — **16/16 fixtures passed**.
- Focused: `smoke:human-console-broker`, `smoke:subagent-containment`,
  `smoke:progress-guard`, `smoke:conductor-specialist-bounds`,
  `smoke:protected-paths`, `smoke:verify-failclosed`, `npm run test:security`.

Raw output captured at the branch tip:

```
$ npm run check:all
check-all: all 60 check run(s) passed in 40.8s

$ npm run eval
[eval] 16/16 fixtures passed.

$ npm run verify
[verify] All checks passed.

$ npm run smoke:protected-paths
  OK: control/audit surfaces are protected by default and env only augments
[protected-paths-smoke] all 3 checks passed

$ node tests/conductor-specialist-bounds-smoke.mjs
[conductor-specialist-bounds-smoke] OK
```

Limitations, stated plainly:

- **No independent reviewer subagent completed.** Repeated dispatches returned
  "No result provided" or ended `failed (toolUse)`; the harness is not dependable in
  this environment. Validation was therefore performed in the main session with
  independent commands and falsification attempts, which is weaker than a fresh
  reviewer who saw only the diff.
- Falsification performed for the two changes originally produced by children:
  `autonomous-loop` writes the armed marker's `at` field (so treating a missing `at` as
  expired does not disable auto mode); and `piChildArgv` was exercised for compiled,
  `node`, `bun`, and `node.exe` hosts.
- The conductor-bounds test fails without a keepalive only because the fake child does
  not hold the event loop open; real spawned children are ref'd, so production is
  unaffected. This is noted in the test.
- `check:all` and `eval` passing is necessary, not sufficient: the verify-gate rewrite in
  `cdfb160` and the `ab922ba` test were reviewed by reading, not by a second party.

## 6. Environment issues encountered

- **Run-id collision:** subagent ids are `<ISO-ms>-<agent>`; two runs dispatched in the
  same millisecond shared one id and one log file, masking a failed run. Documented in
  `docs/improvement-campaign-20260922-notes.md`.
- **Subagent dispatch unreliable:** many dispatches returned no result or `failed
  (toolUse)`; see §5.
- **Shared working tree:** another interactive session is active in the same repo on
  branch `feature/web-console`. It switched branches, discarded a `HANDOFF.md` edit on
  checkout conflict, and ran `auto-commit-on-exit` that committed this campaign's
  in-progress tree under `[pi] …` messages. `ca8f422` on this branch also entangles that
  session's web-console work with the campaign docs. Nothing was lost, but the branch
  history is mixed.
- **Pi-lens degraded mode** (missing `typescript`/`minimatch`/`typebox` in
  `~/.pi/agent/npm/node_modules/pi-lens`) produced repeated noise in child output.

## 7. Defence-in-depth shipped

- secret-guard now scans the live `edit` payload (`edits[].newText`), closing a hole
  where a private key written via `edit` was not detected.
- protected-paths protects the control/audit surfaces by default
  (`.pi/auto-mode.json`, `.pi/verdicts.json`, `.pi/trace.jsonl`,
  `.pi/tool-firewall-audit.jsonl`, `.pi/ctx-contributions/`, `.pi/agents/`,
  `.pi/engagement/`, `packages/core/policies/`, the firewall default policy), and
  `PI_KIT_PROTECTED_PATHS` can only add to the defaults.
- conductor specialist children are now bounded by a stream cap, an idle watchdog, and
  a wall-clock ceiling, with SIGTERM→SIGKILL escalation and honest `{ok:false}` results.
- subagent wall-clock kills are classified as a limit and are never auto-retried.

## 8. Recommended next steps

1. Complete WU-5, WU-8, WU-9, WU-10.
2. Review the `verify-gate` rewrite (`cdfb160`) as a normal change, not as campaign work.
3. Decide the human-console channel model: keep the shared queue with a single dedicated
   console, or scope requests per session.
4. Fix the subagent harness before trusting it for verification: run-id uniqueness,
   dispatch reliability, and the exact shape of the child prompt.
