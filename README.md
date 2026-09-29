# pi-system

<p align="center">
  <img src="docs/assets/pi-system-logo.png" alt="pi-system logo" width="320">
</p>

<p align="center">
  <a href="https://gitlab.home.internal/lab/pi-system/-/pipelines?ref=main"><img src="https://gitlab.home.internal/lab/pi-system/badges/main/pipeline.svg" alt="pipeline status"></a>
  <a href="https://gitlab.home.internal/lab/pi-system/-/releases"><img src="https://gitlab.home.internal/lab/pi-system/-/badges/release.svg" alt="latest release"></a>
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.2.1--beta.0-blue" alt="version 0.2.1-beta.0"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="license MIT"></a>
  <a href="docs/ci-security.md"><img src="https://img.shields.io/badge/secrets-gitleaks-informational" alt="secret scanning: gitleaks"></a>
  <a href="docs/ci-security.md"><img src="https://img.shields.io/badge/SAST-semgrep-informational" alt="SAST: semgrep"></a>
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img src="https://img.shields.io/badge/pi-%E2%89%A50.76-8A2BE2" alt="pi 0.76 or newer"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-%E2%89%A520-339933?logo=nodedotjs&logoColor=white" alt="Node.js 20 or newer"></a>
  <a href="packages/extensions"><img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="packages/container"><img src="https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white" alt="Docker"></a>
  <a href="mkdocs.yml"><img src="https://img.shields.io/badge/docs-MkDocs-526CFE?logo=materialformkdocs&logoColor=white" alt="docs: MkDocs"></a>
</p>

A self-contained Pi coding-agent system, packaged as an npm-workspaces monorepo:

| Package | What it is |
|---|---|
| [`packages/core/`](packages/core) | Kit runtime and CLI: installer, verification gate, registry, release, schemas, policies. |
| [`packages/extensions/`](packages/extensions) | First-party extensions (`src/`) plus vendored third-party extensions (`third_party/`). |
| [`packages/kit/`](packages/kit) | Skills, prompts, profiles, themes, agent definitions, and workflows. |
| [`packages/web-ui/`](packages/web-ui) | `pi-console`: self-hosted multi-agent / session web UI. |
| [`packages/container/`](packages/container) | Docker image, compose files, entrypoint, overlays, and MCP servers. |

The release is MIT-licensed (© SATUNIX). See [`LICENSE`](LICENSE),
[`SECURITY.md`](SECURITY.md), and [`CHANGELOG.md`](CHANGELOG.md).

The workspace layout is for development. Users install the whole kit as one pi package,
delivered from this repository (`gitlab.home.internal/lab/pi-system`): releases are `vX.Y.Z`
tags, and `next` follows `main`.

## Install

```sh
npm install -g @earendil-works/pi-coding-agent                   # pi itself
git clone https://gitlab.home.internal/lab/pi-system.git
cd pi-system
node packages/core/install.mjs --channel latest --profile balanced   # newest release + profile
pi
```

Pick any profile below (`--profile lite` for small local models). Switch later inside pi with
`/profile`, and update pi, the kit and linked packages with `/update`. Use `--channel next` to
follow `main` instead of releases. See [`docs/getting-started.md`](docs/getting-started.md) and,
for git access, [`docs/INSTALL.md`](docs/INSTALL.md).

To develop the kit, install a checkout in place (edits apply on `/reload`):

```sh
npm ci --ignore-scripts
node packages/core/install.mjs --profile balanced
```

## Profiles

| Profile | Tiers | Purpose |
|---|---|---|
| `quick` | T0–T1 | Default-deny firewall, secret-guard, protected-paths, checkpoints, memory, todo, status bar. |
| `balanced` | T0–T2 | + pentest-governance, context-sieve, guidelines, verification, loop support. |
| `long-horizon` | T0–T3 | + orchestration: goal-core, task-graph, branch-lab, subagent. |
| `autonomous` | T0–T3 | + armed autonomous-loop for set-and-walk-away sessions. |
| `self-improving` | T0–T4 | Full capability (experimental): mem0 memory, dual review, skill-forge. |
| `pentest` | T0–T3+ | Security engagements: strict pentest firewall policy, pentest governance and the Conductor (formerly `engagement`). |
| `lite` | T0–T3 | Small local models and low-context sessions: trimmed extension, skill and prompt set. |

## Develop

```sh
npm run verify          # schema + tsc + self-containment lint + policy/docs drift
npm run test:security   # firewall + secret-guard smoke tests
npm run smoke:epic1     # representative extension smoke tests
npm run catalog         # regenerate docs/EXTENSIONS.md, skills + capability catalogues
npm run profile:check -- --profile balanced
npm run docs:build      # strict MkDocs build (requires requirements-docs.txt)
```

## Documentation

Start at [`docs/index.md`](docs/index.md). The design overview is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) and [`docs/MODULARITY.md`](docs/MODULARITY.md),
the safety boundary in [`docs/security.md`](docs/security.md), and the per-extension authoring
contract in [`docs/WRITING_EXTENSIONS.md`](docs/WRITING_EXTENSIONS.md).
Releases and channels are in [`docs/releasing.md`](docs/releasing.md), and the CI
security checks in [`docs/ci-security.md`](docs/ci-security.md).

## Adding an extension

```sh
npm run new -- my-extension    # scaffold packages/extensions/src/my-extension/
npm run verify
npm run catalog
```
