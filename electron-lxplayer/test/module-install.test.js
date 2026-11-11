'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {EventEmitter} = require('node:events');
const {PassThrough} = require('node:stream');
const {ResourceManager, revision} = require('../resource-manager');
const {createOfficialPackageStore} = require('../official-package-store');
const {createFeatureSelection} = require('../feature-selection');
const dir = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(dir, 'main.js'), 'utf8');

test('device release during window destruction never calls a destroyed WebContents', () => {
  const monitor=new EventEmitter(),sent=[];
  const closing={isDestroyed:()=>false,webContents:{isDestroyed:()=>true,getURL(){throw Error('Object has been destroyed');}}};
  const live={isDestroyed:()=>false,webContents:{isDestroyed:()=>false,getURL:()=> 'kumiko-app://renderer/index.html',send:(...args)=>sent.push(args)}};
  const start=source.indexOf("audioOutputMonitor.on('change'");
  const end=source.indexOf('const { SongInfoProviderRegistry }',start);
  vm.runInNewContext(source.slice(start,end),{audioOutputMonitor:monitor,BrowserWindow:{getAllWindows:()=>[closing,live]},secureProtocols:require('../secure-protocols')});
  monitor.emit('change',{reason:'not-needed'});
  assert.equal(sent.length,1);assert.equal(sent[0][0],'lx-audio-output-changed');
});

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowave-install-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const catalog = structuredClone(require('../official-modules/catalog.json'));
  for (const item of Object.values(catalog.packages)) for (const release of item.releases) delete release.url;
  const store = createOfficialPackageStore({directory: path.join(root, 'packages'), catalog,
    bundleSource: (id, version) => fs.readFileSync(path.join(dir, 'official-modules/packages', catalog.packages[id].releases.find(row => row.version === version).bundle))});
  store.bootstrapLegacy();
  const selection = createFeatureSelection(path.join(root, 'features.json'), {initialEnabled: false, available: id => store.hasActive(id)});
  await selection.initialize();
  const events = [], handlers = new Map();
  const sender = {isDestroyed: () => false, send: (channel, payload) => events.push({channel, ...payload})};
  const resources = {prepare: async () => {}, cancel: async () => {}};
  const scope = {require: createRequire(path.join(dir, 'main.js')), __dirname: dir, fs, path, Buffer, AbortController,
    officialCatalog: catalog, officialPackages: store, featureSelection: selection, resourceManager: resources,
    officialModuleOperation: null, workspaceTransition: null, appIsQuitting: false, mainWindow: {webContents: sender},
    secureProtocols: require('../secure-protocols'), ipcMain: {handle: (name, fn) => handlers.set(name, fn)},
    featureSnapshot: () => ({...selection.snapshot(), packages: store.snapshot()}),
    dialog: {showOpenDialog: async () => { throw Error('Unexpected dialog'); }}};
  const start = source.indexOf('  const manageOfficialModule=');
  const end = source.indexOf("  ipcMain.handle('lx-resource-status'", start);
  assert(start >= 0 && end > start);
  vm.runInNewContext(source.slice(start, end), scope);
  const handler = handlers.get('lx-module-manage');
  const event = {sender, senderFrame: {url: 'kumiko-app://renderer/index.html'}};
  const run = (id, action = 'install') => handler(event, {id, action, revision: store.snapshot().revision});
  return {root, store, selection, resources, events, scope, run};
}

test('one install waits for resources before publishing real packages and enabling', async t => {
  const f = await fixture(t);
  for (const id of ['recommendation', 'analysis', 'practice', 'history']) {
    let resume, entered;
    const ready = new Promise(resolve => { entered = resolve; });
    f.resources.prepare = async (key, _sender, {signal}) => {
      assert.equal(key, id); assert.equal(signal.aborted, false); entered();
      await new Promise(resolve => { resume = resolve; });
    };
    const work = f.run(id);
    await ready;
    assert.equal(f.store.snapshot()[id].installed, null);
    assert.equal(f.selection.snapshot().selected.enabled[id], false);
    resume();
    const result = await work;
    assert.equal(result.ok, true, result.error);
    assert(f.store.snapshot()[id].installed);
    assert.equal(f.selection.snapshot().selected.enabled[id], true);
    assert.equal(f.selection.active.enabled[id], false, 'must keep the current running selection');
    assert.equal(f.scope.officialModuleOperation, null);
  }
});

test('resource failure and cancellation preserve package registry, choices and user data', async t => {
  const f = await fixture(t);
  const file = path.join(f.root, 'history-and-index');
  fs.writeFileSync(file, 'protected');
  const before = JSON.stringify(f.store.snapshot());
  f.resources.prepare = async () => { throw Error('Resource hash mismatch'); };
  const failed = await f.run('analysis');
  assert.equal(failed.ok, false); assert.match(failed.error, /hash mismatch/);
  assert.equal(JSON.stringify(f.store.snapshot()), before);
  assert.equal(f.selection.snapshot().selected.enabled.analysis, false);
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.resources.prepare = async (_id, _sender, {signal}) => {
    entered(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('cancelled')), {once: true}));
  };
  const work = f.run('practice'); await ready;
  assert.equal((await f.run('practice', 'cancel')).ok, true);
  const cancelled = await work;
  assert.equal(cancelled.ok, false); assert.match(cancelled.error, /取消/);
  assert.equal(JSON.stringify(f.store.snapshot()), before);
  assert.equal(f.selection.snapshot().selected.enabled.practice, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'protected');
});

test('failed enable reports actual partial installation; retry reuses installed code', async t => {
  const f = await fixture(t), select = f.selection.select;
  f.selection.select = async () => { throw Error('Cannot save choice'); };
  const result = await f.run('history');
  assert.equal(result.ok, false); assert.match(result.error, /Cannot save/);
  assert(result.selection.packages.history.installed);
  assert.equal(result.selection.selected.enabled.history, false);
  f.selection.select = select;
  assert.equal((await f.run('history')).ok, true);
  assert.equal(f.selection.snapshot().selected.enabled.history, true);
});

test('resources cannot report success before child exit and verified readiness', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flowave-resources-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const group = {name: 'model', files: [{bytes: 1}]};
  fs.mkdirSync(path.join(root, 'resources')); fs.mkdirSync(path.join(root, 'backend'));
  fs.writeFileSync(path.join(root, 'backend/api.exe'), 'fixture');
  fs.writeFileSync(path.join(root, 'resources/catalog.json'), JSON.stringify({profiles: {}, groups: {model: group}, modules: {analysis: {groups: ['model']}}}));
  let child, killed = 0;
  const spawnProcess = exe => {
    if (exe === 'taskkill.exe') {
      const killer = new EventEmitter(); killed++;
      setImmediate(() => { child.exitCode = 1; child.emit('close', 1); killer.emit('close', 0); });
      return killer;
    }
    child = new EventEmitter(); Object.assign(child, {pid: 123, exitCode: null, stdout: new PassThrough(), stderr: new PassThrough()});
    return child;
  };
  const sender = {isDestroyed: () => false, send() {}}, manager = new ResourceManager(root, {spawnProcess});
  const failed = manager.prepare('analysis', sender);
  child.stdout.write('{"phase":"complete"}\n');
  child.exitCode = 0; child.emit('close', 0);
  await assert.rejects(failed, /未完成/);
  const control = new AbortController();
  const cancelled = manager.prepare('analysis', sender, {signal: control.signal});
  const rejected = assert.rejects(cancelled, /取消/); control.abort(); await rejected;
  assert.equal(killed, 1); assert.equal(manager.operation, null);
  const success = manager.prepare('analysis', sender);
  const folder = path.join(root, 'data/components/resources/assets/model', revision(group).slice(0,16));
  fs.mkdirSync(folder, {recursive: true}); fs.writeFileSync(path.join(folder, '.ready.json'), JSON.stringify({revision: revision(group)}));
  let settled = false; success.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  child.exitCode = 0; child.emit('close', 0);
  assert.equal((await success).ok, true); assert.equal(manager.snapshot().analysis.ready, true);
  fs.writeFileSync(path.join(folder, '.ready.json'), JSON.stringify({revision:revision(group).slice(0,16)}));
  assert.equal(manager.snapshot().analysis.ready,false,'short directory names never replace full revision validation');
});
