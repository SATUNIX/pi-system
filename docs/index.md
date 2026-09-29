# Pi System

`@satunix/pi-system` is a Pi extension kit: extensions, skills, prompts, themes and agent
definitions in one pi package, with profiles that choose what loads.

Use this guide if you want to:

- install the kit
- choose a profile, including `lite` for small local models
- keep pi, the kit and linked packages up to date
- enable the GitOps status bar and theme
- configure model pricing
- build your own extension
- search the docs

## Fast Choices

| Need | Use |
|---|---|
| Small local model or tight context | the `lite` profile |
| Daily coding with the standard guardrails | the `balanced` profile |
| Long-running work with checkpoints and task graph | the `long-horizon` profile |
| Container operation | `packages/container/README.md` |

## Plain Terms

- The **kit** is the one package, installed from `gitlab.home.internal/lab/pi-system`.
- A **profile** chooses which of the kit's extensions, skills and prompts load. Switch with `/profile`.
- A **channel** is what you follow: `latest` (release tags) or `next` (`main`).
- The **catalogue** is the source library of extensions in this repo.

## Search

```powershell
python -m pip install --user -r requirements-docs.txt
npm run docs:serve
```

```sh
python3 -m pip install --user -r requirements-docs.txt
npm run docs:serve
```

Open the local MkDocs URL and use the search box.

## Next Steps

1. Start with [Getting Started](getting-started.md).
2. Pick a profile in [Profiles](profiles.md).
3. Configure the [GitOps status bar and costs](status-bar-and-costs.md).
4. Already installed? See [Updates](updates.md): `/update` updates pi, the kit and linked packages.

Prefer a scripted tool over typing the raw commands in these guides? See
`packages/core/helpers/README.md` for install/setup/configure/update scripts
(bash and PowerShell).

## Proposals (future direction)

- [Root Orchestrator — the "Conductor"](proposals/root-orchestrator-conductor.md): a design note for a
  single strong root agent that manages an engagement/project A→Z by dynamically synthesising scoped
  specialist subagents from the skills + notes knowledge base, with causally independent finding
  validation and unchanged scope/ROE enforcement underneath.
