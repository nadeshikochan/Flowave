const assert = require("node:assert/strict");
const test = require("node:test");

const { adaptNeteaseLyricPayload } = require("../lyrics/online-payload-adapter");

test("netease word lyrics keep translation and romanization in separate channels", () => {
  const result = adaptNeteaseLyricPayload({
    lrc: { lyric: "[00:01.000]fallback" },
    tlyric: { lyric: "[00:01.000]旧翻译" },
    romalrc: { lyric: "[00:01.000]fallback romanization" },
    yrc: { lyric: "[1000,1000](1000,400,0)気(1400,600,0)付" },
    ytlrc: { lyric: "[00:01.030]注意" },
    yromalrc: { lyric: "[00:01.020]ki zu" },
  });

  assert.equal(result.lyricsModel.lines.length, 1);
  assert.equal(result.lyricsModel.lines[0].main.text, "気付");
  assert.equal(result.lyricsModel.lines[0].translation.text, "注意");
  assert.equal(result.lyricsModel.lines[0].romanization.text, "ki zu");
  assert.deepEqual(result.provenance.channelFields, {
    main: "yrc",
    translation: "ytlrc",
    romanization: "yromalrc",
  });
});

test("netease line lyrics use the ordinary translation and romanization fallbacks", () => {
  const result = adaptNeteaseLyricPayload({
    lrc: { lyric: "[00:02.000]Main" },
    tlyric: { lyric: "[00:02.000]翻译" },
    romalrc: { lyric: "[00:02.000]romanized" },
  });

  assert.equal(result.lyricsModel.lines[0].main.text, "Main");
  assert.equal(result.lyricsModel.lines[0].translation.text, "翻译");
  assert.equal(result.lyricsModel.lines[0].romanization.text, "romanized");
  assert.deepEqual(result.provenance.channelFields, {
    main: "lrc",
    translation: "tlyric",
    romanization: "romalrc",
  });
});

test("missing optional channels stay empty and no lyrics returns no model", () => {
  const mainOnly = adaptNeteaseLyricPayload({
    yrc: { lyric: "[1000,500](1000,500,0)A" },
  });
  assert.equal(mainOnly.lyricsModel.lines[0].main.text, "A");
  assert.equal(mainOnly.lyricsModel.lines[0].translation.text, "");
  assert.equal(mainOnly.lyricsModel.lines[0].romanization.text, "");

  const empty = adaptNeteaseLyricPayload({ code: 200, lrc: { lyric: "" } });
  assert.equal(empty.lyricsModel, null);
  assert.deepEqual(empty.provenance.channelFields, {
    main: null,
    translation: null,
    romanization: null,
  });
});

test("translation outside the alignment tolerance remains explicitly uncertain", () => {
  const result = adaptNeteaseLyricPayload({
    lrc: { lyric: "[00:01.000]Main" },
    tlyric: { lyric: "[00:01.500]翻译" },
  });

  assert.equal(result.lyricsModel.lines.length, 2);
  assert.equal(result.lyricsModel.lines[0].translation.text, "");
  assert.equal(result.lyricsModel.lines[1].translation.text, "翻译");
  assert.ok(result.lyricsModel.lines[1].flags.includes("alignment_uncertain"));
});

test("a malformed word channel falls back to a usable line channel", () => {
  const result = adaptNeteaseLyricPayload({
    yrc: { lyric: `${"[0,1](0,1,0)A".repeat(2001)}` },
    lrc: { lyric: "[00:01.000]Fallback" },
  });

  assert.equal(result.lyricsModel.lines[0].main.text, "Fallback");
  assert.equal(result.provenance.channelFields.main, "lrc");
  assert.equal(result.provenance.channelDiagnostics.main[0].field, "yrc");
  assert.equal(result.provenance.channelDiagnostics.main[0].code, "LYRIC_TOO_MANY_TAGS");
});

test("a malformed optional channel does not discard valid main lyrics", () => {
  const result = adaptNeteaseLyricPayload({
    lrc: { lyric: "[00:01.000]Main" },
    tlyric: { lyric: "bad\0translation" },
  });

  assert.equal(result.lyricsModel.lines[0].main.text, "Main");
  assert.equal(result.lyricsModel.lines[0].translation.text, "");
  assert.equal(result.provenance.channelFields.translation, null);
  assert.equal(result.provenance.channelDiagnostics.translation[0].code, "LYRIC_NUL");
});
