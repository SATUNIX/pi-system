# tool-firewall

The autonomy gate for every tool call. It parses shell commands into their real effects,
tiers each action (low / medium / high / critical) together with the session's history, and
then decides:
- routine work is allowed;
- in auto mode, medium actions go to an in-process judge;
- high actions run when they exactly repeat a session allow or a learned action; otherwise the
  judge reasons over the similar actions the operator allowed (full steps, severity and chain)
  and the learned profile, and anything it finds different goes to the operator through a
  compact (≤10-line) card, or the human-console menu when headless;
- critical actions are denied.

The full description is in `docs/autonomy-gate.md`.

| File | Role |
|---|---|
| `shell.ts` | Shell parser: quoting, substitutions, heredocs, wrappers (sudo/env/ssh/bash -c/xargs/find -exec/eval/tmux), obfuscation normalisation. |
| `classify.ts` | Command table, path classes and tool table → findings (tier, effect, code). |
| `trajectory.ts` | Per-session state (secret reads, downloads, deletions, judge cache, stats) and session grants shared through the root session. |
| `profile.ts` | Global learning: judge-verdict telemetry, per-kind statistics and the background-distilled operator profile. |
| `judge.ts` | Judge prompt and strict-JSON verdict parsing. |
| `feedback.ts` | Operator decision log, learned/suspended/expired status, precedents. |
| `card.ts` | Approval card text and choices. |
| `config.ts` | `~/.pi/agent/pi-kit/firewall.json`, mode/policy resolution, known hosts, workspace root. |
| `index.ts` | Orchestration, audit, `/auto` and `/firewall:*` commands. |

## Policy file

`default-policy.json` (mirrored byte-for-byte at `packages/core/policies/default.json`) holds:
- the tool table (`tools.<name>.decision`: allow / ask / deny);
- the unknown-tool default;
- operator regex rules: `command_rules` applies to every policy, and
  `policies.pentest.command_rules` applies to the pentest policy only.

`PI_KIT_FIREWALL_POLICY` points to a replacement file. A tool rule of `deny` is critical, and
`ask` is high.

## Audit

Each tool call appends one JSONL record to `PI_KIT_FIREWALL_AUDIT_LOG`, or to
`.pi/tool-firewall-audit.jsonl` when the variable is unset. Decisions that wait on a judge or
human add a closing `tool_approved` or `tool_blocked` record.

Audit is best-effort: `audit()` swallows its own errors and MUST never throw, and it must never
break a tool call. In the headless broker, `finish()` MUST stay unconditional so the broker
promise always settles. The code currently attempts the audit record before calling `finish()`,
but that ordering is not what makes it safe: because `audit()` is non-throwing, `finish()` is
reached regardless — and if `audit()` ever threw before `finish()`, the promise would not
resolve. Keep `audit()` non-throwing and `finish()` unconditional when editing this path.

## Commands

- `/auto [status|on|off|learn on|off|learned|forget <sig>|stats|explain [n]|check <cmd>]`,
  with `/auto-mode` as an alias.
- `/firewall:status`
- `/firewall:reload`
