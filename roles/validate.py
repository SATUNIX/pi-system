#!/usr/bin/env python3
"""Offline CTL-034 contract validator for operate-mode agent roles.

Requires PyYAML. Validates the local subset of CTL-034 (08 §3):

* identity, service account and OpenBao auth role match the directory name;
* tools are unique, from the registered catalog, and never ``k8s.write*`` or
  ``secret.*``;
* egress is unique, from the registered destination catalog, and always
  includes the runtime endpoints ``litellm`` and ``openbao``;
* ``entry`` is exactly the §8.7 invocation for the role;
* the result schema parses, is a closed object, and has the mandatory fields.

The shared ``lab-contract validate`` check remains the cross-repo contract
check; this script only enforces the agent-specific rules and has no network or
cluster dependency.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent
ROLES = {"sentinel", "builder", "reviewer", "auditor", "gardener", "reporter", "scribe"}
WORK_TYPES = {"audit", "review", "triage", "implement", "verify", "decide"}
TOOLS = {
    "prom.query", "loki.query", "k8s.read", "wazuh.alerts.read", "argocd.app.read",
    "gitlab.issue.create", "gitlab.issue.read", "gitlab.mr.create", "gitlab.mr.read",
    "gitlab.mr.comment", "gitlab.ci.read", "gitlab.branch.push", "gitlab.repo.read",
    "matrix.post", "safe_action.request", "ops.lease.claim", "ops.report.write",
    "ops.finding.write", "labstat.read", "policyreport.read", "trivy.report.read",
    "backup.status.read", "tofu.plan.read", "render.verify", "test.run",
}
EGRESS = {
    "litellm", "gitlab", "kube-api", "prometheus", "loki", "alertmanager",
    "wazuh-api", "matrix", "openbao", "argocd", "dns", "ntfy",
}
REQUIRED_RESULT_FIELDS = {"run_id", "role", "summary", "confidence", "findings", "escalate"}


def expected_entry(role: str) -> str:
    return (
        f"pi run --role {role} --workflow <workflow> "
        "--input /inputs/context.json --output /outputs/result.json"
    )


def validate_role(role: str, folder: Path) -> list[str]:
    errors: list[str] = []
    contract_path = folder / "agent-role.yaml"
    try:
        data = yaml.safe_load(contract_path.read_text())
    except (OSError, yaml.YAMLError) as exc:
        return [f"{role}: cannot parse agent-role.yaml: {exc}"]
    if not isinstance(data, dict):
        return [f"{role}: agent-role.yaml must be a mapping"]

    spec = data.get("spec") or {}
    if data.get("kind") != "AgentRole" or data.get("metadata", {}).get("name") != role:
        errors.append(f"{role}: identity mismatch")
    if spec.get("entry") != expected_entry(role):
        errors.append(f"{role}: entry does not match the §8.7 invocation")

    tools = spec.get("tools")
    if not isinstance(tools, list) or len(tools) != len(set(tools)) or set(tools) - TOOLS:
        errors.append(f"{role}: invalid tools {set(tools or []) - TOOLS}")
    if any(str(tool).startswith(("k8s.write", "secret.")) for tool in tools or []):
        errors.append(f"{role}: forbidden tool")

    egress = spec.get("egress")
    if not isinstance(egress, list) or len(egress) != len(set(egress)) or set(egress) - EGRESS:
        errors.append(f"{role}: invalid egress {set(egress or []) - EGRESS}")
    if not {"litellm", "openbao"}.issubset(egress or []):
        errors.append(f"{role}: runtime egress missing litellm/openbao")

    work_types = spec.get("workTypes")
    if not isinstance(work_types, list) or not work_types or set(work_types) - WORK_TYPES:
        errors.append(f"{role}: invalid workTypes {set(work_types or []) - WORK_TYPES}")

    if spec.get("kubernetes", {}).get("serviceAccount") != f"agent-{role}":
        errors.append(f"{role}: service account mismatch")
    if spec.get("openbao", {}).get("authRole") != f"agent-{role}":
        errors.append(f"{role}: OpenBao role mismatch")
    if spec.get("openbao", {}).get("tokenTTL") != "15m":
        errors.append(f"{role}: OpenBao token TTL must be 15m")
    if not spec.get("prompt") or not spec.get("resultSchema") or not spec.get("model"):
        errors.append(f"{role}: prompt, resultSchema and model are required")
    if spec.get("resultSchema") != f"roles/{role}/result.schema.json":
        errors.append(f"{role}: result schema path mismatch")

    if not (folder / "SYSTEM.md").is_file():
        errors.append(f"{role}: SYSTEM prompt missing")

    schema_path = folder / "result.schema.json"
    try:
        schema = json.loads(schema_path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        errors.append(f"{role}: cannot parse result schema: {exc}")
        return errors
    if schema.get("type") != "object" or schema.get("additionalProperties") is not False:
        errors.append(f"{role}: result schema must be a closed object")
    if not REQUIRED_RESULT_FIELDS.issubset(schema.get("required", [])):
        errors.append(f"{role}: incomplete result schema")
    if schema.get("properties", {}).get("role", {}).get("const") != role:
        errors.append(f"{role}: result schema role const mismatch")
    return errors


def main() -> int:
    errors: list[str] = []
    for role in sorted(ROLES):
        folder = ROOT / role
        if not folder.is_dir():
            errors.append(f"{role}: role directory missing")
            continue
        errors.extend(validate_role(role, folder))
    for folder in ROOT.iterdir():
        if folder.is_dir() and folder.name not in ROLES:
            errors.append(f"unexpected role: {folder.name}")
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print(
        f"{len(ROLES)} role contract static checks passed; "
        "CTL-034 egress/NetworkPolicy diff pending WP-076"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
