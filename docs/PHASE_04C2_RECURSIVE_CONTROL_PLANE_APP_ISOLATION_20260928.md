# PHASE 04C2｜Recursive Control-Plane App Isolation｜2026-09-28

Status: `04C2_SOURCE_PASS / PRODUCTION_ACTIVATION_PENDING`

## Problem

04C1 correctly restored Codex-native MCP/Apps capability inheritance and disabled the direct `engineering-bridge` MCP server. Production E2E proved:

- the Localink-launched Codex Agent itself could call BigQuery successfully;
- the direct `engineering-bridge` MCP server had zero tools and no Worker process;
- terminal teardown remained healthy.

However, Codex's `codex_apps` aggregate catalog independently projected tools from installed ChatGPT/Codex Apps. That catalog still exposed Engineering Bridge tool names, and also contained Localink/Codexless control-plane Agent tools. Direct MCP disablement alone therefore did not fully isolate recursive execution paths.

## Final policy

Localink continues to inherit Codex's effective user/project capabilities by default.

Before each Native Agent Worker starts, capability projection now combines:

1. names-only `codex mcp list` for direct MCP recursion detection;
2. official App Server `app/installed` for currently installed Apps.

Only local execution/control-plane surfaces are denied:

- Engineering Bridge
- Localink
- Codexless
- DevSpace

These Apps are disabled for the task-owned Codex Worker using launch-level Codex config overrides derived from their current installed App IDs.

Normal capabilities remain untouched, including ordinary configured MCPs, browser/plugins, and business/productivity Apps such as BigQuery, Lark, Apple Reporting, GitHub, Gmail, Google Drive, Singular, Bilibili, Local Image, WeChat, etc., according to Codex's own effective configuration.

## Why whole control-plane Apps are denied

These four Apps are orchestration/execution gateways rather than business data sources. Allowing them inside a Localink-owned Codex Agent would let the task re-enter another execution plane and potentially bypass the Workspace/lifecycle authority that Localink is responsible for.

Examples of prevented recursion/conflict paths:

- Localink Agent -> Engineering Bridge -> another Codex
- Localink Agent -> Localink agent_start -> nested Localink Agent
- Localink Agent -> Codexless agent_start/localagent -> another Agent
- Localink Agent -> DevSpace shell/edit control plane -> alternate workspace authority

The caller outside the Agent can still use these systems according to the normal Localink/Codexless/DevSpace/Engineering Bridge routing policy.

## Implementation safety

- App IDs are discovered dynamically from official `app/installed`; no account-specific connector ID is hardcoded.
- Only bounded app ID, runtime name, enabled/callable booleans are retained.
- No App credentials, MCP command/env/token/URL contents are persisted.
- Capability projection fails closed if installed-App enumeration is malformed or unavailable.
- Already-disabled control-plane Apps are not force-enabled or redundantly overridden.
- Ordinary Apps never receive a Localink override.

## Validation

Focused:

- typecheck: PASS
- Agent/capability: 23/23 PASS

Full package regression:

- Core: 44/44 PASS
- Agent: 23/23 PASS
- Runtime: 22/22 PASS
- CLI: 23/23 PASS
- Portability: 5/5 PASS
- MCP: 35/35 PASS
- Tunnel: 12/12 PASS
- Service: 34/34 PASS
- Release: 10/10 PASS

Existing 04B1/04C lifecycle, Workspace revoke, interaction, public 41-tool surface, and version-aware rollback behavior remain green.

## Next

External/model-free closeout only:

1. commit/push + GitHub CI;
2. build one new immutable release artifact;
3. one controlled Production activation;
4. real Localink Native Agent E2E:
   - ordinary inherited MCP/App works;
   - Engineering Bridge / Localink / Codexless / DevSpace control planes are not model-available;
   - terminal process tree returns to zero;
5. record final Production state.
