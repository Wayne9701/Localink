# PHASE 04C1｜Version-Aware Release Readiness｜2026-09-28

Status: `04C1_SOURCE_PASS / PRODUCTION_ACTIVATION_PENDING`

## Problem

The first 04C Production activation failed safe and restored the `current` pointer to 04B1, but rollback service readiness also failed.

The release CLI that initiated the upgrade belongs to the new source version. Its readiness checks previously used that CLI's own `TOOL_NAMES.length` for both:

- the target release being activated;
- the prior release being restored after a failed activation.

04C changes the public Localink surface from 40 to 41 tools. Therefore a 04C CLI cannot safely validate a restored 04B1 runtime by requiring 41 tools. Any cross-version public-surface change could make rollback readiness self-contradictory.

## Fix

Release activation now reads the expected public tool count from the exact release payload being started:

`payload/node_modules/@localink/mcp-server/dist/src/tool-definitions.js`

The reader:

- uses the immutable validated release path;
- accepts only a bounded, non-empty, unique string `TOOL_NAMES` array;
- fails closed with `LOCAL_MCP_FAILED` when the inventory is missing or invalid.

The activation hook validates the target release against the target release count.

The restore hook validates an installed prior release against that prior release's own count. A pre-release arrangement with no managed current pointer continues to use the invoking checkout's count.

Result:

- 04C target can require 41 tools;
- 04B1 rollback can require 40 tools;
- future public surface changes no longer make rollback readiness impossible by construction.

## Validation

- typecheck: PASS
- CLI: 23/23 PASS
- Release: 10/10 PASS
- dedicated cross-version inventory test: PASS
- missing/duplicate release inventory fails closed: PASS

Production remains on:
`agent-final-lifecycle-04b1-0.1.0-50aa120`

No second install of the failed 04C artifact was attempted.
