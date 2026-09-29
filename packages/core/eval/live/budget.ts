import fs from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  let calls = 0;
  pi.on("tool_call", async (_event, ctx) => {
    if (++calls > 24) { ctx.abort(); return { block: true, reason: "Evaluation tool budget exhausted" }; }
  });
  pi.on("before_agent_start", async (event) => {
    fs.appendFileSync("/logs/context.jsonl", JSON.stringify({ prompt: event.prompt, systemPrompt: event.systemPrompt }) + "\n");
  });
  pi.on("agent_end", async (_event, ctx) => {
    fs.appendFileSync("/logs/lifecycle.jsonl", JSON.stringify({ pendingMessages: ctx.hasPendingMessages(), tools: pi.getActiveTools() }) + "\n");
  });
}
