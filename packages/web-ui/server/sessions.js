// sessions.js — read-only discovery of pi's own session files.
// The web app NEVER writes these files; pi owns their lifecycle.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SESSIONS_DIR } from "./config.js";

const PREVIEW_LEN = 160;

function parseFirstLine(text) {
	const nl = text.indexOf("\n");
	const line = nl === -1 ? text : text.slice(0, nl);
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function summarizeMessages(text) {
	// Scan entries for the first user message to use as a preview.
	const lines = text.split("\n");
	let entryCount = 0;
	let preview = "";
	for (const line of lines) {
		if (!line.trim()) continue;
		entryCount++;
		if (preview) continue;
		let obj;
		try {
			obj = JSON.parse(line);
		} catch {
			continue;
		}
		if (!obj || typeof obj !== "object" || Array.isArray(obj)) continue;
		if (obj.type !== "message") continue;
		const msg = obj.message || {};
		if (msg.role !== "user") continue;
		const content = msg.content;
		if (typeof content === "string") preview = content;
		else if (Array.isArray(content)) {
			const textPart = content.find((p) => p && p.type === "text" && p.text);
			if (textPart) preview = textPart.text;
		}
	}
	return {
		entryCount,
		preview: preview.replace(/\s+/g, " ").trim().slice(0, PREVIEW_LEN),
	};
}

/** All pi session files, newest first. */
export function listSessions() {
	const sessions = [];
	let dirs = [];
	try {
		dirs = fs
			.readdirSync(SESSIONS_DIR, { withFileTypes: true })
			.filter((d) => d.isDirectory());
	} catch {
		return sessions;
	}
	for (const dir of dirs) {
		const dirPath = path.join(SESSIONS_DIR, dir.name);
		let files = [];
		try {
			files = fs.readdirSync(dirPath).filter((f) => f.endsWith(".jsonl"));
		} catch {
			continue;
		}
		for (const file of files) {
			const filePath = path.join(dirPath, file);
			try {
				const stat = fs.statSync(filePath);
				const text = fs.readFileSync(filePath, "utf8");
				const head = parseFirstLine(text) || {};
				const { entryCount, preview } = summarizeMessages(text);
				sessions.push({
					id: head.id || path.basename(file, ".jsonl"),
					cwd: head.cwd || null,
					sessionFile: filePath,
					startedAt: head.timestamp || null,
					endedAt: null,
					lastActivityAt: stat.mtime.toISOString(),
					entryCount,
					preview,
				});
			} catch {
				// unreadable file — skip
			}
		}
	}
	sessions.sort((a, b) =>
		String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)),
	);
	return sessions;
}

/** Distinct working directories seen in session records (plus the home dir). */
export function listCwds() {
	const set = new Set();
	for (const s of listSessions()) {
		if (s.cwd) set.add(s.cwd);
	}
	set.add(os.homedir());
	return [...set].sort();
}
