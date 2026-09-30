#!/usr/bin/env node
/**
 * Offline checks for the resolved boundary and the containment of every container the
 * supervisor starts: the boundary digest and its rendering, the start/authorisation decision,
 * the worker environment contract, and table-driven positive AND negative tests over the
 * container argument builders (lib/docker.mjs) and the containment validator
 * (lib/containment.mjs): non-root, read-only rootfs, all capabilities dropped, no-new-privileges,
 * resource limits, internal network only, no privileged mode, no host namespaces, no engine
 * socket, no home or credential store, no credentials in argv or environment. No Docker needed.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, implementRaw, makeChecker, testEffort } from "./autonomy-helpers.mjs";
import { resolveContract } from "../packages/autonomy/lib/contract.mjs";
import { authorisationStatus, boundaryDigest, boundaryFields, decideStart, renderBoundary } from "../packages/autonomy/lib/boundary.mjs";
import { WORKER_CONTRACT_PATH, workerEnv } from "../packages/autonomy/lib/worker-env.mjs";
import { runtimeConfig } from "../packages/autonomy/lib/runcfg.mjs";
import { runPaths } from "../packages/autonomy/lib/paths.mjs";
import * as dk from "../packages/autonomy/lib/docker.mjs";
import { assertRunArgs, inspectRunArgs } from "../packages/autonomy/lib/containment.mjs";

const { check, done } = makeChecker("autonomy-boundary-smoke");
const PKG = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "autonomy");
const resolve = (raw) => { const r = resolveContract(raw, { effort: testEffort }); assert.equal(r.ok, true, JSON.stringify(r.problems)); return r.contract; };
const NET = { egress: [{ host: "registry.npmjs.org", ports: [443] }] };
const svc = { name: "web", image: "nginxinc/nginx-unprivileged:1.27-alpine", port: 8080, workspaceMounts: [{ source: "dist", target: "/usr/share/nginx/html" }], tmpfs: ["/tmp"], credentialEnv: { API_SECRET: "WEB_SECRET" }, env: { MODE: "test" }, health: { path: "/" } };
// An explicit non-root uid:gid, so the suite behaves the same whichever user runs it (with user "host" a root-run supervisor is refused, correctly).
const RUNTIME = { user: "10001:10001" };
const base = resolve(implementRaw({ permissions: { network: NET, credentials: { names: [] }, unattended: { authorised: true, autoApprove: true } }, effort: "E3", runtime: RUNTIME }));
const deployContract = resolve({ ...implementRaw({ permissions: { network: { ...NET, serviceImages: [svc.image], services: [svc] }, credentials: { names: ["WEB_SECRET"] }, unattended: { authorised: true, autoApprove: true } }, runtime: RUNTIME }), template: "deploy" });

await check("digest: covers the security-relevant fields only, is stable, and changes with every one of them", () => {
  const d = boundaryDigest(base);
  assert.match(d, /^[a-f0-9]{64}$/);
  assert.equal(boundaryDigest(structuredClone(base)), d, "stable");
  const reverseKeys = (v) => (Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reverseKeys(v[k])])) : v);
  const reordered = reverseKeys(base);
  assert.equal(boundaryDigest(reordered), d, "independent of key order");
  const same = (mut) => { const c = structuredClone(base); mut(c); return boundaryDigest(c); };
  // Not part of the boundary: what the task is called and described, and which run this is.
  for (const mut of [(c) => { c.run = "another-run-9"; }, (c) => { c.objective.title = "Other"; }, (c) => { c.objective.spec = "Different spec."; }, (c) => { c.objective.backlog.push({ id: "T9", title: "x" }); }, (c) => { c.authorisation = { boundaryDigest: "a".repeat(64), by: "x", at: "y" }; }, (c) => { c.runtime.mirrorSeconds = 5; }]) assert.equal(same(mut), d);
  // Part of it: anything that changes what the run may touch, spend, run or promote.
  const changes = [
    (c) => { c.permissions.network.egress.push({ host: "example.org", ports: [443], plainGet: false }); },
    (c) => { c.permissions.network.egress[0].ports = [443, 80]; },
    (c) => { c.permissions.writeAreas = ["src/**"]; },
    (c) => { c.permissions.credentials.names = ["X_TOKEN"]; },
    (c) => { c.permissions.unattended.autoApprove = false; },
    (c) => { c.permissions.unattended.authorised = false; c.permissions.unattended.autoApprove = false; },
    (c) => { c.permissions.outputs.destinations = [{ kind: "export-dir", path: "/tmp/out" }]; },
    (c) => { c.promotion = { policy: "push", requiresOperatorApproval: false, destinations: [{ kind: "git-remote", url: "https://git.example.org/a.git", branch: "pi/x", tags: false }] }; },
    (c) => { c.promotion.requiresOperatorApproval = false; },
    (c) => { c.model.worker = "other/model"; },
    (c) => { c.model.provider = "openai-compatible"; },
    (c) => { c.providerSettings.upstream = "https://llm.example.org/v1"; },
    (c) => { c.effort = { tier: "thorough", cap: "thorough" }; },
    (c) => { c.effort.cap = "exhaustive"; },
    (c) => { c.budget.totalUsd += 1; },
    (c) => { c.budget.maxMinutes += 1; },
    (c) => { c.recovery.hardRestarts += 1; },
    (c) => { c.runtime.image = "pi-autonomy:other"; },
    (c) => { c.runtime.memory = "12g"; },
    (c) => { c.runtime.user = "0:0"; },
    (c) => { c.acceptance.checks[0].run = ["true"]; },
    (c) => { c.acceptance.review = false; },
    (c) => { c.inputs.references = { docs: "/refs/docs" }; },
    (c) => { c.inputs.repository = { path: "/repo", ref: "main" }; },
    (c) => { c.templateOptions = { anything: 1 }; },
  ];
  const seen = new Set([d]);
  for (const [i, mut] of changes.entries()) { const x = same(mut); assert.ok(!seen.has(x), `change #${i} must change the digest`); seen.add(x); }
  assert.deepEqual(Object.keys(boundaryFields(base)).sort(), ["acceptance", "boundaryVersion", "budget", "credentials", "effort", "filesystem", "inputs", "model", "network", "outputs", "process", "promotion", "recovery", "template", "templateOptions", "unattended"]);
  assert.equal(JSON.stringify(boundaryFields(base)).includes(base.objective.spec), false, "the specification is not part of the boundary");
});

await check("render: the effective boundary as readable text and JSON, with the digest, listing every dimension", () => {
  const r = renderBoundary(base, { effort: testEffort });
  assert.equal(r.digest, boundaryDigest(base));
  assert.equal(r.json.digest, r.digest);
  assert.ok(r.json.boundary.network.egress.length === 1 && r.json.invariants.length >= 5);
  for (const word of ["Filesystem", "Network", "Credentials", "Processes and resources", "Unattended operation", "Outputs and promotion", "Model and effort", "Budget and recovery", "Completion", "registry.npmjs.org:443", "digest " + r.digest, "read-only", "no route off the host", "is never privileged"]) assert.ok(r.text.includes(word), `boundary text mentions ${word}`);
  assert.match(r.text, /promotion: none\. Nothing is pushed/);
  assert.match(r.text, /E3/);
  assert.match(r.text, /fixed when the run starts/);
  const none = renderBoundary(resolve(implementRaw({ permissions: {} })), { effort: testEffort }).text;
  assert.match(none, /egress: none/);
  assert.match(none, /run services: none/);
  assert.match(none, /not authorised: the worker's normal approval prompts apply/);
  const push = renderBoundary(resolve(implementRaw({ promotion: { policy: "push", destinations: [{ kind: "git-remote", url: "https://git.example.org/a.git", branch: "pi/x" }] } })), { effort: testEffort }).text;
  assert.match(push, /PUSH to https:\/\/git\.example\.org\/a\.git \(pi\/x\); each push needs your approval/);
  const dep = renderBoundary(deployContract, { effort: testEffort }).text;
  assert.match(dep, /run services, started by the supervisor: web \(nginxinc\/nginx-unprivileged:1\.27-alpine, port 8080/);
  assert.match(dep, /WEB_SECRET.*given only to web/);
  assert.doesNotMatch(dep, /hunter2|sk-or/);
});

await check("start authorisation: an authorised contract starts unprompted; a mismatch is refused; without consent a flag alone is not enough", () => {
  const digest = boundaryDigest(base);
  const authorised = { ...base, authorisation: { boundaryDigest: digest, by: "alice", at: "2026-09-30T00:00:00Z" } };
  assert.deepEqual(authorisationStatus(base, digest), { status: "missing" });
  assert.equal(authorisationStatus(authorised, digest).status, "authorised");
  const cases = [
    ["authorised, no TTY, no --yes", { contract: authorised, isTTY: false, yes: false }, "start", "contract"],
    ["authorised, no TTY, --yes", { contract: authorised, isTTY: false, yes: true }, "start", "contract"],
    ["authorised, TTY", { contract: authorised, isTTY: true }, "start", "contract"],
    ["unauthorised, TTY", { contract: base, isTTY: true, yes: false }, "confirm", undefined],
    ["unauthorised, TTY, --yes (a person is present)", { contract: base, isTTY: true, yes: true }, "start", "tty-yes"],
    ["unauthorised, no TTY, --yes", { contract: base, isTTY: false, yes: true }, "refuse", "authorisation_required"],
    ["unauthorised, no TTY", { contract: base, isTTY: false, yes: false }, "refuse", "authorisation_required"],
  ];
  for (const [name, input, action, extra] of cases) {
    const d = decideStart({ digest, ...input });
    assert.equal(d.action, action, name);
    if (action === "start") assert.equal(d.via, extra, name);
    if (action === "refuse") assert.equal(d.code, extra, name);
  }
  const stale = { ...base, authorisation: { boundaryDigest: "0".repeat(64), by: "alice", at: "2026-09-30T00:00:00Z" } };
  for (const input of [{ isTTY: false, yes: true }, { isTTY: true, yes: true }, { isTTY: true, yes: false }]) {
    const d = decideStart({ contract: stale, digest, ...input });
    assert.equal(d.action, "refuse");
    assert.equal(d.code, "digest_mismatch", "a mismatch is refused even on a terminal, even with --yes");
    assert.match(d.message, /re-authorise with `plan --authorise`/);
    assert.match(d.message, /000000000000/);
  }
  assert.match(decideStart({ contract: base, digest, isTTY: false, yes: true }).message, /--yes alone is not consent/);
  const widened = structuredClone(authorised);
  widened.permissions.network.egress.push({ host: "example.org", ports: [443], plainGet: false });
  assert.equal(decideStart({ contract: widened, digest: boundaryDigest(widened), isTTY: false, yes: true }).code, "digest_mismatch", "widening an authorised contract invalidates its authorisation");
});

await check("worker environment: ONE function, exact names, unattended only when authorised, effort from the snapshot, no credentials", () => {
  const env = workerEnv(base, { branch: "pi/todo-api-1", reset: true });
  assert.deepEqual(env, {
    RUN_ID: "todo-api-1", RUN_BRANCH: "pi/todo-api-1", PI_MODEL: "deepseek/deepseek-v4.1-flash", PI_PROVIDER: "openrouter", CYCLE_RESET: "1", GIT_NAME: "pi autonomy", GIT_EMAIL: "pi-autonomy@localhost",
    PI_KIT_EFFORT: "standard", PI_KIT_EFFORT_CAP: "standard",
    PI_KIT_UNATTENDED: "1", PI_KIT_UNATTENDED_BOUNDARY: "container", PI_KIT_UNATTENDED_CONTRACT: "/run/contract.json",
    AUTONOMY_EGRESS: "1", HTTPS_PROXY: "http://egress-proxy:3128", HTTP_PROXY: "http://egress-proxy:3128", https_proxy: "http://egress-proxy:3128", http_proxy: "http://egress-proxy:3128",
    NO_PROXY: "inference,egress-proxy,localhost,127.0.0.1", no_proxy: "inference,egress-proxy,localhost,127.0.0.1",
  });
  assert.equal(WORKER_CONTRACT_PATH, "/run/contract.json");
  assert.deepEqual(Object.keys(workerEnv(base, { branch: "b" })), Object.keys(env), "a stable key order");
  const attended = workerEnv(resolve(implementRaw({ permissions: {} })), { branch: "b" });
  for (const k of ["PI_KIT_UNATTENDED", "PI_KIT_UNATTENDED_BOUNDARY", "PI_KIT_UNATTENDED_CONTRACT", "HTTPS_PROXY", "AUTONOMY_EGRESS"]) assert.equal(k in attended, false, `${k} is absent when not authorised / no egress`);
  assert.equal(attended.PI_KIT_EFFORT, "standard", "effort is always set");
  assert.deepEqual([workerEnv(base, { branch: "b", effort: { tier: "focused", cap: "thorough" } }).PI_KIT_EFFORT, workerEnv(base, { branch: "b", effort: { tier: "focused", cap: "thorough" } }).PI_KIT_EFFORT_CAP], ["focused", "thorough"], "the run's snapshot wins over the contract");
  assert.equal(workerEnv(deployContract, { branch: "b" }).NO_PROXY, "inference,egress-proxy,localhost,127.0.0.1,web", "services are reached directly, by name");
  assert.equal(workerEnv({ ...base, runtime: { ...base.runtime, user: "0:0" } }, { branch: "b" }).AUTONOMY_ROOTLESS, "1");
  const all = JSON.stringify(workerEnv(deployContract, { branch: "b" }));
  assert.doesNotMatch(all, /(_KEY|TOKEN|SECRET|PASSW|sk-or|glpat)/i);
});

// --- container arguments ------------------------------------------------------------------------
const home = path.join(os.tmpdir(), "autonomy-boundary-home");
const cfg = runtimeConfig(deployContract, { namePrefix: "pi-autonomy-test-unit" });
const cfgDocker = runtimeConfig({ ...deployContract, runtime: { ...deployContract.runtime, engine: "docker" } }, { namePrefix: "pi-autonomy-test-unit" });
const p = runPaths(cfg.run, home);
const N = dk.names(cfg);
const flag = (args, f) => args.flatMap((a, i) => (a === f ? [args[i + 1]] : []));
const web = dk.serviceRunArgs(cfg, p, deployContract.permissions.network.services[0]);
const builders = {
  worker: { args: dk.agentRunArgs(cfg, p, { n: 3, attempt: 1, reset: true }), networks: [N.net], role: "worker" },
  relay: { args: dk.relayRunArgs(cfg, p, path.join(PKG, "relay.mjs")), networks: [N.egress], role: "relay" },
  proxy: { args: dk.proxyRunArgs(cfg, p, { script: path.join(PKG, "lib", "egress-proxy.mjs"), netaddr: path.join(PKG, "lib", "netaddr.mjs") }), networks: [N.egress], role: "proxy" },
  service: { args: web.args, networks: [N.net], role: "service", secretEnvNames: ["API_SECRET"] },
  bundle: { args: dk.bundleRunArgs(cfg, p), networks: [], role: "bundle" },
  snapshot: { args: dk.snapshotRunArgs(cfg, p, { message: "checkpoint" }), networks: [], role: "snapshot" },
  setref: { args: dk.setAgentRefRunArgs(cfg, p, { bundleFile: path.join(p.bundles, "b.bundle"), sha: "a".repeat(40) }), networks: [], role: "setref" },
  check: { args: dk.checkRunArgs(cfg, p, { bundleFile: path.join(p.bundles, "c.bundle"), sha: "a".repeat(40), checkId: "unit", runnerScript: path.join(PKG, "lib", "check-runner.mjs"), hasOverlay: true }), networks: [], role: "check" },
  probe: { args: dk.healthProbeRunArgs(cfg, p, { url: "http://web:8080/", expectStatus: 200 }), networks: [N.net], role: "probe" },
  deploySync: { args: dk.deploySyncRunArgs(cfg, p, { service: "web", index: 0, source: "dist" }), networks: [], role: "deploy-sync" },
  workerDocker: { args: dk.agentRunArgs(cfgDocker, p, { n: 1, attempt: 1, reset: false }), networks: [N.net], role: "worker" },
};
const roots = [p.root, PKG];
const inspectOpts = (b) => ({ roots, networks: b.networks, role: b.role, secretEnvNames: b.secretEnvNames ?? [] });

await check("every container the supervisor starts is hardened, on the right network, and passes the containment validator", () => {
  for (const [name, b] of Object.entries(builders)) {
    const { problems, facts } = inspectRunArgs(b.args, inspectOpts(b));
    assert.deepEqual(problems, [], `${name}: ${problems.join("; ")}`);
    for (const f of ["--read-only", "--cap-drop", "--security-opt", "--pids-limit", "--memory", "--cpus", "--user"]) assert.ok(b.args.includes(f), `${name} has ${f}`);
    assert.deepEqual(flag(b.args, "--cap-drop"), ["ALL"], name);
    assert.deepEqual(flag(b.args, "--security-opt"), ["no-new-privileges:true"], name);
    assert.notEqual(facts.user.split(":")[0], "0", `${name} does not run as root`);
    assert.ok(!b.args.includes("--privileged") && !b.args.some((a) => a.startsWith("--cap-add") || a.startsWith("--network=host") || a === "--pid" || a === "--ipc" || a === "--device"), name);
    assert.ok(!b.args.join(" ").includes("docker.sock") && !b.args.join(" ").includes(os.homedir()) && !b.args.join(" ").includes("/.ssh"), name);
    assert.deepEqual(flag(b.args, "--label").filter((l) => l.startsWith("pi-autonomy.run=")), [`pi-autonomy.run=${cfg.run}`], `${name} is labelled with its run for orphan cleanup`);
    assert.ok(b.args.includes(`pi-autonomy.role=${b.role === "deploy-sync" ? "helper" : b.role}`) || b.role === "deploy-sync" || b.role === "bundle" || b.role === "snapshot" || b.role === "setref", `${name} role label`);
  }
  assert.ok(builders.worker.args.includes("--userns=keep-id") && !builders.workerDocker.args.includes("--userns=keep-id"), "keep-id is podman's");
  assert.equal(assertRunArgs(builders.worker.args, inspectOpts(builders.worker)).image, cfg.image);
});

await check("network placement: workers, services and probes on the internal network only; relay and proxy on the egress network; helpers on none", () => {
  assert.deepEqual(flag(builders.worker.args, "--network"), [N.net]);
  assert.deepEqual(flag(builders.service.args, "--network"), [N.net]);
  assert.deepEqual(flag(builders.probe.args, "--network"), [N.net]);
  assert.deepEqual(flag(builders.relay.args, "--network"), [N.egress], "the relay joins the run network only by alias, after start");
  assert.deepEqual(flag(builders.proxy.args, "--network"), [N.egress]);
  for (const k of ["bundle", "snapshot", "setref", "check", "deploySync"]) assert.deepEqual(flag(builders[k].args, "--network"), ["none"], k);
  const [internal, egress] = dk.networkCreateArgs(cfg);
  assert.deepEqual(internal, ["network", "create", "--internal", N.net], "podman: nothing extra (its internal network is checked by the probe's canary)");
  // Docker's internal network stops forwarding, but the host still answers on the bridge's own address; without an address on the bridge there is no host to reach.
  const dockerNets = dk.networkCreateArgs(cfgDocker);
  assert.deepEqual(dockerNets[0], ["network", "create", "--internal", "--opt", "com.docker.network.bridge.inhibit_ipv4=true", N.net]);
  assert.equal(dk.HOSTLESS_OPTION, "com.docker.network.bridge.inhibit_ipv4");
  assert.ok(!dockerNets[1].includes("--internal") && !dockerNets[1].includes("--opt"), "the outward network is an ordinary bridge");
  assert.equal(egress.at(-1), N.egress);
  assert.ok(!egress.includes("--internal"));
  assert.deepEqual(flag(builders.service.args, "--network-alias"), ["web"], "workers reach services by name");
  assert.deepEqual(dk.relayExecArgs(cfg), ["exec", "-i", N.relay, "node", "/relay.mjs"]);
  assert.deepEqual(dk.proxyExecArgs(cfg), ["exec", "-i", N.proxy, "node", "/proxy/egress-proxy.mjs"]);
  assert.ok(N.net.startsWith("pi-autonomy-test-unit") && N.relay.startsWith("pi-autonomy-test-unit") && N.service("web").startsWith("pi-autonomy-test-unit"), "test runs never share names with real runs");
  assert.equal(dk.names(runtimeConfig(deployContract)).net, "pi-exp-todo-api-1");
});

await check("mounts: the worker gets its bare repo, workspace, state and the sanitised contract (read-only); nothing else; helpers read what they must read-only", () => {
  const mounts = (args) => flag(args, "--mount").map((m) => Object.fromEntries(m.split(",").map((kv) => kv.split("="))));
  const w = mounts(builders.worker.args);
  assert.deepEqual(w.map((m) => m.target), ["/git/remote.git", "/work", "/state", "/run"]);
  assert.deepEqual(w.filter((m) => "readonly" in m).map((m) => m.target), ["/run"]);
  assert.equal(w[3].source, p.public);
  assert.equal(flag(builders.worker.args, "--env").some((e) => /^(OPENROUTER|API|.*KEY|.*TOKEN|.*SECRET)/.test(e) && !e.startsWith("PI_KIT")), false);
  const refCfg = runtimeConfig(resolve({ ...implementRaw({ inputs: { references: { docs: "/src/docs" } } }) }), { namePrefix: "pi-autonomy-test-unit" });
  const refArgs = dk.agentRunArgs(refCfg, { ...p, references: path.join(p.root, "references") }, { n: 1, attempt: 1 });
  assert.ok(refArgs.includes(`type=bind,source=${path.join(p.root, "references")}/docs,target=/reference/docs,readonly`), "references are snapshots, mounted read-only");
  assert.ok(!refArgs.join(" ").includes("/src/docs"), "the live reference repository is never mounted");
  const b = mounts(builders.bundle.args);
  assert.deepEqual(b.map((m) => [m.target, "readonly" in m]), [["/git/remote.git", true], ["/out", false]], "bundling reads the worker's repo read-only");
  const c = mounts(builders.check.args);
  assert.deepEqual(c.map((m) => [m.target, "readonly" in m]), [["/in/branch.bundle", true], ["/run/checks.json", true], ["/gate", false], ["/check-runner.mjs", true], ["/overlay", true]], "a check sees a bundle, its definitions and the held-out overlay read-only, and a scratch directory; not the worker's workspace");
  assert.equal(c.some((m) => m.source === p.work || m.source === p.remote || m.source === p.agentState), false);
  assert.equal(mounts(dk.checkRunArgs(cfg, p, { bundleFile: "/x/b", sha: "a".repeat(40), checkId: "u", runnerScript: "/x/r.mjs", hasOverlay: false })).some((m) => m.target === "/overlay"), false);
  assert.deepEqual(flag(builders.check.args, "--env").sort(), [`CHECK_BRANCH=${cfg.branch}`, "CHECK_ID=unit", `CHECK_SHA=${"a".repeat(40)}`, "CI=1"], "a clean environment: nothing from the operator's shell");
  const d = mounts(builders.deploySync.args);
  assert.deepEqual(d.map((m) => [m.target, "readonly" in m]), [["/work", true], ["/out", false]], "deploy-sync reads the workspace read-only and writes a host-owned staging directory");
  assert.equal(d[1].source, dk.deployDir(p, "web", 0));
  const s = mounts(builders.service.args);
  assert.deepEqual(s.map((m) => [m.target, "readonly" in m, m.source]), [["/usr/share/nginx/html", true, dk.deployDir(p, "web", 0)]], "a service serves a read-only, host-owned copy, never the worker's own directory");
  const proxyM = mounts(builders.proxy.args).map((m) => m.target);
  assert.deepEqual(proxyM, ["/proxy/egress-proxy.mjs", "/proxy/netaddr.mjs", "/audit"]);
  assert.deepEqual(mounts(builders.relay.args).map((m) => m.target), ["/relay.mjs", "/meter"]);
});

await check("service credentials travel by NAME only: never in the argument list, the environment flag carries no value", () => {
  assert.deepEqual(web.secretEnv, { API_SECRET: "WEB_SECRET" });
  const env = flag(web.args, "--env");
  assert.ok(env.includes("API_SECRET") && env.includes("MODE=test"));
  assert.ok(!env.some((e) => e.startsWith("API_SECRET=")));
  assert.ok(!web.args.join(" ").includes("WEB_SECRET"), "not even the credential's name in the arguments");
  assert.equal(assertRunArgs(web.args, inspectOpts({ ...builders.service })).role, "service");
  assert.throws(() => assertRunArgs(web.args, { roots, networks: [N.net], role: "service" }), /inherited from the supervisor without being declared/, "an undeclared inherited variable is refused");
});

const mutate = (name, fn, expectRe, b = builders.worker) => ({ name, args: fn([...b.args]), expectRe, b });
const insertBeforeImage = (extra) => (args) => { const i = args.lastIndexOf(cfg.image); return [...args.slice(0, i), ...extra, ...args.slice(i)]; };
const replaceFlag = (f, value) => (args) => { const i = args.indexOf(f); args[i + 1] = value; return args; };
const dropFlag = (f, hasValue = true) => (args) => { const i = args.indexOf(f); args.splice(i, hasValue ? 2 : 1); return args; };
const NEGATIVE = [
  mutate("privileged mode", insertBeforeImage(["--privileged"]), /--privileged/),
  mutate("added capability", insertBeforeImage(["--cap-add", "SYS_ADMIN"]), /--cap-add SYS_ADMIN/),
  mutate("host network", replaceFlag("--network", "host"), /--network host/),
  mutate("default bridge", replaceFlag("--network", "bridge"), /--network bridge/),
  mutate("another network", replaceFlag("--network", "some-lan"), /not one of this container's networks/),
  mutate("container network", replaceFlag("--network", "container:other"), /--network container:other/),
  mutate("second network at start", insertBeforeImage(["--network", N.egress]), /more than one --network/),
  mutate("host pid namespace", insertBeforeImage(["--pid", "host"]), /--pid host/),
  mutate("host ipc namespace", insertBeforeImage(["--ipc=host"]), /--ipc host/),
  mutate("host uts namespace", insertBeforeImage(["--uts", "host"]), /--uts host/),
  mutate("device passthrough", insertBeforeImage(["--device", "/dev/kvm"]), /--device/),
  mutate("published port", insertBeforeImage(["-p", "8080:80"]), /published to the host|nothing is published/),
  mutate("volumes-from", insertBeforeImage(["--volumes-from", "other"]), /--volumes-from/),
  mutate("dns override", insertBeforeImage(["--dns", "8.8.8.8"]), /--dns/),
  mutate("add-host", insertBeforeImage(["--add-host", "evil:1.2.3.4"]), /--add-host/),
  mutate("sysctl", insertBeforeImage(["--sysctl", "net.ipv4.ip_forward=1"]), /--sysctl/),
  mutate("env file", insertBeforeImage(["--env-file", "/etc/secrets"]), /--env-file/),
  mutate("seccomp unconfined", insertBeforeImage(["--security-opt", "seccomp=unconfined"]), /--security-opt seccomp=unconfined/),
  mutate("apparmor unconfined", insertBeforeImage(["--security-opt", "apparmor=unconfined"]), /--security-opt apparmor=unconfined/),
  mutate("selinux label disabled", insertBeforeImage(["--security-opt", "label=disable"]), /--security-opt label=disable/),
  mutate("userns host", insertBeforeImage(["--userns", "host"]), /--userns host/),
  mutate("writable root filesystem", dropFlag("--read-only", false), /missing --read-only/),
  mutate("capabilities kept", dropFlag("--cap-drop"), /missing --cap-drop ALL/),
  mutate("only some capabilities dropped", replaceFlag("--cap-drop", "NET_RAW"), /missing --cap-drop ALL/),
  mutate("no-new-privileges removed", dropFlag("--security-opt"), /missing --security-opt no-new-privileges/),
  mutate("no pids limit", dropFlag("--pids-limit"), /missing --pids-limit/),
  mutate("no memory limit", dropFlag("--memory"), /missing --memory/),
  mutate("no cpu limit", dropFlag("--cpus"), /missing --cpus/),
  mutate("root user", replaceFlag("--user", "0:0"), /never runs as root/),
  mutate("named root user", replaceFlag("--user", "root"), /never runs as root or a named user/),
  mutate("no explicit user", dropFlag("--user"), /missing --user/),
  mutate("engine socket", insertBeforeImage(["--mount", "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock"]), /must never see|not allowed/),
  mutate("podman socket", insertBeforeImage(["--mount", `type=bind,source=/run/user/1000/podman/podman.sock,target=/run/podman.sock`]), /must never see|outside the run/),
  mutate("operator's home", insertBeforeImage(["--mount", `type=bind,source=${os.homedir()},target=/home/op`]), /outside the run's directories|must never see/),
  mutate("ssh keys", insertBeforeImage(["--mount", `type=bind,source=${os.homedir()}/.ssh,target=/root/.ssh`]), /must never see|outside/),
  mutate("host root", insertBeforeImage(["--mount", "type=bind,source=/,target=/host"]), /must never see|outside/),
  mutate("host /etc", insertBeforeImage(["--mount", "type=bind,source=/etc,target=/hostetc"]), /must never see|outside/),
  mutate("pi agent dir", insertBeforeImage(["--mount", `type=bind,source=${os.homedir()}/.pi/agent,target=/pi`]), /must never see|outside/),
  mutate("a path outside the run directory", insertBeforeImage(["--mount", "type=bind,source=/opt/data,target=/data"]), /outside the run's directories/),
  mutate("dot-dot escape", insertBeforeImage(["--mount", `type=bind,source=${p.root}/work/../../elsewhere,target=/data`]), /\.\.|outside/),
  mutate("relative source", insertBeforeImage(["--mount", "type=bind,source=work,target=/data"]), /not an absolute path/),
  mutate("named volume", insertBeforeImage(["--mount", "type=volume,source=v,target=/data"]), /only bind mounts/),
  mutate("short -v form", insertBeforeImage(["-v", `${p.work}:/data`]), /use --mount/),
  mutate("mount over /proc", insertBeforeImage(["--mount", `type=bind,source=${p.work},target=/proc`]), /mount target \/proc is not allowed/),
  mutate("mount over /var/run", insertBeforeImage(["--mount", `type=bind,source=${p.work},target=/var/run`]), /not allowed/),
  mutate("mount option smuggling", insertBeforeImage(["--mount", `type=bind,source=${p.work},target=/data,bind-propagation=rshared`]), /mount option bind-propagation/),
  mutate("credential in the environment (value)", insertBeforeImage(["--env", "SOMETHING=sk-or-v1-0123456789abcdef0123456789abcdef"]), /credential-shaped value/),
  mutate("credential-looking name", insertBeforeImage(["--env", "OPENROUTER_API_KEY=x"]), /looks like a credential/),
  mutate("token variable", insertBeforeImage(["--env", "GITHUB_TOKEN=abc"]), /looks like a credential/),
  mutate("inherited variable", insertBeforeImage(["--env", "HOME_SECRET"]), /inherited from the supervisor/),
  mutate("unknown flag", insertBeforeImage(["--experimental-thing"]), /unrecognised flag/),
  mutate("no network flag", dropFlag("--network"), /no --network/),
  mutate("relay on the run network directly", replaceFlag("--network", N.net), /not one of this container's networks/, builders.relay),
  mutate("proxy on the internal network directly", replaceFlag("--network", N.net), /not one of this container's networks/, builders.proxy),
  mutate("a check with network", replaceFlag("--network", N.net), /not one of this container's networks/, builders.check),
];

await check("negative table: every way of weakening a container is refused by the containment validator", () => {
  let n = 0;
  for (const neg of NEGATIVE) {
    const { problems } = inspectRunArgs(neg.args, inspectOpts(neg.b));
    assert.ok(problems.length > 0, `${neg.name}: expected a problem`);
    assert.ok(problems.some((m) => neg.expectRe.test(m)), `${neg.name}: expected ${neg.expectRe}, got ${problems.join(" | ")}`);
    assert.throws(() => assertRunArgs(neg.args, inspectOpts(neg.b)), /refusing to start/);
    n++;
  }
  assert.ok(n >= 55, `${n} negative cases`);
  assert.ok(inspectRunArgs(["ps"], {}).problems.length > 0, "not a run command");
  assert.ok(inspectRunArgs(["run", "-d", "img"], { roots }).problems.length >= 6, "a bare run has many problems");
});

await check("the builders themselves cannot be talked into weaker containers by configuration", () => {
  // A hostile or mistaken config value must be caught by the validator, not silently emitted.
  const bad = (mut) => { const c = structuredClone(deployContract); mut(c); return runtimeConfig(c, { namePrefix: "pi-autonomy-test-unit" }); };
  const rootCfg = bad((c) => { c.runtime.user = "0:0"; });
  const asRoot = dk.agentRunArgs(rootCfg, p, { n: 1, attempt: 1 });
  assert.ok(inspectRunArgs(asRoot, { roots, networks: [N.net], role: "worker" }).problems.some((m) => /never runs as root/.test(m)), "rootless docker's 0:0 must be an explicit opt-in (allowRoot), not a default");
  assert.deepEqual(inspectRunArgs(asRoot, { roots, networks: [N.net], role: "worker", allowRoot: true }).problems, [], "and it is otherwise as hardened");
  const badMount = structuredClone(deployContract.permissions.network.services[0]);
  badMount.workspaceMounts = [{ source: "../../home", target: "/x" }];
  const svcArgs = dk.serviceRunArgs(cfg, p, badMount).args;
  assert.ok(svcArgs.some((a) => a.includes("/x,readonly")));
  assert.deepEqual(inspectRunArgs(svcArgs, { roots, networks: [N.net], role: "service", secretEnvNames: ["API_SECRET"] }).problems, [], "service mounts are host-owned staging directories, whatever the contract's source says (the source is only the copy's origin, inside a network-less container)");
  assert.match(dk.deploySyncRunArgs(cfg, p, { service: "web", index: 0, source: "../../home" }).join(" "), /DEPLOY_SRC=\.\.\/\.\.\/home/);
});

done();
