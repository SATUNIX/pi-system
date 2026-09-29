---
name: documentation-workflow
category: documentation
description: Produce operator docs that stay aligned with real runtime behavior. Use when writing or updating runbooks, architecture notes, READMEs, or findings — verify behavior first, keep commands runnable, and link claims to evidence.
disable-model-invocation: true
triggers: ["update the readme", "write a readme", "update the docs", "update docs", "write documentation", "write the docs", "runbook", "architecture notes", "architecture doc"]
---

# Documentation Workflow

Documentation is only useful if it matches reality. Verify, then write; separate what
should be true from how to operate it.

## When to use
- Creating or updating operator docs, runbooks, architecture notes, READMEs, or findings.

## Rules
1. **Verify before documenting.** Confirm the actual runtime behaviour (run it, read the
   code path) — don't document intent as if it were fact.
2. **Runnable commands.** Keep commands copy-pasteable and environment-aware (note the
   shell/OS where it matters).
3. **Separate concerns.** Desired state · operational procedure · rollback · troubleshooting
   — as distinct sections, not one blur.
4. **State assumptions and unsupported cases** explicitly.
5. **Link claims to sources** — evidence, tests, code paths, or config files — so a reader
   can check them.
6. **Update validation** when the docs introduce a required file or contract (a new
   required resource should have a check — see `validation-test-maintainer`).

## Decision heuristics
- Can't verify a behaviour? Mark it clearly as unverified/assumed rather than asserting it.
- Command differs by platform? Show both or state which one.

## Anti-patterns
- Documenting the design you intended instead of the behaviour that exists.
- Non-runnable or environment-blind commands.
- Claims with no link to code/evidence.

## Done
The doc reflects verified behaviour, its commands run, concerns are separated, and every
claim traces to a source.
