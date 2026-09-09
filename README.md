# opencode-prune-images

Keep OpenCode chats fast, responsive, and crash-free with dual-budget context management and causal semantic anchoring.

When agent workflows use browser tools (Playwright, Chrome DevTools, computer-use, or visual verification loops), sessions quickly accumulate dozens of base64 screenshots. Upstream providers and gateways reject requests with fatal errors:

- `413 Request Entity Too Large` (request body caps on Cloudflare, Qwen, Azure OpenAI, etc.)
- `Request contains too many images` (Console Go > 50 images, Anthropic > 20 without resizing)
- Provider token exhaustion and latency degradation

Once that happens, the session gets wedged because the bulky images remain in conversation history. `opencode-prune-images` intercepts the dispatch context in-memory, enforces a **dual-budget constraint (Count + Payload Bytes)**, links images to their **causal user intent and model findings**, summarizes older images into structured 3-point recall cards, and persists captures to a rolling local FIFO disk buffer.

---

## Architecture & Flow

```
[Agent Browser / Screenshot Tools]
                │
                ▼ (raw base64 / /tmp/ captures)
[OpenCode In-Memory Context]
                │
                ▼ (experimental.chat.messages.transform / context hook)
┌───────────────────────────────────────────────────────────┐
│                 opencode-prune-images                     │
│                                                           │
│  1. Scan all images and estimate wire base64 character size │
│  2. Greedy Dual-Budget Allocation (Newest to Oldest):     │
│     • Count Budget: Keep <= MAX_IMAGES (default: 7)       │
│     • Byte Budget: Keep <= MAX_IMAGE_BYTES (default: 4MB) │
│  3. Compaction Hook Guard (Zero Media):                   │
│     • If event.agent === "compaction" or /compact command:│
│       Set effective budget to 0 images, 0 bytes           │
│  4. For images exceeding either budget:                   │
│     • Persist ephemeral captures to rolling FIFO cache    │
│     • Causal Context Extraction (User Intent + Finding)   │
│     • Convert into 3-point Markdown context cards         │
│     • Keep newest images intact in full visual fidelity   │
└─────────────────────────────┬─────────────────────────────┘
                              │
                              ▼ (clean payload, zero 413s)
                 [Upstream Model Provider]
       (OpenAI • Anthropic • Google Gemini • 9Router)
```

### What Happens to Pruned Images?

Pruned images are replaced in-memory with a structured 3-point context card:

```markdown
[Pruned Image: /Users/username/.cache/opencode/recent-images/img_3f8a91b2c4e5f607.png]
• What's visible: Found 12px alignment issue where button padding is overflowing container bounds. (checkout-button.png)
• Why it was captured: Check UI alignment on the checkout button
• Recall: If needed again, read from `/Users/username/.cache/opencode/recent-images/img_3f8a91b2c4e5f607.png`. If missing, rely on the summary above—or if safe to reproduce, re-capture the screen.
```

- **Dual-Budget Protection (Golden 4MB Safe Limit)**: Constrains both image count (default 7) and cumulative wire base64 payload size (default 4MB / 4,194,304 bytes). Providers and gateways like Alibaba/Qwen and AWS Lambda enforce a hard 6.0 MiB ceiling for the entire request; Base64 expansion adds 33% and text context adds 0.5–1.5MB. The 4MB wire limit leaves a reliable 2MB safety margin for zero 413s across all upstream proxies.
- **Compaction Lifecycle Defense (Zero-Media Strip)**: When OpenCode runs compaction (`event.agent === "compaction"` or `/compact`), the model only outputs a text summary. Sending raw base64 into compaction causes recursive 413 bricking (OpenCode issue #14562). The plugin strips 100% of images to 3-point cards during compaction so the model synthesizes findings purely from text summaries.
- **Causal Semantic Anchoring**: In complex multi-turn tool loops (`user -> tool(bash) -> tool(read image) -> tool(grep) -> assistant("Found bug...")`), the synthesizer crawls backwards to isolate the originating user prompt and forward up to 6 turns to capture the assistant's visual findings, skipping boilerplate tool output like "Image read successfully".
- **Defensive & Non-Destructive**: Never double-wraps existing cards or markers. Transformations happen purely in-memory right before provider dispatch; your persisted SQLite session history is untouched.
- **Persistent Rolling Buffer**: Base64 payloads and ephemeral `/tmp` screenshots are copied to `~/.cache/opencode/recent-images/` with a strict FIFO cap (default 100 files).
- **Zero Runtime Dependencies**: Written in pure TypeScript using native Node.js / Bun standard library modules (`node:fs`, `node:path`, `node:crypto`, `node:os`).

---

## Installation

### Method 1: OpenCode Plugin List (Recommended)

Add `opencode-prune-images` directly to your `~/.config/opencode/opencode.json` or project-level `opencode.json`:

```json
{
  "plugin": [
    "opencode-prune-images"
  ]
}
```

Or reference a local clone / file:

```json
{
  "plugin": [
    "file:///Users/username/.config/opencode/plugins/prune-images.ts"
  ]
}
```

### Method 2: Global Install

```bash
npm install -g opencode-prune-images
```

---

## Configuration

`opencode-prune-images` works out of the box with safe, production-tested defaults:

| Setting | Default | Environment Variable | Description |
| :--- | :--- | :--- | :--- |
| **Max Images in Context** | `7` | `OPENCODE_MAX_IMAGES` | Maximum number of recent images preserved in full resolution sent to the model. |
| **Max Image Payload Bytes** | `4194304` (4 MB) | `OPENCODE_MAX_IMAGE_BYTES` | Maximum cumulative image wire base64 characters allowed in active context (supports `4MB`, `6MB`, `500KB`, etc.). |
| **Max Cache Files** | `100` | — | Maximum files kept in the FIFO rolling buffer before oldest are deleted. |
| **Cache Directory** | `~/.cache/opencode/recent-images` | — | Location where pruned / ephemeral screenshots are backed up. |

### Example: Environment Configuration

```bash
# Set custom image count and payload byte limit
export OPENCODE_MAX_IMAGES=5
export OPENCODE_MAX_IMAGE_BYTES=4MB
```

### Programmatic API

If importing or wrapping the plugin in your own setup:

```typescript
import {
  setMaxImages,
  setMaxImageBytes,
  setCacheDir,
  pruneImages
} from "opencode-prune-images";

// Set custom count and byte limits
setMaxImages(5);
setMaxImageBytes(4 * 1024 * 1024); // 4MB

// Set custom cache location
setCacheDir("/path/to/custom/cache");
```

---

## Troubleshooting & FAQ

#### Why a dual budget (count + bytes)?
Vision models and cloud reverse proxies enforce independent bottlenecks:
1. Model providers reject queries with too many image parts (e.g. 20-50 images max).
2. Reverse proxies and serverless gateways (Cloudflare, Azure, AWS API Gateway) reject requests exceeding body size limits (e.g. 6MB to 32MB HTTP payloads).
A dual-budget guarantees that neither limit will ever be exceeded.

#### Does this delete my screenshots from disk?
No. Original screenshots in project directories are never touched. Only the rolling cache directory (`~/.cache/opencode/recent-images/`) enforces a FIFO cap (default 100 items) to prevent disk bloat over months of automated work.

#### What happens if the agent needs to see an image that was pruned?
The card provides the exact file path to the cached image. The agent can use any file-reading or image-reading tool (such as `read` or browser inspection) to reload it into active context.

#### Does this break tool call IDs or subagent structures?
No. The plugin performs in-place replacement on content parts while preserving `id`, `tool`, `toolName`, and surrounding metadata intact.

---

## Development & Verification

```bash
# Run test suite
bun test

# Typecheck with strict TypeScript
bun run typecheck
```

---

## License

[MIT](LICENSE) © 2026 Sugam
