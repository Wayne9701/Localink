# Localink Service foundation

This Phase 1B-3A package defines portable macOS user LaunchAgent artifacts,
launchctl argv contracts, layered service status, a secret-safe tunnel wrapper,
and a deterministic one-shot recovery policy.

It generates three independent service definitions:

- `com.localink.core` → `localink service core-run`
- `com.localink.tunnel` → `localink service tunnel-run`
- `com.localink.recovery` → `localink service recovery-run --once`

All paths and the non-root GUI user domain come from an injected
`InstallationContext`. The package only renders artifacts and returns command
vectors. It does not write to `~/Library/LaunchAgents`, execute `launchctl`,
read Keychain, start the real tunnel, or daemonize a recovery loop.

Core and Tunnel use `RunAtLoad=true` and `KeepAlive=false`. Recovery is a
launchd-scheduled one-shot reconciliation with a default 60-second interval;
each invocation emits one bounded decision and exits. This keeps restart caps,
auth failures, missing credentials, and dependency state inside the explicit
recovery policy rather than an unconditional launchd restart loop.

See [`docs/SERVICE_RECOVERY_1B3A.md`](../../docs/SERVICE_RECOVERY_1B3A.md) for
the contract and acceptance boundary.
