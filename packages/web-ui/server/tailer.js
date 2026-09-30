// tailer.js — follow a session file written by ANOTHER pi process (e.g. the CLI).
//
// The console owns the sessions it spawns (streamed via RPC). A session running in the
// terminal is a different process, so the only live view of it is its own session file:
// pi appends JSONL entries as the turn progresses. We poll the file, parse the newly
// appended lines, and translate them into UI events.
//
// Emitted events are namespaced ("observed_*") so the renderer never double-renders them
// alongside the live RPC stream for sessions the console itself owns.
import * as fs from "node:fs";
import * as path from "node:path";

const POLL_MS = 700;
const MAX_REPLAY = 400;
const HISTORY_BYTES = 256 * 1024; // replay at most this much history when a viewer attaches

/** Translate one session JSONL entry into zero or more observed events. */
export function entryToEvents(entry) {
	if (!entry || typeof entry !== "object") return [];
	switch (entry.type) {
		case "message":
			return [
				{
					type: "observed_message",
					message: entry.message,
					timestamp: entry.timestamp,
				},
			];
		case "compaction":
			return [
				{
					type: "observed_compaction",
					summary: entry.summary,
					timestamp: entry.timestamp,
				},
			];
		case "model_change":
			return [
				{
					type: "observed_model_change",
					provider: entry.provider,
					modelId: entry.modelId,
				},
			];
		case "thinking_level_change":
			return [{ type: "observed_thinking_level", level: entry.thinkingLevel }];
		default:
			return [];
	}
}

export class SessionTailer {
	/** @param {string} sessionFile absolute path to the session jsonl file */
	constructor(sessionFile) {
		this.file = sessionFile;
		this.subscribers = new Set();
		this.replay = [];
		this.offset = 0;
		this.pending = ""; // bytes read but not yet newline-terminated
		this.timer = null;
		this.lastActivity = 0;
		this.closed = false;
	}

	/** Prime the offset so we replay only the recent tail, not the whole file. */
	prime() {
		try {
			// One open file: the size that decides how much to read is the size of the file that is read.
			const fd = fs.openSync(this.file, "r");
			let stat;
			let buffer = null;
			try {
				stat = fs.fstatSync(fd);
				this.offset = Math.max(0, stat.size - HISTORY_BYTES);
				this.lastActivity = stat.mtimeMs;
				// Replay recent history so an attaching viewer sees context.
				const length = stat.size - this.offset;
				if (length > 0) {
					buffer = Buffer.alloc(length);
					fs.readSync(fd, buffer, 0, length, this.offset);
				}
			} finally {
				fs.closeSync(fd);
			}
			if (buffer) {
				const lines = buffer.toString("utf8").split("\n");
				lines.shift(); // may be a partial line from the seek point
				for (const line of lines) {
					if (!line.trim()) continue;
					let entry;
					try {
						entry = JSON.parse(line);
					} catch {
						continue;
					}
					for (const event of entryToEvents(entry)) this._emit(event, false);
				}
			}
			this.offset = stat.size;
		} catch {
			this.offset = 0;
		}
	}

	start() {
		if (this.timer || this.closed) return;
		this.prime();
		this.timer = setInterval(() => this.poll(), POLL_MS);
		if (typeof this.timer.unref === "function") this.timer.unref();
		this.poll();
	}

	poll() {
		if (this.closed) return;
		// One open file: the size that decides how much to read is the size of the file that is read.
		let chunk = "";
		try {
			const fd = fs.openSync(this.file, "r");
			try {
				const stat = fs.fstatSync(fd);
				if (stat.size < this.offset) {
					this.offset = 0; // truncated or rotated
					this.pending = "";
				}
				if (stat.size === this.offset) return;
				const length = stat.size - this.offset;
				const buffer = Buffer.alloc(length);
				fs.readSync(fd, buffer, 0, length, this.offset);
				chunk = buffer.toString("utf8");
				this.offset = stat.size;
			} finally {
				fs.closeSync(fd);
			}
		} catch {
			return;
		}

		// A writer can be interrupted mid-line, so keep the unterminated tail and prepend it
		// to the next read instead of parsing (and losing) a half-written JSON entry.
		const text = this.pending + chunk;
		const lastNewline = text.lastIndexOf("\n");
		if (lastNewline === -1) {
			this.pending = text;
			return;
		}
		const complete = text.slice(0, lastNewline);
		this.pending = text.slice(lastNewline + 1);

		let sawEvent = false;
		for (const line of complete.split("\n")) {
			if (!line.trim()) continue;
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue; // partial trailing line; the next poll picks up the rest
			}
			for (const event of entryToEvents(entry)) {
				this._emit(event, true);
				sawEvent = true;
			}
		}
		if (sawEvent) {
			this.lastActivity = Date.now();
			this._emit(
				{ type: "observed_activity", at: this.lastActivity },
				true,
				true,
			);
		}
	}

	_emit(event, broadcast = true, skipReplay = false) {
		const message = { type: "observed", data: event };
		if (!skipReplay) {
			this.replay.push(message);
			if (this.replay.length > MAX_REPLAY) this.replay.shift();
		}
		if (!broadcast) return;
		for (const fn of this.subscribers) {
			try {
				fn(message);
			} catch {
				/* subscriber errors must not break the loop */
			}
		}
	}

	subscribe(fn) {
		this.subscribers.add(fn);
		for (const message of this.replay) {
			try {
				fn(message);
			} catch {
				/* ignore */
			}
		}
		return () => this.subscribers.delete(fn);
	}

	get watching() {
		return this.subscribers.size > 0;
	}

	/** True when the file changed very recently (an external process is likely active). */
	get recentlyActive() {
		try {
			return Date.now() - fs.statSync(this.file).mtimeMs < 20000;
		} catch {
			return false;
		}
	}

	close() {
		this.closed = true;
		if (this.timer) clearInterval(this.timer);
		this.timer = null;
		this.subscribers.clear();
	}
}

// One tailer per session file, shared by every connected viewer.
const tailers = new Map();

export function acquireTailer(sessionFile) {
	if (!sessionFile || !fs.existsSync(sessionFile)) return null;
	let tailer = tailers.get(sessionFile);
	if (!tailer) {
		tailer = new SessionTailer(path.resolve(sessionFile));
		tailers.set(sessionFile, tailer);
	}
	tailer.start();
	return tailer;
}

export function releaseTailer(sessionFile, unsubscribe) {
	if (typeof unsubscribe === "function") unsubscribe();
	const tailer = tailers.get(sessionFile);
	if (tailer && !tailer.watching) {
		// Keep it warm briefly so a page reload does not lose the tail; then stop.
		setTimeout(() => {
			const current = tailers.get(sessionFile);
			if (current && !current.watching) {
				current.close();
				tailers.delete(sessionFile);
			}
		}, 30000).unref?.();
	}
}

/** Stop every tailer's poll timer (shutdown). Idempotent. */
export function closeAllTailers() {
	for (const tailer of tailers.values()) tailer.close();
	tailers.clear();
}

export function isFileActive(sessionFile, windowMs = 20000) {
	try {
		return Date.now() - fs.statSync(sessionFile).mtimeMs < windowMs;
	} catch {
		return false;
	}
}
