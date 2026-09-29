# IDOR / Authorization Test Matrix (reference)

Deep material for `authz-idor-testing`. Loaded on demand — the SKILL.md runbook is the
always-relevant part; this is the checklist/table depth.

## Authorization dimensions to cover

| Dimension | Question | Paired test |
|---|---|---|
| Horizontal | Can user A reach user B's object at the same privilege level? | A's session requests B's object id. |
| Vertical | Can a low-privilege user perform a high-privilege action? | Low-priv session hits an admin endpoint/param. |
| Context / state | Is access allowed only in a state that should forbid it? | Same object across pre/post workflow states. |
| Function-level | Is the endpoint itself gated, independent of object? | Unauthenticated / wrong-role call to the route. |
| Field-level | Can a forbidden field be read/written via mass-assignment? | Add `role`/`isAdmin`/`ownerId` to the body. |

## Object-reference sources to vary (the "id" is not always in the path)

- Path segments: `/api/orders/1001`
- Query params: `?userId=1001&accountId=55`
- Request body fields: `{ "targetId": 1001 }`
- Headers / cookies: `X-Account-Id`, tenant cookies
- JWT / token claims: `sub`, `tenant`, `role` (test with an unmodified token from a
  different account — never forge signatures unless explicitly in scope)
- Indirect references: filenames, export ids, GUIDs (predictable vs random matters)
- Batch / GraphQL: node ids inside `nodes([...])`, aliased queries

## Reference predictability ladder (drives effort, not impact claims)

1. Sequential integer → trivially enumerable (but still: **one** object proves the gap).
2. Timestamp / short random → guessable within a window.
3. UUIDv4 / opaque → not guessable; gap only provable with a *known* other-account id.

## Minimal-evidence rule (why one object is enough)

The finding is "the control does not enforce ownership," proven by a single
allowed-vs-denied pair. Enumerating N records adds **impact-inflation risk and real
user-data exposure**, not proof. Vary the *reference*, never the *volume*.

## Evidence bundle to capture per gap

- The allowed request+response (baseline: the object's true owner).
- The denied-identity request+response that unexpectedly succeeded.
- The two account identities used (labels, not credentials).
- Exact object id(s) touched and the single record proven.
- Timestamps + evidence hashes; the explicit "did not enumerate/extract" statement.

## Common false positives to rule out first

- The two accounts actually share the object (org/tenant membership) → not a gap.
- Caching / CDN returning a stale authorized copy.
- The endpoint returns 200 with an *empty* / redacted body (access denied at data layer).
- Soft-deleted or public-by-design objects.

See also: `scope-roe-governance`, `action-card-builder`, `evidence-review`, `finding-writing`.
