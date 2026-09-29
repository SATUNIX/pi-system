import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

function handoffFilePath(cwd: string): string {
  return process.env.PI_KIT_HANDOFF_FILE ?? path.join(cwd, "HANDOFF.md");
}

function appendHandoff(filePath: string, note: string): void {
  const timestamp = new Date().toISOString();
  const entry = `\n## ${timestamp}\n\n${note.trim()}\n`;
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# Handoff Notes\n${entry}`);
  } else {
    fs.appendFileSync(filePath, entry);
  }
}

export default function (pi: ExtensionAPI) {
  // The automatic note ("Session ended. Recent tools: bash, read.") carries no resumable
  // information, yet it created/appended HANDOFF.md in every directory pi was ever started
  // in. It is now opt-in (PI_KIT_HANDOFF_AUTO=1); /handoff <note> is the deliberate path, and
  // the memory vault's per-turn recaps cover automatic continuity.
  pi.on("session_shutdown", async (_event, ctx) => {
    if (process.env.PI_KIT_INTERNAL_CHILD === "1") return;
    if (process.env.PI_KIT_HANDOFF_AUTO !== "1") return;
    const entries = ctx.sessionManager.getEntries();
    // Collect last few tool results as a brief summary
    const recentTools: string[] = [];
    for (let i = entries.length - 1; i >= 0 && recentTools.length < 5; i--) {
      const e = entries[i];
      if (e.type === "message" && e.message.role === "toolResult") {
        const msg = e.message as { toolName?: string };
        if (msg.toolName) recentTools.unshift(msg.toolName);
      }
    }

    const note = recentTools.length > 0
      ? `Session ended. Recent tools: ${recentTools.join(", ")}.`
      : "Session ended.";

    const filePath = handoffFilePath(ctx.cwd);
    appendHandoff(filePath, note);
    if (ctx.hasUI) ctx.ui.notify(`Handoff note written to ${path.basename(filePath)}`, "info");
  });

  pi.registerCommand("handoff", {
    description: "Write a handoff note to HANDOFF.md. Usage: /handoff <note>",
    handler: async (args, ctx) => {
      const note = args.trim();
      if (!note) {
        ctx.ui.notify("Usage: /handoff <note>", "warning");
        return;
      }
      const filePath = handoffFilePath(ctx.cwd);
      appendHandoff(filePath, note);
      ctx.ui.notify(`Handoff note written to ${path.basename(filePath)}`, "info");
    },
  });
}
