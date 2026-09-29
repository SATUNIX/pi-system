# Security Model

This document states what the pi-kit safety boundary **guarantees** and — just as important —
what it **does not**. It reflects the hardened defaults introduced in `0.4.3` (Epic 2).

## The layers

| Layer | Extension | Ships in | Enforces |
|---|---|---|---|
| Universal firewall / autonomy gate | `tool-firewall` | every profile + lite | Parses shell commands into effects, tiers every call (low/medium/high/critical) with session history, auto-allows routine work, judges medium actions in auto mode, denies critical ones; JSONL audit of every decision. See [autonomy-gate.md](autonomy-gate.md). |
| Universal secrets guard | `secret-guard` | shipped, not enabled by default (experimental / opt-in) | Blocks writes/edits to secret files, protected engagement/repo paths, or secret *content*; blocks shell commands that read/copy/encode/exfiltrate them. No profile's `include` lists it; enable it as an extension (`node packages/core/install.mjs --only secret-guard --yes`) or add it to your profile. |
| Tool I/O capture | `tool-capture` | every profile | Lossless, rotating, compressed JSONL of every tool call and output (blocks and errors included), joined to the firewall audit by action hash; secrets flagged. See [tool-capture.md](tool-capture.md). |
| Domain governance | `pentest-governance-domain` | pentest | Scope/ROE enforcement, MCP-only mode, action-card approval, hash-chained audit for OffSec engagements. |

`tool-firewall` loads **before** `pentest-governance-domain` in the pentest profile (enforced by
`tests/epic1-smoke.mjs`), so the general gate runs first. Coding profiles carry no pentest gate;
the firewall runs there with the `coding` policy, and the pentest profile switches it to the
strict `pentest` policy (see [autonomy-gate.md](autonomy-gate.md#policies-and-profiles)).

### MCP-only mode and `PI_ALLOW_DIRECT_TOOLS`

`pentest-governance-domain`'s MCP-only mode forces target-touching direct tools
(`write`/`edit`/`bash`) through the audited governance MCP path. It loads only in the
`pentest` profile, and even there it is **not** unconditionally on. By default MCP-only activates only once a real engagement
is configured (both `engagement/scope.yaml` and `engagement/roe.yaml` present and complete);
without one, direct tools behave as `tool-firewall` alone decides. Set `PI_ALLOW_DIRECT_TOOLS=1`
to force-allow direct tools even mid-engagement (operator override, still audited), or `=0` to
force MCP-only lockdown even without a configured engagement (defense-in-depth hardening).

This kit's own first-party bookkeeping tools (`todo`, `subagent`, `dual_review`, the `task_*`/
`record_verdict`/`verdict_status`/`memory_*`/`mem0_*`/`skill_*`/`branch_*` tools) are exempt from
MCP-only mode unconditionally — they don't touch a pentest target and are already gated by
`tool-firewall`, which composes before this extension.

## What the boundary guarantees

1. **No silent allow-all.** The firewall's default for an unknown tool is `ask` (interactive)
   which resolves to **deny** when there is no interactive UI (headless / autonomous / print
   mode). This is the fix for the worst finding in the pre-1.0 audit, where the default was
   `{ unknown: "allow" }` with no policy file anywhere. A fresh session with **zero environment
   variables** loads the shipped starter policy (`packages/extensions/src/tool-firewall/default-policy.json`,
   mirrored at `packages/core/policies/default.json`), which has rules > 0.
2. **Destructive shell commands never run automatically.** The shell parser classifies each
   command by its effect and target rather than by a regex over the text. Deleting `/`, `~` or
   system roots, `mkfs`, writes to raw block devices, fork bombs, and secret egress (a
   credential read and a network send in one command) are **critical** and denied in every
   profile and mode. Deletions outside the workspace, force-pushes, history rewrites and
   persistence are **high** and need an operator. Routine build-output cleanup
   (`rm -rf node_modules dist`) is allowed. Obfuscation (`r''m`, `r\m`, `$'\x72m'`,
   variable-built commands) is normalised before classification, and unparseable input is never
   auto-allowed. The strict `pentest` policy adds the regex rules in
   `policies.pentest.command_rules` (e.g. any recursive `rm`); `verify.mjs` fails if those stop
   being a superset of `pentest-governance-domain`'s `DESTRUCTIVE_COMMANDS`.
3. **Secrets can't be written or exfiltrated through the obvious paths.** `secret-guard` blocks
   writing key material / tokens to *any* file (not just files named like secrets), and blocks
   `cat`/`cp`/`mv`/`base64`/`curl -F @file`/PowerShell `Get-Content`/`ReadAllBytes`/
   `ToBase64String` style reads of `.env`, `*.pem`, `*.key`, `id_rsa`, and the protected
   engagement/audit/evidence paths — including glob-obscured references (`cp .e??`) and
   quote-fragmented ones (`'.e''nv'`), and regardless of trailing shell syntax after the
   filename. Its protected-path list is kept in parity with `pentest-governance-domain` by
   `verify.mjs`.
4. **Every firewall decision is audited** to `.pi/tool-firewall-audit.jsonl` (tier, effects,
   reason codes, redacted command, action hash, and the decider: analyser, policy, lease,
   learned precedent, judge or human).
5. **Auto mode cannot approve anything critical, or any new kind of high action, on a model's
   say-so.** A high action runs without the operator only as an exact repeat of a session
   allow or of an action learned from at least 3 operator approvals across 2 sessions with no
   later denial. It reaches the judge only when the operator already allowed something similar,
   and a judge "no" goes back to the operator. None of this applies to critical,
   security-control, destructive or secret-egress actions.
6. **Every tool call and output is captured losslessly** by `tool-capture` for audit and SIEM
   (see [tool-capture.md](tool-capture.md)). The log holds exact values, secrets included, so
   it is private (`0700`/`0600`), write-protected against the agent, and reading it is a
   credential read for the firewall.

## What the boundary does NOT guarantee

- **It is not a sandbox.** A tool call that is *allowed* runs with the agent's full OS
  privileges. The firewall decides *whether* a tool runs, not *what it can reach* once running.
- **Content detection is heuristic, not exhaustive.** `secret-guard` uses high-confidence
  signatures (private-key blocks, AWS `AKIA…`, `ghp_…`, `sk-…`, high-entropy credential
  assignments). A novel secret format, a secret split across multiple writes, or a secret
  encrypted/obfuscated before writing can evade it. Treat it as defense-in-depth, not a DLP
  guarantee.
- **Command classification is static.** The parser sees the command text, not what a script
  or an interpreter does at runtime: `./build.sh` or `python tool.py` is judged by name and
  context, not by the file's contents. Inline code (`python -c`, heredocs into interpreters) is
  scanned, but a wrapper script that the agent wrote earlier can hide an effect. The session
  history (download → execute, secret → send) and the headless fail-closed behaviour are the
  backstop.
- **It does not police network egress by itself.** A network send is medium (judged in auto
  mode, asked in manual) and becomes high or critical when it follows or includes a secret
  read; a plain `curl` GET is routine. Destination allowlisting is the pentest governance
  layer's job (scope/ROE).
- **A custom policy can widen the boundary.** Setting `PI_KIT_FIREWALL_POLICY` to a permissive
  file (e.g. `{ "defaults": { "unknown": "allow" } }`) re-opens the gate. `verify.mjs` only
  guarantees the *shipped* policy is default-deny; it cannot constrain an operator override.

## Overriding / tightening

- `PI_KIT_FIREWALL_POLICY=/path/to/policy.json` — replace the shipped policy.
- `/profile pentest` or `PI_KIT_FIREWALL_PROFILE=pentest` — the strict policy.
- `/auto off` or `PI_KIT_AUTO_MODE=0` — ask for every medium/high action; `/auto learn off` —
  stop applying learned precedents.
- `/firewall:status` — show the policy, mode, judge model, rule counts and session state.
- `/firewall:reload` — reload after editing the policy file.
- Tighten by adding `command_rules.deny` entries or setting individual `tools.<name>.decision`
  to `deny`.

## Reporting

This is an internal kit. Report a suspected boundary bypass by filing an issue on the internal
Gitea instance with a reproducing tool-call fixture (see `tests/tool-firewall-smoke.mjs` /
`tests/secret-guard-smoke.mjs` for the fixture shape) — never with a live secret.

## 1.0.0 sign-off (Epic 9, plus independent-review hardening)

The Epic 9 capstone pass (2026-08-04, commit `8d3b205`) re-ran `npm run test:security`,
`npm run eval` security fixtures, and `verify.mjs`'s stub/parity checks — all green — but an
independent adversarial review of that same commit (`reviews/FINAL-review.md`) found the
boundary itself was bypassable: the default firewall policy missed the native Windows recursive-
delete primitive and quote-fragmented commands (F-03), and `secret-guard` missed glob-obscured
and PowerShell-based secret reads (F-04), among other blocking findings. Both were fixed in the
2026-08-05 hardening pass (see
[`roadmap.md`](roadmap.md#independent-review-and-hardening-pass-2026-08-05)), with the review's
own independent-repro commands added as permanent regression assertions in
`tests/tool-firewall-smoke.mjs` / `tests/secret-guard-smoke.mjs`.

Current sign-off basis: `npm run test:security` and `npm run eval` security fixtures green,
`verify.mjs` confirms **zero non-experimental-profile extensions carry `status:
experimental|stub`** (enforced, not spot-checked) and that the shipped firewall policy is
default-deny with destructive patterns in parity with `pentest-governance-domain`, **and** the
review's own bypass repros (PowerShell `Remove-Item -Recurse`, quote-fragmented commands,
`fs.rmSync`, `git clean -fdx`, glob-obscured/PowerShell secret reads) no longer reproduce. As
with any pattern-based boundary, treat this as the current state of an ongoing arms race, not a
permanent guarantee — see "What the boundary does NOT guarantee" above.

_Last reviewed: 2026-08-05 (independent-review hardening pass; Epic 9 capstone 2026-08-04;
boundary introduced in 0.4.3, Epic 2)._
