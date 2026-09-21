# Localink Service runtime

This package retains the Phase 1B-3A deterministic builders and adds the M5
live macOS boundary: fixed-argv `launchctl` execution, managed atomic plist
writes, sanitized service snapshots, read-only Keychain lookup, long-lived
Tunnel child ownership, and one-shot recovery execution.

It generates three independent service definitions:

- `com.localink.core` → `localink service core-run`
- `com.localink.tunnel` → `localink service tunnel-run`
- `com.localink.recovery` → `localink service recovery-run --once`

All paths and the non-root GUI user domain come from an injected
`InstallationContext`. Live execution accepts only the three known labels,
stops on unknown `com.localink.*` artifacts or services, writes only
Localink-managed plists, and invokes `/bin/launchctl` without a shell. M5
bootstrap activates the current checkout; it does not install or update
software.

Core and Tunnel use `RunAtLoad=true` and `KeepAlive=false`. Recovery is a
launchd-scheduled one-shot reconciliation with a default 60-second interval;
each invocation emits one bounded decision and exits. This keeps restart caps,
auth failures, missing credentials, and dependency state inside the explicit
recovery policy rather than an unconditional launchd restart loop.

The macOS Keychain adapter is read-only in M5. Tunnel configuration contains a
`SecretRef`, never a credential. The long-lived wrapper waits for its child,
forwards termination signals, applies a bounded forced shutdown, and propagates
the child exit. Public runtime health reads only the strict, freshness-aware
`state/service-status.json` projection; it contains no pid, absolute path,
tunnel id, command arguments, Keychain identifiers, or secret value.

See [`docs/SERVICE_RECOVERY_1B3A.md`](../../docs/SERVICE_RECOVERY_1B3A.md) for
the contract and acceptance boundary.
