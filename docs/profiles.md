# Profiles

pi-system ships as one package. A **profile** chooses which of its
extensions pi loads and which of its skills and prompt templates are listed. Switching profile
changes pi's settings, not what is installed, so it takes effect immediately and is reversible.

Lite was once a separate generated package (`@satunix/pi-system-lite`). It is now the `lite`
profile of the same package.

## The profiles

The generated [capability matrix](capability-matrix.md) has the exact extension list and count
for each profile.

| Profile | Use when | Needs |
| --- | --- | --- |
| `quick` | You want the smallest safe setup | Node, pi |
| `balanced` | Daily coding (the default) | Node, pi |
| `long-horizon` | Longer planning and checkpoint workflows | Node, pi |
| `autonomous` | You have validated the session and want set-and-walk-away operation | Node, pi, live-session validation first |
| `pentest` | A security engagement, with the Conductor root orchestrator | Node, pi |
| `self-improving` | Every extension and supporting service | Node, pi, Docker for the memory services (experimental) |
| `lite` | Small local models and low-context sessions | Node, pi |

## Switching

Inside pi:

```text
/profile              pick from a list (shows what each would add or remove)
/profile lite         switch directly
/profile status       what is loaded, and how it differs from the closest profile
```

From a shell:

```sh
# A release install: run the installer of pi's own copy of the kit
node ~/.pi/agent/git/gitlab.home.internal/lab/pi-system/packages/core/install.mjs --profile lite --yes --settings-only
# A checkout registered in place
node packages/core/install.mjs --profile lite --yes
```

Hand edits survive profile switches: the first switch after you edit your settings offers to save
them to `~/.pi/agent/pi-kit/overrides.json`, which is applied on top of every profile.

## The lite profile

`lite` is for small local coding models. It loads:

- safety guardrails (`tool-firewall`, `protected-paths`), git checkpoints and todo
- the verification gate and verifier board, context sieve and progress guard
- the GitOps status bar (`custom-footer`) and session helpers
- `compress`, `save`, `trace-ledger`, `caveman` (terser conversational output)
- the subagent and orchestrator layer, `goal-core`
- `pi-readseek`, a companion package for cheap hash-anchored read/edit/grep and code maps

It lists only the small-model skills (see the [skills catalogue](skills-catalogue.md#lite-profile-subset))
and the four `code-*` prompt templates. These allowlists are the profile's `skills.only` and
`prompts.only` fields in `packages/kit/profiles/lite.json`.

## Companion packages

Some profiles use npm packages that are not part of the kit (`pi-lens`, `pi-readseek`,
`pi-impact-analyzer`, `pi-lean-ctx`). The installer registers them as their own pi packages, at
the exact version the kit has reviewed (`packages/core/sources.json`). `/update` moves them when
a kit release changes a pin. `pi-lean-ctx` is registered only when its `lean-ctx` binary is on
`PATH`.

## Profile file format

Profiles live in `packages/kit/profiles/<name>.json`:

| Field | Meaning |
| --- | --- |
| `include` | Extensions to load: kit extensions by name, plus companion packages from `sources.json` |
| `skills.excludeCategories` / `skills.exclude` | Kit skills to hide, by category or name |
| `skills.only` / `prompts.only` | Allowlists: hide every kit skill or prompt not listed |
| `prompts.exclude` | Prompt templates to hide |
| `firewall` | Tool-firewall default `mode` (`manual`/`auto`) and `policy` (`coding`/`pentest`) |
| `experimental` | Allows experimental extensions in the profile |

`npm run verify` cross-checks every extension's `profiles` field against these files.
