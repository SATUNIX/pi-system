# Conductor Phase 6 — Governed Active Dispatch via the MCP Gateway

> **Status:** Proposal — awaiting sign-off. Not yet implemented.
> **2026-09-07 decision:** deferred past V1. V1 ships on the existing native
> HITL path instead — `tool-firewall`'s `ask` decision and
> `pentest-governance-domain`'s target-scope confirm, both real
> `ctx.ui.confirm()` prompts to an attached operator terminal, both fail
> closed with no UI attached. This document's gateway design is revisited
> only if field use of V1 surfaces a real need for out-of-band/unattended
> approval.
> **Type:** Design addendum to [`root-orchestrator-conductor.md`](root-orchestrator-conductor.md)
> §9 Phase 6 / §11 Open Question O-1.
> **Sits above:** `pentest-governance-domain` (the local, deterministic scope/ROE gate) and
> `pi-system-mcp-gateway` (the central MCP mediation point, currently unbuilt/undeployed).
> **Governed by:** the same non-negotiable invariants as the parent document, §7 — most
> directly invariant 5: *"Non-interactive active target actions already fail closed in
> pentest-governance-domain — the Conductor must design around that, not try to defeat it."*
> This document is the design-around, not a defeat: it replaces a hard local block with a
> **real, out-of-band human decision**, never a fabricated or silent approval.

---

## 1. Problem statement (recap of O-1)

A synthesised specialist dispatched by `conductor` runs as an isolated
`pi --mode json --no-session` child (see `root-orchestrator-conductor.md` Phase 4). It has no
interactive UI. `pentest-governance-domain`'s tool-call gate (`packages/extensions/src/pentest-governance-domain/index.ts`,
~line 696-705) already handles this correctly and safely: an action that requires target-scope
approval and finds `!ctx.hasUI || !ctx.ui?.confirm` is blocked outright, reason
`approval_required_without_ui`. This is *correct, not a bug* — it is exactly what "fail closed"
means. Today it means: **any fully unattended engagement (no human anywhere in the loop, not
even at the root session) cannot perform active target actions at all.** Read-only recon,
coding, and reporting still work fully autonomously.

Phase 6 asks: can a *real* human, reachable out-of-band (not through pi's own UI), still approve
that one action — audited, scoped, and safe to fail-closed on any doubt? `pi-system-mcp-gateway`'s
`human-approval-plugin` already exists for exactly this. This document is the concrete design for
plugging it in, not a general architecture rewrite.

## 2. Grounded current state (verified 2026-08-31, not assumed)

- **`packages/extensions/src/mcp-router`** is a complete no-op stub: `session_start` notifies "loaded (stub)",
  `tool_call` returns `undefined`. It does not forward, inspect, or route anything today.
- **`pi-system-mcp-gateway`** has never been committed (`git log` on that repo returns
  "does not have any commits yet") or deployed. Its own `README.md`/`capability/docs/RUNBOOK.md`
  document local validation steps (`scripts/check_capability_contract.sh`,
  `capability/tests/validate-compose.sh`, `capability/tests/smoke.sh`) with no evidence they have
  ever been run successfully.
- **The human-approval plugin's core mechanics are real and already sound**
  (`plugins/human-approval/human_approval_plugin/plugin.py`): `tool_pre_invoke` genuinely blocks
  the calling MCP client — it polls a shared SQLite store (`ApprovalStore`) once a second up to a
  configurable timeout (default 300s), and **defaults to `deny` on timeout**, not approve. This is
  the correct fail-closed default and needs no design change.
- **The operator-facing decision API has no auth at all today**
  (`plugins/human-approval/human_approval_plugin/operator_api.py`, its own docstring: *"No auth
  yet... Add operator auth (map to a gateway operator identity/role) before exposing beyond
  localhost/SSH-tunnel access."*). It is loopback-bound by compose default, which is a real
  boundary but not sufficient on its own for something that can authorize live exploitation —
  anyone who reaches that loopback port (any process on the host, or through an SSH tunnel, or a
  future misconfiguration that widens the bind address) can `POST /approve/<request_id>` with no
  identity check whatsoever.
- **`rbac/operators.yaml` and `rbac/agents.yaml` already declare the identity model** this repo
  intends to use: operators have an `email`, a `role` (`global-admin` / `team-admin`), and
  `manages_teams`; agents have a `name`, `team`, and `scoped_servers` allow-list. Neither file is
  wired to the human-approval plugin yet — `scripts/bootstrap_rbac.py` only reconciles them into
  the gateway's own admin API (RBAC over which tools an agent can see), not into
  `operator_api.py`'s decision endpoints.
- **`pentest-governance-domain`'s gate is binary** — `ctx.hasUI` present or not. It has no concept
  today of "this call is being routed through a trusted external mediator that will itself hold
  for a real human decision." Adding that concept, narrowly and auditable, is the core of this
  design.

## 3. Decision made (per user sign-off, 2026-08-31)

Two calls were made before this document was written further, so implementation can proceed
without re-litigating them:

1. **The operator-API auth gap is a Phase 6 prerequisite, not a deferred item.** No pi-kit code
   may be written that trusts a gateway approval decision until the gateway's decision endpoints
   require real operator authentication. Loopback-only binding remains defense-in-depth *underneath*
   real auth, not a substitute for it.
2. **This document (Phase 0 for Phase 6) comes before any implementation phase.** Matches this
   repo's own established pattern (see the parent proposal's own Phase 0).

## 4. Design

### 4a. Operator-API authentication (closes the prerequisite)

Extend the existing declarative RBAC model rather than inventing a new identity system:

- Each operator in `rbac/operators.yaml` gets a bearer token, generated and stored the same way
  `rbac/agents.yaml` already implies per-agent tokens are provisioned (via
  `scripts/bootstrap_rbac.py` — extend it to also provision/rotate operator tokens, not just agent
  ones; the mechanism doesn't exist yet and needs to be built, not just documented).
- `operator_api.py` gains a FastAPI auth dependency: every `/approve/{id}` and `/deny/{id}` call
  must present a valid operator bearer token. `/pending` and `/recent` (read-only) may allow the
  same auth or stay read-only-loopback — read access leaking scheduling info is a much smaller
  risk than write access to a live approve/deny decision; err toward requiring auth on both for
  consistency unless that meaningfully complicates the operator's own polling workflow.
- **Team scoping is enforced server-side, not just documented.** A `team-admin` operator's token
  may only decide a request whose `agent_id` maps (via `rbac/agents.yaml`'s `team` field) to one of
  that operator's `manages_teams`. A `global-admin` token may decide anything. This means
  `ApprovalStore`'s pending-request records need an `agent_id` → `team` lookup at decision time
  (the plugin already records `agent_id` on `create_pending`, so the lookup is additive, not a
  schema break).
- Loopback bind stays as-is underneath this — defense-in-depth, not the only control.
- **DoD:** a request from an operator token outside the request's team is rejected 403, not
  silently accepted; a request with no/invalid token is rejected 401; existing approve/deny
  behavior for a correctly-scoped operator is unchanged; a real (not mocked) end-to-end test
  exercises all three cases against the actual FastAPI app.

### 4b. `mcp-router` — from stub to real transport

`mcp-router`'s `tool_call` hook currently returns `undefined` for everything (i.e., defers to
normal handling / does nothing). It needs to become the thing that actually dispatches a call
routed to an external MCP tool server *through* the gateway rather than directly:

- Reads `PI_KIT_MCP_GATEWAY_URL` and a per-agent token (env var, name TBD at implementation time —
  follow the existing `PI_KIT_*` env-var convention used elsewhere in the kit) when both are set;
  when either is absent, `mcp-router` stays a no-op exactly as today (existing direct-MCP-server
  configuration in `overlays/pi/mcp.json` is unaffected — this is additive, not a breaking change
  to any current deployment).
- Enforces `scoped_servers`/`tools_denylist` **client-side too**, not just trusting the gateway's
  own RBAC — matches this kit's established "defense-in-depth, never trust a single layer" pattern
  (the same posture `tool-firewall`/`secret-guard` already take relative to
  `pentest-governance-domain`).
- **DoD:** a `packages/core/verify.mjs`-checkable contract (mirroring how other extensions are verified) that
  `mcp-router` never silently drops an error from the gateway as a successful no-op; a smoke test
  using a fake local HTTP server standing in for the gateway (this repo's established
  eval-fixture convention — see `smoke:conductor-validator`'s injected fake child runner for
  precedent) proving both the allow and scoped-deny paths.

### 4c. `pentest-governance-domain` — the actual gate-composition change

This is the one invariant-adjacent change, so it gets the most scrutiny. Current logic
(~line 696-705): if target-scope approval is required and there's no UI, block. New logic:

1. Scope/ROE check (§7 invariant 1) runs **exactly as today, first, unchanged** — deny-overrides-allow,
   unknown-is-out. A gateway-routed call gets **zero** additional scope leeway; if local scope/ROE
   would deny it, it is denied before the gateway is ever consulted. This is the literal meaning
   of "design around, don't defeat."
2. Only if scope/ROE already says the target/method is in-scope, **and** the call is a real MCP
   tool call being sent through a configured, trusted `mcp-router` (valid gateway URL + a
   provisioned per-agent token — not a bare guess or an unauthenticated pass), does the local gate
   change behavior: instead of hard-blocking on `!ctx.hasUI`, it lets the call proceed to the
   gateway and **synchronously awaits the gateway's own response** (the human-approval plugin
   genuinely blocks server-side, confirmed in §2 above — so this is a real wait for a real
   decision, not a fire-and-forget).
3. The gateway's response is authoritative for *that one call*: approved → proceed; denied or
   timed-out → blocked, same as today's `operator_denied`/`approval_required_without_ui` reasons,
   both audited.
4. If `mcp-router` is not configured (no gateway URL/token), behavior is **byte-identical to
   today** — the existing hard fail-closed path is completely untouched for every deployment that
   doesn't opt into the gateway. This is an additive capability, not a relaxation of the default.
5. Every step — the local scope/ROE pass, the gateway hand-off, and the gateway's decision —
   lands in the existing `audit.jsonl` chain (§7 invariant 7), with a shared `action_hash`/
   `request_id` so a human reviewing pi-kit's local audit trail can find the matching gateway-side
   `approvals.db` record and vice versa (§4a's auth work already threads `agent_id` through the
   same store, so this is the same correlation key, not a new one).
- **DoD:** an eval fixture proving (a) an out-of-scope target is still denied even when a gateway
  is configured — the gateway is never even reached; (b) an in-scope target with no gateway
  configured hard-blocks exactly as today; (c) an in-scope target with a gateway configured and an
  operator approving via the (now-authenticated) operator API actually proceeds; (d) the same with
  an operator denying, or a timeout, actually blocks. All four are real, not mocked at the
  boundary being tested.

### 4d. Interaction with Conductor's dispatch budget (Phase 4)

A specialist's `dispatch_specialist` reservation (bounded recursion + budget caps, already shipped)
stays **consumed for the entire pending-approval window**, including the up-to-5-minute wait. No
new "paused, doesn't count" state. Rationale: budget exhaustion just means no further dispatches
are possible — a safe, recoverable failure mode, not a security hole — so there is no reason to add
complexity carving out an exception for this one case. If this proves to matter in practice
(budget exhausted by legitimately-pending approvals rather than runaway recursion), revisit with
real evidence from a live run, not speculatively now.

### 4e. Crash / cancellation handling

No new cancellation API for v1. If the specialist child that requested approval crashes or is
killed while a request is pending, the gateway's existing timeout-to-deny (§2, confirmed real) is
the safety net — nothing can be approved into a void with no requester left to receive it, because
even a stale pending request eventually times out to `deny`. Accepted as sufficient for v1; a
future phase could add active cancellation if operator experience shows stale pending requests are
a real UX annoyance, not a safety gap.

## 5. Phased delivery

Same bar as every other phase in this project: `npm run verify` / `npm run test:security` (+
`npm run eval` where behavior changes) green before "done"; commit messages carry
finding/root-cause/fix/verification.

- **Phase 6a — gateway operator-API auth + first real deploy.** §4a. First real commit to
  `pi-system-mcp-gateway` (it currently has none). Local validation
  (`scripts/check_capability_contract.sh`, `capability/tests/validate-compose.sh`,
  `capability/tests/smoke.sh`) actually run and passing, not just present.
- **Phase 6b — `mcp-router` real transport.** §4b, in `pi-system`.
- **Phase 6c — `pentest-governance-domain` gateway-composition gate.** §4c, in
  `pi-system`. Depends on 6a (needs real auth to test against) and 6b (needs the real
  transport to route through).
- **Phase 6d — `engagement` profile/docs wiring.** Extend `engagement.example.json` and
  `docs/agent-orchestration.md` to document the opt-in gateway path; update O-1's status in the
  parent proposal from "open" to "resolved, opt-in."

## 6. Explicitly out of scope for Phase 6

- Replacing `pentest-governance-domain`'s local gate for *interactive* sessions — the root
  Conductor session with a real UI keeps using `ctx.ui.confirm` exactly as today; the gateway path
  is additive, for the non-interactive case only.
- Any change to `tool-firewall`/`secret-guard` — unrelated safety boundaries, untouched.
- Building out the full RBAC bootstrap tooling beyond what §4a needs (e.g., a UI for managing
  `rbac/operators.yaml`) — declarative YAML + `bootstrap_rbac.py` stays the workflow.
- mTLS or a heavier auth scheme than bearer tokens — revisit only if the bearer-token model proves
  insufficient in practice.
