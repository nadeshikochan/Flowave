const axios = require("axios");
const { artistCreditSimilarity, textSimilarity } = require("./candidate-model");

const ITUNES_SEARCH_ENDPOINT = "https://itunes.apple.com/search";

function artistNames(value) {
  const name = String(value || "").trim();
  return name ? [name] : [];
}

function normalizeItunesTrack(item) {
  const recordingId = String(item?.trackId || "").trim();
  const title = String(item?.trackName || "").trim();
  if (!recordingId || !title) return null;
  const releaseDate = String(item?.releaseDate || "").trim();
  return {
    recordingId,
    releaseId: String(item?.collectionId || ""),
    title,
    artists: artistNames(item?.artistName),
    album: String(item?.collectionName || ""),
    albumArtists: artistNames(item?.collectionArtistName || item?.artistName),
    releaseDate: releaseDate ? releaseDate.slice(0, 10) : "",
    trackNumber: Number(item?.trackNumber || 0),
    trackTotal: Number(item?.trackCount || 0),
    discNumber: Number(item?.discNumber || 0),
    discTotal: Number(item?.discCount || 0),
    genres: item?.primaryGenreName ? [String(item.primaryGenreName)] : [],
    durationSeconds: Math.max(0, Number(item?.trackTimeMillis || 0) / 1000),
  };
}

function hasUsableItunesResult(evidence, results) {
  const artist = String(evidence?.artists?.[0] || "").trim();
  return (Array.isArray(results) ? results : []).some((item) => {
    if (textSimilarity(evidence?.title, item?.trackName, { ignoreVersion: true }) < 0.55) return false;
    if (!artist) return true;
    return artistCreditSimilarity([artist], artistNames(item?.artistName)) >= 0.5;
  });
}

function abortError() {
  const error = new Error("iTunes query aborted");
  error.name = "AbortError";
  error.code = "ABORTED";
  return error;
}

function createLimiter(limit = 4) {
  const maximum = Math.max(1, Math.min(12, Math.trunc(Number(limit) || 4)));
  const waiting = [];
  let active = 0;
  const release = () => {
    const next = waiting.shift();
    if (next) {
      next.signal?.removeEventListener("abort", next.cancel);
      next.resolve();
      return;
    }
    active = Math.max(0, active - 1);
  };
  return async (operation, signal) => {
    if (signal?.aborted) throw abortError();
    if (active >= maximum) {
      await new Promise((resolve, reject) => {
        const entry = { resolve, reject, signal, cancel: null };
        const cancel = () => {
          const index = waiting.indexOf(entry);
          if (index >= 0) waiting.splice(index, 1);
          reject(abortError());
        };
        entry.cancel = cancel;
        waiting.push(entry);
        signal?.addEventListener("abort", cancel, { once: true });
      });
    } else {
      active += 1;
    }
    try {
      if (signal?.aborted) throw abortError();
      return await operation();
    } finally {
      release();
    }
  };
}

function createItunesProvider({ requestJson = null, countries = ["CN", "US", "JP"], maxConcurrentRequests = 4 } = {}) {
  const query = requestJson || (async ({ params, signal }) => {
    const response = await axios.get(ITUNES_SEARCH_ENDPOINT, { params, signal, timeout: 10000 });
    return response.data;
  });
  const limited = createLimiter(maxConcurrentRequests);
  return {
    id: "itunes",
    version: "search-multistore-v4",
    label: "iTunes",
    supportedFields: ["title", "artists", "album", "albumArtists", "releaseDate", "trackNumber", "trackTotal", "discNumber", "discTotal", "genres"],
    allowConcurrentQueries: true,
    timeoutMs: 25000,
    maxAttempts: 2,
    retryBaseMs: 500,
    async query({ evidence, signal }) {
      const title = String(evidence?.title || "").trim();
      const term = [title, evidence?.artists?.[0]].filter(Boolean).join(" ").trim();
      if (!term) return [];
      const stores = [...new Set((Array.isArray(countries) ? countries : [countries]).map(String).filter(Boolean))];
      const searchStores = async (searchTerm) => {
        const settled = await Promise.allSettled(stores.map((country) => limited(() => query({
          params: { term: searchTerm, country, media: "music", entity: "song", limit: 25 },
          signal,
        }), signal)));
        const aborted = settled.find((item) => (
          item.status === "rejected"
          && (item.reason?.name === "AbortError" || item.reason?.code === "ABORTED")
        ));
        if (aborted) throw aborted.reason;
        const payloads = settled
          .filter((item) => item.status === "fulfilled")
          .map((item) => item.value);
        if (!payloads.length) {
          const failed = settled.findLast((item) => item.status === "rejected");
          throw failed?.reason || new Error("iTunes query failed");
        }
        return payloads.flatMap((payload) => (Array.isArray(payload?.results) ? payload.results : []));
      };
      let rawResults = await searchStores(term);
      if (!hasUsableItunesResult(evidence, rawResults) && title && title !== term) {
        rawResults = [...rawResults, ...await searchStores(title)];
      }
      const seen = new Set();
      return rawResults
        .map(normalizeItunesTrack)
        .filter((track) => {
          const key = track ? `${track.recordingId}:${track.releaseId}` : "";
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return true;
        });
    },
  };
}

module.exports = {
  ITUNES_SEARCH_ENDPOINT,
  createItunesProvider,
  createLimiter,
  hasUsableItunesResult,
  normalizeItunesTrack,
};
