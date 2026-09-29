// Independent offline review of verifier implementation commit 441edc7.
// Run from any directory with this worktree's installed development dependencies.
// This demonstrates a documented, deferred reversed-order risk. It does not
// reproduce a regression in the currently verified default/focused load order.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadExtension, fakePi, tmpWorkspace, rmWorkspace, setEnv } from "../../../../../kit/eval/harness.mjs";

const restoreAuto = setEnv("PI_KIT_VERIFY_ON_TURN", "1");
const restoreOrch = setEnv("PI_KIT_ORCH_DISABLE", undefined);
const restoreCmd = setEnv("PI_KIT_VERIFY_CMD", undefined);
try {
  console.log("Independent offline review: prior PASS, successful edit, failing project verification.");
  console.log("Reversed extension order is a validated-but-deferred risk, not a default-profile regression.");
  for (const order of [["orchestrator", "verify-gate"], ["verify-gate", "orchestrator"]]) {
    const ws = tmpWorkspace("pi-review-order-");
    const pi = fakePi();
    const handlers = new Map();
    // Unlike fakePi's single-handler map, preserve both extensions' handlers in
    // registration order, matching SDK ExtensionRunner.emit's awaited sequence.
    pi.api.on = (name, handler) => {
      const list = handlers.get(name) || [];
      list.push(handler);
      handlers.set(name, list);
    };
    const ctx = { cwd: ws, ui: { notify() {}, setStatus() {} } };
    const emit = async (name, event) => {
      for (const handler of handlers.get(name) || []) await handler(event, ctx);
    };
    try {
      fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ scripts: { verify: 'node -e "process.exit(1)"' } }));
      fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
      fs.writeFileSync(path.join(ws, ".pi/verdicts.json"), JSON.stringify({
        verdicts: { verify: { pass: true, summary: "previous successful check", at: new Date().toISOString() } },
      }));
      for (const name of order) (await loadExtension(`extensions/${name}/index.ts`))(pi.api);
      await emit("session_start", {});
      await emit("input", { source: "rpc", text: "Fix a small function" });
      await emit("tool_result", { toolName: "edit", isError: false });
      await emit("turn_end", { message: { role: "assistant", stopReason: "stop" } });
      const finalPass = JSON.parse(fs.readFileSync(path.join(ws, ".pi/verdicts.json"), "utf8")).verdicts.verify.pass;
      const diagnostics = pi.steers.length;
      console.log(JSON.stringify({ order, finalPass, diagnostics }));
      assert.equal(finalPass, false);
      assert.equal(diagnostics, order[0] === "verify-gate" ? 1 : 0);
    } finally {
      const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(ws));
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || !path.basename(ws).startsWith("pi-review-order-")) {
        throw new Error("Refusing cleanup outside this review's disposable temporary workspace");
      }
      rmWorkspace(ws);
    }
  }
} finally {
  restoreAuto();
  restoreOrch();
  restoreCmd();
}
