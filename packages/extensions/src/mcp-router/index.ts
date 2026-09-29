import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    ctx.ui?.notify?.("mcp-router: loaded (stub)", "info");
  });

  pi.on("tool_call", async () => {
    return undefined;
  });
}
