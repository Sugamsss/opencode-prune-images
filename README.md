# opencode-prune-images

Intelligent image context manager and rolling buffer for OpenCode.

When agent workflows use browser tools (Playwright, Chrome DevTools) or visual iteration loops, sessions quickly accumulate dozens of screenshots. Upstream providers reject requests with fatal errors:

- `400 invalid_request_error: request contains 51 images, exceeding the maximum of 50 allowed per request`
- `413 Request Entity Too Large` / payload ceilings (Cloudflare, Azure, reverse proxies)

Once this happens, the session gets wedged because the bulky images remain in conversation history. 

### Why this is still needed on OpenCode 2.0

OpenCode 2.0 natively bounds inline image bytes (triggering above 25 MiB and reducing to 15 MiB). However, **OpenCode 2.0 enforces no image-count limit** and **does not classify image-count errors as context overflow**. If an agent collects 51 small screenshots (e.g. 50 KB each, totaling ~2.5 MiB), OpenCode 2.0 still sends all 51 images to the provider. The provider rejects the request with HTTP 400, recovery never kicks in, and the session permanently bricks. Furthermore, when core removes an image, it leaves a generic blind placeholder with no file path or context.

`opencode-prune-images` solves the entire problem:
- **Dual-Budget Protection (Count + Bytes)**: Keeps the newest images within both a count limit (default 7) and a cumulative wire Base64 payload limit (default 16 MiB).
- **Conversational 3-Point Cards**: Instead of dropping images into a black hole, older images are summarized into structured context cards capturing what was observed, why it was captured, and the exact path for recall.
- **Rolling FIFO Disk Buffer**: Ephemeral `/tmp` captures and pasted base64 data are backed up to `~/.cache/opencode/recent-images/` (100 files FIFO) so screenshots don't vanish if `/tmp` is wiped.
- **Compaction Defense**: Media is safely carded during compaction so compaction never fails on media payloads.
- **Universal Compatibility**: Works across OpenCode 2.x (including 2.0.16+ nested media assets and Uint8Array binary buffers) and OpenCode 1.x.

## What it does

- Keeps up to **7 newest images** in the active context by default (configurable via `OPENCODE_MAX_IMAGES`).
- Keeps their estimated cumulative wire Base64 payload under **16 MiB** by default (`16,777,216` bytes, configurable via `OPENCODE_MAX_IMAGE_BYTES`).
- Allocates the budgets from newest to oldest. A large recent image can cause older images to become cards even when there are fewer than seven images.
- Replaces pruned images with a rich 3-point card containing the cached path, what was observed, why it was captured, and recall guidance.
- Copies pasted data, Uint8Array binary assets, and ephemeral `/tmp` captures into a rolling cache with a default cap of **100 files**.
- Removes recognized image data from the outgoing context during compaction, leaving text cards for the compaction model. On OpenCode v2 the plugin registers the `compaction` session hook with zero image and byte budgets.
- Avoids double-wrapping cards that it has already created.
- Supports native OpenCode 2.x media parts (`Media.Asset`, Uint8Array bytes, base64 data) and structured tool-result file content, as well as V1 tool attachments.

The transformation is **outgoing-context only**. It runs in memory right before provider dispatch. It does not rewrite the conversation transcript or delete image rows from OpenCode's SQLite history.

## How it works

```text
[Screenshot or image attachment]
                |
                v
[OpenCode context/message hook]
                |
                v
  Scan recognized image parts
  Estimate wire Base64 size
  Keep newest images within:
    - 7 images
    - 16 MiB cumulative wire Base64
                |
       +--------+--------+
       |                 |
       v                 v
  Keep raw image       Create text card
  in outgoing context  and cache when possible
                |
                v
        [Provider request]
```

On OpenCode v2 the plugin registers three session hooks: `context` for normal
requests and `generate` for one-shot requests such as `/btw`, both with the
normal budgets, and `compaction`, with zero budgets. It also
registers the `experimental.chat.messages.transform` hook when available, which
fires before provider conversion on normal requests and before serialization on
the V1 compaction path. Each hook registers on its own, so one failure does not
skip the others.

## Recall cards

A card looks like this:

```text
[Pruned Image: /Users/username/.cache/opencode/recent-images/img_3f8a91b2.png]
• What's visible: Found a 12px alignment issue around the checkout button.
• Why it was captured: Check UI alignment on the checkout button.
• Recall: Read the cached path if it still exists, or re-capture the screen.
```

Cards are intentionally lossy. They provide a useful summary and a best-effort
cached path; they do not preserve the original pixels. Caching can fail for a
restricted or missing file, and cached files can later be evicted.

## Installation

This repository is **source-only and is not published to npm**. Do not use
`npm install -g opencode-prune-images` yet.

Clone or copy the source file, then point OpenCode at its absolute `file:` URL:

```bash
mkdir -p ~/.config/opencode/plugins
git clone https://github.com/Sugamsss/opencode-prune-images.git \
  ~/.config/opencode/plugins/opencode-prune-images
```

Add this to `~/.config/opencode/opencode.json` or to a project-level config:

```json
{
  "plugin": [
    "file:///Users/username/.config/opencode/plugins/opencode-prune-images/index.ts"
  ]
}
```

Use the real absolute path for your machine. Keep the repository in place while
OpenCode loads it. Restart OpenCode after changing the plugin configuration.

## Configuration

Environment values are read when the module initializes. Restart OpenCode after
changing them. The exported setters change the value only in the current
process.

| Setting | Default | Environment variable | Notes |
| --- | ---: | --- | --- |
| Active image count | `7` | `OPENCODE_MAX_IMAGES` | Newest images win. Positive integers only. |
| Active image bytes | `16 MiB` (`16,777,216`) | `OPENCODE_MAX_IMAGE_BYTES` | Cumulative estimated wire Base64 size. |
| Rolling cache files | `100` | — | Fixed default cap. `enforceCacheCap()` accepts an explicit cap for programmatic use. |
| Rolling cache directory | `~/.cache/opencode/recent-images` | — | Can be changed with `setCacheDir()`. |

The byte parser accepts values such as `500KB`, `16MB`, `16MiB`, and raw byte
counts. In this plugin, `KB`/`MB` use binary units (`1024` and `1024 * 1024`).

Example:

```bash
export OPENCODE_MAX_IMAGES=5
export OPENCODE_MAX_IMAGE_BYTES=16MiB
```

The source also exports `setMaxImages`, `setMaxImageBytes`, `setCacheDir`, and
`pruneImages` for local wrappers and tests. The package is marked private because
there is no supported npm distribution yet.

## Limits and safety notes

- The 16 MiB budget covers the plugin's estimated image payload, not the full
  HTTP request. It is not a guarantee against 413 responses.
- Inline Base64/data URIs are measured from their Base64 content. Local files
  are estimated from their size. Remote URLs use a nominal estimate.
- The plugin does not transcode or resize images.
- It does not delete original project files. Only files in the rolling cache
  are subject to the cache cap.
- The plugin does not inspect or clean OpenCode's SQLite database. If an old
  conversation itself is too large, use OpenCode's supported history controls
  or handle database cleanup separately and carefully.
- Compaction receives text cards because the plugin sets the active image and
  byte budgets to zero for recognized images. The plugin does not control the
  summary text that the model writes.

## Development

Requires Bun and TypeScript.

```bash
bun install
bun test
bun run typecheck
```

The test suite covers normal and malformed inputs, nested tool results, image
count and byte budgets, cache rotation, compaction behavior, duplicate cards,
and plugin hook registration.

## Known limitations

- Image recognition depends on the attachment shapes exposed by OpenCode. An
  unknown future media shape may pass through untouched.
- The causal card summary is based on nearby conversation text. It cannot see
  pixels after an image has been pruned.
- The rolling cache is local to one machine and is not synced between devices.
- The plugin has been tested with synthetic fixtures. Provider-specific request
  limits and deployed OpenCode clients still need independent verification.

## License

[MIT](LICENSE) © 2026 Sugam
