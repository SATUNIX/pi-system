# SOURCE

- Upstream: `@earendil-works/pi-coding-agent@0.76.0` — `examples/extensions/custom-footer.ts`
- Date: 2026-06-17
- Changes:
  - Preserves the `custom-footer` extension id for compatibility while presenting it as the GitOps status bar in user docs.
  - Adds token totals, estimated cost, model id, git branch, context percentage, and `/footer status|reload`.
  - Reads pricing from `.pi-kit/costs.json`, `<agent dir>/pi-kit/costs.json`, or `PI_KIT_COST_*_PER_MTOK` environment overrides.
  - Removed all `@earendil-works/pi-tui` imports to preserve self-containment (own ANSI-aware width helpers).
- 2026-09-14 redesign:
  - Replaces the built-in footer through `ctx.ui.setFooter(factory)` with a colored 3-line bar
    (location + model, context bar + session tokens + run timer, status chips + todo progress).
    Session totals come from session entries. A render error falls back to one plain line.
    `/footer off` restores pi's built-in footer.
  - Working line: a 1 s ticker sets `setWorkingMessage` with the activity (tool, thinking,
    writing, or a rotating phrase), elapsed time, and ↑/↓ tokens for the current run.
  - Tips widget during runs (`/tips on|off`), filtered to loaded commands.
  - Todo checklist widget from `TODO.md` (`/footer todos on|off`).
  - UI settings persist in `<agent dir>/pi-kit/ui.json`.
