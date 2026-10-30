const assert = require("node:assert/strict");
const test = require("node:test");

const {
  normalizeLyricCandidate,
  rankLyricCandidates,
  scoreLyricCandidate,
} = require("../lyrics/candidate-model");

const local = {
  title: "Blue Sky",
  artists: ["Singer"],
  album: "Album",
  durationSeconds: 180,
};

function candidate(overrides = {}) {
  return normalizeLyricCandidate({
    id: overrides.id || "one",
    trackName: "Blue Sky",
    artistName: "Singer",
    albumName: "Album",
    duration: 180,
    syncedLyrics: "[00:01.000]Line",
    ...overrides,
  }, { id: "test", version: "1", label: "Test" });
}

test("song identity outranks finer timing from a conflicting artist", () => {
  const correct = candidate({ id: "correct" });
  const wrong = candidate({
    id: "wrong",
    artistName: "Another Singer",
    syncedLyrics: "[00:01.000]A[00:01.500]B[00:02.000]",
  });
  const ranked = rankLyricCandidates(local, [wrong, correct]);

  assert.equal(ranked[0].candidate.sourceRecordId, "correct");
  assert.equal(ranked[0].identityLevel, "strong");
  assert.equal(ranked[1].identityLevel, "reject");
});

test("version and duration conflicts are hard lyric identity gates", () => {
  const live = scoreLyricCandidate(local, candidate({ id: "live", trackName: "Blue Sky (Live)" }));
  const long = scoreLyricCandidate(local, candidate({ id: "long", duration: 190 }));

  assert.equal(live.identityLevel, "reject");
  assert.ok(live.blockers.some((item) => item.code === "version-conflict"));
  assert.equal(long.identityLevel, "reject");
  assert.ok(long.blockers.some((item) => item.code === "duration-conflict"));
});

test("two close strong candidates cannot be selected automatically", () => {
  const ranked = rankLyricCandidates(local, [candidate({ id: "one" }), candidate({ id: "two" })], {
    autoThreshold: 90,
    manualThreshold: 75,
    minimumGap: 8,
  });

  assert.equal(ranked[0].recommendation, "medium");
  assert.ok(ranked[0].blockers.some((item) => item.code === "ambiguous-best"));
  assert.ok(ranked.every((item) => item.recommendation === "medium"));
});

test("a lyric candidate with different collaborator credits requires confirmation", () => {
  const result = scoreLyricCandidate(local, candidate({ artists: ["Singer", "Guest"] }), {
    autoThreshold: 90,
  });

  assert.equal(result.identityLevel, "strong");
  assert.equal(result.recommendation, "medium");
  assert.ok(result.blockers.some((item) => item.code === "artist-credit-difference"));
});

test("speed and language lyric editions are rejected as different versions", () => {
  const slowed = scoreLyricCandidate(local, candidate({ trackName: "Blue Sky (Slowed)" }));
  const language = scoreLyricCandidate(
    { ...local, title: "Blue Sky (English Version)" },
    candidate({ trackName: "Blue Sky (Japanese Version)" }),
  );

  assert.ok(slowed.blockers.some((item) => item.code === "version-conflict"));
  assert.ok(language.blockers.some((item) => item.code === "version-conflict"));
});

test("filename-only evidence never becomes an automatic lyric match", () => {
  const ranked = rankLyricCandidates({
    title: "Blue Sky",
    titleFromFileName: true,
    artists: ["Singer"],
    durationSeconds: 180,
  }, [candidate()], { autoThreshold: 90, manualThreshold: 70 });

  assert.notEqual(ranked[0].recommendation, "strong");
});

test("a unique title-only candidate still has to reach the manual threshold", () => {
  const ranked = rankLyricCandidates({ title: "Blue Sky", artists: [] }, [
    candidate({ duration: 0, albumName: "" }),
  ], { manualThreshold: 90 });

  assert.equal(ranked[0].identityLevel, "weak");
  assert.equal(ranked[0].recommendation, "none");
});

test("trusted local candidates preserve unified channels without raising identity confidence", () => {
  const lyrics = {
    schemaVersion: 1,
    synced: true,
    lines: [{
      startMs: 1000,
      endMs: 2000,
      main: { text: "Line", words: [] },
      translation: { text: "译文", words: [] },
    }],
    plain: { main: "", translation: "", romanization: "" },
  };
  const normalized = normalizeLyricCandidate({
    id: "local-one",
    trackName: "Blue Sky",
    artists: ["Singer"],
    albumName: "Album",
    durationSeconds: 180,
    unifiedLyrics: lyrics,
    identityLevel: "medium",
    identityScore: 84,
  }, { id: "local-library", version: "1", label: "本地歌词", localOnly: true });

  const scored = scoreLyricCandidate(local, normalized, { autoThreshold: 80, manualThreshold: 75 });

  assert.equal(scored.identityLevel, "medium");
  assert.equal(scored.identityScore, 84);
  assert.equal(scored.recommendation, "medium");
  assert.equal(scored.lyricsModel.lines[0].translation.text, "译文");
});

test("network providers cannot mark a unified model or identity as locally trusted", () => {
  const normalized = normalizeLyricCandidate({
    id: "remote-one",
    trackName: "Blue Sky",
    artists: ["Singer"],
    unifiedLyrics: { schemaVersion: 1, plain: { main: "Injected" }, lines: [] },
    identityLevel: "strong",
    identityScore: 100,
  }, { id: "remote", version: "1", label: "Remote" });

  assert.equal(normalized.unifiedLyrics, null);
  assert.equal(normalized.trustedIdentityLevel, "");
  assert.equal(scoreLyricCandidate(local, normalized).identityLevel, "reject");
});
