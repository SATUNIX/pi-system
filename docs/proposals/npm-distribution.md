# Proposal: npm distribution for pi-system

Status: **superseded** (2026-09-24). This assessment predates the decision to publish one
package: pi-system now ships as one package with `lite` as a profile, delivered from its git
repository (release tags and `main`), with npm delivery built but paused. See
[Releasing](../releasing.md) and [Profiles](../profiles.md). Kept for its research.
Scope: decide whether and how to publish pi-system packages to npm (public or a private
GitLab registry), simplify install to `pi install npm:@satunix/…`, and automate publishing
from GitLab CI.

Investigation method: read the installed pi 0.79.4 package-manager source, ran npm 11.11.0
pack experiments, audited every vendored extension's provenance, and evaluated the GitLab
registry/CI path. Findings are cited inline.

---

## 1. Recommendation (short version)

Adopt the **generated surface package** model:

- Extend the existing `packages/core/export-package.mjs` generator to emit a self-contained
  npm package for the full kit and for each profile/surface.
- Publish `@satunix/pi-system` (full), `@satunix/pi-system-lite`, and
  `@satunix/pi-{quick,balanced,long-horizon,autonomous,self-improving,engagement}`.
- Consumers install with one command: `pi install npm:@satunix/pi-balanced`. No post-install
  settings rewriting, no installer, no cross-package bundling.

This is **medium difficulty, not a core rewrite**. The generator already produces the right
artifact shape (validated: `dist/pi-kit-lite` packs to 97 files / 110 KB with `LICENSE`,
`README`, docs, extensions, skills, prompts, themes). The hard parts are provisioning and
process, not runtime plumbing:

1. **Vendored licensing compliance** — currently missing and blocking for any public publish.
2. **Correct `files` sets** — runtime `.ts`/`.md`/`.json` assets must survive packing.
3. **CI publish correctness** — auth, ordering, idempotency.
4. **Private-registry consumer auth** — per-consumer `~/.npmrc` tokens, which partially
   defeats the "simplify install" goal; public npm avoids it.

If the code must stay private, the same model works against a GitLab Package Registry, but
consumers each need a read token. **Recommendation: publish publicly to npmjs.com if the
vendored attribution is cleaned up and the code can be public; otherwise use the GitLab
registry with a documented token setup.**

`@satunix/pi-core` should **not** be published as a consumer CLI: its path model is
monorepo-bound (§4.6) and making it work installed is the largest refactor for the least
value. Keep it as dev tooling, or ship a thin published CLI later if a scripted installer is
still wanted.

---

## 2. How pi consumes npm packages (verified in 0.79.4)

Source: `@earendil-works/pi-coding-agent/dist/core/package-manager.js`.

- `pi install npm:@scope/pkg@ver` installs into `~/.pi/agent/npm/node_modules/<name>`
  (`getManagedNpmInstallPath`, ~1628–1651) and runs
  `npm install <spec> --prefix <installRoot> --legacy-peer-deps`
  (`getNpmInstallArgs`, 1426–1451). Project scope (`-l`) uses `.pi/npm/`.
- **Dependencies are installed automatically.** A lockfile is written by npm but never read
  by pi; updates re-resolve via `npm view`.
- **Resource discovery** (`collectPackageResources`, 1706–1835): the package's
  `package.json.pi` manifest globs are resolved relative to the package root. Conventional
  dirs (`extensions/ skills/ prompts/ themes/`) are used only when there is no manifest.
- **`node_modules/<dep>/...` manifest entries work** because explicit manifest paths bypass
  the `node_modules` skip that convention discovery applies. A nested pi package's *own*
  manifest is generally **not** read — the parent must enumerate the exact paths.
- **Settings filters** (`{source, extensions, skills, prompts, themes}`) only **narrow** what
  a package already exposes; they cannot add files. Patterns are relative to the package
  root; `!pattern` excludes, `+path` force-includes, `-path` force-excludes (`applyPatterns`,
  540–590).
- **Identity/dedup**: npm packages are identified as `npm:<name>` (version ignored); project
  scope wins over user scope; duplicate entries keep the first.
- **Tool collisions are diagnostics, not errors**: first extension wins, later ones are
  shadowed (`resource-loader.js detectExtensionConflicts`, 773–808). This is why installing
  two overlapping packages is harmful rather than fatal.
- **`pi update`**: exact npm versions are treated as pinned and skipped; non-pinned specs are
  updated to the latest satisfying version.
- pi reads `.gitignore`/`.ignore`/`.fdignore` at runtime, **not** `files`/`.npmignore` — those
  only control what is in the published tarball.

**Consequence:** a single self-contained package with a `pi` manifest is the simplest and
most reliable unit. Filtering-based profiles require an installer; package-per-profile does
not.

---

## 3. npm/workspaces publishing mechanics (verified with npm 11.11.0)

- Current `npm pack --dry-run` output:

  | package | files | packed | notes |
  |---|---|---|---|
  | `@satunix/pi-core` | 38 | 62 KB | ships `eval/`; no README/LICENSE |
  | `@satunix/pi-extensions` | 136 | 150 KB | ships `src/_template`; no README/LICENSE |
  | `@satunix/pi-kit` | 98 | 42 KB | no README/LICENSE |

  No `node_modules` leak, but also **no `README`/`LICENSE`** inside any package (the root
  LICENSE is not included), and no `files` control.
- `files` is an authoritative allowlist that supports `!negation` and overrides `.gitignore`;
  `.npmignore` is a denylist and does not disable the root `.gitignore`.
- **`workspace:` protocol is not supported by npm 11** (`EUNSUPPORTEDPROTOCOL`). npm does not
  rewrite workspace deps to concrete versions at pack time. Use explicit semver ranges
  (`*`/`^x.y.z`) and publish dependencies first.
- **Workspace symlinks are not bundled.** `bundledDependencies: ["@satunix/x"]` on a workspace
  sibling produces an empty bundle unless `@satunix/x` is installed from the registry as a
  real directory first. This is the decisive reason to prefer **copying** resources into
  generated surface packages over bundling sibling packages.
- `npm publish --workspaces` iterates **alphabetically, not topologically**, and does not
  validate that dependencies already exist. Use an explicit ordered loop plus a
  version-exists pre-check for idempotency.
- Scoped packages need `--access public` or `publishConfig.access`; private workspaces are
  skipped with a warning.

---

## 4. Constraints and current-code issues

### 4.1 Profile selection
Profiles (`packages/kit/profiles/*.json`) currently narrow a single locally installed package
by rewriting the settings entry (`install.mjs` → `settings.mjs mergePackageBlock`). Under npm
this still works for one package, but it spans multiple packages if the catalogue is split.
The generated-surface model removes the need entirely.

### 4.2 Runtime assets and `files`
A naive `files` list (only `index.ts`/`extension.json`/`README.md`) would drop runtime assets
that are read from the package dir:
`src/verifier-board/todo-read.ts`, `src/verify-gate/todo-read.ts`,
`third_party/subagent/agents.ts`, `third_party/todo/todo-file.ts`,
`third_party/custom-footer/todo-read.ts`, `src/orchestrator/agents/*.md`,
`src/conductor/agents/validator.md`, and `src/conductor/{synth,validate}/*.ts`.
`files` must use `**/*.ts`, `**/*.md`, `**/*.json` per tree, plus `!src/_template/**`.

### 4.3 Vendored licensing (blocking for public publish)
All 13 `third_party` extensions lack a `LICENSE`/`NOTICE`; 11 are MIT-derived from
`@earendil-works/pi-coding-agent` examples (two are explicit verbatim copies:
`git-checkpoint`, `subagent`). MIT requires the copyright and permission notice to be
included with copies, so **publishing now would violate the upstream terms.**
- Required: a per-package `LICENSE` naming both the upstream copyright and SATUNIX, and a
  `THIRD_PARTY_NOTICES.md` consolidated from the 13 `SOURCE.md` files.
- `custom-compaction` is misclassified: `SOURCE.md` says "written from scratch", so it
  belongs in `packages/extensions/src/` and has no attribution obligation.
- `caveman` is the only non-pi upstream; its concept source's license is unstated. Confirm
  before publishing and credit both sources regardless.
- `pi-lean-ctx` is Apache-2.0 and external; if ever bundled it needs a NOTICE too.
- `export-package.mjs` copies the root SATUNIX `LICENSE` but does **not** generate an upstream
  NOTICE — that code path must be extended.

### 4.4 `extension.json` `$schema` paths
They point at `../../../core/schema/extension.schema.json` relative to the fixed monorepo
layout. Once extensions ship in a generated package (or a separate npm package), the schema
is not adjacent. Make the property package-relative or remove it from published copies.

### 4.5 Registry scope constraints
- GitLab requires a published npm scope to match the project's **root namespace**. A
  `@satunix/*` scope needs a `satunix` root group.
- On npmjs.com, the `@satunix` scope must be owned/available.

### 4.6 `@satunix/pi-core` is monorepo-bound
`packages/core/lib/paths.mjs` derives `WORKSPACE_ROOT = core/../..` and expects sibling
`packages/*`; installed as a dependency it resolves under `node_modules/@satunix/packages/…`.
`verify.mjs`/`release.mjs`/`export-package.mjs` also read the workspace-root `package.json`.
Publishing core as a working CLI requires a path-model rewrite; publishing it as-is would ship
broken tooling.

### 4.7 Consumer registry auth
For a private registry, `pi install` runs npm with `--prefix ~/.pi/agent/npm`, so npm's
project `.npmrc` is `~/.pi/agent/npm/.npmrc`, and `~/.npmrc` is always read. Crucially,
`pi update` / `npm view` run from pi's cwd **without** `--prefix`, so registry config must
live in `~/.npmrc` to cover updates. There is no anonymous read for a private registry.

---

## 5. Options

### Option A — One bundle package `@satunix/pi-system`
Publish the monorepo root (or a generated full surface) as a single package with the current
root `pi` globs; profiles via a thin installer that writes settings filters.

- Effort: **low–medium**. Reuses the root `pi` manifest and generator.
- Pros: one install, one version, filtering already supported by pi.
- Cons: large tarball that must explicitly exclude `container`/`web-ui`; profile handling
  still needs an installer or manual settings; core tooling still monorepo-bound.

### Option B — Split catalogue packages + multi-package filter
Publish `@satunix/pi-extensions` (and optionally `@satunix/pi-extensions-vendored`) and
`@satunix/pi-kit`; the installer writes one filter entry per package for a profile.

- Effort: **medium**. The package manifests are already close (`pi.extensions` globs exist).
- Pros: clean provenance separation, smaller packages, independently installable.
- Cons: multiple install commands or a meta-package; installer/settings rework across
  packages; more publish surface to manage.

### Option C — Generated surface packages (recommended)
Extend `export-package.mjs` to emit one self-contained package per profile/surface. Each
package **copies** the selected resources and declares its own `pi` manifest, so there is no
sibling bundling and no settings rewriting.

- Effort: **low–medium**. The generator, manifests, install-surface tests, and lite surface
  already exist; this is an incremental extension.
- Pros: one-command install (`pi install npm:@satunix/pi-balanced`); no installer; no
  cross-package bundling trap; self-contained and auditable; lockstep versioning.
- Cons: resource text duplicated across tarballs (small: ~100–200 KB each); several packages
  to publish; installing two overlapping profile packages would shadow tools (document and
  guard, as today).

### Option D — Per-extension packages
43 packages plus profile meta-packages.

- Effort: **high**. Not recommended now; little benefit over Option C because pi cannot merge
  extensions across separately installed packages without collision management, and it
  multiplies versioning/CI.

---

## 6. Recommended architecture

```
source monorepo (private, dev)
  packages/core      → dev tooling (verify/release/export); NOT published as consumer CLI
  packages/extensions → src/ (first-party) + third_party/ (vendored, with NOTICE)
  packages/kit        → skills, prompts, profiles, themes, agents, surfaces
  packages/web-ui     → pi-console (private)
  packages/container  → container image (not npm)

generated + published (public npm or GitLab registry)
  @satunix/pi-system              full kit surface
  @satunix/pi-system-lite         existing lite surface
  @satunix/pi-quick               profile surface
  @satunix/pi-balanced            profile surface   ← e.g. pi install npm:@satunix/pi-balanced
  @satunix/pi-long-horizon        …
  @satunix/pi-autonomous          …
  @satunix/pi-self-improving      …
  @satunix/pi-engagement          …
```

Optional, if a catalogue layer is wanted: also publish `@satunix/pi-extensions` and
`@satunix/pi-kit` for users who prefer `pi config` over profiles.

Profiles become packaging choices, not settings mutations. `install.mjs` either becomes a
thin compatibility shim that maps `--profile balanced` → `pi install npm:@satunix/pi-balanced`
(plus `.env` scaffolding) or is retired.

---

## 7. What must change (concrete checklist)

**Packaging hygiene (any option)**
- [ ] Add `files`, `README.md`, `repository`, `keywords: ["pi-package"]`, and
      `publishConfig.access` to every publishable package.
- [ ] Include runtime assets with `**/*.ts` / `**/*.md` / `**/*.json`; exclude
      `src/_template/**`.
- [ ] Add a per-package `LICENSE` (root LICENSE is not packed automatically).
- [ ] Fix `extension.json` `$schema` references for published copies.

**Vendored compliance (public publish)**
- [ ] Generate `THIRD_PARTY_NOTICES.md` from the 13 `SOURCE.md` files; add the upstream MIT
      copyright line (from the pi-mono repository — it is not in the npm artifact).
- [ ] Move `custom-compaction` to `packages/extensions/src/`.
- [ ] Resolve the `caveman` upstream license question.
- [ ] Extend `export-package.mjs` to inject `LICENSE` + `NOTICE` into generated surfaces.

**Profile packaging (Option C)**
- [ ] Add surface definitions for each profile, or an `export-package --profile <name>` mode
      that reads `packages/kit/profiles/*.json`.
- [ ] Include `packages/kit/agents` in generated packages (currently only
      extensions/skills/prompts/themes/docs are copied).
- [ ] Keep `lite` and add a `full` surface.
- [ ] Decide external companion handling: keep separate `pi install npm:pi-…` steps, or
      materialize+bundle them at pack time (`npm install --omit=dev` in the surface dir).
      `pi-lean-ctx` cannot be fully npm (needs the `lean-ctx` binary) — treat as optional.

**Publishing / CI**
- [ ] `.npmrc` scope registry (private registry only); publish job on `v*` tags.
- [ ] Idempotent per-package publish loop with a version pre-check; `resource_group` to
      serialize.
- [ ] `prepublishOnly` runs the verify gate (or rely on the pipeline gate).
- [ ] Version bump via the existing `release.mjs` fixed-version flow; one tag = one version set.
- [ ] Add GitLab OIDC `id_tokens` + provenance if publishing to npmjs.com.
- [ ] Document consumer `~/.npmrc` setup for a private registry.

---

## 8. GitLab CI publish sketch (private registry)

```yaml
include:
  - project: root/ci-templates
    ref: main
    file: [/baseline.yml, /heavy.yml]

stages: [verify, publish]

publish:npm:
  stage: publish
  image: node:22.23.2-bookworm
  needs: [verify]
  resource_group: npm-publish
  before_script:
    - |
      set -eu
      cat > .npmrc <<EOF
      @satunix:registry=${CI_SERVER_PROTOCOL}://${CI_SERVER_HOST}/api/v4/projects/${CI_PROJECT_ID}/packages/npm/
      //${CI_SERVER_HOST}/api/v4/projects/${CI_PROJECT_ID}/packages/npm/:_authToken=${CI_JOB_TOKEN}
      EOF
  script:
    - npm ci --ignore-scripts --no-audit --no-fund
    - |
      set -eu
      for s in full lite quick balanced long-horizon autonomous self-improving engagement; do
        node packages/core/export-package.mjs --surface "$s"
      done
      for d in dist/*/; do
        (cd "$d" && npm install --omit=dev --no-audit --no-fund)  # materialize bundled externals
        name=$(node -p "require('./$d/package.json').name")
        ver=$(node -p "require('./$d/package.json').version")
        if npm view "$name@$ver" version >/dev/null 2>&1; then echo "skip $name@$ver"; continue; fi
        (cd "$d" && npm publish --access restricted)
      done
  rules:
    - if: $CI_COMMIT_TAG =~ /^v\d+\.\d+\.\d+$/
```

Notes: the auth key omits the scheme; `CI_JOB_TOKEN` publishes to the job's project and is not
usable by external consumers (document a read deploy token for them). `changes:` cannot gate
tag pipelines, so rely on the idempotent version pre-check.

---

## 9. Risks / open questions

- **Private registry friction**: per-consumer `~/.npmrc` token setup partly defeats the
  goal. Public npm gives zero-config installs and provenance but exposes all code and demands
  clean vendored licensing.
- **Scope ownership**: who owns `@satunix` on npm, and does the GitLab root group match?
- **Duplicate loading**: installing two profile packages (or a profile + catalogue package)
  shadows tools; document "one profile at a time" and optionally guard in the installer.
- **Non-atomic publish**: a mid-loop failure leaves partial versions. Mitigate with the
  version pre-check and re-runnable jobs; never `unpublish`.
- **Bundle/materialization**: externals with native deps must be installed before packing if
  they are to be bundled; otherwise they remain separate `pi install` steps.
- **Surface staleness**: generated packages must be regenerated from the tagged source in CI
  so they cannot drift.

---

## 10. Suggested migration phases

1. **Compliance + hygiene** (no behavior change): `files`/README/LICENSE, NOTICE generation,
   `custom-compaction` move, `$schema` fix. Verify gate stays green.
2. **Generator extension**: add `full` + per-profile surfaces and include `agents`.
3. **Dry-run publishing**: generate all surfaces and run `npm publish --dry-run` in CI
   (no registry writes) to validate tarballs.
4. **Registry + CI**: publish to the private registry on tags; document consumer auth.
5. **Simplify install**: retire or slim `install.mjs` to map profiles onto npm packages.
6. **Optional**: publish the catalogue packages (`pi-extensions`, `pi-kit`) and/or go public
   on npmjs.com with provenance.
