// Shared eval harness helpers. Deterministic and fully offline — extensions are transpiled
// with the TypeScript compiler and driven with a fake pi API. No model, no network.
import fs from "node:fs";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { WORKSPACE_ROOT } from "../lib/paths.mjs";

export const ROOT = WORKSPACE_ROOT;
const CACHE_DIR = path.join(ROOT, "node_modules", ".cache", "pi-kit-eval");

const TS_COMPILER_OPTIONS = {
  module: ts.ModuleKind.ES2022,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
};

const flatName = (relPath) => relPath.replace(/[\\/:]/g, "_").replace(/\.ts$/, ".mjs");

// Transpile a single .ts module into CACHE_DIR, recursing into sibling ".ts" imports.
// Returns the compiled file path. Every module is rewritten on each call (no
// `existsSync` short-circuit): a stale sibling cache previously survived an edit to
// that sibling, so tests could silently run against old code. Sibling output names are
// derived from their repo-relative path (not `path.basename`), so two different
// extensions that each own a same-named sibling (e.g. several `todo-read.ts` copies)
// can no longer overwrite/reuse each other's compiled module.
const compiledThisRun = new Set();
function compileModule(absSource) {
  const relToRoot = path.relative(ROOT, absSource).split(path.sep).join("/");
  const outPath = path.join(CACHE_DIR, flatName(relToRoot));
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (compiledThisRun.has(absSource)) return outPath;
  compiledThisRun.add(absSource);

  const srcDir = path.dirname(absSource);
  let out = ts.transpileModule(fs.readFileSync(absSource, "utf8"), { compilerOptions: TS_COMPILER_OPTIONS }).outputText;

  // Sibling .ts modules imported with an explicit ".ts" specifier (e.g. vendor/subagent/
  // index.ts's `from "./agents.ts"`) must also be transpiled, not merely copied: Node
  // refuses native type-stripping for anything under node_modules (CACHE_DIR lives under
  // node_modules/.cache), so an un-transpiled .ts sibling would fail to load there even
  // though it loads fine from the real source tree. Rewrite the specifier to the
  // compiled sibling's flat filename and transpile it into CACHE_DIR too.
  out = out.replace(/from\s+(["'])(\.[^"']*)\.ts\1/g, (match, quote, specifier) => {
    const siblingSource = path.resolve(srcDir, `${specifier}.ts`);
    if (!fs.existsSync(siblingSource)) return match;
    compileModule(siblingSource);
    const siblingRel = path.relative(ROOT, siblingSource).split(path.sep).join("/");
    return `from ${quote}./${flatName(siblingRel)}${quote}`;
  });

  // Resolve import.meta.url to the *source* file, not the cache copy: extensions locate kit
  // resources relative to themselves (e.g. subagent -> packages/kit/agents), which only exist
  // relative to the real tree. Sibling assets are still copied below for older call sites.
  out = out.replace(/\bimport\.meta\.url\b/g, JSON.stringify(pathToFileURL(absSource).href));

  fs.writeFileSync(outPath, out);
  return outPath;
}

function compile(relativePath) {
  // Logical paths used by tests/profile-check ("extensions/<name>/...", "vendor/<name>/...")
  // map onto the monorepo's package layout; real relative paths pass through.
  const normalized = relativePath.startsWith("extensions/")
    ? `packages/extensions/src/${relativePath.slice("extensions/".length)}`
    : relativePath.startsWith("vendor/")
      ? `packages/extensions/third_party/${relativePath.slice("vendor/".length)}`
      : relativePath;
  const sourcePath = path.join(ROOT, normalized);
  const outPath = compileModule(sourcePath);
  const srcDir = path.dirname(sourcePath);
  // Copy sibling assets so relative filesystem access based on import.meta.url resolves
  // from CACHE_DIR the same way it does from the real source directory: non-.ts files
  // (e.g. tool-firewall/default-policy.json), and sibling data DIRECTORIES (e.g.
  // orchestrator/agents/*.md, static templates read via fs.readdirSync at runtime, not
  // imported as modules).
  for (const f of fs.readdirSync(srcDir)) {
    const srcPath = path.join(srcDir, f);
    if (f.endsWith(".json") && f !== "extension.json") {
      fs.copyFileSync(srcPath, path.join(CACHE_DIR, f));
    } else if (fs.statSync(srcPath).isDirectory()) {
      fs.cpSync(srcPath, path.join(CACHE_DIR, f), { recursive: true });
    }
  }
  return outPath;
}

// Returns the full module (default + named exports).
export async function loadModule(relativePath) {
  const compiled = compile(relativePath);
  return import(`${pathToFileURL(compiled).href}?v=${Date.now()}-${Math.random()}`);
}

export async function loadExtension(relativePath) {
  return (await loadModule(relativePath)).default;
}

export function fakePi(options = {}) {
  const handlers = new Map();
  const tools = new Map();
  const commands = new Map();
  const steers = [];
  const flags = new Map();
  const modelSelections = [];
  return {
    api: {
      on: (name, handler) => handlers.set(name, handler),
      registerTool: (tool) => tools.set(tool.name, tool),
      registerCommand: (name, cmd) => commands.set(name, cmd),
      getCommands: () => [...commands.keys()].map((name) => ({ name })),
      getActiveTools: () => ["read", "bash", "write", "edit", "subagent"],
      registerFlag: (name, opts) => flags.set(name, opts?.default),
      getFlag: (name) => flags.get(name),
      sendUserMessage: async (message, opts) => steers.push({ message, opts }),
      sendMessage: (message, opts) => steers.push({ message, opts }),
      exec: (command, args, execOptions = {}) => new Promise((resolve) => {
        execFile(command, args, {
          cwd: execOptions.cwd ?? options.cwd ?? process.cwd(),
          shell: false,
          windowsHide: true,
        }, (error, stdout, stderr) => resolve({
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? ""),
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        }));
      }),
      // Matches the real pi.setModel(model): Promise<boolean> contract - returns false
      // if no auth is configured. Tests can inject a `_setModelResult: false` on a fake
      // model to simulate that path.
      setModel: async (model) => {
        modelSelections.push(model);
        return model?._setModelResult !== false;
      },
    },
    handlers,
    flags,
    tools,
    commands,
    steers,
    modelSelections,
  };
}

// A minimal ctx.modelRegistry stand-in (find/getAll only - the documented public
// surface extensions are expected to use). `models` is an array of
// { provider, id, ...extra }.
export function fakeModelRegistry(models) {
  return {
    find: (provider, id) => models.find((m) => m.provider === provider && m.id === id),
    getAll: () => models,
  };
}

export function setEnv(name, value) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  };
}

// Ambient kit configuration must not leak into a test: the autonomy runtime and a developer's
// shell set PI_KIT_AUTO_MODE, PI_KIT_FIREWALL_POLICY, PI_CODING_AGENT_DIR and friends, all of
// which change firewall decisions and state paths. Tests call isolateKitEnv() before loading the
// extension under test, then setEnv() only what that test needs. The returned closure restores
// exactly the variables that were present. Matching by prefix (not a fixed list) so new kit
// variables are covered automatically.
export function isolateKitEnv() {
  const saved = new Map();
  for (const key of Object.keys(process.env)) {
    if (key === "PI_CODING_AGENT_DIR" || key.startsWith("PI_KIT_")) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  }
  return () => {
    for (const [key, value] of saved) process.env[key] = value;
  };
}

export function tmpWorkspace(prefix = "pi-kit-eval-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmWorkspace(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

export function assert(cond, message) {
  if (!cond) throw new Error(message || "assertion failed");
}
