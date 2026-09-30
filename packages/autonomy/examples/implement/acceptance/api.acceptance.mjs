// Held-out acceptance test for examples/implement.json. The supervisor copies this file over the
// clean clone before the "acceptance" check runs; the worker never sees or edits it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "../../src/server.mjs";

async function withServer(fn) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((resolve) => server.close(resolve)); }
}

test("health, create, list and complete a todo", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const created = await fetch(`${base}/todos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "write tests" }) });
    assert.equal(created.status, 201);
    const todo = await created.json();
    assert.equal(todo.done, false);
    const list = await (await fetch(`${base}/todos`)).json();
    assert.deepEqual(list.map((t) => t.title), ["write tests"]);
    const patched = await fetch(`${base}/todos/${todo.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ done: true }) });
    assert.equal((await patched.json()).done, true);
    assert.equal((await fetch(`${base}/todos/nope`, { method: "PATCH", body: "{}" })).status, 404);
  });
});
