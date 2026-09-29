# PHASE 04C3｜Tool-Level Control-Plane Isolation｜2026-09-29

Status: `04C3_SOURCE_PASS / PRODUCTION_ACTIVATION_PENDING`

## Problem

04C2 closed the recursive App path by disabling the complete Engineering Bridge, Localink, Codexless, and DevSpace Apps inside a Localink-owned Codex Worker.

Production E2E proved that this was too broad for Codexless. Codexless is an aggregate App that also projects ordinary business and product capabilities such as BigQuery, Lark, Apple, Bilibili, Singular, and Browser. Disabling the whole App removed those non-conflicting capabilities together with its Agent and local execution control planes.

04C3 keeps the accepted 04B1/04C/04C1/04C2 lifecycle, Workspace revocation, MCP elicitation, release, and direct Engineering Bridge MCP behavior. It changes only the App-level launch policy.

## Final launch policy

| Surface                         | Effective Localink Worker override                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Direct `engineering-bridge` MCP | `mcp_servers.<dynamic_name>.enabled=false` as before                                                                        |
| Enabled Engineering Bridge App  | Keep the App enabled; set `apps.<dynamic_id>.default_tools_enabled=false`                                                   |
| Enabled Localink App            | Keep the App enabled; set `apps.<dynamic_id>.default_tools_enabled=false`                                                   |
| Enabled DevSpace App            | Keep the App enabled; set `apps.<dynamic_id>.default_tools_enabled=false`                                                   |
| Enabled Codexless App           | Keep the App enabled; emit one `apps.<dynamic_id>.tools={ ... }` inline-table override containing only selected tool denies |
| Already-disabled target App     | Emit no App override and never force-enable it                                                                              |
| Ordinary MCPs and Apps          | Inherit Codex effective configuration unchanged                                                                             |

Every App ID is discovered dynamically from official `app/installed`. No account-specific connector ID is present in source or tests.

## Selective Codexless deny rules

Official `app/read` is called with `includeTools=true` only for an enabled Codexless App. The policy denies tool names matching:

- prefix `codex.agent_`;
- prefix `localagent.`;
- exact `codex.command_exec`;
- exact `codex.precise_edit`;
- prefix `localfs.`;
- prefix `localgit.`.

The launch override is one TOML inline table with quoted tool-name keys, for example:

```text
apps.<dynamic_id>.tools={ "codex.agent_start" = { enabled = false }, "localfs.inspect" = { enabled = false } }
```

The implementation does not construct CLI dotted keys from dotted tool names. BigQuery, Lark, Apple, Bilibili, Singular, Browser, and every other non-matching Codexless tool receive no Localink override.

`app/read.toolSummaries[].isEnabled` is intentionally not used as a model-exposure verifier. The generated launch configuration is the authority under test. A pre-existing disabled state is never changed to `true`.

## Metadata and failure boundary

The projection retains only:

- bounded App `id`;
- bounded `runtimeName`;
- boolean `enabled` and `callable`;
- bounded Codexless tool names;
- the pre-existing names-only direct MCP projection.

Descriptions, commands, arguments, environment values, URLs, icons, tokens, credentials, and other App/tool metadata are discarded. Errors do not echo raw App Server payloads.

Required metadata fails closed with `CAPABILITY_ISOLATION_UNAVAILABLE` when the installed-App or `app/read` response is missing, malformed, duplicated, incomplete, or over its count/name/serialized override bounds.

## Deterministic validation

Source baseline:

`e47cbe13aebd1844d77a54475b2f3f9d72ce74b0`

Focused validation:

- build: PASS;
- Agent/capability/lifecycle suite: 27/27 PASS;
- official App Server request path proves `app/read` receives `includeTools=true`;
- generated config contains one quoted-key Codexless TOML tool table;
- all six deny selectors are covered;
- representative BigQuery, Lark, Apple, Bilibili, Singular, and Browser names are absent from the deny table;
- enabled Engineering Bridge, Localink, and DevSpace Apps use `default_tools_enabled=false` without App disablement;
- already-disabled targets receive no force-enable or redundant override;
- malformed and oversized metadata fail closed;
- descriptions, URLs, tokens, commands, and environment material are not retained;
- direct Engineering Bridge MCP deny and normal MCP inheritance remain intact;
- Workspace revocation, MCP elicitation, owned-session teardown, writer release, restart normalization, and interaction regressions remain green.

Full repository validation:

- build/typecheck/ESLint/Prettier: PASS;
- Core: 44/44 PASS;
- Agent: 27/27 PASS;
- Runtime: 22/22 PASS;
- CLI: 23/23 PASS;
- Portability: 5/5 PASS;
- MCP: 35/35 PASS;
- Tunnel: 12/12 PASS;
- Service: 34/34 PASS;
- Release: 10/10 PASS;
- total package tests: 212 PASS;
- `npm run check`: PASS in the permitted Host context. The unchanged sandbox run reached Runtime and failed only because loopback bind was denied with `listen EPERM`.

## Production boundary

No Production build, install, release switch, activation, restart, service mutation, or Host E2E was performed in 04C3 source execution.

After source commit, push, and CI, a separately authorized Production continuation may build one immutable release, perform the existing controlled activation, and verify the effective App/tool surface plus normal terminal teardown. Until then the state remains:

`04C3_SOURCE_PASS / PRODUCTION_ACTIVATION_PENDING`
