const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { BatchSongInfoTaskManager } = require("../song-info/batch-task-manager");

async function taskFixture(t, queryTrack = async () => ({ candidates: [], sources: [] }), options = {}) {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "flowave-batch-"));
  t.after(async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await fs.promises.rm(root, { recursive: true, force: true });
        return;
      } catch (error) {
        if (error?.code !== "ENOTEMPTY" || attempt === 3) throw error;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  });
  let id = 0;
  return {
    root,
    filePath: path.join(root, "tasks.json"),
    manager: new BatchSongInfoTaskManager({
      filePath: path.join(root, "tasks.json"),
      queryTrack,
      ...options,
      idFactory: () => `task-${++id}`,
      now: (() => { let value = 1000; return () => ++value; })(),
    }),
  };
}

function track(name, resourceId = "") {
  return { path: `D:\\Music\\${name}.mp3`, resourceId, songKey: name, token: "secret", history: ["private"] };
}

function ranked(recommendation, title) {
  return {
    candidate: {
      title,
      artists: ["Artist"],
      cover: {
        assetId: "release:12345678-1234-4123-8123-123456789abc:front-500",
        provider: "coverartarchive",
        url: "https://should-not-persist.invalid/cover.jpg",
      },
    },
    score: recommendation === "strong" ? 98 : 82,
    recommendation,
    reasons: ["标题和歌手一致"],
    blockers: [],
    differences: [],
  };
}

function lyricRanked(recommendation, candidateId, text) {
  return {
    candidate: {
      candidateId,
      provider: "approved-lyrics",
      sourceLabel: "歌词来源",
      title: "One",
      artists: ["Artist"],
      album: "Album",
      lyrics: {
        schemaVersion: 1,
        synced: false,
        lines: [],
        plain: { main: text, translation: "", romanization: "" },
      },
    },
    score: recommendation === "strong" ? 98 : 82,
    recommendation,
    reasons: ["标题、歌手和时长一致"],
    blockers: [],
    differences: [{ field: "lyrics", current: null, proposed: text, missing: true, available: true }],
  };
}

test("task creation deduplicates stable tracks, clamps thresholds and persists only allowed references", async (t) => {
  const { manager, filePath, root } = await taskFixture(t);
  const created = manager.create({
    tracks: [track("One", "resource-1"), track("Duplicate", "resource-1"), track("Two")],
    requestedFields: ["album", "cover", "unknown"],
    autoThreshold: 130,
    manualThreshold: 120,
  });

  assert.equal(created.items.length, 2);
  assert.deepEqual(created.requestedFields, ["album", "cover"]);
  assert.equal(created.thresholds.auto, 99);
  assert.equal(created.thresholds.manual, 94);
  assert.equal("token" in created.items[0].track, false);
  assert.equal("history" in created.items[0].track, false);
  assert.equal(JSON.parse(await fs.promises.readFile(filePath, "utf8")).version, 1);
  assert.equal((await fs.promises.readdir(root)).some((name) => name.endsWith(".tmp")), false);
});

test("large tasks emit bounded item patches instead of full task snapshots", async (t) => {
  const updates = [];
  const { manager } = await taskFixture(t, async () => ({ candidates: [], sources: [] }), {
    checkpointEvery: 10000,
    onUpdate: (update) => updates.push(update),
  });
  const tracks = Array.from({ length: 1000 }, (_, index) => track(`Track-${index + 1}`, `resource-${index + 1}`));
  const created = manager.create({ tracks, requestedFields: ["album"] });

  await manager.start(created.id);

  assert.ok(updates.length >= 2000);
  assert.ok(updates.every((update) => update.kind === "task-patch"));
  assert.ok(updates.every((update) => update.items.length <= 1));
  assert.ok(Math.max(...updates.map((update) => Buffer.byteLength(JSON.stringify(update)))) < 2048);
});

test("read-only batch query isolates item failures and separates automatic and manual matches", async (t) => {
  const seen = [];
  const { manager } = await taskFixture(t, async (request) => {
    seen.push(request.trackPath);
    if (request.trackPath.endsWith("Failed.mp3")) {
      const error = new Error("provider unavailable");
      error.code = "PROVIDER_UNAVAILABLE";
      throw error;
    }
    const recommendation = request.trackPath.endsWith("Manual.mp3") ? "medium" : "strong";
    return { candidates: [ranked(recommendation, path.basename(request.trackPath, ".mp3"))], sources: [{ id: "test", status: "ok" }] };
  });
  const task = manager.create({ tracks: [track("Auto"), track("Manual"), track("Failed")] });
  const finished = await manager.start(task.id);

  assert.equal(finished.state, "awaiting-confirmation");
  assert.deepEqual(finished.items.map((item) => item.status), ["matched-auto", "awaiting-confirmation", "failed"]);
  assert.equal(finished.counts.matchedAuto, 1);
  assert.equal(finished.counts.awaitingConfirmation, 1);
  assert.equal(finished.counts.failed, 1);
  assert.equal(seen.length, 3);
  assert.equal(finished.items[0].candidates[0].candidate.cover.url, undefined);
});

test("user cancellation aborts the active query and marks remaining items cancelled", async (t) => {
  let activeSignal;
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { manager } = await taskFixture(t, async ({ signal }) => {
    activeSignal = signal;
    await pending;
    if (signal.aborted) {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }
    return { candidates: [] };
  });
  const task = manager.create({ tracks: [track("One"), track("Two")] });
  const running = manager.start(task.id);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.cancel(task.id), true);
  release();
  const cancelled = await running;

  assert.equal(activeSignal.aborted, true);
  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(cancelled.items.map((item) => item.status), ["cancelled", "cancelled"]);
});

test("reload converts interrupted work to resumable pending state", async (t) => {
  const { manager, filePath } = await taskFixture(t);
  const task = manager.create({ tracks: [track("One")] });
  const payload = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  payload.tasks[0].state = "querying";
  payload.tasks[0].items[0].status = "querying";
  await fs.promises.writeFile(filePath, JSON.stringify(payload), "utf8");

  const restored = new BatchSongInfoTaskManager({ filePath, queryTrack: async () => ({ candidates: [] }) });
  const loaded = restored.get(task.id);
  assert.equal(loaded.state, "paused");
  assert.equal(loaded.items[0].status, "pending");
});

test("previous generation recovers tasks and two corrupt generations block new writes", async (t) => {
  const { manager, filePath } = await taskFixture(t);
  const first = manager.create({ tracks: [track("One")] });
  await manager.start(first.id);
  manager.create({ tracks: [track("Two")] });
  await fs.promises.writeFile(filePath, "{broken", "utf8");

  const recovered = new BatchSongInfoTaskManager({ filePath, queryTrack: async () => ({ candidates: [] }) });
  assert.equal(recovered.loadStatus, "recovered");
  assert.ok(recovered.get(first.id));

  await fs.promises.writeFile(`${filePath}.previous`, "{also-broken", "utf8");
  const blocked = new BatchSongInfoTaskManager({ filePath, queryTrack: async () => ({ candidates: [] }) });
  assert.equal(blocked.loadStatus, "unrecoverable");
  assert.throws(() => blocked.create({ tracks: [track("Three")] }), { code: "STORE_WRITE_BLOCKED" });
});

test("failed items can be retried and medium candidates require explicit confirmation", async (t) => {
  let fail = true;
  const { manager } = await taskFixture(t, async () => {
    if (fail) {
      const error = new Error("offline");
      error.code = "OFFLINE";
      throw error;
    }
    return { candidates: [ranked("medium", "One")], sources: [] };
  });
  const created = manager.create({ tracks: [track("One")] });
  let task = await manager.start(created.id);
  assert.equal(task.items[0].status, "failed");

  fail = false;
  assert.equal(manager.retry(task.id, [task.items[0].id]).changed, 1);
  task = await manager.start(task.id);
  assert.equal(task.state, "awaiting-confirmation");
  task = manager.confirmCandidate(task.id, task.items[0].id, 0);
  assert.equal(task.items[0].status, "confirmed");
  assert.equal(task.state, "completed");
});

test("confirmation rejects stale, automatic and repeated item actions", async (t) => {
  const { manager } = await taskFixture(t, async ({ trackPath }) => ({
    candidates: [ranked(trackPath.endsWith("Manual.mp3") ? "medium" : "strong", "Result")],
    sources: [{ id: "test", status: "ok" }],
  }));
  const created = manager.create({ tracks: [track("Auto"), track("Manual")] });
  let task = await manager.start(created.id);
  const auto = task.items[0];
  const manual = task.items[1];

  assert.throws(
    () => manager.confirmCandidate(task.id, auto.id, 0),
    { code: "INVALID_ITEM_STATE" },
  );
  task = manager.confirmCandidate(task.id, manual.id, 0);
  assert.equal(task.items[1].status, "confirmed");
  assert.throws(
    () => manager.confirmCandidate(task.id, manual.id, 0),
    { code: "INVALID_ITEM_STATE" },
  );
});

test("terminal tasks ignore cancellation and empty retries do not broaden scope", async (t) => {
  const { manager } = await taskFixture(t, async () => ({ candidates: [], sources: [] }));
  const created = manager.create({ tracks: [track("NoMatch")] });
  const completed = await manager.start(created.id);

  assert.equal(completed.state, "completed");
  assert.equal(completed.items[0].status, "no-match");
  assert.equal(manager.cancel(completed.id), false);
  assert.equal(manager.retry(completed.id, []).changed, 0);
  assert.equal(manager.retry(completed.id, [completed.items[0].id]).changed, 0);
  assert.equal(manager.get(completed.id).state, "completed");
  assert.equal(manager.get(completed.id).items[0].status, "no-match");
});

test("uncertain matches are opt-in and remaining review can be ended together", async (t) => {
  const { manager } = await taskFixture(t, async () => ({
    candidates: [{ recommendation: "medium" }],
    sources: [],
  }));
  const tracks = [track("One"), track("Two")];
  const reliable = await manager.start(manager.create({ tracks, reviewUncertain: false }).id);
  assert.equal(reliable.state, "completed");
  assert.equal(reliable.counts.deferredReview, 2);
  const review = await manager.start(manager.create({ tracks, reviewUncertain: true }).id);
  assert.equal(review.state, "awaiting-confirmation");
  const result = manager.finishReview(review.id);
  assert.equal(result.state, "completed");
  assert.equal(result.counts.deferredReview, 2);
  assert.equal(result.counts.awaitingConfirmation, 0);
});

test("manual review can be skipped without changing any candidate data", async (t) => {
  const { manager } = await taskFixture(t, async () => ({
    candidates: [ranked("medium", "One")],
    sources: [],
  }));
  const created = manager.create({ tracks: [track("One")] });
  let task = await manager.start(created.id);
  task = manager.skipItem(task.id, task.items[0].id);

  assert.equal(task.items[0].status, "skipped");
  assert.equal(task.counts.skipped, 1);
  assert.equal(task.state, "completed");
});

test("an all-provider rate limit pauses the task without turning it into no-match", async (t) => {
  const { manager } = await taskFixture(t, async () => ({
    candidates: [],
    sources: [{ id: "test", status: "rate-limited", retryable: true }],
  }));
  const created = manager.create({ tracks: [track("One"), track("Two")], concurrency: 1 });
  const task = await manager.start(created.id);

  assert.equal(task.state, "paused-rate-limit");
  assert.deepEqual(task.items.map((item) => item.status), ["pending", "pending"]);
  assert.equal(task.items[0].errorCode, "RATE_LIMITED");
  assert.equal(task.items[1].attempts, 0);
});

test("a new task cannot hide an unfinished task", async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const { manager } = await taskFixture(t, async () => {
    await pending;
    return { candidates: [], sources: [] };
  });
  const first = manager.create({ tracks: [track("One")] });
  const running = manager.start(first.id);
  await new Promise((resolve) => setImmediate(resolve));

  assert.throws(
    () => manager.create({ tracks: [track("Two")] }),
    { code: "TASK_UNFINISHED" },
  );

  manager.cancel(first.id);
  release();
  await running;
  assert.doesNotThrow(() => manager.create({ tracks: [track("Two")] }));
});

test("strong lyric match is saved immediately without persisting lyric text", async (t) => {
  const secretText = "batch lyric body must stay in memory";
  let saveCalls = 0;
  const queryLyrics = async (request) => {
    assert.equal(request.storageTarget, "sidecar");
    const candidate = lyricRanked("strong", "lyrics:one", secretText);
    candidate.candidate.debugPayload = "candidate-private-payload";
    candidate.candidate.provenance = {
      provider: "approved-lyrics",
      providerVersion: "1",
      sourceRecordId: "record-1",
      rawLyrics: "provenance-private-payload",
    };
    return {
      ok: true,
      candidates: [candidate],
      sources: [{ id: "approved-lyrics", status: "ok", rawResponse: "source-private-payload" }],
    };
  };
  const { manager, filePath } = await taskFixture(t, undefined, {
    queryLyrics,
    saveLyrics: async ({ result, candidateId }) => {
      saveCalls += 1;
      assert.equal(candidateId, "lyrics:one");
      assert.equal(result.candidates[0].candidate.lyrics.plain.main, secretText);
      return { ok: true, status: "committed", transactionId: "tx-auto" };
    },
  });
  const created = manager.create({
    mode: "lyric-sidecar",
    tracks: [track("One", "resource-1")],
    requestedFields: ["album"],
  });
  const finished = await manager.start(created.id);
  const stored = await fs.promises.readFile(filePath, "utf8");

  assert.deepEqual(created.requestedFields, ["lyrics"]);
  assert.equal(saveCalls, 1);
  assert.equal(finished.state, "completed");
  assert.equal(finished.items[0].status, "written-auto");
  assert.equal(finished.counts.writtenAuto, 1);
  assert.equal("lyrics" in finished.items[0].candidates[0].candidate, false);
  assert.equal("debugPayload" in finished.items[0].candidates[0].candidate, false);
  assert.equal("rawLyrics" in finished.items[0].candidates[0].candidate.provenance, false);
  assert.equal("rawResponse" in finished.items[0].sources[0], false);
  assert.equal(finished.items[0].candidates[0].differences[0].proposed, true);
  assert.equal(stored.includes(secretText), false);
  assert.equal(stored.includes("private-payload"), false);
});

test("manual lyric confirmation re-queries the candidate before saving", async (t) => {
  let queryCount = 0;
  let savedText = "";
  const queryLyrics = async () => {
    queryCount += 1;
    return {
      ok: true,
      candidates: [lyricRanked("medium", "lyrics:one", `fresh body ${queryCount}`)],
      sources: [{ id: "approved-lyrics", status: "ok" }],
    };
  };
  const { manager, filePath } = await taskFixture(t, undefined, {
    queryLyrics,
    saveLyrics: async ({ result }) => {
      savedText = result.candidates[0].candidate.lyrics.plain.main;
      return { ok: true, status: "committed", transactionId: "tx-manual" };
    },
  });
  const created = manager.create({ mode: "lyric-sidecar", tracks: [track("One")] });
  let task = await manager.start(created.id);
  assert.equal(task.items[0].status, "awaiting-confirmation");
  assert.equal((await fs.promises.readFile(filePath, "utf8")).includes("fresh body 1"), false);

  task = await manager.confirmCandidate(task.id, task.items[0].id, 0);

  assert.equal(queryCount, 2);
  assert.equal(savedText, "fresh body 2");
  assert.equal(task.items[0].status, "confirmed");
  assert.equal(task.state, "completed");
  assert.equal((await fs.promises.readFile(filePath, "utf8")).includes("fresh body 2"), false);
});

test("manual lyric confirmation refuses a candidate whose identity changed", async (t) => {
  let queryCount = 0;
  let saveCalls = 0;
  const queryLyrics = async () => {
    queryCount += 1;
    return {
      ok: true,
      candidates: [lyricRanked("medium", queryCount === 1 ? "lyrics:one" : "lyrics:other", "body")],
      sources: [{ id: "approved-lyrics", status: "ok" }],
    };
  };
  const { manager } = await taskFixture(t, undefined, {
    queryLyrics,
    saveLyrics: async () => {
      saveCalls += 1;
      return { ok: true, status: "committed" };
    },
  });
  const created = manager.create({ mode: "lyric-sidecar", tracks: [track("One")] });
  const task = await manager.start(created.id);

  await assert.rejects(
    manager.confirmCandidate(task.id, task.items[0].id, 0),
    { code: "CANDIDATE_CHANGED" },
  );

  const retained = manager.get(task.id);
  assert.equal(saveCalls, 0);
  assert.equal(retained.state, "awaiting-confirmation");
  assert.equal(retained.items[0].status, "awaiting-confirmation");
  assert.equal(retained.items[0].errorCode, "CANDIDATE_CHANGED");
});

test("confirming a lyric upgrade requires review again if the local file changed", async (t) => {
  let targetVersion = "first";
  let saveCalls = 0;
  const { manager } = await taskFixture(t, undefined, {
    queryLyrics: async request => {
      assert.equal(request.lyricCompleteness, "word");
      assert.equal(request.matchIdentity, "filename");
      assert.deepEqual(request.lyricSources, ["lddc"]);
      return { ok: true, replacingExisting: true, targetVersion,
        candidates: [lyricRanked("medium", "lyrics:one", "body")], sources: [] };
    },
    saveLyrics: async ({ replaceExisting, result }) => {
      assert.equal(replaceExisting, true);
      assert.equal(result.targetVersion, "second");
      saveCalls += 1;
      return { ok: true, status: "committed" };
    },
  });
  const created = manager.create({ mode: "lyric-sidecar", tracks: [track("One")], matchIdentity: "filename",
    lyricOptions: { completeness: "word", sources: ["lddc"] } });
  const reviewed = await manager.start(created.id);
  targetVersion = "second";
  const confirm = () => manager.confirmCandidate(reviewed.id, reviewed.items[0].id, 0);
  await assert.rejects(confirm(), { code: "CANDIDATE_CHANGED" });
  assert.equal(saveCalls, 0);
  assert.equal((await confirm()).items[0].status, "confirmed");
  assert.equal(saveCalls, 1);
});

test("interrupted lyric write resumes as a missing-only lookup", async (t) => {
  const queryLyrics = async () => ({ candidates: [], sources: [] });
  const saveLyrics = async () => ({ ok: true, status: "committed" });
  const { manager, filePath } = await taskFixture(t, undefined, { queryLyrics, saveLyrics });
  const task = manager.create({ mode: "lyric-sidecar", tracks: [track("One")] });
  const payload = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  payload.tasks[0].state = "writing";
  payload.tasks[0].items[0].status = "writing";
  payload.tasks[0].items[0].requestId = "must-not-survive";
  await fs.promises.writeFile(filePath, JSON.stringify(payload), "utf8");

  const restored = new BatchSongInfoTaskManager({
    filePath,
    queryTrack: async () => ({ candidates: [] }),
    queryLyrics,
    saveLyrics,
  }).get(task.id);

  assert.equal(restored.state, "paused");
  assert.equal(restored.items[0].status, "pending");
  assert.equal("requestId" in restored.items[0], false);
});

test("restarting after a completed sidecar write skips the recovered item without saving twice", async (t) => {
  let sidecarExists = false;
  let saveCalls = 0;
  const queryLyrics = async ({ onlyMissing, storageTarget }) => {
    assert.equal(onlyMissing, true);
    assert.equal(storageTarget, "sidecar");
    return sidecarExists
      ? { ok: true, skipped: "complete", candidates: [], sources: [] }
      : {
        ok: true,
        candidates: [lyricRanked("strong", "lyrics:one", "body")],
        sources: [{ id: "approved-lyrics", status: "ok" }],
      };
  };
  const saveLyrics = async () => {
    saveCalls += 1;
    sidecarExists = true;
    return { ok: true, status: "committed" };
  };
  const { manager, filePath } = await taskFixture(t, undefined, { queryLyrics, saveLyrics });
  const task = manager.create({ mode: "lyric-sidecar", tracks: [track("One")] });
  const payload = JSON.parse(await fs.promises.readFile(filePath, "utf8"));
  payload.tasks[0].state = "writing";
  payload.tasks[0].items[0].status = "writing";
  await fs.promises.writeFile(filePath, JSON.stringify(payload), "utf8");

  sidecarExists = true;
  const restoredManager = new BatchSongInfoTaskManager({
    filePath,
    queryTrack: async () => ({ candidates: [] }),
    queryLyrics,
    saveLyrics,
  });
  const completed = await restoredManager.start(task.id);

  assert.equal(completed.state, "completed");
  assert.equal(completed.items[0].status, "skipped-complete");
  assert.equal(saveCalls, 0);
});

test("cancelling during a lyric write lets the atomic save finish and stops later items", async (t) => {
  let writing;
  let releaseWrite;
  const writeStarted = new Promise((resolve) => { writing = resolve; });
  const writePending = new Promise((resolve) => { releaseWrite = resolve; });
  const queryLyrics = async ({ trackPath }) => ({
    ok: true,
    candidates: [lyricRanked("strong", `lyrics:${path.basename(trackPath)}`, "body")],
    sources: [{ id: "approved-lyrics", status: "ok" }],
  });
  const { manager } = await taskFixture(t, undefined, {
    queryLyrics,
    saveLyrics: async () => {
      writing();
      await writePending;
      return { ok: true, status: "committed", transactionId: "tx-finished" };
    },
  });
  const created = manager.create({
    mode: "lyric-sidecar",
    tracks: [track("One"), track("Two")],
    concurrency: 1,
  });
  const running = manager.start(created.id);
  await writeStarted;
  assert.equal(manager.cancel(created.id), true);
  releaseWrite();
  const cancelled = await running;

  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.items[0].status, "written-auto");
  assert.equal(cancelled.items[1].status, "cancelled");
});

test("cancelling a manual lyric recheck closes the remaining confirmation queue", async (t) => {
  let queryCount = 0;
  let rechecking;
  let releaseRecheck;
  const recheckStarted = new Promise((resolve) => { rechecking = resolve; });
  const recheckPending = new Promise((resolve) => { releaseRecheck = resolve; });
  const queryLyrics = async () => {
    queryCount += 1;
    if (queryCount > 2) {
      rechecking();
      await recheckPending;
    }
    return {
      ok: true,
      candidates: [lyricRanked("medium", "lyrics:one", "body")],
      sources: [{ id: "approved-lyrics", status: "ok" }],
    };
  };
  const { manager } = await taskFixture(t, undefined, {
    queryLyrics,
    saveLyrics: async () => ({ ok: true, status: "committed" }),
  });
  const created = manager.create({
    mode: "lyric-sidecar",
    tracks: [track("One"), track("Two")],
  });
  const awaiting = await manager.start(created.id);
  const confirming = manager.confirmCandidate(awaiting.id, awaiting.items[0].id, 0);
  await recheckStarted;
  assert.equal(manager.cancel(awaiting.id), true);
  releaseRecheck();
  await assert.rejects(confirming, { code: "ABORTED" });

  const cancelled = manager.get(awaiting.id);
  assert.equal(cancelled.state, "cancelled");
  assert.deepEqual(cancelled.items.map((item) => item.status), ["cancelled", "cancelled"]);
});
