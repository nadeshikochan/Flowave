"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createLocalLibraryLyricProvider } = require("../lyrics/local-library-provider");
const { LyricLookupService } = require("../lyrics/lookup-service");
const { LyricProviderRegistry } = require("../lyrics/provider-registry");

function lyricModel() {
  return {
    schemaVersion: 1,
    synced: true,
    lines: [{
      startMs: 1000,
      endMs: 2000,
      main: { text: "Line", words: [] },
      translation: { text: "译文", words: [] },
    }],
    plain: { main: "", translation: "", romanization: "" },
  };
}

test("local lyric provider keeps paths inside its resolver and preserves identity caps", async () => {
  let request = null;
  const provider = createLocalLibraryLyricProvider({
    async resolve(payload) {
      request = payload;
      return {
        status: "selected",
        selected: {
          candidateId: "local-candidate",
          identityLevel: "medium",
          identityScore: 84,
          model: lyricModel(),
          sourcePath: "D:\\Private\\Singer - Song.lrc",
        },
        alternatives: [],
      };
    },
  });

  const result = await provider.query({
    evidence: { title: "Song", artists: ["Singer"], album: "Album", durationSeconds: 180 },
    localContext: { trackPath: "D:\\Music\\Song.mp3" },
    signal: new AbortController().signal,
  });

  assert.deepEqual(request.sources, ["external", "embedded"]);
  assert.equal(request.trackPath, "D:\\Music\\Song.mp3");
  assert.equal(result[0].identityLevel, "medium");
  assert.equal(result[0].identityScore, 84);
  assert.equal(result[0].unifiedLyrics.lines[0].translation.text, "译文");
  assert.equal(JSON.stringify(result).includes("D:\\Private"), false);
  assert.equal(provider.localOnly, true);
  assert.equal(provider.policy.save, "approved");
  assert.equal(provider.policy.cache, "blocked");
});

test("ambiguous local results remain separate candidates for manual ranking", async () => {
  const provider = createLocalLibraryLyricProvider({
    async resolve() {
      return {
        status: "ambiguous",
        selected: null,
        alternatives: [
          { candidateId: "one", identityLevel: "medium", identityScore: 82, model: lyricModel() },
          { candidateId: "two", identityLevel: "medium", identityScore: 81, model: lyricModel() },
        ],
      };
    },
  });

  const result = await provider.query({
    evidence: { title: "Song", artists: ["Singer"] },
    localContext: { trackPath: "D:\\Music\\Song.mp3" },
  });

  assert.deepEqual(result.map((item) => item.sourceRecordId), ["one", "two"]);
});

test("local lyric provider stops after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const provider = createLocalLibraryLyricProvider({ async resolve() { return { status: "missing" }; } });

  await assert.rejects(
    provider.query({ localContext: { trackPath: "D:\\Music\\Song.mp3" }, signal: controller.signal }),
    { code: "ABORTED" },
  );
});

test("local KTV lookup keeps translation and medium matches in manual review", async () => {
  const registry = new LyricProviderRegistry();
  registry.register(createLocalLibraryLyricProvider({
    async resolve() {
      return {
        status: "selected",
        selected: {
          candidateId: "local-medium",
          sourceType: "external",
          identityLevel: "medium",
          identityScore: 84,
          model: lyricModel(),
          sourcePath: "D:\\Private\\Singer - Song.lrc",
        },
        alternatives: [],
      };
    },
  }), { allowLocalContext: true });
  const service = new LyricLookupService({
    registry,
    stat: async () => ({ isFile: () => true }),
    inspectSidecar: async () => ({ version: { exists: false } }),
    getMeta: async () => ({
      title: "Song",
      titleFromTag: true,
      artists: ["Singer"],
      album: "Album",
      duration: 180,
      lyrics: "[00:01.00]External source",
    }),
  });

  const result = await service.query({
    trackPath: "D:\\Music\\Song.mp3",
    onlyMissing: true,
    storageTarget: "sidecar",
    autoThreshold: 80,
    manualThreshold: 75,
  });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].recommendation, "medium");
  assert.equal(result.candidates[0].candidate.provider, "local-library");
  assert.equal(result.candidates[0].candidate.lyrics.lines[0].translation.text, "译文");
  assert.equal(JSON.stringify(result).includes("D:\\Private"), false);
});

test("external KTV lyrics without independent duration evidence cannot auto-save", async () => {
  const registry = new LyricProviderRegistry();
  registry.register(createLocalLibraryLyricProvider({
    async resolve() {
      return {
        status: "selected",
        selected: {
          candidateId: "external-strong",
          sourceType: "external",
          identityLevel: "strong",
          identityScore: 100,
          model: lyricModel(),
        },
        alternatives: [],
      };
    },
  }), { allowLocalContext: true });
  const service = new LyricLookupService({
    registry,
    stat: async () => ({ isFile: () => true }),
    inspectSidecar: async () => ({ version: { exists: false } }),
    getMeta: async () => ({
      title: "Song",
      titleFromTag: true,
      artists: ["Singer"],
      album: "Album",
      duration: 180,
      lyrics: "[00:01.00]External source",
    }),
  });

  const result = await service.query({
    trackPath: "D:\\Music\\Song.mp3",
    onlyMissing: true,
    storageTarget: "sidecar",
    autoThreshold: 80,
    manualThreshold: 75,
  });

  assert.equal(result.candidates[0].recommendation, "medium");
  assert.equal(result.candidates[0].evidence.durationDifference, null);
});

test("embedded lyrics remain eligible for automatic save because they are bound to the audio", async () => {
  const registry = new LyricProviderRegistry();
  registry.register(createLocalLibraryLyricProvider({
    async resolve() {
      return {
        status: "selected",
        selected: {
          candidateId: "embedded-strong",
          sourceType: "embedded",
          identityLevel: "strong",
          identityScore: 100,
          model: lyricModel(),
        },
        alternatives: [],
      };
    },
  }), { allowLocalContext: true });
  const service = new LyricLookupService({
    registry,
    stat: async () => ({ isFile: () => true }),
    inspectSidecar: async () => ({ version: { exists: false } }),
    getMeta: async () => ({
      title: "Song",
      titleFromTag: true,
      artists: ["Singer"],
      album: "Album",
      duration: 180,
      lyrics: "[00:01.00]Embedded source",
    }),
  });

  const result = await service.query({
    trackPath: "D:\\Music\\Song.mp3",
    onlyMissing: true,
    storageTarget: "sidecar",
    autoThreshold: 95,
    manualThreshold: 75,
  });

  assert.equal(result.candidates[0].recommendation, "strong");
  assert.equal(result.candidates[0].evidence.durationDifference, 0);
});
