# Localink OpenAI Tunnel adapter

This Phase 1B-2A package defines the deterministic boundary between Localink
and the official `tunnel-client` CLI. It discovers and probes a user-installed
binary, writes a validated loopback-only YAML profile, builds argv vectors,
resolves a frozen `SecretRef` into a redacted child-environment handle, and
parses doctor results without starting a daemon.

The package does not install the official binary, create a Platform tunnel,
read process API-key variables, contact OpenAI, launch a long-lived process, or
manage a system service. Those operations belong to later phases.

The profile writer stores profiles below an injected Localink state root at
`config/openai-tunnel/profiles/<name>.yaml`. Command builders pass that profile
directory through `TUNNEL_CLIENT_PROFILE_DIR` while preserving official argv:

```text
tunnel-client doctor --profile <name> --explain
tunnel-client run --profile <name>
```

The written YAML contains `env:CONTROL_PLANE_API_KEY`; it never contains the
resolved API key. Both the MCP target and health listener are restricted to
loopback addresses.
