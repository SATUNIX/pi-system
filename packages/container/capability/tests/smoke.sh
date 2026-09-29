#!/usr/bin/env sh
# Smoke test: build + start + health check + teardown.
# Requires Docker. Creates temporary data dirs under /tmp.
set -eu

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TMP_DATA="$(mktemp -d)"
COMPOSE="$REPO_ROOT/capability/compose/compose.yaml"
ENV_FILE="$REPO_ROOT/capability/env/defaults.env"

cleanup() {
  docker compose -f "$COMPOSE" --env-file "$ENV_FILE" down --remove-orphans 2>/dev/null || true
  rm -rf "$TMP_DATA"
}
trap cleanup EXIT

echo "[smoke] Building image..."
PI_AGENT_DATA_ROOT="$TMP_DATA" \
  docker compose -f "$COMPOSE" --env-file "$ENV_FILE" build --quiet

echo "[smoke] Starting container..."
PI_AGENT_DATA_ROOT="$TMP_DATA" \
  docker compose -f "$COMPOSE" --env-file "$ENV_FILE" up -d

echo "[smoke] Waiting for healthy..."
for _ in $(seq 1 10); do
  status=$(docker inspect --format='{{.State.Health.Status}}' \
    pi-system-pi-agent-1 2>/dev/null || echo "not_found")
  if [ "$status" = "healthy" ]; then
    echo "[smoke] Container healthy."
    break
  fi
  sleep 3
done

if [ "$status" != "healthy" ]; then
  echo "[smoke] FAIL: container did not become healthy"
  exit 1
fi

echo "[smoke] Checking pi version inside container..."
docker exec pi-system-pi-agent-1 pi --version

echo "[smoke] All smoke checks passed."
