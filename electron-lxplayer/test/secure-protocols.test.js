const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PassThrough } = require("node:stream");

const secureProtocols = require("../secure-protocols");

test("privileged schemes keep the app secure and local media streamable", () => {
  let schemes = null;
  secureProtocols.registerPrivilegedSchemes({
    registerSchemesAsPrivileged(value) {
      schemes = value;
    },
  });
  assert.equal(schemes.length, 2);
  const appScheme = schemes.find((item) => item.scheme === "kumiko-app");
  const mediaScheme = schemes.find((item) => item.scheme === "kumiko-media");
  assert.equal(appScheme.privileges.standard, true);
  assert.equal(appScheme.privileges.secure, true);
  assert.equal(appScheme.privileges.bypassCSP, undefined);
  assert.equal(mediaScheme.privileges.secure, true);
  assert.equal(mediaScheme.privileges.stream, true);
});

test("local media URLs preserve Windows paths and reject non-media files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumiko-secure-media-"));
  try {
    const audioPath = path.join(dir, "测试 tone.wav");
    const textPath = path.join(dir, "private.txt");
    fs.writeFileSync(audioPath, Buffer.from("RIFF"));
    fs.writeFileSync(textPath, "private");

    const mediaUrl = secureProtocols.toLocalMediaUrl(audioPath);
    assert.equal(secureProtocols.localMediaUrlToPath(mediaUrl), audioPath);
    assert.equal(secureProtocols.resolveLocalMediaPath(mediaUrl), audioPath);
    assert.equal(
      secureProtocols.resolveLocalMediaPath(secureProtocols.toLocalMediaUrl(textPath)),
      "",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("workspace media requests repair migrated artwork without rereading track metadata", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "flowave-workspace-artwork-"));
  const currentCache = path.join(directory, "current workspace 音乐", "cache");
  const oldCache = path.join(directory, "previous", "data", "cache");
  const otherCache = path.join(directory, "other workspace", "cache");
  try {
    const handlers = new Map();
    secureProtocols.registerSecureProtocols({
      protocol: { handle: (scheme, handler) => handlers.set(scheme, handler) },
      rendererDir: directory,
      mediaCacheRoot: currentCache,
    });
    for (const kind of ["covers", "thumbs"]) {
      const old = path.join(oldCache, "metadata", kind, "same.jpg");
      const current = path.join(currentCache, "metadata", kind, "same.jpg");
      const other = path.join(otherCache, "metadata", kind, "same.jpg");
      for (const target of [old, current, other]) fs.mkdirSync(path.dirname(target), {recursive:true});
      fs.writeFileSync(old, "previous workspace");
      fs.writeFileSync(current, "current workspace");
      fs.writeFileSync(other, "other workspace");
      const url = secureProtocols.toLocalMediaUrl(old);
      for (const sourceExists of [true, false]) {
        if (!sourceExists) fs.unlinkSync(old);
        assert.equal(secureProtocols.resolveLocalMediaPath(url, currentCache), current);
        assert.equal(secureProtocols.resolveLocalMediaPath(url, otherCache), other);
        const response = await handlers.get("kumiko-media")({url, method:"GET", headers:new Headers()});
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("content-type"), "image/jpeg");
        assert.equal(await response.text(), "current workspace");
      }
    }
    const normalImage = path.join(directory, "cover.jpg");
    const artwork = cache => path.join(cache, "..", "config", "song-info", "artwork", "a".repeat(64) + ".png");
    for (const cache of [oldCache, currentCache]) {
      fs.mkdirSync(path.dirname(artwork(cache)), { recursive: true });
      fs.writeFileSync(artwork(cache), "custom cover");
    }
    const custom = secureProtocols.toLocalMediaUrl(artwork(oldCache));
    assert.equal(secureProtocols.resolveLocalMediaPath(custom, currentCache), artwork(currentCache));
    assert.equal(secureProtocols.resolveLocalMediaPath(custom, otherCache), "");
    fs.writeFileSync(normalImage, "external cover");
    assert.equal(secureProtocols.resolveLocalMediaPath(secureProtocols.toLocalMediaUrl(normalImage), currentCache), normalImage);
    const audio = path.join(oldCache, "metadata", "covers", "audio.mp3");
    fs.mkdirSync(path.dirname(audio), {recursive:true});
    fs.writeFileSync(audio, "audio must retain its path");
    assert.equal(secureProtocols.resolveLocalMediaPath(secureProtocols.toLocalMediaUrl(audio), currentCache), audio);
    const missing = path.join(oldCache, "metadata", "covers", "missing.jpg");
    assert.equal(secureProtocols.remapWorkspaceArtwork(missing, currentCache), missing);
    assert.equal(secureProtocols.resolveLocalMediaPath(secureProtocols.toLocalMediaUrl(missing), currentCache), "");
  } finally {
    assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, {recursive:true, force:true});
  }
});

test("local media responses support complete, head, and byte-range requests", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kumiko-secure-range-"));
  try {
    const audioPath = path.join(dir, "range.mp3");
    fs.writeFileSync(audioPath, Buffer.from("0123456789"));

    const complete = await secureProtocols.createLocalMediaResponse(
      { method: "GET", headers: new Headers() },
      audioPath,
    );
    assert.equal(complete.status, 200);
    assert.equal(complete.headers.get("accept-ranges"), "bytes");
    assert.equal(complete.headers.get("content-length"), "10");
    assert.equal(complete.headers.get("content-type"), "audio/mpeg");
    assert.equal(complete.headers.get("access-control-allow-origin"), "kumiko-app://renderer");
    assert.equal(Buffer.from(await complete.arrayBuffer()).toString(), "0123456789");

    const head = await secureProtocols.createLocalMediaResponse(
      { method: "HEAD", headers: new Headers() },
      audioPath,
    );
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "10");
    assert.equal((await head.arrayBuffer()).byteLength, 0);

    const partial = await secureProtocols.createLocalMediaResponse(
      { method: "GET", headers: new Headers({ range: "bytes=2-5" }) },
      audioPath,
    );
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(partial.headers.get("content-length"), "4");
    assert.equal(Buffer.from(await partial.arrayBuffer()).toString(), "2345");

    const suffix = await secureProtocols.createLocalMediaResponse(
      { method: "GET", headers: new Headers({ range: "bytes=-3" }) },
      audioPath,
    );
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers.get("content-range"), "bytes 7-9/10");
    assert.equal(Buffer.from(await suffix.arrayBuffer()).toString(), "789");

    const invalid = await secureProtocols.createLocalMediaResponse(
      { method: "GET", headers: new Headers({ range: "bytes=20-30" }) },
      audioPath,
    );
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), "bytes */10");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("media body safely handles cancellation, late close, abort and read failure", async (t) => {
  t.mock.method(fs.promises, "stat", async () => ({ size: 10 }));
  let source;
  t.mock.method(fs, "createReadStream", () => {
    source = new PassThrough();
    return source;
  });
  for (const mode of ["cancel-before-read", "cancel-pending", "cancel-after-chunk", "abort", "already-aborted", "error", "early-close", "end"]) {
    const abortController = new AbortController();
    if (mode === "already-aborted") abortController.abort();
    const response = await secureProtocols.createLocalMediaResponse(
      { signal: abortController.signal }, "fixture.mp3",
    );
    // Observe physical close as well as the response's logical terminal state.
    const closed = new Promise((resolve) => source.once("close", resolve));
    const reader = response.body.getReader();
    if (mode === "cancel-before-read") {
      await reader.cancel();
    } else if (mode === "cancel-after-chunk") {
      source.write(Buffer.from("0123"));
      assert.equal(Buffer.from((await reader.read()).value).toString(), "0123");
      await reader.cancel();
    } else if (mode === "cancel-pending") {
      const pending = reader.read();
      await reader.cancel();
      assert.equal((await pending).done, true);
    } else if (mode === "end") {
      source.end(Buffer.from("0123456789"));
      assert.equal(Buffer.from((await reader.read()).value).toString(), "0123456789");
      assert.equal((await reader.read()).done, true);
    } else {
      const rejected = assert.rejects(reader.read(), mode.includes("abort") ? { name: "AbortError" } : /read failed|closed before end/);
      if (mode === "abort") abortController.abort();
      if (mode === "error") source.destroy(new Error("read failed"));
      if (mode === "early-close") source.destroy();
      await rejected;
    }
    if (!source.closed) await closed;
    assert.equal(source.destroyed, true, mode);
  }
});

test("renderer asset resolution remains inside the packaged renderer directory", () => {
  const rendererDir = path.resolve("C:\\kumiko-app\\renderer");
  assert.equal(
    secureProtocols.resolveRendererAsset(rendererDir, "kumiko-app://renderer/index.html"),
    path.join(rendererDir, "index.html"),
  );
  assert.equal(
    secureProtocols.resolveRendererAsset(
      rendererDir,
      "kumiko-app://renderer/%2e%2e%2fsecret.txt",
    ),
    "",
  );
  assert.equal(
    secureProtocols.resolveRendererAsset(rendererDir, "https://example.com/index.html"),
    "",
  );
});

test("only the packaged renderer origin is trusted for navigation", () => {
  assert.equal(secureProtocols.isTrustedRendererUrl("kumiko-app://renderer/index.html"), true);
  assert.equal(secureProtocols.isTrustedRendererUrl("kumiko-app://renderer/#manual"), true);
  assert.equal(secureProtocols.isTrustedRendererUrl("file:///C:/private.txt"), false);
  assert.equal(secureProtocols.isTrustedRendererUrl("https://example.com"), false);
});
