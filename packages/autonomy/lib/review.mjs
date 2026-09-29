// The merge review: one LLM call when a cycle is otherwise eligible for the integration branch
// (completed, post-cycle gate green). The model did not write the change and sees only what the
// host gives it: the charter, the cycle's report and verification record, the commits and the
// diff. It answers MERGE or REJECT; anything else, or no answer, is a REJECT (fail closed). A
// rejected cycle is not lost: its head keeps the exp/<run>/cycle-NN tag and the next cycle is
// told where to find it.

const clip = (text, max) => {
  const s = String(text ?? "");
  return s.length <= max ? s : `${s.slice(0, max / 2)}\n…[${s.length - max} chars cut]…\n${s.slice(-max / 2)}`;
};

export function reviewSystemPrompt(integrationBranch) {
  return [
    `You review one cycle of an unattended coding agent before it is merged into ${integrationBranch}, the branch every later cycle builds on and that a person later reviews for main.`,
    "The automated gate (tests, security tests, strict docs build, secret scan) already passed. Judge what the gate cannot:",
    "- Each change fixes an evidenced problem or adds clear value, as the charter defines it.",
    "- Changed behaviour has a test that would fail without the change; docs are updated with it.",
    "- No security control, check or test is weakened, skipped or deleted to make things pass.",
    "- The diff is scoped: no unrelated reformatting, churn or generated bulk.",
    "- The report and verification record match the diff (no claimed work that is not there).",
    "Improvement work (making an existing system more capable, faster or more reliable) is valid when the need is evidenced (a measured baseline, a documented limitation, a demonstrable gap) and it is tested and documented. A cycle that reports `Outcome: nothing found` and only records its review is valid too; merge it unless its records are misleading.",
    "Merge sound work even if it is small. Reject when any point above fails, and say which.",
    'Reply with only a JSON object: {"verdict": "MERGE" or "REJECT", "reason": "one to three sentences citing the evidence", "concerns": ["..."]}.',
  ].join("\n");
}

export function buildReviewBundle(b) {
  return [
    `Run ${b.run}, cycle ${b.cycle}: ${b.outcome}. Gate green (${(b.gateSteps ?? []).map((s) => s.name).join(", ") || "all steps"}).`,
    "",
    "## Charter (autonomy/CHARTER.md)",
    clip(b.charter || "(missing)", 8000),
    "",
    "## Cycle report",
    clip(b.report || "(missing)", 6000),
    "",
    "## Verification record",
    clip(b.verify || "(missing)", 6000),
    "",
    "## Commits (git log --stat)",
    clip(b.gitLog || "(none)", 8000),
    "",
    "## Diff",
    clip(b.diff || "(empty)", 60000),
  ].join("\n");
}

/** Parse the reviewer's reply. Throws unless it is a well-formed MERGE or REJECT. */
export function parseReview(text) {
  const s = String(text ?? "").trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  let json;
  try { json = JSON.parse(fenced ? fenced[1] : s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1)); } catch { json = null; }
  if (!json || typeof json !== "object" || Array.isArray(json)) throw new Error("review reply has no JSON object");
  if (json.verdict !== "MERGE" && json.verdict !== "REJECT") throw new Error(`unknown verdict ${JSON.stringify(json.verdict)}`);
  if (typeof json.reason !== "string" || !json.reason.trim()) throw new Error("reason is required");
  const concerns = Array.isArray(json.concerns) ? json.concerns.filter((c) => typeof c === "string").map((c) => c.slice(0, 500)).slice(0, 10) : [];
  return { verdict: json.verdict, reason: json.reason.trim().slice(0, 1000), concerns };
}

/**
 * Review a cycle. `complete(system, user)` returns the reply text (lib/manager.mjs
 * openRouterComplete, or a fake in tests). Upstream stalls happen (a live run saw two 120 s
 * timeouts in a row on a call that normally takes 15 s), so it tries three times with a pause
 * between; then a REJECT that says the review failed.
 */
export async function reviewCycle(bundle, complete, { attempts = 3, pauseMs = 30_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    if (i) await sleep(pauseMs * i);
    try {
      return await complete(reviewSystemPrompt(bundle.integrationBranch), buildReviewBundle(bundle)).then(parseReview);
    } catch (error) { last = error; }
  }
  return { verdict: "REJECT", reason: `review unavailable (${last.message}); not merged`, concerns: [], failed: true };
}
