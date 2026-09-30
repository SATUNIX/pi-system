// A last line of defence over every `docker run` / `podman run` the supervisor executes. The
// argument builders in lib/docker.mjs produce hardened arguments; this module re-checks the
// finished argument list against the boundary before it runs, so a bug or a hostile config value
// in a builder cannot start a container that is privileged, on the host network, holding the
// engine socket or the operator's home, or carrying a credential. It fails closed: a flag it
// does not know is a problem.
//
//   inspectRunArgs(args, { roots, networks, role }) -> { problems: [string], facts }
//   assertRunArgs(...)   throws an Error listing every problem
import path from "node:path";

// flag -> takes a value
const FLAGS = new Map(Object.entries({
  "run": false, "-d": false, "-i": false, "-t": false, "--rm": false, "--init": false, "--read-only": false, "--no-healthcheck": false, "--privileged": false, "-P": false, "--publish-all": false,
  "--name": true, "--user": true, "-u": true, "--network": true, "--net": true, "--network-alias": true, "--mount": true, "-v": true, "--volume": true, "--env": true, "-e": true, "--env-file": true,
  "--tmpfs": true, "--cap-add": true, "--cap-drop": true, "--security-opt": true, "--pids-limit": true, "--memory": true, "-m": true, "--cpus": true, "--device": true, "--pid": true, "--ipc": true,
  "--uts": true, "--userns": true, "--cgroupns": true, "--label": true, "-l": true, "--entrypoint": true, "--volumes-from": true, "--add-host": true, "--dns": true, "--publish": true, "-p": true,
  "--expose": true, "--link": true, "--sysctl": true, "--ulimit": true, "--restart": true, "--workdir": true, "-w": true, "--platform": true, "--hostname": true, "-h": true, "--stop-timeout": true,
  "--health-cmd": true, "--shm-size": true, "--memory-swap": true, "--log-driver": true, "--cgroup-parent": true, "--runtime": true, "--oom-score-adj": true, "--group-add": true, "--pull": true,
}));

const FORBIDDEN_TARGETS = [/^\/$/, /^\/proc(\/|$)/, /^\/sys(\/|$)/, /^\/dev(\/|$)/, /^\/var\/run(\/|$)/, /^\/run\/(docker|podman)/, /^\/etc(\/|$)/, /^\/root(\/|$)/, /^\/boot(\/|$)/, /docker\.sock/, /podman\.sock/];
const FORBIDDEN_SOURCES = [/docker\.sock/, /podman\.sock/, /^\/$/, /^\/(proc|sys|dev|boot|etc|root|var\/run|var\/lib\/docker|var\/lib\/containers)(\/|$)/, /\/\.ssh(\/|$)/, /\/\.aws(\/|$)/, /\/\.gnupg(\/|$)/, /\/\.docker(\/|$)/, /\/\.kube(\/|$)/, /\/\.config\/(gcloud|gh|git)(\/|$)/, /\/\.(netrc|npmrc|pypirc|git-credentials)$/, /\/\.pi(\/|$)/];
const CRED_NAME = /(KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH)/i;
const CRED_VALUE = /(sk-[A-Za-z0-9_-]{16,}|glpat-|ghp_|github_pat_|xox[baprs]-|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|Bearer\s+[A-Za-z0-9._~+/-]{16,})/;

function parseMount(text) {
  const out = {};
  for (const part of String(text).split(",")) {
    const i = part.indexOf("=");
    if (i < 0) out[part] = true; else out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

const inside = (child, roots) => roots.some((r) => child === r || child.startsWith(r.endsWith(path.sep) ? r : r + path.sep));

/**
 * @param {string[]} args   the full argument list after the engine binary (`run ...`)
 * @param {{ roots?: string[], networks?: string[], role?: string, allowRoot?: boolean, secretEnvNames?: string[], allowedImages?: string[] }} [opts]
 *   roots: absolute directories bind-mount sources must be inside
 *   networks: the network names this container may join (`none` is always allowed)
 *   secretEnvNames: environment variable NAMES that may be passed without a value (inherited from the supervisor, for run services)
 */
export function inspectRunArgs(args, { roots = [], networks = [], role = "container", allowRoot = false, secretEnvNames = [] } = {}) {
  const problems = [];
  const facts = { role, user: null, networks: [], mounts: [], tmpfs: [], env: [], caps: { drop: [], add: [] }, securityOpt: [], readOnly: false, pids: null, memory: null, cpus: null, image: null, command: [], privileged: false };
  const flag = (name, value) => `${name}${value === undefined ? "" : ` ${value}`}`;
  const bad = (msg) => problems.push(msg);
  const normRoots = roots.map((r) => path.resolve(r));
  if (args[0] !== "run") bad(`not a run command (${args[0]})`);
  let i = 1;
  for (; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) break; // the image
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (!FLAGS.has(name)) { bad(`unrecognised flag ${name} (fail closed)`); continue; }
    let value;
    if (eq > 0) value = a.slice(eq + 1);
    else if (FLAGS.get(name)) { value = args[++i]; if (value === undefined) { bad(`${name} has no value`); break; } }
    switch (name) {
      case "--privileged": facts.privileged = true; bad("--privileged"); break;
      case "--read-only": facts.readOnly = true; break;
      case "--user": case "-u": facts.user = value; break;
      case "--network": case "--net": facts.networks.push(value); break;
      case "--cap-add": facts.caps.add.push(value); bad(`--cap-add ${value}`); break;
      case "--cap-drop": facts.caps.drop.push(value); break;
      case "--security-opt": facts.securityOpt.push(value); break;
      case "--pids-limit": facts.pids = Number(value); break;
      case "--memory": case "-m": facts.memory = value; break;
      case "--cpus": facts.cpus = value; break;
      case "--device": bad(`--device ${value}`); break;
      case "--volumes-from": bad(`--volumes-from ${value}`); break;
      case "--pid": case "--ipc": case "--uts": case "--cgroupns": bad(`${name} ${value} (namespaces are never shared with the host or another container)`); break;
      case "--publish": case "-p": case "-P": case "--publish-all": bad(`${name}${value ? ` ${value}` : ""} (nothing is published to the host)`); break;
      case "--add-host": case "--dns": case "--link": case "--sysctl": case "--cgroup-parent": case "--runtime": bad(`${name} ${value}`); break;
      case "--env-file": bad("--env-file (environment is passed explicitly, never from a file)"); break;
      case "--userns": if (value !== "keep-id") bad(`--userns ${value}`); break;
      case "--env": case "-e": {
        const k = String(value).split("=")[0];
        const hasValue = String(value).includes("=");
        facts.env.push(k);
        if (CRED_VALUE.test(String(value))) bad(`environment ${k} holds a credential-shaped value`);
        if (!hasValue && !secretEnvNames.includes(k)) bad(`environment ${k} is inherited from the supervisor without being declared as a secret for this container`);
        else if (hasValue && CRED_NAME.test(k) && !["AUTONOMY_KEY_SHA256", "PI_KIT_UNATTENDED_CONTRACT", "AUTONOMY_KEY_REGEX"].includes(k) && !secretEnvNames.includes(k)) bad(`environment ${k} looks like a credential (credentials never go into container environments)`);
        break;
      }
      case "--tmpfs": { const target = String(value).split(":")[0]; facts.tmpfs.push(target); if (FORBIDDEN_TARGETS.some((re) => re.test(target)) && !target.startsWith("/tmp")) bad(`--tmpfs on ${target}`); break; }
      case "--mount": case "-v": case "--volume": {
        if (name !== "--mount") { bad(`${name} ${value} (use --mount so type and read-only are explicit)`); break; }
        const m = parseMount(value);
        const type = m.type ?? "volume";
        const target = m.target ?? m.destination ?? m.dst;
        const source = m.source ?? m.src;
        facts.mounts.push({ type, source, target, readOnly: Boolean(m.readonly || m.ro) });
        if (type !== "bind") { bad(`--mount type=${type} (only bind mounts of supervisor-created paths)`); break; }
        if (!source || !path.isAbsolute(source)) { bad(`mount source ${source} is not an absolute path`); break; }
        const resolved = path.resolve(source);
        if (resolved !== source && path.normalize(source) !== source.replace(/\/+$/, "")) bad(`mount source ${source} is not normalised`);
        if (source.split("/").includes("..")) bad(`mount source ${source} contains ..`);
        if (FORBIDDEN_SOURCES.some((re) => re.test(resolved))) bad(`mount source ${source} is a host location a container must never see`);
        if (!inside(resolved, normRoots)) bad(`mount source ${source} is outside the run's directories`);
        if (!target || !target.startsWith("/") || FORBIDDEN_TARGETS.some((re) => re.test(target))) bad(`mount target ${target} is not allowed`);
        for (const key of Object.keys(m)) if (!["type", "source", "src", "target", "destination", "dst", "readonly", "ro"].includes(key)) bad(`mount option ${key} is not allowed (${value})`);
        break;
      }
      case "--entrypoint": case "--label": case "-l": case "--name": case "--network-alias": case "-w": case "--workdir": case "--restart": case "--stop-timeout":
      case "--health-cmd": case "--shm-size": case "--memory-swap": case "--log-driver": case "--oom-score-adj": case "--group-add": case "--platform": case "--hostname": case "-h": case "--expose": case "--ulimit": case "--pull": break;
      default: break;
    }
    void flag;
  }
  facts.image = args[i] ?? null;
  facts.command = args.slice(i + 1);
  if (!facts.image) bad("no image");
  if (!facts.readOnly) bad("missing --read-only (the root filesystem must be read-only)");
  if (!facts.caps.drop.some((c) => String(c).toUpperCase() === "ALL")) bad("missing --cap-drop ALL");
  if (!facts.securityOpt.includes("no-new-privileges:true") && !facts.securityOpt.includes("no-new-privileges")) bad("missing --security-opt no-new-privileges:true");
  for (const s of facts.securityOpt) if (!/^no-new-privileges(:true)?$/.test(s)) bad(`--security-opt ${s}`);
  if (!(facts.pids > 0)) bad("missing --pids-limit");
  if (!facts.memory) bad("missing --memory");
  if (!facts.cpus) bad("missing --cpus");
  if (!facts.user) bad("missing --user (a container never runs as the image default, which may be root)");
  else {
    const uid = String(facts.user).split(":")[0];
    if ((uid === "0" || uid === "root" || !/^\d+$/.test(uid)) && !allowRoot) bad(`--user ${facts.user}: a container never runs as root or a named user`);
  }
  if (!facts.networks.length) bad("no --network (the default bridge is not allowed)");
  for (const n of facts.networks) {
    if (n === "none") continue;
    if (/^(host|container:|bridge$|default$|slirp4netns|pasta|ns:)/.test(n)) bad(`--network ${n}`);
    else if (!networks.includes(n)) bad(`--network ${n} is not one of this container's networks (${networks.join(", ") || "none"})`);
  }
  if (facts.networks.length > 1) bad("more than one --network at start (extra networks are attached explicitly, later)");
  return { problems, facts };
}

export function assertRunArgs(args, opts) {
  const { problems, facts } = inspectRunArgs(args, opts);
  if (problems.length) throw new Error(`refusing to start ${opts?.role ?? "container"}: ${problems.join("; ")}`);
  return facts;
}
