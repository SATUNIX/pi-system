import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// H-04 fix: checkpoints were cleared unconditionally on every `agent_end`, which fires
// at the end of EVERY turn - including the very last turn before a user issues /fork.
// /fork is a separate lifecycle branch (session_before_fork -> session_shutdown ->
// session_start, per the Lifecycle Overview in
// node_modules/@earendil-works/pi-coding-agent/docs/extensions.md) that does not itself
// run through turn_start/agent_end first, so by the time session_before_fork looked a
// ref up, agent_end had already wiped it - the advertised prior-point restoration never
// had a real ref to restore. Independent repro confirmed: simulated
// tool_result -> turn_start -> agent_end -> session_before_fork produced only
// `git stash create`, never `git stash apply`.
//
// Fix: stop clearing on agent_end. Reset only at session_start (a fresh session should
// not see a prior session's checkpoints), and bound the map so a long session's
// checkpoints don't grow unboundedly (oldest evicted past the cap).
function intEnv(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

const MAX_CHECKPOINTS = intEnv("PI_KIT_CHECKPOINT_MAX", 20);

export default function (pi: ExtensionAPI) {
  const checkpoints = new Map<string, string>();
  let currentEntryId: string | undefined;

  pi.on("session_start", async () => {
    checkpoints.clear();
    currentEntryId = undefined;
  });

  pi.on("tool_result", async (_event, ctx) => {
    const leaf = ctx.sessionManager.getLeafEntry();
    if (leaf) currentEntryId = leaf.id;
  });

  pi.on("turn_start", async () => {
    const { stdout } = await pi.exec("git", ["stash", "create"]);
    const ref = stdout.trim();
    if (ref && currentEntryId) {
      checkpoints.set(currentEntryId, ref);
      if (checkpoints.size > MAX_CHECKPOINTS) {
        const oldestKey = checkpoints.keys().next().value;
        if (oldestKey !== undefined) checkpoints.delete(oldestKey);
      }
    }
  });

  pi.on("session_before_fork", async (event, ctx) => {
    const ref = checkpoints.get(event.entryId);
    if (!ref) return;
    if (!ctx.hasUI) return;

    const choice = await ctx.ui.select("Restore code state?", [
      "Yes, restore code to that point",
      "No, keep current code",
    ]);

    if (choice?.startsWith("Yes")) {
      await pi.exec("git", ["stash", "apply", ref]);
      ctx.ui.notify("Code restored to checkpoint", "info");
    }
  });
}
