"use strict";

const { coarseScore } = require("./lddc-strategy-provider");
const { wordTimingQuality } = require("./word-timing-quality");
const { lyricPerformerCredits, splitLyricCredits } = require("./candidate-model");

const MUSIC_TAG_FALLBACK_SOURCES = Object.freeze(["kw"]);
const MUSIC_TAG_STRATEGY_POLICY = Object.freeze({
  serviceUse: "approved",
  cache: "blocked",
  save: "approved",
  reviewedAt: "2026-08-27",
  reviewReference: "Kumiko-approved MusicTag-style fallback through existing Flowave transports; no MusicTag code embedded",
});

function artistsFromTrack(track) {
  return splitLyricCredits(track?.artist);
}

function createMusicTagStrategyLyricProvider({ searchMusic, getLyric } = {}) {
  if (typeof searchMusic !== "function" || typeof getLyric !== "function") {
    throw new TypeError("MusicTag strategy provider requires searchMusic and getLyric");
  }
  return {
    id: "music-tag-strategy",
    version: "1",
    label: "MusicTag 补充匹配",
    minIntervalMs: 200,
    timeoutMs: 30000,
    maxAttempts: 1,
    allowStructuredLyrics: true,
    policy: MUSIC_TAG_STRATEGY_POLICY,
    async query({ evidence, signal } = {}) {
      const titleKeyword = String(evidence?.title || "").trim();
      if (!titleKeyword) return [];
      const artist = lyricPerformerCredits(evidence?.artists)[0] || "";
      const combinedKeyword = [artist, titleKeyword].filter(Boolean).join(" ");
      const candidates = [];
      for (const source of MUSIC_TAG_FALLBACK_SOURCES) {
        if (signal?.aborted) break;
        let result = await searchMusic(source, combinedKeyword || titleKeyword, 1, 10, { signal });
        let ranked = (Array.isArray(result?.list) ? result.list : [])
          .map((track) => ({ track, score: coarseScore(evidence, track) }))
          .filter((item) => item.score >= 0)
          .sort((left, right) => right.score - left.score);
        if (!ranked.length && combinedKeyword !== titleKeyword) {
          result = await searchMusic(source, titleKeyword, 1, 10, { signal });
          ranked = (Array.isArray(result?.list) ? result.list : [])
            .map((track) => ({ track, score: coarseScore(evidence, track) }))
            .filter((item) => item.score >= 0)
            .sort((left, right) => right.score - left.score);
        }
        for (const { track } of ranked.slice(0, 2)) {
          if (signal?.aborted) break;
          try {
            const lyricResult = await getLyric(track.source, track.songId, track, { signal });
            const lyricsModel = lyricResult?.lyricsModel;
            if (!lyricsModel || !Array.isArray(lyricsModel.lines) || !lyricsModel.lines.length) continue;
            candidates.push({
              sourceRecordId: `${track.source}:${track.songId}`,
              sourceLabel: "酷我音乐",
              trackName: String(track.title || ""),
              artists: artistsFromTrack(track),
              albumName: String(track.album || ""),
              durationSeconds: Math.max(0, Number(track.duration) || 0),
              unifiedLyrics: structuredClone(lyricsModel),
              providerPriority: 50,
              sourcePreference: 50,
            });
            if (wordTimingQuality(lyricsModel).complete) break;
          } catch (_) {}
        }
      }
      return candidates;
    },
  };
}

module.exports = {
  MUSIC_TAG_FALLBACK_SOURCES,
  MUSIC_TAG_STRATEGY_POLICY,
  createMusicTagStrategyLyricProvider,
};
