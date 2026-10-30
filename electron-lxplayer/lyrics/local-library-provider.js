"use strict";

const LOCAL_LIBRARY_POLICY = Object.freeze({
  serviceUse: "approved",
  cache: "blocked",
  save: "approved",
  reviewedAt: "2026-08-11",
  reviewReference: "Flowave local-file-only lyric source contract",
});

function aborted() {
  const error = new Error("local lyric query aborted");
  error.name = "AbortError";
  error.code = "ABORTED";
  return error;
}

function candidateFromLocal(item, evidence) {
  if (!item?.candidateId || !item?.model || !["strong", "medium", "weak"].includes(item.identityLevel)) {
    return null;
  }
  const sourceLabels = {
    external: "KTV 歌词",
    sidecar: "同目录歌词",
    embedded: "内嵌歌词",
  };
  return {
    sourceRecordId: String(item.candidateId),
    sourceType: String(item.sourceType || ""),
    sourceLabel: sourceLabels[item.sourceType] || "本地歌词",
    trackName: String(item.lyricIdentity?.title || evidence?.title || ""),
    hasOwnTitle: Boolean(item.lyricIdentity?.title),
    artists: item.lyricIdentity?.artists?.length ? item.lyricIdentity.artists.map(String) : (Array.isArray(evidence?.artists) ? evidence.artists.map(String) : []),
    albumName: String(item.lyricIdentity?.album || evidence?.album || ""),
    durationSeconds: item.sourceType === "embedded"
      ? Math.max(0, Number(evidence?.durationSeconds) || 0)
      : 0,
    unifiedLyrics: structuredClone(item.model),
    identityLevel: item.identityLevel,
    identityScore: Math.max(0, Math.min(100, Number(item.identityScore) || 0)),
    qualityLevel: String(item.qualityLevel || ""),
  };
}

function createLocalLibraryLyricProvider({ resolve } = {}) {
  if (typeof resolve !== "function") throw new TypeError("local lyric provider requires resolve");
  return {
    id: "local-library",
    version: "1",
    label: "本地歌词",
    localOnly: true,
    minIntervalMs: 0,
    timeoutMs: 15000,
    maxAttempts: 1,
    policy: LOCAL_LIBRARY_POLICY,
    async query({ evidence, localContext, signal } = {}) {
      if (signal?.aborted) throw aborted();
      const trackPath = String(localContext?.trackPath || "");
      if (!trackPath) return [];
      const originalEvidence = localContext?.originalEvidence || evidence;
      const result = await resolve({
        trackPath,
        evidence,
        sources: Array.isArray(localContext?.sources) ? localContext.sources : ["external", "embedded"],
      });
      if (signal?.aborted) throw aborted();
      const values = result?.status === "selected"
        ? [result.selected, ...(Array.isArray(result.alternatives) ? result.alternatives : [])]
        : (Array.isArray(result?.alternatives) ? result.alternatives : []);
      const seen = new Set();
      return values
        .map((item) => candidateFromLocal(item, originalEvidence))
        .filter((item) => {
          if (!item || seen.has(item.sourceRecordId)) return false;
          seen.add(item.sourceRecordId);
          return true;
        });
    },
  };
}

module.exports = {
  LOCAL_LIBRARY_POLICY,
  candidateFromLocal,
  createLocalLibraryLyricProvider,
};
