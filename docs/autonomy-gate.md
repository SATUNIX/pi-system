# Autonomy Gate (tool-firewall v2)

`tool-firewall` decides, before every tool call runs, whether it may run. The goal is
simple: an agent in auto mode should do routine work without asking, and dangerous actions
should still be stopped or brought to you. This page describes how that decision is made. It
implements the deterministic core of
`docs/proposals/PI_AUTONOMY_GATE_SPEC.md` (phases 1–3 and a light phase 5). The spec's
ML models, separate daemon and sandboxing are deferred.

## How a decision is made

1. **Parse.** Shell commands are parsed, not pattern-matched. The parser handles:
   - quotes, `$'…'`, `$( )`, backticks, heredocs, redirections, pipes and `cd`/variable
     tracking;
   - obfuscation such as `r''m`, `r\m` and `$'\x72m'`;
   - wrappers: `sudo`, `env`, `timeout`, `nice`, `xargs`, `find -exec`, `bash -c`, `eval`,
     `tmux send-keys`, and `ssh host '…'`, whose remote command is parsed and classified
     too.

   Anything it cannot parse reliably is treated as opaque and never auto-allowed.
2. **Classify.** Each command and each non-shell tool call becomes a set of **effects**:
   read, workspace write, delete, network send, remote exec, privilege, persistence,
   credential read, security control, destructive system, obfuscated exec, and others.
   Targets are scoped by path class:
   - build output inside the workspace, e.g. `rm -rf node_modules`, is routine;
   - other deletes in the workspace are medium;
   - deletes outside the workspace are high;
   - deletes of `/`, `~` or system roots are critical.
3. **Session history.** The following raise the tier:
   - reading a secret, then sending data to a remote host;
   - downloading a file, then running it or making it executable;
   - a burst of deletions.

   History is kept per session under `~/.pi/agent/pi-kit/firewall-sessions/`.
4. **Tier and decide:**

   | Tier | manual | auto (coding policy) | pentest policy |
   |---|---|---|---|
   | low | allow | allow | allow |
   | medium | ask | judge: allow, or block and tell the agent why | ask (the judge may only clear pure reads) |
   | high | ask | exact repeat of a session allow or a learned exact action runs; else the judge, if you allowed something similar; else ask | ask each time, no session allows; denied headless |
   | critical | deny | deny | deny |

   In auto mode with the coding policy, two cases count as low:
   - read-only `ssh` to a known host (from `~/.ssh/config` or `knownHosts`);
   - read-only `sudo -n` commands. `sudo` inside `ssh host '…'` counts as `sudo -n`, because it
     has no terminal to prompt on.

   Remote writes, mounts, key installs and interactive sudo stay medium or high.

Headless children (subagents, print mode) send "ask" to the human-console broker, which
fails closed on timeout.

## Action families

"This kind of action" means a set of **families**. Work on a remote host or as root is grouped
by where it runs and what it does, e.g. `srv02 as root:write_outside` or
`srv02 as root:credential_read`. Ops commands there vary in every path and flag, but your
decision is about the host and the kind of effect.

Some families keep an exact key instead, because their meaning depends on the exact target:
- local work;
- network sends (per destination);
- history rewrites and publishes (per remote);
- security-control, destructive, obfuscated and opaque actions;
- cross-action chains such as secret → send.

Families and scopes decide what counts as *similar* and whether the judge may look at an
action at all. They never allow anything by themselves.

## The judge (auto mode)

**Medium** actions go to a model called in-process, with a 15-second timeout. It sees:
- your **latest** request and the session goal (`.pi/GOAL.yaml`, if set);
- the last few actions;
- this action's parsed effects and reasons;
- up to five of your past decisions on similar actions.

It answers `allow` or `block`. A block is returned to the agent as the tool result, with the
reason, so the agent can change course or explain to you why the step is needed. You get a
quiet notice, not a prompt. If the judge is unavailable, you are asked (with a UI) or the
broker is used (headless).

A **high** action goes to the judge only when all of these hold:
- auto mode is on, with the coding policy;
- the action is learnable;
- you have already allowed something similar: either a **session allow** that shares a family
  or a host/root scope with it, or approvals of **every family in it** (within 30 days, with
  no denial since).

The judge then reasons over the **whole actions** you allowed: their command, steps,
severity, reasons and chain. It also sees your latest request, the goal, precedents, and your
learned profile. It allows only when this is the same kind of step: same host and privilege,
same or narrower paths and services, no new kind of effect, no higher severity, continuing the
same work. "Block" does not refuse outright. It asks you, and the card says exactly **how
this differs** from what you allowed. A kind you have never allowed always comes to you first,
and critical actions never reach the judge.

Model: `PI_KIT_AUTO_MODE_MODEL`, then `judgeModel` in `firewall.json`, then the session model.

## Approval cards and learning

A card is at most **10 lines** of at most 116 characters, so it fits a pane and the human
console. It contains:
- the tier and summary;
- the command;
- the reasons, highest first, then "+N more";
- the session history;
- the judge's note;
- your past decisions on this kind;
- what a session allow would cover.

`/auto explain` shows the full analysis of the last card.

The choices are:
- *Allow once*;
- *Allow for this session*: an exact repeat runs, and in auto mode similar steps go to the
  judge, checked against this action. It is not a blanket allow for "root on srv02". This
  choice is not offered under the pentest policy;
- *Deny*;
- *Deny and tell the agent why*.

Every choice teaches something:
- an allow becomes a precedent, and a session allow also becomes a grant the judge reasons
  over;
- a deny becomes a negative precedent, and the agent is told to take a different approach;
- "deny and tell" gives the agent your reason and keeps it for the judge;
- when you overrule the judge, or agree with it, that is recorded too.

Headless sessions and subagents send the same menu through the human console. A console
without menu support still answers yes/no.

A session allow is a **grant**: the full action with its steps, severity and chain. Grants
belong to the root session and are shared with every subagent the root spawns (they inherit
`PI_KIT_FIREWALL_ROOT_SESSION`). An allow given on a subagent's request therefore informs its
siblings and the parent. A `/new` session starts without grants.

Your decisions are appended, with secrets redacted, to
`~/.pi/agent/pi-kit/firewall-feedback.jsonl`. One "yes" is never "allow always".

Only the **exact same action** runs without the judge once learned (auto mode, coding policy).
Families are tracked the same way and make similar actions judge-eligible. A learned exact
action or family requires all of these:
- at least 3 approvals, in at least 2 sessions, within 30 days, all after the last denial;
- never critical;
- never security-control, destructive-system or obfuscated-exec effects;
- never secret egress, uploads of secrets, a shell piped from the network, unguarded agent
  spawns or safety-env overrides.

A later denial suspends it, and it expires after 30 days without use.

### Global learning (background)

Every decision you make, and every verdict the judge gives, is kept globally:
- `firewall-feedback.jsonl` holds your decisions, with steps, chain, note, and the judge's
  view when it ran first;
- `firewall-judgements.jsonl` holds the judge's verdicts. It rotates at 4 MiB and keeps one
  old copy.

After every 8 new decisions (or once a day if there are any new ones), a background
distillation compresses these into `firewall-profile.json`. The profile holds:
- per-kind statistics: approvals, denials, judge allows and blocks, and where you overrode or
  agreed with the judge;
- up to 12 short **principles** (how you decide) and up to 12 **cautions** (what you refuse),
  written by the judge model.

The distillation is off the hot path, runs one at a time across processes, and never blocks
a tool call. The judge sees the profile, plus the history of this action's kinds, as data.
The profile only informs the judge: what may reach the judge and what runs without it stays
deterministic.

`/auto profile` shows the profile, `/auto profile rebuild` rebuilds it now, and
`/auto profile reset` clears it (your decisions are kept).

## Policies and profiles

`~/.pi/agent/pi-kit/firewall.json`:

```json
{ "mode": "auto", "policy": "coding", "judgeModel": "provider/id", "learn": true, "knownHosts": ["buildbox"], "source": "profile" }
```

The installer and `/profile` write it from the profile's `firewall` field:

| Profile | mode | policy |
|---|---|---|
| quick, balanced | manual | coding |
| long-horizon, autonomous, self-improving | auto | coding |
| pentest (formerly `engagement`) | manual | pentest |

- The policy always follows the profile.
- The mode follows the profile, unless you set it with `/auto on|off` and the policy did not
  change.
- Environment variables override the file: `PI_KIT_AUTO_MODE=1|0` and
  `PI_KIT_FIREWALL_PROFILE=coding|pentest`.
- A project `.pi/auto-mode.json` from the old per-directory auto mode is still honoured.

The **pentest** policy differs from coding in several ways:
- it adds the operator regex rules in `policies.pentest.command_rules` of the shipped policy
  (for example, any recursive `rm` is denied);
- it never trusts the auto-low shortcuts;
- it does not learn, and it offers no session allows;
- it denies high actions when no operator is present;
- `protected-paths` also blocks `.git/`, `node_modules/`, `.pi/agents/` and the engagement
  records.

Under **coding**, `protected-paths` blocks only secrets, key files, agent-control and audit
surfaces, kit policy files and the firewall's own state.

## Commands

- `/auto status|on|off` sets the mode globally (`/auto-mode` is an alias).
- `/auto learn on|off`, `/auto learned` and `/auto forget <sig>` (a trailing `*` matches a
  prefix) manage learning.
- `/auto stats` shows prompts per 100 actions, judge calls and blocks, learned hits, and
  repeats of session allows.
- `/auto profile [rebuild|reset]` shows or rebuilds the learned profile.
- `/auto explain [n]` explains the last *n* decisions.
- `/auto check <command>` classifies a command without running it.
- `/firewall:status` and `/firewall:reload` show and reload the configuration.

## Audit and tuning

Every decision is one line in `PI_KIT_FIREWALL_AUDIT_LOG` (default
`.pi/tool-firewall-audit.jsonl`). Each line includes:
- the tier, mode, policy, effects and reason codes;
- the signature;
- the redacted command;
- the **decider** (analyser, policy, grant, precedent, judge, judge+grant or human);
- the latency.

Decisions that wait for someone add a `tool_approved` or `tool_blocked` line.
Records carry the `toolCallId` and `actionHash`, which join them to the exact arguments and
output in the [tool I/O capture](tool-capture.md).

`npm run firewall:replay` replays the classifier and the decision matrix over your real
sessions in `~/.pi/agent/sessions`. Options include `--mode`, `--policy`, `--show` and
`--json`. It also reports how many prompts remain if every card is answered "allow for this
session". It is the regression and tuning tool:
- on 839 real calls, it cut about 54 human prompts to 6, all of them genuinely sensitive;
- in a root-over-ssh ops session on srv02 (29 prompts), one session allow on the first card
  sends the other 28 to the judge, which asks you only about steps that differ from it.

## Limits

This is still a decision gate, not a sandbox. An allowed call runs with the agent's full
privileges. The parser covers the shell forms agents actually produce, and unparseable input
fails towards asking. A determined adversary with arbitrary code execution inside an allowed
interpreter is out of scope; see [security.md](security.md).
