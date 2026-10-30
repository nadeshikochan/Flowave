const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { Worker } = require("node:worker_threads");
const SearchController = require("../renderer/search-controller");
const rendererRoot = path.join(__dirname, "../renderer");

function browserContext(extra = {}) {
  const context = vm.createContext({ console, setTimeout, clearTimeout, ...extra });
  context.window = context;
  for (const name of ["vendor/fuse.min.js", "vendor/wanakana.min.js", "vendor/pinyin-pro.min.js", "search-utils.js"]) {
    vm.runInContext(fs.readFileSync(path.join(rendererRoot, name), "utf8"), context, { filename: name });
  }
  return context;
}

test("search thread runs the real matching engine off-thread with identical multilingual ordering", async () => {
  const tracks = [
    { path: "鹿乃 - 春に落ちて.mp3", title: "春に落ちて", artist: "鹿乃", album: "测试" },
    { path: "岡崎律子 - 大切な宝物.mp3", title: "大切な宝物", artist: "岡崎律子" },
    { path: "Chinese.mp3", title: "月亮", artist: "周深" },
    ...Array.from({ length: 3600 }, (_, index) => ({ path: `${index}.mp3`, title: `Moon ${index}`, artist: `Artist ${index % 30}` })),
  ].map((track) => ({ ...track, filename: track.path.replace(/\.[^/.]+$/, "") }));
  const context = browserContext();
  const docs = tracks.map((track) => context.KumikoSearch.buildTrackDoc(track, { extractName: () => track.filename }));
  const fuse = context.KumikoSearch.createFuse(docs);
  const worker = new Worker(`
    const { parentPort, workerData } = require('node:worker_threads');
    const fs = require('node:fs');
    const path = require('node:path');
    const vm = require('node:vm');
    const context = vm.createContext({ setTimeout, clearTimeout });
    context.self = context;
    context.postMessage = (data) => parentPort.postMessage(data);
    context.importScripts = (...names) => names.forEach(name => vm.runInContext(fs.readFileSync(path.join(workerData, name), 'utf8'), context, { filename: name }));
    vm.runInContext(fs.readFileSync(path.join(workerData, 'search-worker.js'), 'utf8'), context);
    parentPort.on('message', data => context.onmessage({ data }));
  `, { eval: true, workerData: rendererRoot });
  const inbox = [];
  const waiters = [];
  worker.on("message", (message) => {
    const waiter = waiters.find((candidate) => candidate.predicate(message));
    if (waiter) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); }
    else inbox.push(message);
  });
  function waitFor(predicate) {
    const index = inbox.findIndex(predicate);
    if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error("worker response timeout")), 10000) };
      waiters.push(waiter);
    });
  }
  let heartbeats = 0;
  const heartbeat = setInterval(() => { heartbeats += 1; }, 2);
  try {
    worker.postMessage({ type: "build", generation: 1, tracks });
    await waitFor((message) => message.type === "ready" && message.generation === 1);
    for (const [id, keyword] of ["鹿乃", "gang qi lv zi", "yueliang", "haru", "Moon 14", "not-present"].entries()) {
      for (const fuzzy of [false, true]) {
        const requestId = id * 2 + Number(fuzzy);
        worker.postMessage({ type: "query", id: requestId, keyword, fuzzy });
        const result = await waitFor((message) => message.type === "result" && message.id === requestId);
        const expected = Array.from(context.KumikoSearch.search(docs, fuse, keyword, { fuzzy }), ({ doc }) => doc.path);
        assert.deepEqual(result.paths, expected, `${keyword}, fuzzy=${fuzzy}`);
      }
    }
    assert.ok(heartbeats > 0, "main event loop must stay available during worker work");
    worker.postMessage({ type: "build", generation: 2, tracks: [{ path: "obsolete.mp3", title: "obsolete" }] });
    worker.postMessage({ type: "build", generation: 3, tracks: [{ path: "new.mp3", title: "New Library" }] });
    await waitFor((message) => message.type === "ready" && message.generation === 3);
    worker.postMessage({ type: "query", id: 99, keyword: "New Library", fuzzy: false });
    assert.deepEqual((await waitFor((message) => message.type === "result" && message.id === 99)).paths, ["new.mp3"]);
  } finally {
    clearInterval(heartbeat);
    for (const waiter of waiters) clearTimeout(waiter.timer);
    await worker.terminate();
  }
});

test("search controller deduplicates, bounds caches, and rejects old generations and cancelled queries", () => {
  const posted = [];
  const worker = { postMessage: (message) => posted.push(message), terminate() {} };
  let updates = 0;
  const controller = new SearchController(worker, { onResults: () => { updates += 1; } });
  try {
    controller.build([]);
    worker.onmessage({ data: { type: "ready", generation: 1 } });
    assert.equal(controller.query("鹿乃", true), null);
    controller.query("鹿乃", true);
    assert.equal(posted.filter((message) => message.type === "query").length, 1);
    const firstId = posted.at(-1).id;
    worker.onmessage({ data: { type: "cancelled", id: firstId } });
    controller.query("鹿乃", true);
    const secondId = posted.at(-1).id;
    assert.notEqual(secondId, firstId);
    worker.onmessage({ data: { type: "result", id: firstId, generation: 1, paths: ["wrong.mp3"] } });
    assert.equal(updates, 0);
    worker.onmessage({ data: { type: "result", id: secondId, generation: 1, paths: ["right.mp3"] } });
    assert.deepEqual(controller.query("鹿乃", true), ["right.mp3"]);
    controller.build([]);
    worker.onmessage({ data: { type: "error", generation: -1 } });
    assert.equal(controller.closed, false);
    worker.onmessage({ data: { type: "ready", generation: 2 } });
    worker.onmessage({ data: { type: "result", id: secondId, generation: 1, paths: ["late.mp3"] } });
    assert.equal(controller.query("鹿乃", true), null);
    for (let index = 0; index < 50; index += 1) controller.query(String(index), true);
    assert.equal(controller.cache.size, 32);
    assert.equal(controller.requests.size, 32);
  } finally { controller.close(); }
});

test("isolated search input keeps keystrokes out of parent renders, handles IME, and cancels reset commits", async () => {
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({ console, setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; }, clearTimeout: (id) => timers.delete(id) });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(rendererRoot, "vendor/vue.global.prod.js"), "utf8"), context);
  vm.runInContext(fs.readFileSync(path.join(rendererRoot, "search-input.js"), "utf8"), context);
  const Vue = context.Vue;
  const host = Vue.createRenderer({
    createElement: (tag) => ({ tag, props: {}, children: [] }),
    createText: (text) => ({ text }), createComment: () => ({}),
    insert: (child, parent) => { parent.children.push(child); }, remove() {},
    patchProp: (node, key, _previous, value) => { node.props[key] = value; },
    setElementText() {}, setText() {}, parentNode: () => null, nextSibling: () => null,
  });
  let renders = 0;
  const commits = [];
  const root = { children: [] };
  const app = host.createApp({
    data: () => ({ keyword: "", resetRevision: 0 }),
    render() {
      renders += 1;
      return Vue.h(context.FlowaveSearchInput, { modelValue: this.keyword, resetRevision: this.resetRevision,
        onCommit: (value) => { commits.push(value); this.keyword = value; }, onActivity() {} });
    },
  });
  const instance = app.mount(root);
  const input = root.children[0];
  const flushTimers = async () => { const pending = [...timers.values()]; timers.clear(); pending.forEach((fn) => fn()); await Vue.nextTick(); };
  try {
    input.props.onCompositionstart();
    input.props.onInput({ target: { value: "lu" }, isComposing: true });
    await Vue.nextTick();
    assert.equal(renders, 1);
    assert.equal(timers.size, 0);
    input.props.onCompositionend({ target: { value: "鹿" } });
    input.props.onInput({ target: { value: "鹿乃" } });
    await Vue.nextTick();
    assert.equal(renders, 1);
    await flushTimers();
    assert.deepEqual(commits, ["鹿乃"]);
    assert.equal(instance.keyword, "鹿乃");
    input.props.onInput({ target: { value: "other" } });
    instance.keyword = "";
    instance.resetRevision += 1;
    await Vue.nextTick();
    await flushTimers();
    assert.deepEqual(commits, ["鹿乃"]);
    assert.equal(input.props.value, "");
  } finally { app.unmount(); }
});
