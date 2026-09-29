# Hyperframes Composition Brief: pi-system

## Objective
Create a short launch-style brag video for pi-system.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape - 1920x1080, 30fps
- Duration: 21.5s

## Source Material
- Project root: `/home/user/pi-system`
- Primary files read: `README.md`, `docs/index.md`, `docs/security.md`, `package.json`, `packages/kit/themes/gitops-dark.json`, `tests/firewall-shell-smoke.mjs`, `docs/assets/pi-system-logo.png`
- Product name: pi-system (`@satunix/pi-system`)
- Tagline / strongest claim: "Safety-first kit for the pi coding agent." / "No silent allow-all."
- Key UI or visual moment to recreate: the tool-firewall verdicts (real output of `classifyCommand`, tiers low/medium/high/critical)
- Copy that must appear verbatim:
  - Your agent just tried to delete everything.
  - Safety-first kit for the pi coding agent.
  - Pick a profile. Keep the guardrails.
  - quick, balanced, long-horizon, autonomous, self-improving, pentest, lite
  - Your agent asks first.
  - node packages/core/install.mjs --profile balanced

## Creative Direction
- Tone preset: default
- Creative direction: terminal noir - a rogue command meets a firewall that doesn't blink
- Interpretation: punchy on the beat, calm delivery of the "no"; one lime accent, tier colours only where they carry meaning
- Angle: see `brag-plan.md`
- Hook: typed `rm -rf /` then a red CRITICAL - DENIED stamp
- Outro / punchline: "Your agent asks first." + install command + end card
- Avoid: generic SaaS language; abstract filler; any internal hostname, email or credential

## Visual Identity
- Background `#1f2123`; panel `#161b22`; border `#30363d`
- Text `#ffffff` / `#e6edf3`; muted `#8b949e`
- Accent `#c2fe0b`; tiers `#3fb950` `#d29922` `#f0883e` `#f85149`
- Display font: Space Grotesk; mono: JetBrains Mono (both bundled locally as woff2)
- Visual references: 4x4 pixel Pi glyph, graffiti wordmark and robot cropped from the repo logo

## Storyboard
Use `brag-plan.md` as the creative contract.
1. Hook - 3.55s - command typed, CRITICAL stamp, top caption readable
2. Reveal - 3.8s - pixel Pi, wordmark, tagline (2.2s hold)
3. Firewall - 5.76s - four tiered command rows (real verdicts)
4. Profiles - 4.9s - seven profile chips on the beat, `/profile`
5. Outro - 3.5s - punchline, typed install, end card

## Audio
- Audio role: warm bed with sparse professional accents
- Music: `assets/music/happy-beats-business-moves-vol-10-by-ende-dot-app.mp3`, volume ~0.32, fade in 0.6s, fade out 1.4s
- Music cue guidance: bundled preset (`skills/brag/assets/music/cues/...vol-10...`), 109.96 BPM; beat-lock hook stamp 1.37s, outro line 18.01s, end-card bell 20.19s; chips and rows snap to the grid
- Audio-reactive treatment: subtle background glow driven by precomputed music RMS at 30fps
- SFX: keyboard keypress ticks (typing), impactSoft_medium (stamp/reveal), card-slide + drop (rows/chips), bong (critical row), impactBell_heavy (end card). Picks are from the low high-frequency-risk list.
- Audio files copied into `composition/assets/`

## Hyperframes Instructions
Follow the native Hyperframes contract (`hyperframes docs data-attributes|compositions|gsap`): timed clips with `data-start`/`data-duration`, one paused root GSAP timeline registered on `window.__timelines`, deterministic logic only, local assets only. Run `hyperframes check` before render.
