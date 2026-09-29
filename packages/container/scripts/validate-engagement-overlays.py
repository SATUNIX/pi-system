#!/usr/bin/env python3
import json
import pathlib
import re
import sys


ROOT = pathlib.Path(__file__).resolve().parents[1]
SECRET_RE = re.compile(
    r"(api[_-]?key|token|secret|password)\s*[:=]\s*['\"]?(?!<|example|changeme|REDACTED)([A-Za-z0-9_./+=-]{12,})",
    re.IGNORECASE,
)
ALLOWED_TRANSPORTS = {"streamable-http", "stdio"}
VALID_DECISIONS = {"allow", "ask", "deny"}
VALID_RISK_CLASSES = {
    "unknown",
    "read_only",
    "passive_recon",
    "low_risk_active_validation",
    "intrusive_scan_fuzz",
    "exploit_demonstration",
    "destructive_disallowed",
}


def fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def validate_no_secret_text(path: str) -> int:
    if not (ROOT / path).exists():
        return 0
    text = read(path)
    match = SECRET_RE.search(text)
    if match:
        return fail(f"{path} appears to contain a committed secret-like value near {match.group(1)}")
    return 0


def validate_json(path: str) -> tuple[int, dict]:
    try:
        return 0, json.loads(read(path))
    except Exception as exc:
        return fail(f"{path} is not valid JSON: {exc}"), {}


def validate_tool_policy(path: str) -> int:
    status, policy = validate_json(path)
    if status:
        return status
    if policy.get("schema_version") != 1:
        return fail(f"{path} must declare schema_version 1")
    defaults = policy.get("defaults", {})
    if defaults.get("unknown") != "deny":
        return fail(f"{path} must deny unknown tools by default")
    for name, entry in policy.get("tools", {}).items():
        if entry.get("decision") not in VALID_DECISIONS:
            return fail(f"{path} tool {name} has invalid decision")
        if entry.get("risk_class") not in VALID_RISK_CLASSES:
            return fail(f"{path} tool {name} has invalid risk_class")
        if name.startswith(("shell.", "file.")):
            return fail(f"{path} must not classify direct Pi shell or file tools")
        if name.startswith("mcp.tool.") and (not entry.get("server") or not entry.get("tool_name")):
            return fail(f"{path} tool {name} must bind server and tool_name")
    return 0


def validate_mcp_yaml(path: str) -> int:
    text = read(path)
    if "directTools: false" not in text:
        return fail(f"{path} must keep directTools false")
    if "samplingAutoApprove: false" not in text:
        return fail(f"{path} must keep samplingAutoApprove false")
    if re.search(r"samplingAutoApprove:\s*true", text):
        return fail(f"{path} must not enable sampling auto-approval")

    for transport in re.findall(r"transport:\s*([A-Za-z0-9_-]+)", text):
        if transport not in ALLOWED_TRANSPORTS:
            return fail(f"{path} uses unsupported MCP transport {transport}")
    if re.search(r"url:\s*https?://", text) and "host.docker.internal" not in text:
        return fail(f"{path} HTTP MCP examples must use reviewed host allowlist entries")
    return 0


def validate_required_yaml_fields(path: str, required: list[str]) -> int:
    text = read(path)
    for field in required:
        if not re.search(rf"(^|\n){re.escape(field)}:", text):
            return fail(f"{path} is missing required field {field}")
    return 0


def main() -> int:
    checks = [
        lambda: validate_tool_policy("engagement/tool-policy.json"),
        lambda: validate_tool_policy("engagement/tool-policy.example.json"),
        lambda: validate_mcp_yaml("engagement/mcp-servers.example.yaml"),
        lambda: validate_required_yaml_fields("engagement/scope.example.yaml", ["schema_version", "engagement_id", "allowed_assets", "denied_assets", "scope_rules"]),
        lambda: validate_required_yaml_fields("engagement/roe.example.yaml", ["schema_version", "default_mode", "timezone", "testing_windows", "rate_limits", "always_denied"]),
        lambda: validate_json("engagement/model.example.json")[0],
        lambda: validate_json("engagement/model.small.example.json")[0],
    ]
    for candidate in [
        "engagement/mcp-servers.example.yaml",
        "engagement/scope.example.yaml",
        "engagement/roe.example.yaml",
        "engagement/tool-policy.json",
        "engagement/tool-policy.example.json",
        "engagement/model.example.json",
        "engagement/model.small.example.json",
        "capability/env/defaults.env",
        ".env.example",
    ]:
        checks.append(lambda candidate=candidate: validate_no_secret_text(candidate))

    for check in checks:
        status = check()
        if status:
            return status

    print("Engagement overlay checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
