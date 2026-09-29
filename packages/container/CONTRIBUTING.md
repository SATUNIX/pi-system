# Contributing to the container package

Repository-wide contribution rules are in the repo-root [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
This file adds the deployment/fleet rules that were previously carried by the separate legacy
`fleet-capability-pi-agent` repository.

## Branch and merge policy

All changes use a feature branch and a merge request into protected `main`. Direct and force pushes
to `main` are prohibited. A human Maintainer or Owner performs the final merge; agent approval is
never a substitute for the documented human review.

Agent-authored commits use the established signing identities:

- Codex-authored commits: `Coding-Agent-A01 <coding-agent-a01@gmpk.net>`
- Claude-authored commits: `Coding-Agent-A00 <coding-agent-a00@gmpk.net>`

Their GitLab accounts (`coding-agent-a01` and `coding-agent-a00`) are Developer-only identities owned
by `agrace1`, use the established SSH signing identities and `allowed_signers` policy, and cannot
merge to `main`. Agent accounts must not satisfy the human review/merge gate.

The monorepo has a single root `CODEOWNERS`. The legacy container `CODEOWNERS` rule (review by
`@agrace1`, agent identities deliberately absent) is folded into the ownership notes here and in
`SECURITY.md` rather than added as a second `CODEOWNERS` file.

## Before opening a merge request

1. Read this package's tracking documents and the current state of the work.
2. Select only the next unblocked bounded task and preserve established decisions.
3. Run the checks relevant to what changed.
4. Record evidence and update every affected tracking file in the same change.
5. Identify live impact and rollback, and name the required human reviewer.

## Runtime-change checklist

- Bump `PI_CODING_AGENT_VERSION` / `PI_MCP_ADAPTER_VERSION` in both the `Dockerfile` `ARG` defaults
  and `capability/env/defaults.env`, keeping the two values equal.
- After compose changes, run `sh capability/tests/validate-compose.sh` and
  `python3 scripts/validate-compose-parity.py`.
- After Dockerfile changes, run `python3 scripts/validate-runtime-readiness.py`.
- Changes under `mcp-servers/governance/` also affect the standalone `pentest-governance-domain`
  extension in `packages/extensions/src/pentest-governance-domain/`; keep them in step.
- Update runtime docs to match (`capability/docs/`).

## Material ambiguity

Material ambiguity affecting security, preservation, authentication, ownership, exposure,
availability, or recovery is a stop boundary: record the decision request and ask the operator
rather than choosing a default.
