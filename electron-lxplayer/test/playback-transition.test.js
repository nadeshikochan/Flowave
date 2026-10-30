const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildOnlineQualityQueue,
  PlaybackTransitionCoordinator,
  isStalePlaybackTransitionError,
  selectPlaylistNext,
} = require("../renderer/playback-transition");

test("only the latest playback generation can commit", async () => {
  const coordinator = new PlaybackTransitionCoordinator();
  const first = coordinator.begin({ targetPath: "A" });
  const second = coordinator.begin({ targetPath: "B" });

  assert.equal(coordinator.isCurrent(first), false);
  assert.equal(coordinator.isCurrent(second), true);
  assert.throws(
    () => coordinator.assertCurrent(first),
    (error) => isStalePlaybackTransitionError(error),
  );
  assert.equal(coordinator.finish(first), false);
  assert.equal(coordinator.finish(second), true);
});

test("a late async result from an older generation is discarded", async () => {
  const coordinator = new PlaybackTransitionCoordinator();
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const committed = [];

  const first = coordinator.begin({ targetPath: "A" });
  const firstWork = (async () => {
    await firstGate;
    coordinator.assertCurrent(first);
    committed.push("A");
  })();

  const second = coordinator.begin({ targetPath: "B" });
  coordinator.assertCurrent(second);
  committed.push("B");
  releaseFirst();

  await assert.rejects(
    firstWork,
    (error) => isStalePlaybackTransitionError(error),
  );
  assert.deepEqual(committed, ["B"]);
});

test("playlist selection uses the full queue and wraps in order", () => {
  const queue = [{ path: "A" }, { path: "B" }, { path: "C" }];
  const filteredView = [{ path: "B" }];

  assert.equal(selectPlaylistNext(queue, filteredView[0].path, "loop").path, "C");
  assert.equal(selectPlaylistNext(queue, "C", "loop").path, "A");
  assert.equal(selectPlaylistNext(queue, "missing", "loop").path, "A");
});

test("shuffle excludes the current song when another candidate exists", () => {
  const queue = [{ path: "A" }, { path: "B" }, { path: "C" }];

  assert.equal(selectPlaylistNext(queue, "B", "shuffle", { random: () => 0 }).path, "A");
  assert.equal(selectPlaylistNext(queue, "B", "shuffle", { random: () => 0.999 }).path, "C");
  assert.equal(selectPlaylistNext([{ path: "A" }], "A", "shuffle", { random: () => 0 }).path, "A");
});

test("shuffle also excludes a current-track alias", () => {
  const queue = [{ path: "local-A" }, { path: "local-B" }];
  const selected = selectPlaylistNext(queue, "online-A", "shuffle", {
    currentAliases: ["local-A"],
    random: () => 0,
  });

  assert.equal(selected.path, "local-B");
});

test("online quality starts from the user's choice and only degrades", () => {
  assert.deepEqual(buildOnlineQualityQueue("128k"), ["128k"]);
  assert.deepEqual(buildOnlineQualityQueue("320k"), ["320k", "128k"]);
  assert.deepEqual(buildOnlineQualityQueue("flac"), ["flac", "320k", "128k"]);
  assert.deepEqual(
    buildOnlineQualityQueue("hires"),
    ["hires", "flac24bit", "flac", "320k", "128k"],
  );
});
