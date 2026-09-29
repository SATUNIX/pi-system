# Plan: `pi-kit` — an installable, git-tracked, **modular** extension kit for the `pi` coding agent

> **⚠️ Superseded (historical reference).** This is the original repo-design plan. Its
> principles (identity-by-name, self-containment, profiles, the verify gate) are all
> implemented and now live authoritatively in `docs/ARCHITECTURE.md`, `docs/MODULARITY.md`,
> `CONTRIBUTING.md`, and `docs/roadmap.md`. The current forward plan is
> `docs/roadmap.md` + `docs/improvement-roadmap.md` + the production-readiness plan
> ([`archive/LATEST_PLAN_2026-08-04T042958Z.md`](archive/LATEST_PLAN_2026-08-04T042958Z.md),
> superseded, kept for historical reference). Where this document disagrees with
> `docs/roadmap.md`, the roadmap wins. Kept for provenance only — do not treat as current.

**Goal.** A single repository you can clone (or point pi at locally) so that a *freshly installed* pi agent gains memory, self-verification, recovery, planning, safety guards, and long autonomous runs — with **one command** for the human and an **agent-readable install path** for pi itself. The repo is built to **grow with your experiments**: add an extension folder and it's tracked, validated, installable; pull in other people's extensions from their own repos; and split any extension out into its own repo later **without changing its code or your profiles**. Experimental loadouts live on branches.

This plan supersedes the install/copy approach in the earlier "Supercharge the local pi agent" plan. The *extensions themselves* (their behaviour and lifecycle hooks) are unchanged from that plan — this document is about **how they are packaged, validated, composed, and installed**.

---

## 1. Design principles — modularity & portability (read this first)

Everything below is shaped by six principles. They are repeated as callouts in the sections they govern so they don't live in the fine print.

1. **Identity = name, not location.** Every extension has one stable `name`. Profiles, the catalog, docs, and `pi config` all key on that name. *Where* the code lives — in this repo, vendored, or in someone else's repo — is a resolved implementation detail. This is what lets you relocate an extension without editing anything that refers to it.

2. **Every extension is self-contained at runtime (hard rule).** An extension may import only Node built-ins (`node:*`) and the bundled `typebox` peer. **No importing a sibling extension, and no importing `kit/lib/*`** (that's the toolchain, not runtime). If two extensions need the same helper, duplicate the few lines or publish the helper as its own tiny package. This single rule is what makes "extract to its own repo" a 5-minute job instead of a refactor — and it's enforced mechanically by the verify gate (§13, §16).

3. **Three ingestion avenues, one unified catalog.** Extensions reach the agent by one of three routes — **in-repo**, **vendored**, or **external** (which itself splits into *reference* and *bundle*). The toolchain treats all of them uniformly: one catalog, one validation pass, one install command. You choose the avenue per extension and can change it later.

4. **Profiles reference names; the resolver finds the code.** A profile is a list of extension *names*. `kit/lib/resolve.mjs` maps each name to wherever it currently lives. Move an extension between avenues and the profile is untouched.

5. **External sources are declarative.** Other people's repos (and your own split-out repos) are listed in one file — `kit/sources.json`. The installer reads it so a single `node kit/install.mjs --profile full` brings in the kit *and* its declared companions. "Unified in this repo" without copying everyone's code into it.

6. **Location is reversible.** in-repo ⇄ own-repo is a packaging change, never a code change, because of principles 1 and 2. The repo therefore supports three growth shapes with no rework: a monorepo of your extensions → that plus referenced/bundled third-party packages → a hub that mostly aggregates many small single-extension repos (yours and others').

### The three ingestion avenues at a glance

| Avenue | Lives in | Brought in by | Use when | You own |
|---|---|---|---|---|
| **In-repo** | `extensions/<name>/` | manifest glob | You author/iterate it here | the code |
| **Vendored** | `vendor/<name>/` + `SOURCE.md` | manifest glob | You must *modify* upstream (e.g. Windows fixes to pi's official examples) | a pinned fork |
| **External · reference** | its own repo | `kit/sources.json` → installer runs `pi install git:…` as a sibling package | You want it as-is and auto-updatable; **your preference for other people's per-extension repos** | nothing (pinned ref) |
| **External · bundle** | its own repo, embedded at publish | `dependencies` + `bundledDependencies` + manifest `node_modules/...` glob | You want `pi install pi-kit` to pull it transitively | a pinned embed |

> pi loads every package under a **separate module root**, so mixing your code, vendored forks, and multiple external packages never causes module collisions or shared-state bugs. Modularity is the grain of the tool, not something we're fighting.

---

## 2. The repo **is** a pi package

pi has a first-class package system. A package declares its resources under a `pi` key in `package.json` (or relies on convention directories `extensions/ skills/ prompts/ themes/`), and is installed with `pi install`. This gives us "clone and it installs everything" natively, so we build *with* the grain instead of hand-rolling a copier.

> **Modularity callout:** because the repo is a *package* and pi composes packages, your kit is itself just one composable unit. Other packages (external extensions) sit alongside it as peers; nothing about being "the main repo" makes it a monolith.

> **Security note (your threat model):** pi packages run with **full system access** — extensions execute arbitrary code and skills can instruct the model to run anything. The kit keeps clear provenance per avenue (`extensions/` = yours, `vendor/` = pinned fork with `SOURCE.md`, `kit/sources.json` = reviewed external refs), a schema-validated manifest per extension, and a verify gate in CI. Review-before-install is a first-class workflow.

### The four install paths the repo must support

| # | Path | Command | When |
|---|------|---------|------|
| 1 | **Local, editable (primary)** | `pi install /abs/path/to/pi-kit` | Daily driver. pi references the repo **in place — no copy** — edit, `/reload`, live. Git tracks the one canonical source. |
| 2 | **Git, portable** | `pi install git:github.com/SATUNIX/pi-kit@v0.1.0` | Other machines / clean installs. Clones to `~/.pi/agent/git/...`, pins the ref, runs `npm install`. |
| 3 | **Project auto-install (agent-driven)** | ship `.pi/settings.json` in a repo → open pi there | pi auto-installs missing packages on first trusted startup. The literal "a fresh pi agent sees it and installs as needed." |
| 4 | **Try-before, no install** | `pi -e ./pi-kit` / `pi -e git:...` | Smoke-test a branch in a throwaway run. |

The **scripted installer** (`install.ps1` / `install.sh` → `kit/install.mjs`) wraps paths 1–2, adds dependency preflight, profile selection, **companion-source installation** (§5/§8), `.env` scaffolding, and a printed "what to start next" summary. It drives pi's own CLI (`pi install`, `pi config`) rather than hand-editing settings.

---

## 3. Repository layout

```
pi-kit/
├── package.json                 # the pi manifest (declares loaded resources + deps + bundles)
├── tsconfig.json                # for `tsc --noEmit` verification only (pi runs .ts directly)
├── README.md                    # human quick-start (the 4 install paths)
├── AGENTS.md                    # agent-facing install instructions
├── CONTRIBUTING.md              # branch strategy, the per-extension contract, split-out guide
├── LICENSE
├── .gitignore                   # ignores .env, node_modules/, *.local
├── .env.example
│
├── extensions/                  # AVENUE 1 — your in-repo extensions, one folder each
│   ├── _template/               #   copy-me starter (index.ts + extension.json + README.md)
│   ├── secret-guard/
│   │   ├── index.ts             #   entry (pi loads this)
│   │   ├── extension.json       #   metadata: name(identity), hooks, deps, profiles, pulls
│   │   └── README.md
│   ├── guidelines/  spec-plan/  memory-local/  memory-mem0/
│   ├── verify-gate/  autonomous-loop/  dual-review/
│
├── vendor/                      # AVENUE 2 — adapted upstream, provenance preserved
│   ├── git-checkpoint/          #   each folder has SOURCE.md: upstream path + commit + your edits
│   ├── auto-commit-on-exit/  notify/  protected-paths/  dirty-repo-guard/
│   ├── trigger-compact/  custom-compaction/  todo/  handoff/  custom-footer/
│   ├── plan-mode/  subagent/    #   multi-file upstream dirs; entry = index.ts
│
├── kit/
│   ├── sources.json             # AVENUE 3 — declared external repos (reference + bundle)
│   ├── install.mjs              # resolve profile → register kit → install companions → filter → summary
│   ├── uninstall.mjs
│   ├── verify.mjs               # schema-validate + tsc --noEmit + SELF-CONTAINMENT lint + name-collision check
│   ├── registry.mjs             # aggregate all avenues → docs/EXTENSIONS.md + registry.json
│   ├── new-extension.mjs        # scaffold from _template
│   ├── extract-extension.mjs    # turn extensions/<name>/ into a standalone-repo-ready package
│   ├── schema/
│   │   ├── extension.schema.json
│   │   └── sources.schema.json
│   └── lib/                     # TOOLCHAIN ONLY — never imported by an extension at runtime
│       ├── deps.mjs             #   preflight: node, git, pi, (docker, lmstudio if needed)
│       ├── settings.mjs         #   locate + safely merge ~/.pi/agent or .pi settings
│       ├── sources.mjs          #   read/resolve kit/sources.json
│       └── resolve.mjs          #   name → location (in-repo | vendor | external)
│
├── profiles/                    # name-based resource sets (source-agnostic)
│   ├── minimal.json  balanced.json  full.json
│
├── infra/                       # out-of-process deps (NOT loaded by pi)
│   └── mem0/  (docker-compose.yml, mem0.config.json, README.md)
│
├── .github/workflows/ci.yml     # runs kit/verify.mjs on push/PR (adversarial gate)
└── docs/
    ├── ARCHITECTURE.md  INSTALL.md  WRITING_EXTENSIONS.md
    ├── MODULARITY.md            # the three avenues + the split-out procedure (principle 1–6)
    ├── EXTENSIONS.md            # GENERATED catalog across all avenues (do not hand-edit)
    └── LMSTUDIO.md
```

> **Modularity callout:** the three avenues are physically separated (`extensions/`, `vendor/`, `kit/sources.json`) so provenance is obvious at a glance, but `kit/registry.mjs` unifies them into one catalog. `kit/lib/` is fenced off as toolchain to keep principle 2 honest.

**Convention:** one extension = one folder, stable entry `index.ts`, `extension.json` sibling (metadata; ignored by pi's loader), `README.md`. Multi-file extensions keep helpers beside `index.ts`.

---

## 4. The package manifest (`package.json`)

Makes the repo installable and declares everything pi loads, every dependency, and every **bundled** external package. Explicit globs remove nested-discovery ambiguity.

```jsonc
{
  "name": "@satunix/pi-kit",
  "version": "0.1.0",
  "description": "Modular all-rounder pi extension kit: memory, verification, autonomy, planning, safety.",
  "keywords": ["pi-package", "pi-extension"],
  "type": "module",
  "license": "MIT",

  "pi": {
    "extensions": [
      "extensions/*/index.ts",                       // AVENUE 1: in-repo (yours)
      "vendor/*/index.ts",                           // AVENUE 2: vendored/adapted
      "node_modules/@satunix/pi-ext-*/extensions/*.ts", // AVENUE 3-bundle: your split-out repos
      "node_modules/their-ext/extensions/*.ts",      // AVENUE 3-bundle: someone else's
      "!extensions/_template/index.ts"
    ],
    "skills": ["skills/**"],
    "prompts": ["prompts/*.md"]
  },

  // pi BUNDLES these — never bundle yourself; pin "*".
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*",
    "typebox": "*"
  },

  // AVENUE 3-bundle: external packages that should travel WITH `pi install pi-kit`.
  // (Reference-mode externals are NOT here — they install as siblings via kit/sources.json.)
  "dependencies": {
    "their-ext": "github:them/their-ext#v2"
  },
  "bundledDependencies": ["their-ext"],

  // Dev-only: validation + type-check. Not shipped (pi installs --omit=dev).
  "devDependencies": { "typescript": "^5.4.0", "ajv": "^8.12.0" },

  "scripts": {
    "verify":  "node kit/verify.mjs",
    "catalog": "node kit/registry.mjs --write-docs",
    "new":     "node kit/new-extension.mjs",
    "extract": "node kit/extract-extension.mjs"
  }
}
```

> **Modularity callout:** the `pi.extensions` array is the single switchboard for which avenues are live. Bundled externals appear here via `node_modules/...`; referenced externals deliberately do **not** (they're peers, installed alongside). The `dependencies` value `github:user/repo#ref` is how a *bundled* external — including one of your own split-out repos — gets embedded and pinned.

**Discovery fallback (verify in Phase 0):** if pi's glob won't descend into `*/index.ts`, switch to flat files (`extensions/<name>.ts`) with metadata in `kit/meta/<name>.json`. Folder-per-extension is preferred for docs/growth; `pi list` on first install confirms discovery.

---

## 5. Per-extension contract

Every extension folder (any avenue) carries an `extension.json` validated against `kit/schema/extension.schema.json`. This is the machine-readable answer to *"list the deps and what gets pulled,"* and the unit the catalog/installer/resolver operate on.

> **Modularity callout (the hard rule):** at runtime an extension imports **only** `node:*` built-ins and the `typebox` peer. No sibling imports, no `kit/lib` imports. `kit/verify.mjs` parses each entry's imports and **fails the build** on any violation — so principle 2 is mechanically guaranteed, not just documented. This is the precondition for painless extraction to a standalone repo.

### `extension.json` (example: `extensions/secret-guard/extension.json`)
```jsonc
{
  "$schema": "../../kit/schema/extension.schema.json",
  "name": "secret-guard",                 // <- IDENTITY (stable across avenues)
  "summary": "Blocks write/edit/bash that touches or commits secrets (.env, *.key, *.pem, *credentials*).",
  "category": "safety",
  "entry": "index.ts",
  "hooks": ["tool_call"],
  "registers": { "tools": [], "commands": [] },
  "profiles": ["minimal", "balanced", "full"],
  "enabledByDefault": true,
  "platforms": ["windows", "linux", "darwin"],
  "runtime": {
    "nodeBuiltins": ["node:path"],
    "npm": [],                            // pulled by `npm install` — kept empty across the kit
    "piPeers": ["typebox"],
    "services": [],
    "models": []
  },
  "pulls": [],
  "env": [],
  "provenance": { "origin": "custom" },   // custom | vendored | external
  "homeRepo": null,                       // set to the URL once/if extracted to its own repo
  "status": "stable"                      // stable | beta | experimental
}
```

**Schema essentials:** `required` = name, summary, category, entry, hooks, profiles, platforms, runtime, status. `category` ∈ safety|workflow|planning|memory|execution|ui. `hooks` ∈ the seven lifecycle events. `provenance.origin` ∈ custom|vendored|external. `homeRepo` records the standalone repo when an extension has been (or will be) split out — the resolver and catalog use it to show where the canonical source lives.

> Contract-before-code: the schema, the self-containment lint, and the verify step exist **before** any extension does — mirroring your spec-first/validator-first pattern.

---

## 6. Ingestion avenues for external & upstream extensions (the modular core)

This is how "other people's extensions in their own repos" stay unified with the kit without being copied into it.

### `kit/sources.json` — one declarative registry of external repos
```jsonc
{
  "external": [
    {
      "name": "fancy-reviewer",            // identity, same namespace as in-repo names
      "mode": "reference",                  // reference | bundle
      "source": "git:github.com/someone/pi-fancy-reviewer@v2.1.0",
      "provides": ["fancy-reviewer"],       // extension names this package exposes
      "profiles": ["full"],
      "review": "audited 2026-06-17 @ <commit>"   // your provenance note
    },
    {
      "name": "mem-advanced",
      "mode": "reference",
      "source": "git:github.com/SATUNIX/pi-ext-mem-advanced@v1.0.0",  // YOUR split-out repo
      "provides": ["mem-advanced"],
      "profiles": ["full"]
    }
  ]
}
```

- **Reference mode (your default for others' repos):** the installer runs `pi install git:…@ref` so the external package installs as a **sibling** of the kit. It updates independently via `pi update`, and you never embed its code. The kit "knows about it" through `sources.json` + profiles, so install stays one command.
- **Bundle mode:** for externals you want to travel *inside* `pi install pi-kit` (e.g. a dependency you've pinned and want reproducible). Listed additionally in `package.json` `dependencies` + `bundledDependencies` and exposed via the manifest glob. `kit/verify.mjs` cross-checks that every `bundle`-mode entry in `sources.json` is also declared in `package.json`.

> **Modularity callout:** `kit/registry.mjs` reads `extensions/`, `vendor/`, **and** `sources.json` and produces one `docs/EXTENSIONS.md`. A reader (or the agent) sees every capability in one catalog regardless of avenue. Name-collision across avenues is a verify error.

### Splitting one of *your* extensions out into its own repo (later)
Because of principles 1–2 this is mechanical:
```
npm run extract -- secret-guard            # kit/extract-extension.mjs
```
The helper: copies `extensions/secret-guard/` into a new staging package with its own `package.json` (the `pi` manifest, the same `peerDependencies`, the `pi-package` keyword), sets `homeRepo`, and prints the next steps:
1. `git init` the new repo, push it (e.g. `github.com/SATUNIX/pi-ext-secret-guard`).
2. In pi-kit, either **reference** it (add to `sources.json`, remove the in-repo folder) or **bundle** it (`dependencies` + `bundledDependencies` + manifest glob).
3. **Profiles need no change** — they still list the name `secret-guard`; the resolver now finds it via `sources.json` instead of `extensions/`.

> This is the payoff of "identity = name": relocation touches packaging files only. Nothing that *refers* to the extension changes.

### Choosing an avenue (rule of thumb)
- Authoring/iterating fast → **in-repo**.
- Must modify upstream → **vendor** (with `SOURCE.md`).
- Someone else's repo, want it as-is + auto-updates → **reference**.
- Need it embedded/reproducible inside the kit install → **bundle**.

---

## 7. Profiles (source-agnostic by design)

A profile is a named list of extension **names** — never paths. `kit/lib/resolve.mjs` maps each name to its current location (in-repo → vendor → external via `sources.json`), erroring on unresolved or duplicate names.

`profiles/balanced.json` (your default):
```jsonc
{
  "name": "balanced",
  "description": "Per-turn checkpoints, auto-commit, verification feedback, local memory, guards ON. Autonomous loop installed, manual-launch.",
  "include": [
    "secret-guard", "guidelines", "spec-plan", "memory-local", "verify-gate", "autonomous-loop",
    "git-checkpoint", "auto-commit-on-exit", "notify", "protected-paths",
    "trigger-compact", "todo", "custom-footer", "handoff"
  ]
}
```

| Profile | Adds on top of previous | Purpose |
|---|---|---|
| `minimal` | secret-guard, protected-paths, git-checkpoint, auto-commit-on-exit, todo, notify | Safe, durable, no model-side overhead. |
| `balanced` *(default)* | + guidelines, spec-plan, memory-local, verify-gate, autonomous-loop (manual), trigger-compact, custom-footer, handoff | Everyday long-horizon driver. |
| `full` | + memory-mem0 (Docker), dual-review, dirty-repo-guard, custom-compaction, plan-mode, subagent, + any `full`-tagged externals from `sources.json` | Max capability; needs Docker + a second LM Studio model. |

> **Modularity callout — how profiles shape-shift safely:** today a profile resolves to extensions inside one package, applied via a single settings filter / `pi config` sweep. Once you split extensions into separate packages, the *same* name list resolves across **multiple package sources**, and the installer applies it as a `packages` array (one entry per source, each filtered). The profile file you edit by hand never changes shape — only the resolver's output does. Build the resolver multi-source from day one so this is a no-op when you start splitting repos.

---

## 8. The scripted installer (`kit/install.mjs`)

Cross-platform Node (you have Node 24). `install.ps1` / `install.sh` are thin bootstraps that locate Node and exec `kit/install.mjs`.

**Flags:** `--profile <minimal|balanced|full>` (default balanced), `--only <names>`, `--all`, `--scope <global|project>` (default global), `--mode <local|git>` (default local), `--git-ref <ref>`, `--with-externals` / `--no-externals` (default: install declared companions), `--yes`, `--dry-run`, `--uninstall`.

**Algorithm (idempotent / reconciling):**
1. Resolve desired name set from `--profile`/`--only`/`--all`.
2. **Resolve each name** via `kit/lib/resolve.mjs` → tag as in-repo, vendored, or external(reference|bundle). Unresolved/duplicate ⇒ hard error.
3. **Preflight** (`kit/lib/deps.mjs`): require node, git, pi. For the *selected* set only, check optional deps — Docker (if any `services.via==docker`), LM Studio (if any `models`). Optional deps **warn, never fail**.
4. **Validate + smoke** (`kit/verify.mjs`): schema, `tsc --noEmit`, self-containment lint, collision check. Fail fast before touching config.
5. **Register the kit:** local → `pi install <repoRoot>` (`-l` for project scope); git → `pi install git:<url>@<ref>`.
6. **Install companion externals** (unless `--no-externals`): for each selected **reference**-mode entry in `sources.json`, run `pi install <source>` as a sibling. Bundle-mode externals come in with the kit automatically.
7. **Apply the profile** — choose one:
   - *Declarative (preferred):* write/merge a single **managed** `packages` block (keyed per source) setting each source's `extensions` filter to its resolved entries. Re-running replaces only the managed block.
   - *Native toggles:* `pi config disable extension <name>` for everything not in the profile.
8. **Scaffold env:** copy `.env.example` → `~/.pi/agent/.env` if absent (never overwrite); print vars to fill.
9. **Summary:** installed extensions grouped by avenue + category; companion packages installed; services to start (`docker compose -f infra/mem0/docker-compose.yml up -d` if mem0 selected); LM Studio models to load; next steps (`pi`, `/reload`, the §12 checklist).
10. `--uninstall`: `pi remove` the kit + each managed companion source, strip the managed block, remove the state marker.

State marker `~/.pi/agent/.pi-kit.json` records `{ kitSource, profile, resources, companions[], mode, ref }` so uninstall/reconcile is surgical and never touches packages you installed by hand.

---

## 9. Agent-driven install (`AGENTS.md` + project auto-install)

**A. Context file at repo root** — `AGENTS.md` gives the agent deterministic commands:
```markdown
# pi-kit — install instructions for the agent
This repository is a modular pi extension kit. To install:
- Default (balanced, global):      node kit/install.mjs --profile balanced --yes
- Specific extensions only:        node kit/install.mjs --only secret-guard,memory-local,verify-gate --yes
- Everything incl. external repos:  node kit/install.mjs --all --yes
After install, tell the user to start `pi` and run `/reload`.
Do NOT enable memory-mem0 or dual-review unless Docker / a second LM Studio model is confirmed.
External extensions are installed from the repos listed in kit/sources.json — review before enabling.
Never write or commit secrets; secret-guard enforces this.
```

**B. Project auto-install** — a `.pi/settings.json` in any working repo makes pi pull + apply the kit (and, if referenced there, companion packages) on first **trusted** startup:
```jsonc
{
  "packages": [
    { "source": "git:github.com/SATUNIX/pi-kit@v0.1.0",
      "extensions": ["extensions/*/index.ts", "vendor/*/index.ts", "!extensions/_template/index.ts"] },
    { "source": "git:github.com/someone/pi-fancy-reviewer@v2.1.0" }   // an external, per-project
  ]
}
```
> First trusted startup triggers pi's trust prompt (`~/.pi/agent/trust.json`). For CI: `GIT_TERMINAL_PROMPT=0`, a `BatchMode` `GIT_SSH_COMMAND`, and pre-seeded trust.

> **Modularity callout:** per-project settings can mix the kit with project-specific external packages — so a given engagement can pull extra extensions that never touch your global setup.

---

## 10. Dependency & "what gets pulled" matrix

The kit stays **near-zero-dependency**: pure Node built-ins + the `typebox` peer pi already bundles. Only the optional mem0 upgrade, dual-review, and any external packages reach outside.

| Extension | Avenue | npm pulled | Service | LM Studio model |
|---|---|---|---|---|
| secret-guard / guidelines / spec-plan | in-repo | — | — | — |
| memory-local | in-repo | — | — | embedding model |
| verify-gate / autonomous-loop | in-repo | — | — | — |
| dual-review | in-repo | — | — | 2nd code model |
| memory-mem0 | in-repo | — | **Docker:** Qdrant + mem0 | embedding model |
| vendor/* | vendored | — | — | — |
| *(reference externals)* | external | per their `package.json` (pi runs `npm install`) | per their docs | per their docs |
| *(bundle externals)* | external | embedded + their transitive deps | per their docs | per their docs |

> **Modularity callout:** the kit's own `dependencies` stays empty *except* for bundle-mode externals (each a pinned `github:user/repo#ref`). Reference-mode externals carry their own deps and are pi's problem to `npm install`, not yours. So adding someone's extension never bloats the kit's dependency surface unless you deliberately bundle it.

`peerDependencies` = `typebox` + pi core (bundled by pi). `devDependencies` = `typescript`, `ajv` (verification only). Real downloads: the two Docker images **iff** `memory-mem0`, plus whatever any enabled external package pulls.

---

## 11. Growth, branching & the split-out path

**Add an in-repo extension:**
```
npm run new -- my-extension        # scaffolds extensions/my-extension/{index.ts,extension.json,README.md}
# implement; fill extension.json
npm run verify                     # schema + tsc + self-containment + collisions
npm run catalog                    # regenerate docs/EXTENSIONS.md
git add . && git commit
```
The manifest glob picks it up on next `pi update`/`/reload`; add its name to a profile to install by default.

**Bring in someone's extension:** add an entry to `kit/sources.json` (reference or bundle), `npm run verify`, `npm run catalog`, add the name to a profile. Done — no code copied for reference mode.

**Split your extension into its own repo:** `npm run extract -- <name>` (§6), push the new repo, switch its `sources.json`/manifest entry. Profiles unchanged.

**Branch strategy (CONTRIBUTING.md):**
- `main` — stable; `verify` green; profiles reference only stable/beta resources.
- `experimental/<agent-name>` — a full agent loadout you're trialling (e.g. `experimental/redteam-runner`). A project's `.pi/settings.json` can pin the kit `@<branch-or-commit>` to run that agent without disturbing `main`.
- Tag releases (`v0.1.0`…) so git installs and project settings pin a known-good ref; `pi update` reconciles to it.

> **Modularity callout:** the three growth shapes (monorepo → monorepo + externals → aggregation hub) all use this same workflow. You never "migrate the repo"; you change avenues per extension when it suits the experiment.

---

## 12. Verification (end-to-end smoke, after every phase)

1. **Package loads:** `pi install <repoRoot>`, `pi list` shows the kit; startup lists every expected extension (confirms the glob; else apply §4 fallback).
2. **External sources resolve:** `node kit/install.mjs --all --dry-run` lists in-repo + vendored + external; each `sources.json` ref clones/pins cleanly.
3. **Profile applied:** enabled set == profile; out-of-profile disabled.
4. **Safety:** agent tries to write `.env` → secret-guard blocks. Edit → git-checkpoint stashes; auto-commit-on-exit commits on quit.
5. **Memory (local):** state "we use pnpm", restart, confirm recall; `/mem-search pnpm` returns it.
6. **Verify-gate:** agent introduces a type error → gate feeds failure back → self-correct.
7. **Autonomous loop:** `/loop "build a small CLI todo app with tests" --max-iterations 5` → iterates, commits, stops on `TASK COMPLETE`/cap; `/cancel-loop` halts.
8. **mem0 (full):** `docker compose -f infra/mem0/docker-compose.yml up -d`, `PI_KIT_MEMORY_BACKEND=mem0`, confirm local-only reads/writes (Qdrant has points).
9. **CI gates:** `kit/verify.mjs` green — schema, `tsc --noEmit`, **self-containment lint**, **name-collision check**, **sources/manifest cross-check**.
10. **Clean uninstall:** `--uninstall` removes the kit + companions + managed block; hand-installed packages untouched.

---

## 13. Build order (phased; natural stop points)

- **Phase 0 — Skeleton + install spine + modularity contracts.** `package.json` manifest, `tsconfig`, `_template/`, `extension.schema.json`, `sources.schema.json`, `kit/verify.mjs` (incl. self-containment lint + collision check), `kit/lib/resolve.mjs` (**multi-source from day one**), `kit/install.mjs` (local mode, balanced, companion-aware), bootstraps, `README`, `AGENTS.md`, `MODULARITY.md`, `.env.example`, CI. **Gate:** `pi install <repoRoot>` works against an empty extension set; `pi list` shows it; verify is green.
- **Phase 1 — Safety & workflow (pure, in-repo + vendored).** secret-guard, guidelines, spec-plan + vendor git-checkpoint, auto-commit-on-exit, notify, protected-paths, todo, custom-footer, handoff, trigger-compact. Add one at a time, `/reload`-test. **Gate:** §12 steps 1, 3, 4.
- **Phase 2 — Local memory.** memory-local. **Gate:** §12 step 5.
- **Phase 3 — Long-horizon execution.** verify-gate, then autonomous-loop. **Gate:** §12 steps 6–7.
- **Phase 4 — External sources support.** Wire `kit/sources.json` end-to-end: reference-mode install of one real external package, `registry.mjs` unified catalog, `extract-extension.mjs`. Split one of your own extensions out as a dry run. **Gate:** §12 step 2 + a successful extract+reference round-trip with profiles unchanged.
- **Phase 5 — Heavy upgrades (full profile).** infra/mem0 + memory-mem0, dual-review, dirty-repo-guard, custom-compaction, plan-mode, subagent. **Gate:** §12 step 8.
- **Phase 6 — Polish.** `new-extension.mjs`, generated `EXTENSIONS.md`, gallery metadata (`image`/`video` in the `pi` manifest), experimental-agent branch templates.

> Phase 4 deliberately comes **before** the heavy upgrades: proving the external-source + extraction path early means every extension you build afterward can be split out painlessly, instead of discovering coupling late.

---

## 14. Risks / notes

- **Glob discovery of nested entries** — **CONFIRMED 2026-06-18.** `pi install <abs-path>` works; package appears in `pi list`; `pi.extensions: ["extensions/*/index.ts"]` glob is processed by pi's package loader. Note: `pi install` does NOT support `--yes` flag (returns error) — remove from all callers. Flat-file fallback is no longer needed.
- **Follow-up queue** — **CONFIRMED 2026-06-18.** `pi.sendUserMessage(content, { deliverAs: "followUp" })` is on `ExtensionAPI` (the `pi` factory parameter, dist/core/extensions/types.d.ts:841). Extension factory closures can call it from any event handler. Autonomous-loop uses Option A (in-process follow-up queue).
- **Self-containment drift** — the easiest way to break portability is a quiet `import` of a sibling or `kit/lib`. Mitigated by the verify lint (§12.9); keep it in CI and as a pre-commit hook.
- **Name collisions across avenues** — two sources providing the same extension name. Verify errors out; resolve by renaming or choosing one source.
- **External version skew / supply chain** — reference-mode externals update independently; pin refs in `sources.json`, record a `review` note per entry, and treat `pi update` as a reviewed action given full-system-access execution.
- **Windows shell assumptions in vendored examples** — adapt to call tools via `node:child_process`; log changes in `vendor/<name>/SOURCE.md`.
- **Local-path identity** — pi identifies a local package by resolved absolute path; keep the repo location stable or use the git source for portability.
- **Trust prompt on first project startup** — expected; pre-seed `trust.json` / `GIT_TERMINAL_PROMPT=0` for CI.
- **`devDependencies` not at runtime** — pi installs `--omit=dev`; never `import` `typescript`/`ajv` from an extension.
- **mem0 / dual-review latency** — per-turn LM Studio calls; toggle via env (`PI_KIT_MEMORY_BACKEND`, dual-review flag) per project.
