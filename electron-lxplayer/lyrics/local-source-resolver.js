const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const {
  artistCreditSimilarity,
  extractVersionTerms,
  normalizeText,
  textSimilarity,
} = require("../song-info/candidate-model");
const {
  QUALITY_ORDER,
  buildUnifiedLyric,
  channelQuality,
  exportEnhancedLrc,
  parseLyricChannel,
} = require("./unified-lyric");

const LYRIC_EXTENSIONS = Object.freeze([".lrc", ".yrc", ".qrc", ".txt", ".lyric", ".lyrics"]);
const LYRIC_EXTENSION_SET = new Set(LYRIC_EXTENSIONS);
const IDENTITY_ORDER = Object.freeze({ reject: 0, weak: 1, medium: 2, strong: 3 });
const SOURCE_PRIORITY = Object.freeze({ external: 3, sidecar: 2, embedded: 1 });
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_INDEX_TTL_MS = 30000;
const LEGACY_ENCODING_MIN_GAP = 5;
const ENCRYPTED_QRC_MAGIC = Buffer.from([0x98, 0x25, 0xb0, 0xac, 0xe3, 0x02, 0x83, 0x68, 0xe8, 0xfc, 0x6c]);

class LocalLyricError extends Error {
  constructor(message, code = "LOCAL_LYRIC_FAILED") {
    super(message);
    this.name = "LocalLyricError";
    this.code = code;
  }
}

function normalizeLookupKey(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("und")
    .replace(/\.[^.]+$/u, "")
    .replace(/\s*[\(（]\s*\d{5,}\s*[\)）]\s*$/u, "")
    .replace(/_+/gu, " ")
    .replace(/\s+/gu, " ")
    .replace(/[()[\]{}]/gu, "")
    .trim();
}

function cleanFileBase(fileName) {
  return path.parse(String(fileName || "")).name
    .replace(/\s*[\(（]\s*\d{5,}\s*[\)）]\s*$/u, "")
    .trim();
}

function splitArtistTitle(value) {
  const parts = cleanFileBase(value).split(/\s+-\s+/u).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return [];
  const left = parts[0];
  const right = parts.slice(1).join(" - ");
  return [
    { artist: left, title: right, direction: "artist-title" },
    { artist: right, title: left, direction: "title-artist" },
  ];
}

function buildFileLookupKeys(fileName) {
  const base = cleanFileBase(fileName);
  const keys = new Set([normalizeLookupKey(base)]);
  // 检索也需包含去附注主体；身份与版本检查仍在候选读取后执行。
  const bases = [base, base.normalize("NFKC").replace(/\([^()]*\)/gu, " ").replace(/\s+/gu, " ").trim()];
  for (const value of bases) {
    keys.add(normalizeLookupKey(value));
    splitArtistTitle(value).forEach((part) => {
      keys.add(normalizeLookupKey(part.title));
      keys.add(normalizeLookupKey(`${part.artist} - ${part.title}`));
      keys.add(normalizeLookupKey(`${part.title} - ${part.artist}`));
    });
  }
  return [...keys].filter(Boolean);
}

function buildTrackLookupKeys(trackPath, evidence = {}) {
  const keys = new Set();
  const add = (value) => {
    const key = normalizeLookupKey(value);
    if (key) keys.add(key);
  };
  add(path.parse(String(trackPath || "")).name);
  add(evidence.title);
  for (const artist of evidence.artists || []) {
    add(`${artist} - ${evidence.title}`);
    add(`${evidence.title} - ${artist}`);
  }
  return [...keys];
}

function extractLrcMetadata(text) {
  const source = String(text || "");
  const read = (name) => {
    const match = source.match(new RegExp(`^[\\[［]\\s*${name}\\s*:\\s*(.*?)\\s*[\\]］]\\s*$`, "imu"));
    return match ? String(match[1] || "").trim() : "";
  };
  const artist = read("ar");
  return {
    title: read("ti"),
    artists: artist ? artist.split(/[、,;/&]+/u).map((item) => item.trim()).filter(Boolean) : [],
    album: read("al"),
    language: read("la") || read("language"),
    manualSelection: read("re") === "Flowave:user-selected",
  };
}

function normalizeEvidence(trackPath, raw = {}) {
  const artists = Array.isArray(raw.artists)
    ? raw.artists.map(String).map((item) => item.trim()).filter(Boolean)
    : (raw.artist ? [String(raw.artist).trim()].filter(Boolean) : []);
  const title = String(raw.title || "").trim();
  return {
    trackPath: path.resolve(String(trackPath || "")),
    fileBase: path.parse(String(trackPath || "")).name,
    title: title || path.parse(String(trackPath || "")).name,
    titleFromFileName: Boolean(raw.titleFromFileName) || !title,
    artists,
    album: String(raw.album || "").trim(),
    durationSeconds: Math.max(0, Number(raw.durationSeconds || raw.duration || 0)),
    versionTerms: extractVersionTerms([title, path.parse(String(trackPath || "")).name].filter(Boolean).join(" ")),
  };
}

function sameVersionTerms(left, right) {
  const a = new Set(left || []);
  const b = new Set(right || []);
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function scoreFilenameDirections(fileName, evidence) {
  return splitArtistTitle(fileName)
    .map((part) => {
      const stripAnnotations = (value) => String(value || "").normalize("NFKC").replace(/\([^()]*\)/gu, " ").trim();
      const titleScore = Math.max(
        textSimilarity(evidence.title, part.title, { ignoreVersion: true }),
        textSimilarity(stripAnnotations(evidence.title), stripAnnotations(part.title), { ignoreVersion: true }),
      );
      const artistScore = evidence.artists.length ? artistCreditSimilarity(evidence.artists, [part.artist]) : 0;
      return {
        ...part,
        titleScore,
        artistScore,
        score: titleScore * 0.6 + artistScore * 0.4,
      };
    })
    .sort((left, right) => right.score - left.score || left.direction.localeCompare(right.direction));
}

function classifyIdentity({ sourceType, fileName, metadata, evidence }) {
  if (["sidecar", "embedded"].includes(sourceType)) {
    return { identityLevel: "strong", identityScore: 100, identityReason: `${sourceType}_bound` };
  }
  const candidateTitle = metadata.title;
  const candidateArtists = metadata.artists || [];
  const versionSource = [candidateTitle, cleanFileBase(fileName)].filter(Boolean).join(" ");
  if (!sameVersionTerms(evidence.versionTerms, extractVersionTerms(versionSource))) {
    return { identityLevel: "reject", identityScore: 0, identityReason: "version_conflict" };
  }
  if (candidateTitle && candidateArtists.length) {
    // 版本冲突已在上方拦截；括号里的翻译、作品说明和艺名读音不应降低主体匹配。
    const withoutAnnotations = (text) => String(text || "").normalize("NFKC")
      .replace(/\([^()]*\)/gu, " ").replace(/\s+/gu, " ").trim();
    const titleForms = (text) => {
      const raw = String(text || "").normalize("NFKC");
      return [raw, withoutAnnotations(raw), ...Array.from(raw.matchAll(/\(([^()]*)\)/gu), (match) => match[1])].filter(Boolean);
    };
    const leftForms = titleForms(evidence.title);
    const rightForms = titleForms(candidateTitle);
    const primaryLeft = withoutAnnotations(evidence.title);
    const primaryRight = withoutAnnotations(candidateTitle);
    const exactAlias = (primaryLeft && rightForms.slice(2).some((alias) => normalizeText(alias) === normalizeText(primaryLeft)))
      || (primaryRight && leftForms.slice(2).some((alias) => normalizeText(alias) === normalizeText(primaryRight)));
    const titleScore = Math.max(
      textSimilarity(evidence.title, candidateTitle, { ignoreVersion: true }),
      primaryLeft && primaryRight ? textSimilarity(primaryLeft, primaryRight, { ignoreVersion: true }) : 0,
      exactAlias ? 1 : 0,
    );
    const artistScore = evidence.artists.length ? Math.max(
      artistCreditSimilarity(evidence.artists, candidateArtists),
      artistCreditSimilarity(evidence.artists.map(withoutAnnotations), candidateArtists.map(withoutAnnotations)),
    ) : 0;
    const albumScore = evidence.album && metadata.album ? textSimilarity(evidence.album, metadata.album) : 0;
    const score = Math.round((titleScore * 0.55 + artistScore * 0.4 + albumScore * 0.05) * 1000) / 10;
    if (titleScore >= 0.92 && artistScore >= 0.9) {
      return { identityLevel: "strong", identityScore: score, identityReason: "artist_title_metadata" };
    }
    if (titleScore >= 0.82 && artistScore >= 0.65) {
      return { identityLevel: "medium", identityScore: score, identityReason: "metadata_similar" };
    }
    return { identityLevel: "reject", identityScore: score, identityReason: titleScore < 0.7 ? "title_conflict" : "artist_conflict" };
  }

  const directions = scoreFilenameDirections(fileName, evidence);
  const best = directions[0];
  const second = directions[1];
  if (
    best
    && best.titleScore >= 0.9
    && best.artistScore >= 0.75
    && (!second || best.score - second.score >= 0.08)
  ) {
    return {
      identityLevel: "medium",
      identityScore: Math.round(best.score * 1000) / 10,
      identityReason: best.direction,
    };
  }
  if (normalizeLookupKey(cleanFileBase(fileName)) === normalizeLookupKey(evidence.fileBase)) {
    return { identityLevel: "medium", identityScore: 85, identityReason: "basename_exact" };
  }
  const titleHint = candidateTitle || cleanFileBase(fileName);
  const titleScore = textSimilarity(evidence.title, titleHint, { ignoreVersion: true });
  if (titleScore >= 0.92) {
    return { identityLevel: "weak", identityScore: Math.round(titleScore * 1000) / 10, identityReason: "title_only" };
  }
  return { identityLevel: "reject", identityScore: Math.round(titleScore * 1000) / 10, identityReason: "insufficient_identity" };
}

function sourceFormat(filePath, fallback = "auto") {
  const extension = path.extname(String(filePath || "")).toLowerCase();
  if (extension === ".yrc") return "yrc";
  if (extension === ".qrc") return "qrc";
  if ([".txt", ".lyric", ".lyrics"].includes(extension)) return "plain";
  if (extension === ".lrc") return "lrc";
  return fallback;
}

function contentHash(text) {
  return crypto.createHash("sha256").update(String(text || ""), "utf8").digest("hex");
}

function strictDecode(buffer, encoding) {
  return new TextDecoder(encoding, { fatal: true }).decode(buffer);
}

function countPattern(text, pattern) {
  return (String(text || "").match(pattern) || []).length;
}

function legacyEncodingScore(text, encoding) {
  const value = String(text || "");
  if (!value || value.includes("\0") || value.includes("\uFFFD")) return Number.NEGATIVE_INFINITY;
  const forbiddenControls = countPattern(value, /[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu);
  if (forbiddenControls) return Number.NEGATIVE_INFINITY;
  const timedLines = countPattern(value, /^(?:\s*)[\[［](?:\d+\s*[:：]\s*\d+|\d+\s*[,，]\s*\d+)[\]］]/gmu);
  const metadataLines = countPattern(value, /^(?:\s*)[\[［](?:ti|ar|al|by|offset|la|language)\s*:/gimu);
  const kana = countPattern(value, /[\u3040-\u30FF]/gu);
  const halfwidthKana = countPattern(value, /[\uFF61-\uFF9F]/gu);
  const han = countPattern(value, /\p{Script=Han}/gu);
  const simplifiedHints = countPattern(value, /[这们体国发后里为乐云歌词时间爱听龙门风万与东]/gu);
  const privateUse = countPattern(value, /[\uE000-\uF8FF]/gu);
  let score = Math.min(18, timedLines * 6) + Math.min(8, metadataLines * 2);
  score += Math.min(8, kana + han);
  score -= Math.min(16, halfwidthKana * 2);
  score -= Math.min(20, privateUse * 4);
  if (encoding === "shift_jis") score += Math.min(30, kana * 3);
  if (encoding === "gb18030") {
    score += Math.min(18, han);
    score += Math.min(18, simplifiedHints * 3);
  }
  return score;
}

function decodeLegacyLyricBuffer(buffer) {
  const candidates = [];
  for (const encoding of ["gb18030", "shift_jis"]) {
    try {
      const text = strictDecode(buffer, encoding);
      const score = legacyEncodingScore(text, encoding);
      if (Number.isFinite(score)) candidates.push({ text, encoding, score });
    } catch (_) {
      // Try the next explicitly supported legacy encoding.
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.encoding.localeCompare(right.encoding));
  if (!candidates.length) {
    throw new LocalLyricError("lyric encoding is unsupported", "LYRIC_ENCODING_UNSUPPORTED");
  }
  if (candidates.length > 1 && candidates[0].score - candidates[1].score < LEGACY_ENCODING_MIN_GAP) {
    throw new LocalLyricError("lyric encoding is ambiguous", "LYRIC_ENCODING_AMBIGUOUS");
  }
  return {
    text: candidates[0].text,
    encoding: candidates[0].encoding,
    confidenceGap: candidates.length > 1 ? candidates[0].score - candidates[1].score : null,
  };
}

function decodeLyricBufferDetailed(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return { text: "", encoding: "utf-8", confidenceGap: null };
  if (buffer.length >= ENCRYPTED_QRC_MAGIC.length && buffer.subarray(0, ENCRYPTED_QRC_MAGIC.length).equals(ENCRYPTED_QRC_MAGIC)) {
    throw new LocalLyricError("encrypted QRC is not supported", "QRC_ENCRYPTED_UNSUPPORTED");
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    const source = buffer.subarray(2);
    if (source.length % 2) throw new LocalLyricError("invalid UTF-16 lyric", "LYRIC_ENCODING_INVALID");
    return { text: source.toString("utf16le"), encoding: "utf-16le", confidenceGap: null };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    const source = buffer.subarray(2);
    if (source.length % 2) throw new LocalLyricError("invalid UTF-16 lyric", "LYRIC_ENCODING_INVALID");
    const swapped = Buffer.allocUnsafe(source.length);
    for (let index = 0; index < swapped.length; index += 2) {
      swapped[index] = source[index + 1];
      swapped[index + 1] = source[index];
    }
    return { text: swapped.toString("utf16le"), encoding: "utf-16be", confidenceGap: null };
  }
  const offset = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 3 : 0;
  const source = buffer.subarray(offset);
  try {
    return {
      text: strictDecode(source, "utf-8"),
      encoding: "utf-8",
      confidenceGap: null,
    };
  } catch (_) {
    return decodeLegacyLyricBuffer(source);
  }
}

function decodeLyricBuffer(buffer) {
  return decodeLyricBufferDetailed(buffer).text;
}

function repairSplitChannelEnds(lines) {
  const ordered = (Array.isArray(lines) ? lines : []).sort((left, right) => left.startMs - right.startMs);
  return ordered.map((line, index) => {
    const startMs = Number(line?.startMs);
    const currentEndMs = Number(line?.endMs);
    if (Number.isInteger(currentEndMs) && currentEndMs > startMs) return line;
    const words = Array.isArray(line?.words) ? line.words : [];
    const lastWordEndMs = Number(words[words.length - 1]?.endMs);
    const nextStartMs = Number(ordered[index + 1]?.startMs);
    const repairedEndMs = Number.isInteger(lastWordEndMs) && lastWordEndMs > startMs
      ? lastWordEndMs
      : (Number.isInteger(nextStartMs) && nextStartMs > startMs ? nextStartMs : startMs + 4000);
    return {
      ...line,
      endMs: repairedEndMs,
      flags: [...new Set([...(line?.flags || []), "split_end_repaired"])],
    };
  });
}

function splitImplicitTranslationChannel(channel) {
  if (!channel?.synced || channel.role !== "main" || !Array.isArray(channel.lines)) {
    return { main: channel, translation: null, splitCount: 0 };
  }
  const groups = new Map();
  for (const line of channel.lines) {
    const key = Number(line?.startMs);
    const group = groups.get(key) || [];
    group.push(line);
    groups.set(key, group);
  }
  const mainLines = [];
  const translationLines = [];
  let splitCount = 0;
  for (const group of groups.values()) {
    if (group.length === 2) {
      const [left, right] = group;
      const leftDetail = Array.isArray(left.words) ? left.words.length : 0;
      const rightDetail = Array.isArray(right.words) ? right.words.length : 0;
      const detailed = leftDetail >= 2 && rightDetail <= 1
        ? left
        : (rightDetail >= 2 && leftDetail <= 1 ? right : null);
      // LDDC/KTV 历史文件可能逐句交替，也可能先写完整原文块、再写完整译文块。
      // 相同时间戳归组后保持源文件顺序：第一项是歌曲原文，第二项是中文译文。
      // 仅在唯一逐字项是第一项时强化这一证据；第二项更细不能反转文件声明的语言顺序。
      const original = detailed === left ? detailed : left;
      const translated = right;
      mainLines.push({ ...original, flags: [...new Set([...(original.flags || []), "implicit_main_order"])] });
      translationLines.push({ ...translated, flags: [...new Set([...(translated.flags || []), "implicit_translation_order"])] });
      splitCount += 1;
      continue;
    }
    mainLines.push(...group);
  }
  if (!splitCount) return { main: channel, translation: null, splitCount: 0 };
  const main = {
    ...channel,
    lines: repairSplitChannelEnds(mainLines),
    diagnostics: [...(channel.diagnostics || []), { code: "implicit_translation_order", pairedLines: splitCount }],
  };
  main.qualityLevel = channelQuality(main);
  const translation = {
    role: "translation",
    language: "",
    sourceId: `${channel.sourceId || "local"}:translation`,
    synced: true,
    offsetMs: channel.offsetMs || 0,
    lines: repairSplitChannelEnds(translationLines),
    diagnostics: [{ code: "implicit_translation_order", pairedLines: splitCount }],
  };
  translation.qualityLevel = channelQuality(translation);
  return { main, translation, splitCount };
}

function publicCandidate(candidate) {
  return {
    candidateId: candidate.candidateId,
    sourceType: candidate.sourceType,
    lyricIdentity: candidate.lyricIdentity || null,
    sourceId: candidate.sourceId,
    sourcePath: candidate.sourcePath,
    relativePath: candidate.relativePath,
    identityLevel: candidate.identityLevel,
    identityScore: candidate.identityScore,
    identityReason: candidate.identityReason,
    qualityLevel: candidate.qualityLevel,
    contentHash: candidate.contentHash,
    encoding: candidate.encoding || "",
    model: candidate.model,
    legacyText: candidate.legacyText,
    dependency: candidate.dependency,
    rootPriority: Math.max(0, Number(candidate.rootPriority) || 0),
    manualSelection: candidate.manualSelection === true,
  };
}

function compareCandidatePriority(left, right) {
  return (
    (IDENTITY_ORDER[right?.identityLevel] || 0) - (IDENTITY_ORDER[left?.identityLevel] || 0)
    || Number(right?.identityScore || 0) - Number(left?.identityScore || 0)
    || Number(right?.rootPriority || 0) - Number(left?.rootPriority || 0)
    || (SOURCE_PRIORITY[right?.sourceType] || 0) - (SOURCE_PRIORITY[left?.sourceType] || 0)
    || (QUALITY_ORDER[right?.qualityLevel] || 0) - (QUALITY_ORDER[left?.qualityLevel] || 0)
    || String(left?.relativePath || "").localeCompare(String(right?.relativePath || ""), "und")
    || String(left?.candidateId || "").localeCompare(String(right?.candidateId || ""))
  );
}

class LocalLyricSourceResolver {
  constructor({
    externalRoot = "",
    fsp = fs.promises,
    indexTtlMs = DEFAULT_INDEX_TTL_MS,
    now = () => Date.now(),
  } = {}) {
    this.fsp = fsp;
    this.externalRoot = String(externalRoot || "").trim();
    this.indexTtlMs = Math.max(0, Number(indexTtlMs) || 0);
    this.now = typeof now === "function" ? now : () => Date.now();
    this.indexPromise = null;
    this.index = new Map();
    this.indexBuiltAt = 0;
    this.indexGeneration = 0;
    this.fileCache = new Map();
  }

  setExternalRoot(root) {
    const next = String(root || "").trim();
    if (next === this.externalRoot) return false;
    this.externalRoot = next;
    this.invalidate();
    return true;
  }

  invalidate() {
    this.indexGeneration += 1;
    this.indexPromise = null;
    this.index = new Map();
    this.indexBuiltAt = 0;
    this.fileCache.clear();
  }

  async ensureIndex() {
    if (this.indexPromise) return this.indexPromise;
    const now = this.now();
    if (this.indexBuiltAt && now - this.indexBuiltAt < this.indexTtlMs) return this.index;
    const generation = this.indexGeneration;
    const pending = this.buildIndex().then((next) => {
      if (generation !== this.indexGeneration) return this.index;
      this.index = next;
      this.indexBuiltAt = this.now();
      const indexedPaths = new Set();
      for (const bucket of next.values()) {
        for (const record of bucket) indexedPaths.add(record.path);
      }
      for (const signature of [...this.fileCache.keys()]) {
        const separator = signature.indexOf("|");
        const filePath = separator >= 0 ? signature.slice(0, separator) : signature;
        if (!indexedPaths.has(filePath)) this.fileCache.delete(signature);
      }
      return this.index;
    });
    this.indexPromise = pending;
    try {
      return await pending;
    } finally {
      if (this.indexPromise === pending) this.indexPromise = null;
    }
  }

  async buildIndex() {
    const next = new Map();
    const root = this.externalRoot ? path.resolve(this.externalRoot) : "";
    if (!root) return next;
    const visit = async (directory) => {
      let entries = [];
      try {
        entries = await this.fsp.readdir(directory, { withFileTypes: true });
      } catch (_) {
        return;
      }
      entries.sort((left, right) => left.name.localeCompare(right.name, "und"));
      for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(fullPath);
          continue;
        }
        if (!entry.isFile() || !LYRIC_EXTENSION_SET.has(path.extname(entry.name).toLowerCase())) continue;
        let stat;
        try {
          stat = await this.fsp.stat(fullPath);
        } catch (_) {
          continue;
        }
        if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) continue;
        const record = {
          path: path.resolve(fullPath),
          relativePath: path.relative(root, fullPath),
          name: entry.name,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          birthtimeMs: stat.birthtimeMs,
        };
        for (const key of buildFileLookupKeys(entry.name)) {
          const bucket = next.get(key) || [];
          bucket.push(record);
          next.set(key, bucket);
        }
      }
    };
    await visit(root);
    for (const bucket of next.values()) {
      bucket.sort((left, right) => left.relativePath.localeCompare(right.relativePath, "und"));
    }
    return next;
  }

  async readFileCandidate(record, sourceType, evidence) {
    let stat;
    try {
      stat = await this.fsp.stat(record.path);
    } catch (_) {
      return null;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES) return null;
    const signature = [
      record.path,
      stat.size,
      stat.mtimeMs,
      stat.ctimeMs,
      stat.birthtimeMs,
    ].join("|");
    let cached = this.fileCache.get(signature);
    if (!cached) {
      let buffer;
      try {
        buffer = await this.fsp.readFile(record.path);
      } catch (_) {
        return null;
      }
      let decoded;
      try {
        decoded = decodeLyricBufferDetailed(buffer);
      } catch (_) {
        return null;
      }
      const text = decoded.text.replace(/^\uFEFF/u, "");
      if (!text.trim() || text.includes("\uFFFD") || text.includes("\0")) return null;
      cached = {
        text,
        encoding: decoded.encoding,
        encodingConfidenceGap: decoded.confidenceGap,
        metadata: extractLrcMetadata(text),
        hash: contentHash(text),
      };
      this.fileCache.set(signature, cached);
      for (const key of [...this.fileCache.keys()]) {
        if (key.startsWith(`${record.path}|`) && key !== signature) this.fileCache.delete(key);
      }
    }
    const identity = classifyIdentity({ sourceType, fileName: record.name, metadata: cached.metadata, evidence });
    if (identity.identityLevel === "reject") return null;
    let channel;
    try {
      channel = parseLyricChannel(cached.text, {
        role: "main",
        language: cached.metadata.language,
        sourceId: `${sourceType}:${cached.hash}`,
        format: sourceFormat(record.path),
      });
    } catch (_) {
      return null;
    }
    if (!channel.lines.length) return null;
    const split = splitImplicitTranslationChannel(channel);
    const model = buildUnifiedLyric({
      main: split.main,
      ...(split.translation ? { translation: split.translation } : {}),
    }, { identityReason: identity.identityReason });
    return {
      candidateId: crypto.createHash("sha256").update(`${sourceType}|${record.path}|${cached.hash}`).digest("hex"),
      sourceType,
      lyricIdentity: { title: cached.metadata.title, artists: cached.metadata.artists, album: cached.metadata.album },
      sourceId: `${sourceType}:${cached.hash}`,
      sourcePath: record.path,
      relativePath: record.relativePath || path.basename(record.path),
      ...identity,
      qualityLevel: split.main.qualityLevel,
      contentHash: cached.hash,
      encoding: cached.encoding,
      manualSelection: cached.metadata.manualSelection === true,
      model,
      legacyText: exportEnhancedLrc(model, { includeTranslation: true, includeRomanization: true }),
      dependency: {
        path: record.path,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        birthtimeMs: stat.birthtimeMs,
        hash: cached.hash,
      },
    };
  }

  async externalCandidates(evidence) {
    const index = await this.ensureIndex();
    const records = new Map();
    for (const key of buildTrackLookupKeys(evidence.trackPath, evidence)) {
      for (const record of index.get(key) || []) records.set(record.path, record);
    }
    const candidates = [];
    for (const record of [...records.values()].sort((left, right) => left.relativePath.localeCompare(right.relativePath, "und"))) {
      const candidate = await this.readFileCandidate(record, "external", evidence);
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }

  async sidecarCandidates(evidence) {
    const directory = path.dirname(evidence.trackPath);
    const base = path.parse(evidence.trackPath).name;
    const candidates = [];
    for (const extension of LYRIC_EXTENSIONS) {
      const sourcePath = path.join(directory, `${base}${extension}`);
      let stat;
      try {
        stat = await this.fsp.stat(sourcePath);
      } catch (_) {
        continue;
      }
      if (!stat.isFile()) continue;
      const candidate = await this.readFileCandidate({
        path: sourcePath,
        relativePath: path.basename(sourcePath),
        name: path.basename(sourcePath),
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        birthtimeMs: stat.birthtimeMs,
      }, "sidecar", evidence);
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  }

  embeddedCandidates(evidence, embedded = []) {
    const candidates = [];
    for (const [index, raw] of (Array.isArray(embedded) ? embedded : []).entries()) {
      const text = String(raw?.text || "");
      if (!text.trim() || Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES || text.includes("\0")) continue;
      try {
        const hash = contentHash(text);
        const sourceId = `embedded:${String(raw?.id || index)}:${hash}`;
        const channel = parseLyricChannel(text, {
          role: String(raw?.role || "main"),
          language: String(raw?.language || ""),
          sourceId,
          format: String(raw?.format || "auto"),
          wordTimeMode: String(raw?.wordTimeMode || "auto"),
        });
        if (!channel.lines.length) continue;
        const split = splitImplicitTranslationChannel(channel);
        const channels = channel.role === "main"
          ? { main: split.main, ...(split.translation ? { translation: split.translation } : {}) }
          : { [channel.role]: channel };
        const model = buildUnifiedLyric(channels, { identityReason: "embedded_bound" });
        candidates.push({
          candidateId: crypto.createHash("sha256").update(sourceId).digest("hex"),
          sourceType: "embedded",
          lyricIdentity: extractLrcMetadata(text),
          sourceId,
          sourcePath: "",
          relativePath: "",
          identityLevel: "strong",
          identityScore: 100,
          identityReason: "embedded_bound",
          qualityLevel: channel.role === "main" ? split.main.qualityLevel : channel.qualityLevel,
          contentHash: hash,
          model,
          legacyText: exportEnhancedLrc(model, { includeTranslation: true, includeRomanization: true }),
          dependency: { tagId: String(raw?.id || index), hash },
        });
      } catch (_) {
        // A damaged embedded lyric must not hide other candidates.
      }
    }
    return candidates;
  }

  select(candidates) {
    const viable = (Array.isArray(candidates) ? candidates : [])
      .filter((candidate) => IDENTITY_ORDER[candidate.identityLevel] > 0)
      .sort(compareCandidatePriority);
    if (!viable.length) return { status: "missing", selected: null, alternatives: [] };
    const weak = viable.filter((candidate) => candidate.identityLevel === "weak");
    if (viable[0].identityLevel === "weak" && new Set(weak.map((candidate) => candidate.contentHash)).size !== 1) {
      return { status: "ambiguous", selected: null, alternatives: viable.map(publicCandidate) };
    }
    const top = viable[0];
    const indistinguishableExternal = top.sourceType === "external" && viable.some((candidate, index) => (
      index > 0
      && candidate.sourceType === "external"
      && top.identityLevel === candidate.identityLevel
      && Math.abs(top.identityScore - candidate.identityScore) < 1
      && Number(top.rootPriority || 0) === Number(candidate.rootPriority || 0)
      && top.qualityLevel === candidate.qualityLevel
      && top.contentHash !== candidate.contentHash
    ));
    if (indistinguishableExternal) {
      return { status: "ambiguous", selected: null, alternatives: viable.map(publicCandidate) };
    }
    return { status: "selected", selected: publicCandidate(top), alternatives: viable.slice(1).map(publicCandidate) };
  }

  async resolve({ trackPath, evidence: rawEvidence = {}, embedded = [], sources = null } = {}) {
    if (!trackPath || !path.isAbsolute(String(trackPath))) throw new LocalLyricError("local track path is required", "TRACK_INVALID");
    const evidence = normalizeEvidence(trackPath, rawEvidence);
    const enabled = new Set(Array.isArray(sources) ? sources : ["external", "sidecar", "embedded"]);
    const candidates = [];
    if (enabled.has("external")) candidates.push(...await this.externalCandidates(evidence));
    if (enabled.has("sidecar")) candidates.push(...await this.sidecarCandidates(evidence));
    if (enabled.has("embedded")) candidates.push(...this.embeddedCandidates(evidence, embedded));
    return this.select(candidates);
  }

  async resolveExternal({ evidence: rawEvidence = {} } = {}) {
    const title = String(rawEvidence?.title || "").trim();
    const artists = Array.isArray(rawEvidence?.artists)
      ? rawEvidence.artists.map(String).map((item) => item.trim()).filter(Boolean)
      : (rawEvidence?.artist ? [String(rawEvidence.artist).trim()].filter(Boolean) : []);
    if (!title) return { status: "missing", selected: null, alternatives: [] };
    const safeBase = `${artists[0] ? `${artists[0]} - ` : ""}${title}`
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .trim() || "online-track";
    const virtualTrackPath = path.resolve(`${safeBase}.online`);
    const evidence = normalizeEvidence(virtualTrackPath, {
      ...rawEvidence,
      title,
      artists,
      titleFromFileName: false,
    });
    return this.select(await this.externalCandidates(evidence));
  }
}

module.exports = {
  DEFAULT_INDEX_TTL_MS,
  ENCRYPTED_QRC_MAGIC,
  IDENTITY_ORDER,
  LYRIC_EXTENSIONS,
  LocalLyricError,
  LocalLyricSourceResolver,
  MAX_FILE_BYTES,
  SOURCE_PRIORITY,
  buildFileLookupKeys,
  buildTrackLookupKeys,
  classifyIdentity,
  cleanFileBase,
  compareCandidatePriority,
  decodeLyricBuffer,
  decodeLyricBufferDetailed,
  decodeLegacyLyricBuffer,
  extractLrcMetadata,
  legacyEncodingScore,
  normalizeLookupKey,
  scoreFilenameDirections,
  splitImplicitTranslationChannel,
  splitArtistTitle,
};
