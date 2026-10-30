const assert = require("node:assert/strict");
const test = require("node:test");

const {
  clearListeningStats,
  commitListeningHistoryOperation,
  resetRecommendationBehavior,
} = require("../listening-history-ops");

function createHistory() {
  return {
    version: 2,
    updatedAt: 100,
    totalSeconds: 150,
    totalPlays: 3,
    days: { "2026-07-30": 150 },
    tracks: {
      "C:\\Music\\learned.flac": {
        path: "C:\\Music\\learned.flac",
        title: "Learned",
        playCount: 2,
        listenedSeconds: 120,
        lastPlayedAt: 90,
        lastCountedAt: 80,
        recommendationBehavior: {
          songKey: "artist|learned",
          skipOpportunityCount: 8,
          dislikeChainSkipCount: 3,
          lastSkipAt: 70,
          lastOpportunityAt: 75,
          smoothedSkipRate: 0.4,
          skipNorm: 1.2,
          skipFix: 0.8,
          skipStatsUpdatedAt: 76,
          path: "C:\\Music\\learned.flac",
        },
      },
      "C:\\Music\\stats-only.flac": {
        path: "C:\\Music\\stats-only.flac",
        title: "Stats only",
        playCount: 1,
        listenedSeconds: 30,
        lastPlayedAt: 50,
        lastCountedAt: 45,
        recommendationBehavior: {
          skipOpportunityCount: 0,
          dislikeChainSkipCount: 0,
          skipNorm: 1,
          skipFix: 1,
        },
      },
      "online://behavior-only": {
        path: "online://behavior-only",
        title: "Behavior only",
        playCount: 0,
        listenedSeconds: 0,
        lastPlayedAt: 0,
        lastCountedAt: 0,
        recommendationBehavior: {
          skipOpportunityCount: 2,
          dislikeChainSkipCount: 1,
          skipNorm: 1.5,
          skipFix: 0.7,
        },
      },
    },
    recommendationBehaviorSummary: {
      version: 1,
      updatedAt: 95,
      updatedDay: "2026-07-30",
      globalSkipRate: 0.4,
      totalSkipOpportunityCount: 10,
      totalDislikeChainSkipCount: 4,
      dailyDecay: 0.97,
    },
  };
}

test("clearListeningStats clears statistics and preserves recommendation learning", () => {
  const source = createHistory();
  const before = structuredClone(source);
  const result = clearListeningStats(source, 200);

  assert.deepEqual(source, before);
  assert.equal(result.totalSeconds, 0);
  assert.equal(result.totalPlays, 0);
  assert.deepEqual(result.days, {});
  assert.equal(result.updatedAt, 200);
  assert.equal(result.tracks["C:\\Music\\learned.flac"].playCount, 0);
  assert.equal(result.tracks["C:\\Music\\learned.flac"].listenedSeconds, 0);
  assert.equal(
    result.tracks["C:\\Music\\learned.flac"].recommendationBehavior.skipOpportunityCount,
    8,
  );
  assert.equal(result.tracks["online://behavior-only"].recommendationBehavior.dislikeChainSkipCount, 1);
  assert.equal(result.tracks["C:\\Music\\stats-only.flac"], undefined);
  assert.deepEqual(result.recommendationBehaviorSummary, source.recommendationBehaviorSummary);
});

test("resetRecommendationBehavior preserves listening statistics and returns neutral learning", () => {
  const source = createHistory();
  const result = resetRecommendationBehavior(source, 300);
  const track = result.tracks["C:\\Music\\learned.flac"];

  assert.equal(result.totalSeconds, 150);
  assert.equal(result.totalPlays, 3);
  assert.deepEqual(result.days, source.days);
  assert.equal(track.playCount, 2);
  assert.equal(track.listenedSeconds, 120);
  assert.equal(track.lastPlayedAt, 90);
  assert.equal(track.recommendationBehavior.skipOpportunityCount, 0);
  assert.equal(track.recommendationBehavior.dislikeChainSkipCount, 0);
  assert.equal(track.recommendationBehavior.skipNorm, 1);
  assert.equal(track.recommendationBehavior.skipFix, 1);
  assert.equal(result.tracks["online://behavior-only"], undefined);
  assert.equal(result.recommendationBehaviorSummary.globalSkipRate, 0);
  assert.equal(result.recommendationBehaviorSummary.totalSkipOpportunityCount, 0);
  assert.equal(result.recommendationBehaviorSummary.totalDislikeChainSkipCount, 0);
  assert.equal(result.recommendationBehaviorSummary.dailyDecay, 0.97);
});

test("destructive operation writes the immutable snapshot before the primary file", () => {
  const source = createHistory();
  const events = [];
  const result = commitListeningHistoryOperation(source, "clear-stats", {
    now: 400,
    writeSnapshot(history, kind) {
      events.push(["snapshot", kind, history.totalSeconds]);
      return "snapshot.json";
    },
    writePrimary(history, kind) {
      events.push(["primary", kind, history.totalSeconds]);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.snapshot, "snapshot.json");
  assert.deepEqual(events, [
    ["snapshot", "clear-stats", 150],
    ["primary", "clear-stats", 0],
  ]);
});

test("operation failure returns the original history and never mutates it", () => {
  const source = createHistory();
  const before = structuredClone(source);
  let primaryCalled = false;
  const result = commitListeningHistoryOperation(source, "reset-recommendation-behavior", {
    now: 500,
    writeSnapshot() {
      throw new Error("snapshot disk full");
    },
    writePrimary() {
      primaryCalled = true;
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /snapshot disk full/);
  assert.equal(primaryCalled, false);
  assert.deepEqual(result.history, before);
  assert.deepEqual(source, before);
});
