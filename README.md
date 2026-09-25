# Localink

Localink is a general-purpose, local-first AI tool runtime that gives **ChatGPT Web** controlled access to local tools through a Secure MCP Tunnel. Codex and Cursor use their own local tools and Shared Assets directly; they do not need to run through Localink.

## Current status

The Localink MVP passed a real ChatGPT Web → Tunnel → Localink end-to-end session on 2026-09-23. This checkout defines **exactly 31 product MCP tools** for health, capability and Skill discovery/invocation/confirmation, Workspace, Files, Process, and bounded Git operations. The four new Files tools are source-only until a separately approved release; the installed Production surface remains at 27 tools. Process execution is disabled by default and can only be enabled or disabled by the local administrator CLI.

The M6 release flow has passed stable-prefix install, update, and offline rollback acceptance. Releases contain the compiled runtime and fixed production dependencies; mutable state, config, secrets, and logs stay outside the release payload. M7 adds on-demand cross-process refresh for Workspace, Process policy, Shared Skill sources, and External MCP provider configuration. A running Core sees valid changes made by a separate CLI process without a service restart.

Shared Skills and Shared MCP providers are independently owned assets. Localink discovers or bridges only explicitly configured, bounded sources; it does not install or own them. Optional Codex Agent work is deferred beyond the MVP. Sleep/wake, network switching, and proxy/Clash changes are post-MVP natural-use reliability observations, not MVP release gates.

The External MCP Bridge projects explicit MCP annotations into Localink risk tiers: reads are Tier 0, ordinary writes are Tier 1, and destructive or open-world tools are Tier 2. Missing annotations stay hidden unless the local administrator configures an exact-name Tier 0/1/2 override. Tier 2 first returns a short-lived, single-use confirmation ticket and calls the provider only through the separate confirmed invocation. Provider business logic, authentication, installation, and verification remain provider-owned. Localink does not proxy arbitrary remote HTTPS MCP providers.

## Build and verify

Requires Node.js 22 or newer and npm 10 or newer.

```sh
git clone https://github.com/Wayne9701/Localink.git
cd Localink
npm ci
npm run check
```

For a new Mac, follow [the installation and acceptance guide](docs/INSTALL_MACOS.md). It covers the existing release CLI and the machine-specific Tunnel setup required before activation. Security and credential boundaries are in [SECURITY.md](SECURITY.md). Localink is licensed under [Apache-2.0](LICENSE).

## Local administration

From a built checkout, `node packages/cli/dist/src/cli.js` exposes `core self-test`, `runtime health`, `doctor`, `workspace add|list|inspect|remove`, `process policy|enable|disable`, `skill-source`, `mcp-provider`, `tunnel configure|status`, `service`, and `release` commands. The installed stable launcher is `~/.localink/bin/localink`.

State defaults to `~/.localink`; `LOCALINK_STATE_ROOT` is available for isolated development or tests. Workspace registrations persist at `~/.localink/config/workspaces.json`. Public Process tools have no environment-variable input and launch with `shell: false` and a small environment allowlist. A workspace-bound working directory is not an OS sandbox: an enabled executable can access other host resources.

The release CLI builds an immutable, SHA-256-inventoried directory artifact, validates it before installation, switches `current` and `previous` atomically, and can roll back to an already installed release without the checkout or network. Activation requires a configured and working Tunnel on that Mac. A failed activation makes one bounded restore attempt and then safe-stops if restoration fails.

External provider risk overrides are administered without editing state files:

```sh
localink mcp-provider risk list <provider-id> --json
localink mcp-provider risk set <provider-id> <exact-tool-name> <0|1|2> --json
localink mcp-provider risk remove <provider-id> <exact-tool-name> --json
```

Overrides are exact names only—no glob or regex—and cannot select Tier 3. Existing schema-v1 provider entries without `toolRiskOverrides` remain valid.
