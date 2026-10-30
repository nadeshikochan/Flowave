const FIELD_NAMES = Object.freeze([
  "title",
  "artists",
  "album",
  "albumArtists",
  "releaseDate",
  "trackNumber",
  "trackTotal",
  "discNumber",
  "discTotal",
  "genres",
  "cover",
  "lyrics",
  "composers",
  "lyricists",
]);

const VERSION_PATTERNS = Object.freeze([
  ["live", /\blive\b|现场|現場|ライブ/iu],
  ["dj-mix", /\bdj\s*(?:mix|mixed|set|edit)\b|\bcontinuous\s+mix\b|串烧|串燒/iu],
  ["remix", /\bremix(?:ed)?\b|\bmix\b|混音|リミックス/iu],
  ["acoustic", /\bacoustic\b|不插电|不插電|アコースティック/iu],
  ["instrumental", /\binstrumental\b|纯音乐|純音樂|伴奏|インスト(?:ゥルメンタル)?/iu],
  ["karaoke", /\bkaraoke\b|卡拉\s*ok|カラオケ/iu],
  ["tv-size", /\btv\s*(?:size|version|ver\.?|edit)\b|电视版|電視版|テレビサイズ/iu],
  ["remaster", /\bremaster(?:ed)?\b|重制版|重製版|リマスター/iu],
  ["radio-edit", /\bradio\s*(?:edit|version|ver\.?)\b|电台版|電台版/iu],
  ["extended", /\bextended(?:\s*(?:mix|version|ver\.?))?\b|加长版|加長版/iu],
  ["demo", /\bdemo\b|样带|樣帶|デモ/iu],
  ["mono", /\bmono(?:phonic)?\b|单声道|單聲道/iu],
  ["sped-up", /\b(?:sped|speed)\s*up\b|加速版|高速版/iu],
  ["slowed", /\bslowed(?:\s*(?:down|and\s+reverb))?\b|\bslow(?:ed)?\s*(?:version|ver\.?|edit)\b|减速版|減速版/iu],
  ["nightcore", /\bnightcore\b/iu],
  ["language-en", /\benglish\s*(?:version|ver\.?|edit)\b|英文版|英語版/iu],
  ["language-ja", /\bjapanese\s*(?:version|ver\.?|edit)\b|日文版|日語版/iu],
  ["language-ko", /\bkorean\s*(?:version|ver\.?|edit)\b|韩文版|韓文版|韓国語版/iu],
  ["language-mandarin", /\bmandarin\s*(?:version|ver\.?|edit)\b|国语版|國語版|普通话版|普通話版/iu],
  ["language-cantonese", /\bcantonese\s*(?:version|ver\.?|edit)\b|粤语版|粵語版/iu],
]);

const PLACEHOLDER_PATTERNS = Object.freeze([
  /^unknown(?:\s+(?:artist|title))?$/iu,
  /^未知(?:艺术家|藝術家|歌手|歌曲|标题|標題)?$/u,
  /^untitled$/iu,
  /^(?:audio\s*)?track\s*0*\d+$/iu,
]);

function cleanText(value) {
  return String(value ?? "").normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function normalizeText(value) {
  return cleanText(value)
    .toLocaleLowerCase("und")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function isMissingText(value) {
  const normalized = normalizeText(value);
  if (!normalized) return true;
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(normalized));
}

function uniqueTextList(value) {
  const source = Array.isArray(value) ? value : (value == null || value === "" ? [] : [value]);
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const text = cleanText(typeof item === "object" && item ? (item.name ?? item.value ?? "") : item);
    const key = normalizeText(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(text);
  }
  return result;
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function positiveInteger(value) {
  const number = Math.trunc(finiteNumber(value));
  return number > 0 ? number : 0;
}

function extractVersionTerms(value) {
  const text = cleanText(value).toLocaleLowerCase("und");
  const terms = VERSION_PATTERNS
    .filter(([, pattern]) => pattern.test(text))
    .map(([term]) => term)
    .sort();
  return terms.includes("dj-mix") ? terms.filter((term) => term !== "remix") : terms;
}

function stripVersionTerms(value) {
  let text = cleanText(value);
  for (const [, pattern] of VERSION_PATTERNS) text = text.replace(pattern, " ");
  return normalizeText(text);
}

function bigrams(value) {
  const text = normalizeText(value).replace(/\s+/gu, "");
  if (!text) return [];
  if (text.length === 1) return [text];
  const result = [];
  for (let index = 0; index < text.length - 1; index += 1) {
    result.push(text.slice(index, index + 2));
  }
  return result;
}

function diceSimilarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (!a.length || !b.length) return 0;
  const counts = new Map();
  for (const item of a) counts.set(item, (counts.get(item) || 0) + 1);
  let overlap = 0;
  for (const item of b) {
    const count = counts.get(item) || 0;
    if (!count) continue;
    overlap += 1;
    counts.set(item, count - 1);
  }
  return (2 * overlap) / (a.length + b.length);
}

function tokenSimilarity(left, right) {
  const a = new Set(normalizeText(left).split(" ").filter(Boolean));
  const b = new Set(normalizeText(right).split(" ").filter(Boolean));
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / (a.size + b.size - overlap);
}

function textSimilarity(left, right, { ignoreVersion = false } = {}) {
  const a = ignoreVersion ? stripVersionTerms(left) : normalizeText(left);
  const b = ignoreVersion ? stripVersionTerms(right) : normalizeText(right);
  if (!a || !b) return 0;
  if (a === b) return 1;
  return Math.max(diceSimilarity(a, b), tokenSimilarity(a, b));
}

function listSimilarity(left, right) {
  const a = uniqueTextList(left);
  const b = uniqueTextList(right);
  if (!a.length || !b.length) return 0;
  let sum = 0;
  for (const item of a) {
    sum += Math.max(...b.map((candidate) => textSimilarity(item, candidate)));
  }
  return sum / a.length;
}

function artistCreditSimilarity(left, right) {
  const a = uniqueTextList(left);
  const b = uniqueTextList(right);
  if (!a.length || !b.length) return 0;
  return Math.max(
    listSimilarity(a, b),
    listSimilarity(b, a),
    textSimilarity(a.join(" "), b.join(" ")),
  );
}

function artistCreditsEquivalent(left, right) {
  const a = uniqueTextList(left).map(normalizeText).filter(Boolean);
  const b = uniqueTextList(right).map(normalizeText).filter(Boolean);
  if (!a.length || a.length !== b.length) return false;
  const rightSet = new Set(b);
  return a.every((value) => rightSet.has(value));
}

function normalizeAsset(value) {
  if (!value) return null;
  if (typeof value === "string") return { url: cleanText(value) };
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const url = cleanText(value.url || value.href || "");
  const assetId = cleanText(value.assetId || "");
  if (!url && !assetId) return null;
  return {
    url,
    assetId,
    provider: cleanText(value.provider || ""),
    mime: cleanText(value.mime || value.mimeType || ""),
    size: Math.max(0, finiteNumber(value.size)),
    hash: cleanText(value.hash || ""),
    width: positiveInteger(value.width),
    height: positiveInteger(value.height),
  };
}

function normalizeCandidate(raw, provider = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const providerId = cleanText(provider.id || source.provider || "");
  const providerVersion = cleanText(provider.version || source.providerVersion || "");
  const recordingId = cleanText(source.recordingId || source.recording_id || source.id || "");
  const releaseId = cleanText(source.releaseId || source.release_id || "");
  const title = cleanText(source.title || "");
  const artists = uniqueTextList(source.artists?.length ? source.artists : source.artist);
  const albumArtists = uniqueTextList(source.albumArtists?.length ? source.albumArtists : source.albumArtist);
  const candidateId = [providerId, recordingId || normalizeText(title), releaseId].filter(Boolean).join(":");
  const provenance = source.provenance && typeof source.provenance === "object"
    ? structuredClone(source.provenance)
    : {};

  return {
    candidateId,
    provider: providerId,
    providerVersion,
    sourceLabel: cleanText(provider.label || source.sourceLabel || providerId),
    recordingId,
    releaseId,
    title,
    artists,
    primaryArtist: artists[0] || "",
    album: cleanText(source.album || ""),
    albumArtists,
    releaseDate: cleanText(source.releaseDate || source.date || ""),
    trackNumber: positiveInteger(source.trackNumber),
    trackTotal: positiveInteger(source.trackTotal),
    discNumber: positiveInteger(source.discNumber),
    discTotal: positiveInteger(source.discTotal),
    genres: uniqueTextList(source.genres || source.genre),
    composers: uniqueTextList(source.composers || source.composer),
    lyricists: uniqueTextList(source.lyricists || source.lyricist),
    durationSeconds: Math.max(0, finiteNumber(source.durationSeconds ?? source.duration)),
    isrcs: uniqueTextList(source.isrcs || source.isrc).map((item) => item.toUpperCase()),
    cover: normalizeAsset(source.cover),
    lyrics: source.lyrics && typeof source.lyrics === "object" ? structuredClone(source.lyrics) : null,
    versionTerms: extractVersionTerms(title),
    provenance,
  };
}

function normalizeEvidence(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const title = cleanText(source.title || "");
  const fileName = cleanText(source.fileName || "");
  const artists = uniqueTextList(source.artists?.length ? source.artists : source.artist)
    .filter((value) => !isMissingText(value));
  const albumArtists = uniqueTextList(source.albumArtists?.length ? source.albumArtists : source.albumArtist)
    .filter((value) => !isMissingText(value));
  return {
    resourceId: cleanText(source.resourceId || ""),
    title,
    artists,
    album: cleanText(source.album || ""),
    albumArtists,
    releaseDate: cleanText(source.releaseDate || source.date || ""),
    trackNumber: positiveInteger(source.trackNumber),
    trackTotal: positiveInteger(source.trackTotal),
    discNumber: positiveInteger(source.discNumber),
    discTotal: positiveInteger(source.discTotal),
    genres: uniqueTextList(source.genres || source.genre),
    composers: uniqueTextList(source.composers || source.composer),
    lyricists: uniqueTextList(source.lyricists || source.lyricist),
    cover: normalizeAsset(source.cover),
    lyrics: source.lyrics && typeof source.lyrics === "object"
      ? structuredClone(source.lyrics)
      : (cleanText(source.lyrics || "") ? { plain: cleanText(source.lyrics) } : null),
    durationSeconds: Math.max(0, finiteNumber(source.durationSeconds ?? source.duration)),
    isrcs: uniqueTextList(source.isrcs || source.isrc).map((item) => item.toUpperCase()),
    recordingId: cleanText(source.recordingId || ""),
    fileName,
    titleFromFileName: Boolean(source.titleFromFileName) || (!title && Boolean(fileName)),
    versionTerms: extractVersionTerms([title, fileName].filter(Boolean).join(" ")),
  };
}

function valuePresent(candidate, field) {
  const value = candidate[field];
  if (field === "cover") return Boolean(value?.url || value?.assetId);
  if (field === "lyrics") return Boolean(value && (value.synced || value.plain || value.lines?.length));
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "number") return value > 0;
  return !isMissingText(value);
}

function sameStringSets(left, right) {
  const a = new Set((left || []).map(normalizeText).filter(Boolean));
  const b = new Set((right || []).map(normalizeText).filter(Boolean));
  if (!a.size && !b.size) return true;
  if (!a.size || !b.size) return false;
  if (a.size !== b.size) return false;
  for (const item of a) if (!b.has(item)) return false;
  return true;
}

function addEvidence(state, name, similarity, weight) {
  if (!Number.isFinite(similarity)) return;
  const bounded = Math.max(0, Math.min(1, similarity));
  state.weighted += bounded * weight;
  state.weight += weight;
  state.evidence.push({ name, similarity: bounded, weight });
}

function scoreCandidate(localRaw, candidateRaw, options = {}) {
  const local = normalizeEvidence(localRaw);
  const candidate = candidateRaw?.candidateId ? candidateRaw : normalizeCandidate(candidateRaw, options.provider);
  const requestedFields = [...new Set((options.requestedFields || []).filter((field) => FIELD_NAMES.includes(field)))];
  const state = { weighted: 0, weight: 0, evidence: [] };
  const blockers = [];
  const reasons = [];
  const addBlocker = (code, message, severity = "manual") => {
    if (!blockers.some((item) => item.code === code)) blockers.push({ code, message, severity });
  };

  const missingFields = requestedFields.filter((field) => !valuePresent(candidate, field));
  if (missingFields.length) addBlocker("missing-required", "只能补充部分信息", "manual");

  const localTitle = !isMissingText(local.title) ? local.title : local.fileName;
  if (!isMissingText(localTitle) && !isMissingText(candidate.title)) {
    const titleScore = textSimilarity(localTitle, candidate.title, { ignoreVersion: true });
    addEvidence(state, "title", titleScore, 40);
    if (titleScore >= 0.92) reasons.push("标题一致");
    if (titleScore < 0.55) addBlocker("title-conflict", "标题差异较大");
  }

  if (local.artists.length && candidate.artists.length) {
    const artistScore = artistCreditSimilarity(local.artists, candidate.artists);
    addEvidence(state, "artists", artistScore, 30);
    if (artistScore >= 0.9) reasons.push("歌手一致");
    if (artistScore < 0.5) addBlocker("artist-conflict", "歌手不一致");
    else if (!artistCreditsEquivalent(local.artists, candidate.artists)) {
      addBlocker("artist-credit-difference", "演唱者不完全一致");
    }
  }

  if (local.durationSeconds > 0 && candidate.durationSeconds > 0) {
    const difference = Math.abs(local.durationSeconds - candidate.durationSeconds);
    const tolerance = Math.max(4, local.durationSeconds * 0.02);
    const durationScore = Math.max(0, 1 - difference / Math.max(tolerance * 2, 1));
    addEvidence(state, "duration", durationScore, 20);
    if (difference <= 2) reasons.push("时长一致");
    else if (difference > tolerance) addBlocker("duration-conflict", `时长相差 ${Math.round(difference)} 秒`, "reject");
  }

  if (!isMissingText(local.album) && !isMissingText(candidate.album)) {
    const albumScore = textSimilarity(local.album, candidate.album);
    addEvidence(state, "album", albumScore, 10);
    if (albumScore >= 0.9) reasons.push("专辑一致");
  }

  if (local.trackNumber > 0 && candidate.trackNumber > 0) {
    addEvidence(state, "trackNumber", local.trackNumber === candidate.trackNumber ? 1 : 0, 4);
  }
  if (local.discNumber > 0 && candidate.discNumber > 0) {
    addEvidence(state, "discNumber", local.discNumber === candidate.discNumber ? 1 : 0, 2);
  }

  if (!sameStringSets(local.versionTerms, candidate.versionTerms)) {
    addBlocker("version-conflict", "版本不一致");
  }

  const localIsrc = new Set(local.isrcs);
  const candidateIsrc = new Set(candidate.isrcs);
  if (localIsrc.size && candidateIsrc.size) {
    const isrcMatch = [...localIsrc].some((value) => candidateIsrc.has(value));
    if (isrcMatch) {
      reasons.push("录音编号一致");
      addEvidence(state, "isrc", 1, 30);
    } else {
      addBlocker("strong-id-conflict", "录音编号不一致", "reject");
    }
  }
  if (local.recordingId && candidate.recordingId) {
    if (local.recordingId === candidate.recordingId) {
      reasons.push("录音记录一致");
      addEvidence(state, "recordingId", 1, 40);
    } else {
      addBlocker("strong-id-conflict", "录音记录不一致", "reject");
    }
  }

  const meaningfulEvidence = state.evidence.filter((item) => item.name !== "trackNumber" && item.name !== "discNumber");
  if (local.titleFromFileName && !local.artists.length) addBlocker("filename-only", "本地信息太少");
  if (meaningfulEvidence.length < 2) addBlocker("insufficient-evidence", "匹配依据不足");

  const score = state.weight > 0 ? Math.round((state.weighted / state.weight) * 1000) / 10 : 0;
  const autoThreshold = Math.max(90, Math.min(99, finiteNumber(options.autoThreshold, 95)));
  const manualThreshold = Math.max(60, Math.min(autoThreshold - 1, finiteNumber(options.manualThreshold, 75)));
  const hasReject = blockers.some((item) => item.severity === "reject");
  const hasManualBlocker = blockers.some((item) => item.severity !== "reject");
  let recommendation = "none";
  if (!hasReject && score >= manualThreshold) {
    recommendation = !hasManualBlocker && score >= autoThreshold ? "strong" : "medium";
  } else if (!hasReject && missingFields.length < requestedFields.length && score >= Math.max(55, manualThreshold - 15)) {
    recommendation = "medium";
  }

  return {
    candidate,
    score,
    recommendation,
    autoEligible: recommendation === "strong",
    reasons: [...new Set(reasons)].slice(0, 3),
    blockers,
    missingFields,
    evidence: state.evidence,
  };
}

function rankCandidates(local, candidates, options = {}) {
  const recommendationPriority = { strong: 2, medium: 1, none: 0 };
  const ranked = (candidates || [])
    .map((candidate) => scoreCandidate(local, candidate, options))
    .sort((left, right) => {
      const tierDifference = (recommendationPriority[right.recommendation] || 0)
        - (recommendationPriority[left.recommendation] || 0);
      return tierDifference || right.score - left.score;
    });
  const minimumGap = Math.max(0, finiteNumber(options.minimumGap, 8));
  const viable = ranked.filter((item) => item.recommendation !== "none");
  for (const item of viable) {
    if (item.recommendation !== "strong") continue;
    const hasCloseAlternative = viable.some((other) => (
      other !== item
      && String(other?.candidate?.provider || "") !== String(item?.candidate?.provider || "")
      && String(other?.candidate?.recordingId || "") !== String(item?.candidate?.recordingId || "")
      && Math.abs(item.score - other.score) < minimumGap
    ));
    if (!hasCloseAlternative) continue;
    if (!item.blockers.some((blocker) => blocker.code === "ambiguous-best")) {
      item.blockers.push({ code: "ambiguous-best", message: "存在两个相近版本", severity: "manual" });
    }
    item.recommendation = "medium";
    item.autoEligible = false;
  }
  return ranked;
}

function buildFieldDiff(localRaw, candidateRaw, requestedFields = FIELD_NAMES) {
  const local = normalizeEvidence(localRaw);
  const candidate = candidateRaw?.candidateId ? candidateRaw : normalizeCandidate(candidateRaw);
  return [...new Set(requestedFields)]
    .filter((field) => FIELD_NAMES.includes(field))
    .map((field) => {
      const current = local[field] ?? null;
      const proposed = candidate[field] ?? null;
      const comparable = (value) => {
        if (Array.isArray(value)) return value.map(normalizeText).join("|");
        if (value && typeof value === "object") return JSON.stringify(value);
        return normalizeText(value);
      };
      const currentKey = comparable(current);
      const proposedKey = comparable(proposed);
      return {
        field,
        current,
        proposed,
        missing: Array.isArray(current)
          ? current.length === 0
          : (current && typeof current === "object" ? !valuePresent(local, field) : isMissingText(current)),
        changed: currentKey !== proposedKey,
        available: valuePresent(candidate, field),
      };
    });
}

module.exports = {
  FIELD_NAMES,
  artistCreditSimilarity,
  artistCreditsEquivalent,
  buildFieldDiff,
  cleanText,
  extractVersionTerms,
  isMissingText,
  listSimilarity,
  normalizeCandidate,
  normalizeEvidence,
  normalizeText,
  rankCandidates,
  scoreCandidate,
  textSimilarity,
};
