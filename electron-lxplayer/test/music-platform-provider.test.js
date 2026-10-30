const assert = require("node:assert/strict");
const test = require("node:test");

const { createMusicPlatformProvider, normalizePlatformTrack } = require("../song-info/music-platform-provider");

test("platform metadata keeps only fields supported by the catalog response", () => {
  const candidate = normalizePlatformTrack({
    songId: "42", title: "Song", artist: "Singer", album: "Album", duration: 181,
    cover: "https://private.example/cover.jpg",
  }, "wy");
  assert.equal(candidate.recordingId, "42");
  assert.deepEqual(candidate.artists, ["Singer"]);
  assert.equal(candidate.album, "Album");
  assert.equal(candidate.durationSeconds, 181);
  assert.equal(Object.hasOwn(candidate, "cover"), false);
});

test("platform metadata retries by title when the combined query has no usable identity", async () => {
  const calls = [];
  const provider = createMusicPlatformProvider({
    source: "tx",
    searchMusic: async (_source, term, _page, _size, options) => {
      calls.push({ term, signal: options.signal });
      return term === "Song Singer"
        ? { list: [{ songId: "wrong", title: "Other", artist: "Other" }] }
        : { list: [{ songId: "right", title: "Song", artist: "Singer", album: "Album", duration: 180 }] };
    },
  });
  const controller = new AbortController();
  const result = await provider.query({ evidence: { title: "Song", artists: ["Singer"] }, signal: controller.signal });
  assert.deepEqual(calls.map((item) => item.term), ["Song Singer", "Song"]);
  assert.ok(calls.every((item) => item.signal === controller.signal));
  assert.deepEqual(result.map((item) => item.recordingId), ["wrong", "right"]);
});
