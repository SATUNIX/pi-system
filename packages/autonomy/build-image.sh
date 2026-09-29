#!/usr/bin/env bash
# Build the autonomy image from local git objects (no clone, no credentials in the image):
#   packages/autonomy/build-image.sh [--kit-ref v0.2.1-beta.0] [--base-ref origin/main] [--tag pi-autonomy:local] [--engine podman|docker]
# The kit ref is the harness the agent runs; the base ref supplies the lockfile whose
# dependencies are prebaked for offline installs. Fetch both refs first (git fetch --tags origin).
set -euo pipefail
kit_ref=v0.2.1-beta.0; base_ref=origin/main; tag=pi-autonomy:local; engine=podman
while [ $# -gt 0 ]; do
  case "$1" in
    --kit-ref) kit_ref="$2"; shift 2 ;;
    --base-ref) base_ref="$2"; shift 2 ;;
    --tag) tag="$2"; shift 2 ;;
    --engine) engine="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
repo="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
ctx="$(mktemp -d)"; trap 'rm -rf "$ctx"' EXIT
mkdir -p "$ctx/kit" "$ctx/base"
git -C "$repo" archive --format=tar "$kit_ref" | tar -x -C "$ctx/kit"
git -C "$repo" archive --format=tar "$base_ref" -- package.json package-lock.json requirements-docs.txt 'packages/*/package.json' | tar -x -C "$ctx/base"
cp -r "$repo/packages/autonomy/image" "$ctx/image"
"$engine" build -f "$ctx/image/Dockerfile" -t "$tag" \
  --label "pi-autonomy.kit-ref=$kit_ref" --label "pi-autonomy.kit-sha=$(git -C "$repo" rev-parse "$kit_ref^{commit}")" \
  --label "pi-autonomy.base-sha=$(git -C "$repo" rev-parse "$base_ref^{commit}")" "$ctx"
echo "built $tag with $engine (kit $kit_ref, dependencies from $base_ref)"
