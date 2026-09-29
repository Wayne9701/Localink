# PHASE 04C4｜Codexless Default-Deny Dynamic Inheritance｜2026-09-29

Status: `04C4_SOURCE_PASS / PRODUCTION_ACTIVATION_PENDING`

## Production finding

04C3 Production E2E proved that the overall tool-level architecture was correct but its Codexless enforcement direction was not reliable:

- BigQuery `bigquery.find_list_table_ids` succeeded;
- `codex.browser_read` remained visible;
- Engineering Bridge, Localink, and DevSpace namespaces were absent under `default_tools_enabled=false`;
- the intended Codexless control-plane denies remained model-visible despite per-tool `{ enabled = false }` entries.

04C4 changes only the enabled Codexless App policy. Direct Engineering Bridge MCP denial, the other three App rules, Native Agent lifecycle, Workspace revocation, MCP elicitation, release behavior, metadata boundaries, and all non-Codexless capability inheritance remain unchanged.

## Reliable Codexless policy

For each enabled Codexless App discovered from official `app/installed`, Localink:

1. calls official `app/read` with `includeTools=true`;
2. retains only bounded tool names;
3. emits `apps.<dynamic_id>.default_tools_enabled=false`;
4. emits exactly one `apps.<dynamic_id>.tools={ ... }` TOML inline table;
5. places every currently enumerated non-denied tool in that table as `{ enabled = true }`;
6. omits matching control-plane tools, leaving the authoritative App default set to false.

Example:

```text
apps.<dynamic_id>.default_tools_enabled=false
apps.<dynamic_id>.tools={ "bigquery.find_list_table_ids" = { enabled = true }, "codex.browser_read" = { enabled = true } }
```

This is dynamic inheritance, not a maintained business allowlist. Every task reads the current Codexless catalog. A newly added safe tool is enabled automatically on the next task; a newly added tool matching the narrow control-plane predicate remains disabled by default.

## Unchanged deny predicate

Tool names are omitted from the safe-tools table when they match:

- prefix `codex.agent_`;
- prefix `localagent.`;
- exact `codex.command_exec`;
- exact `codex.precise_edit`;
- prefix `localfs.`;
- prefix `localgit.`.

Exact matching keeps names such as `codex.command_exec_extra` safe. Representative BigQuery, Lark, Apple, Bilibili, Singular, and Browser tools are dynamically emitted with `enabled=true`.

## Safety boundary

- App IDs remain dynamic and bounded; no account-specific connector ID is hardcoded.
- Tool count, individual tool-name size, and the serialized inline-table launch argument are bounded.
- Missing, malformed, duplicate, incomplete, or oversized required metadata fails closed with `CAPABILITY_ISOLATION_UNAVAILABLE`.
- `app/read.toolSummaries[].isEnabled` is not treated as a model-exposure verifier.
- Descriptions, commands, arguments, environment values, URLs, icons, tokens, credentials, and other App/tool metadata are discarded and never projected into launch arguments or errors.
- An already-disabled Codexless App receives no Localink override and is never force-enabled.

## Unchanged surrounding policy

- direct `engineering-bridge` MCP remains disabled;
- enabled Engineering Bridge App remains enabled with `default_tools_enabled=false`;
- enabled Localink App remains enabled with `default_tools_enabled=false`;
- enabled DevSpace App remains enabled with `default_tools_enabled=false`;
- normal direct MCP inheritance remains unchanged.

## Deterministic validation

Source baseline:

`829eec54f55b41e06466dca9fecbc03a6165b74f`

Focused validation:

- build: PASS;
- Agent/capability/lifecycle suite: 27/27 PASS;
- one dynamic Codexless `default_tools_enabled=false` override is generated;
- one quoted-key Codexless safe-tools inline table is generated;
- BigQuery, Lark, Apple, Bilibili, Singular, Browser, and an exact-match near miss are emitted as `enabled=true`;
- all six deny selectors are omitted from the safe-tools table;
- official `app/read(includeTools=true)` behavior and `isEnabled` independence are covered;
- malformed metadata, oversized tool count, and oversized serialized launch argument fail closed;
- secret-like descriptions, URLs, and tokens are not retained;
- existing lifecycle, Workspace revocation, MCP elicitation, restart, teardown, and interaction coverage remains green.

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
- `npm run check`: PASS in the permitted Host context required by loopback tests.

## Production boundary

No Production build, install, release switch, activation, restart, service mutation, or Host E2E was performed during 04C4 source execution.

After commit, push, and CI, a separately authorized Production continuation may build and activate one immutable release and repeat the effective model-visible tool E2E. Until then:

`04C4_SOURCE_PASS / PRODUCTION_ACTIVATION_PENDING`
