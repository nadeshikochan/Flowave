'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {execFileSync} = require('node:child_process');
const {WorkspaceStore, restartArguments} = require('../workspaces');
const layout = require('../data-layout');
const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const bootstrap = fs.readFileSync(path.join(__dirname, '../workspace-bootstrap.js'), 'utf8');

function fixture(t, mode = 'installed') {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowave-workspace-'));
  t.after(() => fs.rmSync(temp, {recursive:true, force:true}));
  const home = path.join(temp, 'program'), local = path.join(temp, 'local');
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(home, 'distribution.json'), JSON.stringify({mode}));
  const store = new WorkspaceStore({appHome:home, localAppData:local, mode, version:'0.1.0'});
  const a = store.create(path.join(temp, '甲 工作区')), b = store.create(path.join(temp, '乙 工作区'));
  store.activate(a.path);
  return {temp, home, local, store, a, b};
}

test('new, legacy, incompatible and unknown directories preserve workspace boundaries', t => {
  const {temp, home, local, store, a, b} = fixture(t);
  fs.mkdirSync(path.join(a.path, 'config'));
  fs.writeFileSync(path.join(a.path, 'config/renderer_state.json'), '{"theme":"dark"}');
  store.activate(b.path);
  assert.equal(layout.resolveDataDir(home, {mode:'installed', localAppData:local}), b.path);
  assert.equal(fs.readFileSync(path.join(a.path, 'config/renderer_state.json'), 'utf8'), '{"theme":"dark"}');
  assert.equal(fs.existsSync(path.join(b.path, 'config/features.json')), false);
  assert.equal(store.recent().length, 2);
  const unknown = path.join(temp, 'music');
  fs.mkdirSync(unknown);
  fs.writeFileSync(path.join(unknown, 'keep.mp3'), 'keep');
  assert.throws(() => store.create(unknown), /空文件夹/);
  assert.throws(() => store.describe(unknown), /无法识别/);
  assert.throws(() => store.create(path.join(a.path, 'cache/other-workspace'), a.path), /互相包含/);
  assert.equal(fs.existsSync(path.join(a.path, 'cache/other-workspace')), false);
  fs.writeFileSync(path.join(b.path, '.flowave-workspace.json'), JSON.stringify({application:'Flowave', schema:1, hostApi:2}));
  assert.throws(() => store.describe(b.path), /更新版本/);
  assert.equal(fs.readFileSync(path.join(unknown, 'keep.mp3'), 'utf8'), 'keep');
  const legacy = path.join(temp, 'legacy');
  fs.mkdirSync(path.join(legacy, 'config'), {recursive:true});
  fs.writeFileSync(path.join(legacy, 'config/features.json'), '{"schema":1,"enabled":{"recommendation":false}}');
  store.activate(legacy);
  assert.equal(store.describe(legacy).path, legacy);
  fs.renameSync(legacy, legacy + '-offline');
  assert.throws(() => layout.resolveDataDir(home, {mode:'installed', localAppData:local}), /不可用/);
  assert.equal(fs.readFileSync(store.pointer, 'utf8'), legacy);
});

test('portable internal workspaces survive a whole directory move and recent-list corruption stays recoverable', t => {
  const {temp, home, store} = fixture(t, 'portable');
  const internal = store.create(path.join(home, 'data'));
  store.activate(internal.path);
  assert.equal(fs.readFileSync(store.pointer, 'utf8'), './data');
  const moved = path.join(temp, 'moved-program');
  fs.renameSync(home, moved);
  const next = new WorkspaceStore({appHome:moved, mode:'portable', version:'0.1.0'});
  assert.equal(layout.resolveDataDir(moved, {mode:'portable'}), path.join(moved, 'data'));
  assert.equal(next.recent()[0].path, path.join(moved, 'data'));
  fs.writeFileSync(next.history, '{broken');
  const result = next.activate(path.join(moved, 'data'));
  assert(result.warning);
  assert.equal(fs.readFileSync(next.history, 'utf8'), '{broken');
});

test('new workspaces cannot import legacy configuration from the application directory', t => {
  const {temp, home, store, b} = fixture(t, 'portable');
  const python = path.resolve(__dirname, '../../build/backend-venv/Scripts/python.exe');
  if (!fs.existsSync(python)) return t.skip('Pinned backend build environment unavailable');
  const defaultSpace = store.create(path.join(home, 'data'));
  const legacy = path.join(temp, 'old-config.json');
  fs.writeFileSync(legacy, '{"oldUser":true}');
  const code = "from pathlib import Path;import sys;import runtime_paths as r;r.LEGACY_CONFIG_PATH=Path(sys.argv[1]);assert not r.legacy_import_allowed();state=r.migrate_legacy_files();assert state['legacy_import'] is False;assert not r.APP_CONFIG_PATH.exists()";
  for (const space of [b, defaultSpace]) execFileSync(python, ['-c', code, legacy],
    {cwd:path.resolve(__dirname, '../..'), windowsHide:true, env:{...process.env, KUMIKO_APP_HOME:home, KUMIKO_DATA_DIR:space.path}});
  assert.equal(fs.readFileSync(legacy, 'utf8'), '{"oldUser":true}');
});

function controller(t) {
  const result = fixture(t);
  const {store, a, b} = result;
  const sender = {executeJavaScript:async () => ({ok:true})};
  const flush = {flush:async () => {}};
  const scope = {console, setTimeout, clearTimeout, setImmediate:fn => fn(), process:{argv:['Flowave.exe']},
    secureProtocols:{isTrustedRendererUrl:url => url === 'kumiko-app://renderer/index.html'},
    mainWindow:{webContents:sender, isDestroyed:() => false, setEnabled:value => { scope.enabled = value; }},
    enabled:true, appIsQuitting:false, workspaceTransition:null, DATA_DIR:a.path, workspaces:store,
    officialModuleOperation:null, resourceManager:{operation:null}, startupBackgroundBusy:false,
    readBackendHealth:async () => ({valid:true, health:{active_tasks:scope.tasks}}), tasks:[],
    traceArchive:flush, rendererStateWriter:flush, listeningHistoryPersistence:flush, metadata:{flushMetadataCache:async () => {}},
    startupBackground:{pending:Promise.resolve()}, featureSelection:flush, officialPackages:flush,
    tagEditor:{drain:async () => {}}, lyricSaveService:{drain:async () => ({drained:true})},
    dialog:{showOpenDialog:async () => ({canceled:false, filePaths:[b.path]}), showMessageBox:async () => ({response:0})},
    app:{quit:() => { scope.quitCount++; }}, quitCount:0};
  const begin = main.indexOf('async function publishCurrentWorkspace()');
  const end = main.indexOf('\nregisterIpc();', begin);
  vm.createContext(scope);
  vm.runInContext(main.slice(begin, end), scope);
  const event = {sender, senderFrame:{url:'kumiko-app://renderer/index.html'}};
  return {...result, scope, event};
}

test('busy jobs, cancellation and failed saves keep the current workspace and release the UI', async t => {
  const {scope, store, a, event} = controller(t);
  scope.tasks = ['推荐索引'];
  let result = await scope.changeWorkspace(event, {action:'open'});
  assert.equal(result.ok, false);
  assert.match(result.error, /推荐索引/);
  scope.tasks = [];
  scope.dialog.showMessageBox = async () => ({response:1});
  result = await scope.changeWorkspace(event, {action:'open'});
  assert.equal(result.canceled, true);
  scope.dialog.showMessageBox = async () => ({response:0});
  scope.mainWindow.webContents.executeJavaScript = async code => code.includes('prepareWorkspaceSwitch') ? {ok:false, error:'save failed'} : undefined;
  result = await scope.changeWorkspace(event, {action:'open'});
  assert.equal(result.ok, false);
  assert.match(result.error, /save failed/);
  assert.equal(scope.enabled, true);
  assert.equal(scope.workspaceTransition, null);
  assert.equal(scope.quitCount, 0);
  assert.equal(fs.readFileSync(store.pointer, 'utf8'), a.path);
});

test('a successful request drains saves and defers folder publication until the new process', async t => {
  const {scope, store, a, b, event} = controller(t);
  const result = await scope.changeWorkspace(event, {action:'recent', id:b.id});
  assert.equal(result.ok, false); // B has not been opened and is absent from recent history.
  const ready = await scope.changeWorkspace(event, {action:'open'});
  assert.equal(ready.restarting, true);
  assert.equal(scope.quitCount, 1);
  assert.equal(scope.workspaceTransition.target.path, b.path);
  assert.equal(fs.readFileSync(store.pointer, 'utf8'), a.path);
  assert.equal((await scope.changeWorkspace(event, {action:'open'})).ok, false);
});

test('bootstrap overrides inherited data roots, sets Electron paths and acquires the lock before core loading', t => {
  const {home, local, store, a, b} = fixture(t);
  const events = [];
  const process = {argv:['Flowave.exe', '--flowave-workspace=' + encodeURIComponent(b.path)],
    env:{KUMIKO_APP_HOME:home, KUMIKO_DATA_DIR:a.path}};
  const app = {isPackaged:true, getVersion:() => '0.1.0', setPath:(key, value) => events.push([key, value]),
    requestSingleInstanceLock:() => { assert.equal(fs.readFileSync(store.pointer, 'utf8'), a.path); events.push(['lock']); return true; }};
  const scope = {process, __dirname:home, require:name => {
    if (name === 'electron') return {app, dialog:{}, protocol:{}};
    if (name === './workspaces') return {WorkspaceStore:class extends WorkspaceStore {constructor(options) {super({...options, localAppData:local});}}, restartArguments};
    if (name === './data-layout') return layout;
    if (name === './secure-protocols') return {registerPrivilegedSchemes:() => events.push(['protocol'])};
    if (name === './main') {events.push(['main']); return {};}
    return require(name);
  }};
  vm.runInNewContext(bootstrap, scope);
  assert.equal(process.env.KUMIKO_DATA_DIR, b.path);
  assert.equal(fs.readFileSync(store.pointer, 'utf8'), a.path);
  assert(events.find(row => row[0] === 'userData')[1].startsWith(b.path));
  assert(events.findIndex(row => row[0] === 'lock') < events.findIndex(row => row[0] === 'main'));
  assert.equal(events[0][0], 'protocol');
});

test('only a completed renderer publishes the active folder', async t => {
  const {scope, store, a, b} = controller(t);
  scope.DATA_DIR = b.path;
  scope.process.env = {FLOWAVE_WORKSPACE_PERSIST:'1'};
  scope.mainWindow.webContents.executeJavaScript = async () => false;
  assert.equal((await scope.publishCurrentWorkspace()).ok, false);
  assert.equal(fs.readFileSync(store.pointer, 'utf8'), a.path);
  scope.mainWindow.webContents.executeJavaScript = async () => true;
  assert.equal((await scope.publishCurrentWorkspace()).ok, true);
  assert.equal(fs.readFileSync(store.pointer, 'utf8'), b.path);
});

test('a fresh explicit launch initializes metadata only after the workspace lock', t => {
  const {home, local, store, a, temp} = fixture(t);
  const target = path.join(temp, 'fresh-launch');
  let loaded = false;
  const process = {argv:['Flowave.exe'], env:{KUMIKO_APP_HOME:home, KUMIKO_DATA_DIR:target}};
  const app = {isPackaged:true, getVersion:() => '0.1.0', setPath() {},
    requestSingleInstanceLock:() => {assert.equal(fs.existsSync(path.join(target, '.flowave-workspace.json')), false); return true;}};
  vm.runInNewContext(bootstrap, {process, __dirname:home, require:name => {
    if (name === 'electron') return {app, dialog:{}, protocol:{}};
    if (name === './workspaces') return {WorkspaceStore:class extends WorkspaceStore {constructor(options) {super({...options, localAppData:local});}}, restartArguments};
    if (name === './data-layout') return layout;
    if (name === './secure-protocols') return {registerPrivilegedSchemes() {}};
    if (name === './main') {loaded = true; return {};}
    return require(name);
  }});
  assert.equal(loaded, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target, '.flowave-workspace.json'), 'utf8')).legacyImport, false);
  assert.equal(fs.readFileSync(store.pointer, 'utf8'), a.path);
});

test('a missing startup workspace leaves its location intact and offers recovery before core loading', async t => {
  const {home, local, store, a, b} = fixture(t);
  const events = [];
  let exited;
  const done = new Promise(resolve => { exited = resolve; });
  const app = {isPackaged:true, getVersion:() => '0.1.0', whenReady:async () => {}, exit:code => {events.push(['exit', code]); exited();},
    relaunch:options => events.push(['relaunch', options.args])};
  const process = {argv:['Flowave.exe', '--flowave-workspace=' + encodeURIComponent(path.join(home, 'missing'))], env:{KUMIKO_APP_HOME:home}};
  const scope = {process, __dirname:home, require:name => {
    if (name === 'electron') return {app, protocol:{}, dialog:{showMessageBox:async () => ({response:0}), showOpenDialog:async () => ({canceled:false, filePaths:[b.path]})}};
    if (name === './workspaces') return {WorkspaceStore:class extends WorkspaceStore {constructor(options) {super({...options, localAppData:local});}}, restartArguments};
    if (name === './data-layout') return layout;
    if (name === './secure-protocols') return {registerPrivilegedSchemes() {}};
    if (name === './main') throw Error('Core must stay unloaded');
    return require(name);
  }};
  vm.runInNewContext(bootstrap, scope);
  await done;
  assert.equal(fs.readFileSync(store.pointer, 'utf8'), a.path);
  const args = events.find(row => row[0] === 'relaunch')[1];
  assert.equal(args.filter(value => value.startsWith('--flowave-workspace=')).length, 1);
  assert.equal(decodeURIComponent(args.at(-1).split('=').slice(1).join('=')), b.path);
});

test('a late shutdown save failure schedules reopening the old workspace', async t => {
  const {scope, a, b} = controller(t);
  let beforeQuit;
  scope.app.on = (_event, handler) => { beforeQuit = handler; };
  scope.app.relaunch = value => { scope.relaunchArgs = value.args; };
  scope.quitCleanupFinished = false;
  scope.quitCleanupPromise = null;
  scope.workspaceTransition = {target:b, restart:true};
  scope.tagEditor.close = () => {};
  scope.batchSongInfoTasks = {close() {}};
  scope.songInfoService = {cancelAll() {}};
  scope.lyricLookupService = {cancelAll() {}};
  scope.coverAssetControllers = new Map();
  scope.lyricOverlayWindow = null;
  scope.resourceManager.close = async () => {};
  scope.lyricSaveService.close = () => {};
  scope.traceArchive = {flush:async () => {throw Error('disk full');}};
  scope.dialog.showErrorBox = () => {};
  scope.restartArguments = restartArguments;
  const begin = main.indexOf('app.on("before-quit"');
  const end = main.indexOf('\nfunction registerAllShortcuts', begin);
  vm.runInContext(main.slice(begin, end), scope);
  beforeQuit({preventDefault() {}});
  await scope.quitCleanupPromise;
  assert.equal(scope.quitCleanupFinished, true);
  assert.equal(scope.quitCount, 1);
  assert.equal(decodeURIComponent(scope.relaunchArgs.at(-1).split('=').slice(1).join('=')), a.path);
});

test('Vue-backed save preparation respects pending configuration and leaves history writable after failure', async () => {
  const scope = {window:{__flowaveMounted:true}, console, setTimeout, clearTimeout};
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/vendor/vue.global.prod.js'), 'utf8'), scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/feature-modules.js'), 'utf8'), scope);
  const order = [];
  const app = scope.Vue.reactive({listeningHistoryClosing:false, _configSavePromise:Promise.resolve().then(() => order.push('pending')),
    flushConfigAutoSave:async () => {order.push('config'); return {ok:true};}, pauseByManual:() => order.push('pause'),
    prepareListeningHistoryQuit:async () => {order.push('history'); return {ok:false, error:'disk full'};}});
  const method = scope.window.FlowaveFeatureModules.methods.prepareWorkspaceSwitch;
  const result = await method.call(app);
  assert.equal(result.ok, false);
  assert.equal(app.listeningHistoryClosing, false);
  assert.deepEqual(order, ['pending', 'config', 'pause', 'history']);
});

test('canceled save preparation cannot pause or close history after its configuration request finishes', async () => {
  const scope = {window:{__flowaveMounted:true}, console, setTimeout, clearTimeout};
  vm.createContext(scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/vendor/vue.global.prod.js'), 'utf8'), scope);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../renderer/feature-modules.js'), 'utf8'), scope);
  let complete;
  const config = new Promise(resolve => {complete = resolve;});
  const order = [];
  const app = scope.Vue.reactive({listeningHistoryClosing:false,
    flushConfigAutoSave:() => config, pauseByManual:() => order.push('pause'),
    prepareListeningHistoryQuit:async () => {order.push('history'); return {ok:true};}});
  const methods = scope.window.FlowaveFeatureModules.methods;
  const pending = methods.prepareWorkspaceSwitch.call(app);
  assert.equal((await methods.prepareWorkspaceSwitch.call(app)).ok, false);
  methods.cancelWorkspaceSwitch.call(app);
  complete({ok:true});
  assert.equal((await pending).canceled, true);
  assert.equal(app.listeningHistoryClosing, false);
  assert.deepEqual(order, []);
  assert.equal((await methods.prepareWorkspaceSwitch.call(app)).ok, true);
  assert.deepEqual(order, ['pause', 'history']);
});
