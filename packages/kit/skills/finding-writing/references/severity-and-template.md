# Finding Severity Rubric & Template (reference)

Deep material for `finding-writing`. The SKILL.md lists the required elements; this is the
severity reasoning and a fill-in template.

## Severity = demonstrated impact × exploitability (not a scanner label)

| Rating | Impact shown | Exploitability |
|---|---|---|
| Critical | Full compromise / mass data loss, **demonstrated** | Low barrier: no/again auth, reliable |
| High | Significant data or integrity loss on real assets | Moderate barrier: some auth or conditions |
| Medium | Limited/again scoped exposure, or needs chaining | Higher barrier: privileged position, race |
| Low | Minor info leak, defense-in-depth gap | Hard to exploit or low value |
| Info | No direct security impact | N/A — hygiene / hardening |

Rules for the rationale sentence:
- State the **impact you demonstrated**, not the worst theoretical case.
- Name the **preconditions** that lower/raise it (privilege, network position, user
  interaction, timing window).
- If you rated on a chain, list the links and note which you proved vs assumed.

## CVSS note

If the engagement requires CVSS, record the vector string *and* a one-line justification
per metric that changed from default. A vector without justification is not defensible.

## Finding template (copy, fill, delete guidance lines)

```
### <Title: specific, neutral — what + where>

**Severity:** <Critical|High|Medium|Low|Info> — <one-sentence rationale: impact × exploitability>

**Affected assets:** <exact in-scope hosts/endpoints/objects>

**Summary:** <2-3 sentences: what the weakness is and why it matters here>

**Reproduction:**
1. <precise, minimal step — another tester can follow it>
2. ...
(reference requests/responses by Evidence ID, not inline secrets)

**Impact:** <concrete business/security consequence, tied to the evidence you have>

**Exploitability constraints:** <preconditions, privileges required, what limits it>

**Remediation:** <specific to the code/config/sink — not "sanitize inputs">

**Limitations:** <what you tested and deliberately did not; scope/ROE boundaries>

**False-positive check:** <how you confirmed it is real>

**Evidence:** <IDs/hashes for every claim above>
```

## Writing checklist (before handing to report-export-review)

- [ ] Every sentence traces to an evidence ID; unsupported claims removed (not hedged).
- [ ] Reproduction is minimal and reproducible from a clean state.
- [ ] Remediation names the actual sink/config, not generic advice.
- [ ] Severity rationale matches demonstrated impact (no inflation).
- [ ] No raw secrets/PII in the body — referenced by evidence ID only.
- [ ] Limitations + false-positive check present.

See also: `evidence-review`, `hypothesis-lifecycle`, `report-export-review`.
