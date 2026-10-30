"use strict";

const {
  artistCreditSimilarity,
  textSimilarity,
} = require("../song-info/candidate-model");
const { wordTimingQuality } = require("./word-timing-quality");
const { normalizeLyricCandidate, rankLyricCandidates } = require("./candidate-model");

const LDDC_SOURCE_ORDER = Object.freeze(["tx", "kg", "wy"]);
const SOURCE_LABELS = Object.freeze({ tx: "QQ 音乐", kg: "酷狗音乐", wy: "网易云音乐" });
const LDDC_STRATEGY_POLICY = Object.freeze({
  serviceUse: "approved",
  cache: "blocked",
  save: "approved",
  reviewedAt: "2026-08-27",
  reviewReference: "Kumiko-approved local lyric retrieval through existing Flowave online transports; no LDDC code or crypto embedded",
});

function artistsFromTrack(track) {
  return String(track?.artist || "").split(/[、,，;/]+/u).map((item) => item.trim()).filter(Boolean);
}

function coarseScore(evidence, track) {
  const title = textSimilarity(evidence?.title || "", track?.title || "", { ignoreVersion: true });
  const expectedArtists = Array.isArray(evidence?.artists) ? evidence.artists : [];
  const actualArtists = artistsFromTrack(track);
  const artists = expectedArtists.length && actualArtists.length
    ? artistCreditSimilarity(expectedArtists, actualArtists)
    : 0;
  const expectedDuration = Math.max(0, Number(evidence?.durationSeconds) || 0);
  const actualDuration = Math.max(0, Number(track?.duration) || 0);
  const durationDifference = expectedDuration && actualDuration ? Math.abs(expectedDuration - actualDuration) : null;
  if (title < 0.7 || (expectedArtists.length && actualArtists.length && artists < 0.5)) return -1;
  if (durationDifference !== null && durationDifference > 4) return -1;
  return title * 60 + artists * 30 + (durationDifference === null ? 0 : Math.max(0, 10 - durationDifference * 2.5));
}

function candidateFromTrack(track, lyricsModel, sourceIndex, rank) {
  if (!lyricsModel || !Array.isArray(lyricsModel.lines) || !lyricsModel.lines.length) return null;
  return {
    sourceRecordId: `${track.source}:${track.songId}`,
    sourceLabel: SOURCE_LABELS[track.source] || track.source,
    trackName: String(track.title || ""),
    artists: artistsFromTrack(track),
    albumName: String(track.album || ""),
    durationSeconds: Math.max(0, Number(track.duration) || 0),
    unifiedLyrics: structuredClone(lyricsModel),
    providerPriority: 100,
    sourcePreference: Math.max(0, 100 - sourceIndex * 10 - rank),
  };
}

function createLddcStrategyLyricProvider({ searchMusic, getLyric } = {}) {
  if (typeof searchMusic !== "function" || typeof getLyric !== "function") {
    throw new TypeError("LDDC strategy provider requires searchMusic and getLyric");
  }
  return {
    id: "lddc-strategy",
    version: "3",
    label: "多来源歌词",
    minIntervalMs: 200,
    timeoutMs: 30000,
    maxAttempts: 1,
    allowStructuredLyrics: true,
    policy: LDDC_STRATEGY_POLICY,
    async query({ evidence, signal } = {}) {
      const combinedKeyword = [...(Array.isArray(evidence?.artists) ? evidence.artists.slice(0, 1) : []), evidence?.title]
        .map((item) => String(item || "").trim()).filter(Boolean).join(" ");
      const titleKeyword = String(evidence?.title || "").trim();
      if (!titleKeyword) return [];
      const searches = await Promise.allSettled(LDDC_SOURCE_ORDER.map(async (source) => {
        if (signal?.aborted) return [];
        let result = await searchMusic(source, combinedKeyword || titleKeyword, 1, 10, { signal });
        let ranked = (Array.isArray(result?.list) ? result.list : [])
          .map((track) => ({ track, score: coarseScore(evidence, track) }))
          .filter((item) => item.score >= 0)
          .sort((left, right) => right.score - left.score);
        if (!ranked.length && combinedKeyword && combinedKeyword !== titleKeyword) {
          result = await searchMusic(source, titleKeyword, 1, 10, { signal });
          ranked = (Array.isArray(result?.list) ? result.list : [])
            .map((track) => ({ track, score: coarseScore(evidence, track) }))
            .filter((item) => item.score >= 0)
            .sort((left, right) => right.score - left.score);
        }
        return ranked.slice(0, 3);
      }));
      if (signal?.aborted) return [];
      if (searches.every(result => result.status === "rejected")) throw searches[0].reason;
      const candidates = [];
      let lyricAttempts = 0, lyricFailures = 0, lastFailure;
      await Promise.all(searches.map(async (search, sourceIndex) => {
        const ranked = search.status === "fulfilled" ? search.value : [];
        for (let rank = 0; rank < ranked.length; rank += 1) {
          if (signal?.aborted) return;
          try {
            const track = ranked[rank].track;
            lyricAttempts += 1;
            const result = await getLyric(track.source, track.songId, track, { signal });
            if (signal?.aborted) return;
            const candidate = candidateFromTrack(track, result?.lyricsModel, sourceIndex, rank);
            if (candidate) {
              candidates.push(candidate);
              const match = rankLyricCandidates(evidence, [normalizeLyricCandidate(candidate,
                { id: "lddc-strategy", allowStructuredLyrics: true })])[0];
              if (match?.recommendation !== "none" && wordTimingQuality(result.lyricsModel).complete) break;
            }
          } catch (error) { lyricFailures += 1; lastFailure = error; }
        }
      }));
      if (!candidates.length && lyricAttempts > 0 && lyricFailures === lyricAttempts) throw lastFailure;
      return candidates.sort((left, right) => right.sourcePreference - left.sourcePreference);
    },
  };
}

module.exports = {
  LDDC_SOURCE_ORDER,
  LDDC_STRATEGY_POLICY,
  candidateFromTrack,
  coarseScore,
  createLddcStrategyLyricProvider,
};
