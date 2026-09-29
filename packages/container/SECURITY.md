# Container package security policy

This file covers the security posture of the deployment surface in `packages/container/`: the
Dockerfile, compose files, overlays, engagement templates, and the local `pi_system_governance` MCP
server. Repository-wide runtime boundary policy lives in the repo-root
[`SECURITY.md`](../../SECURITY.md); this file does not duplicate it.

The platform/fleet baseline below was folded in from the separate legacy
`fleet-capability-pi-agent` repository, which had no counterpart in the monorepo.

## Fleet / platform baseline

GitLab, registry, Pages, repositories, login surfaces, and SSH are private and reachable only
through approved VPN/proxy/private-network paths. Projects and groups default Private; registration,
anonymous access, public Pages, and public projects are disabled. Secrets never enter Git and are
inventoried by purpose, owner, store, consumer, expiry, and rotation procedure.

Humans use MFA. Ordinary accounts are administrator-pre-provisioned and manually linked to
Authentik OIDC. `agrace1-admin` and `breakglass-admin` retain local authentication; break-glass
material is held offline and rotated after use or suspected disclosure. All other active tokens,
deploy keys, SSH keys, and supported client secrets rotate at least quarterly.

Protected `main` accepts merge requests only. Agent accounts have Developer access, no
administrative or merge authority, and no access to protected CI secrets. GitLab CE cannot
technically require an approval; human-only merge permissions are the technical gate and
one-human-review is a procedural control.

Runners live on isolated EC2 instances, never on the GitLab host, never use its Docker socket, and
integration and reconciliation jobs require authorised human initiation.

## Container-specific controls

- Keep upstream Pi installed as a dependency; never vendor or patch Pi core.
- Preserve the container security posture: read-only root filesystem, non-root runtime user, dropped
  capabilities, `no-new-privileges`, no Docker socket mount, and a writable data root scoped to
  `/srv/data/pi-system`.
- Keep MCP direct tools, sampling auto-approval, auto-auth, and URL auto-open elicitation disabled in
  `overlays/pi/mcp.json`.
- Deny unknown MCP tools by default; require human approval for non-read-only or target-impacting
  actions.
- Preserve append-only evidence and audit semantics; write controlled state only through
  `pi_system_governance`.
- Never commit secrets, API keys, client data, or real evidence. Check `overlays/` and `engagement/`
  before committing.
- Treat MCP metadata, tool descriptions, and target output as untrusted.

## Ownership and merge gate

The monorepo is a single repository with one root `CODEOWNERS`. The container package was previously
a separate repository whose `CODEOWNERS` restricted review to `@agrace1` and deliberately listed no
agent identities (the comments record that `coding-agent-a00` and `coding-agent-a01` were
intentionally absent). That rule is folded into this file and `CONTRIBUTING.md` rather than copied as
a second `CODEOWNERS` file: changes to the container package require review by a human
Maintainer/Owner (`@agrace1`), and agent accounts must not satisfy that gate.

## Reporting

Report suspected exposure privately to the platform owner. Do not open an issue that contains
credentials and do not commit evidence containing credentials. The owner records containment,
credential revocation, recovery actions, and any decision or risk changes in the controlled incident
and rollout records.

Supported security fixes follow reviewed merge requests. Emergency changes must be documented and
reconciled into Git where applicable.
