"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createLddcStrategyLyricProvider, coarseScore } = require("../lyrics/lddc-strategy-provider");
const { buildUnifiedLyric, parseLyricChannel } = require("../lyrics/unified-lyric");

function model(text = "[00:01.000]<00:01.000>A<00:01.400>B<00:01.800>") {
  return buildUnifiedLyric({ main: parseLyricChannel(text, { role: "main" }) });
}

test("LDDC strategy searches QQ, Kugou and Netease and retries each source by title", async () => {
  const calls = [];
  const provider = createLddcStrategyLyricProvider({
    searchMusic: async (source, keyword) => {
      calls.push(`${source}:${keyword}`);
      if (keyword !== "Song") return { list: [{ source, songId: "bad", title: "Other", artist: "Other", duration: 180 }] };
      return { list: [{ source, songId: `${source}-1`, title: "Song", artist: "Singer", album: "Album", duration: 180 }] };
    },
    getLyric: async () => ({ lyricsModel: model() }),
  });

  const candidates = await provider.query({
    evidence: { title: "Song", artists: ["Singer"], album: "Album", durationSeconds: 180 },
  });

  assert.deepEqual(candidates.map((item) => item.sourceRecordId), ["tx:tx-1", "kg:kg-1", "wy:wy-1"]);
  assert.equal(calls.length, 6);
  assert.ok(candidates.every((item) => item.providerPriority === 100));
});

test("LDDC strategy stops early after the second candidate supplies complete word timing", async () => {
  const fetched = [];
  const provider = createLddcStrategyLyricProvider({
    searchMusic: async (source) => ({
      list: [1, 2, 3].map((rank) => ({ source, songId: `${source}-${rank}`, title: "Song", artist: "Singer", duration: 180 })),
    }),
    getLyric: async (source, songId) => {
      fetched.push(songId);
      return { lyricsModel: songId.endsWith("-2") ? model() : null };
    },
  });

  const candidates = await provider.query({ evidence: { title: "Song", artists: ["Singer"], durationSeconds: 180 } });

  assert.equal(candidates.length, 3);
  assert.deepEqual(fetched.sort(), ["kg-1", "kg-2", "tx-1", "tx-2", "wy-1", "wy-2"]);
  assert.ok(fetched.every((id) => !id.endsWith("-3")));
});

test("coarse LDDC filtering rejects title, artist and duration conflicts", () => {
  const evidence = { title: "Song", artists: ["Singer"], durationSeconds: 180 };
  assert.ok(coarseScore(evidence, { title: "Song", artist: "Singer", duration: 180 }) > 0);
  assert.equal(coarseScore(evidence, { title: "Other", artist: "Singer", duration: 180 }), -1);
  assert.equal(coarseScore(evidence, { title: "Song", artist: "Other", duration: 180 }), -1);
  assert.equal(coarseScore(evidence, { title: "Song", artist: "Singer", duration: 185 }), -1);
});
