# pi-system — Capability Docs

Deployable pi coding agent with governed kit profiles installed from `pi-system`.

Use `capability/compose/compose.yaml` as the canonical Pi System compose entrypoint. The root `docker-compose.yml` is a compatibility entrypoint and must stay behaviorally equivalent except for build context relativity.

Environment defaults live in `capability/env/defaults.env`; Pi System overlays may override non-secret values such as `APP_PORT`, `PI_AGENT_DATA_ROOT`, `PI_AGENT_IMAGE`, and `PI_KIT_PROFILE`. Runtime state is stored below `/srv/data/pi-system`.

Rollback is declarative: revert the desired Pi System Git revision or environment overlay and let the reconciler apply the previous state.

| Document | Purpose |
|---|---|
| `OPERATOR_GUIDE.md` | Day-to-day operations: start, attach, kit choice, model configuration, MCP/governance |
| `RUNBOOK.md` | Troubleshooting and incident procedures |
| `SECURITY_MODEL.md` | Trust boundaries, capability drop, data paths |
| `ROADMAP.md` | Deploy-specific roadmap; package roadmap delegates to pi-kit |
| `PI_AGENT_GOLDEN_PATH.md` | Recommended agent operating patterns |
| `BURP_MCP.md` | Connecting Burp Suite via MCP |
| `CODEX_HANDOFF.md` | Handoff notes from prior capability work |

For extension building, package surfaces, status bar/costs, themes, and searchable user docs, use `../pi-system/docs/index.md` from the workspace root.
