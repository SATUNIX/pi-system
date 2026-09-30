# Status bar and costs

The status bar is implemented by the `custom-footer` extension (the id is kept for
compatibility). It replaces pi's built-in footer while loaded, and is one renderer with three
layouts.

## Layouts

```text
/footer light      one compact line
/footer default    two lines: identity and context (the default)
/footer heavy      adds session totals, cost provenance and every status chip
/footer config     open the layout selector
/footer off        restore pi's built-in footer (accounting continues)
/footer on         show the bar again
/footer status     everything the bar drops when it is narrow, in plain text
/footer reload     re-read pricing without restarting pi
/footer ascii on|off      plain characters instead of symbols (automatic for ISO, ANSI and TTY themes)
/footer todos on|off      the todo checklist above the editor
/tips on|off              the usage tip under the working line
```

The layout is stored in `<agent dir>/pi-kit/ui.json` and survives reloads and new sessions.
`/footer` on its own toggles the bar on and off. Any other argument is rejected with the usage
line and changes nothing.

The layouts differ in what they show, not just in line count:

```text
light     ● project │ ctx 70% │ on main                                       model
default   ● project │ on main │ /path/to/project                 provider │ model
          ctx ████████░░░░ 70% 18k free                                 status chips
heavy     (default, then)
          session ↑1.0k ↓500 ⟲200 │ cost ?                          pricing costs.json
          extension status chips
```

## What it shows

- **Identity**: project, model, and the **effort tier** (`E3 Standard`; `→ E4` while a change waits
  for your next message).
- **Boundary and health warnings**, which are never dropped to make room for telemetry:
  unattended mode (shown from what the firewall *enforces*, never from what the environment
  claims: a requested-but-not-enforced setting is shown as a misconfiguration), compaction off or
  degraded, failed or blocked children, and the firewall mode.
- **Active work**: running children, todo progress, running checks.
- **Context**: a bar, the percentage and tokens free. Unknown context is shown as `?`, never as 0%.
- **Orientation**: git branch, thinking level, profile.
- **Telemetry** (heavy): session tokens (`↑` input, `↓` output, `⟲` cache reads) and cost.
- **Detail**: path, provider, session name.

Cost carries its provenance: **measured** (the provider or catalogue reported it), **estimated**
(computed from your configured prices), or **unknown** (`?`: no price is configured and none was
reported). An unknown cost is unknown, not zero. Usage a partial turn did not report is flagged
`partial`.

When the terminal is narrow the least important segment goes first (path and provider, then
tokens, then branch and thinking); long segments shorten before anything is dropped. Widths are
measured in terminal columns (wide characters, emoji and escape sequences handled). A render error
falls back to one plain line. `/footer status` prints every detail the bar dropped and works
without a terminal UI (it writes to standard error).

The bar reads the state other extensions publish (effort, unattended, compaction, running
children) from small read-only registries; it never runs a subprocess or reads a file per
render.

## The working line

While the agent runs, the working line shows the current activity, the elapsed time and the run
tokens, for example:

```text
Reading server.ts… (1m 04s · ↑12k ↓~850)
```

The activity follows the running tool, the stream type (thinking, writing, a tool call), or a
rotating phrase. Output tokens marked `~` are an estimate until the turn records real usage.

## Tips and the todo checklist

A one-line usage tip appears under the working line during a run. It rotates and lists only
commands that are loaded. The checklist above the editor is read from `TODO.md` (kept by the
`todo` tool) and shows progress and each item's state.

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

Prices are dollars per million tokens. **A price you leave out is unknown, not zero**: the cost is
shown as *estimated* only when every token category the session has used has a price. Otherwise
it falls back to the cost the provider reported (*measured*, when that is above zero), and
otherwise shows `?`. For a local model that costs nothing, set the prices to `0` explicitly.

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

A malformed pricing file produces a warning and keeps the previous pricing.

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

### Theme credits

The `catppuccin-mocha`, `dracula`, `gruvbox-dark`, `monokai`, `nord-dark`, `rosepine` and
`tokyo-night` themes use the colour palettes of the projects of those names, re-expressed as pi
theme files; the palettes belong to their respective authors. The `marathon` and `code-marathon*`
themes use this project's own palette.
