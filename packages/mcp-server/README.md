# Localink MCP transport

Product MCP over stdio and localhost Streamable HTTP. Both entrypoints create a
real, process-scoped `@localink/runtime` and load persistent workspace state.
The transport uses official MCP server / Node adapter / client **2.0.0**;
schema validation uses Zod **4.6.5**. Core and SDK V1 contracts are unchanged.

State defaults to `~/.localink`. Set `LOCALINK_STATE_ROOT` for isolated
development or tests. Runtime health never returns the state root or registered
workspace roots.

From the repository root:

```sh
npm ci
npm run build
```

## stdio development

For an MCP host, launch the entry directly (npm prints non-protocol banners):

```sh
node packages/mcp-server/dist/src/stdio.js
```

Use `node` as the host command and the entry path as its argument, with the
repository as cwd. stdout is protocol-only; errors use fixed, redacted stderr
messages. EOF, SIGINT and SIGTERM close the connection and runtime. The M1
public surface does not expose Files or Process tools.

## HTTP development

```sh
node packages/mcp-server/dist/src/http-entry.js
LOCALINK_MCP_HOST=127.0.0.1 LOCALINK_MCP_PORT=4318 node packages/mcp-server/dist/src/http-entry.js
```

Default endpoint: `http://127.0.0.1:4318/mcp`. Only `127.0.0.1` and `::1` are
accepted bind addresses. The actual endpoint is logged to stderr. The official
localhost Host/Origin guards run before the SDK handler. SIGINT/SIGTERM close
the handler, listener and runtime.

HTTP uses protocol **2026-07-28**, `createMcpHandler(factory)` and
`toNodeHandler`, with `legacy: 'reject'`. Every request creates a fresh MCP
server/adapter over one process-scoped runtime. Runtime state persists across
requests; caller context does not. There is no persistent MCP session and no
`Mcp-Session-Id` dependency.

## Public tools: exactly six

| Tool                           | Input / purpose                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------- |
| `localink.health_status`       | `{}`; real runtime readiness and bounded registry counts                         |
| `localink.capability_search`   | Optional `query` (256 characters), `limit` (1–50, default 20)                    |
| `localink.capability_describe` | `capabilityId`; projected V1 descriptor                                          |
| `localink.capability_invoke`   | `capabilityId`, JSON `input`; always invokes through Core                        |
| `localink.skill_search`        | Same bounded query/limit; Registry assets only                                   |
| `localink.skill_read`          | `skillId`, optional `maxBytes` (1–16384, default 8192); untrusted asset boundary |

M1 real runtime capability and Skill registries are intentionally empty. The
fixture runtime and synthetic invocation context exist only behind explicit
test entrypoints. They remain available for policy, identity, verification,
error, bounding and Skill-contract regression tests and are never selected by a
product entrypoint.

## Bounds and errors

Tool results contain matching JSON text and `structuredContent`. The default
result limit is 16 KiB, injectable from 1–64 KiB for library callers and tests.
Oversize data becomes a valid structural preview with explicit truncation byte
metadata. Serialized tool arguments are limited to 32 KiB after SDK decoding;
stdio's SDK read buffer is capped at 64 KiB.

Raw thrown messages, details, stacks and causes are discarded. Unknown tools
use `layer: mcp`, `code: UNKNOWN_TOOL`; domain failures use `layer: localink`.
Skill content remains an untrusted asset and is never executable authorization.

## Verification and scope

```sh
npm run check
# Targeted rerun after build:
npm run test:mcp
```

Tests require permission to bind localhost. No public network endpoint is
needed.

M1 includes **no Secure MCP Tunnel dogfood, live macOS Service, real
OAuth/Keychain, business Module, production Skill, or public Files/Process/Git
tools**. Workspace configuration persists for new runtime processes; long-lived
service hot reload and restart orchestration are deferred to M5.
