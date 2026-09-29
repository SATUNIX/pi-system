# compress

`/compress` is an instant alternative to `/compact`. It makes no model call.

## How it works

`/compress` runs pi's own compaction pipeline. Pi picks the same cut point and
keeps the same recent window (`compaction.keepRecentTokens`, default 20k tokens)
verbatim. This extension then answers `session_before_compact` with a summary
that it builds by plain string processing:

| Kept | Dropped or reduced |
|---|---|
| Every user message (trimmed to 600 chars, head and tail) | Tool results |
| Assistant text replies (trimmed to 900 chars per turn) | Thinking blocks and images |
| One tool digest line per turn: counts, files, commands, failures | Fenced code blocks, replaced by `[code: ts, 40 lines]` |
| The earlier summary, capped at 30% of the space left | Oldest middle turns, when over budget |
| Cumulative `<modified-files>` / `<read-files>` lists (15% of the budget) | |

The trim limits above apply at the default budget. They get smaller with a
smaller budget.

When the summary is over budget, content goes in this order of priority:

1. The first turn. It usually holds the original ask.
2. The newest turn.
3. The earlier summary.
4. Older turns, from newest to oldest. A marker shows how many were omitted.

## Usage

```text
/compress
/compress keep the scope limits for 10.0.0.0/24 in mind
```

Text after the command is kept as an "Operator note" in the summary.

## Configuration

| Env var | Default | Effect |
|---|---|---|
| `PI_KIT_COMPRESS_MAX_CHARS` | `16000` (min `4000`) | Summary size budget, in characters (about 4 chars per token) |

## Notes

- Only `/compress` uses this summary. `/compact` and automatic compaction still
  use pi's native LLM summary. The hook acts only on its own marker.
- If the build fails, the hook cancels the compaction. It never falls back to an
  LLM summary with the marker text as instructions.
- If nothing is older than the kept window, `/compress` reports that and makes
  no change.
- The summary does not keep file contents or tool output. The agent must re-read
  a file before it relies on its contents.
