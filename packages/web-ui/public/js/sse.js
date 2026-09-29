// sse.js — subscribe to a session's server-sent event stream.
//
// The server emits three named events:
//   event: lifecycle  data: {sessionId, type:"lifecycle", state, code}
//   event: event      data: {sessionId, type:"event", data:<pi event>}      (live RPC child)
//   event: observed   data: {sessionId, type:"observed", data:<observed_*>}  (tailed CLI session)
//
// `observed` frames are how a session being run by another process (the CLI) appears here, so
// the listener below is essential — without it the browser silently drops every tailed message.
export class SessionStream {
	/**
	 * @param {string} sessionId
	 * @param {{onEvent?:Function, onLifecycle?:Function, onError?:Function}} handlers
	 */
	constructor(sessionId, handlers = {}) {
		this.sessionId = sessionId;
		this.handlers = handlers;
		this.source = null;
		this.closed = false;
	}

	open() {
		if (this.closed) return;
		const source = new EventSource(
			`/api/sessions/${encodeURIComponent(this.sessionId)}/events`,
		);
		this.source = source;

		const onPayload = (e) => {
			const payload = safeParse(e.data);
			if (payload && this.handlers.onEvent) this.handlers.onEvent(payload);
		};

		// Live events from a console-owned child, and tailed events from an external session.
		source.addEventListener("event", onPayload);
		source.addEventListener("observed", onPayload);

		source.addEventListener("lifecycle", (e) => {
			const payload = safeParse(e.data);
			if (payload && this.handlers.onLifecycle)
				this.handlers.onLifecycle(payload);
		});

		source.onerror = () => {
			// EventSource reconnects automatically; surface the hiccup but keep listening.
			if (this.handlers.onError)
				this.handlers.onError(new Error("stream disconnected"));
		};
	}

	close() {
		this.closed = true;
		if (this.source) {
			this.source.close();
			this.source = null;
		}
	}
}

function safeParse(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}
