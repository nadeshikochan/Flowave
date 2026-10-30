(function (root) {
  class SearchController {
    constructor(worker, { onReady = () => {}, onResults = () => {}, onError = () => {} } = {}) {
      this.worker = worker;
      this.onReady = onReady;
      this.onResults = onResults;
      this.onError = onError;
      this.generation = 0;
      this.activeGeneration = 0;
      this.sequence = 0;
      this.cache = new Map();
      this.requests = new Map();
      this.closed = false;
      worker.onmessage = ({ data }) => this.receive(data);
      worker.onerror = () => this.fail();
      worker.onmessageerror = () => this.fail();
    }
    build(tracks) {
      const generation = ++this.generation;
      clearTimeout(this.buildTimer);
      this.buildTimer = setTimeout(() => this.fail(), 15000);
      try { this.worker.postMessage({ type: "build", generation, tracks }); }
      catch (_) { this.fail(); }
      return generation;
    }
    receive(data) {
      if (this.closed) return;
      if (data.type === "error") {
        if (data.generation === this.generation || data.generation === this.activeGeneration) this.fail();
        return;
      }
      if (data.type === "progress" && data.generation === this.generation) {
        clearTimeout(this.buildTimer);
        this.buildTimer = setTimeout(() => this.fail(), 15000);
        return;
      }
      if (data.type === "cancelled") {
        const request = this.requests.get(data.id);
        this.requests.delete(data.id);
        if (request && this.cache.get(request.key) === request) this.cache.delete(request.key);
        return;
      }
      if (data.type === "ready" && data.generation === this.generation) {
        clearTimeout(this.buildTimer);
        this.activeGeneration = data.generation;
        this.cache.clear();
        this.requests.clear();
        this.onReady();
      } else if (data.type === "result" && data.generation === this.activeGeneration) {
        const request = this.requests.get(data.id);
        if (!request) return;
        this.requests.delete(data.id);
        if (this.cache.get(request.key) !== request) return;
        request.paths = Array.isArray(data.paths) ? data.paths : [];
        this.onResults();
      }
    }
    query(keyword, fuzzy, scope = "library") {
      if (!this.activeGeneration || this.closed) return null;
      const key = JSON.stringify([keyword, fuzzy !== false]);
      let entry = this.cache.get(key);
      if (!entry) {
        if (this.cache.size >= 32) {
          const oldest = this.cache.keys().next().value;
          const discarded = this.cache.get(oldest);
          this.requests.delete(discarded.id);
          this.cache.delete(oldest);
        }
        entry = { id: ++this.sequence, key, paths: null };
        this.cache.set(key, entry);
        this.requests.set(entry.id, entry);
        try { this.worker.postMessage({ type: "query", id: entry.id, keyword, fuzzy, scope }); }
        catch (_) { this.fail(); }
      }
      return entry.paths;
    }
    fail() {
      if (this.closed) return;
      this.close();
      this.onError();
    }
    close() {
      this.closed = true;
      clearTimeout(this.buildTimer);
      this.cache.clear();
      this.requests.clear();
      this.worker.terminate();
    }
  }
  root.FlowaveSearchController = SearchController;
  if (typeof module !== "undefined") module.exports = SearchController;
})(typeof window === "undefined" ? globalThis : window);
