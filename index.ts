/**
 * OpenCode Plugin: Intelligent Image Context Manager & Rolling Buffer
 *
 * Reduces the chance of 413 "Request Entity Too Large" and "Too many images"
 * errors by capping active visual images sent to LLMs while preserving a
 * recoverable summary through contextual text cards and a persistent FIFO disk
 * buffer. Provider limits and the rest of the request are outside this plugin.
 *
 * 1. Rolling Disk Buffer (~/.cache/opencode/recent-images/):
 *    - Strict FIFO limit of 100 files.
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
 * 3. Dual-Budget Active Window:
 *    - Preserves up to 7 latest raw images (configurable via OPENCODE_MAX_IMAGES or setMaxImages)
 *      AND up to 16 MiB active payload bytes (configurable via OPENCODE_MAX_IMAGE_BYTES or setMaxImageBytes).
 *    - In-place mutation preserving tool call IDs, wrappers, and message structure.
 *    - V1 tool attachments pruned from state.attachments are removed from the
 *      array with their card appended to that tool part's output text, since
 *      neither provider conversion nor the compaction serializer reads card
 *      text out of a replaced attachment object.
 *
 * 4. Compaction Lifecycle Defense (Zero-Media Strip):
 *    - When event.agent === "compaction" or on /compact requests, effectiveMaxImages and effectiveMaxBytes
 *      are clamped to 0.
 *    - 100% of images are cleanly converted into 3-point context cards with zero raw base64 sent to the model,
 *      so compaction receives text cards instead of raw image data (issue #14562).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

export const DEFAULT_MAX_IMAGES_IN_CONTEXT = 7;
export const DEFAULT_MAX_IMAGE_BYTES = 16 * 1024 * 1024; // 16 MiB wire base64 length (~12 MiB raw binary)
export const DEFAULT_MAX_CACHE_FILES = 100;

export const DEFAULT_CACHE_DIR = path.join(
  os.homedir(),
  ".cache",
  "opencode",
  "recent-images"
);

export function parseByteString(val: string | undefined): number | undefined {
  if (!val || typeof val !== "string") return undefined;
  const trimmed = val.trim();
  if (!trimmed) return undefined;

  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
  if (!match) return undefined;

  const num = Number.parseFloat(match[1]);
  if (Number.isNaN(num) || num <= 0) return undefined;

  const unit = match[2]?.toLowerCase() || "";
  if (!unit || unit === "b" || unit === "bytes") {
    return Math.floor(num);
  }
  if (unit === "k" || unit === "kb" || unit === "kib") {
    return Math.floor(num * 1024);
  }
  if (unit === "m" || unit === "mb" || unit === "mib") {
    return Math.floor(num * 1024 * 1024);
  }
  if (unit === "g" || unit === "gb" || unit === "gib") {
    return Math.floor(num * 1024 * 1024 * 1024);
  }

  return Math.floor(num);
}

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

function resolveDefaultMaxImageBytes(): number {
  const envVal = process.env.OPENCODE_MAX_IMAGE_BYTES;
  const parsed = parseByteString(envVal);
  if (parsed && parsed > 0) {
    return parsed;
  }
  return DEFAULT_MAX_IMAGE_BYTES;
}

let currentMaxImages = resolveDefaultMaxImages();
let currentMaxImageBytes = resolveDefaultMaxImageBytes();

export function setMaxImages(count: number): void {
  if (typeof count === "number" && !Number.isNaN(count) && count > 0) {
    currentMaxImages = Math.floor(count);
  }
}

export function getMaxImages(): number {
  return currentMaxImages;
}

export function setMaxImageBytes(bytes: number): void {
  if (typeof bytes === "number" && !Number.isNaN(bytes) && bytes > 0) {
    currentMaxImageBytes = Math.floor(bytes);
  }
}

export function getMaxImageBytes(): number {
  return currentMaxImageBytes;
}

// Backward compatibility exports
export const MAX_IMAGES_IN_CONTEXT = DEFAULT_MAX_IMAGES_IN_CONTEXT;
export const MAX_IMAGE_BYTES = DEFAULT_MAX_IMAGE_BYTES;
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
  byteSize?: number;
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

function isAlreadyPrunedPart(part: unknown): boolean {
  if (!part) return false;
  if (typeof part === "string") {
    return part.includes("[Pruned Image:");
  }
  if (typeof part === "object") {
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string" && p.text.includes("[Pruned Image:")) {
      return true;
    }
    if (typeof p.content === "string" && p.content.includes("[Pruned Image:")) {
      return true;
    }
  }
  return false;
}

function isImagePart(part: unknown): boolean {
  if (!part || typeof part !== "object") return false;
  if (isAlreadyPrunedPart(part)) return false;
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
 * Estimate wire base64 character payload length of an image.
 *
 * Base64 expands binary by 33% (4 chars per 3 bytes), so wire length is a useful
 * estimate for image payloads. It is not a complete request-size calculation:
 * prompts, tools, serialization, provider limits, and URL/file estimates are
 * outside this helper.
 *
 * - Base64 string / data URI: data.length (wire characters)
 * - File on disk: Math.ceil((stat.size * 4) / 3) (wire base64 characters when serialized)
 * - Remote URL: nominal estimate (500KB wire chars)
 */
export function estimateImageBytes(meta: ImageMeta): number {
  if (meta.byteSize && meta.byteSize > 0) {
    return meta.byteSize;
  }

  // 1. Raw base64 / data URI
  if (meta.rawBase64 && typeof meta.rawBase64 === "string") {
    let raw = meta.rawBase64;
    const commaIdx = raw.indexOf(",");
    if (commaIdx !== -1) {
      raw = raw.slice(commaIdx + 1);
    }
    // Wire base64 character length directly reflects serialized request payload
    return raw.length;
  }

  // 2. File path on disk
  if (meta.path && typeof meta.path === "string") {
    try {
      const cleanPath = cleanFilePath(meta.path);
      const resolved = path.resolve(cleanPath);
      if (fs.existsSync(resolved)) {
        const stat = fs.statSync(resolved);
        if (stat.isFile()) {
          // Convert binary disk size to wire base64 character length (* 4 / 3)
          return Math.ceil((stat.size * 4) / 3);
        }
      }
    } catch {
      // Fall through
    }
  }

  // 3. Remote URL
  if (meta.url && typeof meta.url === "string") {
    return 500 * 1024; // 500KB nominal estimate
  }

  // Generic fallback
  return 250 * 1024; // 250KB fallback
}

const BOILERPLATE_PATTERNS = [
  /^image\s+read\s+successfully\.?$/i,
  /^screenshot\s+(?:captured|taken|saved)\.?$/i,
  /^ok\.?$/i,
  /^success\.?$/i,
  /^done\.?$/i,
  /^file\s+read\s+successfully\.?$/i,
  /^image\s+loaded\.?$/i,
];

function isSubstantiveText(text: string): boolean {
  if (!text) return false;
  const clean = text.trim();
  if (clean.length < 5) return false;
  if (isImageDataUri(clean)) return false;
  if (clean.includes("[Pruned Image:")) return false;

  for (const pattern of BOILERPLATE_PATTERNS) {
    if (pattern.test(clean)) {
      return false;
    }
  }

  return true;
}

/**
 * Conversational Context Synthesizer:
 * Extracts user intent (from preceding user message) and model observation
 * (from message itself or next assistant turn synthesizing visual findings).
 */
export function synthesizeContext(
  messages: unknown[],
  imageRef: ImageRef
): { observed: string; intent: string } {
  const { messageIndex, meta } = imageRef;

  // 1. Extract User Intent:
  // Search backwards from messageIndex to find the originating user turn,
  // ignoring intermediate assistant/tool turns.
  let intent = "";
  for (let i = messageIndex; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown> | undefined;
    const info = m?.info as Record<string, unknown> | undefined;
    if (m && (m.role === "user" || info?.role === "user")) {
      const txt = extractMessageText(m);
      if (isSubstantiveText(txt)) {
        intent = cleanAndTruncate(txt, 180);
        break;
      }
    }
  }

  if (!intent) {
    intent = meta.source ? `Captured during ${meta.source}` : "User provided context";
  }

  // 2. Extract Model / Environment Observation:
  // Check if current message has substantive text (not boilerplate or empty).
  // If not, crawl forward up to 6 turns looking for the assistant turn articulating findings.
  let observed = "";

  const currentMsgText = extractMessageText(messages[messageIndex]);
  if (isSubstantiveText(currentMsgText)) {
    observed = cleanAndTruncate(currentMsgText, 180);
  }

  if (!observed) {
    const maxForward = Math.min(messages.length, messageIndex + 7); // up to 6 turns forward
    for (let i = messageIndex + 1; i < maxForward; i++) {
      const forwardMsg = messages[i] as Record<string, unknown> | undefined;
      const forwardInfo = forwardMsg?.info as Record<string, unknown> | undefined;
      const isAssistant = forwardMsg?.role === "assistant" || forwardInfo?.role === "assistant";

      if (isAssistant) {
        const forwardTxt = extractMessageText(forwardMsg);
        if (isSubstantiveText(forwardTxt)) {
          observed = cleanAndTruncate(forwardTxt, 180);
          break;
        }
      }
    }
  }

  // Fallback to meta details or append filename if observed
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
export function countImagesInValue(val: unknown, seen = new Set<unknown>()): number {
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

export function countImagesInMessages(messages: unknown[]): number {
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
 * Find the V1 tool part that owns a state.attachments array (or an object
 * inside one) so pruned attachments can be removed cleanly instead of
 * swapping the attachment object for a text object downstream code cannot
 * read. Returns the owning part and its attachments array, or undefined when
 * the container is not a V1 tool attachment holder.
 */
function findV1ToolAttachmentOwner(
  messages: unknown[],
  messageIndex: number,
  container: unknown
): { part: Record<string, unknown>; state: Record<string, unknown>; attachments: unknown[] } | undefined {
  const msg = messages[messageIndex] as Record<string, unknown> | undefined;
  if (!msg || typeof msg !== "object") return undefined;
  const parts = Array.isArray(msg.parts) ? msg.parts : null;
  if (!parts) return undefined;

  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    if (p.type !== "tool") continue;
    const state = p.state as Record<string, unknown> | undefined;
    if (!state || typeof state !== "object") continue;
    if (state.status !== "completed") continue;
    const attachments = state.attachments;
    if (!Array.isArray(attachments)) continue;
    if (attachments === container) {
      return { part: p, state, attachments };
    }
    if (container && typeof container === "object" && attachments.includes(container)) {
      return { part: p, state, attachments };
    }
  }
  return undefined;
}
/**
 * Check if the current context event or message payload indicates compaction.
 *
 * OpenCode compaction lifecycle:
 * - Either automatic or manual (/compact), OpenCode triggers context hooks with event.agent === "compaction".
 * - Or the last user message requests a compaction/summary.
 * - Compaction should receive a text summary rather than raw image data.
 * - Passing raw base64 images into compaction can cause payload errors (OpenCode issue #14562).
 */
export function isCompactionEvent(event: unknown, messages?: unknown[]): boolean {
  if (!event || typeof event !== "object") return false;
  const ev = event as Record<string, unknown>;

  // 1. Direct event.agent check (OpenCode convention)
  if (typeof ev.agent === "string" && ev.agent.toLowerCase() === "compaction") {
    return true;
  }

  // Also check nested session/context info if present
  const session = ev.session as Record<string, unknown> | undefined;
  if (typeof session?.agent === "string" && session.agent.toLowerCase() === "compaction") {
    return true;
  }

  // 2. Check last message content / intent for compaction
  const msgs = messages || (Array.isArray(ev.messages) ? (ev.messages as unknown[]) : null);
  if (Array.isArray(msgs) && msgs.length > 0) {
    const lastMsg = msgs[msgs.length - 1] as Record<string, unknown> | undefined;
    if (lastMsg) {
      // Check last message role or info
      const info = lastMsg.info as Record<string, unknown> | undefined;
      if (typeof info?.agent === "string" && info.agent.toLowerCase() === "compaction") {
        return true;
      }
      const text = extractMessageText(lastMsg).trim().toLowerCase();
      if (
        text === "/compact" ||
        text.startsWith("/compact ") ||
        text.includes("compact conversation") ||
        text.includes("summarize conversation history")
      ) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Core Prune Routine:
 * Dual-budget enforcement (Max Images Count + Max Payload Bytes).
 * Allocates budget greedily from newest to oldest images.
 * Pruned images are transformed in chronological order (oldest to newest).
 *
 * If event.agent === "compaction" or compaction is requested, effectiveMaxImages
 * and effectiveMaxBytes are clamped to 0 so 100% of recognized images are
 * converted to 3-point context cards with zero raw image data remaining in context.
 */
export function pruneImages(
  event: unknown,
  maxImages = getMaxImages(),
  maxBytes = getMaxImageBytes()
): number {
  try {
    if (!event || typeof event !== "object") return 0;

    const ev = event as Record<string, unknown>;
    const messages = Array.isArray(event)
      ? (event as unknown[])
      : Array.isArray(ev.messages)
        ? (ev.messages as unknown[])
        : null;

    if (!messages || messages.length === 0) return 0;

    // Compaction detection: strip 100% of media to 3-point context cards
    const isCompaction = isCompactionEvent(event, messages);
    const effectiveMaxImages = isCompaction ? 0 : maxImages;
    const effectiveMaxBytes = isCompaction ? 0 : maxBytes;

    const imageRefs: ImageRef[] = [];
    collectImageRefs(messages, imageRefs);

    if (imageRefs.length === 0) {
      return 0;
    }

    // 1. Dual-Budget Greedy Allocation from Newest to Oldest
    // Newest images have the highest conversational value.
    const keepIndices = new Set<number>();
    let retainedCount = 0;
    let retainedBytes = 0;

    for (let i = imageRefs.length - 1; i >= 0; i--) {
      const ref = imageRefs[i];
      const imgBytes = estimateImageBytes(ref.meta);

      if (retainedCount < effectiveMaxImages && retainedBytes + imgBytes <= effectiveMaxBytes) {
        keepIndices.add(i);
        retainedCount++;
        retainedBytes += imgBytes;
      }
    }

    // If all images fit in budget, no-op
    if (keepIndices.size === imageRefs.length) {
      return 0;
    }

    // 2. Identify references to prune and transform in chronological order (oldest to newest)
    // V1 tool attachments are collected separately: removing the entry from
    // state.attachments and appending the card to state.output keeps both the
    // normal provider conversion and the compaction serializer working, since
    // neither path reads card text out of a replaced attachment object.
    const attachmentOps = new Map<
      Record<string, unknown>,
      { owner: Record<string, unknown>; state: Record<string, unknown>; attachments: unknown[]; cards: string[]; targets: unknown[] }
    >();
    let prunedCount = 0;

    for (let i = 0; i < imageRefs.length; i++) {
      if (keepIndices.has(i)) {
        continue;
      }

      const ref = imageRefs[i];
      if (!ref) continue;

      // Defensive check: avoid double-wrapping if already pruned
      const containerObj = ref.container as Record<string, unknown>;
      const existing = containerObj[ref.keyOrIndex];
      if (isAlreadyPrunedPart(existing)) {
        continue;
      }

      // a. Ensure persisted to rolling buffer
      const cachedPath =
        persistToRollingCache(ref.meta.rawBase64, ref.meta.path, ref.meta.mime) ||
        ref.meta.path ||
        ref.meta.url ||
        "~/.cache/opencode/recent-images/";

      // b. Synthesize context from causal conversational turns
      const { observed, intent } = synthesizeContext(messages, ref);

      // c. Format 3-point card
      const cardText = formatThreePointCard(cachedPath, observed, intent);

      // d1. V1 tool attachment: defer removal so array indices stay valid
      // until every card for that tool part is collected. Only applies when
      // the ref points directly at the attachments array or at an object
      // inside it; anything else falls through to standard replacement so no
      // image is kept while its card is also added.
      const owner =
        ref.type === "part" || ref.type === "raw-string"
          ? findV1ToolAttachmentOwner(messages, ref.messageIndex, ref.container)
          : undefined;
      const ownerArray = owner?.attachments;
      const isDirectIndex =
        !!ownerArray && ref.container === ownerArray && typeof ref.keyOrIndex === "number";
      const isDirectObject =
        !!ownerArray && ref.container !== ownerArray && ownerArray.includes(ref.container);
      if (owner && ownerArray && (isDirectIndex || isDirectObject)) {
        let op = attachmentOps.get(owner.part);
        if (!op) {
          op = { owner: owner.part, state: owner.state, attachments: ownerArray, cards: [], targets: [] };
          attachmentOps.set(owner.part, op);
        }
        op.cards.push(cardText);
        op.targets.push(isDirectIndex ? (ref.keyOrIndex as number) : ref.container);
        prunedCount++;
        continue;
      }

      // d2. In-place replacement preserving wrapper and ID
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

      prunedCount++;
    }

    // e. Apply deferred V1 attachment removals: highest index first so array
    // positions stay valid, then append cards to the tool output text.
    for (const op of attachmentOps.values()) {
      const numericTargets = op.targets.filter((t): t is number => typeof t === "number").sort((a, b) => b - a);
      for (const idx of numericTargets) {
        if (idx >= 0 && idx < op.attachments.length) {
          op.attachments.splice(idx, 1);
        }
      }
      // Object targets are attachment objects nested without a direct index:
      // remove them by identity.
      for (const target of op.targets) {
        if (typeof target === "number") continue;
        const obj = target as unknown;
        const at = op.attachments.indexOf(obj);
        if (at !== -1) op.attachments.splice(at, 1);
      }
      const prior = typeof op.state.output === "string" ? op.state.output : "";
      op.state.output = prior ? `${prior}\n\n${op.cards.join("\n\n")}` : op.cards.join("\n\n");
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
          pruneImages(event, getMaxImages(), getMaxImageBytes());
        });
      }

      // 2. Chat message transform hook
      if (typeof ctx?.hook === "function") {
        ctx.hook("experimental.chat.messages.transform", async (_input: unknown, output: unknown) => {
          if (output && typeof output === "object" && Array.isArray((output as Record<string, unknown>).messages)) {
            pruneImages(output, getMaxImages(), getMaxImageBytes());
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
        pruneImages(output, getMaxImages(), getMaxImageBytes());
      }
    },
  }),
};
