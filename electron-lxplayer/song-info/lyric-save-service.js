"use strict";

const crypto = require("node:crypto");
const path = require("node:path");
const { wordTimingQuality } = require("../lyrics/word-timing-quality");

const {
  MAX_LINES,
  MAX_TAGS_PER_LINE,
  buildUnifiedLyric,
  exportEnhancedLrc,
  parseLyricChannel,
} = require("../lyrics/unified-lyric");

const DEFAULT_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_CANDIDATE_TTL_MS = 30 * 60 * 1000;
const MAX_PENDING_CONFIRMATIONS = 32;
const MAX_STAGED_CANDIDATES = 64;

class LyricSaveServiceError extends Error {
  constructor(message, code = "LYRIC_SAVE_FAILED") {
    super(message);
    this.name = "LyricSaveServiceError";
    this.code = code;
  }
}

function textFragment(value) {
  return String(value?.text || "");
}

function assertSafeFragment(fragment, lineStartMs) {
  const text = textFragment(fragment);
  if (text.includes("\0")) throw new LyricSaveServiceError("invalid lyric text", "LYRIC_INVALID");
  const words = Array.isArray(fragment?.words) ? fragment.words : [];
  if (words.length > MAX_TAGS_PER_LINE) {
    throw new LyricSaveServiceError("too many lyric words", "LYRIC_TOO_COMPLEX");
  }
  for (const word of words) {
    const startMs = Number(word?.startMs);
    const endMs = word?.endMs === null || word?.endMs === undefined ? null : Number(word.endMs);
    if (!Number.isInteger(startMs) || startMs < 0 || (endMs !== null && (!Number.isInteger(endMs) || endMs < startMs))) {
      throw new LyricSaveServiceError("invalid lyric word time", "LYRIC_INVALID");
    }
    if (startMs < lineStartMs - 60000) {
      throw new LyricSaveServiceError("invalid lyric word time", "LYRIC_INVALID");
    }
    if (String(word?.text || "").includes("\0")) {
      throw new LyricSaveServiceError("invalid lyric text", "LYRIC_INVALID");
    }
  }
}

function validateUnifiedModel(model) {
  if (!model || typeof model !== "object" || Array.isArray(model) || Number(model.schemaVersion) !== 1) {
    throw new LyricSaveServiceError("unsupported lyric model", "LYRIC_MODEL_UNSUPPORTED");
  }
  const lines = Array.isArray(model.lines) ? model.lines : [];
  if (lines.length > MAX_LINES) throw new LyricSaveServiceError("too many lyric lines", "LYRIC_TOO_COMPLEX");
  for (const line of lines) {
    const startMs = Number(line?.startMs);
    const endMs = line?.endMs === null || line?.endMs === undefined ? null : Number(line.endMs);
    if (!Number.isInteger(startMs) || startMs < 0 || (endMs !== null && (!Number.isInteger(endMs) || endMs < startMs))) {
      throw new LyricSaveServiceError("invalid lyric line time", "LYRIC_INVALID");
    }
    assertSafeFragment(line.main, startMs);
    assertSafeFragment(line.translation, startMs);
    assertSafeFragment(line.romanization, startMs);
  }
  for (const role of ["main", "translation", "romanization"]) {
    const plain = String(model?.plain?.[role] || "");
    if (plain.includes("\0")) throw new LyricSaveServiceError("invalid lyric text", "LYRIC_INVALID");
  }
  return model;
}

function normalizeLyricInput(value) {
  if (typeof value === "string") {
    return buildUnifiedLyric({ main: parseLyricChannel(value, { role: "main", format: "auto" }) });
  }
  if (value && typeof value === "object" && Number(value.schemaVersion) === 1) {
    return validateUnifiedModel(value);
  }
  const readChannel = (role) => {
    const channel = value?.[role];
    const plain = typeof value?.plain === "object" ? value.plain?.[role] : (role === "main" ? value?.plain : "");
    const candidates = role === "main"
      ? [value?.synced, value?.syncedLyrics, channel?.synced, channel?.plain, channel, plain]
      : [channel?.synced, channel?.plain, channel, plain];
    return candidates.find((candidate) => typeof candidate === "string" && candidate.trim()) || "";
  };
  const main = readChannel("main");
  if (main) {
    const channels = { main: parseLyricChannel(main, { role: "main", format: "auto" }) };
    for (const role of ["translation", "romanization"]) {
      const source = readChannel(role);
      if (source) channels[role] = parseLyricChannel(source, { role, format: "auto" });
    }
    return buildUnifiedLyric(channels);
  }
  throw new LyricSaveServiceError("lyric content is missing", "LYRIC_EMPTY");
}

function availableChannels(model) {
  const roles = [];
  for (const role of ["main", "translation", "romanization"]) {
    const timed = (model.lines || []).some((line) => textFragment(line?.[role]).trim());
    const plain = String(model?.plain?.[role] || "").trim();
    if (timed || plain) roles.push(role);
  }
  return roles;
}

function publicLyricDescriptor(model) {
  const timing = wordTimingQuality(model);
  return {
    available: true,
    synced: Boolean(model?.synced),
    channels: availableChannels(model),
    wordTimedLines: timing.timedLines,
    lyricLines: timing.lines,
    preview: (model.lines || []).slice(0, 12).map(line => ({
      startMs: line.startMs, text: textFragment(line.main).slice(0, 300),
      translation: textFragment(line.translation).slice(0, 300),
    })),
    plainPreview: String(model?.plain?.main || "").slice(0, 1800),
    qualityLevel: (model.lines || []).some(line => line.main?.words?.length)
      ? "word" : (model?.synced ? "line" : "plain"),
  };
}

function sanitizeLyricDifference(difference, descriptor) {
  const copy = structuredClone(difference || {});
  if (copy.field === "lyrics") {
    copy.current = Boolean(copy.current);
    copy.proposed = Boolean(descriptor?.available);
  }
  return copy;
}

class LyricSaveService {
  constructor({
    store,
    now = () => Date.now(),
    idFactory = () => crypto.randomUUID(),
    candidateTokenFactory = () => crypto.randomUUID(),
    confirmationTtlMs = DEFAULT_CONFIRMATION_TTL_MS,
    candidateTtlMs = DEFAULT_CANDIDATE_TTL_MS,
    onChanged = async () => {},
  } = {}) {
    if (!store || typeof store.inspect !== "function" || typeof store.write !== "function" || typeof store.undoById !== "function") {
      throw new TypeError("LyricSaveService requires a sidecar store");
    }
    this.store = store;
    this.onChanged = onChanged;
    this.now = now;
    this.idFactory = idFactory;
    this.candidateTokenFactory = candidateTokenFactory;
    this.confirmationTtlMs = Math.max(1000, Number(confirmationTtlMs) || DEFAULT_CONFIRMATION_TTL_MS);
    this.candidateTtlMs = Math.max(1000, Number(candidateTtlMs) || DEFAULT_CANDIDATE_TTL_MS);
    this.pending = new Map();
    this.stagedCandidates = new Map();
    this.activeWrites = new Set();
  }

  prune() {
    const now = this.now();
    for (const [id, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(id);
    }
    while (this.pending.size >= MAX_PENDING_CONFIRMATIONS) {
      this.pending.delete(this.pending.keys().next().value);
    }
    for (const [token, entry] of this.stagedCandidates) {
      if (entry.expiresAt <= now) this.stagedCandidates.delete(token);
    }
    while (this.stagedCandidates.size >= MAX_STAGED_CANDIDATES) {
      this.stagedCandidates.delete(this.stagedCandidates.keys().next().value);
    }
  }

  cancelStagedRequest(requestIdValue) {
    const requestId = String(requestIdValue || "");
    if (!requestId) return 0;
    let cancelled = 0;
    for (const [token, entry] of this.stagedCandidates) {
      if (entry.requestId !== requestId) continue;
      this.stagedCandidates.delete(token);
      cancelled += 1;
    }
    for (const [confirmationId, entry] of this.pending) {
      if (entry.requestId !== requestId) continue;
      this.pending.delete(confirmationId);
    }
    return cancelled;
  }

  stageQueryResult({
    requestId,
    trackPath,
    resourceId = "",
    result,
    isSaveApproved = () => false,
  } = {}) {
    this.prune();
    const requestKey = String(requestId || "");
    this.cancelStagedRequest(requestKey);
    const output = structuredClone(result || {});
    output.candidates = (Array.isArray(result?.candidates) ? result.candidates : []).map((item) => {
      const copy = structuredClone(item || {});
      const sourceCandidate = item?.candidate || {};
      const lyrics = sourceCandidate.lyrics;
      if (!copy.candidate || typeof copy.candidate !== "object") copy.candidate = {};
      delete copy.candidate.lyrics;
      let descriptor = null;
      let model = null;
      if (lyrics) {
        try {
          model = normalizeLyricInput(lyrics);
          descriptor = publicLyricDescriptor(model);
          copy.candidate.lyrics = descriptor;
        } catch (_) {
          model = null;
        }
      }
      copy.differences = (Array.isArray(item?.differences) ? item.differences : [])
        .map((difference) => sanitizeLyricDifference(difference, descriptor));
      copy.lyricSaveToken = "";
      if (model && ["strong", "medium"].includes(item?.recommendation)
        && !(item?.blockers || []).some(blocker => blocker.severity === "reject")
        && Boolean(isSaveApproved(sourceCandidate.provider, sourceCandidate))) {
        while (this.stagedCandidates.size >= MAX_STAGED_CANDIDATES) {
          this.stagedCandidates.delete(this.stagedCandidates.keys().next().value);
        }
        const token = String(this.candidateTokenFactory());
        this.stagedCandidates.set(token, {
          requestId: requestKey,
          trackPath: String(trackPath || ""),
          resourceId: String(resourceId || ""),
          identityCorrection: item.identityCorrection || null,
          source: String(sourceCandidate.provider || ""),
          candidateId: String(sourceCandidate.candidateId || ""),
          model,
          expiresAt: this.now() + this.candidateTtlMs,
        });
        copy.lyricSaveToken = token;
      }
      return copy;
    });
    return output;
  }

  async prepare(payload = {}) {
    this.prune();
    const candidateToken = String(payload.candidateToken || "");
    const staged = this.stagedCandidates.get(candidateToken);
    if (!staged) throw new LyricSaveServiceError("lyric candidate expired", "CANDIDATE_EXPIRED");
    const model = validateUnifiedModel(staged.model);
    const includeTranslation = payload.includeTranslation !== false;
    const includeRomanization = payload.includeRomanization === true;
    const format = payload.format === "lrc" ? "lrc" : "enhanced-lrc";
    const lyrics = exportEnhancedLrc(model, {
      includeTranslation,
      includeRomanization,
      includeWordTiming: format !== "lrc",
    });
    if (!lyrics.trim()) throw new LyricSaveServiceError("lyric content is missing", "LYRIC_EMPTY");
    const savedLyrics = `[re:Flowave:user-selected]\n${lyrics}`;
    const inspected = await this.store.inspect(staged.trackPath);
    if (payload.expectedTargetVersion !== undefined && (inspected.version.sha256 || "") !== payload.expectedTargetVersion) {
      throw new LyricSaveServiceError("lyric target changed", "CANDIDATE_CHANGED");
    }
    const confirmationId = String(this.idFactory());
    const expiresAt = this.now() + this.confirmationTtlMs;
    this.pending.set(confirmationId, {
      trackPath: inspected.audioPath,
      expected: inspected.version,
      lyrics: savedLyrics,
      source: staged.source,
      candidateId: staged.candidateId,
      resourceId: staged.resourceId,
      candidateToken,
      requestId: staged.requestId,
      expiresAt,
    });
    return {
      ok: true,
      confirmationId,
      expiresAt,
      identityCorrection: staged.identityCorrection,
      targetExists: Boolean(inspected.version.exists),
      destination: inspected.sidecarPath
        ? path.relative(this.store.audioRoot?.(inspected.audioPath) || path.dirname(inspected.sidecarPath), inspected.sidecarPath) : "",
      outputFormat: format,
      outputBytes: Buffer.byteLength(savedLyrics, "utf8"),
      channels: availableChannels(model),
    };
  }

  cancel(confirmationId) {
    return this.pending.delete(String(confirmationId || ""));
  }

  async prepareLocal({ trackPath, resourceId, action, text, expectedVersion } = {}) {
    this.prune();
    const inspected = await this.store.inspect(trackPath);
    const remove = action === "delete";
    if (remove && !inspected.version.exists) return { ok: false, message: "没有可删除的 KTV 歌词文件" };
    if (!remove && expectedVersion !== inspected.version.sha256) {
      return { ok: false, message: "歌词已变化，请重新打开编辑器" };
    }
    const content = typeof text === "string" ? text.trim() : "";
    if (!remove) {
      if (!content || content.includes("\0") || Buffer.byteLength(content) > 5 * 1024 * 1024
        || content.split(/\r?\n/u, MAX_LINES + 1).length > MAX_LINES) {
        return { ok: false, message: "请输入有效歌词，清空时请使用删除操作" };
      }
      if (!parseLyricChannel(content)?.lines?.some(line => String(line.text || "").trim())) {
        return { ok: false, message: "没有可显示的歌词正文" };
      }
    }
    const confirmationId = String(this.idFactory());
    this.pending.set(confirmationId, {
      trackPath: inspected.audioPath, expected: inspected.version, resourceId,
      source: "manual",
      lyrics: remove ? "" : `[re:Flowave:user-selected]\n${content.replace(/^\[re:.*?\][ \t]*\r?\n/gimu, "")}`,
      remove, expiresAt: this.now() + this.confirmationTtlMs,
    });
    return { ok: true, confirmationId, targetExists: inspected.version.exists };
  }

  async commit({ confirmationId, replaceExisting = false } = {}) {
    this.prune();
    const key = String(confirmationId || "");
    const prepared = this.pending.get(key);
    if (!prepared) throw new LyricSaveServiceError("save confirmation expired", "CONFIRMATION_EXPIRED");
    this.pending.delete(key);
    const operation = Promise.resolve().then(() => this.store.write({
      audioPath: prepared.trackPath,
      lyrics: prepared.lyrics,
      remove: prepared.remove === true,
      expected: prepared.expected,
      skipExisting: !replaceExisting,
      source: prepared.source,
      candidateId: prepared.candidateId,
      resourceId: prepared.resourceId,
    }));
    this.activeWrites.add(operation);
    let result;
    try {
      result = await operation;
    } finally {
      this.activeWrites.delete(operation);
    }
    let refreshFailed = false;
    if (result.status === "committed") {
      try { await this.onChanged(prepared.trackPath, prepared.resourceId); }
      catch (_) { refreshFailed = true; }
    }
    return {
      ok: true,
      status: result.status,
      transactionId: String(result.transactionId || ""),
      replacedExisting: Boolean(result.before?.exists && result.status === "committed"),
      ...(refreshFailed ? { refreshFailed: true } : {}),
    };
  }

  async undo(transactionId, { includeTrackPath = false } = {}) {
    const result = await this.store.undoById(transactionId);
    let refreshFailed = false;
    if (result.status === "undone") {
      try { await this.onChanged(result.audioPath || ""); }
      catch (_) { refreshFailed = true; }
    }
    return { ok: true, status: result.status, ...(refreshFailed ? { refreshFailed: true } : {}),
      ...(includeTrackPath && result.audioPath ? { trackPath: result.audioPath } : {}) };
  }

  async recentUndo({ includeTrackPath = false } = {}) {
    if (typeof this.store.listRecentUndoable !== "function") {
      return { ok: true, transaction: null };
    }
    const [transaction = null] = await this.store.listRecentUndoable({ limit: 1, includeTrackPath });
    return {
      ok: true,
      transaction: transaction ? {
        transactionId: String(transaction.transactionId || ""),
        committedAt: Math.max(0, Number(transaction.committedAt) || 0),
        ...(includeTrackPath && transaction.trackPath ? { trackPath: transaction.trackPath } : {}),
      } : null,
    };
  }

  hasActiveWrites() {
    return this.activeWrites.size > 0;
  }

  async drain({ timeoutMs = 15000 } = {}) {
    const active = [...this.activeWrites];
    if (!active.length) return { drained: true, pending: 0 };
    const waitForWrites = Promise.allSettled(active).then(() => true);
    const limit = Math.max(1, Number(timeoutMs) || 15000);
    let timer = null;
    const timedOut = new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), limit);
    });
    try {
      const drained = await Promise.race([waitForWrites, timedOut]);
      return { drained, pending: this.activeWrites.size };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  close() {
    this.pending.clear();
    this.stagedCandidates.clear();
  }
}

module.exports = {
  DEFAULT_CONFIRMATION_TTL_MS,
  DEFAULT_CANDIDATE_TTL_MS,
  LyricSaveService,
  LyricSaveServiceError,
  MAX_PENDING_CONFIRMATIONS,
  MAX_STAGED_CANDIDATES,
  availableChannels,
  normalizeLyricInput,
  publicLyricDescriptor,
  validateUnifiedModel,
};
