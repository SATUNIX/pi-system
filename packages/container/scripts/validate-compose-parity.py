#!/usr/bin/env python3
import pathlib
import sys


ROOT = pathlib.Path(__file__).resolve().parents[1]
CANONICAL = ROOT / "capability" / "compose" / "compose.yaml"
LOCAL = ROOT / "docker-compose.yml"


def normalized(path: pathlib.Path) -> str:
    text = path.read_text(encoding="utf-8")
    text = text.replace("context: ../..", "context: .")
    return "\n".join(line.rstrip() for line in text.splitlines()).strip() + "\n"


def main() -> int:
    canonical = normalized(CANONICAL)
    local = normalized(LOCAL)
    if canonical != local:
        print(
            "Root docker-compose.yml must match capability/compose/compose.yaml "
            "except for build context relativity.",
            file=sys.stderr,
        )
        return 1

    for path in (CANONICAL, LOCAL):
        text = path.read_text(encoding="utf-8")
        if "PI_CODING_AGENT_VERSION:-latest" in text:
            print(f"{path} must not default PI_CODING_AGENT_VERSION to latest", file=sys.stderr)
            return 1
        if "PI_MCP_ADAPTER_VERSION" not in text:
            print(f"{path} must pass PI_MCP_ADAPTER_VERSION into the Docker build", file=sys.stderr)
            return 1

    print("Compose parity checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
