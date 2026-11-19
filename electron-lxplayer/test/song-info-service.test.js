const assert = require("node:assert/strict");
const test = require("node:test");

const { SongInfoService, missingLocalField, publicLocalEvidence } = require("../song-info/song-info-service");

function fileStat() {
  return { isFile: () => true };
}

test("local evidence marks filename fallbacks and removes unknown artists", () => {
  const evidence = publicLocalEvidence("D:\\Music\\Track01.mp3", {
    title: "Track01",
    artist: "未知艺术家",
    duration: 180,
  });

  assert.equal(evidence.titleFromFileName, true);
  assert.deepEqual(evidence.artists, []);
  assert.equal(evidence.fileName, "Track01");
});

test("batch lookup asks one candidate to fill every selected field that is actually missing", async () => {
  let observedFields = [];
  const service = new SongInfoService({
    stat: async () => fileStat(),
    getMeta: async () => ({
      title: "Song",
      titleFromTag: true,
      artists: ["Artist"],
      album: "",
      genres: [],
      cover: "D:\\Music\\cover.jpg",
      duration: 180,
    }),
    registry: {
      async queryAll({ requestedFields }) {
        observedFields = requestedFields;
        return { candidates: [], sources: [] };
      },
    },
  });

  const result = await service.query({
    requestId: "batch-1",
    trackPath: "D:\\Music\\Song.mp3",
    requestedFields: ["title", "album", "genres", "cover"],
    onlyMissing: true,
  });

  assert.deepEqual(observedFields, ["album", "genres"]);
  assert.deepEqual(result.requestedFields, ["album", "genres"]);
});

test("complete selected fields skip provider lookup in batch mode", async () => {
  let calls = 0;
  const service = new SongInfoService({
    stat: async () => fileStat(),
    getMeta: async () => ({ title: "Song", titleFromTag: true, artists: ["Artist"], album: "Album", duration: 180 }),
    registry: { async queryAll() { calls += 1; return { candidates: [], sources: [] }; } },
  });
  const result = await service.query({
    requestId: "batch-complete",
    trackPath: "D:\\Music\\Song.mp3",
    requestedFields: ["title", "artists", "album"],
    onlyMissing: true,
  });

  assert.equal(result.skipped, "complete");
  assert.equal(calls, 0);
  assert.equal(missingLocalField({ title: "Track01", titleFromFileName: true }, "title"), true);
});

test("batch checks that local cover exists and isolates filename evidence from bad tags", async () => {
  let request;
  const gone = Object.assign(new Error("missing cover"), { code: "ENOENT" });
  const service = new SongInfoService({
    stat: async file => { if (file.endsWith(".jpg")) throw gone; return fileStat(); },
    getMeta: async (_path, options) => {
      assert.equal(options.includeLyrics, false);
      return { title: "Wrong", titleFromTag: true, artist: "Incorrect", album: "Wrong album",
        cover: require("../secure-protocols").toLocalMediaUrl("D:/Music/missing.jpg"), duration: 180 };
    },
    registry: {
      async queryAll(options) {
        request = options;
        const raw = { title: "Song", artists: ["Artist"], durationSeconds: 180,
          cover: { assetId: "cover:correct", provider: "fixture" } };
        return { sources: [], candidates: [
          require("../song-info/candidate-model").normalizeCandidate(raw, {id: "fixture"}),
          require("../song-info/candidate-model").normalizeCandidate({ ...raw, title: "Song (Live)" }, {id: "fixture"}),
        ] };
      },
    },
  });
  const result = await service.query({
    trackPath: require("node:path").join("D:/Music", "01 - Song - Artist.mp3"),
    requestedFields: ["title", "album", "cover"], onlyMissing: true,
  });
  assert.deepEqual(request.requestedFields, ["cover"]);
  assert.equal(request.evidence.album, undefined);
  assert.equal(result.current.title, "Wrong");
  assert.equal(result.current.cover, false);
  assert.equal(result.candidates[0].candidate.title, "Song");
  assert.equal(result.candidates[0].recommendation, "medium");
  assert.deepEqual(result.candidates[0].differences.map(difference => difference.field), ["cover"]);
  assert.equal(result.candidates[1].recommendation, "none");
});

test("song info service returns ranked read-only candidates with field differences", async () => {
  let observed = null;
  const registry = {
    async queryAll(request) {
      observed = request;
      return {
        candidates: [{
          provider: "test",
          providerVersion: "1",
          recordingId: "recording-1",
          title: "Northern Sky",
          artists: ["Example Artist"],
          album: "Quiet Hours",
          albumArtists: ["Example Artist"],
          durationSeconds: 240,
        }],
        sources: [{ id: "test", status: "ok", count: 1 }],
      };
    },
  };
  const service = new SongInfoService({
    registry,
    stat: async () => fileStat(),
    getMeta: async () => ({
      title: "Northern Sky",
      artists: ["Example Artist"],
      album: "",
      duration: 240,
    }),
  });

  const result = await service.query({
    requestId: "request-1",
    trackPath: "D:\\Music\\song.flac",
    requestedFields: ["album", "albumArtists"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].recommendation, "strong");
  assert.equal(result.candidates[0].differences.find((item) => item.field === "album").missing, true);
  assert.deepEqual(observed.evidence.artists, ["Example Artist"]);
  assert.equal("trackPath" in observed.evidence, false);
});

test("an omitted or empty field list uses the documented full lookup fields", async () => {
  const observed = [];
  const service = new SongInfoService({
    registry: {
      async queryAll({ requestedFields }) {
        observed.push(requestedFields);
        return { candidates: [], sources: [] };
      },
    },
    stat: async () => fileStat(),
    getMeta: async () => ({ title: "Song", artist: "Artist", duration: 180 }),
  });

  await service.query({ requestId: "default-fields", trackPath: "D:\\Music\\Song.mp3", requestedFields: [] });

  assert.equal(observed.length, 1);
  assert.ok(observed[0].includes("title"));
  assert.ok(observed[0].includes("cover"));
  assert.ok(observed[0].includes("lyrics"));
});

test("starting the same request id cancels its older provider query", async () => {
  const seenSignals = [];
  const registry = {
    queryAll({ signal }) {
      seenSignals.push(signal);
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ candidates: [], sources: [] }), { once: true });
        if (seenSignals.length === 2) resolve({ candidates: [], sources: [] });
      });
    },
  };
  const service = new SongInfoService({
    registry,
    stat: async () => fileStat(),
    getMeta: async () => ({ title: "Song", artist: "Artist", duration: 100 }),
  });

  const first = service.query({ requestId: "same", trackPath: "D:\\Music\\first.mp3" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = service.query({ requestId: "same", trackPath: "D:\\Music\\second.mp3" });
  await Promise.all([first, second]);

  assert.equal(seenSignals.length, 2);
  assert.equal(seenSignals[0].aborted, true);
  assert.equal(seenSignals[1].aborted, false);
});
