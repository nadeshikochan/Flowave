const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { createHash } = require("node:crypto");

test("Bitap mask reuse and per-query memo preserve upstream scores, boundaries and highlights", () => {
  const optimized = fs.readFileSync(path.join(__dirname, "../renderer/vendor/fuse.min.js"), "utf8");
  const upstream = optimized
    .replace(/\n\/\/ Flowave local performance change[^]*?\nw=-1;for/, "w=-1;for")
    .replace("q=flowaveMasks[K]", "q=n[e.charAt(K)]")
    .replace(/\n\/\/ A Bitap searcher[^]*?\nreturn ve.version/, "return ve.version")
    .replace(/\r\n/g, "\n").trimEnd();
  assert.equal(createHash("sha256").update(upstream).digest("hex"),
    "e3621b53cb77b4ec306dec41ed95511e6dd80d17fae5a04f3e346d214b9f8f92",
    "The reference must remain the reviewed, unmodified Fuse 7.0.0 distribution");
  function load(source) {
    const context = {};
    vm.runInNewContext(source, context);
    return context.Fuse;
  }
  const Original = load(upstream), Optimized = load(optimized);
  const samples = ["", "a", "aa", "AAA", "鹿乃", "大切な宝物", "moon moon", "🎵音楽🎵",
    "a".repeat(31), "a".repeat(32), "a".repeat(33), "x".repeat(64), "long " + "word ".repeat(18)];
  const docs = samples.flatMap((title, index) => [
    { title, artist: samples[index % 4] },
    { title: `prefix ${title} suffix`, artist: samples[index % 4] },
    { title: title.slice(1) + "!", artist: samples[index % 4] },
  ]);
  const options = [
    { ignoreLocation: true, threshold: .38 },
    { ignoreLocation: false, location: 3, distance: 20, threshold: .6 },
    { ignoreLocation: false, distance: 0, threshold: .38 },
    { ignoreLocation: true, minMatchCharLength: 2, includeMatches: true },
    { findAllMatches: true, includeMatches: true, threshold: 1 },
    { isCaseSensitive: true, threshold: 0, includeMatches: true },
  ];
  for (const config of options) {
    const settings = { ...config, includeScore: true, keys: [{ name: "title", weight: .7 }, { name: "artist", weight: .3 }] };
    const previous = new Original(docs, settings), current = new Optimized(docs, settings);
    for (const query of [...samples, "aa", "missing", "a", "鹿乃"]) {
      assert.equal(JSON.stringify(current.search(query)), JSON.stringify(previous.search(query)), JSON.stringify({ query, config }));
    }
  }
});

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
