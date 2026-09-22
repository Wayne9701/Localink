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
- 21 bounded ChatGPT-facing Workspace, Files, Process, registry and Skill tools;
- persistent local-admin Process policy, disabled by default;
- deterministic tests and portability checks.
- Localink-only versioned release artifacts, integrity validation, atomic
  current/previous activation, explicit rollback, and stable-prefix service
  installation context.

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

The active roadmap still needs live/integrated acceptance for:

- first migration of managed services from the development checkout to the
  stable Localink-owned install prefix;
- update/rollback dogfood against the live managed service topology;
- reboot, sleep/wake, network-switch, proxy, and ChatGPT Connector dogfood;
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
node packages/cli/dist/src/cli.js process policy --json
node packages/cli/dist/src/cli.js process enable --json
node packages/cli/dist/src/cli.js process disable --json
```

Workspace configuration defaults to `~/.localink/config/workspaces.json`.
`LOCALINK_STATE_ROOT` selects an isolated state root for tests or development.
Each runtime process loads configuration once; live service reload is deferred.

Public Process tools are disabled by default. `process enable` is a persistent
local-admin gate for host process execution. Localink uses `shell: false` and a
workspace-bound cwd, but that cwd boundary is not an OS sandbox: an executable
can still access resources outside the workspace. Public Process schemas do not
accept environment variables and children receive only a small non-sensitive
environment allowlist.

## Tool-surface principle

ChatGPT-facing deterministic tools should prefer sensible batching when operations naturally belong together, for example multi-file reads, bounded batch inspection and compound health checks.

Batching is an efficiency and UX optimization, not a reason to blur safety boundaries. Independent mutations, destructive actions and external side effects remain appropriately atomic and verifiable.

All real user state is stored outside the repository and is ignored by Git.

## Localink release administration

Release artifacts contain compiled Localink runtime packages plus their fixed
production dependency closure. They do not contain mutable state, config,
secrets, logs, compilers, or development dependencies. Installation is limited
to `~/.localink/app/**`, `~/.localink/bin/localink`, and the three managed
`com.localink.*` LaunchAgents.

```sh
node packages/cli/dist/src/cli.js release build <artifact-dir> <release-id> <full-source-commit> --json
node packages/cli/dist/src/cli.js release install <artifact-dir> --json
~/.localink/bin/localink release status --json
~/.localink/bin/localink release rollback --json
```

Install/update validates and stages the artifact before an atomic pointer
switch. A failed activation makes one bounded attempt to restore the prior
release and service definitions; a failed restore safe-stops rather than
retrying indefinitely. Rollback uses only already-installed releases and does
not require the source checkout or network.
