const {
  artistCreditSimilarity,
  artistCreditsEquivalent,
  cleanText,
  extractVersionTerms,
  normalizeText,
  textSimilarity,
} = require("../song-info/candidate-model");
const {
  LyricModelError,
  QUALITY_ORDER,
  buildUnifiedLyric,
  exportEnhancedLrc,
  isLeadingCreditText,
  parseLyricChannel,
} = require("./unified-lyric");
const { wordTimingQuality } = require("./word-timing-quality");

const IDENTITY_ORDER = Object.freeze({ reject: 0, weak: 1, medium: 2, strong: 3 });
const LOCAL_SOURCE_ORDER = Object.freeze({ external: 3, sidecar: 2, embedded: 1 });

function textList(value) {
  const input = Array.isArray(value) ? value : (value ? [value] : []);
  const result = [];
  const seen = new Set();
  for (const item of input) {
    const text = cleanText(typeof item === "object" && item ? (item.name || item.value || "") : item);
    const key = normalizeText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

const EAST_ASIAN_SCRIPT = /\p{sc=Han}|\p{sc=Hiragana}|\p{sc=Katakana}|\p{sc=Hangul}/u;
const VOICE_ACTOR_CREDIT = /^(.+?)\s*\(\s*CV\s*[.:]?\s*([^()]+)\)\s*$/iu;

function splitLyricCredits(value) {
  return textList(textList(value).flatMap(credit => {
    const separators = EAST_ASIAN_SCRIPT.test(credit) ? /[、,;\/]+/u : /[、,;]+|\s+\/\s+/u;
    return credit.split(separators);
  }));
}

function lyricPerformerCredits(value) {
  return splitLyricCredits(value).map(credit => credit.match(VOICE_ACTOR_CREDIT)?.[2] || credit);
}

function compareLyricCredits(left, right) {
  const a = lyricPerformerCredits(left);
  const b = lyricPerformerCredits(right);
  if (!a.length || !b.length) return { equivalent: false, similarity: 0 };
  const equivalent = artistCreditsEquivalent(a, b);
  if (equivalent) {
    const characterCredits = credit => splitLyricCredits(credit).map(name => name.match(VOICE_ACTOR_CREDIT)).filter(Boolean);
    const leftRoles = characterCredits(left);
    const rightRoles = characterCredits(right);
    const conflictingRole = leftRoles.some(([, role, actor]) => rightRoles.some(([, otherRole, otherActor]) =>
      normalizeText(actor) === normalizeText(otherActor) && normalizeText(role) !== normalizeText(otherRole)));
    return { equivalent: !conflictingRole, similarity: 1 };
  }
  const normalizeName = name => normalizeText(name.replace(/(\p{sc=Han})々/gu, "$1$1"));
  const aliases = credit => {
    const match = credit.match(/^([^()]+)\(\s*([^()]+)\)\s*$/u);
    if (!match || !EAST_ASIAN_SCRIPT.test(match[1]) || !EAST_ASIAN_SCRIPT.test(match[2])) return [normalizeName(credit)];
    return [normalizeName(match[1]), normalizeName(match[2])].filter(Boolean);
  };
  const leftNames = a.map(aliases);
  const rightNames = b.map(aliases);
  const overlap = (from, to) => from.reduce((sum, names) => sum + Math.max(0, ...to.map(other =>
    names.some(name => other.includes(name)) ? 1 : textSimilarity(names[0], other[0]))), 0) / from.length;
  const aliasSimilarity = Math.min(overlap(leftNames, rightNames), overlap(rightNames, leftNames));
  return { equivalent, similarity: Math.max(artistCreditSimilarity(a, b), aliasSimilarity) };
}

function normalizeLyricEvidence(raw = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const title = cleanText(source.title || source.trackName || "");
  const fileName = cleanText(source.fileName || "");
  return {
    title: title || fileName,
    titleFromFileName: Boolean(source.titleFromFileName) || (!title && Boolean(fileName)),
    artists: textList(source.artists?.length ? source.artists : source.artist),
    album: cleanText(source.album || source.albumName || ""),
    durationSeconds: finitePositive(source.durationSeconds ?? source.duration),
    versionTerms: extractVersionTerms([title, fileName].filter(Boolean).join(" ")),
  };
}

function normalizeLyricCandidate(raw = {}, provider = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const providerId = cleanText(provider.id || source.provider || "");
  const providerVersion = cleanText(provider.version || source.providerVersion || "");
  const sourceRecordId = cleanText(source.sourceRecordId || source.id || "");
  const trackName = cleanText(source.trackName || source.title || source.name || "");
  const artists = textList(source.artists?.length ? source.artists : (source.artistName || source.artist));
  const candidateId = [providerId, sourceRecordId || normalizeText(trackName), normalizeText(artists.join(" "))]
    .filter(Boolean)
    .join(":");
  const trustedLocal = provider.localOnly === true;
  const trustedStructuredLyrics = trustedLocal || provider.allowStructuredLyrics === true;
  const trustedIdentityLevel = trustedLocal && ["strong", "medium", "weak"].includes(source.identityLevel)
    ? source.identityLevel
    : "";
  const trustedIdentityScore = trustedIdentityLevel
    ? Math.max(0, Math.min(100, Number(source.identityScore) || 0))
    : 0;
  const unifiedLyrics = trustedStructuredLyrics
    && source.unifiedLyrics
    && typeof source.unifiedLyrics === "object"
    && !Array.isArray(source.unifiedLyrics)
    ? structuredClone(source.unifiedLyrics)
    : null;
  return {
    candidateId,
    provider: providerId,
    providerVersion,
    sourceLabel: cleanText(source.sourceLabel || provider.label || providerId),
    sourceRecordId,
    trackName,
    artists,
    album: cleanText(source.albumName || source.album || ""),
    durationSeconds: finitePositive(source.durationSeconds ?? source.duration),
    instrumental: Boolean(source.instrumental),
    plainLyrics: String(source.plainLyrics || ""),
    syncedLyrics: String(source.syncedLyrics || ""),
    syncedFormat: cleanText(source.syncedFormat || source.format || "auto").toLowerCase(),
    language: cleanText(source.language || ""),
    versionTerms: extractVersionTerms(trackName),
    trustedIdentityLevel,
    trustedIdentityScore,
    sourceType: trustedLocal ? cleanText(source.sourceType || "") : "",
    hasOwnTitle: trustedLocal && source.hasOwnTitle === true,
    providerPriority: Math.max(0, Number(source.providerPriority) || Number(provider.providerPriority) || 0),
    sourcePreference: Math.max(0, Number(source.sourcePreference) || 0),
    unifiedLyrics,
    provenance: {
      provider: providerId,
      providerVersion,
      sourceRecordId,
    },
  };
}

function sameTerms(left, right) {
  const a = new Set(left || []);
  const b = new Set(right || []);
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

function inspectLyricQuality(candidate) {
  if (candidate.instrumental) {
    return { available: true, qualityLevel: "instrumental", parsed: null, errorCode: "" };
  }
  if (candidate.unifiedLyrics) {
    const model = candidate.unifiedLyrics;
    const lines = Array.isArray(model.lines) ? model.lines : [];
    const plainMain = String(model?.plain?.main || "").trim();
    const hasMain = lines.some((line) => String(line?.main?.text || "").trim()) || Boolean(plainMain);
    const hasWords = lines.some((line) => Array.isArray(line?.main?.words) && line.main.words.length > 0);
    const valid = Number(model.schemaVersion) === 1 && hasMain
      && !isInstrumentalNotice(lines.map(line => line.main?.text), plainMain);
    return {
      available: valid,
      qualityLevel: valid ? (hasWords ? "word" : (lines.length ? "line" : "plain")) : "invalid",
      parsed: null,
      model: valid ? structuredClone(model) : null,
      errorCode: valid ? "" : "LYRIC_INVALID",
    };
  }
  const value = candidate.syncedLyrics || candidate.plainLyrics;
  if (!value.trim()) return { available: false, qualityLevel: "missing", parsed: null, errorCode: "LYRIC_MISSING" };
  try {
    const parsed = parseLyricChannel(value, {
      role: "main",
      language: candidate.language,
      sourceId: `${candidate.provider}:${candidate.sourceRecordId || candidate.candidateId}`,
      format: candidate.syncedLyrics ? candidate.syncedFormat : "plain",
    });
    const available = parsed.lines.length > 0 && !isInstrumentalNotice(parsed.lines.map(line => line.text));
    return {
      available,
      qualityLevel: available ? parsed.qualityLevel : "invalid",
      parsed: available ? parsed : null,
      errorCode: available ? "" : "LYRIC_EMPTY",
    };
  } catch (error) {
    return {
      available: false,
      qualityLevel: "invalid",
      parsed: null,
      errorCode: error instanceof LyricModelError ? error.code : "LYRIC_INVALID",
    };
  }
}

function isInstrumentalNotice(timedText, plain = "") {
  const text = [...timedText, ...String(plain).split(/\r?\n/u)]
    .map(line => String(line || "").normalize("NFKC").trim())
    .filter(line => line && !isLeadingCreditText(line));
  return text.length > 0 && text.every(line => /^(?:本(?:曲|歌曲)(?:为|是))?(?:纯音乐|纯伴奏|伴奏曲|无人声)(?:[,，\s]*(?:请欣赏|敬请欣赏|无歌词))?[。.!！]*$|^(?:instrumental|no lyrics)[.!]*$/iu.test(line));
}

function lyricTimingFitsDuration(model, durationSeconds) {
  if (!(durationSeconds > 0)) return false;
  const limit = durationSeconds * 1000 + 2000;
  return (model?.lines || []).every(line => (line.startMs ?? 0) <= limit && (line.endMs ?? 0) <= limit
    && (line.main?.words || []).every(word => (word.endMs ?? word.startMs ?? 0) <= limit));
}

function meetsLyricTarget(item, target) {
  if (target === "word") return item.timingQuality.complete;
  if (target === "line") return Boolean(item.lyricsModel?.synced || item.parsed?.synced);
  return true;
}

function scoreLyricCandidate(evidenceRaw, candidateRaw, options = {}) {
  const evidence = normalizeLyricEvidence(evidenceRaw);
  const candidate = candidateRaw?.candidateId
    ? candidateRaw
    : normalizeLyricCandidate(candidateRaw, options.provider);
  const titleScore = textSimilarity(evidence.title, candidate.trackName, { ignoreVersion: true });
  const credits = compareLyricCredits(evidence.artists, candidate.artists);
  const artistScore = credits.similarity;
  const albumScore = evidence.album && candidate.album ? textSimilarity(evidence.album, candidate.album) : 0;
  const hasDuration = evidence.durationSeconds > 0 && candidate.durationSeconds > 0;
  const durationDifference = hasDuration
    ? Math.abs(evidence.durationSeconds - candidate.durationSeconds)
    : null;
  const durationScore = durationDifference === null ? 0 : Math.max(0, 1 - durationDifference / 4);
  const quality = inspectLyricQuality(candidate);
  const blockers = [];
  const reasons = [];
  if (titleScore < 0.7) blockers.push({ code: "title-conflict", message: "标题不一致" });
  if (evidence.artists.length && candidate.artists.length && artistScore < 0.5) {
    blockers.push({ code: "artist-conflict", message: "歌手不一致" });
  } else if (evidence.artists.length && candidate.artists.length && !credits.equivalent) {
    blockers.push({ code: "artist-credit-difference", message: "演唱者不完全一致" });
  }
  if (!sameTerms(evidence.versionTerms, candidate.versionTerms)) {
    blockers.push({ code: "version-conflict", message: "版本不一致" });
  } else if (evidence.versionTerms.includes("instrumental") && quality.available) {
    blockers.push({ code: "instrumental-with-lyrics", message: "伴奏版带有歌词，请核实是否来自人声版" });
  }
  if (durationDifference !== null && durationDifference > 4) {
    blockers.push({ code: "duration-conflict", message: `时长相差 ${Math.round(durationDifference)} 秒` });
  }
  if (!quality.available) blockers.push({ code: quality.errorCode, message: "歌词不可用" });
  const model = quality.model || (quality.parsed ? buildUnifiedLyric({ main: quality.parsed }) : null);
  if (options.lyricCompleteness && model?.synced && evidence.durationSeconds > 0
    && !lyricTimingFitsDuration(model, evidence.durationSeconds)) {
    blockers.push({ code: "timing-outside-audio", message: "歌词时间超出音频长度" });
  }

  if (titleScore >= 0.92) reasons.push("标题一致");
  if (artistScore >= 0.9) reasons.push("歌手一致");
  if (durationDifference !== null && durationDifference <= 2) reasons.push("时长一致");
  if (albumScore >= 0.9) reasons.push("专辑一致");

  const hardBlockers = blockers.filter(({ code }) => !["artist-credit-difference", "instrumental-with-lyrics"].includes(code));
  let identityLevel = "reject";
  if (!hardBlockers.length) {
    if (titleScore >= 0.92 && artistScore >= 0.9 && durationDifference !== null && durationDifference <= 2) {
      identityLevel = "strong";
    } else if (titleScore >= 0.82 && artistScore >= 0.65 && (durationDifference === null || durationDifference <= 4)) {
      identityLevel = "medium";
    } else if (titleScore >= 0.92 && !evidence.artists.length) {
      identityLevel = "weak";
    }
  }

  const hasArtist = evidence.artists.length && candidate.artists.length;
  const hasAlbum = evidence.album && candidate.album;
  // Missing singer is neutral when other evidence exists; title alone stays weak.
  const weight = hasArtist || hasDuration || hasAlbum
    ? 45 + (hasArtist ? 30 : 0) + (hasDuration ? 15 : 0) + (hasAlbum ? 10 : 0) : 90;
  const weighted = titleScore * 45 + artistScore * 30 + durationScore * 15 + albumScore * 10;
  let identityScore = Math.round((weighted / weight) * 1000) / 10;
  if (candidate.trustedIdentityLevel) {
    const trustedOrder = IDENTITY_ORDER[candidate.trustedIdentityLevel] || 0;
    if ((IDENTITY_ORDER[identityLevel] || 0) > trustedOrder) identityLevel = candidate.trustedIdentityLevel;
    identityScore = Math.min(identityScore, candidate.trustedIdentityScore);
  }
  const autoThreshold = Math.max(0, Math.min(100, Number(options.autoThreshold ?? 95)));
  const manualThreshold = Math.max(0, Math.min(autoThreshold, Number(options.manualThreshold ?? 75)));
  let recommendation = "none";
  if (identityLevel === "strong" && identityScore >= autoThreshold && !evidence.titleFromFileName && !blockers.length) {
    recommendation = "strong";
  } else if (["strong", "medium"].includes(identityLevel) && identityScore >= manualThreshold) {
    recommendation = "medium";
  }
  return {
    candidate,
    identityLevel,
    identityScore,
    recommendation,
    reasons,
    blockers,
    qualityLevel: quality.qualityLevel,
    parsed: quality.parsed,
    lyricsModel: quality.model || null,
    timingQuality: wordTimingQuality(model),
    evidence: {
      title: titleScore,
      artists: artistScore,
      album: albumScore,
      durationDifference,
    },
  };
}

function rankLyricCandidates(evidence, candidates, options = {}) {
  const scored = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => scoreLyricCandidate(evidence, candidate, options))
    .filter(item => meetsLyricTarget(item, options.lyricCompleteness))
    .sort((left, right) => (
      Number(right.recommendation !== "none") - Number(left.recommendation !== "none")
      || (options.lyricCompleteness ? Number(right.recommendation === "strong") - Number(left.recommendation === "strong") : 0)
      || IDENTITY_ORDER[right.identityLevel] - IDENTITY_ORDER[left.identityLevel]
      || right.timingQuality.coverage - left.timingQuality.coverage
      || right.timingQuality.textCoverage - left.timingQuality.textCoverage
      || right.timingQuality.endCoverage - left.timingQuality.endCoverage
      || right.identityScore - left.identityScore
      || right.candidate.providerPriority - left.candidate.providerPriority
      || (LOCAL_SOURCE_ORDER[right.candidate.sourceType] || 0) - (LOCAL_SOURCE_ORDER[left.candidate.sourceType] || 0)
      || (QUALITY_ORDER[right.qualityLevel] || 0) - (QUALITY_ORDER[left.qualityLevel] || 0)
      || right.candidate.sourcePreference - left.candidate.sourcePreference
      || left.candidate.candidateId.localeCompare(right.candidate.candidateId)
    ));
  // Provider and local tag IDs describe provenance, not distinct lyric timelines.
  const fingerprints = new Set();
  const ranked = scored.filter(item => {
    if (item.identityLevel === "reject") return true;
    const model = item.lyricsModel || (item.parsed ? buildUnifiedLyric({ main: item.parsed }) : null);
    if (!model) return true;
    const fingerprint = exportEnhancedLrc(model, {
      includeTranslation: options.includeTranslation !== false,
      includeRomanization: options.includeRomanization !== false,
      includeWordTiming: options.lyricCompleteness !== "line",
    });
    if (!fingerprint) return true;
    if (fingerprints.has(fingerprint)) return false;
    fingerprints.add(fingerprint);
    return true;
  });
  const viableWeak = ranked.filter((item) => item.identityLevel === "weak");
  const manualThreshold = Math.max(0, Math.min(100, Number(options.manualThreshold ?? 75)));
  if (
    viableWeak.length === 1
    && ranked[0] === viableWeak[0]
    && viableWeak[0].identityScore >= manualThreshold
  ) {
    viableWeak[0].recommendation = "medium";
  }
  const minimumGap = Math.max(0, Number(options.minimumGap ?? 8));
  const viable = ranked.filter((item) => item.recommendation !== "none");
  for (const item of viable) {
    if (item.recommendation !== "strong") continue;
    const hasCloseAlternative = viable.some((other) => (
      other !== item
      && item.identityLevel === other.identityLevel
      && Math.abs(item.identityScore - other.identityScore) < minimumGap
    ));
    if (!hasCloseAlternative) continue;
    item.recommendation = "medium";
    if (!item.blockers.some((blocker) => blocker.code === "ambiguous-best")) {
      item.blockers.push({ code: "ambiguous-best", message: "存在两个相近版本" });
    }
  }
  return ranked;
}

module.exports = {
  IDENTITY_ORDER,
  compareLyricCredits,
  inspectLyricQuality,
  lyricTimingFitsDuration,
  lyricPerformerCredits,
  meetsLyricTarget,
  normalizeLyricCandidate,
  normalizeLyricEvidence,
  rankLyricCandidates,
  scoreLyricCandidate,
  splitLyricCredits,
};
