#!/usr/bin/env node
// Inference relay for the autonomy run: the agent container's only route off its internal
// network. Based on packages/core/eval/live/proxy.mjs: a fixed upstream, configuration (with the
// real API key) over stdin only, and a small allowlist of inference paths. The agent holds a
// synthetic key. Added here: per-response usage metering to /meter/usage.jsonl, which the
// supervisor sums for the budget, a hard spending stop as a backstop to the supervisor's, and a
// model allowlist that also refuses OpenRouter's web-search features (screen()).
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { pathToFileURL } from "node:url";

export const ALLOWED = new Map([
  ["POST /v1/chat/completions", "/chat/completions"],
  ["GET /v1/models", "/models"],
]);

export function route(method, url) {
  const path = String(url ?? "").split("?")[0];
  return ALLOWED.get(`${method} ${path}`) ?? null;
}

/** Ask OpenRouter to report usage (tokens and cost) on every response, streaming included. */
export function withUsage(body) {
  if (!body || typeof body !== "object") return body;
  return { ...body, usage: { ...(body.usage ?? {}), include: true } };
}

/**
 * Screen a chat request. OpenRouter can turn a completion into web access (the `plugins` web
 * plugin, `web_search_options`, `:online` model variants); none of that is inference the run
 * needs, so it is refused or removed. With an allowlist, only the run's models are served.
 * Returns { body } or { error }.
 */
export function screen(body, models = []) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Request body must be a JSON object" };
  const model = String(body.model ?? "");
  if (/:online\b/i.test(model)) return { error: "Online model variants are not allowed" };
  if (models.length && !models.includes(model)) return { error: `Model ${JSON.stringify(model)} is not allowed for this run` };
  const { plugins, web_search_options: _web, ...rest } = body;
  const kept = Array.isArray(plugins) ? plugins.filter((p) => p && p.id !== "web") : undefined;
  return { body: withUsage(kept?.length ? { ...rest, plugins: kept } : rest) };
}

/** Usage records from a response body: SSE `data:` lines or one JSON document. */
export function usageFrom(text) {
  const found = [];
  const take = (obj) => {
    if (obj?.usage && typeof obj.usage === "object") {
      const u = obj.usage;
      found.push({
        model: obj.model ?? null,
        promptTokens: num(u.prompt_tokens),
        completionTokens: num(u.completion_tokens),
        costUsd: num(u.cost),
      });
    }
  };
  const s = String(text ?? "");
  if (/^\s*data:/m.test(s)) {
    for (const line of s.split("\n")) {
      const m = line.match(/^data:\s*(\{.*\})\s*$/);
      if (m) { try { take(JSON.parse(m[1])); } catch { /* partial or non-JSON line */ } }
    }
  } else {
    try { take(JSON.parse(s)); } catch { /* not JSON */ }
  }
  return found;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Total metered spend so far. */
export function meteredUsd(meterText) {
  let total = 0;
  for (const line of String(meterText ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { total += JSON.parse(line).costUsd ?? 0; } catch { /* skip */ }
  }
  return total;
}

async function main() {
  const configText = await new Promise((resolve) => {
    let input = "";
    process.stdin.on("data", (chunk) => {
      input += chunk;
      if (input.includes("\n")) { process.stdin.pause(); resolve(input.slice(0, input.indexOf("\n"))); }
    });
  });
  const config = JSON.parse(configText);
  const upstream = config.upstream.replace(/\/$/, "");
  const meterFile = config.meterFile ?? "/meter/usage.jsonl";
  let spent = fs.existsSync(meterFile) ? meteredUsd(fs.readFileSync(meterFile, "utf8")) : 0;

  const server = http.createServer(async (req, res) => {
    const target = route(req.method, req.url);
    if (!target) { res.writeHead(403).end("Only inference requests are allowed"); return; }
    if (config.maxUsd && spent >= config.maxUsd) { res.writeHead(429).end("Run budget exhausted"); return; }
    const chunks = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) { res.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    let body = Buffer.concat(chunks);
    if (req.method === "POST") {
      let parsed;
      try { parsed = JSON.parse(body.toString()); } catch { res.writeHead(400).end("Request body must be JSON"); return; }
      const screened = screen(parsed, config.models ?? []);
      if (screened.error) { res.writeHead(403).end(screened.error); return; }
      body = Buffer.from(JSON.stringify(screened.body));
    }
    const destination = new URL(upstream + target);
    const transport = destination.protocol === "https:" ? https : http;
    const headers = { "content-type": "application/json", authorization: `Bearer ${config.apiKey}`, ...(config.headers ?? {}) };
    const upstreamReq = transport.request(destination, { method: req.method, headers, timeout: 600_000 }, (reply) => {
      res.writeHead(reply.statusCode, { "content-type": reply.headers["content-type"] || "application/json" });
      let seen = "";
      reply.on("data", (c) => { res.write(c); if (seen.length < 8 * 1024 * 1024) seen += c; });
      reply.on("end", () => {
        res.end();
        for (const u of usageFrom(seen)) {
          spent += u.costUsd ?? 0;
          fs.appendFileSync(meterFile, JSON.stringify({ at: new Date().toISOString(), status: reply.statusCode, ...u }) + "\n");
        }
      });
    });
    upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("Inference timeout")));
    upstreamReq.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Inference upstream unavailable"); });
    upstreamReq.end(body);
  });
  server.listen(8081, "0.0.0.0", () => console.log("inference relay ready"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
