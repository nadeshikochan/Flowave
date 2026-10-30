"use strict";

const { inflateSync } = require("node:zlib");
const { MAX_TEXT_BYTES, MAX_LINES, MAX_TAGS_PER_LINE } = require("./unified-lyric");

// Independent implementation of the KRC container/relative-time wire format.
// No LDDC code, parser or cryptographic implementation is imported.
const CONTAINER_MASK = Buffer.from("404761775e3274475136312dced26e69", "hex");

function decodeKugouWordLyrics(base64) {
  const value = String(base64 || "").trim();
  if (!value || value.length > MAX_TEXT_BYTES * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("invalid KRC container");
  const container = Buffer.from(value, "base64");
  if (container.subarray(0, 4).toString("ascii") !== "krc1") throw new Error("unsupported KRC container");
  const payload = Buffer.alloc(container.length - 4);
  for (let i = 0; i < payload.length; i++) payload[i] = container[i + 4] ^ CONTAINER_MASK[i % CONTAINER_MASK.length];
  const text = inflateSync(payload, { maxOutputLength: MAX_TEXT_BYTES }).toString("utf8");
  if (text.includes("\0") || text.includes("\ufffd")) throw new Error("invalid KRC text");
  const lines = [];
  const offsetTag = text.match(/^\[offset:\s*(-?\d+)\s*\]/im);
  const offset = offsetTag ? Number(offsetTag[1]) : 0;
  if (!Number.isSafeInteger(offset) || Math.abs(offset) > 3600000) throw new Error("invalid KRC offset");
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.match(/^\[(\d+),(\d+)\](.*)$/);
    if (!match) continue;
    const start = Number(match[1]), duration = Number(match[2]);
    if (!Number.isSafeInteger(start + duration) || start + duration > 86400000) throw new Error("invalid KRC time");
    const words = [];
    for (const word of match[3].matchAll(/<(\d+),(\d+),-?\d+>([^<]*)/g)) {
      const relative = Number(word[1]), length = Number(word[2]);
      if (!Number.isSafeInteger(relative + length) || relative + length > duration + 250) throw new Error("invalid KRC word time");
      words.push({ startMs: Math.max(0, start + relative + offset), endMs: Math.max(0, start + relative + length + offset), text: word[3], flags: [] });
      if (words.length > MAX_TAGS_PER_LINE) throw new Error("KRC too complex");
    }
    const mainText = match[3].replace(/<\d+,\d+,-?\d+>/g, "");
    if (!mainText.trim()) continue;
    lines.push({ startMs: Math.max(0, start + offset), endMs: Math.max(0, start + duration + offset),
      main: { text: mainText, words },
      translation: { text: "", words: [] }, romanization: { text: "", words: [] } });
    if (lines.length > MAX_LINES) throw new Error("KRC too complex");
  }
  if (!lines.length) throw new Error("KRC has no lyrics");
  lines.sort((a, b) => a.startMs - b.startMs);
  return { schemaVersion: 1, synced: true, offsetMs: 0, lines,
    plain: { main: "", translation: "", romanization: "" }, channels: { main: { language: "", sourceId: "online:kugou:krc" } },
    provenance: { provider: "kugou", qualityLevel: lines.some(line => line.main.words.length) ? "word_with_end" : "line", identityReason: "online_song_id" } };
}

module.exports = { decodeKugouWordLyrics };
