---
name: independent-finding-validation
category: evidence-reporting
description: Validate specialist findings or claimed-done results through Conductor's causally independent validator path. Use when a claim needs independent verification before it can be trusted, not for routine code review.
disable-model-invocation: true
triggers: ["independent validation", "independently validate", "validate the finding", "validate this finding"]
---

# Independent finding validation

Route a claimed finding or claimed-done result through Conductor's validator dispatch. Give the
validator only raw evidence and the relevant requirement or scope stanza—never the finder's reasoning
or self-assessed severity—so its judgment is causally independent.

## Validator questions

The validator determines whether the claim is real, whether it matters, and whether it is in
scope/specification. Its verdict is recorded on `verifier-board`; a missing or failing verdict blocks
phase advance and report inclusion with the same fail-closed completion behavior.

## Use the right review

This is not routine code review: use the `reviewer` role in `agent-orchestration` for that. Invoke
independent validation when a specialist's claimed result must be trusted as evidence or accepted as
complete.
