// 同源静态 worker；沿用主界面同一套搜索规则与可选语言依赖。
self.window = self;
importScripts("vendor/fuse.min.js", "vendor/wanakana.min.js", "vendor/pinyin-pro.min.js", "search-utils.js");
let requestedGeneration = 0;
let active = { generation: 0, docs: [], fuse: null, sources: new Map() };
const pendingQueries = new Map();
let queryTimer = null;
function runQuery() {
  queryTimer = null;
  const [scope, data] = pendingQueries.entries().next().value || [];
  if (!data) return;
  pendingQueries.delete(scope);
  try {
    const paths = self.KumikoSearch.search(active.docs, active.fuse, data.keyword, { fuzzy: data.fuzzy })
      .map(({ doc }) => doc.path);
    self.postMessage({ type: "result", id: data.id, generation: active.generation, paths });
  } catch (_) {
    self.postMessage({ type: "error", generation: active.generation });
  }
  if (pendingQueries.size) queryTimer = setTimeout(runQuery, 0);
}

self.onmessage = ({ data }) => {
  if (data.type === "build") {
    const generation = data.generation;
    requestedGeneration = generation;
    const tracks = data.tracks || [];
    const docs = [];
    const sources = new Map();
    let cursor = 0;
    let lastProgressAt = 0;
    const build = () => {
      if (generation !== requestedGeneration) return;
      try {
        const started = Date.now();
        while (cursor < tracks.length) {
          const track = tracks[cursor++];
          const key = JSON.stringify([track.title, track.name, track.artist, track.album, track.filename]);
          const previous = active.sources.get(track.path);
          const doc = previous?.key === key ? previous.doc : self.KumikoSearch.buildTrackDoc(track, {
            extractName: (value) => track.filename ?? String(value || "").split(/[\\/]/).pop().replace(/\.[^/.]+$/, ""),
          });
          sources.set(track.path, { key, doc });
          docs.push(doc);
          if (Date.now() - started >= 8) break;
        }
        if (cursor < tracks.length) {
          if (Date.now() - lastProgressAt >= 250) {
            lastProgressAt = Date.now();
            self.postMessage({ type: "progress", generation });
          }
          return setTimeout(build, 0);
        }
        const fuse = self.KumikoSearch.createFuse(docs);
        active = { generation, docs, fuse, sources };
        self.postMessage({ type: "ready", generation });
      } catch (_) {
        self.postMessage({ type: "error", generation });
      }
    };
    setTimeout(build, 0);
  } else if (data.type === "query") {
    const scope = data.scope || "library";
    const previous = pendingQueries.get(scope);
    if (previous) self.postMessage({ type: "cancelled", id: previous.id });
    pendingQueries.set(scope, data);
    if (!queryTimer) queryTimer = setTimeout(runQuery, 0);
  }
};
