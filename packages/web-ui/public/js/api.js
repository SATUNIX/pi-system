// api.js — thin fetch wrappers around the pi-console REST API (relative paths only).
async function request(method, path, body) {
	const options = { method };
	if (body !== undefined) {
		options.headers = { "Content-Type": "application/json" };
		options.body = JSON.stringify(body);
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
		const message = (data && data.error) || `request failed (${res.status})`;
		throw new Error(message);
	}
	return data;
}

const enc = encodeURIComponent;

export const api = {
	health: () => request("GET", "/api/health"),
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
