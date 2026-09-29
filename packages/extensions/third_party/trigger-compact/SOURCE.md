# SOURCE

- Upstream: `@earendil-works/pi-coding-agent@0.76.0` — `examples/extensions/trigger-compact.ts`
- Date: 2026-06-17
- Changes:
  - 2026-09-15: The upstream `COMPACT_THRESHOLD_TOKENS` constant was hardcoded at 100k, which
    fires auto-compaction far too early on large-context-window models (e.g. a 1.3M window).
    Made the threshold configurable: `PI_KIT_COMPACT_THRESHOLD_TOKENS` env var (managed-install
    override, highest precedence), a new `/compact-threshold [amount|reset]` command that
    persists to `<agent dir>/pi-kit/trigger-compact.json`, falling back to the original 100k
    default when neither is set. `/trigger-compact` (manual, immediate compaction) is unchanged.
