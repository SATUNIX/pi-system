// Deliberately vulnerable, synthetic lab API. No real users or data.
import http from "node:http";
import fs from "node:fs";
const invoices = { "101": { id: 101, owner: "alice", amount: 35 }, "202": { id: 202, owner: "bob", amount: 99 } };
http.createServer((req, res) => {
  res.on("finish", () => fs.appendFileSync("/logs/requests.jsonl", JSON.stringify({ method: req.method, path: req.url,
    user: { "Bearer lab-alice": "alice", "Bearer lab-bob": "bob" }[req.headers.authorization] || "anonymous", status: res.statusCode }) + "\n"));
  res.setHeader("content-type", "application/json");
  if (req.url === "/health") { res.end('{"ok":true}'); return; }
  const user = { "Bearer lab-alice": "alice", "Bearer lab-bob": "bob" }[req.headers.authorization];
  if (!user) { res.writeHead(401).end('{"error":"authentication required"}'); return; }
  const invoice = invoices[req.url.match(/^\/invoices\/(\d+)$/)?.[1]];
  if (!invoice) { res.writeHead(404).end('{"error":"not found"}'); return; }
  // Intentionally missing: invoice.owner === user authorization check.
  res.end(JSON.stringify(invoice));
}).listen(8080, "0.0.0.0");
