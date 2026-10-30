const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function isHistoryObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function readHistoryFile(filePath, fileSystem = fs) {
  try {
    if (!fileSystem.existsSync(filePath)) {
      return { ok: false, missing: true, error: "文件不存在" };
    }
    const value = JSON.parse(fileSystem.readFileSync(filePath, "utf-8"));
    if (!isHistoryObject(value)) {
      return { ok: false, missing: false, error: "JSON 根节点不是对象" };
    }
    return { ok: true, missing: false, value };
  } catch (error) {
    return {
      ok: false,
      missing: false,
      error: String(error?.message || error || "读取失败"),
    };
  }
}

function writeJsonAtomic(filePath, value, fileSystem = fs) {
  const dir = path.dirname(filePath);
  fileSystem.mkdirSync(dir, { recursive: true });
  const nonce = crypto.randomBytes(4).toString("hex");
  const temporaryPath = path.join(dir, `${path.basename(filePath)}.${process.pid}.${nonce}.tmp`);
  try {
    fileSystem.writeFileSync(temporaryPath, JSON.stringify(value || {}, null, 2), "utf-8");
    fileSystem.renameSync(temporaryPath, filePath);
  } catch (error) {
    try {
      if (fileSystem.existsSync(temporaryPath)) fileSystem.unlinkSync(temporaryPath);
    } catch {
      // 保留原错误。
    }
    throw error;
  }
}

function listListeningHistoryBackups(configDir, fileSystem = fs) {
  const backupDir = path.join(configDir, "listening-history-backups");
  if (!fileSystem.existsSync(backupDir)) return [];
  try {
    return fileSystem.readdirSync(backupDir)
      .map((name) => {
        const match = /^listening_history\.(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
        if (!match) return null;
        return {
          name,
          day: match[1],
          path: path.join(backupDir, name),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.day.localeCompare(a.day));
  } catch {
    return [];
  }
}

function snapshotStamp(timestamp) {
  const date = new Date(timestamp);
  const pad = (value, length = 2) => String(value).padStart(length, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    pad(date.getMilliseconds(), 3),
  ].join("");
}

function archiveCorruptPrimary(primaryPath, configDir, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const randomBytes = options.randomBytes || ((length) => crypto.randomBytes(length));
  const corruptDir = path.join(configDir, "listening-history-corrupt");
  fileSystem.mkdirSync(corruptDir, { recursive: true });
  const randomValue = randomBytes(4);
  const nonce = Buffer.isBuffer(randomValue)
    ? randomValue.toString("hex")
    : String(randomValue || "archive").replace(/[^a-z0-9]+/gi, "").slice(0, 16) || "archive";
  const name = `listening_history.${snapshotStamp(options.now || Date.now())}.${nonce}.corrupt.json`;
  const archivePath = path.join(corruptDir, name);
  fileSystem.copyFileSync(primaryPath, archivePath);
  return { name, path: archivePath };
}

function createStatus(overrides = {}) {
  return {
    state: "primary",
    recovered: false,
    writeBlocked: false,
    sourceBackup: "",
    sourceDay: "",
    corruptArchive: "",
    invalidBackups: [],
    warning: "",
    ...overrides,
  };
}

function loadListeningHistoryWithRecovery(options = {}) {
  const rawConfigDir = String(options.configDir || "").trim();
  if (!rawConfigDir) throw new Error("缺少听歌历史配置目录");
  const configDir = path.resolve(rawConfigDir);
  const fileSystem = options.fileSystem || fs;
  const primaryPath = path.join(configDir, "listening_history.json");
  const primary = readHistoryFile(primaryPath, fileSystem);
  const recoveryPath = path.join(configDir, "listening_history.recovery-pending.json");
  const pending = readHistoryFile(recoveryPath, fileSystem);
  if (primary.ok && pending.ok && pending.value.recoveryKind === "verified-disjoint-days-v1"
      && typeof pending.value.recoveryId === "string" && pending.value.recoveryId
      && isHistoryObject(pending.value.history?.tracks) && isHistoryObject(pending.value.history?.days)
      && isHistoryObject(pending.value.baseline?.tracks)) {
    try {
      if (primary.value.recoveryApplied === pending.value.recoveryId) {
        fileSystem.unlinkSync(recoveryPath);
        return { history: primary.value, status: createStatus() };
      }
      const restored = mergeRecoveryHistory(primary.value, pending.value.history, pending.value.baseline);
      restored.recoveryApplied = pending.value.recoveryId;
      archiveCorruptPrimary(primaryPath, configDir, { fileSystem });
      writeJsonAtomic(primaryPath, restored, fileSystem);
      // 删除失败时下次通过 recoveryApplied 识别，禁止重复累加。
      try { fileSystem.unlinkSync(recoveryPath); } catch { /* 下次启动重试清理。 */ }
      return { history: restored, status: createStatus({ state: "recovered", recovered: true, sourceDay: pending.value.sourceDay || "" }) };
    } catch (error) {
      return { history: primary.value, status: createStatus({ writeBlocked: true, warning: "恢复材料暂未应用，已保留原记录和恢复材料：" + String(error?.message || error) }) };
    }
  }
  if (primary.ok) {
    return {
      history: primary.value,
      status: createStatus(),
    };
  }

  const backups = listListeningHistoryBackups(configDir, fileSystem);
  const invalidBackups = [];
  let recoveredBackup = null;
  for (const backup of backups) {
    const result = readHistoryFile(backup.path, fileSystem);
    if (result.ok) {
      recoveredBackup = { ...backup, value: result.value };
      break;
    }
    invalidBackups.push(backup.name);
  }

  let corruptArchive = "";
  let archiveWarning = "";
  if (!primary.missing) {
    try {
      const archived = archiveCorruptPrimary(primaryPath, configDir, {
        fileSystem,
        randomBytes: options.randomBytes,
        now: options.now,
      });
      corruptArchive = archived.name;
    } catch (error) {
      archiveWarning = `损坏主文件无法归档：${error?.message || error}`;
    }
  }

  if (!recoveredBackup) {
    const hasDamagedData = !primary.missing || backups.length > 0;
    return {
      history: {},
      status: createStatus({
        state: hasDamagedData ? "unrecoverable" : "empty",
        writeBlocked: hasDamagedData,
        corruptArchive,
        invalidBackups,
        warning: hasDamagedData
          ? [archiveWarning, "主文件和现有备份均无法读取，已阻止自动覆盖"].filter(Boolean).join("；")
          : "",
      }),
    };
  }

  let restoreWarning = archiveWarning;
  const canReplacePrimary = primary.missing || !!corruptArchive;
  if (canReplacePrimary) {
    try {
      writeJsonAtomic(primaryPath, recoveredBackup.value, fileSystem);
    } catch (error) {
      restoreWarning = [
        restoreWarning,
        `已在内存恢复，但主文件暂未写回：${error?.message || error}`,
      ].filter(Boolean).join("；");
    }
  } else {
    restoreWarning = [
      restoreWarning,
      "已在内存恢复；因损坏主文件未能归档，本次禁止自动覆盖",
    ].filter(Boolean).join("；");
  }

  return {
    history: recoveredBackup.value,
    status: createStatus({
      state: "recovered",
      recovered: true,
      writeBlocked: !canReplacePrimary,
      sourceBackup: recoveredBackup.name,
      sourceDay: recoveredBackup.day,
      corruptArchive,
      invalidBackups,
      warning: restoreWarning,
    }),
  };
}

module.exports = {
  archiveCorruptPrimary,
  isHistoryObject,
  listListeningHistoryBackups,
  loadListeningHistoryWithRecovery,
  readHistoryFile,
  writeJsonAtomic,
};

// 普通保存只允许累计；主动清空仍通过独立、带快照的维护入口。
function validateHistoryProgress(previous, next) {
  if (!isHistoryObject(next) || !isHistoryObject(next.tracks) || !isHistoryObject(next.days)) return false;
  const n = value => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
  if (n(next.totalSeconds) + 0.001 < n(previous?.totalSeconds) || n(next.totalPlays) < n(previous?.totalPlays)) return false;
  if (!Object.entries(previous?.days || {}).every(([day, seconds]) => n(next.days[day]) + 0.001 >= n(seconds))) return false;
  const pathIds = new Map();
  for (const history of [previous, next]) for (const [key, track] of Object.entries(history?.tracks || {})) {
    if (!track?.resourceId) continue;
    const location = track.path || key;
    if (!pathIds.has(location)) pathIds.set(location, track.resourceId);
    else if (pathIds.get(location) !== track.resourceId) pathIds.set(location, null);
  }
  const totals = history => {
    const rows = new Map();
    for (const [key, track] of Object.entries(history?.tracks || {})) {
      if (!isHistoryObject(track)) return null;
      const resourceId = track.resourceId || pathIds.get(track.path || key);
      const identity = resourceId ? "id:" + resourceId : "path:" + (track.path || key);
      const value = rows.get(identity) || { playCount: 0, listenedSeconds: 0 };
      for (const field of ['playCount', 'listenedSeconds']) {
        if (!Number.isFinite(Number(track[field] || 0)) || Number(track[field] || 0) < 0) return null;
        value[field] += n(track[field]);
      }
      rows.set(identity, value);
    }
    return rows;
  };
  const before = totals(previous), after = totals(next);
  if (!before || !after) return false;
  for (const [identity, stats] of before) {
    const target = after.get(identity);
    if ((stats.playCount > 0 || stats.listenedSeconds > 0) && (!target
        || target.playCount < stats.playCount || target.listenedSeconds + 0.001 < stats.listenedSeconds)) return false;
  }
  return true;
}
module.exports.validateHistoryProgress = validateHistoryProgress;

function mergeRecoveryHistory(current, recovered, baseline = {}) {
  const result = JSON.parse(JSON.stringify(current));
  result.days = { ...current.days };
  for (const [day, seconds] of Object.entries(recovered.days || {})) result.days[day] = Math.max(Number(result.days[day] || 0), Number(seconds || 0));
  result.tracks = { ...current.tracks };
  const ids = new Map(Object.entries(result.tracks).filter(([, t]) => t.resourceId).map(([key,t]) => [t.resourceId,key]));
  for (const [key, track] of Object.entries(recovered.tracks || {})) {
    const target = (track.resourceId && ids.get(track.resourceId)) || key;
    const existing = result.tracks[target];
    if (!existing) { result.tracks[target] = track; if (track.resourceId) ids.set(track.resourceId,target); continue; }
    const original = baseline.tracks?.[key] || Object.values(baseline.tracks || {}).find(t => track.resourceId && t.resourceId === track.resourceId) || {};
    for (const field of ['playCount','listenedSeconds']) existing[field] = Math.max(Number(existing[field] || 0), Number(track[field] || 0) + Math.max(0, Number(existing[field] || 0) - Number(original[field] || 0)));
    for (const field of ['lastPlayedAt','lastCountedAt']) existing[field] = Math.max(Number(existing[field] || 0),Number(track[field] || 0));
  }
  result.totalSeconds = Object.values(result.days).reduce((a,b)=>a+Number(b||0),0);
  result.totalPlays = Object.values(result.tracks).reduce((a,b)=>a+Number(b.playCount||0),0);
  result.updatedAt = Date.now();
  return result;
}
module.exports.mergeRecoveryHistory = mergeRecoveryHistory;
