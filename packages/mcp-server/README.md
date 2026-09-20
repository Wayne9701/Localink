# Localink MCP transport (Phase 1B-1)

Fixture-only MCP over stdio and localhost Streamable HTTP. Uses official MCP
server / Node adapter / client **2.0.0**; schema validation uses Zod **4.6.5**.
Core and SDK V1 contracts are unchanged.

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

Use `node` as the host's command and the entry path as its argument, with the
repository as cwd. stdout is protocol-only; errors use fixed, redacted stderr
messages. The official `serveStdio` owns the transport and supports the standard
initialize handshake as well as modern negotiation. EOF, SIGINT and SIGTERM close
the connection. This process does not create subprocesses.

## HTTP development

```sh
node packages/mcp-server/dist/src/http-entry.js
# Optional loopback address / port (0 requests an ephemeral development port):
LOCALINK_MCP_HOST=127.0.0.1 LOCALINK_MCP_PORT=4318 node packages/mcp-server/dist/src/http-entry.js
```

Default endpoint: `http://127.0.0.1:4318/mcp`. Only `127.0.0.1` and `::1` are
accepted bind addresses. The actual endpoint is logged to stderr. The official
localhost Host/Origin guards run before the SDK handler. SIGINT/SIGTERM close
the handler and listener; a library caller uses the idempotent `close()` handle.

HTTP uses **2026-07-28**, `createMcpHandler(factory)` and `toNodeHandler`, with
`legacy: 'reject'`. Every request creates a fresh MCP adapter, injected with the
one process-scoped Localink runtime. Registry and fixture application state
persist across requests. Caller context does not. There is no persistent MCP
session and no `Mcp-Session-Id` dependency.

The official v2 client defaults to legacy negotiation. Select the modern version
explicitly for this endpoint:

```ts
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

const client = new Client(
  { name: 'localink-dev', version: '1.0.0' },
  { versionNegotiation: { mode: { pin: '2026-07-28' } } },
);
await client.connect(
  new StreamableHTTPClientTransport(new URL('http://127.0.0.1:4318/mcp')),
);
const tools = await client.listTools();
await client.close();
```

For modern HTTP, `connect()` performs SDK discovery/negotiation, not a legacy
`initialize` wire message. No custom legacy HTTP branch is implemented.

## Public tools: exactly six

| Tool                           | Input / purpose                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `localink.health_status`       | `{}`; fixture module health and bounded in-memory state                              |
| `localink.capability_search`   | Optional `query` (256 characters), `limit` (1–50, default 20)                        |
| `localink.capability_describe` | `capabilityId`; projected V1 descriptor                                              |
| `localink.capability_invoke`   | `capabilityId`, JSON `input`, optional `fixtureContext`; always invokes through Core |
| `localink.skill_search`        | Same bounded query/limit; Registry assets only                                       |
| `localink.skill_read`          | `skillId`, optional `maxBytes` (1–16384, default 8192); `trust: untrusted-asset`     |

`fixtureContext` accepts only `policyProfile` (`open`, `balanced`, `strict`;
default balanced), synthetic identity `{id: 'alice' | 'bob', type: 'fixture-user'}`,
and up to two scopes from `fixture:read`, `fixture:write`. These test assertions
are **not authentication**. No credentials or policy overrides are accepted.
Only in-memory fixture capabilities are installed. A later authenticated runtime
must supply independently verified authority; do not attach real modules to this
fixture context surface.

Fixture capabilities: `fixture.read`, `fixture.write`, `fixture.external-send`,
`fixture.protected`, `fixture.identity`, `fixture.failure`, `fixture.unverified`.
They remain internal registry entries, never additional MCP tools. The read
fixture can request `rows` (0–4096) to exercise output bounding. Write takes
`{value: string}` (maximum 256 characters), changes memory and verifies read-back.

## Bounds and errors

Tool results contain matching JSON text and `structuredContent`:

```json
{
  "data": { "status": "executed" },
  "truncation": {
    "truncated": false,
    "originalBytes": 21,
    "returnedBytes": 21,
    "limitBytes": 16384
  }
}
```

The byte numbers above illustrate the envelope, not a complete invoke receipt.
Default result limit is 16 KiB, injectable from 1–64 KiB for library callers/tests.
The serializer measures the whole tool result including both content copies and
reserves 256 bytes for SDK metadata. Oversize data becomes a structural preview:
bounded object fields, array prefixes and Unicode string prefixes, with maximum
preview depth 8. If no preview fits, `data` is null. `truncated` must be checked
before consuming any preview as complete. Sizes refer to UTF-8 JSON data, not the
HTTP envelope. Encoded JSON is never sliced. Serialization failures become safe
tool errors. This is output bounding, not streaming or pagination.

Serialized tool arguments are limited to 32 KiB after SDK decoding; stdio's SDK
read buffer is capped at 64 KiB. The argument bound is not an HTTP body streaming
limit. Search `hasMore` and Skill's own `truncated` flag are separate from the
transport envelope's byte truncation.

Domain failures return `isError: true` and `data.error` with a stable code and
fixed message. Raw thrown messages, details, stacks and causes are discarded.
Unknown tools use `layer: mcp`, `code: UNKNOWN_TOOL`; domain failures use
`layer: localink`. Policy `confirmation_required` / `denied` are successful
business receipts (`isError: false`), with the original Core policy decision.
Core still enforces identity/scopes and required post-verification. Malformed
MCP/HTTP requests and connection errors remain SDK transport errors; stderr never
logs their raw thrown values. See [transport notes](../../docs/MCP_TRANSPORT_1B1.md).

## Verification and scope

```sh
npm run check
# Targeted rerun after build:
npm run test:mcp
```

Root `check` includes official-client stdio/HTTP E2E, isolation, bounding, errors,
EOF, and listener release. Tests require permission to bind localhost. No public
network endpoint is needed for tests.

Phase 1B-1 includes **no Secure MCP Tunnel, ChatGPT connection, macOS Service,
real OAuth/Keychain, business Module or production Skill**. There is no restart,
persistence or reconnection service. Closing/restarting a process resets fixture
application state. Request abort stops delivery but is not a rollback guarantee
for a Core handler already executing.
