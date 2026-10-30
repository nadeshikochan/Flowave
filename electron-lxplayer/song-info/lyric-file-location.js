"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Resolve in the main process; the renderer never supplies an arbitrary lyric path.
async function lyricFileLocation(store, trackPath, stat = fs.promises.stat) {
  const inspected = await store.inspect(trackPath);
  const base = path.join(path.dirname(inspected.audioPath), path.basename(inspected.audioPath, path.extname(inspected.audioPath)));
  const candidates = [inspected.sidecarPath, ...[".lrc", ".yrc", ".qrc", ".txt", ".lyric", ".lyrics"].map(ext => base + ext)];
  for (const candidate of [...new Set(candidates)]) {
    try {
      if ((await stat(candidate)).isFile()) return { inspected, filePath: candidate };
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error;
    }
  }
  return { inspected, filePath: "" };
}

module.exports = { lyricFileLocation };
