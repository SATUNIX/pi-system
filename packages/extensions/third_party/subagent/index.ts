/**
 * Subagent — delegate tasks to specialized role agents in isolated context windows.
 *
 * Modes:
 *   - single:   { agent, task }
 *   - parallel: { tasks: [{ agent, task }, ...] }   (concurrency-limited)
 *   - chain:    { chain: [{ agent, task }, ...] }    ({previous} threads prior output)
 *
 * Each subagent is a separate `pi --mode json -p --no-session` process with its own context
 * window, a selectable parent-model or per-agent-model policy (--model), and tool
 * restriction (--tools). Roles are discovered from ~/.pi/agent/agents/*.md and
 * .pi/agents/*.md (see ./agents.ts).
 *
 * Module layout:
 *   config.ts         tunables + environment parsing
 *   logging.ts        per-run logs + run registry (`subagent_status`)
 *   result.ts         reading a finished child's result
 *   child-process.ts  child spawn/stream/budget lifecycle
 *   runner.ts         runAgent / runSingleAgent
 *   tools.ts          `subagent` + `subagent_status` registration
 *
 * This is a kit extension (a pi-package resource), NOT a modification of pi core. It is
 * adapted from pi's bundled `examples/extensions/subagent` reference, with the TUI rendering
 * removed and message types localised so it depends only on pi's public API (ExtensionAPI) +
 * typebox + Node built-ins.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubagentTools } from "./tools.ts";
import { registerWorkflowTools } from "./workflow-tools.ts";

// Kept as the public entry point for existing callers and the eval harness.
export { runAgent, runSingleAgent, projectRoleDigest } from "./runner.ts";
export { getResultOutput, isFailedResult } from "./result.ts";

export { executeWorkflow, parseWorkflow, discoverWorkflows, renderTemplate, newRunState, resolveInputs, loadState } from "./workflow.ts";

export default function (pi: ExtensionAPI) {
  registerSubagentTools(pi);
  registerWorkflowTools(pi);
}
