# Supply Chain

How the kit sources third-party code, what installing it pulls in, and the current `npm audit`
status. The CI checks that enforce this are listed in [CI Security](ci-security.md).

## What installing the kit pulls in

The kit has **no runtime dependencies of its own**: `@earendil-works/pi-coding-agent` and
`typebox` are peer dependencies that pi itself provides, and everything else is dev-only.

A release is a tag in the private GitLab, created only after the full check suite and security
scans pass (`.gitlab-ci.yml`). pi clones it and runs `npm install --omit=dev` in the clone (as for
every git package). That links the workspaces and installs `ajv` (used by the toolchain) and,
because npm installs peer dependencies, an extra copy of pi and `typebox` inside the clone. The
running pi never loads that copy: it resolves `@earendil-works/pi-coding-agent` imports in
extensions to itself. All of it comes from the public npm registry at the lockfile's pinned,
integrity-checked versions.

If npm delivery is switched on, every version will also carry npm provenance, so
`npm audit signatures` can verify where it was built.

## External sources (`packages/core/sources.json`)

All external pi packages are pinned to an exact version and reviewed before enabling. They are
`reference` mode: the installer registers each one as its own pi package at the pinned version
when a selected profile includes it. None is bundled into the kit package.

| Package | Version | Native/opaque parts | Notes |
|---|---|---|---|
| `pi-lens` | 3.8.63 | `@ast-grep/napi` (native `.node`) + tree-sitter WASM | MIT. Diagnostics on edit; tools filtered off in balanced. |
| `pi-lean-ctx` | 3.8.18 | external `lean-ctx` CLI (NOT bundled, not on npm) | Apache-2.0. Requires the CLI on PATH; `session-helpers` warns if missing (Epic 1). |
| `pi-impact-analyzer` | 0.3.1 | web-tree-sitter WASM | MIT. Passive blast-radius. |
| `pi-readseek` | 0.4.26 | `@jarkkojs/readseek` native CLI (`readseek.exe`) + xxhash-wasm | MIT. Used by the `lite` profile for cheap hash-anchored reads and edits. |
| `pi-subagents` | 0.32.0 | pi-tui, jiti, typebox | MIT. Opt-in; not in any profile include by default. |

Native-binary risk is contained by exact version pins, `reference` (not bundle) mode, and the
`review` field per source in `packages/core/sources.json`. A kit release that changes a pin
moves companions on the next `/update`.

## `npm audit` status (2026-09-24, `npm@11`)

`npm audit` reports **0 vulnerabilities** for the full dependency tree (including dev
dependencies), and `npm audit signatures` verifies every registry signature and attestation.
CI blocks on high or critical advisories (`npm audit --audit-level=high`), on OSV-Scanner
findings, and, for pull requests, on dependency review.

Earlier `ws` and `undici` advisories reached the kit only through the framework
(`@earendil-works/pi-coding-agent`) and were cleared by framework updates.

## Lockfile integrity

`npm run security:lockfile` (`packages/core/lockfile-check.mjs`, part of CI) fails when a
package in `package-lock.json` resolves from anywhere but `https://registry.npmjs.org`, lacks a
sha512 `integrity` hash, or declares an install script that is not on its reviewed allowlist
(`@google/genai`, `esbuild`, `protobufjs`). CI installs with `--ignore-scripts`, so even
allowlisted scripts never run there.

## Version pinning

The kit supports `@earendil-works/pi-coding-agent` from `0.76.0` (its `peerDependencies`
floor). The dev dependency pins the newest tested version (`0.85.1`), which the main `verify`
job type-checks against, and CI's `pi-compat` matrix also runs `npm run verify` against `0.76.0`
and `0.79.6`, so an API drift in either direction fails the build.
