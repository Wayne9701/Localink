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
