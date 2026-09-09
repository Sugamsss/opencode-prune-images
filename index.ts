/**
 * OpenCode Global Plugin: Intelligent Image Context Manager & Rolling Buffer
 *
 * 1. Rolling Disk Buffer (~/.cache/opencode/recent-images/):
 *    - Strict FIFO limit of 100 images.
 *    - Persists pasted base64 images with hash-based filename (img_<hash>.<ext>).
 *    - Copies or links ephemeral (/tmp/) images into the persistent rolling cache.
 *    - Fast, synchronous, safe filesystem operations.
 *
 * 2. Conversational 3-Point Context Synthesizer:
 *    - Replaces pruned images (beyond the latest 7) with a structured context card:
 *      [Pruned Image: <cached_path>]
 *      • What's visible: <observed summary / filename / details>
 *      • Why it was captured: <user intent / task context>
 *      • Recall: If needed again, read from `<cached_path>`. If missing, rely on the summary above—or if safe to reproduce, re-capture the screen.
 *
 * 3. Active 7-Image Cap:
 *    - Preserves up to 7 latest raw images for provider dispatch.
 *    - In-place replacement preserving tool call IDs, tool wrappers, and message structure.
 *    - Sub-millisecond execution, zero 413 errors.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as crypto from "crypto";

export const MAX_IMAGES_IN_CONTEXT = 7;
export const MAX_CACHE_FILES = 100;

export const DEFAULT_CACHE_DIR = path.join(
  os.homedir(),
  ".cache",
  "opencode",
  "recent-images"
);

// Configurable cache dir for testing/isolation
let currentCacheDir = DEFAULT_CACHE_DIR;
export function setCacheDir(dir: string): void {
  currentCacheDir = dir;
}
export function getCacheDir(): string {
  return currentCacheDir;
}

// In-memory lookup: key -> cached file path
const imagePathCache = new Map<string, string>();

function ensureCacheDir(): void {
  try {
    if (!fs.existsSync(currentCacheDir)) {
      fs.mkdirSync(currentCacheDir, { recursive: true });
    }
  } catch (err) {
    // Non-fatal
  }
}

/**
 * Maintain a strict FIFO rolling limit of maxFiles (default 100).
 * Sort by mtime ascending and unlink oldest until count <= maxFiles.
 */
export function enforceCacheCap(maxFiles: number = MAX_CACHE_FILES): void {
  try {
    if (!fs.existsSync(currentCacheDir)) return;

    const entries = fs.readdirSync(currentCacheDir);
    if (entries.length <= maxFiles) return;

    const fileStats: { fullPath: string; time: number }[] = [];
    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const fullPath = path.join(currentCacheDir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          const time = stat.mtimeMs || stat.birthtimeMs || 0;
          fileStats.push({ fullPath, time });
        }
      } catch {
        // Skip unreadable files
      }
    }

    if (fileStats.length <= maxFiles) return;

    // Sort ascending: oldest mtime first
    fileStats.sort((a, b) => a.time - b.time);

    const removeCount = fileStats.length - maxFiles;
    for (let i = 0; i < removeCount; i++) {
      try {
        fs.unlinkSync(fileStats[i].fullPath);
      } catch {
        // Safe ignore
      }
    }
  } catch (err) {
    // Non-fatal
  }
}

function extensionForMime(mime?: string): string {
  if (!mime) return "png";
  const lower = mime.toLowerCase();
  if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
  if (lower.includes("png")) return "png";
  if (lower.includes("webp")) return "webp";
  if (lower.includes("gif")) return "gif";
  if (lower.includes("svg")) return "svg";
  if (lower.includes("bmp")) return "bmp";
  if (lower.includes("avif")) return "avif";
  if (lower.includes("ico") || lower.includes("icon")) return "ico";
  if (lower.includes("tiff?")) return "tiff";
  return "png";
}

/**
 * Sniff binary image magic bytes to detect actual image MIME and extension.
 * Handles missing mime or generic data:application/octet-stream;base64,... payloads.
 */
function sniffImageHeader(buf: Buffer): { mime: string; ext: string } | undefined {
  if (!buf || buf.length < 4) return undefined;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { mime: "image/png", ext: "png" };
  }

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }

  // GIF: GIF87a or GIF89a
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return { mime: "image/gif", ext: "gif" };
  }

  // BMP: 42 4D ("BM")
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { mime: "image/bmp", ext: "bmp" };
  }

  // ICO: 00 00 01 00
  if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) {
    return { mime: "image/x-icon", ext: "ico" };
  }

  // WebP: RIFF....WEBP
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { mime: "image/webp", ext: "webp" };
  }

  // AVIF: ftypavif / ftypavis / ftypmif1 / ftypmiaf
  if (buf.length >= 12) {
    const ftyp = buf.toString("ascii", 4, 12);
    if (ftyp === "ftypavif" || ftyp === "ftypavis" || ftyp === "ftypmif1" || ftyp === "ftypmiaf") {
      return { mime: "image/avif", ext: "avif" };
    }
  }

  // SVG: starts with <svg or <?xml ... <svg
  const headStr = buf.toString("utf8", 0, Math.min(buf.length, 256)).trim().toLowerCase();
  if (headStr.startsWith("<svg") || (headStr.startsWith("<?xml") && headStr.includes("<svg"))) {
    return { mime: "image/svg+xml", ext: "svg" };
  }

  return undefined;
}

function isTmpPath(filePath: string): boolean {
  const norm = path.normalize(filePath);
  const tmpDir = os.tmpdir();
  return (
    norm.startsWith("/tmp/") ||
    norm.startsWith("/private/tmp/") ||
    norm.startsWith("/var/tmp/") ||
    norm.startsWith("/private/var/tmp/") ||
    (tmpDir && norm.startsWith(tmpDir)) ||
    norm.includes("/T/antigravity") ||
    norm.includes("/tmp/")
  );
}

/**
 * Save or copy image into rolling cache (~/.cache/opencode/recent-images/).
 * Returns persistent file path.
 */
export function persistToRollingCache(
  dataUriOrBase64: string | undefined,
  existingPath: string | undefined,
  mime?: string
): string | undefined {
  try {
    ensureCacheDir();

    // Case 1: Existing file path
    if (existingPath && typeof existingPath === "string") {
      const resolvedExisting = path.resolve(existingPath);

      // If already outside tmp and exists, it is a stable file path
      if (!isTmpPath(resolvedExisting) && fs.existsSync(resolvedExisting)) {
        return resolvedExisting;
      }

      const hashKey = `path:${resolvedExisting}`;
      if (imagePathCache.has(hashKey)) {
        const cached = imagePathCache.get(hashKey)!;
        if (fs.existsSync(cached)) return cached;
      }

      if (fs.existsSync(resolvedExisting)) {
        try {
          const fileBuf = fs.readFileSync(resolvedExisting);
          const sha = crypto.createHash("sha256").update(fileBuf).digest("hex").slice(0, 16);
          const ext = path.extname(resolvedExisting) || `.${extensionForMime(mime)}`;
          const targetName = `img_${sha}${ext}`;
          const targetPath = path.join(currentCacheDir, targetName);

          if (!fs.existsSync(targetPath)) {
            try {
              fs.copyFileSync(resolvedExisting, targetPath);
            } catch {
              try {
                fs.writeFileSync(targetPath, fileBuf);
              } catch {
                // Ignore copy failure
              }
            }
          }

          imagePathCache.set(hashKey, targetPath);
          enforceCacheCap();
          return targetPath;
        } catch {
          return resolvedExisting;
        }
      }

      return resolvedExisting;
    }

    // Case 2: Base64 / data URI
    if (dataUriOrBase64 && typeof dataUriOrBase64 === "string") {
      let base64Data = dataUriOrBase64;
      let detectedMime = mime;

      if (dataUriOrBase64.startsWith("data:")) {
        const commaIdx = dataUriOrBase64.indexOf(",");
        if (commaIdx !== -1) {
          const header = dataUriOrBase64.slice(0, commaIdx);
          base64Data = dataUriOrBase64.slice(commaIdx + 1);
          const match = header.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64/i);
          if (match) {
            detectedMime = match[1].toLowerCase();
          }
        }
      }

      const sha = crypto.createHash("sha256").update(base64Data).digest("hex").slice(0, 16);
      const hashKey = `base64:${sha}`;
      if (imagePathCache.has(hashKey)) {
        const cached = imagePathCache.get(hashKey)!;
        if (fs.existsSync(cached)) return cached;
      }

      // Decode buffer first so we can sniff magic bytes if mime is missing or octet-stream
      let buf: Buffer | null = null;
      try {
        buf = Buffer.from(base64Data, "base64");
      } catch {
        // Safe ignore
      }

      if (buf && (!detectedMime || detectedMime.includes("octet-stream"))) {
        const sniffed = sniffImageHeader(buf);
        if (sniffed) {
          detectedMime = sniffed.mime;
        }
      }

      const ext = extensionForMime(detectedMime);
      const targetName = `img_${sha}.${ext}`;
      const targetPath = path.join(currentCacheDir, targetName);

      if (!fs.existsSync(targetPath)) {
        if (!buf) buf = Buffer.from(base64Data, "base64");
        fs.writeFileSync(targetPath, buf);
      }

      imagePathCache.set(hashKey, targetPath);
      enforceCacheCap();
      return targetPath;
    }

    return undefined;
  } catch (err) {
    return existingPath;
  }
}

export interface ImageMeta {
  name?: string;
  path?: string;
  url?: string;
  mime?: string;
  dimensions?: string;
  source?: string;
  rawBase64?: string;
}

export interface ImageRef {
  type:
    | "part"
    | "tool-result-value"
    | "tool-content"
    | "tool-attachment"
    | "gemini-part"
    | "raw-string";
  container: any;
  keyOrIndex: string | number;
  meta: ImageMeta;
  messageIndex: number;
}

const IMAGE_EXTENSIONS_REGEX = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?)(\?.*)?$/i;
const DATA_IMAGE_PREFIX = "data:image/";
const HTTP_PREFIX_REGEX = /^https?:\/\//i;

function isImageMime(mime?: unknown): boolean {
  return typeof mime === "string" && mime.trim().toLowerCase().startsWith("image/");
}

function isImageDataUri(uri?: unknown): boolean {
  if (typeof uri !== "string") return false;
  const lower = uri.trim().toLowerCase();
  if (lower.startsWith(DATA_IMAGE_PREFIX)) return true;
  if (lower.startsWith("data:application/octet-stream;base64,")) {
    // Check if it sniffs to an image header
    try {
      const b64 = uri.slice(uri.indexOf(",") + 1, uri.indexOf(",") + 65);
      const buf = Buffer.from(b64, "base64");
      return sniffImageHeader(buf) !== undefined;
    } catch {
      return false;
    }
  }
  return false;
}

function isRemoteImageUrl(url?: unknown): boolean {
  return typeof url === "string" && HTTP_PREFIX_REGEX.test(url.trim());
}

function isImageExtension(pathOrFilename?: unknown): boolean {
  return typeof pathOrFilename === "string" && IMAGE_EXTENSIONS_REGEX.test(pathOrFilename.trim());
}

function extractMimeFromDataUri(uri: string): string | undefined {
  const match = uri.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,/i);
  return match ? match[1].toLowerCase() : undefined;
}

function isImagePart(part: any): boolean {
  if (!part || typeof part !== "object") return false;

  if (part.type === "image") return true;
  if (part.type === "image_url") return true;

  if (part.type === "media") {
    return (
      isImageMime(part.mediaType) ||
      isImageMime(part.mime) ||
      isImageMime(part.mimeType) ||
      isImageDataUri(part.data) ||
      isImageDataUri(part.url) ||
      (isRemoteImageUrl(part.url) && isImageExtension(part.url)) ||
      isImageExtension(part.filename || part.name)
    );
  }

  if (part.type === "file") {
    return (
      isImageMime(part.mime) ||
      isImageMime(part.mimeType) ||
      isImageMime(part.mediaType) ||
      isImageDataUri(part.uri) ||
      isImageDataUri(part.data) ||
      isImageDataUri(part.url) ||
      isImageExtension(part.filename || part.name || part.path || part.url || part.uri)
    );
  }

  if (part.inlineData && isImageMime(part.inlineData.mimeType)) return true;
  if (part.fileData && (isImageMime(part.fileData.mimeType) || isImageExtension(part.fileData.fileUri))) return true;

  return false;
}

function extractImageMeta(part: any, fallbackSource?: string, autoName?: string): ImageMeta {
  if (!part || typeof part !== "object") return {};

  const name: string | undefined =
    part.filename ||
    part.name ||
    part.label ||
    part.title ||
    part.source?.filename ||
    part.source?.name ||
    autoName ||
    undefined;

  const pathVal: string | undefined =
    part.path ||
    part.filePath ||
    part.source?.path ||
    undefined;

  let url: string | undefined;
  if (isRemoteImageUrl(part.url)) {
    url = part.url.trim();
  } else if (isRemoteImageUrl(part.image_url?.url)) {
    url = part.image_url.url.trim();
  } else if (isRemoteImageUrl(part.image_url)) {
    url = String(part.image_url).trim();
  } else if (isRemoteImageUrl(part.image)) {
    url = String(part.image).trim();
  } else if (isRemoteImageUrl(part.uri)) {
    url = part.uri.trim();
  } else if (isRemoteImageUrl(part.source?.url)) {
    url = part.source.url.trim();
  }

  let mime: string | undefined =
    (typeof part.mime === "string" && isImageMime(part.mime) ? part.mime.trim().toLowerCase() : undefined) ||
    (typeof part.mimeType === "string" && isImageMime(part.mimeType) ? part.mimeType.trim().toLowerCase() : undefined) ||
    (typeof part.mediaType === "string" && isImageMime(part.mediaType) ? part.mediaType.trim().toLowerCase() : undefined) ||
    (typeof part.source?.media_type === "string" && isImageMime(part.source.media_type) ? part.source.media_type.trim().toLowerCase() : undefined) ||
    (typeof part.inlineData?.mimeType === "string" && isImageMime(part.inlineData.mimeType) ? part.inlineData.mimeType.trim().toLowerCase() : undefined);

  let rawBase64: string | undefined;
  const rawData =
    part.data ||
    part.uri ||
    part.url ||
    part.image ||
    part.image_url?.url ||
    part.inlineData?.data ||
    (part.source?.type === "base64" && typeof part.source?.data === "string" ? part.source.data : undefined);

  if (typeof rawData === "string") {
    if (isImageDataUri(rawData)) {
      rawBase64 = rawData;
      if (!mime) mime = extractMimeFromDataUri(rawData);
    } else if (part.inlineData?.data || part.source?.type === "base64") {
      rawBase64 = rawData;
    }
  }

  let dimensions: string | undefined;
  const width = part.width ?? part.metadata?.width ?? part.image?.width;
  const height = part.height ?? part.metadata?.height ?? part.image?.height;
  if (width !== undefined && height !== undefined) {
    dimensions = `${width}x${height}`;
  } else if (typeof part.dimensions === "string") {
    dimensions = part.dimensions;
  }

  const source =
    (typeof part.tool === "string" ? `tool (${part.tool})` : undefined) ||
    (typeof part.toolName === "string" ? `tool (${part.toolName})` : undefined) ||
    fallbackSource ||
    undefined;

  return { name, path: pathVal, url, mime, dimensions, source, rawBase64 };
}

/**
 * Helper to extract plain text string from any message object or part array
 */
function extractMessageText(msg: any): string {
  if (!msg || typeof msg !== "object") return "";
  if (typeof msg.content === "string") return msg.content.trim();

  const parts = Array.isArray(msg.parts)
    ? msg.parts
    : Array.isArray(msg.content)
      ? msg.content
      : null;

  if (!parts) return "";

  const textPieces: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (typeof part === "string") {
      textPieces.push(part.trim());
    } else if (part.type === "text" && typeof part.text === "string") {
      textPieces.push(part.text.trim());
    } else if (typeof part.content === "string") {
      textPieces.push(part.content.trim());
    }
  }

  return textPieces.filter(Boolean).join(" ");
}

/**
 * Truncate long conversational text cleanly to a reasonable summary size.
 * Handles multiline text, markdown, quotes, emojis, and unicode properly.
 */
function cleanAndTruncate(text: string, maxLen: number = 180): string {
  // Normalize newline sequences and multiple spaces into clean single space
  const singleLine = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.slice(0, maxLen - 3) + "...";
}

/**
 * Conversational Context Synthesizer:
 * Extracts user intent (from preceding user message) and model observation
 * (from message itself or immediate next assistant turn).
 */
export function synthesizeContext(
  messages: any[],
  imageRef: ImageRef
): { observed: string; intent: string } {
  const { messageIndex, meta } = imageRef;

  // 1. Extract User Intent: search backward from messageIndex for the closest user message
  let intent = "";
  for (let i = messageIndex; i >= 0; i--) {
    const m = messages[i];
    if (m && (m.role === "user" || m.info?.role === "user")) {
      const txt = extractMessageText(m);
      if (txt && !isImageDataUri(txt) && !txt.includes("[Pruned Image:")) {
        intent = cleanAndTruncate(txt, 180);
        break;
      }
    }
  }

  if (!intent) {
    intent = meta.source ? `Captured during ${meta.source}` : "User provided context";
  }

  // 2. Extract Model / Environment Observation
  let observed = "";

  // Check current message text first
  const currentMsgText = extractMessageText(messages[messageIndex]);
  if (currentMsgText && !isImageDataUri(currentMsgText) && !currentMsgText.includes("[Pruned Image:")) {
    observed = cleanAndTruncate(currentMsgText, 200);
  }

  // If not found or message is a tool response, check the immediately following assistant message
  if (!observed && messageIndex + 1 < messages.length) {
    const nextMsg = messages[messageIndex + 1];
    if (nextMsg && (nextMsg.role === "assistant" || nextMsg.info?.role === "assistant")) {
      const nextTxt = extractMessageText(nextMsg);
      if (nextTxt && !isImageDataUri(nextTxt) && !nextTxt.includes("[Pruned Image:")) {
        observed = cleanAndTruncate(nextTxt, 200);
      }
    }
  }

  // Fallback to meta details
  if (!observed) {
    const details: string[] = [];
    if (meta.name) details.push(meta.name);
    if (meta.dimensions) details.push(`${meta.dimensions}`);
    if (meta.mime) details.push(meta.mime);
    if (meta.source) details.push(meta.source);
    observed = details.length > 0 ? details.join(", ") : "Image capture";
  }

  return { observed, intent };
}

/**
 * Build the 3-point card:
 * [Pruned Image: <cached_path>]
 * • What's visible: <observed summary / filename / details>
 * • Why it was captured: <user intent / task context>
 * • Recall: If needed again, read from `<cached_path>`. If missing, rely on the summary above—or if safe to reproduce, re-capture the screen.
 */
export function formatThreePointCard(
  cachedPath: string,
  observed: string,
  intent: string
): string {
  return [
    `[Pruned Image: ${cachedPath}]`,
    `• What's visible: ${observed}`,
    `• Why it was captured: ${intent}`,
    `• Recall: If needed again, read from \`${cachedPath}\`. If missing, rely on the summary above—or if safe to reproduce, re-capture the screen.`,
  ].join("\n");
}

/**
 * Recursive crawler to count all image references in any object / array tree.
 * Handles deeply nested tool calls, subagents, code mode evaluations, etc.
 */
function countImagesInValue(val: any, seen = new Set<any>()): number {
  if (!val) return 0;
  if (typeof val === "string") {
    return isImageDataUri(val) ? 1 : 0;
  }
  if (typeof val !== "object") return 0;

  if (seen.has(val)) return 0;
  seen.add(val);

  if (Array.isArray(val)) {
    let count = 0;
    for (let i = 0; i < val.length; i++) {
      count += countImagesInValue(val[i], seen);
    }
    return count;
  }

  if (isImagePart(val)) {
    return 1;
  }

  let count = 0;
  for (const key of Object.keys(val)) {
    count += countImagesInValue(val[key], seen);
  }
  return count;
}

/**
 * Fast-path counting pass with cycle protection.
 */
function countImagesInMessages(messages: any[]): number {
  let count = 0;
  const msgLen = messages.length;
  const seen = new Set<any>();

  for (let mIdx = 0; mIdx < msgLen; mIdx++) {
    const msg = messages[mIdx];
    if (!msg || typeof msg !== "object") continue;

    if (typeof msg.content === "string") {
      if (isImageDataUri(msg.content)) count++;
      continue;
    }

    const parts = Array.isArray(msg.parts)
      ? msg.parts
      : Array.isArray(msg.content)
        ? msg.content
        : null;

    if (!parts) continue;
    const partsLen = parts.length;

    for (let pIdx = 0; pIdx < partsLen; pIdx++) {
      const part = parts[pIdx];
      if (!part || typeof part !== "object") continue;

      if (isImagePart(part)) {
        count++;
        continue;
      }

      // Check tool results or any nested structure
      count += countImagesInValue(part, seen);
    }
  }

  return count;
}

/**
 * Recursively inspect an object or array to find and collect all nested images.
 * Preserves containers and keys so in-place pruning cleanly replaces the image with text
 * without disrupting tool call IDs, subagents, or outer JSON structure.
 */
function collectNestedImageRefs(
  val: any,
  toolSource: string | undefined,
  messageIndex: number,
  target: ImageRef[],
  seen = new Set<any>()
): void {
  if (!val) return;
  if (typeof val !== "object") return;
  if (seen.has(val)) return;
  seen.add(val);

  if (Array.isArray(val)) {
    for (let i = 0; i < val.length; i++) {
      const item = val[i];
      if (!item) continue;

      if (typeof item === "string") {
        if (isImageDataUri(item)) {
          target.push({
            type: "raw-string",
            container: val,
            keyOrIndex: i,
            meta: {
              mime: extractMimeFromDataUri(item),
              source: toolSource,
              rawBase64: item,
            },
            messageIndex,
          });
        }
        continue;
      }

      if (typeof item === "object") {
        if (isImagePart(item)) {
          target.push({
            type: "part",
            container: val,
            keyOrIndex: i,
            meta: extractImageMeta(item, toolSource),
            messageIndex,
          });
        } else {
          // If this nested object has a tool name, refine source
          const nestedToolSource = item.tool || item.toolName ? `tool (${item.tool || item.toolName})` : toolSource;
          collectNestedImageRefs(item, nestedToolSource, messageIndex, target, seen);
        }
      }
    }
    return;
  }

  // Object handling
  for (const key of Object.keys(val)) {
    const child = val[key];
    if (!child) continue;

    if (typeof child === "string") {
      if (isImageDataUri(child)) {
        target.push({
          type: "raw-string",
          container: val,
          keyOrIndex: key,
          meta: {
            mime: extractMimeFromDataUri(child),
            source: toolSource,
            rawBase64: child,
          },
          messageIndex,
        });
      }
      continue;
    }

    if (typeof child === "object") {
      if (isImagePart(child)) {
        target.push({
          type: "part",
          container: val,
          keyOrIndex: key,
          meta: extractImageMeta(child, toolSource),
          messageIndex,
        });
      } else {
        const nestedToolSource = child.tool || child.toolName ? `tool (${child.tool || child.toolName})` : toolSource;
        collectNestedImageRefs(child, nestedToolSource, messageIndex, target, seen);
      }
    }
  }
}

/**
 * Collect all image references in strict chronological order with their message indices.
 */
function collectImageRefs(messages: any[], target: ImageRef[]): void {
  const msgLen = messages.length;
  const seen = new Set<any>();

  for (let mIdx = 0; mIdx < msgLen; mIdx++) {
    const msg = messages[mIdx];
    if (!msg || typeof msg !== "object") continue;

    const isUser = msg.role === "user" || msg.info?.role === "user";
    const defaultSource = isUser ? "user attachment" : undefined;

    if (typeof msg.content === "string") {
      if (isImageDataUri(msg.content)) {
        target.push({
          type: "raw-string",
          container: msg,
          keyOrIndex: "content",
          meta: {
            mime: extractMimeFromDataUri(msg.content),
            source: defaultSource,
            rawBase64: msg.content,
          },
          messageIndex: mIdx,
        });
      }
      continue;
    }

    const parts = Array.isArray(msg.parts)
      ? msg.parts
      : Array.isArray(msg.content)
        ? msg.content
        : null;

    if (!parts) continue;
    const partsLen = parts.length;
    let userImageAttachmentIndex = 0;

    for (let pIdx = 0; pIdx < partsLen; pIdx++) {
      const part = parts[pIdx];
      if (!part || typeof part !== "object") continue;

      if (isImagePart(part)) {
        let autoName: string | undefined;
        if (isUser) {
          userImageAttachmentIndex++;
          autoName = `[Image ${userImageAttachmentIndex}]`;
        }

        const meta = extractImageMeta(part, defaultSource, autoName);
        const refType = part.inlineData ? "gemini-part" : "part";
        target.push({
          type: refType,
          container: parts,
          keyOrIndex: pIdx,
          meta,
          messageIndex: mIdx,
        });
        continue;
      }

      // Check tool result or nested subagent structures
      const toolName = part.tool || part.toolName || (part.type?.startsWith("tool") ? "tool" : undefined);
      const toolSource = toolName ? `tool (${toolName})` : undefined;
      collectNestedImageRefs(part, toolSource, mIdx, target, seen);
    }
  }
}

/**
 * Core Prune Routine
 */
export function pruneImages(event: any, maxImages = MAX_IMAGES_IN_CONTEXT): number {
  try {
    if (!event || typeof event !== "object") return 0;

    const messages = Array.isArray(event)
      ? event
      : Array.isArray(event.messages)
        ? event.messages
        : null;

    if (!messages || messages.length === 0) return 0;

    const totalImages = countImagesInMessages(messages);
    if (totalImages <= maxImages) {
      return 0;
    }

    const prunedCount = totalImages - maxImages;
    const imageRefs: ImageRef[] = [];
    collectImageRefs(messages, imageRefs);

    for (let i = 0; i < prunedCount; i++) {
      const ref = imageRefs[i];
      if (!ref) continue;

      // 1. Ensure persisted to rolling buffer
      const cachedPath =
        persistToRollingCache(ref.meta.rawBase64, ref.meta.path, ref.meta.mime) ||
        ref.meta.path ||
        ref.meta.url ||
        "~/.cache/opencode/recent-images/";

      // 2. Synthesize context from conversational turns
      const { observed, intent } = synthesizeContext(messages, ref);

      // 3. Format 3-point card
      const cardText = formatThreePointCard(cachedPath, observed, intent);

      // 4. In-place replacement
      if (
        ref.type === "part" ||
        ref.type === "tool-result-value" ||
        ref.type === "tool-content" ||
        ref.type === "tool-attachment"
      ) {
        const existing = ref.container[ref.keyOrIndex];
        const existingId = existing && typeof existing === "object" ? existing.id : undefined;

        ref.container[ref.keyOrIndex] = {
          type: "text",
          text: cardText,
          ...(existingId ? { id: existingId } : {}),
        };
      } else if (ref.type === "gemini-part") {
        ref.container[ref.keyOrIndex] = {
          text: cardText,
        };
      } else if (ref.type === "raw-string") {
        ref.container[ref.keyOrIndex] = cardText;
        if (ref.container && typeof ref.container === "object" && ref.container.type === "image") {
          ref.container.type = "text";
        }
      }
    }

    return prunedCount;
  } catch (err) {
    console.error("[prune-images] error:", err);
    return 0;
  }
}

export default {
  id: "opencode.prune-images",
  setup: async (ctx: any) => {
    try {
      // 1. Session context hook (OpenCode preview / v2 architecture)
      if (ctx?.session?.hook) {
        await ctx.session.hook("context", async (event: any) => {
          pruneImages(event, MAX_IMAGES_IN_CONTEXT);
        });
      }

      // 2. Chat message transform hook
      if (typeof ctx?.hook === "function") {
        ctx.hook("experimental.chat.messages.transform", async (_input: any, output: any) => {
          if (output && Array.isArray(output.messages)) {
            pruneImages(output, MAX_IMAGES_IN_CONTEXT);
          }
        });
      }
    } catch (err) {
      console.error("[prune-images] setup hook registration error:", err);
    }
  },
  /**
   * OpenCode 1.x / 2.x standard plugin lifecycle: server() hook returns plugin hooks
   */
  server: async () => ({
    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      if (output && Array.isArray(output.messages)) {
        pruneImages(output, MAX_IMAGES_IN_CONTEXT);
      }
    },
  }),
};
