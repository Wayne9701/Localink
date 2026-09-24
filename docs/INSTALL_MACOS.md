# Install and accept Localink on a new Mac

This guide uses the release commands in the repository. There is no one-click installer. Run these commands as the intended non-root macOS login user. The install activates user LaunchAgents and the Secure MCP Tunnel.

## Prerequisites

- macOS with a user GUI session, Node.js 22 or newer, npm 10 or newer, and Git.
- A network connection for the public repository clone and `npm ci`.
- A machine-specific OpenAI Secure MCP Tunnel ID and runtime credential, plus a Localink-owned `tunnel-client` binary at `~/.localink/bin/tunnel-client` matching the version accepted by the checked-out code. Check `TESTED_LOCAL_TUNNEL_CLIENT_VERSION` in `transports/openai-tunnel/src/types.ts`. Localink does not download the client, create the Tunnel, or issue its credential.
- A free local MCP endpoint (`127.0.0.1:4318`) and Tunnel health listener (`127.0.0.1:8080`), and permission to use the current user's `~/Library/LaunchAgents`.

Provision the Tunnel and credential separately on **each Mac**. The current runtime checks `~/.localink/secrets/` as a user-owned `0700` directory and `~/.localink/secrets/openai-tunnel-runtime.key` as a nonempty, user-owned regular `0600` file, with no symlink. Put the new Mac's own credential there through a secure local workflow; never print it in a shell command, copy it from another machine, or commit it. The profile stores a `file:` reference, not the key value.

## Clone and verify

```sh
git clone https://github.com/Wayne9701/Localink.git localink
cd localink
npm ci
npm run check
```

Review the source and artifact destination before activating. Build a release ID that is unique on this Mac; the example derives it from the checkout commit:

```sh
SOURCE_COMMIT="$(git rev-parse HEAD)"
RELEASE_ID="localink-0.1.0-${SOURCE_COMMIT}"
ARTIFACT_DIR="$(mktemp -d "${TMPDIR:-/tmp/}localink-artifact.XXXXXX")"
node packages/cli/dist/src/cli.js release build "$ARTIFACT_DIR" "$RELEASE_ID" "$SOURCE_COMMIT" --json
```

The build output includes the manifest. Keep the artifact directory outside the source checkout and inspect its location before reuse. `release build` does not activate services.

## Configure this Mac, then install

After independently provisioning the tested `tunnel-client`, Tunnel ID, and credential file, configure the profile with the **new Mac's** Tunnel ID:

```sh
node packages/cli/dist/src/cli.js tunnel configure <this-mac-tunnel-id> --json
node packages/cli/dist/src/cli.js tunnel status --json
node packages/cli/dist/src/cli.js release install "$ARTIFACT_DIR" --json
```

`release install` requires the tested Tunnel configuration and waits for local Core/MCP and Tunnel control-plane readiness. Treat anything other than an `activated` receipt as a failed install; inspect the receipt and service status before another attempt. The command installs under `~/.localink/app/`, creates `~/.localink/bin/localink`, and manages only the `com.localink.*` user LaunchAgents. Later updates use the same `release build` and `release install` commands with a new release ID. `~/.localink/bin/localink release rollback --json` uses a prior installed release and needs no checkout or network.

## Acceptance on the new Mac

```sh
~/.localink/bin/localink release status --json
~/.localink/bin/localink doctor --json
~/.localink/bin/localink service status --json
~/.localink/bin/localink runtime health --json
~/.localink/bin/localink process policy --json
~/.localink/bin/localink workspace add <name> <absolute-root> --json
~/.localink/bin/localink workspace list --json
```

Confirm `release status` points to the new release, Doctor reports local MCP ready with **26** tools and a ready Tunnel, and Process policy is `enabled: false`. Use an intentional workspace root containing harmless test files. In ChatGPT Web, connect to this Mac's Localink Connector in a fresh session, verify tool discovery, then call `workspace_list`, `workspace_inspect`, a bounded file read, and `health_status` against that workspace. The CLI and ChatGPT Web should see the same workspace without restarting Core. Keep Process disabled unless a local administrator explicitly authorizes a bounded process test, then disable it again.

Shared Skill sources and Shared MCP providers must be installed and configured independently with `skill-source add` and `mcp-provider add-http|add-stdio` if needed. An empty shared-asset registry is expected on a clean Mac until configured. ChatGPT Web Connector visibility and calls are separate acceptance evidence; Doctor alone cannot prove that session binding.

Localink state, config, secrets, logs, and cache remain under `~/.localink/`, outside both the Git checkout and release payload. Do not copy a previous Mac's `~/.localink/` tree or LaunchAgents into this installation. Keep the checkout for rebuilding and updating; the active stable launcher and services run from the installed release.
