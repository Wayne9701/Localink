# Security and credential boundary

Report a suspected vulnerability privately to the repository owner or maintainers through an agreed channel. Do not include credentials, credential files, or sensitive logs in an issue or pull request. No public disclosure address is configured in this repository.

This repository is source and test material. It must not contain a real Tunnel runtime credential, private key, tenant configuration, personal workspace state, or another machine's `~/.localink/` data. Test strings such as `synthetic-service-secret` and `example.invalid` are fixtures. The Tunnel credential and profile are provisioned per Mac outside the checkout; the credential file must satisfy the ownership and mode checks in [the macOS install guide](docs/INSTALL_MACOS.md).

The public MCP surface is bounded to 26 tools. Process is disabled by default; only the local CLI changes that policy. Enabling Process permits host execution, and a workspace working directory does not confine an executable like an OS sandbox. Shared Skills are untrusted content. External MCP bridging admits configured read-only, non-destructive tools only; source and provider credentials remain owned by their external assets.

Before distributing a new commit or artifact, review tracked files and the release payload for credentials and private host details. `npm run check` includes portability checks, but automated scans cannot establish that every string or newly added file is safe to publish.
