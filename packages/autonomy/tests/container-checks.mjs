// Facts gathered from INSIDE a hardened container, for tests/autonomy-container-smoke.mjs.
// The test pipes this file to `node -` in a container started with the worker's exact
// arguments, and asserts on the single JSON line it prints. It asserts nothing itself, so a
// failed assertion names the fact, not a stack trace from a container.
//
//   MODE=props    kernel-level properties, and every way out of the internal network
//   MODE=proxy    CONNECT through the egress proxy to each AUTHORITIES entry (+ TLS to TLS_HOST)
//   MODE=infer    a chat completion and the model list through the inference relay
//   MODE=http     GET URL (an in-zone service)
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";

const env = process.env;
const out = { mode: env.MODE };

const attempt = (fn) => fn().then((value) => ({ ok: true, value }), (e) => ({ ok: false, error: String(e.code ?? e.message ?? e) }));
const connect = (host, port, ms = 4000) => new Promise((resolve, reject) => {
  const s = net.connect({ host, port, timeout: ms });
  s.on("connect", () => { s.destroy(); resolve("connected"); });
  s.on("timeout", () => { s.destroy(); reject(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })); });
  s.on("error", reject);
});
const canWrite = (file) => { try { fs.writeFileSync(file, "x"); fs.rmSync(file, { force: true }); return true; } catch { return false; } };

if (env.MODE === "props") {
  const status = Object.fromEntries(fs.readFileSync("/proc/self/status", "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1).trim()]));
  Object.assign(out, {
    uid: process.getuid(), gid: process.getgid(),
    capEff: status.CapEff, capPrm: status.CapPrm, capBnd: status.CapBnd, capInh: status.CapInh, noNewPrivs: status.NoNewPrivs,
    writable: Object.fromEntries(["/usr/x", "/etc/x", "/x", "/run/x", "/tmp/x", "/work/x", "/state/x"].map((f) => [f, canWrite(f)])),
    sockets: ["/var/run/docker.sock", "/run/docker.sock", "/run/podman/podman.sock"].filter((p) => fs.existsSync(p)),
    mountinfo: fs.readFileSync("/proc/self/mountinfo", "utf8"), // the kernel's own mount table, for the firewall's provenance parser
    homes: fs.existsSync("/home") ? fs.readdirSync("/home") : [],
    procNet: fs.readFileSync("/proc/net/route", "utf8").trim().split("\n").slice(1).map((l) => l.split("\t")).map(([iface, dest]) => ({ iface, dest })),
    dnsPublic: await attempt(() => dns.lookup("example.com")),
    tcpPublic: await attempt(() => connect("1.1.1.1", 443)),
    tcpPublicDns: await attempt(() => connect("8.8.8.8", 53)),
    names: {},
    gateways: {},
  });
  for (const name of (env.NAMES ?? "").split(",").filter(Boolean)) out.names[name] = await attempt(() => dns.lookup(name));
  for (const target of (env.HOST_TARGETS ?? "").split(",").filter(Boolean)) {
    const [host, port] = target.split(":");
    out.gateways[target] = await attempt(() => connect(host, Number(port)));
  }
} else if (env.MODE === "proxy") {
  const viaProxy = (authority) => new Promise((resolve, reject) => {
    const s = net.connect({ host: "egress-proxy", port: 3128, timeout: 15_000 });
    let buf = "";
    s.on("error", reject);
    s.on("timeout", () => { s.destroy(); reject(new Error("proxy timeout")); });
    s.on("data", (d) => {
      buf += d;
      if (buf.includes("\r\n\r\n")) { s.removeAllListeners("data"); resolve({ status: Number(buf.slice(9, 12)), socket: s }); }
    });
    s.on("connect", () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
  });
  out.results = {};
  for (const authority of (env.AUTHORITIES ?? "").split(",").filter(Boolean)) {
    const r = await attempt(async () => { const { status, socket } = await viaProxy(authority); socket.destroy(); return status; });
    out.results[authority] = r.ok ? { status: r.value } : { error: r.error };
  }
  if (env.TLS_HOST) {
    out.tls = await attempt(async () => {
      const { status, socket } = await viaProxy(`${env.TLS_HOST}:443`);
      if (status !== 200) throw new Error(`CONNECT answered ${status}`);
      return new Promise((resolve, reject) => {
        // Verification is reported, not enforced: a network that intercepts TLS presents its own CA's certificate, and the tunnel itself is what is under test.
        const t = tls.connect({ socket, servername: env.TLS_HOST, rejectUnauthorized: false, timeout: 15_000 }, () => { const r = { authorized: t.authorized, authorizationError: t.authorizationError ? String(t.authorizationError) : null, protocol: t.getProtocol(), subject: t.getPeerCertificate()?.subject?.CN ?? "" }; t.destroy(); resolve(r); });
        t.on("error", reject);
        t.on("timeout", () => { t.destroy(); reject(new Error("tls timeout")); });
      });
    });
  }
} else if (env.MODE === "infer") {
  const post = (body, headers = {}) => fetch("http://inference:8081/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  const chat = await attempt(async () => { const r = await post({ model: env.MODEL, messages: [{ role: "user", content: "hello" }], max_tokens: 5 }, { authorization: "Bearer worker-placeholder" }); return { status: r.status, body: await r.text() }; });
  const other = await attempt(async () => (await post({ model: "some/other-model", messages: [], max_tokens: 1 })).status);
  const models = await attempt(async () => (await fetch("http://inference:8081/v1/models", { signal: AbortSignal.timeout(20_000) })).status);
  const keys = await attempt(async () => (await fetch("http://inference:8081/v1/keys", { signal: AbortSignal.timeout(20_000) })).status);
  Object.assign(out, { chat, other, models, keys });
} else if (env.MODE === "http") {
  out.get = await attempt(async () => { const r = await fetch(env.URL, { redirect: "manual", signal: AbortSignal.timeout(10_000) }); return { status: r.status, body: (await r.text()).slice(0, 2000) }; });
} else {
  out.error = `unknown MODE ${env.MODE}`;
}
console.log(JSON.stringify(out));
