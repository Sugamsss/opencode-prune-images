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

  expect(DEFAULT_MAX_IMAGE_BYTES).toBe(8 * 1024 * 1024);
  expect(MAX_IMAGE_BYTES).toBe(8 * 1024 * 1024);
  expect(getMaxImageBytes()).toBe(8 * 1024 * 1024);

  setMaxImages(4);
  expect(getMaxImages()).toBe(4);

  // Negative or invalid values should not overwrite
  setMaxImages(-1);
  expect(getMaxImages()).toBe(4);
  setMaxImages(Number.NaN);
  expect(getMaxImages()).toBe(4);

  setMaxImages(7);
  expect(getMaxImages()).toBe(7);

  setMaxImageBytes(6 * 1024 * 1024);
  expect(getMaxImageBytes()).toBe(6 * 1024 * 1024);
  setMaxImageBytes(-100);
  expect(getMaxImageBytes()).toBe(6 * 1024 * 1024);
  setMaxImageBytes(Number.NaN);
  expect(getMaxImageBytes()).toBe(6 * 1024 * 1024);
  setMaxImageBytes(8 * 1024 * 1024);
  expect(getMaxImageBytes()).toBe(8 * 1024 * 1024);

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
