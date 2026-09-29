# Internal changelog (archived)

> This is the changelog of the internal development line, before pi-system was published. Its
> version numbers (0.4.x to 1.x) belong to that line and do not correspond to npm releases.
> Public versioning restarts at `0.2.1-beta.0`; see `CHANGELOG.md` in the repository root.

All notable changes to `pi-system` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `/profile` command in `extensions/session-helpers`: switch the active kit profile from inside
  pi (`/profile` picker, `/profile <name>` direct, `/profile list`). It locates the kit checkout,
  re-runs `node packages/core/install.mjs --profile <name> --yes` (passing the recorded `--scope`
  back through), then reloads. Both the monorepo layout (`packages/core/install.mjs` +
  `packages/kit/profiles`) and a legacy flat kit (`kit/install.mjs` + `profiles/`) are supported;
  generated npm surfaces ship neither, so `/profile` degrades to a clear `PI_KIT_ROOT` message.
  New `tests/profile-command-smoke.mjs` (`npm run smoke:profile`, wired into CI) covers
  picker/direct/list, unknown/current-profile rejection, exact install argv for both layouts, and
  no-reload on installer failure.

### Added

- `packages/core/.env.example` — the env-var template the installer scaffolds and refreshes
  (`packages/core/lib/paths.mjs` `ENV_EXAMPLE`, `packages/core/install.mjs`, the `files` list in
  `packages/core/package.json`). It had gone missing in the monorepo move, so installs silently
  skipped scaffolding. Creating it required a narrow, deliberate guard exemption: `.env` protection
  is a substring match, so the template was blocked for reads, writes and shell access alike.
  `secret-guard` (the universal boundary), `pentest-governance-domain` and
  `third_party/protected-paths` now all treat the exact basenames `.env.example` / `.env.sample` as
  non-secret, while the real `.env`, `.env.local`, `.env.production` and `cp .env.example .env` stay
  blocked, and secret CONTENT written into a template is still caught. `PROTECTED_PATTERNS` is
  unchanged in every extension, so the verify.mjs pattern-parity check still holds. Covered by new
  assertions in `tests/secret-guard-smoke.mjs`, `tests/protected-paths-smoke.mjs` and
  `tests/governance-smoke.mjs`.
- Ported reference material from the legacy kit: `docs/SUPERSESSION.md` (supersession decision and
  the porting inventory), `docs/agent-improvement/` (autonomous improvement workflow, cycle-state
  injector, Codex skills), `docs/archive/` (the delegation-liveness and monitoring/security/UX review
  briefs), root `AGENTS.md` and `CLAUDE.md`, and container `AGENTS.md`, `CONTRIBUTING.md`,
  `SECURITY.md`, `CHANGELOG.md` and `capability/docs/CODEX_HANDOFF.md`.

- `reviews/` — the predecessor kit's full review records (14 documents plus their
  baseline logs, inventories and scenario scripts), ported so the historical reasoning is
  not lost with the predecessor repository.
- The remainder of the predecessor's `docs/` — `PI_KIT_REPO_PLAN.md`, the five Conductor
  phase handoffs, the two `0.4.1 → 1.0.0` handoffs (including the v1 hardening prompt),
  `LATEST_PLAN_2026-08-04T042958Z.md`, `Pi RAIA.txt`, and the two complete
  `docs/agent-improvement/cycles/` records (82 files) that serve as worked examples of the
  six-phase evidence layout.
- `docs/future-work.md` — a tracked, evidence-backed list of the open improvements:
  subagent stability and reliability; auto-compaction still running when disabled; the
  compaction threshold being unreachable from the TUI; long-context reliability in
  planning and assessment; reviews of planning/context injection, of skill disclosure and
  skill use, and of the tool firewall; tools executing before human approval; and the
  checks that never run in CI. Each item records its evidence with file references, ranked
  hypotheses, the smallest useful next step and acceptance criteria.
- `docs/legacy-repo-deletion-readiness.md` — the evidence that the predecessor repo's
  useful content is accounted for before it is deleted, including the two classes that
  exist only in its git objects (the Pi Coder corpus at `6daf815` and the 31 unmerged
  `fix/bonsai-model` commits) and the verified offline bundle that preserves them.

### Added

- `npm run check:all` (`packages/core/check-all.mjs`) — one command that runs every check
  the repository defines, enumerated from `package.json` rather than hardcoded: every
  `smoke:*` and `test:*` script, plus `verify`, `eval`, `docs:check`, and `profile:check`
  once per shipped profile and surface. It reports every failure, not just the first, so
  one run is enough. 58 runs, ~45 s, green.
- `.gitlab-ci.yml` — the pipeline that actually runs for this repository. GitLab does not
  execute `.github/workflows/`, and the monorepo branch carried no pipeline at all, so the
  check suite had no CI on the host it lives on. Adapted from the predecessor's root
  `.gitlab-ci.yml` (which ran a hardcoded subset from `misc-agents-pi-kit/`), now
  self-contained: a Node job running `check:all`, a job that generates and packs the export
  surfaces, and a Python job running `mkdocs build --strict`. The predecessor's
  `root/ci-templates` composition is documented as an optional include for instances that
  provide those templates.
- A `## Checks` section in `CONTRIBUTING.md` naming `check:all` as the single definition of
  the checks, with the faster per-area commands for local loops.

### Fixed

- `tests/observability-contracts-smoke.mjs` was failing, silently, because it never ran in
  CI. The trace-ledger `/trace` summary does report skipped corrupt lines, but the
  assertion only accepted the wording from a different branch (`unreadable/corrupt
  records`), so it had rotted. It now asserts the contract instead of one exact string:
  corruption is surfaced, and a ledger that still has records is never reported as "no
  actions recorded yet". The same test no longer uses `new Function` to evaluate the pinned
  runtime's footer method; that is a sandboxed `vm.runInNewContext`.
- `profile:check` fails when invoked without a target, so `check:all` runs it per profile
  and per surface (what CI's matrix previously did by hand).
- `docs` build: resolved the unresolved links that made `mkdocs build --strict` abort. Five were
  pre-existing on `main` (links to files outside `docs_dir` in `index.md`, `INSTALL.md`, `updates.md`
  and `proposals/root-orchestrator-conductor.md`); the sixth came from the ported
  `agent-improvement/autonomous-workflow.md`. The referenced paths are kept as code spans, which is
  how they already read, so no information was lost and the strict build now exits 0.
- `trigger-compact` and `compress` no longer throw when their deferred compaction callbacks run after
  a reload has replaced the session (`notifySafely` in `trigger-compact`; a guarded `notify` in
  `compress`). Previously the notification itself threw *inside* the error path.
- `memory-mem0` pointed at legacy paths that no longer exist: the default MCP server argument was
  `infra/memory-mcp/index.js` (now `packages/container/mcp-servers/memory-mcp/index.js`) and two
  messages referenced `infra/mem0/`. Its MCP transport also threw on non-JSON child output instead of
  degrading like the HTTP transport, and a malformed `MEM0_API_URL` surfaced a raw `TypeError`.

This release merges the previously separate `@satunix/pi-system` catalogue, the `pi-console` web UI,
and the fleet container capability into one MIT-licensed npm-workspaces monorepo.

### Added

- `packages/core`, `packages/extensions`, `packages/kit`, `packages/web-ui`, and
  `packages/container` workspace packages, each with its own manifest.
- `packages/extensions/third_party/` with a `SOURCE.md` attribution for every vendored extension.
- Canonical path resolution in `packages/core/lib/paths.mjs`, consumed by every core script.
- `examples/engagement/` sample configuration.
- Fresh `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE` (MIT, © SATUNIX), and mkdocs site.

### Changed

- Extensions moved to `packages/extensions/src/` (first-party) and
  `packages/extensions/third_party/` (vendored); `extension.json` `$schema` references retargeted.
- Kit resources (skills, prompts, profiles, themes, surfaces, agents) moved to `packages/kit/`.
- Core tooling moved to `packages/core/` and retargeted to the new layout; the generated install
  surfaces keep their flat `extensions/` + `vendor/` layout.
- Test suite retargeted to the package layout; the eval harness maps logical
  `extensions/…`/`vendor/…` paths onto the packages.
- The lite surface package was renamed from `@satunix/pi-system-lite` to `@satunix/pi-system-lite`.

### Removed

- Development-only baggage from the release tree: `node_modules`, `dist`, `.runtime`, `.pi`
  runtime state, `reviews/`, agent-improvement cycle evidence, logs, handoffs, and the
  per-subproject Gitea/GitLab workflow directories.

### Inherited

- Behaviour from the merged `1.0.0` capstone: the default-deny firewall / secret-guard /
  pentest-governance boundary, verification gate, profile system, and install surfaces.
  Pre-1.1.0 history is preserved in the source repositories; this file records the
  reorganization onward.
