#!/usr/bin/env bash
# Entrypoint of the autonomy image (docs/autonomy.md). One image, four roles, chosen by the
# supervisor (packages/autonomy/lib/docker.mjs):
#   agent               pi in RPC mode on /work; stdout is the RPC channel, so everything
#                       else goes to stderr
#   bundle <branch>     write the agent repo's branch to /out/agent.bundle (repo mounted read-only)
#   setref <branch> <sha>  point the agent repo's branch at <sha> from /in/branch.bundle; exp/
#                       tags in the bundle (unmerged cycles) become attempts/<run>/cycle-NN branches
#   gate <branch> <sha> the post-cycle gate (gate.sh)
set -euo pipefail
role="${1:-agent}"; shift || true
git_() { git -c safe.directory='*' -c core.hooksPath=/dev/null "$@"; }

case "$role" in
  bundle)
    git_ -C /git/remote.git bundle create --quiet /out/agent.bundle "refs/heads/$1"
    exit 0 ;;
  setref)
    git_ -C /git/remote.git fetch --quiet --no-tags /in/branch.bundle "+refs/heads/$1:refs/autonomy/reset" \
      "+refs/tags/exp/*:refs/heads/attempts/*"
    git_ -C /git/remote.git update-ref "refs/heads/$1" "$2"
    exit 0 ;;
  gate)
    exec /opt/autonomy/gate.sh "$@" ;;
  agent) ;;
  *) echo "unknown role $role" >&2; exit 2 ;;
esac

# --- agent ----------------------------------------------------------------------------------
exec 3>&1 1>&2   # keep fd 3 as the RPC stdout; setup output goes to stderr
: "${RUN_BRANCH:?}" "${PI_MODEL:?}"
export HOME=/state/home PI_CODING_AGENT_DIR=/state/agent npm_config_cache=/state/npm-cache
# No registry is reachable: npm resolves from the baked cache or fails at once (no retries).
export npm_config_offline=true npm_config_fetch_retries=0
mkdir -p "$HOME" /state/sessions

# pi state: the harness template once (kit registration, profile), then the run owns it.
if [ ! -f /state/agent/.seeded ]; then
  mkdir -p /state/agent && cp -a /opt/pi-agent/. /state/agent/ && touch /state/agent/.seeded
fi
# The installer records the kit as a path relative to the agent dir it ran in (/opt/pi-agent).
# In the copy that would point at /state/pi-kit, which does not exist, and pi would start with
# none of the kit's extensions; make every relative package source absolute against the
# template's location.
node -e '
  const fs = require("fs"), path = require("path");
  const file = "/state/agent/settings.json";
  const s = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const p of s.packages ?? []) {
    const src = typeof p === "string" ? p : p.source;
    if (typeof src === "string" && src.startsWith(".")) {
      const abs = path.resolve("/opt/pi-agent", src);
      if (typeof p === "string") s.packages[s.packages.indexOf(p)] = abs; else p.source = abs;
    }
  }
  fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");'
[ -f /opt/pi-kit/package.json ] || { echo "kit missing at /opt/pi-kit" >&2; exit 3; }
[ -d /state/npm-cache ] || cp -a /opt/npm-cache /state/npm-cache
# The relay is the only provider endpoint; the key here is a placeholder the relay replaces.
# The supervisor writes /state/run-models.json with the run's model specs (lib/models.mjs).
if [ -f /state/run-models.json ]; then cp /state/run-models.json /state/agent/models.json
else echo '{ "providers": { "openrouter": { "baseUrl": "http://inference:8081/v1", "apiKey": "relay" } } }' > /state/agent/models.json; fi

git config --global user.name "${GIT_NAME:-pi autonomy}"
git config --global user.email "${GIT_EMAIL:-pi-autonomy@localhost}"
git config --global push.default current
git config --global init.defaultBranch main

if [ ! -d /work/.git ]; then
  git clone --quiet --branch "$RUN_BRANCH" /git/remote.git /work
fi
cd /work
if [ "${CYCLE_RESET:-0}" = 1 ]; then
  # A new cycle starts from the pushed branch: uncommitted or unpushed work from an earlier
  # cycle is discarded (ignored files such as node_modules are kept).
  git fetch --quiet origin
  git checkout --quiet -B "$RUN_BRANCH" "origin/$RUN_BRANCH"
  git reset --quiet --hard "origin/$RUN_BRANCH"
  git clean -fdq
fi
git branch --quiet --set-upstream-to="origin/$RUN_BRANCH" 2>/dev/null || true

# Dependencies from the baked cache, when the lockfile changed or they are missing.
stamp=node_modules/.autonomy-lock-sha
lock_sha="$(sha256sum package-lock.json | cut -d' ' -f1)"
if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$lock_sha" ]; then
  if npm ci --offline --ignore-scripts >/state/npm-ci.log 2>&1; then echo "$lock_sha" > "$stamp"
  else echo "npm ci --offline failed (see /state/npm-ci.log); continuing" >&2; fi
fi

# No judge and no prompts: manual firewall mode with an invocation-local allow-all policy
# (the same mechanism as the live evaluation runner). The container is the boundary.
export PI_KIT_AUTO_MODE=0 PI_KIT_FIREWALL_POLICY=/opt/autonomy/firewall.json
# pi-lens: no automatic formatting or fixing (it rewrites whole files the agent touched, which
# the charter's scoped-diff rule forbids) and no language-server installs (offline).
export PI_LENS_DISABLE_LSP_INSTALL=1
exec pi --mode rpc --no-approve --provider openrouter --model "$PI_MODEL" --session-dir /state/sessions \
  --no-autoformat --no-autofix 1>&3
