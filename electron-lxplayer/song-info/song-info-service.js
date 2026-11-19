const fs = require("node:fs");
const path = require("node:path");

const {
  FIELD_NAMES,
  buildFieldDiff,
  isMissingText,
  normalizeText,
  rankCandidates,
  textSimilarity,
  artistCreditSimilarity,
} = require("./candidate-model");
const { localMediaUrlToPath } = require("../secure-protocols");

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
    artists: info?.artists?.length ? info.artists.filter(artist => !isMissingText(artist)) : (isMissingText(info?.artist) ? [] : [info.artist]),
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
  if (Array.isArray(value)) return !value.some(item => !isMissingText(item));
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

function completionMatchingContext(evidence, mode, compareArtists = artistCreditSimilarity) {
  const original = { query: evidence, evidence, alternatives: [], correction: null };
  if (mode === "tags") return original;
  const base = evidence.fileName.normalize("NFKC")
    .replace(/^\d{1,3}(?:[._-]\d{1,3})?[._ -]+(?=\p{L})/u, "")
    .replace(/\s*\(\s*\d{5,}\s*\)\s*$/u, "").trim();
  const useful = text => /\p{L}/u.test(text) && !isMissingText(text)
    && !/^(?:(?:track|audio|unknown|untitled|录音|音轨|未知)\s*[-_. ]*\d*|[0-9a-f]{16,})$/iu.test(text);
  if (!useful(base)) return original;
  const [first, ...rest] = base.split(/\s+[–—-]\s+/u);
  const second = rest.join(" - ");
  const pair = useful(first) && useful(second);
  const choices = pair ? [
    { title: second, artists: [first] },
    { title: first, artists: [second] },
  ] : [{ title: base, artists: [] }];
  const agrees = choice => !evidence.titleFromFileName
    && textSimilarity(choice.title, evidence.title, { ignoreVersion: true }) >= 0.92
    && (!choice.artists.length || !evidence.artists.length || compareArtists(choice.artists, evidence.artists) >= 0.9);
  const corroborated = choices.find(agrees);
  if (mode !== "filename" && ((corroborated && (!pair || evidence.artists.length))
    || (!pair && !evidence.titleFromFileName && !isMissingText(evidence.title)))) {
    return original;
  }
  const hypotheses = (corroborated ? [corroborated, ...choices.filter(choice => choice !== corroborated)] : choices)
    .map(choice => ({ ...choice, fileName: base, titleFromFileName: true, durationSeconds: evidence.durationSeconds }));
  const [identity, ...alternatives] = hypotheses;
  return { query: { ...identity, alternatives }, evidence: identity, alternatives,
    correction: { title: identity.title, artists: identity.artists, fromFileName: true } };
}

function hasIdentityConflict(item) {
  return item.blockers.some(blocker =>
    ["title-conflict", "artist-conflict", "version-conflict", "duration-conflict"].includes(blocker.code));
}

function rankCompletionCandidates(matching, candidates, options, rank) {
  const ranked = rank(matching.evidence, candidates, options);
  if (!matching.alternatives?.length) return ranked;
  const scores = { strong: 2, medium: 1, none: 0 };
  const compare = (left, right) => Number(hasIdentityConflict(left)) - Number(hasIdentityConflict(right))
    || scores[right.recommendation] - scores[left.recommendation]
    || (right.identityScore ?? right.score) - (left.identityScore ?? left.score);
  const alternate = matching.alternatives.flatMap(evidence => rank(evidence, candidates, options));
  const seen = new Set();
  return [...ranked, ...alternate].sort(compare).filter(item => {
    const key = item.candidate.candidateId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function describeCompletionIdentity(item, matching) {
  if (!matching.correction?.fromFileName) return requireManualCorrection(item, matching.correction);
  return {
    ...requireManualCorrection(item, { title: item.candidate.title, artists: item.candidate.artists, fromFileName: true }),
    ...(hasIdentityConflict(item) ? { recommendation: "none" } : {}),
    blockers: [...item.blockers, { code: "filename-review", message: "按文件名匹配，请核对歌曲及版本" }],
  };
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
      const rawRequestedFields = Array.isArray(payload.requestedFields) && payload.requestedFields.length
        ? payload.requestedFields
        : FIELD_NAMES;
      const requestedFields = [...new Set(rawRequestedFields.filter((field) => FIELD_NAMES.includes(field)))];
      const info = await this.getMeta(trackPath, {
        includeLyrics: !payload.onlyMissing || requestedFields.includes("lyrics"),
      });
      const evidence = publicLocalEvidence(trackPath, info || {});
      if (payload.onlyMissing && requestedFields.includes("cover") && typeof evidence.cover === "string") {
        const coverPath = localMediaUrlToPath(evidence.cover) || (path.isAbsolute(evidence.cover) ? evidence.cover : "");
        if (coverPath) {
          try {
            const cover = await this.stat(coverPath);
            if (!cover.isFile() || cover.size === 0) evidence.cover = "";
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            evidence.cover = "";
          }
        }
      }
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
      const matching = payload.onlyMissing
        ? completionMatchingContext(evidence, payload.matchIdentity)
        : matchingContext(evidence, payload);
      const result = await this.registry.queryAll({
        evidence: matching.query,
        forceRefresh: payload.forceRefresh === true && payload.onlyMissing !== true,
        requestedFields: effectiveFields,
        locale: String(payload.locale || "zh-CN"),
        signal: controller.signal,
      });
      const ranked = rankCompletionCandidates(matching, result.candidates, {
        requestedFields: effectiveFields,
        autoThreshold: payload.autoThreshold,
        manualThreshold: payload.manualThreshold,
        minimumGap: payload.minimumGap,
      }, rankCandidates);
      const candidates = ranked.filter(item => !payload.onlyMissing || item.missingFields.length < effectiveFields.length).map((item) => ({
        ...describeCompletionIdentity(item, matching),
        differences: buildFieldDiff(evidence, item.candidate, payload.onlyMissing ? effectiveFields : FIELD_NAMES)
          .map(difference => payload.onlyMissing ? { ...difference, missing: true } : difference),
      }));
      if (matching.correction?.fromFileName) candidates.sort((left, right) =>
        Number(right.recommendation !== "none") - Number(left.recommendation !== "none"));
      return {
        ok: true,
        requestId,
        requestedFields: effectiveFields,
        current: publicCurrentEvidence(evidence),
        candidates,
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
  completionMatchingContext,
  describeCompletionIdentity,
  rankCompletionCandidates,
  requireManualCorrection,
  missingLocalField,
  publicLocalEvidence,
  publicCurrentEvidence,
  searchEvidence,
};
