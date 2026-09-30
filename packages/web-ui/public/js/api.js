// api.js — thin fetch wrappers around the pi-console REST API (relative paths only).
import { authHeaders } from "./auth.js";

let unauthorizedHandler = () => {};

/** Called whenever the server answers 401, so the app can ask for a fresh token. */
export function setUnauthorizedHandler(fn) {
	unauthorizedHandler = typeof fn === "function" ? fn : () => {};
}

export function notifyUnauthorized() {
	unauthorizedHandler();
}

async function request(method, path, body, { quiet401 = false } = {}) {
	const headers = { ...authHeaders() };
	// No cookies are used, so none are sent: another localhost service's cookies stay out of it.
	const options = { method, headers, cache: "no-store", credentials: "omit" };
	if (method !== "GET") {
		// The server requires JSON on every state-changing request, bodiless ones included.
		headers["Content-Type"] = "application/json";
		options.body = JSON.stringify(body === undefined ? {} : body);
	}
	const res = await fetch(path, options);
	const text = await res.text();
	let data = null;
	if (text) {
		try {
			data = JSON.parse(text);
		} catch {
			data = null;
		}
	}
	if (!res.ok) {
		if (res.status === 401 && !quiet401) notifyUnauthorized();
		const message = (data && data.error) || `request failed (${res.status})`;
		const error = new Error(message);
		error.status = res.status;
		throw error;
	}
	return data;
}

const enc = encodeURIComponent;

export const api = {
	health: () => request("GET", "/api/health"),
	// Validates the token currently held (or just typed) without triggering the 401 handler.
	authCheck: () => request("GET", "/api/auth", undefined, { quiet401: true }),
	config: () => request("GET", "/api/config"),
	prompts: () => request("GET", "/api/prompts"),
	skills: () => request("GET", "/api/skills"),
	models: () => request("GET", "/api/models"),
	cwds: () => request("GET", "/api/cwds"),

	agents: () => request("GET", "/api/agents"),
	agent: (name, source) =>
		request(
			"GET",
			`/api/agents/${enc(name)}${source ? `?source=${enc(source)}` : ""}`,
		),
	createAgent: (payload) => request("POST", "/api/agents", payload),
	updateAgent: (name, payload) =>
		request("PUT", `/api/agents/${enc(name)}`, payload),
	deleteAgent: (name, source) =>
		request(
			"DELETE",
			`/api/agents/${enc(name)}${source ? `?source=${enc(source)}` : ""}`,
		),

	sessions: () => request("GET", "/api/sessions"),
	session: (id) => request("GET", `/api/sessions/${enc(id)}`),
	sessionStats: (id) => request("GET", `/api/sessions/${enc(id)}/stats`),
	sessionTodos: (id) => request("GET", `/api/sessions/${enc(id)}/todos`),
	sessionLens: (id) => request("GET", `/api/sessions/${enc(id)}/lens`),

	createSession: (config) => request("POST", "/api/sessions", config),
	prompt: (id, message, streamingBehavior) =>
		request("POST", `/api/sessions/${enc(id)}/prompt`, {
			message,
			streamingBehavior,
		}),
	abort: (id) => request("POST", `/api/sessions/${enc(id)}/abort`),
	stop: (id) => request("DELETE", `/api/sessions/${enc(id)}`),
	setModel: (id, provider, modelId) =>
		request("POST", `/api/sessions/${enc(id)}/model`, { provider, modelId }),
	setThinking: (id, level) =>
		request("POST", `/api/sessions/${enc(id)}/thinking`, { level }),
	fork: (id, entryId) =>
		request("POST", `/api/sessions/${enc(id)}/fork`, { entryId }),
	newSessionInPlace: (id) => request("POST", `/api/sessions/${enc(id)}/new`),
};
