# Localink Contracts V1

Status: frozen by Phase 1A-2

This document defines the platform-neutral V1 boundary for Modules, Auth,
Capabilities, Policy, Secrets, and Skills. It extends, but does not change, the
Phase 1A-1 Workspace, Files, Process, and Config semantics in
`CORE_CONTRACT_1A1.md`.

## Common rules

- Every V1 manifest or descriptor declares `contractVersion: "1"`.
- Stable IDs are lowercase identifiers. Versions use semantic version syntax.
- Results and errors are structured and fail-visible. A failed component must
  not terminate Core or hide its state.
- Contracts are platform-neutral. Product-specific resource types, tool names,
  and business payload fields belong in Modules, not in these contracts.
- Core does not implement a confirmation UI. It returns a policy decision for a
  client or later transport to handle.
- Configuration stores secret references only. Secret values are never normal
  configuration, descriptor, receipt, log, or error fields.

## Module Contract

`ModuleManifest` declares the module ID, semantic version, title, V1 runtime
compatibility, optional dependencies, config schema, auth provider reference,
capability IDs, and optional public semantic IDs. `ModuleDefinition` may provide
initialize, enable, disable, and health hooks.

`ModuleRegistry` provides:

- `register` and the equivalent fixture-facing `install` operation;
- `enable` and `disable` lifecycle operations;
- `list`, `discover`, and `inspect`;
- `health` with `healthy`, `degraded`, `unhealthy`, or `disabled` state.

Registration validates the manifest and rejects duplicate IDs. Lifecycle and
health hook exceptions are contained at the registry boundary. They produce a
generic, machine-readable failure without serializing the thrown value. Other
modules and Core remain operational. V1 does not define package download,
dynamic dependency installation, update, or rollback.

## Auth Contract

`AuthProvider` exposes explicit method boundaries for `status`, `setup`,
`login`, `refresh`, and `logout`. An `AuthStatus` contains:

- provider ID and state;
- an optional explicit identity summary;
- granted, required, and missing scopes;
- refresh readiness;
- an optional `SecretRef` for the credential location.

An Auth result never contains a raw access credential or raw refresh
credential. A provider must not replace a missing or mismatched identity with a
different identity class. The fixture provider proves that missing identity
remains missing and that scope gaps are calculated without any real OAuth flow.

## Capability Contract

`CapabilityDescriptor` declares:

- ID, module ID, semantic version, title, and description;
- inline input schema or a schema reference and an output summary;
- read or write operation class;
- required identity and required scopes;
- risk tier;
- reversibility and precondition support;
- post-verification requirement;
- public semantic surface membership.

`CapabilityRegistry` provides `register`, `list`, `search`, `describe`,
`availability`, and `invoke`. Invalid and duplicate registration fails visibly.
Availability reports disabled-module, missing-identity, identity-mismatch, and
missing-scope reasons.

Every invoke is evaluated by Policy before the handler can run. `confirm` and
`deny` decisions return receipts and do not call the handler. For an allowed
invoke, identity and scope requirements must be satisfied. Handler exceptions
are contained and returned as generic capability failures. A capability with
`postVerify: "required"` cannot return verified success without a successful
verification receipt.

The registry is internal in Phase 1A-2. No MCP or other transport is defined by
this contract freeze.

## Policy Contract

Policy uses four fixed risk tiers:

| Tier | Meaning                                                                                 |
| ---- | --------------------------------------------------------------------------------------- |
| 0    | Read with no external mutation                                                          |
| 1    | Bounded, reversible or verifiable, low-impact write                                     |
| 2    | External send, permission change, delete or clear, irreversible or high-impact mutation |
| 3    | Secret, system-security, admin-critical, or explicitly restricted action                |

The built-in profiles are:

| Profile    | Tier 0 | Tier 1  | Tier 2  | Tier 3 |
| ---------- | ------ | ------- | ------- | ------ |
| `open`     | allow  | allow   | allow   | deny   |
| `balanced` | allow  | allow   | confirm | deny   |
| `strict`   | allow  | confirm | confirm | deny   |

Per-workspace overrides merge at a specific tier for Tiers 0 through 2. Tier 3
is an absolute protected boundary: neither `open` nor a workspace override can
turn it into `allow` or `confirm`. Every `PolicyDecision` returns `allow`,
`confirm`, or `deny` plus a machine-readable reason code, human-readable
message, selected profile and tier, and whether an override was applied.

## Secret Contract

`SecretRef` identifies a provider, a key, and an optional namespace. It does not
contain a secret value. `SecretProvider` exposes `get`, `set`, and `delete`.
Mutation receipts include the reference and changed state, never the value.

`SecretValue` is an explicit handle: callers must deliberately call `reveal()`
inside the narrow consumer boundary. JSON, string, and standard inspection
representations are redacted.

Phase 1A-2 includes:

- an in-memory provider for deterministic tests;
- a `MacOSKeychainSecretProvider` with an injected `MacOSKeychainAdapter`.

The macOS class is an adapter skeleton. It has no default command runner and
therefore cannot inspect or modify a real Keychain unless a later, separately
reviewed adapter is explicitly supplied. Provider failures use generic error
messages and do not serialize adapter exceptions.

The generic Phase 1A-1 `ConfigStore` remains unchanged. Configuration schemas
that need credentials must accept and validate `SecretRef` fields, never inline
secret fields.

## Skill Contract

`SkillManifest` declares the Skill ID, semantic version, title, description,
fixed `SKILL.md` entry, and optional tags, assets, and scripts metadata.
Metadata paths must be safe relative paths.

`SkillRegistry` provides `register`, `discover`, `list`, `search`, and bounded
`read`. Manifest validation and duplicate detection are fail-visible. Reads are
bounded by a hard server-side maximum and report truncation. The registry stores
and returns Skill assets only. It never interprets instructions, imports code,
or executes listed scripts.

Phase 1A-2 uses a fixture Skill only. No production analysis Skill is migrated.

## Error semantics

Contract validation uses `CONTRACT_INVALID`; duplicate registrations use
`ALREADY_EXISTS`. Missing resources use domain-specific not-found codes.
Identity and scope gaps use `IDENTITY_REQUIRED` and `SCOPE_REQUIRED`.
Unavailable capability execution, missing required verification, secret
provider failure, and lifecycle state are distinct machine-readable conditions.

Errors expose only information needed to diagnose the contract boundary. Hook,
handler, and secret-adapter exceptions are not copied into public error details.
Policy `confirm` and `deny` are decisions, not thrown exceptions, because the
caller needs the complete decision receipt without executing a handler.

## Extension and versioning rules

- Compatible optional fields may be added within V1 when old consumers can
  safely ignore them.
- Existing required field meanings, risk tiers, default profile decisions,
  identity fail-closed behavior, and secret redaction may not be weakened in
  V1.
- New Module or Capability implementations must use these contracts rather
  than adding product-specific fields to Core.
- A change that removes a required field, changes its meaning, weakens a safety
  invariant, or makes an existing valid consumer incompatible requires a new
  contract version.
- Contract versions and individual Module, Capability, and Skill semantic
  versions are separate. Updating an implementation does not by itself require
  a contract version change.

After Phase 1A-2, later Modules must not silently break V1. A genuine breaking
change requires an explicit contract-version upgrade and migration plan.

## Generalized operational evidence

The V1 boundary abstracts previously validated operational lessons without
depending on any particular platform runtime:

- identity selection is explicit and fail-closed;
- required, granted, and missing scopes are separate fields;
- a small stable semantic surface can coexist with a broader internal registry;
- low-impact writes use preconditions and post-write verification where
  declared;
- external, permission, and destructive actions cross a confirmation boundary;
- backend readiness, catalog availability, and client-session binding are
  distinct states.

These are general contract principles. No platform Module, OAuth flow, business
schema, transport, tunnel, service, or production credential is implemented by
Phase 1A-2.
