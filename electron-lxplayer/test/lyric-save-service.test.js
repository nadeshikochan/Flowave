const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { LyricSaveService } = require("../song-info/lyric-save-service");
const { LyricSidecarStore } = require("../song-info/lyric-sidecar-store");

async function fixture(t, options = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flowave-lyric-save-"));
  t.after(() => fs.promises.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 }));
  const audioPath = path.join(root, "Song.mp3");
  await fs.promises.writeFile(audioPath, "audio");
  let id = 0;
  let candidateTokenId = 0;
  const store = new LyricSidecarStore({
    snapshotRoot: path.join(root, "transactions"),
    idFactory: () => `tx-${++id}`,
  });
  const service = new LyricSaveService({
    store,
    now: options.now || (() => 1000),
    idFactory: () => `confirm-${++id}`,
    candidateTokenFactory: () => `candidate-${++candidateTokenId}`,
    confirmationTtlMs: options.confirmationTtlMs || 10000,
    candidateTtlMs: options.candidateTtlMs || 10000,
  });
  return { root, audioPath, service };
}

function stageCandidate(service, audioPath, lyrics, options = {}) {
  const requestId = options.requestId || `request-${Math.random()}`;
  const result = service.stageQueryResult({
    requestId,
    trackPath: audioPath,
    resourceId: "resource-1",
    result: {
      ok: true,
      candidates: [{
        recommendation: options.recommendation || "strong",
        candidate: {
          candidateId: "provider:item",
          provider: "provider",
          title: "Song",
          lyrics,
        },
        differences: [{ field: "lyrics", current: null, proposed: lyrics, changed: true, available: true }],
      }],
    },
    isSaveApproved: () => options.approved !== false,
  });
  return { requestId, result, token: String(result.candidates[0]?.lyricSaveToken || "") };
}

async function prepareCandidate(service, audioPath, lyrics, options = {}) {
  const staged = stageCandidate(service, audioPath, lyrics, options);
  const prepared = await service.prepare({
    candidateToken: staged.token,
    includeTranslation: options.includeTranslation,
    includeRomanization: options.includeRomanization,
  });
  return { ...staged, prepared };
}

function timedModel(text = "Line") {
  return {
    schemaVersion: 1,
    synced: true,
    lines: [{
      startMs: 1000,
      endMs: 2000,
      main: { text, words: [{ startMs: 1000, endMs: 2000, text }] },
      translation: { text: "译文", words: [] },
      romanization: { text: "romanized", words: [] },
    }],
    plain: { main: "", translation: "", romanization: "" },
  };
}

test("prepare returns an opaque confirmation and commit can be undone by transaction id", async (t) => {
  const { audioPath, service } = await fixture(t);
  const { prepared } = await prepareCandidate(service, audioPath, timedModel(), {
    includeTranslation: true,
    includeRomanization: false,
  });

  assert.equal(prepared.ok, true);
  assert.equal(prepared.targetExists, false);
  assert.deepEqual(prepared.channels, ["main", "translation", "romanization"]);
  assert.equal(Object.hasOwn(prepared, "sidecarPath"), false);
  assert.equal(Object.hasOwn(prepared, "version"), false);

  const committed = await service.commit({ confirmationId: prepared.confirmationId });
  assert.equal(committed.status, "committed");
  assert.equal(committed.transactionId, "tx-2");
  const recent = await service.recentUndo();
  assert.equal(recent.transaction.transactionId, "tx-2");
  assert.equal(Object.hasOwn(recent.transaction, "sidecarPath"), false);
  const saved = await fs.promises.readFile(path.join(path.dirname(audioPath), "Song.lrc"), "utf8");
  assert.match(saved, /Line/);
  assert.match(saved, /译文/);
  assert.doesNotMatch(saved, /romanized/);

  assert.deepEqual(await service.undo(committed.transactionId), { ok: true, status: "undone" });
  assert.equal((await service.recentUndo()).transaction, null);
  assert.equal(fs.existsSync(path.join(path.dirname(audioPath), "Song.lrc")), false);
});

test("existing sidecar is skipped until replacement is explicitly confirmed", async (t) => {
  const { audioPath, service } = await fixture(t);
  const sidecarPath = path.join(path.dirname(audioPath), "Song.lrc");
  await fs.promises.writeFile(sidecarPath, "original\n", "utf8");

  const { prepared: first } = await prepareCandidate(service, audioPath, timedModel("New"));
  assert.equal(first.targetExists, true);
  assert.equal((await service.commit({ confirmationId: first.confirmationId })).status, "skipped-existing");
  assert.equal(await fs.promises.readFile(sidecarPath, "utf8"), "original\n");

  const { prepared: second } = await prepareCandidate(service, audioPath, timedModel("New"));
  const committed = await service.commit({ confirmationId: second.confirmationId, replaceExisting: true });
  assert.equal(committed.status, "committed");
  assert.equal(committed.replacedExisting, true);
});

test("external change after prepare blocks commit and consumes the confirmation", async (t) => {
  const { audioPath, service } = await fixture(t);
  const sidecarPath = path.join(path.dirname(audioPath), "Song.lrc");
  const { prepared } = await prepareCandidate(service, audioPath, timedModel());
  await fs.promises.writeFile(sidecarPath, "external\n", "utf8");

  await assert.rejects(
    service.commit({ confirmationId: prepared.confirmationId, replaceExisting: true }),
    (error) => error?.code === "EXTERNAL_CHANGE",
  );
  await assert.rejects(
    service.commit({ confirmationId: prepared.confirmationId, replaceExisting: true }),
    (error) => error?.code === "CONFIRMATION_EXPIRED",
  );
});

test("expired and cancelled confirmations cannot write", async (t) => {
  let now = 0;
  const { audioPath, service } = await fixture(t, { now: () => now, confirmationTtlMs: 1000 });
  const { prepared: expired } = await prepareCandidate(service, audioPath, timedModel());
  now = 1001;
  await assert.rejects(
    service.commit({ confirmationId: expired.confirmationId }),
    (error) => error?.code === "CONFIRMATION_EXPIRED",
  );

  const { prepared: cancelled } = await prepareCandidate(service, audioPath, timedModel());
  assert.equal(service.cancel(cancelled.confirmationId), true);
  await assert.rejects(
    service.commit({ confirmationId: cancelled.confirmationId }),
    (error) => error?.code === "CONFIRMATION_EXPIRED",
  );
});

test("malformed timed models are rejected before sidecar inspection", async (t) => {
  const { audioPath, service } = await fixture(t);
  const model = timedModel();
  model.lines[0].startMs = "bad";
  const staged = stageCandidate(service, audioPath, model);
  assert.equal(staged.token, "");
  assert.equal(Object.hasOwn(staged.result.candidates[0].candidate, "lyrics"), false);
});

test("provider lyric objects accept synced main and optional language channels", async (t) => {
  const { audioPath, service } = await fixture(t);
  const { prepared } = await prepareCandidate(service, audioPath, {
      synced: "[00:01.00]Main",
      translation: { synced: "[00:01.00]译文" },
      romanization: "[00:01.00]romanized",
    }, {
    includeTranslation: true,
    includeRomanization: false,
  });
  const committed = await service.commit({ confirmationId: prepared.confirmationId });
  assert.equal(committed.status, "committed");
  const saved = await fs.promises.readFile(path.join(path.dirname(audioPath), "Song.lrc"), "utf8");
  assert.match(saved, /Main/);
  assert.match(saved, /译文/);
  assert.doesNotMatch(saved, /romanized/);
});

test("renderer receives bounded preview but cannot prepare an arbitrary lyric payload", async (t) => {
  const { audioPath, service } = await fixture(t);
  const staged = stageCandidate(service, audioPath, "[00:01.00]Secret");
  const serialized = JSON.stringify(staged.result);
  assert.match(serialized, /Secret/);
  assert.equal(Object.hasOwn(staged.result.candidates[0].candidate.lyrics, "lines"), false);
  assert.equal(staged.result.candidates[0].candidate.lyrics.preview.length, 1);
  assert.equal(staged.result.candidates[0].candidate.lyrics.available, true);
  assert.equal(staged.result.candidates[0].differences[0].proposed, true);
  await assert.rejects(
    service.prepare({ lyrics: "[00:01.00]Forged" }),
    (error) => error?.code === "CANDIDATE_EXPIRED",
  );
});

test("unapproved, expired and cancelled query candidates cannot be saved", async (t) => {
  let now = 0;
  const { audioPath, service } = await fixture(t, { now: () => now, candidateTtlMs: 1000 });
  const unapproved = stageCandidate(service, audioPath, timedModel(), { approved: false });
  assert.equal(unapproved.token, "");
  const rejected = stageCandidate(service, audioPath, timedModel(), { recommendation: "none" });
  assert.equal(rejected.token, "");

  const expired = stageCandidate(service, audioPath, timedModel());
  now = 1001;
  await assert.rejects(
    service.prepare({ candidateToken: expired.token }),
    (error) => error?.code === "CANDIDATE_EXPIRED",
  );

  const cancelled = stageCandidate(service, audioPath, timedModel(), { requestId: "cancel-me" });
  assert.equal(service.cancelStagedRequest("cancel-me"), 1);
  await assert.rejects(
    service.prepare({ candidateToken: cancelled.token }),
    (error) => error?.code === "CANDIDATE_EXPIRED",
  );
});

test("shutdown drain waits for an active sidecar write", async () => {
  let releaseWrite;
  let markStarted;
  const writeStarted = new Promise((resolve) => { markStarted = resolve; });
  const writePending = new Promise((resolve) => { releaseWrite = resolve; });
  const service = new LyricSaveService({
    store: {
      inspect: async (audioPath) => ({ audioPath, version: { exists: false } }),
      write: async () => {
        markStarted();
        await writePending;
        return { status: "committed", transactionId: "tx-drained", before: { exists: false } };
      },
      undoById: async () => ({ status: "undone" }),
    },
    idFactory: () => "confirm-drain",
    candidateTokenFactory: () => "candidate-drain",
  });
  const { prepared } = await prepareCandidate(service, "D:\\Music\\Drain.mp3", timedModel());
  const committing = service.commit({ confirmationId: prepared.confirmationId });
  await writeStarted;
  assert.equal(service.hasActiveWrites(), true);
  let drainFinished = false;
  const draining = service.drain({ timeoutMs: 1000 }).then((result) => {
    drainFinished = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drainFinished, false);

  releaseWrite();
  const [committed, drained] = await Promise.all([committing, draining]);
  assert.equal(committed.status, "committed");
  assert.deepEqual(drained, { drained: true, pending: 0 });
  assert.equal(service.hasActiveWrites(), false);
});

test("shutdown drain has a bounded timeout without cancelling the atomic write", async () => {
  let releaseWrite;
  let markStarted;
  const writeStarted = new Promise((resolve) => { markStarted = resolve; });
  const writePending = new Promise((resolve) => { releaseWrite = resolve; });
  const service = new LyricSaveService({
    store: {
      inspect: async (audioPath) => ({ audioPath, version: { exists: false } }),
      write: async () => {
        markStarted();
        await writePending;
        return { status: "committed", transactionId: "tx-late", before: { exists: false } };
      },
      undoById: async () => ({ status: "undone" }),
    },
    idFactory: () => "confirm-timeout",
    candidateTokenFactory: () => "candidate-timeout",
  });
  const { prepared } = await prepareCandidate(service, "D:\\Music\\Timeout.mp3", timedModel());
  const committing = service.commit({ confirmationId: prepared.confirmationId });
  await writeStarted;

  const timedOut = await service.drain({ timeoutMs: 5 });
  assert.equal(timedOut.drained, false);
  assert.equal(timedOut.pending, 1);
  assert.equal(service.hasActiveWrites(), true);

  releaseWrite();
  await committing;
  assert.equal(service.hasActiveWrites(), false);
});
