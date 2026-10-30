const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const CACHE_VERSION = 1;

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, stableValue(value[key])]),
  );
}

function queryCacheKey(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableValue(value)))
    .digest("hex");
}

class SongInfoQueryCache {
  constructor({
    filePath = "",
    now = () => Date.now(),
    positiveTtlMs = 7 * 24 * 60 * 60 * 1000,
    negativeTtlMs = 15 * 60 * 1000,
    maxEntries = 5000,
    saveDelayMs = 300,
  } = {}) {
    this.filePath = String(filePath || "");
    this.now = now;
    this.positiveTtlMs = positiveTtlMs;
    this.negativeTtlMs = negativeTtlMs;
    this.maxEntries = maxEntries;
    this.saveDelayMs = saveDelayMs;
    this.entries = new Map();
    this.saveTimer = null;
    this.generation = 0;
    this.load();
  }

  snapshotGeneration() {
    return this.generation;
  }

  load() {
    if (!this.filePath || !fs.existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (parsed?.version !== CACHE_VERSION || !parsed.entries || typeof parsed.entries !== "object") return;
      const now = this.now();
      for (const [key, entry] of Object.entries(parsed.entries)) {
        if (!entry || typeof entry !== "object" || Number(entry.expiresAt) <= now) continue;
        this.entries.set(key, entry);
      }
      this.prune();
    } catch (_) {
      // 查询缓存可重建；损坏时保持空缓存。
    }
  }

  get(key) {
    const entry = this.entries.get(String(key || ""));
    if (!entry) return null;
    if (Number(entry.expiresAt) <= this.now()) {
      this.entries.delete(String(key || ""));
      this.scheduleSave();
      return null;
    }
    entry.lastAccessAt = this.now();
    return {
      value: structuredClone(entry.value),
      negative: Boolean(entry.negative),
      cachedAt: Number(entry.cachedAt) || 0,
    };
  }

  set(key, value, { negative = false, generation = null } = {}) {
    if (generation !== null && generation !== this.generation) return false;
    const now = this.now();
    const ttl = negative ? this.negativeTtlMs : this.positiveTtlMs;
    this.entries.set(String(key || ""), {
      value: structuredClone(value),
      negative: Boolean(negative),
      cachedAt: now,
      lastAccessAt: now,
      expiresAt: now + Math.max(1, Number(ttl) || 1),
    });
    this.prune();
    this.scheduleSave();
    return true;
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (Number(entry?.expiresAt) <= now) this.entries.delete(key);
    }
    if (this.entries.size <= this.maxEntries) return;
    const ordered = [...this.entries.entries()]
      .sort((left, right) => Number(left[1]?.lastAccessAt || 0) - Number(right[1]?.lastAccessAt || 0));
    for (const [key] of ordered.slice(0, this.entries.size - this.maxEntries)) this.entries.delete(key);
  }

  scheduleSave() {
    if (!this.filePath || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, this.saveDelayMs);
    this.saveTimer.unref?.();
  }

  flush() {
    if (!this.filePath) return;
    this.prune();
    const parent = path.dirname(this.filePath);
    fs.mkdirSync(parent, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    const payload = {
      version: CACHE_VERSION,
      entries: Object.fromEntries(this.entries),
    };
    try {
      fs.writeFileSync(temporary, JSON.stringify(payload), "utf8");
      fs.renameSync(temporary, this.filePath);
    } finally {
      try {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      } catch (_) {}
    }
  }

  clear({ persist = true } = {}) {
    const cleared = this.entries.size;
    this.generation += 1;
    this.entries.clear();
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (persist) this.flush();
    else this.scheduleSave();
    return cleared;
  }

  close() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.flush();
  }
}

module.exports = {
  CACHE_VERSION,
  SongInfoQueryCache,
  queryCacheKey,
  stableValue,
};
