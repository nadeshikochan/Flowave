const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const {
  isSupportedLyricPathForAudio,
  legacyLyricPathForAudio,
  legacyPartitionLyricPathForAudio,
  libraryLyricRoot,
  mirroredLyricRootForAudio,
  preferredLyricPathForAudio,
} = require("../lyrics/mirrored-lyric-paths");

test("MusicDownloader tracks map to the same relative directory under the KTV root", () => {
  const audioRoot = path.resolve("D:/Library");
  const audio = path.join(audioRoot, "MusicDownloader", "ogg_music", "Singer - Song.ogg");
  const lyricRoot = path.join(audioRoot, "KTV歌词", "MusicDownloader", "ogg_music");

  assert.equal(libraryLyricRoot(audioRoot), path.join(audioRoot, "KTV歌词"));
  assert.equal(mirroredLyricRootForAudio(audio, audioRoot), lyricRoot);
  assert.equal(preferredLyricPathForAudio(audio, audioRoot), path.join(lyricRoot, "Singer - Song.lrc"));
});

test("lx.music part4 tracks map beneath KTV歌词/lx.music/part4", () => {
  const audioRoot = path.resolve("D:/Library");
  const audio = path.join(audioRoot, "lx.music", "part4", "Singer - Song.mp3");
  assert.equal(
    preferredLyricPathForAudio(audio, audioRoot),
    path.join(audioRoot, "KTV歌词", "lx.music", "part4", "Singer - Song.lrc"),
  );
});

test("paths outside the music root and tracks inside KTV歌词 cannot recurse into the mirror", () => {
  const audioRoot = path.resolve("D:/Library");
  assert.equal(mirroredLyricRootForAudio(path.resolve("D:/Elsewhere/Song.mp3"), audioRoot), "");
  assert.equal(mirroredLyricRootForAudio(path.join(audioRoot, "KTV歌词", "Song.mp3"), audioRoot), "");
});

test("recovery accepts mirror, former same-directory and former partition-local targets", () => {
  const audioRoot = path.resolve("D:/Library");
  const audio = path.join(audioRoot, "lx.music", "part2", "Singer - Song.mp3");
  assert.equal(isSupportedLyricPathForAudio(audio, preferredLyricPathForAudio(audio, audioRoot), audioRoot), true);
  assert.equal(isSupportedLyricPathForAudio(audio, legacyLyricPathForAudio(audio), audioRoot), true);
  assert.equal(isSupportedLyricPathForAudio(audio, legacyPartitionLyricPathForAudio(audio), audioRoot), true);
  assert.equal(isSupportedLyricPathForAudio(audio, path.resolve("D:/Elsewhere/Singer - Song.lrc"), audioRoot), false);
});
