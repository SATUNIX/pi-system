# memory-mem0

Mem0-compatible memory tools. By default (`PI_KIT_MEMORY_BACKEND` unset or `mcp`) the tools
proxy the kit memory MCP server; with `PI_KIT_MEMORY_BACKEND=mem0` they speak the legacy mem0
REST API directly (`MEM0_API_URL`, optional `MEM0_API_KEY` / `MEM0_USER_ID`).

## Failure and circuit behaviour (legacy REST path)

An HTTP response with status `>= 400` is treated as a failure, not as a successful response:

- `mem0_search` and `mem0_add` report an error mentioning the HTTP status instead of returning
  `"No results."` or a `mem0 add: <error body>` success line.
- Each failure increments an in-process circuit counter and resets on the next successful (2xx)
  response. After three consecutive failures the circuit opens and subsequent calls return
  `mem0 unavailable: circuit open (3 consecutive failures). Restart session to reset.` without
  contacting the service.

See `tests/memory-mem0-smoke.mjs` for the hermetic regression coverage (local `node:http`
server; no Docker/Qdrant).
