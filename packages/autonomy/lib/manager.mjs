// The run manager: one LLM call, made only when the supervisor sees a trigger (lib/triggers.mjs).
// It reads a bounded bundle of the cycle's state and must answer with exactly one decision from a
// fixed list. The supervisor validates the answer, executes it, and the manager is done: it has no
// tools, no memory between calls and no way to act by itself.

export const DECISIONS = {
  CONTINUE: "The cycle is progressing; give it more time (extendMinutes, 10-120).",
  NUDGE: "The agent is drifting or stuck on something specific; send it one steering message (message).",
  RESTART_SESSION: "The session is wedged (looping, context exhausted, crashed); start a fresh session on the same workspace, briefed with message.",
  NEW_CYCLE: "This cycle has done what it can; close it as partial (committed work is kept) and start the next cycle.",
  RESET_TO_LAST_GOOD: "This cycle's work is in a bad state (red and getting worse); keep its head as an abandoned tag and restart the cycle's branch from the integration branch (the last merged state).",
  ABORT_RUN: "Continuing wastes budget or risks harm (repeated failures with no progress across cycles); stop the whole run for a human.",
};

const MAX_MESSAGE = 2000;

/** Parse and validate the manager's reply. Returns a decision or throws with the reason. */
export function parseDecision(text) {
  const json = extractJson(text);
  if (!json) throw new Error("manager reply has no JSON object");
  const { decision, reason } = json;
  if (!Object.hasOwn(DECISIONS, decision)) throw new Error(`unknown decision ${JSON.stringify(decision)}`);
  if (typeof reason !== "string" || !reason.trim()) throw new Error("reason is required");
  const out = { decision, reason: reason.trim().slice(0, 1000) };
  if (decision === "CONTINUE") {
    const m = Number(json.extendMinutes);
    if (!Number.isFinite(m)) throw new Error("CONTINUE needs extendMinutes");
    out.extendMinutes = Math.min(120, Math.max(10, Math.round(m)));
  }
  if (decision === "NUDGE" || decision === "RESTART_SESSION") {
    if (typeof json.message !== "string" || !json.message.trim()) throw new Error(`${decision} needs message`);
    out.message = json.message.trim().slice(0, MAX_MESSAGE);
  }
  return out;
}

function extractJson(text) {
  const s = String(text ?? "").trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1);
  try {
    const v = JSON.parse(candidate);
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

const clip = (text, max) => {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max / 2)}\n…[${s.length - max} chars cut]…\n${s.slice(-max / 2)}`;
};

/** The manager's user prompt: everything it may know about the cycle, bounded in size. */
export function buildBundle(b) {
  return [
    `Run ${b.run}, cycle ${b.cycle} of ${b.cycles}. Trigger(s): ${b.triggers.join(", ")}.`,
    `Elapsed ${Math.round(b.elapsedMinutes)} min (soft ${b.limits.softMinutes}, hard ${b.limits.hardMinutes}); extended ${b.extendedMinutes ?? 0} min so far.`,
    `Cost this cycle $${(b.costUsd ?? 0).toFixed(2)} (review at $${b.budget.perCycleUsd}, hard stop at $${b.budget.perCycleHardUsd ?? 2 * b.budget.perCycleUsd}); run total $${(b.totalCostUsd ?? 0).toFixed(2)} of $${b.budget.totalUsd}.`,
    `Manager calls this cycle before this one: ${b.managerCalls ?? 0}. Previous decisions: ${b.previousDecisions?.length ? b.previousDecisions.map((d) => `${d.decision} (${d.reason})`).join("; ") : "none"}.`,
    `Last session event ${b.idleMinutes != null ? `${Math.round(b.idleMinutes)} min ago` : "unknown"}; last push ${b.sinceCommitMinutes != null ? `${Math.round(b.sinceCommitMinutes)} min ago` : "none this cycle"}.`,
    `Post-cycle gates (latest last): ${b.gates?.length ? b.gates.join(", ") : "none yet"}.`,
    "",
    "## Commits this cycle (git log --stat)",
    clip(b.gitLog || "(none)", 6000),
    "",
    "## Recent session activity (tools, errors, guard notes; oldest first)",
    clip(b.activity || "(none)", 8000),
    "",
    "## Cycle plan",
    clip(b.plan || "(not written yet)", 3000),
    "",
    "## Handoff (autonomy/HANDOFF.md)",
    clip(b.handoff || "(none)", 2000),
  ].join("\n");
}

export function systemPrompt() {
  return [
    "You manage an unattended run in which a coding agent improves a repository in cycles (review, plan, improve, verify).",
    "You are called only when something needs a decision. Choose exactly one decision:",
    ...Object.entries(DECISIONS).map(([k, v]) => `- ${k}: ${v}`),
    "Prefer the least disruptive decision that the evidence supports. Commits and passing gates are progress; repeated identical tool calls, the same error recurring, or long silence are not.",
    'Reply with only a JSON object: {"decision": "...", "reason": "one or two sentences citing the evidence", "extendMinutes": n (CONTINUE only), "message": "..." (NUDGE and RESTART_SESSION only)}.',
    "A NUDGE or RESTART_SESSION message is read by the agent as coming from the operator: be specific and actionable.",
  ].join("\n");
}

/** Call the model. `complete(system, user)` returns the reply text; injected for tests. */
export async function decide(bundle, complete) {
  const text = await complete(systemPrompt(), buildBundle(bundle));
  return parseDecision(text);
}

/** An OpenRouter chat-completions `complete` for the host (the manager runs outside the container). */
export function openRouterComplete({ apiKey, model, upstream, fetchImpl = fetch, timeoutMs = 120_000, onUsage = () => {} }) {
  return async (system, user) => {
    const res = await fetchImpl(`${upstream.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ model, temperature: 0, usage: { include: true }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`manager model HTTP ${res.status}: ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    if (json.usage) onUsage(json.usage); // the manager's spend counts toward the run budget too
    return json.choices?.[0]?.message?.content ?? "";
  };
}
