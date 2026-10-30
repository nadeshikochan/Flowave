const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { SongInfoQueryCache } = require("../song-info/query-cache");
const {
  SongInfoProviderRegistry,
  retryAfterMilliseconds,
  sanitizeTrackEvidence,
} = require("../song-info/provider-registry");

function tempCache(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "flowave-song-info-"));
  const filePath = path.join(root, "queries.json");
  t.after(() => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir())));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return { root, filePath };
}

function rawCandidate(id = "recording-1") {
  return {
    id,
    title: "Northern Sky",
    artists: ["Example Artist"],
    album: "Quiet Hours",
    durationSeconds: 240,
  };
}

test("provider evidence excludes local paths, history, tokens and stable resource ids", () => {
  const safe = sanitizeTrackEvidence({
    resourceId: "private-resource",
    path: "D:\\Private\\Music\\song.flac",
    fileName: "private-name.flac",
    title: "Northern Sky",
    artists: ["Example Artist"],
    album: "Quiet Hours",
    durationSeconds: 240,
    history: ["secret"],
    token: "secret-token",
    isrcs: ["USABC1234567"],
  });

  assert.deepEqual(safe, {
    title: "Northern Sky",
    artists: ["Example Artist"],
    album: "Quiet Hours",
    durationSeconds: 240,
  });
  assert.equal(JSON.stringify(safe).includes("Private"), false);
  assert.equal(JSON.stringify(safe).includes("secret"), false);
});

test("successful provider queries are normalized and reused from persistent cache", async (t) => {
  const { filePath } = tempCache(t);
  const cache = new SongInfoQueryCache({ filePath, saveDelayMs: 1 });
  let calls = 0;
  const provider = {
    id: "test-metadata",
    version: "1",
    label: "Test metadata",
    async query() {
      calls += 1;
      return [rawCandidate()];
    },
  };
  const registry = new SongInfoProviderRegistry({ cache }).register(provider);
  const request = {
    evidence: { title: "Northern Sky", artists: ["Example Artist"], durationSeconds: 240 },
    requestedFields: ["title", "artists"],
  };

  const first = await registry.queryAll(request);
  const second = await registry.queryAll(request);
  cache.close();

  assert.equal(calls, 1);
  assert.equal(first.candidates[0].provider, "test-metadata");
  assert.equal(second.sources[0].cached, true);

  const reloaded = new SongInfoQueryCache({ filePath });
  const secondRegistry = new SongInfoProviderRegistry({ cache: reloaded }).register({
    ...provider,
    query: async () => {
      throw new Error("persistent cache should satisfy the query");
    },
  });
  const afterRestart = await secondRegistry.queryAll(request);
  assert.equal(afterRestart.candidates.length, 1);
  assert.equal(afterRestart.sources[0].cached, true);
  reloaded.close();
});

test("a failed provider does not discard candidates from healthy providers", async () => {
  const registry = new SongInfoProviderRegistry({ timeoutMs: 100 });
  registry.register({
    id: "healthy",
    version: "1",
    query: async () => [rawCandidate("healthy-recording")],
  });
  registry.register({
    id: "broken",
    version: "1",
    query: async () => {
      const error = new Error("service unavailable with private details");
      error.status = 503;
      throw error;
    },
  });

  const result = await registry.queryAll({ evidence: { title: "Northern Sky" } });

  assert.equal(result.candidates.length, 1);
  assert.equal(result.sources.find((item) => item.id === "healthy").status, "ok");
  assert.deepEqual(
    result.sources.find((item) => item.id === "broken"),
    {
      id: "broken",
      label: "broken",
      status: "unavailable",
      cached: false,
      count: 0,
      message: "来源暂时不可用",
      retryable: true,
    },
  );
});

test("rate-limit retries honor Retry-After without exposing provider details", async () => {
  const delays = [];
  let calls = 0;
  const registry = new SongInfoProviderRegistry({
    now: () => Date.parse("2026-08-13T00:00:00Z"),
    waitFor: async (milliseconds) => delays.push(milliseconds),
  }).register({
    id: "limited",
    version: "1",
    maxAttempts: 2,
    retryBaseMs: 100,
    async query() {
      calls += 1;
      if (calls === 1) {
        const error = new Error("private rate-limit response");
        error.response = { status: 429, headers: { "retry-after": "2" } };
        throw error;
      }
      return [rawCandidate()];
    },
  });

  const result = await registry.queryAll({ evidence: { title: "Northern Sky" } });

  assert.equal(calls, 2);
  assert.deepEqual(delays, [2000]);
  assert.equal(result.sources[0].status, "ok");
});

test("long Retry-After pauses at the task layer instead of retrying too early", async () => {
  const delays = [];
  let calls = 0;
  const registry = new SongInfoProviderRegistry({
    waitFor: async (milliseconds) => delays.push(milliseconds),
    maxRetryAfterMs: 30000,
  }).register({
    id: "limited",
    version: "1",
    maxAttempts: 2,
    async query() {
      calls += 1;
      const error = new Error("private rate-limit response");
      error.response = { status: 429, headers: { "Retry-After": "120" } };
      throw error;
    },
  });

  const result = await registry.queryAll({ evidence: { title: "Northern Sky" } });

  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
  assert.equal(result.sources[0].status, "rate-limited");
  assert.equal(result.sources[0].message, "来源请求过多");
});

test("Retry-After accepts HTTP dates and rejects malformed values", () => {
  const now = Date.parse("2026-08-13T00:00:00Z");
  assert.equal(retryAfterMilliseconds({ headers: { "retry-after": "Thu, 13 Aug 2026 00:00:03 GMT" } }, now), 3000);
  assert.equal(retryAfterMilliseconds({ headers: { "retry-after": "later" } }, now), 0);
});

test("hung providers stop at the configured timeout", async () => {
  const registry = new SongInfoProviderRegistry({ timeoutMs: 20 });
  registry.register({
    id: "hung",
    version: "1",
    query: async () => new Promise(() => {}),
  });

  const started = Date.now();
  const result = await registry.queryAll({ evidence: { title: "Northern Sky" } });

  assert.equal(result.sources[0].status, "timeout");
  assert.ok(Date.now() - started < 500);
});

test("provider version changes invalidate old query results", async () => {
  const cache = new SongInfoQueryCache();
  let calls = 0;
  const request = { evidence: { title: "Northern Sky" } };
  const first = new SongInfoProviderRegistry({ cache }).register({
    id: "versioned",
    version: "1",
    query: async () => {
      calls += 1;
      return [rawCandidate("v1")];
    },
  });
  await first.queryAll(request);
  const second = new SongInfoProviderRegistry({ cache }).register({
    id: "versioned",
    version: "2",
    query: async () => {
      calls += 1;
      return [rawCandidate("v2")];
    },
  });

  const result = await second.queryAll(request);

  assert.equal(calls, 2);
  assert.equal(result.candidates[0].recordingId, "v2");
});

test("a query started before cache clearing cannot repopulate the cache", async () => {
  const cache = new SongInfoQueryCache();
  let releaseQuery;
  const queryGate = new Promise((resolve) => {
    releaseQuery = resolve;
  });
  let calls = 0;
  const registry = new SongInfoProviderRegistry({ cache }).register({
    id: "generation-aware",
    version: "1",
    async query() {
      calls += 1;
      if (calls === 1) await queryGate;
      return [rawCandidate(`candidate-${calls}`)];
    },
  });
  const request = { evidence: { title: "Northern Sky" } };

  const pending = registry.queryAll(request);
  await new Promise((resolve) => setImmediate(resolve));
  cache.clear();
  releaseQuery();
  await pending;
  await registry.queryAll(request);

  assert.equal(calls, 2);
});
