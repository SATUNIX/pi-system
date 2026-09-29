---
name: supply-chain-review
category: coding-workflow
description: Review dependency, image, and MCP server supply-chain risk. Use when adding or upgrading a dependency, base image, or MCP server, or before an install/build step from an untrusted source.
disable-model-invocation: true
triggers: ["add a dependency", "add a new dependency", "new dependency", "upgrade the dependency", "bump the dependency", "dependency upgrade", "supply chain", "supply-chain", "base image", "untrusted package"]
---

# Supply Chain Review

Use this skill for dependency or integration changes.

- Check pinned Pi, MCP adapter, image base, and package manager behavior.
- Avoid install scripts unless explicitly required and reviewed.
- Treat MCP servers as external software with their own trust boundary.
- Document version changes, review notes, and rollback path.
