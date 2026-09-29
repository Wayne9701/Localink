# PHASE 05A | Native Agent lifecycle and supervision hardening | 2026-09-29

Status: `05A_SOURCE_VALIDATED / PRODUCTION_UNCHANGED`

## Incident evidence and root cause

The accepted 04B/04B1/04C5 design remains in place: one task-owned Codex App Server per active Agent, durable inventory, single-writer repository ownership, bounded `agent_wait`, Workspace revocation, MCP elicitation, native Codex capability inheritance, and direct `engineering-bridge` isolation.

Incident A was below that lifecycle layer. `ManagedAppServerClient` treated any newline-delimited App Server stdout message over 1 MiB as a protocol failure. A valid large JSON-RPC response could therefore reject pending requests, report a crash, send `SIGTERM` to the owned process group, and use the existing two-second `SIGKILL` fallback even when framing and JSON were valid.

Incident B was the state transition after that crash. `handleCrash()` recorded `unknown`, released the task App Server/session and repository writer, but did not terminalize the task. Restart recovery then preserved `unknown + inProgress + terminal=false` while all owned resources were already released. This was a permanent zombie because no client remained to produce another lifecycle event.

Incident C followed from the same state. A released stale task had no client on which `agent_cancel` could replay `turn/interrupt`, while `agent_archive` correctly refused a nonterminal task. Neither action could close the lifecycle.

## Protocol envelope versus public projection

The JSON-RPC protocol message cap is now 8 MiB. This is deliberately larger than the observed approximately 2 MiB valid message and remains within the repository's existing 8 MiB bounded transport precedent. Framing is never repaired by truncating raw JSON: a complete message at or below the cap is parsed normally, while an unterminated or complete line above the cap fails closed and tears down the owned process tree.

This does not enlarge the Localink Agent receipt or inventory contract. Final Agent text remains bounded to 4 KiB, crash diagnostics remain bounded, diagnostic history remains limited to ten entries, and MCP interaction fields continue to use their existing bounded projections. Deterministic coverage sends a valid 2 MiB single-line response through the real managed client, rejects a true greater-than-8-MiB line with exactly one crash report and process teardown, and verifies that a 2 MiB Agent result produces only a bounded public result and small durable inventory.

## Recovery terminalization rule

There is one released-task finalization path for crash recovery, startup recovery, stale cancel, and a released failed resume. It is eligible only when all of the following are true:

- the task is nonterminal;
- no task session/client is registered;
- there is no recorded task App Server PID;
- `taskAppServerState=stopped`;
- `officialSessionReleased=true`;
- `repoWriterReleased=true`.

The path creates at most one bounded read-only metadata App Server session for the candidate batch and reads only the recorded turn. It does not call `thread/resume`, reacquire a writer, start a turn, replay an approval, or poll indefinitely.

Official terminal truth wins. `completed`, `failed`, and `interrupted` map respectively to Localink `completed`, `failed`, and `cancelled`, keep ownership released, and set `lifecycleIntegrity=confirmed`.

If official terminal state is missing, unavailable, or still nonterminal after ownership is gone, Localink records:

- `status=failed` and `taskStatus=failed`;
- `turnStatus=failed`;
- `terminal=true` with `terminalAt`;
- `lifecycleIntegrity=recovery_failed`;
- the most informative retained cause, including `APP_SERVER_PROTOCOL_LIMIT_EXCEEDED`, `TASK_APP_SERVER_CRASH`, `TURN_RESUME_UNCERTAIN`, or `RECOVERY_SESSION_NOT_REATTACHED`;
- stopped/released App Server, official session, and repository writer state.

For this state, supervision recommends `archive` rather than another bounded wait. `agent_wait` remains a single observation with the accepted default and hard maximum; it is not a task lifetime.

## Stale cancel and archive

Live active cancellation is unchanged and still uses the exact owned `threadId + turnId` interrupt.

Cancellation of an already terminal task is idempotent and returns its current snapshot without replaying an interrupt. A released nonterminal stale task uses the bounded finalization path above. If official truth is terminal it is projected; otherwise the task becomes an explicit terminal recovery failure. A second cancel does not mutate it. Once terminal and released, the existing `agent_archive` path can archive its official thread normally.

Historical stale tasks are never deleted or marked completed by schema migration. They transition through the same recovery rule during a real manager startup. The five Host fixtures named by the 05A task remain untouched in Source and are reserved for external Host acceptance.

## Agent execution contract and output stability

Every initial and resumed Localink Agent turn appends a stable execution-contract suffix after the user's unmodified task text. It requires verbose stdout/stderr, large JSON, and full diffs to be written to a temporary or task-workspace file, while commentary/final output contains only PASS/FAIL, exit code, bounded tail/summary, and a path when full evidence must be retained. It also states the 05A deployment boundary and requires explicit task authorization for commit or push.

This prompt contract reduces routine output pressure but is not a substitute for the hard protocol cap or the bounded persisted/public projection.

## Self-restart and task-policy boundary

The formal V1 boundary is mechanical at the workflow level: a Native Agent may edit Localink source, run tests, and commit/push when explicitly authorized, but it must not build/install/activate/roll back a Localink release, bootstrap/restart the Localink services that supervise it, or mutate `launchctl` entries for `com.localink.*`. Deployment happens only after the Agent is terminal and is performed by an external ChatGPT/model-free supervisor.

Installed Codex CLI/App Server 0.147.0 was inspected directly. `thread/start`, `thread/resume`, and `turn/start` expose permissions, sandbox, approval policy, reviewer, and instruction fields, but no task-scoped command-rule input. Official Codex rules support `forbidden` prefix rules, but the [official Rules documentation](https://developers.openai.com/codex/rules) marks the mechanism experimental, loads it from active config layers at process startup, and defines it for commands requesting execution outside the sandbox. It cannot honestly be represented as a stable per-task hard block for arbitrary shell spellings without either changing shared/user project policy or broadly denying shell wrappers and normal 04C5 capability.

Accordingly, 05A does not add a parallel shell sandbox, a separate `CODEX_HOME`, App filtering, or an unverified hard-policy field. The execution contract is enforced in every Agent prompt, and the external-supervisor deployment boundary remains the supported control. A future Codex public API that accepts verified per-thread forbidden rules can replace this documented unsupported boundary.

## Git authorization correction

Commit `35c215474651b80210b9365fcabb084402827c67` is not an authorization incident. Its first turn correctly left changes uncommitted when commit/deploy were prohibited; a later official turn explicitly authorized the commit message, normal push to `main`, and CI. Generic structured Git governance remains a possible later feature, not a proven 05A defect and not a reason to add a new interception layer here.

## Backward compatibility

- Legacy `workspace-dev-v1` and current `codex-native-v1` inventory values remain readable.
- Existing terminal and archived tasks keep their state and archive semantics.
- Existing approval and MCP elicitation bindings remain exact and are cleared rather than replayed after ownership loss.
- Workspace revocation remains monotonic and cleanup-safe; expected revocation teardown does not become a generic crash recovery failure.
- Normal completion still persists terminal truth before teardown and releases the official session and repository writer only after task-owned process teardown.
- 04C5 native Apps/MCP/browser inheritance is unchanged; only direct configured `engineering-bridge` remains disabled.

## Source validation

Focused validation:

- managed App Server client: 4/4 PASS;
- Agent manager: 23/23 PASS;
- MCP Agent adapter: 4/4 PASS.

The complete Host-capable `npm run check` passed build, typecheck, ESLint, Prettier, and all 218 tests:

- Core 44/44;
- Agent 32/32;
- Runtime 23/23;
- CLI 23/23;
- Portability 5/5;
- MCP 35/35;
- Tunnel 12/12;
- Service 34/34;
- Release 10/10.

The first sandboxed full-check attempt reached Runtime and was blocked only because three unchanged loopback fixtures could not bind `127.0.0.1` (`listen EPERM`). The identical command passed in the permitted Host context.

Deterministic coverage includes the protocol envelope, hard over-limit teardown, public/inventory bounding, crash recovery, all three official terminal projections, persisted restart recovery, idempotent stale cancel plus archive, normal lifecycle, Workspace revoke, approval, MCP interaction, legacy inventory, and 04C5 capability inheritance.

## Production and external Host handoff

Production is unchanged. This source task does not build or install a release, change a Production symlink, bootstrap/restart a service, mutate `launchctl`, edit the real Agent inventory, clear the five historical stale Agents, or change Shared BigQuery configuration/authentication.

After Source commit, normal push, and green GitHub CI, an external supervisor must perform the task section 18 immutable release and Host E2E sequence. Only that external run may activate the release and exercise real normal, approximately-2-MiB, hard-overlimit, crash, restart, stale cancel/archive, BigQuery/browser, Workspace revoke, and leak checks. Source completion alone must not be labeled `LOCALINK_NATIVE_AGENT_05A_PASS`.
