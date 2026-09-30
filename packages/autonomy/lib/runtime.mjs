// The real runtime of the engine (lib/engine.mjs): rootless Podman or Docker. It builds the
// hardened container argument lists (lib/docker.mjs), re-checks EVERY `run` against the boundary
// (lib/containment.mjs) before executing it, and does the parts that need the container engine:
// the run network, the relay and the egress proxy, run services, the boundary probe, worker
// sessions over pi's RPC channel, the bundle/snapshot/deploy helpers and the acceptance checks.
// The interface it implements is documented at the top of lib/engine.mjs; tests use the fake
// runtime in packages/autonomy/tests/fake-runtime.mjs instead.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { meteredUsd } from "../relay.mjs";
import { PROVIDERS } from "./contract.mjs";
import { assertRunArgs } from "./containment.mjs";
import * as dk from "./docker.mjs";
import { proxyConfigFromContract } from "./egress-proxy.mjs";
import { readJson, writeJsonAtomic } from "./fsutil.mjs";
import { HostRepo } from "./hostrepo.mjs";
import { openRouterComplete } from "./manager.mjs";
import { BARE_REPO_CONFIG } from "./mirror.mjs";
import { agentModelsJson, modelEntries, plainModelEntries } from "./models.mjs";
import { reviewTask } from "./review.mjs";
import { lineParser, missingHarness } from "./rpc.mjs";

const LIB = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(LIB, "..");
const pad = (n) => String(n).padStart(2, "0");

/** The inference key for a run: the operator's environment first, then pi's login file for providers that use one. Never written anywhere. */
export function providerKey(contract, env = process.env) {
  const s = contract.providerSettings;
  if (s.apiKeyEnv && env[s.apiKeyEnv]) return env[s.apiKeyEnv];
  if (s.authName) {
    const dir = env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
    const entry = readJson(path.join(dir, "auth.json"), {})?.[s.authName];
    const key = typeof entry === "string" ? entry : entry?.key;
    if (key) return key;
  }
  throw new Error(`No inference key for provider ${contract.model.provider}: set ${s.apiKeyEnv ?? "the provider's key variable"} in the supervisor's environment${s.authName ? ` or log in to ${s.authName} in pi (auth.json)` : ""}. It is handed to the relay on stdin and never enters a worker container.`);
}

export class DockerRuntime {
  /** @param {{ contract: object, cfg: object, store: import("./store.mjs").RunStore, env?: object }} o */
  constructor({ contract, cfg, store, env = process.env }) {
    Object.assign(this, { contract, cfg, store, env });
    this.p = store.p;
    this.bin = cfg.engine;
    this.names = dk.names(cfg);
    this.repo = new HostRepo({ gitDir: this.p.mirror, cfg });
    this.tickMs = cfg.mirrorSeconds * 1000;
    this.apiKey = null;
    this.relay = null;
    this.proxy = null;
    this.harnessFailure = null;
    this.harnessOk = false;
    this.roots = [this.p.root, PKG];
  }

  now() { return Date.now(); }
  sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
  log(line) { console.log(`${new Date().toISOString()} ${line}`); }
  workerProblem() { return this.harnessFailure; }

  // --- engine calls ---------------------------------------------------------------------------------
  cli(args, { timeoutMs = 120_000, input, allowFail = false, env } = {}) {
    const r = spawnSync(this.bin, args, { encoding: "utf8", timeout: timeoutMs, input, maxBuffer: 32 * 1024 * 1024, env: env ?? process.env });
    if (r.error || r.status !== 0) {
      if (allowFail) return null;
      const err = r.error?.message ?? r.stderr.trim();
      throw new Error(`${this.bin} ${args[0]} failed: ${/permission denied.*docker/i.test(err) ? `${err} (use "runtime.engine": "podman", or give your user Docker access; see docs/autonomy.md)` : err}`);
    }
    return r.stdout.trim();
  }

  /** The containment check every `run` passes before it executes. */
  checked(args, { networks = [], role, secretEnvNames = [] }) {
    return assertRunArgs(args, { roots: this.roots, networks, role, secretEnvNames, allowRoot: this.contract.runtime.user === "0:0" });
  }

  /** Run a helper container to completion. Resolves { code, stdout, stderr, timedOut }. */
  helper(args, { role, networks = [], timeoutMs, secretEnv = {} }) {
    this.checked(args, { networks, role, secretEnvNames: Object.keys(secretEnv) });
    return new Promise((resolve) => {
      const child = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...secretEnv } });
      let stdout = ""; let stderr = ""; let timedOut = false;
      child.stdout.on("data", (c) => { if (stdout.length < 4e6) stdout += c; });
      child.stderr.on("data", (c) => { if (stderr.length < 4e6) stderr += c; });
      const name = args[args.indexOf("--name") + 1];
      const timer = setTimeout(() => { timedOut = true; spawnSync(this.bin, ["rm", "-f", name], { stdio: "ignore", timeout: 30_000 }); }, timeoutMs);
      child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr, timedOut }); });
      child.on("error", (e) => { clearTimeout(timer); resolve({ code: 1, stdout, stderr: String(e), timedOut }); });
    });
  }

  // --- the zone ---------------------------------------------------------------------------------------
  async preflight() {
    this.cli(["version"]);
    this.cli(["image", "inspect", this.cfg.image, "--format", "{{.Id}}"]);
    const user = dk.userSpec(this.cfg);
    if (user.split(":")[0] === "0" && this.contract.runtime.user !== "0:0") throw new Error('the supervisor runs as root, so runtime.user "host" would run containers as root, which is never allowed. Run it as your own user, or set runtime.user to a non-root "uid:gid" (rootless Docker: "0:0", explicitly).');
    this.apiKey = providerKey(this.contract, this.env);
  }

  async prepare({ log }) {
    const { cfg, p } = this;
    this.repo.init();
    const baseSha = this.repo.seedBase();
    this.snapshotReferences(log);
    spawnSync("git", ["init", "--quiet", "--bare", p.remote]);
    for (const [k, v] of BARE_REPO_CONFIG) spawnSync("git", ["--git-dir", p.remote, "config", k, v]);
    // remote.git is created while it is still pristine; once a worker runs, the host only reaches it through containers.
    const pushed = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "--git-dir", p.mirror, "push", "--quiet", p.remote, `refs/heads/${cfg.branch}:refs/heads/${cfg.branch}`], { encoding: "utf8" });
    if (pushed.status !== 0) throw new Error(`seeding the worker's repository failed: ${pushed.stderr}`);
    return { baseSha };
  }

  /** Reference repos: tracked files at HEAD only, so no .git internals or untracked local files (credentials, .env) reach a container. */
  snapshotReferences(log = () => {}) {
    for (const [name, src] of Object.entries(this.cfg.references ?? {})) {
      const dest = path.join(this.p.references, name);
      fs.mkdirSync(dest, { recursive: true });
      let repoDir = src;
      let tmp = null;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(src) || /^[^/\s]+@[^/\s]+:/.test(src)) {
        tmp = fs.mkdtempSync(path.join(this.p.tmp, "ref-"));
        const clone = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--depth", "1", src, tmp], { encoding: "utf8" });
        if (clone.status !== 0) throw new Error(`reference ${name}: cannot fetch ${src}: ${clone.stderr.trim().slice(0, 200)}`);
        repoDir = tmp;
      }
      const archive = spawnSync("git", ["-C", repoDir, "archive", "--format=tar", "HEAD"], { maxBuffer: 512 * 1024 * 1024 });
      if (archive.status !== 0) throw new Error(`reference ${name}: git archive failed in ${src}`);
      const untar = spawnSync("tar", ["-x", "-C", dest], { input: archive.stdout });
      if (untar.status !== 0) throw new Error(`reference ${name}: extract failed`);
      const sha = spawnSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
      log(`reference ${name}: ${src} at ${sha.slice(0, 12)} -> /reference/${name} (read-only)`);
    }
  }

  // --- bring up the zone: networks, relay, proxy, services, probe -------------------------------------
  async bringUp({ log }) {
    this.networks();
    await this.writeModelSpecs(log);
    await this.startRelay(log);
    if (this.contract.permissions.network.egress.length) await this.startProxy(log);
    await this.startServices(log);
    return this.probe(log);
  }

  networks() {
    for (const args of dk.networkCreateArgs(this.cfg)) {
      if (this.cli(["network", "inspect", args.at(-1)], { allowFail: true }) === null) this.cli(args);
    }
    if (this.cli(["network", "inspect", this.names.net, "--format", "{{.Internal}}"]) !== "true") throw new Error(`network ${this.names.net} exists but is not internal; remove it and resume`);
    if (this.bin === "docker" && this.cli(["network", "inspect", this.names.net, "--format", `{{index .Options "${dk.HOSTLESS_OPTION}"}}`]) !== "true") throw new Error(`network ${this.names.net} exists without ${dk.HOSTLESS_OPTION}=true, so the host would be reachable from the zone through the bridge address; remove it and resume`);
  }

  /** The IPv4 addresses on the run's networks that the host itself could answer on (subnet first host, gateways): what a worker must not be able to reach. */
  zoneHostAddresses() {
    const found = new Set(["172.17.0.1"]); // the engine's default bridge gateway
    const walk = (v) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          if (typeof x === "string" && /^gateway$/i.test(k) && /^\d+\.\d+\.\d+\.\d+$/.test(x)) found.add(x);
          else if (typeof x === "string" && /^subnet$/i.test(k) && /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(x)) {
            const o = x.split("/")[0].split(".").map(Number);
            found.add(`${o[0]}.${o[1]}.${o[2]}.${o[3] + 1}`);
          } else walk(x);
        }
      }
    };
    for (const network of [this.names.net, this.names.egress]) {
      const raw = this.cli(["network", "inspect", network], { allowFail: true });
      try { walk(JSON.parse(raw ?? "[]")); } catch { /* an unreadable network adds nothing to try */ }
    }
    return [...found];
  }

  async writeModelSpecs(log) {
    const { contract, cfg, p } = this;
    let entries = [];
    if (contract.model.provider === "openrouter") {
      try {
        const res = await fetch(`${cfg.upstream.replace(/\/$/, "")}/models`, { headers: { authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(30_000) });
        entries = modelEntries((await res.json()).data, cfg.models);
      } catch (e) { log(`model specs unavailable (${e.message}); pi falls back to its defaults`); }
      const missing = cfg.models.filter((id) => !entries.some((m) => m.id === id));
      if (missing.length) log(`model specs: ${missing.join(", ")} not in the upstream list`);
    } else entries = plainModelEntries(cfg.models, contract.providerSettings.pricing);
    fs.mkdirSync(p.agentState, { recursive: true });
    writeJsonAtomic(path.join(p.agentState, "run-models.json"), agentModelsJson(entries, contract.model.provider));
    for (const m of entries) if (m.contextWindow) log(`model ${m.id}: context ${m.contextWindow}, max output ${m.maxTokens}`);
  }

  /** Start a long-lived hardened container that idles, then run a server in it with its config on stdin (the key never touches an argument list or a file). */
  async startServer({ removeName, runArgs, connect, execArgs, config, readyText, log, label, role }) {
    this.cli(["rm", "-f", removeName], { allowFail: true });
    this.checked(runArgs, { networks: [this.names.egress], role });
    this.cli(runArgs);
    this.cli(connect);
    const child = spawn(this.bin, execArgs, { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.on("data", (c) => fs.appendFileSync(path.join(this.p.meter, `${label}.log`), c));
    child.stdin.end(`${JSON.stringify(config)}\n`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} did not start within 20s`)), 20_000);
      child.stdout.on("data", (c) => { if (String(c).includes(readyText)) { clearTimeout(timer); resolve(); } });
      child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`${label} exited (${code})`)); });
    });
    child.removeAllListeners("exit");
    child.on("exit", (code) => { log(`${label} exited (${code})`); });
    log(`${label} ready`);
    return child;
  }

  async startRelay(log) {
    const { contract, cfg, p, names } = this;
    fs.mkdirSync(p.meter, { recursive: true });
    const state = this.store.readState();
    this.relay?.kill();
    this.relay = await this.startServer({
      removeName: names.relay, runArgs: dk.relayRunArgs(cfg, p, path.join(PKG, "relay.mjs")), connect: ["network", "connect", "--alias", dk.RELAY_HOST, names.net, names.relay], execArgs: dk.relayExecArgs(cfg),
      config: { upstream: cfg.upstream, apiKey: this.apiKey, meterFile: "/meter/usage.jsonl", maxUsd: state.limits.budget.totalUsd, models: cfg.models, provider: contract.model.provider, pricing: contract.providerSettings.pricing, headers: { "X-Title": `pi-autonomy ${cfg.run}`, ...contract.providerSettings.headers } },
      readyText: "ready", log, label: "relay", role: "relay",
    });
  }

  async startProxy(log) {
    const { cfg, p, names } = this;
    fs.mkdirSync(p.egress, { recursive: true });
    this.proxy?.kill();
    this.proxy = await this.startServer({
      removeName: names.proxy, runArgs: dk.proxyRunArgs(cfg, p, { script: path.join(LIB, "egress-proxy.mjs"), netaddr: path.join(LIB, "netaddr.mjs") }), connect: ["network", "connect", "--alias", dk.PROXY_HOST, names.net, names.proxy], execArgs: dk.proxyExecArgs(cfg),
      config: { ...proxyConfigFromContract(this.contract), auditFile: "/audit/egress.jsonl" }, readyText: "ready", log, label: "egress-proxy", role: "proxy",
    });
  }

  async startServices(log) {
    const { contract, cfg, p, names } = this;
    for (const svc of contract.permissions.network.services) {
      this.cli(["rm", "-f", names.service(svc.name)], { allowFail: true });
      svc.workspaceMounts.forEach((_m, i) => fs.mkdirSync(dk.deployDir(p, svc.name, i), { recursive: true }));
      const { args, secretEnv } = dk.serviceRunArgs(cfg, p, svc);
      const values = {};
      for (const [envName, credName] of Object.entries(secretEnv)) {
        if (!this.env[credName]) throw new Error(`service ${svc.name} needs credential ${credName} from the supervisor's environment, and it is not set`);
        values[envName] = this.env[credName];
      }
      this.checked(args, { networks: [names.net], role: "service", secretEnvNames: Object.keys(values) });
      const r = spawnSync(this.bin, args, { encoding: "utf8", env: { ...process.env, ...values }, timeout: 120_000 });
      if (r.status !== 0) throw new Error(`starting service ${svc.name} failed: ${r.stderr.trim().slice(0, 300)}`);
      log(`service ${svc.name} started (${svc.image})`);
    }
    // Services that serve nothing from the workspace should be healthy now; the others get their content after the first deploy.
    for (const svc of contract.permissions.network.services.filter((s) => !s.workspaceMounts.length)) {
      const ok = await this.waitHealthy(svc, { path: svc.health.path, expectStatus: svc.health.expectStatus });
      if (!ok.ok) throw new Error(`service ${svc.name} is not healthy after ${svc.health.retries} checks: ${ok.detail}`);
      log(`service ${svc.name} healthy`);
    }
  }

  async probeService(svc, { path: urlPath, expectStatus }) {
    if (svc.health.cmd) {
      const r = spawnSync(this.bin, ["exec", this.names.service(svc.name), ...svc.health.cmd], { encoding: "utf8", timeout: (svc.health.timeoutSeconds + 5) * 1000 });
      return { ok: r.status === 0, detail: r.status === 0 ? "health command succeeded" : `health command exited ${r.status}` };
    }
    const args = dk.healthProbeRunArgs(this.cfg, this.p, { url: `http://${svc.name}:${svc.port}${urlPath ?? "/"}`, expectStatus: expectStatus ?? 200, timeoutSeconds: svc.health.timeoutSeconds });
    const r = await this.helper(args, { role: "probe", networks: [this.names.net], timeoutMs: (svc.health.timeoutSeconds + 20) * 1000 });
    return { ok: r.code === 0, detail: `${svc.name}${urlPath ?? "/"} answered ${r.stdout.trim() || r.stderr.trim().slice(-100) || "nothing"}` };
  }

  async waitHealthy(svc, opts) {
    let last = { ok: false, detail: "not checked" };
    for (let i = 0; i < svc.health.retries; i++) {
      last = await this.probeService(svc, opts);
      if (last.ok) return last;
      await this.sleep(svc.health.intervalSeconds * 1000);
    }
    return last;
  }

  async serviceHealth({ check }) {
    const svc = this.contract.permissions.network.services.find((s) => s.name === check.service);
    if (!svc) return { ok: false, detail: `no service ${check.service}` };
    return this.waitHealthy(svc, { path: check.path, expectStatus: check.expectStatus });
  }

  /** The boundary probe in a container started with the worker's exact arguments, with the effort snapshot and unattended environment. */
  async probe(log) {
    const { cfg, p, contract } = this;
    const state = this.store.readState();
    const args = dk.agentRunArgs(cfg, p, { n: 0, attempt: "probe", reset: false, effort: state.effort }).filter((a) => a !== "-i");
    const at = args.lastIndexOf(cfg.image);
    const keyHash = createHash("sha256").update(this.apiKey).digest("hex");
    const keyRegex = contract.model.provider === "openrouter" ? "sk-or-v1-[0-9a-f]{32,}" : "[A-Za-z0-9_.-]{24,200}";
    const allow = contract.permissions.network.egress.map((e) => `${e.host}:${e.ports[0]}`).join(",");
    const services = contract.permissions.network.services.map((s) => `${s.name}:${s.port}`).join(",");
    // A canary listener on the host, on every interface: the zone must not reach it at any address the host holds on the run's networks.
    const canary = net.createServer((s) => s.destroy());
    await new Promise((resolve) => canary.listen(0, "0.0.0.0", resolve));
    const canaryPort = canary.address().port;
    const hostTargets = this.zoneHostAddresses().map((ip) => `${ip}:${canaryPort}`).join(",");
    const probeArgs = [...args.slice(0, at), "--env", `AUTONOMY_KEY_SHA256=${keyHash}`, "--env", `AUTONOMY_KEY_REGEX=${keyRegex}`, "--env", `AUTONOMY_EGRESS_ALLOW=${allow}`, "--env", `AUTONOMY_SERVICES=${services}`, "--env", `AUTONOMY_HOST_CANARY=${hostTargets}`,
      "--mount", `type=bind,source=${path.join(PKG, "tests", "boundary-probe.mjs")},target=/probe.mjs,readonly`, "--entrypoint", "node", cfg.image, "/probe.mjs"];
    let r;
    try { r = await this.helper(probeArgs, { role: "worker", networks: [this.names.net], timeoutMs: 180_000 }); } finally { canary.close(); }
    let report;
    try { report = JSON.parse(r.stdout.trim().split("\n").at(-1)); } catch { throw new Error(`boundary probe gave no report (exit ${r.code}): ${r.stderr.trim().slice(-500)}`); }
    fs.writeFileSync(p.boundary, `${JSON.stringify({ at: new Date().toISOString(), ...report }, null, 2)}\n`);
    for (const c of report.checks) if (!c.ok) log(`boundary FAIL ${c.name}: ${c.detail}`);
    log(`boundary probe: ${report.checks.filter((c) => c.ok).length} of ${report.checks.length} checks passed`);
    return report;
  }

  async tearDown() {
    this.relay?.kill(); this.relay = null;
    this.proxy?.kill(); this.proxy = null;
    const n = this.names;
    for (const svc of this.contract.permissions.network.services) this.cli(["rm", "-f", n.service(svc.name)], { allowFail: true });
    for (const name of [n.relay, n.proxy]) this.cli(["rm", "-f", name], { allowFail: true });
    for (const net of [n.net, n.egress]) this.cli(["network", "rm", net], { allowFail: true });
  }

  /** After a crash: everything the run labelled is removed, so a resumed run never meets a stray worker, relay or service. */
  async cleanupOrphans() {
    const listed = this.cli(dk.listRunContainersArgs(this.cfg), { allowFail: true });
    const names = listed ? listed.split("\n").filter(Boolean) : [];
    for (const name of names) this.cli(["rm", "-f", name], { allowFail: true });
    return names;
  }

  // --- the worker -------------------------------------------------------------------------------------
  startWorker({ step, attempt, resetWorkspace, effort, onEvent }) {
    const { cfg, p, names } = this;
    const dir = path.join(p.steps, pad(step));
    fs.mkdirSync(dir, { recursive: true });
    const args = dk.agentRunArgs(cfg, p, { n: step, attempt, reset: resetWorkspace, effort });
    this.checked(args, { networks: [names.net], role: "worker" });
    const events = fs.createWriteStream(path.join(dir, `events-${attempt}.jsonl`), { flags: "a" });
    const stderr = fs.createWriteStream(path.join(dir, `agent-${attempt}.log`), { flags: "a" });
    const child = spawn(this.bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    child.stderr.pipe(stderr);
    child.stdin.on("error", () => {});
    child.stdout.on("data", lineParser((msg) => {
      if (msg.type === "response" && msg.id === "harness-check") {
        const missing = missingHarness(msg);
        if (missing.length) { this.harnessFailure = `the kit harness did not load (missing commands: ${missing.join(", ")}); see ${path.join(dir, `agent-${attempt}.log`)}`; this.log(`HARNESS FAIL: ${this.harnessFailure}`); }
        else if (!this.harnessOk) { this.harnessOk = true; this.log("harness verified: kit commands registered"); }
        return;
      }
      // Streaming deltas and partial tool output are most of the volume and none of the signal.
      if (msg.type !== "message_update" && msg.type !== "tool_execution_update") events.write(`${JSON.stringify({ at: new Date().toISOString(), ...msg })}\n`);
      onEvent(msg);
    }, (bad) => stderr.write(`[non-json stdout] ${bad.slice(0, 500)}\n`)));
    const exited = new Promise((resolve) => child.on("close", (code) => { events.end(); resolve({ code: code ?? 1 }); }));
    child.stdin.write(`${JSON.stringify({ id: "harness-check", type: "get_commands" })}\n`); // pi answers commands in order
    const name = names.agent(step, attempt);
    return {
      name,
      send: (msg) => { if (child.stdin.writable) child.stdin.write(`${JSON.stringify(msg)}\n`); },
      exited,
      stop: async () => {
        if (child.exitCode !== null) return;
        if (child.stdin.writable) { child.stdin.write(`${JSON.stringify({ type: "abort" })}\n`); child.stdin.end(); }
        const done = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 30_000))]);
        if (!done) { this.cli(["rm", "-f", name], { allowFail: true }); await exited; }
      },
    };
  }

  async snapshotWork({ message }) {
    const r = await this.helper(dk.snapshotRunArgs(this.cfg, this.p, { message }), { role: "snapshot", timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`snapshot failed: ${r.stderr.trim().slice(-300)}`);
  }

  async fetchWorkerBundle() {
    const bundle = path.join(this.p.bundles, "agent.bundle");
    fs.mkdirSync(this.p.bundles, { recursive: true });
    fs.rmSync(bundle, { force: true });
    const r = await this.helper(dk.bundleRunArgs(this.cfg, this.p), { role: "bundle", timeoutMs: 120_000 });
    if (r.code !== 0 || !fs.existsSync(bundle)) return { error: `bundle failed: ${r.stderr.trim().slice(-300)}` };
    return { bundle };
  }

  /** Point the worker's repository at the mirror's working branch; unmerged cycles' tags travel along as attempts/<run>/cycle-NN. */
  async setWorkerBranch(sha, extraRefs = []) {
    const bundle = this.repo.bundleBranch(path.join(this.p.bundles, "setref.bundle"), extraRefs);
    const r = await this.helper(dk.setAgentRefRunArgs(this.cfg, this.p, { bundleFile: bundle, sha: this.repo.head() }), { role: "setref", timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`setting the worker's branch failed: ${r.stderr.trim().slice(-300)}`);
  }

  /** Refresh each service's staged copy of its workspace mounts (in a network-less container), and restart services that read their code at start. */
  async deploy({ sha }) {
    for (const svc of this.contract.permissions.network.services) {
      if (!svc.workspaceMounts.length) continue;
      for (const [i, m] of svc.workspaceMounts.entries()) {
        fs.mkdirSync(dk.deployDir(this.p, svc.name, i), { recursive: true });
        const r = await this.helper(dk.deploySyncRunArgs(this.cfg, this.p, { service: svc.name, index: i, source: m.source }), { role: "deploy-sync", timeoutMs: 120_000 });
        if (r.code !== 0) throw new Error(`deploying ${m.source} to ${svc.name} failed: ${r.stderr.trim().slice(-300)}`);
      }
      if (svc.restartOnDeploy) this.cli(["restart", this.names.service(svc.name)], { allowFail: true });
    }
    this.log(`deployed ${sha.slice(0, 12)} into the run's services`);
  }

  // --- trusted checks ----------------------------------------------------------------------------------
  async runCheck({ check, sha }) {
    const { p } = this;
    const bundle = path.join(p.bundles, `check-${check.id}.bundle`);
    this.repo.bundleBranch(bundle);
    fs.rmSync(p.gateWork, { recursive: true, force: true });
    fs.mkdirSync(p.gateWork, { recursive: true });
    const hasOverlay = fs.existsSync(p.overlay) && fs.readdirSync(p.overlay).length > 0;
    const started = Date.now();
    const r = await this.helper(dk.checkRunArgs(this.cfg, p, { bundleFile: bundle, sha, checkId: check.id, runnerScript: path.join(LIB, "check-runner.mjs"), hasOverlay }), { role: "check", timeoutMs: (check.timeoutMinutes + 2) * 60_000 });
    fs.rmSync(bundle, { force: true });
    const read = (f) => { try { return fs.readFileSync(path.join(p.gateWork, f), "utf8").slice(-4000); } catch { return ""; } };
    const detail = readJson(path.join(p.gateWork, "result.json"), null);
    return { exitCode: r.code, timedOut: r.timedOut || r.code === 124, seconds: Math.round((Date.now() - started) / 1000), tail: read("gate.log") || read("check.log") || r.stderr.trim().slice(-2000), steps: Array.isArray(detail?.steps) ? detail.steps : undefined };
  }

  // --- money and models ---------------------------------------------------------------------------------
  usageUsd() {
    const read = (f) => { try { return meteredUsd(fs.readFileSync(path.join(this.p.meter, f), "utf8")); } catch { return 0; } };
    return read("usage.jsonl") + read("manager.jsonl");
  }

  /** A host-side chat-completions call (manager, merge review, task review); its spend is metered with the run's. */
  complete(model, { timeoutMs } = {}) {
    const { contract, cfg, p } = this;
    const meterFile = path.join(p.meter, "manager.jsonl");
    const pricing = contract.providerSettings.pricing[model];
    return openRouterComplete({
      apiKey: this.apiKey, model, upstream: cfg.upstream, timeoutMs, usageInclude: PROVIDERS[contract.model.provider]?.reportsCost ?? false,
      onUsage: (u) => {
        const computed = pricing ? ((u.prompt_tokens ?? 0) * pricing.inputPerMTok + (u.completion_tokens ?? 0) * pricing.outputPerMTok) / 1e6 : 0;
        fs.mkdirSync(p.meter, { recursive: true });
        fs.appendFileSync(meterFile, `${JSON.stringify({ at: new Date().toISOString(), model, costUsd: u.cost ?? computed })}\n`);
      },
    });
  }

  review(bundle) {
    return reviewTask(bundle, this.complete(this.contract.model.review, { timeoutMs: 300_000 }), { sleep: (ms) => this.sleep(ms) });
  }
}
