# PHASE 04C｜Codex-Native Capability Inheritance｜2026-09-28

Status: `04C_SOURCE_PASS / PRODUCTION_ACTIVATION_PENDING`

## 1. Why 04C exists

04B/04B1 correctly solved Localink Native Agent lifecycle ownership by moving to one task-owned Codex App Server per Agent and tearing that Worker down before releasing the repository writer. However, the 04B capability profile also disabled every configured external MCP plus Apps/Browser/Computer Use. That coupled two unrelated concerns:

- resource/session lifecycle;
- what a normal Codex Agent is allowed to use.

04C separates them. Localink now governs the Codex Agent lifecycle and Workspace authority while Codex keeps its own effective capability configuration.

## 2. Final capability model

New tasks use `capabilityProfile=codex-native-v1`.

The Worker:

- uses the same Codex executable, CODEX_HOME, auth identity, user config and project config;
- does not force `plugins/apps/computer_use/browser_use` feature flags off;
- does not disable ordinary configured MCP servers;
- does not force-enable MCP servers that Codex config has disabled;
- enumerates configured MCP server names only, without retaining command/URL/env/token material;
- applies a launch override only when a configured server matches Localink's recursion/conflict denylist.

Current recursion denylist:

- `engineering-bridge`

This prevents `Localink Agent -> Codex -> Engineering Bridge -> another Codex` recursion while preserving normal Codex capabilities such as BigQuery, Lark Shared, Apple Reporting, Bilibili, Local Image, Singular, WeChat, node_repl/cua_repl and future non-conflicting Codex capabilities according to Codex's own config.

Persisted `workspace-dev-v1` tasks remain readable for history compatibility.

## 3. MCP elicitation

04B1 treated every `mcpServer/elicitation/request` as a capability violation. 04C follows the official App Server typed request/response contract.

When Codex core cannot resolve an elicitation internally, Localink persists one bounded exact `pendingInteraction` and exposes:

`localink.agent_interact`

The public action is bound to:

- one owned `agentRef`;
- one opaque `interactionRequestId`;
- the original server-provided mode, URL and form schema.

Supported actions are `accept / decline / cancel`.

Safety constraints:

- the caller cannot substitute the MCP server or URL;
- form input is validated against a bounded primitive schema subset;
- unknown/stale interactions fail closed;
- accepted interactions revalidate Workspace authorization;
- revoked Workspace cannot accept an interaction;
- decline/cancel remain cleanup-safe;
- restart never recreates a live request handle; any persisted diagnostic is non-actionable;
- Localink does not become a parallel permission authority or expand Codex sandbox/network/root permissions.

Codex core remains responsible for its own Guardian/strict auto-review path before an unresolved elicitation reaches Localink.

## 4. Public surface

Localink public MCP surface changes from 40 to 41 tools.

The only new tool is:

- `localink.agent_interact`

Existing Agent tools and all non-Agent Localink tools keep their previous contracts.

## 5. Lifecycle guarantees preserved

04C keeps all accepted 04B1 behavior:

- one App Server per active Agent task;
- durable task inventory;
- auto / inline / detached supervision;
- bounded wait;
- same-repository single-writer protection;
- terminal persistence before teardown;
- task App Server/process-tree teardown before writer release;
- `officialSessionReleased` and `repoWriterReleased` separation;
- unarchived terminal thread history;
- `[Localink] <task title>` Desktop naming;
- external archive/unarchive reconciliation;
- restart normalization;
- Workspace revocation -> cancelled/interrupted + `WORKSPACE_AUTH_REVOKED`;
- Process policy unchanged;
- no secret material persisted by capability projection.

## 6. Deterministic acceptance

Source baseline before 04C:

`50aa120af76f1e0a9a638974824a31bd77bedd22`

Validation completed on the 04C worktree:

- build: PASS
- typecheck: PASS
- ESLint: PASS
- Prettier: PASS
- Core: 44/44 PASS
- Agent: 23/23 PASS
- Runtime: 22/22 PASS
- CLI: 21/21 PASS
- Portability: 5/5 PASS
- MCP: 35/35 PASS
- Tunnel: 12/12 PASS
- Service: 34/34 PASS
- Release: 10/10 PASS

Total test cases across the package suites above: 206 PASS.

Additional 04C Agent coverage includes:

- normal MCP inheritance with only Engineering Bridge denied;
- no incomplete deny override when Engineering Bridge is absent;
- no forced Apps/Browser/Computer Use disable flags;
- secrets/commands/URLs not retained by names-only projection;
- MCP form elicitation exact binding and schema validation;
- MCP URL elicitation exact URL preservation;
- stale interaction replay refusal;
- Workspace revoke blocks interaction acceptance;
- restart makes persisted interaction non-actionable;
- legacy `workspace-dev-v1` history compatibility;
- ten sequential terminal task teardown regression.

## 7. Source closeout

Production has not been changed by this source phase.

Required next steps are external/model-free:

1. commit and push the 04C source;
2. GitHub CI PASS;
3. build one Localink release artifact under `AI_OS/workflow/Localink/artifacts/`;
4. one controlled Production activation;
5. Host E2E proving the Localink-launched Codex Agent itself can use a normal inherited external MCP such as BigQuery while Engineering Bridge remains unavailable;
6. verify full-capability task teardown and no runtime accumulation;
7. recheck Workspace revocation and Desktop history.

Final source state:

`04C_SOURCE_PASS / PRODUCTION_ACTIVATION_PENDING`
