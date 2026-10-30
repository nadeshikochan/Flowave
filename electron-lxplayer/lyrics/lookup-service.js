"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { LOCAL_AUDIO_EXTENSIONS, missingLocalField, publicLocalEvidence, matchingContext, requireManualCorrection } = require("../song-info/song-info-service");
const { rankLyricCandidates } = require("./candidate-model");
const { buildUnifiedLyric } = require("./unified-lyric");

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
      const info = await this.getMeta(trackPath);
      const evidence = publicLocalEvidence(trackPath, info || {});
      const matching = matchingContext(evidence, payload);
      let replacingExisting = false;
      if (payload.storageTarget === "sidecar" && this.inspectSidecar) {
        const inspected = await this.inspectSidecar(trackPath);
        if (inspected?.version?.exists) {
          if (payload.onlyMissing !== false) {
            return { ok: true, requestId, skipped: "complete", candidates: [], sources: [] };
          }
          replacingExisting = true;
        }
      } else if (payload.onlyMissing !== false && !missingLocalField(evidence, "lyrics")) {
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
      const queryProviders = (providerIds) => this.registry.queryAll({
        evidence: matching.query,
        locale: String(payload.locale || "zh-CN"),
        signal: controller.signal,
        providerIds,
        localContext,
      });
      let result = useLddc
        ? await queryProviders(["lddc-strategy"])
        : { candidates: [], sources: [] };
      const rankOptions = {
        autoThreshold: payload.autoThreshold,
        manualThreshold: payload.manualThreshold,
        minimumGap: payload.minimumGap,
      };
      const hasCompleteWords = () => rankLyricCandidates(matching.evidence, result.candidates, rankOptions)
        .some(item => item.recommendation !== "none" && item.timingQuality.complete);
      if (!controller.signal.aborted && useLddc && !hasCompleteWords()) {
        const fallback = await queryProviders(["music-tag-strategy"]);
        result = {
          candidates: [...result.candidates, ...fallback.candidates],
          sources: [...result.sources, ...fallback.sources],
        };
      }
      if (!controller.signal.aborted && !hasCompleteWords() && useLocalFallback) {
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
      const ranked = rankLyricCandidates(matching.evidence, result.candidates, rankOptions).map(item => {
        // Exporting lyrics already bound to this exact audio is a manual action.
        // Missing lyric title must not turn the audio's known-wrong title into a hard veto.
        const boundWithoutTitle = matching.correction && item.candidate.sourceType === "embedded"
          && item.candidate.trustedIdentityLevel === "strong" && !item.candidate.hasOwnTitle
          && item.blockers.length > 0 && item.blockers.every(blocker => blocker.code === "title-conflict");
        if (!boundWithoutTitle) return item;
        return { ...item, recommendation: "medium", reasons: ["来自当前音频"],
          blockers: [{ code: "embedded-title-missing", message: "内嵌歌词未标歌名，请核对预览" }] };
      });
      const candidates = ranked.map(publicCandidate).filter(Boolean).map(item => requireManualCorrection(item, matching.correction)).map((candidate) => {
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
      return {
        ok: true,
        requestId,
        replacingExisting,
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
  publicCandidate,
};
