// pi RPC helpers (node_modules/@earendil-works/pi-coding-agent/docs/rpc.md). The supervisor talks
// JSON lines to `pi --mode rpc` over the container's stdin/stdout, so the agent needs no network
// for control. Every dialog an extension opens is answered here as an attentive operator would:
// approve, allow for the session, or "proceed with your best judgement". The agent is not told
// that the operator is automated.

export const OPERATOR_ANSWER =
  "Approved. Proceed with your best judgement within the cycle charter (autonomy/CHARTER.md); you do not need to check with me again for this task.";

const ALLOW_SESSION = /\ballow\b.*\bsession\b/i;
const AFFIRM = /^(allow|yes|approve|approved|continue|proceed|ok|accept|run|confirm)\b/i;
const NEGATIVE = /\b(deny|block|reject|cancel|no|stop|abort)\b/i;

/** The response for one extension_ui_request, or null for fire-and-forget methods. */
export function uiResponse(req) {
  const id = req.id;
  switch (req.method) {
    case "confirm":
      return { type: "extension_ui_response", id, confirmed: true };
    case "select": {
      const options = Array.isArray(req.options) ? req.options.map(String) : [];
      const pick = options.find((o) => ALLOW_SESSION.test(o))
        ?? options.find((o) => AFFIRM.test(o.trim()) && !NEGATIVE.test(o))
        ?? options.find((o) => !NEGATIVE.test(o))
        ?? options[0];
      return pick === undefined ? { type: "extension_ui_response", id, cancelled: true } : { type: "extension_ui_response", id, value: pick };
    }
    case "input":
      return { type: "extension_ui_response", id, value: OPERATOR_ANSWER };
    case "editor":
      return { type: "extension_ui_response", id, value: typeof req.prefill === "string" && req.prefill.trim() ? req.prefill : OPERATOR_ANSWER };
    default:
      return null; // notify, setStatus, setWidget, setTitle, set_editor_text: nothing to answer
  }
}

/** Split a stream of chunks into complete JSON lines; malformed lines are reported, not thrown. */
export function lineParser(onMessage, onBad = () => {}) {
  let buf = "";
  return (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        onMessage(JSON.parse(line));
      } catch {
        onBad(line);
      }
    }
  };
}

/** Short, human-readable activity lines for the manager bundle (lib/manager.mjs). */
export function activityLine(ev) {
  const t = new Date(ev.at ?? Date.now()).toISOString().slice(11, 19);
  switch (ev.type) {
    case "tool_execution_start":
      return `${t} tool ${ev.toolName ?? ev.tool ?? "?"} ${clipArgs(ev.args)}`;
    case "tool_execution_end":
      return ev.isError ? `${t} tool ${ev.toolName ?? "?"} ERROR ${clipArgs(ev.result)}` : null;
    case "extension_ui_request":
      return ev.method === "notify" ? `${t} notice(${ev.notifyType ?? "info"}) ${String(ev.message ?? "").slice(0, 200)}` : null;
    case "extension_error":
      return `${t} extension error ${String(ev.error ?? ev.message ?? "").slice(0, 200)}`;
    case "auto_retry_start":
      return `${t} provider retry: ${String(ev.errorMessage ?? "").slice(0, 160)}`;
    case "compaction_start":
      return `${t} compaction`;
    case "agent_end":
      return `${t} agent run ended${ev.willRetry ? " (will retry)" : ""}`;
    default:
      return null;
  }
}

function clipArgs(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  return s.length > 160 ? `${s.slice(0, 160)}…` : s;
}

/** progress-guard / recovery-orchestrator escalations show up as notices; count them. */
export function isGuardEscalation(ev) {
  return ev.type === "extension_ui_request" && ev.method === "notify"
    && /progress-guard|recovery|stuck|loop detected|oscillat/i.test(String(ev.message ?? ""));
}

/**
 * Commands the long-horizon harness must have registered. If the kit fails to load (a bad
 * package path, a broken extension) pi still starts, bare; the supervisor checks this list
 * against `get_commands` at the start of every session and stops the run rather than cycle
 * without the harness.
 */
export const HARNESS_COMMANDS = ["goal", "subagents", "handoff", "verify", "firewall:status", "orchestrate", "trace"];

/** Missing harness commands in a get_commands response (an empty list means the harness loaded). */
export function missingHarness(response, required = HARNESS_COMMANDS) {
  const list = response?.data?.commands ?? response?.data ?? [];
  const names = new Set((Array.isArray(list) ? list : []).map((c) => c?.name));
  return required.filter((name) => !names.has(name));
}
