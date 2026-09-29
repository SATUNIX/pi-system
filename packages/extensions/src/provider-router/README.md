# provider-router

Opt-in model routing. When `PI_KIT_ROUTING_POLICY` is set, this extension calls `pi.setModel()` from
`before_agent_start` to switch between two operator-configured models — `hot_path_model` and
`strong_model` — chosen by the task class recorded for the current input. With no policy set it is
a no-op and never touches whatever model the operator has already configured. It does not select
providers by cost or availability, and it does not manage local model runtimes or endpoints.

Point `PI_KIT_ROUTING_POLICY` at a JSON file with `hot_path_model`, `strong_model`, and
(optionally) `trigger_task_types` to enable routing.

`hot_path_model` and `strong_model` may be either an unqualified model id (`small`) or a
provider-qualified name (`provider/id`). A provider-qualified name must resolve within that
provider; if it does not, routing notifies the operator and keeps the current model rather
than switching. The id-only fallback (matching any provider by id) applies only to unqualified
names, so a provider-qualified miss can never silently cross providers.
