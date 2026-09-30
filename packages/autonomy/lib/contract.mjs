// The versioned run contract (schemaVersion 1): one declarative document that says what a run
// is for, what it may touch and when it is finished. Hand-written validation (no dependencies)
// so the supervisor can run on plain Node; schema/run-contract.schema.json documents the same
// shape for other tools and tests/autonomy-contract-smoke.mjs checks that the two agree.
//
// resolveContract(raw, opts) -> { ok, contract, problems, legacy }
//   - problems: [{ level: "error" | "warning", path, message }]
//   - ok: no errors. `contract` is the fully resolved document (defaults filled, spec inlined,
//     effort snapshotted as canonical tier ids) even when there are errors, for display only.
//
// Fail-closed rules (docs/autonomy.md, "The run contract"):
//   - unknown top-level keys are errors;
//   - unknown or malformed keys under permissions, promotion, authorisation are errors;
//   - unknown keys elsewhere are warnings;
//   - anything absent defaults to the closed choice (no egress, no services, no unattended
//     approval, no promotion), never to a wider one;
//   - credential values never appear in a contract: names only, and credential-shaped strings
//     are rejected wherever they occur.
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, clone, deepMerge, isPlainObject, sha256 } from "./fsutil.mjs";
import { globProblem } from "./glob.mjs";
import { EFFORT_UNAVAILABLE, effortApi } from "./effort.mjs";
import { TEMPLATES, templateIds } from "./templates/index.mjs";
import { isPublicIpLiteral, isIpLiteral, canonicalIp, classifyAddress, normaliseHost } from "./netaddr.mjs";

export const SCHEMA_VERSION = 1;

export const TOP_LEVEL_KEYS = ["schemaVersion", "run", "template", "objective", "inputs", "acceptance", "permissions", "model", "providerSettings", "effort", "budget", "recovery", "promotion", "runtime", "templateOptions", "authorisation"];

const RUN_ID = /^[a-z0-9][a-z0-9-]{2,40}$/;
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;
const CHECK_ID = /^[a-z0-9][a-z0-9._-]{0,40}$/;
const SERVICE_NAME = /^[a-z][a-z0-9-]{1,30}$/;
const RESERVED_HOSTNAMES = new Set(["inference", "egress-proxy", "relay", "localhost", "worker", "agent", "supervisor", "gate"]);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const CRED_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9][\w.:/@+-]{0,120}$/;
const REF_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/;
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,80}$/;
const REFERENCE_NAME = /^[a-z0-9][a-z0-9._-]{0,40}$/;
const IMAGE_REF = /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::\d{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[\w][\w.-]{0,127})?(?:@sha256:[a-f0-9]{64})?$/;
const HEX64 = /^[a-f0-9]{64}$/;

// Branch names a run may never treat as its integration or promotion target: they are the
// places a person merges to, and a run must not be able to move them.
const PROTECTED_BRANCHES = new Set(["main", "master", "head", "trunk", "develop", "development", "production", "prod", "stable"]);
const isProtectedBranch = (b) => PROTECTED_BRANCHES.has(String(b).toLowerCase()) || /^(release|releases|hotfix)(\/|$)/i.test(b) || /^refs\//.test(b);

export const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}/, /\bsk-or-[A-Za-z0-9_-]{10,}/, /\bglpat-[A-Za-z0-9_-]{10,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bBearer\s+[A-Za-z0-9._~+/-]{20,}/,
  /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i, // scheme://user:password@host
];

export const DEFAULT_RUNTIME = {
  engine: "podman",
  image: "pi-autonomy:local",
  memory: "6g",
  cpus: "4",
  pids: 1024,
  tmpSize: "4g",
  user: "host",
  mirrorSeconds: 30,
  gitIdentity: { name: "pi autonomy", email: "pi-autonomy@localhost" },
};

export const DEFAULT_MODEL = "deepseek/deepseek-v4.1-flash";
const PROVIDERS = {
  openrouter: { upstream: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", authName: "openrouter", reportsCost: true },
  "openai-compatible": { upstream: null, apiKeyEnv: null, authName: null, reportsCost: false },
};
export const providerIds = () => Object.keys(PROVIDERS);

export function urlProblem(value, { allowed = ["https", "ssh"] } = {}) {
  if (typeof value !== "string" || !value.trim()) return "must be a non-empty string";
  if (value.length > 500) return "is longer than 500 characters";
  if (/[\s\0-\x1f]/.test(value)) return "must not contain whitespace or control characters";
  if (value.startsWith("-")) return 'must not start with "-"';
  if (/^(ext|fd)::/i.test(value) || /^file:/i.test(value)) return "uses an unsupported transport";
  const m = value.match(/^([a-z][a-z0-9+.-]*):\/\//i);
  if (m) {
    const scheme = m[1].toLowerCase();
    if (!allowed.includes(scheme)) return `must use ${allowed.join(" or ")}`;
    let url;
    try { url = new URL(value); } catch { return "is not a valid URL"; }
    if (url.password || (scheme === "https" && url.username)) return "must not embed credentials";
    if (!url.hostname) return "has no host";
    return null;
  }
  if (allowed.includes("ssh") && /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[^\s]+$/.test(value)) return null;
  return `must be a ${allowed.join(" or ")} URL${allowed.includes("ssh") ? " (or user@host:path)" : ""}`;
}

const isUrlLike = (v) => typeof v === "string" && (/^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:/.test(v));

function pathProblem(p) {
  if (typeof p !== "string" || !p.trim()) return "must be a non-empty string";
  if (/[\0-\x1f]/.test(p)) return "must not contain control characters";
  if (p.startsWith("-")) return 'must not start with "-"';
  return null;
}

function relativePathProblem(p) {
  const base = pathProblem(p);
  if (base) return base;
  if (path.isAbsolute(p) || /^[A-Za-z]:/.test(p)) return "must be relative to the workspace";
  if (p.split(/[\\/]/).includes("..")) return 'must not contain ".." segments';
  return null;
}

/** Builds the problem list and small typed readers around it. */
function collector() {
  const problems = [];
  return {
    problems,
    err: (p, message) => problems.push({ level: "error", path: p, message }),
    warn: (p, message) => problems.push({ level: "warning", path: p, message }),
  };
}

function scanSecrets(value, where, c) {
  if (typeof value === "string") {
    if (SECRET_PATTERNS.some((re) => re.test(value))) c.err(where, "looks like a credential; contracts carry credential NAMES only (permissions.credentials.names), never values");
  } else if (Array.isArray(value)) value.forEach((v, i) => scanSecrets(v, `${where}[${i}]`, c));
  else if (isPlainObject(value)) for (const [k, v] of Object.entries(value)) scanSecrets(v, `${where}.${k}`, c);
}

function checkKeys(obj, where, allowed, { strict }, c) {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) continue;
    if (strict) c.err(`${where}.${key}`, `unknown key (safety-critical sections reject unknown keys so nothing can be widened silently); allowed: ${allowed.join(", ")}`);
    else c.warn(`${where}.${key}`, "unknown key ignored");
  }
}

function asObject(v, where, c) {
  if (v === undefined || v === null) return {};
  if (!isPlainObject(v)) { c.err(where, "must be an object"); return {}; }
  return v;
}

function num(v, where, c, { min = -Infinity, max = Infinity, int = false, def } = {}) {
  if (v === undefined || v === null) return def;
  if (typeof v !== "number" || !Number.isFinite(v)) { c.err(where, "must be a number"); return def; }
  if (int && !Number.isInteger(v)) { c.err(where, "must be an integer"); return def; }
  if (v < min || v > max) { c.err(where, `must be between ${min} and ${max}`); return def; }
  return v;
}

function str(v, where, c, { re, def, max = 500, what } = {}) {
  if (v === undefined || v === null) return def;
  if (typeof v !== "string" || !v.trim()) { c.err(where, "must be a non-empty string"); return def; }
  if (v.length > max) { c.err(where, `is longer than ${max} characters`); return def; }
  if (re && !re.test(v)) { c.err(where, what ?? `does not match ${re}`); return def; }
  return v;
}

function bool(v, where, c, def) {
  if (v === undefined || v === null) return def;
  if (typeof v !== "boolean") { c.err(where, "must be true or false"); return def; }
  return v;
}

function arr(v, where, c, { max = 200 } = {}) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) { c.err(where, "must be an array"); return []; }
  if (v.length > max) { c.err(where, `has more than ${max} entries`); return v.slice(0, max); }
  return v;
}

const argvOrShell = (run, where, c) => {
  if (typeof run === "string") {
    if (!run.trim()) c.err(where, "must not be empty");
    else if (run.length > 4000) c.err(where, "is longer than 4000 characters");
    return run;
  }
  if (Array.isArray(run) && run.length && run.length <= 100 && run.every((a) => typeof a === "string" && a.length <= 4000 && !a.includes("\0"))) return run;
  c.err(where, "must be a non-empty argv array of strings, or a shell command string");
  return Array.isArray(run) ? run : String(run ?? "");
};

// --- sections ---------------------------------------------------------------------------------

function readObjective(raw, opts, c) {
  const o = asObject(raw, "objective", c);
  checkKeys(o, "objective", ["title", "spec", "specFile", "backlog"], { strict: false }, c);
  const out = { title: str(o.title, "objective.title", c, { max: 200 }) ?? "", spec: "" };
  if (!out.title) c.err("objective.title", "is required");
  if (o.spec !== undefined && o.specFile !== undefined) c.err("objective", "give spec (inline text) or specFile, not both");
  if (typeof o.spec === "string") {
    if (o.spec.length > 200_000) c.err("objective.spec", "is longer than 200000 characters");
    out.spec = o.spec;
  } else if (o.spec !== undefined) c.err("objective.spec", "must be a string");
  if (o.specFile !== undefined) {
    const problem = relativePathProblem(o.specFile);
    if (problem) c.err("objective.specFile", problem);
    else {
      out.specFile = o.specFile;
      if (opts.baseDir) {
        const file = path.resolve(opts.baseDir, o.specFile);
        try {
          out.spec = fs.readFileSync(file, "utf8");
          if (out.spec.length > 200_000) c.err("objective.specFile", "is longer than 200000 characters");
          out.specSha256 = sha256(out.spec);
        } catch (e) { c.err("objective.specFile", `cannot read ${file}: ${e.code ?? e.message}`); }
      }
    }
  }
  out.backlog = [];
  const seen = new Set();
  for (const [i, item] of arr(o.backlog, "objective.backlog", c, { max: 200 }).entries()) {
    const where = `objective.backlog[${i}]`;
    if (!isPlainObject(item)) { c.err(where, "must be an object"); continue; }
    checkKeys(item, where, ["id", "title", "detail", "acceptance"], { strict: false }, c);
    const id = str(item.id, `${where}.id`, c, { re: ITEM_ID, what: "must be 1-41 characters of letters, digits, . _ -" });
    if (id && seen.has(id)) c.err(`${where}.id`, `duplicate backlog id "${id}"`);
    if (id) seen.add(id);
    const entry = { id: id ?? "", title: str(item.title, `${where}.title`, c, { max: 300 }) ?? "" };
    if (!entry.title) c.err(`${where}.title`, "is required");
    if (item.detail !== undefined) entry.detail = str(item.detail, `${where}.detail`, c, { max: 20_000 });
    if (item.acceptance !== undefined) {
      entry.acceptance = arr(item.acceptance, `${where}.acceptance`, c, { max: 50 }).filter((a, j) => typeof a === "string" || (c.err(`${where}.acceptance[${j}]`, "must be a check id"), false));
    }
    out.backlog.push(entry);
  }
  return out;
}

function readRepository(raw, where, c, opts) {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) { c.err(where, "must be an object or null"); return null; }
  checkKeys(raw, where, ["path", "url", "ref"], { strict: false }, c);
  if ((raw.path === undefined) === (raw.url === undefined)) { c.err(where, "give exactly one of path (a local repository) or url"); return null; }
  const out = {};
  if (raw.path !== undefined) {
    const problem = pathProblem(raw.path);
    if (problem) c.err(`${where}.path`, problem);
    else out.path = opts.baseDir && !path.isAbsolute(raw.path) ? path.resolve(opts.baseDir, raw.path) : raw.path;
  } else {
    const problem = urlProblem(raw.url);
    if (problem) c.err(`${where}.url`, problem);
    else out.url = raw.url;
  }
  out.ref = str(raw.ref, `${where}.ref`, c, { re: REF_NAME, def: "HEAD", what: "must be a branch, tag or HEAD (letters, digits, . _ - /)" });
  if (out.ref && (out.ref.includes("..") || out.ref.endsWith("/") || out.ref.endsWith(".lock"))) c.err(`${where}.ref`, "is not a valid ref name");
  return out;
}

function readInputs(raw, c, opts) {
  const o = asObject(raw, "inputs", c);
  checkKeys(o, "inputs", ["repository", "references"], { strict: false }, c);
  const out = { repository: readRepository(o.repository, "inputs.repository", c, opts), references: {} };
  const refs = asObject(o.references, "inputs.references", c);
  for (const [name, src] of Object.entries(refs)) {
    if (!REFERENCE_NAME.test(name)) { c.err(`inputs.references.${name}`, "bad reference name (lowercase letters, digits, . _ -)"); continue; }
    const problem = pathProblem(src);
    if (problem) c.err(`inputs.references.${name}`, problem);
    else out.references[name] = opts.baseDir && !path.isAbsolute(src) && !isUrlLike(src) ? path.resolve(opts.baseDir, src) : src;
  }
  return out;
}

function readAcceptance(raw, c, opts, template) {
  const o = asObject(raw, "acceptance", c);
  checkKeys(o, "acceptance", ["checks", "overlay", "review"], { strict: false }, c);
  const out = { checks: [], overlay: [], review: bool(o.review, "acceptance.review", c, true) };
  const seen = new Set();
  for (const [i, check] of arr(o.checks, "acceptance.checks", c, { max: 100 }).entries()) {
    const where = `acceptance.checks[${i}]`;
    if (!isPlainObject(check)) { c.err(where, "must be an object"); continue; }
    checkKeys(check, where, ["id", "type", "run", "cwd", "timeoutMinutes", "required", "description", "service", "path", "expectStatus"], { strict: false }, c);
    const id = str(check.id, `${where}.id`, c, { re: CHECK_ID, what: "must be 1-41 characters: lowercase letters, digits, . _ -" }) ?? "";
    if (id && seen.has(id)) c.err(`${where}.id`, `duplicate check id "${id}"`);
    seen.add(id);
    const type = check.type ?? "command";
    if (type !== "command" && type !== "service-health") c.err(`${where}.type`, 'must be "command" or "service-health"');
    const entry = { id, type, required: bool(check.required, `${where}.required`, c, true), timeoutMinutes: num(check.timeoutMinutes, `${where}.timeoutMinutes`, c, { min: 1, max: 240, int: true, def: 15 }) };
    if (check.description !== undefined) entry.description = str(check.description, `${where}.description`, c, { max: 500 });
    if (type === "command") {
      if (check.run === undefined) c.err(`${where}.run`, "is required for a command check");
      else entry.run = argvOrShell(check.run, `${where}.run`, c);
      if (check.cwd !== undefined) {
        const problem = relativePathProblem(check.cwd);
        if (problem) c.err(`${where}.cwd`, problem); else entry.cwd = check.cwd;
      }
    } else {
      entry.service = str(check.service, `${where}.service`, c, { re: SERVICE_NAME, what: "must name a declared service" });
      entry.path = str(check.path, `${where}.path`, c, { def: "/", max: 300 });
      if (entry.path && !entry.path.startsWith("/")) c.err(`${where}.path`, 'must start with "/"');
      entry.expectStatus = num(check.expectStatus, `${where}.expectStatus`, c, { min: 100, max: 599, int: true, def: 200 });
      if (check.run !== undefined) c.err(`${where}.run`, "a service-health check takes service/path/expectStatus, not run");
    }
    out.checks.push(entry);
  }
  for (const [i, ov] of arr(o.overlay, "acceptance.overlay", c, { max: 200 }).entries()) {
    const where = `acceptance.overlay[${i}]`;
    if (!isPlainObject(ov)) { c.err(where, "must be an object"); continue; }
    checkKeys(ov, where, ["source", "target"], { strict: false }, c);
    const sp = pathProblem(ov.source); const tp = relativePathProblem(ov.target);
    if (sp) c.err(`${where}.source`, sp);
    if (tp) c.err(`${where}.target`, tp);
    else if (String(ov.target).split("/")[0] === ".git") c.err(`${where}.target`, "must not target .git");
    if (!sp && !tp) out.overlay.push({ source: opts.baseDir && !path.isAbsolute(ov.source) ? path.resolve(opts.baseDir, ov.source) : ov.source, target: ov.target.replace(/^\.\//, "") });
  }
  void template;
  return out;
}

function readServices(raw, images, c) {
  const list = [];
  const seen = new Set();
  for (const [i, s] of arr(raw, "permissions.network.services", c, { max: 10 }).entries()) {
    const where = `permissions.network.services[${i}]`;
    if (!isPlainObject(s)) { c.err(where, "must be an object"); continue; }
    checkKeys(s, where, ["name", "image", "env", "credentialEnv", "port", "command", "workspaceMounts", "restartOnDeploy", "tmpfs", "user", "health", "memory", "cpus"], { strict: true }, c);
    const name = str(s.name, `${where}.name`, c, { re: SERVICE_NAME, what: "must be a lowercase DNS label (2-31 characters)" }) ?? "";
    if (RESERVED_HOSTNAMES.has(name)) c.err(`${where}.name`, `"${name}" is reserved`);
    if (seen.has(name)) c.err(`${where}.name`, `duplicate service name "${name}"`);
    seen.add(name);
    const image = str(s.image, `${where}.image`, c, { re: IMAGE_REF, what: "is not a valid image reference", max: 300 }) ?? "";
    if (image) {
      const pinned = /@sha256:[a-f0-9]{64}$/.test(image) || (/:[\w][\w.-]*$/.test(image.split("/").pop()) && !/:latest$/.test(image));
      if (!pinned) c.err(`${where}.image`, "must be pinned by a tag (not :latest) or a sha256 digest");
      if (!images.includes(image)) c.err(`${where}.image`, `is not in permissions.network.serviceImages (the allowlist of images the supervisor may start)`);
    }
    const entry = { name, image, port: num(s.port, `${where}.port`, c, { min: 1, max: 65535, int: true }), env: {}, credentialEnv: {}, workspaceMounts: [] };
    if (entry.port === undefined) c.err(`${where}.port`, "is required");
    for (const [k, v] of Object.entries(asObject(s.env, `${where}.env`, c))) {
      if (!ENV_NAME.test(k)) c.err(`${where}.env.${k}`, "bad environment variable name");
      else if (typeof v !== "string") c.err(`${where}.env.${k}`, "must be a string");
      else entry.env[k] = v;
    }
    for (const [k, v] of Object.entries(asObject(s.credentialEnv, `${where}.credentialEnv`, c))) {
      if (!ENV_NAME.test(k)) c.err(`${where}.credentialEnv.${k}`, "bad environment variable name");
      else if (typeof v !== "string" || !CRED_NAME.test(v)) c.err(`${where}.credentialEnv.${k}`, "must be a credential NAME (upper-case, as listed in permissions.credentials.names)");
      else entry.credentialEnv[k] = v;
    }
    if (s.command !== undefined) {
      if (Array.isArray(s.command) && s.command.length && s.command.every((a) => typeof a === "string")) entry.command = s.command;
      else c.err(`${where}.command`, "must be a non-empty argv array of strings");
    }
    for (const [j, m] of arr(s.workspaceMounts, `${where}.workspaceMounts`, c, { max: 5 }).entries()) {
      const mw = `${where}.workspaceMounts[${j}]`;
      if (!isPlainObject(m)) { c.err(mw, "must be an object"); continue; }
      checkKeys(m, mw, ["source", "target"], { strict: true }, c);
      const sp = relativePathProblem(m.source);
      if (sp) c.err(`${mw}.source`, `${sp} (a path inside the worker workspace; mounted read-only)`);
      if (typeof m.target !== "string" || !m.target.startsWith("/") || m.target.includes("..") || /[\0-\x1f]/.test(m.target)) c.err(`${mw}.target`, "must be an absolute path inside the service container");
      if (!sp && typeof m.target === "string" && m.target.startsWith("/")) entry.workspaceMounts.push({ source: m.source.replace(/^\.\//, ""), target: m.target });
    }
    entry.restartOnDeploy = bool(s.restartOnDeploy, `${where}.restartOnDeploy`, c, false);
    entry.tmpfs = [];
    for (const [j, t] of arr(s.tmpfs, `${where}.tmpfs`, c, { max: 5 }).entries()) {
      if (typeof t !== "string" || !t.startsWith("/") || t.includes("..") || t.includes(",") || /[\0-\x1f]/.test(t)) c.err(`${where}.tmpfs[${j}]`, "must be an absolute path inside the service container (a size-limited tmpfs; the root filesystem stays read-only)");
      else entry.tmpfs.push(t);
    }
    if (s.user !== undefined) entry.user = str(s.user, `${where}.user`, c, { re: /^\d+:\d+$/, what: 'must be "uid:gid" (services never run as root: 0 is refused below)' });
    if (entry.user && (entry.user.startsWith("0:") || entry.user.endsWith(":0") || entry.user === "0:0")) { c.err(`${where}.user`, "must not be root"); delete entry.user; }
    const h = asObject(s.health, `${where}.health`, c);
    checkKeys(h, `${where}.health`, ["path", "cmd", "expectStatus", "intervalSeconds", "timeoutSeconds", "retries"], { strict: true }, c);
    entry.health = { intervalSeconds: num(h.intervalSeconds, `${where}.health.intervalSeconds`, c, { min: 1, max: 300, int: true, def: 5 }), timeoutSeconds: num(h.timeoutSeconds, `${where}.health.timeoutSeconds`, c, { min: 1, max: 300, int: true, def: 5 }), retries: num(h.retries, `${where}.health.retries`, c, { min: 1, max: 100, int: true, def: 12 }) };
    if (h.path !== undefined && h.cmd !== undefined) c.err(`${where}.health`, "give path (HTTP) or cmd, not both");
    if (h.path !== undefined) { entry.health.path = str(h.path, `${where}.health.path`, c, { max: 300 }); if (entry.health.path && !entry.health.path.startsWith("/")) c.err(`${where}.health.path`, 'must start with "/"'); entry.health.expectStatus = num(h.expectStatus, `${where}.health.expectStatus`, c, { min: 100, max: 599, int: true, def: 200 }); }
    else if (h.cmd !== undefined) { if (Array.isArray(h.cmd) && h.cmd.length && h.cmd.every((a) => typeof a === "string")) entry.health.cmd = h.cmd; else c.err(`${where}.health.cmd`, "must be a non-empty argv array of strings"); }
    else c.err(`${where}.health`, "needs path (HTTP check) or cmd (run inside the service container)");
    if (s.memory !== undefined) entry.memory = str(s.memory, `${where}.memory`, c, { re: /^\d+[kmg]?$/i, what: "must look like 512m or 2g" });
    if (s.cpus !== undefined) entry.cpus = str(String(s.cpus), `${where}.cpus`, c, { re: /^\d+(\.\d+)?$/, what: "must be a number" });
    list.push(entry);
  }
  return list;
}

function readEgress(raw, c) {
  const list = [];
  const seen = new Set();
  for (const [i, e] of arr(raw, "permissions.network.egress", c, { max: 50 }).entries()) {
    const where = `permissions.network.egress[${i}]`;
    if (!isPlainObject(e)) { c.err(where, "must be an object"); continue; }
    checkKeys(e, where, ["host", "ports", "plainGet"], { strict: true }, c);
    let host = typeof e.host === "string" ? normaliseHost(e.host) : null;
    if (host && isIpLiteral(host)) host = canonicalIp(host); // stored in one spelling, so the allowlist compares like with like
    let ok = Boolean(host);
    if (!host) c.err(`${where}.host`, "must be a host name (no scheme, port, path, user info or wildcard)");
    else if (isIpLiteral(host)) {
      if (!isPublicIpLiteral(host)) { c.err(`${where}.host`, `${host} is a ${classifyAddress(host)} address; egress to private, loopback, link-local or metadata addresses is never allowed (declare a run service instead)`); ok = false; }
    } else if (!/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(host)) { c.err(`${where}.host`, "is not a valid fully qualified domain name"); ok = false; }
    else if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) { c.err(`${where}.host`, "is a local name; egress is for public hosts only"); ok = false; }
    const ports = [];
    for (const [j, p] of arr(e.ports ?? [443], `${where}.ports`, c, { max: 10 }).entries()) {
      const v = num(p, `${where}.ports[${j}]`, c, { min: 1, max: 65535, int: true });
      if (v !== undefined) ports.push(v);
    }
    if (!ports.length) c.err(`${where}.ports`, "needs at least one port");
    const plainGet = bool(e.plainGet, `${where}.plainGet`, c, false);
    if (host && seen.has(host)) c.err(`${where}.host`, `duplicate egress host "${host}"`);
    seen.add(host);
    if (ok && host) list.push({ host, ports: [...new Set(ports)].sort((a, b) => a - b), plainGet });
  }
  return list;
}

function readPermissions(raw, c, template) {
  const o = asObject(raw, "permissions", c);
  checkKeys(o, "permissions", ["writeAreas", "network", "credentials", "outputs", "unattended"], { strict: true }, c);
  const out = { writeAreas: [], network: { egress: [], services: [], serviceImages: [] }, credentials: { names: [] }, outputs: { destinations: [] }, unattended: { authorised: false, autoApprove: false } };
  const areas = o.writeAreas === undefined ? ["**"] : arr(o.writeAreas, "permissions.writeAreas", c, { max: 100 });
  for (const [i, g] of areas.entries()) {
    const problem = globProblem(g);
    if (problem) c.err(`permissions.writeAreas[${i}]`, problem); else out.writeAreas.push(g);
  }
  if (!out.writeAreas.length) c.err("permissions.writeAreas", "needs at least one glob (default [\"**\"], the whole workspace)");

  const n = asObject(o.network, "permissions.network", c);
  checkKeys(n, "permissions.network", ["egress", "services", "serviceImages"], { strict: true }, c);
  out.network.egress = readEgress(n.egress, c);
  for (const [i, img] of arr(n.serviceImages, "permissions.network.serviceImages", c, { max: 20 }).entries()) {
    if (typeof img !== "string" || !IMAGE_REF.test(img)) c.err(`permissions.network.serviceImages[${i}]`, "is not a valid image reference"); else out.network.serviceImages.push(img);
  }
  out.network.services = readServices(n.services, out.network.serviceImages, c);
  if (out.network.services.length && template && template !== "deploy") c.err("permissions.network.services", `run services are part of the deploy template; template "${template}" declares none`);

  const cr = asObject(o.credentials, "permissions.credentials", c);
  checkKeys(cr, "permissions.credentials", ["names"], { strict: true }, c);
  for (const [i, name] of arr(cr.names, "permissions.credentials.names", c, { max: 30 }).entries()) {
    if (typeof name !== "string" || !CRED_NAME.test(name)) c.err(`permissions.credentials.names[${i}]`, "must be an upper-case environment variable name; values are never written in a contract");
    else out.credentials.names.push(name);
  }
  for (const s of out.network.services) for (const cred of Object.values(s.credentialEnv)) if (!out.credentials.names.includes(cred)) c.err(`permissions.network.services.${s.name}.credentialEnv`, `${cred} is not declared in permissions.credentials.names`);

  const outp = asObject(o.outputs, "permissions.outputs", c);
  checkKeys(outp, "permissions.outputs", ["destinations"], { strict: true }, c);
  for (const [i, d] of arr(outp.destinations, "permissions.outputs.destinations", c, { max: 10 }).entries()) {
    const where = `permissions.outputs.destinations[${i}]`;
    if (!isPlainObject(d)) { c.err(where, "must be an object"); continue; }
    checkKeys(d, where, ["kind", "path"], { strict: true }, c);
    if (d.kind !== "export-dir") c.err(`${where}.kind`, 'must be "export-dir"');
    const problem = pathProblem(d.path);
    if (problem) c.err(`${where}.path`, problem);
    else if (!path.isAbsolute(d.path)) c.err(`${where}.path`, "must be an absolute path");
    if (d.kind === "export-dir" && !problem) out.outputs.destinations.push({ kind: "export-dir", path: d.path });
  }

  const u = asObject(o.unattended, "permissions.unattended", c);
  checkKeys(u, "permissions.unattended", ["authorised", "autoApprove"], { strict: true }, c);
  out.unattended = { authorised: bool(u.authorised, "permissions.unattended.authorised", c, false), autoApprove: bool(u.autoApprove, "permissions.unattended.autoApprove", c, false) };
  if (out.unattended.autoApprove && !out.unattended.authorised) c.err("permissions.unattended", "autoApprove requires authorised: true (approvals are only answered automatically inside an authorised unattended zone)");
  return out;
}

function readModel(rawModel, rawProvider, c) {
  const m = asObject(rawModel, "model", c);
  checkKeys(m, "model", ["provider", "worker", "manager", "review", "extra"], { strict: false }, c);
  const provider = str(m.provider, "model.provider", c, { def: "openrouter", max: 40 });
  if (!Object.hasOwn(PROVIDERS, provider)) c.err("model.provider", `unknown provider "${provider}"; known: ${providerIds().join(", ")}`);
  const preset = PROVIDERS[provider] ?? PROVIDERS["openai-compatible"];
  const modelId = (v, where, def) => {
    const s = str(v, where, c, { def, max: 121 });
    if (s && (!MODEL_ID.test(s) || /:online\b/i.test(s))) { c.err(where, "is not a plain model id (no :online variants)"); return def; }
    return s;
  };
  const worker = modelId(m.worker, "model.worker", provider === "openrouter" ? DEFAULT_MODEL : undefined);
  if (!worker) c.err("model.worker", `is required for provider "${provider}"`);
  const out = { provider, worker: worker ?? "", manager: modelId(m.manager, "model.manager", worker) ?? worker ?? "", review: modelId(m.review, "model.review", undefined), extra: [] };
  out.review = out.review ?? out.manager;
  for (const [i, e] of arr(m.extra, "model.extra", c, { max: 10 }).entries()) {
    const s = modelId(e, `model.extra[${i}]`, undefined);
    if (s) out.extra.push(s);
  }

  const p = asObject(rawProvider, "providerSettings", c);
  checkKeys(p, "providerSettings", ["upstream", "apiKeyEnv", "authName", "headers", "pricing"], { strict: false }, c);
  const settings = { upstream: str(p.upstream, "providerSettings.upstream", c, { def: preset.upstream ?? undefined, max: 300 }), apiKeyEnv: str(p.apiKeyEnv, "providerSettings.apiKeyEnv", c, { def: preset.apiKeyEnv ?? undefined, re: CRED_NAME, what: "must be an upper-case environment variable NAME (the value is read from the operator's environment, never from the contract)" }), authName: str(p.authName, "providerSettings.authName", c, { def: preset.authName ?? undefined, max: 60 }), headers: {}, pricing: {} };
  if (!settings.upstream) c.err("providerSettings.upstream", `is required for provider "${provider}"`);
  else {
    const problem = urlProblem(settings.upstream, { allowed: ["https"] });
    if (problem) c.err("providerSettings.upstream", problem);
  }
  if (provider === "openai-compatible" && !settings.apiKeyEnv) c.err("providerSettings.apiKeyEnv", 'is required for provider "openai-compatible"');
  for (const [k, v] of Object.entries(asObject(p.headers, "providerSettings.headers", c))) {
    if (!/^[A-Za-z0-9-]{1,60}$/.test(k) || typeof v !== "string" || v.length > 200) c.err(`providerSettings.headers.${k}`, "must be a short header name with a short string value");
    else if (/^(authorization|proxy-authorization|cookie|x-api-key)$/i.test(k)) c.err(`providerSettings.headers.${k}`, "credential headers are set by the relay from the operator's key, never by the contract");
    else settings.headers[k] = v;
  }
  for (const [model, pr] of Object.entries(asObject(p.pricing, "providerSettings.pricing", c))) {
    if (!isPlainObject(pr) || !(pr.inputPerMTok >= 0) || !(pr.outputPerMTok >= 0)) c.err(`providerSettings.pricing.${model}`, "must be { inputPerMTok, outputPerMTok } in USD per million tokens");
    else settings.pricing[model] = { inputPerMTok: pr.inputPerMTok, outputPerMTok: pr.outputPerMTok };
  }
  if (!preset.reportsCost) {
    // Spend cannot be metered without a price, and an unmetered run cannot honour its budget.
    for (const id of new Set([out.worker, out.manager, out.review, ...out.extra].filter(Boolean))) {
      if (!settings.pricing[id]) c.err("providerSettings.pricing", `provider "${provider}" does not report cost; give pricing for ${id} so the budget can be enforced`);
    }
  }
  return { model: out, providerSettings: settings };
}

function readEffort(raw, c, effort) {
  if (!effort) { c.err("effort", EFFORT_UNAVAILABLE); return { tier: "standard", cap: "standard" }; }
  const def = (() => { try { return effort.loadEffortPolicy().default; } catch { return "standard"; } })();
  const request = raw === undefined || raw === null ? { tier: def } : typeof raw === "string" || typeof raw === "number" ? { tier: raw } : raw;
  if (!isPlainObject(request)) { c.err("effort", "must be a tier name (E1..E5, minimal..exhaustive) or { tier, cap }"); return { tier: def, cap: def }; }
  checkKeys(request, "effort", ["tier", "cap"], { strict: false }, c);
  const tier = effort.normalizeTier(request.tier ?? def);
  if (!tier) { c.err("effort.tier", `${JSON.stringify(request.tier)} is not an effort tier (E1..E5 or minimal, focused, standard, thorough, exhaustive)`); return { tier: def, cap: def }; }
  const cap = request.cap === undefined ? tier : effort.normalizeTier(request.cap);
  if (!cap) { c.err("effort.cap", `${JSON.stringify(request.cap)} is not an effort tier`); return { tier, cap: tier }; }
  if (effort.clampTier(tier, cap) !== tier) c.err("effort", `tier ${tier} is above its cap ${cap}`);
  return { tier, cap };
}

function readBudget(raw, c) {
  const b = asObject(raw, "budget", c);
  checkKeys(b, "budget", ["totalUsd", "perStepUsd", "maxSteps", "maxMinutes"], { strict: false }, c);
  const out = {
    totalUsd: num(b.totalUsd, "budget.totalUsd", c, { min: 0.01, max: 100_000 }),
    perStepUsd: num(b.perStepUsd, "budget.perStepUsd", c, { min: 0.01, max: 100_000 }),
    maxSteps: num(b.maxSteps, "budget.maxSteps", c, { min: 1, max: 1000, int: true }),
    maxMinutes: num(b.maxMinutes, "budget.maxMinutes", c, { min: 1, max: 43_200, int: true }),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined && (b[k] === undefined || b[k] === null)) c.err(`budget.${k}`, "is required (every run is bounded by money, steps and time)");
  if (out.totalUsd !== undefined && out.perStepUsd !== undefined && out.perStepUsd > out.totalUsd) c.err("budget.perStepUsd", "must not exceed budget.totalUsd");
  return out;
}

function readRecovery(raw, c) {
  const r = asObject(raw, "recovery", c);
  checkKeys(r, "recovery", ["softNudges", "hardRestarts", "maxAttemptsPerStep"], { strict: false }, c);
  return {
    softNudges: num(r.softNudges, "recovery.softNudges", c, { min: 0, max: 10, int: true, def: 2 }),
    hardRestarts: num(r.hardRestarts, "recovery.hardRestarts", c, { min: 0, max: 5, int: true, def: 1 }),
    maxAttemptsPerStep: num(r.maxAttemptsPerStep, "recovery.maxAttemptsPerStep", c, { min: 1, max: 100, int: true, def: 8 }),
  };
}

function readPromotion(raw, c, inputs, run) {
  const p = asObject(raw, "promotion", c);
  checkKeys(p, "promotion", ["policy", "destinations", "requiresOperatorApproval"], { strict: true }, c);
  const policy = p.policy === undefined ? "none" : p.policy;
  if (!["none", "local-branch", "push"].includes(policy)) c.err("promotion.policy", 'must be "none", "local-branch" or "push"');
  const out = { policy, destinations: [], requiresOperatorApproval: bool(p.requiresOperatorApproval, "promotion.requiresOperatorApproval", c, true) };
  for (const [i, d] of arr(p.destinations, "promotion.destinations", c, { max: 5 }).entries()) {
    const where = `promotion.destinations[${i}]`;
    if (!isPlainObject(d)) { c.err(where, "must be an object"); continue; }
    if (policy === "local-branch") {
      checkKeys(d, where, ["kind", "repo", "branch"], { strict: true }, c);
      if (d.kind !== "local-branch") c.err(`${where}.kind`, 'must be "local-branch"');
      const entry = { kind: "local-branch" };
      if (d.repo !== undefined) { const problem = pathProblem(d.repo); if (problem) c.err(`${where}.repo`, problem); else entry.repo = d.repo; }
      entry.branch = str(d.branch, `${where}.branch`, c, { re: BRANCH_NAME, def: `pi/${run || "run"}`, what: "is not a valid branch name" });
      if (entry.branch && (entry.branch.includes("..") || entry.branch.endsWith("/") || entry.branch.endsWith(".lock") || isProtectedBranch(entry.branch))) c.err(`${where}.branch`, `"${entry.branch}" is a protected or invalid branch name; a run never moves the branches a person merges to`);
      out.destinations.push(entry);
    } else if (policy === "push") {
      checkKeys(d, where, ["kind", "url", "branch", "tags"], { strict: true }, c);
      if (d.kind !== "git-remote") c.err(`${where}.kind`, 'must be "git-remote"');
      const problem = urlProblem(d.url);
      const entry = { kind: "git-remote", url: d.url, tags: bool(d.tags, `${where}.tags`, c, false) };
      if (problem) c.err(`${where}.url`, problem);
      entry.branch = str(d.branch, `${where}.branch`, c, { re: BRANCH_NAME, what: "is not a valid branch name" });
      if (!entry.branch) c.err(`${where}.branch`, "is required for a push destination");
      else if (entry.branch.includes("..") || entry.branch.endsWith("/") || entry.branch.endsWith(".lock") || isProtectedBranch(entry.branch)) c.err(`${where}.branch`, `"${entry.branch}" is a protected or invalid branch name; promote to a review branch, never to a protected one`);
      out.destinations.push(entry);
    } else c.err(where, `policy "${policy}" takes no destinations`);
  }
  if (policy === "push" && !out.destinations.length) c.err("promotion.destinations", 'policy "push" needs at least one git-remote destination (nothing is ever pushed to an unlisted remote)');
  if (policy === "push" && !out.requiresOperatorApproval) c.warn("promotion.requiresOperatorApproval", "false: the supervisor will push to the listed remotes without asking again; the boundary authorisation is the only approval");
  void inputs;
  return out;
}

function readRuntime(raw, c) {
  const r = asObject(raw, "runtime", c);
  checkKeys(r, "runtime", Object.keys(DEFAULT_RUNTIME), { strict: false }, c);
  const out = { ...clone(DEFAULT_RUNTIME) };
  if (r.engine !== undefined) { if (!["podman", "docker"].includes(r.engine)) c.err("runtime.engine", '"podman" or "docker"'); else out.engine = r.engine; }
  out.image = str(r.image, "runtime.image", c, { re: IMAGE_REF, def: out.image, what: "is not a valid image reference", max: 300 });
  out.memory = str(r.memory, "runtime.memory", c, { re: /^\d+[kmg]?$/i, def: out.memory, what: "must look like 512m or 6g" });
  out.cpus = str(r.cpus === undefined ? undefined : String(r.cpus), "runtime.cpus", c, { re: /^\d+(\.\d+)?$/, def: out.cpus, what: "must be a number" });
  out.pids = num(r.pids, "runtime.pids", c, { min: 16, max: 100_000, int: true, def: out.pids });
  out.tmpSize = str(r.tmpSize, "runtime.tmpSize", c, { re: /^\d+[kmg]?$/i, def: out.tmpSize, what: "must look like 512m or 4g" });
  out.user = str(r.user, "runtime.user", c, { re: /^(host|\d+:\d+)$/, def: out.user, what: 'must be "host" or "uid:gid"' });
  out.mirrorSeconds = num(r.mirrorSeconds, "runtime.mirrorSeconds", c, { min: 1, max: 3600, int: true, def: out.mirrorSeconds });
  const gi = asObject(r.gitIdentity, "runtime.gitIdentity", c);
  out.gitIdentity = { name: str(gi.name, "runtime.gitIdentity.name", c, { def: out.gitIdentity.name, max: 100 }), email: str(gi.email, "runtime.gitIdentity.email", c, { def: out.gitIdentity.email, max: 200 }) };
  return out;
}

function readAuthorisation(raw, c) {
  if (raw === undefined || raw === null) return null;
  if (!isPlainObject(raw)) { c.err("authorisation", "must be an object { boundaryDigest, by, at }"); return null; }
  checkKeys(raw, "authorisation", ["boundaryDigest", "by", "at"], { strict: true }, c);
  const out = { boundaryDigest: str(raw.boundaryDigest, "authorisation.boundaryDigest", c, { re: HEX64, what: "must be the 64-character hex boundary digest printed by `plan`" }), by: str(raw.by, "authorisation.by", c, { max: 200 }), at: str(raw.at, "authorisation.at", c, { max: 40 }) };
  if (!out.by) c.err("authorisation.by", "is required (who authorised this boundary)");
  if (out.at && Number.isNaN(Date.parse(out.at))) c.err("authorisation.at", "must be an ISO date-time");
  if (!out.at) c.err("authorisation.at", "is required");
  return out;
}

// --- legacy v0 -------------------------------------------------------------------------------

const LEGACY_KEYS = ["run", "cycles", "model", "managerModel", "provider", "upstream", "image", "engine", "gitRemote", "baseRef", "integration", "extraModels", "references", "gitIdentity", "budget", "limits", "mirrorSeconds", "container", "gate", "promotion", "authorisation"];

/** Does this look like the pre-contract configuration file (cycles / gitRemote / integration)? */
export function looksLegacy(raw) {
  return isPlainObject(raw) && raw.schemaVersion === undefined && raw.template === undefined && ["cycles", "gitRemote", "integration", "managerModel", "baseRef", "limits", "container", "gate"].some((k) => k in raw);
}

/**
 * Map the v0 config onto the self-improve template. v0 relied on a built-in private remote and
 * always published; both are gone, so a v0 file must now state its remote and promotion policy.
 */
export function legacyToRaw(v0, c) {
  checkKeys(v0, "config", LEGACY_KEYS, { strict: false }, c);
  c.warn("config", "deprecated v0 config shape: mapped onto the self-improve template. Write a schemaVersion 1 contract instead (`pi-autonomy init --template self-improve`).");
  if (typeof v0.gitRemote !== "string" || !v0.gitRemote.trim()) c.err("gitRemote", "is required: there is no default remote any more. Name the repository the run improves and publishes to.");
  const policy = v0.promotion;
  if (!["none", "local-branch", "push"].includes(policy)) c.err("promotion", 'is required in a v0 config now: "none", "local-branch" or "push" (v0 always pushed to its built-in remote; state it explicitly)');
  const cycles = v0.cycles ?? 50;
  const limits = { softMinutes: 180, hardMinutes: 300, idleMinutes: 20, noCommitMinutes: 90, managerCallsPerCycle: 3, redGatesInARow: 2, guardEscalations: 3, nothingFoundToStop: 3, ...(v0.limits ?? {}) };
  const budget = { perCycleUsd: 5, perCycleHardUsd: null, totalUsd: 100, ...(v0.budget ?? {}) };
  const perCycleHardUsd = budget.perCycleHardUsd ?? 2 * budget.perCycleUsd;
  const remote = v0.gitRemote;
  const integration = { branch: "experimental/main", review: true, ...(v0.integration ?? {}) };
  const ref = v0.baseRef ?? "main";
  const maxMinutesWanted = Number.isFinite(cycles) && Number.isFinite(limits.hardMinutes) ? Math.ceil(cycles * limits.hardMinutes) : 43_200;
  if (maxMinutesWanted > 43_200) c.warn("cycles", "cycles x limits.hardMinutes exceeds 30 days; the run's total time is capped at 43200 minutes");
  const model = v0.model ?? DEFAULT_MODEL;
  const manager = v0.managerModel ?? DEFAULT_MODEL;
  const gate = v0.gate ?? {};
  const raw = {
    schemaVersion: 1,
    run: v0.run,
    template: "self-improve",
    objective: { title: `Autonomous improvement of ${typeof remote === "string" ? remote.replace(/\.git$/, "").split(/[/:]/).filter(Boolean).pop() : "the repository"}` },
    inputs: { repository: isUrlLike(remote) ? { url: remote, ref } : { path: remote, ref }, references: v0.references ?? {} },
    permissions: { unattended: { authorised: true, autoApprove: true } },
    model: { provider: v0.provider ?? "openrouter", worker: model, manager, review: integration.reviewModel ?? manager, extra: v0.extraModels ?? [] },
    providerSettings: v0.upstream ? { upstream: v0.upstream } : {},
    budget: { totalUsd: budget.totalUsd, perStepUsd: budget.perCycleUsd, maxSteps: cycles, maxMinutes: Math.min(maxMinutesWanted, 43_200) },
    acceptance: { review: integration.review !== false, checks: [{ id: "gate", run: ["/opt/autonomy/gate.sh"], timeoutMinutes: gate.timeoutMinutes ?? 60, required: true }] },
    runtime: { ...(v0.engine ? { engine: v0.engine } : {}), ...(v0.image ? { image: v0.image } : {}), ...(v0.mirrorSeconds ? { mirrorSeconds: v0.mirrorSeconds } : {}), ...(v0.gitIdentity ? { gitIdentity: v0.gitIdentity } : {}), ...(v0.container ?? {}) },
    templateOptions: { integration: { branch: integration.branch, review: integration.review !== false }, perStepHardUsd: perCycleHardUsd, limits, gate: { memory: gate.memory ?? v0.container?.memory ?? "6g", cpus: gate.cpus ?? "4" } },
  };
  if (policy === "push") raw.promotion = { policy: "push", requiresOperatorApproval: false, destinations: [{ kind: "git-remote", url: remote, branch: integration.branch, tags: true }] };
  else if (policy === "local-branch") raw.promotion = { policy: "local-branch", destinations: [{ kind: "local-branch", ...(isUrlLike(remote) ? {} : { repo: remote }), branch: integration.branch }] };
  else raw.promotion = { policy: "none" };
  if (v0.authorisation) raw.authorisation = v0.authorisation;
  return raw;
}

// --- resolution --------------------------------------------------------------------------------

/**
 * Validate and resolve a contract.
 * @param {object} rawInput the parsed JSON
 * @param {{ baseDir?: string, effort?: object, checkFs?: boolean }} [opts]
 */
export function resolveContract(rawInput, opts = {}) {
  const c = collector();
  const effort = effortApi(opts.effort);
  let raw = rawInput;
  let legacy = false;
  if (!isPlainObject(raw)) {
    c.err("", "the contract must be a JSON object");
    return { ok: false, contract: null, problems: c.problems, legacy };
  }
  if (looksLegacy(raw)) { legacy = true; raw = legacyToRaw(raw, c); }
  else if (raw.schemaVersion !== SCHEMA_VERSION) c.err("schemaVersion", `must be ${SCHEMA_VERSION} (got ${JSON.stringify(raw.schemaVersion)}); a config without schemaVersion is read as the deprecated v0 shape only when it has v0 keys (cycles, gitRemote, integration, ...)`);
  checkKeys(raw, "", TOP_LEVEL_KEYS, { strict: true }, c);

  const templateId = raw.template;
  const template = Object.hasOwn(TEMPLATES, templateId) ? TEMPLATES[templateId] : null;
  if (!template) c.err("template", `must be one of ${templateIds().join(", ")} (got ${JSON.stringify(templateId)})`);
  const merged = template ? deepMerge(template.defaults(), stripUndefined(raw)) : stripUndefined(raw);

  const run = str(merged.run, "run", c, { re: RUN_ID, what: "must be 3-41 characters: lowercase letters, digits and - (it names branches and containers)" }) ?? "";
  if (merged.run === undefined || merged.run === null) c.err("run", "is required");
  if (merged.objective === undefined || merged.objective === null) c.err("objective", "is required");
  const objective = readObjective(merged.objective, opts, c);
  const inputs = readInputs(merged.inputs, c, opts);
  const acceptance = readAcceptance(merged.acceptance, c, opts, templateId);
  const permissions = readPermissions(merged.permissions, c, templateId);
  const { model, providerSettings } = readModel(merged.model, merged.providerSettings, c);
  const contract = {
    schemaVersion: SCHEMA_VERSION, run, template: templateId, objective, inputs, acceptance, permissions, model, providerSettings,
    effort: readEffort(merged.effort, c, effort),
    budget: readBudget(merged.budget, c),
    recovery: readRecovery(merged.recovery, c),
    promotion: readPromotion(merged.promotion, c, inputs, run),
    runtime: readRuntime(merged.runtime, c),
    templateOptions: asObject(merged.templateOptions, "templateOptions", c),
    authorisation: readAuthorisation(merged.authorisation, c),
  };

  // Cross-field rules.
  const checkIds = new Set(acceptance.checks.map((k) => k.id));
  for (const [i, item] of objective.backlog.entries()) for (const id of item.acceptance ?? []) if (!checkIds.has(id)) c.err(`objective.backlog[${i}].acceptance`, `unknown check id "${id}"`);
  const serviceNames = new Set(permissions.network.services.map((s) => s.name));
  for (const [i, k] of acceptance.checks.entries()) if (k.type === "service-health" && !serviceNames.has(k.service)) c.err(`acceptance.checks[${i}].service`, `"${k.service}" is not a declared service (permissions.network.services)`);
  if (permissions.network.serviceImages.length && !permissions.network.services.length) c.warn("permissions.network.serviceImages", "images are allowlisted but no service uses them");
  if (template) {
    const api = { err: c.err, warn: c.warn };
    template.validate(contract, api, opts);
  }
  if (contract.promotion.policy === "local-branch" && !inputs.repository?.path && !contract.promotion.destinations.some((d) => d.repo) && template && template.id !== "self-improve") {
    c.err("promotion", 'policy "local-branch" needs a local repository: use inputs.repository.path or set promotion.destinations[].repo');
  }
  if (opts.checkFs) checkFilesystem(contract, c);
  scanSecrets(rawInput, "", c);
  const contractOut = contract;
  const ok = !c.problems.some((p) => p.level === "error");
  return { ok, contract: contractOut, problems: c.problems, legacy };
}

function stripUndefined(v) {
  return JSON.parse(JSON.stringify(v));
}

function checkFilesystem(contract, c) {
  const repo = contract.inputs.repository;
  if (repo?.path) {
    if (!fs.existsSync(repo.path)) c.err("inputs.repository.path", `${repo.path} does not exist`);
    else if (!fs.existsSync(path.join(repo.path, ".git")) && !fs.existsSync(path.join(repo.path, "HEAD"))) c.err("inputs.repository.path", `${repo.path} is not a git repository`);
  }
  for (const [name, src] of Object.entries(contract.inputs.references)) if (!isUrlLike(src) && !fs.existsSync(src)) c.err(`inputs.references.${name}`, `${src} does not exist`);
  for (const [i, ov] of contract.acceptance.overlay.entries()) if (!fs.existsSync(ov.source)) c.err(`acceptance.overlay[${i}].source`, `${ov.source} does not exist`);
  for (const [i, d] of contract.promotion.destinations.entries()) if (d.kind === "local-branch" && d.repo && !fs.existsSync(d.repo)) c.err(`promotion.destinations[${i}].repo`, `${d.repo} does not exist`);
}

/** Digest of the whole resolved contract (run identity), excluding the authorisation record. */
export function contractDigest(contract) {
  const { authorisation: _authorisation, ...rest } = contract;
  return sha256(canonicalJson(rest));
}

/** Errors first, one per line, for CLI and error messages. */
export function formatProblems(problems) {
  const order = { error: 0, warning: 1 };
  return [...problems].sort((a, b) => order[a.level] - order[b.level]).map((p) => `${p.level === "error" ? "error" : "warning"}: ${p.path || "(contract)"}: ${p.message}`).join("\n");
}

/** The copy the worker may read (mounted read-only at /run/contract.json): no credentials, no remotes, no supervisor-only settings. */
export function workerContract(contract) {
  return {
    schemaVersion: contract.schemaVersion,
    sanitised: true,
    run: contract.run,
    template: contract.template,
    objective: contract.objective,
    acceptance: { review: contract.acceptance.review, checks: contract.acceptance.checks.map(({ id, type, required, description, timeoutMinutes, run, cwd }) => ({ id, type, required, description, timeoutMinutes, ...(type === "command" ? { run, cwd } : {}) })) },
    permissions: {
      writeAreas: contract.permissions.writeAreas,
      network: { egress: contract.permissions.network.egress.map(({ host, ports }) => ({ host, ports })), services: contract.permissions.network.services.map(({ name, port, health }) => ({ name, port, healthPath: health.path ?? null })) },
      unattended: contract.permissions.unattended,
    },
    model: { worker: contract.model.worker },
    effort: contract.effort,
    budget: contract.budget,
  };
}

export { PROVIDERS, isProtectedBranch };
