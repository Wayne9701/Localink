# Localink runtime

`@localink/runtime` is the process-scoped owner for Core workspace, Files,
Process, Module, Capability and Skill services.

The runtime exposes a public-safe native facade for Workspace, Files and
Process operations. It projects workspace/process receipts without absolute
roots, absolute cwd or host PID.

Workspace registrations are stored atomically in
`<state-root>/config/workspaces.json`. The state root defaults to `~/.localink`
and can be overridden with `LOCALINK_STATE_ROOT` or the factory option. Runtime
startup restores the persisted workspace ID and creation timestamp while
revalidating and canonicalizing each root.

Workspace mutations are serialized. Add rolls its in-memory registration back
if persistence fails; remove persists the next configuration before removing
the in-memory registration. The long-running runtime refreshes Workspace,
Process policy, Shared Skill sources, and External MCP providers on demand
after another CLI process changes their validated configuration.

Process policy is stored atomically in
`<state-root>/config/process-policy.json` and defaults to disabled. Only the
local CLI changes it. Public process execution uses `shell: false`, has no env
input, and starts children with a small non-sensitive environment allowlist.
Runtime close gracefully stops managed children and force-kills after a bounded
grace period when necessary.

Capability and Skill registries load only explicitly configured Shared MCP and
Shared Skill sources. They are empty on a clean machine until configured.
