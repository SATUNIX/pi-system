# web-console

`/console` (alias `/webui`) — start, stop and check the bundled **Pi Console** web UI
that ships in [`packages/web-ui`](../../web-ui).

The command does one thing: launch the existing zero-dependency server
(`packages/web-ui/server/server.js`) as a detached Node process and report its URL. It does
not proxy sessions itself, never writes Pi session files, and changes no other extension's
behaviour.

## Usage

```
/console            # start (default) and print the URL
/console open       # start if needed, then open it in a browser
/console status     # report running/not reachable, pid and root
/console stop       # stop the server this command started
```

`start` treats the health endpoint as the source of truth: a live pid file alone never makes it
report "already running". If the configured host/port does not answer `/api/health`, it spawns a
fresh server (overwriting the pid file), unless the pid file names a live console process that has
stopped responding; then it says so instead of starting a second server on the same port.

`stop` only signals the pid when it is the console. On Linux that is checked from the process
command line (`/proc/<pid>/cmdline` must name this web UI's `server/server.js`), so a hung console
is stopped and a pid the OS has reused for an unrelated process is not. Where the command line
cannot be read, the console must answer its health endpoint.

## Resolution

`packages/web-ui` is located in this order:

1. `PI_KIT_WEBUI_ROOT` (explicit override)
2. relative to this extension (`<root>/packages/extensions/src/web-console` → `<root>/packages/web-ui`)
3. the checkout recorded in `~/.pi/agent/.pi-kit.json`

Generated npm surfaces do not ship the web UI, so the command reports that clearly instead of
guessing.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_KIT_WEBUI_ROOT` | auto | explicit path to `packages/web-ui` |
| `PI_CONSOLE_HOST` | `127.0.0.1` | server bind address (keep on loopback) |
| `PI_CONSOLE_PORT` | `8123` | server port |

## Security

The Pi Console server binds to **loopback only** and has **no authentication**. Do not expose it
to a network. The server's own runtime state (pid file, log) lives in
`packages/web-ui/.runtime/`.
