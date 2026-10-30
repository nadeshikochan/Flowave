const assert = require("node:assert/strict");
const test = require("node:test");

const { LyricProviderRegistry } = require("../lyrics/provider-registry");

const TEST_POLICY = Object.freeze({
  serviceUse: "approved",
  cache: "blocked",
  save: "blocked",
  reviewedAt: "2026-08-11",
  reviewReference: "unit-test",
});

test("unreviewed lyric services cannot be registered", () => {
  const registry = new LyricProviderRegistry();

  assert.throws(
    () => registry.register({ id: "unreviewed", version: "1", async query() { return []; } }),
    { code: "PROVIDER_POLICY_UNREVIEWED" },
  );
});

test("save permission is explicit and provider-scoped", () => {
  const registry = new LyricProviderRegistry();
  registry.register({ id: "preview", version: "1", policy: TEST_POLICY, async query() { return []; } });
  registry.register({
    id: "save-approved",
    version: "1",
    policy: { ...TEST_POLICY, save: "approved" },
    async query() { return []; },
  });

  assert.equal(registry.canSave("preview"), false);
  assert.equal(registry.canSave("save-approved"), true);
  assert.equal(registry.canSave("missing"), false);
  assert.deepEqual(registry.capabilities(), { queryProviders: 2, saveProviders: 1 });
});

test("lyric providers receive only public song evidence", async () => {
  let received = null;
  let receivedLocalContext = "unset";
  const registry = new LyricProviderRegistry();
  registry.register({
    id: "safe",
    version: "1",
    policy: TEST_POLICY,
    async query(request) {
      received = request.evidence;
      receivedLocalContext = request.localContext;
      return [{ id: "1", trackName: request.evidence.title, artistName: "Singer", plainLyrics: "Line" }];
    },
  });

  const result = await registry.queryAll({
    evidence: {
      title: "Song",
      artists: ["Singer"],
      album: "Album",
      durationSeconds: 180,
      path: "D:\\Private\\Song.mp3",
      resourceId: "resource-secret",
      token: "token-secret",
      history: ["private"],
    },
    localContext: { trackPath: "D:\\Private\\Song.mp3", sources: ["external"] },
  });

  assert.deepEqual(received, { title: "Song", artists: ["Singer"], album: "Album", durationSeconds: 180 });
  assert.equal(receivedLocalContext, undefined);
  assert.equal(result.candidates.length, 1);
  assert.equal(JSON.stringify(result).includes("D:\\Private"), false);
  assert.equal(JSON.stringify(result).includes("resource-secret"), false);
  assert.equal(JSON.stringify(result).includes("token-secret"), false);
});

test("only explicitly local providers receive local lookup context", async () => {
  let received = null;
  let selfDeclaredContext = "unset";
  const registry = new LyricProviderRegistry();
  registry.register({
    id: "self-declared",
    version: "1",
    localOnly: true,
    policy: TEST_POLICY,
    async query(request) {
      selfDeclaredContext = request.localContext;
      return [];
    },
  });
  registry.register({
    id: "local-library",
    version: "1",
    label: "本地歌词",
    localOnly: true,
    policy: { ...TEST_POLICY, save: "approved" },
    async query(request) {
      received = request.localContext;
      return [];
    },
  }, { allowLocalContext: true });

  await registry.queryAll({
    evidence: { title: "Song" },
    localContext: { trackPath: "D:\\Private\\Song.mp3", sources: ["external", "embedded"] },
  });

  assert.deepEqual(received, {
    trackPath: "D:\\Private\\Song.mp3",
    sources: ["external", "embedded"],
  });
  assert.equal(selfDeclaredContext, undefined);
});

test("one failed lyric source does not discard healthy candidates", async () => {
  const registry = new LyricProviderRegistry({ timeoutMs: 30 });
  registry.register({ id: "failed", version: "1", policy: TEST_POLICY, async query() { throw new Error("offline details"); } });
  registry.register({
    id: "healthy",
    version: "1",
    policy: TEST_POLICY,
    async query() { return [{ id: "1", trackName: "Song", artistName: "Singer", plainLyrics: "Line" }]; },
  });

  const result = await registry.queryAll({ evidence: { title: "Song", artists: ["Singer"] } });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.sources.find((source) => source.id === "failed").status, "failed");
  assert.equal(result.sources.find((source) => source.id === "healthy").status, "ok");
  assert.equal(JSON.stringify(result).includes("offline details"), false);
});

test("an explicit provider list queries only the selected lyric tiers", async () => {
  const calls = [];
  const registry = new LyricProviderRegistry();
  for (const id of ["lddc-strategy", "local-library"]) {
    registry.register({
      id,
      version: "1",
      policy: TEST_POLICY,
      async query() { calls.push(id); return []; },
    });
  }

  const result = await registry.queryAll({ evidence: { title: "Song" }, providerIds: ["lddc-strategy"] });

  assert.deepEqual(calls, ["lddc-strategy"]);
  assert.deepEqual(result.sources.map((source) => source.id), ["lddc-strategy"]);
});

test("hung lyric providers stop at the configured timeout", async () => {
  const registry = new LyricProviderRegistry({ timeoutMs: 20 });
  registry.register({ id: "hung", version: "1", policy: TEST_POLICY, async query() { return new Promise(() => {}); } });

  const result = await registry.queryAll({ evidence: { title: "Song", artists: ["Singer"] } });

  assert.equal(result.sources[0].status, "timeout");
  assert.equal(result.sources[0].retryable, true);
});

test("provider responses are not cached without a separate cache approval", async () => {
  let cacheReads = 0;
  let cacheWrites = 0;
  const registry = new LyricProviderRegistry({
    cache: {
      get() { cacheReads += 1; return null; },
      set() { cacheWrites += 1; },
    },
  });
  registry.register({
    id: "preview-only",
    version: "1",
    policy: TEST_POLICY,
    async query() { return [{ id: "1", trackName: "Song", plainLyrics: "Line" }]; },
  });

  await registry.queryAll({ evidence: { title: "Song" } });

  assert.equal(cacheReads, 0);
  assert.equal(cacheWrites, 0);
});
