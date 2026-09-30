// The task templates. A template is what turns the generic run engine (lib/engine.mjs) into a
// particular kind of run: it supplies defaults, extra validation, the worker's prompts, how a
// step is judged and what promotion means. The engine owns everything that must not vary:
// the boundary, lifecycle, locks, budgets, recovery, evidence and export.
import selfImprove from "./self-improve.mjs";
import implement from "./implement.mjs";
import deploy from "./deploy.mjs";

export const TEMPLATES = { implement, deploy, "self-improve": selfImprove };

export const templateIds = () => Object.keys(TEMPLATES);

export const describeTemplates = () => Object.values(TEMPLATES).map((t) => t.describe());
