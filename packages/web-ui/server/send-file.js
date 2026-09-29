// send-file.js — stream a static file to an HTTP response with error handling.
import * as fs from "node:fs";
import * as path from "node:path";

const MIME = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".ico": "image/x-icon",
	".txt": "text/plain; charset=utf-8",
	".woff2": "font/woff2",
};

/**
 * Stream `filePath` to `res`, converting async read failures into responses
 * instead of uncaught exceptions.
 *
 * If the stream fails before headers are sent, reply 500. If it fails after the
 * body has started (settled), abort the response with res.destroy().
 */
export function sendFile(res, filePath, stat, createStream = fs.createReadStream) {
	const type =
		MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
	const stream = createStream(filePath);
	let settled = false;
	stream.once("error", () => {
		if (settled) {
			res.destroy();
			return;
		}
		settled = true;
		res.writeHead(500, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ error: "read failed" }));
	});
	stream.once("open", () => {
		settled = true;
		res.writeHead(200, { "Content-Type": type, "Content-Length": stat.size });
		stream.pipe(res);
	});
}
