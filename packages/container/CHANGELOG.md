# Container package changelog

This file records deployment-history migrations for the container package. The entries below are
**historical migrations**, inherited from the separate legacy `fleet-capability-pi-agent` (formerly
`fleet-capability-agent-pi-pentest`) repository that was merged into the `pi-system` monorepo. They
are recorded for traceability and are **not** unreleased work in this monorepo. Repository-wide
changes are recorded in the root [`CHANGELOG.md`](../../CHANGELOG.md).

## Historical migrations

### Legacy migration: `fleet-capability-agent-pi-pentest` → `fleet-capability-pi-agent`

#### Added

- Initial repo: clean rewrite of `fleet-capability-agent-pi-pentest` generalised to a reusable pi
  agent container.
- `mcp-servers/governance/` — the `fleet_governance` MCP server migrated from the pentest repo.
- `overlays/pi/` — settings, mcp, and models config templates seeded at container startup.
- `engagement/` — example scope/ROE/tool-policy/approval-classes templates.
- All validation scripts from the pentest repo (adapted to the new capability id).
- `scripts/pi-agent` — generalised launcher (was `pi-pentest`).

#### Changed

- Capability id: `fleet-capability-agent-pi-pentest` → `fleet-capability-pi-agent`.
- Service name: `pi-pentest` → `pi-agent`.
- Data root: `/srv/data/fleet-capability-agent-pi-pentest` → `/srv/data/fleet-capability-pi-agent`.
- MCP governance server path:
  `/workspace/.pi/mcp-servers/governance/` → `/opt/pi-agent/mcp-servers/governance/`.
- Pentest-specific skills/prompts/extensions moved to `misc-agents-pi-kit`.

### Monorepo merge: `fleet-capability-pi-agent` → `packages/container/`

#### Added

- Container package at `packages/container/` (Dockerfile, compose, overlays, engagement templates,
  validation scripts) as part of the MIT-licensed `pi-system` npm-workspaces monorepo.

#### Changed

- Capability id: `fleet-capability-pi-agent` → `pi-system`.
- MCP governance server name: `fleet_governance` → `pi_system_governance`.
- Persistent data root: `/srv/data/fleet-capability-pi-agent` → `/srv/data/pi-system`.
- Governance extension sourced from the kit at
  `packages/extensions/src/pentest-governance-domain/`; behaviour resources (skills, prompts,
  profiles) installed from `packages/kit/`.
