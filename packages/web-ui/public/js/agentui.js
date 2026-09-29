// agentui.js — create / edit / delete agents from the web UI.
import { api } from "./api.js";
import { el } from "./render.js";

const $ = (id) => document.getElementById(id);

export class AgentEditor {
	/**
	 * @param {{tools?: string[], onSaved?: Function, toast?: Function}} options
	 */
	constructor(options = {}) {
		this.tools = options.tools || [];
		this.onSaved = options.onSaved || (() => {});
		this.toast = options.toast || (() => {});
		this.editing = null; // {name, source} of the record being edited
		this.cacheDom();
		this.wire();
	}

	cacheDom() {
		this.dialog = $("agent-dialog");
		this.form = $("agent-form");
		this.title = $("agent-dialog-title");
		this.name = $("a-name");
		this.source = $("a-source");
		this.description = $("a-description");
		this.model = $("a-model");
		this.toolsBox = $("a-tools");
		this.body = $("a-body");
		this.error = $("agent-error");
		this.save = $("agent-save");
		this.remove = $("agent-delete");
	}

	wire() {
		this.form.addEventListener("submit", (event) => {
			event.preventDefault();
			this.submit();
		});
		this.remove.addEventListener("click", () => this.deleteCurrent());
		for (const button of document.querySelectorAll(
			'[data-close-dialog="agent-dialog"]',
		)) {
			button.addEventListener("click", () => this.dialog.close());
		}
	}

	renderToolPicker(selected) {
		this.toolsBox.replaceChildren();
		const chosen = new Set(selected || []);
		for (const tool of this.tools) {
			const input = el("input", { type: "checkbox", value: tool });
			input.checked = chosen.has(tool);
			const label = el(
				"label",
				{ class: `tool-opt${input.checked ? " is-on" : ""}` },
				[input, el("span", { text: tool })],
			);
			input.addEventListener("change", () =>
				label.classList.toggle("is-on", input.checked),
			);
			this.toolsBox.append(label);
		}
	}

	selectedTools() {
		return [...this.toolsBox.querySelectorAll("input:checked")].map(
			(i) => i.value,
		);
	}

	showError(message) {
		this.error.textContent = message;
		this.error.hidden = false;
	}

	clearError() {
		this.error.hidden = true;
	}

	/** Open for a new agent, or for editing an existing record (full object with body). */
	async open(agent, tools) {
		if (tools && tools.length) this.tools = tools;
		this.clearError();
		if (agent) {
			const full =
				agent.body !== undefined
					? agent
					: await api.agent(agent.name, agent.source);
			const record = full.agent || full;
			this.editing = { name: record.name, source: record.source };
			this.title.textContent = `Edit agent — ${record.name}`;
			this.name.value = record.name;
			this.source.value = record.source;
			this.description.value = record.description || "";
			this.model.value = record.model || "";
			this.body.value = record.body || "";
			this.renderToolPicker(record.tools || []);
			this.remove.hidden = false;
		} else {
			this.editing = null;
			this.title.textContent = "New agent";
			this.name.value = "";
			this.source.value = "user";
			this.description.value = "";
			this.model.value = "";
			this.body.value = "";
			this.renderToolPicker([]);
			this.remove.hidden = true;
		}
		if (!this.toolsBox.children.length) this.renderToolPicker([]);
		this.dialog.showModal();
	}

	payload() {
		return {
			name: this.name.value.trim(),
			description: this.description.value.trim(),
			tools: this.selectedTools(),
			model: this.model.value.trim() || undefined,
			body: this.body.value,
			source: this.source.value,
		};
	}

	async submit() {
		this.clearError();
		const payload = this.payload();
		if (!payload.name) return this.showError("name is required");
		this.save.disabled = true;
		try {
			if (this.editing) {
				await api.updateAgent(this.editing.name, payload);
				this.toast(`agent updated: ${payload.name}`);
			} else {
				await api.createAgent(payload);
				this.toast(`agent created: ${payload.name}`);
			}
			this.dialog.close();
			await this.onSaved();
		} catch (err) {
			this.showError(err.message);
		} finally {
			this.save.disabled = false;
		}
	}

	async deleteCurrent() {
		if (!this.editing) return;
		const { name, source } = this.editing;
		if (
			!window.confirm(
				`Delete agent "${name}" (${source})? This removes its .md file.`,
			)
		)
			return;
		try {
			await api.deleteAgent(name, source);
			this.toast(`agent deleted: ${name}`);
			this.dialog.close();
			await this.onSaved();
		} catch (err) {
			this.showError(err.message);
		}
	}
}
