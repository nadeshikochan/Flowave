"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createMusicTagStrategyLyricProvider } = require("../lyrics/music-tag-strategy-provider");
const { buildUnifiedLyric, parseLyricChannel } = require("../lyrics/unified-lyric");

function model() {
  return buildUnifiedLyric({ main: parseLyricChannel("[00:01.00]Line", { role: "main" }) });
}

test("MusicTag fallback queries Kuwo and keeps only a safe usable candidate", async () => {
  const searches = [];
  const provider = createMusicTagStrategyLyricProvider({
    searchMusic: async (source, keyword) => {
      searches.push([source, keyword]);
      return { list: [{ source, songId: "123", title: "Song", artist: "Singer", duration: 180 }] };
    },
    getLyric: async () => ({ lyricsModel: model() }),
  });
  const candidates = await provider.query({ evidence: { title: "Song", artists: ["Singer"], durationSeconds: 180 } });
  assert.deepEqual(searches, [["kw", "Singer Song"]]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].sourceRecordId, "kw:123");
  assert.equal(candidates[0].providerPriority, 50);
});

test("MusicTag fallback rejects a duration conflict before fetching lyrics", async () => {
  let lyricCalls = 0;
  const provider = createMusicTagStrategyLyricProvider({
    searchMusic: async () => ({ list: [{ source: "kw", songId: "123", title: "Song", artist: "Singer", duration: 185 }] }),
    getLyric: async () => { lyricCalls += 1; return { lyricsModel: model() }; },
  });
  const candidates = await provider.query({ evidence: { title: "Song", artists: ["Singer"], durationSeconds: 180 } });
  assert.equal(candidates.length, 0);
  assert.equal(lyricCalls, 0);
});
