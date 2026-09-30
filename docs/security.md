# Security model

This page states what the pi-system safety boundary **guarantees** and, just as important, what it
**does not**. It is a default-deny **guard rail**, not a sandbox. The reporting process is in
`SECURITY.md` at the repository root.

## The layers

| Layer | Extension | Ships in | Enforces |
|---|---|---|---|
| Universal firewall and autonomy gate | `tool-firewall` | every profile | Parses shell commands into effects, tiers every call (low, medium, high, critical) with session history, auto-allows routine work, judges medium actions in auto mode, denies critical ones, and audits every decision. See [Autonomy gate](autonomy-gate.md). |
| Protected paths | `protected-paths` | every profile | Blocks writes to agent-control files, including the firewall's policy, approvals and audit files and the unattended-run contract. |
| Delegation governance | `delegation-guard`, `effort` | every profile | Every child agent is started only with the protections its parent has loaded, and verifies them itself before running a tool, failing closed. See [Agent orchestration](agent-orchestration.md). |
| Universal secrets guard | `secret-guard` | shipped, **not in any profile** (experimental, opt-in) | A name- and pattern-based backstop: blocks writes to secret files and secret *content*, and shell commands that read, copy, encode or exfiltrate them. Enable it with `node packages/core/install.mjs --only secret-guard --yes` or by adding it to a profile. |
| Tool I/O capture | `tool-capture` | every profile | Lossless, rotating JSONL of every tool call and output, joined to the firewall audit by action hash; secrets flagged. See [Tool I/O capture](tool-capture.md). |
| Domain governance | `pentest-governance-domain` | `pentest` | Scope and rules-of-engagement enforcement, MCP-only mode, action-card approval, hash-chained audit for authorised engagements. |
| Web console | `web-console` and `packages/web-ui` | most profiles | Token authentication, host and origin checks, an RPC allow-list. See [Web console](web-console.md). |

`tool-firewall` loads **before** `pentest-governance-domain` in the pentest profile (enforced by
`tests/epic1-smoke.mjs`), so the general gate runs first. Coding profiles carry no pentest gate;
the firewall runs there with the `coding` policy, and the pentest profile switches it to the
strict `pentest` policy (see [Autonomy gate](autonomy-gate.md#policies-and-profiles)). The
firewall loads first in every profile and in every child, and pi hands it the very object that
will execute, after argument preparation and validation, with parallel calls executed only after
all are decided (`tests/firewall-preauth-smoke.mjs`).

### MCP-only mode and `PI_ALLOW_DIRECT_TOOLS`

`pentest-governance-domain`'s MCP-only mode forces target-touching direct tools
(`write`, `edit`, `bash`) through the audited governance MCP path. It loads only in the `pentest`
profile, and even there it is not unconditionally on: by default it activates only once a real
engagement is configured (both `engagement/scope.yaml` and `engagement/roe.yaml` present and
complete). Set `PI_ALLOW_DIRECT_TOOLS=1` to force-allow direct tools mid-engagement (operator
override, still audited), or `=0` to force MCP-only lockdown without a configured engagement.

The kit's own first-party bookkeeping tools (`todo`, `subagent`, `dual_review`, the `task_*`,
`record_verdict`, `verdict_status`, `memory_*`, `mem0_*`, `skill_*` and `branch_*` tools) are exempt
from MCP-only mode: they do not touch a pentest target and are already gated by `tool-firewall`.

## What the boundary guarantees

1. **No silent allow-all.** The firewall's default for an unknown tool is `ask`, which resolves to
   **deny** when there is no interactive operator (headless, autonomous, print mode). A fresh
   session with no environment variables loads the shipped starter policy
   (`packages/extensions/src/tool-firewall/default-policy.json`), which has rules.
2. **Destructive shell commands never run automatically.** The shell parser classifies each
   command by effect and target rather than by a regex over the text. Deleting `/`, `~` or system
   roots, `mkfs`, writes to raw block devices, fork bombs, and secret egress (a credential read
   and a network send in one command) are **critical** and denied in every profile and mode.
   Deletions outside the workspace, force-pushes, history rewrites and persistence are **high**
   and need an operator. Obfuscation (`r''m`, `r\m`, `$'\x72m'`, variable-built commands) is
   normalised before classification, and unparseable input is never auto-allowed. Authorisation
   precedes execution on every shell form tested, including wrappers such as `xargs`, `sudo`,
   `env`, `find -exec` and command substitution (`tests/firewall-noeffect-smoke.mjs`: the marker
   file is never created and the tool never runs before an answer).
3. **Approvals are never broader than what you chose.** <a id="approvals"></a>An "allow" you give
   is bound to the exact action, the workspace, the directory and the session, and expires
   (24 hours for a session allow, 30 days for a learned one). Approvals are stored in one file,
   `<agent dir>/pi-kit/firewall-approvals.json` (mode 0600), and `/firewall list` shows each with
   its scope, who granted it and how; `/firewall revoke <id>`, `revoke session`, `revoke workspace`
   or `revoke all` removes them, effective from the next call. A malformed approvals file is
   ignored, never treated as an allow, and reported. A precedent learned in one workspace does
   not run unasked in another.
4. **Every refusal is labelled once**, as `[HARD DENY]`, `[UNCERTAIN ...]`,
   `[OPERATOR DECISION: denied]` or `[AUTO-MODE BLOCK]`, in the text the agent sees, on the
   approval card and in the audit record. A hard deny cannot be overridden by an approval or the
   judge.
5. **Auto mode cannot approve anything critical, or any new kind of high action, on a model's
   say-so.** A high action runs without the operator only as an exact repeat of an approval you
   gave. A judge block whose confidence is not high goes to the operator rather than being final,
   and an unsure judge never becomes an allow.
6. **Nothing waits forever.** An approval card, the human console and the judge all have
   timeouts (15 minutes, 15 minutes and 15 seconds by default); an unanswered wait ends as
   `UNCERTAIN` and nothing runs. Aborting ends every wait.
7. **Every child agent is at least as protected as its parent.** `delegation-guard` starts a child
   only with the protections the parent registered; inside the child it checks that they loaded
   and otherwise blocks every tool and exits with code 78. This applies to grandchildren and to
   every launch path (the `subagent` tool, workflows, verification reviewers, validators).
8. **Unattended mode can only come from the supervisor.** It is active only when the process
   environment and a read-only contract file, both built by the autonomous runner, say so and
   agree; it cannot be enabled from inside a session, and any inconsistency means the normal
   rules apply. See [Autonomous runs](autonomy.md).
9. **Every firewall decision is audited** to `.pi/tool-firewall-audit.jsonl` (tier, effects,
   reason codes, redacted command, action hash, and the decider: analyser, policy, learned
   precedent, judge or human). Every tool call and output is also captured by `tool-capture`. The
   capture log holds exact values, secrets included, so it is private (`0700` and `0600`),
   write-protected against the agent, and reading it is a credential read for the firewall.
10. **`secret-guard`, when enabled, blocks the obvious secret paths.** It blocks writing key
    material or tokens to any file, and `cat`, `cp`, `mv`, `base64`, `curl -F @file` and PowerShell
    style reads of `.env`, `*.pem`, `*.key`, `id_rsa` and protected engagement paths, including
    glob-obscured and quote-fragmented references. The firewall separately classifies credential
    files as credential reads whether or not `secret-guard` is loaded.

## What the boundary does NOT guarantee

- **It is not a sandbox.** A tool call that is *allowed* runs with the agent's full operating
  system privileges. The firewall decides *whether* a tool runs, not *what it can reach* once
  running. For containment use the [autonomous runner's container](autonomy.md) or your own.
- **Content detection is heuristic.** A novel secret format, a secret split across writes, or one
  encrypted or obfuscated before writing can evade `secret-guard`. Treat it as defence in depth.
- **Command classification is static.** The parser sees the command text, not what a script
  does at run time: `./build.sh` or `python tool.py` is judged by name and context. A wrapper
  script the agent wrote earlier can hide an effect. Session history (download then execute,
  secret then send) and the headless fail-closed behaviour are the backstop.
- **Low-tier actions run unasked in every mode.** That includes reads by tools whose name says
  they only read (`get_*`, `list_*`) and plain network GETs. `/firewall status` prints this.
  Tightening it would prompt on every MCP read.
- **It does not police network egress by itself.** A network send is medium (judged in auto mode,
  asked in manual) and becomes high or critical after a secret read. Destination allow-listing is
  the pentest governance layer's job (scope and rules of engagement), and in unattended runs the
  container's network is the stop, because package-manager and opaque-tool traffic cannot be
  attributed to a host.
- **Companion tools outside the kit's classification.** A pi package that registers its own shell
  or edit tools (for example the optional `pi-lean-ctx`) is seen by the firewall only as an
  unknown tool (`ask`), not as a shell command, and `secret-guard` matches the built-in tool names.
- **Effort is not a boundary.** It budgets delegation and shapes behaviour; the ledger and its
  environment are owned by your user. A hostile process could edit them. See [Effort](effort.md).
- **Unattended mode trusts the supervisor.** The firewall checks the contract and environment
  but cannot verify that the container boundary the supervisor describes actually exists. A
  forged contract elsewhere on disk is possible through paths that spawn pi without a shell.
- **A custom policy can widen the boundary.** `PI_KIT_FIREWALL_POLICY` pointing at a permissive
  file (for example `{ "defaults": { "unknown": "allow" } }`) re-opens the gate. `verify.mjs`
  only guarantees the *shipped* policy is default-deny. Such overrides, and `PI_KIT_UNATTENDED*`,
  are safety-setting overrides.
- **Interactive approval is only as careful as the person answering it.** Cards show the action,
  its tier and the reasons; a remembered approval is scoped, but you still decide.

## Overriding and tightening

- `PI_KIT_FIREWALL_POLICY=/path/to/policy.json` replaces the shipped policy.
- `/profile pentest` or `PI_KIT_FIREWALL_PROFILE=pentest` selects the strict policy. Profiles set
  the firewall mode and policy only; they never turn on unattended mode.
- `/auto off` or `PI_KIT_AUTO_MODE=0` asks for every medium and high action; `/auto learn off`
  stops applying learned precedents.
- `/firewall status` shows the policy, mode, judge, rule counts and session state;
  `/firewall list` and `/firewall revoke` manage approvals; `/firewall reload` re-reads the
  policy file.
- Tighten by adding `command_rules.deny` entries, or setting `tools.<name>.decision` to `deny`.

## Tests that pin this

`npm run test:security` runs the firewall, shell parser, approvals, outcomes, no-side-effect,
pre-authorisation, unattended-mode, protections-registry, delegation-guard and web-console suites,
plus `secret-guard`. `verify.mjs` fails the build if the shipped policy stops being default-deny or
its destructive patterns stop being a superset of `pentest-governance-domain`'s. As with any
pattern-based boundary, this is the current state of an ongoing effort, not a permanent guarantee.
