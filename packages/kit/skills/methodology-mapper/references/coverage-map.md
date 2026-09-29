# Methodology Coverage Map (reference)

Deep material for `methodology-mapper`. The SKILL.md is the mapping procedure + the hard
"advisory only" rule; this is the coverage scaffold to map observations against.

> Advisory only. A methodology "expecting" a test never authorizes it — `scope-roe-governance`
> and `action-card-builder` still gate every active action.

## Coverage states

`tested` (evidence linked) · `partial` (started / one case) · `not-tested` (in-scope gap) ·
`n/a` (out of scope or not applicable). Every non-`n/a` item links an evidence or
hypothesis id.

## OWASP WSTG top-level areas (web)

| WSTG | Area | Typical checks |
|---|---|---|
| WSTG-INFO | Information gathering | fingerprinting, entry points, `endpoint-inventory` |
| WSTG-CONF | Configuration & deploy | headers, TLS, exposed admin/debug, backups |
| WSTG-IDNT | Identity management | registration, enumeration, provisioning |
| WSTG-ATHN | Authentication | brute-force controls, credential policy, MFA, reset |
| WSTG-ATHZ | Authorization | IDOR, priv-esc, path traversal (`authz-idor-testing`) |
| WSTG-SESS | Session management | cookie flags, fixation, logout, CSRF |
| WSTG-INPV | Input validation | XSS, SQLi, injection family (`code-security-review`) |
| WSTG-ERRH | Error handling | stack traces, verbose errors |
| WSTG-CRYP | Cryptography | weak TLS, padding, weak randomness |
| WSTG-BUSL | Business logic | workflow bypass, abuse of function |
| WSTG-CLNT | Client-side | DOM XSS, postMessage, CORS, clickjacking |
| WSTG-APIT | API testing | REST/GraphQL specifics (`api-testing`) |

## OWASP API Security Top 10 (2023) — for API engagements

API1 BOLA · API2 Broken auth · API3 Broken object property-level authz · API4 Resource
consumption · API5 Broken function-level authz · API6 Unrestricted sensitive business
flows · API7 SSRF · API8 Security misconfiguration · API9 Improper inventory management ·
API10 Unsafe consumption of APIs.

## PTES phases (engagement shape)

Pre-engagement → Intelligence gathering → Threat modeling → Vulnerability analysis →
Exploitation → Post-exploitation → Reporting. Map coverage per phase; most authorized
low-impact assessments stop at controlled proof in Exploitation.

## Gap reporting

For each `not-tested` in-scope area, record: the area, why untested (time / ROE window /
access), and whether it is a candidate next action (gated) or an explicit accepted-limitation
for the report's Limitations section.

See also: `endpoint-inventory`, `hypothesis-lifecycle`, `finding-writing`.
