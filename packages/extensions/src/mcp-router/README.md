# mcp-router

Stub. This extension does **not** route MCP tool calls or provide failover between MCP server
instances yet. On `session_start` it only notifies that it loaded as a stub, and its `tool_call`
hook is a no-op that returns `undefined`. Capability-, load-, and availability-based routing and
failover are planned but not implemented.
