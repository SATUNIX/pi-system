#!/usr/bin/env node
// The run's egress proxy: the only way from the internal network to a public host, and only to
// hosts and ports the contract lists (permissions.network.egress). Runs in its own hardened
// container on the run network and the egress network (like the relay); its configuration
// arrives on stdin; every decision is written to an audit log.
//
// What it does
//   - CONNECT host:port  -> a tunnel, if host and port are on the allowlist. TLS is never
//     inspected or terminated; the tunnel is opaque bytes.
//   - GET/HEAD http://host/path (only for entries with plainGet) -> forwarded, redirects are NOT
//     followed (the client re-asks, and every new request is checked again).
//   - anything else -> refused.
//
// How it avoids being a leak
//   - Host names are normalised (case, one trailing dot) and must match an entry exactly. User
//     info, ports in the wrong place, percent-encoding, wildcards, non-ASCII and IPv6 zone ids
//     make the request malformed. IP-literal hosts (in any spelling: 0x7f.1, 2130706433,
//     [::ffff:127.0.0.1]) are refused unless that exact public address is listed.
//   - The proxy resolves DNS ITSELF, validates EVERY address it got (loopback, private,
//     link-local, metadata, multicast, unique-local, IPv4-mapped/compatible, NAT64, 6to4 and
//     other reserved ranges are refused, unless the destination is a declared run service),
//     then connects to the validated IP. It never hands a name to the connect call, so a second
//     lookup cannot return a different answer (DNS rebinding); every new connection resolves and
//     validates again. After connecting it checks the peer address once more.
//   - Caps: concurrent connections (and per client), bytes per connection, idle time, total
//     connection time, header size. Refused and closed connections are audited.
import dns from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";
import { SERVICE_OK_CLASSES, canonicalIp, classifyAddress, isIpLiteral, normaliseHost } from "./netaddr.mjs";

export const DEFAULT_LIMITS = {
  maxConnections: 64,
  maxPerClient: 32,
  maxBytesPerConnection: 512 * 1024 * 1024,
  connectTimeoutMs: 10_000,
  idleTimeoutMs: 60_000,
  maxConnectionMs: 30 * 60_000,
  maxHeaderBytes: 16 * 1024,
  maxAddresses: 4,
};

const HOP_BY_HOP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"]);

/** Parse the authority of a CONNECT request (`host:port`, `[v6]:port`). Returns { host, port } or { error }. */
export function parseAuthority(text) {
  const s = String(text ?? "");
  if (!s || s.length > 300 || /[\s\0-\x1f]/.test(s)) return { error: "malformed" };
  const m = s.startsWith("[") ? s.match(/^(\[[^\]]+\]):(\d{1,5})$/) : s.match(/^([^:]+):(\d{1,5})$/);
  if (!m) return { error: "malformed" };
  const host = normaliseHost(m[1]);
  const port = Number(m[2]);
  if (!host || !(port >= 1 && port <= 65535)) return { error: "malformed" };
  return { host, port };
}

/** Decide whether a destination is allowed BEFORE any DNS or network activity. */
export function decideDestination({ allow = [], services = [] }, host, port) {
  const ipLiteral = isIpLiteral(host);
  const key = ipLiteral ? canonicalIp(host) : host;
  const entry = allow.find((e) => e.host === key);
  const service = ipLiteral ? null : services.find((s) => s.host === key);
  const match = entry ?? service;
  if (!match) return { ok: false, reason: ipLiteral ? "ip_literal_not_listed" : "not_allowlisted" };
  if (!match.ports.includes(port)) return { ok: false, reason: "port_not_allowed" };
  return { ok: true, key, ipLiteral, entry: entry ?? null, service: service ?? null };
}

/** Is this address acceptable for a destination that matched `decision`? */
export function addressAllowed(address, decision) {
  const cls = classifyAddress(address);
  if (cls === "public") return { ok: true, cls };
  if (decision.service && !decision.entry && SERVICE_OK_CLASSES.has(cls)) return { ok: true, cls };
  return { ok: false, cls, reason: `blocked_address_class:${cls}` };
}

const defaultResolve = async (host) => (await dns.lookup(host, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family }));
const defaultDial = ({ address, port, family, timeoutMs }) => new Promise((resolve, reject) => {
  const socket = net.connect({ host: address, port, family, timeout: timeoutMs });
  socket.once("connect", () => { socket.setTimeout(0); resolve(socket); });
  socket.once("timeout", () => { socket.destroy(); reject(Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" })); });
  socket.once("error", reject);
});

/**
 * @param {{ allow: {host: string, ports: number[], plainGet?: boolean}[], services?: {host: string, ports: number[]}[],
 *   resolve?: Function, dial?: Function, audit?: Function, limits?: object, verifyRemote?: boolean, now?: Function }} options
 * @returns {import("node:http").Server} not listening yet
 */
export function createEgressProxy({ allow = [], services = [], resolve = defaultResolve, dial = defaultDial, audit = () => {}, limits = {}, verifyRemote = true, now = Date.now } = {}) {
  const L = { ...DEFAULT_LIMITS, ...limits };
  const policy = { allow, services };
  let active = 0;
  const perClient = new Map();
  let seq = 0;

  const server = http.createServer({ maxHeaderSize: L.maxHeaderBytes, requestTimeout: 30_000, headersTimeout: 15_000, keepAliveTimeout: 1000 });
  server.stats = () => ({ active, perClient: Object.fromEntries(perClient) });

  const admit = (client) => {
    if (active >= L.maxConnections) return "too_many_connections";
    if ((perClient.get(client) ?? 0) >= L.maxPerClient) return "too_many_connections_for_client";
    active++; perClient.set(client, (perClient.get(client) ?? 0) + 1);
    return null;
  };
  const release = (client) => {
    active = Math.max(0, active - 1);
    const n = (perClient.get(client) ?? 1) - 1;
    if (n <= 0) perClient.delete(client); else perClient.set(client, n);
  };

  /** Resolve, validate every address, connect to a validated IP. Returns { socket, address, resolved } or { deny }. */
  async function reach(host, port, decision) {
    let candidates;
    if (decision.ipLiteral) candidates = [{ address: decision.key, family: net.isIPv6(decision.key) ? 6 : 4 }];
    else {
      try { candidates = await resolve(host); } catch (e) { return { deny: `dns_failed:${e.code ?? "error"}`, resolved: [] }; }
      if (!candidates?.length) return { deny: "dns_no_answer", resolved: [] };
    }
    const resolved = candidates.slice(0, L.maxAddresses).map((c) => c.address);
    for (const c of candidates.slice(0, L.maxAddresses)) {
      const verdict = addressAllowed(c.address, decision);
      if (!verdict.ok) return { deny: verdict.reason, resolved };
    }
    let lastError = "connect_failed";
    for (const c of candidates.slice(0, L.maxAddresses)) {
      try {
        const socket = await dial({ address: c.address, port, family: c.family, timeoutMs: L.connectTimeoutMs });
        if (verifyRemote && socket.remoteAddress) {
          const verdict = addressAllowed(socket.remoteAddress, decision);
          if (!verdict.ok) { socket.destroy(); return { deny: `peer_${verdict.reason}`, resolved }; }
        }
        return { socket, address: c.address, resolved };
      } catch (e) { lastError = `connect_failed:${e.code ?? "error"}`; }
    }
    return { deny: lastError, resolved };
  }

  const finish = (rec, started) => audit({ ...rec, ms: now() - started });

  // --- CONNECT ---
  server.on("connect", async (req, clientSocket, head) => {
    const started = now();
    const id = ++seq;
    const client = clientSocket.remoteAddress ?? "unknown";
    const base = { at: new Date(started).toISOString(), id, client, method: "CONNECT", target: String(req.url).slice(0, 300) };
    const refuse = (status, text, reason, extra = {}) => {
      if (clientSocket.writable) clientSocket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      finish({ ...base, decision: "deny", reason, ...extra }, started);
    };
    clientSocket.on("error", () => {});
    const auth = parseAuthority(req.url);
    if (auth.error) return refuse(400, "Bad Request", "malformed_authority");
    const decision = decideDestination(policy, auth.host, auth.port);
    if (!decision.ok) return refuse(403, "Forbidden", decision.reason, { host: auth.host, port: auth.port });
    const busy = admit(client);
    if (busy) return refuse(503, "Service Unavailable", busy, { host: auth.host, port: auth.port });
    let upstream = null;
    let closed = false;
    let released = false;
    const rel = () => { if (!released) { released = true; release(client); } };
    let bytesUp = 0; let bytesDown = 0;
    const done = (reason, extra = {}) => {
      if (closed) return;
      closed = true;
      rel();
      upstream?.destroy(); clientSocket.destroy();
      finish({ ...base, host: auth.host, port: auth.port, decision: "allow", closed: reason, bytesUp, bytesDown, ...extra }, started);
    };
    clientSocket.on("close", () => done("client_closed"));
    try {
      const r = await reach(auth.host, auth.port, decision);
      if (r.deny) { closed = true; rel(); return refuse(403, "Forbidden", r.deny, { host: auth.host, port: auth.port, resolved: r.resolved }); }
      upstream = r.socket;
      base.resolved = r.resolved; base.connectedTo = r.address;
    } catch (e) { closed = true; rel(); return refuse(502, "Bad Gateway", `error:${e.message}`, { host: auth.host, port: auth.port }); }
    if (closed) { upstream.destroy(); return; }
    upstream.on("error", () => done("upstream_error"));
    upstream.on("close", () => done("upstream_closed"));
    const total = () => bytesUp + bytesDown;
    const count = (dir, n) => { if (dir === "up") bytesUp += n; else bytesDown += n; if (total() > L.maxBytesPerConnection) done("byte_cap"); };
    upstream.on("data", (c) => count("down", c.length));
    clientSocket.on("data", (c) => count("up", c.length));
    clientSocket.setTimeout(L.idleTimeoutMs, () => done("idle_timeout"));
    upstream.setTimeout(L.idleTimeoutMs, () => done("idle_timeout"));
    const life = setTimeout(() => done("max_duration"), L.maxConnectionMs); life.unref?.();
    clientSocket.on("close", () => clearTimeout(life));
    clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    clientSocket.pipe(upstream);
    upstream.pipe(clientSocket);
  });

  // --- plain HTTP GET/HEAD ---
  server.on("request", async (req, res) => {
    const started = now();
    const id = ++seq;
    const client = req.socket.remoteAddress ?? "unknown";
    const base = { at: new Date(started).toISOString(), id, client, method: req.method, target: String(req.url).slice(0, 300) };
    const refuse = (status, reason, extra = {}) => {
      if (!res.headersSent) res.writeHead(status, { "content-type": "text/plain", connection: "close" });
      res.end(`refused: ${reason}\n`);
      finish({ ...base, decision: "deny", reason, ...extra }, started);
    };
    if (req.method !== "GET" && req.method !== "HEAD") return refuse(405, "method_not_allowed");
    let url;
    try { url = new URL(req.url); } catch { return refuse(400, "malformed_url"); }
    if (url.protocol !== "http:") return refuse(400, "only_http_absolute_urls");
    if (url.username || url.password) return refuse(400, "userinfo_in_url");
    if (/%/.test(url.hostname) || /[\s]/.test(req.url)) return refuse(400, "malformed_url");
    const host = normaliseHost(url.hostname.startsWith("[") ? url.hostname : url.hostname);
    const port = url.port ? Number(url.port) : 80;
    if (!host) return refuse(400, "malformed_host");
    const headerHost = String(req.headers.host ?? "").toLowerCase().replace(/\.$/, "");
    if (headerHost && headerHost !== `${host}${url.port ? `:${url.port}` : ""}` && headerHost !== host) return refuse(400, "host_header_mismatch", { host, port });
    const decision = decideDestination(policy, host, port);
    if (!decision.ok) return refuse(403, decision.reason, { host, port });
    if (!decision.entry?.plainGet && !decision.service) return refuse(403, "plain_http_not_allowed", { host, port });
    const busy = admit(client);
    if (busy) return refuse(503, busy, { host, port });
    let released = false;
    const end = (rec) => { if (!released) { released = true; release(client); finish({ ...base, host, port, ...rec }, started); } };
    try {
      const r = await reach(host, port, decision);
      if (r.deny) { released = true; release(client); return refuse(403, r.deny, { host, port, resolved: r.resolved }); }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP_BY_HOP.has(k) && k !== "host") headers[k] = v;
      headers.host = url.host;
      headers.connection = "close";
      // The request goes over the connection reach() already made and validated: a one-shot agent hands it out.
      const agent = new http.Agent({ keepAlive: false });
      agent.createConnection = (_options, cb) => cb(null, r.socket);
      const upstreamReq = http.request({ agent, host: r.address, port, method: req.method, path: `${url.pathname}${url.search}`, headers, timeout: L.idleTimeoutMs }, (up) => {
        const out = {};
        for (const [k, v] of Object.entries(up.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
        res.writeHead(up.statusCode ?? 502, out); // a 3xx is passed through, never followed
        let bytes = 0;
        up.on("data", (c) => { bytes += c.length; if (bytes > L.maxBytesPerConnection) { up.destroy(); res.destroy(); } else res.write(c); });
        up.on("end", () => { res.end(); end({ decision: "allow", status: up.statusCode, bytesDown: bytes, resolved: r.resolved, connectedTo: r.address }); });
        up.on("error", () => { res.destroy(); end({ decision: "allow", closed: "upstream_error", resolved: r.resolved }); });
      });
      upstreamReq.on("timeout", () => upstreamReq.destroy(new Error("timeout")));
      upstreamReq.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); end({ decision: "allow", closed: "upstream_error", resolved: r.resolved }); });
      upstreamReq.end();
    } catch (e) { released = true; release(client); refuse(502, `error:${e.message}`, { host, port }); }
  });

  server.on("clientError", (e, socket) => {
    // Unparseable requests (oversized headers, bytes that are not HTTP, a host the parser rejects) are refused and audited too.
    audit({ at: new Date(now()).toISOString(), id: ++seq, client: socket.remoteAddress ?? "unknown", method: null, target: null, decision: "deny", reason: `client_error:${e.code ?? "parse"}` });
    if (socket.writable) socket.end(`HTTP/1.1 ${e.code === "HPE_HEADER_OVERFLOW" ? "431 Request Header Fields Too Large" : "400 Bad Request"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  return server;
}

/** Build the proxy's allowlist from the resolved contract (supervisor side). */
export function proxyConfigFromContract(contract) {
  const p = contract.permissions.network;
  return {
    allow: p.egress.map((e) => ({ host: e.host, ports: e.ports, plainGet: e.plainGet })),
    services: [],
  };
}

async function main() {
  const line = await new Promise((resolve) => {
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; if (input.includes("\n")) { process.stdin.pause(); resolve(input.slice(0, input.indexOf("\n"))); } });
  });
  const config = JSON.parse(line);
  const auditFile = config.auditFile ?? "/audit/egress.jsonl";
  const server = createEgressProxy({ allow: config.allow ?? [], services: config.services ?? [], limits: config.limits ?? {}, audit: (rec) => { try { fs.appendFileSync(auditFile, `${JSON.stringify(rec)}\n`); } catch { /* audit is best effort, never a reason to open a connection */ } } });
  server.listen(config.port ?? 3128, "0.0.0.0", () => console.log("egress proxy ready"));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
