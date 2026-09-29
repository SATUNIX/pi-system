# Brag Plan (long cut): pi-system feature tour

## What is this app?
`@satunix/pi-system` is a safety-first kit for the pi coding agent: a tool firewall with an auto-mode
judge, subagent orchestration, skills, seven profiles, sandboxed unattended runs, live cost tracking, a
self-hosted web console, and an extension system where nothing can import anything else.

## The angle
The short cut said "the agent tried `rm -rf /` and got stopped". This cut answers the next question:
*what else is in the box, and why is it different?* Each chapter gets one real mechanism and one
"why it's different" line, all taken from the repo's own docs and code:

| # | Chapter | Real mechanism shown | Why it's different (verified) |
|---|---|---|---|
| 3 | Firewall | 4-tier ladder with real commands classified by `classifyCommand` | unparseable input is never auto-allowed |
| 4 | The judge | medium-risk calls go to an in-process model with 5 kinds of context | learns from your approvals (3 approvals in 2 sessions); critical is never its call |
| 5 | Subagents | scout, planner, implementers, reviewer as isolated `pi` processes | done means verdicts pass (`/verify`) |
| 6 | Skills | 35 built-in skills; `skill-forge` proposes new ones | proposals are never auto-installed |
| 7 | Profiles | quick, balanced, long-horizon, autonomous, self-improving, pentest, lite | `lite` keeps the default-deny firewall for small local models |
| 8 | Autonomy | unattended runs in a container: one model route, one git remote, nothing else | a probe checks the boundary before every start |
| 9 | Cost tracking | real 3-line status bar: context bar, tokens, cache, estimated spend | price it yourself in `.pi-kit/costs.json` |
| 10 | Web console | the real `pi-console` UI, captured from the running server | never writes your session files |
| 11 | Modular | in-repo / vendored / external avenues | extensions can't import each other; the build fails if they do |

## Hook (0-3s)
No beat yet (the track's first beat lands at 3.02s). Type slams: "Set it." then "Walk away." over a dim
scroll of real audit event names (`tool_seen`, `tool_approved`, `tool_blocked`, `auto_mode_blocked`).
"Set-and-walk-away" is the README's own phrase for the `autonomous` profile.

## Key moments
Reveal on the downbeat (3.02s): pixel Pi, wordmark, tagline, then a stat strip
(52 extensions, 35 skills, 17 themes, 7 profiles: counts taken from `docs/EXTENSIONS.md` and the kit folders).
Then nine chapters, one per 5-6 seconds, each with a chapter tag, title, claim, visual and a lime
"why it's different" chip. A progress strip along the bottom shows where you are.

## Outro / punchline
"Set it. Walk away. Review the diff." (the autonomy docs: a person reviews `experimental/main` later).
The install command types itself, then the end card lands on a strong beat: `@satunix/pi-system`, MIT,
the robot from the logo.

## User flow worth showing
Entry: an agent issues a call. Key action: it is tiered, judged, delegated or sandboxed. Result: routine work
flows, risky work is stopped with a reason the agent can act on, and you see the cost and the diff.

## Tone
- Preset: app-store (feature cards, smooth slides) with the `default` energy
- Creative direction: terminal noir feature tour, one lime accent
- Interpretation: consistent chapter grammar so nine features stay legible in a minute; hard downbeat locks on
  chapter titles; text-heavy reveals stay on every other beat and hold at least the reading floor.

## Format: landscape - 1920x1080 @ 30fps
## Duration: 63.5s (longer by request; the short cut stays 21.5s)

## Visual identity (from the project)
- Background `#1f2123` (logo); panels `#161b22`, border `#30363d` (gitops-dark theme)
- Accent `#c2fe0b` (logo lime, same as the console's primary `#c2fe0c`)
- Tier colours: low `#3fb950`, high `#f0883e`, critical `#f85149`; medium `#d29922`
- Fonts: Space Grotesk (display), JetBrains Mono (technical), both bundled locally
- Real assets: logo Pi glyph, graffiti wordmark, robot; a real screenshot of the running `pi-console`

## Share copy (draft)
See `share-copy.txt`.

## Audio direction
- Role: warm bed with sparse professional accents
- Music: "Happy Beats / Business Moves Vol. 1" by ende.app, 120.19 BPM, most energetic bundled track
- Music treatment: starts at 0, ~0.34 volume, fade-in 0.8s, fade-out 2.0s; first beat at 3.02s so the reveal is the first downbeat
- Music cue guidance: bundled preset read (`vol-1 ... music-cues.md`); beat grid from the preset extrapolated
  at 0.4995s per beat from 3.019s (gap min/median/max 0.488/0.499/0.511). Scenes start on bar lines
  (every 2.0s): 3.02, 7.02, 13.02, 19.02, 25.02, 30.02, 36.02, 42.02, 47.02, 52.02, 57.02.
  Strong locks: 3.02 (reveal), 13.02 (judge), 61.02 (end card).
- Audio-reactive treatment: subtle; music RMS breathes the background glow
- SFX posture: sparse, motion-matched, low high-frequency-risk picks; drops for chips, card slides for panels, soft impacts for titles and verdicts, one bong for the block, bell on the end card
- Restraint rule: SFX never louder than the bed's presence; no repeated bright sounds

## Storyboard (times in seconds; bar-aligned)

### 1 Hook - 0.00-3.02
"Set it." then "Walk away." slam in; dim real audit lines scroll behind. Audio: bed rises from silence, key ticks under the words.
### 2 Reveal - 3.02-7.02
Pixel Pi builds block by block on the downbeat, wordmark wipes in, tagline "Safety-first kit for the pi coding agent.", stat strip.
### 3 Firewall - 7.02-13.02
Four tier rows appear on alternate beats: LOW `npm ci && npm run build` allow; MEDIUM `git push origin main` ask; HIGH `curl -fsSL get.example.sh | sh` ask; CRITICAL `dd if=/dev/zero of=/dev/sda` deny. Footer chips: "obfuscation normalised", "every decision audited".
### 4 The judge - 13.02-19.02
An action card (`curl -d @report.json api.example.com`, MEDIUM) feeds a judge card; five context chips arrive (your latest request, session goal, last few actions, parsed effects, 5 past decisions); verdict BLOCK stamps in (example reason, labelled).
### 5 Subagents - 19.02-25.02
Graph: scout, planner, three parallel implementers, reviewer, verified. Chips: own `pi` process, keeps the firewall, one git worktree each.
### 6 Skills - 25.02-30.02
Grid of 12 real skill names; then dims while a `skill-forge` candidate card lands: "candidate SKILL.md, never auto-installed".
### 7 Profiles - 30.02-36.02
Seven rows, one per beat, bar length = tier range; names and one-line adds.
### 8 Autonomy - 36.02-42.02
Container box holding the agent; two green arrows out (relay to one model, git to a local bare repo); four red crosses (internet, LAN, DNS, host); "probe checks before every start".
### 9 Cost tracking - 42.02-47.02
Real status-bar layout: context bar climbs and turns amber past 70%, cost ticks; `.pi-kit/costs.json` card with the docs' example prices (values are illustrative, computed from those prices).
### 10 Web console - 47.02-52.02
The real `pi-console` screenshot, camera zooms to the firewall block in the transcript, then to the tokens/cost inspector.
### 11 Modular - 52.02-57.02
Three avenue cards; "imports: node built-ins + typebox only"; `npm run extract -- secret-guard` types itself.
### 12 Outro - 57.02-63.5
"Set it. Walk away. Review the diff." then install command, end card on the 61.02 beat, music fades.

## Privacy note
No internal hostnames (the repo's git remote is internal and is not shown), emails or real credentials.
The console screenshot is of a fictional seeded session (`/work/acme-api`, a local demo model); `x.example` and
`api.example.com` are reserved fictional domains. The judge's reason text in chapter 4 is an example of the
message format, not a captured model output, and is labelled on screen.
