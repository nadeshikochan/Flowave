"use strict";

const fs = require("node:fs");
const path = require("node:path");

const {
  LOCAL_AUDIO_EXTENSIONS, missingLocalField, publicLocalEvidence, matchingContext,
  completionMatchingContext, describeCompletionIdentity, rankCompletionCandidates,
} = require("../song-info/song-info-service");
const { compareLyricCredits, inspectLyricQuality, lyricTimingFitsDuration, meetsLyricTarget, rankLyricCandidates } = require("./candidate-model");
const { extractVersionTerms, textSimilarity } = require("../song-info/candidate-model");
const { buildUnifiedLyric, parseLyricChannel } = require("./unified-lyric");
const { decodeLyricBufferDetailed, extractLrcMetadata, splitImplicitTranslationChannel } = require("./local-source-resolver");
const { wordTimingQuality } = require("./word-timing-quality");

function checkExistingLyric(body, evidence, target) {
  if (!body?.length) return null;
  let text, model;
  try {
    text = decodeLyricBufferDetailed(body).text;
    const { main, translation } = splitImplicitTranslationChannel(parseLyricChannel(text, { role: "main", format: "lrc" }));
    model = buildUnifiedLyric({ main, ...(translation ? { translation } : {}) });
  } catch (_) {
    return { skipped: "local-review", localReviewReason: "unreadable" };
  }
  if (!inspectLyricQuality({ unifiedLyrics: model }).available
    || !meetsLyricTarget({ lyricsModel: model, timingQuality: wordTimingQuality(model) }, target)) return null;
  const tags = extractLrcMetadata(text);
  const existingVersions = extractVersionTerms(tags.title);
  const trackVersions = new Set(extractVersionTerms([evidence.title, evidence.fileName].join(" ")));
  const titleConflict = tags.title && textSimilarity(tags.title, evidence.title, { ignoreVersion: true }) < 0.7;
  const artistConflict = tags.artists.length && evidence.artists.length
    && compareLyricCredits(tags.artists, evidence.artists).similarity < 0.6;
  const versionConflict = existingVersions.some(version => !trackVersions.has(version))
    || (tags.title && trackVersions.has("instrumental") !== existingVersions.includes("instrumental"));
  let localReviewReason = "";
  if (!evidence.durationSeconds) localReviewReason = "missing-duration";
  else if (!lyricTimingFitsDuration(model, evidence.durationSeconds)) localReviewReason = "timing";
  else if (versionConflict) localReviewReason = "version";
  else if (titleConflict) localReviewReason = "title";
  else if (artistConflict) localReviewReason = "artists";
  return localReviewReason ? { skipped: "local-review", localReviewReason } : { skipped: "complete" };
}

function publicCandidate(item) {
  const source = item?.candidate || {};
  const lyrics = item?.lyricsModel
    ? structuredClone(item.lyricsModel)
    : (item?.parsed ? buildUnifiedLyric({ main: item.parsed }) : null);
  if (!lyrics) return null;
  return {
    candidate: {
      candidateId: String(source.candidateId || ""),
      provider: String(source.provider || ""),
      providerVersion: String(source.providerVersion || ""),
      sourceLabel: String(source.sourceLabel || source.provider || ""),
      title: String(source.trackName || ""),
      artists: Array.isArray(source.artists) ? source.artists.map(String) : [],
      album: String(source.album || ""),
      durationSeconds: Math.max(0, Number(source.durationSeconds) || 0),
      versionTerms: Array.isArray(source.versionTerms) ? source.versionTerms.map(String) : [],
      lyrics,
      provenance: source.provenance && typeof source.provenance === "object"
        ? structuredClone(source.provenance)
        : {},
    },
    score: Math.max(0, Number(item.identityScore) || 0),
    recommendation: ["strong", "medium"].includes(item.recommendation) ? item.recommendation : "none",
    autoEligible: item.recommendation === "strong",
    timing: { lines: item.timingQuality.lines, timedLines: item.timingQuality.timedLines, complete: item.timingQuality.complete },
    reasons: (Array.isArray(item.reasons) ? item.reasons : []).map(String).slice(0, 3),
    blockers: (Array.isArray(item.blockers) ? item.blockers : []).map((blocker) => ({
      code: String(blocker?.code || "lyric-conflict"),
      message: String(blocker?.message || "歌词不匹配"),
    })),
    missingFields: [],
    evidence: structuredClone(item.evidence || {}),
    differences: [{
      field: "lyrics",
      current: null,
      proposed: lyrics,
      missing: true,
      available: true,
      changed: true,
    }],
  };
}

class LyricLookupService {
  constructor({ registry, getMeta, inspectSidecar = null, stat = fs.promises.stat } = {}) {
    if (!registry || typeof registry.queryAll !== "function" || typeof getMeta !== "function") {
      throw new TypeError("LyricLookupService requires registry and getMeta");
    }
    this.registry = registry;
    this.getMeta = getMeta;
    this.inspectSidecar = typeof inspectSidecar === "function" ? inspectSidecar : null;
    this.stat = stat;
    this.controllers = new Map();
  }

  async query(payload = {}) {
    const trackPath = String(payload.trackPath || "").trim();
    if (!trackPath || !LOCAL_AUDIO_EXTENSIONS.has(path.extname(trackPath).toLowerCase())) {
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
    const requestId = String(payload.requestId || "single-lyrics");
    this.cancel(requestId);
    const controller = new AbortController();
    this.controllers.set(requestId, controller);
    try {
      const completion = ["line", "word"].includes(payload.lyricCompleteness);
      const info = await this.getMeta(trackPath, { includeLyrics: !completion });
      const evidence = publicLocalEvidence(trackPath, info || {});
      const matching = completion
        ? completionMatchingContext(evidence, payload.matchIdentity, (first, second) => compareLyricCredits(first, second).similarity)
        : matchingContext(evidence, payload);
      let replacingExisting = false;
      let targetVersion;
      if (completion && payload.storageTarget === "sidecar" && this.inspectSidecar) {
        const inspected = await this.inspectSidecar(trackPath, { includeBody: true });
        targetVersion = inspected?.version?.sha256 || "";
        replacingExisting = Boolean(inspected?.version?.exists);
        const existing = checkExistingLyric(inspected?.body, evidence, payload.lyricCompleteness);
        if (existing) return { ok: true, requestId, ...existing, candidates: [], sources: [] };
      }
      if (!completion && payload.storageTarget === "sidecar" && this.inspectSidecar) {
        const inspected = await this.inspectSidecar(trackPath);
        if (inspected?.version?.exists) {
          if (!completion && payload.onlyMissing !== false) {
            return { ok: true, requestId, skipped: "complete", candidates: [], sources: [] };
          }
          replacingExisting = true;
        }
      } else if (!completion && payload.onlyMissing !== false && !missingLocalField(evidence, "lyrics")) {
          return { ok: true, requestId, skipped: "complete", candidates: [], sources: [] };
      }
      const selectedSources = Array.isArray(payload.lyricSources) ? payload.lyricSources.map(String) : null;
      const useLddc = !selectedSources || selectedSources.includes("lddc");
      const useLocalFallback = !selectedSources || selectedSources.some((source) => ["external", "embedded"].includes(source));
      const localContext = {
          trackPath,
          ...(matching.correction ? { originalEvidence: evidence } : {}),
          sources: payload.storageTarget === "sidecar"
            ? (selectedSources || ["lddc", "external", "embedded"])
            : null,
      };
      const queryProviders = (providerIds, context = localContext, queryEvidence = matching.query) => this.registry.queryAll({
        evidence: queryEvidence,
        locale: String(payload.locale || "zh-CN"),
        signal: controller.signal,
        providerIds,
        localContext: context,
      });
      const rankOptions = {
        autoThreshold: payload.autoThreshold,
        manualThreshold: payload.manualThreshold,
        minimumGap: payload.minimumGap,
        lyricCompleteness: payload.lyricCompleteness,
        includeTranslation: payload.includeTranslation,
        includeRomanization: payload.includeRomanization,
      };
      const rank = candidates => rankCompletionCandidates(matching, candidates, rankOptions, rankLyricCandidates);
      const meetsGoal = item => meetsLyricTarget(item, payload.lyricCompleteness);
      let result = { candidates: [], sources: [] };
      if (completion) {
        // Presence is checked across all supported local locations even if the
        // user limits which providers may search for missing lyrics.
        const local = await queryProviders(["local-library"], {
          trackPath, sources: ["external", "sidecar", "embedded"],
        }, evidence);
        if (controller.signal.aborted) {
          const error = new Error("lyric lookup aborted"); error.code = "ABORTED"; throw error;
        }
        if (local.sources.some(source => !["ok", "empty"].includes(source.status))) {
          return { ok: false, code: "LOCAL_LYRICS_UNAVAILABLE", requestId, candidates: [], sources: local.sources };
        }
        const localRanked = rankLyricCandidates(evidence, local.candidates, rankOptions);
        if (localRanked.some(item => item.candidate.trustedIdentityLevel === "strong"
          && (!item.blockers.length || item.candidate.sourceType === "embedded" || item.candidate.sourceType === "sidecar")
          && meetsGoal(item))) {
          return { ok: true, requestId, skipped: "complete", candidates: [], sources: [] };
        }
        if (!useLddc) result.sources = local.sources;
      }
      const hasCompleteWords = () => rank(result.candidates)
        .some(item => item.recommendation !== "none" && (completion ? meetsGoal(item) : item.timingQuality.complete));
      if (!controller.signal.aborted && useLddc) {
        const online = await queryProviders(["lddc-strategy"]);
        result = { candidates: online.candidates, sources: [...result.sources, ...online.sources] };
      }
      if (!controller.signal.aborted && useLddc && !hasCompleteWords()) {
        const fallback = await queryProviders(["music-tag-strategy"]);
        result = {
          candidates: [...result.candidates, ...fallback.candidates],
          sources: [...result.sources, ...fallback.sources],
        };
      }
      if (!completion && !controller.signal.aborted && !hasCompleteWords() && useLocalFallback) {
        const fallback = await queryProviders(["local-library"]);
        result = {
          candidates: [...result.candidates, ...fallback.candidates],
          sources: [...result.sources, ...fallback.sources],
        };
      }
      if (controller.signal.aborted) {
        const error = new Error("lyric lookup aborted"); error.code = "ABORTED"; throw error;
      }
      result.candidates = [...new Map(result.candidates.map(item => [item.candidateId, item])).values()];
      const ranked = rank(result.candidates).filter(item => !completion || meetsGoal(item)).map(item => {
        // Exporting lyrics already bound to this exact audio is a manual action.
        // Missing lyric title must not turn the audio's known-wrong title into a hard veto.
        const boundWithoutTitle = matching.correction && item.candidate.sourceType === "embedded"
          && item.candidate.trustedIdentityLevel === "strong" && !item.candidate.hasOwnTitle
          && item.blockers.length > 0 && item.blockers.every(blocker => blocker.code === "title-conflict");
        if (!boundWithoutTitle) return item;
        return { ...item, recommendation: "medium", reasons: ["来自当前音频"],
          blockers: [{ code: "embedded-title-missing", message: "内嵌歌词未标歌名，请核对预览" }] };
      });
      const candidates = ranked.map(publicCandidate).filter(Boolean).map(item => describeCompletionIdentity(item, matching)).map((candidate) => {
        if (!replacingExisting) return candidate;
        return {
          ...candidate,
          recommendation: candidate.recommendation === "strong" ? "medium" : candidate.recommendation,
          autoEligible: false,
          blockers: [
            ...(Array.isArray(candidate.blockers) ? candidate.blockers : []),
            { code: "replace-existing", message: "将替换已有歌词" },
          ],
          differences: candidate.differences.map((difference) => ({
            ...difference,
            current: true,
            missing: false,
          })),
        };
      });
      let matchOutcome;
      if (completion && !candidates.some(candidate => candidate.recommendation !== "none")) {
        const incompleteSource = result.sources.some(source => !["ok", "empty"].includes(source.status));
        const badTiming = candidates.length
          && candidates.every(candidate => candidate.blockers.some(blocker => blocker.code === "timing-outside-audio"));
        if (candidates.length && !badTiming) matchOutcome = "identity-rejected";
        else if (incompleteSource) matchOutcome = "source-incomplete";
        else if (result.candidates.length) matchOutcome = "timing-insufficient";
        else matchOutcome = "source-empty";
      }
      return {
        ok: true,
        requestId,
        replacingExisting,
        targetVersion,
        matchOutcome,
        requestedFields: ["lyrics"],
        current: {
          title: evidence.title,
          artists: evidence.artists,
          album: evidence.album,
          durationSeconds: evidence.durationSeconds,
        },
        candidates,
        sources: Array.isArray(result.sources) ? result.sources : [],
      };
    } finally {
      if (this.controllers.get(requestId) === controller) this.controllers.delete(requestId);
    }
  }

  cancel(requestId = "single-lyrics") {
    const key = String(requestId || "single-lyrics");
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
  LyricLookupService,
  checkExistingLyric,
  publicCandidate,
};
