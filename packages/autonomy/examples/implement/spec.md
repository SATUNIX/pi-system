# Todo API

Build a small HTTP API for a todo list using only Node's standard library (no dependencies).

Requirements

- `GET /health` returns 200 with `{"ok": true}`.
- `POST /todos` with `{"title": "..."}` creates a todo and returns 201 with `{"id", "title", "done": false}`.
- `GET /todos` returns the list, oldest first.
- `PATCH /todos/:id` with `{"done": true}` marks a todo done; an unknown id is a 404.
- Export `createServer()` from `src/server.mjs` (it does not listen; the caller does). `node src/main.mjs` listens on `PORT` (default 8080).
- Tests use `node --test` and live under `tests/`.
- `README.md` says how to run it and the tests.
