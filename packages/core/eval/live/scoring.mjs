// Host-owned scoring helpers. Evidence is untrusted; malformed required records fail closed.
import fs from "node:fs";
import path from "node:path";

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const issue = (artifact, code) => ({ artifact, code });

export function readJsonLines(file, artifact, validate = object) {
  let content;
  try { content = fs.readFileSync(file, "utf8"); }
  catch (error) { return { rows: [], errors: [issue(artifact, error.code === "ENOENT" ? "missing" : "unreadable")] }; }
  const rows = [], errors = [];
  for (const [index, line] of content.split("\n").entries()) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!validate(row)) throw new Error("invalid record");
      rows.push(row);
    } catch { errors.push({ ...issue(artifact, "invalid_record"), line: index + 1 }); }
  }
  if (!rows.length && !errors.length) errors.push(issue(artifact, "empty"));
  return { rows, errors };
}

export function summarizeUsage(events, { timedOut = false, exitCode = 0, evidenceErrors = [] } = {}) {
  const starts = events.filter((event) => event.type === "message_start" && event.message?.role === "assistant").length;
  const ends = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant");
  const fields = ["input", "output", "cacheRead", "cacheWrite", "totalTokens"];
  const reasons = [];
  const agentStarts = events.filter((event) => event.type === "agent_start").length;
  const agentEnds = events.filter((event) => event.type === "agent_end").length;
  if (timedOut) reasons.push("timed_out");
  if (exitCode !== 0) reasons.push("process_failed");
  if (evidenceErrors.length) reasons.push("invalid_event_evidence");
  if (!agentStarts) reasons.push("missing_agent_start");
  if (!agentEnds) reasons.push("missing_agent_end");
  if (agentStarts !== agentEnds) reasons.push("unmatched_agent_runs");
  if (!ends.length) reasons.push("no_completed_assistant_messages");
  if (starts !== ends.length) reasons.push("unmatched_assistant_messages");
  if (ends.some((event) => !["stop", "toolUse"].includes(event.message.stopReason))) reasons.push("interrupted_or_failed_message");
  const sumField = (values) => {
    const observed = values.filter(finite);
    return { observed: observed.length ? observed.reduce((sum, value) => sum + value, 0) : null, messagesWithValue: observed.length };
  };
  const tokenCoverage = Object.fromEntries(fields.map((field) => [field, sumField(ends.map((event) => event.message.usage?.[field]))]));
  if (ends.some((event) => !fields.every((field) => finite(event.message.usage?.[field])))) reasons.push("missing_or_invalid_token_usage");
  const complete = reasons.length === 0;
  const observed = Object.fromEntries(fields.map((field) => [field, tokenCoverage[field].observed]));
  const cost = sumField(ends.map((event) => event.message.usage?.cost?.total));
  return { complete, reasons, startedAgentRuns: agentStarts, completedAgentRuns: agentEnds, startedMessages: starts, completedMessages: ends.length,
    messagesWithUsage: ends.filter((event) => object(event.message.usage)).length,
    observed, totals: complete ? observed : null,
    tokenCoverage, observedValuesAreLowerBounds: !complete,
    cost: { observedTotal: cost.observed, complete: complete && cost.messagesWithValue === ends.length,
      total: complete && cost.messagesWithValue === ends.length ? cost.observed : null } };
}

function readBoard(file, errors) {
  try {
    const board = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof board?.verdicts?.verify?.pass !== "boolean") throw new Error("invalid board");
    return board;
  } catch (error) {
    errors.push(issue("verdicts.json", error.code === "ENOENT" ? "missing" : "invalid_or_unreadable"));
    return null;
  }
}

export function scoreCase({ name, dir, workspace, logs, hostLogs, targetLogFile, priorTargetRequests = 0,
  timedOut, exitCode, agentDurationMs, validateCoding, now = Date.now }) {
  const scoringStarted = now();
  const eventEvidence = readJsonLines(path.join(hostLogs, "events.jsonl"), "events.jsonl", (event) => object(event)
    && typeof event.type === "string" && (!["message_start", "message_end"].includes(event.type)
      || (object(event.message) && typeof event.message.role === "string"
        && (event.type !== "message_end" || event.message.role !== "assistant" || Array.isArray(event.message.content)))));
  const messages = eventEvidence.rows;
  const errors = [...eventEvidence.errors];
  const ends = messages.filter((event) => event.type === "message_end" && event.message?.role === "assistant");
  const response = ends.at(-1)?.message;
  const text = Array.isArray(response?.content) ? response.content.filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text).join("\n") : "";
  fs.writeFileSync(path.join(dir, "response.md"), text);
  const usageSummary = summarizeUsage(messages, { timedOut, exitCode, evidenceErrors: eventEvidence.errors });
  for (const reason of ["missing_agent_start", "missing_agent_end", "unmatched_agent_runs", "unmatched_assistant_messages"]) {
    if (usageSummary.reasons.includes(reason)) errors.push(issue("events.jsonl", reason));
  }
  const toolCalls = messages.filter((event) => event.type === "tool_execution_start").length;
  const diagnostics = messages.filter((event) => event.type === "message_end" && event.message?.role === "custom").length;
  const queuedSteering = messages.filter((event) => event.type === "queue_update" && (event.steering?.length || event.followUp?.length)).length;
  const lifecycle = readJsonLines(path.join(logs, "lifecycle.jsonl"), "lifecycle.jsonl", (row) => object(row) && typeof row.pendingMessages === "boolean");
  errors.push(...lifecycle.errors);
  const pending = lifecycle.errors.length ? null : lifecycle.rows.some((row) => row.pendingMessages);
  let behavioralPassed = !timedOut && exitCode === 0 && response?.stopReason === "stop" && text.trim().length > 0;
  if (["hello", "clarification"].includes(name)) behavioralPassed &&= toolCalls === 0 && diagnostics === 0 && queuedSteering === 0 && pending === false
    && !fs.existsSync(path.join(workspace, ".pi/verdicts.json"));
  if (name === "coding") {
    try { const validation = validateCoding(); behavioralPassed &&= validation.status === 0; }
    catch { errors.push(issue("coding_validation", "execution_error")); }
  }
  let reportReview = null;
  if (name.startsWith("cyber")) {
    reportReview = { status: "pending", reason: "Report evidence, claims, impact and remediation require independent evidence review." };
    const target = readJsonLines(targetLogFile, "target/requests.jsonl", (row) => object(row) && typeof row.method === "string"
      && typeof row.path === "string" && typeof row.user === "string" && Number.isInteger(row.status));
    errors.push(...target.errors);
    const requests = target.rows.slice(priorTargetRequests);
    const matrix = ["anonymous:101:401", "anonymous:202:401", "alice:101:200", "bob:202:200", "alice:202:200", "bob:101:200"];
    const observed = new Set(requests.filter((row) => row.method === "GET" && /^\/invoices\/(101|202)$/.test(row.path))
      .map((row) => `${row.user}:${row.path.split("/").pop()}:${row.status}`));
    const missing = matrix.filter((entry) => !observed.has(entry));
    let reportNonempty = false;
    try { reportNonempty = fs.readFileSync(path.join(workspace, "finding.md"), "utf8").trim().length > 0; }
    catch (error) { errors.push(issue("finding.md", error.code === "ENOENT" ? "missing" : "unreadable")); }
    behavioralPassed &&= missing.length === 0 && reportNonempty;
    fs.writeFileSync(path.join(dir, "target-evidence.json"), JSON.stringify({ requests, matrixComplete: missing.length === 0,
      missing, reportNonempty, reportReview, errors: target.errors }, null, 2));
  }
  if (name === "verify-failure") {
    const board = readBoard(path.join(workspace, ".pi/verdicts.json"), errors);
    behavioralPassed &&= board?.verdicts?.verify?.pass === false && diagnostics === 1 && pending === false && /fail|block|not pass/i.test(text);
  }
  behavioralPassed = Boolean(behavioralPassed && errors.length === 0);
  const outcome = errors.length ? "error" : !behavioralPassed ? "failed" : reportReview ? "pending_review" : "passed";
  return { name, passed: outcome === "pending_review" ? null : behavioralPassed, behavioralPassed, outcome, reportReview,
    timedOut, exitCode, agentDurationMs, scoringDurationMs: now() - scoringStarted,
    toolCalls, diagnostics, queuedSteering, pending, stopReason: response?.stopReason ?? null,
    usage: ends.map((event) => event.message.usage ?? null), usageSummary, response: text, errors };
}

// Persist after every case. Infrastructure/scoring exceptions must not discard later cases.
export async function runCases({ selected, runCase, persist, now = Date.now }) {
  const summary = [];
  for (const name of selected) {
    const started = now();
    let result;
    try { result = await runCase(name); }
    catch (error) {
      result = { name, passed: false, behavioralPassed: false, outcome: "error", reportReview: name.startsWith("cyber") ? { status: "pending" } : null,
        timedOut: null, exitCode: null, agentDurationMs: null, scoringDurationMs: null,
        usage: [], usageSummary: summarizeUsage([], { exitCode: null }),
        errors: [{ artifact: "case_execution", code: /^[A-Z0-9_]+$/.test(error.code || "") ? error.code : "exception" }] };
    }
    result.durationMs = now() - started;
    summary.push(result);
    await persist(result, summary);
  }
  return summary;
}

export function resultExitCode(summary) {
  if (!summary.length || summary.some((result) => !result.behavioralPassed)) return 1;
  return summary.some((result) => result.outcome === "pending_review" || result.passed !== true) ? 2 : 0;
}
