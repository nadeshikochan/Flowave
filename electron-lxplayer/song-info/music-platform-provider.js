const { artistCreditSimilarity, textSimilarity } = require("./candidate-model");

const PLATFORM_DEFINITIONS = Object.freeze({
  wy: Object.freeze({ id: "netease-catalog", label: "网易云音乐" }),
  tx: Object.freeze({ id: "qqmusic-catalog", label: "QQ 音乐" }),
  kg: Object.freeze({ id: "kugou-catalog", label: "酷狗音乐" }),
  kw: Object.freeze({ id: "kuwo-catalog", label: "酷我音乐" }),
});

function artistNames(value) {
  const name = String(value || "").trim();
  return name ? [name] : [];
}

function normalizePlatformTrack(track, source) {
  const recordingId = String(track?.songId || "").trim();
  const title = String(track?.title || track?.name || "").trim();
  if (!recordingId || !title) return null;
  const artists = artistNames(track?.artist);
  const album = String(track?.album || "").trim();
  const durationSeconds = Math.max(0, Number(track?.duration) || 0);
  const provenance = {};
  for (const field of ["title", "artists", "album", "durationSeconds"]) {
    const available = field === "artists"
      ? artists.length > 0
      : (field === "durationSeconds" ? durationSeconds > 0 : Boolean(field === "album" ? album : title));
    if (available) provenance[field] = { provider: PLATFORM_DEFINITIONS[source]?.id || source, recordingId };
  }
  return { recordingId, title, artists, album, durationSeconds, provenance };
}

function hasUsablePlatformResult(evidence, tracks) {
  const artist = String(evidence?.artists?.[0] || "").trim();
  return (Array.isArray(tracks) ? tracks : []).some((track) => {
    if (textSimilarity(evidence?.title, track?.title || track?.name, { ignoreVersion: true }) < 0.55) return false;
    if (!artist) return true;
    return artistCreditSimilarity([artist], artistNames(track?.artist)) >= 0.5;
  });
}

function createMusicPlatformProvider({ source, searchMusic } = {}) {
  const definition = PLATFORM_DEFINITIONS[String(source || "")];
  if (!definition || typeof searchMusic !== "function") {
    throw new TypeError("music platform provider requires a supported source and search function");
  }
  return {
    id: definition.id,
    version: "catalog-search-v1",
    label: definition.label,
    supportedFields: ["title", "artists", "album"],
    timeoutMs: 18000,
    maxAttempts: 2,
    retryBaseMs: 600,
    minIntervalMs: 250,
    async query({ evidence, signal }) {
      const title = String(evidence?.title || "").trim();
      const artist = String(evidence?.artists?.[0] || "").trim();
      const combined = [title, artist].filter(Boolean).join(" ").trim();
      if (!combined) return [];
      const search = async (term) => {
        const result = await searchMusic(source, term, 1, 25, { signal });
        return Array.isArray(result?.list) ? result.list : [];
      };
      let tracks = await search(combined);
      if (title && title !== combined && !hasUsablePlatformResult(evidence, tracks)) {
        tracks = [...tracks, ...await search(title)];
      }
      const seen = new Set();
      return tracks
        .map((track) => normalizePlatformTrack(track, source))
        .filter((track) => {
          const key = track ? track.recordingId : "";
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    },
  };
}

module.exports = {
  PLATFORM_DEFINITIONS,
  createMusicPlatformProvider,
  hasUsablePlatformResult,
  normalizePlatformTrack,
};
