const assert = require("node:assert/strict");
const test = require("node:test");

const { toRendererLyrics } = require("../renderer/lyric-model-adapter");

test("unified word end times reach renderer karaoke state", () => {
  const result = toRendererLyrics({
    schemaVersion: 1,
    synced: true,
    lines: [{
      startMs: 1000,
      endMs: 2500,
      main: {
        text: "Hello",
        words: [{ startMs: 1000, endMs: 1400, text: "Hel" }, { startMs: 1400, endMs: 1800, text: "lo" }],
      },
      translation: { text: "你好", words: [] },
      romanization: { text: "ni hao", words: [] },
    }],
  });

  assert.equal(result.synced, true);
  assert.deepEqual(result.lines[0], {
    time: 1,
    endTime: 2.5,
    main: "Hello",
    sub: "你好",
    romanization: "ni hao",
    words: [
      { time: 1, endTime: 1.4, text: "Hel" },
      { time: 1.4, endTime: 1.8, text: "lo" },
    ],
    synced: true,
  });
});

test("plain unified channels stay unsynchronised without invented timestamps", () => {
  const result = toRendererLyrics({
    schemaVersion: 1,
    synced: false,
    lines: [],
    plain: {
      main: "First\nSecond",
      translation: "第一行\n第二行",
      romanization: "",
    },
  });

  assert.equal(result.synced, false);
  assert.equal(result.lines.length, 2);
  assert.deepEqual(result.lines.map((line) => [line.main, line.sub]), [
    ["First", "第一行"],
    ["Second", "第二行"],
  ]);
  assert.ok(result.lines.every((line) => line.words.length === 0 && line.synced === false));
});

test("unknown schemas and malformed timed lines fall back to legacy parsing", () => {
  assert.equal(toRendererLyrics({ schemaVersion: 2, synced: true, lines: [] }), null);
  assert.deepEqual(toRendererLyrics({
    schemaVersion: 1,
    synced: true,
    lines: [{ startMs: "bad", main: { text: "Ignored" } }],
  }), { lines: [], synced: false, schemaVersion: 1 });
});

test("missing end times remain missing instead of becoming zero", () => {
  const result = toRendererLyrics({
    schemaVersion: 1,
    synced: true,
    lines: [{
      startMs: 0,
      endMs: null,
      main: { text: "A", words: [{ startMs: 0, endMs: null, text: "A" }] },
      translation: { text: "", words: [] },
      romanization: { text: "", words: [] },
    }],
  });

  assert.equal(result.lines[0].endTime, null);
  assert.equal(result.lines[0].words[0].endTime, null);
});
