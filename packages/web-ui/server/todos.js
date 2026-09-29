// todos.js — read the kit's per-session todo file (read-only).
// Storage: <cwd>/.pi/todos/<session-id>.md — see the kit's vendor/todo/todo-file.ts.
import * as fs from "node:fs";
import * as path from "node:path";

const ITEM_RE = /^\s*[-*]\s*\[( |x|X|~)\]\s*(.+?)\s*$/;
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function todoFilePath(cwd, sessionId) {
	if (process.env.PI_KIT_TODO_FILE) return process.env.PI_KIT_TODO_FILE;
	if (sessionId && SESSION_ID_RE.test(sessionId)) {
		return path.join(cwd, ".pi", "todos", `${sessionId}.md`);
	}
	return path.join(cwd, "TODO.md");
}

/** Parse a todo markdown file into items. Returns [] when absent or unreadable. */
export function readTodos(cwd, sessionId) {
	const file = todoFilePath(cwd, sessionId);
	if (!fs.existsSync(file)) return { file, exists: false, todos: [] };
	const todos = [];
	let id = 0;
	for (const line of fs.readFileSync(file, "utf8").split("\n")) {
		const match = ITEM_RE.exec(line);
		if (!match) continue;
		const mark = match[1].toLowerCase();
		const state = mark === "x" ? "done" : mark === "~" ? "active" : "open";
		todos.push({ id: ++id, text: match[2], state });
	}
	return { file, exists: true, todos };
}
