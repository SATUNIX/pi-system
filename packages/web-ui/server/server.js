// server.js — pi-console entrypoint: HTTP server, static files, API delegation.
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import { HOST, PORT, PUBLIC_DIR, ensureRuntimeDir } from "./config.js";
import { handleApi } from "./routes.js";
import { killAll } from "./spawn.js";
import { sendFile } from "./send-file.js";

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

/** Serve a file from public/, refusing anything that escapes the directory. */
function serveStatic(res, pathname) {
	let decoded;
	try {
		decoded = pathname === "/" ? "index.html" : decodeURIComponent(pathname);
	} catch {
		// Malformed percent-encoding must not throw out of the request handler.
		res.writeHead(400, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "bad request" }));
		return;
	}
	const rel = decoded.replace(/^\/+/, "");
	const resolved = path.resolve(PUBLIC_DIR, rel);
	const root = path.resolve(PUBLIC_DIR);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		res.writeHead(403, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "forbidden" }));
		return;
	}
	fs.stat(resolved, (err, stat) => {
		if (err || !stat.isFile()) {
			res.writeHead(404, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "not found" }));
			return;
		}
		sendFile(res, resolved, stat);
	});
}

// Minimal stdout logger: the console rule only wants stderr for errors, so write directly.
const out = (line) => process.stdout.write(`${line}\n`);

const server = http.createServer(async (req, res) => {
	const pathname = pathnameOf(req);
	const search = searchOf(req);
	try {
		const handled = await handleApi(req, res, { pathname, search });
		if (handled) return;
	} catch (err) {
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({ error: String(err && err.message ? err.message : err) }),
		);
		return;
	}
	if (req.method !== "GET" && req.method !== "HEAD") {
		res.writeHead(405, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "method not allowed" }));
		return;
	}
	try {
		serveStatic(res, pathname);
	} catch (err) {
		// Defence in depth: a static-serving failure must never take the process down.
		if (!res.headersSent) {
			res.writeHead(500, { "Content-Type": "application/json" });
			res.end(
				JSON.stringify({
					error: String(err && err.message ? err.message : err),
				}),
			);
		}
	}
});

ensureRuntimeDir();

server.listen(PORT, HOST, () => {
	const scheme = "http" + "://";
	out(`pi-console listening on ${scheme}${HOST}:${PORT}`);
});

function shutdown() {
	out("pi-console shutting down, stopping pi children...");
	killAll();
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 2000).unref?.();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
