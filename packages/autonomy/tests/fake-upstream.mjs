// A fake model provider for tests/autonomy-container-smoke.mjs, run as its OWN process (the test
// uses synchronous engine calls, which would stall a server living in the test's event loop).
//   node fake-upstream.mjs <log.jsonl> <model-id> <cost-usd>
// Serves GET .../models (an OpenRouter-shaped list with one model) and answers every POST with a
// canned chat completion carrying usage and a cost. Each request is appended to the log as one
// JSON line { method, url, authorization, body }; the first stdout line is { port }.
import fs from "node:fs";
import http from "node:http";

const [logFile, model, cost] = process.argv.slice(2);
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    fs.appendFileSync(logFile, `${JSON.stringify({ method: req.method, url: req.url, authorization: req.headers.authorization ?? null, body: Buffer.concat(chunks).toString() })}\n`);
    res.setHeader("content-type", "application/json");
    if (req.method === "GET") res.end(JSON.stringify({ data: [{ id: model, name: "Test model", context_length: 32000, top_provider: { max_completion_tokens: 4096 }, pricing: { prompt: "0.000001", completion: "0.000002" }, supported_parameters: [] }] }));
    else res.end(JSON.stringify({ id: "gen-1", model, choices: [{ index: 0, message: { role: "assistant", content: "fake answer" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 2, cost: Number(cost) } }));
  });
});
server.listen(0, "0.0.0.0", () => console.log(JSON.stringify({ port: server.address().port })));
