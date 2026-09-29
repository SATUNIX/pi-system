// No inference or live Pi session. Executes the kit extension and the pinned
// runtime's actual footer method against a synthetic component container.
// Node >= 24. Override runtime with --runtime <pi-coding-agent package directory>.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { stripTypeScriptTypes } from "node:module";
import { fileURLToPath } from "node:url";

const reviewDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(reviewDir, "../..");
const runtimeFlag = process.argv.indexOf("--runtime");
if (runtimeFlag >= 0 && !process.argv[runtimeFlag + 1]) throw new Error("--runtime requires a package directory");
const runtimeDir = path.resolve(runtimeFlag >= 0
  ? process.argv[runtimeFlag + 1]
  : path.join(root, "node_modules/@earendil-works/pi-coding-agent"));
const sourcePath = path.join(root, "vendor/custom-footer/index.ts");
const runtimePath = path.join(runtimeDir, "dist/modes/interactive/interactive-mode.js");
const source = fs.readFileSync(sourcePath, "utf8");
const runtime = fs.readFileSync(runtimePath, "utf8");
const runtimePackage = JSON.parse(fs.readFileSync(path.join(runtimeDir, "package.json"), "utf8"));
const method = runtime.match(/    setExtensionFooter\(factory\) \{([\s\S]*?)\n    \}\n    \/\*\*/);
assert.ok(method, "Expected runtime footer method must be located; do not substitute a hand-written implementation");
const setExtensionFooter = new Function("factory", "theme", method[1]);
const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");

const temporaryRoot = path.resolve(os.tmpdir());
const workspace = fs.mkdtempSync(path.join(temporaryRoot, "pi-footer-contract-"));
assert.ok(path.resolve(workspace).startsWith(temporaryRoot + path.sep), "Temporary workspace must remain inside temp root");
try {
  // Supply pricing before the extension can consult the operator's home config.
  fs.mkdirSync(path.join(workspace, ".pi-kit"));
  fs.writeFileSync(path.join(workspace, ".pi-kit/costs.json"), JSON.stringify({ input: 1, output: 2, cacheRead: 1, cacheWrite: 1 }));
  for (const key of ["INPUT", "OUTPUT", "CACHE_READ", "CACHE_WRITE"]) delete process.env[`PI_KIT_COST_${key}_PER_MTOK`];
  const { default: register } = await import("data:text/javascript;base64," + Buffer.from(stripTypeScriptTypes(source)).toString("base64"));
  const handlers = new Map();
  register({ on: (name, handler) => handlers.set(name, handler), registerCommand() {} });
  const footer = {};
  const children = new Set([footer]);
  const statuses = [];
  const mode = {
    footer,
    customFooter: undefined,
    footerDataProvider: {},
    ui: {
      removeChild(component) { children.delete(component); },
      addChild(component) { children.add(component); },
      requestRender() {},
    },
  };
  const ctx = {
    cwd: workspace,
    hasUI: true,
    model: { id: "synthetic-model" },
    getContextUsage: () => ({ tokens: 42, percent: 1 }),
    ui: {
      setFooter(factory) { setExtensionFooter.call(mode, factory, {}); },
      setStatus(key, value) { statuses.push({ key, value }); },
      notify() {},
    },
  };
  const usage = { input: 1000, output: 500, cacheRead: 200, cacheWrite: 0, totalTokens: 1700, cost: { total: 0.0022 } };
  await handlers.get("session_start")({ type: "session_start" }, ctx);
  await handlers.get("turn_end")({ type: "turn_end", turnIndex: 0, message: { role: "assistant", usage }, toolResults: [] }, ctx);
  const observed = {
    builtinFooterAttached: children.has(footer),
    attachedComponentCount: children.size,
    lastStatus: statuses.at(-1)?.value,
  };
  const findings = {
    OI_01_reproduced: !observed.builtinFooterAttached && observed.attachedComponentCount === 0,
    OI_02_reproduced: /input 0 \| output 0 \| total 42 \| est \$0\.00/.test(observed.lastStatus ?? ""),
  };
  const result = {
    generatedAt: new Date().toISOString(),
    sourceBaseline: "6460ef6392dc290038f5ad79835861f9e5e06134",
    nodeVersion: process.version,
    runtimeVersion: runtimePackage.version,
    runtimeDirectory: runtimeDir,
    sourceSha256: hash(source),
    runtimeFileSha256: hash(runtime),
    runtimeMethodSha256: hash(method[1]),
    methodology: "Actual extension loaded with Node type stripping; actual runtime setExtensionFooter method executed with synthetic UI. No inference, real terminal rendering, live session, transcript or network access.",
    syntheticInput: { usage, contextTokens: 42 },
    expectedHealthyBehavior: { builtinFooterAttached: true, attachedComponentCount: 1, input: 1000, output: 500, cumulativeTokens: 1700 },
    observed,
    findings,
    limitations: ["Checks the runtime method contract, not full TUI rendering or web integration", "Does not establish bytes loaded by earlier Pi processes", "Findings true indicate reproduced defects, not release acceptance"],
  };
  fs.writeFileSync(path.join(reviewDir, "footer-contract-result.json"), JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ observed, findings }));
  assert.ok(findings.OI_01_reproduced, "Baseline footer detachment counterexample no longer reproduces");
  assert.ok(findings.OI_02_reproduced, "Baseline usage counterexample no longer reproduces");
} finally {
  // Path was resolved and checked against the temporary root before any writes.
  fs.rmSync(workspace, { recursive: true, force: true });
}
