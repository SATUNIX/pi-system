#!/usr/bin/env bash
# Post-cycle gate (docs/autonomy.md): a clean clone of the accepted head, the repository's
# offline checks, no network. Exit 0 only when every step passed. Output: /gate/gate.log and
# /gate/result.json. Semgrep is not run (its rules come from the network); CI runs it on the MR.
set -uo pipefail
branch="$1"; sha="$2"
export HOME=/gate/home npm_config_cache=/gate/npm-cache
mkdir -p "$HOME"
exec >/gate/gate.log 2>&1
git config --global safe.directory '*'
git config --global core.hooksPath /dev/null

git clone --quiet --no-checkout --branch "$branch" /in/branch.bundle /gate/src || exit 3
cd /gate/src && git checkout --quiet --detach "$sha" || exit 3
cp -a /opt/npm-cache /gate/npm-cache

steps=(); failed=0
step() {
  local name="$1"; shift
  local start=$SECONDS
  echo "=== $name: $*"
  "$@"; local code=$?
  echo "=== $name: exit $code ($((SECONDS - start))s)"
  steps+=("$name $code $((SECONDS - start))")
  [ "$code" = 0 ] || failed=1
}

step install npm ci --offline --ignore-scripts
step check-all npm run check:all
step security npm run test:security
step docs python3 -m mkdocs build --strict -d /tmp/site
step secrets gitleaks git --redact --exit-code 1 .

printf '%s\n' "${steps[@]}" | node -e '
  const steps = require("fs").readFileSync(0, "utf8").trim().split("\n").map((l) => { const [name, code, seconds] = l.split(" "); return { name, code: +code, seconds: +seconds }; });
  require("fs").writeFileSync("/gate/result.json", JSON.stringify({ steps, green: steps.every((s) => s.code === 0) }, null, 2));'
exit "$failed"
