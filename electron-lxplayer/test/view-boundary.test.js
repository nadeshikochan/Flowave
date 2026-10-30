const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

test("retained views stop evaluating hidden content and restore current data without losing DOM or parent refs", async () => {
  const context = vm.createContext({ console });
  context.window = context;
  const rootPath = path.join(__dirname, "../renderer");
  for (const file of ["vendor/vue.global.prod.js", "view-boundary.js"]) {
    vm.runInContext(fs.readFileSync(path.join(rootPath, file), "utf8"), context);
  }
  const Vue = context.Vue;
  const host = Vue.createRenderer({
    createElement: (tag) => ({ tag, props: {}, children: [] }),
    createText: (text) => ({ text }), createComment: () => ({}),
    insert: (child, parent) => { if (!parent.children.includes(child)) parent.children.push(child); child.parent = parent; },
    remove() {}, patchProp: (node, key, _previous, value) => { node.props[key] = value; },
    setElementText: (node, text) => { node.text = text; }, setText: (node, text) => { node.text = text; },
    parentNode: (node) => node.parent, nextSibling: () => null,
  });
  let evaluations = 0;
  const app = host.createApp({
    components: { ViewBoundary: context.FlowaveViewBoundary },
    data: () => ({ active: true, value: "initial", tick: 0 }),
    methods: { touch(value) { evaluations += 1; return value; } },
    template: '<div><view-boundary :active="active" class="content"><input ref="field" :value="value"><span>{{touch(value)}}</span></view-boundary><footer>{{tick}}</footer></div>',
  });
  const instance = app.mount({ children: [] });
  try {
    const originalInput = instance.$refs.field;
    originalInput.scrollTop = 200;
    assert.equal(evaluations, 1);
    instance.active = false;
    await Vue.nextTick();
    for (let tick = 1; tick <= 10; tick += 1) {
      instance.tick = tick;
      instance.value = `latest-${tick}`;
      await Vue.nextTick();
    }
    assert.equal(evaluations, 1);
    assert.equal(instance.$refs.field, originalInput);
    assert.equal(originalInput.props.value, "initial");
    instance.active = true;
    await Vue.nextTick();
    assert.equal(evaluations, 2);
    assert.equal(instance.$refs.field, originalInput);
    assert.equal(originalInput.props.value, "latest-10");
    assert.equal(originalInput.scrollTop, 200);
  } finally { app.unmount(); }
});

test("the actual player template compiles with isolated input, retained views and row memoization", () => {
  const context = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../renderer/vendor/vue.global.prod.js"), "utf8"), context);
  const html = fs.readFileSync(path.join(__dirname, "../renderer/index.html"), "utf8");
  const source = html.slice(html.indexOf('  <div id="app"'), html.indexOf('  <script src="lyric-timing.js"'));
  const errors = [];
  assert.equal(/&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(source), false);
  const compiled = context.Vue.compile(source, { decodeEntities: (text) => text, onError: (error) => errors.push(error.message) });
  assert.deepEqual(errors, []);
  assert.equal(typeof compiled, "function");
});
