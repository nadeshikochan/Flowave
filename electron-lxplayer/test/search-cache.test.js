const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

test("reused title collator preserves the previous Chinese locale tie ordering", () => {
  const context = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/search-utils.js"), "utf8"), context);
  const titles = ["鹿乃", "阿", "啊", "月亮", "月光", "a", "A", "2", "10", "春に落ちて", "はる", "ハル", "岡崎律子", "冈崎律子", "🎵"];
  const docs = titles.map((title, index) => ({ title, path: `${index}.mp3`, titleSearch: "shared", allSearch: "shared" }));
  const actual = Array.from(context.window.KumikoSearch.search(docs, null, "shared", { fuzzy: false }), ({ doc }) => doc.title);
  assert.deepEqual(actual, [...titles].sort((a, b) => a.localeCompare(b, "zh-Hans-CN")));
});

test("cached search tokens preserve direct and fuzzy scores and invalidate edited fields", () => {
  const source = fs.readFileSync(path.join(__dirname, "../renderer/search-utils.js"), "utf8");
  function load(code) {
    const sandbox = { window: {} };
    vm.runInNewContext(code, sandbox);
    return sandbox.window.KumikoSearch;
  }
  const cached = load(source);
  const baseline = load(source.replace("tokens.has(q)", "text.split(/\\s+/).includes(q)"));
  const docs = Array.from({ length: 3608 }, (_, i) => cached.buildTrackDoc({
    path: `${i}.mp3`, title: `Moon ${i}`, artist: `Artist ${i % 30}`, album: `Album ${i % 50}`,
  }));
  const fuse = { search: () => [{ item: docs[14], score: 0.2 }, { item: docs[12], score: 0.3 }] };
  const pack = (results) => JSON.stringify(results.map(({ doc, score }) => [doc.path, score]));
  for (const fuzzy of [false, true]) {
    for (const query of ["Moon", "artist 3", "14", "missing", "Moon"]) {
      assert.equal(pack(cached.search(docs, fuse, query, { fuzzy })), pack(baseline.search(docs, fuse, query, { fuzzy })));
    }
  }
  docs[0].titleSearch = "changed title";
  assert.equal(pack(cached.search(docs, null, "changed", { fuzzy: false })), pack(baseline.search(docs, null, "changed", { fuzzy: false })));
});
