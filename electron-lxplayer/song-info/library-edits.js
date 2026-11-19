"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { writeJsonObjectAtomic } = require("../async-json-writer");

const textFields = ["title", "album", "releaseDate"];
const listFields = ["artists", "albumArtists", "genres", "composers", "lyricists", "isrcs"];
const numberFields = ["trackNumber", "trackTotal", "discNumber", "discTotal"];
const editableFields = [...textFields, ...listFields, ...numberFields];

class LibraryEdits {
  constructor(file) {
    this.file = file;
    this.tail = Promise.resolve();
  }

  load() {
    this.loading ||= fs.readFile(this.file, "utf8").then(text => {
      const data = JSON.parse(text);
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("歌曲资料文件损坏");
      return this.entries = new Map(Object.entries(data));
    }, error => {
      if (error.code !== "ENOENT") throw error;
      return this.entries = new Map();
    });
    return this.loading;
  }

  key(trackPath, resourceId) {
    return resourceId ? `resource:${resourceId}` : `path:${path.normalize(trackPath).toLowerCase()}`;
  }

  async apply(info, trackPath, resourceId) {
    const entries = this.entries || await this.load();
    const edits = entries.get(this.key(trackPath, resourceId));
    if (!edits) return info;
    const { coverFile, lyricsHidden } = edits;
    const fields = Object.fromEntries(editableFields.filter(field => Object.hasOwn(edits, field))
      .map(field => [field, edits[field]]));
    const next = { ...info, ...fields, libraryEdits: Object.keys(fields).length > 0 || typeof coverFile === "string",
      libraryIdentityEdited: Object.hasOwn(fields, "title") || Object.hasOwn(fields, "artists"),
      lyricsHidden: lyricsHidden === true };
    if (Object.hasOwn(fields, "title")) {
      next.editableTitle = fields.title;
      next.title = fields.title || path.basename(trackPath, path.extname(trackPath));
    }
    if (fields.artists) next.artist = fields.artists.join("、");
    if (fields.albumArtists) next.albumArtist = fields.albumArtists.join("、");
    if (coverFile === "" || /^[a-f0-9]{64}\.png$/.test(coverFile || "")) {
      next.cover = next.cover_thumb = coverFile ? path.join(path.dirname(this.file), "artwork", coverFile) : "";
    }
    if (lyricsHidden) Object.assign(next, { lyrics: "", lyricsModel: null, lyricsStatus: "missing", lyricsProvenance: null });
    return next;
  }

  update(trackPath, resourceId, updates, { reset = false, coverFile } = {}) {
    const job = this.tail.then(async () => {
      const entries = this.entries || await this.load();
      const key = this.key(trackPath, resourceId);
      const edits = { ...entries.get(key) };
      if (reset) {
        for (const field of [...editableFields, "coverFile"]) delete edits[field];
      } else {
        for (const field of textFields) {
          if (typeof updates[field] === "string") edits[field] = updates[field].trim().slice(0, 500);
        }
        for (const field of listFields) {
          if (Array.isArray(updates[field])) edits[field] = updates[field].filter(value => typeof value === "string")
            .slice(0, 100).map(value => value.trim().slice(0, 500)).filter(Boolean);
        }
        for (const field of numberFields) {
          if (!Object.hasOwn(updates, field)) continue;
          const value = updates[field] === "" ? 0 : Number(updates[field]);
          if (!Number.isSafeInteger(value) || value < 0) throw new Error("曲号与碟号须为非负整数");
          edits[field] = value;
        }
        if (typeof coverFile === "string") edits.coverFile = coverFile;
        if (updates.lyricsHidden === true) edits.lyricsHidden = true;
        if (updates.lyricsHidden === false) delete edits.lyricsHidden;
      }
      const next = new Map(entries);
      if (Object.keys(edits).length) next.set(key, edits);
      else next.delete(key);
      await writeJsonObjectAtomic(this.file, next);
      this.entries = next;
    });
    this.tail = job.catch(() => {});
    return job;
  }
}

module.exports = { LibraryEdits };
