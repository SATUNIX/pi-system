# LM Studio setup

Some extensions can use a second model for reviewer or sub-agent tasks. LM Studio is the recommended local model server for this.

## Basic setup

1. Download and install [LM Studio](https://lmstudio.ai)
2. Load a model (e.g. `Qwen2.5-Coder-7B-Instruct`)
3. Start the local server: **Local Server** tab → **Start Server** (default: `http://localhost:1234`)

## Configuring pi to use LM Studio

In your pi settings (`~/.pi/agent/settings.json` or `.pi/settings.json`):

```jsonc
{
  "providers": {
    "lmstudio": {
      "baseUrl": "http://localhost:1234/v1"
    }
  }
}
```

## dual-review with a second model

Set the `DUAL_REVIEW_MODEL` environment variable to the model name loaded in LM Studio:

```sh
# In ~/.pi/agent/.env
DUAL_REVIEW_MODEL=qwen2.5-coder-7b-instruct
```

The `dual-review` extension will route `/review` and `dual_review` tool calls to that model.

## Recommended models

| Use case | Model | Size |
|---|---|---|
| Reviewer (dual-review) | Qwen2.5-Coder-7B-Instruct | ~5 GB |
| Reviewer (faster) | Qwen2.5-Coder-3B-Instruct | ~2 GB |
| Subagent | Any code-capable model | — |

## Notes

- LM Studio must be running before starting pi with these extensions enabled
- The primary model (used for the main agent) is configured separately in pi's provider settings
- Verify connectivity: `curl http://localhost:1234/v1/models`
