// sse.js — subscribe to a session's server-sent event stream.
//
// The server emits three named events:
//   event: lifecycle  data: {sessionId, type:"lifecycle", state, code}
//   event: event      data: {sessionId, type:"event", data:<pi event>}      (live RPC child)
//   event: observed   data: {sessionId, type:"observed", data:<observed_*>}  (tailed CLI session)
//
// `observed` frames are how a session being run by another process (the CLI) appears here, so
// handling them is essential — without it the browser silently drops every tailed message.
//
// Transport: the stream is read with fetch() rather than EventSource. EventSource cannot set
// an Authorization header, and the alternatives (a token in the query string, or an ambient
// cookie) would leak the token into logs/history or be sent to other localhost origins. The
// wire format is unchanged, so this parser handles exactly what EventSource would.
import { authHeaders } from "./auth.js";
import { notifyUnauthorized } from "./api.js";

const RETRY_BASE_MS = 3000; // EventSource's own default reconnect delay
const RETRY_MAX_MS = 15000;

export class SessionStream {
	/**
	 * @param {string} sessionId
	 * @param {{onEvent?:Function, onLifecycle?:Function, onError?:Function}} handlers
	 */
	constructor(sessionId, handlers = {}) {
		this.sessionId = sessionId;
		this.handlers = handlers;
		this.controller = null;
		this.closed = false;
		this.running = false;
	}

	open() {
		if (this.closed || this.running) return;
		this.running = true;
		this._run();
	}

	close() {
		this.closed = true;
		if (this.controller) {
			this.controller.abort();
			this.controller = null;
		}
	}

	async _run() {
		const url = `/api/sessions/${encodeURIComponent(this.sessionId)}/events`;
		let failures = 0;
		while (!this.closed) {
			const controller = new AbortController();
			this.controller = controller;
			try {
				const res = await fetch(url, {
					headers: { Accept: "text/event-stream", ...authHeaders() },
					cache: "no-store",
					credentials: "omit",
					signal: controller.signal,
				});
				if (res.status === 401) {
					// Retrying with the same token cannot succeed: hand over to the login prompt.
					this.closed = true;
					notifyUnauthorized();
					return;
				}
				if (!res.ok || !res.body) throw new Error(`stream failed (${res.status})`);
				failures = 0;
				await this._read(res.body);
			} catch {
				/* fall through to the reconnect path unless we were closed on purpose */
			}
			if (this.closed) return;
			// EventSource reconnects automatically; do the same, surfacing the hiccup.
			if (this.handlers.onError) this.handlers.onError(new Error("stream disconnected"));
			const delay = Math.min(RETRY_BASE_MS * 2 ** Math.min(failures, 3), RETRY_MAX_MS);
			failures++;
			await new Promise((resolve) => setTimeout(resolve, delay));
		}
	}

	async _read(body) {
		const reader = body.getReader();
		const decoder = new TextDecoder("utf-8");
		let buffer = "";
		for (;;) {
			const { value, done } = await reader.read();
			if (done) return;
			buffer += decoder.decode(value, { stream: true });
			let boundary;
			while ((boundary = buffer.indexOf("\n\n")) !== -1) {
				const frame = parseFrame(buffer.slice(0, boundary));
				buffer = buffer.slice(boundary + 2);
				if (frame) this._dispatch(frame.event, frame.data);
			}
		}
	}

	_dispatch(event, data) {
		const payload = safeParse(data);
		if (!payload) return;
		if (event === "event" || event === "observed") {
			if (this.handlers.onEvent) this.handlers.onEvent(payload);
		} else if (event === "lifecycle") {
			if (this.handlers.onLifecycle) this.handlers.onLifecycle(payload);
		}
	}
}

/** Parse one SSE frame (text between blank lines); null for comment-only frames. */
export function parseFrame(text) {
	let event = "message";
	const data = [];
	for (const raw of text.split("\n")) {
		const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
		if (!line || line.startsWith(":")) continue;
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		let value = colon === -1 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") event = value;
		else if (field === "data") data.push(value);
	}
	return data.length ? { event, data: data.join("\n") } : null;
}

function safeParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
