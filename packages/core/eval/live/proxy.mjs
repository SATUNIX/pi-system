// Fixed-upstream inference relay. Configuration arrives over stdin, never argv,
// Docker environment metadata, or an agent-readable credential file.
import http from "node:http";
import https from "node:https";
import fs from "node:fs";

let configText = await new Promise((resolve) => {
  let input = "";
  process.stdin.on("data", (chunk) => {
    input += chunk;
    if (input.includes("\n")) { process.stdin.pause(); resolve(input.slice(0, input.indexOf("\n"))); }
  });
});
const config = JSON.parse(configText);
configText = "";
const upstream = new URL(config.baseUrl);
let requests = 0;
const allowed = new Set(["/v1/responses", "/v1/chat/completions", "/v1/models"]);
const server = http.createServer(async (req, res) => {
  if (!allowed.has(req.url) || !["GET", "POST"].includes(req.method)) {
    res.writeHead(403).end("Only inference requests are allowed"); return;
  }
  if (++requests > 100) { res.writeHead(429).end("Evaluation request budget exhausted"); return; }
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) { res.writeHead(413).end(); return; }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  fs.appendFileSync("/logs/requests.jsonl", JSON.stringify({ at: new Date().toISOString(), path: req.url,
    body: body.length ? JSON.parse(body.toString()) : null }) + "\n");
  const destination = new URL(upstream.href.replace(/\/$/, "") + req.url.slice(3));
  const transport = destination.protocol === "https:" ? https : http;
  const headers = { "content-type": "application/json", ...config.headers };
  if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
  const request = transport.request(destination, { method: req.method, headers, timeout: 180_000 }, (reply) => {
    res.writeHead(reply.statusCode, { "content-type": reply.headers["content-type"] || "application/json" });
    reply.pipe(res);
  });
  request.on("timeout", () => request.destroy(new Error("Inference timeout")));
  request.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Inference upstream unavailable"); });
  request.end(body);
});
server.listen(8081, "0.0.0.0", () => console.log("inference relay ready"));
