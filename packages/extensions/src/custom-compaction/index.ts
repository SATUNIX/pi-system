import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (!process.env.PI_KIT_COMPACT_TEMPLATE) return;
    const message = "custom-compaction: template injection is unsupported by this Pi compaction API. Using native summarization; pass instructions with /compact <instructions>.";
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else console.warn(message);
  });

  // A complete replacement summary is supported, but a truncated transcript plus
  // template is not a valid summary. Preserve Pi's full prepared input and its
  // operator-provided customInstructions instead of silently losing later state.
  pi.on("session_before_compact", async () => undefined);
}
