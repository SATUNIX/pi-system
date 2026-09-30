#!/usr/bin/env bash
# Build the autonomy image from local git objects (no clone, no credentials in the image):
#   packages/autonomy/build-image.sh [--kit-ref v0.2.4-beta.0] [--base-ref origin/main] [--tag pi-autonomy:local] [--engine podman|docker]
# The kit ref is the harness the worker runs. The base ref is OPTIONAL: when given, its lockfile's
# dependencies (and docs requirements) are prebaked for offline installs; without it the image
# carries no repository-specific dependencies. Fetch the refs first (git fetch --tags origin).
set -euo pipefail
kit_ref=v0.2.4-beta.0; base_ref=""; tag=pi-autonomy:local; engine=podman
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
labels=(--label "pi-autonomy.kit-ref=$kit_ref" --label "pi-autonomy.kit-sha=$(git -C "$repo" rev-parse "$kit_ref^{commit}")")
if [ -n "$base_ref" ]; then
  # Only the dependency manifests that exist at that ref (a repository need not have every one).
  paths="$(git -C "$repo" ls-tree -r --name-only "$base_ref" | grep -E '^(package\.json|package-lock\.json|requirements-docs\.txt|packages/[^/]+/package\.json)$' || true)"
  # shellcheck disable=SC2086
  [ -z "$paths" ] || git -C "$repo" archive --format=tar "$base_ref" -- $paths | tar -x -C "$ctx/base"
  labels+=(--label "pi-autonomy.base-sha=$(git -C "$repo" rev-parse "$base_ref^{commit}")")
fi
cp -r "$repo/packages/autonomy/image" "$ctx/image"
"$engine" build -f "$ctx/image/Dockerfile" -t "$tag" "${labels[@]}" "$ctx"
echo "built $tag with $engine (kit $kit_ref${base_ref:+, dependencies from $base_ref})"
