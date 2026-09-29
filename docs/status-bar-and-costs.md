# Status Bar and Costs

The GitOps status bar is implemented by the `custom-footer` extension. The extension id stays `custom-footer` for compatibility.

## Status Bar Settings

The current three-line bar remains the `default` preset. The selection is stored in
`<agent dir>/pi-kit/ui.json`, so it survives reloads and new sessions.

```text
/footer config             open the status-bar selector
/footer default            current three-line layout
/footer light              one compact line
/footer heavy              expanded four-line layout
/footer off                restore Pi's built-in footer
```

`/footer` by itself still toggles the selected preset on and off. `/footer status`
reports the active preset and `/footer todos on|off` continues to control the todo widget.

## What It Shows

The status bar has three colored lines. It replaces pi's built-in footer while
loaded.

Line 1 (location and model):

- project folder and short path
- git branch
- session name, if set
- provider and model id
- thinking level, if the model reasons

Line 2 (context and tokens):

- a context usage bar, the percent, and used/window tokens
- session totals: input, output, cache reads, estimated cost
- a live run block during a turn: elapsed time and run tokens

Line 3 (status):

- todo progress (done/total)
- one chip per extension status (for example the trace-ledger loss count)

Colors follow the theme. The context bar turns amber above 70% and red above
90%. Narrow terminals drop the least important parts to fit. A render error
falls back to one plain line.

## The working line

While the agent runs, the working line shows the current activity, the elapsed
time, and the run tokens, for example:

```text
Reading server.ts… (1m 04s · ↑12k ↓~850)
```

The activity follows the running tool, the stream type (thinking, writing, a
tool call), or a rotating phrase. Output tokens marked `~` are an estimate until
the turn records real usage. This shows progress even when thinking is hidden.

## Tips

A one-line usage tip appears under the working line during a run. It rotates and
lists only commands that are loaded.

```text
/tips        toggle tips
/tips off    hide tips
```

## Todo checklist

The status bar shows a checklist above the editor from `TODO.md`, with progress
and each item's state (done, in progress, open). The `todo` tool keeps the file.

```text
/footer todos        toggle the checklist
/footer todos off    hide the checklist
```

## Commands

```text
/footer
/footer status
/footer reload
/footer todos on|off
/tips on|off
```

`/footer` toggles the status bar. `/footer off` restores pi's built-in footer.
`/footer status` prints the pricing source and current totals. `/footer reload`
reloads pricing without restarting Pi. Settings persist in
`<agent dir>/pi-kit/ui.json`.

## Pricing Files

Project pricing is read first:

```text
.pi-kit/costs.json
```

If that file is missing, Pi checks the user fallback:

```text
~/.pi/agent/pi-kit/costs.json
```

Example:

```json
{
  "inputPerMTok": 0.15,
  "outputPerMTok": 0.60,
  "cacheReadPerMTok": 0.02,
  "cacheWritePerMTok": 0.10
}
```

Prices are dollars per million tokens. Missing values default to `0`, which is the expected default for local models.

## Environment Overrides

```powershell
$env:PI_KIT_COST_INPUT_PER_MTOK="0.15"
$env:PI_KIT_COST_OUTPUT_PER_MTOK="0.60"
```

```sh
export PI_KIT_COST_INPUT_PER_MTOK=0.15
export PI_KIT_COST_OUTPUT_PER_MTOK=0.60
```

Optional cache overrides:

```text
PI_KIT_COST_CACHE_READ_PER_MTOK
PI_KIT_COST_CACHE_WRITE_PER_MTOK
```

Malformed pricing files produce a warning and keep the previous/default pricing.

## Themes

These themes ship with the full package and the lite surface. Pi discovers a theme,
but only applies it after you select it in `/settings` or configure `theme` in
`~/.pi/agent/settings.json`:

| Theme | Purpose |
|---|---|
| `gitops-dark` | Existing default kit theme. |
| `iso-dark` | Standard Linux ISO/ANSI palette and keyboard-only footer glyphs. |
| `marathon` | ISO/ANSI layout with electric-blue (`#5200ff`) accents and volt-green (`#c2fe0c`) highlights. |
| `high-contrast-dark` | Maximum text and interface contrast. |
| `colourblind-dark` | Okabe-Ito palette with distinct blue, orange, and yellow states. |
| `ansi-dark` | Strict 16-colour ANSI palette and keyboard-only footer glyphs. |
| `tty-dark` | Green-phosphor TTY palette and keyboard-only footer glyphs. |

For `iso-dark`, `ansi-dark`, and `tty-dark`, the kit footer and todo widget use
ASCII keyboard characters such as `>`, `|`, `=`, `[x]`, and `...`; it does not emit
box drawing, symbols, or emoji. Select a theme either way:

- In Pi, run `/settings` and pick a theme name from the table, or
- Add it to `~/.pi/agent/settings.json`:

```json
{
  "theme": "iso-dark"
}
```

Without a `theme` key you get Pi's default (`dark`/`light`), even though these themes
are installed. Confirm what is discovered with:

```powershell
pi list
```

```sh
pi list
```
