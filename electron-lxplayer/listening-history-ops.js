function cloneHistory(value) {
  try {
    return JSON.parse(JSON.stringify(value && typeof value === "object" ? value : {}));
  } catch {
    return {};
  }
}

function nonNegative(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

function neutralRecommendationBehavior(path = "") {
  return {
    songKey: "",
    skipOpportunityCount: 0,
    dislikeChainSkipCount: 0,
    lastSkipAt: 0,
    lastOpportunityAt: 0,
    smoothedSkipRate: 0,
    skipNorm: 1,
    skipFix: 1,
    skipStatsUpdatedAt: 0,
    path: String(path || ""),
  };
}

function neutralRecommendationSummary(raw = {}, now = Date.now()) {
  const source = raw && typeof raw === "object" ? raw : {};
  const dailyDecay = Number(source.dailyDecay);
  return {
    version: Math.max(1, Math.floor(nonNegative(source.version || 1))),
    updatedAt: nonNegative(now),
    updatedDay: "",
    globalSkipRate: 0,
    totalSkipOpportunityCount: 0,
    totalDislikeChainSkipCount: 0,
    dailyDecay: Number.isFinite(dailyDecay) ? Math.max(0, Math.min(1, dailyDecay)) : 0.98,
  };
}

function hasRecommendationLearning(raw) {
  if (!raw || typeof raw !== "object") return false;
  if (String(raw.songKey || "").trim()) return true;
  if (nonNegative(raw.skipOpportunityCount) > 0) return true;
  if (nonNegative(raw.dislikeChainSkipCount) > 0) return true;
  if (nonNegative(raw.lastSkipAt) > 0) return true;
  if (nonNegative(raw.lastOpportunityAt) > 0) return true;
  if (nonNegative(raw.skipStatsUpdatedAt) > 0) return true;
  if (nonNegative(raw.smoothedSkipRate) > 0) return true;
  if (Math.abs(Number(raw.skipNorm ?? 1) - 1) > 1e-9) return true;
  return Math.abs(Number(raw.skipFix ?? 1) - 1) > 1e-9;
}

function hasListeningStats(raw) {
  if (!raw || typeof raw !== "object") return false;
  return [
    "playCount",
    "listenedSeconds",
    "lastPlayedAt",
    "lastCountedAt",
    "firstPlayedAt",
    "listenedWallSeconds",
    "listenedMediaSeconds",
    "play_count",
    "listened_wall_seconds",
    "listened_media_seconds",
    "first_played_at",
    "last_played_at",
    "last_counted_at",
  ].some((key) => nonNegative(raw[key]) > 0);
}

function resetTrackStats(raw, path) {
  const track = cloneHistory(raw);
  track.path = String(track.path || path || "");
  [
    "playCount",
    "listenedSeconds",
    "lastPlayedAt",
    "lastCountedAt",
    "firstPlayedAt",
    "listenedWallSeconds",
    "listenedMediaSeconds",
    "play_count",
    "listened_wall_seconds",
    "listened_media_seconds",
    "first_played_at",
    "last_played_at",
    "last_counted_at",
  ].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(track, key)
      || ["playCount", "listenedSeconds", "lastPlayedAt", "lastCountedAt"].includes(key)) {
      track[key] = 0;
    }
  });
  return track;
}

function clearListeningStats(history, now = Date.now()) {
  const source = cloneHistory(history);
  const next = {
    ...source,
    updatedAt: nonNegative(now),
    totalSeconds: 0,
    totalPlays: 0,
    days: {},
    tracks: {},
  };
  [
    "totalListenedWallSeconds",
    "totalListenedMediaSeconds",
    "total_listened_wall_seconds",
    "total_listened_media_seconds",
    "total_plays",
  ].forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(next, key)) next[key] = 0;
  });

  Object.entries(source.tracks || {}).forEach(([path, raw]) => {
    if (!raw || typeof raw !== "object" || !hasRecommendationLearning(raw.recommendationBehavior)) return;
    next.tracks[path] = resetTrackStats(raw, path);
  });

  next.recommendationBehaviorSummary = cloneHistory(
    source.recommendationBehaviorSummary || neutralRecommendationSummary({}, 0),
  );
  return next;
}

function resetRecommendationBehavior(history, now = Date.now()) {
  const source = cloneHistory(history);
  const next = {
    ...source,
    updatedAt: nonNegative(now),
    tracks: {},
    recommendationBehaviorSummary: neutralRecommendationSummary(
      source.recommendationBehaviorSummary,
      now,
    ),
  };

  Object.entries(source.tracks || {}).forEach(([path, raw]) => {
    if (!raw || typeof raw !== "object" || !hasListeningStats(raw)) return;
    next.tracks[path] = {
      ...cloneHistory(raw),
      path: String(raw.path || path || ""),
      recommendationBehavior: neutralRecommendationBehavior(raw.path || path),
    };
  });
  return next;
}

function commitListeningHistoryOperation(history, kind, options = {}) {
  const before = cloneHistory(history);
  const now = nonNegative(options.now || Date.now());
  const transform = kind === "reset-recommendation-behavior"
    ? resetRecommendationBehavior
    : kind === "clear-stats"
      ? clearListeningStats
      : null;
  if (!transform) {
    return { ok: false, history: before, error: `未知听歌历史操作: ${kind}` };
  }
  if (typeof options.writeSnapshot !== "function" || typeof options.writePrimary !== "function") {
    return { ok: false, history: before, error: "缺少听歌历史持久化函数" };
  }

  try {
    const next = transform(before, now);
    const snapshot = options.writeSnapshot(before, kind, now);
    options.writePrimary(next, kind, now);
    return { ok: true, history: next, snapshot };
  } catch (error) {
    return {
      ok: false,
      history: before,
      error: String(error?.message || error || "听歌历史操作失败"),
    };
  }
}

module.exports = {
  clearListeningStats,
  commitListeningHistoryOperation,
  hasListeningStats,
  hasRecommendationLearning,
  neutralRecommendationBehavior,
  neutralRecommendationSummary,
  resetRecommendationBehavior,
};
