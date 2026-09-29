# Hyperframes Composition Brief (long cut): pi-system feature tour

## Objective
A 63.5s feature-tour brag video for pi-system covering the firewall, judge, subagents, skills, profiles,
autonomy, cost tracking, web console and modularity, each with one "why it's different" line.

## Output
- Composition directory: `composition/`
- Rendered video: `brag.mp4`; poster `brag.jpg` baked as frame 0
- Format: landscape 1920x1080, 30fps, 63.5s

## Source material
- Project root `/home/user/pi-system`
- Files read: `README.md`, `docs/{security,autonomy-gate,MODULARITY,agent-orchestration,status-bar-and-costs,autonomy,EXTENSIONS}.md`, `packages/web-ui/README.md`, `packages/extensions/src/tool-firewall/{index,feedback,classify}.ts`, `packages/kit/{skills,agents,profiles}`, `tests/firewall-shell-smoke.mjs`
- Real UI: screenshot of the running `packages/web-ui` server against a seeded fictional session
- Copy that must appear verbatim: "Set it." / "Walk away." / "Safety-first kit for the pi coding agent." / the nine chapter titles and claims in `composition/index.html` / "Set it. Walk away. Review the diff." / `node packages/core/install.mjs --profile balanced`

## Creative direction
Tone `app-store` with `default` energy, "terminal noir feature tour". Consistent chapter grammar: tag, title,
claim, visual, lime twist chip, bottom progress strip. See `brag-plan.md` for the storyboard contract.

## Visual identity
Background `#1f2123`, panel `#161b22`, border `#30363d`, text `#fff`/`#e6edf3`, muted `#a1abb5`, accent `#c2fe0b`,
tiers `#3fb950` `#d29922` `#f0883e` `#f85149`. Space Grotesk + JetBrains Mono (local woff2).

## Audio
- Music `assets/music/happy-beats-business-moves-vol-1-by-ende-dot-app.mp3` at ~0.34, fade-in 0.8s, fade-out 2.0s
- Cue guidance: bundled preset, 120.19 BPM, first beat 3.019s, grid 0.4995s; scenes on bar lines; strong locks 3.02 / 13.02 / 61.02
- Audio-reactive: subtle background glow from precomputed RMS (`assets/music-rms.js`)
- SFX from the low high-frequency-risk list; exact files/timestamps chosen after the animation existed

## Hyperframes instructions
Native contract: timed clips with `data-start`/`data-duration`, one paused GSAP root timeline on `window.__timelines`, deterministic logic only, local assets only. Run `hyperframes check` before render.
