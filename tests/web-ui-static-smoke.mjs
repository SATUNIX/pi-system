#!/usr/bin/env node
// Offline regression smoke for web-ui static file streaming (finding F2).
// Verifies that an async read-stream error is turned into a 500 (before headers)
// or an aborted response (after piping), instead of an uncaught exception.
//
// NOTE: this must NOT import server.js — that module starts a listener.
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter, once } from "node:events";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.resolve(HERE, "../packages/web-ui/server/server.js");

let failed = false;

async function check(name, fn) {
	try {
		await fn();
		console.log(`  ok - ${name}`);
	} catch (error) {
		failed = true;
		console.error(`  not ok - ${name}`);
		console.error(error && error.stack ? error.stack : error);
	}
}

/** Minimal fake response built on a Writable. */
class FakeRes extends Writable {
	constructor() {
		super();
		this.statusCode = 0;
		this.headers = null;
		this.body = "";
		this.destroyedFlag = false;
	}
	writeHead(status, headers) {
		this.statusCode = status;
		this.headers = headers || null;
	}
	_write(chunk, _enc, cb) {
		this.body += chunk.toString();
		cb();
	}
	destroy() {
		this.destroyedFlag = true;
		return super.destroy();
	}
}

/** A Readable that pushes "hello" on its first read (and optionally ends). */
function helloStream({ end = false } = {}) {
	let sent = false;
	return new Readable({
		read() {
			if (sent) return;
			sent = true;
			this.push("hello");
			if (end) this.push(null);
		},
	});
}

try {
	const { sendFile } = await import(
		"../packages/web-ui/server/send-file.js"
	);

	// (a) open failure before headers: 500 + JSON body, no exception.
	await check("open failure yields 500 read failed", async () => {
		const res = new FakeRes();
		const emitter = new EventEmitter();
		const factory = () => emitter;
		assert.doesNotThrow(() => sendFile(res, "/x.css", { size: 5 }, factory));
		assert.doesNotThrow(() =>
			emitter.emit("error", new Error("boom")),
		);
		assert.equal(res.statusCode, 500);
		assert.ok(
			res.body.includes("read failed"),
			`body should mention read failed, got ${JSON.stringify(res.body)}`,
		);
	});

	// (b) success: open -> 200 + body streamed through.
	await check("success yields 200 and streamed body", async () => {
		const res = new FakeRes();
		const stream = helloStream({ end: true });
		const done = once(res, "finish");
		sendFile(res, "/a.css", { size: 5 }, () => stream);
		stream.emit("open");
		await done;
		assert.equal(res.statusCode, 200);
		assert.equal(res.headers["Content-Type"], "text/css; charset=utf-8");
		assert.equal(res.headers["Content-Length"], 5);
		assert.equal(res.body, "hello");
	});

	// (c) error after piping has begun aborts the response.
	await check("mid-stream error aborts the response", async () => {
		const res = new FakeRes();
		const stream = helloStream({ end: false });
		sendFile(res, "/a.css", { size: 5 }, () => stream);
		stream.emit("open");
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(res.body, "hello", "first chunk should have been written");
		assert.doesNotThrow(() =>
			stream.emit("error", new Error("mid-stream boom")),
		);
		assert.equal(res.destroyedFlag, true);
	});

	// (d) wiring guard: a revert of server.js to the raw pipe must be caught.
	await check("server.js imports ./send-file.js", async () => {
		const text = fs.readFileSync(SERVER_JS, "utf8");
		assert.ok(
			text.includes('"./send-file.js"'),
			"server.js must import ./send-file.js",
		);
		assert.ok(
			!text.includes("createReadStream"),
			"server.js must not create the read stream directly",
		);
	});
} finally {
	void 0;
}

if (failed) {
	console.error("web-ui-static smoke: FAIL");
	process.exit(1);
}
console.log("web-ui-static smoke: OK");
