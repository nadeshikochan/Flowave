(function initUnifiedLyric(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FlowaveUnifiedLyric = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function unifiedLyricFactory() {
  "use strict";

  const SCHEMA_VERSION = 1;
  const PARSER_VERSION = "1.0.0";
  const MAX_TEXT_BYTES = 5 * 1024 * 1024;
  const MAX_LINES = 50000;
  const MAX_TAGS_PER_LINE = 2000;
  const CHANNEL_ROLES = new Set(["main", "translation", "romanization"]);
  const QUALITY_ORDER = Object.freeze({ plain: 0, line: 1, word_start_only: 2, word_with_end: 3 });
  const TIME_TAG_SOURCE = "[\\[［]\\s*(\\d+)\\s*[:：]\\s*(\\d+(?:[.,]\\d+)?)\\s*[\\]］]";
  const INLINE_TAG_SOURCE = "<\\s*(\\d+)\\s*[:：]\\s*(\\d+(?:[.,]\\d+)?)\\s*>";
  const QRC_WORD_TAG_SOURCE = "[\\(（]\\s*(\\d+)\\s*[,，]\\s*(\\d+)\\s*[\\)）]";

  class LyricModelError extends Error {
    constructor(message, code = "LYRIC_INVALID") {
      super(message);
      this.name = "LyricModelError";
      this.code = code;
    }
  }

  function utf8Length(value) {
    const text = String(value || "");
    if (typeof Buffer !== "undefined") return Buffer.byteLength(text, "utf8");
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(text).byteLength;
    return unescape(encodeURIComponent(text)).length;
  }

  function validateText(value) {
    const text = String(value || "").replace(/\r\n?/g, "\n");
    if (text.includes("\0")) throw new LyricModelError("lyric contains NUL", "LYRIC_NUL");
    if (utf8Length(text) > MAX_TEXT_BYTES) throw new LyricModelError("lyric is too large", "LYRIC_TOO_LARGE");
    const lines = text.split("\n");
    if (lines.length > MAX_LINES) throw new LyricModelError("lyric has too many lines", "LYRIC_TOO_MANY_LINES");
    return { text, lines };
  }

  function normalizeRole(role) {
    const value = String(role || "main");
    if (!CHANNEL_ROLES.has(value)) throw new LyricModelError("unknown lyric channel", "LYRIC_CHANNEL_INVALID");
    return value;
  }

  function toMs(minutes, seconds) {
    const minuteValue = Number(minutes);
    const secondValue = Number(String(seconds || "").replace(",", "."));
    if (!Number.isFinite(minuteValue) || !Number.isFinite(secondValue) || minuteValue < 0 || secondValue < 0) {
      return null;
    }
    return Math.round((minuteValue * 60 + secondValue) * 1000);
  }

  function parseOffsetMs(text) {
    const match = String(text || "").match(/[\[［]\s*offset\s*:\s*([+-]?\d+)\s*[\]］]/i);
    return match ? Number(match[1]) || 0 : 0;
  }

  function isMetadataLine(line) {
    return /^[\[［]\s*(?:ar|al|ti|au|by|tool|re|ve|length|offset)\s*:/i.test(String(line || ""));
  }

  function collectMatches(source, patternSource) {
    const matches = Array.from(String(source || "").matchAll(new RegExp(patternSource, "g")));
    if (matches.length > MAX_TAGS_PER_LINE) {
      throw new LyricModelError("lyric line has too many time tags", "LYRIC_TOO_MANY_TAGS");
    }
    return matches;
  }

  function applyOffset(timeMs, offsetMs, flags) {
    const value = Math.round(Number(timeMs) + Number(offsetMs || 0));
    if (!Number.isFinite(value)) return null;
    if (value < 0) {
      flags.push("offset_clamped");
      return 0;
    }
    return value;
  }

  function parseInlineWords(content, offsetMs, flags) {
    const matches = collectMatches(content, INLINE_TAG_SOURCE);
    if (!matches.length) return null;
    const words = [];
    for (let index = 0; index < matches.length; index += 1) {
      const match = matches[index];
      const next = matches[index + 1];
      const startMs = applyOffset(toMs(match[1], match[2]), offsetMs, flags);
      if (startMs === null) continue;
      const textStart = match.index + match[0].length;
      const textEnd = next ? next.index : content.length;
      const wordText = content.slice(textStart, textEnd);
      if (!wordText) continue;
      const nextMs = next ? applyOffset(toMs(next[1], next[2]), offsetMs, flags) : null;
      words.push({
        startMs,
        endMs: nextMs !== null && nextMs >= startMs ? nextMs : null,
        text: wordText,
        flags: [],
      });
    }
    if (!words.length) return null;
    return {
      text: content.replace(new RegExp(INLINE_TAG_SOURCE, "g"), "").trim(),
      words,
    };
  }

  function parseLrcSourceLine(line, offsetMs, sequence) {
    const source = String(line || "");
    const matches = collectMatches(source, TIME_TAG_SOURCE);
    if (!matches.length) return [];
    const flags = [];
    const segments = matches.map((match, index) => {
      const next = matches[index + 1];
      return source.slice(match.index + match[0].length, next ? next.index : source.length);
    });
    const hasInterleavedText = segments.slice(0, -1).some((segment) => segment.length > 0);

    if (matches.length >= 2 && hasInterleavedText) {
      const words = [];
      for (let index = 0; index < matches.length; index += 1) {
        const wordText = segments[index];
        if (!wordText) continue;
        const startMs = applyOffset(toMs(matches[index][1], matches[index][2]), offsetMs, flags);
        if (startMs === null) continue;
        const nextMatch = matches[index + 1];
        const endMs = nextMatch
          ? applyOffset(toMs(nextMatch[1], nextMatch[2]), offsetMs, flags)
          : null;
        words.push({
          startMs,
          endMs: endMs !== null && endMs >= startMs ? endMs : null,
          text: wordText,
          flags: endMs !== null && endMs < startMs ? ["negative_duration"] : [],
        });
      }
      if (!words.length) return [];
      const lastMatch = matches[matches.length - 1];
      const trailingEndMs = segments[segments.length - 1] === ""
        ? applyOffset(toMs(lastMatch[1], lastMatch[2]), offsetMs, flags)
        : null;
      const lastWord = words[words.length - 1];
      if (trailingEndMs !== null && trailingEndMs >= lastWord.startMs) lastWord.endMs = trailingEndMs;
      return [{
        startMs: words[0].startMs,
        endMs: lastWord.endMs,
        text: words.map((word) => word.text).join("").trim(),
        words,
        flags,
        sequence,
      }];
    }

    const content = source.slice(matches[matches.length - 1].index + matches[matches.length - 1][0].length).trim();
    if (!content) return [];
    const inline = parseInlineWords(content, offsetMs, flags);
    return matches.map((match, index) => {
      const startMs = applyOffset(toMs(match[1], match[2]), offsetMs, flags);
      return {
        startMs,
        endMs: null,
        text: inline?.text || content,
        words: inline?.words ? inline.words.map((word) => ({ ...word, flags: [...word.flags] })) : [],
        flags: [...flags],
        sequence: sequence + index / Math.max(1, matches.length),
      };
    }).filter((item) => item.startMs !== null);
  }

  function yrcWordMode(lineStartMs, lineDurationMs, rawWords, requestedMode) {
    if (["absolute", "relative"].includes(requestedMode)) return { mode: requestedMode, ambiguous: false };
    const lineEndMs = lineStartMs + Math.max(0, lineDurationMs);
    const absoluteFits = rawWords.every((word) => (
      word.startRaw >= Math.max(0, lineStartMs - 250)
      && word.startRaw <= lineEndMs + 250
    ));
    const relativeFits = rawWords.every((word) => (
      word.startRaw >= -250
      && word.startRaw <= lineDurationMs + 250
      && lineStartMs + word.startRaw <= lineEndMs + 250
    ));
    if (absoluteFits !== relativeFits) return { mode: absoluteFits ? "absolute" : "relative", ambiguous: false };
    return { mode: "", ambiguous: true };
  }

  function parseYrcSourceLine(line, offsetMs, sequence, requestedMode = "auto") {
    const source = String(line || "").trim();
    const lineMatch = source.match(/^[\s]*[\[［]\s*(\d+)\s*[,，]\s*(\d+)\s*[\]］]\s*(.*)$/);
    if (!lineMatch) return null;
    const lineStartRaw = Number(lineMatch[1]);
    const lineDurationMs = Number(lineMatch[2]);
    const body = String(lineMatch[3] || "");
    if (!Number.isFinite(lineStartRaw) || !Number.isFinite(lineDurationMs) || !body) return null;
    const wordMatches = collectMatches(body, "[\\(（]\\s*(-?\\d+)\\s*[,，]\\s*(\\d+)(?:\\s*[,，]\\s*-?\\d+)?\\s*[\\)）]");
    if (!wordMatches.length) return null;
    const rawWords = wordMatches.map((match, index) => ({
      startRaw: Number(match[1]),
      durationMs: Number(match[2]),
      text: body.slice(match.index + match[0].length, wordMatches[index + 1]?.index ?? body.length),
    })).filter((word) => Number.isFinite(word.startRaw) && Number.isFinite(word.durationMs) && word.text);
    if (!rawWords.length) return null;
    const mode = yrcWordMode(lineStartRaw, lineDurationMs, rawWords, requestedMode);
    const flags = mode.ambiguous ? ["word_time_ambiguous"] : [];
    const lineStartMs = applyOffset(lineStartRaw, offsetMs, flags);
    const lineEndMs = applyOffset(lineStartRaw + lineDurationMs, offsetMs, flags);
    const words = mode.mode ? rawWords.map((word) => {
      const rawStart = mode.mode === "relative" ? lineStartRaw + word.startRaw : word.startRaw;
      const startMs = applyOffset(rawStart, offsetMs, flags);
      const endMs = applyOffset(rawStart + Math.max(0, word.durationMs), offsetMs, flags);
      return {
        startMs,
        endMs,
        text: word.text,
        flags: word.durationMs < 0 ? ["negative_duration"] : [],
      };
    }).filter((word) => word.startMs !== null) : [];
    return {
      startMs: lineStartMs,
      endMs: lineEndMs !== null && lineEndMs >= lineStartMs ? lineEndMs : null,
      text: rawWords.map((word) => word.text).join("").trim(),
      words,
      flags,
      sequence,
    };
  }

  function decodeXmlEntities(value) {
    return String(value || "").replace(/&(?:#(\d+)|#x([\da-f]+)|amp|lt|gt|quot|apos);/giu, (entity, decimal, hexadecimal) => {
      if (decimal || hexadecimal) {
        const codePoint = Number.parseInt(decimal || hexadecimal, hexadecimal ? 16 : 10);
        if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
          return entity;
        }
        return String.fromCodePoint(codePoint);
      }
      const named = entity.toLowerCase();
      if (named === "&amp;") return "&";
      if (named === "&lt;") return "<";
      if (named === "&gt;") return ">";
      if (named === "&quot;") return "\"";
      if (named === "&apos;") return "'";
      return entity;
    });
  }

  function findXmlTagEnd(source, start) {
    let quote = "";
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === quote) quote = "";
        continue;
      }
      if (char === "\"" || char === "'") quote = char;
      else if (char === ">") return index;
    }
    return -1;
  }

  function parseXmlStartTagAttributes(tag) {
    const attributes = {};
    const source = String(tag || "");
    const firstSpace = source.search(/\s/u);
    let cursor = firstSpace;
    if (cursor < 0) return attributes;
    while (cursor < source.length) {
      while (cursor < source.length && /[\s/]/u.test(source[cursor])) cursor += 1;
      const nameStart = cursor;
      while (cursor < source.length && /[\w:.-]/u.test(source[cursor])) cursor += 1;
      if (cursor === nameStart) break;
      const name = source.slice(nameStart, cursor).toLowerCase();
      while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1;
      if (source[cursor] !== "=") continue;
      cursor += 1;
      while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1;
      const quote = source[cursor];
      if (quote !== "\"" && quote !== "'") continue;
      cursor += 1;
      const valueStart = cursor;
      while (cursor < source.length && source[cursor] !== quote) cursor += 1;
      if (cursor >= source.length) break;
      attributes[name] = decodeXmlEntities(source.slice(valueStart, cursor));
      cursor += 1;
    }
    return attributes;
  }

  function extractQrcLyricContent(value) {
    const source = String(value || "");
    const lowerSource = source.toLowerCase();
    let cursor = 0;
    let inspected = 0;
    while (cursor < source.length && inspected < 32) {
      const start = lowerSource.indexOf("<lyric_", cursor);
      if (start < 0) return null;
      const end = findXmlTagEnd(source, start);
      if (end < 0) return null;
      inspected += 1;
      const tag = source.slice(start, end + 1);
      const attributes = parseXmlStartTagAttributes(tag);
      if ((attributes.lyrictype === undefined || attributes.lyrictype === "1") && attributes.lyriccontent) {
        return attributes.lyriccontent.replace(/\r\n?/gu, "\n");
      }
      cursor = end + 1;
    }
    return null;
  }

  function parseQrcSourceLine(line, offsetMs, sequence) {
    const source = String(line || "").trim();
    const lineMatch = source.match(/^[\s]*[\[［]\s*(\d+)\s*[,，]\s*(\d+)\s*[\]］]\s*(.*)$/u);
    if (!lineMatch) return null;
    const lineStartRaw = Number(lineMatch[1]);
    const lineDurationMs = Number(lineMatch[2]);
    const body = String(lineMatch[3] || "");
    if (!Number.isInteger(lineStartRaw) || !Number.isInteger(lineDurationMs) || !body) return null;
    const flags = [];
    const lineStartMs = applyOffset(lineStartRaw, offsetMs, flags);
    const lineEndMs = applyOffset(lineStartRaw + lineDurationMs, offsetMs, flags);
    const wordMatches = collectMatches(body, QRC_WORD_TAG_SOURCE);
    if (!wordMatches.length) {
      return {
        startMs: lineStartMs,
        endMs: lineEndMs,
        text: body.trim(),
        words: [],
        flags,
        sequence,
      };
    }
    let cursor = 0;
    const rawWords = [];
    for (const match of wordMatches) {
      const wordText = body.slice(cursor, match.index);
      cursor = match.index + match[0].length;
      if (!wordText) continue;
      rawWords.push({
        startRaw: Number(match[1]),
        durationMs: Number(match[2]),
        text: wordText,
      });
    }
    const trailing = body.slice(cursor);
    const lineText = rawWords.map((word) => word.text).join("") + trailing;
    const monotonic = rawWords.every((word, index) => (
      Number.isInteger(word.startRaw)
      && Number.isInteger(word.durationMs)
      && word.durationMs >= 0
      && (index === 0 || word.startRaw >= rawWords[index - 1].startRaw)
    ));
    if (!rawWords.length || trailing || !monotonic) {
      if (trailing) flags.push("qrc_untimed_tail");
      if (!monotonic) flags.push("qrc_word_time_non_monotonic");
      return {
        startMs: lineStartMs,
        endMs: lineEndMs,
        text: lineText.trim(),
        words: [],
        flags,
        sequence,
      };
    }
    const words = rawWords.map((word) => ({
      startMs: applyOffset(word.startRaw, offsetMs, flags),
      endMs: applyOffset(word.startRaw + word.durationMs, offsetMs, flags),
      text: word.text,
      flags: [],
    }));
    if (rawWords.some((word) => (
      word.startRaw < lineStartRaw - 250
      || word.startRaw + word.durationMs > lineStartRaw + lineDurationMs + 250
    ))) {
      flags.push("qrc_word_time_outside_line");
    }
    return {
      startMs: lineStartMs,
      endMs: lineEndMs,
      text: lineText.trim(),
      words,
      flags,
      sequence,
    };
  }

  function finalizeTimedLines(rawLines) {
    const lines = rawLines
      .filter((line) => Number.isInteger(line.startMs) && line.startMs >= 0 && line.text)
      .sort((left, right) => left.startMs - right.startMs || left.sequence - right.sequence)
      .map((line) => ({
        startMs: line.startMs,
        endMs: Number.isInteger(line.endMs) && line.endMs >= line.startMs ? line.endMs : null,
        text: String(line.text || ""),
        words: (line.words || []).map((word) => ({
          startMs: word.startMs,
          endMs: Number.isInteger(word.endMs) && word.endMs >= word.startMs ? word.endMs : null,
          text: String(word.text || ""),
          flags: [...new Set(word.flags || [])],
        })),
        flags: [...new Set(line.flags || [])],
      }));

    lines.forEach((line, lineIndex) => {
      line.words.sort((left, right) => left.startMs - right.startMs);
      line.words.forEach((word, wordIndex) => {
        const nextWord = line.words[wordIndex + 1];
        if (nextWord && nextWord.startMs < word.startMs) word.flags.push("non_monotonic_word");
        if (word.endMs === null && nextWord && nextWord.startMs >= word.startMs) {
          word.endMs = nextWord.startMs;
          word.flags.push("end_inferred");
        }
      });
      const nextLine = lines[lineIndex + 1];
      const lastWord = line.words[line.words.length - 1];
      if (line.endMs === null && lastWord?.endMs !== null && lastWord?.endMs !== undefined) line.endMs = lastWord.endMs;
      if (line.endMs === null && nextLine?.startMs >= line.startMs) line.endMs = nextLine.startMs;
      if (line.endMs === null) line.endMs = line.startMs + 4000;
      if (lastWord && lastWord.endMs === null) {
        lastWord.endMs = line.endMs;
        lastWord.flags.push("end_inferred");
      }
      line.words.forEach((word) => {
        word.flags = [...new Set(word.flags)];
      });
      line.flags = [...new Set(line.flags)];
    });
    return lines;
  }

  function channelQuality(channel) {
    if (!channel?.synced) return "plain";
    const words = channel.lines.flatMap((line) => line.words || []);
    if (!words.length) return "line";
    return words.every((word) => (
      Number.isInteger(word.endMs)
      && word.endMs >= word.startMs
      && !(word.flags || []).includes("end_inferred")
    ))
      ? "word_with_end"
      : "word_start_only";
  }

  function isLeadingCreditText(value) {
    const text = String(value || "").trim();
    if (!text) return false;
    if (/^(?:作?词|作?詞|作?曲|编曲|編曲|制作人|製作人|监制|監製|vocal|lyrics?|composer|arranger|producer)\s*[:：]/iu.test(text)) return true;
    return /(?:著作权|著作權|翻译作品|翻譯作品|copyright|all rights reserved)/iu.test(text);
  }

  function filterLeadingMetadata(lines) {
    const source = Array.isArray(lines) ? lines : [];
    if (!source.length) return { lines: [], removed: 0, reason: "" };
    const leadingLimitMs = 15000;
    const largeGapMs = 5000;
    let blockEnd = -1;
    for (let index = 0; index < source.length - 1; index += 1) {
      const line = source[index];
      const next = source[index + 1];
      if (Number(line.startMs) > leadingLimitMs) break;
      const endMs = Number.isInteger(line.endMs) ? line.endMs : line.startMs;
      if (Number(next.startMs) - Number(endMs) >= largeGapMs) {
        blockEnd = index;
        break;
      }
    }
    if (blockEnd >= 0) {
      const block = source.slice(0, blockEnd + 1);
      const knownCredits = block.filter((line) => isLeadingCreditText(line.text)).length;
      if (knownCredits >= 2 && blockEnd + 1 < source.length) {
        return {
          lines: source.slice(blockEnd + 1),
          removed: blockEnd + 1,
          reason: "leading_credit_block",
        };
      }
    }
    const filtered = source.filter((line) => !(
      Number(line.startMs) <= leadingLimitMs
      && isLeadingCreditText(line.text)
    ));
    return {
      lines: filtered.length ? filtered : source,
      removed: source.length - filtered.length,
      reason: filtered.length < source.length ? "leading_credit_lines" : "",
    };
  }

  function parseLyricChannel(value, options = {}) {
    const role = normalizeRole(options.role);
    const requestedFormat = String(options.format || "auto").toLowerCase();
    let validated = validateText(value);
    if (requestedFormat === "qrc") {
      const extracted = extractQrcLyricContent(validated.text);
      if (extracted !== null) validated = validateText(extracted);
      else if (/<(?:qrcinfos|lyricinfo|lyric_)\b/iu.test(validated.text)) {
        throw new LyricModelError("invalid QRC XML", "QRC_XML_INVALID");
      }
    }
    const { text, lines: sourceLines } = validated;
    const offsetMs = parseOffsetMs(text);
    const rawLines = [];
    const plainLines = [];
    sourceLines.forEach((line, sequence) => {
      if (!line.trim() || isMetadataLine(line)) return;
      const yrc = ["auto", "yrc"].includes(requestedFormat)
        ? parseYrcSourceLine(line, offsetMs, sequence, String(options.wordTimeMode || "auto"))
        : null;
      if (yrc) {
        rawLines.push(yrc);
        return;
      }
      const qrc = requestedFormat === "qrc"
        ? parseQrcSourceLine(line, offsetMs, sequence)
        : null;
      if (qrc) {
        rawLines.push(qrc);
        return;
      }
      const lrc = ["auto", "lrc", "enhanced-lrc"].includes(requestedFormat)
        || requestedFormat === "qrc"
        ? parseLrcSourceLine(line, offsetMs, sequence)
        : [];
      if (lrc.length) rawLines.push(...lrc);
      else plainLines.push(line.trim());
    });
    const timed = filterLeadingMetadata(finalizeTimedLines(rawLines));
    const timedLines = timed.lines;
    const synced = timedLines.length > 0;
    const channel = {
      role,
      language: String(options.language || ""),
      sourceId: String(options.sourceId || ""),
      synced,
      offsetMs,
      lines: synced
        ? timedLines
        : plainLines.map((line) => ({ text: line, words: [], flags: [] })),
      diagnostics: timed.removed ? [{ code: timed.reason, removedLines: timed.removed }] : [],
    };
    channel.qualityLevel = channelQuality(channel);
    return channel;
  }

  function emptyChannel(role) {
    return { role, language: "", sourceId: "", synced: false, offsetMs: 0, lines: [], qualityLevel: "plain" };
  }

  function channelFragment(line) {
    if (!line) return { text: "", words: [] };
    return {
      text: String(line.text || ""),
      words: (line.words || []).map((word) => ({
        startMs: word.startMs,
        endMs: word.endMs,
        text: word.text,
        flags: [...(word.flags || [])],
      })),
    };
  }

  function alignChannel(targetLines, sourceLines, toleranceMs) {
    const assignments = new Map();
    const unmatched = [];
    let floor = 0;
    sourceLines.forEach((line) => {
      let bestIndex = -1;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let index = floor; index < targetLines.length; index += 1) {
        const distance = Math.abs(Number(targetLines[index].startMs) - Number(line.startMs));
        if (distance <= toleranceMs && distance < bestDistance && !assignments.has(index)) {
          bestIndex = index;
          bestDistance = distance;
        }
        if (targetLines[index].startMs > line.startMs + toleranceMs) break;
      }
      if (bestIndex >= 0) {
        assignments.set(bestIndex, line);
        floor = bestIndex + 1;
      } else {
        unmatched.push(line);
      }
    });
    return { assignments, unmatched };
  }

  function buildUnifiedLyric(channels = {}, options = {}) {
    const normalized = {
      main: channels.main || emptyChannel("main"),
      translation: channels.translation || emptyChannel("translation"),
      romanization: channels.romanization || emptyChannel("romanization"),
    };
    const toleranceMs = Math.max(0, Math.min(250, Number(options.toleranceMs) || 80));
    const baseRole = normalized.main.lines.length
      ? "main"
      : (normalized.translation.lines.length ? "translation" : "romanization");
    const base = normalized[baseRole];
    const baseLines = base.synced ? base.lines : [];
    const alignments = {};
    for (const role of CHANNEL_ROLES) {
      if (role === baseRole || !normalized[role].synced) continue;
      alignments[role] = alignChannel(baseLines, normalized[role].lines, toleranceMs);
    }
    const lines = baseLines.map((line, index) => {
      const output = {
        startMs: line.startMs,
        endMs: line.endMs,
        main: { text: "", words: [] },
        translation: { text: "", words: [] },
        romanization: { text: "", words: [] },
        flags: [...new Set(line.flags || [])],
      };
      output[baseRole] = channelFragment(line);
      for (const role of CHANNEL_ROLES) {
        const matched = alignments[role]?.assignments.get(index);
        if (matched) output[role] = channelFragment(matched);
      }
      return output;
    });
    for (const role of CHANNEL_ROLES) {
      for (const line of alignments[role]?.unmatched || []) {
        const output = {
          startMs: line.startMs,
          endMs: line.endMs,
          main: { text: "", words: [] },
          translation: { text: "", words: [] },
          romanization: { text: "", words: [] },
          flags: ["alignment_uncertain"],
        };
        output[role] = channelFragment(line);
        lines.push(output);
      }
    }
    lines.sort((left, right) => left.startMs - right.startMs);
    const selectedSources = [...new Set(Object.values(normalized).map((channel) => channel.sourceId).filter(Boolean))];
    const qualityLevel = Object.values(normalized)
      .map((channel) => channel.qualityLevel || "plain")
      .sort((left, right) => QUALITY_ORDER[right] - QUALITY_ORDER[left])[0] || "plain";
    return {
      schemaVersion: SCHEMA_VERSION,
      synced: lines.length > 0,
      offsetMs: 0,
      channels: Object.fromEntries(Object.entries(normalized).map(([role, channel]) => [role, {
        language: channel.language,
        sourceId: channel.sourceId || null,
      }])),
      lines,
      plain: Object.fromEntries(Object.entries(normalized).map(([role, channel]) => [
        role,
        channel.synced ? "" : channel.lines.map((line) => line.text).join("\n"),
      ])),
      provenance: {
        selectedSources,
        parserVersion: PARSER_VERSION,
        identityReason: String(options.identityReason || ""),
        qualityLevel,
      },
    };
  }

  function formatTimestamp(milliseconds, wrapper = "[]") {
    const value = Math.max(0, Math.round(Number(milliseconds) || 0));
    const minutes = Math.floor(value / 60000);
    const seconds = Math.floor((value % 60000) / 1000);
    const millis = value % 1000;
    const body = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
    return `${wrapper[0]}${body}${wrapper[1]}`;
  }

  function exportFragment(fragment, lineStartMs, includeWordTiming = true) {
    const words = Array.isArray(fragment?.words) ? fragment.words.filter((word) => word.text) : [];
    if (!words.length || !includeWordTiming) return String(fragment?.text || "");
    let output = "";
    words.forEach((word, index) => {
      output += `${formatTimestamp(word.startMs, "<>")}${word.text}`;
      const next = words[index + 1];
      // A separate empty timing tag preserves a pause, overlap or zero-length
      // syllable instead of extending this word to the next word's onset.
      if (next && Number.isInteger(word.endMs) && word.endMs >= word.startMs && word.endMs !== next.startMs
        && !(word.flags || []).includes("end_inferred")) {
        output += formatTimestamp(word.endMs, "<>");
      }
    });
    const last = words[words.length - 1];
    if (Number.isInteger(last.endMs) && last.endMs >= last.startMs && !(last.flags || []).includes("end_inferred")) output += formatTimestamp(last.endMs, "<>");
    return output || String(fragment?.text || "");
  }

  function exportEnhancedLrc(model, options = {}) {
    const includeTranslation = options.includeTranslation !== false;
    const includeRomanization = options.includeRomanization === true;
    const includeWordTiming = options.includeWordTiming !== false;
    const output = [];
    for (const line of Array.isArray(model?.lines) ? model.lines : []) {
      const tag = formatTimestamp(line.startMs, "[]");
      const mainText = exportFragment(line.main, line.startMs, includeWordTiming);
      if (mainText) output.push(`${tag}${mainText}`);
      if (includeTranslation && line.translation?.text) output.push(`${tag}${exportFragment(line.translation, line.startMs, includeWordTiming)}`);
      if (includeRomanization && line.romanization?.text) output.push(`${tag}${exportFragment(line.romanization, line.startMs, includeWordTiming)}`);
    }
    if (!output.length) {
      const roles = ["main"];
      if (includeTranslation) roles.push("translation");
      if (includeRomanization) roles.push("romanization");
      roles.forEach((role) => {
        const plain = String(model?.plain?.[role] || "");
        if (plain) output.push(plain);
      });
    }
    return output.length ? `${output.join("\n")}\n` : "";
  }

  return {
    CHANNEL_ROLES,
    LyricModelError,
    MAX_LINES,
    MAX_TAGS_PER_LINE,
    MAX_TEXT_BYTES,
    PARSER_VERSION,
    QUALITY_ORDER,
    SCHEMA_VERSION,
    buildUnifiedLyric,
    channelQuality,
    exportEnhancedLrc,
    extractQrcLyricContent,
    formatTimestamp,
    filterLeadingMetadata,
    isLeadingCreditText,
    parseLyricChannel,
    parseOffsetMs,
    parseQrcSourceLine,
    toMs,
  };
});
