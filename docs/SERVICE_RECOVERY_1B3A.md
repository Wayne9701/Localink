# Service and recovery contract 1B-3A

Status: Phase 1B-3A deterministic foundation

## Authoritative macOS semantics

The implementation was checked against the current host's local macOS manual
pages and tools: `launchd.plist(5)`, `launchctl(1)`, `launchctl help`, and
`plutil -help`.

The contract uses these documented semantics:

- `Label` is the required unique launchd job identifier.
- `ProgramArguments` is an argv array passed to the spawned job. The first
  element is an injected absolute Localink executable path; no shell command is
  rendered.
- `WorkingDirectory` asks launchd to change directory before starting the job.
- `RunAtLoad` starts a job once when it is loaded.
- `KeepAlive` can cause repeated relaunch and implicitly implies `RunAtLoad`;
  rapidly failing jobs are subject to launchd throttling. Localink therefore
  sets it to `false` and applies its own bounded recovery decision.
- `StartInterval` invokes the recovery job periodically. A missed interval
  while asleep is not replayed, and an interval is skipped while the previous
  invocation is still running.
- `StandardOutPath` and `StandardErrorPath` are opened by launchd for the job.
- `EnvironmentVariables` accepts string values. Localink places only injected
  non-secret state/config/log roots there.
- `~/Library/LaunchAgents` is the per-user location. `UserName` is for the
  privileged system domain and is omitted.
- `gui/<uid>` addresses the logged-in user's GUI domain;
  `gui/<uid>/<label>` addresses a service in that domain.
- `launchctl print` output is diagnostic and explicitly not a stable API, so
  no production parser is frozen in this phase.
- launchd has no explicit dependency model. Core-before-Tunnel reasoning is
  therefore performed by the recovery policy using readiness inputs.

`plutil -lint` is the syntax acceptance check for every generated plist.

## Installation context

Every machine-specific absolute path is injected through
`InstallationContext`:

- install prefix;
- Localink executable;
- runtime/working directory;
- state, config, and log roots;
- user home and exact `<home>/Library/LaunchAgents` target;
- non-root uid and derived `gui/<uid>` domain.

The package has no baked-in checkout, user-home, or `tunnel-client` path.

## Service topology

The three service definitions are independent:

| Service  | Label                   | Stable argv                            | launchd behavior                                         |
| -------- | ----------------------- | -------------------------------------- | -------------------------------------------------------- |
| Core     | `com.localink.core`     | `localink service core-run`            | Start at load, no unconditional keepalive                |
| Tunnel   | `com.localink.tunnel`   | `localink service tunnel-run`          | Start at load, no unconditional keepalive                |
| Recovery | `com.localink.recovery` | `localink service recovery-run --once` | Start at load plus default 60-second interval, then exit |

Each service has separate stdout and stderr paths. Plists contain no credential,
SecretRef, Tunnel identifier, or official binary path.

The package provides a strict entrypoint parser/dispatcher. The recovery form
is accepted only with `--once`, and dispatch calls exactly one injected handler.
Live Core/Tunnel/recovery handlers and CLI wiring remain a Phase 1B-3B concern.

## Secret-safe Tunnel wrapper

The Tunnel plist starts the Localink wrapper. At runtime the wrapper contract:

1. receives a frozen `SecretRef` from non-plist configuration;
2. requires the matching `SecretProvider`;
3. resolves a `SecretValueHandle`;
4. builds official `tunnel-client run --profile <name>` argv through the
   accepted Phase 1B-2A adapter;
5. reveals the value only while creating the injected child launcher's env;
6. sets `CONTROL_PLANE_API_KEY` and `TUNNEL_CLIENT_PROFILE_DIR` at that narrow
   boundary;
7. returns a receipt containing the injected key name but never its value or
   SecretRef key.

There is no default real process launcher or Keychain adapter in this phase.
Tests use only synthetic values and a fake launcher.

## Status layers

`ServiceStatus` reports:

- service id and installation state;
- process running and optional pid;
- independent readiness;
- last exit;
- recent restart count;
- optional cooldown;
- reason codes and checked time.

`LocalinkServiceTopologyStatus` keeps these distinct:

1. Core service/process;
2. local MCP readiness;
3. Tunnel service/process;
4. Tunnel connected;
5. Tunnel ready.

No state is inferred from another layer. In particular, a running Core process
does not make MCP ready, and a running Tunnel process does not make the Tunnel
connected or ready. Business E2E is outside this status model.

## Recovery policy

`decideRecovery()` is pure and uses an injected timestamp, policy, status,
restart history, dependencies, credential/config preconditions, and operator
intent. It returns exactly one of:

- `no_action`
- `start`
- `restart`
- `stop`
- `wait_backoff`
- `manual_intervention`

The default policy uses a 5-second exponential backoff, a 5-minute cap, a
10-minute rolling window, five maximum attempts, and a 15-minute cooldown.
The history is scoped per service.

Automatic decisions follow these rules:

- Core process/readiness is resolved before Tunnel restart decisions.
- Missing Tunnel secret, auth failure, invalid config, or stale pid/lock state
  requires manual intervention.
- A stopped service with no recent attempt may be started.
- A failed readiness layer may produce a bounded restart.
- A recent attempt produces `wait_backoff` until the exponential delay ends.
- The attempt cap produces `manual_intervention` plus a cooldown deadline.
- Unknown readiness produces `no_action`; it is never guessed to be healthy or
  failed.
- Each invocation returns one decision and ends. It contains no polling loop.

A stale-state decision only suggests removing a stale pid/lock after owner
verification. The foundation does not delete it.

## Installer and launchctl boundary

Install/uninstall plans are data only. They describe plist destinations,
non-root permissions, validated user-domain targets, and argv for:

- `launchctl bootstrap gui/<uid> <absolute-plist-path>`
- `launchctl bootout gui/<uid>/<label>`
- `launchctl kickstart [-k] gui/<uid>/<label>`
- `launchctl print gui/<uid>/<label>`

No builder executes these commands. Uninstall plans preserve state, config,
logs, and secrets by default.

## Evidence boundaries

Phase 1B-3A distinguishes:

- generated artifact: rendered and linted in a temporary directory;
- installed: plist copied and bootstrapped into the user domain;
- process alive: launchd reports a process;
- ready: the corresponding local readiness probe succeeds;
- Tunnel connected/ready: confirmed by Tunnel-layer evidence;
- business E2E: a real supported product completes a real MCP call.

Only the first item is exercised here. Real LaunchAgent install/bootstrap,
credential resolution, Tunnel connection, crash/sleep/network dogfood, log
rotation, and uninstall execution remain for Phase 1B-2B/1B-3B and Installer
acceptance.
