/**
 * OpenCode Plugin: Intelligent Image Context Manager & Rolling Buffer
 *
 * Prevents 413 "Request Entity Too Large" and "Too many images" errors by
 * capping active visual images sent to LLMs while preserving full conversational
 * recall through contextual text cards and a persistent FIFO disk buffer.
 *
 * 1. Rolling Disk Buffer (~/.cache/opencode/recent-images/):
 *    - Strict FIFO limit of 100 images (configurable).
 *    - Persists pasted base64 data and copies ephemeral (/tmp) screenshots.
 *    - Safe, synchronous, zero-dependency filesystem operations.
 *
 * 2. Conversational 3-Point Context Cards:
 *    - Replaces pruned images with structured metadata:
 *      [Pruned Image: <cached_path>]
 *      • What's visible: <observed summary / filename / details>
 *      • Why it was captured: <user intent / task context>
 *      • Recall: If needed again, read from `<cached_path>`.
 *
 * 3. Active Window Cap:
 *    - Preserves up to 7 (configurable via OPENCODE_MAX_IMAGES or setMaxImages)
 *      latest raw images for provider dispatch.
 *    - In-place mutation preserving tool call IDs, wrappers, and message structure.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

export const DEFAULT_MAX_IMAGES_IN_CONTEXT = 7;
export const DEFAULT_MAX_CACHE_FILES = 100;

export const DEFAULT_CACHE_DIR = path.join(
  os.homedir(),
  ".cache",
  "opencode",
  "recent-images"
);

function resolveDefaultMaxImages(): number {
  const envVal = process.env.OPENCODE_MAX_IMAGES;
  if (envVal) {
    const parsed = Number.parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_MAX_IMAGES_IN_CONTEXT;
}

let currentMaxImages = resolveDefaultMaxImages();

export function setMaxImages(count: number): void {
  if (typeof count === "number" && !Number.isNaN(count) && count > 0) {
    currentMaxImages = Math.floor(count);
  }
}

export function getMaxImages(): number {
  return currentMaxImages;
}

// Backward compatibility export
export const MAX_IMAGES_IN_CONTEXT = DEFAULT_MAX_IMAGES_IN_CONTEXT;
export const MAX_CACHE_FILES = DEFAULT_MAX_CACHE_FILES;

let currentCacheDir = DEFAULT_CACHE_DIR;

export function setCacheDir(dir: string): void {
  if (typeof dir === "string" && dir.trim().length > 0) {
    currentCacheDir = path.resolve(dir.trim());
  }
}

export function getCacheDir(): string {
  return currentCacheDir;
}

// In-memory lookup: hash/path key -> cached file path
const imagePathCache = new Map<string, string>();

function ensureCacheDir(): void {
  try {
    if (!fs.existsSync(currentCacheDir)) {
      fs.mkdirSync(currentCacheDir, { recursive: true });
    }
  } catch {
    // Non-fatal: filesystem might be read-only or restricted
  }
}

/**
 * Maintain a strict FIFO rolling limit of maxFiles.
 * Sort by mtime ascending and unlink oldest until count <= maxFiles.
 */
export function enforceCacheCap(maxFiles: number = DEFAULT_MAX_CACHE_FILES): void {
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

    // Oldest mtime first
    fileStats.sort((a, b) => a.time - b.time);

    const removeCount = fileStats.length - maxFiles;
    for (let i = 0; i < removeCount; i++) {
      try {
        fs.unlinkSync(fileStats[i].fullPath);
      } catch {
        // Best effort
      }
    }
  } catch {
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
  if (lower.includes("tiff")) return "tiff";
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

function cleanFilePath(rawPath: string): string {
  let cleaned = rawPath.trim();
  if (cleaned.startsWith("file://")) {
    cleaned = cleaned.slice(7);
  }
  return path.normalize(cleaned);
}

function isTmpPath(filePath: string): boolean {
  const norm = cleanFilePath(filePath);
  const tmpDir = path.normalize(os.tmpdir());
  return (
    norm.startsWith("/tmp/") ||
    norm.startsWith("/private/tmp/") ||
    norm.startsWith("/var/tmp/") ||
    norm.startsWith("/private/var/tmp/") ||
    (Boolean(tmpDir) && norm.startsWith(tmpDir)) ||
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
      const normalizedPath = cleanFilePath(existingPath);
      const resolvedExisting = path.resolve(normalizedPath);

      // If already outside tmp and exists, it is a stable persistent file path
      if (!isTmpPath(resolvedExisting) && fs.existsSync(resolvedExisting)) {
        return resolvedExisting;
      }

      const hashKey = `path:${resolvedExisting}`;
      const cached = imagePathCache.get(hashKey);
      if (cached && fs.existsSync(cached)) {
        return cached;
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
                // Ignore fallback write failure
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
      const cached = imagePathCache.get(hashKey);
      if (cached && fs.existsSync(cached)) {
        return cached;
      }

      // Decode buffer safely
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
        if (!buf) {
          buf = Buffer.from(base64Data, "base64");
        }
        fs.writeFileSync(targetPath, buf);
      }

      imagePathCache.set(hashKey, targetPath);
      enforceCacheCap();
      return targetPath;
    }

    return undefined;
  } catch {
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
  container: Record<string, unknown> | unknown[];
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
    try {
      const commaIdx = uri.indexOf(",");
      const b64 = uri.slice(commaIdx + 1, commaIdx + 65);
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

function isImagePart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  const p = part as Record<string, unknown>;

  if (p.type === "image" || p.type === "image_url") return true;

  if (p.type === "media") {
    return (
      isImageMime(p.mediaType) ||
      isImageMime(p.mime) ||
      isImageMime(p.mimeType) ||
      isImageDataUri(p.data) ||
      isImageDataUri(p.url) ||
      (isRemoteImageUrl(p.url) && isImageExtension(p.url)) ||
      isImageExtension(p.filename || p.name)
    );
  }

  if (p.type === "file") {
    return (
      isImageMime(p.mime) ||
      isImageMime(p.mimeType) ||
      isImageMime(p.mediaType) ||
      isImageDataUri(p.uri) ||
      isImageDataUri(p.data) ||
      isImageDataUri(p.url) ||
      isImageExtension(p.filename || p.name || p.path || p.url || p.uri)
    );
  }

  const inlineData = p.inlineData as Record<string, unknown> | undefined;
  if (inlineData && isImageMime(inlineData.mimeType)) return true;

  const fileData = p.fileData as Record<string, unknown> | undefined;
  if (fileData && (isImageMime(fileData.mimeType) || isImageExtension(fileData.fileUri))) {
    return true;
  }

  return false;
}

function extractImageMeta(part: unknown, fallbackSource?: string, autoName?: string): ImageMeta {
  if (!part || typeof part !== "object") return {};
  const p = part as Record<string, unknown>;
  const sourceObj = p.source as Record<string, unknown> | undefined;
  const imageUrlObj = p.image_url as Record<string, unknown> | undefined;
  const inlineDataObj = p.inlineData as Record<string, unknown> | undefined;
  const metadataObj = p.metadata as Record<string, unknown> | undefined;
  const imageObj = p.image as Record<string, unknown> | undefined;

  const name =
    (typeof p.filename === "string" && p.filename) ||
    (typeof p.name === "string" && p.name) ||
    (typeof p.label === "string" && p.label) ||
    (typeof p.title === "string" && p.title) ||
    (typeof sourceObj?.filename === "string" && sourceObj.filename) ||
    (typeof sourceObj?.name === "string" && sourceObj.name) ||
    autoName ||
    undefined;

  const pathVal =
    (typeof p.path === "string" && p.path) ||
    (typeof p.filePath === "string" && p.filePath) ||
    (typeof sourceObj?.path === "string" && sourceObj.path) ||
    undefined;

  let url: string | undefined;
  if (isRemoteImageUrl(p.url)) {
    url = (p.url as string).trim();
  } else if (isRemoteImageUrl(imageUrlObj?.url)) {
    url = (imageUrlObj!.url as string).trim();
  } else if (isRemoteImageUrl(p.image_url)) {
    url = String(p.image_url).trim();
  } else if (isRemoteImageUrl(p.image)) {
    url = String(p.image).trim();
  } else if (isRemoteImageUrl(p.uri)) {
    url = (p.uri as string).trim();
  } else if (isRemoteImageUrl(sourceObj?.url)) {
    url = (sourceObj!.url as string).trim();
  }

  const mimeCandidate =
    (isImageMime(p.mime) ? (p.mime as string) : undefined) ||
    (isImageMime(p.mimeType) ? (p.mimeType as string) : undefined) ||
    (isImageMime(p.mediaType) ? (p.mediaType as string) : undefined) ||
    (isImageMime(sourceObj?.media_type) ? (sourceObj!.media_type as string) : undefined) ||
    (isImageMime(inlineDataObj?.mimeType) ? (inlineDataObj!.mimeType as string) : undefined);

  let mime = mimeCandidate ? mimeCandidate.trim().toLowerCase() : undefined;

  let rawBase64: string | undefined;
  const rawDataCandidate =
    p.data ||
    p.uri ||
    p.url ||
    p.image ||
    imageUrlObj?.url ||
    inlineDataObj?.data ||
    (sourceObj?.type === "base64" && typeof sourceObj.data === "string" ? sourceObj.data : undefined);

  if (typeof rawDataCandidate === "string") {
    if (isImageDataUri(rawDataCandidate)) {
      rawBase64 = rawDataCandidate;
      if (!mime) mime = extractMimeFromDataUri(rawDataCandidate);
    } else if (inlineDataObj?.data || sourceObj?.type === "base64") {
      rawBase64 = rawDataCandidate;
    }
  }

  let dimensions: string | undefined;
  const width = p.width ?? metadataObj?.width ?? imageObj?.width;
  const height = p.height ?? metadataObj?.height ?? imageObj?.height;
  if (width !== undefined && height !== undefined) {
    dimensions = `${width}x${height}`;
  } else if (typeof p.dimensions === "string") {
    dimensions = p.dimensions;
  }

  const source =
    (typeof p.tool === "string" ? `tool (${p.tool})` : undefined) ||
    (typeof p.toolName === "string" ? `tool (${p.toolName})` : undefined) ||
    fallbackSource ||
    undefined;

  return { name, path: pathVal, url, mime, dimensions, source, rawBase64 };
}

function extractMessageText(msg: unknown): string {
  if (!msg || typeof msg !== "object") return "";
  const m = msg as Record<string, unknown>;

  if (typeof m.content === "string") return m.content.trim();

  const parts = Array.isArray(m.parts)
    ? m.parts
    : Array.isArray(m.content)
      ? m.content
      : null;

  if (!parts) return "";

  const textPieces: string[] = [];
  for (const part of parts) {
    if (!part) continue;
    if (typeof part === "string") {
      textPieces.push(part.trim());
    } else if (typeof part === "object") {
      const p = part as Record<string, unknown>;
      if (p.type === "text" && typeof p.text === "string") {
        textPieces.push(p.text.trim());
      } else if (typeof p.content === "string") {
        textPieces.push(p.content.trim());
      }
    }
  }

  return textPieces.filter(Boolean).join(" ");
}

function cleanAndTruncate(text: string, maxLen = 180): string {
  const singleLine = text.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return `${singleLine.slice(0, maxLen - 3)}...`;
}

/**
 * Conversational Context Synthesizer:
 * Extracts user intent (from preceding user message) and model observation
 * (from message itself or immediate next assistant turn).
 */
export function synthesizeContext(
  messages: unknown[],
  imageRef: ImageRef
): { observed: string; intent: string } {
  const { messageIndex, meta } = imageRef;

  // 1. Extract User Intent
  let intent = "";
  for (let i = messageIndex; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    const info = m?.info as Record<string, unknown> | undefined;
    if (m && (m.role === "user" || info?.role === "user")) {
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

  // Check current message text
  const currentMsgText = extractMessageText(messages[messageIndex]);
  if (currentMsgText && !isImageDataUri(currentMsgText) && !currentMsgText.includes("[Pruned Image:")) {
    observed = cleanAndTruncate(currentMsgText, 200);
  }

  // If not found, check immediate next assistant message
  if (!observed && messageIndex + 1 < messages.length) {
    const nextMsg = messages[messageIndex + 1] as Record<string, unknown> | undefined;
    const nextInfo = nextMsg?.info as Record<string, unknown> | undefined;
    if (nextMsg && (nextMsg.role === "assistant" || nextInfo?.role === "assistant")) {
      const nextTxt = extractMessageText(nextMsg);
      if (nextTxt && !isImageDataUri(nextTxt) && !nextTxt.includes("[Pruned Image:")) {
        observed = cleanAndTruncate(nextTxt, 200);
      }
    }
  }

  // Fallback to meta details or append filename
  if (!observed) {
    const details: string[] = [];
    if (meta.name) details.push(meta.name);
    if (meta.dimensions) details.push(meta.dimensions);
    if (meta.mime) details.push(meta.mime);
    if (meta.source) details.push(meta.source);
    observed = details.length > 0 ? details.join(", ") : "Image capture";
  } else if (meta.name && !observed.includes(meta.name)) {
    observed = `${observed} (${meta.name})`;
  }

  return { observed, intent };
}

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
 */
function countImagesInValue(val: unknown, seen = new Set<unknown>()): number {
  if (!val) return 0;
  if (typeof val === "string") {
    return isImageDataUri(val) ? 1 : 0;
  }
  if (typeof val !== "object") return 0;

  if (seen.has(val)) return 0;
  seen.add(val);

  if (Array.isArray(val)) {
    let count = 0;
    for (const item of val) {
      count += countImagesInValue(item, seen);
    }
    return count;
  }

  if (isImagePart(val)) {
    return 1;
  }

  let count = 0;
  const obj = val as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    count += countImagesInValue(obj[key], seen);
  }
  return count;
}

function countImagesInMessages(messages: unknown[]): number {
  let count = 0;
  const seen = new Set<unknown>();

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;

    if (typeof m.content === "string" && isImageDataUri(m.content)) {
      count++;
    }

    const parts = Array.isArray(m.parts)
      ? m.parts
      : Array.isArray(m.content)
        ? m.content
        : null;

    if (!parts) continue;

    for (const part of parts) {
      if (!part || typeof part !== "object") continue;

      if (isImagePart(part)) {
        count++;
        continue;
      }

      count += countImagesInValue(part, seen);
    }
  }

  return count;
}

/**
 * Recursively inspect an object or array to find and collect all nested images.
 */
function collectNestedImageRefs(
  val: unknown,
  toolSource: string | undefined,
  messageIndex: number,
  target: ImageRef[],
  seen = new Set<unknown>()
): void {
  if (!val || typeof val !== "object") return;
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
          const itemObj = item as Record<string, unknown>;
          const nestedTool = itemObj.tool || itemObj.toolName;
          const nestedToolSource = nestedTool ? `tool (${nestedTool})` : toolSource;
          collectNestedImageRefs(item, nestedToolSource, messageIndex, target, seen);
        }
      }
    }
    return;
  }

  const obj = val as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    const child = obj[key];
    if (!child) continue;

    if (typeof child === "string") {
      if (isImageDataUri(child)) {
        target.push({
          type: "raw-string",
          container: obj,
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
          container: obj,
          keyOrIndex: key,
          meta: extractImageMeta(child, toolSource),
          messageIndex,
        });
      } else {
        const childObj = child as Record<string, unknown>;
        const nestedTool = childObj.tool || childObj.toolName;
        const nestedToolSource = nestedTool ? `tool (${nestedTool})` : toolSource;
        collectNestedImageRefs(child, nestedToolSource, messageIndex, target, seen);
      }
    }
  }
}

/**
 * Collect all image references in strict chronological order with message indices.
 */
function collectImageRefs(messages: unknown[], target: ImageRef[]): void {
  const seen = new Set<unknown>();

  for (let mIdx = 0; mIdx < messages.length; mIdx++) {
    const msg = messages[mIdx];
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    const info = m.info as Record<string, unknown> | undefined;

    const isUser = m.role === "user" || info?.role === "user";
    const defaultSource = isUser ? "user attachment" : undefined;

    if (typeof m.content === "string" && isImageDataUri(m.content)) {
      target.push({
        type: "raw-string",
        container: m,
        keyOrIndex: "content",
        meta: {
          mime: extractMimeFromDataUri(m.content),
          source: defaultSource,
          rawBase64: m.content,
        },
        messageIndex: mIdx,
      });
    }

    const parts = Array.isArray(m.parts)
      ? m.parts
      : Array.isArray(m.content)
        ? m.content
        : null;

    if (!parts) continue;
    let userImageAttachmentIndex = 0;

    for (let pIdx = 0; pIdx < parts.length; pIdx++) {
      const part = parts[pIdx];
      if (!part || typeof part !== "object") continue;
      const p = part as Record<string, unknown>;

      if (isImagePart(part)) {
        let autoName: string | undefined;
        if (isUser) {
          userImageAttachmentIndex++;
          autoName = `[Image ${userImageAttachmentIndex}]`;
        }

        const meta = extractImageMeta(part, defaultSource, autoName);
        const refType = p.inlineData ? "gemini-part" : "part";
        target.push({
          type: refType,
          container: parts,
          keyOrIndex: pIdx,
          meta,
          messageIndex: mIdx,
        });
        continue;
      }

      const toolName = p.tool || p.toolName || (typeof p.type === "string" && p.type.startsWith("tool") ? "tool" : undefined);
      const toolSource = toolName ? `tool (${toolName})` : undefined;
      collectNestedImageRefs(part, toolSource, mIdx, target, seen);
    }
  }
}

/**
 * Core Prune Routine
 */
export function pruneImages(event: unknown, maxImages = getMaxImages()): number {
  try {
    if (!event || typeof event !== "object") return 0;

    const ev = event as Record<string, unknown>;
    const messages = Array.isArray(event)
      ? (event as unknown[])
      : Array.isArray(ev.messages)
        ? (ev.messages as unknown[])
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
      const containerObj = ref.container as Record<string, unknown>;
      const existing = containerObj[ref.keyOrIndex];
      const existingObj = existing && typeof existing === "object" ? (existing as Record<string, unknown>) : undefined;
      const existingId = existingObj ? existingObj.id : undefined;

      if (
        ref.type === "part" ||
        ref.type === "tool-result-value" ||
        ref.type === "tool-content" ||
        ref.type === "tool-attachment"
      ) {
        containerObj[ref.keyOrIndex] = {
          type: "text",
          text: cardText,
          ...(existingId !== undefined ? { id: existingId } : {}),
        };
      } else if (ref.type === "gemini-part") {
        containerObj[ref.keyOrIndex] = {
          text: cardText,
        };
      } else if (ref.type === "raw-string") {
        containerObj[ref.keyOrIndex] = cardText;
        if (containerObj.type === "image") {
          containerObj.type = "text";
        }
      }
    }

    return prunedCount;
  } catch (err) {
    console.error("[prune-images] error:", err);
    return 0;
  }
}

export interface OpenCodePluginContext {
  session?: {
    hook?: (hookName: string, handler: (event: unknown) => Promise<void> | void) => Promise<void> | void;
  };
  hook?: (hookName: string, handler: (_input: unknown, output: unknown) => Promise<void> | void) => void;
  [key: string]: unknown;
}

export interface OpenCodePluginHooks {
  "experimental.chat.messages.transform"?: (_input: unknown, output: unknown) => Promise<void> | void;
  [key: string]: unknown;
}

export default {
  id: "opencode.prune-images",
  setup: async (ctx: OpenCodePluginContext): Promise<void> => {
    try {
      // 1. Session context hook (OpenCode preview / v2 architecture)
      if (ctx?.session?.hook) {
        await ctx.session.hook("context", async (event: unknown) => {
          pruneImages(event, getMaxImages());
        });
      }

      // 2. Chat message transform hook
      if (typeof ctx?.hook === "function") {
        ctx.hook("experimental.chat.messages.transform", async (_input: unknown, output: unknown) => {
          if (output && typeof output === "object" && Array.isArray((output as Record<string, unknown>).messages)) {
            pruneImages(output, getMaxImages());
          }
        });
      }
    } catch (err) {
      console.error("[prune-images] setup hook registration error:", err);
    }
  },
  server: async (): Promise<OpenCodePluginHooks> => ({
    "experimental.chat.messages.transform": async (_input: unknown, output: unknown) => {
      if (output && typeof output === "object" && Array.isArray((output as Record<string, unknown>).messages)) {
        pruneImages(output, getMaxImages());
      }
    },
  }),
};
