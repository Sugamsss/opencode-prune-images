# opencode-prune-images

Keep OpenCode chats fast, responsive, and crash-free by capping active visual images sent to the LLM.

When agent workflows use browser tools (Playwright, Chrome DevTools, computer-use, or visual verification loops), sessions quickly accumulate dozens of base64 screenshots. Upstream providers eventually reject requests with fatal errors:

- `413 Request Entity Too Large`
- `Request contains too many images`
- Provider-specific payload limits or token exhaustion

Once that happens, the session gets wedged because the bulky images remain in conversation history. `opencode-prune-images` intercepts the dispatch context in-memory, retains the latest high-resolution images, summarizes earlier images into structured recall cards, and persists captures to a rolling local disk buffer.

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
│  1. Scan & Count images across parts, tool results, data  │
│  2. If images > MAX_IMAGES (default: 7):                  │
│     • Persist ephemeral captures to rolling FIFO cache    │
│     • Extract intent & model observation from context     │
│     • Convert older images to 3-point Markdown cards      │
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
• What's visible: Login modal with email field and sign-in button (screenshot.png)
• Why it was captured: Verify login modal layout after form submission
• Recall: If needed again, read from `/Users/username/.cache/opencode/recent-images/img_3f8a91b2c4e5f607.png`. If missing, rely on the summary above—or if safe to reproduce, re-capture the screen.
```

- **Natural Recall**: The model retains full conversational context. If you or the agent need to inspect an older image again, the model reads the cached path and pulls it back into view.
- **Zero History Corruption**: Transformations happen exclusively in-memory right before provider dispatch. Your persisted SQLite session history is untouched.
- **Persistent Rolling Buffer**: Base64 payloads and ephemeral `/tmp` screenshots are copied to `~/.cache/opencode/recent-images/` with a strict FIFO cap (default 100 files). Images survive even if system `/tmp` is wiped.
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

`opencode-prune-images` works out of the box with safe, production-tested defaults (7 active images, 100 cached files). You can customize behavior via environment variables or programmatically:

| Setting | Default | Environment Variable | Description |
| :--- | :--- | :--- | :--- |
| **Max Images in Context** | `7` | `OPENCODE_MAX_IMAGES` | Number of recent images preserved in full resolution sent to the model. |
| **Max Cache Files** | `100` | — | Maximum files kept in the FIFO rolling buffer before oldest are deleted. |
| **Cache Directory** | `~/.cache/opencode/recent-images` | — | Location where pruned / ephemeral screenshots are backed up. |

### Example: Setting Image Cap via Shell / Config

```bash
export OPENCODE_MAX_IMAGES=5
```

### Programmatic API

If importing or wrapping the plugin in your own setup:

```typescript
import { setMaxImages, setCacheDir, pruneImages } from "opencode-prune-images";

// Set custom window size
setMaxImages(5);

// Set custom cache location
setCacheDir("/path/to/custom/cache");
```

---

## Troubleshooting & FAQ

#### Why 7 images by default?
7 images provide enough visual history for multi-step browser interactions (e.g. navigation, modal open, form input, error state, retry, success verification) while remaining comfortably within the strict payload and token budgets of major vision models (Gemini, Claude 3.7/4.6, GPT-4o/5.6/6).

#### Does this delete my screenshots from disk?
No. Your original screenshots in project directories are never deleted. Only the rolling cache directory (`~/.cache/opencode/recent-images/`) enforces a FIFO cap (default 100 items) to prevent disk bloat over months of automated work.

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
