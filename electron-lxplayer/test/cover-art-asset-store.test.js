const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const sharp = require("sharp");

const {
  CoverArtAssetStore,
  parseAssetId,
} = require("../song-info/cover-art-asset-store");

const RELEASE_ID = "12345678-1234-4123-8123-123456789abc";

test("cover asset ids accept only controlled MusicBrainz release assets", () => {
  const parsed = parseAssetId(`release:${RELEASE_ID}:front-500`);
  assert.equal(parsed.url, `https://coverartarchive.org/release/${RELEASE_ID}/front-500`);
  assert.throws(() => parseAssetId("https://example.test/cover.jpg"), { code: "INVALID_ASSET_ID" });
  assert.throws(() => parseAssetId("release:../../private:front-500"), { code: "INVALID_ASSET_ID" });
  assert.throws(() => parseAssetId(`release:${RELEASE_ID}:front-original`), { code: "INVALID_ASSET_ID" });
});

test("validated cover assets are content addressed and reused without another request", async (t) => {
  const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flowave-cover-"));
  t.after(() => fs.promises.rm(rootDir, { recursive: true, force: true }));
  const body = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "#456789" },
  }).jpeg().toBuffer();
  let calls = 0;
  const store = new CoverArtAssetStore({
    rootDir,
    requestAsset: async ({ url, maxBytes }) => {
      calls += 1;
      assert.equal(url, `https://coverartarchive.org/release/${RELEASE_ID}/front-500`);
      assert.ok(maxBytes >= body.length);
      return { body, contentType: "image/jpeg", contentLength: String(body.length) };
    },
  });

  const first = await store.get(`release:${RELEASE_ID}:front-500`);
  const second = await store.get(`release:${RELEASE_ID}:front-500`);

  assert.equal(calls, 1);
  assert.equal(first.path, second.path);
  assert.equal(path.basename(first.path), `${first.sha256}.jpg`);
  assert.equal(first.width, 64);
  assert.equal(first.height, 64);
  assert.equal(fs.existsSync(first.path), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(rootDir, "manifest.json"), "utf8")).version, 1);
});

test("MIME, magic, dimensions and maximum size are enforced before persistence", async (t) => {
  const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flowave-cover-invalid-"));
  t.after(() => fs.promises.rm(rootDir, { recursive: true, force: true }));
  const png = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "#123456" },
  }).png().toBuffer();
  const assetId = `release:${RELEASE_ID}:front-500`;

  const wrongMime = new CoverArtAssetStore({
    rootDir: path.join(rootDir, "mime"),
    requestAsset: async () => ({ body: png, contentType: "text/html" }),
  });
  await assert.rejects(() => wrongMime.get(assetId), { code: "INVALID_IMAGE" });

  const tooSmall = new CoverArtAssetStore({
    rootDir: path.join(rootDir, "small"),
    requestAsset: async () => ({ body: Buffer.alloc(128, 0xff), contentType: "image/jpeg" }),
    imageMetadata: async () => ({ format: "jpeg", width: 1, height: 1 }),
  });
  await assert.rejects(() => tooSmall.get(assetId), { code: "INVALID_IMAGE" });

  const tooLarge = new CoverArtAssetStore({
    rootDir: path.join(rootDir, "large"),
    maxBytes: 1024,
    requestAsset: async () => ({ body: Buffer.alloc(1025), contentType: "image/png" }),
  });
  await assert.rejects(() => tooLarge.get(assetId), { code: "ASSET_TOO_LARGE" });
});

test("a tampered cached asset is discarded and downloaded again", async (t) => {
  const rootDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flowave-cover-tamper-"));
  t.after(() => fs.promises.rm(rootDir, { recursive: true, force: true }));
  const body = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "#778899" },
  }).jpeg().toBuffer();
  let calls = 0;
  const store = new CoverArtAssetStore({
    rootDir,
    requestAsset: async () => {
      calls += 1;
      return { body, contentType: "image/jpeg" };
    },
  });
  const first = await store.get(`release:${RELEASE_ID}:front-500`);
  await fs.promises.writeFile(first.path, Buffer.from("tampered"));
  const second = await store.get(`release:${RELEASE_ID}:front-500`);

  assert.equal(calls, 2);
  assert.equal(second.sha256, first.sha256);
  assert.equal((await fs.promises.readFile(second.path)).equals(body), true);
});
