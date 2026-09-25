import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import plugin, {
  pruneImages,
  persistToRollingCache,
  MAX_IMAGES_IN_CONTEXT,
  DEFAULT_MAX_IMAGES_IN_CONTEXT,
  MAX_IMAGE_BYTES,
  DEFAULT_MAX_IMAGE_BYTES,
  setCacheDir,
  getCacheDir,
  setMaxImages,
  getMaxImages,
  setMaxImageBytes,
  getMaxImageBytes,
  parseByteString,
  enforceCacheCap,
} from "./index";

const TEST_CACHE_DIR = path.join(os.tmpdir(), "opencode-prune-images-test-" + Date.now());

beforeEach(() => {
  setCacheDir(TEST_CACHE_DIR);
  setMaxImages(DEFAULT_MAX_IMAGES_IN_CONTEXT);
  setMaxImageBytes(DEFAULT_MAX_IMAGE_BYTES);
});

afterEach(() => {
  try {
    if (fs.existsSync(TEST_CACHE_DIR)) {
      fs.rmSync(TEST_CACHE_DIR, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup error
  }
});

test("exports standard defaults and getters/setters", () => {
  expect(DEFAULT_MAX_IMAGES_IN_CONTEXT).toBe(7);
  expect(MAX_IMAGES_IN_CONTEXT).toBe(7);
  expect(getMaxImages()).toBe(7);

  expect(DEFAULT_MAX_IMAGE_BYTES).toBe(16 * 1024 * 1024);
  expect(MAX_IMAGE_BYTES).toBe(16 * 1024 * 1024);
  expect(getMaxImageBytes()).toBe(16 * 1024 * 1024);

  setMaxImages(4);
  expect(getMaxImages()).toBe(4);

  // Negative or invalid values should not overwrite
  setMaxImages(-1);
  expect(getMaxImages()).toBe(4);
  setMaxImages(Number.NaN);
  expect(getMaxImages()).toBe(4);

  setMaxImages(7);
  expect(getMaxImages()).toBe(7);

  setMaxImageBytes(3 * 1024 * 1024);
  expect(getMaxImageBytes()).toBe(3 * 1024 * 1024);
  setMaxImageBytes(-100);
  expect(getMaxImageBytes()).toBe(3 * 1024 * 1024);
  setMaxImageBytes(Number.NaN);
  expect(getMaxImageBytes()).toBe(3 * 1024 * 1024);
  setMaxImageBytes(4 * 1024 * 1024);
  expect(getMaxImageBytes()).toBe(4 * 1024 * 1024);

  expect(parseByteString("4MB")).toBe(4 * 1024 * 1024);
  expect(parseByteString("8MB")).toBe(8 * 1024 * 1024);
  expect(parseByteString("64kb")).toBe(64 * 1024);
  expect(parseByteString("1048576")).toBe(1048576);

  expect(getCacheDir()).toBe(TEST_CACHE_DIR);
});

test("no-op when total images is less than or equal to maxImages", () => {
  const messages = [
    {
      role: "user",
      content: "Please check this image",
      parts: [
        { type: "text", text: "Please check this image" },
        { type: "image", image_url: { url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==" } }
      ]
    }
  ];

  const pruned = pruneImages({ messages }, 5);
  expect(pruned).toBe(0);
  expect(messages[0].parts[1].type).toBe("image");
});

test("prunes oldest images when exceeding maxImages", () => {
  const makeImgPart = (id: number) => ({
    type: "image",
    filename: `screenshot-${id}.png`,
    data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  });

  const messages = [
    {
      role: "user",
      content: "Look at these steps",
      parts: [
        { type: "text", text: "Step 1" },
        makeImgPart(1),
        { type: "text", text: "Step 2" },
        makeImgPart(2),
        { type: "text", text: "Step 3" },
        makeImgPart(3),
      ]
    },
    {
      role: "assistant",
      content: "I see steps 1 to 3."
    },
    {
      role: "user",
      content: "Here are more steps",
      parts: [
        { type: "text", text: "Step 4" },
        makeImgPart(4),
        { type: "text", text: "Step 5" },
        makeImgPart(5),
      ]
    }
  ];

  // Total 5 images. Cap at 3 -> prune 2 oldest (Step 1 and Step 2)
  const pruned = pruneImages({ messages }, 3);
  expect(pruned).toBe(2);

  // First 2 images should be converted to text cards
  expect(messages[0].parts[1].type).toBe("text");
  expect((messages[0].parts[1] as { text?: string }).text).toContain("[Pruned Image:");
  expect((messages[0].parts[1] as { text?: string }).text).toContain("screenshot-1.png");

  expect(messages[0].parts[3].type).toBe("text");
  expect((messages[0].parts[3] as { text?: string }).text).toContain("[Pruned Image:");
  expect((messages[0].parts[3] as { text?: string }).text).toContain("screenshot-2.png");

  // Third, fourth, fifth images remain untouched
  expect(messages[0].parts[5].type).toBe("image");
  expect(messages[2].parts[1].type).toBe("image");
  expect(messages[2].parts[3].type).toBe("image");
});

test("persists ephemeral /tmp/ files into rolling cache directory", () => {
  fs.mkdirSync(TEST_CACHE_DIR, { recursive: true });

  const tmpImgPath = path.join(os.tmpdir(), `test-capture-${Date.now()}.png`);
  fs.writeFileSync(tmpImgPath, Buffer.from("dummy-png-data"));

  const cached = persistToRollingCache(undefined, tmpImgPath, "image/png");
  expect(cached).toBeDefined();
  expect(cached).not.toBe(tmpImgPath);
  expect(cached?.startsWith(TEST_CACHE_DIR)).toBe(true);
  expect(fs.existsSync(cached!)).toBe(true);

  // Clean up source tmp
  fs.unlinkSync(tmpImgPath);
});

test("handles file:// URLs correctly", () => {
  fs.mkdirSync(TEST_CACHE_DIR, { recursive: true });

  const tmpImgPath = path.join(os.tmpdir(), `test-fileurl-${Date.now()}.png`);
  fs.writeFileSync(tmpImgPath, Buffer.from("dummy-png-data"));

  const fileUrl = `file://${tmpImgPath}`;
  const cached = persistToRollingCache(undefined, fileUrl, "image/png");

  expect(cached).toBeDefined();
  expect(cached?.startsWith(TEST_CACHE_DIR)).toBe(true);
  expect(fs.existsSync(cached!)).toBe(true);

  fs.unlinkSync(tmpImgPath);
});

test("enforces cache cap with FIFO deletion", () => {
  fs.mkdirSync(TEST_CACHE_DIR, { recursive: true });

  // Create 5 files with distinct times
  for (let i = 0; i < 5; i++) {
    const fPath = path.join(TEST_CACHE_DIR, `img_00${i}.png`);
    fs.writeFileSync(fPath, `data-${i}`);
    const time = new Date(Date.now() - (5 - i) * 1000);
    fs.utimesSync(fPath, time, time);
  }

  expect(fs.readdirSync(TEST_CACHE_DIR).length).toBe(5);

  // Cap at 3
  enforceCacheCap(3);

  const remaining = fs.readdirSync(TEST_CACHE_DIR);
  expect(remaining.length).toBe(3);
  expect(remaining).not.toContain("img_000.png");
  expect(remaining).not.toContain("img_001.png");
  expect(remaining).toContain("img_004.png");
});

test("handles raw data URI strings in tool calls and content", () => {
  const rawDataUri = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const messages = [
    {
      role: "tool",
      content: [
        {
          tool: "take_screenshot",
          result: rawDataUri
        }
      ]
    },
    {
      role: "tool",
      content: [
        {
          tool: "take_screenshot",
          result: rawDataUri
        }
      ]
    }
  ];

  const pruned = pruneImages({ messages }, 1);
  expect(pruned).toBe(1);
  expect(typeof (messages[0].content[0] as { result?: string }).result).toBe("string");
  expect((messages[0].content[0] as { result?: string }).result).toContain("[Pruned Image:");
  expect((messages[1].content[0] as { result?: string }).result).toBe(rawDataUri);
});

test("handles gemini-part inlineData format correctly", () => {
  const messages = [
    {
      role: "user",
      parts: [
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="
          }
        },
        {
          inlineData: {
            mimeType: "image/jpeg",
            data: "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA="
          }
        }
      ]
    }
  ];

  const pruned = pruneImages({ messages }, 1);
  expect(pruned).toBe(1);
  // Gemini part converted to text
  expect((messages[0].parts[0] as { text?: string }).text).toContain("[Pruned Image:");
  expect((messages[0].parts[1] as { inlineData?: unknown }).inlineData).toBeDefined();
});

test("handles empty or malformed inputs without throwing", () => {
  expect(pruneImages(null)).toBe(0);
  expect(pruneImages(undefined)).toBe(0);
  expect(pruneImages({})).toBe(0);
  expect(pruneImages({ messages: [] })).toBe(0);
  expect(pruneImages({ messages: "invalid" as unknown as unknown[] })).toBe(0);
  expect(pruneImages([{ broken: true }])).toBe(0);
});

test("dual-budget cap: prunes older images exceeding maxBytes even when count is under maxImages", () => {
  // Create 4 images, each approx 2.5 MB of payload (total 10 MB).
  // With maxBytes = 6 MB and maxImages = 7:
  // Count is 4 <= 7, but byte total is 10 MB > 6 MB!
  // It should retain the 2 newest (2 * 2.5MB = 5MB <= 6MB) and prune the older 2!
  const chunk2_5MB = "A".repeat(2_500_000);
  const makeLargeImg = (id: number) => ({
    type: "image",
    filename: `big-render-${id}.png`,
    data: `data:image/png;base64,${chunk2_5MB}`,
  });

  const messages = [
    {
      role: "user",
      content: "Analyze visual rendering performance",
      parts: [
        { type: "text", text: "Frame 1" },
        makeLargeImg(1),
        { type: "text", text: "Frame 2" },
        makeLargeImg(2),
      ],
    },
    {
      role: "assistant",
      content: "Observed first two frames.",
    },
    {
      role: "user",
      content: "Here are frames 3 and 4",
      parts: [
        { type: "text", text: "Frame 3" },
        makeLargeImg(3),
        { type: "text", text: "Frame 4" },
        makeLargeImg(4),
      ],
    },
  ];

  // maxImages = 7 (allows all 4 by count), maxBytes = 6 MB
  const maxBytes = 6 * 1024 * 1024;
  const pruned = pruneImages({ messages }, 7, maxBytes);

  expect(pruned).toBe(2);

  // Frames 1 and 2 (older) pruned to 3-point cards
  expect(messages[0].parts[1].type).toBe("text");
  expect((messages[0].parts[1] as { text?: string }).text).toContain("[Pruned Image:");
  expect((messages[0].parts[1] as { text?: string }).text).toContain("big-render-1.png");

  expect(messages[0].parts[3].type).toBe("text");
  expect((messages[0].parts[3] as { text?: string }).text).toContain("[Pruned Image:");
  expect((messages[0].parts[3] as { text?: string }).text).toContain("big-render-2.png");

  // Frames 3 and 4 (newest) kept intact
  expect(messages[2].parts[1].type).toBe("image");
  expect(messages[2].parts[3].type).toBe("image");
});

test("enforces 16MB (16,777,216 bytes) wire base64 default budget", () => {
  // 3 images of 7MB wire base64 length each (total ~21MB)
  // With DEFAULT_MAX_IMAGE_BYTES (16MB) and maxImages (7):
  // Should keep 2 newest (2 * 7MB = 14MB <= 16MB) and prune oldest 1 (7MB)
  const chunk7MB = "B".repeat(7_000_000);
  const makeWireImg = (id: number) => ({
    type: "image",
    filename: `wire-frame-${id}.png`,
    data: `data:image/png;base64,${chunk7MB}`,
  });

  const messages = [
    {
      role: "user",
      content: "Inspect wire frames",
      parts: [
        { type: "text", text: "Wire 1" },
        makeWireImg(1),
        { type: "text", text: "Wire 2" },
        makeWireImg(2),
        { type: "text", text: "Wire 3" },
        makeWireImg(3),
      ],
    },
  ];

  // Run with default budget (maxImages = 7, maxBytes = 16MB)
  const pruned = pruneImages({ messages });
  expect(pruned).toBe(1);

  // Wire 1 (oldest) pruned to 3-point card
  expect(messages[0].parts[1].type).toBe("text");
  expect((messages[0].parts[1] as { text?: string }).text).toContain("[Pruned Image:");
  expect((messages[0].parts[1] as { text?: string }).text).toContain("wire-frame-1.png");

  // Wire 2 and Wire 3 remain intact
  expect(messages[0].parts[3].type).toBe("image");
  expect(messages[0].parts[5].type).toBe("image");
});

test("compaction lifecycle: strips 100% of images to 3-point cards when event.agent === 'compaction'", () => {
  const messages = [
    {
      role: "user",
      content: "Please check design and alignment",
      parts: [
        { type: "text", text: "Initial mockup" },
        {
          type: "image",
          filename: "mockup-desktop.png",
          data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ],
    },
    {
      role: "assistant",
      content: "I reviewed mockup-desktop.png and verified 16px margins.",
    },
    {
      role: "user",
      content: "Here is mobile view",
      parts: [
        { type: "text", text: "Mobile mockup" },
        {
          type: "image",
          filename: "mockup-mobile.png",
          data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ],
    },
  ];

  // Dispatch compaction event
  const event = {
    agent: "compaction",
    messages,
  };

  const pruned = pruneImages(event);
  // 100% of images (both 1 and 2) must be pruned to 3-point cards
  expect(pruned).toBe(2);

  // First image -> 3-point card
  expect(messages[0].parts[1].type).toBe("text");
  const card1 = (messages[0].parts[1] as { text?: string }).text || "";
  expect(card1).toContain("[Pruned Image:");
  expect(card1).toContain("mockup-desktop.png");
  expect(card1).not.toContain("data:image/");

  // Second image -> 3-point card
  expect(messages[2].parts[1].type).toBe("text");
  const card2 = (messages[2].parts[1] as { text?: string }).text || "";
  expect(card2).toContain("[Pruned Image:");
  expect(card2).toContain("mockup-mobile.png");
  expect(card2).not.toContain("data:image/");

  // Zero raw base64 or image parts remain in messages
  for (const msg of messages) {
    if (Array.isArray(msg.parts)) {
      for (const part of msg.parts) {
        expect((part as { type?: string }).type).not.toBe("image");
        expect((part as { data?: string }).data).toBeUndefined();
      }
    }
  }
});

test("compaction lifecycle: strips 100% of images when last message is /compact", () => {
  const messages = [
    {
      role: "user",
      content: "Initial visual check",
      parts: [
        {
          type: "image",
          filename: "view.png",
          data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ],
    },
    {
      role: "assistant",
      content: "Observed view.",
    },
    {
      role: "user",
      content: "/compact",
    },
  ];

  const pruned = pruneImages({ messages });
  expect(pruned).toBe(1);
  expect(messages[0].parts[0].type).toBe("text");
  expect((messages[0].parts[0] as { text?: string }).text).toContain("[Pruned Image:");
  expect((messages[0].parts[0] as { text?: string }).text).not.toContain("data:image/");
});

test("causal chain context extraction across multi-step tool loops", () => {
  // Multi-step loop:
  // user -> tool(bash) -> tool(read image) -> tool(grep) -> assistant("Found 12px alignment issue")
  const messages = [
    {
      role: "user",
      content: "Check UI alignment on the checkout button",
    },
    {
      role: "tool",
      content: [
        {
          tool: "bash",
          result: "git status: clean",
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          tool: "read_screenshot",
          result: "Image read successfully.", // boilerplate!
        },
      ],
      parts: [
        {
          type: "image",
          filename: "checkout-button.png",
          data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          tool: "grep",
          result: "padding: 8px;",
        },
      ],
    },
    {
      role: "assistant",
      content: "Found 12px alignment issue where button padding is overflowing container bounds.",
    },
  ];

  // Cap at 0 images so it prunes
  const pruned = pruneImages({ messages }, 0);
  expect(pruned).toBe(1);

  const prunedPart = messages[2].parts[0] as { type: string; text: string };
  expect(prunedPart.type).toBe("text");
  expect(prunedPart.text).toContain("[Pruned Image:");
  // Intent should crawl backwards skipping intermediate tools to reach user prompt
  expect(prunedPart.text).toContain("Check UI alignment on the checkout button");
  // Observed should skip "Image read successfully." boilerplate and forward crawl to assistant synthesis!
  expect(prunedPart.text).toContain("Found 12px alignment issue where button padding is overflowing");
});

test("defensively avoids double-wrapping already pruned image cards", () => {
  const messages = [
    {
      role: "user",
      content: "Test already pruned",
      parts: [
        {
          type: "text",
          text: "[Pruned Image: /some/path/img.png]\n• What's visible: Something\n• Why it was captured: Prior task\n• Recall: Read from path",
        },
        {
          type: "image",
          filename: "new-capture.png",
          data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
        },
      ],
    },
  ];

  // When prune is run with maxImages = 1, new-capture is kept, pruned card is not touched
  const pruned = pruneImages({ messages }, 1);
  expect(pruned).toBe(0);
  expect((messages[0].parts[0] as { text: string }).text).not.toContain("[Pruned Image: [Pruned Image:");
});

test("plugin structure satisfies OpenCode plugin signature", async () => {
  expect(plugin.id).toBe("opencode.prune-images");
  expect(typeof plugin.setup).toBe("function");
  expect(typeof plugin.server).toBe("function");

  const serverHooks = await plugin.server();
  expect(typeof serverHooks["experimental.chat.messages.transform"]).toBe("function");

  let hookRegistered = false;
  const mockCtx = {
    session: {
      hook: async (name: string) => {
        if (name === "context") hookRegistered = true;
      }
    },
    hook: (_name: string) => {}
  };

  await plugin.setup(mockCtx);
  expect(hookRegistered).toBe(true);
});

// Registers the plugin against a fake OpenCode context and returns the
// handlers by hook name. Names in `failing` throw on registration.
async function setupHooks(failing: string[] = []) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const add = (name: string, fn: (...args: unknown[]) => unknown) => {
    if (failing.includes(name)) throw new Error(`cannot register ${name}`);
    handlers.set(name, fn);
  };
  await plugin.setup({ session: { hook: async (name, fn) => add(name, fn) }, hook: add });
  return handlers;
}

test("compaction session hook strips every image even when the event is not marked as compaction", async () => {
  const compaction = (await setupHooks()).get("compaction");
  expect(compaction).toBeDefined();

  // OpenCode v2 runs compaction under the session's agent, so nothing in the
  // event says "compaction". Three images fit the normal budget of seven.
  const png = "data:image/png;base64,iVBORw0KGgo" + "A".repeat(400);
  const event = {
    agent: "build",
    messages: [0, 1, 2].map((i) => ({
      role: "tool",
      content: [{ type: "tool-result", id: `t${i}`, name: "screenshot",
        result: { type: "content", value: [{ type: "file", uri: png + i, mime: "image/png", name: `s${i}.png` }] } }],
    })),
  };
  await compaction!(event);

  const values = event.messages.flatMap((m) => m.content.flatMap((p) => p.result.value as { type: string; text?: string }[]));
  expect(values.filter((v) => v.type === "file")).toHaveLength(0);
  expect(values.every((v) => String(v.text).includes("[Pruned Image:"))).toBe(true);
});

test("a hook that fails to register does not stop the others", async () => {
  const handlers = await setupHooks(["context"]);
  expect([...handlers.keys()].sort()).toEqual(["compaction", "experimental.chat.messages.transform"]);
});

test("V1 tool attachments prune to output cards without breaking downstream shapes", () => {
  // Real read-tool shape: type file attachments with data URLs under
  // state.attachments. Pruned entries must leave the array and land in
  // state.output, because downstream code reads card text from neither a
  // replaced attachment object nor a rewritten attachment URL.
  const tiny = "data:image/png;base64," + "A".repeat(1000);
  const messages = [
    { role: "user", content: "check", parts: [{ type: "text", text: "check screenshots" }] },
    {
      role: "assistant",
      content: "",
      parts: [
        {
          type: "tool",
          id: "p1",
          tool: "read",
          callID: "c1",
          state: {
            status: "completed",
            input: { filePath: "/tmp/shot.png" },
            output: "Image read successfully",
            time: { start: 1, end: 2 },
            attachments: [
              { type: "file", mime: "image/png", url: `${tiny}1` },
              { type: "file", mime: "image/png", url: `${tiny}2` },
              { type: "file", mime: "image/png", url: `${tiny}3` },
            ],
          },
        },
      ],
    },
  ];

  const pruned = pruneImages({ messages }, 1, 16 * 1024 * 1024);
  expect(pruned).toBe(2);

  const tool = (messages[1] as any).parts[0];
  const attachments = tool.state.attachments;
  expect(attachments.length).toBe(1);
  expect(attachments[0].url).toBe(`${tiny}3`);

  // Both cards live in the tool output next to the original text.
  expect(tool.state.output).toContain("Image read successfully");
  expect((tool.state.output.match(/\[Pruned Image:/g) || []).length).toBe(2);

  // Downstream data URL filter must not throw and must keep the survivor.
  const kept = attachments.filter((a: any) => a.url.startsWith("data:") && a.url.includes(","));
  expect(kept.length).toBe(1);

  // Compaction-style serialization must show defined labels plus cards.
  const serialized = [
    tool.state.output,
    ...attachments.map((item: any) => `[Attached ${item.mime}: ${item.filename ?? "file"}]`),
  ].join("\n");
  expect(serialized).not.toContain("undefined");
  expect(serialized).toContain("[Pruned Image:");
});
