# Localink Native Agent 04B source closeout

Date: 2026-09-28

Scope: source implementation and deterministic regression only. This document does not claim release installation, Production activation, Host E2E, Fresh ChatGPT Web acceptance, or Codex Desktop human acceptance.

## Phase A feasibility

- Baseline source was clean at `49b1557970ce1e7f1388a62bced51dced0b4544b`.
- Installed runtime was `codex-cli 0.147.0`.
- The hard isolation boundary is 0 ambient external Shared MCP in the default `workspace-dev-v1` profile. `SkyComputerUseClient` is a Codex-internal runtime helper, not a configured external Shared MCP server, and is evaluated separately.
- Before every task or metadata process launch, the launch projection freshly applies installed stable disables for plugins, apps, Computer Use, Browser, external Browser, full-CDP Browser, and in-app Browser, then disables every currently configured MCP name enumerated through the official non-starting `codex mcp list` path. The projection is not cached across task launches, and the default v1 allowlist is empty.
- One bounded real App Server probe enumerated all 10 configured external MCP servers, supplied 10 disable overrides, and received official `mcpServerStatus/list` readback with 0 exposed tools for every server. Engineering Bridge was present only as a disabled configuration entry with 0 tools.
- The same probe read back all seven relevant installed feature flags as `stable / false`. A real task explicitly asked to use Browser or Computer Use if available; it emitted no Browser, Computer, or MCP tool item and returned exactly `BROWSER_COMPUTER_NOT_AVAILABLE`.
- During that real turn, one `SkyComputerUseClient` process appeared inside the task-owned process group. It was not advertised or usable by the task, and the owned process group read back as 0 processes after Worker teardown. Diagnostic: `CODEX_INTERNAL_RUNTIME_TRANSIENT`.
- The probe preserved effective `:workspace / on-request / auto_review` permissions under the same `CODEX_HOME` and auth identity.
- The names-only streaming parser retains only the first table column. Commands, arguments, URLs, environment values, auth material, and other secret-bearing columns are discarded and are never returned, logged, or persisted by Localink.
- Safe explicit single-MCP allowlisting would add a new remote authority surface. Source closeout therefore ships default deny-all v1; a controlled Localink-admin allowlist remains follow-up work rather than weakening the local gate.

Phase A verdict: `CAPABILITY_ISOLATION_FEASIBLE`.

## Phase B implementation

- Replaced the shared managed App Server with one task-owned App Server session per active Agent.
- Added process-group ownership, graceful teardown, bounded force termination, and post-exit verification.
- Split observable lifecycle state into task, turn, repository writer, task App Server, official session, official thread load, archive, Desktop history, Workspace authorization, capability profile, and diagnostics fields. `writerReleased` remains only as an explicitly deprecated derived alias.
- Persisted terminal state before teardown. A teardown failure leaves `release_pending`, `officialSessionReleased=false`, and the same-repository writer lock held.
- Kept completed threads unarchived. `agent_archive` is a governance action restricted to released terminal tasks.
- Set the official thread display name to `[Localink] <task title>` while retaining the existing `Localink Agents` backend section.
- Added state-DB-only lazy official reconciliation for recent and terminal tasks, including external archive/unarchive changes, without reloading task runtime.
- Added Workspace authorization generation, canonical root/cwd/repository readback, and fail-closed revalidation before start, send/resume, and approval acceptance.
- Connected Workspace removal/config revocation to active-turn interruption and owned-session teardown. Read-only inspection and cleanup operations remain available after revocation.
- Added restart normalization: persisted running state is never trusted as live; a persisted owned process group is terminated and verified before release, and an unattachable task is retained as recoverable `unknown` rather than duplicated.
- Preserved the nine public Agent tools, exact 40-tool public surface, `inline / auto / detached`, default 8-second and hard 15-second wait bounds, `:workspace / on-request / auto_review`, and the existing non-Agent architecture.

## Deterministic acceptance covered

The focused suite covers:

1. per-task session start, terminal persistence, teardown, and release;
2. different repositories running in parallel;
3. same-repository writer lock held until process exit;
4. teardown failure retaining the lock;
5. deny-all ambient MCP projection and stable feature disables;
6. recovery-only Engineering Bridge exclusion;
7. Workspace revocation blocking send/resume and approval acceptance;
8. active Workspace revocation interrupting and tearing down;
9. external archive/unarchive reconciliation;
10. restart fake-running normalization without task duplication;
11. 8/15-second wait contract;
12. archive restricted to released terminal tasks;
13. secret-bearing enumeration columns not surviving projection;
14. ten sequential terminal tasks each closing exactly one task session without deterministic session accumulation;
15. unchanged exact-40 public surface and non-Agent regression suites.

## Source validation receipts

- Pre-edit inherited-worktree baseline: `npm run build && npm run test:agent` — PASS, 16/16 Agent tests.
- Final focused validation: `npm run build && npm run test:agent` — PASS, 17/17 Agent tests.
- Full validation: `npm run check` — PASS in the host-capable context, including build, typecheck, lint, format check, and 198/198 tests: Core 44, Agent 17, Runtime 21, CLI 21, Portability 5, MCP 34, Tunnel 12, Service 34, Release 10.
- The first sandboxed full-check attempt reached Runtime and was blocked only by `listen EPERM: operation not permitted 127.0.0.1` for three loopback fixtures. The unchanged host-capable rerun passed all Runtime tests and the complete check.

Source verdict: `04B_SOURCE_CLOSEOUT_PASS / EXTERNAL_ACTIVATION_AND_HOST_E2E_PENDING`.

## Required external continuation

After this source commit and GitHub CI pass, a separate authorized Agent must perform the existing Production Isolation release flow and exactly one controlled activation. Then Host E2E must prove short-task release, detached continuation, real child-process capability isolation, active Workspace revocation, resource return to baseline, and no task-owned orphan. The real 10-tiny-Agent resource loop is intentionally left to that external Host E2E because it requires real Codex processes; deterministic source coverage already exercises the 10-cycle lifecycle. Fresh ChatGPT Web and Codex Desktop terminal-history human checks remain external acceptance. Do not label the result `LOCALINK_NATIVE_AGENT_FINAL_PASS` before those gates complete.
