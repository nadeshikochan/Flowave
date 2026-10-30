const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildFieldDiff,
  extractVersionTerms,
  normalizeCandidate,
  rankCandidates,
  scoreCandidate,
} = require("../song-info/candidate-model");

function candidate(overrides = {}) {
  return normalizeCandidate({
    id: "recording-1",
    releaseId: "release-1",
    title: "Northern Sky",
    artists: ["Example Artist"],
    album: "Quiet Hours",
    durationSeconds: 240,
    albumArtists: ["Example Artist"],
    ...overrides,
  }, { id: "test", version: "1", label: "Test" });
}

const local = {
  title: "Northern Sky",
  artists: ["Example Artist"],
  album: "Quiet Hours",
  durationSeconds: 241,
};

test("matching title, artist, album and duration produces an explainable strong result", () => {
  const result = scoreCandidate(local, candidate(), {
    requestedFields: ["title", "artists", "album", "albumArtists"],
  });

  assert.equal(result.recommendation, "strong");
  assert.equal(result.autoEligible, true);
  assert.ok(result.score >= 95);
  assert.deepEqual(result.blockers, []);
  assert.ok(result.reasons.includes("标题一致"));
  assert.ok(result.reasons.includes("歌手一致"));
  assert.ok(result.reasons.includes("时长一致"));
});

test("live and studio versions remain distinct even when base title matches", () => {
  const result = scoreCandidate(
    { ...local, title: "Northern Sky (Live)", durationSeconds: 270 },
    candidate({ title: "Northern Sky", durationSeconds: 240 }),
  );

  assert.equal(result.autoEligible, false);
  assert.ok(result.blockers.some((item) => item.code === "version-conflict"));
  assert.ok(result.blockers.some((item) => item.code === "duration-conflict"));
  assert.deepEqual(extractVersionTerms("Northern Sky（现场版）"), ["live"]);
});

test("lowering the score threshold cannot bypass a version hard gate", () => {
  const result = scoreCandidate(
    { ...local, title: "Northern Sky (Acoustic)" },
    candidate({ title: "Northern Sky" }),
    { autoThreshold: 90, manualThreshold: 60 },
  );

  assert.ok(result.score >= 90);
  assert.equal(result.autoEligible, false);
  assert.equal(result.recommendation, "medium");
});

test("a candidate missing any requested field is rejected", () => {
  const result = scoreCandidate(local, candidate({ albumArtists: [] }), {
    requestedFields: ["title", "albumArtists"],
  });

  assert.equal(result.recommendation, "none");
  assert.deepEqual(result.missingFields, ["albumArtists"]);
  assert.ok(result.blockers.some((item) => item.code === "missing-required"));
});

test("filename-only evidence never becomes an automatic match", () => {
  const result = scoreCandidate(
    { fileName: "Track01", titleFromFileName: true, durationSeconds: 240 },
    candidate(),
    { manualThreshold: 60 },
  );

  assert.equal(result.autoEligible, false);
  assert.ok(result.blockers.some((item) => item.code === "filename-only"));
});

test("two close candidates force the top result into manual confirmation", () => {
  const ranked = rankCandidates(local, [
    candidate({ id: "recording-1", releaseId: "release-1" }),
    candidate({ id: "recording-1", releaseId: "release-2", album: "Quiet Hours Deluxe" }),
  ]);

  assert.equal(ranked[0].autoEligible, false);
  assert.equal(ranked[0].recommendation, "medium");
  assert.ok(ranked[0].blockers.some((item) => item.code === "ambiguous-best"));
  assert.ok(ranked.every((item) => item.autoEligible === false));
});

test("an incomplete high-score candidate cannot outrank a complete result", () => {
  const ranked = rankCandidates(local, [
    candidate({ id: "incomplete", albumArtists: [] }),
    candidate({ id: "complete", durationSeconds: 239 }),
  ], {
    requestedFields: ["title", "artists", "album", "albumArtists"],
  });

  assert.equal(ranked[0].candidate.recordingId, "complete");
  assert.equal(ranked[0].recommendation, "strong");
  assert.equal(ranked[1].recommendation, "none");
  assert.ok(ranked[1].score > ranked[0].score);
});

test("different collaborator credits require confirmation even at a high score", () => {
  const result = scoreCandidate(
    { ...local, artists: ["Example Artist"] },
    candidate({ artists: ["Example Artist", "Guest Singer"] }),
  );

  assert.equal(result.autoEligible, false);
  assert.equal(result.recommendation, "medium");
  assert.ok(result.blockers.some((item) => item.code === "artist-credit-difference"));
});

test("speed and language editions remain distinct", () => {
  const spedUp = scoreCandidate(
    { ...local, title: "Northern Sky (Sped Up)" },
    candidate({ title: "Northern Sky" }),
  );
  const language = scoreCandidate(
    { ...local, title: "Northern Sky (English Version)" },
    candidate({ title: "Northern Sky (Japanese Version)" }),
  );

  assert.ok(spedUp.blockers.some((item) => item.code === "version-conflict"));
  assert.ok(language.blockers.some((item) => item.code === "version-conflict"));
  assert.deepEqual(extractVersionTerms("Northern Sky (DJ Mix / Slowed)"), ["dj-mix", "slowed"]);
});

test("field differences keep current and proposed values separate", () => {
  const diff = buildFieldDiff(
    { ...local, album: "" },
    candidate(),
    ["title", "album", "cover"],
  );

  assert.deepEqual(diff.map((item) => item.field), ["title", "album", "cover"]);
  assert.equal(diff.find((item) => item.field === "title").changed, false);
  assert.equal(diff.find((item) => item.field === "album").missing, true);
  assert.equal(diff.find((item) => item.field === "album").proposed, "Quiet Hours");
  assert.equal(diff.find((item) => item.field === "cover").available, false);
});
