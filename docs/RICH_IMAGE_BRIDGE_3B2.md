# External MCP rich image bridge (3B-2)

## Contract

External MCP schema version 1 remains compatible. A provider without `richContent` keeps its existing 1 MiB stdio receive buffer and JSON result behavior. An image-capable provider explicitly opts in:

```json
{
  "richContent": {
    "images": {
      "enabled": true,
      "maxDecodedBytes": 5000000,
      "maxBlocks": 1,
      "mimeTypes": ["image/png", "image/jpeg"]
    }
  }
}
```

The maximum is 5,000,000 decoded bytes, one image block, and PNG/JPEG only. The CLI entry is `localink mcp-provider rich-content set <provider-id> <max-image-bytes> --json`; `rich-content remove <provider-id>` disables it. `mcp-provider list --json` reads the persisted policy back. The CLI does not register a provider as a side effect of setting the policy. Provider registration and production activation are separate acceptance work.

Only successful Tier 0 calls with native `readOnlyHint=true`, no `destructiveHint=true`, and no `openWorldHint=true` can return an image. An exact-name risk override alone never confers rich image eligibility. Audio, resources, links, multiple images, noncanonical base64, MIME/signature mismatch, provider errors carrying images, and duplicate base64 in metadata fail closed. Rich image bytes stay out of capability output, discovery metadata, confirmation tickets, logs and persisted config.

The provider stdio receive buffer is calculated per opted provider as `max(1 MiB, ceil(maxDecodedBytes / 3) * 4 + 256 KiB)`, capped at 8 MiB. Other stdio providers remain at 1 MiB. HTTP providers remain credential-free loopback HTTP; this field does not widen their network policy.

`localink.capability_invoke` returns its existing bounded JSON envelope as `content[0]` and `structuredContent`, followed by one top-level MCP image block at `content[1]`. Metadata follows the 16 KiB default / 64 KiB hard result limit. Image bytes use their separate bound and are never passed through JSON truncation. `localink.capability_confirm` has no rich image path. The public tool registry remains 31 tools.

This source change does not configure or register Local-Image-MCP and does not activate a Localink release. Production registration, client-side image receipt, and rollback acceptance remain a later phase.
