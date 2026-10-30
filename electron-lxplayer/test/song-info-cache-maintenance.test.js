const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sharp = require("sharp");

const { SongInfoCacheMaintenance } = require("../song-info/cache-maintenance");
const { CoverArtAssetStore } = require("../song-info/cover-art-asset-store");
const { SongInfoQueryCache } = require("../song-info/query-cache");

const RELEASE_ID = "12345678-1234-4123-8123-123456789abc";

test("clearing lookup caches preserves tasks, lyric transactions and saved lyrics", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flowave-cache-maintenance-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true }));
  const cacheRoot = path.join(root, "data", "cache", "song-info");
  const configRoot = path.join(root, "data", "config", "song-info");
  const musicRoot = path.join(root, "music");
  const tasksPath = path.join(configRoot, "tasks.json");
  const transactionPath = path.join(configRoot, "lyric-sidecar-transactions", "tx-1", "manifest.json");
  const savedLyricPath = path.join(musicRoot, "Northern Sky.lrc");
  await fs.promises.mkdir(path.dirname(transactionPath), { recursive: true });
  await fs.promises.mkdir(musicRoot, { recursive: true });
  await fs.promises.writeFile(tasksPath, "task-state", "utf8");
  await fs.promises.writeFile(transactionPath, "transaction-state", "utf8");
  await fs.promises.writeFile(savedLyricPath, "[00:00.00]saved lyric", "utf8");

  const metadataCache = new SongInfoQueryCache({ filePath: path.join(cacheRoot, "queries.json") });
  const lyricCache = new SongInfoQueryCache({ filePath: path.join(cacheRoot, "lyric-queries.json") });
  metadataCache.set("metadata", { candidates: [1] });
  lyricCache.set("lyrics", { candidates: [2] });
  metadataCache.flush();
  lyricCache.flush();

  const image = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "#456789" },
  }).jpeg().toBuffer();
  const coverAssetStore = new CoverArtAssetStore({
    rootDir: path.join(cacheRoot, "assets"),
    requestAsset: async () => ({ body: image, contentType: "image/jpeg" }),
  });
  const cover = await coverAssetStore.get(`release:${RELEASE_ID}:front-500`);
  const maintenance = new SongInfoCacheMaintenance({
    queryCaches: [metadataCache, lyricCache],
    coverAssetStore,
  });

  const result = await maintenance.clear();

  assert.equal(result.queryEntries, 2);
  assert.equal(result.coverFiles, 1);
  assert.equal(fs.existsSync(cover.path), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cacheRoot, "queries.json"), "utf8")).entries, {});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cacheRoot, "lyric-queries.json"), "utf8")).entries, {});
  assert.equal(await fs.promises.readFile(tasksPath, "utf8"), "task-state");
  assert.equal(await fs.promises.readFile(transactionPath, "utf8"), "transaction-state");
  assert.equal(await fs.promises.readFile(savedLyricPath, "utf8"), "[00:00.00]saved lyric");
});

test("an in-flight cover cannot repopulate the cache after it is cleared", async (t) => {
  const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flowave-cache-generation-"));
  t.after(() => fs.promises.rm(rootDir, { recursive: true, force: true }));
  const image = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "#789abc" },
  }).jpeg().toBuffer();
  let releaseRequest;
  const requested = new Promise((resolve) => {
    releaseRequest = resolve;
  });
  let requestStarted;
  const started = new Promise((resolve) => {
    requestStarted = resolve;
  });
  const store = new CoverArtAssetStore({
    rootDir,
    requestAsset: async () => {
      requestStarted();
      await requested;
      return { body: image, contentType: "image/jpeg" };
    },
  });

  const pending = store.get(`release:${RELEASE_ID}:front-500`);
  await started;
  await store.clear();
  releaseRequest();

  await assert.rejects(pending, { code: "CACHE_CLEARED" });
  const files = await fs.promises.readdir(rootDir);
  assert.deepEqual(files, ["manifest.json"]);
  assert.deepEqual(JSON.parse(await fs.promises.readFile(path.join(rootDir, "manifest.json"), "utf8")).entries, {});
});
