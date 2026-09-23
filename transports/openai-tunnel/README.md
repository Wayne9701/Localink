# Localink OpenAI Tunnel adapter

This package defines the deterministic boundary between Localink and the
official `tunnel-client` CLI. It discovers and probes a separately installed
binary, writes a validated loopback-only YAML profile with a machine-local
`file:` credential reference, builds argv vectors, and parses doctor results.

The package does not install the official binary, create a Platform tunnel, or
provision a runtime credential. Localink's service package owns the long-lived
process and managed user LaunchAgents.

The profile writer stores profiles below an injected Localink state root at
`config/openai-tunnel/profiles/<name>.yaml`. Command builders pass that profile
directory through `TUNNEL_CLIENT_PROFILE_DIR` while preserving official argv:

```text
tunnel-client doctor --profile <name> --explain
tunnel-client run --profile <name>
```

The current written YAML contains a `file:` reference under the Localink state
root, never the credential value. Both the MCP target and health listener are
restricted to loopback addresses.
