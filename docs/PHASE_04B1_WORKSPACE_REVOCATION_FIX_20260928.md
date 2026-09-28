# Localink Native Agent 04B1 Workspace revocation source closeout

Date: 2026-09-28

Status: `04B1_SOURCE_FIX_PASS / PRODUCTION_REACTIVATION_PENDING`

Scope: narrow Agent/runtime integration, public error mapping, and deterministic regression only. This closeout does not claim a new release build, Production activation or restart, repeated Host E2E, Fresh ChatGPT Web acceptance, or Codex Desktop acceptance.

## Baseline and reproduction

- Source baseline: `ca77a8b53d759067a50192a93394d32baa9ed010`.
- The deterministic reproduction made `turn/interrupt` emit the same expected App Server `SIGTERM` observed in Host E2E. Before the fix, the revoked task ended with `latestError=TASK_APP_SERVER_CRASH` instead of `WORKSPACE_AUTH_REVOKED`.
- A public-adapter reproduction returned `INTERNAL_ERROR` for an Agent `WORKSPACE_AUTH_REVOKED` error, matching the Host-facing failure.
- Both reproductions failed before the source change and pass after it.

## Root cause

1. `AgentManager.revokeWorkspace` persisted `revoked` before interrupting the active turn, but the App Server `onCrash` callback unconditionally classified the expected revocation shutdown as an ordinary crash. That callback could overwrite the explicit revocation reason and add a misleading `app_server_crash` diagnostic.
2. Agent entrypoints refreshed Agent configuration without first refreshing the Workspace Registry. A Workspace removed by an external admin runtime could therefore remain stale in the live runtime during `agent_show/list/wait`, delaying the live manager's revocation transition and leaving the observed task authorization as `authorized`.
3. `#authorizeTask` could move an already-revoked task back to `authorized` if a resolver later returned the same Workspace identity. Revocation was not monotonic.
4. The public Agent error allowlist omitted `WORKSPACE_AUTH_REVOKED`, so the explicit internal AgentError was sanitized to generic `INTERNAL_ERROR`.

## Fix

- Expected App Server termination after a task is marked revoked now follows the owned-session release path without applying generic crash state or diagnostics.
- A revoked task is terminally fail-closed for send/resume and approval authorization; it cannot be reauthorized by a later resolver result.
- `LocalinkRuntime.refreshAgents()` now refreshes Workspace configuration first, so every public Agent entrypoint observes external Workspace removal and invokes `AgentManager.revokeWorkspace` in the live runtime.
- The public adapter preserves the safe `WORKSPACE_AUTH_REVOKED` code and uses a fixed public message without exposing resolver or exception details.
- Existing per-task Worker ownership, capability isolation, terminal teardown, Desktop naming, archive reconciliation, wait bounds, exact-40 surface, and all non-Agent foundations remain unchanged.

## Exact files changed

- `packages/codex-agent/src/agent-manager.ts`
- `packages/codex-agent/test/agent-manager.test.ts`
- `packages/runtime/src/localink-runtime.ts`
- `packages/runtime/test/runtime.test.ts`
- `packages/mcp-server/src/public-adapter.ts`
- `packages/mcp-server/test/agent-tools.test.ts`

## Deterministic coverage

- Active Workspace revocation with an App Server crash callback during `turn/interrupt` now proves:
  - `workspaceAuthorizationStatus=revoked`;
  - `status=cancelled`;
  - `latestError=WORKSPACE_AUTH_REVOKED`;
  - no generic `app_server_crash` diagnostic;
  - `taskAppServerState=stopped`;
  - `officialSessionReleased=true`;
  - `repoWriterReleased=true`;
  - the owned session is closed.
- Send remains blocked with `WORKSPACE_AUTH_REVOKED` even when the fixture resolver still knows the old Workspace.
- Existing approval acceptance coverage returns `WORKSPACE_AUTH_REVOKED`; reject remains cleanup-safe.
- Show, list, and wait remain readable for the revoked durable task.
- Runtime coverage proves both direct `removeWorkspace` and external config removal followed by Agent refresh invoke live Workspace revocation.
- Public coverage proves start, send, and approve preserve `WORKSPACE_AUTH_REVOKED` without leaking private thrown messages.
- The public tool surface remains exactly 40.

## Validation receipts

- Focused Agent suite: 17/17 PASS.
- Focused runtime suite: 22/22 PASS.
- Focused MCP/public suite: 35/35 PASS, including exact-40 surface.
- Full host-capable `npm run check`: PASS, 200/200 tests:
  - Core 44
  - Agent 17
  - Runtime 22
  - CLI 21
  - Portability 5
  - MCP 35
  - Tunnel 12
  - Service 34
  - Release 10
- The first sandboxed focused runtime/MCP runs were blocked only by `listen EPERM: operation not permitted 127.0.0.1`. The unchanged host-capable reruns passed, and the complete host-capable check passed.

## Commit and CI

- Source fix commit: `b0c12a644d36a6bd16eb691aa3a6b10097823244` (`fix(agent): preserve workspace revocation state`).
- GitHub Actions: [run 36390779562](https://github.com/Wayne9701/Localink/actions/runs/36390779562) PASS.

## External continuation

No Production activation, restart, release switch, or Host mutation was performed from this Agent. A separately authorized Production continuation must build/install the new source release, perform exactly one controlled activation under the existing Production Isolation gate, and rerun the real Workspace revocation Host E2E before 04B final acceptance.

Final source verdict: `04B1_SOURCE_FIX_PASS / PRODUCTION_REACTIVATION_PENDING`.
