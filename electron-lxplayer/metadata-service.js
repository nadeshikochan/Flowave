const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { writeJsonObjectAtomic, createCoalescedWriter } = require("./async-json-writer");
const { localMediaUrlToPath, toLocalMediaUrl } = require("./secure-protocols");
const {
  LocalLyricSourceResolver,
  compareCandidatePriority,
} = require("./lyrics/local-source-resolver");
const { isContainedPath, libraryLyricRoot, mirroredLyricRootForAudio, preferredLyricPathForAudio } = require("./lyrics/mirrored-lyric-paths");
let sharp = null;

let mmModule = null;
async function getMusicMetadata() {
  if (mmModule) return mmModule;
  mmModule = await import("music-metadata");
  return mmModule;
}

// 持久缓存：key = 路径 + 文件版本签名，值为解析后的元信息（cover 为文件路径）
const RUNTIME_CACHE_ROOT = path.resolve(process.env.KUMIKO_CACHE_DIR || path.join(__dirname, "..", "data", "cache"));
const CACHE_DIR = path.join(RUNTIME_CACHE_ROOT, "metadata");
const CACHE_PATH = path.join(CACHE_DIR, "metadata_cache.json");
const COVER_DIR = path.join(CACHE_DIR, "covers");
const THUMB_DIR = path.join(CACHE_DIR, "thumbs");
const CACHE_URL_MARKER = "/data/cache/metadata/";
let configuredExternalLyricRoot = String(process.env.KUMIKO_EXTERNAL_LYRIC_DIR || "").trim();
let configuredLibraryAudioRoots = [];
const localLyricResolver = new LocalLyricSourceResolver({ externalRoot: configuredExternalLyricRoot });
const discoveredLyricResolvers = new Map();
fs.mkdirSync(COVER_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });
// V6 增加仅供主进程使用的稳定资源身份与精确失效代际。
const CACHE_VERSION = 6;
const cacheIdentityKeys = new Map();
function cacheEntryScopes(key, value) {
  const scopes = new Set(identityScopes(value?._cacheIdentity));
  const delimiter = String(key).indexOf("|");
  if (delimiter >= 0) scopes.add(`path:${normalizedPathIdentity(String(key).slice(0, delimiter))}`);
  return scopes;
}
class IdentityCache extends Map {
  set(key, value) {
    this.delete(key);
    super.set(key, value);
    for (const scope of cacheEntryScopes(key, value)) {
      if (!cacheIdentityKeys.has(scope)) cacheIdentityKeys.set(scope, new Set());
      cacheIdentityKeys.get(scope).add(key);
    }
    return this;
  }
  delete(key) {
    if (!this.has(key)) return false;
    for (const scope of cacheEntryScopes(key, this.get(key))) {
      const keys = cacheIdentityKeys.get(scope);
      keys?.delete(key);
      if (!keys?.size) cacheIdentityKeys.delete(scope);
    }
    return super.delete(key);
  }
  clear() { super.clear(); cacheIdentityKeys.clear(); }
}
const cache = new IdentityCache();
const invalidationGenerations = new Map();
let saveTimer = null;
const cacheWriter = createCoalescedWriter((snapshot) => writeJsonObjectAtomic(CACHE_PATH, snapshot, {
  header: { version: CACHE_VERSION }, serialize: serializeCacheEntry,
}));

function getExternalLyricRoots() {
  const roots = new Map();
  const add = (root) => {
    const resolved = String(root || "").trim();
    if (resolved) roots.set(path.resolve(resolved).toLocaleLowerCase(), resolved);
  };
  add(configuredExternalLyricRoot);
  for(const audioRoot of configuredLibraryAudioRoots){const root=libraryLyricRoot(audioRoot);if(root&&fs.existsSync(root))add(root);}
  return [...roots.values()];
}

function setExternalLyricRoot(dir) {
  configuredExternalLyricRoot = String(dir || "").trim();
  // 保存同一目录也视为用户要求刷新，立即丢弃旧索引与已解析文件。
  if (!localLyricResolver.setExternalRoot(configuredExternalLyricRoot)) localLyricResolver.invalidate();
  discoveredLyricResolvers.clear();
}

function setLibraryAudioRoot(dir) {
  const next=[...new Set((Array.isArray(dir)?dir:[dir]).map(v=>String(v||"").trim()).filter(Boolean))];
  if(JSON.stringify(next)===JSON.stringify(configuredLibraryAudioRoots))return false;
  configuredLibraryAudioRoots=next;
  discoveredLyricResolvers.clear();
  return true;
}
function libraryAudioRootFor(trackPath="") {
  return configuredLibraryAudioRoots.find(root=>trackPath&&isContainedPath(root,trackPath)) || configuredLibraryAudioRoots[0] || "";
}

function discoverLibraryLyricRoot(trackPath = "") {
  const audioRoot = libraryAudioRootFor(trackPath);
  const root = libraryLyricRoot(audioRoot);
  if (!root) return "";
  try {
    return fs.statSync(root).isDirectory() ? root : "";
  } catch (_) {
    return "";
  }
}

function resolverForExternalRoot(root) {
  const resolvedRoot = path.resolve(root);
  if (configuredExternalLyricRoot
    && path.resolve(configuredExternalLyricRoot).toLocaleLowerCase() === resolvedRoot.toLocaleLowerCase()) {
    return localLyricResolver;
  }
  const key = resolvedRoot.toLocaleLowerCase();
  if (!discoveredLyricResolvers.has(key)) {
    discoveredLyricResolvers.set(key, new LocalLyricSourceResolver({ externalRoot: resolvedRoot }));
  }
  return discoveredLyricResolvers.get(key);
}

function mirroredLyricResolverForTrack(trackPath) {
  const root = mirroredLyricRootForAudio(trackPath, libraryAudioRootFor(trackPath));
  if (!root || !fs.existsSync(root)) return null;
  const resolvedRoot = path.resolve(root);
  if (configuredExternalLyricRoot
    && path.resolve(configuredExternalLyricRoot).toLocaleLowerCase() === resolvedRoot.toLocaleLowerCase()) {
    return null;
  }
  return resolverForExternalRoot(resolvedRoot);
}

function candidatesFromResolution(resolution, rootPriority = 0) {
  const list = [];
  if (resolution?.selected) list.push(resolution.selected);
  if (Array.isArray(resolution?.alternatives)) list.push(...resolution.alternatives);
  return list.map((candidate) => ({ ...candidate, rootPriority }));
}

async function resolveLyricsWithMirroredRoot({ trackPath, evidence, embedded = [], sources = null }) {
  const enabled = new Set(Array.isArray(sources) ? sources : ["external", "sidecar", "embedded"]);
  const libraryRoot = discoverLibraryLyricRoot(trackPath);
  const configuredIsLibraryRoot = Boolean(configuredExternalLyricRoot && libraryRoot
    && path.resolve(configuredExternalLyricRoot).toLocaleLowerCase() === path.resolve(libraryRoot).toLocaleLowerCase());
  const baseSources = [...enabled].filter((source) => source !== "external" || !configuredIsLibraryRoot);
  const basePromise = localLyricResolver.resolve({ trackPath, evidence, embedded, sources: baseSources });
  const mirroredResolver = enabled.has("external") ? mirroredLyricResolverForTrack(trackPath) : null;
  if (!mirroredResolver) return basePromise;
  const [base, mirrored] = await Promise.all([
    basePromise,
    mirroredResolver.resolve({ trackPath, evidence, embedded: [], sources: ["external"] }),
  ]);
  const byId = new Map();
  const bindingBase = (value) => path.parse(String(value || "")).name.normalize("NFKC")
    .replace(/\([^()]*\)/gu, " ").replace(/[’‘]/gu, "'").replace(/\s+/gu, " ").trim().toLocaleLowerCase();
  const audioBase = bindingBase(trackPath);
  const mirroredCandidates = candidatesFromResolution(mirrored, 1).map((candidate) => {
    const lyricBase = bindingBase(candidate.sourcePath);
    // 镜像相对目录和同名文件提供与歌曲旁 sidecar 等价的路径绑定证据。
    // 只有标题/歌手/版本已通过 strong 验证才提升，不能放宽冲突门槛。
    const verifiedFilename = candidate.identityLevel === "medium"
      && ["artist-title", "title-artist", "basename_exact"].includes(candidate.identityReason);
    if ((candidate.identityLevel !== "strong" && !verifiedFilename) || lyricBase !== audioBase) return candidate;
    const explicitlyChosen = candidate.manualSelection === true
      && path.resolve(candidate.sourcePath).toLocaleLowerCase()
        === path.resolve(preferredLyricPathForAudio(trackPath, libraryAudioRootFor(trackPath))).toLocaleLowerCase();
    return { ...candidate, identityLevel: "strong", identityScore: 100, identityReason: "mirrored_path_bound", rootPriority: explicitlyChosen ? 3 : 2 };
  });
  for (const candidate of [
    ...candidatesFromResolution(base, 0),
    ...mirroredCandidates,
  ]) {
    const key = String(candidate?.candidateId || "");
    const previous = byId.get(key);
    if (!previous || Number(candidate.rootPriority || 0) > Number(previous.rootPriority || 0)) {
      byId.set(key, candidate);
    }
  }
  return localLyricResolver.select([...byId.values()]);
}

function getExternalLyricConfig() {
  const configuredRoot = String(configuredExternalLyricRoot || "").trim();
  return {
    externalLyricDir: configuredRoot,
    // 自动推导的镜像歌词根目录属于主进程上下文，不作为普通设置载荷返回。
    roots: configuredRoot ? [configuredRoot] : [],
  };
}

// 解析队列，限制并发，避免阻塞
const queue = [];
let running = 0;
const CONCURRENCY = 8; // 提升并发，加速未缓存解析

function readCacheEntries(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  if (Object.prototype.hasOwnProperty.call(obj, "version")) {
    if (obj.version !== CACHE_VERSION) return {};
    if (!obj.entries || typeof obj.entries !== "object" || Array.isArray(obj.entries)) return {};
    return obj.entries;
  }
  // V1 以前没有版本封装，继续读取平面对象。
  return obj;
}

// 异步读取磁盘缓存（兼容无版本的旧平面格式）
const cacheReady = (async () => {
  try {
    if (!fs.existsSync(CACHE_PATH)) return;
    const raw = await fsp.readFile(CACHE_PATH, "utf-8");
    const obj = JSON.parse(raw);
    const entries = Object.entries(readCacheEntries(obj));
    for (let i = 0; i < entries.length; i++) {
      const [k, v] = entries[i];
      if (typeof k === "string" && v && typeof v === "object" && !Array.isArray(v)) cache.set(k, v);
      if ((i + 1) % 64 === 0) await new Promise(resolve => setImmediate(resolve));
    }
  } catch (_) {
    // ignore
  }
})();

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    cacheWriter.save(new Map(cache)).catch(() => {});
  }, 2000);
}

async function flushMetadataCache() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    cacheWriter.save(new Map(cache)).catch(() => {});
  }
  await cacheWriter.flush();
}

function cacheKey(p, stat) {
  const part = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  return [
    p,
    part(stat.mtimeMs),
    part(stat.ctimeMs),
    part(stat.birthtimeMs),
    part(stat.size),
  ].join("|");
}

function normalizedPathIdentity(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const resolved = path.resolve(raw);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function metadataIdentity(trackPath, resourceId = "") {
  const rawPath = String(trackPath || "").trim();
  return {
    path: rawPath ? path.resolve(rawPath) : "",
    pathKey: normalizedPathIdentity(rawPath),
    resourceId: String(resourceId || "").trim(),
  };
}

function identityScopes(identity) {
  const scopes = identity?.pathKey ? [`path:${identity.pathKey}`] : [];
  if (identity?.resourceId) scopes.push(`resource:${identity.resourceId}`);
  return scopes;
}

function captureInvalidationGeneration(identity) {
  return identityScopes(identity).map((scope) => [scope, Number(invalidationGenerations.get(scope) || 0)]);
}

function isInvalidationGenerationCurrent(snapshot) {
  return (snapshot || []).every(([scope, generation]) => (
    Number(invalidationGenerations.get(scope) || 0) === Number(generation || 0)
  ));
}

function commitCacheEntry(key, value, generation) {
  if (!isInvalidationGenerationCurrent(generation)) return false;
  cache.set(key, serializeCacheEntry(value));
  scheduleSave();
  return true;
}

function pruneSupersededCacheEntries(identity, keepKey = "") {
  let removed = 0;
  for (const key of cacheKeysForIdentity(identity)) {
    if (key === keepKey) continue;
    cache.delete(key);
    removed += 1;
  }
  if (removed) scheduleSave();
  return removed;
}

function cacheKeysForIdentity(identity) {
  const keys = new Set();
  for (const scope of identityScopes(identity)) {
    for (const key of cacheIdentityKeys.get(scope) || []) keys.add(key);
  }
  return keys;
}

async function invalidateTrackMetadata(trackPathOrRequest, options = {}) {
  await cacheReady;
  const request = trackPathOrRequest && typeof trackPathOrRequest === "object"
    ? trackPathOrRequest
    : { trackPath: trackPathOrRequest, ...options };
  const trackPath = String(request.trackPath || request.path || "").trim();
  const resourceId = String(request.resourceId || "").trim();
  if (!trackPath && !resourceId) return { invalidated: 0 };
  const identity = metadataIdentity(trackPath, resourceId);
  for (const scope of identityScopes(identity)) {
    invalidationGenerations.set(scope, Number(invalidationGenerations.get(scope) || 0) + 1);
  }
  let invalidated = 0;
  for (const key of cacheKeysForIdentity(identity)) {
    cache.delete(key);
    invalidated += 1;
  }
  if (invalidated) scheduleSave();
  return { invalidated };
}

function serializeCacheEntry(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const output = { ...value };
  // 结构化歌词可由来源依赖重建，不与兼容文本在磁盘重复保存。
  delete output.lyricsModel;
  return output;
}

function publicMetadata(value, { includeLyricsModel = false, includeLyrics = true } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const output = { ...value };
  delete output._cacheIdentity;
  if (!includeLyricsModel) delete output.lyricsModel;
  if (!includeLyrics) {
    delete output.lyricsModel;
    delete output.lyrics;
    delete output.lyricsStatus;
    delete output.lyricsProvenance;
  }
  return output;
}

function resourceUrlToPath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const mediaPath = localMediaUrlToPath(raw);
  if (mediaPath) return mediaPath;
  if (!/^file:\/\//i.test(raw)) return raw;
  try {
    const u = new URL(raw);
    return decodeURIComponent(u.pathname)
      .replace(/^\/([A-Za-z]:\/)/, "$1")
      .replace(/\//g, path.sep);
  } catch (_) {
    return raw.replace(/^file:\/\/\//i, "").replace(/\//g, path.sep);
  }
}

function remapMovedCachePath(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^(https?:|data:|blob:)/i.test(raw)) return raw;
  const originalPath = resourceUrlToPath(raw);
  if (originalPath && fs.existsSync(originalPath)) {
    return toLocalMediaUrl(originalPath);
  }
  const normalized = raw.replace(/\\/g, "/");
  const idx = normalized.toLowerCase().lastIndexOf(CACHE_URL_MARKER);
  if (idx < 0) return raw;
  const rel = normalized.slice(idx + CACHE_URL_MARKER.length).split(/[?#]/)[0];
  const candidate = path.join(CACHE_DIR, ...rel.split("/").filter(Boolean));
  if (candidate && fs.existsSync(candidate)) return toLocalMediaUrl(candidate);
  return raw;
}

function normalizeCachedCoverFields(info) {
  if (!info || typeof info !== "object") return false;
  const beforeCover = info.cover || "";
  const beforeThumb = info.cover_thumb || "";
  info.cover = remapMovedCachePath(info.cover || "");
  info.cover_thumb = remapMovedCachePath(info.cover_thumb || info.cover || "");
  return beforeCover !== info.cover || beforeThumb !== info.cover_thumb;
}

async function enqueue(task) {
  return new Promise((resolve, reject) => {
    queue.push({ task, resolve, reject });
    runQueue();
  });
}

function runQueue() {
  if (running >= CONCURRENCY || queue.length === 0) return;
  const { task, resolve, reject } = queue.shift();
  running += 1;
  task()
    .then(resolve)
    .catch(reject)
    .finally(() => {
      running -= 1;
      runQueue();
    });
}

function minimal(trackPath) {
  return {
    path: trackPath,
    title: path.basename(trackPath, path.extname(trackPath)),
    titleFromTag: false,
    artist: "未知艺术家",
    artists: [],
    album: "",
    albumArtist: "",
    albumArtists: [],
    releaseDate: "",
    trackNumber: 0,
    trackTotal: 0,
    discNumber: 0,
    discTotal: 0,
    genres: [],
    composers: [],
    lyricists: [],
    isrcs: [],
    duration: 0,
    cover: "",
    cover_thumb: "",
    lyrics: "",
    lyricsModel: null,
    lyricsStatus: "missing",
    lyricsProvenance: null,
  };
}

async function ensureSharp() {
  if (sharp) return sharp;
  try {
    sharp = require("sharp");
  } catch (e) {
    sharp = null;
  }
  return sharp;
}

async function saveCoverToFile(pic) {
  const hash = crypto.createHash("md5").update(pic.data).digest("hex");
  const ext = (pic.format || "").includes("png") ? "png" : "jpg";
  const out = path.join(COVER_DIR, `${hash}.${ext}`);
  const thumbOut = path.join(THUMB_DIR, `${hash}.${ext}`);
  try {
    await fsp.writeFile(out, pic.data, { flag: "wx" }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    // 生成缩略图
    const s = await ensureSharp();
    const thumbnailExists = await fsp.access(thumbOut).then(() => true, () => false);
    if (s && !thumbnailExists) {
      await s(pic.data).resize({ width: 160, height: 160, fit: "inside" }).toFile(thumbOut);
    } else if (!s && !thumbnailExists) {
      // 无 sharp 时退化为原图
      await fsp.writeFile(thumbOut, pic.data);
    }
    return { cover: toLocalMediaUrl(out), cover_thumb: toLocalMediaUrl(thumbOut) };
  } catch (_) {
    return { cover: toLocalMediaUrl(out), cover_thumb: toLocalMediaUrl(out) };
  }
}

async function extractCover(common, trackPath) {
  try {
    if (common?.picture?.length) {
      const pic = common.picture[0];
      if (pic?.data?.length && pic.data.length <= 5_000_000) {
        return await saveCoverToFile(pic);
      }
    }
  } catch (_) {
    // ignore and fallback
  }
  const folder = await findFolderCover(trackPath);
  return { cover: folder, cover_thumb: folder };
}

function formatLrcTimestampFromMs(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  const totalSec = safeMs / 1000;
  const mm = Math.floor(totalSec / 60);
  const ss = totalSec - mm * 60;
  const ssStr = ss.toFixed(2).padStart(5, "0");
  return `[${String(mm).padStart(2, "0")}:${ssStr}]`;
}

function getSyltTimestampMs(rawTs, tsFormat, meta) {
  const numeric = Number(rawTs);
  if (!Number.isFinite(numeric)) return NaN;
  // ID3 SYLT: 2 = milliseconds, 1 = MPEG frames.
  if (tsFormat !== 1) return numeric;
  // MPEG1-L3 usually 1152 samples/frame; MPEG2/2.5-L3 often 576.
  const sampleRate = Number(meta?.format?.sampleRate || 0);
  const codecProfile = String(meta?.format?.codecProfile || "").toLowerCase();
  const samplesPerFrame = codecProfile.includes("mpeg 2") || codecProfile.includes("mpeg 2.5") ? 576 : 1152;
  if (sampleRate > 0) return (numeric * samplesPerFrame * 1000) / sampleRate;
  // Fallback to common MP3 frame duration at 44.1kHz MPEG1-L3.
  return numeric * 26.122449;
}

function extractSyncedLyricsFromNative(meta) {
  const native = meta?.native;
  if (!native || typeof native !== "object") return "";
  const lines = [];
  Object.values(native).forEach((tags) => {
    if (!Array.isArray(tags)) return;
    tags.forEach((tag) => {
      const id = String(tag?.id || "").toUpperCase();
      if (!id.includes("SYLT")) return;
      const value = tag?.value;
      if (!value || typeof value !== "object") return;
      const syncItems = Array.isArray(value.synchronisedText)
        ? value.synchronisedText
        : (Array.isArray(value.syncText)
          ? value.syncText
          : (Array.isArray(value.syncLyrics) ? value.syncLyrics : []));
      if (!syncItems.length) return;
      const tsFormat = Number(value.timestampFormat || value.timeStampFormat || 2);
      syncItems.forEach((item) => {
        const text = String(item?.text || item?.line || "").trim();
        if (!text) return;
        const tsMs = getSyltTimestampMs(item?.timestamp ?? item?.timeStamp ?? item?.time ?? item?.ts ?? NaN, tsFormat, meta);
        if (!Number.isFinite(tsMs)) return;
        lines.push(`${formatLrcTimestampFromMs(tsMs)}${text}`);
      });
    });
  });
  if (!lines.length) return "";
  return lines.join("\n");
}

function hasLrcTimeTags(text) {
  if (!text) return false;
  const source = String(text);
  return /[\[［]\s*\d+\s*[:：]\s*\d+(?:[.,]-?\d+)?\s*[\]］]/u.test(source)
    || /[\[［]\s*\d+\s*[,，]\s*\d+\s*[\]］]\s*[\(（]\s*\d+\s*[,，]\s*\d+/u.test(source);
}

function extractTimedLyricsFromNativeText(meta) {
  const native = meta?.native;
  if (!native || typeof native !== "object") return "";
  const candidates = [];
  Object.values(native).forEach((tags) => {
    if (!Array.isArray(tags)) return;
    tags.forEach((tag) => {
      const id = String(tag?.id || "").toUpperCase();
      if (!id || id.includes("SYLT")) return;
      if (!(id.includes("LYRIC") || id.includes("LRC") || id.includes("UNSYNCED"))) return;
      const value = tag?.value;
      if (typeof value === "string") {
        const text = value.trim();
        if (text) candidates.push({ id, text });
        return;
      }
      if (value && typeof value === "object") {
        const text = String(value.text || value.lyrics || value.content || "").trim();
        if (text) candidates.push({ id, text });
      }
    });
  });
  if (!candidates.length) return "";
  // Prefer explicit LYRICS/LRC style tags, then fallback to any lyric-like tag.
  candidates.sort((a, b) => {
    const aScore = (a.id.includes("LYRICS") ? 2 : 0) + (a.id.includes("LRC") ? 1 : 0);
    const bScore = (b.id.includes("LYRICS") ? 2 : 0) + (b.id.includes("LRC") ? 1 : 0);
    if (aScore !== bScore) return bScore - aScore;
    return b.text.length - a.text.length;
  });
  for (const item of candidates) {
    if (hasLrcTimeTags(item.text)) return item.text;
  }
  return "";
}

function collectEmbeddedLyrics(meta) {
  const embedded = [];
  const seen = new Set();
  const add = (id, text, extra = {}) => {
    const value = String(text || "").trim();
    if (!value || seen.has(value)) return;
    seen.add(value);
    embedded.push({ id, text: value, role: "main", ...extra });
  };
  const syncedFromNative = extractSyncedLyricsFromNative(meta);
  add("native:sylt", syncedFromNative, { format: "lrc" });
  const timedNativeText = extractTimedLyricsFromNativeText(meta);
  add("native:timed", timedNativeText, { format: "auto" });
  try {
    const values = Array.isArray(meta?.common?.lyrics) ? meta.common.lyrics : [meta?.common?.lyrics];
    values.filter(Boolean).forEach((value, index) => {
      if (typeof value === "string") {
        add(`common:${index}`, value);
      } else if (value && typeof value === "object") {
        add(`common:${index}`, value.text || value.lyrics || value.content || "", {
          language: String(value.language || value.lang || ""),
        });
      }
    });
  } catch (_) {
    // A malformed common.lyrics entry must not hide native or local files.
  }
  return embedded;
}

function lyricEvidence(meta, trackPath, fallback = null) {
  const common = meta?.common || {};
  const commonArtists = Array.isArray(common.artists) ? common.artists.filter(Boolean) : [];
  const fallbackArtists = Array.isArray(fallback?.artists) ? fallback.artists.filter(Boolean) : [];
  const artist = String(common.artist || fallback?.artist || "").trim();
  return {
    title: String(common.title || fallback?.title || "").trim(),
    titleFromFileName: !common.title && !fallback?.titleFromTag,
    artists: commonArtists.length ? commonArtists : (artist ? [artist] : fallbackArtists),
    album: String(common.album || fallback?.album || "").trim(),
    durationSeconds: Number(meta?.format?.duration || fallback?.duration || 0),
    trackPath,
  };
}

async function resolveLocalLyrics(meta, trackPath, { fallback = null, sources = null } = {}) {
  try {
    return await resolveLyricsWithMirroredRoot({
      trackPath,
      evidence: lyricEvidence(meta, trackPath, fallback),
      embedded: sources && !sources.includes("embedded") ? [] : collectEmbeddedLyrics(meta),
      sources,
    });
  } catch (_) {
    return { status: "missing", selected: null, alternatives: [] };
  }
}

async function resolveLocalLyricsForLookup(trackPath, evidence = {}, { sources = null } = {}) {
  const enabled = Array.isArray(sources) ? sources : ["external", "sidecar", "embedded"];
  let meta = null;
  if (enabled.includes("embedded")) {
    try {
      const { parseFile } = await getMusicMetadata();
      meta = await parseFile(trackPath, { duration: false, skipCovers: true });
    } catch (_) {
      meta = null;
    }
  }
  try {
    return await resolveLyricsWithMirroredRoot({
      trackPath,
      evidence,
      embedded: enabled.includes("embedded") ? collectEmbeddedLyrics(meta) : [],
      sources: enabled,
    });
  } catch (_) {
    return { status: "missing", selected: null, alternatives: [] };
  }
}

async function resolveExternalLyricsForOnline(evidence = {}) {
  try {
    const roots = getExternalLyricRoots();
    if (!roots.length) return { status: "missing", lyricsModel: null, lyric: "", provenance: null };
    const resolutions = await Promise.all(roots.map((root) => (
      resolverForExternalRoot(root).resolveExternal({ evidence })
    )));
    const candidates = resolutions.flatMap((resolution) => candidatesFromResolution(resolution, 0));
    const resolution = localLyricResolver.select(candidates);
    const selected = resolution?.status === "selected" ? resolution.selected : null;
    return {
      status: selected ? "selected" : (resolution?.status === "ambiguous" ? "ambiguous" : "missing"),
      lyricsModel: selected?.model || null,
      lyric: selected?.legacyText || "",
      provenance: publicLyricProvenance(selected),
    };
  } catch (_) {
    return { status: "missing", lyricsModel: null, lyric: "", provenance: null };
  }
}

function publicLyricProvenance(candidate) {
  if (!candidate) return null;
  const dependency = candidate.dependency && typeof candidate.dependency === "object"
    ? Object.fromEntries(Object.entries(candidate.dependency).filter(([key]) => key !== "path"))
    : null;
  return {
    sourceType: candidate.sourceType,
    sourceName: candidate.relativePath ? path.basename(candidate.relativePath) : "",
    identityLevel: candidate.identityLevel,
    identityScore: candidate.identityScore,
    identityReason: candidate.identityReason,
    qualityLevel: candidate.qualityLevel,
    contentHash: candidate.contentHash,
    encoding: String(candidate.encoding || ""),
    dependency,
  };
}

function applyLyricsResolution(info, resolution) {
  const selected = resolution?.status === "selected" ? resolution.selected : null;
  const next = {
    lyrics: selected?.legacyText || "",
    lyricsModel: selected?.model || null,
    lyricsStatus: selected ? "selected" : (resolution?.status === "ambiguous" ? "ambiguous" : "missing"),
    lyricsProvenance: publicLyricProvenance(selected),
  };
  const before = JSON.stringify({
    lyrics: info.lyrics || "",
    hasLyricsModel: Boolean(info.lyricsModel),
    lyricsStatus: info.lyricsStatus || "",
    lyricsProvenance: info.lyricsProvenance || null,
  });
  const after = JSON.stringify({
    lyrics: next.lyrics,
    hasLyricsModel: Boolean(next.lyricsModel),
    lyricsStatus: next.lyricsStatus,
    lyricsProvenance: next.lyricsProvenance,
  });
  Object.assign(info, next);
  return before !== after;
}

async function refreshCachedLyrics(trackPath, info) {
  const localResolution = await resolveLocalLyrics(null, trackPath, {
    fallback: info,
    sources: ["external", "sidecar"],
  });
  const previousSource = String(info.lyricsProvenance?.sourceType || "");
  if (localResolution.status === "selected") {
    if (
      previousSource === "embedded"
      && compareCandidatePriority(localResolution.selected, info.lyricsProvenance) >= 0
    ) {
      return false;
    }
    return applyLyricsResolution(info, localResolution);
  }

  if (previousSource === "embedded" && info.lyricsModel) return false;
  if (previousSource && previousSource !== "embedded" && !["external", "sidecar"].includes(previousSource)) {
    return applyLyricsResolution(info, localResolution);
  }

  try {
    const { parseFile } = await getMusicMetadata();
    const meta = await parseFile(trackPath, { duration: false });
    return applyLyricsResolution(info, await resolveLocalLyrics(meta, trackPath, { fallback: info }));
  } catch (_) {
    if (["external", "sidecar"].includes(previousSource)) {
      return applyLyricsResolution(info, localResolution);
    }
    return false;
  }
}

async function findFolderCover(trackPath) {
  try {
    if (!trackPath) return "";
    const dir = path.dirname(trackPath);
    const preferred = ["cover.jpg", "cover.jpeg", "cover.png", "folder.jpg", "folder.png"];
    for (const name of preferred) {
      const p = path.join(dir, name);
      if (await fsp.access(p).then(() => true, () => false)) return toLocalMediaUrl(p);
    }
    const files = await fsp.readdir(dir);
    const img = files.find((f) => /\.(jpg|jpeg|png)$/i.test(f));
    if (img) return toLocalMediaUrl(path.join(dir, img));
  } catch (_) {}
  return "";
}

async function parseMeta(trackPath, stat = null, key = null, context = {}) {
  await cacheReady;
  if (!stat) stat = await fsp.stat(trackPath);
  if (!stat.isFile()) return minimal(trackPath);
  if (!key) key = cacheKey(trackPath, stat);
  if (cache.has(key)) {
    const hit = cache.get(key);
    if (normalizeCachedCoverFields(hit)) scheduleSave();
    return hit;
  }

  let info = minimal(trackPath);
  try {
    const { parseFile } = await getMusicMetadata();
    const meta = await parseFile(trackPath, { duration: true });
    const common = meta.common || {};
    const format = meta.format || {};
    const artists = Array.isArray(common.artists) && common.artists.length
      ? common.artists.filter(Boolean)
      : (common.artist ? [common.artist] : []);
    const albumArtists = common.albumartist ? [common.albumartist] : [];
    info = {
      path: trackPath,
      title: common.title || info.title,
      titleFromTag: Boolean(common.title),
      artist: common.artist || (artists.length ? artists.join(", ") : info.artist),
      artists,
      album: common.album || "",
      albumArtist: common.albumartist || "",
      albumArtists,
      releaseDate: String(common.date || common.originaldate || common.year || ""),
      trackNumber: Number(common.track?.no || 0),
      trackTotal: Number(common.track?.of || 0),
      discNumber: Number(common.disk?.no || 0),
      discTotal: Number(common.disk?.of || 0),
      genres: Array.isArray(common.genre) ? common.genre.filter(Boolean) : [],
      composers: Array.isArray(common.composer) ? common.composer.filter(Boolean) : [],
      lyricists: Array.isArray(common.lyricist) ? common.lyricist.filter(Boolean) : [],
      isrcs: Array.isArray(common.isrc) ? common.isrc.filter(Boolean) : [],
      duration: format.duration ? Math.round(format.duration) : 0,
      audioInfo: audioFormatDetails(format, stat),
      ...(await extractCover(common, trackPath)),
      lyrics: "",
      lyricsModel: null,
      lyricsStatus: "missing",
      lyricsProvenance: null,
    };
    if (context.includeLyrics !== false) {
      applyLyricsResolution(info, await resolveLocalLyrics(meta, trackPath));
      context.lyricsResolved = true;
    }
  } catch (_) {
    info.metadataError = true;
    const fallback = await findFolderCover(trackPath);
    info.cover = fallback;
    info.cover_thumb = fallback;
    if (context.includeLyrics !== false) {
      applyLyricsResolution(info, await resolveLocalLyrics(null, trackPath, { fallback: info }));
      context.lyricsResolved = true;
    }
  }

  info._cacheIdentity = metadataIdentity(trackPath, context.resourceId);
  commitCacheEntry(key, info, context.generation);
  return info;
}

async function getMeta(trackPath, options = {}) {
  await cacheReady;
  if (!trackPath) return null;
  const stat = await fsp.stat(trackPath);
  if (!stat.isFile()) return minimal(trackPath);
  const identity = metadataIdentity(trackPath, options.resourceId);
  const generation = captureInvalidationGeneration(identity);
  const key = cacheKey(trackPath, stat);
  pruneSupersededCacheEntries(identity, key);
  // 缓存命中直接返回，不进队列
  if (cache.has(key)) {
    const hit = cache.get(key);
    if (options.includeAudioDetails === true && !hit.audioInfo) {
      await enqueue(async () => {
        if (hit.audioInfo || !isInvalidationGenerationCurrent(generation)) return;
        try {
          const { parseFile } = await getMusicMetadata();
          const parsed = await parseFile(trackPath, { duration: true, skipCovers: true });
          if (!isInvalidationGenerationCurrent(generation)) return;
          hit.audioInfo = audioFormatDetails(parsed.format || {}, stat);
          commitCacheEntry(key, hit, generation);
        } catch (_) { /* Failed enrichment is retryable; never invalidate healthy playback metadata. */ }
      });
    }
    if (normalizeCachedCoverFields(hit)) scheduleSave();
    if (options.includeLyrics !== false && await refreshCachedLyrics(trackPath, hit)) {
      commitCacheEntry(key, hit, generation);
    }
    if (!isInvalidationGenerationCurrent(generation)) return getMeta(trackPath, options);
    return publicMetadata(hit, options);
  }
  // 未命中才入队解析
  const context = {
    resourceId: identity.resourceId,
    generation,
    includeLyrics: options.includeLyrics !== false,
  };
  const info = await enqueue(() => parseMeta(trackPath, stat, key, context));
  // 同一文件可能先由列表请求完成解析，当前播放请求仍须补齐歌词。
  if (options.includeLyrics !== false && !context.lyricsResolved) {
    if (await refreshCachedLyrics(trackPath, info)) commitCacheEntry(key, info, generation);
  }
  if (!isInvalidationGenerationCurrent(generation)) return getMeta(trackPath, options);
  return publicMetadata(info, options);
}

function audioFormatDetails(format, stat) {
  const positive = value => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : null;
  return {
    sampleRate: positive(format.sampleRate), bitrate: positive(format.bitrate),
    bitsPerSample: positive(format.bitsPerSample), channels: positive(format.numberOfChannels),
    codec: String(format.codec || "").slice(0, 80), container: String(format.container || "").slice(0, 80),
    lossless: typeof format.lossless === "boolean" ? format.lossless : null,
    size: positive(stat?.size), duration: positive(format.duration),
  };
}

module.exports = {
  getMeta,
  async invalidateLyricSources(trackPath, resourceId = "") {
    localLyricResolver.invalidate();
    for (const resolver of discoveredLyricResolvers.values()) resolver.invalidate();
    return invalidateTrackMetadata({ trackPath, resourceId });
  },
  flushMetadataCache,
  invalidateTrackMetadata,
  resolveExternalLyricsForOnline,
  resolveLocalLyricsForLookup,
  setExternalLyricRoot,
  setLibraryAudioRoot,
  getExternalLyricConfig,
  __test: {
    audioFormatDetails,
    CACHE_VERSION,
    applyLyricsResolution,
    cacheKey,
    cache,
    commitCacheEntry,
    captureInvalidationGeneration,
    invalidationGenerations,
    isInvalidationGenerationCurrent,
    metadataIdentity,
    pruneSupersededCacheEntries,
    publicLyricProvenance,
    publicMetadata,
    readCacheEntries,
    discoverLibraryLyricRoot,
    resolveLocalLyrics,
    serializeCacheEntry,
  },
};
