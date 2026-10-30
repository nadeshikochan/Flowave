const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const axios = require("axios");
const sharp = require("sharp");

const MANIFEST_VERSION = 1;
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;
const RELEASE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSET_ID_RE = /^release:([^:]+):front-(250|500|1200)$/i;
const CACHED_ASSET_FILE_RE = /^[0-9a-f]{64}\.(?:jpg|png|webp)$/i;
const FORMAT_INFO = Object.freeze({
  jpeg: { extension: ".jpg", mimeType: "image/jpeg" },
  png: { extension: ".png", mimeType: "image/png" },
  webp: { extension: ".webp", mimeType: "image/webp" },
});

class CoverAssetError extends Error {
  constructor(message, code = "COVER_ASSET_FAILED") {
    super(message);
    this.name = "CoverAssetError";
    this.code = code;
  }
}

function parseAssetId(assetId) {
  const raw = String(assetId || "").trim();
  const match = ASSET_ID_RE.exec(raw);
  if (!match || !RELEASE_ID_RE.test(match[1])) {
    throw new CoverAssetError("invalid cover asset id", "INVALID_ASSET_ID");
  }
  const releaseId = match[1].toLowerCase();
  const size = Number(match[2]);
  return {
    assetId: `release:${releaseId}:front-${size}`,
    releaseId,
    size,
    url: `https://coverartarchive.org/release/${releaseId}/front-${size}`,
  };
}

function normalizedMime(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

function hasExpectedMagic(buffer, format) {
  if (!Buffer.isBuffer(buffer)) return false;
  if (format === "jpeg") return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (format === "png") return buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
  if (format === "webp") return buffer.length >= 12
    && buffer.subarray(0, 4).toString("ascii") === "RIFF"
    && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
}

function atomicWriteJson(filePath, value) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), "utf8");
    fs.renameSync(temporary, filePath);
  } finally {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch (_) {}
  }
}

async function defaultRequestAsset({ url, signal, timeoutMs, maxBytes }) {
  const response = await axios.get(url, {
    signal,
    timeout: timeoutMs,
    responseType: "arraybuffer",
    maxRedirects: 5,
    maxContentLength: maxBytes,
    maxBodyLength: maxBytes,
    headers: {
      Accept: "image/jpeg, image/png, image/webp",
      "User-Agent": "Flowave cover-art cache",
    },
    validateStatus: (status) => status === 200,
  });
  return {
    body: Buffer.from(response.data || []),
    contentType: response.headers?.["content-type"] || "",
    contentLength: response.headers?.["content-length"] || "",
  };
}

class CoverArtAssetStore {
  constructor({
    rootDir,
    manifestPath = "",
    requestAsset = defaultRequestAsset,
    imageMetadata = (buffer) => sharp(buffer, { failOn: "error", limitInputPixels: 100_000_000 }).metadata(),
    now = () => Date.now(),
    maxBytes = DEFAULT_MAX_BYTES,
    timeoutMs = 15000,
  } = {}) {
    if (!rootDir) throw new TypeError("CoverArtAssetStore requires rootDir");
    this.rootDir = path.resolve(String(rootDir));
    this.manifestPath = path.resolve(String(manifestPath || path.join(this.rootDir, "manifest.json")));
    this.requestAsset = requestAsset;
    this.imageMetadata = imageMetadata;
    this.now = now;
    this.maxBytes = Math.max(1024, Number(maxBytes) || DEFAULT_MAX_BYTES);
    this.timeoutMs = Math.max(1000, Number(timeoutMs) || 15000);
    this.entries = new Map();
    this.inflight = new Map();
    this.generation = 0;
    this.load();
  }

  assertGeneration(generation) {
    if (generation !== this.generation) {
      throw new CoverAssetError("cover cache cleared", "CACHE_CLEARED");
    }
  }

  load() {
    if (!fs.existsSync(this.manifestPath)) return;
    try {
      const payload = JSON.parse(fs.readFileSync(this.manifestPath, "utf8"));
      if (payload?.version !== MANIFEST_VERSION || !payload.entries || typeof payload.entries !== "object") return;
      for (const [assetId, entry] of Object.entries(payload.entries)) {
        try {
          const parsed = parseAssetId(assetId);
          if (entry && typeof entry === "object") this.entries.set(parsed.assetId, entry);
        } catch (_) {}
      }
    } catch (_) {
      // 派生封面缓存损坏时按空缓存重建，不触碰歌曲或用户封面。
    }
  }

  save() {
    atomicWriteJson(this.manifestPath, {
      version: MANIFEST_VERSION,
      entries: Object.fromEntries(this.entries),
    });
  }

  assetPath(entry) {
    const fileName = path.basename(String(entry?.fileName || ""));
    if (!fileName || fileName !== entry?.fileName) return "";
    const target = path.resolve(this.rootDir, fileName);
    const relative = path.relative(this.rootDir, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return "";
    return target;
  }

  async cached(assetId) {
    const parsed = parseAssetId(assetId);
    const entry = this.entries.get(parsed.assetId);
    const target = this.assetPath(entry);
    if (!entry || !target) return null;
    try {
      const body = await fs.promises.readFile(target);
      if (body.length !== Number(entry.bytes)
        || crypto.createHash("sha256").update(body).digest("hex") !== entry.sha256) {
        throw new Error("cached cover hash mismatch");
      }
      entry.lastAccessAt = this.now();
      return { assetId: parsed.assetId, path: target, ...entry };
    } catch (_) {
      this.entries.delete(parsed.assetId);
      try {
        if (target) await fs.promises.unlink(target);
      } catch (_) {}
      this.save();
      return null;
    }
  }

  async get(assetId, { signal } = {}) {
    const parsed = parseAssetId(assetId);
    const generation = this.generation;
    const cached = await this.cached(parsed.assetId);
    this.assertGeneration(generation);
    if (cached) return cached;
    if (this.inflight.has(parsed.assetId)) return this.inflight.get(parsed.assetId);
    const pending = this.download(parsed, signal, generation).finally(() => this.inflight.delete(parsed.assetId));
    this.inflight.set(parsed.assetId, pending);
    return pending;
  }

  async download(parsed, signal, generation) {
    const response = await this.requestAsset({
      url: parsed.url,
      signal,
      timeoutMs: this.timeoutMs,
      maxBytes: this.maxBytes,
    });
    this.assertGeneration(generation);
    const body = Buffer.isBuffer(response?.body) ? response.body : Buffer.from(response?.body || []);
    const declaredLength = Number(response?.contentLength || 0);
    if (declaredLength > this.maxBytes || body.length > this.maxBytes) {
      throw new CoverAssetError("cover is too large", "ASSET_TOO_LARGE");
    }
    if (body.length < 64) throw new CoverAssetError("cover response is empty", "INVALID_IMAGE");

    const metadata = await this.imageMetadata(body);
    this.assertGeneration(generation);
    const format = String(metadata?.format || "").toLowerCase();
    const info = FORMAT_INFO[format];
    const mimeType = normalizedMime(response?.contentType);
    if (!info || mimeType !== info.mimeType || !hasExpectedMagic(body, format)) {
      throw new CoverAssetError("cover type is invalid", "INVALID_IMAGE");
    }
    const width = Number(metadata?.width || 0);
    const height = Number(metadata?.height || 0);
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 32 || height < 32) {
      throw new CoverAssetError("cover dimensions are invalid", "INVALID_IMAGE");
    }

    const sha256 = crypto.createHash("sha256").update(body).digest("hex");
    const fileName = `${sha256}${info.extension}`;
    const target = path.join(this.rootDir, fileName);
    await fs.promises.mkdir(this.rootDir, { recursive: true });
    this.assertGeneration(generation);
    if (!fs.existsSync(target)) {
      const temporary = path.join(this.rootDir, `.${sha256}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
      try {
        await fs.promises.writeFile(temporary, body, { flag: "wx" });
        await fs.promises.rename(temporary, target);
        if (generation !== this.generation) {
          await fs.promises.unlink(target).catch(() => {});
          this.assertGeneration(generation);
        }
      } finally {
        try {
          await fs.promises.unlink(temporary);
        } catch (_) {}
      }
    }
    this.assertGeneration(generation);
    const entry = {
      fileName,
      sha256,
      mimeType: info.mimeType,
      bytes: body.length,
      width,
      height,
      cachedAt: this.now(),
      lastAccessAt: this.now(),
    };
    this.entries.set(parsed.assetId, entry);
    this.save();
    return { assetId: parsed.assetId, path: target, ...entry };
  }

  async clear() {
    this.generation += 1;
    this.entries.clear();
    let files = 0;
    let bytes = 0;
    let names = [];
    try {
      names = await fs.promises.readdir(this.rootDir);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    for (const name of names) {
      if (!CACHED_ASSET_FILE_RE.test(name)) continue;
      const target = path.resolve(this.rootDir, name);
      if (path.dirname(target) !== this.rootDir) continue;
      try {
        const stat = await fs.promises.lstat(target);
        await fs.promises.unlink(target);
        files += 1;
        bytes += stat.isFile() ? stat.size : 0;
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    this.save();
    return { files, bytes };
  }
}

module.exports = {
  CoverArtAssetStore,
  CoverAssetError,
  CACHED_ASSET_FILE_RE,
  DEFAULT_MAX_BYTES,
  MANIFEST_VERSION,
  defaultRequestAsset,
  hasExpectedMagic,
  normalizedMime,
  parseAssetId,
};
