import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Self-containment rule: import only node:* builtins and typebox peer.
// No sibling imports. No toolchain-lib imports. See CONTRIBUTING.md.

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (_event, _ctx) => {
    // Implement your tool_call hook here.
    // Return undefined to allow the call, return { block: true, reason: "..." } to deny.
  });
}
