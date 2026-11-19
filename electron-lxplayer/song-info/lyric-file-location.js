"use strict";

const fs = require("node:fs");
const path = require("node:path");

// Resolve in the main process; the renderer never supplies an arbitrary lyric path.
async function lyricFileLocation(store, trackPath, stat = fs.promises.stat) {
  const inspected = await store.inspect(trackPath, { stateOnly: true });
  if (inspected.version.exists) return { inspected, filePath: inspected.sidecarPath };
  const base = path.join(path.dirname(inspected.audioPath), path.basename(inspected.audioPath, path.extname(inspected.audioPath)));
  const candidates = [".lrc", ".yrc", ".qrc", ".txt", ".lyric", ".lyrics"].map(ext => base + ext);
  for (const candidate of candidates) {
    if (candidate === inspected.sidecarPath) continue;
    try {
      if ((await stat(candidate)).isFile()) return { inspected, filePath: candidate };
    } catch (error) {
      if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw error;
    }
  }
  return { inspected, filePath: "" };
}

module.exports = { lyricFileLocation };
