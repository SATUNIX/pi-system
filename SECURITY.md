# Security Policy

`pi-system` ships a three-layer safety boundary that is **default-deny**, not allow-all:

- **`tool-firewall`** (`packages/extensions/src/tool-firewall`) — unknown tools default to `ask`,
  which resolves to **deny** when headless; destructive shell commands (`rm -rf`, `dd`, `mkfs`, …)
  are denied in every profile; every decision is audited to `.pi/tool-firewall-audit.jsonl`.
- **`secret-guard`** (`packages/extensions/src/secret-guard`) — blocks writing secret files,
  protected paths, or secret *content*, and blocks `cat`/`cp`/`mv`/`base64`/`curl` exfiltration
  of them.
- **`pentest-governance-domain`** (`packages/extensions/src/pentest-governance-domain`, pentest profile only) —
  scope/ROE enforcement and action-card approval for authorized engagements.

`packages/core/verify.mjs` fails if the shipped firewall policy stops being default-deny or if
the universal guards stop covering `pentest-governance-domain`'s destructive/protected pattern
lists. `npm run test:security` exercises all of this offline.

**The full model — what the boundary guarantees, and the specific things it does *not* (it is not
a sandbox; content detection is heuristic; obfuscated commands can evade patterns) — is documented
in [`docs/security.md`](docs/security.md). Read it before relying on the boundary.**

## Reporting a vulnerability

Report a suspected boundary bypass by opening an issue, including a reproducing tool-call fixture
(see `tests/tool-firewall-smoke.mjs` and `tests/secret-guard-smoke.mjs` for the fixture shape).
**Never include a live secret** in a report.

_Last reviewed: 2026-08-04 (internal 1.0.0 capstone sign-off; boundary introduced in internal
0.4.3 — internal version numbers predate the public `0.2.1-beta.0` line). See
[`docs/security.md`](docs/security.md#100-sign-off-epic-9) for the sign-off record._
