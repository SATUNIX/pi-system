# Fonts (drop-in)

The UI asks for these families and falls back gracefully when they are absent:

| Role | Family | File expected here |
| --- | --- | --- |
| All information (display, secondary, body) | `Helvetica Neue` / `Helvetica` / `Arial` | — (system fonts) |
| Code / technical readouts | `JetBrains Mono` | `JetBrainsMono-Regular.woff2` |

Sans-serif text uses the system Helvetica/Arial stack — no files needed. When none of those
families is installed, it falls back to the metric-compatible `Liberation Sans` / `Nimbus Sans`,
so Arial rendering stays consistent on Linux without a webfont. Drop
`JetBrainsMono-Regular.woff2` in this directory to ship the mono font with the UI; until then
the stack falls back to `JetBrainsMono Nerd Font`, `DejaVu Sans Mono`, then `monospace`, and the
browser logs a 404 for the missing file (harmless; the UI is unaffected).

Get JetBrains Mono from <https://www.jetbrains.com/lp/mono/>. To install it system-wide instead
(no file needed here), put it under `~/.local/share/fonts/` and run `fc-cache -f`.
