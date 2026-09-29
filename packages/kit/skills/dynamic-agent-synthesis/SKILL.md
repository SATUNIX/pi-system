---
name: dynamic-agent-synthesis
category: orchestration-recovery
description: Assemble a deterministic least-privilege Conductor specialist from catalogued skills and policy inputs. Use when an engagement needs a new specialist role that is not already materialized as a static `.pi/agents/*.md` file.
disable-model-invocation: true
triggers: ["synthesize a specialist", "synthesise a specialist", "specialist role", "dispatch_specialist"]
---

# Dynamic agent synthesis

Use Conductor's `dispatch_specialist` path with a materialized specialist assembled by `agent-synth`,
rather than hand-writing a `.pi/agents/*.md` role. The deterministic assembler combines a role brief,
catalogued skill names, an approved tool restriction, model tier, and scope stanza into a reviewable
definition; it never free-writes agent code or grants tools.

## Refusal boundary

Synthesis refuses invalid names, tools, skills, or model tiers, and refuses empty or newline-containing
role briefs and scope stanzas. Select only the needed catalogue skills and the narrowest permitted
tool set; a static, already-materialized role does not need synthesis.

## Bounded dispatch

Every specialist dispatch consumes the durable engagement budget. Check `dispatchesUsed` against
`maxDispatches` and current depth against `maxDepth`; either cap refuses the child before it starts.
Use the sanctioned dispatch path so these limits and its audit trail remain intact.
