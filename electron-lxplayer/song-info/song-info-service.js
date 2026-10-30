const fs = require("node:fs");
const path = require("node:path");

const {
  FIELD_NAMES,
  buildFieldDiff,
  isMissingText,
  normalizeText,
  rankCandidates,
} = require("./candidate-model");

const LOCAL_AUDIO_EXTENSIONS = new Set([
  ".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".wma", ".ape",
]);

function publicLocalEvidence(trackPath, info) {
  const fileName = path.basename(trackPath, path.extname(trackPath));
  const title = String(info?.title || "").trim();
  const titleFromFileName = info?.titleFromTag === false
    || (!Object.hasOwn(info || {}, "titleFromTag") && (!title || normalizeText(title) === normalizeText(fileName)));
  return {
    title: title || fileName,
    titleFromFileName,
    fileName,
    artists: info?.artists?.length ? info.artists : (isMissingText(info?.artist) ? [] : [info.artist]),
    album: info?.album || "",
    albumArtists: info?.albumArtists?.length ? info.albumArtists : (info?.albumArtist ? [info.albumArtist] : []),
    releaseDate: info?.releaseDate || "",
    trackNumber: info?.trackNumber || 0,
    trackTotal: info?.trackTotal || 0,
    discNumber: info?.discNumber || 0,
    discTotal: info?.discTotal || 0,
    genres: info?.genres || [],
    composers: info?.composers || [],
    lyricists: info?.lyricists || [],
    durationSeconds: info?.duration || 0,
    isrcs: info?.isrcs || [],
    cover: info?.cover || "",
    lyrics: info?.lyrics || "",
  };
}

function missingLocalField(evidence, field) {
  const value = evidence?.[field];
  if (field === "title") return Boolean(evidence?.titleFromFileName) || isMissingText(value);
  if (field === "cover") {
    return typeof value === "string" ? !value.trim() : !Boolean(value?.url || value?.assetId);
  }
  if (field === "lyrics") {
    if (typeof value === "string") return !value.trim();
    return !Boolean(value && (value.synced || value.plain || value.lines?.length));
  }
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "number") return !(value > 0);
  return isMissingText(value);
}

// Search edits remain discovery-only unless a single-song user action explicitly corrects identity.
function searchEvidence(evidence, payload) {
  const title = String(payload?.searchTitle || "").trim().slice(0, 240);
  const artist = String(payload?.searchArtist || "").trim().slice(0, 240);
  const clearArtist = payload?.manualIdentity === true && payload?.onlyMissing !== true
    && Object.hasOwn(payload, "searchArtist");
  return { ...evidence, ...(title ? { title } : {}),
    ...(artist ? { artists: [artist] } : clearArtist ? { artists: [] } : {}) };
}

function matchingContext(evidence, payload) {
  const query = searchEvidence(evidence, payload);
  const corrected = payload?.manualIdentity === true && payload?.onlyMissing !== true
    && (normalizeText(query.title) !== normalizeText(evidence.title)
      || normalizeText(query.artists.join(" ")) !== normalizeText(evidence.artists.join(" ")));
  return {
    query,
    evidence: corrected ? { ...query, titleFromFileName: false } : evidence,
    correction: corrected ? { title: query.title, artists: query.artists } : null,
  };
}

function requireManualCorrection(item, correction) {
  if (!correction) return item;
  return { ...item, autoEligible: false,
    recommendation: item.recommendation === "strong" ? "medium" : item.recommendation,
    identityCorrection: correction };
}

function publicCurrentEvidence(evidence) {
  return { durationSeconds: evidence.durationSeconds, ...Object.fromEntries(FIELD_NAMES.map((field) => {
    if (field === "cover" || field === "lyrics") return [field, !missingLocalField(evidence, field)];
    return [field, structuredClone(evidence?.[field] ?? null)];
  })) };
}

class SongInfoService {
  constructor({ registry, getMeta, stat = fs.promises.stat } = {}) {
    if (!registry || typeof registry.queryAll !== "function" || typeof getMeta !== "function") {
      throw new TypeError("SongInfoService requires registry and getMeta");
    }
    this.registry = registry;
    this.getMeta = getMeta;
    this.stat = stat;
    this.controllers = new Map();
  }

  async query(payload = {}) {
    const trackPath = String(payload.trackPath || "").trim();
    const extension = path.extname(trackPath).toLowerCase();
    if (!trackPath || !LOCAL_AUDIO_EXTENSIONS.has(extension)) {
      const error = new Error("请选择本地歌曲");
      error.code = "INVALID_TRACK";
      throw error;
    }
    const fileStat = await this.stat(trackPath);
    if (!fileStat?.isFile?.()) {
      const error = new Error("歌曲文件不存在");
      error.code = "TRACK_MISSING";
      throw error;
    }

    const requestId = String(payload.requestId || "single");
    this.cancel(requestId);
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    try {
      const info = await this.getMeta(trackPath);
      const evidence = publicLocalEvidence(trackPath, info || {});
      const rawRequestedFields = Array.isArray(payload.requestedFields) && payload.requestedFields.length
        ? payload.requestedFields
        : FIELD_NAMES;
      const requestedFields = [...new Set(rawRequestedFields.filter((field) => FIELD_NAMES.includes(field)))];
      const effectiveFields = payload.onlyMissing
        ? requestedFields.filter((field) => missingLocalField(evidence, field))
        : requestedFields;
      if (payload.onlyMissing && effectiveFields.length === 0) {
        return {
          ok: true,
          requestId,
          skipped: "complete",
          requestedFields: [],
          current: publicCurrentEvidence(evidence),
          candidates: [],
          sources: [],
        };
      }
      const matching = matchingContext(evidence, payload);
      const result = await this.registry.queryAll({
        evidence: matching.query,
        forceRefresh: payload.forceRefresh === true && payload.onlyMissing !== true,
        requestedFields: effectiveFields,
        locale: String(payload.locale || "zh-CN"),
        signal: controller.signal,
      });
      const ranked = rankCandidates(matching.evidence, result.candidates, {
        requestedFields: effectiveFields,
        autoThreshold: payload.autoThreshold,
        manualThreshold: payload.manualThreshold,
        minimumGap: payload.minimumGap,
      });
      return {
        ok: true,
        requestId,
        requestedFields: effectiveFields,
        current: publicCurrentEvidence(evidence),
        candidates: ranked.map((item) => ({
          ...requireManualCorrection(item, matching.correction),
          differences: buildFieldDiff(evidence, item.candidate, FIELD_NAMES),
        })),
        sources: result.sources,
      };
    } finally {
      if (this.controllers.get(requestId) === controller) this.controllers.delete(requestId);
    }
  }

  cancel(requestId = "single") {
    const key = String(requestId || "single");
    const controller = this.controllers.get(key);
    if (!controller) return false;
    controller.abort();
    this.controllers.delete(key);
    return true;
  }

  cancelAll() {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
}

module.exports = {
  LOCAL_AUDIO_EXTENSIONS,
  SongInfoService,
  matchingContext,
  requireManualCorrection,
  missingLocalField,
  publicLocalEvidence,
  publicCurrentEvidence,
  searchEvidence,
};
