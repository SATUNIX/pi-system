#!/usr/bin/env python3
import argparse
import pathlib
import re
import sys
from urllib.parse import urlparse


ROOT = pathlib.Path(__file__).resolve().parents[1]
VALID_DAYS = {"Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"}
REQUIRED_DENIALS = {
    "out_of_scope_target",
    "destructive_exploitation",
    "persistence",
    "malware",
    "credential_stuffing",
    "data_extraction_beyond_poc",
    "disable_logging",
    "delete_evidence",
    "modify_scope",
}


def fail(message: str) -> int:
    print(message, file=sys.stderr)
    return 1


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def default_overlay_path(live_path: str, example_path: str) -> str:
    return live_path if (ROOT / live_path).exists() else example_path


def yaml_scalar(value: str) -> str:
    return value.strip().strip("\"'")


def parse_inline_list(value: str) -> list[str]:
    value = value.strip()
    if not value.startswith("[") or not value.endswith("]"):
        return []
    return [yaml_scalar(item) for item in value[1:-1].split(",") if yaml_scalar(item)]


def collect_list(text: str, path_keys: list[str]) -> list[str]:
    values: list[str] = []
    stack: list[tuple[int, str]] = []
    for raw_line in text.splitlines():
        line = re.sub(r"\s+#.*$", "", raw_line)
        if not line.strip():
            continue
        indent = len(line) - len(line.lstrip())
        while stack and indent <= stack[-1][0]:
            stack.pop()

        key_match = re.match(r"\s*([A-Za-z0-9_-]+):\s*(.*)$", line)
        if key_match:
            key, rest = key_match.groups()
            candidate_path = [entry[1] for entry in stack] + [key]
            if candidate_path == path_keys:
                values.extend(parse_inline_list(rest))
            stack.append((indent, key))
            continue

        list_match = re.match(r"\s*-\s*(.+?)\s*$", line)
        if list_match and [entry[1] for entry in stack] == path_keys:
            values.append(yaml_scalar(list_match.group(1)))
    return values


def scalar(text: str, key: str, default: str = "") -> str:
    match = re.search(rf"(^|\n){re.escape(key)}:\s*([^\r\n#]+)", text)
    return yaml_scalar(match.group(2)) if match else default


def testing_windows(text: str) -> list[dict[str, object]]:
    windows: list[dict[str, object]] = []
    in_windows = False
    current: dict[str, object] | None = None
    for raw_line in text.splitlines():
        line = re.sub(r"\s+#.*$", "", raw_line)
        if line == "testing_windows:":
            in_windows = True
            continue
        if in_windows and line and not line.startswith(" ") and not line.startswith("-"):
            if current:
                windows.append(current)
            break
        if not in_windows or not line.strip():
            continue

        days = re.match(r"\s*-\s*days:\s*(\[.*\])\s*$", line)
        if days:
            if current:
                windows.append(current)
            current = {"days": parse_inline_list(days.group(1)), "start": "", "end": ""}
            continue
        start = re.match(r"\s*start:\s*(.+?)\s*$", line)
        if start and current is not None:
            current["start"] = yaml_scalar(start.group(1))
            continue
        end = re.match(r"\s*end:\s*(.+?)\s*$", line)
        if end and current is not None:
            current["end"] = yaml_scalar(end.group(1))
    if current:
        windows.append(current)
    return windows


def valid_clock(value: object) -> bool:
    if not isinstance(value, str):
        return False
    match = re.match(r"^(\d{2}):(\d{2})$", value)
    if not match:
        return False
    hour, minute = int(match.group(1)), int(match.group(2))
    return 0 <= hour <= 23 and 0 <= minute <= 59


def host_for_target(target: str) -> str:
    parsed = urlparse(target)
    if parsed.hostname:
        return parsed.hostname.lower()
    return re.sub(r":\d+$", "", target).lower()


def target_in_scope(target: str, allowed_hosts: list[str], denied_hosts: list[str], allowed_prefixes: list[str], denied_prefixes: list[str]) -> bool:
    host = host_for_target(target)
    if host in denied_hosts:
        return False
    if any(target.startswith(prefix) for prefix in denied_prefixes):
        return False
    if allowed_prefixes and any(target.startswith(prefix) for prefix in allowed_prefixes):
        return True
    return host in allowed_hosts


def validate_scope_roe(scope_path: str, roe_path: str) -> int:
    scope = read(scope_path)
    roe = read(roe_path)

    allowed_hosts = [item.lower() for item in collect_list(scope, ["allowed_assets", "web", "hosts"])]
    allowed_prefixes = collect_list(scope, ["allowed_assets", "web", "url_prefixes"])
    allowed_methods = [item.upper() for item in collect_list(scope, ["allowed_assets", "web", "methods"])]
    denied_hosts = [item.lower() for item in collect_list(scope, ["denied_assets", "hosts"])]
    denied_prefixes = collect_list(scope, ["denied_assets", "url_prefixes"])
    denied_actions = set(item.lower() for item in collect_list(roe, ["always_denied"]))
    windows = testing_windows(roe)

    if scalar(scope, "schema_version") != "1":
        return fail(f"{scope_path} must declare schema_version 1")
    if scalar(roe, "schema_version") != "1":
        return fail(f"{roe_path} must declare schema_version 1")
    if not allowed_hosts and not allowed_prefixes:
        return fail(f"{scope_path} must define at least one allowed web host or URL prefix")
    if not all(re.match(r"^[A-Z]{3,10}$", method) for method in allowed_methods):
        return fail(f"{scope_path} has invalid HTTP method entries")
    if "unknown_assets: deny" not in scope:
        return fail(f"{scope_path} must deny unknown assets")
    if not REQUIRED_DENIALS.issubset(denied_actions):
        missing = ", ".join(sorted(REQUIRED_DENIALS - denied_actions))
        return fail(f"{roe_path} missing always_denied entries: {missing}")
    if not windows:
        return fail(f"{roe_path} must define at least one testing window")
    for window in windows:
        days = window.get("days")
        if not isinstance(days, list) or not days or any(day not in VALID_DAYS for day in days):
            return fail(f"{roe_path} has invalid testing window days")
        if not valid_clock(window.get("start")) or not valid_clock(window.get("end")):
            return fail(f"{roe_path} has invalid testing window clock values")

    if not target_in_scope("https://app.example.test/", allowed_hosts, denied_hosts, allowed_prefixes, denied_prefixes):
        return fail("scope fixture failed: allowed app URL was not accepted")
    if target_in_scope("https://app.example.test/logout", allowed_hosts, denied_hosts, allowed_prefixes, denied_prefixes):
        return fail("scope fixture failed: denied URL prefix was accepted")
    if target_in_scope("https://outside.example.test/", allowed_hosts, denied_hosts, allowed_prefixes, denied_prefixes):
        return fail("scope fixture failed: unknown target was accepted")
    if "TRACE" in allowed_methods:
        return fail("scope fixture failed: unsafe TRACE method should not be in the example allowlist")

    print("Scope/ROE checks passed")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate deterministic scope and ROE overlays.")
    parser.add_argument("--scope", default=default_overlay_path("engagement/scope.yaml", "engagement/scope.example.yaml"))
    parser.add_argument("--roe", default=default_overlay_path("engagement/roe.yaml", "engagement/roe.example.yaml"))
    args = parser.parse_args()
    return validate_scope_roe(args.scope, args.roe)


if __name__ == "__main__":
    raise SystemExit(main())
