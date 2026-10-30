const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildUnifiedLyric,
  exportEnhancedLrc,
  parseLyricChannel,
} = require("../lyrics/unified-lyric");

test("standard LRC leading timestamps produce repeated lines instead of fake words", () => {
  const channel = parseLyricChannel("[00:01.00][00:02.500]Same line", { sourceId: "sidecar:test" });

  assert.equal(channel.synced, true);
  assert.deepEqual(channel.lines.map((line) => line.startMs), [1000, 2500]);
  assert.deepEqual(channel.lines.map((line) => line.text), ["Same line", "Same line"]);
  assert.deepEqual(channel.lines.map((line) => line.words), [[], []]);
});

test("LDDC repeated timestamps preserve word boundaries and a trailing end tag", () => {
  const channel = parseLyricChannel("[00:21.039]気[00:21.343]づ[00:21.511]け[00:23.272]", {
    sourceId: "external:lddc-sample",
  });

  assert.equal(channel.qualityLevel, "word_with_end");
  assert.equal(channel.lines[0].startMs, 21039);
  assert.equal(channel.lines[0].endMs, 23272);
  assert.deepEqual(channel.lines[0].words, [
    { startMs: 21039, endMs: 21343, text: "気", flags: [] },
    { startMs: 21343, endMs: 21511, text: "づ", flags: [] },
    { startMs: 21511, endMs: 23272, text: "け", flags: [] },
  ]);
});

test("offset applies to lines and words and records negative clamping", () => {
  const channel = parseLyricChannel("[offset:-1500]\n[00:01.000]<00:01.000>A<00:02.000>B", {});

  assert.equal(channel.lines[0].startMs, 0);
  assert.deepEqual(channel.lines[0].words.map((word) => word.startMs), [0, 500]);
  assert.ok(channel.lines[0].flags.includes("offset_clamped"));
  assert.equal(channel.qualityLevel, "word_start_only");
});

test("YRC relative timing retains explicit line and word durations", () => {
  const channel = parseLyricChannel("[21039,2471](0,304,0)気(304,168,0)づ", {
    format: "yrc",
    wordTimeMode: "relative",
  });

  assert.equal(channel.lines[0].startMs, 21039);
  assert.equal(channel.lines[0].endMs, 23510);
  assert.deepEqual(channel.lines[0].words.map((word) => [word.startMs, word.endMs, word.text]), [
    [21039, 21343, "気"],
    [21343, 21511, "づ"],
  ]);
});

test("ambiguous YRC timing keeps the line and refuses to invent word timing", () => {
  const channel = parseLyricChannel("[0,3000](0,500,0)A(500,500,0)B", { format: "yrc" });

  assert.equal(channel.lines[0].text, "AB");
  assert.deepEqual(channel.lines[0].words, []);
  assert.ok(channel.lines[0].flags.includes("word_time_ambiguous"));
});

test("plain lyrics preserve order without fabricated timestamps", () => {
  const channel = parseLyricChannel("First\nSecond", { role: "main" });

  assert.equal(channel.synced, false);
  assert.deepEqual(channel.lines.map((line) => line.text), ["First", "Second"]);
  assert.equal("startMs" in channel.lines[0], false);
});

test("explicit language channels align within tolerance and preserve uncertain lines", () => {
  const main = parseLyricChannel("[00:10.000]Main one\n[00:20.000]Main two", {
    role: "main",
    language: "ja",
    sourceId: "source:main",
  });
  const translation = parseLyricChannel("[00:10.040]译文一\n[00:30.000]未对齐", {
    role: "translation",
    language: "zh",
    sourceId: "source:translation",
  });
  const model = buildUnifiedLyric({ main, translation }, { toleranceMs: 80, identityReason: "artist_title_exact" });

  assert.equal(model.lines[0].translation.text, "译文一");
  assert.equal(model.lines[2].translation.text, "未对齐");
  assert.ok(model.lines[2].flags.includes("alignment_uncertain"));
  assert.deepEqual(model.provenance.selectedSources, ["source:main", "source:translation"]);
});

test("Enhanced LRC export keeps word timing and never invents romanization", () => {
  const main = parseLyricChannel("[00:21.039]気[00:21.343]づ[00:23.272]", { sourceId: "source:main" });
  const translation = parseLyricChannel("[00:21.039]回过神来", {
    role: "translation",
    sourceId: "source:translation",
  });
  const model = buildUnifiedLyric({ main, translation });
  const output = exportEnhancedLrc(model, { includeTranslation: true, includeRomanization: true });

  assert.match(output, /^\[00:21\.039\]<00:21\.039>気<00:21\.343>づ<00:23\.272>/m);
  assert.match(output, /^\[00:21\.039\]回过神来$/m);
  assert.equal(output.includes("roman"), false);
  assert.ok(output.endsWith("\n"));
});

test("a timed title and credit block before a long gap is removed conservatively", () => {
  const channel = parseLyricChannel([
    "[00:00.20]Song - Artist[00:01.00]",
    "[00:00.20]Copyright holder owns this translation[00:01.00]",
    "[00:01.10]词：Writer[00:02.00]",
    "[00:02.10]曲：Composer[00:03.00]",
    "[00:20.00]Actual lyric[00:21.00]",
  ].join("\n"), { role: "main", format: "lrc" });

  assert.deepEqual(channel.lines.map((line) => line.text), ["Actual lyric"]);
  assert.deepEqual(channel.diagnostics, [{ code: "leading_credit_block", removedLines: 4 }]);
});

test("a normal opening line is preserved when there is no verified credit block", () => {
  const channel = parseLyricChannel([
    "[00:00.00]Opening lyric[00:01.00]",
    "[00:10.00]Next lyric[00:11.00]",
  ].join("\n"), { role: "main", format: "lrc" });

  assert.deepEqual(channel.lines.map((line) => line.text), ["Opening lyric", "Next lyric"]);
  assert.deepEqual(channel.diagnostics, []);
});

test("plain QRC preserves explicit line and word durations", () => {
  const channel = parseLyricChannel(
    "[1000,1200]你(1000,400)好(1400,800)",
    { format: "qrc" },
  );

  assert.equal(channel.lines.length, 1);
  assert.equal(channel.lines[0].startMs, 1000);
  assert.equal(channel.lines[0].endMs, 2200);
  assert.deepEqual(channel.lines[0].words.map((word) => [word.text, word.startMs, word.endMs]), [
    ["你", 1000, 1400],
    ["好", 1400, 2200],
  ]);
  assert.equal(channel.qualityLevel, "word_with_end");
});

test("QRC XML entities decode before parsing timed content", () => {
  const xml = "<QrcInfos><LyricInfo><Lyric_1 LyricContent=\"[ti:Song]&#10;[1000,500]A&amp;(1000,500)\" LyricType=\"1\"/></LyricInfo></QrcInfos>";
  const channel = parseLyricChannel(xml, { format: "qrc" });

  assert.equal(channel.lines.length, 1);
  assert.equal(channel.lines[0].text, "A&");
  assert.equal(channel.lines[0].words[0].text, "A&");
  assert.equal(channel.lines[0].words[0].endMs, 1500);
});

test("QRC with non-monotonic word time keeps the line without unsafe karaoke", () => {
  const channel = parseLyricChannel(
    "[1000,1000]A(1500,300)B(1200,300)",
    { format: "qrc" },
  );

  assert.equal(channel.lines[0].text, "AB");
  assert.equal(channel.lines[0].words.length, 0);
  assert.ok(channel.lines[0].flags.includes("qrc_word_time_non_monotonic"));
  assert.equal(channel.qualityLevel, "line");
});
