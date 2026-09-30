# human-console

Provides the local file-backed approval and question broker used by attended sessions and headless subagents. Requests are stored beneath `.pi/human-console` by default; set `PI_KIT_HUMAN_CONSOLE_DIR` to override that location.

It registers `ask_human` for concise, concrete questions. Questions and approval requests time out safely when no attended session resolves them. That includes a question put to an interactive UI that never answers: without a `timeoutMs` of its own it gives up after `PI_KIT_HUMAN_CONSOLE_TIMEOUT_MS` (15 minutes by default) and returns "No human answered in time.", so nothing waits on a UI that is not there.

Pending requests live in `pending/` and answers in `resolved/`; both are removed once a request settles. A pending file that is malformed, has an unsafe id or has an unrecognised kind is quarantined as `<name>.json.invalid` for operator inspection rather than retried forever. That quarantine is capped at 50 files, oldest evicted first, so a repetitive bad producer cannot grow the directory without bound. The watcher tolerates an unusable pending path (for example a regular file where the directory belongs), reports it to stderr and keeps running, so it recovers once the path is usable again; a pending-scan failure is reported once per distinct error, and a single recovery line is logged when scanning resumes.
