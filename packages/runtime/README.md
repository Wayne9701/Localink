# Localink runtime

`@localink/runtime` is the process-scoped owner for Core workspace, Files,
Process, Module, Capability and Skill services.

Workspace registrations are stored atomically in
`<state-root>/config/workspaces.json`. The state root defaults to `~/.localink`
and can be overridden with `LOCALINK_STATE_ROOT` or the factory option. Runtime
startup restores the persisted workspace ID and creation timestamp while
revalidating and canonicalizing each root.

Workspace mutations are serialized. Add rolls its in-memory registration back
if persistence fails; remove persists the next configuration before removing
the in-memory registration. A process loads configuration once. Changes made by
another CLI process become visible to a newly created runtime; live reload of a
long-running service is deferred to M5.

M1 capability and Skill registries are empty. The runtime owns Files and Process
services, but they are not public MCP tools until M2.
