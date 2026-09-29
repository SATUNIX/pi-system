// tool-capture: a lossless record of every tool call and its output, for audit and SIEM.
//
// Each call produces a `call` record (the exact arguments the model sent) and a `result` record
// (the exact content and details the model got back, including firewall blocks and errors),
// joined by toolCallId and by the same action hash the firewall audit uses (and the argsHash
// trace-ledger uses). Nothing is truncated: values too large for a line are stored whole as
// content-addressed blobs, and pi's full-output temp file of a truncated bash result is copied
// into a blob and linked by an `attachment` record. Storage, rotation, compression and disk
// budget are in store.ts.
//
// Values are stored byte-exact, secrets included (operator choice), which is why the directory is
// 0700 with 0600 files, protected-paths refuses agent writes there, the firewall treats reading
// it as a credential read, and each record lists the secret kinds it contains in `secrets`.
// PI_KIT_CAPTURE_REDACT=1 stores redacted values instead. PI_KIT_CAPTURE=0 disables capture.
//
// Capture never breaks the agent: every hook is wrapped, failures are counted, reported once and
// shown by /capture.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { CaptureStore, defaultOptions } from "./store.ts";

export function captureDir(): string {
  const explicit = process.env.PI_KIT_CAPTURE_DIR?.trim();
  if (explicit) return explicit;
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || path.join(process.env.HOME || os.homedir(), ".pi", "agent");
  return path.join(agentDir, "pi-kit", "capture");
}

// The firewall's action hash: sha256 of the key-sorted JSON of { toolName, input }.
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).sort(([l], [r]) => l.localeCompare(r)).map(([k, v]) => [k, sortJson(v)]));
}
export function actionHash(toolName: string, input: unknown): string {
  try {
    return crypto.createHash("sha256").update(JSON.stringify(sortJson({ toolName, input }))).digest("hex");
  } catch {
    return "unhashable";
  }
}

// trace-ledger's argsHash: sha256 of `${tool} ${stableStringify(input)}`.
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stableStringify).join(",") + "]";
  const obj = v as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}
export function argsHash(tool: string, input: unknown): string {
  try {
    return crypto.createHash("sha256").update(tool + " " + stableStringify(input)).digest("hex");
  } catch {
    return "unhashable";
  }
}

// Secret detection: flags which kinds a record contains. Detection only (values are kept), except
// in redact mode. Scanning is bounded per record so a huge output cannot stall the agent.
const SECRET_PATTERNS: [string, RegExp][] = [
  ["private_key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY-----|$)/g],
  ["aws_access_key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github_token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["api_key", /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}\b/g],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g],
  ["google_api_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  ["bearer", /(authorization\s*[:=]\s*["']?(?:bearer|basic|token)\s+)[^\s"']{8,}/gi],
  ["url_credentials", /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi],
  ["password_assignment", /((?:^|[^A-Za-z0-9])(?:[A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_-]*)["']?\s*[:=]\s*)("[^"\n]{4,}"|'[^'\n]{4,}'|[^\s"',;&|]{6,})/gi],
];
const SCAN_BUDGET = 4 * 1024 * 1024;

export function scanSecrets(value: unknown, redact: boolean): { kinds: string[]; value: unknown } {
  const kinds = new Set<string>();
  let budget = SCAN_BUDGET;
  const seen = new WeakSet<object>();
  const visit = (v: unknown): unknown => {
    if (typeof v === "string") {
      if (budget <= 0) return v;
      const scanned = v.length > budget ? v.slice(0, budget) : v;
      budget -= scanned.length;
      let out = v;
      for (const [kind, re] of SECRET_PATTERNS) {
        re.lastIndex = 0;
        if (!re.test(scanned)) continue;
        kinds.add(kind);
        if (redact) {
          re.lastIndex = 0;
          out = out.replace(re, (m, keep?: string) => (typeof keep === "string" && m.startsWith(keep) ? `${keep}[REDACTED:${kind}]` : `[REDACTED:${kind}]`));
        }
      }
      return out;
    }
    if (!v || typeof v !== "object" || v instanceof Uint8Array || v instanceof ArrayBuffer) return v;
    if (seen.has(v)) return v;
    seen.add(v);
    if (Array.isArray(v)) {
      const mapped = v.map(visit);
      return redact ? mapped : v;
    }
    if (v instanceof Date || v instanceof Error || v instanceof Map || v instanceof Set) return v;
    if (!redact) {
      for (const k of Object.keys(v)) {
        try {
          visit((v as Record<string, unknown>)[k]);
        } catch {
          /* getter threw */
        }
      }
      return v;
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      try {
        out[k] = visit((v as Record<string, unknown>)[k]);
      } catch (error) {
        out[k] = { $getter_error: String(error) };
      }
    }
    return out;
  };
  const out = visit(value);
  return { kinds: [...kinds].sort(), value: redact ? out : value };
}

function sessionIdOf(ctx: any): string {
  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (typeof id === "string" && id) return id;
  } catch {
    /* optional */
  }
  return typeof ctx?.sessionId === "string" && ctx.sessionId ? ctx.sessionId : `pid-${process.pid}`;
}

function rootSessionOf(own: string): string {
  const inherited = process.env.PI_KIT_FIREWALL_ROOT_SESSION?.trim();
  return inherited && process.env.PI_KIT_INTERNAL_CHILD === "1" ? inherited : own;
}

// One store per process, shared across extension reloads so the exit handler closes the current one.
const GLOBAL_KEY = Symbol.for("pi-kit.tool-capture.store");
type Holder = { store: CaptureStore | null; exitHooked: boolean };
function holder(): Holder {
  const g = globalThis as unknown as Record<symbol, Holder>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { store: null, exitHooked: false };
  return g[GLOBAL_KEY];
}

export default function (pi: ExtensionAPI) {
  if (process.env.PI_KIT_CAPTURE === "0") return;
  const redact = process.env.PI_KIT_CAPTURE_REDACT === "1";
  const started = new Map<string, number>();
  let store: CaptureStore | null = null;
  let initError = "";
  let warned = false;

  const report = (ctx: ExtensionContext | undefined, message: string) => {
    if (warned) return;
    warned = true;
    try {
      if (ctx?.hasUI) ctx.ui.notify(`tool-capture: ${message} (capture continues best-effort; /capture for status)`, "warning");
      else process.stderr.write(`tool-capture: ${message}\n`);
    } catch {
      /* nothing more to do */
    }
  };

  const open = (ctx?: ExtensionContext): CaptureStore | null => {
    if (store) return store;
    try {
      const h = holder();
      if (h.store) void h.store.close().catch(() => undefined);
      store = new CaptureStore(defaultOptions(captureDir()));
      store.init();
      h.store = store;
      if (!h.exitHooked) {
        h.exitHooked = true;
        process.once("exit", () => holder().store?.closeSync());
      }
      return store;
    } catch (error) {
      initError = String((error as Error)?.message ?? error);
      store = null;
      report(ctx, `cannot open ${captureDir()}: ${initError}`);
      return null;
    }
  };

  const common = (ctx: any) => {
    const session = sessionIdOf(ctx);
    return {
      session,
      rootSession: rootSessionOf(session),
      child: process.env.PI_KIT_INTERNAL_CHILD === "1" || undefined,
      agent: ctx?.agent?.name || ctx?.agentName || undefined,
      cwd: typeof ctx?.cwd === "string" ? ctx.cwd : process.cwd(),
    };
  };

  // Wraps a hook so capture can never throw into pi or delay a tool call beyond its own work.
  const guard =
    <E>(fn: (event: E, ctx: any) => void | Promise<void>) =>
    async (event: E, ctx: any): Promise<undefined> => {
      try {
        await fn(event, ctx);
        if (store && store.stats.errors && !warned) report(ctx, store.stats.lastError);
      } catch (error) {
        if (store) store.stats.errors++;
        report(ctx, String((error as Error)?.message ?? error));
      }
      return undefined;
    };

  pi.on(
    "session_start",
    guard((event: any, ctx) => {
      const s = open(ctx);
      s?.append({ kind: "session", event: "start", reason: event?.reason, previousSessionFile: event?.previousSessionFile, ...common(ctx), redacted: redact || undefined, argv: process.argv.slice(1) });
    }),
  );

  pi.on(
    "tool_execution_start",
    guard((event: any, ctx) => {
      const s = open(ctx);
      if (!s) return;
      const tool = String(event?.toolName ?? "unknown");
      const id = String(event?.toolCallId ?? "");
      started.set(id, Date.now());
      if (started.size > 10_000) started.delete(started.keys().next().value as string);
      const scan = scanSecrets(event?.args, redact);
      s.append({ kind: "call", ...common(ctx), toolCallId: id, tool, actionHash: actionHash(tool, event?.args ?? {}), argsHash: argsHash(tool, event?.args), args: s.encode(scan.value), secrets: scan.kinds.length ? scan.kinds : undefined, redacted: redact && scan.kinds.length ? true : undefined });
    }),
  );

  pi.on(
    "tool_execution_end",
    guard((event: any, ctx) => {
      const s = open(ctx);
      if (!s) return;
      const tool = String(event?.toolName ?? "unknown");
      const id = String(event?.toolCallId ?? "");
      const t0 = started.get(id);
      started.delete(id);
      const result = event?.result;
      const scan = scanSecrets(result, redact);
      const base = { ...common(ctx), toolCallId: id, tool };
      s.append({ kind: "result", ...base, isError: event?.isError === true, durationMs: t0 === undefined ? undefined : Date.now() - t0, result: s.encode(scan.value), secrets: scan.kinds.length ? scan.kinds : undefined, redacted: redact && scan.kinds.length ? true : undefined });

      // pi keeps the untruncated output of a long bash result in a temp file: store it whole.
      const full = result?.details?.fullOutputPath;
      if (typeof full === "string" && full && !redact) {
        // Copied in the background (streamed, gzip) so a large output does not hold up the agent.
        s.track(s.putFileBlob(full).then((blob) => s.append({ kind: "attachment", ...base, role: "full_output", sourcePath: full, content: blob })));
      } else if (typeof full === "string" && full) {
        s.append({ kind: "attachment", ...base, role: "full_output", sourcePath: full, content: { $blob_skipped: "redact_mode", bytes: 0 } });
      }
    }),
  );

  pi.on(
    "session_shutdown",
    guard(async (event: any, ctx) => {
      if (!store) return;
      store.append({ kind: "session", event: "shutdown", reason: event?.reason, ...common(ctx) });
      const s = store;
      store = null;
      if (holder().store === s) holder().store = null;
      await s.close();
    }),
  );

  pi.registerCommand("capture", {
    description: "Tool I/O capture: status, or `prune` to apply the disk budget now.",
    handler: async (args: string, ctx: ExtensionContext) => {
      const s = open(ctx);
      const say = (m: string): void => {
        if (ctx.hasUI) ctx.ui.notify(m, "info");
        else process.stdout.write(`${m}\n`);
      };
      if (!s) {
        say(`tool-capture: unavailable — ${initError || "disabled"} (${captureDir()})`);
        return;
      }
      if (String(args ?? "").trim() === "prune") s.maybePrune(true);
      const u = s.usage();
      const mib = (n: number) => `${(n / 1024 ** 2).toFixed(1)} MiB`;
      say(
        [
          `tool-capture: ${captureDir()}${redact ? " (redacted mode)" : ""}`,
          `  active segment: ${path.basename(s.activeSegment) || "(none yet)"}`,
          `  stored: ${u.segments} segment(s) ${mib(u.segmentBytes)}, ${u.blobs} blob(s) ${mib(u.blobBytes)} of ${mib(s.opts.budgetBytes)} budget; free ${u.free === null ? "?" : mib(u.free)}; pressure ${u.pressure}`,
          `  this process: ${s.stats.records} record(s), ${s.stats.blobs} new blob(s) (${s.stats.blobReuse} reused), ${s.stats.pruned} pruned, ${s.stats.dropped} dropped, ${s.stats.errors} error(s)${s.stats.lastError ? ` — last: ${s.stats.lastError}` : ""}`,
        ].join("\n"),
      );
    },
  });
}
