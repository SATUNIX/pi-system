# Changelog

All notable changes to `@satunix/pi-system` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Versions before `0.2.1-beta.0` were internal and are archived in
`docs/archive/CHANGELOG-internal.md`; their numbers do not correspond to npm releases.

## [Unreleased]

_Nothing yet._

## [0.2.4-beta.0]

### Added

- `packages/autonomy` (private, not published): a supervisor for unattended improvement runs
  of this repository. It runs cycles of the kit's own agent (long-horizon profile, no judge,
  approvals auto-granted) inside a hard container boundary. The only ways out are an
  inference relay (fixed upstream, model allowlist, metered budget) and a local bare repo
  that the host takes in fast-forward only. Each cycle gets a post-cycle gate and a tag, and a
  fixed-choice manager model handles stuck cycles. A cycle that completes, passes the gate and
  passes an independent merge review is fast-forwarded into one shared `experimental/main`
  branch, which every later cycle and run starts from. Nothing is force-pushed. Cycles work
  in fix mode while there is something to fix, and in improve mode (capability, performance,
  reliability of existing systems) only when there isn't; each improvement is followed by a
  consolidation pass. A run whose cycles repeatedly find nothing to do stops as
  `backlog_exhausted`. See `docs/autonomy.md`.

### Changed

- The kit is delivered from `gitlab.home.internal/lab/pi-system` (`packages/core/distribution.json`);
  `root/pi-system` is archived. See `docs/updates.md` to move an existing install.
- Context contributions are scoped per session: producers write to
  `.pi/ctx-contributions/sessions/<session-id>/` (the flat directory stays as the fallback when
  pi exposes no session id), so concurrent sessions sharing a directory no longer overwrite each
  other. context-sieve skips files older than the process start instead of snapshotting them.
- Completion gates (verifier-board, orchestrator, conductor) require at least one passing
  trusted source (`verify`, `review` or `validator:<id>`); self-recorded passes alone no longer
  count as done.
- A project install keeps its state marker in `<project>/.pi/.pi-kit.json`, and `/profile`,
  `/update`, uninstall and the web UI read it before the global one. Uninstall removes the
  companion packages the install recorded.
- `PI_KIT_SPEC_PLAN_STRICT=0` (or `false`, `off`, `no`) now disables spec-plan; `1` still blocks.
- `npm run verify` lints nested `.ts` files in extensions and checks `docs/EXTENSIONS.md` for drift.

### Fixed

- Readers of persisted state (settings, sources, manifests, firewall sessions and grants, task
  graph, workflow runs, memory stores, ledgers, web UI files) ignore malformed or wrong-shaped
  data instead of crashing the host.
- Approval brokers (tool-firewall, pentest-governance, human-console) always settle, remove their
  pending and resolved files, and quarantine malformed requests (capped at 50).
- `extract-extension` rejects unsafe names and copies subdirectories; branch-lab accepts real git
  refs such as `origin/main` as the base branch; `check:all` runs on Windows.
- `/console stop` stops a hung web UI and never signals a pid that is not the console.

### Security

- pentest-governance blocks an action whose audit record cannot be written.

## [0.2.1-beta.0]

First versioned release, delivered from the private GitLab (`gitlab.home.internal/root/pi-system`).

### Added

- One package, one install: `node packages/core/install.mjs --channel latest --profile <name>`
  from any clone registers the newest release with pi; or `pi install
  git:gitlab.home.internal/root/pi-system@v<version>` (the first interactive start then applies
  the `balanced` profile; `PI_KIT_AUTO_PROFILE=<name>|0` changes or turns this off).
- Release channels: `latest` (the newest `vX.Y.Z` tag), `next` (every commit on `main`) and
  pinned versions. `install.mjs --channel <latest|next|X.Y.Z>` picks one.
- Kit delivery setting, `packages/core/distribution.json`: `git` (release tags and `main` of the
  kit's repository, the current setting) or `npm` (dist-tags of `@satunix/pi-system`). The
  installer, `/profile` and `/update` follow it; `PI_KIT_DELIVERY` and `PI_SYSTEM_GIT_SOURCE`
  override it per machine. When a release changes it, `/update kit` moves installs over.
- `kit-update` extension, in every profile: a daily background check for new versions of pi,
  the kit (release tags or `main` over `git ls-remote`, never prompting for credentials) and
  linked packages, and `/update` (`status`, `all`, `kit`, `pi`, `packages`, `channel <name>`) to
  apply them, re-applying the current profile and companion pins.
- `lite` profile: the small-model set formerly shipped as the separate lite package, with
  `skills.only` / `prompts.only` allowlists (new profile fields).
- GitLab release stage: a pushed `vX.Y.Z` tag that passes every check and scan, matches
  `package.json` and is on `main` gets a GitLab Release with notes from this changelog
  (`packages/core/release-notes.mjs`, `packages/core/gitlab-release.mjs`). A private CA is
  supported, and every other pipeline runs the release path read-only (`release-preflight`).
- Security scanning in the GitLab pipeline: gitleaks over full history, Semgrep, `npm audit`,
  `npm audit signatures`, lockfile integrity, and GitLab's SAST and Secret Detection. The same
  checks plus CodeQL, OSV-Scanner, dependency review, zizmor, OpenSSF Scorecard and Dependabot
  are ready in `.github/workflows/` for when the repository is on GitHub.
- npm delivery, built and paused: `.github/workflows/release.yml` (trusted publishing with
  provenance, dist-tags from `packages/core/publish-plan.mjs`), runnable only by hand.
- `npm run smoke:package` (tarball contents and per-profile resolution from the packed copy),
  `npm run smoke:distribution` (delivery, channels and installer source selection) and
  `npm run security:lockfile` (registry-only sources, integrity hashes, install-script
  allowlist).

### Changed

- The installer registers a checkout in place by default, the released kit when given
  `--channel`, and keeps the existing git or npm registration when run from pi's own copy of
  the kit. It keeps exactly one registered copy of the kit (git sources match on repository,
  whatever the ref), removing other checkouts, other deliveries and legacy exports.
- `release.mjs` accepts prerelease versions, bumps every workspace manifest, and runs the
  package check instead of generating surfaces.
- `install.mjs --uninstall` removes the companions it registered, not just the kit.

### Removed

- Generated install surfaces (`packages/kit/surfaces/`, `export-package.mjs`,
  `export-all.mjs`) and the `@satunix/pi-system-lite` package. `--surface lite` still works as a
  deprecated alias for `--profile lite`.
- The `export:*`, `install:lite`, `publish:dry-run` and `smoke:export-package` scripts.
