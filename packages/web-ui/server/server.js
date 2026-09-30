// server.js — pi-console entrypoint: HTTP server, static files, API delegation.
//
// Access control lives in security.js and is applied to every request here, before routing:
// Host allowlist, Origin / Fetch-Metadata check, bearer token, JSON content type. The token is
// per start (or operator supplied) and is never written to the log or to a query string.
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { PUBLIC_DIR, TOKEN_FILE, ensureRuntimeDir } from "./config.js";
import { handleApi, closeAllStreams } from "./routes.js";
import { killAll } from "./spawn.js";
import { sendFile } from "./send-file.js";
import { closeAllTailers } from "./tailer.js";
import {
	PolicyError,
	applySecurityHeaders,
	buildAuthorities,
	constantTimeEqual,
	evaluateRequest,
	isLoopbackHost,
	normalizeHost,
	resolvePolicy,
} from "./security.js";

/** Extract the pathname from req.url without constructing a URL object. */
function pathnameOf(req) {
	const raw = req.url || "/";
	const q = raw.indexOf("?");
	return q === -1 ? raw : raw.slice(0, q);
}

/** Extract the raw query string (including the leading "?") from req.url. */
function searchOf(req) {
	const raw = req.url || "/";
	const qi = raw.indexOf("?");
	return qi === -1 ? "" : raw.slice(qi);
}

function sendError(res, status, message, extraHeaders = {}) {
	const payload = JSON.stringify({ error: message });
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Content-Length": Buffer.byteLength(payload),
		...extraHeaders,
	});
	res.end(payload);
}

/** Serve a file from public/, refusing anything that escapes the directory. */
function serveStatic(res, pathname) {
	let decoded;
	try {
		decoded = pathname === "/" ? "index.html" : decodeURIComponent(pathname);
	} catch {
		// Malformed percent-encoding must not throw out of the request handler.
		sendError(res, 400, "bad request");
		return;
	}
	if (decoded.includes("\0")) {
		sendError(res, 400, "bad request");
		return;
	}
	const rel = decoded.replace(/^\/+/, "");
	// Static assets are the UI's own files; nothing under a dot-directory belongs there.
	if (rel.split(/[\\/]/).some((segment) => segment.startsWith("."))) {
		sendError(res, 404, "not found");
		return;
	}
	const resolved = path.resolve(PUBLIC_DIR, rel);
	const root = path.resolve(PUBLIC_DIR);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		sendError(res, 403, "forbidden");
		return;
	}
	fs.stat(resolved, (err, stat) => {
		if (err || !stat.isFile()) {
			sendError(res, 404, "not found");
			return;
		}
		sendFile(res, resolved, stat);
	});
}

// Minimal stdout/stderr loggers: stderr only for errors and denials, so write directly.
const out = (line) => process.stdout.write(`${line}\n`);
const err = (line) => process.stderr.write(`${line}\n`);

// ------------------------------------------------------------------- policy ---
let policy;
try {
	policy = resolvePolicy(process.env);
} catch (error) {
	if (error instanceof PolicyError) {
		err(`pi-console: refusing to start: ${error.message}`);
		process.exit(2);
	}
	throw error;
}

// Filled in once the socket is bound (the port may be ephemeral). Empty means fail closed.
let authorities = new Set();

// ------------------------------------------------------------------ logging ---
// Denied requests are logged (method, path, status, reason, peer) so an operator can see
// probing. Only the path is logged, never the query string, headers or any credential.
// Set PI_CONSOLE_ACCESS_LOG=1 to log every request the same way.
const LOG_ALL = process.env.PI_CONSOLE_ACCESS_LOG === "1";
const DENY_LOG_LIMIT = 30; // lines per window; the rest are counted, not written
const DENY_LOG_WINDOW_MS = 10_000;
let denyWindowStart = 0;
let denyWindowCount = 0;
let denySuppressed = 0;

function safePath(pathname) {
	let text = String(pathname);
	// A client that put the token in the URL path must not get it copied into the log.
	if (policy.token) text = text.split(policy.token).join("[redacted]");
	return text.replace(/[^\x20-\x7e]/g, "?").slice(0, 120);
}

function logRequest(req, pathname, status, reason) {
	const line = `pi-console: ${req.method} ${safePath(pathname)} -> ${status}${reason ? ` (${reason})` : ""} from ${req.socket.remoteAddress || "?"}`;
	if (LOG_ALL && !reason) return out(line);
	if (!reason) return;
	const now = Date.now();
	if (now - denyWindowStart > DENY_LOG_WINDOW_MS) {
		if (denySuppressed > 0) err(`pi-console: ${denySuppressed} further denied request(s) not logged`);
		denyWindowStart = now;
		denyWindowCount = 0;
		denySuppressed = 0;
	}
	if (denyWindowCount++ < DENY_LOG_LIMIT) err(line);
	else denySuppressed++;
}

// ------------------------------------------------------------------- server ---
const server = http.createServer(async (req, res) => {
	const pathname = pathnameOf(req);
	const search = searchOf(req);
	const isApi = pathname.startsWith("/api/");
	applySecurityHeaders(res, { api: isApi });
	let denied = false;
	if (LOG_ALL) {
		res.on("finish", () => {
			if (!denied) logRequest(req, pathname, res.statusCode, null);
		});
	}

	if (!(req.url || "").startsWith("/")) {
		// Absolute-form or asterisk targets are not something this server serves.
		denied = true;
		logRequest(req, pathname, 400, "bad request target");
		return sendError(res, 400, "bad request");
	}

	const verdict = evaluateRequest(req, { pathname, authorities, policy });
	if (!verdict.ok) {
		denied = true;
		logRequest(req, pathname, verdict.status, verdict.code);
		return sendError(res, verdict.status, verdict.message, verdict.headers);
	}

	try {
		const handled = await handleApi(
			req,
			res,
			{ pathname, search },
			{ authMode: policy.auth },
		);
		if (handled) return;
	} catch (error) {
		return sendError(res, 500, String(error && error.message ? error.message : error));
	}
	if (req.method !== "GET" && req.method !== "HEAD") {
		return sendError(res, 405, "method not allowed", { Allow: "GET, HEAD" });
	}
	try {
		serveStatic(res, pathname);
	} catch (error) {
		// Defence in depth: a static-serving failure must never take the process down.
		if (!res.headersSent) {
			sendError(res, 500, String(error && error.message ? error.message : error));
		}
	}
});

// Slow or stalled request bodies must not hold sockets open indefinitely.
server.requestTimeout = 60_000;
server.headersTimeout = 30_000;

server.on("error", (error) => {
	err(`pi-console: server error: ${error && error.message ? error.message : error}`);
	process.exit(1);
});

ensureRuntimeDir();

/** True when the token file on disk is the one this process wrote (so it may remove it). */
let wroteTokenFile = false;

function writeTokenFile() {
	// Remove first and create exclusively with 0600 so a pre-planted file or symlink is not
	// followed and the file is never group/world readable, even for an instant.
	fs.rmSync(TOKEN_FILE, { force: true });
	fs.writeFileSync(TOKEN_FILE, `${policy.token}\n`, { mode: 0o600, flag: "wx" });
	wroteTokenFile = true;
}

function removeTokenFile() {
	if (!wroteTokenFile) return;
	try {
		if (constantTimeEqual(fs.readFileSync(TOKEN_FILE, "utf8").trim(), policy.token)) {
			fs.rmSync(TOKEN_FILE, { force: true });
		}
	} catch {
		/* already gone */
	}
}

function urlHost(host) {
	return host.includes(":") ? `[${host}]` : host;
}

server.listen(policy.port, policy.host, () => {
	const address = server.address();
	const port = address && typeof address === "object" ? address.port : policy.port;

	// Belt and braces: whatever the host name resolved to, a default (non-remote) start must
	// have ended up on a loopback interface.
	if (!policy.allowRemote && !isLoopbackHost(address.address)) {
		err(`pi-console: refusing to run: bound to non-loopback address ${address.address}`);
		server.close();
		process.exit(2);
	}

	authorities = buildAuthorities(policy, port);
	const scheme = "http" + "://";
	const base = `${scheme}${urlHost(policy.host === "0.0.0.0" || policy.host === "::" ? "127.0.0.1" : normalizeHost(policy.host))}:${port}`;
	out(`pi-console listening on ${scheme}${urlHost(policy.host)}:${port}`);

	for (const warning of policy.warnings) err(`pi-console: WARNING: ${warning}`);

	if (policy.auth === "off") {
		err("pi-console: !!!!!!!! AUTHENTICATION IS OFF (PI_CONSOLE_AUTH=off) !!!!!!!!");
		err("pi-console: anything that can reach this port can run shell commands as you. Development only.");
	} else if (policy.tokenSource === "generated") {
		// A generated token has to reach the operator without landing in a shared log: show it
		// only on an interactive terminal; otherwise leave it in an owner-only file.
		if (process.stdout.isTTY) {
			out(`pi-console: open ${base}/#token=${policy.token}`);
		} else {
			try {
				writeTokenFile();
				out(`pi-console: access token written to ${TOKEN_FILE} (owner-only); it is not logged`);
			} catch (error) {
				err(`pi-console: could not write the token file (${error && error.code ? error.code : "error"}); set PI_CONSOLE_TOKEN instead`);
				process.exit(2);
			}
		}
	} else {
		out(`pi-console: access token required (from ${policy.tokenSource === "env" ? "PI_CONSOLE_TOKEN" : "PI_CONSOLE_TOKEN_FILE"})`);
	}
});

// -------------------------------------------------------------- shutdown ---
let shuttingDown = false;

async function shutdown() {
	if (shuttingDown) return;
	shuttingDown = true;
	out("pi-console shutting down, stopping pi children...");
	// Last resort: never hang on a stuck child or connection.
	setTimeout(() => process.exit(0), 6000).unref?.();
	try {
		server.close(); // stop accepting; open connections are closed below
		closeAllStreams(); // end SSE responses (releases their tailer subscriptions and heartbeats)
		closeAllTailers(); // stop the session-file poll timers
		await killAll(); // SIGTERM, then SIGKILL for any pi child that ignores it
		server.closeAllConnections?.();
	} catch (error) {
		err(`pi-console: error during shutdown: ${error && error.message ? error.message : error}`);
	} finally {
		removeTokenFile();
		process.exit(0);
	}
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
