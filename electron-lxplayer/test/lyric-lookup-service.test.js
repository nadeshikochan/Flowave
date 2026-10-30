const assert = require("node:assert/strict");
const test = require("node:test");

const { LyricLookupService } = require("../lyrics/lookup-service");

function fileStat() {
  return { isFile: () => true };
}

function lyricCandidate(overrides = {}) {
  return {
    candidateId: "provider:item-1",
    provider: "provider",
    providerVersion: "1",
    sourceLabel: "歌词来源",
    sourceRecordId: "item-1",
    trackName: "Song",
    artists: ["Artist"],
    album: "Album",
    durationSeconds: 180,
    instrumental: false,
    plainLyrics: "",
    syncedLyrics: "[00:01.00]Line",
    syncedFormat: "lrc",
    language: "zh",
    versionTerms: [],
    provenance: { provider: "provider", providerVersion: "1", sourceRecordId: "item-1" },
    ...overrides,
  };
}

test("lyric lookup returns ranked unified candidates without mixing metadata providers", async () => {
  let observedEvidence = null;
  const observedProviderLists = [];
  const service = new LyricLookupService({
    stat: async () => fileStat(),
    getMeta: async () => ({
      title: "Song",
      titleFromTag: true,
      artists: ["Artist"],
      album: "Album",
      duration: 180,
      lyrics: "",
    }),
    registry: {
      async queryAll({ evidence, providerIds }) {
        observedEvidence = evidence;
        observedProviderLists.push(providerIds);
        return {
          candidates: [lyricCandidate()],
          sources: [{ id: "provider", label: "歌词来源", status: "ok", count: 1 }],
        };
      },
    },
  });

  const result = await service.query({
    requestId: "lyrics-1",
    trackPath: "D:\\Music\\Song.mp3",
    onlyMissing: true,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.requestedFields, ["lyrics"]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].recommendation, "strong");
  assert.equal(result.candidates[0].candidate.lyrics.schemaVersion, 1);
  assert.equal(result.candidates[0].candidate.lyrics.lines[0].main.text, "Line");
  assert.equal(result.candidates[0].differences[0].field, "lyrics");
  assert.equal(observedEvidence.title, "Song");
  assert.equal(Object.hasOwn(observedEvidence, "trackPath"), false);
  assert.deepEqual(observedProviderLists, [["lddc-strategy"], ["music-tag-strategy"], ["local-library"]]);
});

test("existing local lyrics skip every provider in missing-only mode", async () => {
  let calls = 0;
  const service = new LyricLookupService({
    stat: async () => fileStat(),
    getMeta: async () => ({ title: "Song", artist: "Artist", duration: 180, lyrics: "[00:01.00]Existing" }),
    registry: {
      async queryAll() {
        calls += 1;
        return { candidates: [], sources: [] };
      },
    },
  });

  const result = await service.query({ trackPath: "D:\\Music\\Song.flac", onlyMissing: true });

  assert.equal(result.skipped, "complete");
  assert.equal(calls, 0);
});

test("sidecar batches can use local sources when only the target sidecar is missing", async () => {
  let observedContext = null;
  const service = new LyricLookupService({
    stat: async () => fileStat(),
    inspectSidecar: async () => ({ version: { exists: false } }),
    getMeta: async () => ({
      title: "Song",
      titleFromTag: true,
      artists: ["Artist"],
      duration: 180,
      lyrics: "[00:01.00]External source already available",
    }),
    registry: {
      async queryAll({ localContext }) {
        observedContext = localContext;
        return { candidates: [], sources: [{ id: "local-library", status: "empty", count: 0 }] };
      },
    },
  });

  const result = await service.query({
    trackPath: "D:\\Music\\Song.mp3",
    onlyMissing: true,
    storageTarget: "sidecar",
  });

  assert.equal(result.skipped, undefined);
  assert.deepEqual(observedContext, {
    trackPath: "D:\\Music\\Song.mp3",
    sources: ["lddc", "external", "embedded"],
  });
});

test("sidecar source selection routes LDDC and local fallback providers explicitly", async () => {
  const observed = [];
  const service = new LyricLookupService({
    stat: async () => fileStat(),
    inspectSidecar: async () => ({ version: { exists: false } }),
    getMeta: async () => ({ title: "Song", artists: ["Artist"], duration: 180, lyrics: "" }),
    registry: {
      async queryAll(request) {
        observed.push(request);
        return { candidates: [], sources: [] };
      },
    },
  });

  await service.query({
    trackPath: "D:\\Music\\Song.mp3",
    storageTarget: "sidecar",
    lyricSources: ["lddc", "embedded"],
  });

  assert.deepEqual(observed.map((request) => request.providerIds), [["lddc-strategy"], ["music-tag-strategy"], ["local-library"]]);
  assert.deepEqual(observed[2].localContext.sources, ["lddc", "embedded"]);
});

test("an existing target sidecar skips local and remote lyric sources", async () => {
  let calls = 0;
  const service = new LyricLookupService({
    stat: async () => fileStat(),
    inspectSidecar: async () => ({ version: { exists: true } }),
    getMeta: async () => ({ title: "Song", artists: ["Artist"], duration: 180, lyrics: "" }),
    registry: {
      async queryAll() {
        calls += 1;
        return { candidates: [], sources: [] };
      },
    },
  });

  const result = await service.query({
    trackPath: "D:\\Music\\Song.mp3",
    onlyMissing: true,
    storageTarget: "sidecar",
  });

  assert.equal(result.skipped, "complete");
  assert.equal(calls, 0);
});

test("starting the same lyric request cancels its older provider query", async () => {
  const signals = [];
  const service = new LyricLookupService({
    stat: async () => fileStat(),
    getMeta: async () => ({ title: "Song", artist: "Artist", duration: 180, lyrics: "" }),
    registry: {
      queryAll({ signal }) {
        signals.push(signal);
        return new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ candidates: [], sources: [] }), { once: true });
          if (signals.length >= 2) resolve({ candidates: [], sources: [] });
        });
      },
    },
  });

  const first = service.query({ requestId: "same", trackPath: "D:\\Music\\First.mp3" });
  const firstCancelled = assert.rejects(first, { code: "ABORTED" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = service.query({ requestId: "same", trackPath: "D:\\Music\\Second.mp3" });
  await Promise.all([firstCancelled, second]);

  assert.equal(signals.length, 4);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  assert.equal(signals[2].aborted, false);
  assert.equal(signals[3].aborted, false);
});
