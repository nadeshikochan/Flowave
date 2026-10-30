(function initLyricUtils(global) {
  function parseTimestamp(mm, ss) {
    const normMM = String(mm || "").trim();
    const normSS = String(ss || "").trim().replace(",", ".");
    const m = parseInt(normMM, 10);
    const s = parseFloat(normSS);
    if (!Number.isFinite(m) || !Number.isFinite(s)) return NaN;
    return m * 60 + s;
  }

  function parseInlineKaraoke(text) {
    const source = String(text || "");
    const wordTagRe = /<\s*(\d+)\s*[:：]\s*(\d+(?:[.,]-?\d+)?)\s*>/g;
    const matches = Array.from(source.matchAll(wordTagRe));
    if (!matches.length) return { plain: source.trim(), words: [] };
    const words = [];
    for (let i = 0; i < matches.length; i++) {
      const cur = matches[i];
      const next = matches[i + 1];
      const start = parseTimestamp(cur[1], cur[2]);
      if (!Number.isFinite(start)) continue;
      const startIdx = cur.index + cur[0].length;
      const endIdx = next ? next.index : source.length;
      const wordText = source.slice(startIdx, endIdx);
      if (!wordText || !wordText.trim()) continue;
      words.push({ time: start, text: wordText });
    }
    const plain = source.replace(wordTagRe, "").trim();
    return { plain, words };
  }

  function parseRepeatedTimeTaggedWords(line) {
    const source = String(line || "");
    const repeatedTagRe = /[\[［]\s*(\d+)\s*[:：]\s*(\d+(?:[.,]\d+)?)\s*[\]］]/g;
    const matches = Array.from(source.matchAll(repeatedTagRe));
    if (matches.length < 2) return null;
    const words = [];
    for (let i = 0; i < matches.length; i++) {
      const cur = matches[i];
      const next = matches[i + 1];
      const start = parseTimestamp(cur[1], cur[2]);
      if (!Number.isFinite(start)) continue;
      const startIdx = cur.index + cur[0].length;
      const endIdx = next ? next.index : source.length;
      const text = source.slice(startIdx, endIdx);
      if (!text || !text.trim()) continue;
      words.push({ time: start, text });
    }
    if (!words.length) return null;
    return {
      time: words[0].time,
      text: words.map((w) => w.text).join("").trim(),
      words,
    };
  }

  function parseYrcLine(line) {
    const source = String(line || "").trim();
    if (!source) return null;
    const lineMatch = source.match(/^[\s]*[\[［]\s*(\d+)\s*[,，]\s*(\d+)\s*[\]］]\s*(.*)$/);
    if (!lineMatch) return null;
    const lineStartMs = Number(lineMatch[1]);
    const body = String(lineMatch[3] || "");
    if (!Number.isFinite(lineStartMs) || !body) return null;
    const wordTagRe = /[\(（]\s*(\d+)\s*[,，]\s*(\d+)(?:\s*[,，]\s*[-\d]+)?\s*[\)）]/g;
    const matches = Array.from(body.matchAll(wordTagRe));
    if (!matches.length) return null;
    const words = [];
    const rawStarts = matches
      .map((match) => Number(match[1]))
      .filter((value) => Number.isFinite(value));
    const wordsUseRelativeTime = rawStarts.length > 0 && lineStartMs > 1000 && rawStarts[0] < Math.max(1000, lineStartMs - 1000);
    for (let i = 0; i < matches.length; i++) {
      const cur = matches[i];
      const next = matches[i + 1];
      const rawStartMs = Number(cur[1]);
      const startMs = wordsUseRelativeTime ? lineStartMs + rawStartMs : rawStartMs;
      if (!Number.isFinite(startMs)) continue;
      const startIdx = cur.index + cur[0].length;
      const endIdx = next ? next.index : body.length;
      const text = body.slice(startIdx, endIdx);
      if (!text || !text.trim()) continue;
      words.push({
        time: Math.max(0, startMs) / 1000,
        text,
      });
    }
    if (!words.length) return null;
    return {
      time: Math.max(0, lineStartMs) / 1000,
      text: words.map((word) => word.text).join("").trim(),
      words,
    };
  }

  function looksLikeRomanized(text) {
    if (!text) return false;
    if (/[一-龥ぁ-んァ-ヶ]/.test(text)) return false;
    return /[A-Za-z]/.test(text);
  }

  function splitMainAndSub(text) {
    const input = String(text || "");
    const candidates = [" / ", "｜", " - ", " — "];
    for (const sep of candidates) {
      const parts = input.split(sep);
      if (parts.length === 2 && parts[0].trim() && parts[1].trim()) {
        return { main: parts[0].trim(), sub: parts[1].trim() };
      }
    }
    return { main: input.trim(), sub: "" };
  }

  function isLikelyLyricMetaText(text) {
    const raw = String(text || "").trim();
    if (!raw) return false;
    const compact = raw.replace(/\s+/g, "");
    if (/^(作词|作曲|编曲|词|曲|詞|編曲|歌|唱|演唱|vocal|artist|title|by)[:：]/i.test(raw)) return true;
    if (/^[\[(（【《].*(TVアニメ|TV动画|动画|片头曲|片尾曲|主题曲|OP|ED).*[)\]）》】]$/i.test(raw)) return true;
    if (/(TVアニメ|TV动画|动画|片头曲|片尾曲|主题曲|OP|ED)/i.test(raw) && /[《》「」()（）]/.test(raw)) return true;
    if (/^(終わり|终わり|end)$/i.test(compact)) return true;
    return false;
  }

  function filterLeadingMetaLines(lines) {
    const list = Array.isArray(lines) ? lines.slice() : [];
    let start = 0;
    while (start < list.length) {
      const line = list[start] || {};
      const text = [String(line.main || "").trim(), String(line.sub || "").trim()].filter(Boolean).join(" ");
      const time = Number(line.time);
      if (Number.isFinite(time) && time <= 15 && isLikelyLyricMetaText(text)) {
        start += 1;
        continue;
      }
      break;
    }
    return start > 0 && start < list.length ? list.slice(start) : list;
  }

  function parseOffsetSeconds(text) {
    const source = String(text || "");
    const match = source.match(/[\[［]\s*offset\s*[:：]\s*([+-]?\d+)\s*[\]］]/i);
    if (!match) return 0;
    const offsetMs = Number(match[1]);
    if (!Number.isFinite(offsetMs)) return 0;
    return offsetMs / 1000;
  }

  function buildLyricLineFromGroup(group) {
    let main = "";
    let sub = "";
    let words = [];
    const normalized = group
      .map((x) => ({
        text: String(x.text || "").trim(),
        words: Array.isArray(x.words) ? x.words : [],
      }))
      .filter((x) => x.text);
    if (!normalized.length) return { main: "", sub: "", words: [] };
    const first = normalized[0];
    const split = splitMainAndSub(first.text);
    main = split.main;
    sub = split.sub;
    words = first.words || [];
    for (let i = 1; i < normalized.length; i++) {
      const t = normalized[i].text;
      if (!sub) {
        sub = t;
        continue;
      }
    }
    if (!main && sub) {
      main = sub;
      sub = "";
    }
    return { main, sub, words };
  }

  function parseLrc(text) {
    const parsed = [];
    const raw = String(text || "");
    const offsetSeconds = parseOffsetSeconds(raw);
    const sourceLines = raw.split(/\r?\n/);
    const lrcTimeTagRe = /[\[［]\s*(\d+)\s*[:：]\s*(\d+(?:[.,]-?\d+)?)\s*[\]］]/g;
    sourceLines.forEach((line) => {
      const yrcLine = parseYrcLine(line);
      if (yrcLine) {
        parsed.push(yrcLine);
        return;
      }
      const repeatedWordLine = parseRepeatedTimeTaggedWords(line);
      if (repeatedWordLine) {
        parsed.push(repeatedWordLine);
        return;
      }
      const tags = Array.from(line.matchAll(lrcTimeTagRe));
      if (!tags.length) return;
      const content = line.replace(lrcTimeTagRe, "").trim();
      if (!content) return;
      const wordInfo = parseInlineKaraoke(content);
      tags.forEach((tag) => {
        const t = parseTimestamp(tag[1], tag[2]);
        if (!Number.isFinite(t)) return;
        parsed.push({ time: t, text: wordInfo.plain, words: wordInfo.words });
      });
    });
    if (!parsed.length) {
      const plainLines = raw
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      if (!plainLines.length) return { lines: [], synced: false };
      return {
        lines: plainLines.map((line, idx) => ({
          time: idx,
          main: line,
          sub: "",
          words: [],
          synced: false,
        })),
        synced: false,
      };
    }
    const groups = new Map();
    parsed.forEach((item) => {
      const adjustedTime = Number(item.time) + offsetSeconds;
      if (!Number.isFinite(adjustedTime)) return;
      const adjustedWords = Array.isArray(item.words)
        ? item.words
          .map((word) => ({
            time: Math.max(0, Number(word?.time) + offsetSeconds),
            text: String(word?.text || ""),
          }))
          .filter((word) => Number.isFinite(word.time) && word.text)
        : [];
      const adjustedKey = Math.max(0, adjustedTime).toFixed(3);
      if (!groups.has(adjustedKey)) groups.set(adjustedKey, []);
      groups.get(adjustedKey).push({
        time: Math.max(0, adjustedTime),
        text: item.text,
        words: adjustedWords,
      });
    });
    const lines = Array.from(groups.entries())
      .map(([key, group]) => {
        const built = buildLyricLineFromGroup(group);
        return {
          time: Number(key),
          main: built.main,
          sub: built.sub,
          words: built.words,
          synced: true,
        };
      })
      .filter((x) => x.main || x.sub)
      .sort((a, b) => a.time - b.time);
    return { lines: filterLeadingMetaLines(lines), synced: true };
  }

  function clampActiveScale(value) {
    const n = Number(value) || 1.18;
    return Math.max(1.1, Math.min(1.35, n));
  }

  global.LyricUtils = {
    parseTimestamp,
    parseInlineKaraoke,
    parseRepeatedTimeTaggedWords,
    parseYrcLine,
    looksLikeRomanized,
    splitMainAndSub,
    parseOffsetSeconds,
    isLikelyLyricMetaText,
    filterLeadingMetaLines,
    buildLyricLineFromGroup,
    parseLrc,
    clampActiveScale,
  };
})(window);
