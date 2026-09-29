#!/usr/bin/env node
// tool-capture: lossless tool I/O capture. Call/result records joined by toolCallId and the
// firewall's action hash, blobs for large values and bytes, binary-safe lines, full-output
// attachments, secrets flagged (or redacted on request), rotation + gzip, concurrent writers,
// budget pruning with a retention log, 0700/0600 permissions, and never throwing into pi.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import zlib from "node:zlib";
import { loadExtension, loadModule, fakePi, setEnv, tmpWorkspace, rmWorkspace, ROOT, isolateKitEnv } from "../packages/core/eval/harness.mjs";

const ws = tmpWorkspace("pi-kit-capture-");
const dir = path.join(ws, "capture");
const restores = [
  isolateKitEnv(),
  setEnv("PI_CODING_AGENT_DIR", path.join(ws, "agent")),
  setEnv("PI_KIT_CAPTURE", undefined),
  setEnv("PI_KIT_CAPTURE_DIR", dir),
  setEnv("PI_KIT_CAPTURE_REDACT", undefined),
  setEnv("PI_KIT_CAPTURE_INLINE_BYTES", "4096"),
  setEnv("PI_KIT_CAPTURE_SEGMENT_BYTES", String(256 * 1024)),
  setEnv("PI_KIT_CAPTURE_MAX_BYTES", String(512 * 1024 ** 2)),
  setEnv("PI_KIT_CAPTURE_MIN_FREE_BYTES", "1"),
  setEnv("PI_KIT_FIREWALL_CONFIG", path.join(ws, "firewall.json")),
  setEnv("PI_KIT_FIREWALL_AUDIT_LOG", path.join(ws, "audit.jsonl")),
  setEnv("PI_KIT_FIREWALL_PROFILE", undefined),
  setEnv("PI_KIT_AUTO_MODE", undefined),
  setEnv("PI_KIT_INTERNAL_CHILD", undefined),
  setEnv("PI_KIT_FIREWALL_ROOT_SESSION", undefined),
];
let checks = 0;
const ok = (label) => {
  checks++;
  console.log(`  OK: ${label}`);
};

const ctxFor = (session) => ({ cwd: ws, hasUI: false, sessionManager: { getSessionId: () => session } });

async function capture() {
  const register = await loadExtension("extensions/tool-capture/index.ts");
  const pi = fakePi();
  register(pi.api, {});
  const h = (name) => pi.handlers.get(name);
  return { pi, h };
}

function readRecords(root = dir) {
  const segs = path.join(root, "segments");
  const out = [];
  for (const n of fs.readdirSync(segs).sort()) {
    if (!/\.jsonl(\.gz)?$/.test(n)) continue;
    let buf = fs.readFileSync(path.join(segs, n));
    if (n.endsWith(".gz")) buf = zlib.gunzipSync(buf);
    for (const line of buf.toString("utf8").split("\n")) if (line) out.push(JSON.parse(line));
  }
  return out;
}

function readBlob(ref, root = dir) {
  assert.ok(ref && typeof ref.$blob === "string", `expected a blob ref, got ${JSON.stringify(ref)?.slice(0, 200)}`);
  const sha = ref.$blob.slice("sha256:".length);
  const bytes = zlib.gunzipSync(fs.readFileSync(path.join(root, "blobs", sha.slice(0, 2), `${sha}.gz`)));
  assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), sha, "blob content matches its name");
  assert.equal(bytes.length, ref.bytes);
  return bytes;
}

try {
  const { h } = await capture();
  const ctx = ctxFor("sess-A");
  await h("session_start")({ type: "session_start", reason: "startup" }, ctx);

  // 1. Call and result, joined; the action hash is the firewall's.
  const args1 = { command: "echo hi && ls", timeout: 5 };
  await h("tool_execution_start")({ toolCallId: "c1", toolName: "bash", args: args1 }, ctx);
  await h("tool_execution_end")({ toolCallId: "c1", toolName: "bash", result: { content: [{ type: "text", text: "hi\n" }], details: {} }, isError: false }, ctx);
  const fw = await loadExtension("extensions/tool-firewall/index.ts");
  const fpi = fakePi();
  fw(fpi.api, {});
  await fpi.handlers.get("tool_call")({ toolName: "bash", input: args1, toolCallId: "c1" }, { cwd: ws, hasUI: false, sessionManager: { getSessionId: () => "sess-A" } });
  const fwHash = fs.readFileSync(path.join(ws, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.actionHash)?.actionHash;
  let recs = readRecords();
  const call1 = recs.find((r) => r.kind === "call" && r.toolCallId === "c1");
  const res1 = recs.find((r) => r.kind === "result" && r.toolCallId === "c1");
  assert.deepEqual(call1.args, args1);
  assert.equal(call1.session, "sess-A");
  const fwRec = fs.readFileSync(path.join(ws, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.actionHash);
  assert.equal(call1.actionHash, fwHash, "same action hash as the firewall audit");
  assert.equal(fwRec.toolCallId, "c1", "firewall audit carries the toolCallId");
  assert.match(call1.argsHash, /^[0-9a-f]{64}$/);
  assert.equal(res1.result.content[0].text, "hi\n");
  assert.equal(res1.isError, false);
  assert.ok(typeof res1.durationMs === "number");
  assert.ok(recs.some((r) => r.kind === "session" && r.event === "start"));
  ok("call + result records joined by toolCallId; actionHash equals the firewall audit's");

  // 2. Large values: stored whole in a blob, byte-exact.
  const big = "line of output ✓ ".repeat(20_000);
  await h("tool_execution_start")({ toolCallId: "c2", toolName: "read", args: { path: "big.txt" } }, ctx);
  await h("tool_execution_end")({ toolCallId: "c2", toolName: "read", result: { content: [{ type: "text", text: big }] }, isError: false }, ctx);
  recs = readRecords();
  const res2 = recs.find((r) => r.kind === "result" && r.toolCallId === "c2");
  assert.equal(readBlob(res2.result.content[0].text).toString("utf8"), big);
  ok("oversized value is a content-addressed blob that round-trips exactly");

  // 3. Binary garbage, NULs, control bytes, lone surrogates; Buffers become byte blobs.
  const garbage = crypto.randomBytes(1500).toString("latin1") + "\u0000\u001b[31m\ud800 tail \udfff";
  const bigGarbage = crypto.randomBytes(20_000).toString("latin1") + "\udfff lone";
  const raw = crypto.randomBytes(10_000);
  await h("tool_execution_start")({ toolCallId: "c3", toolName: "bash", args: { command: "cat /dev/urandom | head -c 3000" } }, ctx);
  await h("tool_execution_end")({ toolCallId: "c3", toolName: "bash", result: { content: [{ type: "text", text: garbage }], details: { raw, big: bigGarbage, n: 10n, when: new Date(0), inf: Infinity } }, isError: false }, ctx);
  recs = readRecords();
  const res3 = recs.find((r) => r.kind === "result" && r.toolCallId === "c3");
  assert.equal(res3.result.content[0].text, garbage, "garbage string round-trips through the JSON line");
  assert.equal(res3.result.details.raw.encoding, "bytes");
  assert.ok(readBlob(res3.result.details.raw).equals(raw));
  assert.equal(res3.result.details.big.encoding, "utf16le");
  assert.equal(readBlob(res3.result.details.big).toString("utf16le"), bigGarbage, "large string with a lone surrogate round-trips");
  assert.deepEqual(res3.result.details.n, { $bigint: "10" });
  assert.deepEqual(res3.result.details.inf, { $number: "Infinity" });
  ok("binary / control / lone-surrogate output and Buffers are captured losslessly");

  // 4. Truncated bash output: pi's full-output file is attached as a blob.
  const fullFile = path.join(ws, "pi-bash-full.log");
  const fullBytes = Buffer.concat([crypto.randomBytes(50_000), Buffer.from("\nend\n")]);
  fs.writeFileSync(fullFile, fullBytes);
  await h("tool_execution_start")({ toolCallId: "c4", toolName: "bash", args: { command: "make" } }, ctx);
  await h("tool_execution_end")({ toolCallId: "c4", toolName: "bash", result: { content: [{ type: "text", text: "…[truncated]" }], details: { truncation: { truncated: true }, fullOutputPath: fullFile } }, isError: false }, ctx);
  // Blocked calls reach tool_execution_end too, as an error result.
  await h("tool_execution_start")({ toolCallId: "c5", toolName: "bash", args: { command: "rm -rf /" } }, ctx);
  await h("tool_execution_end")({ toolCallId: "c5", toolName: "bash", result: { content: [{ type: "text", text: "tool-firewall: denied" }], details: {} }, isError: true }, ctx);
  // 5. Secrets: stored exact, flagged by kind.
  const key = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\n-----END OPENSSH PRIVATE KEY-----";
  await h("tool_execution_start")({ toolCallId: "c6", toolName: "bash", args: { command: "cat ~/.ssh/id_ed25519" } }, ctx);
  await h("tool_execution_end")({ toolCallId: "c6", toolName: "bash", result: { content: [{ type: "text", text: `${key}\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789` }] }, isError: false }, ctx);
  await h("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx);
  recs = readRecords();
  const att = recs.find((r) => r.kind === "attachment" && r.toolCallId === "c4");
  assert.equal(att.role, "full_output");
  assert.ok(readBlob(att.content).equals(fullBytes));
  const res5 = recs.find((r) => r.kind === "result" && r.toolCallId === "c5");
  assert.equal(res5.isError, true);
  assert.ok(recs.some((r) => r.kind === "call" && r.toolCallId === "c5"));
  const res6 = recs.find((r) => r.kind === "result" && r.toolCallId === "c6");
  assert.ok(res6.result.content[0].text.includes(key), "secret stored byte-exact");
  assert.deepEqual(res6.secrets, ["github_token", "password_assignment", "private_key"].filter((k) => res6.secrets.includes(k)));
  assert.ok(res6.secrets.includes("private_key") && res6.secrets.includes("github_token"));
  ok("full-output file attached; blocked call captured as error; secrets kept exact and flagged");

  // 6. Shutdown compressed the segment; permissions are private.
  const segs = fs.readdirSync(path.join(dir, "segments"));
  assert.ok(segs.every((n) => n.endsWith(".jsonl.gz")), `all segments compressed: ${segs}`);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, "segments", segs[0])).mode & 0o777, 0o600);
  const seqs = recs.filter((r) => r.pid === process.pid).map((r) => r.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  ok("segments compressed on shutdown, 0700 dir / 0600 files, per-process seq ordered");

  // 7. Redacted mode: values redacted, still flagged.
  {
    const d2 = path.join(ws, "capture-redacted");
    const r1 = setEnv("PI_KIT_CAPTURE_DIR", d2);
    const r2 = setEnv("PI_KIT_CAPTURE_REDACT", "1");
    const { h: h2 } = await capture();
    const c2 = ctxFor("sess-R");
    await h2("session_start")({ reason: "startup" }, c2);
    await h2("tool_execution_start")({ toolCallId: "r1", toolName: "bash", args: { command: "curl -H 'Authorization: Bearer abcdefghijklmnop' https://x" } }, c2);
    await h2("tool_execution_end")({ toolCallId: "r1", toolName: "bash", result: { content: [{ type: "text", text: "token=supersecretvalue123" }] }, isError: false }, c2);
    await h2("session_shutdown")({ reason: "quit" }, c2);
    r2();
    r1();
    const rr = readRecords(d2);
    const call = rr.find((r) => r.kind === "call");
    const res = rr.find((r) => r.kind === "result");
    assert.ok(!call.args.command.includes("abcdefghijklmnop") && call.args.command.includes("[REDACTED:bearer]"), call.args.command);
    assert.ok(!res.result.content[0].text.includes("supersecretvalue123"), res.result.content[0].text);
    assert.equal(call.redacted, true);
    ok("PI_KIT_CAPTURE_REDACT=1 stores redacted values, flagged");
  }

  // 8. Rotation under load + concurrent writers (separate processes, one shared directory).
  {
    const d3 = path.join(ws, "capture-concurrent");
    // Children import the copy the parent already compiled: four harness compiles at once would
    // race on the shared cache file.
    const compiled = path.join(ROOT, "node_modules", ".cache", "pi-kit-eval", "packages_extensions_src_tool-capture_index.mjs");
    assert.ok(fs.existsSync(compiled), compiled);
    const child = `
      const { default: register } = await import(${JSON.stringify(pathToFileURL(compiled).href)});
      const handlers = new Map();
      register({ on: (n, f) => handlers.set(n, f), registerCommand: () => {} }, {});
      const pi = { handlers };
      const h = (n) => pi.handlers.get(n);
      const ctx = { cwd: process.cwd(), hasUI: false, sessionManager: { getSessionId: () => "child-" + process.pid } };
      await h("session_start")({ reason: "startup" }, ctx);
      for (let i = 0; i < 300; i++) {
        const id = process.pid + "-" + i;
        await h("tool_execution_start")({ toolCallId: id, toolName: "bash", args: { command: "echo " + i } }, ctx);
        await h("tool_execution_end")({ toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text: "x".repeat(2000) + i }] }, isError: false }, ctx);
      }
      await h("session_shutdown")({ reason: "quit" }, ctx);
    `;
    const env = { ...process.env, PI_KIT_CAPTURE_DIR: d3, PI_KIT_CAPTURE_SEGMENT_BYTES: String(64 * 1024) };
    const codes = await Promise.all(
      Array.from({ length: 4 }, () => new Promise((resolve) => {
        const p = spawn(process.execPath, ["--input-type=module", "-e", child], { env, stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        p.stderr.on("data", (d) => (err += d));
        p.on("exit", (code) => {
          if (code) console.error(err);
          resolve(code);
        });
      })),
    );
    assert.deepEqual(codes, [0, 0, 0, 0]);
    const rr = readRecords(d3);
    const byPid = new Map();
    for (const r of rr) if (r.kind === "result") byPid.set(r.pid, (byPid.get(r.pid) ?? 0) + 1);
    assert.equal(byPid.size, 4);
    assert.ok([...byPid.values()].every((n) => n === 300), JSON.stringify([...byPid]));
    const segs3 = fs.readdirSync(path.join(d3, "segments"));
    assert.ok(segs3.length >= 8 && segs3.every((n) => n.endsWith(".gz")), `rotated and compressed: ${segs3.length}`);
    ok(`4 concurrent processes × 600 records: none lost or torn; rotated into ${segs3.length} gzip segments`);
  }

  // 9. Budget pruning: oldest compressed segments / blobs go first, logged; the live segment stays.
  {
    const { CaptureStore } = await loadModule("extensions/tool-capture/store.ts");
    const d4 = path.join(ws, "capture-budget");
    const store = new CaptureStore({ dir: d4, inlineBytes: 1024, segmentBytes: 1024 ** 2, budgetBytes: 200 * 1024, minFreeBytes: 1, maxBlobBytes: 1024 ** 2 });
    store.init();
    const old = Date.now() / 1000 - 86_400;
    for (let i = 0; i < 6; i++) {
      const f = path.join(d4, "segments", `oldhost-1-2026-01-01T00-00-00-000Z-${String(i).padStart(4, "0")}.jsonl.gz`);
      fs.writeFileSync(f, crypto.randomBytes(60 * 1024));
      fs.utimesSync(f, old + i, old + i);
    }
    store.append({ kind: "call", tool: "bash", args: { command: "live" } });
    store.prune();
    const left = fs.readdirSync(path.join(d4, "segments"));
    const total = left.filter((n) => n.endsWith(".gz")).reduce((n, f) => n + fs.statSync(path.join(d4, "segments", f)).size, 0);
    assert.ok(total <= 200 * 1024 * 0.9, `pruned to budget: ${total}`);
    assert.ok(!left.includes("oldhost-1-2026-01-01T00-00-00-000Z-0000.jsonl.gz"), "oldest went first");
    assert.ok(left.includes("oldhost-1-2026-01-01T00-00-00-000Z-0005.jsonl.gz"), "newest kept");
    assert.ok(left.some((n) => n.endsWith(".jsonl")), "live segment untouched");
    const log = fs.readFileSync(path.join(d4, "retention.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(log.length >= 3 && log.every((e) => e.reason === "budget" && e.bytes > 0 && e.deleted));
    await store.close();
    ok(`budget pruning deleted ${log.length} oldest segment(s), each logged in retention.jsonl`);
  }

  // 10. Unusable directory: hooks never throw and never block.
  {
    const blocker = path.join(ws, "not-a-dir");
    fs.writeFileSync(blocker, "x");
    const r1 = setEnv("PI_KIT_CAPTURE_DIR", path.join(blocker, "capture"));
    const { h: h3, pi: pi3 } = await capture();
    const c3 = ctxFor("sess-X");
    const errs = [];
    const write = process.stderr.write;
    process.stderr.write = (m) => (errs.push(String(m)), true);
    try {
      assert.equal(await h3("session_start")({ reason: "startup" }, c3), undefined);
      assert.equal(await h3("tool_execution_start")({ toolCallId: "x", toolName: "bash", args: { command: "ls" } }, c3), undefined);
      assert.equal(await h3("tool_execution_end")({ toolCallId: "x", toolName: "bash", result: { content: [] }, isError: false }, c3), undefined);
      await pi3.commands.get("capture").handler("", { hasUI: false });
    } finally {
      process.stderr.write = write;
      r1();
    }
    assert.equal(errs.filter((m) => m.includes("tool-capture:")).length, 1, "reported once");
    ok("unwritable capture dir: hooks return normally, failure reported once");
  }

  // 11. The capture log is guarded: reading it is a credential read; the agent cannot write it.
  {
    const C = await loadModule("extensions/tool-firewall/classify.ts");
    const home = "/home/op";
    const r1 = setEnv("PI_KIT_CAPTURE_DIR", undefined);
    const r2 = setEnv("PI_CODING_AGENT_DIR", undefined);
    const env = { cwd: "/work/repo", workspace: "/work/repo", home, tmpRoots: ["/tmp"], knownHosts: new Set(), policy: "coding" };
    const a = C.classifyToolCall("bash", { command: `zcat ${home}/.pi/agent/pi-kit/capture/segments/h-1-x-0001.jsonl.gz | grep token` }, env, undefined, "ask");
    assert.ok(a.findings.some((f) => f.effect === "credential_read" && f.tier === "high"), JSON.stringify(a.findings));
    const e = C.classifyToolCall("bash", { command: "PI_KIT_CAPTURE=0 pi -p hi" }, env, undefined, "ask");
    assert.ok(e.findings.some((f) => f.code === "safety_env_override"));
    r2();
    r1();
    const pp = await loadExtension("vendor/protected-paths/index.ts");
    const ppi = fakePi();
    pp(ppi.api, {});
    const res = await ppi.handlers.get("tool_call")({ toolName: "write", input: { path: path.join(dir, "segments", "forged.jsonl"), content: "{}" } }, { cwd: ws, hasUI: false });
    assert.equal(res?.block, true, "protected-paths blocks writes into the capture dir");
    ok("capture dir: firewall treats reads as credential reads, env override flagged, protected-paths blocks writes");
  }

  // 12. track() never leaks an unhandled rejection; a rejected attachment is still drained by flush().
  {
    const { CaptureStore } = await loadModule("extensions/tool-capture/store.ts");
    const d5 = path.join(ws, "capture-track-reject");
    const store = new CaptureStore({ dir: d5, inlineBytes: 1024, segmentBytes: 1024 ** 2, budgetBytes: 200 * 1024, minFreeBytes: 1, maxBlobBytes: 1024 ** 2 });
    store.init();
    let unhandled = 0;
    const onUnhandled = () => { unhandled++; };
    process.on("unhandledRejection", onUnhandled);
    try {
      store.track(Promise.reject(new Error("wu2-boom")));
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(unhandled, 0, "track() must observe the derived rejection");
      assert.equal(store.pendingWork.size, 0, "rejected promise removed from pending work");
      await store.flush();
      assert.equal(store.pendingWork.size, 0, "flush() drains pending work");
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
      await store.close();
    }
    ok("track() of a rejected promise: no unhandledRejection, removed from pending, flush() drains it");
  }

  console.log(`[tool-capture-smoke] OK (${checks} checks)`);
} finally {
  for (const r of restores.reverse()) r();
  rmWorkspace(ws);
}
