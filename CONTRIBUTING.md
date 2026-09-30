# Contributing

## Layout

- `packages/core/` — runtime + CLI + schemas + policies.
- `packages/extensions/src/<name>/` — first-party extensions you author here.
- `packages/extensions/third_party/<name>/` — adapted upstream extensions, each with a `SOURCE.md`.
- `packages/kit/` — skills, prompts, profiles, themes, agents, workflows.
- `packages/web-ui/` — the web console. `packages/autonomy/` — the autonomous run engine.
  `packages/container/` — the container deployment.
- `tests/`, `docs/` — the suite and the documentation.

## Branch strategy

- `main` — `npm run check:all` green. Every commit on `main` is the `next` channel.
- Feature branches and draft pull requests carry unreleased work; nothing is released from them.
- Releases are tags `vX.Y.Z` (or `vX.Y.Z-beta.N`) cut by an operator with
  `npm run release -- <version>`; a pushed tag becomes the `latest` channel. See `docs/releasing.md`.

## Checks

`npm run check:all` is the single definition of "the checks". It enumerates them from
`package.json` — every `smoke:*` and `test:*` script, plus `verify`, `eval`, `docs:check`
and a `profile:check` pass per profile — and fails with a summary of every
failure rather than stopping at the first. Run it before proposing a change; CI runs the
same command, so a new `smoke:*` script is covered without editing a workflow.

Smoke tests must be hermetic. Call `isolateKitEnv()` from
`packages/core/eval/harness.mjs` before loading the extension under test, then set only the
variables that test needs; the gate must pass with the operator's `PI_KIT_*` environment
present (an ambient `PI_KIT_FIREWALL_POLICY`, for example, otherwise overrides the shipped
policy and changes the decision under test).

Faster loops while working: `npm run verify` (structure, catalogues, parity, nav),
`npm run eval` (offline fixtures), and the single `npm run smoke:<name>` for the area you
changed. Documentation changes additionally want
`python -m mkdocs build --strict`, which is the one gate that needs Python.

## Per-extension contract

1. One folder per extension: `packages/extensions/src/<name>/` or `packages/extensions/third_party/<name>/`.
2. Entry point: `index.ts` at the folder root.
3. Metadata: `extension.json` sibling, validated against `packages/core/schema/extension.schema.json`.
4. **Self-containment (hard rule):** import only `node:*` built-ins and the `typebox` peer. No
   sibling imports, no `packages/core/lib` imports. Cross-extension contracts go through a
   registry on `globalThis` (`Symbol.for("pi-kit.*")`). `npm run verify` enforces this mechanically.
5. `README.md` per extension explaining what it does and what it needs.

## Avenues

| Avenue | Folder | Use when |
| --- | --- | --- |
| First-party | `packages/extensions/src/<name>/` | You author and iterate it here |
| Third-party | `packages/extensions/third_party/<name>/` | You must modify upstream (add `SOURCE.md`) |
| External | `packages/core/sources.json` | Someone else's repo, reference or bundle |

Profiles reference extension names, not paths — so relocation never changes a profile.

## Splitting an extension to its own repo

```sh
npm run extract -- <name>
```

## Updating the catalog

```sh
npm run catalog
```

`docs/EXTENSIONS.md`, `docs/skills-catalogue.md`, and `docs/capability-matrix.md` are generated;
do not hand-edit them.

Private GitLab is the development source of truth; GitHub is the public release projection.
Public contributions are reviewed and imported into a GitLab MR before the next release.
See [repository topology](docs/repository-topology.md). Do not maintain independent changes on
both main branches.
