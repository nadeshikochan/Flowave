const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { FIELD_NAMES } = require("./candidate-model");

const STORE_VERSION = 1;
const TASK_MODES = new Set(["preview", "lyric-sidecar"]);
const RUNNING_STATES = new Set(["scanning", "querying", "scoring", "cancelling", "writing", "verifying"]);
const TERMINAL_STATES = new Set(["completed", "cancelled", "failed"]);
const RETRYABLE_ITEM_STATES = new Set(["failed", "cancelled"]);

class BatchTaskError extends Error {
  constructor(message, code = "BATCH_TASK_FAILED") {
    super(message);
    this.name = "BatchTaskError";
    this.code = code;
  }
}

function clampThreshold(value, fallback, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(minimum, Math.min(maximum, number)) : fallback;
}

function clampConcurrency(value, fallback = 4) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.max(1, Math.min(12, number)) : fallback;
}

function normalizeTrackRef(value) {
  const item = value && typeof value === "object" ? value : {};
  const trackPath = String(item.path || "").trim();
  if (!trackPath || !path.isAbsolute(trackPath)) return null;
  return {
    resourceId: String(item.resourceId || "").trim(),
    songKey: String(item.songKey || "").trim(),
    path: path.resolve(trackPath),
  };
}

function trackIdentity(track) {
  return track.resourceId || path.normalize(track.path).toLowerCase();
}

function safeDifference(value) {
  const difference = structuredClone(value || {});
  if (difference.field === "lyrics") {
    difference.current = Boolean(difference.current);
    difference.proposed = Boolean(difference.proposed);
  }
  return difference;
}

function safeCandidateData(value, { lyricMode = false } = {}) {
  const source = value && typeof value === "object" ? value : {};
  if (lyricMode) {
    return {
      candidateId: String(source.candidateId || ""),
      provider: String(source.provider || ""),
      providerVersion: String(source.providerVersion || ""),
      sourceLabel: String(source.sourceLabel || source.provider || ""),
      title: String(source.title || ""),
      artists: (Array.isArray(source.artists) ? source.artists : []).map(String).slice(0, 20),
      album: String(source.album || ""),
      durationSeconds: Math.max(0, Number(source.durationSeconds) || 0),
      provenance: {
        provider: String(source.provenance?.provider || source.provider || ""),
        providerVersion: String(source.provenance?.providerVersion || source.providerVersion || ""),
        sourceRecordId: String(source.provenance?.sourceRecordId || ""),
      },
    };
  }
  const candidate = structuredClone(source);
  delete candidate.lyrics;
  if (candidate.cover && typeof candidate.cover === "object") {
    candidate.cover = {
      assetId: String(candidate.cover.assetId || ""),
      provider: String(candidate.cover.provider || ""),
    };
  }
  return candidate;
}

function safeCandidates(candidates, options = {}) {
  return (Array.isArray(candidates) ? candidates : []).slice(0, 5).map((item) => {
    const candidate = safeCandidateData(item?.candidate, options);
    return {
      candidate,
      score: Number(item?.score || 0),
      recommendation: ["strong", "medium", "none"].includes(item?.recommendation)
        ? item.recommendation
        : "none",
      reasons: (item?.reasons || []).map(String).slice(0, 8),
      blockers: (item?.blockers || []).map((blocker) => (
        typeof blocker === "object" && blocker ? String(blocker.message || blocker.code || "") : String(blocker)
      )).filter(Boolean).slice(0, 8),
      differences: (Array.isArray(item?.differences) ? item.differences : []).map(safeDifference),
    };
  });
}

function safeCurrent(value) {
  const current = structuredClone(value && typeof value === "object" ? value : {});
  if (current.cover) current.cover = true;
  if (current.lyrics) current.lyrics = true;
  return current;
}

function safeSources(sources) {
  return (Array.isArray(sources) ? sources : []).slice(0, 20).map((source) => ({
    id: String(source?.id || ""),
    label: String(source?.label || source?.id || ""),
    status: String(source?.status || ""),
    cached: Boolean(source?.cached),
    count: Math.max(0, Number(source?.count) || 0),
    retryable: Boolean(source?.retryable),
  }));
}

function parseStorePayload(raw) {
  const parsed = JSON.parse(raw);
  if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.tasks)) {
    throw new BatchTaskError("unsupported batch task store", "STORE_INVALID");
  }
  for (const task of parsed.tasks) {
    if (!task || typeof task !== "object" || !task.id || !Array.isArray(task.items)) {
      throw new BatchTaskError("invalid batch task", "STORE_INVALID");
    }
  }
  return parsed;
}

function atomicWrite(filePath, payload) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let handle = null;
  try {
    handle = fs.openSync(temporary, "wx");
    fs.writeFileSync(handle, JSON.stringify(payload), "utf8");
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(temporary, filePath);
  } finally {
    if (handle !== null) {
      try { fs.closeSync(handle); } catch (_) {}
    }
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch (_) {}
  }
}

function taskCounts(task) {
  const counts = {
    total: task.items.length,
    pending: 0,
    matchedAuto: 0,
    awaitingConfirmation: 0,
    confirmed: 0,
    writtenAuto: 0,
    skippedComplete: 0,
    skipped: 0,
    noMatch: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const item of task.items) {
    if (["pending", "querying", "writing", "verifying"].includes(item.status)) counts.pending += 1;
    else if (item.status === "matched-auto") counts.matchedAuto += 1;
    else if (item.status === "awaiting-confirmation") counts.awaitingConfirmation += 1;
    else if (item.status === "confirmed") counts.confirmed += 1;
    else if (item.status === "written-auto") counts.writtenAuto += 1;
    else if (item.status === "skipped-complete") counts.skippedComplete += 1;
    else if (item.status === "skipped") counts.skipped += 1;
    else if (item.status === "no-match") counts.noMatch += 1;
    else if (item.status === "failed") counts.failed += 1;
    else if (item.status === "cancelled") counts.cancelled += 1;
  }
  return counts;
}

function taskPatch(task, changedItems = []) {
  const items = new Map();
  for (const item of Array.isArray(changedItems) ? changedItems : []) {
    if (item?.id) items.set(String(item.id), structuredClone(item));
  }
  return {
    kind: "task-patch",
    task: {
      id: String(task.id),
      state: String(task.state || ""),
      updatedAt: Number(task.updatedAt || 0),
      cancelRequested: Boolean(task.cancelRequested),
      counts: structuredClone(task.counts || taskCounts(task)),
    },
    items: [...items.values()],
  };
}

class BatchSongInfoTaskManager {
  constructor({
    filePath,
    queryTrack,
    queryLyrics = null,
    saveLyrics = null,
    cancelQuery = () => false,
    now = () => Date.now(),
    idFactory = () => crypto.randomUUID(),
    maxTasks = 20,
    onUpdate = () => {},
    checkpointEvery = 10,
  } = {}) {
    if (!filePath || typeof queryTrack !== "function") {
      throw new TypeError("BatchSongInfoTaskManager requires filePath and queryTrack");
    }
    this.filePath = path.resolve(String(filePath));
    this.previousPath = `${this.filePath}.previous`;
    this.queryTrack = queryTrack;
    this.queryLyrics = typeof queryLyrics === "function" ? queryLyrics : null;
    this.saveLyrics = typeof saveLyrics === "function" ? saveLyrics : null;
    this.cancelQuery = cancelQuery;
    this.now = now;
    this.idFactory = idFactory;
    this.maxTasks = Math.max(1, Number(maxTasks) || 20);
    this.onUpdate = onUpdate;
    this.checkpointEvery = Math.max(1, Number(checkpointEvery) || 10);
    this.tasks = new Map();
    this.controllers = new Map();
    this.activeTaskId = "";
    this.writeBlocked = false;
    this.loadStatus = "empty";
    this.load();
  }

  load() {
    const candidates = [
      { path: this.filePath, status: "loaded" },
      { path: this.previousPath, status: "recovered" },
    ];
    let sawUnreadable = false;
    for (const candidate of candidates) {
      if (!fs.existsSync(candidate.path)) continue;
      try {
        const payload = parseStorePayload(fs.readFileSync(candidate.path, "utf8"));
        for (const rawTask of payload.tasks) {
          const task = structuredClone(rawTask);
          task.mode = TASK_MODES.has(task.mode) ? task.mode : "preview";
          task.concurrency = clampConcurrency(task.concurrency);
          if (RUNNING_STATES.has(task.state)) task.state = "paused";
          task.cancelRequested = false;
          task.items.forEach((item) => {
            if (["querying", "scoring", "writing", "verifying"].includes(item.status)) item.status = "pending";
            item.candidates = safeCandidates(item.candidates, { lyricMode: task.mode === "lyric-sidecar" });
            item.sources = safeSources(item.sources);
            item.current = safeCurrent(item.current);
            delete item.requestId;
          });
          task.counts = taskCounts(task);
          this.tasks.set(String(task.id), task);
        }
        this.loadStatus = candidate.status;
        return;
      } catch (_) {
        sawUnreadable = true;
      }
    }
    if (sawUnreadable) {
      this.writeBlocked = true;
      this.loadStatus = "unrecoverable";
    }
  }

  ensureWritable() {
    if (this.writeBlocked) {
      throw new BatchTaskError("batch task store is unrecoverable", "STORE_WRITE_BLOCKED");
    }
  }

  save() {
    this.ensureWritable();
    if (fs.existsSync(this.filePath)) {
      try {
        parseStorePayload(fs.readFileSync(this.filePath, "utf8"));
        fs.mkdirSync(path.dirname(this.previousPath), { recursive: true });
        fs.copyFileSync(this.filePath, this.previousPath);
        const previousHandle = fs.openSync(this.previousPath, "r");
        try {
          fs.fsyncSync(previousHandle);
        } finally {
          fs.closeSync(previousHandle);
        }
      } catch (_) {
        // 当前代已损坏时不覆盖最后一份可恢复 previous。
      }
    }
    atomicWrite(this.filePath, {
      version: STORE_VERSION,
      savedAt: this.now(),
      tasks: [...this.tasks.values()],
    });
  }

  prune() {
    if (this.tasks.size <= this.maxTasks) return;
    const removable = [...this.tasks.values()]
      .filter((task) => TERMINAL_STATES.has(task.state))
      .sort((left, right) => Number(left.updatedAt || 0) - Number(right.updatedAt || 0));
    for (const task of removable) {
      if (this.tasks.size <= this.maxTasks) break;
      this.tasks.delete(task.id);
    }
  }

  create({
    tracks,
    requestedFields,
    autoThreshold = 95,
    manualThreshold = 75,
    minimumGap = 8,
    concurrency = 4,
    mode = "preview",
    lyricOptions = {},
  } = {}) {
    this.ensureWritable();
    if ([...this.tasks.values()].some((task) => !TERMINAL_STATES.has(task.state))) {
      throw new BatchTaskError("an unfinished batch task already exists", "TASK_UNFINISHED");
    }
    const seen = new Set();
    const normalizedTracks = [];
    for (const rawTrack of Array.isArray(tracks) ? tracks : []) {
      const track = normalizeTrackRef(rawTrack);
      if (!track) continue;
      const identity = trackIdentity(track);
      if (seen.has(identity)) continue;
      seen.add(identity);
      normalizedTracks.push(track);
    }
    if (!normalizedTracks.length) throw new BatchTaskError("batch task has no local tracks", "EMPTY_TASK");
    const taskMode = TASK_MODES.has(mode) ? mode : "preview";
    if (taskMode === "lyric-sidecar" && (!this.queryLyrics || !this.saveLyrics)) {
      throw new BatchTaskError("lyric sidecar mode is unavailable", "LYRIC_MODE_UNAVAILABLE");
    }
    const fields = taskMode === "lyric-sidecar"
      ? ["lyrics"]
      : [...new Set((requestedFields || FIELD_NAMES).filter((field) => FIELD_NAMES.includes(field)))];
    if (!fields.length) throw new BatchTaskError("batch task has no fields", "EMPTY_FIELDS");
    const automatic = clampThreshold(autoThreshold, 95, 90, 99);
    const manual = Math.min(automatic - 1, clampThreshold(manualThreshold, 75, 60, 94));
    const now = this.now();
    const task = {
      schemaVersion: 1,
      id: String(this.idFactory()),
      mode: taskMode,
      state: "draft",
      createdAt: now,
      updatedAt: now,
      requestedFields: fields,
      thresholds: {
        auto: automatic,
        manual,
        minimumGap: Math.max(0, Number(minimumGap) || 0),
      },
      concurrency: clampConcurrency(concurrency),
      lyricOptions: taskMode === "lyric-sidecar" ? {
        includeTranslation: lyricOptions?.includeTranslation !== false,
        includeRomanization: lyricOptions?.includeRomanization === true,
        sources: (Array.isArray(lyricOptions?.sources) ? lyricOptions.sources : ["external", "embedded"])
          .map(String)
          .filter((source) => ["external", "embedded"].includes(source)),
        skipExisting: lyricOptions?.skipExisting !== false,
        format: lyricOptions?.format === "lrc" ? "lrc" : "enhanced-lrc",
      } : undefined,
      cancelRequested: false,
      items: normalizedTracks.map((track, index) => ({
        id: `${index + 1}`,
        track,
        status: "pending",
        attempts: 0,
        candidates: [],
        sources: [],
        errorCode: "",
      })),
    };
    task.counts = taskCounts(task);
    this.tasks.set(task.id, task);
    this.prune();
    this.save();
    return structuredClone(task);
  }

  get(taskId) {
    const task = this.tasks.get(String(taskId || ""));
    return task ? structuredClone(task) : null;
  }

  list() {
    return [...this.tasks.values()]
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
      .map((task) => structuredClone(task));
  }

  touch(task, { persist = true, changedItems = [] } = {}) {
    task.updatedAt = this.now();
    task.counts = taskCounts(task);
    if (persist) this.save();
    try {
      this.onUpdate(taskPatch(task, changedItems));
    } catch (_) {}
  }

  async saveLyricResult({ task, item, result, candidateId, requestId, automatic }) {
    if (task.mode !== "lyric-sidecar" || !this.saveLyrics) {
      throw new BatchTaskError("lyric sidecar mode is unavailable", "LYRIC_MODE_UNAVAILABLE");
    }
    item.status = "writing";
    task.state = "writing";
    this.touch(task, { changedItems: [item] });
    const saved = await this.saveLyrics({
      requestId,
      track: structuredClone(item.track),
      result,
      candidateId: String(candidateId || ""),
      includeTranslation: task.lyricOptions?.includeTranslation !== false,
      includeRomanization: task.lyricOptions?.includeRomanization === true,
      format: task.lyricOptions?.format || "enhanced-lrc",
      replaceExisting: automatic !== true
        && task.lyricOptions?.skipExisting === false
        && result?.replacingExisting === true,
    });
    if (!saved?.ok) {
      throw new BatchTaskError("lyric sidecar save failed", String(saved?.code || "LYRIC_SAVE_FAILED"));
    }
    if (saved.status === "committed") {
      item.status = automatic ? "written-auto" : "confirmed";
      item.errorCode = "";
      return;
    }
    if (["skipped-existing", "skipped-complete"].includes(saved.status)) {
      item.status = "skipped-complete";
      item.errorCode = "";
      return;
    }
    throw new BatchTaskError("unexpected lyric sidecar result", "LYRIC_SAVE_FAILED");
  }

  async start(taskId) {
    this.ensureWritable();
    const key = String(taskId || "");
    const task = this.tasks.get(key);
    if (!task) throw new BatchTaskError("batch task was not found", "TASK_NOT_FOUND");
    if (this.controllers.has(key)) return this.get(key);
    if (this.activeTaskId && this.activeTaskId !== key) {
      throw new BatchTaskError("another batch task is running", "TASK_BUSY");
    }
    if (TERMINAL_STATES.has(task.state) && !task.items.some((item) => item.status === "pending")) return this.get(key);
    task.cancelRequested = false;
    task.state = "querying";
    const controller = new AbortController();
    let pausedState = "";
    this.controllers.set(key, controller);
    this.activeTaskId = key;
    this.touch(task);
    try {
      const pendingItems = task.items.filter((item) => item.status === "pending");
      let nextIndex = 0;
      let processedSinceCheckpoint = 0;
      const processNext = async () => {
        while (!controller.signal.aborted && !pausedState) {
          const item = pendingItems[nextIndex];
          nextIndex += 1;
          if (!item) return;
          if (item.status !== "pending") continue;
        task.state = "querying";
        item.status = "querying";
        item.attempts = Number(item.attempts || 0) + 1;
        item.errorCode = "";
        const requestId = `batch:${task.id}:${item.id}:${item.attempts}`;
        item.requestId = requestId;
        this.touch(task, { persist: false, changedItems: [item] });
        try {
          const query = task.mode === "lyric-sidecar" ? this.queryLyrics : this.queryTrack;
          const result = await query({
            requestId,
            trackPath: item.track.path,
            resourceId: item.track.resourceId,
            requestedFields: task.mode === "lyric-sidecar" ? undefined : task.requestedFields,
            autoThreshold: task.thresholds.auto,
            manualThreshold: task.thresholds.manual,
            minimumGap: task.thresholds.minimumGap,
            onlyMissing: task.mode === "lyric-sidecar"
              ? task.lyricOptions?.skipExisting !== false
              : true,
            storageTarget: task.mode === "lyric-sidecar" ? "sidecar" : undefined,
            lyricSources: task.mode === "lyric-sidecar" ? task.lyricOptions?.sources : undefined,
            signal: controller.signal,
          });
          if (controller.signal.aborted) break;
          item.sources = safeSources(result?.sources);
          item.current = safeCurrent(result?.current);
          item.candidates = safeCandidates(result?.candidates, { lyricMode: task.mode === "lyric-sidecar" });
          const best = item.candidates[0];
          const sourceWorked = item.sources.some((source) => ["ok", "empty"].includes(source?.status));
          const rateLimited = item.sources.some((source) => source?.status === "rate-limited");
          if (result?.skipped === "complete") {
            item.status = "skipped-complete";
          } else if (result?.ok === false) {
            item.status = "failed";
            item.errorCode = String(result?.code || "QUERY_FAILED");
          } else if (!best && rateLimited && !sourceWorked) {
            item.status = "pending";
            item.errorCode = "RATE_LIMITED";
            pausedState = "paused-rate-limit";
          } else if (!best && item.sources.length && !sourceWorked) {
            item.status = "failed";
            item.errorCode = String(item.sources[0]?.status || "PROVIDER_UNAVAILABLE").toUpperCase();
          } else if (!best) item.status = "no-match";
          else if (best.recommendation === "strong" && task.mode === "lyric-sidecar") {
            const candidateId = String(result?.candidates?.[0]?.candidate?.candidateId || "");
            if (!candidateId) throw new BatchTaskError("lyric candidate has no identity", "CANDIDATE_INVALID");
            await this.saveLyricResult({
              task,
              item,
              result,
              candidateId,
              requestId,
              automatic: true,
            });
          } else if (best.recommendation === "strong") item.status = "matched-auto";
          else if (best.recommendation === "medium") item.status = "awaiting-confirmation";
          else item.status = "no-match";
        } catch (error) {
          if (controller.signal.aborted || error?.name === "AbortError" || error?.code === "ABORTED") {
            item.status = task.cancelRequested ? "cancelled" : "pending";
          } else {
            item.status = "failed";
            item.errorCode = String(error?.code || "QUERY_FAILED");
          }
        } finally {
          delete item.requestId;
          processedSinceCheckpoint += 1;
          const checkpointDue = processedSinceCheckpoint >= this.checkpointEvery;
          if (checkpointDue) processedSinceCheckpoint = 0;
          this.touch(task, {
            persist: Boolean(pausedState || task.cancelRequested || checkpointDue),
            changedItems: [item],
          });
        }
        }
      };
      const workerCount = Math.min(clampConcurrency(task.concurrency), pendingItems.length);
      await Promise.all(Array.from({ length: workerCount }, () => processNext()));
      const finalChangedItems = [];
      if (task.cancelRequested) {
        task.items.forEach((item) => {
          if (["pending", "querying"].includes(item.status)) {
            item.status = "cancelled";
            finalChangedItems.push(item);
          }
        });
        task.state = "cancelled";
      } else if (pausedState) {
        task.state = pausedState;
      } else if (controller.signal.aborted) {
        task.items.forEach((item) => {
          if (item.status === "querying") item.status = "pending";
        });
        task.state = "paused";
      } else if (task.items.some((item) => item.status === "awaiting-confirmation")) {
        task.state = "awaiting-confirmation";
      } else {
        task.state = "completed";
      }
      this.touch(task, { changedItems: finalChangedItems });
      return this.get(key);
    } finally {
      if (this.controllers.get(key) === controller) this.controllers.delete(key);
      if (this.activeTaskId === key) this.activeTaskId = "";
    }
  }

  cancel(taskId) {
    const key = String(taskId || "");
    const task = this.tasks.get(key);
    if (!task) return false;
    if (TERMINAL_STATES.has(task.state)) return false;
    task.cancelRequested = true;
    task.state = "cancelling";
    const activeItem = task.items.find((item) => ["querying", "writing", "verifying"].includes(item.status));
    if (activeItem?.requestId && activeItem.status === "querying") this.cancelQuery(activeItem.requestId, task.mode);
    this.controllers.get(key)?.abort();
    this.touch(task);
    return true;
  }

  retry(taskId, itemIds = []) {
    this.ensureWritable();
    const task = this.tasks.get(String(taskId || ""));
    if (!task) throw new BatchTaskError("batch task was not found", "TASK_NOT_FOUND");
    const selected = new Set((itemIds || []).map(String).filter(Boolean));
    if (!selected.size) return { changed: 0, task: this.get(task.id) };
    let changed = 0;
    const changedItems = [];
    for (const item of task.items) {
      if (!selected.has(String(item.id))) continue;
      if (!RETRYABLE_ITEM_STATES.has(item.status)) continue;
      item.status = "pending";
      item.errorCode = "";
      item.candidates = [];
      item.sources = [];
      changed += 1;
      changedItems.push(item);
    }
    if (changed) {
      task.cancelRequested = false;
      task.state = "draft";
      this.touch(task, { changedItems });
    }
    return { changed, task: this.get(task.id) };
  }

  confirmCandidate(taskId, itemId, candidateIndex = 0) {
    this.ensureWritable();
    const task = this.tasks.get(String(taskId || ""));
    const item = task?.items.find((entry) => String(entry.id) === String(itemId));
    if (!task || !item) throw new BatchTaskError("batch task item was not found", "ITEM_NOT_FOUND");
    if (item.status !== "awaiting-confirmation") {
      throw new BatchTaskError("batch task item is not awaiting confirmation", "INVALID_ITEM_STATE");
    }
    const candidate = item.candidates[Number(candidateIndex) || 0];
    if (!candidate || candidate.recommendation === "none") {
      throw new BatchTaskError("candidate cannot be confirmed", "INVALID_CANDIDATE");
    }
    if (task.mode === "lyric-sidecar") {
      return this.confirmLyricCandidate(task, item, Number(candidateIndex) || 0, candidate);
    }
    item.selectedCandidate = Number(candidateIndex) || 0;
    item.status = "confirmed";
    task.state = task.items.some((entry) => entry.status === "awaiting-confirmation")
      ? "awaiting-confirmation"
      : "completed";
    this.touch(task, { changedItems: [item] });
    return this.get(task.id);
  }

  async confirmLyricCandidate(task, item, candidateIndex, storedCandidate) {
    if (this.controllers.has(task.id) || (this.activeTaskId && this.activeTaskId !== task.id)) {
      throw new BatchTaskError("another batch task is running", "TASK_BUSY");
    }
    const candidateId = String(storedCandidate?.candidate?.candidateId || "");
    if (!candidateId) throw new BatchTaskError("lyric candidate has no identity", "CANDIDATE_INVALID");
    const controller = new AbortController();
    item.attempts = Number(item.attempts || 0) + 1;
    const requestId = `batch-confirm:${task.id}:${item.id}:${item.attempts}`;
    item.requestId = requestId;
    item.status = "querying";
    item.errorCode = "";
    task.state = "querying";
    this.controllers.set(task.id, controller);
    this.activeTaskId = task.id;
    this.touch(task, { persist: false, changedItems: [item] });
    try {
      const result = await this.queryLyrics({
        requestId,
        trackPath: item.track.path,
        resourceId: item.track.resourceId,
        autoThreshold: task.thresholds.auto,
        manualThreshold: task.thresholds.manual,
        minimumGap: task.thresholds.minimumGap,
        onlyMissing: task.lyricOptions?.skipExisting !== false,
        storageTarget: "sidecar",
        lyricSources: task.lyricOptions?.sources,
        signal: controller.signal,
      });
      if (controller.signal.aborted) throw new BatchTaskError("batch query aborted", "ABORTED");
      if (result?.skipped === "complete") {
        item.status = "skipped-complete";
      } else {
        const freshCandidates = Array.isArray(result?.candidates) ? result.candidates : [];
        const fresh = freshCandidates.find((entry) => (
          String(entry?.candidate?.candidateId || "") === candidateId
          && ["strong", "medium"].includes(entry?.recommendation)
        ));
        if (!fresh) {
          item.status = "awaiting-confirmation";
          item.errorCode = "CANDIDATE_CHANGED";
          throw new BatchTaskError("lyric candidate changed", "CANDIDATE_CHANGED");
        }
        item.candidates = safeCandidates(freshCandidates, { lyricMode: true });
        await this.saveLyricResult({
          task,
          item,
          result,
          candidateId,
          requestId,
          automatic: false,
        });
        item.selectedCandidate = item.candidates.findIndex((entry) => (
          String(entry?.candidate?.candidateId || "") === candidateId
        ));
      }
      const changedItems = [item];
      if (task.cancelRequested) {
        task.items.forEach((entry) => {
          if (["pending", "querying", "awaiting-confirmation"].includes(entry.status)) {
            entry.status = "cancelled";
            changedItems.push(entry);
          }
        });
        task.state = "cancelled";
      } else {
        task.state = task.items.some((entry) => entry.status === "awaiting-confirmation")
          ? "awaiting-confirmation"
          : "completed";
      }
      delete item.requestId;
      this.touch(task, { changedItems });
      return this.get(task.id);
    } catch (error) {
      if (item.status !== "awaiting-confirmation") {
        item.status = error?.code === "ABORTED" ? "cancelled" : "failed";
        item.errorCode = String(error?.code || "LYRIC_SAVE_FAILED");
      }
      const changedItems = [item];
      if (task.cancelRequested) {
        task.items.forEach((entry) => {
          if (["pending", "querying", "awaiting-confirmation"].includes(entry.status)) {
            entry.status = "cancelled";
            changedItems.push(entry);
          }
        });
        task.state = "cancelled";
      } else {
        task.state = task.items.some((entry) => entry.status === "awaiting-confirmation")
          ? "awaiting-confirmation"
          : (item.status === "cancelled" ? "cancelled" : "failed");
      }
      delete item.requestId;
      this.touch(task, { changedItems });
      throw error;
    } finally {
      delete item.requestId;
      if (this.controllers.get(task.id) === controller) this.controllers.delete(task.id);
      if (this.activeTaskId === task.id) this.activeTaskId = "";
    }
  }

  skipItem(taskId, itemId) {
    this.ensureWritable();
    const task = this.tasks.get(String(taskId || ""));
    const item = task?.items.find((entry) => String(entry.id) === String(itemId));
    if (!task || !item) throw new BatchTaskError("batch task item was not found", "ITEM_NOT_FOUND");
    if (item.status !== "awaiting-confirmation") {
      throw new BatchTaskError("batch task item is not awaiting confirmation", "INVALID_ITEM_STATE");
    }
    item.status = "skipped";
    delete item.selectedCandidate;
    task.state = task.items.some((entry) => entry.status === "awaiting-confirmation")
      ? "awaiting-confirmation"
      : "completed";
    this.touch(task, { changedItems: [item] });
    return this.get(task.id);
  }

  close() {
    for (const [taskId, controller] of this.controllers) {
      const task = this.tasks.get(taskId);
      const activeItem = task?.items.find((item) => ["querying", "writing", "verifying"].includes(item.status));
      if (activeItem?.requestId && activeItem.status === "querying") this.cancelQuery(activeItem.requestId, task.mode);
      controller.abort();
      if (task && !task.cancelRequested) {
        const changedItems = [];
        task.items.forEach((item) => {
          if (item.status === "querying") {
            item.status = "pending";
            changedItems.push(item);
          }
        });
        task.state = "paused";
        this.touch(task, { changedItems });
      }
    }
    this.controllers.clear();
    this.activeTaskId = "";
  }
}

module.exports = {
  BatchSongInfoTaskManager,
  BatchTaskError,
  RETRYABLE_ITEM_STATES,
  taskPatch,
  RUNNING_STATES,
  STORE_VERSION,
  normalizeTrackRef,
  parseStorePayload,
  safeCandidates,
  taskCounts,
};
