# Examples

Sample configuration for a governed Pi System deployment.

## `engagement/`

Authority and policy templates for an authorized security engagement:

- `scope.example.yaml` / `roe.example.yaml` — scope and rules of engagement.
- `tool-policy.example.json` / `tool-policy.example.yaml` — tool approval policy.
- `approval-classes.example.yaml` — approval-class definitions.
- `mcp-servers.example.yaml` — MCP server configuration.
- `model.example.json` / `model.small.example.json` — model routing examples.

The container package ships the same templates under `packages/container/engagement/`; they are
baked into the image at `/opt/pi-agent/engagement/` and copied into a workspace when an engagement
starts. Real engagement files are deployment-specific and should never be committed.
