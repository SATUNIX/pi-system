// validate.js — input validation for the HTTP API.
//
// Everything that arrives in a request body or URL and is later used as a file name, a
// child-process argument or an RPC field is checked here first. Failures are HttpErrors with a
// statusCode, which routes.js turns into a JSON error response.
import * as fs from "node:fs";
import * as path from "node:path";

export class HttpError extends Error {
	constructor(status, message) {
		super(message);
		this.name = "HttpError";
		this.statusCode = status;
	}
}

/** Session ids are pi UUIDs, session-file basenames or `local-<hex>`: never a path. */
export const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
/** Provider and model identifiers, e.g. `openrouter-custom`, `deepseek/deepseek-v4.1-flash:free`. */
export const MODEL_ARG_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,199}$/;
export const ENTRY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh"]);
export const STREAMING_BEHAVIOURS = Object.freeze(["steer", "followUp"]);

/** Decode one URL path segment into a session id, refusing anything path-like. */
export function parseSessionId(rawSegment) {
	let id;
	try {
		id = decodeURIComponent(String(rawSegment ?? ""));
	} catch {
		throw new HttpError(400, "invalid session id");
	}
	if (!SESSION_ID_RE.test(id)) throw new HttpError(400, "invalid session id");
	return id;
}

/** An optional string bounded by length and (optionally) a pattern. */
export function optionalString(value, name, { max = 200, pattern } = {}) {
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string" || value.length > max || (pattern && !pattern.test(value))) {
		throw new HttpError(400, `invalid ${name}`);
	}
	return value;
}

export function requireString(value, name, options) {
	const out = optionalString(value, name, options);
	if (out === undefined) throw new HttpError(400, `${name} is required`);
	return out;
}

/** Body of a bare JSON object (never null, an array or a primitive). */
export function requireObject(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new HttpError(400, "JSON object body required");
	}
	return value;
}

/**
 * Validate the fields of a spawn request. The returned object is what createSession uses,
 * so nothing unvalidated ever reaches argv.
 */
export function sanitizeSpawnConfig(input, { defaultCwd }) {
	const config = requireObject(input);
	const cwdRaw = config.cwd === undefined || config.cwd === null || config.cwd === "" ? defaultCwd : config.cwd;
	if (typeof cwdRaw !== "string" || cwdRaw.length > 4096 || cwdRaw.includes("\0") || !path.isAbsolute(cwdRaw)) {
		throw new HttpError(400, "cwd must be an absolute directory path");
	}
	let stat = null;
	try {
		stat = fs.statSync(cwdRaw);
	} catch {
		/* handled below */
	}
	if (!stat || !stat.isDirectory()) throw new HttpError(400, `cwd does not exist: ${cwdRaw}`);

	const thinking = optionalString(config.thinking, "thinking level", { max: 10 });
	if (thinking !== undefined && !THINKING_LEVELS.includes(thinking)) {
		throw new HttpError(400, "invalid thinking level");
	}
	const agentSource = optionalString(config.agentSource, "agent source", { max: 10 });
	if (agentSource !== undefined && agentSource !== "user" && agentSource !== "project") {
		throw new HttpError(400, "invalid agent source");
	}
	let resumeSessionFile;
	if (config.resumeSessionFile !== undefined) {
		if (typeof config.resumeSessionFile !== "string" || config.resumeSessionFile.includes("\0")) {
			throw new HttpError(400, "invalid session file");
		}
		resumeSessionFile = config.resumeSessionFile;
	}
	return {
		cwd: cwdRaw,
		agent: optionalString(config.agent, "agent", { max: 64 }),
		agentSource,
		provider: optionalString(config.provider, "provider", { pattern: MODEL_ARG_RE }),
		model: optionalString(config.model, "model", { pattern: MODEL_ARG_RE }),
		thinking,
		resumeSessionFile,
	};
}
