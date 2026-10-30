(function initLyricModelAdapter(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LyricModelAdapter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function lyricModelAdapterFactory() {
  "use strict";

  const SUPPORTED_SCHEMA_VERSION = 1;
  const MAX_LINES = 50000;

  function finiteSeconds(milliseconds) {
    if (milliseconds === null || milliseconds === undefined || milliseconds === "") return NaN;
    const value = Number(milliseconds);
    if (!Number.isFinite(value) || value < 0) return NaN;
    return value / 1000;
  }

  function fragmentText(fragment) {
    return String(fragment?.text || "");
  }

  function rendererWords(fragment, lineTiming = {}) {
    const words = (Array.isArray(fragment?.words) ? fragment.words : [])
      .map((word) => {
        const time = finiteSeconds(word?.startMs);
        const rawEnd = finiteSeconds(word?.endMs);
        const text = String(word?.text || "");
        if (!Number.isFinite(time) || !text) return null;
        return {
          time,
          endTime: Number.isFinite(rawEnd) && rawEnd >= time ? rawEnd : null,
          text,
        };
      })
      .filter(Boolean);
    if (words.length) return words;

    // 普通定时 LRC 没有独立字时间片。桌面与软件内歌词仍按整句有效区间
    // 连续扫过；带真实字时间片的歌词始终走上面的精确分支。
    const text = fragmentText(fragment);
    const time = finiteSeconds(lineTiming?.startMs);
    const endTime = finiteSeconds(lineTiming?.endMs);
    if (!text || !Number.isFinite(time) || !Number.isFinite(endTime) || endTime <= time) return [];
    return [{ time, endTime, text }];
  }

  function syncedLines(model) {
    const source = Array.isArray(model?.lines) ? model.lines.slice(0, MAX_LINES) : [];
    const lines = source
      .map((line) => {
        const time = finiteSeconds(line?.startMs);
        if (!Number.isFinite(time)) return null;
        const rawEnd = finiteSeconds(line?.endMs);
        const main = fragmentText(line?.main);
        const sub = fragmentText(line?.translation);
        const romanization = fragmentText(line?.romanization);
        if (!main && !sub && !romanization) return null;
        return {
          time,
          endTime: Number.isFinite(rawEnd) && rawEnd >= time ? rawEnd : null,
          main,
          sub,
          romanization,
          words: rendererWords(line?.main, {
            startMs: line?.startMs,
            endMs: line?.endMs,
          }),
          synced: true,
        };
      })
      .filter(Boolean)
      .sort((left, right) => left.time - right.time);
    return lines;
  }

  function plainLines(model) {
    const split = (value) => String(value || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
    const main = split(model?.plain?.main);
    const translation = split(model?.plain?.translation);
    const romanization = split(model?.plain?.romanization);
    const count = Math.min(MAX_LINES, Math.max(main.length, translation.length, romanization.length));
    return Array.from({ length: count }, (_, index) => ({
      time: index,
      endTime: null,
      main: main[index] || "",
      sub: translation[index] || "",
      romanization: romanization[index] || "",
      words: [],
      synced: false,
    })).filter((line) => line.main || line.sub || line.romanization);
  }

  function toRendererLyrics(model) {
    if (!model || typeof model !== "object" || Array.isArray(model)) return null;
    if (Number(model.schemaVersion) !== SUPPORTED_SCHEMA_VERSION) return null;
    const lines = model.synced ? syncedLines(model) : plainLines(model);
    return {
      lines,
      synced: Boolean(model.synced && lines.length),
      schemaVersion: SUPPORTED_SCHEMA_VERSION,
    };
  }

  return {
    MAX_LINES,
    SUPPORTED_SCHEMA_VERSION,
    finiteSeconds,
    rendererWords,
    toRendererLyrics,
  };
});
