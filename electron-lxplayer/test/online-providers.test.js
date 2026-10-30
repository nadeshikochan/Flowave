const assert = require("node:assert/strict");
const test = require("node:test");

const { __test } = require("../online/providers");

test("online provider cover fields are normalized for Kuwo and Kugou", () => {
  assert.equal(
    __test.normalizeCoverUrl("120/120/albumcover/a/b.jpg", "kw"),
    "https://img1.kuwo.cn/star/albumcover/400/400/a/b.jpg",
  );
  assert.equal(
    __test.normalizeCoverUrl("http://imge.kugou.com/stdmusic/{size}/cover.jpg", "kg"),
    "https://imge.kugou.com/stdmusic/400/cover.jpg",
  );
  assert.equal(
    __test.normalizeCoverUrl("/data/oss/resource/cover.webp", "mg"),
    "https://d.musicapp.migu.cn/data/oss/resource/cover.webp",
  );
});

test("QQ tracks derive a usable high resolution cover from album mid", () => {
  const track = __test.buildTrack("tx", {
    songmid: "song-mid",
    name: "Title",
    singer: [{ name: "Singer" }],
    album: { name: "Album", mid: "album-mid" },
    types: [],
  });

  assert.equal(track.artist, "Singer");
  assert.equal(track.album, "Album");
  assert.equal(track.cover, "https://y.qq.com/music/photo_new/T002R500x500M000album-mid.jpg");
});

test("plain QQ and Kugou LRC payloads become unified timed lyrics without crypto", () => {
  const result = __test.adaptPlainLyricChannels({
    source: "qq-music",
    main: "[00:01.00]Main",
    translation: "[00:01.00]翻译",
  });

  assert.equal(result.lyricsModel.lines[0].main.text, "Main");
  assert.equal(result.lyricsModel.lines[0].translation.text, "翻译");
  assert.equal(result.provenance.provider, "qq-music");
});

test("Kuwo timed rows become a unified line-timed lyric", () => {
  const result = __test.adaptKuwoLyricPayload({
    data: { lrclist: [{ time: "1.25", lineLyric: "Main" }, { time: "3", lineLyric: "Next" }] },
  });
  assert.equal(result.lyricsModel.lines[0].startMs, 1250);
  assert.equal(result.lyricsModel.lines[0].main.text, "Main");
  assert.equal(result.provenance.provider, "kuwo");
});
