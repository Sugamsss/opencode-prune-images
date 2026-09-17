# opencode-prune-images

An OpenCode plugin that keeps image-heavy chats manageable.

Browser work, screenshots, and visual checks can add many image attachments to
one conversation. Large requests may hit a provider or gateway limit. This
plugin changes the outgoing context before it is sent: it keeps the newest
images within two budgets and replaces older images with small recall cards.

It is deliberately conservative about what it promises. It reduces image
payload pressure, but it cannot guarantee that every provider accepts every
request. Provider limits, prompt size, tool schemas, and other request data
still matter.

## What it does

- Keeps up to **7 newest images** in the active context by default.
- Keeps their estimated cumulative wire Base64 payload under **16 MiB** by
  default (`16,777,216` bytes).
- Allocates the budgets from newest to oldest. A large recent image can cause
  older images to become cards even when there are fewer than seven images.
- Replaces pruned images with a three-point card containing the cached path,
  what was visible, why it was captured, and a best-effort way to recall it.
- Copies pasted data and ephemeral `/tmp` captures into a rolling cache with a
  default cap of **100 files**.
- Removes recognized image data from the outgoing context during compaction,
  leaving text cards for the compaction model. The zero image mode applies
  when the hook event is explicitly marked as compaction. The V1 compaction
  transform carries no such marker, so it uses the normal budgets there.
- Avoids double-wrapping cards that it has already created.
- Handles V1 tool attachments by removing pruned entries from
  `state.attachments` and appending their cards to that tool part's output
  text. This keeps provider conversion and compaction serialization working,
  since neither path reads card text out of a replaced attachment object.

The transformation is **outgoing-context only**. It runs in memory in the
OpenCode context/message hook. It does not rewrite the conversation transcript
or delete image rows from OpenCode's SQLite history. The cache is also not a
permanent archive: its oldest files are removed when the 100-file cap is
exceeded.

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

The plugin supports OpenCode's preview `context` hook and the
`experimental.chat.messages.transform` hook when available. The transform hook
remains present on current upstream `dev` and fires before provider conversion
on normal requests and before serialization on the V1 compaction path.

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
