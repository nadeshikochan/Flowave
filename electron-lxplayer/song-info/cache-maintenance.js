class SongInfoCacheMaintenance {
  constructor({ queryCaches = [], coverAssetStore } = {}) {
    if (!Array.isArray(queryCaches) || queryCaches.some((cache) => typeof cache?.clear !== "function")) {
      throw new TypeError("SongInfoCacheMaintenance requires query caches");
    }
    if (!coverAssetStore || typeof coverAssetStore.clear !== "function") {
      throw new TypeError("SongInfoCacheMaintenance requires a cover asset store");
    }
    this.queryCaches = [...queryCaches];
    this.coverAssetStore = coverAssetStore;
  }

  async clear() {
    let queryEntries = 0;
    for (const cache of this.queryCaches) {
      queryEntries += Math.max(0, Number(cache.clear({ persist: true })) || 0);
    }
    const covers = await this.coverAssetStore.clear();
    return {
      queryEntries,
      coverFiles: Math.max(0, Number(covers?.files) || 0),
      coverBytes: Math.max(0, Number(covers?.bytes) || 0),
    };
  }
}

module.exports = { SongInfoCacheMaintenance };
