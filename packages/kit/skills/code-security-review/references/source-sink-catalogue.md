# Source → Sink Catalogue (reference)

Deep material for `code-security-review`. The SKILL.md is the review runbook; this is the
taint-tracking catalogue to consult while tracing input → dangerous operation.

## The model: untrusted SOURCE reaches a SINK without a correct SANITIZER

A vulnerability exists when tainted data flows from a source to a sink and the transform on
the path is missing, wrong, or bypassable. Review = follow that flow.

## Common sources (untrusted input)

- HTTP: query/body/path params, headers, cookies, multipart filenames, JSON/GraphQL vars
- Inter-service: message queues, webhooks, third-party API responses
- Storage read-back: DB/cache values that were themselves user-set (second-order)
- Files/uploads, env in multi-tenant contexts, deserialized objects

## Sink families → the bug class they enable

| Sink | Bug class | What to look for |
|---|---|---|
| SQL / ORM raw query | SQL injection | String-built queries; ORM `.raw()`/`.literal()`; dynamic `ORDER BY` |
| `exec`/`spawn`/`system`/backticks | Command injection | Shell string interpolation; `shell:true` |
| HTML render / templating | XSS | Unescaped output; `dangerouslySetInnerHTML`; `|safe`; `v-html` |
| File path join / open | Path traversal | User input in paths without normalization/allowlist |
| Deserializers | RCE / object injection | `pickle`, `yaml.load`, native `unserialize`, Java `readObject` |
| URL fetch (server-side) | SSRF | User-controlled host in `fetch`/`curl`/http client |
| Redirect / `Location` | Open redirect | User-controlled redirect target |
| Reflection / dynamic dispatch | Auth bypass / RCE | User input selecting method/class/route |
| Template/expr engines | SSTI | User input in template string (Jinja, Freemarker, EL) |
| Crypto / token compare | Auth weakness | `==` on secrets, static IV/salt, `Math.random` for tokens |

## Sanitizers that actually work vs common fakes

- **Works:** parameterized queries / prepared statements; contextual output encoding;
  allowlists; `path.resolve` + prefix check; safe loaders (`yaml.safe_load`); constant-time
  compare.
- **Fake / bypassable:** blocklist string filters; escaping the wrong context (HTML-escape
  into a JS string); client-side-only validation; regex "validation" with `.*`; encoding
  once when the sink decodes twice.

## Second-order & chain notes

- Tainted data stored then later used in a sink is still injection (stored XSS, second-order
  SQLi). Trace *reads* of user-writable storage into sinks too.
- Auth/authorization bugs rarely show as a single sink — check ownership/role checks at the
  boundary of every state-changing handler (pairs with `authz-idor-testing`).

## Review pass order (cheap → deep)

1. Map routes/handlers and the trust boundary (where input enters).
2. For each sink family above, grep the codebase; triage hits by whether a source reaches it.
3. For live candidates, confirm the sanitizer on the path is correct for that sink's context.
4. Promote confirmed source→sink flows via `hypothesis-lifecycle` → `finding-writing`.

See also: `endpoint-inventory`, `supply-chain-review`, `finding-writing`.
