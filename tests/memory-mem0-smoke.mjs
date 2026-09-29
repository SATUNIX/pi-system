#!/usr/bin/env node
// B-027 regression: the memory-mem0 legacy REST path must treat HTTP >= 400 as a failure
// (so the circuit opens after three consecutive failures) instead of resolving every status
// and reporting a 500 body as success / "No results.". Fully hermetic: a local node:http
// server on an ephemeral port; no Docker, no Qdrant, no model.
import assert from "node:assert/strict";
import http from "node:http";
import { isolateKitEnv, loadExtension, fakePi, setEnv } from "../packages/core/eval/harness.mjs";

const server = http.createServer((req, res) => {
  requestCount++;
  res.writeHead(mode === "healthy" ? 200 : 500, { "Content-Type": "application/json" });
  if (mode === "healthy") {
    res.end(JSON.stringify({ results: [{ memory: "the sky is blue" }] }));
  } else {
    res.end(JSON.stringify({ detail: "internal server error" }));
  }
});

let mode = "healthy";
let requestCount = 0;

function listen() {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function loadMem0(port) {
  const restoreBackend = setEnv("PI_KIT_MEMORY_BACKEND", "mem0");
  const restoreUrl = setEnv("MEM0_API_URL", `http://127.0.0.1:${port}`);
  const restoreKey = setEnv("MEM0_API_KEY", undefined);
  const restoreUser = setEnv("MEM0_USER_ID", undefined);
  try {
    const register = await loadExtension("extensions/memory-mem0/index.ts");
    const pi = fakePi();
    register(pi.api);
    return pi;
  } finally {
    // Module-level MEM0_URL is captured at import, so the env only needs to survive load;
    // restore the caller's values immediately.
    restoreBackend();
    restoreUrl();
    restoreKey();
    restoreUser();
  }
}

async function search(pi, query) {
  const tool = pi.tools.get("mem0_search");
  return (await tool.execute("s", { query })).content[0].text;
}

async function add(pi, text) {
  const tool = pi.tools.get("mem0_add");
  return (await tool.execute("a", { text })).content[0].text;
}

async function run() {
  const restoreIsolation = isolateKitEnv();
  const port = await listen();
  try {
    // (a) A persistent 500 must surface as an error, not a false success or empty match.
    mode = "500";
    requestCount = 0;
    {
      const pi = await loadMem0(port);
      const searchText = await search(pi, "anything");
      assert.notEqual(searchText, "No results.", "an HTTP 500 must not look like an empty match");
      assert.match(searchText, /error/i, "mem0_search must report an error");
      assert.match(searchText, /500/, "the error must mention the HTTP status");

      const addText = await add(pi, "a memory");
      assert.ok(!addText.startsWith("mem0 add:"), `an HTTP 500 must not report a successful add (got ${addText})`);
      assert.match(addText, /error/i, "mem0_add must report an error");
      assert.match(addText, /500/, "the add error must mention the HTTP status");
    }

    // (b) Three consecutive failures open the circuit; the fourth call is degraded and never
    // reaches the server, so its request counter stays at 3.
    mode = "500";
    requestCount = 0;
    {
      const pi = await loadMem0(port);
      for (let i = 0; i < 3; i++) {
        assert.match(await search(pi, `q${i}`), /error/i, `failure ${i + 1} must report an error`);
      }
      assert.equal(requestCount, 3, "the first three calls must reach the server");
      const degraded = await search(pi, "q3");
      assert.match(degraded, /circuit open/i, "the fourth call must report the circuit open");
      assert.equal(requestCount, 3, "an open circuit must not send another request");
    }

    // (c) A healthy 200 still returns the memory text unchanged.
    mode = "healthy";
    requestCount = 0;
    {
      const pi = await loadMem0(port);
      assert.match(await search(pi, "sky"), /the sky is blue/, "a healthy response must return the memory text");
      assert.equal(requestCount, 1, "the healthy call must reach the server once");
    }

    console.log("[test:smoke memory-mem0] OK");
  } finally {
    restoreIsolation();
  }
}

try {
  await run();
} catch (error) {
  console.error(`[memory-mem0-smoke] FAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
} finally {
  await new Promise((resolve) => server.close(resolve));
}
