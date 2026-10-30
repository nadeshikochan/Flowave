const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const {
  isSupportedLyricPathForAudio,
  preferredLyricPathForAudio,
} = require("../lyrics/mirrored-lyric-paths");

const AUDIO_EXTENSIONS = new Set([
  ".mp3", ".flac", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".wma", ".ape",
]);
const MAX_LYRIC_BYTES = 5 * 1024 * 1024;
const MAX_RECENT_TRANSACTIONS = 64;
const RECENT_INDEX_FILE = "recent.json";

class LyricSidecarError extends Error {
  constructor(message, code = "LYRIC_SIDECAR_FAILED") {
    super(message);
    this.name = "LyricSidecarError";
    this.code = code;
  }
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function validTransactionId(value) {
  return /^[a-zA-Z0-9_-]{1,128}$/u.test(String(value || ""));
}

function lyricPathForAudio(audioPath, audioRoot = "") {
  const target = path.resolve(String(audioPath || ""));
  const extension = path.extname(target).toLowerCase();
  if (!AUDIO_EXTENSIONS.has(extension)) {
    throw new LyricSidecarError("unsupported audio path", "INVALID_AUDIO_PATH");
  }
  return preferredLyricPathForAudio(target, audioRoot);
}

function temporaryPathForSidecar(sidecarPath, transactionIdValue) {
  const transactionId = String(transactionIdValue || "");
  if (!validTransactionId(transactionId)) {
    throw new LyricSidecarError("invalid lyric transaction", "INVALID_TRANSACTION");
  }
  const target = path.resolve(String(sidecarPath || ""));
  return path.join(
    path.dirname(target),
    `.${path.basename(target, ".lrc")}.flowave-${transactionId}.tmp.lrc`,
  );
}

async function captureSidecarVersion(sidecarPath) {
  const target = path.resolve(String(sidecarPath || ""));
  try {
    const stat = await fs.promises.stat(target);
    if (!stat.isFile()) throw new LyricSidecarError("lyric path is not a file", "INVALID_LYRIC_PATH");
    const body = await fs.promises.readFile(target);
    return {
      exists: true,
      size: body.length,
      mtimeMs: Number(stat.mtimeMs),
      sha256: sha256(body),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, size: 0, mtimeMs: 0, sha256: "" };
    throw error;
  }
}

function sameVersion(expected, actual) {
  return Boolean(expected?.exists) === Boolean(actual?.exists)
    && Number(expected?.size || 0) === Number(actual?.size || 0)
    && String(expected?.sha256 || "") === String(actual?.sha256 || "");
}

function normalizeLyricText(value) {
  const text = String(value ?? "").replace(/\r\n?/g, "\n");
  if (!text.trim()) throw new LyricSidecarError("lyric is empty", "EMPTY_LYRIC");
  if (text.includes("\0")) throw new LyricSidecarError("lyric contains invalid characters", "INVALID_LYRIC");
  const normalized = text.endsWith("\n") ? text : `${text}\n`;
  const bytes = Buffer.byteLength(normalized, "utf8");
  if (bytes > MAX_LYRIC_BYTES) throw new LyricSidecarError("lyric is too large", "LYRIC_TOO_LARGE");
  return normalized;
}

function atomicWriteJson(filePath, value) {
  const parent = path.dirname(filePath);
  fs.mkdirSync(parent, { recursive: true });
  const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let handle = null;
  try {
    handle = fs.openSync(temporary, "wx");
    fs.writeFileSync(handle, JSON.stringify(value), "utf8");
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

async function writeDurable(filePath, body) {
  const handle = await fs.promises.open(filePath, "wx");
  try {
    await handle.writeFile(body);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncFile(filePath) {
  const handle = await fs.promises.open(filePath, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

class LyricSidecarStore {
  constructor({
    snapshotRoot,
    now = () => Date.now(),
    idFactory = () => crypto.randomUUID(),
    resolveAudioRoot = () => "",
  } = {}) {
    if (!snapshotRoot) throw new TypeError("LyricSidecarStore requires snapshotRoot");
    this.snapshotRoot = path.resolve(String(snapshotRoot));
    this.recentIndexPath = path.join(this.snapshotRoot, RECENT_INDEX_FILE);
    this.now = now;
    this.idFactory = idFactory;
    this.resolveAudioRoot = typeof resolveAudioRoot === "function" ? resolveAudioRoot : () => "";
    this.locks = new Map();
  }

  audioRoot(audioPath = "") {
    return String(this.resolveAudioRoot(audioPath) || "").trim();
  }

  lyricPath(audioPath) {
    return lyricPathForAudio(audioPath, this.audioRoot(audioPath));
  }

  supportsLyricPath(audioPath, lyricPath) {
    return isSupportedLyricPathForAudio(audioPath, lyricPath, this.audioRoot(audioPath));
  }

  async inspect(audioPath) {
    const audio = path.resolve(String(audioPath || ""));
    const audioStat = await fs.promises.stat(audio);
    if (!audioStat.isFile()) throw new LyricSidecarError("audio file is missing", "AUDIO_MISSING");
    const sidecarPath = this.lyricPath(audio);
    return { audioPath: audio, sidecarPath, version: await captureSidecarVersion(sidecarPath) };
  }

  async recoverIncomplete() {
    let entries = [];
    try {
      entries = await fs.promises.readdir(this.snapshotRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const outcomes = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !validTransactionId(entry.name)) continue;
      const manifestPath = path.join(this.snapshotRoot, entry.name, "manifest.json");
      let manifest;
      try {
        manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
      } catch (_) {
        continue;
      }
      if (Number(manifest?.schemaVersion) !== 1
        || String(manifest?.transactionId || "") !== entry.name
        || manifest?.status !== "prepared") continue;
      try {
        outcomes.push(await this.recoverPrepared(manifestPath, manifest));
      } catch (_) {
        outcomes.push({ status: "failed", transactionId: entry.name });
      }
    }
    return outcomes;
  }

  async recoverPrepared(manifestPath, manifest) {
    const transactionId = String(manifest.transactionId || "");
    let audioPath;
    let sidecarPath;
    try {
      audioPath = path.resolve(String(manifest.audioPath || ""));
      sidecarPath = path.resolve(String(manifest.sidecarPath || ""));
      if (!this.supportsLyricPath(audioPath, sidecarPath)) throw new Error("path mismatch");
    } catch (_) {
      manifest.status = "invalid";
      manifest.recovery = {
        status: "invalid",
        reason: "path-mismatch",
        checkedAt: this.now(),
      };
      atomicWriteJson(manifestPath, manifest);
      return { status: "invalid", transactionId };
    }
    return this.withLock(sidecarPath, async () => {
      const current = await captureSidecarVersion(sidecarPath);
      const before = manifest.before || {};
      const after = manifest.after || {};
      if (current.exists
        && current.size === Number(after.size || 0)
        && current.sha256 === String(after.sha256 || "")) {
        manifest.status = "committed";
        manifest.committedAt = this.now();
        manifest.after = current;
        manifest.recoveredAt = this.now();
        atomicWriteJson(manifestPath, manifest);
        try {
          await this.recordRecentTransaction(transactionId, manifest.committedAt);
        } catch (_) {}
        await this.removeVerifiedPreparedTemporary({
          sidecarPath,
          transactionId,
          after,
        });
        return { status: "committed", transactionId };
      }
      if (sameVersion(before, current)) {
        manifest.status = "aborted";
        manifest.abortedAt = this.now();
        manifest.recoveryReason = "original-unchanged";
        atomicWriteJson(manifestPath, manifest);
        await this.removeVerifiedPreparedTemporary({
          sidecarPath,
          transactionId,
          after,
        });
        return { status: "aborted", transactionId };
      }
      manifest.status = "conflict";
      manifest.recovery = {
        status: "conflict",
        reason: "target-changed",
        checkedAt: this.now(),
      };
      atomicWriteJson(manifestPath, manifest);
      await this.removeVerifiedPreparedTemporary({
        sidecarPath,
        transactionId,
        after,
      });
      return { status: "conflict", transactionId, reason: "target-changed" };
    });
  }

  async removeVerifiedPreparedTemporary({ sidecarPath, transactionId, after }) {
    let temporary;
    try {
      temporary = temporaryPathForSidecar(sidecarPath, transactionId);
      const staged = await captureSidecarVersion(temporary);
      if (!staged.exists
        || staged.size !== Number(after?.size || 0)
        || staged.sha256 !== String(after?.sha256 || "")) return false;
      await fs.promises.unlink(temporary);
      return true;
    } catch (_) {
      return false;
    }
  }

  async withLock(target, operation) {
    const key = path.normalize(target).toLowerCase();
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.locks.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }

  async write({
    audioPath,
    lyrics,
    expected,
    skipExisting = true,
    source = "",
    candidateId = "",
    resourceId = "",
  } = {}) {
    const resolvedAudioPath = path.resolve(String(audioPath || ""));
    const sidecarPath = this.lyricPath(resolvedAudioPath);
    return this.withLock(sidecarPath, async () => {
      let audioStat;
      try {
        audioStat = await fs.promises.stat(resolvedAudioPath);
      } catch (error) {
        if (error?.code === "ENOENT") throw new LyricSidecarError("audio file is missing", "AUDIO_MISSING");
        throw error;
      }
      if (!audioStat.isFile()) throw new LyricSidecarError("audio file is missing", "AUDIO_MISSING");
      return this.writeLocked({
        audioPath: resolvedAudioPath,
        sidecarPath,
        lyrics,
        expected,
        skipExisting,
        source,
        candidateId,
        resourceId,
      });
    });
  }

  async writeLocked({ audioPath, sidecarPath, lyrics, expected, skipExisting, source, candidateId, resourceId }) {
    if (!expected || typeof expected !== "object") {
      throw new LyricSidecarError("expected sidecar version is required", "EXPECTED_VERSION_REQUIRED");
    }
    const before = await captureSidecarVersion(sidecarPath);
    if (!sameVersion(expected, before)) {
      throw new LyricSidecarError("lyric changed after confirmation", "EXTERNAL_CHANGE");
    }
    if (skipExisting && before.exists) {
      return { ok: true, status: "skipped-existing", audioPath, sidecarPath, before };
    }

    const text = normalizeLyricText(lyrics);
    const body = Buffer.from(text, "utf8");
    const afterHash = sha256(body);
    if (before.exists && before.sha256 === afterHash) {
      return { ok: true, status: "unchanged", audioPath, sidecarPath, before };
    }

    const transactionId = String(this.idFactory());
    if (!validTransactionId(transactionId)) {
      throw new LyricSidecarError("invalid lyric transaction", "INVALID_TRANSACTION");
    }
    const transactionDir = path.join(this.snapshotRoot, transactionId);
    const snapshotPath = path.join(transactionDir, "original.lrc");
    const manifestPath = path.join(transactionDir, "manifest.json");
    const temporary = temporaryPathForSidecar(sidecarPath, transactionId);
    const manifest = {
      schemaVersion: 1,
      transactionId,
      status: "preparing",
      createdAt: this.now(),
      audioPath,
      sidecarPath,
      resourceId: String(resourceId || ""),
      source: String(source || ""),
      candidateId: String(candidateId || ""),
      before,
      after: { exists: true, size: body.length, sha256: afterHash },
    };

    let replaced = false;
    try {
      await fs.promises.mkdir(this.snapshotRoot, { recursive: true });
      await fs.promises.mkdir(path.dirname(sidecarPath), { recursive: true });
      await fs.promises.mkdir(transactionDir, { recursive: false });
      if (before.exists) {
        await fs.promises.copyFile(sidecarPath, snapshotPath, fs.constants.COPYFILE_EXCL);
        await syncFile(snapshotPath);
        const snapshot = await captureSidecarVersion(snapshotPath);
        if (snapshot.sha256 !== before.sha256) {
          throw new LyricSidecarError("lyric snapshot verification failed", "SNAPSHOT_FAILED");
        }
        manifest.snapshotPath = snapshotPath;
      }
      await writeDurable(temporary, body);
      const staged = await fs.promises.readFile(temporary);
      if (staged.length !== body.length || sha256(staged) !== afterHash) {
        throw new LyricSidecarError("lyric staging verification failed", "VERIFY_FAILED");
      }
      const latest = await captureSidecarVersion(sidecarPath);
      if (!sameVersion(before, latest)) {
        throw new LyricSidecarError("lyric changed during save", "EXTERNAL_CHANGE");
      }
      manifest.status = "prepared";
      atomicWriteJson(manifestPath, manifest);

      await fs.promises.rename(temporary, sidecarPath);
      replaced = true;
      const final = await captureSidecarVersion(sidecarPath);
      if (!final.exists || final.size !== body.length || final.sha256 !== afterHash) {
        throw new LyricSidecarError("saved lyric verification failed", "VERIFY_FAILED");
      }
      manifest.status = "committed";
      manifest.committedAt = this.now();
      manifest.after = final;
      atomicWriteJson(manifestPath, manifest);
      try {
        await this.recordRecentTransaction(transactionId, manifest.committedAt);
      } catch (_) {
        // 最近记录是可重建索引，失败不能把已经验证完成的歌词保存回滚。
      }
      return { ok: true, status: "committed", audioPath, sidecarPath, manifestPath, transactionId, before, after: final };
    } catch (error) {
      if (replaced) await this.restoreAfterFailedCommit(sidecarPath, snapshotPath, before, afterHash);
      throw error;
    } finally {
      try {
        await fs.promises.unlink(temporary);
      } catch (_) {}
    }
  }

  async restoreAfterFailedCommit(sidecarPath, snapshotPath, before, expectedAfterHash) {
    const current = await captureSidecarVersion(sidecarPath);
    if (!current.exists || current.sha256 !== expectedAfterHash) {
      throw new LyricSidecarError("lyric rollback conflict", "ROLLBACK_CONFLICT");
    }
    if (!before.exists) {
      await fs.promises.unlink(sidecarPath);
      return;
    }
    const recovery = path.join(
      path.dirname(sidecarPath),
      `.${path.basename(sidecarPath, ".lrc")}.flowave-recovery-${crypto.randomUUID()}.tmp.lrc`,
    );
    try {
      await fs.promises.copyFile(snapshotPath, recovery, fs.constants.COPYFILE_EXCL);
      await syncFile(recovery);
      const staged = await captureSidecarVersion(recovery);
      if (!sameVersion(before, staged)) {
        throw new LyricSidecarError("lyric rollback verification failed", "ROLLBACK_CONFLICT");
      }
      await fs.promises.rename(recovery, sidecarPath);
    } finally {
      try {
        await fs.promises.unlink(recovery);
      } catch (_) {}
    }
  }

  async undo(manifestPathValue) {
    const manifestPath = path.resolve(String(manifestPathValue || ""));
    const expectedRoot = `${this.snapshotRoot}${path.sep}`;
    if (!manifestPath.startsWith(expectedRoot)
      || path.basename(manifestPath) !== "manifest.json"
      || !validTransactionId(path.basename(path.dirname(manifestPath)))) {
      throw new LyricSidecarError("invalid lyric transaction", "UNDO_CONFLICT");
    }
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
    if (manifest?.status !== "committed") {
      throw new LyricSidecarError("lyric transaction is not undoable", "UNDO_CONFLICT");
    }
    const sidecarPath = path.resolve(String(manifest.sidecarPath || ""));
    const audioPath = path.resolve(String(manifest.audioPath || ""));
    if (String(manifest.transactionId || "") !== path.basename(path.dirname(manifestPath))
      || !this.supportsLyricPath(audioPath, sidecarPath)) {
      throw new LyricSidecarError("invalid lyric transaction", "UNDO_CONFLICT");
    }
    return this.withLock(sidecarPath, async () => {
      const current = await captureSidecarVersion(sidecarPath);
      if (!current.exists || current.sha256 !== String(manifest.after?.sha256 || "")) {
        throw new LyricSidecarError("lyric changed after Flowave save", "UNDO_CONFLICT");
      }
      const before = manifest.before || {};
      if (before.exists) {
        const snapshotPath = path.resolve(String(manifest.snapshotPath || ""));
        const snapshot = await captureSidecarVersion(snapshotPath);
        if (!snapshot.exists || snapshot.sha256 !== String(before.sha256 || "")) {
          throw new LyricSidecarError("lyric undo snapshot is invalid", "UNDO_CONFLICT");
        }
        const recovery = path.join(
          path.dirname(sidecarPath),
          `.${path.basename(sidecarPath, ".lrc")}.flowave-undo-${crypto.randomUUID()}.tmp.lrc`,
        );
        try {
          await fs.promises.copyFile(snapshotPath, recovery, fs.constants.COPYFILE_EXCL);
          await syncFile(recovery);
          const staged = await captureSidecarVersion(recovery);
          if (!sameVersion(before, staged)) {
            throw new LyricSidecarError("lyric undo snapshot is invalid", "UNDO_CONFLICT");
          }
          await fs.promises.rename(recovery, sidecarPath);
        } finally {
          try {
            await fs.promises.unlink(recovery);
          } catch (_) {}
        }
      } else {
        await fs.promises.unlink(sidecarPath);
      }
      const restored = await captureSidecarVersion(sidecarPath);
      if (!sameVersion(before, restored)) {
        throw new LyricSidecarError("lyric undo verification failed", "VERIFY_FAILED");
      }
      manifest.status = "undone";
      manifest.undoneAt = this.now();
      manifest.restored = restored;
      atomicWriteJson(manifestPath, manifest);
      return { ok: true, status: "undone", audioPath, sidecarPath, restored };
    });
  }

  async undoById(transactionIdValue) {
    const transactionId = String(transactionIdValue || "");
    if (!validTransactionId(transactionId)) {
      throw new LyricSidecarError("invalid lyric transaction", "UNDO_CONFLICT");
    }
    const transactionDir = path.resolve(this.snapshotRoot, transactionId);
    const expectedParent = `${this.snapshotRoot}${path.sep}`;
    if (!transactionDir.startsWith(expectedParent)) {
      throw new LyricSidecarError("invalid lyric transaction", "UNDO_CONFLICT");
    }
    return this.undo(path.join(transactionDir, "manifest.json"));
  }

  async recordRecentTransaction(transactionIdValue, committedAtValue) {
    const transactionId = String(transactionIdValue || "");
    if (!validTransactionId(transactionId)) return;
    await this.withLock(this.recentIndexPath, async () => {
      let current = [];
      try {
        const parsed = JSON.parse(await fs.promises.readFile(this.recentIndexPath, "utf8"));
        current = Array.isArray(parsed?.transactions) ? parsed.transactions : [];
      } catch (_) {}
      const transactions = [
        { transactionId, committedAt: Number(committedAtValue) || 0 },
        ...current.filter((entry) => (
          validTransactionId(entry?.transactionId)
          && String(entry.transactionId) !== transactionId
        )),
      ].slice(0, MAX_RECENT_TRANSACTIONS);
      atomicWriteJson(this.recentIndexPath, { schemaVersion: 1, transactions });
    });
  }

  async readUndoableTransaction(transactionIdValue) {
    const transactionId = String(transactionIdValue || "");
    if (!validTransactionId(transactionId)) return null;
    const manifestPath = path.join(this.snapshotRoot, transactionId, "manifest.json");
    try {
      const stat = await fs.promises.stat(manifestPath);
      if (!stat.isFile() || stat.size > 64 * 1024) return null;
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
      if (Number(manifest?.schemaVersion) !== 1
        || String(manifest?.transactionId || "") !== transactionId
        || manifest?.status !== "committed") return null;
      const audioPath = path.resolve(String(manifest.audioPath || ""));
      const sidecarPath = path.resolve(String(manifest.sidecarPath || ""));
      if (!this.supportsLyricPath(audioPath, sidecarPath)) return null;
      const current = await captureSidecarVersion(sidecarPath);
      if (!current.exists || current.sha256 !== String(manifest.after?.sha256 || "")) return null;
      return {
        transactionId,
        committedAt: Math.max(0, Number(manifest.committedAt) || 0),
      };
    } catch (_) {
      return null;
    }
  }

  async scanUndoableTransactions() {
    let ids;
    try {
      ids = (await fs.promises.readdir(this.snapshotRoot, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && validTransactionId(entry.name))
        .map((entry) => entry.name);
    } catch (_) {
      return [];
    }
    const candidates = [];
    for (let offset = 0; offset < ids.length; offset += 16) {
      const batch = await Promise.all(
        ids.slice(offset, offset + 16).map((id) => this.readUndoableTransaction(id)),
      );
      candidates.push(...batch.filter(Boolean));
      candidates.sort((left, right) => right.committedAt - left.committedAt);
      if (candidates.length > MAX_RECENT_TRANSACTIONS) {
        candidates.length = MAX_RECENT_TRANSACTIONS;
      }
    }
    return candidates;
  }

  async listRecentUndoable({ limit = 1 } = {}) {
    const safeLimit = Math.max(1, Math.min(10, Number(limit) || 1));
    let ids = [];
    try {
      const parsed = JSON.parse(await fs.promises.readFile(this.recentIndexPath, "utf8"));
      ids = (Array.isArray(parsed?.transactions) ? parsed.transactions : [])
        .map((entry) => String(entry?.transactionId || ""))
        .filter(validTransactionId)
        .slice(0, MAX_RECENT_TRANSACTIONS);
    } catch (_) {}
    let candidates = (await Promise.all(ids.map((id) => this.readUndoableTransaction(id))))
      .filter(Boolean)
      .sort((left, right) => right.committedAt - left.committedAt);
    if (candidates.length < safeLimit) {
      candidates = await this.scanUndoableTransactions();
      if (candidates.length) {
        try {
          atomicWriteJson(this.recentIndexPath, {
            schemaVersion: 1,
            transactions: candidates,
          });
        } catch (_) {
          // 最近记录是可重建索引，修复失败不影响已验证事务的撤销能力。
        }
      }
    }
    return candidates.slice(0, safeLimit);
  }
}

module.exports = {
  AUDIO_EXTENSIONS,
  LyricSidecarError,
  LyricSidecarStore,
  MAX_LYRIC_BYTES,
  MAX_RECENT_TRANSACTIONS,
  RECENT_INDEX_FILE,
  captureSidecarVersion,
  lyricPathForAudio,
  normalizeLyricText,
  sameVersion,
  temporaryPathForSidecar,
};
