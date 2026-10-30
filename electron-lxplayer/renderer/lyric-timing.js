(function exposeLyricTiming(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.LyricTiming = api;
})(typeof globalThis !== "undefined" ? globalThis : this, () => {
  const finite = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));

  function wordState(line, currentTime, nextLineTime = NaN) {
    const result = { wordIndex: -1, wordProgress: 0 };
    const words = Array.isArray(line?.words) ? line.words : [];
    const time = Number(currentTime);
    if (!words.length || !Number.isFinite(time)) return result;
    // 解析器已按时间排序。二分查询也覆盖同时起唱的时间片。
    let low = 0, high = words.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (Number(words[mid].time) <= time) low = mid + 1;
      else high = mid;
    }
    const index = low - 1;
    if (index < 0) return result;
    const word = words[index];
    const start = Number(word.time);
    const next = words[index + 1]?.time;
    const explicitEnd = finite(word.endTime) && Number(word.endTime) >= start ? Number(word.endTime) : NaN;
    const lineEnd = finite(line?.endTime) && Number(line.endTime) >= start ? Number(line.endTime) : NaN;
    const end = Number.isFinite(explicitEnd) ? explicitEnd
      : finite(next) && Number(next) >= start ? Number(next)
        : Number.isFinite(lineEnd) ? lineEnd
          : finite(nextLineTime) && Number(nextLineTime) > start ? Number(nextLineTime) : start + 0.35;
    result.wordIndex = index;
    // 显式短音节和零长度时间片不得被人为拉长。
    result.wordProgress = end <= start ? 1 : Math.min(1, Math.max(0, (time - start) / (end - start)));
    return result;
  }

  function clockTime({ baseTime, baseAt, now, playing, playbackRate = 1, maxAdvanceMs = 250 }) {
    const base = Math.max(0, Number(baseTime) || 0);
    if (!playing) return base;
    const elapsed = Math.min(Math.max(0, Number(maxAdvanceMs) || 0), Math.max(0, Number(now) - Number(baseAt)));
    const rate = Number(playbackRate);
    return base + elapsed / 1000 * (Number.isFinite(rate) && rate > 0 ? rate : 1);
  }
  return { wordState, clockTime };
});
