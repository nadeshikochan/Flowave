(function exposePlaybackTransitionUtils(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.PlaybackTransitionUtils = api;
  }
}(typeof globalThis !== "undefined" ? globalThis : this, () => {
  class StalePlaybackTransitionError extends Error {
    constructor(message = "播放请求已被更新的操作取代") {
      super(message);
      this.name = "StalePlaybackTransitionError";
      this.code = "STALE_PLAYBACK_TRANSITION";
    }
  }

  class PlaybackTransitionCoordinator {
    constructor() {
      this.generation = 0;
      this.active = null;
    }

    begin(details = {}) {
      const generation = this.generation + 1;
      this.generation = generation;
      const transition = Object.freeze({
        generation,
        actionId: String(details.actionId || `play-${generation}`),
        source: String(details.source || "manual"),
        targetPath: String(details.targetPath || ""),
      });
      this.active = transition;
      return transition;
    }

    isCurrent(transition) {
      return !!transition
        && !!this.active
        && transition.generation === this.generation
        && transition === this.active;
    }

    assertCurrent(transition) {
      if (!this.isCurrent(transition)) {
        throw new StalePlaybackTransitionError();
      }
    }

    finish(transition) {
      if (!this.isCurrent(transition)) return false;
      this.active = null;
      return true;
    }

    invalidate() {
      this.generation += 1;
      this.active = null;
      return this.generation;
    }
  }

  function isStalePlaybackTransitionError(error) {
    return error instanceof StalePlaybackTransitionError
      || String(error?.code || "") === "STALE_PLAYBACK_TRANSITION";
  }

  function selectPlaylistNext(queue, currentPath, mode = "loop", options = {}) {
    const list = Array.isArray(queue)
      ? queue.filter((item) => item && String(item.path || ""))
      : [];
    if (!list.length) return null;

    const current = String(currentPath || "");
    const aliases = Array.isArray(options.currentAliases)
      ? options.currentAliases.map((item) => String(item || "")).filter(Boolean)
      : [];
    const currentIds = new Set([current, ...aliases].filter(Boolean));
    const currentIndex = list.findIndex((item) => currentIds.has(String(item.path || "")));

    if (mode === "shuffle") {
      const candidates = list.length > 1
        ? list.filter((item) => !currentIds.has(String(item.path || "")))
        : list;
      const pool = candidates.length ? candidates : list;
      const random = typeof options.random === "function" ? options.random : Math.random;
      const sample = Number(random());
      const safeSample = Number.isFinite(sample) ? Math.max(0, Math.min(0.999999999999, sample)) : 0;
      return pool[Math.floor(safeSample * pool.length)] || pool[0] || null;
    }

    return currentIndex >= 0
      ? list[(currentIndex + 1) % list.length]
      : list[0];
  }

  function buildOnlineQualityQueue(wantedQuality) {
    const wanted = String(wantedQuality || "320k").trim().toLowerCase();
    const ladders = {
      "128k": ["128k"],
      "320k": ["320k", "128k"],
      flac: ["flac", "320k", "128k"],
      flac24bit: ["flac24bit", "flac", "320k", "128k"],
      hires: ["hires", "flac24bit", "flac", "320k", "128k"],
    };
    return [...(ladders[wanted] || ladders["320k"])];
  }

  return {
    buildOnlineQualityQueue,
    PlaybackTransitionCoordinator,
    StalePlaybackTransitionError,
    isStalePlaybackTransitionError,
    selectPlaylistNext,
  };
}));
