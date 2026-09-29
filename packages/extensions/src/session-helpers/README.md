# session-helpers

Manual session-control helpers layered on top of the kit's autonomous behaviour.
Everything here is an explicit user slash command — nothing runs on a hook, and
nothing overrides auto-loaded skills/tools or automatic compaction.

## Why

The kit is designed to run autonomously (skills and tools auto-load, `context-sieve`
compacts context on its own). Operators still occasionally want manual control:
reset the context, remember which command does what, etc. `pi` already ships the
real controls as built-ins — this extension fills the two gaps a Claude Code user
notices first: there is no `/clear`, and there is no one-stop command list.

## Commands

| Command | What it does |
| --- | --- |
| `/clear` | **Guidance only — does not clear anything.** Explains `/compact` (shrink context, keep thread), `/new` (fresh session), and `/fork` (branch), so the reflex `/clear` never silently drops your thread. |
| `/kit` | Prints a cheatsheet of the pi built-in session commands plus the kit helpers. |
| `/helpers` | Alias for `/kit`. |
| `/profile` | Switch the active kit profile: `/profile` opens a picker, `/profile <name>` switches directly, `/profile list` lists profiles with descriptions. Reinstalls the registered kit package for that profile (`node packages/core/install.mjs --profile <name> --yes`, passing back the `--scope` the kit was installed with) and reloads. |

## Switching profiles with `/profile`

`/profile` is the in-session front-end to the same operation the CLI installer
performs — it does not reimplement install logic, it locates the kit checkout and
drives `packages/core/install.mjs`. Resolution order for the kit root:
`PI_KIT_ROOT` → the `kitSource` recorded in `~/.pi/agent/.pi-kit.json` (when it is a
path) → this module's own location (a checkout, git clone or npm install of the kit).

Two layouts are supported: the monorepo (`packages/core/install.mjs` +
`packages/kit/profiles`) and a legacy flat kit (`kit/install.mjs` + `profiles/`).
Release installs (pi's clone of the kit's git repository, or the npm package) keep the monorepo
layout, so `/profile` works for them too.
If no layout is found, `/profile` reports that the kit could not be located and points at
`PI_KIT_ROOT`.

A bare `pi install git:<host>/<owner>/pi-system@<tag>` (or `npm:@satunix/pi-system`) registers
the package unfiltered. On the first
interactive session the extension applies the `balanced` profile (or `PI_KIT_AUTO_PROFILE=<name>`;
`PI_KIT_AUTO_PROFILE=0` turns this off) and asks for a `/reload`.
Switching to the current profile is a no-op; a failed install surfaces the
installer's stderr and does **not** reload.

## Built-ins worth knowing (provided by pi, not this extension)

`/new` (new session · the real "clear"), `/compact` (compact context),
`/fork` (branch from a past message), `/clone` (duplicate session),
`/tree` (switch branches), `/resume`, `/session`, `/model`, `/settings`, `/hotkeys`.

Compaction also happens automatically via `context-sieve`, so manual `/compact`
is rarely needed.

## Notes

- Output uses `ctx.ui.notify`, the same path the GitOps status bar uses, so it is a
  no-op in `-p` / JSON modes (guarded by `ctx.hasUI`).
- `/clear` is intentionally non-destructive: an autonomous run should never lose its
  thread because a reflex command was typed.
- `/profile` spawns the installer as a subprocess (`pi.exec`, 5-minute timeout) and
  only reloads after a clean exit — a failed profile switch leaves the session on
  the old profile rather than in a half-installed state.
