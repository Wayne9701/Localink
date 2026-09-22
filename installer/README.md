# Localink installer boundary

The Localink installer is responsible only for Localink itself:

- runtime/environment checks;
- Localink installation;
- Localink service setup;
- Localink state/config initialization;
- doctor;
- update/rollback;
- uninstall.

Installing Shared MCPs, Shared Skills, Codex/Cursor configuration, team profiles, or restoring a complete workstation belongs to the separate AI Environment Bootstrap project.

M6 implements this boundary as a directory artifact with an immutable manifest
and SHA-256 file inventory. The installed layout is:

```text
~/.localink/app/releases/<release-id>/
~/.localink/app/current -> releases/<release-id>
~/.localink/app/previous -> releases/<release-id>
~/.localink/app/staging/
~/.localink/bin/localink
```

Only ordinary, manifest-listed files are accepted. Absolute paths, traversal,
symbolic links, unlisted files, special files, integrity mismatches, and a
non-Localink production root fail closed. Activation and rollback preserve the
separate `config/`, `state/`, `secrets/`, `logs/`, and `cache/` trees.
