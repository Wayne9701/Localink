# PHASE 04C5｜Final Native Capability Inheritance｜2026-09-29

Status: `04C5_SOURCE_PASS / PRODUCTION_UNCHANGED_04C3`

## Decision

Localink Native Agent capability projection returns to the proven 04C1 model from commit `7cdc2b0`:

1. run only `codex mcp list` before launching the task-owned Codex App Server;
2. retain only valid, bounded MCP server names from the first output column;
3. inherit every normal Codex capability and installed App according to Codex's existing effective configuration;
4. when and only when the configured direct MCP name `engineering-bridge` exists, emit exactly:

   ```text
   -c mcp_servers.engineering-bridge.enabled=false
   ```

Localink does not call `app/installed` or `app/read` during capability projection. It emits no `apps.*` launch override and maintains no App or App-tool allowlist/denylist.

## Why 04C2-04C4 were rejected

The production E2E sequence established that Localink should not reconstruct Codex's internal Apps catalog:

- 04C2 disabled the complete Engineering Bridge, Localink, Codexless, and DevSpace Apps. This blocked recursion paths, but real E2E also removed valuable business and product capabilities aggregated by Codexless, including normal data and browser access. The boundary was broader than Localink's authority required.
- 04C3 kept Apps enabled and attempted selective tool denial. Real E2E showed that the per-tool `{ enabled = false }` entries did not reliably remove the intended Codexless control tools from the model-visible catalog.
- 04C4 inverted the rule to App-level default deny plus dynamic safe-tool re-enablement. Although deterministic in source tests, it still made Localink enumerate and reconstruct an internal Codex Apps/tool catalog. That introduced a second capability policy, an App Server preflight dependency, and a risk of hiding ordinary capabilities when Codex App policy or search behavior changes.

The final conclusion is that App filtering is both ineffective in the narrow form and over-broad in the reliable form. Historical 04C2, 04C3, and 04C4 documents remain in the repository as the audit trail; their policies are superseded by this decision.

## Codexless comparison

Source comparison confirmed that Codexless Formal Agent launches Codex App Server with its normal existing `configOverrides`. It does not dynamically enumerate or filter the internal Codex Apps/MCP catalog before launch.

04C5 matches that native inheritance model. Localink owns the Workspace authorization, approval, interaction, lifecycle, revocation, and teardown envelope around its Codex Agent; Codex continues to own normal capability and App resolution inside that envelope.

## Sole narrow exception

The configured direct `engineering-bridge` MCP server remains disabled for a Localink-owned Codex Agent.

Engineering Bridge's direct MCP role is to start or supervise another Codex execution chain. It contributes no unique business capability needed inside the already Localink-owned Agent. Disabling this one direct server prevents that recursion path without changing installed Apps named Engineering Bridge, Localink, Codexless, or DevSpace and without filtering their tools.

## Security and failure boundary

Capability projection reads only the first whitespace-delimited name column from `codex mcp list`. Commands, arguments, environment values, URLs, bearer material, auth metadata, and other non-name columns are discarded while streaming and are never returned or persisted.

Enumeration fails closed with `CAPABILITY_ISOLATION_UNAVAILABLE` when the executable cannot run, exits unsuccessfully, omits the official header, contains a malformed or overlong name, or exceeds the bounded output size. Failure messages do not include raw enumeration output.

No other accepted behavior changes. Workspace authority, approval handling, lifecycle ownership, durable terminal state, process-tree teardown, writer release, Workspace revocation, restart normalization, release isolation, Desktop history behavior, and MCP elicitation support remain as accepted in 04B/04C.

## Acceptance criteria

- ordinary configured MCP names are inherited with no enable or disable override;
- configured direct `engineering-bridge` produces exactly one disabled override;
- capability projection invokes only `codex mcp list` and never performs App enumeration;
- no `apps.*` launch override is emitted;
- secrets or sensitive values in non-name columns are never retained;
- missing, malformed, overlong, or oversized MCP enumeration fails closed;
- the focused capability tests pass;
- all 04B/04C lifecycle, revocation, interaction, teardown, release, and package regression tests remain green under `npm run check`.

## Production boundary

Production is rolled back to 04C3. This source phase must not build or install a release, switch a release pointer, activate or restart services, or otherwise mutate Production.

After source commit, push, and CI, any release build and controlled Production activation require a separate authorization and acceptance run.

## Validation

Focused validation:

- capability projection: 4/4 PASS;
- complete Agent suite: 24/24 PASS;
- exact `mcp list`-only invocation, secret discard, direct Engineering Bridge override, no `apps.*` override, and malformed/overlong/oversized fail-closed cases: PASS.

Full repository validation in the permitted Host context:

- build/typecheck/ESLint/Prettier: PASS;
- Core: 44/44 PASS;
- Agent: 24/24 PASS;
- Runtime: 22/22 PASS;
- CLI: 23/23 PASS;
- Portability: 5/5 PASS;
- MCP: 35/35 PASS;
- Tunnel: 12/12 PASS;
- Service: 34/34 PASS;
- Release: 10/10 PASS;
- total package tests: 209 PASS;
- `npm run check`: PASS.

The initial sandbox run reached Runtime and failed only because three unchanged tests could not bind loopback with `listen EPERM`. The identical full command passed in the permitted Host context.
