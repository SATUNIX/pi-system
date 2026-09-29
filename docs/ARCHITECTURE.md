# Architecture

`pi-system` is one pi package, `@satunix/pi-system`. The repository root is the package: it declares its full resource set under the `pi` key in `package.json` (and a `files` allowlist for the npm tarball). Profiles, not separate packages, narrow what loads.

## The three avenues

| Avenue | Folder | Description |
|---|---|---|
| In-repo | `packages/extensions/src/<name>/` | Extensions you author and iterate here |
| Vendored | `packages/extensions/third_party/<name>/` | Adapted upstream extensions (with `SOURCE.md` provenance) |
| External | `packages/core/sources.json` | Other repos — installed as sibling packages via `pi install git:…` |

`packages/core/registry.mjs` unifies all three into `docs/EXTENSIONS.md`. Profiles reference extension **names** — never paths — so moving an extension between avenues doesn't change anything that refers to it.

## Extension contract

Every extension:
- Lives in a single folder (`packages/extensions/src/<name>/` or `packages/extensions/third_party/<name>/`)
- Has a stable `index.ts` entry point
- Has an `extension.json` metadata file (validated by `packages/core/verify.mjs`)
- Imports only `node:*` built-ins and the `typebox` peer — **no sibling imports, no `packages/core/lib`**

This self-containment rule is mechanically enforced by `packages/core/verify.mjs` and is what makes `npm run extract -- <name>` a 5-minute job.

## Skills and prompts

Skills (`packages/kit/skills/*/SKILL.md`) are markdown instruction sets loaded by pi as context. Prompts (`packages/kit/prompts/*.md`) are invocable via `/` commands. Neither is TypeScript code — they are pure knowledge/behaviour documents.

## Profiles

Profiles (`packages/kit/profiles/*.json`) are lists of extension names, plus optional skill and prompt filters. The installer applies a profile by registering the kit with pi and writing `extensions` / `skills` / `prompts` filters on the kit's package entry in pi's settings. Profile files never change shape as extensions move between avenues. The `lite` profile uses `skills.only` / `prompts.only` allowlists for small models.

## Distribution

`packages/core/distribution.json` sets how the kit reaches users. Today it is **git**: pi installs the repository from the private GitLab, `latest` is the newest `vX.Y.Z` tag and `next` is `main`. **npm** (dist-tags of `@satunix/pi-system`, published from GitHub Actions with trusted publishing and provenance) is built but paused. The installer, `/profile` and the `kit-update` extension (`/update`) all read the setting. See `docs/releasing.md` and `docs/updates.md`.

## Toolchain

`packages/core/` is the toolchain only — never imported at extension runtime:
- `install.mjs` — installs the kit + profile, from a checkout or as a release (git or npm; also the package's `npx` entry point)
- `lib/distribution.mjs` — reads `distribution.json`; git sources, release tags and channels
- `release.mjs` / `release-notes.mjs` / `gitlab-release.mjs` — cut a release; its notes; the GitLab Release (via the Releases API)
- `pack-check.mjs` — checks the npm tarball; `publish-plan.mjs` / `snapshot-version.mjs` pick the npm version and dist-tag; `lockfile-check.mjs` checks lockfile integrity
- `verify.mjs` — the static gate: schema + tsc + self-containment + collision + profile/manifest
  drift + stub quarantine + firewall policy + security parity + catalogue/matrix drift + docs
  nav. **Every check has a worked failure example in `WRITING_EXTENSIONS.md`.**
- `registry.mjs` / `skills-catalogue.mjs` / `capability-matrix.mjs` — generate the catalogues
- `docs-nav-check.mjs` — offline `mkdocs build --strict` stand-in
- `eval/` — the offline behavioural fixture harness (`npm run eval`)
- `dream.mjs` — offline dream-mode pass (allowlisted internal state only)
- `new-extension.mjs` / `extract-extension.mjs` — scaffolding helpers
- `lib/` — shared toolchain utilities

Static checks (`verify`) + behavioural checks (`eval`, `test:security`) + docs checks
(`smoke:docs`, `docs:check`) together form the release gate. See `WRITING_EXTENSIONS.md` for the
full check list and `docs/roadmap.md` for the current plan. `PI_KIT_REPO_PLAN.md` is the
(superseded) original design rationale.
