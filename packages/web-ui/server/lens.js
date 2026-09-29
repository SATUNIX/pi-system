// lens.js — surface pi-lens's own state for a session (read-only).
//
// pi-lens persists per-session widget data and a shared cache under ~/.pi-lens.
// We only read small, well-known files — the directory itself can be very large.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const LENS_DIR =
	process.env.PI_LENS_DIR || path.join(os.homedir(), ".pi-lens");

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

function safeStat(file) {
	try {
		return fs.statSync(file);
	} catch {
		return null;
	}
}

function emptyLens() {
	return {
		available: false,
		savedAt: null,
		files: [],
		totals: { blocking: 0, errors: 0, warnings: 0 },
		cache: { qualityWarnings: 0, findings: 0, qualityGeneratedAt: null },
	};
}

/** Per-file diagnostics recorded for this session plus cache-level findings. */
export function sessionLens(sessionId) {
	// Guard against path traversal: an id such as "../../secret" would otherwise
	// be normalised by path.join and read a JSON file outside LENS_DIR/sessions.
	if (typeof sessionId !== "string" || sessionId.length === 0) return emptyLens();
	const sessionsDir = path.join(LENS_DIR, "sessions");
	const root = path.resolve(sessionsDir);
	const resolved = path.resolve(sessionsDir, `${sessionId}.json`);
	if (!resolved.startsWith(root + path.sep)) return emptyLens();
	const raw = readJson(resolved);
	const files = [];
	if (raw && raw.widget && Array.isArray(raw.widget.files)) {
		for (const entry of raw.widget.files) {
			if (!entry || typeof entry !== "object") continue;
			const counts = entry.diagnosticCounts || {};
			files.push({
				filePath: typeof entry.filePath === "string" ? entry.filePath : null,
				blocking: counts.blocking || 0,
				errors: counts.errors || 0,
				warnings: counts.warnings || 0,
				runners: Array.isArray(entry.runners)
					? entry.runners
							.filter(
								(runner) =>
									Array.isArray(runner) && typeof runner[0] === "string",
							)
							.map(([name, info]) => ({
								name,
								status: info && info.status,
								count: (info && info.count) || 0,
								durationMs: (info && info.durationMs) || 0,
							}))
					: [],
				touchedAt: entry.touchedAt || null,
			});
		}
	}

	const totals = files.reduce(
		(acc, f) => ({
			blocking: acc.blocking + f.blocking,
			errors: acc.errors + f.errors,
			warnings: acc.warnings + f.warnings,
		}),
		{ blocking: 0, errors: 0, warnings: 0 },
	);

	const quality = readJson(
		path.join(LENS_DIR, "cache", "code-quality-warnings.json"),
	);
	const findings = readJson(
		path.join(LENS_DIR, "cache", "turn-end-findings.json"),
	);

	return {
		available: Boolean(raw),
		savedAt: raw && raw.savedAt ? new Date(raw.savedAt).toISOString() : null,
		files,
		totals,
		cache: {
			qualityWarnings:
				quality && Array.isArray(quality.files) ? quality.files.length : 0,
			findings:
				findings && Array.isArray(findings.files) ? findings.files.length : 0,
			qualityGeneratedAt: (quality && quality.generatedAt) || null,
		},
	};
}

/** Global lens status: is the cache present and how big is it. */
export function lensStatus() {
	const dirStat = safeStat(LENS_DIR);
	const sessionDir = path.join(LENS_DIR, "sessions");
	let sessionCount = 0;
	try {
		sessionCount = fs
			.readdirSync(sessionDir)
			.filter((f) => f.endsWith(".json")).length;
	} catch {
		/* ignore */
	}
	const turnState = readJson(path.join(LENS_DIR, "turn-state.json"));
	return {
		dir: LENS_DIR,
		present: Boolean(dirStat),
		sessionCount,
		turn: turnState
			? {
					files: Object.keys(turnState.files || {}).length,
					cycles: turnState.turnCycles,
					lastUpdated: turnState.lastUpdated,
				}
			: null,
	};
}
