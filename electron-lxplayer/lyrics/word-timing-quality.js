"use strict";

// Counts source timing only. The renderer's sentence sweep is never passed here.
function wordTimingQuality(model) {
  const lines = (Array.isArray(model?.lines) ? model.lines : []).filter(line => String(line?.main?.text || "").trim());
  let timedLines = 0, endedLines = 0, words = 0, totalText = 0, timedText = 0;
  for (const line of lines) {
    const textLength = String(line.main.text).replace(/\s/gu, "").length;
    totalText += textLength;
    const valid = (Array.isArray(line.main?.words) ? line.main.words : []).filter(word =>
      String(word?.text || "").trim() && Number.isInteger(word.startMs) && word.startMs >= 0);
    if (!valid.length) continue;
    timedText += Math.min(textLength, valid.reduce((sum, word) => sum + String(word.text).replace(/\s/gu, "").length, 0));
    words += valid.length; timedLines += 1;
    if (valid.every(word => Number.isInteger(word.endMs) && word.endMs >= word.startMs
      && !(word.flags || []).includes("end_inferred"))) endedLines += 1;
  }
  const coverage = lines.length ? timedLines / lines.length : 0;
  const endCoverage = lines.length ? endedLines / lines.length : 0;
  const textCoverage = totalText ? timedText / totalText : 0;
  return { lines: lines.length, timedLines, words, coverage, endCoverage, textCoverage,
    complete: lines.length > 0 && coverage >= 0.9 && endCoverage >= 0.9 && textCoverage >= 0.9
      && model?.provenance?.qualityLevel !== "word_start_only" };
}

module.exports = { wordTimingQuality };
