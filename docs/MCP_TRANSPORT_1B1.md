# MCP transport 1B-1

This fixture package adapts frozen Core V1 without changing its safety semantics.
The implementation is confined to `packages/mcp-server` and root build/check
wiring. There is no business platform logic.

## Architecture and protocol choice

`createFixtureRuntime()` creates Module/Capability/Skill registries once per
process. `createPublicServer(runtime)` creates an official `McpServer` plus a
transport-neutral `PublicAdapter`. The SDK registers and advertises six tools;
its `tools/call` handler routes to the shared adapter so validation errors,
unknown names and successful calls all use the same result boundary. The SDK
owns request decoding, framing, protocol negotiation and result encoding.

stdio uses official `serveStdio` and `StdioServerTransport`. It supports the
original initialize flow and modern discovery through the SDK. HTTP uses only
the v2 **2026-07-28** `createMcpHandler` / `toNodeHandler` path and rejects legacy
traffic. The factory allocates a fresh adapter for each HTTP request, closing
over the same application runtime. No request metadata or caller context is
cached in that runtime. The local library's `adaptersCreated` diagnostic counts
factory calls for E2E; it is not a public MCP tool or a session identifier.

The official client must opt into modern negotiation: its default is legacy.
On modern HTTP, client `connect()` is the initialization API, and its wire
exchange is `server/discover`. Tests assert the resulting protocol revision,
headers, exact public schema and no session-header dependence.

References used for the implementation:

- [Official SDK repository](https://github.com/modelcontextprotocol/typescript-sdk)
- [HTTP factory and Node mounting](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/http.md)
- [Application state versus legacy sessions](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/sessions-state-scaling.md)

Installed packages are exact-pinned: server/node **2.0.0** and Zod **4.6.5** in
production; client **2.0.0** only for development/tests. The Node adapter's own
transitive HTTP conversion dependencies are SDK dependencies; Localink adds no
web framework. Existing development dependency versions remain unchanged.

## Error and decision mapping

| Condition                                      | Public outcome                                               |
| ---------------------------------------------- | ------------------------------------------------------------ |
| Invalid schema/input                           | `isError: true`, `INVALID_ARGUMENT`                          |
| Tool arguments over 32 KiB                     | `SIZE_LIMIT_EXCEEDED`                                        |
| Unknown tool                                   | `UNKNOWN_TOOL`, layer `mcp`                                  |
| Capability/Skill missing                       | `CAPABILITY_NOT_FOUND` / `SKILL_NOT_FOUND`                   |
| Missing identity or scopes                     | `IDENTITY_REQUIRED` / `SCOPE_REQUIRED`                       |
| Tier 2 balanced / Tier 1 strict                | `confirmation_required` Core receipt, handler not executed   |
| Tier 3 (including open profile)                | `denied` Core receipt, handler not executed                  |
| Required verification absent                   | `VERIFICATION_REQUIRED`, no success receipt                  |
| Handler failure                                | `CAPABILITY_UNAVAILABLE`, reason `CAPABILITY_HANDLER_FAILED` |
| Other unexpected runtime/serialization failure | `INTERNAL_ERROR`, fixed message                              |
| Oversized result                               | Valid JSON structural preview and truncation byte metadata   |
| Invalid HTTP/MCP / unsupported legacy protocol | Official SDK transport rejection                             |
| Closed/aborted connection                      | SDK client transport error; other requests remain usable     |

No thrown object's raw details are public, even for `LocalinkError`. Descriptors
are projected to V1 metadata fields; registry handlers and runtime extensions
are excluded. Skill content is an untrusted text asset, never an instruction to
the transport or executable script.

## Safety and acceptance boundaries

Fixture context is deliberately synthetic and limited. It only exercises the
frozen `CapabilityRegistry.invoke()` policy → availability → handler → required
postVerify path. Transport input validation precedes invoke, but transport never
calls a capability handler directly or substitutes its own policy decision.

Loopback bind is enforced even for programmatic config. SDK localhost Host and
Origin guards run before request processing. HTTP close first stops accepting
connections, closes the SDK handler, then closes remaining HTTP connections.
Tests rebind the same port after shutdown. No global process/network discovery
is performed.

Result limits apply to tool results, not raw HTTP body consumption or arbitrary
resource use by a future module. Core V1 has no transport cancellation parameter:
aborting a request is not transaction rollback. Tests release a deliberately
blocked fixture read and verify the other client remains available. Real auth,
module integration, tunnel access, service recovery and deployment are outside
this phase.
