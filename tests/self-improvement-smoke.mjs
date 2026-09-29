#!/usr/bin/env node
// self-improvement smoke: the reviewable preview must equal the applied AGENTS.md change and
// re-applying must be idempotent. Deterministic and offline — no model, no network.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { isolateKitEnv, loadModule, setEnv, tmpWorkspace, rmWorkspace } from "../packages/core/eval/harness.mjs";

const HEADER = "## Learned notes (self-improvement)";

function seedTrace(ws, reads = 4) {
  fs.mkdirSync(path.join(ws, ".pi"), { recursive: true });
  const lines = [];
  for (let i = 0; i < reads; i++) {
    lines.push(JSON.stringify({ kind: "call", tool: "read", target: "src/app.ts", argsHash: "a" }));
    lines.push(JSON.stringify({ kind: "result", tool: "read", target: "src/app.ts", status: "ok" }));
  }
  fs.writeFileSync(path.join(ws, ".pi", "trace.jsonl"), lines.join("\n") + "\n");
}

function addedLines(before, after) {
  const counts = new Map();
  for (const line of before.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added = [];
  for (const line of after.split("\n")) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else added.push(line);
  }
  return added;
}

function diffPlusLines(diff) {
  return diff
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

// Assert the result has one uniform line ending throughout (no mixed endings).
function assertUniformEol(text, eol, label) {
  if (eol === "\r\n") {
    assert.ok(
      text.split("\r\n").every((line) => !line.includes("\n")),
      `${label}: CRLF result must not contain bare-LF-only lines`,
    );
    assert.equal(
      (text.match(/\n/g) ?? []).length,
      (text.match(/\r\n/g) ?? []).length,
      `${label}: every LF must be part of a CRLF pair`,
    );
    assert.ok(text.endsWith("\r\n"), `${label}: result must end with CRLF`);
  } else {
    assert.equal((text.match(/\r/g) ?? []).length, 0, `${label}: LF result must not contain CR`);
    assert.ok(
      text.split("\n").every((line) => !line.includes("\r")),
      `${label}: LF result must have bare-LF line endings`,
    );
  }
}

async function run() {
  const restoreIsolation = isolateKitEnv();
  const restoreArm = setEnv("PI_KIT_SELF_IMPROVE_ARM", undefined);
  const ws = tmpWorkspace("pi-kit-self-improve-");
  const emptyWs = tmpWorkspace("pi-kit-self-improve-empty-");
  try {
    const mod = await loadModule("extensions/self-improvement/index.ts");
    const agents = path.join(ws, "AGENTS.md");
    fs.writeFileSync(agents, "# AGENTS.md\n");
    seedTrace(ws);

    // (1) The preview's `+` lines are exactly the line delta applyProposal produces.
    const before = fs.readFileSync(agents, "utf8");
    const proposal = mod.buildProposal(ws);
    assert.equal(proposal.hasSignal, true, "repeated reads must yield a signal");
    mod.applyProposal(ws, proposal);
    const after = fs.readFileSync(agents, "utf8");
    assert.deepEqual(
      diffPlusLines(proposal.diff),
      addedLines(before, after),
      "preview `+` lines must equal the applied AGENTS.md line delta",
    );

    // (2) Applying twice in a row is byte-identical (fails on the unfixed code, which appended
    // the bullets under the header again).
    const secondProposal = mod.buildProposal(ws);
    mod.applyProposal(ws, secondProposal);
    assert.equal(fs.readFileSync(agents, "utf8"), after, "re-applying must leave AGENTS.md byte-identical");
    assertUniformEol(after, "\n", "LF apply");

    // (3) Existing bullets are not duplicated when the header already exists.
    const pre = `# AGENTS.md\n\n${HEADER}\n- EXISTING NOTE\n`;
    fs.writeFileSync(agents, pre);
    mod.applyProposal(ws, { hasSignal: true, notes: ["EXISTING NOTE", "BRAND NEW NOTE"], summary: "", diff: "" });
    const merged = fs.readFileSync(agents, "utf8");
    assert.equal((merged.match(/- EXISTING NOTE/g) ?? []).length, 1, "existing bullet must not be duplicated");
    assert.match(merged, /- BRAND NEW NOTE/, "new note must be added");
    assert.ok(
      merged.indexOf("- EXISTING NOTE") < merged.indexOf("- BRAND NEW NOTE"),
      "existing bullets must stay first",
    );

    // (4) No signal produces a diff with no `+` lines.
    const quiet = mod.buildProposal(emptyWs);
    assert.equal(quiet.hasSignal, false, "an empty trace has no signal");
    assert.equal(diffPlusLines(quiet.diff).length, 0, "no signal must produce no added lines");

    // (5) A bullet run followed by a blank separator and another section must keep that
    // separator: consuming only contiguous bullets leaves `\n\n## Next` byte-for-byte intact
    // (the buggy version swallowed the blank line, deleting it from the applied file).
    const sectionFollowed = "# A\n\n" + HEADER + "\n- old\n\n## Next\ntext\n";
    fs.writeFileSync(agents, sectionFollowed);
    mod.applyProposal(ws, { hasSignal: true, notes: ["brand new"], summary: "", diff: "" });
    const sectionTarget = fs.readFileSync(agents, "utf8");
    assert.match(sectionTarget, /\n\n## Next\ntext\n$/, "blank separator before the next section must be preserved");
    mod.applyProposal(ws, { hasSignal: true, notes: ["brand new"], summary: "", diff: "" });
    assert.equal(fs.readFileSync(agents, "utf8"), sectionTarget, "re-applying with a following section must be byte-identical");

    // (6) CRLF AGENTS.md: a bullet already present must be detected despite the trailing `\r`,
    // so applying is a byte-level no-op (fails on the unfixed code, whose regex missed the
    // CRLF bullet and prepended a duplicate).
    const crlfNote = mod.buildProposal(ws).notes[0];
    assert.ok(crlfNote, "the repeated-read trace must yield a note for the CRLF case");
    const crlfPre = `# AGENTS.md\r\n\r\n${HEADER}\r\n- ${crlfNote}\r\n`;
    fs.writeFileSync(agents, crlfPre);
    const crlfBefore = fs.readFileSync(agents, "utf8");
    const crlfProposal = mod.buildProposal(ws);
    assert.equal(
      diffPlusLines(crlfProposal.diff).length,
      0,
      "a note already present in a CRLF section must produce no previewed additions",
    );
    mod.applyProposal(ws, crlfProposal);
    const crlfAfter = fs.readFileSync(agents, "utf8");
    assert.equal(crlfAfter.split(crlfNote).length - 1, 1, "present CRLF note must not be duplicated");
    assert.equal(crlfAfter, crlfBefore, "applying an already-present CRLF note is a byte-level no-op");
    assertUniformEol(crlfAfter, "\r\n", "CRLF no-op");

    // (7) CRLF with a genuinely new note: preview `+` lines still equal the applied line delta,
    // and re-applying is byte-identical.
    fs.writeFileSync(agents, `# AGENTS.md\r\n\r\n${HEADER}\r\n- OTHER NOTE\r\n`);
    const crlfBefore2 = fs.readFileSync(agents, "utf8");
    const crlfProposal2 = mod.buildProposal(ws);
    mod.applyProposal(ws, crlfProposal2);
    const crlfAfter2 = fs.readFileSync(agents, "utf8");
    assert.deepEqual(
      diffPlusLines(crlfProposal2.diff),
      addedLines(crlfBefore2, crlfAfter2),
      "preview `+` lines must equal the applied AGENTS.md line delta on CRLF",
    );
    assert.equal(crlfAfter2.split(crlfNote).length - 1, 1, "new note must be added exactly once on CRLF");
    assertUniformEol(crlfAfter2, "\r\n", "CRLF apply");
    mod.applyProposal(ws, crlfProposal2);
    assert.equal(fs.readFileSync(agents, "utf8"), crlfAfter2, "re-applying on CRLF must be byte-identical");

    // (8) CRLF body with no existing section: the header-insert branch must also emit uniform CRLF
    // for the trimmed prefix, header, bullets and every join.
    const inserted = mod.mergeNotes("# AGENTS.md\r\n\r\nsome text\r\n", ["fresh note"]);
    assertUniformEol(inserted, "\r\n", "CRLF header insert");
    assert.match(inserted, /## Learned notes \(self-improvement\)\r\n- fresh note\r\n$/);

    console.log("[test:smoke self-improvement] OK");
  } finally {
    restoreArm();
    restoreIsolation();
    rmWorkspace(ws);
    rmWorkspace(emptyWs);
  }
}

await run();
