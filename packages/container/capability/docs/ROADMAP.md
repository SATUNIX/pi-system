# Pi Capability Roadmap

This page tracks deploy-specific work for `pi-system`.

Package and extension direction lives in `../pi-system/docs/roadmap.md` from the workspace root. That kit roadmap is authoritative for:

- the source catalogue
- the `@satunix/pi-system` package and its profiles
- status bar, themes, and package docs

## Capability Scope

This repo owns:

- container build and runtime defaults
- Pi System compose shape
- seeded Pi overlays
- governance and memory MCP server wiring
- engagement template validation
- runtime readiness checks
- operator runbooks and security model

## Near-Term Deploy Work

- Keep canonical and compatibility compose files behaviorally equivalent.
- Keep validation scripts aligned with the current data root `/srv/data/pi-system`.
- Add a release-mode validation note for pinned kit refs after each kit package milestone.
- Add a host-specific follow-up if Windows path handling affects runtime readiness outside container/Pi System execution.

Historical workspace trackers, including `../PI_SYSTEM_TRACKER.md`, are useful references but should not override this deploy roadmap or the kit roadmap.
