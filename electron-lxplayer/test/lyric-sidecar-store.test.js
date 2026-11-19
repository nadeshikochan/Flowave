const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  LyricSidecarStore,
  captureSidecarVersion,
  lyricPathForAudio,
  normalizeLyricText,
  temporaryPathForSidecar,
} = require("../song-info/lyric-sidecar-store");

async function fixture(t) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flowave-lyric-"));
  t.after(() => fs.promises.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  }));
  const audioPath = path.join(root, "Artist - Song.mp3");
  await fs.promises.writeFile(audioPath, "audio-placeholder");
  return {
    root,
    audioPath,
    sidecarPath: lyricPathForAudio(audioPath),
    store: new LyricSidecarStore({
      snapshotRoot: path.join(root, "undo"),
      idFactory: (() => { let value = 0; return () => `tx-${++value}`; })(),
      now: () => 123456,
    }),
  };
}

test("lyric output is normalized to UTF-8 LF with a final newline", () => {
  assert.equal(normalizeLyricText("[00:01.00]一行\r\n[00:02.00]二行"), "[00:01.00]一行\n[00:02.00]二行\n");
  assert.throws(() => normalizeLyricText("  "), { code: "EMPTY_LYRIC" });
  assert.throws(() => normalizeLyricText("line\0bad"), { code: "INVALID_LYRIC" });
});

test("new lyrics are saved in the matching mirrored KTV directory", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flowave-mirrored-save-"));
  t.after(() => fs.promises.rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  }));
  const partition = path.join(root, "MusicDownloader", "ogg_music");
  const audioPath = path.join(partition, "Artist - Song.mp3");
  await fs.promises.mkdir(partition, { recursive: true });
  await fs.promises.writeFile(audioPath, "audio-placeholder");
  const store = new LyricSidecarStore({
    snapshotRoot: path.join(root, "undo"),
    idFactory: () => "mirrored-save",
    resolveAudioRoot: () => root,
  });

  const inspected = await store.inspect(audioPath);
  assert.equal(
    inspected.sidecarPath,
    path.join(root, "KTV歌词", "MusicDownloader", "ogg_music", "Artist - Song.lrc"),
  );
  const result = await store.write({
    audioPath,
    lyrics: "[00:01.00]mirrored lyric",
    expected: inspected.version,
  });

  assert.equal(result.status, "committed");
  assert.equal(await fs.promises.readFile(inspected.sidecarPath, "utf8"), "[00:01.00]mirrored lyric\n");
});

test("new sidecar save is verified, recorded and undo removes only its own unchanged file", async (t) => {
  const { audioPath, sidecarPath, store } = await fixture(t);
  const inspected = await store.inspect(audioPath);
  const result = await store.write({
    audioPath,
    lyrics: "[00:01.00]hello",
    expected: inspected.version,
    source: "test",
    candidateId: "candidate-1",
  });

  assert.equal(result.status, "committed");
  assert.equal(await fs.promises.readFile(sidecarPath, "utf8"), "[00:01.00]hello\n");
  const manifest = JSON.parse(await fs.promises.readFile(result.manifestPath, "utf8"));
  assert.equal(manifest.before.exists, false);
  assert.equal(manifest.source, "test");

  const undone = await store.undo(result.manifestPath);
  assert.equal(undone.status, "undone");
  assert.equal((await captureSidecarVersion(sidecarPath)).exists, false);
});

test("existing lyrics are skipped by default without creating a transaction", async (t) => {
  const { audioPath, sidecarPath, store, root } = await fixture(t);
  await fs.promises.writeFile(sidecarPath, "original\n", "utf8");
  const inspected = await store.inspect(audioPath);
  const result = await store.write({ audioPath, lyrics: "replacement", expected: inspected.version });

  assert.equal(result.status, "skipped-existing");
  assert.equal(await fs.promises.readFile(sidecarPath, "utf8"), "original\n");
  assert.equal(fs.existsSync(path.join(root, "undo")), false);
});

test("explicit replacement keeps a verified snapshot and undo restores it", async (t) => {
  const { audioPath, sidecarPath, store } = await fixture(t);
  await fs.promises.writeFile(sidecarPath, "original\n", "utf8");
  const inspected = await store.inspect(audioPath);
  const result = await store.write({
    audioPath,
    lyrics: "replacement",
    expected: inspected.version,
    skipExisting: false,
  });

  assert.equal(await fs.promises.readFile(sidecarPath, "utf8"), "replacement\n");
  await store.undo(result.manifestPath);
  assert.equal(await fs.promises.readFile(sidecarPath, "utf8"), "original\n");
});

test("confirmation and undo both refuse to overwrite external changes", async (t) => {
  const { audioPath, sidecarPath, store } = await fixture(t);
  const inspected = await store.inspect(audioPath);
  await fs.promises.writeFile(sidecarPath, "external-before-save\n", "utf8");
  await assert.rejects(
    () => store.write({ audioPath, lyrics: "new", expected: inspected.version, skipExisting: false }),
    { code: "EXTERNAL_CHANGE" },
  );

  const current = await store.inspect(audioPath);
  const result = await store.write({
    audioPath,
    lyrics: "flowave",
    expected: current.version,
    skipExisting: false,
  });
  await fs.promises.writeFile(sidecarPath, "external-after-save\n", "utf8");
  await assert.rejects(() => store.undo(result.manifestPath), { code: "UNDO_CONFLICT" });
  assert.equal(await fs.promises.readFile(sidecarPath, "utf8"), "external-after-save\n");
});

test("same target writes are serialized and a stale second confirmation fails", async (t) => {
  const { audioPath, sidecarPath, store } = await fixture(t);
  const expected = (await store.inspect(audioPath)).version;
  const [first, second] = await Promise.allSettled([
    store.write({ audioPath, lyrics: "first", expected, skipExisting: false }),
    store.write({ audioPath, lyrics: "second", expected, skipExisting: false }),
  ]);

  assert.equal(first.status, "fulfilled");
  assert.equal(second.status, "rejected");
  assert.equal(second.reason.code, "EXTERNAL_CHANGE");
  assert.equal(await fs.promises.readFile(sidecarPath, "utf8"), "first\n");
});

test("recent undo state survives store recreation without exposing file paths", async (t) => {
  const { root, audioPath, store } = await fixture(t);
  const expected = (await store.inspect(audioPath)).version;
  const committed = await store.write({ audioPath, lyrics: "saved", expected });
  const reloaded = new LyricSidecarStore({ snapshotRoot: path.join(root, "undo") });

  const recent = await reloaded.listRecentUndoable({ limit: 1 });
  assert.equal(recent.length, 1);
  assert.equal(recent[0].transactionId, committed.transactionId);
  assert.equal(recent[0].committedAt, 123456);
  assert.equal(Object.hasOwn(recent[0], "audioPath"), false);
  assert.equal(Object.hasOwn(recent[0], "sidecarPath"), false);

  await reloaded.undoById(committed.transactionId);
  assert.deepEqual(await reloaded.listRecentUndoable({ limit: 1 }), []);
});

test("stale recent index falls back to verified manifests and repairs itself", async (t) => {
  const { root, audioPath, store } = await fixture(t);
  const expected = (await store.inspect(audioPath)).version;
  const committed = await store.write({ audioPath, lyrics: "saved", expected });
  const recentPath = path.join(root, "undo", "recent.json");
  await fs.promises.writeFile(recentPath, JSON.stringify({
    schemaVersion: 1,
    transactions: [{ transactionId: "missing-transaction", committedAt: 999999 }],
  }), "utf8");

  const recent = await store.listRecentUndoable({ limit: 1 });

  assert.deepEqual(recent, [{ transactionId: committed.transactionId, committedAt: 123456 }]);
  const repaired = JSON.parse(await fs.promises.readFile(recentPath, "utf8"));
  assert.deepEqual(repaired.transactions, recent);
});

test("partially stale recent index scans manifests to fill the requested undo list", async (t) => {
  const { root, audioPath, store } = await fixture(t);
  const secondAudioPath = path.join(root, "Artist - Second Song.mp3");
  await fs.promises.writeFile(secondAudioPath, "audio-placeholder-2");
  const first = await store.write({
    audioPath,
    lyrics: "first",
    expected: (await store.inspect(audioPath)).version,
  });
  const second = await store.write({
    audioPath: secondAudioPath,
    lyrics: "second",
    expected: (await store.inspect(secondAudioPath)).version,
  });
  const recentPath = path.join(root, "undo", "recent.json");
  await fs.promises.writeFile(recentPath, JSON.stringify({
    schemaVersion: 1,
    transactions: [
      { transactionId: second.transactionId, committedAt: 123456 },
      { transactionId: "missing-transaction", committedAt: 999999 },
    ],
  }), "utf8");

  const recent = await store.listRecentUndoable({ limit: 2 });

  assert.deepEqual(new Set(recent.map((entry) => entry.transactionId)), new Set([
    first.transactionId,
    second.transactionId,
  ]));
});

test("transaction ids and undo manifests cannot escape the snapshot root", async (t) => {
  const { root, audioPath } = await fixture(t);
  const escaping = new LyricSidecarStore({
    snapshotRoot: path.join(root, "safe-undo"),
    idFactory: () => "../escape",
  });
  const expected = (await escaping.inspect(audioPath)).version;

  await assert.rejects(
    () => escaping.write({ audioPath, lyrics: "saved", expected }),
    { code: "INVALID_TRANSACTION" },
  );
  assert.equal(fs.existsSync(path.join(root, "escape")), false);
  await assert.rejects(
    () => escaping.undo(path.join(root, "outside", "manifest.json")),
    { code: "UNDO_CONFLICT" },
  );
});

test("undo validates its recovery copy before replacing saved lyrics", async (t) => {
  const { audioPath, sidecarPath, store } = await fixture(t);
  await fs.promises.writeFile(sidecarPath, "original\n", "utf8");
  const expected = (await store.inspect(audioPath)).version;
  const committed = await store.write({
    audioPath,
    lyrics: "replacement",
    expected,
    skipExisting: false,
  });
  const manifest = JSON.parse(await fs.promises.readFile(committed.manifestPath, "utf8"));
  await fs.promises.writeFile(manifest.snapshotPath, "damaged\n", "utf8");

  await assert.rejects(() => store.undo(committed.manifestPath), { code: "UNDO_CONFLICT" });
  assert.equal(await fs.promises.readFile(sidecarPath, "utf8"), "replacement\n");
});

async function makePreparedManifest({ root, audioPath, sidecarPath, transactionId, before, afterBody }) {
  const transactionDir = path.join(root, "undo", transactionId);
  await fs.promises.mkdir(transactionDir, { recursive: true });
  const after = Buffer.from(afterBody, "utf8");
  const manifestPath = path.join(transactionDir, "manifest.json");
  await fs.promises.writeFile(manifestPath, JSON.stringify({
    schemaVersion: 1,
    transactionId,
    status: "prepared",
    audioPath,
    sidecarPath,
    before,
    after: {
      exists: true,
      size: after.length,
      sha256: require("node:crypto").createHash("sha256").update(after).digest("hex"),
    },
  }), "utf8");
  return manifestPath;
}

test("prepared recovery records a replaced sidecar as committed and undoable", async (t) => {
  const { root, audioPath, sidecarPath, store } = await fixture(t);
  const before = await captureSidecarVersion(sidecarPath);
  const body = "[00:01.00]recovered\n";
  await makePreparedManifest({
    root,
    audioPath,
    sidecarPath,
    transactionId: "tx-recover-commit",
    before,
    afterBody: body,
  });
  await fs.promises.writeFile(sidecarPath, body, "utf8");

  const outcomes = await store.recoverIncomplete();

  assert.deepEqual(outcomes, [{ status: "committed", transactionId: "tx-recover-commit" }]);
  assert.equal((await store.listRecentUndoable({ limit: 1 }))[0].transactionId, "tx-recover-commit");
});

test("prepared deletion is recoverable only with a verified original snapshot", async (t) => {
  const { audioPath, sidecarPath, store } = await fixture(t);
  const original = "[00:01.00]original\n";
  await fs.promises.writeFile(sidecarPath, original);
  const deleted = await store.write({ audioPath, expected: (await store.inspect(audioPath)).version, remove: true });
  const manifest = JSON.parse(await fs.promises.readFile(deleted.manifestPath, "utf8"));
  manifest.status = "prepared";
  await fs.promises.writeFile(deleted.manifestPath, JSON.stringify(manifest));
  assert.equal((await store.recoverIncomplete())[0].status, "committed");
  await store.undoById(deleted.transactionId);
  assert.equal(await fs.promises.readFile(sidecarPath, "utf8"), original);

  const next = await store.write({ audioPath, expected: (await store.inspect(audioPath)).version, remove: true });
  const pending = JSON.parse(await fs.promises.readFile(next.manifestPath, "utf8"));
  pending.status = "prepared";
  await fs.promises.writeFile(next.manifestPath, JSON.stringify(pending));
  await fs.promises.writeFile(pending.snapshotPath, "corrupt snapshot");
  assert.equal((await store.recoverIncomplete())[0].status, "conflict");
});

test("prepared recovery aborts an unchanged target and preserves external conflicts", async (t) => {
  const { root, audioPath, sidecarPath, store } = await fixture(t);
  const before = await captureSidecarVersion(sidecarPath);
  await makePreparedManifest({
    root,
    audioPath,
    sidecarPath,
    transactionId: "tx-recover-abort",
    before,
    afterBody: "new\n",
  });
  const aborted = await store.recoverIncomplete();
  assert.deepEqual(aborted, [{ status: "aborted", transactionId: "tx-recover-abort" }]);

  const external = "external\n";
  await fs.promises.writeFile(sidecarPath, external, "utf8");
  await makePreparedManifest({
    root,
    audioPath,
    sidecarPath,
    transactionId: "tx-recover-conflict",
    before,
    afterBody: "other\n",
  });
  const outcomes = await store.recoverIncomplete();
  assert.ok(outcomes.some((item) => item.status === "conflict" && item.transactionId === "tx-recover-conflict"));
  assert.equal(await fs.promises.readFile(sidecarPath, "utf8"), external);
  assert.deepEqual(await store.recoverIncomplete(), []);
});

test("prepared recovery removes only the exact verified transaction temporary", async (t) => {
  const { root, audioPath, sidecarPath, store } = await fixture(t);
  const before = await captureSidecarVersion(sidecarPath);
  const transactionId = "tx-recover-temporary";
  const afterBody = "new\n";
  await makePreparedManifest({
    root,
    audioPath,
    sidecarPath,
    transactionId,
    before,
    afterBody,
  });
  const temporary = temporaryPathForSidecar(sidecarPath, transactionId);
  await fs.promises.writeFile(temporary, afterBody, "utf8");

  await store.recoverIncomplete();

  assert.equal(fs.existsSync(temporary), false);
});

test("prepared recovery preserves a temporary whose content does not match the manifest", async (t) => {
  const { root, audioPath, sidecarPath, store } = await fixture(t);
  const before = await captureSidecarVersion(sidecarPath);
  const transactionId = "tx-recover-foreign-temporary";
  await makePreparedManifest({
    root,
    audioPath,
    sidecarPath,
    transactionId,
    before,
    afterBody: "expected\n",
  });
  const temporary = temporaryPathForSidecar(sidecarPath, transactionId);
  await fs.promises.writeFile(temporary, "external\n", "utf8");

  await store.recoverIncomplete();

  assert.equal(await fs.promises.readFile(temporary, "utf8"), "external\n");
});

test("prepared recovery marks an invalid manifest once without exposing or retrying its path", async (t) => {
  const { root, audioPath, sidecarPath, store } = await fixture(t);
  const before = await captureSidecarVersion(sidecarPath);
  const manifestPath = await makePreparedManifest({
    root,
    audioPath,
    sidecarPath,
    transactionId: "tx-invalid-path",
    before,
    afterBody: "expected\n",
  });
  const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
  manifest.sidecarPath = path.join(root, "unrelated.lrc");
  await fs.promises.writeFile(manifestPath, JSON.stringify(manifest), "utf8");

  assert.deepEqual(await store.recoverIncomplete(), [
    { status: "invalid", transactionId: "tx-invalid-path" },
  ]);
  assert.deepEqual(await store.recoverIncomplete(), []);
  const settled = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
  assert.equal(settled.status, "invalid");
  assert.equal(settled.recovery.reason, "path-mismatch");
});
