const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildRecordingQuery,
  createMusicBrainzProvider,
  normalizeRecording,
} = require("../song-info/musicbrainz-provider");

test("MusicBrainz search escapes Lucene characters and uses only public evidence", () => {
  const query = buildRecordingQuery({
    title: "A/B: Test?",
    artists: ["Artist + Guest"],
    album: "Album (Deluxe)",
    path: "D:\\Private\\song.flac",
    token: "secret",
  });

  assert.equal(
    query,
    "recording:\"A\\/B\\: Test\\?\" AND artist:\"Artist \\+ Guest\" AND release:\"Album \\(Deluxe\\)\"",
  );
  assert.equal(query.includes("Private"), false);
  assert.equal(query.includes("secret"), false);
});

test("MusicBrainz recording releases become separate candidates with provenance", () => {
  const candidates = normalizeRecording({
    id: "recording-1",
    title: "Northern Sky",
    length: 241000,
    isrcs: ["USABC1234567"],
    "artist-credit": [{ name: "Example Artist" }],
    tags: [{ name: "ambient" }],
    releases: [
      {
        id: "release-1",
        title: "Quiet Hours",
        date: "2024-03-01",
        "artist-credit": [{ name: "Example Artist" }],
        "cover-art-archive": { front: true },
        media: [{ position: 1, "track-count": 10 }],
      },
      {
        id: "release-2",
        title: "Quiet Hours Deluxe",
        date: "2025",
        "artist-credit": [{ name: "Example Artist" }],
        "cover-art-archive": { front: false },
        media: [{ position: 1, "track-count": 14 }],
      },
    ],
  });

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].durationSeconds, 241);
  assert.equal(candidates[0].cover.assetId, "release:release-1:front-500");
  assert.equal(candidates[0].cover.provider, "coverartarchive");
  assert.equal(candidates[0].cover.url, undefined);
  assert.equal(candidates[1].cover, null);
  assert.equal(candidates[0].provenance.album.provider, "musicbrainz");
  assert.equal(candidates[0].provenance.album.releaseId, "release-1");
  assert.deepEqual(candidates[0].genres, ["ambient"]);
});

test("MusicBrainz provider sends the required user agent and caps results", async () => {
  let observed = null;
  const provider = createMusicBrainzProvider({
    userAgent: "Flowave-test/1.0 (https://example.test)",
    requestJson: async (request) => {
      observed = request;
      return {
        recordings: Array.from({ length: 30 }, (_, index) => ({
          id: `recording-${index}`,
          title: `Song ${index}`,
          "artist-credit": [{ name: "Artist" }],
          releases: Array.from({ length: 5 }, (__, releaseIndex) => ({
            id: `release-${index}-${releaseIndex}`,
            title: `Album ${releaseIndex}`,
          })),
        })),
      };
    },
  });

  const result = await provider.query({
    evidence: { title: "Northern Sky", artists: ["Example Artist"] },
    signal: new AbortController().signal,
  });

  assert.equal(observed.headers["User-Agent"], "Flowave-test/1.0 (https://example.test)");
  assert.equal(observed.params.fmt, "json");
  assert.equal(observed.params.limit, 25);
  assert.equal(result.length, 100);
});
