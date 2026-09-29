/**
 * Subagent — child extension isolation.
 *
 * A child used to inherit every extension the operator had installed. Print mode reports its
 * prompt as `source: "interactive"`, so each child's orchestrator / memory hooks treated the
 * delegated task as a fresh user request and rewrote the parent's shared
 * `.pi/ctx-contributions/*.json` (an implementer child was even told "do NOT implement directly,
 * delegate"). Children also started the web console, git checkpoints, desktop notifications,
 * formatters and footers of their own.
 *
 * Children now run with `--no-extensions` plus an explicit allowlist of safety extensions,
 * intersected with what the operator actually has enabled, so a guard the operator switched
 * off is not silently switched back on inside children.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir, falseValue } from "./config.ts";

const SUBAGENT_DIR = path.dirname(fileURLToPath(import.meta.url));
// packages/extensions/third_party/subagent -> packages/extensions
const EXTENSIONS_ROOT = path.resolve(SUBAGENT_DIR, "..", "..");

// Guards that keep a child inside the operator's policy. Workflow/UX extensions are excluded on
// purpose: they either steer (orchestrator, memory, context-sieve) or have side effects that
// belong to the interactive session only (web-console, notify, git-checkpoint, footer).
export const DEFAULT_CHILD_EXTENSIONS = ["secret-guard", "protected-paths", "tool-firewall", "finish-reason-retry", "todo"];

export function kitExtensionPath(name: string): string | null {
	if (name.includes("/") || name.endsWith(".ts")) {
		const p = path.resolve(name);
		return fs.existsSync(p) ? p : null;
	}
	for (const avenue of ["src", "third_party"]) {
		const p = path.join(EXTENSIONS_ROOT, avenue, name, "index.ts");
		if (fs.existsSync(p)) return p;
	}
	return null;
}

function readJson(file: string): Record<string, unknown> | null {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
	} catch {
		return null;
	}
}

// Names of kit extensions the operator has enabled, from the kit's package entry in the global
// and project settings. `null` means "not filtered" (the entry has no extensions list, so pi
// loads every kit extension) or "kit entry not found" (e.g. loaded with -e during development).
export function enabledKitExtensions(cwd: string): Set<string> | null {
	const files = [path.join(agentDir(), "settings.json"), path.join(cwd, ".pi", "settings.json")];
	let found: Set<string> | null = null;
	for (const file of files) {
		const settings = readJson(file);
		const packages = Array.isArray(settings?.packages) ? (settings.packages as unknown[]) : [];
		for (const pkg of packages) {
			if (!pkg || typeof pkg !== "object") continue;
			const entry = pkg as { source?: unknown; extensions?: unknown };
			if (typeof entry.source !== "string" || !Array.isArray(entry.extensions)) continue;
			const names = (entry.extensions as unknown[])
				.filter((e): e is string => typeof e === "string" && !e.startsWith("!"))
				.map((e) => e.match(/(?:src|third_party)\/([^/]+)\/index\.ts$/)?.[1])
				.filter((n): n is string => Boolean(n));
			if (names.length === 0) continue;
			// A project entry for the kit replaces the global one, matching pi's package precedence.
			found = new Set(names);
		}
	}
	return found;
}

export interface ChildExtensionPlan {
	isolated: boolean;
	args: string[];
	loaded: string[];
}

// Build the extension argv for a child. `roleExtensions` come from role frontmatter and
// `needsSubagent` is true when the role's tool list names `subagent` (a delegator).
export function childExtensionArgs(cwd: string, roleExtensions: string[] = [], needsSubagent = false): ChildExtensionPlan {
	if (falseValue(process.env.PI_KIT_SUBAGENT_ISOLATE)) return { isolated: false, args: [], loaded: [] };
	const override = process.env.PI_KIT_SUBAGENT_EXTENSIONS;
	const base = override !== undefined ? override.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_CHILD_EXTENSIONS;
	const enabled = enabledKitExtensions(cwd);
	const wanted = new Set<string>();
	// Safety defaults follow the operator's enablement; an explicit override or role request is
	// taken as-is (the operator or role author asked for it by name).
	for (const name of base) if (override !== undefined || !enabled || enabled.has(name)) wanted.add(name);
	for (const name of roleExtensions) wanted.add(name);
	if (needsSubagent) wanted.add("subagent");
	const args = ["--no-extensions"];
	const loaded: string[] = [];
	for (const name of wanted) {
		const p = kitExtensionPath(name);
		if (!p) continue;
		args.push("-e", p);
		loaded.push(name);
	}
	return { isolated: true, args, loaded };
}
