# opencode-prune-images

Keep OpenCode chats fast and crash-free by capping active image payloads sent to the LLM.

When agent workflows use browser tools (Playwright, Chrome DevTools, or screenshot loops), chats quickly accumulate dozens of base64 images. Eventually, providers reject the request with:

`413 Request Entity Too Large` or `Request contains too many images`

Once that happens, the session gets wedged because the images stay in the transcript.

`opencode-prune-images` fixes this quietly in-memory right before dispatch.

## How it works

1. **Active 7-image window**: The latest 7 images reach the model in full visual resolution.
2. **Older images turn into cards**: Earlier images are converted into lightweight text cards capturing the file path, what was observed, and why it was taken.
3. **Natural recall**: If you ask about an older screenshot later, the model reads the file path from the card and pulls it back into the active slots.
4. **Zero history corruption**: Operates in-memory during the context transform hook. Your persisted SQLite session history is untouched.
5. **Rolling local buffer**: Ephemeral `/tmp` captures and pasted base64 data are backed up to a rolling 100-file cache (`~/.cache/opencode/recent-images/`), so images can be re-read even if `/tmp` was cleared.

## Install

Add it to your `opencode.json` or `opencode.jsonc`:

```json
{
  "plugin": ["opencode-prune-images"]
}
```

Or install it globally:

```bash
npm install -g opencode-prune-images
```

## Requirements

- OpenCode 2 (or 1.18+)
- Works across all providers (OpenAI, Anthropic, Gemini, local 9Router)

## License

MIT
