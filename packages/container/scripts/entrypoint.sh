#!/usr/bin/env bash
set -euo pipefail

DATA_ROOT="${PI_AGENT_DATA_ROOT:-/srv/data/pi-system}"
PI_DIR="${PI_CODING_AGENT_DIR:-${DATA_ROOT}/pi-agent}"
SESSION_DIR="${PI_CODING_AGENT_SESSION_DIR:-${DATA_ROOT}/sessions}"

log() { echo "[pi-entrypoint] $*"; }

# Create required directories
for d in "$DATA_ROOT" "$PI_DIR" "$SESSION_DIR" "${DATA_ROOT}/home"; do
  if [ ! -d "$d" ]; then
    mkdir -p "$d" || { log "WARN: could not create $d"; }
  fi
done

# Seed pi config from overlays if not already present
PI_CONFIG_DIR="${HOME}/.pi/agent"
mkdir -p "$PI_CONFIG_DIR"

for f in settings.json mcp.json models.json; do
  src="/opt/pi-agent/overlays/pi/$f"
  dst="$PI_CONFIG_DIR/$f"
  if [ -f "$src" ] && [ ! -f "$dst" ]; then
    cp "$src" "$dst"
    log "Seeded $dst"
  fi
done

log "Data root: $DATA_ROOT"
log "Pi config: $PI_CONFIG_DIR"
log "Sessions:  $SESSION_DIR"

exec "$@"
