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

/**
 * The agent's models.json: the provider pointed at the relay, with the run's models. OpenRouter is
 * pi's built-in provider (overridden to point at the relay); any other OpenAI-compatible provider
 * is a custom provider called `relay`. The key is always the placeholder the relay replaces.
 */
export function agentModelsJson(entries, provider = "openrouter") {
  if (provider === "openrouter") return { providers: { openrouter: { baseUrl: "http://inference:8081/v1", apiKey: "relay", ...(entries.length ? { models: entries } : {}) } } };
  return { providers: { relay: { baseUrl: "http://inference:8081/v1", api: "openai-completions", apiKey: "relay", models: entries.length ? entries : [] } } };
}

/** Model entries for a provider that publishes no model list: only the ids (pi fills defaults), priced from the contract. */
export function plainModelEntries(ids, pricing = {}) {
  return ids.map((id) => ({ id, ...(pricing[id] ? { cost: { input: pricing[id].inputPerMTok, output: pricing[id].outputPerMTok, cacheRead: 0, cacheWrite: 0 } } : {}) }));
}
