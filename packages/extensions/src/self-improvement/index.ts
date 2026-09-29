import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

// self-improvement (Epic 6 Sprint 6.2): the /improve cycle — mine -> synthesise -> score ->
// PROPOSE. It never calls a model and never auto-commits: it writes a reviewable proposal
// (a summary + a unified-diff preview of a "Learned notes" addition to AGENTS.md) into
// .pi/self-improvement/. The change is only applied when explicitly armed
// (PI_KIT_SELF_IMPROVE_ARM=1 or `/improve arm`), and even then only appends to an allowlisted
// path — matching the dream-mode safety rule (see docs/roadmap.md "Future Direction").

interface TraceEntry {
  kind?: "call" | "result";
  tool?: string;
  target?: string;
  status?: "ok" | "error";
}

const READ_HINT = /^(read|grep|glob|ls|find|cat|search|rg)/i;
const NOTES_HEADER = "## Learned notes (self-improvement)";

// Bounded tail read (mirrors trace-ledger's /trace window): long-lived workspaces can grow
// .pi/trace.jsonl without limit, so mining must not load the whole file into memory. Read at
// most the last 1MB and drop the partial first line.
const TRACE_TAIL_BYTES = 1024 * 1024;

function readTraceTail(file: string): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - TRACE_TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, bytes).toString("utf8");
    if (start > 0) text = text.slice(text.indexOf("\n") + 1);
    return text;
  } catch {
    return null;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function readTrace(cwd: string): TraceEntry[] {
  const text = readTraceTail(path.join(cwd, ".pi", "trace.jsonl"));
  if (text === null) return [];
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as TraceEntry;
      } catch {
        return null;
      }
    })
    .filter((e): e is TraceEntry => !!e);
}

export interface Proposal {
  hasSignal: boolean;
  notes: string[];
  summary: string;
  diff: string; // unified-diff preview of the AGENTS.md addition
}

function bulletText(line: string): string | null {
  // Tolerate CRLF: on Windows-authored AGENTS.md each split line ends with `\r`, which `$`
  // does not match before and `.` does not consume, so strip it before matching. Only the
  // match sees the normalised line; callers keep the original bytes for output.
  const match = /^\s*-\s+(.*)$/.exec(line.endsWith("\r") ? line.slice(0, -1) : line);
  return match ? match[1].trim() : null;
}

// The added lines are the multiset difference between the merged and current bodies. Using a
// count map (not a set) keeps repeated lines correct while ignoring lines the merge removed.
function addedLines(before: string, after: string): string[] {
  const counts = new Map<string, number>();
  for (const line of before.split("\n")) counts.set(line, (counts.get(line) ?? 0) + 1);
  const added: string[] = [];
  for (const line of after.split("\n")) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else added.push(line);
  }
  return added;
}

// Single shared section model: buildProposal previews exactly the lines applyProposal writes.
// Existing bullets are kept first (stable order), new notes are unioned in and deduped, and a
// no-op returns the body untouched so re-arming cannot duplicate notes.
export function mergeNotes(body: string, notes: string[]): string {
  // Track the file's EOL so every line we emit uses it. Splitting on bare "\n" would leave a
  // trailing "\r" on each untouched CRLF line, so rebuilding the header/bullets with "\n" would
  // produce a mixed-ending file. Normalise input lines with /\r?\n/ and join all output with eol.
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  const headerIndex = lines.findIndex((line) => line.trim() === NOTES_HEADER);

  if (headerIndex === -1) {
    if (notes.length === 0) return body;
    const trimmed = body.replace(/\s+$/, "");
    return `${trimmed}${eol}${NOTES_HEADER}${eol}${notes.map((n) => `- ${n}`).join(eol)}${eol}`;
  }

  // Extent of the existing bullet run: only true bullet lines are consumed, so the first
  // non-bullet line (a blank separator or the next section) and everything after it are kept
  // verbatim by lines.slice(end). This keeps the change purely additive.
  let end = headerIndex + 1;
  const existing: string[] = [];
  while (end < lines.length) {
    const text = bulletText(lines[end]);
    if (text === null) break;
    existing.push(text);
    end += 1;
  }

  const seen = new Set(existing);
  const merged = [...existing];
  for (const note of notes) {
    if (!seen.has(note)) {
      seen.add(note);
      merged.push(note);
    }
  }
  if (merged.length === existing.length) return body;

  const replacement = [NOTES_HEADER, ...merged.map((text) => `- ${text}`)];
  return [...lines.slice(0, headerIndex), ...replacement, ...lines.slice(end)].join(eol);
}

// Deterministically derive improvement notes from recorded inefficiencies.
export function buildProposal(cwd: string): Proposal {
  const entries = readTrace(cwd);
  const calls = entries.filter((e) => e.kind === "call" && e.tool);
  const notes: string[] = [];

  // Repeated reads -> a "read once" note naming the worst offenders.
  const readCounts = new Map<string, number>();
  for (const e of calls) if (e.target && READ_HINT.test(e.tool!)) readCounts.set(e.target, (readCounts.get(e.target) ?? 0) + 1);
  const worstReads = [...readCounts.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 3);
  for (const [target, n] of worstReads) notes.push(`Read \`${target}\` once — it was read ${n}× in a recent session; cache the result instead of re-reading.`);

  // High error rate -> a verify-before-continue note.
  const results = entries.filter((e) => e.kind === "result");
  const errors = results.filter((e) => e.status === "error").length;
  if (results.length >= 5 && errors / results.length >= 0.3) {
    notes.push(`Verify after each change — ${errors}/${results.length} recent tool results errored; run the smallest check before continuing.`);
  }

  const hasSignal = notes.length > 0;
  const summary = hasSignal
    ? `Mined ${calls.length} tool calls; ${notes.length} improvement note(s) proposed.`
    : `Mined ${calls.length} tool calls; nothing actionable — no proposal.`;

  // Unified-diff preview of exactly what applyProposal will write: both share mergeNotes, so
  // the reviewed diff cannot drift from the applied file. No signal (or all notes already
  // present) adds no lines.
  const agents = path.join(cwd, "AGENTS.md");
  let body: string;
  try {
    body = fs.readFileSync(agents, "utf8");
  } catch {
    body = "# AGENTS.md\n";
  }
  const added = addedLines(body, mergeNotes(body, notes));
  const diff = [
    "--- a/AGENTS.md",
    "+++ b/AGENTS.md",
    "@@ append @@",
    ...added.map((l) => `+${l}`),
  ].join("\n");

  return { hasSignal, notes, summary, diff };
}

function isArmed(args: string): boolean {
  return args.trim().toLowerCase() === "arm" || process.env.PI_KIT_SELF_IMPROVE_ARM === "1";
}

// Apply the proposal by merging the notes into the AGENTS.md "Learned notes" section
// (allowlisted path). The write goes through the same mergeNotes model the preview uses.
export function applyProposal(cwd: string, proposal: Proposal): string {
  const agents = path.join(cwd, "AGENTS.md");
  let body = "# AGENTS.md\n";
  try {
    body = fs.readFileSync(agents, "utf8");
  } catch {
    body = "# AGENTS.md\n";
  }
  fs.writeFileSync(agents, mergeNotes(body, proposal.notes), "utf8");
  return agents;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("improve", {
    description: "Self-improvement cycle: mine traces → propose a reviewable diff. `/improve arm` (or PI_KIT_SELF_IMPROVE_ARM=1) applies it to AGENTS.md.",
    handler: async (args, ctx) => {
      const c = ctx as ExtensionContext;
      const cwd = c.cwd ?? process.cwd();
      const proposal = buildProposal(cwd);

      // Always write the reviewable proposal artifact (summary + diff preview).
      const dir = path.join(cwd, ".pi", "self-improvement");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const proposalFile = path.join(dir, `proposal-${stamp}.md`);
      fs.writeFileSync(
        proposalFile,
        [`# Self-improvement proposal`, "", proposal.summary, "", "## Proposed AGENTS.md diff", "", "```diff", proposal.diff, "```", ""].join("\n"),
        "utf8",
      );

      if (!proposal.hasSignal) {
        if (c.hasUI) c.ui.notify(`self-improvement: ${proposal.summary} (see ${path.relative(cwd, proposalFile)})`, "info");
        return;
      }

      if (isArmed(args)) {
        const applied = applyProposal(cwd, proposal);
        if (c.hasUI) c.ui.notify(`self-improvement: ARMED — applied ${proposal.notes.length} note(s) to ${path.relative(cwd, applied)}. Review the diff and commit.`, "warning");
      } else if (c.hasUI) {
        c.ui.notify(`self-improvement: ${proposal.summary} Proposal written to ${path.relative(cwd, proposalFile)} (NOT applied). Run '/improve arm' to apply.`, "info");
      }
    },
  });
}
