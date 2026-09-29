# self-improvement

The `/improve` cycle mines the local trace ledger (`.pi/trace.jsonl`) for recurring
inefficiencies and proposes a reviewable diff that adds "Learned notes" to `AGENTS.md`.
It never calls a model and never commits.

## Behaviour

- `buildProposal` reads the last 1MB of `.pi/trace.jsonl` and derives deterministic notes
  (repeated reads of the same target, a high tool-result error rate).
- `/improve` always writes the summary plus a unified diff preview to
  `.pi/self-improvement/proposal-<timestamp>.md`.
- The notes are only written to `AGENTS.md` when explicitly armed (`/improve arm` or
  `PI_KIT_SELF_IMPROVE_ARM=1`). Applying is idempotent: notes already present are not
  duplicated.
- The preview and the applied file share the same section model (`mergeNotes`), so the
  reviewed diff is exactly what gets written. With no signal, or when every note is
  already present, the diff contains no added lines.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `PI_KIT_SELF_IMPROVE_ARM` | `0` | Set to `1` to apply the proposal instead of only previewing it |
