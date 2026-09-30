import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";

// PowerShell single-quoted strings escape ' by doubling it.
const psQuote = (text: string): string => text.replace(/'/g, "''");

function windowsToastScript(title: string, body: string): string {
  const type = "Windows.UI.Notifications";
  const mgr = `[${type}.ToastNotificationManager, ${type}, ContentType = WindowsRuntime]`;
  const template = `[${type}.ToastTemplateType]::ToastText01`;
  const toast = `[${type}.ToastNotification]::new($xml)`;
  return [
    `${mgr} > $null`,
    `$xml = [${type}.ToastNotificationManager]::GetTemplateContent(${template})`,
    `$xml.GetElementsByTagName('text')[0].AppendChild($xml.CreateTextNode('${psQuote(body)}')) > $null`,
    `[${type}.ToastNotificationManager]::CreateToastNotifier('${psQuote(title)}').Show(${toast})`,
  ].join("; ");
}

function notifyOSC777(title: string, body: string): void {
  process.stdout.write(`\x1b]777;notify;${title};${body}\x07`);
}

function notifyOSC99(title: string, body: string): void {
  process.stdout.write(`\x1b]99;i=1:d=0;${title}\x1b\\`);
  process.stdout.write(`\x1b]99;i=1:p=body;${body}\x1b\\`);
}

function notifyBell(): void {
  process.stdout.write("\x07");
}

function notifySend(title: string, body: string): void {
  execFile("notify-send", [title, body], () => {});
}

function notifyWindows(title: string, body: string): void {
  execFile("powershell.exe", ["-NoProfile", "-Command", windowsToastScript(title, body)]);
}

// PI_KIT_NOTIFY selects how (default `osc`): off | osc | bell | notify-send. Windows Terminal and kitty
// keep their native paths under `osc`.
export function notifyMode(env: NodeJS.ProcessEnv = process.env): "off" | "osc" | "bell" | "notify-send" {
  const v = (env.PI_KIT_NOTIFY ?? "").trim().toLowerCase();
  if (v === "0" || v === "off" || v === "false" || v === "none") return "off";
  return v === "bell" || v === "notify-send" ? v : "osc";
}

// Only tell the operator about runs long enough to have looked away (default 10 s,
// PI_KIT_NOTIFY_MIN_SECONDS to change; 0 notifies every run).
export function minSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.PI_KIT_NOTIFY_MIN_SECONDS);
  return Number.isFinite(n) && n >= 0 && (env.PI_KIT_NOTIFY_MIN_SECONDS ?? "") !== "" ? n : 10;
}

function notify(title: string, body: string, mode: "osc" | "bell" | "notify-send"): void {
  if (mode === "bell") notifyBell();
  else if (mode === "notify-send") notifySend(title, body);
  else if (process.env.WT_SESSION) notifyWindows(title, body);
  else if (process.env.KITTY_WINDOW_ID) notifyOSC99(title, body);
  else notifyOSC777(title, body);
}

export default function (pi: ExtensionAPI) {
  let startedAt = 0;
  pi.on("agent_start", async () => {
    startedAt = Date.now();
  });
  pi.on("agent_end", async (_event, ctx) => {
    const mode = notifyMode();
    // Delegated children and print/JSON sessions have nobody to notify, and raw OSC bytes on stdout
    // would corrupt piped output.
    if (mode === "off" || process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_KIT_INTERNAL_CHILD === "1" || !(ctx as { hasUI?: boolean } | undefined)?.hasUI) return;
    if (startedAt && Date.now() - startedAt < minSeconds() * 1000) return;
    notify("Pi", "Ready for input", mode);
  });
}
