// routes.js — REST API and the SSE event stream for pi-console.
import * as fs from "node:fs";
import { listAgents } from "./agents.js";
import {
	KNOWN_TOOLS,
	createAgent,
	deleteAgent,
	getAgent,
	updateAgent,
} from "./agentstore.js";
import { configInfo, listPrompts, listSkills } from "./configinfo.js";
import { sessionLens } from "./lens.js";
import { listModels } from "./models.js";
import { listCwds, listSessions } from "./sessions.js";
import { createSession, getSession, listLiveSessions } from "./spawn.js";
import { sessionStats } from "./stats.js";
import { readTodos } from "./todos.js";
import { acquireTailer, isFileActive, releaseTailer } from "./tailer.js";
import { DEFAULT_CWD } from "./config.js";
import { mediaType } from "./security.js";
import {
	ENTRY_ID_RE,
	HttpError,
	MODEL_ARG_RE,
	STREAMING_BEHAVIOURS,
	optionalString,
	parseSessionId,
	requireObject,
} from "./validate.js";

const VERSION = "0.1.0";

/** Largest JSON request body accepted, in bytes. */
export const MAX_BODY_BYTES = 1_000_000;

function sendJson(res, status, body, extraHeaders = {}) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
		"Content-Length": Buffer.byteLength(payload),
		...extraHeaders,
	});
	res.end(payload);
}

/**
 * Read a bounded JSON object body. The size is enforced on the declared Content-Length
 * first and again on the bytes actually received (chunked bodies have no length), and the
 * bytes are decoded once at the end so a multi-byte character split across chunks survives.
 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const headers = req.headers || {};
		if (mediaType(headers["content-type"]) !== "application/json") {
			return reject(new HttpError(415, "Content-Type must be application/json"));
		}
		const declared = Number(headers["content-length"]);
		if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
			return reject(new HttpError(413, "request body too large"));
		}
		const chunks = [];
		let size = 0;
		let settled = false;
		req.on("data", (chunk) => {
			if (settled) return;
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				settled = true;
				chunks.length = 0;
				reject(new HttpError(413, "request body too large"));
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (settled) return;
			settled = true;
			const text = Buffer.concat(chunks).toString("utf8");
			if (!text.trim()) return resolve({});
			let parsed;
			try {
				parsed = JSON.parse(text);
			} catch {
				return reject(new HttpError(400, "invalid JSON body"));
			}
			try {
				resolve(requireObject(parsed));
			} catch (error) {
				reject(error);
			}
		});
		req.on("error", (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		});
	});
}

function procSummary(proc) {
	return {
		id: proc.publicId,
		cwd: proc.cwd,
		sessionFile: proc.sessionFile,
		startedAt: new Date(proc.startedAt).toISOString(),
		endedAt: null,
		lastActivityAt: new Date().toISOString(),
		entryCount: 0,
		preview: "",
		status: proc.alive ? "running" : "exited",
		agent: proc.agentName,
	};
}

/** Disk sessions (idle) merged with live child processes (running).
 * A session recently written by ANOTHER process (e.g. the CLI) is marked "external" so the
 * UI can show it as live rather than idle. */
function mergedSessions() {
	const byId = new Map();
	for (const s of listSessions()) {
		const externalActive =
			Boolean(s.sessionFile) && isFileActive(s.sessionFile);
		byId.set(s.id, {
			...s,
			status: externalActive ? "external" : "idle",
			externalActive,
		});
	}
	for (const proc of listLiveSessions()) {
		if (!proc.alive) continue; // exited children fall back to their on-disk view
		const id = proc.publicId;
		const existing = byId.get(id);
		if (existing) {
			byId.set(id, {
				...existing,
				status: "running",
				externalActive: false,
				cwd: existing.cwd || proc.cwd,
				agent: proc.agentName,
			});
		} else {
			byId.set(id, procSummary(proc));
		}
	}
	return [...byId.values()].sort((a, b) =>
		String(b.lastActivityAt || "").localeCompare(
			String(a.lastActivityAt || ""),
		),
	);
}

function findSummary(id) {
	return mergedSessions().find((s) => s.id === id) || null;
}

/** Resume an idle session by spawning a child bound to its session file.
 * Refuses when another process is actively writing the session (two writers would clash). */
async function ensureLive(id) {
	const existing = getSession(id);
	if (existing && existing.alive) return existing;
	const summary = findSummary(id);
	if (!summary) return null;
	if (summary.sessionFile && !fs.existsSync(summary.sessionFile)) return null;
	if (summary.sessionFile && isFileActive(summary.sessionFile)) {
		const err = new Error(
			"session is active in another process (CLI) — watch it here, or wait for it to finish",
		);
		err.statusCode = 409;
		throw err;
	}
	return createSession({
		cwd: summary.cwd || DEFAULT_CWD,
		resumeSessionFile: summary.sessionFile,
	});
}

/** Recover the raw query string ("?...") when the caller did not pass one. */
function searchOf(req) {
	const raw = (req && req.url) || "";
	const q = raw.indexOf("?");
	return q === -1 ? "" : raw.slice(q);
}

/**
 * Route one /api request. Returns true when the request was handled.
 *
 * Authentication, Host/Origin checks and content-type enforcement happen in server.js
 * (security.js evaluateRequest) before this is called; this function validates the
 * request's content and never forwards anything to a pi child except the fixed command
 * shapes built below (spawn.js additionally enforces an allowlist of RPC command types).
 * `ctx.authMode` is only reported by /api/health.
 */
export async function handleApi(req, res, url, ctx = {}) {
	const { pathname } = url;
	if (!pathname.startsWith("/api/")) return false;

	const parts = pathname.split("/").filter(Boolean); // ["api", ...]
	const method = req.method || "GET";
	// `??`: an explicitly supplied empty search is honoured, while callers that only
	// forward a pathname still get the query from req.url.
	const search = url.search ?? searchOf(req);
	const query = new URLSearchParams((search || "").replace(/^\?/, ""));

	try {
		if (parts[1] === "health" && parts.length === 2 && method === "GET") {
			return (
				sendJson(res, 200, {
					ok: true,
					version: VERSION,
					uptimeSec: Math.round(process.uptime()),
					// Tells the page whether to ask for a token: "token" unless the operator
					// explicitly started the server with PI_CONSOLE_AUTH=off.
					auth: ctx.authMode === "off" ? "off" : "token",
				}),
				true
			);
		}

		// Reaching this route means the request already passed the token check, so the
		// login page uses it to validate a token the operator typed in.
		if (parts[1] === "auth" && parts.length === 2 && method === "GET") {
			return sendJson(res, 200, { authenticated: true }), true;
		}

		if (parts[1] === "config" && parts.length === 2 && method === "GET") {
			return sendJson(res, 200, configInfo()), true;
		}

		if (parts[1] === "prompts" && parts.length === 2 && method === "GET") {
			return sendJson(res, 200, { prompts: listPrompts() }), true;
		}

		if (parts[1] === "skills" && parts.length === 2 && method === "GET") {
			return sendJson(res, 200, { skills: listSkills() }), true;
		}

		if (parts[1] === "models" && parts.length === 2 && method === "GET") {
			return sendJson(res, 200, listModels()), true;
		}

		if (parts[1] === "cwds" && parts.length === 2 && method === "GET") {
			return sendJson(res, 200, { cwds: listCwds() }), true;
		}

		// ------------------------------------------------------------- agents ----
		if (parts[1] === "agents") {
			if (parts.length === 2) {
				if (method === "GET")
					return (
						sendJson(res, 200, { agents: listAgents(), tools: KNOWN_TOOLS }),
						true
					);
				if (method === "POST") {
					const body = await readBody(req);
					const agent = createAgent(body);
					return sendJson(res, 201, { agent }), true;
				}
			}
			if (parts.length === 3) {
				const name = decodeURIComponent(parts[2]);
				const source = query.get("source") || undefined;
				if (method === "GET") {
					const agent = getAgent(name, source);
					if (!agent)
						return sendJson(res, 404, { error: "agent not found" }), true;
					return sendJson(res, 200, { agent }), true;
				}
				if (method === "PUT") {
					const body = await readBody(req);
					const agent = updateAgent(name, {
						...body,
						source: body.source || source,
					});
					return sendJson(res, 200, { agent }), true;
				}
				if (method === "DELETE") {
					return sendJson(res, 200, deleteAgent(name, source)), true;
				}
			}
		}

		// ----------------------------------------------------------- sessions ----
		if (parts[1] === "sessions" && parts.length === 2) {
			if (method === "GET")
				return sendJson(res, 200, { sessions: mergedSessions() }), true;
			if (method === "POST") {
				const body = await readBody(req);
				const proc = await createSession({
					cwd: body.cwd,
					agent: body.agent,
					agentSource: body.agentSource,
					provider: body.provider,
					model: body.model,
					thinking: body.thinking,
				});
				return sendJson(res, 201, { session: procSummary(proc) }), true;
			}
		}

		if (parts[1] === "sessions" && parts.length >= 3) {
			const id = parseSessionId(parts[2]);
			const sub = parts[3];

			if (parts.length === 3 && method === "GET") {
				const summary = findSummary(id);
				if (!summary)
					return sendJson(res, 404, { error: "session not found" }), true;
				return sendJson(res, 200, { session: summary }), true;
			}

			if (parts.length === 3 && method === "DELETE") {
				const proc = getSession(id);
				if (!proc)
					return sendJson(res, 404, { error: "session is not running" }), true;
				proc.kill();
				return sendJson(res, 202, { stopping: true }), true;
			}

			if (sub === "events" && method === "GET") return handleSse(res, id), true;

			if (sub === "stats" && method === "GET") {
				const summary = findSummary(id);
				if (!summary)
					return sendJson(res, 404, { error: "session not found" }), true;
				const proc = getSession(id);
				return (
					sendJson(res, 200, { stats: await sessionStats(summary, proc) }), true
				);
			}

			if (sub === "todos" && method === "GET") {
				const summary = findSummary(id);
				if (!summary)
					return sendJson(res, 404, { error: "session not found" }), true;
				return (
					sendJson(res, 200, readTodos(summary.cwd || DEFAULT_CWD, id)), true
				);
			}

			if (sub === "lens" && method === "GET") {
				return sendJson(res, 200, { lens: sessionLens(id) }), true;
			}

			if (sub === "prompt" && method === "POST") {
				const body = await readBody(req);
				const message =
					typeof body.message === "string" ? body.message.trim() : "";
				if (!message)
					return sendJson(res, 400, { error: "message is required" }), true;
				// Validate everything before ensureLive(), which can spawn a child.
				const streamingBehavior = optionalString(
					body.streamingBehavior,
					"streamingBehavior",
					{ max: 20 },
				);
				if (
					streamingBehavior !== undefined &&
					!STREAMING_BEHAVIOURS.includes(streamingBehavior)
				)
					throw new HttpError(400, "invalid streamingBehavior");
				const proc = await ensureLive(id);
				if (!proc)
					return sendJson(res, 404, { error: "session not found" }), true;
				const cmd = { type: "prompt", message };
				if (streamingBehavior !== undefined)
					cmd.streamingBehavior = streamingBehavior;
				proc.send(cmd).catch(() => {});
				return sendJson(res, 202, { queued: true }), true;
			}

			if (sub === "abort" && method === "POST") {
				const proc = getSession(id);
				if (!proc)
					return sendJson(res, 404, { error: "session is not running" }), true;
				proc.send({ type: "abort" }).catch(() => {});
				return sendJson(res, 202, { aborted: true }), true;
			}

			if (sub === "model" && method === "POST") {
				const body = await readBody(req);
				if (!body.provider || !body.modelId)
					return (
						sendJson(res, 400, { error: "provider and modelId are required" }),
						true
					);
				const provider = optionalString(body.provider, "provider", {
					pattern: MODEL_ARG_RE,
				});
				const modelId = optionalString(body.modelId, "modelId", {
					pattern: MODEL_ARG_RE,
				});
				const proc = await ensureLive(id);
				if (!proc)
					return sendJson(res, 404, { error: "session not found" }), true;
				const data = await proc.send({
					type: "set_model",
					provider,
					modelId,
				});
				return sendJson(res, 200, { model: data }), true;
			}

			if (sub === "thinking" && method === "POST") {
				const body = await readBody(req);
				const level = String(body.level || "");
				if (
					!["off", "minimal", "low", "medium", "high", "xhigh"].includes(level)
				) {
					return sendJson(res, 400, { error: "invalid thinking level" }), true;
				}
				const proc = await ensureLive(id);
				if (!proc)
					return sendJson(res, 404, { error: "session not found" }), true;
				const data = await proc.send({ type: "set_thinking_level", level });
				return sendJson(res, 200, { thinking: data, level }), true;
			}

			if (sub === "fork" && method === "POST") {
				const body = await readBody(req);
				const entryId = optionalString(body.entryId, "entryId", {
					max: 100,
					pattern: ENTRY_ID_RE,
				});
				const proc = await ensureLive(id);
				if (!proc)
					return sendJson(res, 404, { error: "session not found" }), true;
				const data = await proc.send({ type: "fork", entryId });
				return sendJson(res, 200, { fork: data }), true;
			}

			if (sub === "new" && method === "POST") {
				const proc = await ensureLive(id);
				if (!proc)
					return sendJson(res, 404, { error: "session not found" }), true;
				const data = await proc.send({ type: "new_session" });
				return sendJson(res, 200, { reset: data }), true;
			}
		}

		return (
			sendJson(res, 404, { error: `no route for ${method} ${pathname}` }), true
		);
	} catch (err) {
		const status = Number(err && err.statusCode) || 400;
		return (
			sendJson(
				res,
				status,
				{ error: String(err && err.message ? err.message : err) },
				// An oversized body may still be arriving: do not keep the connection for reuse.
				status === 413 ? { Connection: "close" } : {},
			),
			true
		);
	}
}

// Open SSE responses, so shutdown can end them (otherwise server.close() waits on them).
const openStreams = new Set();

/** End every open event stream (shutdown). Their close handlers release subscriptions. */
export function closeAllStreams() {
	for (const res of [...openStreams]) {
		try {
			res.end();
		} catch {
			/* already gone */
		}
	}
	openStreams.clear();
}

function handleSse(res, id) {
	res.writeHead(200, {
		"Content-Type": "text/event-stream; charset=utf-8",
		"Cache-Control": "no-store, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	});
	res.write(": connected\n\n");
	openStreams.add(res);

	const write = (message) => {
		try {
			res.write(
				`event: ${message.type}\ndata: ${JSON.stringify({ sessionId: id, ...message })}\n\n`,
			);
		} catch {
			/* client vanished */
		}
	};

	const proc = getSession(id);
	const summary = findSummary(id);
	let unsubscribe = () => {};
	let cleanupTailer = null;

	if (proc && proc.alive) {
		write({ type: "lifecycle", state: "running", code: null });
		for (const message of proc.replay) write(message);
		unsubscribe = proc.subscribe(write);
	} else if (summary && summary.sessionFile) {
		// No child of ours: follow the session file so a session running in the CLI is live here.
		const tailer = acquireTailer(summary.sessionFile);
		if (tailer) {
			write({ type: "lifecycle", state: "watching", code: null });
			const unsubscribeTailer = tailer.subscribe(write);
			unsubscribe = unsubscribeTailer;
			cleanupTailer = () =>
				releaseTailer(summary.sessionFile, unsubscribeTailer);
		} else {
			write({ type: "lifecycle", state: "idle", code: null });
		}
	} else {
		write({ type: "lifecycle", state: "idle", code: null });
	}

	const heartbeat = setInterval(() => {
		try {
			res.write(": ping\n\n");
		} catch {
			/* ignore */
		}
	}, 15000);

	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return; // 'error' and 'close' can both fire
		cleaned = true;
		unsubscribe();
		if (cleanupTailer) cleanupTailer();
		clearInterval(heartbeat);
		openStreams.delete(res);
	};
	res.on("close", cleanup);
	res.on("error", cleanup);
}
