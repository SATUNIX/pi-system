# Supply chain

How the kit sources third-party code, what installing it pulls in, and the current `npm audit`
status. The CI checks that enforce this are listed in [CI security](ci-security.md).

## What installing the kit pulls in

The kit has **no runtime dependencies of its own**: `@earendil-works/pi-coding-agent` and
`typebox` are peer dependencies that pi itself provides, and everything else is dev-only
(`tests/clean-install-smoke.mjs` installs the packed artefact and confirms there is nothing to
install).

A release is a `vX.Y.Z` tag of the public repository, created only after the full check suite
and security scans pass. pi clones it and runs `npm install --omit=dev` in the clone (as for every
git package). Because npm installs peer dependencies, that can place an extra copy of pi and
`typebox` inside the clone. The running pi never loads that copy: it resolves
`@earendil-works/pi-coding-agent` imports in extensions to itself. Everything comes from the
public npm registry at the lockfile's pinned, integrity-checked versions.

If npm delivery is switched on, every version will also carry npm provenance, so
`npm audit signatures` can verify where it was built.

## Vendored code

Twelve extensions under `packages/extensions/third_party/` adapt upstream code. Each has a
`SOURCE.md` recording its upstream, what was changed and when, and `THIRD_PARTY_NOTICES.md`
(generated from them by `node packages/core/gen-notices.mjs`; `npm run verify` fails on drift)
carries the licence text and credits. The notice for pi's own example extensions is the upstream MIT
licence with its copyright holder and year.

## External sources (`packages/core/sources.json`)

External pi packages are pinned to an exact version and reviewed before enabling. They are
`reference` mode: the installer registers each one as its own pi package at the pinned version
when a selected profile includes it. None is bundled into the kit package. The review text in
`sources.json` records what each one does, and which newer versions were evaluated and why they
were not adopted.

| Package | Version | In a profile? | Native or opaque parts | Notes |
|---|---|---|---|---|
| `pi-lens` | 3.8.63 | balanced, long-horizon, autonomous, self-improving, pentest | `@ast-grep/napi` (native `.node`) and tree-sitter WASM | MIT. Diagnostics on edit; its tools are filtered off in `balanced`. 4.3.0 was evaluated and not adopted for this beta. |
| `pi-readseek` | 0.4.26 | long-horizon, autonomous, self-improving, pentest, lite | `@jarkkojs/readseek` native CLI and xxhash-wasm | MIT. Hash-anchored reads and edits. 0.10.1 changed licence, entry and dependencies and was not adopted. |
| `pi-lean-ctx` | 3.10.5 | **none (opt-in)** | The external `lean-ctx` Rust CLI, not bundled | Apache-2.0. Registers extra shell, read and edit tools that the firewall does not classify as shell and `secret-guard` does not inspect. Installed by `install.mjs --all` only when its CLI is on `PATH`. |

The container overlay (`packages/container/overlays/pi/settings.json`) pins `pi-mcp-adapter@2.8.0`,
checked by `validate-pentest-env.sh`; the 3.x line adds native and remote dependencies and was not
adopted.

Native-binary risk is contained by exact version pins, `reference` (not bundle) mode, and the
`review` field per source. A kit release that changes a pin moves companions on the next
`/update`.

### Evaluating a candidate

Read its tarball (`npm pack <name>@<version>`, then inspect `package.json` for `pi` entries,
peer ranges, dependencies, scripts and licence). If it loads into pi, install it into a scratch
`PI_CODING_AGENT_DIR` with `pi install npm:<name>@<version>` and start pi in a terminal to see what
it registers and whether it degrades cleanly. Record the result in `review`. Do not adopt a
version on the strength of its changelog.

## `npm audit` status (2026-09-30, npm 10.9)

`npm audit` reports **0 vulnerabilities** for the full dependency tree, including dev
dependencies, and `npm audit signatures` verifies every registry signature and 84 attestations
(385 locked packages). CI blocks on high or critical advisories (`npm audit --audit-level=high`),
on OSV-Scanner findings and, for pull requests, on dependency review.

The dev tree includes `mermaid` and `jsdom`, used only by `npm run docs:mermaid` to check that the
documentation's diagrams parse. They are never installed by a user of the kit.

## Lockfile integrity

`npm run security:lockfile` (`packages/core/lockfile-check.mjs`, part of CI) fails when a package
in `package-lock.json` resolves from anywhere but `https://registry.npmjs.org`, lacks a sha512
`integrity` hash, or declares an install script that is not on its reviewed allowlist. CI installs
with `--ignore-scripts`, so even allowlisted scripts never run there.

## pi versions

The kit supports `@earendil-works/pi-coding-agent` **0.85.1 and newer** (its `peerDependencies`
floor) on Node 22.19 or newer, which is pi's own requirement. The dev dependency pins the version
the whole suite is tested against, **0.87.1**. CI's `pi-compat` matrix runs the entire check suite
at the floor (must pass) and at the newest release looked at, **0.99.1** (advisory: it may fail
after a pi release, and that failure is the signal to review before widening the range). Widening
either is a reviewed change; Dependabot does not bump pi minors or TypeScript majors.

pi 0.99 changed its distribution (the runtime is bundled) and its tool-call and overflow
internals. The suite's runtime pins were made to follow pi's own behaviour rather than its source
layout, and the results at each version are recorded in the release notes for the beta.
