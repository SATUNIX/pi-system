# Auto Mode + Human Console — tiered tool approval with an LLM guardrail and out-of-band human escalation

> **Status:** Implemented 2026-09-15. No design decisions changed during
> implementation; the cited gate line numbers were navigation references and had
> moved in the live source.
> **Type:** New capability. Extends `tool-firewall`'s existing `allow`/`ask`/`deny`
> model and `pentest-governance-domain`'s scope/ROE confirm gate. Does not touch
> `pi-system-mcp-gateway` — this replaces the need to revive
> [`conductor-phase6-gateway-approval.md`](conductor-phase6-gateway-approval.md)
> for v1 with a self-contained, in-repo mechanism instead.
> **Sits alongside:** `packages/extensions/src/tool-firewall` (deterministic policy engine),
> `packages/extensions/src/pentest-governance-domain` (scope/ROE gate), `packages/extensions/src/subagent`
> (spawns isolated `pi --mode json -p --no-session` child processes with no UI).

## 1. Problem statement

Today, `tool-firewall`'s policy has three tiers (`allow` / `ask` / `deny`), but
`ask` only has one real resolution path: `ctx.ui.confirm()` to an attached
operator terminal. When there is no UI — which is **always** true inside a
subagent, since `packages/extensions/src/subagent` spawns a fully separate `pi --mode json
-p --no-session` process — `ask` fails closed to `deny` outright
(`packages/extensions/src/tool-firewall/index.ts:344-348`). `pentest-governance-domain` has
the identical shape of gate for its own scope/ROE confirm
(`packages/extensions/src/pentest-governance-domain/index.ts:702-705`).

This is correct and deliberate (see `conductor-phase6-gateway-approval.md` §1)
but it means: any tool not already on the static allow-list is simply
unusable from a subagent, and even in an attended session every `ask`-tier
call interrupts the human, with no tier in between "explicitly pre-approved"
and "always ask a human right now."

The operator wants a third tier: an automated reasoning check (an "auto mode"
judge — a separate model call, not the agent's own self-report) that can
approve or deny an `ask`-tier call by checking the agent's stated reasoning
and the tool call against the task/goal, escalating to a human only when the
judge itself denies, is unavailable, or times out. This must work identically
whether the caller is the interactive root session or an unattended subagent,
without requiring the subagent to have a UI, and without requiring
`pi-system-mcp-gateway` (which would need new operator-API auth built
first — out of scope here, per the deferred Phase 6 doc).

The operator also wants agents to be able to ask a human a direct clarifying
question mid-task ("`ask_human`"), and for both of these fail paths — auto
mode escalation, and `ask_human` — to work the same way from a subagent as
from the root session.

## 2. Decisions made (operator sign-off, 2026-09-15)

1. **Human escalation from a subagent uses a local, file-based queue**, not
   `pi-system-mcp-gateway`. A new self-contained extension,
   `human-console`, watches `.pi/human-console/pending/*.json` whenever it has
   a UI (i.e. it is running in the attended root session) and resolves each
   request via `ctx.ui`, writing `.pi/human-console/resolved/<id>.json`. Any
   process without a UI (a subagent) writes the pending request and polls for
   the resolution, timing out to a safe default (deny for approvals, "no
   answer" for questions) if no attended session is watching. No new network
   service, no new auth surface — trust boundary is the local filesystem,
   consistent with this being a single-operator local tool today.
2. **`pentest-governance-domain`'s scope/ROE confirm gate is included.** It
   gets the same broker escalation for its `!ctx.hasUI` case (its deterministic
   scope/ROE check is completely unchanged and still runs first — the broker
   only replaces the immediate hard-block after that check has already said
   "this needs a human sign-off"). No LLM judge is involved in this gate — the
   scope/ROE decision is already deterministic; the confirm step is a pure
   human sign-off on an in-scope-but-sensitive action, exactly as today, just
   reachable out-of-band now.
3. **The auto-mode judge defaults to a strong, configurable model**, not a
   cheap local one, following the `DUAL_REVIEW_MODEL` precedent
   (`packages/extensions/src/dual-review/index.ts:7`). Env var `PI_KIT_AUTO_MODE_MODEL`;
   falls back to the session's active model if unset.

## 3. Non-goals

- No change to `tools[name].decision: "deny"` or `command_rules.deny` — a hard
  deny is never seen by the judge or the broker. It blocks immediately, as
  today. Auto mode can only ever soften an `ask`, never override a `deny`.
- No change to any `allow`-tier tool. Auto mode only engages for the `ask`
  tier (named-tool `ask` rules, `defaults.unknown: "ask"`, and
  `command_rules.ask` matches).
- No change to `mcp-router` or `pi-system-mcp-gateway`. Phase 6 stays
  deferred.
- Agents (root or subagent) are **never told an LLM judge exists.** From
  their perspective, an `ask`-tier tool call just "goes through an approval
  step" that may take a little time, exactly like today's `ctx.ui.confirm`
  from their perspective. This is a hard requirement, not a wording
  preference — see §7.

## 4. Architecture

### 4a. `human-console` (new extension)

Self-contained (`node:*` + `typebox` only, per `docs/WRITING_EXTENSIONS.md`
rule 1 — no importing `tool-firewall` or `pentest-governance-domain` code;
those two coordinate with it purely through the shared on-disk request/response
contract below, the same way `tool-firewall` and `secret-guard` already only
share an audit-log *format*, never code).

**On-disk contract** (`PI_KIT_HUMAN_CONSOLE_DIR`, default `.pi/human-console/`):

```
.pi/human-console/
  pending/<id>.json   # written by the requester
  resolved/<id>.json  # written by the watcher, once decided
```

`pending/<id>.json`:
```jsonc
{
  "id": "uuid",
  "kind": "approval" | "question",
  "createdAt": "iso8601",
  "requester": { "pid": 1234, "sessionId": "...", "agent": "scout" }, // agent name if a subagent role is known, else "root"
  // kind: "approval"
  "toolName": "bash", "input": { "...": "..." }, "riskClass": "shell",
  "reason": "sudo", "title": "Approve tool call?", "body": "...",
  "autoModeRationale": "..." | null, // present only if auto mode's judge already denied and this is an escalation
  // kind: "question"
  "question": "...", "options": ["..."] | null, "context": "..." | null,
  "timeoutMs": 900000
}
```

`resolved/<id>.json`:
```jsonc
{ "id": "uuid", "decidedAt": "iso8601", "approved": true, "answer": "..." | null, "note": "..." | null }
```

**Watcher** (`session_start`, only when `ctx.hasUI`): polls `pending/` every
1s (matches the precedent already established and confirmed real in
`pi-system-mcp-gateway`'s human-approval plugin — "polls a shared
store once a second," per `conductor-phase6-gateway-approval.md` §2 — Windows
`fs.watch` is unreliable enough on network/some local filesystems that
polling is the safer default here too). For each new pending file: if
`kind: "approval"`, `ctx.ui.confirm(title, body)`; if `kind: "question"`,
`ctx.ui.select` when `options` is present (append a `"Other (type an
answer)"` choice that falls through to `ctx.ui.input`) else `ctx.ui.input`.
Writes the resolution, deletes the pending file (avoid re-processing on
restart). If the extension is reloaded or the session ends with pending
requests still unresolved, they simply wait for the next attended watcher —
no special cleanup required, the requester's own timeout is the safety net.

**Requester-side helper** (duplicated inline in every extension that needs to
escalate — `tool-firewall`, `pentest-governance-domain`, and `human-console`
itself for its own `ask_human` tool execute path): write the pending file,
then poll for the matching `resolved/<id>.json` at the same 1s cadence up to
`timeoutMs`, honoring the tool's `AbortSignal` so an aborted turn doesn't leave
an orphaned poll loop. On timeout: approvals resolve to **deny** (fail closed,
matching every other timeout default in this repo); questions resolve to a
clear "no human answered in time" result, not a fabricated answer.

**`ask_human` tool** (registered by `human-console`):
```
ask_human({ question: string, options?: string[], context?: string, timeoutMs?: number })
```
If `ctx.hasUI`: resolve directly via `ctx.ui.select`/`ctx.ui.input`, no
broker round-trip needed. If not: go through the broker exactly as above.
Add `ask_human` to `default-policy.json` as `{ "decision": "allow" }` —
asking a question must never itself require approval, or it deadlocks.

### 4b. `tool-firewall` — auto mode

Extends the existing `ask` branch (`packages/extensions/src/tool-firewall/index.ts:343+`).
New state, read the same way the policy file already is (env var first, then
a project file, cached with mtime like `getPolicy()`):

- Toggle: `.pi/auto-mode.json` (`{"enabled": true}`), env override
  `PI_KIT_AUTO_MODE=1|0`. **Default: disabled** — this is an opt-in mode, like
  Claude Code's, not a silent default.
- New command `/auto-mode [on|off|status]`, mirroring `/firewall:status`.
- Judge model: `PI_KIT_AUTO_MODE_MODEL` env var, falls back to `ctx.model?.id`.

When `decisionFor(...)` resolves to `ask` **and auto mode is enabled**:

1. Build a judge prompt from: the tool name, input, `riskClass`/`reason`; the
   first user message in `ctx.sessionManager.getEntries()` (truncated) as the
   stated task/goal; and the text content of the in-flight assistant message
   that issued this tool call (i.e. whatever reasoning the agent already
   wrote before calling the tool), also truncated. No ROE/scope re-derivation
   here — that stays `pentest-governance-domain`'s deterministic job and runs
   independently; the judge is answering "does this look like a reasonable
   step toward the stated task, with no obvious unintended side effect,"
   nothing more.
2. Spawn the judge exactly like `dual-review`'s `launchReviewer`
   (`spawn(process.execPath, [cli, "--print", prompt, "--no-session",
   "--model", model, "--tools", ""], ...)` — **no tools**, so the judge can
   only reason, never act. Require strict JSON output
   `{"decision":"allow"|"deny","rationale":"..."}`; a ~45s timeout mirroring
   `REVIEW_TIMEOUT_MS`.
3. Judge unavailable, times out, errors, or returns anything that doesn't
   parse to a valid decision → **treat as "ask" continues to the human path
   below**, exactly as if auto mode were off for this one call. Never
   silently allow on judge failure.
4. Judge returns `allow` → allow, log `auto_mode_approved` with the
   rationale.
5. Judge returns `deny` → do **not** block outright. Escalate to the human
   path below, attaching the judge's rationale to the prompt/pending request
   so the human sees *why* it was flagged. Log `auto_mode_denied_escalated`.

**Human path** (used when auto mode is off, or the judge denied/failed):
same as today if `ctx.hasUI` (`ctx.ui.confirm`); otherwise use the
`human-console` broker contract from §4a instead of the current hard
`{ block: true, reason: "...no interactive UI... fail closed" }`. Timeout
still fails closed to deny — this is strictly an *additional* path to a real
decision, never a relaxation of the existing fail-closed default.

### 4c. `pentest-governance-domain` — broker-backed confirm

Only change: at `index.ts:702-705`, when `!ctx.hasUI || !ctx.ui?.confirm`,
escalate via the same `human-console` broker contract (write the existing
`actionCard(...)` output as the pending request's `body`) instead of
returning `{ block: true, reason: "approval_required_without_ui" }`
immediately. Everything before that line (the scope/ROE deterministic check)
is untouched. Timeout still blocks, same reason string, now also logging
`human_console_timeout` in `audit.jsonl` for traceability.

## 5. Audit logging

Both `tool-firewall` and `pentest-governance-domain` already append to
`.pi/tool-firewall-audit.jsonl` (or their own audit sink — verify exact
target file per extension when implementing; do not introduce a second audit
file). Add event types: `auto_mode_check_start`, `auto_mode_approved`,
`auto_mode_denied_escalated`, `auto_mode_judge_unavailable`,
`human_console_pending`, `human_console_resolved`, `human_console_timeout`.
`human-console` logs its own `ask_human_pending` / `ask_human_resolved` /
`ask_human_timeout` to its own extension-local audit file
(`.pi/human-console-audit.jsonl`) since it cannot import `tool-firewall`'s
audit helper (self-containment) and has no reason to share the file.

## 6. Subagent propagation (how this actually reaches a subagent)

`packages/extensions/src/subagent` spawns `pi --mode json -p --no-session` in the same
`cwd`. Because pi-kit's extensions are discovered via the package's own
`pi.extensions` glob (`package.json`), not just `.pi/extensions/`, every
subagent process loads `tool-firewall`, `pentest-governance-domain`, and
`human-console` exactly as the root session does — this already happens
today for the existing `allow`/`deny` tiers and requires no new wiring. What
is new is only that the `ask` tier, inside that subagent process, now has a
real resolution path (§4a/§4b) instead of an automatic fail-closed deny. The
auto-mode toggle and judge-model env vars are read from the same
project-relative file/env, so a subagent picks up the root session's current
auto-mode state automatically — there is no separate "subagent auto mode"
concept to configure.

A subagent calling `ask_human` lands in the same `.pi/human-console/pending/`
queue as a root-session escalation, tagged with `requester.agent` (the
subagent's role name, from the `subagent` tool's own `AgentConfig`, if
available — best-effort, not a hard requirement). The attended root session's
`human-console` watcher answers it exactly like any other pending request.
There is no protocol where the question routes "through" the main agent's own
turn — the main agent is not necessarily even idle while a parallel subagent
is asking something. The human sees it directly, tagged by which agent asked.
This is a deliberate simplification, not an oversight: the alternative
(routing subagent questions through the parent's own conversation) would
require the parent's LLM turn to be paused and resumed mid-stream, which pi's
subagent model does not support today.

## 7. Agent-facing framing (must not mention the judge)

Update, in the language of "an approval step," never "an AI reviews you":

- `AGENTS.md` (or a project `GUIDELINES.md`, surfaced via `packages/extensions/src/guidelines`
  into every session's system-prompt contributions): add a short paragraph —
  tools outside the pre-approved list still work, they go through an approval
  step first (which may take a little time); a denial means adapt the
  approach, not retry through a different tool to route around it; if unsure
  and a scout subagent can't resolve it, call `ask_human` with concrete
  options where possible.
- `packages/extensions/src/pentest-governance-domain/README.md` and any role prompts under
  `node_modules/@earendil-works/pi-coding-agent/examples/extensions/subagent/agents/*.md`-style
  role files this repo ships (check `orchestrator`'s role materialization) —
  same framing, add a one-line mention of `ask_human` for the "genuinely
  blocked, no scout can answer this" case.
- Do not add the words "auto mode", "judge", "classifier", or "LLM review" to
  any agent-visible prompt, skill, or role file. Those terms are fine in
  `docs/`, `README.md`s, `default-policy.json` comments, and this proposal —
  never in text that ends up in an agent's context.

## 8. Definition of done

- `npm run verify` green (schema, self-containment, profile/manifest parity
  for the new `human-console` extension, capability-matrix/catalog
  regeneration via `npm run catalog`).
- `npm run test:security` green, plus a new
  `tests/human-console-broker-smoke.mjs` (or extend
  `tests/tool-firewall-smoke.mjs`) proving, with a fake/mocked judge child
  process (this repo's established fixture convention — see
  `smoke:conductor-validator`'s injected fake child runner precedent):
  - a `deny`-tier tool/command is never sent to the judge or the broker;
  - an `allow`-tier tool never touches auto mode;
  - auto mode off: an `ask`-tier call with no UI escalates to the broker and
    resolves correctly on both approve and timeout-deny;
  - auto mode on, judge allows: call proceeds, no human escalation;
  - auto mode on, judge denies: escalates to the broker with the rationale
    attached;
  - auto mode on, judge times out/errors: escalates to the broker exactly as
    if auto mode were off (never silently allows);
  - `ask_human` resolves via direct UI when attended, via the broker
    round-trip when not, and times out to a clear "no answer" result rather
    than hanging or fabricating a response;
  - `pentest-governance-domain`'s scope/ROE deterministic check still denies
    an out-of-scope target even when the broker would have approved — the
    broker is only reachable after that check already passed.
- `npm run eval` fixture(s) added if any *behavioral* (non-structural) change
  is visible to a live model run (e.g. a new fixture exercising the
  `ask_human` tool end-to-end).
- New extension registered in `packages/kit/profiles/balanced.json` (and any other profile
  that already carries `tool-firewall`/`pentest-governance-domain`) and in
  `packages/core/policies/default.json` (mirror of `default-policy.json`'s new
  `ask_human` allow entry — `verify.mjs` enforces these stay byte-identical).
- Commit message(s) follow this repo's convention: finding/root-cause/fix/
  verification in the body.
- **Do not commit** — leave the working tree ready for the operator's own
  review and commit, per standing instruction for this task.
