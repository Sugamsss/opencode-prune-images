import { test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import plugin, {
  pruneImages,
  persistToRollingCache,
  MAX_IMAGES_IN_CONTEXT,
  DEFAULT_MAX_IMAGES_IN_CONTEXT,
  setCacheDir,
  getCacheDir,
  setMaxImages,
  getMaxImages,
  enforceCacheCap,
} from "./index";

const TEST_CACHE_DIR = path.join(os.tmpdir(), "opencode-prune-images-test-" + Date.now());

beforeEach(() => {
  setCacheDir(TEST_CACHE_DIR);
  setMaxImages(DEFAULT_MAX_IMAGES_IN_CONTEXT);
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

  setMaxImages(4);
  expect(getMaxImages()).toBe(4);

  // Negative or invalid values should not overwrite
  setMaxImages(-1);
  expect(getMaxImages()).toBe(4);
  setMaxImages(Number.NaN);
  expect(getMaxImages()).toBe(4);

  setMaxImages(7);
  expect(getMaxImages()).toBe(7);

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
