// Container argument builders for the run's containers (rootless podman or docker). Pure: supervisor.mjs executes them, and
// tests/autonomy-smoke.mjs checks the boundary properties (networks, mounts, no credentials)
// without Docker. The hardening mirrors packages/core/eval/live/run.mjs.
//
//   <net>     internal network: no route off the host's Docker bridge, no DNS beyond container names
//   <egress>  ordinary bridge network the relay alone joins, for its fixed upstream
//   relay     on both; holds the real API key, received on stdin
//   agent     on <net> only; mounts the run's bare repo (its only git remote), its workspace and
//             its pi state; nothing from the operator's home
//   helpers   --network none: bundle the agent's refs, update the agent's bare repo, run the gate

export function names(cfg) {
  const p = `pi-exp-${cfg.run}`;
  return {
    net: p,
    egress: `${p}-egress`,
    relay: `${p}-relay`,
    agent: (n, attempt) => `${p}-agent-${String(n).padStart(2, "0")}-${attempt}`,
    helper: (what) => `${p}-${what}-${Date.now().toString(36)}`,
  };
}

export function userSpec(cfg, uid = process.getuid?.() ?? 1000, gid = process.getgid?.() ?? 1000) {
  const u = cfg.container.user;
  return !u || u === "host" ? `${uid}:${gid}` : String(u);
}

export function hardened(cfg, { memory = cfg.container.memory, cpus = cfg.container.cpus, tmpSize = cfg.container.tmpSize } = {}) {
  return [
    // Rootless podman: map the operator's uid to itself inside the container (every other id
    // in the container is an unprivileged sub-id on the host).
    ...(cfg.engine === "podman" ? ["--userns=keep-id"] : []),
    "--user", userSpec(cfg), "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--pids-limit", String(cfg.container.pids), "--memory", String(memory), "--cpus", String(cpus),
    "--tmpfs", `/tmp:rw,nosuid,size=${tmpSize}`, "--no-healthcheck",
  ];
}

const bind = (src, dest, readOnly = false) => ["--mount", `type=bind,source=${src},target=${dest}${readOnly ? ",readonly" : ""}`];

/** The relay idles in its container; the server is started by `docker exec -i` (config on stdin). */
export function relayRunArgs(cfg, p, relayScript) {
  return ["run", "-d", "--name", names(cfg).relay, ...hardened(cfg, { memory: "256m", cpus: "1", tmpSize: "16m" }),
    "--network", names(cfg).egress, ...bind(relayScript, "/relay.mjs", true), ...bind(p.meter, "/meter"),
    "--entrypoint", "node", cfg.image, "-e", "setInterval(() => {}, 1 << 30)"];
}

export function relayExecArgs(cfg) {
  return ["exec", "-i", names(cfg).relay, "node", "/relay.mjs"];
}

/** The agent: pi in RPC mode, driven over stdin/stdout. `reset` discards uncommitted work first. */
export function agentRunArgs(cfg, p, { n, attempt, reset }) {
  return ["run", "-i", "--rm", "--name", names(cfg).agent(n, attempt), ...hardened(cfg), "--network", names(cfg).net,
    ...bind(p.remote, "/git/remote.git"), ...bind(p.work, "/work"), ...bind(p.agentState, "/state"),
    ...Object.keys(cfg.references ?? {}).flatMap((name) => bind(`${p.references}/${name}`, `/reference/${name}`, true)),
    "--env", `RUN_ID=${cfg.run}`, "--env", `RUN_BRANCH=${cfg.branch}`, "--env", `PI_MODEL=${cfg.model}`,
    ...(userSpec(cfg) === "0:0" ? ["--env", "AUTONOMY_ROOTLESS=1"] : []),
    "--env", `CYCLE_RESET=${reset ? 1 : 0}`, "--env", `GIT_NAME=${cfg.gitIdentity.name}`, "--env", `GIT_EMAIL=${cfg.gitIdentity.email}`,
    cfg.image, "agent"];
}

/** Bundle the agent's branch out of its bare repo (read-only), for the host to fetch as data. */
export function bundleRunArgs(cfg, p) {
  return ["run", "--rm", "--name", names(cfg).helper("bundle"), ...hardened(cfg, { memory: "512m", cpus: "1", tmpSize: "64m" }), "--network", "none",
    ...bind(p.remote, "/git/remote.git", true), ...bind(p.bundles, "/out"), cfg.image, "bundle", cfg.branch];
}

/** Point the agent's bare repo at a sha the host holds (after RESET_TO_LAST_GOOD), from a bundle. */
export function setAgentRefRunArgs(cfg, p, { bundleFile, sha }) {
  return ["run", "--rm", "--name", names(cfg).helper("setref"), ...hardened(cfg, { memory: "512m", cpus: "1", tmpSize: "64m" }), "--network", "none",
    ...bind(p.remote, "/git/remote.git"), ...bind(bundleFile, "/in/branch.bundle", true), cfg.image, "setref", cfg.branch, sha];
}

/** The post-cycle gate: a clean clone of the accepted head, the offline checks, no network at all. */
export function gateRunArgs(cfg, p, { bundleFile, sha }) {
  return ["run", "--rm", "--name", names(cfg).helper("gate"), ...hardened(cfg, { memory: cfg.gate.memory, cpus: cfg.gate.cpus }), "--network", "none",
    ...bind(bundleFile, "/in/branch.bundle", true), ...bind(p.gateWork, "/gate"), cfg.image, "gate", cfg.branch, sha];
}

/** Network creation: the run network must be internal. */
export function networkCreateArgs(cfg) {
  return [["network", "create", "--internal", names(cfg).net], ["network", "create", names(cfg).egress]];
}
