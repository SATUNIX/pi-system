// Template `implement`: a FINITE task. A specification, a backlog and acceptance checks go in;
// steps continue until every required acceptance check passes (judged by the trusted
// supervisor in a clean, network-less gate container from definitions held in the run
// directory), then an independent review if acceptance.review is set, then the run succeeds.
import { FINITE_DEFAULTS, backlogLines, checkLines, resultLines, untrusted, zoneRules, clip } from "./common.mjs";

const describe = () => ({
  id: "implement",
  title: "Implement a task",
  summary: "Build or change something to a specification, until the acceptance checks pass and an independent review approves it. Finite: it ends when the criteria are met, or a limit is reached.",
  finite: true,
  requires: ["objective.title", "objective.spec or objective.specFile", "acceptance.checks (at least one required check)"],
  optional: ["inputs.repository (start from an existing repository; otherwise from an empty one)", "objective.backlog", "permissions.network.egress (dependency downloads through the proxy)", "promotion"],
});

export const IMPLEMENT_STEP_INTRO = "You are working on a bounded task for an operator who is not watching. Work until every acceptance check passes.";

function validate(contract, { err }) {
  if (!contract.objective.spec.trim()) err("objective.spec", "is required for a finite task: give the specification inline (spec) or as a file (specFile)");
  if (!contract.acceptance.checks.some((k) => k.required)) err("acceptance.checks", "needs at least one required check: a finite run ends when its acceptance criteria pass, so it needs something to pass");
  if (!contract.objective.backlog.length) {
    // A run without backlog items is fine: the acceptance checks are the task board.
  }
}

function stepPrompt({ contract, state, step, briefing, evaluation, feedback }) {
  const lines = [];
  if (step === 1 && !briefing && !evaluation) {
    lines.push(`${IMPLEMENT_STEP_INTRO}`, "", `# Task: ${contract.objective.title}`, "", clip(contract.objective.spec, 30_000), "");
    if (contract.objective.backlog.length) lines.push("## Backlog", ...backlogLines(contract, state?.tasks), "");
    lines.push("## Acceptance (judged by the supervisor, not by you)", ...checkLines(contract), "");
    if (contract.acceptance.review) lines.push("When the checks pass, an independent reviewer compares your change with the original specification. Tests you write are welcome but they are not the criteria: the reviewer and the supervisor's checks are.", "");
    lines.push("## Ground rules", ...zoneRules(contract), "- Commit after each logical change and run `git push origin HEAD`; the supervisor also snapshots your workspace when you stop.", "- Read /run/contract.json for the machine-readable version of this task.");
    return lines.join("\n");
  }
  if (briefing) lines.push(briefing, "");
  if (evaluation) {
    lines.push("## Verified state (from the supervisor's checks)", ...resultLines(evaluation.results), "");
    for (const r of evaluation.results.filter((x) => !x.pass && x.tail)) lines.push(untrusted(`check ${r.id} output`, r.tail, 1500), "");
  }
  if (feedback?.length) lines.push("## Notes from the supervisor", ...feedback.map((f) => `- ${f}`), "");
  if (state?.tasks?.length) lines.push("## Task board (supervisor's)", ...backlogLines(contract, state.tasks), "");
  lines.push("Continue the task. Fix what the failing checks show, keep changes scoped, commit and push. Stop when you believe every acceptance check passes.");
  return lines.join("\n");
}

export default {
  id: "implement",
  describe,
  defaults: FINITE_DEFAULTS,
  validate,
  stepPrompt,
  finite: true,
};
