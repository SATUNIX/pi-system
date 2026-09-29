// pi model entries for the run's models, from OpenRouter's model list. pi's built-in catalogue
// may not know a new model id; unknown ids fall back to a 128k context window and zero cost,
// which would compact too early and show no spend. The supervisor fetches the list on the host
// and writes the entries into the agent's models.json (through agent-state/run-models.json).

const perMillion = (v) => (Number.isFinite(Number(v)) ? +(Number(v) * 1e6).toFixed(6) : 0);

/** @param {object[]} list OpenRouter `data` array; @param {string[]} ids the run's model ids */
export function modelEntries(list, ids) {
  const byId = new Map((Array.isArray(list) ? list : []).map((m) => [m.id, m]));
  return ids.map((id) => {
    const m = byId.get(id);
    if (!m) return null;
    const params = new Set(m.supported_parameters ?? []);
    return {
      id,
      name: m.name ?? id,
      reasoning: params.has("reasoning"),
      input: (m.architecture?.input_modalities ?? ["text"]).includes("image") ? ["text", "image"] : ["text"],
      contextWindow: m.top_provider?.context_length ?? m.context_length ?? 128000,
      maxTokens: m.top_provider?.max_completion_tokens ?? 16384,
      cost: {
        input: perMillion(m.pricing?.prompt),
        output: perMillion(m.pricing?.completion),
        cacheRead: perMillion(m.pricing?.input_cache_read),
        cacheWrite: perMillion(m.pricing?.input_cache_write),
      },
    };
  }).filter(Boolean);
}

/** The agent's models.json: the openrouter provider pointed at the relay, with the run's models. */
export function agentModelsJson(entries) {
  return { providers: { openrouter: { baseUrl: "http://inference:8081/v1", apiKey: "relay", ...(entries.length ? { models: entries } : {}) } } };
}
