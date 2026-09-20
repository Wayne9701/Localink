# Localink

Localink is a local-first AI tool runtime focused on giving ChatGPT Web controlled local execution capabilities while remaining independently customizable.

## Current foundation

Implemented and retained:

- workspace authority;
- bounded file operations and search;
- pipe-mode process lifecycle;
- config, policy, secrets, capability and skill contracts;
- MCP stdio / HTTP transport;
- OpenAI Secure MCP Tunnel adapter foundation;
- macOS service / recovery foundation;
- process-scoped real runtime assembly;
- persistent workspace identity shared by CLI and MCP product entrypoints;
- deterministic tests and portability checks.

Platform integrations such as Lark, BigQuery and Bilibili are external Shared MCP assets. Localink may bridge them for ChatGPT, but does not own or reimplement their platform business logic.

Shared Skills are also external assets. Localink may discover/read them without owning their content.

## Requirements

- Node.js 22 or newer
- npm 10 or newer

## Verify

```sh
npm ci
npm run check
```

## Current gaps before MVP

The active roadmap still needs design/implementation for:

- Git basics;
- compound doctor;
- lightweight External MCP Bridge;
- Shared Skill adapter;
- live service + tunnel dogfood;
- Localink-only installer/update/rollback;
- optional Codex invocation / Agent lifecycle.

PTY, browser/UI automation and richer process features are demand-driven rather than automatic Phase 1 requirements.

## Development CLI

```sh
npm run build
node packages/cli/dist/src/cli.js core self-test --json
node packages/cli/dist/src/cli.js runtime health --json
node packages/cli/dist/src/cli.js workspace add <name> <absolute-root> --json
node packages/cli/dist/src/cli.js workspace list --json
node packages/cli/dist/src/cli.js workspace inspect <id> --json
node packages/cli/dist/src/cli.js workspace remove <id> --json
```

Workspace configuration defaults to `~/.localink/config/workspaces.json`.
`LOCALINK_STATE_ROOT` selects an isolated state root for tests or development.
Each runtime process loads configuration once; live service reload is deferred.

## Tool-surface principle

ChatGPT-facing deterministic tools should prefer sensible batching when operations naturally belong together, for example multi-file reads, bounded batch inspection and compound health checks.

Batching is an efficiency and UX optimization, not a reason to blur safety boundaries. Independent mutations, destructive actions and external side effects remain appropriately atomic and verifiable.

All real user state is stored outside the repository and is ignored by Git.
