# Core Contract 1A-1

This document records only the stable Phase 1A-1 core boundary. It deliberately does not define module, capability, authentication, policy, secret-provider, Skill, MCP, service, or installer contracts.

## Workspace authority

`WorkspaceRegistry` is the sole path authority used by Files and Process. Public operations accept an opaque `workspaceId` plus a relative path. Registration accepts an absolute host directory and stores its canonical real path. Relative paths containing NUL, absolute replacements, or `..` segments are rejected. Existing paths are checked by `realpath`; new destinations are checked through the nearest existing canonical ancestor. A symlink that resolves outside the root fails with `SYMLINK_ESCAPE`.

Removing a registration never removes host files.

## Files

`FilesService` provides bounded list, inspect, text read, binary metadata, create, atomic replace, guarded precise edit, file copy/move/rename, path/content search, SHA-256, archive-first, and sequential bounded batch operations.

Writes are no-overwrite by default except the explicit atomic replace operation. Precise edit checks the optional expected SHA-256 and the expected occurrence count before any write. Text operations require valid UTF-8 and enforce a 2 MiB hard bound. Lists, searches, and batches enforce server-side hard limits. Normal move is fail-visible across devices. Archive supports a copy, hash-verify, remove fallback for cross-device moves and returns a receipt.

Hard delete is not part of the Files surface.

## Process

`ProcessManager` uses Node OS process primitives with `shell: false`. Commands are argv-based, use a workspace-resolved cwd, accept an explicit environment overlay, and bound stdout and stderr independently. It supports buffered exec and Localink-owned persistent start, poll, stdin input, and stop.

Stop sends SIGTERM, waits a bounded grace period, and sends SIGKILL only when explicitly requested. Repeated stop returns the current terminal receipt. Unknown IDs return `PROCESS_NOT_FOUND`. The registry cannot discover or terminate arbitrary host processes. PTY is deferred.

## Config

`createStatePaths` derives config, state, cache, logs, and archive roots from an injectable root, defaulting to the current user's `.localink` directory. `ConfigStore<T>` validates values, reads structured JSON, and writes by same-directory temporary file, file sync, and rename. Malformed or invalid configuration returns `CONFIG_INVALID`.

No secrets or platform-specific configuration schemas are present.
