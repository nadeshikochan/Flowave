const axios = require("axios");
const { artistCreditSimilarity, textSimilarity } = require("./candidate-model");

const MUSICBRAINZ_ENDPOINT = "https://musicbrainz.org/ws/2/recording/";

function escapeLucene(value) {
  return String(value || "")
    .normalize("NFKC")
    .trim()
    .replace(/([+\-&|!(){}\[\]^"~*?:\\/])/g, "\\$1");
}

function buildRecordingQuery(evidence, { includeArtist = true } = {}) {
  const title = escapeLucene(evidence?.title);
  if (!title) return "";
  const clauses = [`recording:\"${title}\"`];
  const artist = escapeLucene(evidence?.artists?.[0]);
  if (includeArtist && artist) clauses.push(`artist:\"${artist}\"`);
  return clauses.join(" AND ");
}

function creditNames(credit) {
  if (!Array.isArray(credit)) return [];
  return credit
    .map((item) => String(item?.name || item?.artist?.name || "").trim())
    .filter(Boolean);
}

function releaseTrackInfo(release, recordingId) {
  const media = Array.isArray(release?.media) ? release.media : [];
  let trackNumber = 0;
  let discNumber = 0;
  let trackTotal = 0;
  for (const medium of media) {
    trackTotal += Math.max(0, Number(medium?.["track-count"] || medium?.trackCount || 0));
    const tracks = Array.isArray(medium?.tracks) ? medium.tracks : [];
    const hit = tracks.find((track) => String(track?.recording?.id || track?.recordingId || "") === recordingId);
    if (hit && !trackNumber) {
      trackNumber = Math.max(0, Number(hit.position || hit.number || 0));
      discNumber = Math.max(0, Number(medium.position || 0));
    }
  }
  return {
    trackNumber,
    trackTotal,
    discNumber,
    discTotal: media.length,
  };
}

function coverAsset(release) {
  const archive = release?.["cover-art-archive"] || release?.coverArtArchive || {};
  if (!archive.front || !release?.id) return null;
  return {
    assetId: `release:${release.id}:front-500`,
    provider: "coverartarchive",
  };
}

function provenance(recordingId, releaseId, fields) {
  const source = {
    provider: "musicbrainz",
    recordingId,
    releaseId: releaseId || "",
  };
  return Object.fromEntries(fields.map((field) => [field, source]));
}

function normalizeRecording(recording) {
  const recordingId = String(recording?.id || "").trim();
  const title = String(recording?.title || "").trim();
  if (!recordingId || !title) return [];
  const artists = creditNames(recording["artist-credit"] || recording.artistCredit);
  const durationSeconds = Math.max(0, Number(recording.length || 0) / 1000);
  const isrcs = Array.isArray(recording.isrcs) ? recording.isrcs : [];
  const tags = Array.isArray(recording.tags) ? recording.tags.map((tag) => tag?.name).filter(Boolean) : [];
  const releases = Array.isArray(recording.releases) && recording.releases.length
    ? recording.releases.slice(0, 12)
    : [null];

  return releases.map((release) => {
    const releaseId = String(release?.id || "").trim();
    const trackInfo = releaseTrackInfo(release, recordingId);
    const fields = ["title", "artists", "durationSeconds", "isrcs"];
    if (release) fields.push("album", "albumArtists", "releaseDate", "trackNumber", "trackTotal", "discNumber", "discTotal", "cover");
    return {
      recordingId,
      releaseId,
      title,
      artists,
      album: String(release?.title || "").trim(),
      albumArtists: creditNames(release?.["artist-credit"] || release?.artistCredit),
      releaseDate: String(release?.date || release?.["first-release-date"] || "").trim(),
      ...trackInfo,
      durationSeconds,
      isrcs,
      genres: tags,
      cover: coverAsset(release),
      provenance: provenance(recordingId, releaseId, fields),
    };
  });
}

function hasUsableRecording(evidence, recordings) {
  const artist = String(evidence?.artists?.[0] || "").trim();
  return (Array.isArray(recordings) ? recordings : []).some((recording) => {
    if (textSimilarity(evidence?.title, recording?.title, { ignoreVersion: true }) < 0.55) return false;
    if (!artist) return true;
    return artistCreditSimilarity([artist], creditNames(recording?.["artist-credit"] || recording?.artistCredit)) >= 0.5;
  });
}

async function defaultRequestJson({ params, headers, signal }) {
  const response = await axios.get(MUSICBRAINZ_ENDPOINT, {
    params,
    headers,
    signal,
    responseType: "json",
  });
  return response.data;
}

function waitForFallback(ms, signal) {
  if (signal?.aborted) {
    const error = new Error("MusicBrainz query aborted");
    error.name = "AbortError";
    error.code = "ABORTED";
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      const error = new Error("MusicBrainz query aborted");
      error.name = "AbortError";
      error.code = "ABORTED";
      reject(error);
    }
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

function createMusicBrainzProvider({
  requestJson = defaultRequestJson,
  userAgent = "Flowave/0.1.0 (https://github.com/nadeshikochan/Flowave)",
} = {}) {
  let lastRequestStartedAt = 0;
  const request = async (query, signal) => {
    const delay = Math.max(0, lastRequestStartedAt + 1100 - Date.now());
    if (delay > 0) await waitForFallback(delay, signal);
    lastRequestStartedAt = Date.now();
    return requestJson({
      params: { query, fmt: "json", limit: 25 },
      headers: { Accept: "application/json", "User-Agent": userAgent },
      signal,
    });
  };
  return {
    id: "musicbrainz",
    version: "ws2-recording-v3",
    label: "MusicBrainz",
    minIntervalMs: 1100,
    timeoutMs: 25000,
    maxAttempts: 2,
    retryBaseMs: 1100,
    async query({ evidence, signal }) {
      const primaryQuery = buildRecordingQuery(evidence);
      if (!primaryQuery) return [];
      let payload = await request(primaryQuery, signal);
      let recordings = Array.isArray(payload?.recordings) ? payload.recordings : [];
      const fallbackQuery = buildRecordingQuery(evidence, { includeArtist: false });
      if (!hasUsableRecording(evidence, recordings) && fallbackQuery && fallbackQuery !== primaryQuery) {
        payload = await request(fallbackQuery, signal);
        recordings = [...recordings, ...(Array.isArray(payload?.recordings) ? payload.recordings : [])];
      }
      const seen = new Set();
      return recordings.flatMap(normalizeRecording).filter((recording) => {
        const key = `${recording.recordingId}:${recording.releaseId}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 100);
    },
  };
}

module.exports = {
  MUSICBRAINZ_ENDPOINT,
  buildRecordingQuery,
  createMusicBrainzProvider,
  escapeLucene,
  hasUsableRecording,
  normalizeRecording,
  waitForFallback,
};
