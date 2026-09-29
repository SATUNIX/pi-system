# SOURCE

- Written from scratch for this kit (no upstream pi example exists for custom compaction).
- Date: 2026-06-17
- Purpose: overrides context compaction by returning custom compaction instructions derived
  from a template file configured via `PI_KIT_COMPACT_TEMPLATE`.
- Hook: implements `session_before_compact`. A `session_start` guard reports that the
  current Pi compaction API does not support template injection on a truncated transcript,
  so this extension deliberately returns `undefined` and lets Pi use its native,
  goal-agnostic summarization (preserving the full prepared input and operator
  `customInstructions`).
- Superseded: at T3+ the `context-sieve` extension is the single authority for
  model-visible system-prompt assembly and injection; neither extension replaces pi's
  native compaction summarization, and `custom-compaction` is only shipped in the T1
  `balanced` profile.
