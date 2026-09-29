# Root Orchestrator — the "Conductor"

> **Status:** Design of record. Phases 1–5 implemented; promoted 2026-08-27. Originally written 2026-08-14.
> **Type:** Idea document + repo improvement plan.
> **Sits above:** [`docs/agent-orchestration.md`](../agent-orchestration.md) (the current task-level
> `orchestrator`) and [`docs/NORTH_STAR.md`](../NORTH_STAR.md) §5 layer 4 (Orchestration).
> **Composes, does not replace:** `subagent`, `orchestrator`, `pentest-governance-domain`,
> `verifier-board`, `dual-review`, `task-graph`, `goal-core`, `branch-lab`, `memory-local`,
> `skill-forge`, `trace-ledger`, and the `packages/kit/skills/` corpus.
> **Governed by:** North Star First Principle #13 — *general capability lives in the kit; domain
> specifics layer on top via composition, never welded in.* Nothing here is allowed to reimplement or
> weaken a guarantee an existing extension already makes.

This is a note to my future self about a capability I want to build: **one strong, long-lived root
agent — the Conductor — that manages a whole engagement or project end to end by dynamically
synthesising and dispatching scoped specialist subagents, instead of driving a fixed four-role
plan → implement → review chain.** It is optimised for two workloads that dominate my use of this
kit: **offensive-security testing** (web / API / network, A→Z including reporting) and **coding**
(build, then follow up with independent review/improvement). It must be able to do this without ever
loosening the deterministic scope/ROE and safety guarantees the kit already enforces.

---

## Part I — The idea

### 1. What we have vs. what I want

Today's `orchestrator` (`packages/extensions/src/orchestrator/index.ts`) is a **task-level autonomy layer**.
On each input it scores complexity and, above a threshold, drops a context-sieve contribution steering
the main agent into a `planner → implementer → reviewer` flow over the four **static** role files it
materialises into `.pi/agents/` (`planner`, `implementer`, `reviewer`, `scout`). It is excellent at
what it does — but it has three structural limits for the work I actually do:

1. **The roster is fixed and generic.** Four coding-shaped roles. A web-app pentest wants a
   *recon* agent, an *auth/IDOR* agent, an *injection* agent, an *evidence/reporting* agent — each
   preloaded with the right runbook skills and scoped to the right tools. Today I get "implementer."
2. **There is no engagement / project object above the task.** `goal-core` holds a one-line goal;
   `task-graph` holds a DAG. Neither models *"this is engagement X, here is its scope/ROE, here is
   the phase we're in, here are the findings so far, here is what still needs independent validation
   before it goes in the report."* An engagement is a long-lived thing with its own lifecycle; the
   orchestrator is stateless per input.
3. **Validation is not causally independent by construction.** `verifier-board` + `dual-review`
   exist, but nothing guarantees the agent that *judges whether a finding is real and matters* is
   isolated from the reasoning of the agent that *produced* it. For security findings that
   distinction is the whole game (false positives, out-of-scope "findings," severity inflation).

I want to add a layer **above** the orchestrator — not replace it — that closes those three gaps:

> **The Conductor.** A single strong root agent (strong-model tier) that owns the engagement/project
> as a durable object, and that — for each unit of work — *queries the kit's own knowledge base
> (skills + notes/memory) and composes a purpose-built specialist subagent on the fly*, dispatches it
> non-interactively, collects its output as evidence, and routes every claim through a **causally
> independent** validator before it is allowed to count as done or land in a report. Specialists may
> themselves spawn sub-specialists, bounded. One conductor; many disposable, task-shaped experts.

### 2. Design in one picture

```
                 ┌──────────────────────────────────────────────────────┐
   operator ───► │  CONDUCTOR  (root agent, strong-model tier)           │
   (approvals)   │  • owns the engagement object + lifecycle (A→Z)       │
                 │  • agent factory: skills + notes ─► synthesised agent  │
                 │  • dispatches specialists non-interactively           │
                 │  • routes every claim to independent validation       │
                 └───────┬───────────────────────────────┬──────────────┘
        synthesises .pi/agents/<synth>.md at runtime      │ records verdicts
                         │                                 ▼
          ┌──────────────┼───────────────┐        ┌────────────────────┐
          ▼              ▼               ▼         │  verifier-board /  │
   ┌───────────┐  ┌───────────┐   ┌───────────┐   │  independent        │
   │ recon      │  │ authz/IDOR│   │ injection │   │  VALIDATOR agent    │
   │ specialist │  │ specialist│   │ specialist│   │  (fresh context,    │
   └─────┬──────┘  └───────────┘   └───────────┘   │  no finder reasoning)│
         │ may spawn bounded sub-specialists       └────────────────────┘
         ▼
   ┌───────────┐
   │ sub-recon │   ← recursion via subagent agentScope:"both", depth-capped
   └───────────┘

   Every arrow above still passes through, unchanged:
   tool-firewall → pentest-governance-domain (scope/ROE, action cards, MCP-only, chained audit)
```

The Conductor is a **planning / steering / bookkeeping** layer. It writes agent definition files and
context-sieve contributions and reads state files. It is emphatically **not** a new path to touch a
target — every target-touching action a synthesised specialist attempts still goes through
`tool-firewall` and `pentest-governance-domain` exactly as today (see §7).

### 3. Core capabilities

#### 3a. Engagement / project as a durable object (A→Z lifecycle)

A new persisted object — call it the **engagement record** — models the whole job, not just the
current task. It extends, and links to, the existing state files rather than duplicating them:

| Concern | Owner (existing where possible) |
|---|---|
| One-line mission | `goal-core` → `.pi/GOAL.yaml` |
| Authoritative scope / ROE | `engagement/scope.yaml`, `engagement/roe.yaml`, `engagement/tool-policy.json` (already the deterministic authority read by `pentest-governance-domain`) |
| Task DAG | `task-graph` → `.pi/task-graph.json` |
| Definition-of-done verdicts | `verifier-board` → `.pi/verdicts.json` |
| **New:** engagement phase, roster of synthesised agents, findings ledger, validation status, report state | **`conductor`** → `.pi/engagement/engagement.json` (+ `findings/`) |

Lifecycle phases the Conductor drives, each a gate (not just a suggestion):
`intake → authorisation → scoping → recon/planning → execution → evidence → independent validation →
reporting → close-out`. The engagement record is restartable: a fresh Conductor process must be able
to resume the engagement from the working tree + `engagement.json` alone (North Star First Principle
#5). This is the security-domain analogue of the `/pi-improve` `cycle-state.json` pattern already
proven in `docs/agent-improvement/`.

#### 3b. The agent factory — dynamic specialist synthesis from the knowledge base

This is the heart of the proposal and the part that does not exist today. Instead of only the four
static role files, the Conductor **assembles a specialist agent definition at runtime** for a given
scoped sub-job by querying the kit's own two knowledge bases:

- **Skills (procedural knowledge).** The `packages/kit/skills/` corpus is already a curated, trigger-shaped
  library (`api-testing`, `authz-idor-testing`, `endpoint-inventory`, `burp-web-triage`,
  `methodology-mapper`, `finding-writing`, `evidence-review`, `code-security-review`,
  `scope-roe-governance`, …). The factory selects the relevant skills for the job and names them in
  the synthesised agent's prompt so the child loads them via `/skill:<name>`.
- **Notes (semantic memory).** `memory-local` (and, in the self-improving profile, `memory-mem0`)
  already recall relevant memories on non-trivial input. The factory queries them for engagement- and
  target-specific facts (prior findings, quirks of this target, house style) and seeds the specialist
  with that recall.

The output is a `.pi/agents/<synth-name>.md` file with, deterministically assembled from templates:

- a **role brief** for the sub-job (e.g. "authorisation-and-IDOR specialist for `api.acme.test`"),
- the **selected skills** to load,
- a **tool restriction** appropriate to the role (recon/validators read-only; coding specialists get
  edit/write; nobody gets more than the job needs — least privilege by construction),
- a **model tier** via the existing `provider-router` policy convention (strong for planning/review,
  hot-path for mechanical work — the same `hot_path_model`/`strong_model` split the orchestrator
  already reads),
- and — non-negotiable — the **engagement's scope/ROE constraints embedded in the agent's own
  prompt**, so the specialist is *told* its boundary, in addition to that boundary being *enforced*
  deterministically downstream.

Crucial safety property, borrowed directly from `skill-forge`'s design: **synthesis is deterministic
template assembly from the catalogue, never a live model writing arbitrary agent code, and never
auto-trusted beyond what the governance layer independently allows.** The factory chooses *which*
catalogued skills and *which* tool set and *which* scope stanza; it does not free-write executable
behaviour. A synthesised agent that would need out-of-scope tools or targets is refused at synthesis
time (first line of defence; the deterministic gate in §7 is the second).

#### 3c. Causally independent finding / result validation

Every claim a specialist produces — a security finding, or "the feature is implemented and tested" —
is routed to a **validator agent spawned in a fresh, isolated context** that is given only:

- the **raw evidence** (request/response, PoC, diff, test output),
- the **requirement or scope stanza** it is meant to satisfy,

and explicitly **not** the finder's chain of reasoning or its self-assessed severity. The validator
answers three separate questions and records them on the `verifier-board`:

1. **Is it real?** (reproducible from the evidence alone — falsifiability)
2. **Does it matter?** (significance / severity, judged independently)
3. **Does it match the requirement / stay in scope?** (a "finding" on an out-of-scope asset is not a
   finding)

This is the security-and-coding generalisation of the `/pi-improve` falsifiability-and-significance
gate (`docs/agent-improvement/README.md`) and of `dual-review`, wired so independence is
*structural* (separate process, separate context, withheld reasoning), not merely requested. The
Conductor may not advance an engagement phase or write a finding into a report while its validator
verdict is missing or failing — reusing `orchestrator`'s existing `missionCompleteBlocked` fail-closed
pattern.

For coding: this is exactly the "build it, then follow up with a *separate* agent to review/improve
it, and validate with a causally independent agent whether the change is valid and meets the
requirement" loop the kit already gestures at with `orchestrator` + `verifier-board` — the Conductor
just makes the independence and the follow-up first-class and durable.

#### 3d. Bounded recursion

Specialists may spawn their own sub-specialists — the `subagent` tool already supports this
(`agentScope: "both"`, child `pi --mode json --no-session` processes that themselves load the kit).
The Conductor sets and enforces a **depth cap and a fan-out/budget cap** in the engagement record;
recursion is a feature for genuinely decomposable recon, but unbounded fan-out is a real failure mode
(cost blow-up, context thrash, runaway processes) and must be capped by construction, not by hope.

#### 3e. Optimised for both security testing and coding

The same machinery serves both because the kit is already dual-purpose. For a coding project the
"specialists" are scoped implementers/reviewers with domain skills (`code-security-review`,
`patch-hygiene`, `verification-loop`); for a pentest they are recon/exploitation/reporting
specialists with the OffSec skills. The engagement object, the factory, the independent validator, and
the bounded recursion are identical; only the catalogue selection and the governance profile differ.

### 4. Worked example — web-app engagement, A→Z

1. **Intake / authorisation.** Operator points the Conductor at `engagement/scope.yaml` +
   `roe.yaml`. Conductor refuses to start active work if scope/ROE is missing or invalid
   (`scope-roe-governance` skill rule: *missing scope/ROE = stop*), and records the authorisation +
   scope/roe hashes in `engagement.json`.
2. **Recon/planning.** Factory synthesises a read-only `recon` specialist (skills:
   `endpoint-inventory`, `methodology-mapper`; tools: read/grep + the sanctioned recon MCP tools).
   It builds an endpoint inventory as evidence. Heavy discovery may recurse into sub-scouts, depth-1.
3. **Execution.** From the inventory, the Conductor synthesises task-shaped specialists — e.g. an
   `authz-idor` specialist (skill `authz-idor-testing`) and an `api-injection` specialist (skill
   `api-testing`). **Active, target-touching actions still hit the `pentest-governance-domain`
   approval path** — inside testing windows, in-scope host/method, action card to the operator (§7).
4. **Evidence.** Each specialist writes findings to the findings ledger with reproducible evidence
   (`evidence-review` discipline), never self-grading severity as final.
5. **Independent validation.** For each candidate finding the Conductor spawns a fresh validator
   (§3c). Only real + in-scope + significant findings survive to the report.
6. **Reporting.** A `reporting` specialist (skills `finding-writing`, `report-export-review`) drafts
   the report from validated findings only. The Conductor gates report export on all findings having a
   passing validator verdict.
7. **Close-out.** Engagement record marked complete; `trace-ledger` retains the run for later
   `skill-forge` mining (did we discover a reusable runbook?).

### 5. Worked example — coding task with independent follow-up

"Add a caching layer with tests" → Conductor synthesises a `planner` (strong tier) → parallel scoped
`implementer`s in `branch-lab` worktrees (disjoint files) → a **separate** `reviewer` specialist →
an **independent validator** that, given only the diff + the requirement + the test output (not the
implementer's narrative), rules PASS/FAIL on the verifier-board. FAIL loops back to a fresh
implementer with the validator's must-fix list. `missionCompleteBlocked` keeps "done" honest.

### 6. Where it sits (mapping to the North Star)

- **Six-layer architecture (§5):** the Conductor is layer 4 (Orchestration), one level of abstraction
  above the current `orchestrator`. It touches layer 3 (context/memory) to *read* the knowledge base
  and layer 5 (verification) to *drive* independent validation, but it owns neither.
- **Capability ladder:** it is a **T3+/T4** capability. It requires T0–T2 to be solid (it leans
  entirely on the existing guards, verifiers, and memory) and it is where "self-improving specialist"
  (T4) meets "long-horizon agent" (T3) for my actual domain.
- **First Principles:** #8 isolated workers (its whole premise), #6 model never self-certifies
  (independent validator), #10 two-tier routing (factory sets per-agent model tier), #12 specialise
  ruthlessly (dynamic domain specialists), and — hardest — #13 compose, never weld.

### 7. Non-negotiable invariants (safety)

These are the lines the implementation may not cross. They exist because the Conductor is a powerful
autonomy layer sitting over an offensive-security toolchain.

1. **The Conductor never enforces scope/ROE; it never *is* the gate.** `pentest-governance-domain`
   remains the sole deterministic authority at tool-call time. Scope/ROE files are the authority; the
   Conductor's synthesis-time checks are an *additional* early refusal, never a replacement. Deny
   overrides allow; unknown is out; a synthesised agent cannot grant itself a target or tool the
   deterministic gate would deny.
2. **The Conductor never injects a system prompt.** It writes context-sieve *contributions* and
   `.pi/agents` files only — `context-sieve` stays the single injection authority, exactly as the
   current `orchestrator` respects (the self-containment lint enforces this).
3. **Synthesis is deterministic and reviewable.** Template + catalogue assembly, never a live model
   free-writing agent behaviour or tool grants. Modelled on `skill-forge` (mines/synthesises to a
   proposal, never a live model, never auto-installed) and `self-improvement` (reviewable diff, armed
   only explicitly).
4. **Least privilege by construction.** Every synthesised agent gets the *minimum* tools and the
   narrowest model tier its role needs. Read-only roles get read-only tools. Validators are read-only.
5. **Fail closed.** No engagement phase advance, and no finding-into-report, while a required
   validator verdict is missing/failing/stale (reuse `missionCompleteBlocked`). Non-interactive active
   target actions already fail closed in `pentest-governance-domain` (`approval_required_without_ui`)
   — the Conductor must *design around* that, not try to defeat it (see Open Question O-1).
6. **Bounded recursion and budget.** Hard depth and fan-out caps in the engagement record.
7. **Everything audited.** Synthesis events, dispatch, validation verdicts, and phase transitions all
   land in `trace-ledger` and (for governed actions) the existing chained `audit.jsonl`.

---

## Part II — Repo improvement plan

The point of Part II is to make Part I *buildable in small, verifiable steps that never break the
existing kit*. Everything below composes existing extensions; new code is thin glue plus templates.

### 8. New components

| Component | Kind | What it is | Composes |
|---|---|---|---|
| `conductor` | new extension (`packages/extensions/src/conductor/`) | The root layer: engagement record CRUD, phase gates, the agent factory, the dispatch/validation loop, `/engagement*` and `/synth*` commands. Writes `.pi/engagement/engagement.json`, `.pi/agents/<synth>.md`, and a context-sieve contribution — never a system prompt. | `subagent`, `orchestrator`, `task-graph`, `goal-core`, `verifier-board`, `memory-local`, `pentest-governance-domain`, `trace-ledger` |
| `agent-synth` | library inside `conductor` (`packages/extensions/src/conductor/synth/`) | Deterministic template→agent assembler. Inputs: role brief, selected skill names, tool set, model tier, scope stanza. Output: a `.pi/agents/*.md` string. Pure, unit-testable, no live model. | skills catalogue index, `provider-router` routing-policy convention |
| `validator` role template | new role (`packages/extensions/src/conductor/agents/validator.md`) | The causally independent finding/result judge (real? matters? in scope/spec?). Read-only. Fresh context, withheld finder reasoning. Records to `verifier-board`. | `verifier-board`, `dual-review` |
| Specialist role templates | new roles (`packages/extensions/src/conductor/agents/*.md`) | Seed library the factory specialises from: `recon`, `web-exploit`, `authz`, `api`, `reporter`, plus the existing coding four. Each is a *starting template*, tuned per-synthesis. | `packages/kit/skills/` corpus |
| Conductor skills | new skills (`packages/kit/skills/engagement-conductor/`, `packages/kit/skills/dynamic-agent-synthesis/`, `packages/kit/skills/independent-finding-validation/`) | Runbooks so *any* model (esp. small local ones) drives the loop correctly. | existing skill conventions + `packages/core/verify.mjs` trigger-shape lint |
| `engagement` profile | new profile (`packages/kit/profiles/engagement.json`) | Security-engagement-optimised set: `conductor` + `pentest-governance-domain` + full orchestration + independent validation + memory + trace. | all of the above |
| `engagement.example/` overlay | new example config | `scope.example.yaml` / `roe.example.yaml` / `tool-policy.example.json` already exist for `pentest-governance-domain`; add an `engagement.example.json` skeleton the Conductor reads. | `pentest-governance-domain` |

### 9. Phased delivery (each phase independently useful, verified, revertible)

Follows the kit's own bar: `npm run verify` + `npm run test:security` (+ `npm run eval` where a
behaviour changes) green before any phase is "done"; commit messages carry
finding/root-cause/fix/verification per `CLAUDE.md`.

- **Phase 0 — this document.** Design agreed, invariants fixed. *(done on merge of this note.)*
- **Phase 1 — engagement record + lifecycle skeleton.** `conductor` extension that creates/reads
  `.pi/engagement/engagement.json`, exposes `/engagement status|start|phase`, and gates phase
  advance on `verifier-board`. No synthesis yet; uses the existing four static roles. **DoD:** a
  fresh process resumes an engagement from disk alone; verify/security green; a `tests/` smoke test.
- **Phase 2 — the agent factory (deterministic).** `agent-synth` assembles `.pi/agents/<synth>.md`
  from a role brief + catalogue skill selection + tool set + model tier + scope stanza. Pure
  function, heavily unit-tested (this is the riskiest new logic). Conductor dispatches synthesised
  agents via `subagent`. **DoD:** golden-file tests for assembled agents; a synthesised out-of-scope
  agent is refused at synthesis time; new `packages/core/verify.mjs` check that every synthesised agent declares
  a scope stanza and a tool restriction.
- **Phase 3 — independent validator.** `validator` role + the "withhold finder reasoning, feed raw
  evidence only" dispatch path; verdicts recorded on `verifier-board`; report/phase gates honour them.
  **DoD:** an eval fixture proving a fabricated/out-of-scope finding is rejected by the validator and
  cannot reach the report; independence is structural (assert the validator prompt never contains the
  finder's narrative).
- **Phase 4 — bounded recursion + budget.** Depth/fan-out caps enforced; specialists may recurse.
  **DoD:** a test proving the cap actually stops a runaway; cost/one-run budget surfaced in the footer.
- **Phase 5 — `engagement` profile + docs + skills.** Wire the profile, write the three conductor
  skills, extend `docs/agent-orchestration.md` with a "root orchestrator" section, promote this note
  from proposal to design-of-record. **DoD:** `npm run catalog` regenerated; skills pass the
  trigger-shape lint; capability matrix updated.
- **Phase 6 (stretch) — governed active dispatch via the MCP gateway.** Resolve Open Question O-1 by
  wiring `mcp-router` ↔ `pi-system-mcp-gateway`'s human-approval plugin so a non-interactive
  specialist's active target action can be approved out-of-band instead of only failing closed.
  Design proposed, awaiting sign-off: see
  [Phase 6 — Governed Active Dispatch via the MCP Gateway](conductor-phase6-gateway-approval.md).

### 10. Repo debt this proposal gives a purpose to

This lands cleanly on top of three items already open in the project's `Current State` / `Gotchas`:

- **`remote-review` (stub, zero profiles).** Its literal job — "escalate completed work to a remote
  reviewer at `agent_end`" — *is* the independent-validation escalation path (§3c). The Conductor
  gives it a reason to exist; Phase 3 should either implement it as the remote-tier validator or
  fold its intent into `conductor` and delete the stub. Either way the stale "used in autonomous"
  manifest claim gets resolved.
- **`mcp-router` (stub, zero profiles) + `pi-system-mcp-gateway` (unconnected).** The gateway
  path is exactly how a *non-interactive* synthesised specialist's active action gets human approval
  without an interactive UI (§7 invariant 5 / O-1). Phase 6 is the first concrete use-case that
  justifies wiring it. (Also resolve the standing `mcp-router` vs `provider-router` vs new `conductor`
  naming-confusion risk by documenting the three layers explicitly.)
- **`pi-subagents` (declared, not wired).** Its background-job / `oracle` second-opinion features map
  onto the Conductor's async dispatch and the independent validator; decide wire-or-remove in Phase 4.

### 11. Risks & open questions

- **O-1 (biggest): non-interactive active actions fail closed.** `pentest-governance-domain` blocks
  target-touching actions when there is no interactive UI to approve them. A subagent *is*
  non-interactive. So today, synthesised specialists can safely do read-only recon, coding, and
  reporting fully autonomously, but **active exploitation must keep a human in the loop** (operator
  approves via the main/root agent's UI) until Phase 6's gateway approval path exists (design
  proposed: [conductor-phase6-gateway-approval.md](conductor-phase6-gateway-approval.md)). This is a
  *correct* safety behaviour to design around, not a bug to remove. The engagement profile must make
  the split explicit: autonomous read/plan/code/report; human-gated active target actions.
- **Determinism vs. flexibility of synthesis.** Keeping the factory deterministic (invariant 3) means
  it can only compose *catalogued* skills and *predefined* tool sets. That is the right trade
  (reviewable, safe) but it means the value scales with the skills corpus — which is fine, growing the
  corpus is already a T4 goal (`skill-forge`).
- **Small-model reliability of the root role.** The Conductor is the one role that must stay coherent
  over a long horizon; it should be pinned to the strong-model tier and lean hard on `goal-core` +
  the engagement record for continuity, never on raw context. (This is why it is T3+, gated on
  T0–T2 being solid.)
- **Cost/fan-out.** Dynamic synthesis + recursion can multiply model calls fast. Budget caps
  (Phase 4) and `provider-router`'s hot-path/strong split are the controls.

### 12. Explicitly out of scope (for now)

- Any relaxation of the deterministic scope/ROE gate. Never.
- A live model writing agent code or granting its own tools/targets. Never (invariant 3).
- Replacing the current `orchestrator` — the Conductor sits above it and reuses it.
- Cross-machine / system-wide orchestration — single-host first; the deployment story is the deploy repo's.

### 13. Definition of done for the whole capability

A fresh Conductor process, handed only a working tree + `engagement/scope.yaml` + `roe.yaml` +
`engagement.json`, can: resume the engagement; synthesise correctly-scoped, least-privilege
specialists from the packages/kit/skills/notes knowledge base; dispatch them (recursively, bounded); collect
evidence; get every claim independently validated; and produce a report containing only real,
in-scope, significant findings — all with `pentest-governance-domain` and `tool-firewall` enforcing
unchanged underneath, and every step in the trace. And the identical machinery, minus the pentest
profile, runs a long-horizon coding project with independent review/improvement. Nothing above weakens
any guarantee in `SECURITY.md`.

---

*This is a design note, not a commitment to a schedule. Treat its summaries as hypotheses to verify
against the code when implementation starts (`CLAUDE.md` convention) — the extensions and invariants
it cites were accurate as of 2026-08-14.*
