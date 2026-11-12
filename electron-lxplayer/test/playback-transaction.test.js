const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const nodeVm = require("node:vm");
const { EventEmitter } = require('node:events');
const { AudioOutputSafety } = require('../audio-output-safety');

const PlaybackTransitionUtils = require("../renderer/playback-transition");
const ListeningHistoryOps = require("../listening-history-ops");
const LyricModelAdapter = require("../renderer/lyric-model-adapter");

test("headphone safety latches through real Vue and invalidates pending playback", async () => {
  const vueContext = { console };
  nodeVm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "renderer", "vendor", "vue.global.prod.js"), "utf8"), vueContext);
  let confirmOutput;
  const { capturedConfig, fakeAudio } = createRendererHarness({ rendererState:{'lx-bluetooth-protection':'1'}, lxEnv: { prepareAudioOutput: value => value.playing
    ? new Promise(resolve => { confirmOutput = resolve; }) : Promise.resolve({ok:true}) } });
  const renderer = vueContext.Vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null });
  const notices = [];
  const instance = renderer.createApp({ data: capturedConfig.data, render: () => null,
    methods: { ...capturedConfig.methods, showNotice: text => notices.push(text), appendMediaDiagEvent() {}, cancelRecommendPrefetch() {},
      cancelNaturalCrossfade() {}, syncMediaSessionPlaybackState() {} } });
  const app = instance.mount({});
  try {
    app.currentPath = 'C:/Fixture/song.mp3'; app.isPlaying = true;
    app.beginPlaybackTransition('C:/Fixture/next.mp3', 'next', {});
    const before = app.playbackGeneration;
    app.handleAudioOutputSafety({ reason: 'headphones-removed' });
    assert.match(notices.at(-1), /双耳均已摘下/);
    assert.equal(app.outputSafetyBlocked, true);
    assert.equal(app.isPlaying, false);
    assert.equal(fakeAudio.paused, true);
    assert.equal(app.playbackIntent, 'pause');
    assert.equal(app.pendingPlaybackTransition, null);
    assert(app.playbackGeneration > before);
    await assert.rejects(app.prepareSafeAudioOutput(), /耳机输出/);
    app.pauseByInterruptionDetected();
    assert.equal(app.audioInterrupt.armed, false);
    assert.equal(app.audioInterrupt.timer, null);
    app.outputSafetyBlocked = false;
    const pending = app.prepareSafeAudioOutput();
    app.pauseByManual('headphone-pause');
    confirmOutput({ok:true});
    await assert.rejects(pending, /确认耳机/);
    assert.equal(app.playbackIntent, 'pause');
  } finally { instance.unmount(); }
});

test('bluetooth protection defaults off, persists only confirmed changes and ignores disabled events in real Vue', async () => {
  const vueContext = {console};
  nodeVm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'renderer/vendor/vue.global.prod.js'), 'utf8'), vueContext);
  let saves = 0, success = false, preparations = 0;
  const {capturedConfig} = createRendererHarness({lxEnv:{
    setBluetoothProtection:async () => {saves++; return {ok:success, error:'disk full'};},
    prepareAudioOutput:async () => {preparations++; return {ok:true};},
  }});
  const renderer = vueContext.Vue.createRenderer({createComment:() => ({}), insert() {}, remove() {}, parentNode:() => null, nextSibling:() => null});
  const instance = renderer.createApp({data:capturedConfig.data, render:() => null, methods:capturedConfig.methods});
  const app = instance.mount({});
  try {
    assert.equal(app.bluetoothProtectionEnabled, false);
    await app.prepareSafeAudioOutput();
    app.handleAudioOutputSafety({reason:'headphones-disconnected'});
    assert.equal(preparations, 0);
    assert.equal(app.outputSafetyBlocked, false);
    const event = {target:{checked:true}};
    await app.updateBluetoothProtection(event);
    assert.equal(app.bluetoothProtectionEnabled, false);
    assert.equal(event.target.checked, false);
    assert.match(app.bluetoothProtectionMessage, /disk full/);
    success = true;
    event.target.checked = true;
    await app.updateBluetoothProtection(event);
    assert.equal(app.bluetoothProtectionEnabled, true);
    app.outputSafetyBlocked = true;
    app.outputSafetyWearResume = {token:1};
    event.target.checked = false;
    await app.updateBluetoothProtection(event);
    assert.equal(app.outputSafetyBlocked, false);
    assert.equal(app.outputSafetyWearResume, null);
    assert.equal(saves, 3);
    assert.equal(capturedConfig.data().bluetoothProtectionEnabled, false);
  } finally {instance.unmount();}
});

test("media session mapping uses the common bridge for recover and change", async () => {
  const sent = [], bindings = new Map();
  const { app } = createRendererHarness({
    lxEnv: { sendMediaInput: async action => { sent.push(action); } },
    navigator: { mediaSession: { setActionHandler: (action, handler) => bindings.set(action, handler) } },
  });
  app.setupMediaSessionIntegration();
  bindings.get('nexttrack')(); bindings.get('previoustrack')(); bindings.get('pause')();
  await Promise.resolve();
  assert.deepEqual(sent, ['next_like', 'dislike_next', 'pause']);
});

async function createWearPlaybackFixture() {
  const vueContext = { console };
  nodeVm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'renderer', 'vendor', 'vue.global.prod.js'), 'utf8'), vueContext);
  const monitor = new EventEmitter(), effects = [];
  monitor.leases = new Set();
  monitor.acquire = id => monitor.leases.add(id);
  monitor.release = id => monitor.leases.delete(id);
  monitor.get = async () => (monitor.state = {id:'headphones',transport:'bluetooth',route:'session',confirmed:true,sampledAt:Date.now()});
  let app;
  const owner = {isDestroyed:()=>false, setAudioMuted:value=>effects.push(value),
    send:(_channel,event)=>{ void Promise.resolve().then(()=>app.handleAudioOutputSafety(event)); }};
  const safety = new AudioOutputSafety(monitor);
  const { capturedConfig, fakeAudio } = createRendererHarness({rendererState:{'lx-bluetooth-protection':'1'},markRaw:vueContext.Vue.markRaw,lxEnv:{prepareAudioOutput:async value=>{
    if (value.playing) return safety.prepare(owner,value);
    safety.pause(owner,value); return {ok:true};
  }}});
  const renderer = vueContext.Vue.createRenderer({createComment:()=>({}),insert(){},remove(){},parentNode:()=>null,nextSibling:()=>null});
  const instance = renderer.createApp({data:capturedConfig.data,render:()=>null,
    watch:{isPlaying:capturedConfig.watch.isPlaying},
    methods:{...capturedConfig.methods,showNotice(){},appendMediaDiagEvent(){},cancelRecommendPrefetch(){},cancelNaturalCrossfade(){},
      syncOutputCalibrationConsumers(){},syncLyricAmbient(){},sendLyricOverlay(){}}});
  app = instance.mount({});
  app.currentPath = 'C:/Music/A.mp3'; app.isPlaying = true; app.playbackIntent = 'play';
  await safety.prepare(owner);
  const settle = () => new Promise(resolve=>setImmediate(resolve));
  await settle();
  return {app,fakeAudio,monitor,safety,effects,settle,
    async wear(worn) {monitor.wearState={id:'headphones',status:'reported',worn};monitor.emit('wear-state',monitor.wearState);await settle();},
    dispose(){safety.dispose();instance.unmount();}};
}

test('real Vue wear pause retains its watcher and rewear resumes the same song and position', async () => {
  const fixture = await createWearPlaybackFixture();
  const { app, fakeAudio, monitor, safety } = fixture;
  try {
    await fixture.wear(false);
    assert.equal(app.playbackIntent,'pause'); assert.equal(fakeAudio.paused,true);
    assert(app.outputSafetyWearResume); assert.equal(monitor.leases.size,1);
    app.syncMediaSessionPlaybackState(); // Paused-state publication must retain the wear lease.
    await fixture.wear(true);
    assert.equal(app.isPlaying,true); assert.equal(fakeAudio.paused,false);
    assert.equal(app.currentPath,'C:/Music/A.mp3'); assert.equal(fakeAudio.currentTime,12);
    assert.equal(app.outputSafetyWearResume,null); assert.equal(safety.blocked,false);
    // Main-process wear reports may both arrive before the renderer publishes its pause.
    for (const worn of [false,true]) {
      monitor.wearState={id:'headphones',status:'reported',worn};
      monitor.emit('wear-state',monitor.wearState);
    }
    await fixture.settle();
    assert.equal(app.isPlaying,true); assert.equal(safety.blocked,false);
  } finally {fixture.dispose();}
});

test('manual pause, track replacement and disconnection revoke real Vue wear recovery', async () => {
  for (const interrupt of ['already-paused','manual','track','disconnect']) {
    const fixture = await createWearPlaybackFixture();
    const { app, fakeAudio, monitor } = fixture;
    try {
      if (interrupt === 'already-paused') app.pauseByManual('user');
      await fixture.wear(false);
      const old = app.outputSafetyWearResume?.token;
      if (interrupt === 'manual') app.pauseByManual('user');
      if (interrupt === 'track') app.beginPlaybackTransition('C:/Music/B.mp3','manual',{});
      if (interrupt === 'disconnect') {monitor.emit('device-event',{kind:'removed',id:'headphones'});await fixture.settle();}
      await fixture.wear(true);
      await app.handleAudioOutputSafety({reason:'headphones-worn',wearToken:old});
      assert.equal(app.isPlaying,false,interrupt); assert.equal(fakeAudio.paused,true,interrupt);
      assert.equal(app.outputSafetyWearResume,null,interrupt);
    } finally {fixture.dispose();}
  }
});

test('manual pause wins while wear recovery is waiting for the effects engine', async () => {
  const fixture = await createWearPlaybackFixture();
  const { app, fakeAudio } = fixture;
  try {
    await fixture.wear(false);
    let release;
    app.resumeEffectsEngine = () => new Promise(resolve=>{release=resolve;});
    await fixture.wear(true);
    assert.equal(typeof release,'function');
    app.pauseByManual('user'); release(); await fixture.settle();
    assert.equal(fakeAudio.paused,true); assert.equal(app.isPlaying,false);
    assert.equal(app.playbackIntent,'pause'); assert.equal(app.outputSafetyWearResume,null);
  } finally {fixture.dispose();}
});

test('removing both again during wear recovery invalidates the old resume and rearms the new pause', async () => {
  const fixture = await createWearPlaybackFixture();
  const { app, fakeAudio } = fixture;
  try {
    await fixture.wear(false);
    const firstToken = app.outputSafetyWearResume.token;
    const resumeEffects = app.resumeEffectsEngine;
    let release;
    app.resumeEffectsEngine = () => new Promise(resolve=>{release=resolve;});
    await fixture.wear(true);
    await fixture.wear(false);
    assert.notEqual(app.outputSafetyWearResume.token,firstToken);
    app.resumeEffectsEngine = resumeEffects;
    release(); await fixture.settle();
    assert.equal(fakeAudio.paused,true); assert.equal(app.playbackIntent,'pause');
    await fixture.wear(true);
    assert.equal(fakeAudio.paused,false); assert.equal(app.isPlaying,true);
    assert.equal(app.outputSafetyWearResume,null);
  } finally {fixture.dispose();}
});

test('a switch gap retains the output monitor; manual pause still releases it immediately', async () => {
  const fixture = await createWearPlaybackFixture();
  const { app, monitor, safety } = fixture;
  try {
    app.beginPlaybackTransition('C:/Music/B.mp3','manual',{});
    app.isPlaying = false;
    await fixture.settle();
    assert.equal(safety.active,true);
    assert.equal(monitor.leases.size,1);
    app.pendingPlaybackTransition = null;
    app.recommendationResume = {origin:app.currentPath,generation:app.playbackGeneration};
    app.syncMediaSessionPlaybackState();
    assert.equal(safety.active,true);
    app.pauseByManual('user'); await fixture.settle();
    assert.equal(safety.active,false);
    assert.equal(monitor.leases.size,0);
  } finally {fixture.dispose();}
});

test('display metadata does not discard preloaded change audio; a library reload still invalidates it', async () => {
  const fixture = await createWearPlaybackFixture();
  const { app, fakeAudio } = fixture;
  try {
    app.useRecommend = true;
    const runtime = app.ensureRecommendationRuntime(), element = new FakeAudio();
    const data = {dislike_list:[{path:'C:/Music/B.mp3',probability:1}],
      diagnostic:{intent:'change',details:{model:'muq+mert'}}};
    runtime.caches.set('change',{stamp:app.getRecommendationPolicyStamp(),at:Date.now(),data});
    const ticket = {path:'C:/Music/B.mp3',element,from:fakeAudio,ready:true,at:Date.now(),
      base:app.getRecommendationPreparationStamp(),recommendationContext:data};
    runtime.media.set('change',ticket); runtime.owners.set(element,ticket);
    app._localMetadataRevision++;
    const ready = app.takePreparedRecommendation('change');
    assert.equal(ready,ticket);
    assert.equal(ready.ready,true);
    runtime.claimed.delete(ticket); runtime.media.set('change',ticket);
    app._trackLoadGeneration++;
    assert.equal(app.takePreparedRecommendation('change')?.ready,undefined);
  } finally {fixture.dispose();}
});

test("performance UI snapshots reuse the library during selection and restore both snapshot formats", () => {
  const { app, rendererState, writes } = createRendererHarness();
  app.tracks = Array.from({ length: 3600 }, (_, index) => ({ path: `C:\\Music\\${index}.mp3`, title: `歌曲${index}` }));
  app._localMetadataRevision = 1;
  app.saveUiSnapshot();
  const firstLibrary = rendererState["lx-library-snapshot"];
  assert.equal(JSON.parse(firstLibrary).tracks.length, 3600);
  assert.equal(Object.hasOwn(JSON.parse(rendererState["lx-ui-snapshot"]), "tracks"), false);
  for (let index = 0; index < 10; index += 1) {
    app.selectedPath = app.tracks[index].path;
    app.saveUiSnapshot();
  }
  assert.equal(writes.filter(([key]) => key === "lx-library-snapshot").length, 1);
  assert.equal(JSON.parse(rendererState["lx-ui-snapshot"]).selectedPath, app.tracks[9].path);
  assert.equal(rendererState["lx-library-snapshot"], firstLibrary);
  app._localMetadataRevision += 1;
  app.saveUiSnapshot();
  assert.equal(writes.filter(([key]) => key === "lx-library-snapshot").length, 1);
  app.saveUiSnapshot({ flushLibrary: true });
  assert.equal(writes.filter(([key]) => key === "lx-library-snapshot").length, 2);
  assert.equal(app._uiLibrarySnapshotTimer, null);
  for (const inline of [false, true]) {
    const snapshot = JSON.parse(rendererState["lx-ui-snapshot"]);
    if (inline) snapshot.tracks = JSON.parse(firstLibrary).tracks;
    const restored = createRendererHarness({ rendererState: { ...rendererState, "lx-ui-snapshot": JSON.stringify(snapshot) } }).app;
    restored.queueSearchIndexRebuild = () => {};
    restored.reconcilePersistentTrackReferences = () => {};
    restored.restoreUiSnapshot();
    assert.equal(restored.tracks.length, 3600);
    assert.equal(restored.selectedPath, app.tracks[9].path);
  }
});

test("performance cover-only metadata does not rebuild search or request lyrics", async () => {
  let requested;
  const { app } = createRendererHarness({ getSongInfo: async (_path, options) => {
    requested = options;
    return { title: "Song", artist: "Singer", album: "Album", cover: "", duration: 120 };
  } });
  const doc = {};
  const track = { path: "C:\\Music\\Song.mp3", title: "Song", name: "Song", artist: "Singer", album: "Album", _searchDoc: doc };
  app.tracks = [track];
  app.trackByPath = new Map([[track.path, track]]);
  app.queueSearchIndexRebuild = () => { throw new Error("unnecessary search rebuild"); };
  await app.fillMetadataTargets([track], app._trackLoadGeneration);
  assert.equal(requested.includeLyrics, false);
  assert.equal(track._searchDoc, doc);
  assert.equal(track._metaLoaded, true);
});

test("composite seeds load through the real Vue public instance and reject late selection results", async () => {
  const vueContext = { console };
  nodeVm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "renderer", "vendor", "vue.global.prod.js"), "utf8"), vueContext);
  const seedA = { id: "a", name: "A", seed_track_paths: ["A.mp3"], rec_cache: [] };
  const seedB = { id: "b", name: "B", seed_track_paths: ["B.mp3"], rec_cache: [] };
  let resolveLateA;
  let delayA = false;
  let listRequests = 0;
  const { capturedConfig } = createRendererHarness({ axios: {
    async get(url) {
      if (url.endsWith("/seeds")) { listRequests++; return { data: { seeds: [seedA, seedB] } }; }
      if (url.endsWith("/a") && delayA) return new Promise((resolve) => { resolveLateA = resolve; });
      return { data: { seed: url.endsWith("/b") ? seedB : seedA } };
    },
  } });
  const renderer = vueContext.Vue.createRenderer({
    createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null,
  });
  const vueApp = renderer.createApp({
    data: capturedConfig.data,
    render: () => null,
    methods: {
      ensureSeedsLoaded: capturedConfig.methods.ensureSeedsLoaded,
      setView: capturedConfig.methods.setView,
      markLibraryUserInteraction() {},
      loadSeeds: capturedConfig.methods.loadSeeds,
      loadSeedDetail: capturedConfig.methods.loadSeedDetail,
      sortSeedRecs: capturedConfig.methods.sortSeedRecs,
      updateSeedPlaylist() {},
    },
  });
  const vm = vueApp.mount({});
  try {
    const preload = vm.ensureSeedsLoaded();
    assert.equal(vm.ensureSeedsLoaded(), preload);
    assert.equal(await preload, true);
    assert.equal(vm.seedsLoaded, true);
    vm.setView("seeds");
    vm.setView("library");
    vm.setView("seeds");
    assert.equal(listRequests, 1);
    assert.equal(vm.currentSeedId, "a");
    assert.equal(vm.seedLoadGeneration, 1);
    assert.deepEqual(Array.from(vm.seedPos), ["A.mp3"]);
    delayA = true;
    const lateA = vm.loadSeedDetail("a");
    vm.currentSeedId = "b";
    assert.equal(await vm.loadSeedDetail("b"), true);
    resolveLateA({ data: { seed: seedA } });
    assert.equal(await lateA, false);
    assert.equal(vm.currentSeedId, "b");
    assert.deepEqual(Array.from(vm.seedPos), ["B.mp3"]);
  } finally {
    vueApp.unmount();
  }
});

class FakeAudio {
  constructor() {
    this._src = "";
    this.currentSrc = "";
    this.currentTime = 0;
    this.duration = 180;
    this.readyState = 1;
    this.paused = true;
    this.ended = false;
    this.volume = 0.8;
    this.muted = false;
    this.playbackRate = 1;
  }

  get src() {
    return this._src;
  }

  set src(value) {
    this._src = String(value || "");
    this.currentSrc = this._src;
    this.currentTime = 0;
    this.paused = true;
  }

  getAttribute(name) {
    return name === "src" ? this._src : null;
  }

  removeAttribute(name) {
    if (name === "src") this.src = "";
  }

  load() {
    this.currentSrc = this._src;
  }

  async play() {
    if (this._src.includes("bad.mp3")) {
      throw new Error("decode failed");
    }
    this.paused = false;
  }

  pause() {
    this.paused = true;
  }

  addEventListener() {}

  removeEventListener() {}
}

function createRendererHarness(options = {}) {
  const rendererState = {
    "lx-last-track": "C:\\Music\\A.mp3",
    "lx-play-history": "[]",
    ...(options.rendererState || {}),
  };
  const writes = [];
  const fakeAudio = new FakeAudio();
  fakeAudio.src = "file:///C:/Music/A.mp3";
  fakeAudio.currentTime = 12;
  fakeAudio.paused = false;

  let capturedConfig = null;
  const windowObject = {
    innerWidth: 1280,
    innerHeight: 720,
    LyricUtils: {},
    LyricModelAdapter,
    LyricTiming: require("../renderer/lyric-timing"),
    PlaybackTransitionUtils,
    RecommendationContext: require("../renderer/recommendation-context"),
    FlowaveFolders: require("../renderer/folder-browser"),
    KumikoSearch: options.searchUtils,
    Worker: options.Worker,
    FlowaveSearchController: options.searchController,
    FlowaveAudioEffects: options.audioEffects,
    lxEnv: {
      getRendererStateSync: () => ({ ...rendererState }),
      setRendererState: async (key, value) => {
        rendererState[key] = String(value);
        writes.push([key, String(value)]);
      },
      removeRendererState: async (key) => {
        delete rendererState[key];
      },
      getSongInfo: options.getSongInfo || (async (trackPath) => ({
        title: path.basename(String(trackPath), path.extname(String(trackPath))),
        artist: "Artist",
        album: "Album",
        lyrics: "",
        duration: 180,
      })),
      ...(options.lxEnv || {}),
    },
  };
  const sandbox = {
    Audio: function Audio() {
      return options.makeAudio ? options.makeAudio(fakeAudio) : fakeAudio;
    },
    URL,
    TextEncoder,
    LyricModelAdapter,
    Vue: {
      markRaw: options.markRaw || (value => value),
      createApp(config) {
        capturedConfig = config;
        return { mount: () => config };
      },
    },
    window: windowObject,
    document: {
      documentElement: { setAttribute() {}, style: { setProperty() {} } },
      querySelector() { return null; },
    },
    getComputedStyle: (element) => ({ paddingTop: element.paddingTop || "0px" }),
    localStorage: { getItem: () => null },
    navigator: options.navigator || {},
    axios: options.axios || {},
    console: { ...console, warn() {} },
    alert() {},
    confirm: () => true,
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
    setInterval,
    clearInterval,
    requestAnimationFrame: (callback) => setTimeout(callback, 0),
    cancelAnimationFrame: clearTimeout,
    Date,
    Math: options.Math || Math,
    JSON,
    Object,
    Array,
    Map,
    Set,
    Promise,
  };
  sandbox.globalThis = sandbox;
  const historyPackage = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'official-modules', 'packages', 'history-1.0.0.fwm'), 'utf8'));
  nodeVm.runInNewContext(Buffer.from(historyPackage.files['module.js'], 'base64').toString('utf8'), sandbox, { filename: 'official-history/module.js' });
  nodeVm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", "renderer", "app.js"), "utf8"),
    sandbox,
    { filename: "renderer/app.js" },
  );
  assert.ok(capturedConfig, "renderer Vue config should be captured");

  const app = { ...capturedConfig.data() };
  Object.entries(capturedConfig.methods).forEach(([name, fn]) => {
    app[name] = fn.bind(app);
  });
  app.currentPath = "C:\\Music\\A.mp3";
  app.currentMeta = { title: "A", artist: "Artist", album: "Album", lyric: "" };
  app.currentTime = 12;
  app.duration = 180;
  app.durationText = "03:00";
  app.isPlaying = true;
  app.playbackIntent = "play";
  app.playbackPauseReason = "none";
  app._committedAudioSource = fakeAudio.src;
  app.useRecommend = false;
  app.queueUiSnapshotSave = () => {};
  app.syncMediaSessionPlaybackState = () => {};
  app.syncKaraokeProgressTicker = () => {};
  app.updateMediaSessionMetadata = () => {};

  return { app, fakeAudio, rendererState, writes, capturedConfig };
}

test("switch checkpoint settles listening immediately and defers the full history snapshot", async () => {
  const { app } = createRendererHarness();
  const session = { path: app.currentPath };
  app.listeningSession = session;
  let settlements = 0;
  let snapshots = 0;
  let scheduled = 0;
  app.updateListeningSessionProgress = () => { settlements += 1; };
  app.maybeCountListeningPlay = () => {};
  app.queueListeningHistorySave = () => { scheduled += 1; };
  app.saveListeningHistoryNow = async () => { snapshots += 1; return { ok: true }; };
  const result = await app.flushListeningSession("switch-attempt", { deferSave: true });
  assert.equal(result.scheduled, true);
  assert.equal(settlements, 1);
  assert.equal(session.state, "ended");
  assert.equal(app.listeningSession, null);
  assert.equal(scheduled, 1);
  assert.equal(snapshots, 0);
  app.listeningSession = { path: app.currentPath };
  await app.flushListeningSession("unmount");
  assert.equal(snapshots, 1);
});

test("background search rebuild retains full results until replacement and rejects an old library", () => {
  const tasks = [];
  const searchUtils = {
    buildTrackDoc: (track) => ({ path: track.path }),
    createFuse: () => ({}),
    search: (docs) => docs.slice(0, 21).map((doc) => ({ doc })),
  };
  const { app } = createRendererHarness({ searchUtils, setTimeout: (fn) => { tasks.push(fn); return tasks.length; } });
  app.tracks = Array.from({ length: 240 }, (_, i) => ({
    path: `${i}.mp3`, _searchText: i < 20 ? "鹿乃" : "其他", _searchDoc: { path: `${i}.mp3` },
  }));
  app.keyword = app.keywordDraft = "鹿乃";
  app.rebuildTrackLookup();
  const originalDocs = app.searchDocs;
  app.rebuildSearchIndexChunked();
  assert.equal(app.searchIndexReady, true);
  assert.equal(app.searchTrackList(app.tracks, "鹿乃").length, 21);
  tasks.shift()();
  assert.equal(app.searchDocs, originalDocs);
  assert.equal(app.searchTrackList(app.tracks, "鹿乃").length, 21);
  tasks.shift()();
  assert.notEqual(app.searchDocs, originalDocs);
  assert.equal(app.searchTrackList(app.tracks, "鹿乃").length, 21);
  app.rebuildSearchIndexChunked();
  const lastCompleteDocs = app.searchDocs;
  app.tracks = [];
  tasks.shift()();
  assert.equal(app.searchDocs, lastCompleteDocs);
});

test("search worker integration uses real Vue state, preserves visible results, and discards an old library", async () => {
  const SearchController = require("../renderer/search-controller");
  const workers = [];
  const fallbackTasks = [];
  let mainSearches = 0;
  class FakeSearchWorker {
    constructor() { this.posted = []; workers.push(this); }
    postMessage(message) { this.posted.push(message); }
    terminate() {}
    receive(data) { this.onmessage({ data }); }
  }
  const { capturedConfig } = createRendererHarness({ Worker: FakeSearchWorker, searchController: SearchController,
    setTimeout: (fn) => { fallbackTasks.push(fn); return fallbackTasks.length; },
    searchUtils: {
      buildTrackDoc: (track) => ({ path: track.path }), createFuse: () => null,
      search: (docs) => { mainSearches += 1; return docs.map((doc) => ({ doc })); },
    } });
  const context = { console };
  nodeVm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/vendor/vue.global.prod.js"), "utf8"), context);
  const Vue = context.Vue;
  const host = Vue.createRenderer({ createComment: () => ({}), insert() {}, remove() {}, parentNode: () => null, nextSibling: () => null });
  const names = ["ensureSearchController", "rebuildSearchIndexChunked", "searchTrackList", "extractName", "prepareTrackForList"];
  const vueApp = host.createApp({
    data: capturedConfig.data,
    methods: Object.fromEntries(names.map((name) => [name, capturedConfig.methods[name]])),
    computed: {
      currentPlaylistTracks() { return this.tracks; },
      filteredTracks: capturedConfig.computed.filteredTracks,
    },
    render: () => null,
  });
  const instance = vueApp.mount({});
  try {
    instance.tracks = [{ path: "A.mp3", title: "A" }, { path: "B.mp3", title: "B" }];
    instance.trackByPath = new Map(instance.tracks.map((track) => [track.path, track]));
    instance.rebuildSearchIndexChunked();
    const worker = workers[0];
    assert.equal(worker.posted[0].type, "build");
    worker.receive({ type: "ready", generation: 1 });
    instance.keyword = "A";
    void instance.filteredTracks;
    const firstQuery = worker.posted.at(-1);
    worker.receive({ type: "result", id: firstQuery.id, generation: 1, paths: ["A.mp3"] });
    assert.deepEqual(Array.from(instance.filteredTracks, (track) => track.path), ["A.mp3"]);
    instance.keyword = "B";
    assert.deepEqual(Array.from(instance.filteredTracks, (track) => track.path), ["A.mp3"]);
    const secondQuery = worker.posted.at(-1);
    worker.receive({ type: "result", id: firstQuery.id, generation: 1, paths: ["A.mp3"] });
    worker.receive({ type: "result", id: secondQuery.id, generation: 1, paths: ["B.mp3"] });
    assert.deepEqual(Array.from(instance.filteredTracks, (track) => track.path), ["B.mp3"]);
    const subset = [instance.tracks[0]];
    assert.deepEqual(Array.from(instance.searchTrackList(subset, "B", true)), []);
    instance.tracks = [{ path: "C.mp3", title: "C" }];
    instance.trackByPath = new Map(instance.tracks.map((track) => [track.path, track]));
    instance.rebuildSearchIndexChunked();
    worker.receive({ type: "ready", generation: 1 });
    worker.receive({ type: "result", id: secondQuery.id, generation: 1, paths: ["B.mp3"] });
    assert.deepEqual(Array.from(instance.filteredTracks, (track) => track.path), []);
    worker.receive({ type: "ready", generation: 2 });
    void instance.filteredTracks;
    worker.receive({ type: "result", id: worker.posted.at(-1).id, generation: 2, paths: [] });
    assert.deepEqual(Array.from(instance.filteredTracks), []);
    assert.equal(mainSearches, 0, "healthy worker searches must never run on the renderer thread");
    instance.keywordDraft = instance.keyword = "C";
    worker.onerror();
    assert.equal(instance._searchWorkerController, null);
    fallbackTasks.shift()();
    assert.deepEqual(Array.from(instance.filteredTracks, (track) => track.path), ["C.mp3"]);
    assert.ok(mainSearches > 0, "worker failure must activate the existing fallback");
  } finally { instance._searchWorkerController?.close(); vueApp.unmount(); }
});

test("search input activity defers background metadata and library snapshots without delaying explicit flush", () => {
  const tasks = [];
  const { app, writes } = createRendererHarness({ setTimeout: (fn) => { tasks.push(fn); return tasks.length; }, clearTimeout() {} });
  app.trackByPath = new Map([["A.mp3", { path: "A.mp3" }]]);
  app.tracks = [{ path: "A.mp3" }];
  app.buildMetadataFillPlan = () => { throw new Error("metadata must wait while typing"); };
  app.onLibrarySearchActivity(true);
  app.saveUiSnapshot();
  assert.equal(writes.filter(([key]) => key === "lx-library-snapshot").length, 0);
  tasks.shift()();
  assert.ok(tasks.length >= 2, "metadata must reschedule during composition");
  app.saveUiSnapshot({ flushLibrary: true });
  assert.equal(writes.filter(([key]) => key === "lx-library-snapshot").length, 1);
});

test("search rebuild coalesces same-library metadata changes without starving the initial index", () => {
  const posted = [];
  let worker;
  const { app } = createRendererHarness({
    Worker: class { constructor() { worker = this; } postMessage(message) { posted.push(message); } terminate() {} },
    searchController: require("../renderer/search-controller"),
  });
  let deferredBuilds = 0;
  app.queueSearchIndexRebuild = () => { deferredBuilds += 1; };
  app.tracks = [{ path: "A.mp3", title: "A" }];
  try {
    app.rebuildSearchIndexChunked();
    app.tracks[0].title = "Updated";
    app.rebuildSearchIndexChunked();
    app.rebuildSearchIndexChunked();
    assert.equal(posted.length, 1);
    worker.onmessage({ data: { type: "ready", generation: 1 } });
    assert.equal(app.searchIndexReady, true);
    assert.equal(deferredBuilds, 1);
    app.rebuildSearchIndexChunked();
    assert.equal(posted.length, 2);
    assert.equal(posted[1].tracks[0].title, "Updated");
    app.tracks = [{ path: "New.mp3", title: "New Library" }];
    app.rebuildSearchIndexChunked();
    assert.equal(posted.length, 3, "a different library must supersede the old build immediately");
  } finally { app._searchWorkerController?.close(); }
});

test("list loop and shuffle follow displayed search results while recommendation stays independent", async () => {
  const { app } = createRendererHarness();
  const a = { path: "A.mp3" }, b = { path: "B.mp3" }, c = { path: "C.mp3" };
  app.filteredTracks = [a, c];
  app.currentPath = a.path;
  app.playByPath = async (path) => ({ ok: true, path });
  app.playMode = "loop";
  assert.equal((await app.playFromPlaylistNext()).path, c.path);
  app.currentPath = c.path;
  assert.equal((await app.playFromPlaylistNext()).path, a.path);
  app.currentPath = a.path;
  app.playMode = "shuffle";
  assert.equal((await app.playFromPlaylistNext()).path, c.path);
  app.useRecommend = true;
  app.hasFreshRecCache = () => true;
  app.recCache = { like_list: [{ path: b.path }] };
  assert.equal((await app.nextTrack()).path, b.path);
  app.filteredTracks = [];
  assert.equal((await app.playFromPlaylistNext()).ok, false);
});

test("playByPath commits identity, history, and last track only after audio starts", async () => {
  const { app, rendererState } = createRendererHarness();

  const result = await app.playByPath("C:\\Music\\B.mp3", true, "manual");

  assert.equal(result.ok, true);
  assert.equal(app.currentPath, "C:\\Music\\B.mp3");
  assert.equal(app.currentMeta.title, "B");
  assert.deepEqual(Array.from(app.playHistory), ["C:\\Music\\B.mp3"]);
  assert.equal(rendererState["lx-last-track"], "C:\\Music\\B.mp3");
  assert.equal(app.listeningSession.path, "C:\\Music\\B.mp3");
});

test("playByPath failure restores the previous source, position, and playing state", async () => {
  const { app, fakeAudio, rendererState } = createRendererHarness();

  const result = await app.playByPath("C:\\Music\\bad.mp3", true, "manual");

  assert.equal(result.ok, false);
  assert.equal(result.canceled, false);
  assert.equal(app.currentPath, "C:\\Music\\A.mp3");
  assert.equal(app.currentMeta.title, "A");
  assert.equal(fakeAudio.currentSrc, "file:///C:/Music/A.mp3");
  assert.equal(fakeAudio.currentTime, 12);
  assert.equal(app.isPlaying, true);
  assert.deepEqual(Array.from(app.playHistory), []);
  assert.equal(rendererState["lx-last-track"], "C:\\Music\\A.mp3");
  assert.equal(result.error, "音频格式不受支持或文件已损坏。");
  assert.doesNotMatch(result.error, /source=|file:\/\/|decode failed|C:\\/);
});

test("rapid A-to-B-to-C switching commits only the latest target", async () => {
  let releaseB;
  const bMetadata = new Promise((resolve) => {
    releaseB = resolve;
  });
  const { app, rendererState } = createRendererHarness({
    getSongInfo: async (trackPath) => {
      if (String(trackPath).endsWith("B.mp3")) return bMetadata;
      return {
        title: path.basename(String(trackPath), path.extname(String(trackPath))),
        artist: "Artist",
        album: "Album",
        lyrics: "",
        duration: 180,
      };
    },
  });

  const first = app.playByPath("C:\\Music\\B.mp3", true, "manual");
  await Promise.resolve();
  const second = await app.playByPath("C:\\Music\\C.mp3", true, "manual");
  releaseB({ title: "B", artist: "Artist", album: "Album", lyrics: "", duration: 180 });
  const firstResult = await first;

  assert.equal(second.ok, true);
  assert.equal(firstResult.canceled, true);
  assert.equal(app.currentPath, "C:\\Music\\C.mp3");
  assert.deepEqual(Array.from(app.playHistory), ["C:\\Music\\C.mp3"]);
  assert.equal(rendererState["lx-last-track"], "C:\\Music\\C.mp3");
});

test("library relocation updates durable track references without touching audio state", async () => {
  const { app, fakeAudio, rendererState } = createRendererHarness();
  const oldPath = "C:\\Music\\A.mp3";
  const movedPath = "D:\\Library\\A.mp3";
  app.selectedPath = oldPath;
  app.rankingFor = oldPath;
  app.playHistory = [oldPath, "C:\\Music\\B.mp3"];
  app.customPlaylists = [
    { id: "custom-1", name: "收藏", type: "custom", tracks: [oldPath] },
  ];
  app.recCache = { like_list: [{ path: oldPath }] };
  app.recCacheFor = oldPath;
  const committedAudioSource = fakeAudio.currentSrc;

  app.applyLibraryRelocations([
    { song_key: "artist - a", from: oldPath, to: movedPath },
  ]);
  await Promise.resolve();

  assert.equal(app.currentPath, movedPath);
  assert.equal(app.selectedPath, movedPath);
  assert.equal(app.rankingFor, movedPath);
  assert.deepEqual(Array.from(app.playHistory), [movedPath, "C:\\Music\\B.mp3"]);
  assert.deepEqual(Array.from(app.customPlaylists[0].tracks), [movedPath]);
  assert.equal(rendererState["lx-last-track"], movedPath);
  assert.equal(fakeAudio.currentSrc, committedAudioSource);
  assert.equal(app.recCache, null);
  assert.equal(app.recCacheFor, null);
});

test("custom playlist create, rename, and delete validate and persist", async () => {
  const { app, rendererState } = createRendererHarness();
  app.tracks = [];
  app.playlists = [];
  app.customPlaylists = [];

  app.promptNewPlaylist();
  app.playlistEditName = "夜晚散步";
  assert.equal(app.confirmPlaylistEdit(), true);
  assert.equal(app.customPlaylists.length, 1);
  assert.equal(app.customPlaylists[0].name, "夜晚散步");
  assert.equal(app.currentPlaylist, app.customPlaylists[0].id);

  app.playlistContextMenu = {
    show: true,
    playlistId: app.customPlaylists[0].id,
    playlistName: app.customPlaylists[0].name,
  };
  app.openRenamePlaylistModal();
  app.playlistEditName = "安静流动";
  assert.equal(app.confirmPlaylistEdit(), true);
  assert.equal(app.customPlaylists[0].name, "安静流动");
  assert.match(rendererState["lx-custom-playlists"], /安静流动/);

  app.playlistContextMenu = {
    show: true,
    playlistId: app.customPlaylists[0].id,
    playlistName: app.customPlaylists[0].name,
  };
  app.requestConfirmation = async () => true;
  await app.deletePlaylistFromContextMenu();
  assert.equal(app.customPlaylists.length, 0);
  assert.equal(app.currentPlaylist, "all");
  assert.equal(rendererState["lx-custom-playlists"], "[]");
});

test("custom playlist add and remove track keep playback untouched", async () => {
  const { app, fakeAudio, rendererState } = createRendererHarness();
  const trackPath = "C:\\Music\\A.mp3";
  app.tracks = [];
  app.playlists = [];
  app.customPlaylists = [
    { id: "custom-1", name: "收藏", type: "custom", tracks: [] },
  ];
  app.currentPlaylist = "custom-1";
  app.restorePlaylistScroll = () => {};
  const committedAudioSource = fakeAudio.currentSrc;

  app.addToPlaylist(trackPath);
  app.playlistAddTargetId = "custom-1";
  assert.equal(app.confirmAddToPlaylist(), true);
  assert.deepEqual(Array.from(app.customPlaylists[0].tracks), [trackPath]);
  app.addToPlaylist(trackPath);
  app.playlistAddTargetId = "custom-1";
  assert.equal(app.confirmAddToPlaylist(), false);
  assert.match(app.playlistAddError, /已经在/);
  app.cancelAddToPlaylist();

  app.trackContextMenu = { show: true, path: trackPath, x: 0, y: 0 };
  assert.equal(app.canRemoveTrackFromCurrentPlaylist(trackPath), true);
  assert.equal(app.removeTrackFromCurrentPlaylist(trackPath), true);
  assert.deepEqual(Array.from(app.customPlaylists[0].tracks), []);
  assert.equal(fakeAudio.currentSrc, committedAudioSource);
  assert.match(rendererState["lx-custom-playlists"], /"tracks":\[\]/);
});

test("all songs preserves playlist order and moves direct download folders to the end", () => {
  const { app } = createRendererHarness();
  const paths = [
    "C:\\Music\\MymusicOS下载\\Tim Janis - Reflections.mp3",
    "C:\\Music\\part1\\A.mp3",
    "C:\\Flowave\\data\\downloads\\B.mp3",
    "C:\\Music\\part2\\C.mp3",
  ];
  app.params = {
    ...app.params,
    audio_dir: "C:\\Music",
    download_dir: "C:\\Flowave\\data\\downloads",
  };
  app.tracks = paths.map((trackPath) => ({ path: trackPath, title: path.basename(trackPath) }));
  app.trackByPath = new Map(app.tracks.map((track) => [track.path, track]));
  app.currentPlaylist = "all";

  app.buildFolderPlaylists();

  assert.deepEqual(
    Array.from(app.getCurrentPlaylistTracks(), (track) => track.path),
    [paths[1], paths[3], paths[0], paths[2]],
  );
});

test("public navigation rejects legacy seed and ranking views without preloading them", () => {
  const { app, capturedConfig } = createRendererHarness({
    rendererState: { "lx-last-view": "seeds" },
  });
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");

  assert.equal(app.view, "library");
  app.setView("ranking");
  assert.equal(app.view, "library");
  app.visitedViews = { library: true, seeds: true, ranking: true };
  assert.equal(app.shouldRenderView("seeds"), false);
  assert.equal(app.shouldRenderView("ranking"), false);
  app.setView("online");
  assert.equal(app.view, "online");
  assert.equal(app.shouldRenderView("online"), true);

  assert.doesNotMatch(html, /title="复合种子"/);
  assert.doesNotMatch(html, /title="全库排行"/);
  assert.doesNotMatch(html, /openSeedMenuFromTrackContext/);
  assert.doesNotMatch(html, /v-model\.number="params\.seed\./);
  assert.doesNotMatch(capturedConfig.methods.loadTracks.toString(), /loadSeeds|loadRanking/);
});

test("bottom recommendation mode uses a neutral text state button", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "style.css"), "utf8");

  assert.match(html, /class="player-recommend-toggle"/);
  assert.match(html, /:aria-pressed="useRecommend \? 'true' : 'false'"/);
  assert.match(html, />推荐<\/button>/);
  assert.doesNotMatch(html, /class="player-recommend-switch"/);
  assert.match(css, /\.player-recommend-toggle\.active\s*\{/);
  assert.doesNotMatch(css, /\.player-recommend-toggle\.active\s*\{[^}]*var\(--settings-switch\)/);
  assert.equal((html.match(/class="player-recommend-toggle/g) || []).length, 2);
  assert.match(html, /class="player-recommend-toggle lyric-recommend-toggle"/);
  assert.doesNotMatch(html, /class="switch lyric-switch"/);
  assert.doesNotMatch(css, /\.lyric-switch\s*\{/);
});

test("player chrome uses stable cover placeholders and consistent icon sizing", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "style.css"), "utf8");

  assert.match(html, /class="player-cover-placeholder"/);
  assert.match(html, /class="lyric-cover-placeholder"/);
  assert.doesNotMatch(html, /:src="currentCover \|\| ''"/);
  assert.match(html, /:aria-label="isCurrentOnlineTrack \?/);
  assert.doesNotMatch(css, /\.favorite-btn\s*\{[^}]*min-width:\s*40px/);
});

test("settings show saved values as text and translate online source codes", () => {
  const { app, capturedConfig } = createRendererHarness();
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  app.onlineSourceNames = ["wy", "tx"];

  assert.equal(capturedConfig.computed.onlineSourceSummaryLabel.call(app), "网易、QQ");
  assert.match(html, /<output class="settings-value">\{\{ onlineSourceSummaryLabel \}\}<\/output>/);
  assert.match(html, /<output class="settings-value">歌曲旁 \.lrc<\/output>/);
  assert.doesNotMatch(html, /:value="onlineSourceNames[^>]*disabled/);
});

test("common, song-information and lyric settings use compact system groups", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "style.css"), "utf8");

  assert.match(html, /class="settings-card settings-destination-list"/);
  assert.match(html, /class="settings-destination" @click="openSongInfoBatchSettings"/);
  assert.match(html, /aria-label="连续推荐"/);
  assert.match(html, /查找歌曲信息/);
  assert.match(html, /查找缺失歌词/);
  assert.doesNotMatch(html, /class="settings-card settings-link-card"/);
  assert.doesNotMatch(html, /<span class="status-pill">只补空白<\/span>/);
  assert.doesNotMatch(css, /\.settings-link-card\s*\{/);
  assert.match(css, /\.settings-destination\s*\{/);
  assert.equal((html.match(/class="settings-card settings-group-stack"/g) || []).length, 2);
  assert.equal((html.match(/class="settings-card settings-group-stack lyric-settings-stack"/g) || []).length, 2);
  assert.match(html, /class="settings-card settings-group-stack lyric-settings-stack"[\s\S]*?<h3>歌词来源<\/h3>[\s\S]*?<h3>歌词保存<\/h3>[\s\S]*?<\/section>/);
  assert.match(html, /class="settings-card settings-group-stack lyric-settings-stack"[\s\S]*?<h3>软件内歌词<\/h3>[\s\S]*?<h3>歌词同步<\/h3>[\s\S]*?<h3>桌面歌词<\/h3>[\s\S]*?<\/section>/);
  assert.match(css, /\.settings-group-section \+ \.settings-group-section > \.settings-card-title\s*\{/);
});

test("library and online lists group artwork with the song title", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "style.css"), "utf8");

  assert.equal((html.match(/<div class="col-title">歌曲<\/div>/g) || []).length, 2);
  assert.equal((html.match(/class="col-title track-primary"/g) || []).length, 2);
  assert.doesNotMatch(html, /<div class="col-cover">封面<\/div>/);
  assert.doesNotMatch(css, /grid-template-columns:\s*44px 68px/);
  assert.match(css, /\.track-primary\s*\{/);
});

test("advanced recommendation maintenance keeps algorithm parameters nested", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "..", "renderer", "style.css"), "utf8");

  assert.match(html, /<details class="maintenance-subgroup">\s*<summary>算法参数<\/summary>/);
  assert.match(html, /v-model\.number="params\.dislike_correction\.rec_strength"/);
  assert.match(html, /v-model\.number="params\.dislike_correction\.skip_strength"/);
  assert.match(css, /\.maintenance-subgroup\s*\{/);
});

test("zero disables the recent-track repeat window without being replaced by the default", async () => {
  let responseData = null;
  const api = {
    get: async () => ({ data: responseData }),
  };
  const { app } = createRendererHarness({ axios: api });
  responseData = JSON.parse(JSON.stringify(app.params));
  responseData.history = {
    ...(responseData.history || {}),
    no_repeat_within: 0,
    repeat_policy: "disallow",
  };

  await app.loadConfig();
  app.playHistory = ["C:\\Music\\A.mp3", "C:\\Music\\B.mp3"];

  assert.equal(app.params.history.no_repeat_within, 0);
  assert.equal(app.buildConfigPayload().history.no_repeat_within, 0);
  assert.equal(app.getRecommendHistoryPolicy().windowSize, 0);
  assert.deepEqual(Array.from(app.getRecommendHistoryWindow()), []);
});

test("renderer numeric defaults distinguish missing values from explicit zero", () => {
  const defaultsVersion = "2026-06-config-renderer-state-v2";
  const missing = createRendererHarness({
    rendererState: {
      "lx-defaults-version": defaultsVersion,
    },
  }).app;
  assert.equal(missing.lyricFocusLeadMs, 500);
  assert.equal(missing.desktopLyricStroke, 0.5);

  const explicitZero = createRendererHarness({
    rendererState: {
      "lx-defaults-version": defaultsVersion,
      "lx-lyric-focus-lead-ms": "0",
      "lx-desktop-lyric-stroke": "0",
    },
  }).app;
  assert.equal(explicitZero.lyricFocusLeadMs, 0);
  assert.equal(explicitZero.desktopLyricStroke, 0);
});

test("default migration fills missing keys without replacing existing choices", () => {
  const { app, rendererState } = createRendererHarness({
    rendererState: {
      "lx-defaults-version": "older-version",
      "lx-lyric-focus-lead-ms": "250",
      "lx-lyric-main-font": "44",
    },
  });

  assert.equal(app.lyricFocusLeadMs, 250);
  assert.equal(app.lyricMainFontSize, 44);
  assert.equal(rendererState["lx-lyric-focus-lead-ms"], "250");
  assert.equal(rendererState["lx-lyric-main-font"], "44");
  assert.equal(rendererState["lx-desktop-lyric-stroke"], "0.5");
  assert.equal(rendererState["lx-defaults-version"], "2026-06-config-renderer-state-v2");
});

test("favorite shortcut toggles the current online track", () => {
  const { app } = createRendererHarness();
  app.currentPath = "online://wy/song-1";
  app.customPlaylists = [];
  app.buildFolderPlaylists = () => {};
  app.persistCurrentPlaylistOrder = () => {};

  assert.equal(app.dispatchPlayerAction("favorite", "shortcut"), true);
  assert.equal(app.customPlaylists.length, 1);
  assert.equal(app.customPlaylists[0].name, "我喜欢的歌");
  assert.deepEqual(Array.from(app.customPlaylists[0].tracks), ["online://wy/song-1"]);

  assert.equal(app.dispatchPlayerAction("favorite", "shortcut"), true);
  assert.deepEqual(Array.from(app.customPlaylists[0].tracks), []);
});

test("context menus stay inside the renderer viewport", () => {
  const { app } = createRendererHarness();

  assert.deepEqual(
    { ...app.clampContextMenuPosition({ clientX: 1275, clientY: 715 }, 210, 170) },
    { x: 1062, y: 542 },
  );
  assert.deepEqual(
    { ...app.clampContextMenuPosition({ clientX: -10, clientY: 0 }, 210, 170) },
    { x: 8, y: 8 },
  );
});

test("Escape closes transient UI without interrupting an active download", () => {
  const { app } = createRendererHarness();
  let prevented = 0;
  const event = { key: "Escape", preventDefault: () => { prevented += 1; } };

  app.trackContextMenu = { show: true, x: 10, y: 10, path: "C:\\Music\\A.mp3" };
  app.playlistEditModalVisible = true;
  app.playlistEditId = "custom-1";
  app.playlistEditName = "列表";
  assert.equal(app.handleGlobalEscape(event), true);
  assert.equal(app.trackContextMenu.show, false);
  assert.equal(app.playlistEditModalVisible, false);
  assert.equal(prevented, 1);

  app.onlineDownloadModalVisible = true;
  app.onlineDownloading = true;
  assert.equal(app.handleGlobalEscape(event), false);
  assert.equal(app.onlineDownloadModalVisible, true);
  assert.equal(prevented, 1);
});

test("clean-install library setup saves the selected folder and loads tracks in one flow", async () => {
  const requests = [];
  const steps = [];
  const selectedPath = "C:\\Music";
  const { app } = createRendererHarness({
    lxEnv: {
      pickDirectory: async () => ({ canceled: false, path: selectedPath }),
    },
    axios: {
      post: async (url, payload) => {
        requests.push([url, payload]);
        return { data: { ok: true, committed: true, relocations: [] } };
      },
    },
  });
  app.baseUrl = "http://127.0.0.1:29613";
  app.params.audio_dir = "";
  app.tracks = [];
  app.loadTracks = async () => {
    steps.push("loadTracks");
    app.tracks = [{ path: `${selectedPath}\\song.mp3` }];
  };
  app.buildFolderPlaylists = () => steps.push("buildFolderPlaylists");
  app.refreshVirtualViewport = () => steps.push("refreshVirtualViewport");
  app.$nextTick = (callback) => callback();

  await app.setupMusicLibrary();

  assert.equal(app.params.audio_dir, selectedPath);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][0], "http://127.0.0.1:29613/tracks/rescan");
  assert.equal(requests[0][1].audio_dir, selectedPath);
  assert.deepEqual(steps, ["loadTracks", "buildFolderPlaylists", "refreshVirtualViewport"]);
  assert.match(app.libraryRefreshMessage, /已载入 1 首歌曲/);
  assert.equal(app.loading, false);
});

test("choosing a music folder keeps it as a draft until the user loads it", async () => {
  const selectedPath = "D:\\Music";
  const requests = [];
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const { app } = createRendererHarness({
    lxEnv: {
      pickDirectory: async () => ({ canceled: false, path: selectedPath }),
    },
    axios: {
      post: async (...args) => {
        requests.push(args);
        return { data: { ok: true } };
      },
    },
  });
  app.params.audio_dir = "C:\\Music";
  app.audioDirectoryDraft = app.params.audio_dir;

  await app.pickAudioDir();

  assert.equal(app.audioDirectoryDraft, selectedPath);
  assert.equal(app.params.audio_dir, "C:\\Music");
  assert.equal(app.hasPendingAudioDirectoryChange(), true);
  assert.equal(requests.length, 0);
  assert.equal(Object.hasOwn(app.buildConfigPayload(), "audio_dir"), false);
  assert.match(html, /v-model="audioDirectoryDraft"[^>]*readonly/);
  assert.doesNotMatch(html, /v-model="params\.audio_dir"/);
});

test("explicit music folder load waits for an older auto-save before scanning the new folder", async () => {
  let resolveOldSave;
  const requests = [];
  const { app } = createRendererHarness({
    axios: {
      post: async (url, payload) => {
        requests.push({ url, payload: { ...payload } });
        if (!url.endsWith("/tracks/rescan")) {
          return new Promise((resolve) => {
            resolveOldSave = resolve;
          });
        }
        return { data: { ok: true, committed: true, relocations: [] } };
      },
    },
  });
  app.baseUrl = "http://127.0.0.1:29613";
  app.params.audio_dir = "C:\\Music";
  app.audioDirectoryDraft = "D:\\Music";
  app._configAutoSaveReady = true;
  app._lastSavedConfigFingerprint = "older";
  app.loadTracks = async () => {};
  app.buildFolderPlaylists = () => {};
  app.refreshVirtualViewport = () => {};
  app.$nextTick = (callback) => callback();

  const oldSave = app.flushConfigAutoSave();
  await Promise.resolve();
  const directorySave = app.saveAudioDirectory();
  await Promise.resolve();

  assert.equal(requests.length, 1);
  assert.equal(Object.hasOwn(requests[0].payload, "audio_dir"), false);

  resolveOldSave({ data: { ok: true } });
  await oldSave;
  assert.equal(await directorySave, true);

  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "http://127.0.0.1:29613/tracks/rescan");
  assert.equal(requests[1].payload.audio_dir, "D:\\Music");
  assert.equal(app.params.audio_dir, "D:\\Music");
  assert.equal(app.audioDirectoryDraft, "D:\\Music");
});

test("settings changed during a music folder commit are saved afterward without the folder field", async () => {
  let resolveDirectorySave;
  const requests = [];
  const { app } = createRendererHarness({
    axios: {
      post: async (url, payload) => {
        requests.push({ url, payload: JSON.parse(JSON.stringify(payload)) });
        if (url.endsWith("/tracks/rescan")) {
          return new Promise((resolve) => {
            resolveDirectorySave = resolve;
          });
        }
        return { data: { ok: true } };
      },
    },
  });
  app.baseUrl = "http://127.0.0.1:29613";
  app.params.audio_dir = "C:\\Music";
  app.audioDirectoryDraft = "D:\\Music";
  app._configAutoSaveReady = true;
  app._lastSavedConfigFingerprint = app.getConfigFingerprint(app.buildConfigPayload());
  app.loadTracks = async () => {};
  app.buildFolderPlaylists = () => {};
  app.refreshVirtualViewport = () => {};
  app.$nextTick = (callback) => callback();

  const directorySave = app.saveAudioDirectory();
  await Promise.resolve();
  app.params.history.no_repeat_within = 24;
  app.scheduleConfigAutoSave();
  assert.equal(app._configAutoSaveSuspended, true);
  assert.equal(requests.length, 1);

  resolveDirectorySave({ data: { ok: true, committed: true, relocations: [] } });
  assert.equal(await directorySave, true);
  if (app._configAutoSaveTimer) {
    clearTimeout(app._configAutoSaveTimer);
    app._configAutoSaveTimer = null;
  }
  await app.flushConfigAutoSave();

  assert.equal(requests.length, 2);
  assert.equal(Object.hasOwn(requests[1].payload, "audio_dir"), false);
  assert.equal(requests[1].payload.history.no_repeat_within, 24);
});

test("closing during a music folder scan still saves the latest ordinary settings", async () => {
  let resolveDirectorySave;
  const requests = [];
  const { app } = createRendererHarness({
    axios: {
      post: async (url, payload) => {
        requests.push({ url, payload: JSON.parse(JSON.stringify(payload)) });
        if (url.endsWith("/tracks/rescan")) {
          return new Promise((resolve) => {
            resolveDirectorySave = resolve;
          });
        }
        return { data: { ok: true } };
      },
    },
  });
  app.baseUrl = "http://127.0.0.1:29613";
  app.params.audio_dir = "C:\\Music";
  app.audioDirectoryDraft = "D:\\Music";
  app._configAutoSaveReady = true;
  app._lastSavedConfigFingerprint = app.getConfigFingerprint(app.buildConfigPayload());
  app.loadTracks = async () => {};
  app.buildFolderPlaylists = () => {};
  app.refreshVirtualViewport = () => {};
  app.$nextTick = (callback) => callback();

  const directorySave = app.saveAudioDirectory();
  await Promise.resolve();
  app.params.history.no_repeat_within = 12;
  app.flushConfigBeforeUnload();
  await Promise.resolve();

  assert.equal(requests.length, 2);
  assert.equal(requests[1].url, "http://127.0.0.1:29613/config");
  assert.equal(Object.hasOwn(requests[1].payload, "audio_dir"), false);
  assert.equal(requests[1].payload.history.no_repeat_within, 12);

  resolveDirectorySave({ data: { ok: false, committed: false, message: "已取消" } });
  assert.equal(await directorySave, false);
});

test("library refresh refuses to scan a folder draft that has not been loaded", async () => {
  let rescans = 0;
  const { app } = createRendererHarness({
    axios: {
      post: async () => {
        rescans += 1;
        return { data: { committed: true } };
      },
    },
  });
  app.params.audio_dir = "C:\\Music";
  app.audioDirectoryDraft = "D:\\Music";

  assert.equal(await app.refreshSongList(), false);
  assert.equal(rescans, 0);
  assert.match(app.libraryRefreshMessage, /先载入/);
});

test("overlapping library loads keep only the latest response", async () => {
  const trackResolvers = [];
  const { app } = createRendererHarness({
    axios: {
      get: async (url) => {
        if (url.endsWith("/online/catalog")) return { data: { catalog: {} } };
        return new Promise((resolve) => trackResolvers.push(resolve));
      },
    },
  });
  app.baseUrl = "http://127.0.0.1:29613";
  app.currentPath = "";
  app.queueSearchIndexRebuild = () => {};
  app.lazyFillMeta = () => {};
  app.queueUiSnapshotSave = () => {};
  app.refreshVirtualViewport = () => {};
  app.$nextTick = (callback) => callback();

  const first = app.loadTracks();
  const second = app.loadTracks();
  trackResolvers[1]({ data: { tracks: ["C:\\Music\\new.mp3"] } });
  assert.equal(await second, true);
  trackResolvers[0]({ data: { tracks: ["C:\\Music\\old.mp3"] } });
  assert.equal(await first, false);

  assert.deepEqual(app.tracks.map((track) => track.path), ["C:\\Music\\new.mp3"]);
});

test("library load keeps backend resource identity separate from display metadata", async () => {
  const trackPath = "C:\\Music\\A.mp3";
  const { app } = createRendererHarness({
    axios: {
      get: async (url) => {
        if (url.endsWith("/online/catalog")) return { data: { catalog: {} } };
        return {
          data: {
            tracks: [trackPath],
            items: [{
              path: trackPath,
              resource_id: "resource-1",
              song_key: "artist - a",
              content_fingerprint: "mert:abc",
              source: "local",
            }],
          },
        };
      },
    },
  });
  app.baseUrl = "http://127.0.0.1:29613";
  app.currentPath = trackPath;
  app.queueSearchIndexRebuild = () => {};
  app.fillMetadataTargets = async () => {};
  app.lazyFillMeta = () => {};
  app.buildFolderPlaylists = () => {};
  app.queueUiSnapshotSave = () => {};
  app.$nextTick = (callback) => callback();
  app.refreshVirtualViewport = () => {};

  assert.equal(await app.loadTracks({ preserveView: true }), true);
  assert.equal(app.tracks[0].resourceId, "resource-1");
  assert.equal(app.tracks[0].songKey, "artist - a");
  assert.equal(app.tracks[0].contentFingerprint, "mert:abc");

  const snapshot = app.buildUiSnapshotPayload();
  assert.equal(snapshot.tracks[0].resourceId, "resource-1");
  assert.equal(snapshot.tracks[0].songKey, "artist - a");
});

test("a tag key change reloads display metadata while preserving stable track relationships", async () => {
  const trackPath = "C:\\Music\\A.mp3";
  const resourceId = "resource-1";
  const oldReference = { resourceId, songKey: "artist - old", path: trackPath };
  const { app } = createRendererHarness({
    rendererState: {
      "lx-last-track": trackPath,
      "lx-last-track-ref": JSON.stringify(oldReference),
      "lx-play-history": JSON.stringify([trackPath]),
      "lx-play-history-refs": JSON.stringify([oldReference]),
      "lx-custom-playlists": JSON.stringify([{
        id: "custom-1",
        name: "收藏",
        type: "custom",
        tracks: [trackPath],
        trackRefs: [oldReference],
      }]),
    },
    axios: {
      get: async (url) => {
        if (url.endsWith("/online/catalog")) return { data: { catalog: {} } };
        return {
          data: {
            tracks: [trackPath],
            items: [{
              path: trackPath,
              resource_id: resourceId,
              song_key: "artist - corrected",
              content_fingerprint: "sha256-audio-payload-v1:mp3:12:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            }],
          },
        };
      },
    },
  });
  app.baseUrl = "http://127.0.0.1:29613";
  app.currentPath = trackPath;
  app.currentTrackRef = oldReference;
  app.tracks = [app.prepareTrackForList({
    path: trackPath,
    resourceId,
    songKey: "artist - old",
    title: "Old title",
    artist: "Artist",
    album: "Old album",
    cover: "old-cover",
    cover_thumb: "old-cover",
    _metaLoaded: true,
  }, { buildDoc: false })];
  app.trackByPath = new Map([[trackPath, app.tracks[0]]]);
  app.rebuildTrackIdentityMaps();
  app.loadCustomPlaylists();
  app.queueSearchIndexRebuild = () => {};
  app.fillMetadataTargets = async (targets) => {
    assert.equal(targets[0].path, trackPath);
    assert.equal(targets[0]._metaLoaded, false);
  };
  app.lazyFillMeta = () => {};
  app.buildFolderPlaylists = () => {};
  app.queueUiSnapshotSave = () => {};
  app.refreshVirtualViewport = () => {};
  app.$nextTick = (callback) => callback?.();

  assert.equal(await app.loadTracks({ preserveView: true }), true);

  const updated = app.trackByPath.get(trackPath);
  assert.equal(updated.resourceId, resourceId);
  assert.equal(updated.songKey, "artist - corrected");
  assert.equal(updated.title, "A");
  assert.equal(updated.artist, "");
  assert.equal(updated.album, "");
  assert.equal(updated.cover, "");
  assert.equal(app.currentPath, trackPath);
  assert.equal(app.currentTrackRef.resourceId, resourceId);
  assert.equal(app.currentTrackRef.songKey, "artist - corrected");
  assert.deepEqual(Array.from(app.playHistory), [trackPath]);
  assert.deepEqual(Array.from(app.customPlaylists[0].tracks), [trackPath]);
  assert.equal(app.customPlaylists[0].trackRefs[0].resourceId, resourceId);
  assert.equal(app.customPlaylists[0].trackRefs[0].songKey, "artist - corrected");
});

test("resource references relink last track, playlists, and recent history", async () => {
  const oldPath = "C:\\Old\\A.mp3";
  const newPath = "D:\\Music\\A.mp3";
  const resourceId = "resource-1";
  const reference = { resourceId, songKey: "artist - a", path: oldPath };
  const { app, rendererState } = createRendererHarness({
    rendererState: {
      "lx-last-track": oldPath,
      "lx-last-track-ref": JSON.stringify(reference),
      "lx-play-history": JSON.stringify([oldPath]),
      "lx-play-history-refs": JSON.stringify([reference]),
      "lx-custom-playlists": JSON.stringify([{
        id: "custom-1",
        name: "收藏",
        type: "custom",
        tracks: [oldPath],
        trackRefs: [reference],
      }]),
    },
    axios: {
      get: async (url) => {
        if (url.endsWith("/online/catalog")) return { data: { catalog: {} } };
        return {
          data: {
            tracks: [newPath],
            items: [{
              path: newPath,
              resource_id: resourceId,
              song_key: "artist - a",
              content_fingerprint: "mert:abc",
              source: "local",
            }],
          },
        };
      },
    },
  });
  app.baseUrl = "http://127.0.0.1:29613";
  app.currentPath = oldPath;
  app.currentTrackRef = reference;
  app.listeningHistory = app.normalizeListeningHistory({
    version: 1,
    tracks: {
      [oldPath]: {
        path: oldPath,
        resourceId,
        songKey: "artist - a",
        playCount: 2,
        listenedSeconds: 90,
        recommendationBehavior: {
          resourceId,
          songKey: "artist - a",
          skipOpportunityCount: 3,
        },
      },
    },
    days: { "2026-08-11": 90 },
  });
  app.loadCustomPlaylists();
  app.queueSearchIndexRebuild = () => {};
  app.fillMetadataTargets = async () => {};
  app.lazyFillMeta = () => {};
  app.queueUiSnapshotSave = () => {};
  app.$nextTick = (callback) => callback();
  app.refreshVirtualViewport = () => {};

  assert.equal(await app.loadTracks({ preserveView: true }), true);

  assert.equal(app.currentPath, newPath);
  assert.equal(app.currentTrackRef.resourceId, resourceId);
  assert.deepEqual(Array.from(app.customPlaylists[0].tracks), [newPath]);
  assert.equal(app.customPlaylists[0].trackRefs[0].resourceId, resourceId);
  assert.deepEqual(Array.from(app.playHistory), [newPath]);
  assert.equal(app.playHistoryRefs[0].resourceId, resourceId);
  assert.equal(app.listeningHistory.tracks[oldPath], undefined);
  assert.equal(app.listeningHistory.tracks[newPath].resourceId, resourceId);
  assert.equal(app.listeningHistory.tracks[newPath].recommendationBehavior.skipOpportunityCount, 3);
  assert.equal(rendererState["lx-last-track"], newPath);
  assert.equal(JSON.parse(rendererState["lx-last-track-ref"]).resourceId, resourceId);
});

test("successful playback persists the current resource reference", async () => {
  const targetPath = "C:\\Music\\B.mp3";
  const { app, rendererState } = createRendererHarness();
  const track = {
    path: targetPath,
    resourceId: "resource-b",
    songKey: "artist - b",
  };
  app.tracks = [track];
  app.trackByPath = new Map([[targetPath, track]]);
  app.rebuildTrackIdentityMaps();

  const result = await app.playByPath(targetPath, true, "manual");

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(rendererState["lx-last-track-ref"]), {
    resourceId: "resource-b",
    songKey: "artist - b",
    path: targetPath,
  });
  assert.equal(JSON.parse(rendererState["lx-play-history-refs"])[0].resourceId, "resource-b");
});

test("metadata filling uses a bounded parallel batch and ignores stale results", async () => {
  const metadataResolvers = [];
  const { app } = createRendererHarness({
    getSongInfo: (trackPath, options) => new Promise((resolve) => {
      metadataResolvers.push({ trackPath, options, resolve });
    }),
  });
  app._trackLoadGeneration = 4;
  app.tracks = ["A", "B", "C", "D", "E", "F", "G", "H"].map((name) => ({
    path: `C:\\Music\\${name}.mp3`,
    title: name,
    _metaLoaded: false,
  }));
  app.trackByPath = new Map(app.tracks.map((track) => [track.path, track]));
  app.queueSearchIndexRebuild = () => {};

  const filling = app.lazyFillMeta(0, 8, 4);
  assert.equal(metadataResolvers.length, 4);
  assert.ok(metadataResolvers.every(({ options }) => options?.resourceId === ""));
  app._trackLoadGeneration = 5;
  metadataResolvers.forEach(({ resolve }) => resolve({
    title: "stale",
    artist: "stale",
    album: "stale",
    duration: 1,
  }));
  await filling;

  assert.deepEqual(app.tracks.map((track) => track.title), ["A", "B", "C", "D", "E", "F", "G", "H"]);
  assert.deepEqual(app.tracks.map((track) => track._metaLoaded), [false, false, false, false, false, false, false, false]);
});

test("metadata from an obsolete page plan cannot update the new visible state", async () => {
  let resolveMetadata;
  const { app } = createRendererHarness({
    getSongInfo: () => new Promise((resolve) => {
      resolveMetadata = resolve;
    }),
  });
  const track = { path: "C:\\Music\\A.mp3", title: "A", _metaLoaded: false };
  app.tracks = [track];
  app.trackByPath = new Map([[track.path, track]]);
  app._trackLoadGeneration = 4;
  app._metadataPlanGeneration = 8;

  const filling = app.fillMetadataTargets([track], 4, 8);
  app._metadataPlanGeneration = 9;
  resolveMetadata({ title: "stale", artist: "stale", album: "stale", duration: 1 });
  await filling;

  assert.equal(track.title, "A");
  assert.equal(track._metaLoaded, false);
});

test("current-track metadata explicitly requests the structured lyric model", async () => {
  let receivedOptions = null;
  const { app } = createRendererHarness({
    getSongInfo: async (_trackPath, options) => {
      receivedOptions = options;
      return { title: "A", artist: "Artist", album: "Album", lyrics: "", duration: 180 };
    },
  });
  app.trackByPath = new Map([["C:\\Music\\A.mp3", { resourceId: "resource-a" }]]);

  await app.loadTrackPresentation("C:\\Music\\A.mp3");

  assert.equal(receivedOptions?.includeLyricsModel, true);
  assert.equal(receivedOptions?.resourceId, "resource-a");
  assert.deepEqual(Array.from(Object.keys(receivedOptions || {})), ["includeLyricsModel", "resourceId"]);
});

test("startup metadata plan prioritizes the current track and its viewport neighborhood", () => {
  const { app } = createRendererHarness();
  app.tracks = Array.from({ length: 100 }, (_, index) => ({
    path: `C:\\Music\\${String(index).padStart(3, "0")}.mp3`,
    title: String(index),
    _metaLoaded: false,
  }));
  app.trackByPath = new Map(app.tracks.map((track) => [track.path, track]));
  app.currentPath = app.tracks[50].path;
  app.libraryRowHeight = 64;
  app.libraryViewportHeight = 256;
  app.libraryScrollTop = 0;
  app.virtualOverscan = 2;
  app.getCurrentPlaylistTracks = () => app.tracks;
  app.searchTrackList = (tracks) => tracks;

  const plan = app.buildMetadataFillPlan();
  const priorityPaths = Array.from(plan.priority, (track) => track.path);

  assert.deepEqual(
    priorityPaths.slice(0, 7),
    [50, 49, 51, 48, 52, 47, 53].map((index) => app.tracks[index].path),
  );
  for (let index = 44; index <= 56; index += 1) {
    assert.equal(priorityPaths.includes(app.tracks[index].path), true);
  }
  assert.equal(plan.background[0].path, app.tracks[20].path);
});

test("startup locate centers the current track and yields to user interaction", () => {
  const { app } = createRendererHarness();
  const tracks = Array.from({ length: 100 }, (_, index) => ({
    path: `C:\\Music\\${String(index).padStart(3, "0")}.mp3`,
    title: String(index),
  }));
  const body = { clientHeight: 320, scrollTop: 0 };
  app.tracks = tracks;
  app.filteredTracks = tracks;
  app.playlists = [{ id: "all", name: "全部歌曲", type: "system", tracks: tracks.map((track) => track.path) }];
  app.currentPlaylist = "all";
  app.currentPath = tracks[50].path;
  app.keyword = "";
  app.libraryRowHeight = 64;
  app.libraryViewportHeight = 320;
  app.playlistScrollTopMap = {};
  app.$refs = { libraryTableBody: body };
  app.$nextTick = (callback) => callback();
  app.refreshVirtualViewport = () => {
    app.libraryViewportHeight = body.clientHeight;
  };
  app._trackLoadGeneration = 7;
  app._libraryInteractionRevision = 0;

  assert.equal(app.locateTrack(tracks[50].path, {
    center: true,
    flash: false,
    startup: true,
    loadGeneration: 7,
    interactionRevision: 0,
  }), true);
  assert.equal(body.scrollTop, 3072);
  assert.equal(app.libraryScrollTop, 3072);

  body.scrollTop = 180;
  app.libraryScrollTop = 180;
  app.markLibraryUserInteraction();
  assert.equal(app.locateTrack(tracks[60].path, {
    center: true,
    flash: false,
    startup: true,
    loadGeneration: 7,
    interactionRevision: 0,
  }), false);
  assert.equal(body.scrollTop, 180);
});

test("startup locate clamps a 3000-row library to valid first and last scroll bounds", () => {
  const { app } = createRendererHarness();
  const tracks = Array.from({ length: 3000 }, (_, index) => ({
    path: `C:\\Music\\${String(index).padStart(4, "0")}.mp3`,
    title: String(index),
  }));
  const body = { clientHeight: 320, scrollTop: 900 };
  app.tracks = tracks;
  app.filteredTracks = tracks;
  app.playlists = [{ id: "all", name: "全部歌曲", type: "system", tracks: tracks.map((track) => track.path) }];
  app.currentPlaylist = "all";
  app.keyword = "";
  app.libraryRowHeight = 64;
  app.libraryViewportHeight = 320;
  app.playlistScrollTopMap = {};
  app.$refs = { libraryTableBody: body };
  app.$nextTick = (callback) => callback();
  app.refreshVirtualViewport = () => {
    app.libraryViewportHeight = body.clientHeight;
  };
  app._trackLoadGeneration = 4;
  app._libraryInteractionRevision = 2;

  assert.equal(app.locateTrack(tracks[0].path, {
    center: true,
    flash: false,
    startup: true,
    loadGeneration: 4,
    interactionRevision: 2,
  }), true);
  assert.equal(body.scrollTop, 0);

  assert.equal(app.locateTrack(tracks[2999].path, {
    center: true,
    flash: false,
    startup: true,
    loadGeneration: 4,
    interactionRevision: 2,
  }), true);
  assert.equal(body.scrollTop, 191680);

  body.scrollTop = 720;
  app.libraryScrollTop = 720;
  assert.equal(app.locateTrack(tracks[1500].path, {
    center: true,
    flash: false,
    startup: true,
    loadGeneration: 3,
    interactionRevision: 2,
  }), false);
  assert.equal(body.scrollTop, 720);
});

test("locating keeps a containing playlist and clears only a preexisting search that hides the target", () => {
  const { app } = createRendererHarness();
  const tracks = Array.from({ length: 12 }, (_, index) => ({
    path: `C:\\Music\\${String(index).padStart(2, "0")}.mp3`,
    title: `Track ${index}`,
  }));
  const allPaths = tracks.map((track) => track.path);
  const customPaths = [tracks[3].path, tracks[7].path];
  const body = { clientHeight: 256, scrollTop: 0 };
  app.tracks = tracks;
  app.trackByPath = new Map(tracks.map((track) => [track.path, track]));
  app.playlists = [
    { id: "all", name: "全部歌曲", type: "system", tracks: allPaths },
    { id: "custom", name: "收藏", type: "custom", tracks: customPaths },
  ];
  app.currentPlaylist = "custom";
  app.keyword = "";
  app.keywordDraft = "";
  app.libraryRowHeight = 64;
  app.libraryViewportHeight = 256;
  app.playlistScrollTopMap = {};
  app.$refs = { libraryTableBody: body };
  app.$nextTick = (callback) => callback();
  app.refreshVirtualViewport = () => {};
  Object.defineProperty(app, "filteredTracks", {
    configurable: true,
    get() {
      const playlist = app.playlists.find((item) => item.id === app.currentPlaylist);
      const visible = (playlist?.tracks || allPaths).map((trackPath) => app.trackByPath.get(trackPath));
      return app.keyword ? visible.filter((track) => track.title.includes(app.keyword)) : visible;
    },
  });

  assert.equal(app.locateTrack(tracks[7].path, { center: true, flash: false }), true);
  assert.equal(app.currentPlaylist, "custom");

  assert.equal(app.locateTrack(tracks[9].path, { center: true, flash: false }), true);
  assert.equal(app.currentPlaylist, "all");

  app.keywordDraft = "Track 1";
  app.keyword = "Track 1";
  assert.equal(app.locateTrack(tracks[5].path, { center: true, flash: false }), true);
  assert.equal(app.keywordDraft, "");
  assert.equal(app.keyword, "");
  assert.equal(app.selectedPath, tracks[5].path);
});

test("page, playlist, and library search actions invalidate pending startup positioning", () => {
  const { app } = createRendererHarness();
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  app.view = "library";
  app.currentPlaylist = "all";
  app.playlists = [
    { id: "all", name: "全部歌曲", type: "system", tracks: [] },
    { id: "custom", name: "收藏", type: "custom", tracks: [] },
  ];
  app.$refs = {};
  app.$nextTick = (callback) => callback();
  app._libraryInteractionRevision = 0;
  app._metadataPlanGeneration = 0;

  app.setView("settings");
  assert.equal(app._libraryInteractionRevision, 1);
  assert.equal(app._metadataPlanGeneration, 1);
  app.selectPlaylist("custom");
  assert.equal(app._libraryInteractionRevision, 2);
  assert.equal(app._metadataPlanGeneration, 2);
  app.onLibraryScroll({ target: { scrollTop: 640 } });
  assert.equal(app.libraryScrollTop, 640);
  assert.equal(app._libraryInteractionRevision, 2);
  assert.equal(app._metadataPlanGeneration, 3);
  assert.match(html, /<library-search-input[^>]+@commit="commitLibrarySearch"[^>]+@activity="onLibrarySearchActivity"/);
});

test("a late startup library response preserves the user's page, selection, and scroll", async () => {
  const tracks = Array.from({ length: 30 }, (_, index) => ({
    path: `C:\\Music\\${String(index).padStart(2, "0")}.mp3`,
    title: `Track ${index}`,
  }));
  let resolveTracks;
  const { app } = createRendererHarness({
    rendererState: { "lx-last-track": tracks[12].path },
    axios: {
      get: async (url) => {
        if (url.endsWith("/online/catalog")) return { data: { catalog: {} } };
        return new Promise((resolve) => {
          resolveTracks = resolve;
        });
      },
    },
  });
  const body = { clientHeight: 320, scrollTop: 768 };
  app.baseUrl = "http://127.0.0.1:29613";
  app.tracks = tracks;
  app.trackByPath = new Map(tracks.map((track) => [track.path, track]));
  app.currentPath = tracks[12].path;
  app.selectedPath = tracks[4].path;
  app.libraryScrollTop = 768;
  app.libraryViewportHeight = 320;
  app.$refs = { libraryTableBody: body };
  app.$nextTick = (callback) => callback();
  app.queueSearchIndexRebuild = () => {};
  app.fillMetadataTargets = async () => {};
  app.lazyFillMeta = () => {};
  app.refreshVirtualViewport = () => {};
  app._libraryInteractionRevision = 0;

  const pending = app.loadTracks({
    startup: true,
    interactionRevision: 0,
    playbackGeneration: app.playbackGeneration,
  });
  app.setView("settings");
  app.selectedPath = tracks[4].path;
  resolveTracks({ data: { tracks: tracks.map((track) => track.path) } });

  assert.equal(await pending, true);
  assert.equal(app.view, "settings");
  assert.equal(app.selectedPath, tracks[4].path);
  assert.equal(app.libraryScrollTop, 768);
  assert.equal(body.scrollTop, 768);
});

test("startup restore does not replace a newer playback generation", async () => {
  const { app, fakeAudio } = createRendererHarness({
    rendererState: { "lx-last-track": "C:\\Music\\A.mp3" },
  });
  const newerPath = "C:\\Music\\B.mp3";
  app.tracks = [
    { path: "C:\\Music\\A.mp3", title: "A" },
    { path: newerPath, title: "B" },
  ];
  app.trackByPath = new Map(app.tracks.map((track) => [track.path, track]));
  app.currentPath = newerPath;
  app.playbackGeneration = 3;
  fakeAudio.src = "file:///C:/Music/B.mp3";

  assert.equal(await app.restoreLastTrack({ expectedPlaybackGeneration: 2 }), false);
  assert.equal(app.currentPath, newerPath);
  assert.equal(fakeAudio.src, "file:///C:/Music/B.mp3");
});

test("overlapping online searches keep the latest query and loading state", async () => {
  const pending = [];
  const { app } = createRendererHarness({
    lxEnv: {
      onlineSearch: (payload) => new Promise((resolve) => {
        pending.push({ payload, resolve });
      }),
    },
  });
  app.onlineSearchType = "music";
  app.onlineKeyword = "old";
  const first = app.searchOnline(1);
  app.onlineKeyword = "new";
  const second = app.searchOnline(1);

  pending[0].resolve({ list: [{ token: "online://old", title: "Old" }] });
  await first;
  assert.equal(app.onlineLoading, true);
  assert.deepEqual(Array.from(app.onlineTracks), []);

  pending[1].resolve({ list: [{ token: "online://new", title: "New" }] });
  await second;
  assert.equal(app.onlineLoading, false);
  assert.deepEqual(app.onlineTracks.map((track) => track.token), ["online://new"]);
  assert.equal(app.onlineTrackMap["online://old"], undefined);
  assert.equal(app.onlineMessage, "");
});

test("online search failures are distinct from an empty result", async () => {
  const { app } = createRendererHarness({
    lxEnv: {
      onlineSearch: async () => {
        throw new Error("upstream failed");
      },
    },
  });
  app.onlineSearchType = "music";
  app.onlineKeyword = "query";

  await app.searchOnline(1);

  assert.equal(app.onlineLoading, false);
  assert.equal(app.onlineMessage, "搜索失败，请检查音源后重试。");
  assert.deepEqual(Array.from(app.onlineTracks), []);
});

test("leaving an online songlist discards its late detail response", async () => {
  let resolveTracks;
  const { app } = createRendererHarness({
    lxEnv: {
      onlineSonglistTracks: () => new Promise((resolve) => {
        resolveTracks = resolve;
      }),
    },
  });
  app.onlineSonglistsSnapshot = [{ source: "wy", id: "list-1", name: "列表" }];
  const loading = app.loadOnlineSonglistTracks(app.onlineSonglistsSnapshot[0]);
  app.backToSonglistResults();
  resolveTracks({ list: [{ token: "online://late", title: "Late" }] });
  await loading;

  assert.equal(app.onlineLoading, false);
  assert.equal(app.onlineSonglistExpanded, false);
  assert.equal(app.currentOnlineSonglist, null);
  assert.deepEqual(Array.from(app.onlineTracks), []);
});

test("online-to-local matching builds a reusable lookup instead of scanning for each request", () => {
  const { app } = createRendererHarness();
  const localTracks = [
    { path: "C:\\Music\\A.mp3", title: "A", artist: "Artist" },
    { path: "C:\\Music\\B.mp3", title: "B", artist: "Artist" },
    { path: "C:\\Music\\C.mp3", title: "C", artist: "Artist" },
  ];
  let findCalls = 0;
  const nativeFind = localTracks.find.bind(localTracks);
  localTracks.find = (...args) => {
    findCalls += 1;
    return nativeFind(...args);
  };
  app.tracks = localTracks;
  app.trackByPath = new Map(localTracks.map((track) => [track.path, track]));
  app.onlineTrackMap = {
    "online://wy/b": { token: "online://wy/b", title: "B", artist: "Artist" },
  };

  assert.equal(app.resolveOnlineRecommendAnchorPath("online://wy/b"), "C:\\Music\\B.mp3");
  assert.equal(app.resolveOnlineRecommendAnchorPath("online://wy/b"), "C:\\Music\\B.mp3");
  assert.equal(findCalls, 0);
});

test("online-to-local matching prefers an exact artist over an earlier artistless title", () => {
  const { app } = createRendererHarness();
  const localTracks = [
    { path: "C:\\Music\\B.mp3", title: "B", artist: "" },
    { path: "C:\\Music\\Artist - B.mp3", title: "B", artist: "Artist" },
  ];
  app.tracks = localTracks;
  app.trackByPath = new Map(localTracks.map((track) => [track.path, track]));
  app._localMetadataRevision = 1;
  app.onlineTrackMap = {
    "online://wy/b": { token: "online://wy/b", title: "B", artist: "Artist" },
  };

  assert.equal(app.resolveOnlineRecommendAnchorPath("online://wy/b"), "C:\\Music\\Artist - B.mp3");
});

test("listening attempt survives pause and counts real media progress only once", () => {
  const { app, fakeAudio } = createRendererHarness();
  app.listeningHistory = app.getEmptyListeningHistory();
  app.currentPath = "C:\\Music\\A.mp3";
  app.currentMeta = { title: "A", artist: "Artist", album: "Album" };
  app.duration = 100;
  fakeAudio.duration = 100;
  fakeAudio.currentTime = 0;
  fakeAudio.paused = false;
  app.isPlaying = true;
  app.beginListeningSession(app.currentPath);
  const attemptId = app.listeningSession.attemptId;

  const advanceFiveSeconds = () => {
    app.listeningSession.lastClockAt = app.getListeningClockMs() - 5000;
    app.listeningSession.lastAudioTime = fakeAudio.currentTime;
    fakeAudio.currentTime += 5;
    app.currentTime = fakeAudio.currentTime;
    app.updateListeningSessionProgress();
  };

  for (let i = 0; i < 6; i += 1) advanceFiveSeconds();
  fakeAudio.paused = true;
  app.isPlaying = false;
  app.checkpointListeningSession("pause");
  assert.equal(app.listeningSession.attemptId, attemptId);
  assert.equal(app.listeningSession.state, "paused");

  app.listeningSession.lastClockAt = app.getListeningClockMs() - 5000;
  const beforeStall = app.listeningSession.listenedSeconds;
  app.updateListeningSessionProgress({ force: true });
  assert.equal(app.listeningSession.listenedSeconds, beforeStall);

  fakeAudio.paused = false;
  app.isPlaying = true;
  assert.equal(app.resumeListeningSession(app.currentPath), true);
  for (let i = 0; i < 4; i += 1) advanceFiveSeconds();
  assert.equal(app.listeningSession.attemptId, attemptId);
  assert.equal(app.listeningHistory.tracks[app.currentPath].playCount, 1);

  for (let i = 0; i < 2; i += 1) advanceFiveSeconds();
  assert.equal(app.listeningHistory.tracks[app.currentPath].playCount, 1);
  assert.ok(app.listeningHistory.tracks[app.currentPath].listenedSeconds >= 59.9);
});

test("clearing listening stats preserves learning and keeps current audio playing", async () => {
  const persisted = [];
  const { app, fakeAudio } = createRendererHarness({
    lxEnv: {
      setListeningHistory: async (history) => {
        persisted.push(structuredClone(history));
        return { ok: true };
      },
      clearListeningStats: async () => ({
        ok: true,
        history: ListeningHistoryOps.clearListeningStats(persisted.at(-1) || {}, 200),
      }),
    },
  });
  app.listeningHistory = app.getEmptyListeningHistory();
  app.listeningHistoryLoaded = true;
  app.listeningHistory.tracks[app.currentPath] = {
    path: app.currentPath,
    title: "A",
    artist: "Artist",
    album: "Album",
    duration: 180,
    playCount: 2,
    listenedSeconds: 90,
    lastPlayedAt: 100,
    lastCountedAt: 100,
    recommendationBehavior: {
      ...app.getEmptyRecommendationBehavior(app.currentPath),
      skipOpportunityCount: 5,
      dislikeChainSkipCount: 2,
      skipFix: 0.75,
    },
  };
  app.beginListeningSession(app.currentPath);
  app.requestConfirmation = async () => true;
  const originalSource = fakeAudio.currentSrc;
  const originalTime = fakeAudio.currentTime;

  await app.clearListeningStats();

  assert.equal(fakeAudio.currentSrc, originalSource);
  assert.equal(fakeAudio.currentTime, originalTime);
  assert.equal(fakeAudio.paused, false);
  assert.equal(app.listeningHistory.totalSeconds, 0);
  assert.equal(app.listeningHistory.totalPlays, 0);
  assert.equal(app.listeningHistory.tracks[app.currentPath].recommendationBehavior.skipOpportunityCount, 6);
  assert.equal(app.listeningSession.path, app.currentPath);
  assert.equal(app.listeningSession.state, "playing");
});

test("resetting recommendation behavior keeps listening stats and active attempt", async () => {
  let returnedHistory = null;
  const { app } = createRendererHarness({
    lxEnv: {
      setListeningHistory: async () => ({ ok: true }),
      resetRecommendationBehavior: async () => ({ ok: true, history: returnedHistory }),
    },
  });
  app.listeningHistory = app.getEmptyListeningHistory();
  app.listeningHistoryLoaded = true;
  app.listeningHistory.totalSeconds = 90;
  app.listeningHistory.totalPlays = 1;
  app.listeningHistory.days = { "2026-07-30": 90 };
  app.listeningHistory.tracks[app.currentPath] = {
    path: app.currentPath,
    title: "A",
    artist: "Artist",
    album: "Album",
    duration: 180,
    playCount: 1,
    listenedSeconds: 90,
    lastPlayedAt: 100,
    lastCountedAt: 100,
    recommendationBehavior: {
      ...app.getEmptyRecommendationBehavior(app.currentPath),
      skipOpportunityCount: 5,
      dislikeChainSkipCount: 2,
      skipFix: 0.75,
    },
  };
  app.beginListeningSession(app.currentPath);
  app.requestConfirmation = async () => true;
  const attemptId = app.listeningSession.attemptId;
  app.consecutiveDislikeCount = 3;
  returnedHistory = ListeningHistoryOps.resetRecommendationBehavior(app.listeningHistory, 300);

  await app.resetRecommendationBehavior();

  assert.equal(app.listeningHistory.totalSeconds, 90);
  assert.equal(app.listeningHistory.totalPlays, 1);
  assert.equal(app.listeningHistory.tracks[app.currentPath].listenedSeconds, 90);
  assert.equal(app.listeningHistory.tracks[app.currentPath].recommendationBehavior.skipOpportunityCount, 0);
  assert.equal(app.listeningHistory.tracks[app.currentPath].recommendationBehavior.skipFix, 1);
  assert.equal(app.listeningSession.attemptId, attemptId);
  assert.equal(app.consecutiveDislikeCount, 0);
  await app.handleRecommendationBehaviorBeforeSwitch("dislike_next");
  assert.equal(app.listeningHistory.tracks[app.currentPath].recommendationBehavior.skipOpportunityCount, 1);
  assert.equal(app.listeningHistory.tracks[app.currentPath].recommendationBehavior.dislikeChainSkipCount, 1);
});

test("first dislike records feedback when ignored count is zero", () => {
  const { app } = createRendererHarness();
  app.listeningHistory = app.getEmptyListeningHistory();
  app.params.dislike_correction.consecutive_dislike_threshold = 0;
  app.consecutiveDislikeCount = 0;
  app.beginListeningSession(app.currentPath);

  app.handleRecommendationBehaviorBeforeSwitch("dislike_next");

  const behavior = app.listeningHistory.tracks[app.currentPath].recommendationBehavior;
  assert.equal(behavior.dislikeChainSkipCount, 1);
  assert.equal(behavior.skipOpportunityCount, 1);
  assert.equal(app.consecutiveDislikeCount, 1);
  app.handleRecommendationBehaviorAfterCommit("dislike_fallback");
  assert.equal(app.consecutiveDislikeCount, 1);
});

test("recommendation feedback deduplicates attempts and refreshes the opportunity denominator", async () => {
  const { app } = createRendererHarness();
  app.listeningHistory = app.getEmptyListeningHistory();
  app.beginListeningSession(app.currentPath);
  app.recordRecommendationOpportunity(app.currentPath, "like_next");
  app.recordRecommendationOpportunity(app.currentPath, "like_next");
  assert.equal(app.listeningHistory.recommendationBehaviorSummary.totalSkipOpportunityCount, 1);
  await app.handleRecommendationBehaviorBeforeSwitch("dislike_next");
  await app.handleRecommendationBehaviorBeforeSwitch("dislike_next");
  let b = app.listeningHistory.tracks[app.currentPath].recommendationBehavior;
  assert.equal(b.skipOpportunityCount, 1);
  assert.equal(b.dislikeChainSkipCount, 1);
  assert.equal(app.consecutiveDislikeCount, 1);
  // A failed next track restoring this same attempt must preserve its feedback flags.
  app.listeningSession = { ...app.listeningSession };
  await app.handleRecommendationBehaviorBeforeSwitch("dislike_next");
  assert.equal(app.listeningHistory.tracks[app.currentPath].recommendationBehavior.dislikeChainSkipCount, 1);
  app.beginListeningSession(app.currentPath); // A genuine replay is a new opportunity.
  await app.handleRecommendationBehaviorBeforeSwitch("dislike_next");
  b = app.listeningHistory.tracks[app.currentPath].recommendationBehavior;
  assert.equal(b.skipOpportunityCount, 2);
  assert.equal(b.dislikeChainSkipCount, 2);
  assert.equal(app.listeningHistory.recommendationBehaviorSummary.totalSkipOpportunityCount, 2);
});

test("recommendation feedback applies elapsed calendar decay before a new exposure", () => {
  const { app } = createRendererHarness();
  app.listeningHistory = app.getEmptyListeningHistory();
  app.params.dislike_correction.daily_decay = 0.5;
  const today = app.formatLocalDateKey();
  const old = new Date(today + "T00:00:00Z"); old.setUTCDate(old.getUTCDate() - 3);
  app.listeningHistory.recommendationBehaviorSummary.updatedDay = old.toISOString().slice(0,10);
  app.ensureListeningTrack(app.currentPath).recommendationBehavior.skipOpportunityCount = 8;
  app.beginListeningSession(app.currentPath);
  app.recordRecommendationOpportunity(app.currentPath, "like_next");
  assert.equal(app.listeningHistory.tracks[app.currentPath].recommendationBehavior.skipOpportunityCount, 2);
  assert.equal(app.listeningHistory.recommendationBehaviorSummary.totalSkipOpportunityCount, 2);
});

test("recommendation feedback waits once and the latest dislike action wins", async t => {
  const { app: initial, capturedConfig } = createRendererHarness();
  const vueContext = { console };
  nodeVm.runInNewContext(fs.readFileSync(path.join(__dirname, "../renderer/vendor/vue.global.prod.js"), "utf8"), vueContext);
  const renderer = vueContext.Vue.createRenderer({createComment:()=>({}),insert(){},remove(){},parentNode:()=>null,nextSibling:()=>null});
  const view = renderer.createApp({data:capturedConfig.data,methods:capturedConfig.methods,render:()=>null});
  const app = view.mount({});
  t.after(()=>view.unmount());
  app.currentPath = initial.currentPath;
  app.listeningHistory = app.getEmptyListeningHistory();
  app.beginListeningSession(app.currentPath);
  let release;
  app.saveListeningHistoryNow = () => new Promise(resolve => { release = resolve; });
  const calls = [];
  app.playFromPlaylistNext = async source => { calls.push(source); return {ok:true}; };
  const first = app.playDislike(), second = app.playDislike();
  assert.equal(calls.length, 0);
  release({ok:true});
  assert.equal((await first).canceled, true);
  assert.equal((await second).ok, true);
  assert.deepEqual(calls, ["dislike_fallback"]);
  assert.equal(app.listeningHistory.tracks[app.currentPath].recommendationBehavior.dislikeChainSkipCount, 1);
});

test("rolling continuity excludes rejected tracks and invalidates the policy cache", () => {
  const { app } = createRendererHarness();
  app.rememberContinuityTrack("C:/Music/old.mp3");
  app.rememberContinuityTrack("C:/Music/rejected.mp3", true);
  app.rememberContinuityTrack(app.currentPath);
  assert.deepEqual(Array.from(app.getContinuityRecentPaths()), ["C:/Music/old.mp3"]);
  app.recCacheFor = app.currentPath;
  app.recCacheStamp = app.getRecommendationPolicyStamp();
  assert.equal(app.hasFreshRecCache(), true);
  app.params.similarity.like_min -= 0.001;
  assert.equal(app.hasFreshRecCache(), false);
  app.resetConsecutiveDislike("long-pause");
  assert.equal(app.getContinuityRecentPaths().length, 0);
});

test("rolling continuity rewards the actual harmonic draw without changing its candidate pool", async () => {
  const { app } = createRendererHarness({ Math: Object.assign(Object.create(Math), { random:()=>0.7 }) });
  app.useRecommend = true;
  app.hasFreshRecCache = () => true;
  app.recCache = {like_list:[{path:"B",continuity_reward:1.25},{path:"C",continuity_reward:1}]};
  app.playByPath = async path => ({ok:true,path});
  assert.equal((await app.playLike()).path,"B"); // 0.7 is inside rewarded P(B), outside unmodified P(B).
  app.recCache.like_list[0].continuity_reward = 1;
  assert.equal((await app.playLike()).path,"C");
});

test("seed sequence preserves its path and starts a clicked track in its own queue", async () => {
  const { app } = createRendererHarness();
  app.seedRecs = [{path:"a",sim:0.8,sequence_version:1,sequence_order:0},
    {path:"b",sim:0.1,sequence_version:1,sequence_order:1},
    {path:"c",sim:0.9,sequence_version:1,sequence_order:2}];
  assert.deepEqual(Array.from(app.sortSeedRecs([...app.seedRecs].reverse()), r=>r.path), ["a","b","c"]);
  app.currentSeedId = "one"; app.seeds = [{id:"one", name:"One"}];
  app.playMode = "shuffle";
  app.playByPath = async path => ({ok:true,path});
  assert.equal((await app.playSeedTrack("b")).path, "b");
  assert.equal(app.playMode, "loop");
  assert.equal(app.useRecommend, false);
  assert.equal(app.currentPlaylist, "seed-rec-one");
  assert.deepEqual(Array.from(app.playlists.find(p=>p.id===app.currentPlaylist).tracks), ["a","b","c"]);
});

test("audio detail uses real Vue generations to reject closed or late metadata", async t => {
  let release;
  const {capturedConfig}=createRendererHarness({getSongInfo:async path=>path==="old.mp3"
    ? new Promise(resolve=>{release=resolve;}) : {title:"New",artist:"Singer",audioInfo:{sampleRate:48000}}});
  const vueContext={console};nodeVm.runInNewContext(fs.readFileSync(path.join(__dirname,"../renderer/vendor/vue.global.prod.js"),"utf8"),vueContext);
  const renderer=vueContext.Vue.createRenderer({createComment:()=>({}),insert(){},remove(){},parentNode:()=>null,nextSibling:()=>null});
  const view=renderer.createApp({data:capturedConfig.data,methods:capturedConfig.methods,render:()=>null});
  const app=view.mount({});t.after(()=>view.unmount());
  const old=app.openAudioDetail("old.mp3");
  await app.openAudioDetail("new.mp3");
  release({title:"Old",audioInfo:{sampleRate:22050}});await old;
  assert.equal(app.audioDetail.info.title,"New");
  assert.ok(app.audioDetailFields().some(row=>row[1]==="48,000 Hz"));
  app.closeAudioDetail();assert.equal(app.audioDetail.visible,false);
});

test("audio detail artist and album lists use exact credits and separate same-name albums", async () => {
  const {app}=createRendererHarness();app.$nextTick=async callback=>callback?.();
  app.tracks=[
    {path:"a",title:"A",artist:"鹿乃",artists:["鹿乃"],album:"Same",albumArtist:"鹿乃",trackNumber:2,_metaLoaded:true},
    {path:"b",title:"B",artist:"鹿乃 / Other",artists:["鹿乃","Other"],album:"Same",albumArtist:"鹿乃",trackNumber:1,_metaLoaded:true},
    {path:"c",title:"C",artist:"鹿乃2",artists:["鹿乃2"],album:"Same",albumArtist:"鹿乃2",_metaLoaded:true},
  ];app.trackByPath=new Map(app.tracks.map(t=>[t.path,t]));
  app.audioDetail={visible:true,mode:"info",path:"a",info:app.tracks[0],rows:[],page:1};
  await app.openAudioDetailCollection("artist","鹿乃");
  assert.deepEqual(Array.from(app.audioDetail.rows,r=>r.path),["a","b"]);
  await app.openAudioDetailCollection("album","Same");
  assert.deepEqual(Array.from(app.audioDetail.rows,r=>r.path),["b","a"]);
});

test("audio detail similar browse is read-only ranked, paginated and not history filtered", async () => {
  let request;
  const {app}=createRendererHarness({axios:{post:async(_url,payload)=>{request=payload;return{data:{all_ranked:Array.from({length:130},(_,i)=>({path:"song"+i,sim:1-i/1000}))}};}}});
  app.$nextTick=async callback=>callback?.();
  app.audioDetail={visible:true,mode:"info",path:"anchor",info:{title:"Anchor"},rows:[],page:1};
  await app.openAudioDetailCollection("similar");
  assert.equal(request.ranking_only,true);assert.equal(request.history.length,0);
  assert.equal(app.audioDetail.rows.length,130);assert.equal(app.audioDetailPageRows().length,60);
  app.changeAudioDetailPage(2);assert.equal(app.audioDetailPageRows().length,10);
  assert.equal(app.listeningSession,null);
});

test("audio detail top ten moves existing songs next without duplicates or changing source playlists", () => {
  const {app,fakeAudio,rendererState}=createRendererHarness();
  app.currentPath="a";app.filteredTracks=[{path:"a"},{path:"b"},{path:"c"},{path:"d"}];
  app.playlists=[{id:"folder",type:"folder",name:"Folder",tracks:["a","b","c","d"]}];app.currentPlaylist="folder";
  app.audioDetail={mode:"similar",loading:false,rows:[{path:"b"},{path:"e"},{path:"c"}]};
  app.showNotice=()=>{};app.useRecommend=true;
  const before=fakeAudio.currentTime;
  app.appendSimilarTopTen();
  assert.deepEqual(Array.from(app.sessionQueue.tracks),["a","b","e","c","d"]);
  assert.deepEqual(Array.from(app.playlists.find(p=>p.id==="folder").tracks),["a","b","c","d"]);
  assert.equal(app.useRecommend,false);assert.equal(fakeAudio.currentTime,before);
  assert.equal(JSON.parse(rendererState["lx-session-queue"]).tracks.length,5);
});

test("audio detail double click switches to the entire similarity queue and follows it", async () => {
  const {app}=createRendererHarness();app.$nextTick=async callback=>callback?.();
  app.audioDetail={mode:"similar",loading:false,label:"相似歌曲",path:"anchor",info:{title:"Anchor"},rows:[{path:"a"},{path:"b"},{path:"c"}]};
  app.useRecommend=true;app.playMode="shuffle";
  app.playByPath=async path=>{app.currentPath=path;return{ok:true,path};};
  await app.playAudioDetailCollection("b");
  assert.equal(app.currentPlaylist,"session-current");assert.equal(app.useRecommend,false);assert.equal(app.playMode,"loop");
  assert.deepEqual(Array.from(app.getPlaybackQueueTracks(),t=>t.path),["a","b","c"]);
  assert.equal((await app.nextTrack()).path,"c");
  app.buildFolderPlaylists();assert.equal(app.playlists.find(p=>p.id==="session-current").tracks.length,3);
});

test("audio detail cancels tag hydration after its active bounded batch", async () => {
  const pending=[];
  const {app}=createRendererHarness({getSongInfo:path=>new Promise(resolve=>pending.push(()=>resolve({title:"Changed",artist:"Singer",artists:["Singer"],album:"Album"})))});
  app.$nextTick=async callback=>callback?.();
  app.tracks=Array.from({length:20},(_,i)=>({path:"song"+i,title:"Original"}));
  app.trackByPath=new Map(app.tracks.map(t=>[t.path,t]));
  app.audioDetail={visible:true,path:"song0",info:{artist:"Singer"},rows:[]};
  const loading=app.openAudioDetailCollection("artist","Singer");
  assert.equal(pending.length,4);
  app.closeAudioDetail();pending.forEach(release=>release());await loading;
  assert.equal(pending.length,4);assert.equal(app.audioDetail.visible,false);
  assert.equal(app.tracks[0].title,"Original");assert.equal(app.audioDetail.rows.length,0);
});

test("audio detail restores its saved queue through stable resource identity", () => {
  const saved={id:"session-current",type:"session",name:"Saved queue",tracks:["old.mp3"],trackRefs:[{resourceId:"stable-id",path:"old.mp3"}]};
  const {app,rendererState}=createRendererHarness({rendererState:{"lx-session-queue":JSON.stringify(saved)}});
  app.tracks=[{path:"new.mp3",title:"Same",resourceId:"stable-id",songKey:"same"}];
  app.trackByPath=new Map(app.tracks.map(t=>[t.path,t]));app.rebuildTrackIdentityMaps();
  app.buildFolderPlaylists();
  assert.deepEqual(Array.from(app.sessionQueue.tracks),["new.mp3"]);
  assert.equal(JSON.parse(rendererState["lx-session-queue"]).trackRefs[0].resourceId,"stable-id");
});

test("recommendation diagnostics keep actual probabilities, bounded records and no failed exposure", async () => {
  const { app } = createRendererHarness();
  app.listeningHistory = app.getEmptyListeningHistory();
  app.recCache = {like_list:[{path:"C:/Music/B.mp3",sim:.98,continuity_reward:1.25},{path:"C:/Music/C.mp3",sim:.977,continuity_reward:1}],diagnostic:{policy:"rolling",request_id:"request"},stats:{like_fallback_level:"strict"}};
  const id = app.beginRecommendationDiagnostic("C:/Music/B.mp3","like_next",app.recCache,"natural");
  const entry = app.recommendationDiagnostics.find(r=>r.id===id);
  assert.ok(Math.abs(entry.probability - 1.25/1.75)<1e-10);
  assert.equal(entry.trigger,"natural");
  app.finishRecommendationDiagnostic(id,"failed");
  assert.equal(Object.keys(app.listeningHistory.tracks).length,0);
  const failed = await app.playByPath("C:/Music/bad.mp3",true,"like_next");
  assert.equal(failed.ok,false);
  assert.equal(app.recommendationDiagnostics.at(-1).status,"failed");
  assert.equal(app.listeningHistory.tracks["C:/Music/bad.mp3"],undefined);
  // Log retention is independent of history and never grows with playback duration.
  for(let i=0;i<90;i++) app.beginRecommendationDiagnostic("C:/Music/B.mp3","like_next");
  assert.equal(app.recommendationDiagnostics.length,80);
});

test("seeking skips jumped ranges and counts only replayed media", () => {
  const { app, fakeAudio, capturedConfig } = createRendererHarness();
  const mountedSource = capturedConfig.mounted.toString();
  ["seeking", "seeked", "waiting", "stalled", "playing", "ratechange"].forEach((eventName) => {
    assert.match(mountedSource, new RegExp(`addEventListener\\("${eventName}"`));
  });
  app.listeningHistory = app.getEmptyListeningHistory();
  app.currentTime = 0;
  app.duration = 300;
  fakeAudio.currentTime = 0;
  fakeAudio.duration = 300;
  fakeAudio.paused = false;
  app.isPlaying = true;
  app.beginListeningSession(app.currentPath);
  const attemptId = app.listeningSession.attemptId;

  const advance = (seconds) => {
    app.listeningSession.lastClockAt = app.getListeningClockMs() - seconds * 1000;
    app.listeningSession.lastAudioTime = fakeAudio.currentTime;
    fakeAudio.currentTime += seconds;
    app.currentTime = fakeAudio.currentTime;
    app.updateListeningSessionProgress();
  };
  advance(5);
  advance(5);
  app.beginListeningSeek("test");
  fakeAudio.currentTime = 200;
  app.currentTime = 200;
  app.completeListeningSeek("test");
  advance(5);
  advance(5);
  app.beginListeningSeek("test-backward");
  fakeAudio.currentTime = 5;
  app.currentTime = 5;
  app.completeListeningSeek("test-backward");
  advance(5);

  assert.equal(app.listeningSession.attemptId, attemptId);
  assert.ok(app.listeningSession.listenedSeconds >= 24.9);
  assert.ok(app.listeningSession.listenedSeconds < 25.1);
  assert.ok(app.listeningSession.creditedMediaSeconds >= 24.9);
  assert.ok(app.listeningSession.creditedMediaSeconds < 25.1);
  assert.equal(app.listeningHistory.tracks[app.currentPath].playCount, 0);
});

test("waiting and stalled time do not increase listening duration", () => {
  const { app, fakeAudio } = createRendererHarness();
  app.listeningHistory = app.getEmptyListeningHistory();
  app.currentTime = 0;
  fakeAudio.currentTime = 0;
  fakeAudio.paused = false;
  app.isPlaying = true;
  app.beginListeningSession(app.currentPath);

  app.listeningSession.lastClockAt = app.getListeningClockMs() - 5000;
  fakeAudio.currentTime = 5;
  app.currentTime = 5;
  app.updateListeningSessionProgress();
  app.markListeningBuffering("waiting");
  app.listeningSession.lastClockAt = app.getListeningClockMs() - 5000;
  app.updateListeningSessionProgress({ force: true });
  app.markListeningBuffering("stalled");
  app.resumeListeningAfterBuffering("playing");
  app.listeningSession.lastClockAt = app.getListeningClockMs() - 5000;
  app.listeningSession.lastAudioTime = fakeAudio.currentTime;
  fakeAudio.currentTime = 10;
  app.currentTime = 10;
  app.updateListeningSessionProgress();

  assert.ok(app.listeningSession.listenedSeconds >= 9.9);
  assert.ok(app.listeningSession.listenedSeconds < 10.1);
  assert.equal(app.listeningSession.state, "playing");
});

test("playback rate keeps wall time and credited media time separate", () => {
  const { app, fakeAudio } = createRendererHarness();
  app.listeningHistory = app.getEmptyListeningHistory();
  app.currentTime = 0;
  app.duration = 100;
  fakeAudio.currentTime = 0;
  fakeAudio.duration = 100;
  fakeAudio.paused = false;
  app.isPlaying = true;
  app.beginListeningSession(app.currentPath);
  fakeAudio.playbackRate = 2;
  app.handleListeningRateChange();
  app.listeningSession.lastClockAt = app.getListeningClockMs() - 5000;
  app.listeningSession.lastAudioTime = fakeAudio.currentTime;
  fakeAudio.currentTime = 10;
  app.currentTime = 10;
  app.updateListeningSessionProgress();

  assert.ok(app.listeningSession.listenedSeconds >= 4.9);
  assert.ok(app.listeningSession.listenedSeconds < 5.1);
  assert.ok(app.listeningSession.creditedMediaSeconds >= 9.9);
  assert.ok(app.listeningSession.creditedMediaSeconds < 10.1);
  assert.equal(app.listeningHistory.tracks[app.currentPath].playCount, 0);
});

test("a throttled background tick still counts matching media progress", () => {
  const { app, fakeAudio } = createRendererHarness();
  app.listeningHistory = app.getEmptyListeningHistory();
  app.currentTime = 0;
  app.duration = 100;
  fakeAudio.currentTime = 0;
  fakeAudio.duration = 100;
  fakeAudio.paused = false;
  app.isPlaying = true;
  app.beginListeningSession(app.currentPath);
  app.listeningSession.lastClockAt = app.getListeningClockMs() - 30000;
  app.listeningSession.lastAudioTime = 0;
  fakeAudio.currentTime = 30;
  app.currentTime = 30;

  app.updateListeningSessionProgress();

  assert.ok(app.listeningSession.listenedSeconds >= 29.9);
  assert.ok(app.listeningSession.listenedSeconds < 30.1);
  assert.ok(app.listeningSession.creditedMediaSeconds >= 29.9);
  assert.ok(app.listeningSession.creditedMediaSeconds < 30.1);
  assert.equal(app.listeningHistory.tracks[app.currentPath].playCount, 0);
});

test("continuous timeupdates cannot postpone history persistence forever", async () => {
  let nextTimerId = 0;
  const timers = new Map();
  const writes = [];
  const fakeSetTimeout = (callback, delay) => {
    nextTimerId += 1;
    const timerId = nextTimerId;
    timers.set(timerId, {
      delay,
      run() {
        timers.delete(timerId);
        callback();
      },
    });
    return timerId;
  };
  const fakeClearTimeout = (timerId) => {
    timers.delete(timerId);
  };
  const { app } = createRendererHarness({
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    lxEnv: {
      setListeningHistory: async (history) => {
        writes.push(structuredClone(history));
        return { ok: true };
      },
    },
  });
  app.listeningHistory = app.getEmptyListeningHistory();

  app.queueListeningHistorySave(1000);
  app.queueListeningHistorySave(1000);
  app.queueListeningHistorySave(1000);

  const activeTimers = Array.from(timers.values());
  assert.equal(activeTimers.length, 2);
  const maxTimer = activeTimers.find((timer) => timer.delay === 60000);
  assert.ok(maxTimer);
  maxTimer.run();
  await Promise.resolve();

  assert.equal(writes.length, 1);
  assert.equal(timers.size, 0);
});

test("history recovery status is visible without exposing an absolute path", async () => {
  const { app } = createRendererHarness({
    lxEnv: {
      getListeningHistory: async () => ({
        version: 1,
        totalSeconds: 42,
        totalPlays: 0,
        tracks: {},
        days: { "2026-07-29": 42 },
      }),
      getListeningHistoryStatus: async () => ({
        state: "recovered",
        recovered: true,
        sourceDay: "2026-07-29",
        sourceBackup: "listening_history.2026-07-29.json",
        corruptArchive: "listening_history.20260730T120000000.deadbeef.corrupt.json",
        invalidBackups: ["listening_history.2026-07-30.json"],
        warning: "",
      }),
    },
  });

  await app.loadListeningHistory();

  assert.equal(app.listeningHistory.totalSeconds, 42);
  assert.match(app.listeningHistoryMessage, /2026-07-29/);
  assert.match(app.listeningHistoryMessage, /跳过 1 个损坏备份/);
  assert.match(app.listeningHistoryMessage, /损坏主文件已保留/);
  assert.doesNotMatch(app.listeningHistoryMessage, /[A-Za-z]:\\/);
});

test("song information batch clamps thresholds to the documented safe range", async () => {
  let createdPayload = null;
  const { app } = createRendererHarness({
    lxEnv: {
      createSongInfoBatchTask: async (payload) => {
        createdPayload = payload;
        return {
          ok: true,
          task: { id: "task-zero", state: "draft", updatedAt: 1, items: [], counts: { total: 0, pending: 0 } },
        };
      },
      startSongInfoBatchTask: async () => ({ ok: true }),
    },
  });
  app.tracks = [{ path: "C:\\Music\\Zero.mp3", resourceId: "resource-zero", songKey: "zero" }];
  app.trackByPath = new Map(app.tracks.map((track) => [track.path, track]));
  app.songInfoBatchSettings.autoThreshold = 0;
  app.songInfoBatchSettings.manualThreshold = 0;

  await app.startSongInfoBatch();

  assert.equal(createdPayload.autoThreshold, 90);
  assert.equal(createdPayload.manualThreshold, 60);
});

test("song information batch respects all, playlist, and selected ranges", async () => {
  const payloads = [];
  const localA = { path: "C:\\Music\\A.mp3", resourceId: "resource-a", songKey: "artist - a" };
  const localB = { path: "C:\\Music\\B.mp3", resourceId: "resource-b", songKey: "artist - b" };
  const online = { path: "online://wy/song-1" };
  const { app } = createRendererHarness({
    lxEnv: {
      createSongInfoBatchTask: async (payload) => {
        payloads.push(payload);
        return { ok: true, task: { id: `task-${payloads.length}`, state: "draft", updatedAt: payloads.length } };
      },
      startSongInfoBatchTask: async () => ({ ok: true }),
    },
  });
  app.tracks = [localA, localB, online];
  app.trackByPath = new Map([[localA.path, localA], [localB.path, localB]]);
  app.playlists = [{ id: "custom-1", tracks: [localB.path, online.path, localB.path] }];
  app.currentPlaylist = "custom-1";
  app.selectedPath = localA.path;
  app.songInfoBatchSettings.fields = {
    ...app.songInfoBatchSettings.fields,
    title: true,
  };

  assert.deepEqual(
    Array.from(app.localSongInfoBatchTracks("all"), (track) => track.path),
    [localA.path, localB.path],
  );
  assert.deepEqual(
    Array.from(app.localSongInfoBatchTracks("playlist"), (track) => track.path),
    [localB.path],
  );
  assert.deepEqual(
    Array.from(app.localSongInfoBatchTracks("selected"), (track) => track.path),
    [localA.path],
  );

  app.songInfoBatchSettings.scope = "playlist";
  await app.startSongInfoBatch();
  assert.deepEqual(Array.from(payloads[0].tracks, (track) => track.path), [localB.path]);
});

test("song information cache clearing reports the result and waits for unfinished tasks", async () => {
  let calls = 0;
  const { app } = createRendererHarness({
    lxEnv: {
      clearSongInfoCache: async () => {
        calls += 1;
        return { ok: true, queryEntries: 2, coverFiles: 1 };
      },
    },
  });

  await app.clearSongInfoLookupCache();

  assert.equal(calls, 1);
  assert.equal(app.songInfoCacheMessage, "已清理");
  assert.equal(app.songInfoCacheMessageTone, "");
  assert.equal(app.songInfoCacheBusy, false);

  app.songInfoBatchTasks = [{ id: "active", state: "running" }];
  await app.clearSongInfoLookupCache();
  assert.equal(calls, 1);

  const index = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
  assert.match(index, /任务和已保存歌词会保留。/);
  assert.match(preload, /clearSongInfoCache: \(\) => ipcRenderer\.invoke\("lx-song-info-cache-clear"\)/);
});

test("song information task progress reports checked items and the active local track", () => {
  const { app } = createRendererHarness();
  const activePath = "C:\\Music\\Active.mp3";
  app.trackByPath = new Map([[
    activePath,
    { path: activePath, title: "Active", artists: ["Singer"] },
  ]]);
  const task = {
    mode: "lyric-sidecar",
    counts: {
      total: 4,
      pending: 2,
      writtenAuto: 1,
      skipped: 1,
      cancelled: 0,
    },
    items: [
      { status: "written-auto", track: { path: "C:\\Music\\Done.mp3" } },
      { status: "skipped", track: { path: "C:\\Music\\Skipped.mp3" } },
      { status: "writing", track: { path: activePath } },
      { status: "pending", track: { path: "C:\\Music\\Pending.mp3" } },
    ],
  };

  assert.equal(app.songInfoBatchProgress(task), 50);
  assert.equal(app.songInfoBatchSummary(task), "已检查 2/4 · 已保存 1 · 已跳过 1");
  assert.equal(app.songInfoBatchActiveTrackText(task), "Active · Singer");
  assert.equal(app.songInfoBatchActiveTrackText({ ...task, items: [] }), "");
});

test("song information task patches replace only changed rows", () => {
  const { app } = createRendererHarness();
  const first = { id: "1", status: "matched-auto", track: { path: "C:\\Music\\One.mp3" } };
  const second = { id: "2", status: "pending", track: { path: "C:\\Music\\Two.mp3" } };
  app.songInfoBatchTasks = [{
    id: "task-patch",
    state: "querying",
    updatedAt: 1,
    counts: { total: 2, pending: 1 },
    items: [first, second],
  }];
  app.songInfoBatchCurrentId = "task-patch";

  app.applySongInfoBatchUpdate({
    kind: "task-patch",
    task: {
      id: "task-patch",
      state: "completed",
      updatedAt: 2,
      counts: { total: 2, pending: 0, noMatch: 1, matchedAuto: 1 },
    },
    items: [{ ...second, status: "no-match" }],
  });

  const updated = app.songInfoBatchTasks[0];
  assert.equal(updated.state, "completed");
  assert.equal(updated.items[0], first);
  assert.equal(updated.items[1].status, "no-match");
  assert.equal(updated.counts.pending, 0);
});

test("a late task-list snapshot cannot roll back newer progress patches", async () => {
  let resolveList;
  const listPending = new Promise((resolve) => {
    resolveList = resolve;
  });
  const { app } = createRendererHarness({
    lxEnv: {
      listSongInfoBatchTasks: async () => listPending,
    },
  });
  const currentItem = { id: "1", status: "querying", track: { path: "C:\\Music\\One.mp3" } };
  app.songInfoBatchTasks = [{
    id: "task-race",
    state: "querying",
    updatedAt: 2,
    counts: { total: 1, pending: 1 },
    items: [currentItem],
  }];
  app.songInfoBatchCurrentId = "task-race";

  const loading = app.loadSongInfoBatchTasks();
  await new Promise((resolve) => setImmediate(resolve));
  app.applySongInfoBatchUpdate({
    kind: "task-patch",
    task: {
      id: "task-race",
      state: "completed",
      updatedAt: 3,
      counts: { total: 1, pending: 0, noMatch: 1 },
    },
    items: [{ ...currentItem, status: "no-match" }],
  });
  resolveList({
    ok: true,
    tasks: [{
      id: "task-race",
      state: "querying",
      updatedAt: 1,
      counts: { total: 1, pending: 1 },
      items: [{ ...currentItem, status: "pending" }],
    }],
  });
  await loading;

  const retained = app.songInfoBatchTasks[0];
  assert.equal(retained.state, "completed");
  assert.equal(retained.items[0].status, "no-match");
  assert.equal(retained.counts.pending, 0);
});

test("batch retries target only the selected failure class", async () => {
  const retryPayloads = [];
  const { app } = createRendererHarness({
    lxEnv: {
      retrySongInfoBatchTask: async (payload) => {
        retryPayloads.push(payload);
        return { ok: true, changed: payload.itemIds.length, task: null };
      },
      startSongInfoBatchTask: async () => ({ ok: true }),
    },
  });
  const task = {
    id: "task-retry",
    state: "completed",
    items: [
      { id: "failed", status: "failed", errorCode: "PROVIDER_TIMEOUT", track: { path: "C:\\Music\\Failed.mp3" } },
      { id: "missing", status: "no-match", track: { path: "C:\\Music\\Missing.mp3" } },
      { id: "cancelled", status: "cancelled", track: { path: "C:\\Music\\Cancelled.mp3" } },
    ],
  };

  await app.retrySongInfoBatch(task, ["failed"]);
  await app.retrySongInfoBatch(task, ["cancelled"]);

  assert.deepEqual(Array.from(retryPayloads[0].itemIds), ["failed"]);
  assert.deepEqual(Array.from(retryPayloads[1].itemIds), ["cancelled"]);
  assert.equal(app.songInfoBatchErrorText(task.items[0]), "暂时无法查询");
  assert.equal(app.songInfoBatchErrorText({ errorCode: "TRACK_MISSING" }), "歌曲文件不存在");
  assert.equal(app.songInfoBatchErrorText({ errorCode: "LYRIC_SAVE_FAILED" }), "保存失败");
  const index = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  assert.match(index, /继续未完成/);
  assert.doesNotMatch(index, /\{\{\s*item\.errorCode\s*\}\}/);
});

test("batch confirmation keeps the selected candidate and every visible field difference together", () => {
  const { app } = createRendererHarness();
  const task = { id: "task-differences" };
  const item = {
    id: "item-1",
    candidates: [
      {
        candidate: { title: "First", artists: ["Singer"] },
        differences: [{ field: "album", current: "", proposed: "Album", changed: true, available: true }],
      },
      {
        candidate: { title: "Second", artists: ["Singer"] },
        differences: [
          { field: "album", current: "", proposed: "Other Album", changed: true, available: true },
          { field: "cover", current: null, proposed: { assetId: "cover-1" }, changed: true, available: true },
        ],
      },
    ],
  };

  app.setSongInfoBatchCandidateChoice(task, item, 1);
  const selected = app.songInfoBatchSelectedCandidate(task, item);

  assert.equal(selected.candidate.title, "Second");
  assert.deepEqual(app.visibleSongInfoDifferences(selected).map((difference) => difference.field), ["album", "cover"]);
  assert.match(app.songInfoBatchCandidateText(selected), /Second/);
});

test("batch lyric entry is capability-gated and sends only sidecar options", async () => {
  let createdPayload = null;
  const { app } = createRendererHarness({
    lxEnv: {
      createSongInfoBatchTask: async (payload) => {
        createdPayload = payload;
        return {
          ok: true,
          task: { id: "task-lyrics", mode: "lyric-sidecar", state: "draft", updatedAt: 1, items: [], counts: { total: 0, pending: 0 } },
        };
      },
      startSongInfoBatchTask: async () => ({ ok: true }),
    },
  });
  app.tracks = [{ path: "C:\\Music\\Lyrics.mp3", resourceId: "resource-lyrics", songKey: "lyrics" }];
  app.trackByPath = new Map(app.tracks.map((track) => [track.path, track]));
  app.lyricSaveIncludeTranslation = true;
  app.lyricSaveIncludeRomanization = false;

  await app.startLyricSidecarBatch();
  assert.equal(createdPayload, null);
  assert.equal(app.songInfoBatchMessage, "暂无歌词来源");

  app.songInfoLyricBatchAvailable = true;
  await app.startLyricSidecarBatch();

  assert.equal(createdPayload.mode, "lyric-sidecar");
  assert.deepEqual(Array.from(createdPayload.requestedFields), ["lyrics"]);
  assert.equal(createdPayload.tracks[0].resourceId, "resource-lyrics");
  assert.deepEqual(JSON.parse(JSON.stringify(createdPayload.lyricOptions)), {
    includeTranslation: true,
    includeRomanization: false,
  });
});

test("song information candidate choices are scoped to their task", () => {
  const { app } = createRendererHarness();
  const item = { id: "1" };
  const first = { id: "task-one" };
  const second = { id: "task-two" };

  app.setSongInfoBatchCandidateChoice(first, item, 2);

  assert.equal(app.songInfoBatchCandidateChoice(first, item), 2);
  assert.equal(app.songInfoBatchCandidateChoice(second, item), 0);
});

test("structured lyrics preserve explicit word ends through playback and overlay state", () => {
  const { app } = createRendererHarness();
  app.applyTrackPresentation({
    meta: {
      title: "Timed",
      artist: "Artist",
      album: "Album",
      lyric: "[00:01.00]Legacy",
      lyricModel: {
        schemaVersion: 1,
        synced: true,
        lines: [{
          startMs: 1000,
          endMs: 2400,
          main: {
            text: "AB",
            words: [
              { startMs: 1000, endMs: 1200, text: "A" },
              { startMs: 1800, endMs: 2000, text: "B" },
            ],
          },
          translation: { text: "译文", words: [] },
          romanization: { text: "", words: [] },
        }],
      },
    },
    duration: 180,
  });

  assert.equal(app.lyricLines[0].words[0].endTime, 1.2);
  assert.equal(app.computeKaraokeState(0, 1.3).wordProgress, 1);
  app.lyricCanShowMain = true;
  app.lyricCanShowSub = true;
  const payload = app.buildLyricOverlayPayload();
  assert.equal(payload.current.words[0].endTime, 1.2);
  assert.equal(payload.current.endTime, 2.4);

  app.lyricLines = [{
    time: 0,
    main: "AB",
    sub: "",
    words: [{ time: 0, endTime: null, text: "A" }, { time: 1, endTime: null, text: "B" }],
  }];
  assert.equal(app.computeKaraokeState(0, 0.5).wordProgress, 0.5);
});

test("committed online lyrics use the unified model and keep language channels separate", async () => {
  let lyricRequest = null;
  const { app } = createRendererHarness({
    lxEnv: {
      getOnlineLyric: async (payload) => {
        lyricRequest = payload;
        return ({
        lyricsModel: {
          schemaVersion: 1,
          synced: true,
          lines: [{
            startMs: 1000,
            endMs: 2000,
            main: { text: "Main", words: [] },
            translation: { text: "翻译", words: [] },
            romanization: { text: "romanized", words: [] },
          }],
        },
        });
      },
    },
  });
  app.currentPath = "online://wy/1";
  app.playbackGeneration = 4;
  app._committedPlaybackGeneration = 4;

  const applied = await app.loadCommittedOnlineLyric(
    "online://wy/1",
    4,
    { source: "wy", songId: "1", title: "Title", artist: "Singer", album: "Album", duration: 180 },
  );

  assert.equal(applied, true);
  assert.equal(app.lyricLines[0].main, "Main");
  assert.equal(app.lyricLines[0].sub, "翻译");
  assert.equal(app.lyricLines[0].romanization, "romanized");
  assert.equal(app.currentMeta.lyric, "");
  assert.equal(app.currentMeta.lyricModel.schemaVersion, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(lyricRequest)), {
    source: "wy",
    songId: "1",
    title: "Title",
    artist: "Singer",
    album: "Album",
    duration: 180,
  });
});

test("online covers use the loopback proxy for hotlink-protected artwork", () => {
  const { app } = createRendererHarness();
  assert.equal(
    app.onlineCoverUrl("https://example.test/cover.jpg"),
    "http://127.0.0.1:3901/online-proxy?url=https%3A%2F%2Fexample.test%2Fcover.jpg",
  );
  assert.equal(app.onlineCoverUrl("data:image/png;base64,AA=="), "data:image/png;base64,AA==");
});

test("indexed online tracks keep proxied artwork in the library list", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "renderer", "index.html"), "utf8");
  assert.match(
    html,
    /isOnlineToken\(t\.path\) \? onlineCoverUrl\(t\.cover_thumb \|\| t\.cover\)/,
  );
});

test("late online lyrics cannot overwrite a newer playback generation", async () => {
  let resolveLyric;
  const { app } = createRendererHarness({
    lxEnv: {
      getOnlineLyric: () => new Promise((resolve) => {
        resolveLyric = resolve;
      }),
    },
  });
  app.currentPath = "online://wy/1";
  app.playbackGeneration = 7;
  app._committedPlaybackGeneration = 7;
  app.currentMeta = { title: "Current", artist: "", album: "", lyric: "", lyricModel: null };

  const pending = app.loadCommittedOnlineLyric(
    "online://wy/1",
    7,
    { source: "wy", songId: "1" },
  );
  app.playbackGeneration = 8;
  app._committedPlaybackGeneration = 8;
  app.currentPath = "online://wy/2";
  resolveLyric({
    lyricsModel: {
      schemaVersion: 1,
      synced: true,
      lines: [{
        startMs: 0,
        main: { text: "Late", words: [] },
        translation: { text: "", words: [] },
        romanization: { text: "", words: [] },
      }],
    },
  });

  assert.equal(await pending, false);
  assert.equal(app.currentMeta.title, "Current");
  assert.equal(app.lyricLines.length, 0);
});

test("song information lyric action appears only for candidates with main lyrics", () => {
  const { app } = createRendererHarness();
  assert.equal(app.songInfoCandidateHasLyrics({ candidate: { lyrics: null } }), false);
  assert.equal(app.songInfoCandidateHasLyrics({ candidate: { lyrics: { available: true } } }), false);
  assert.equal(app.songInfoCandidateHasLyrics({
    lyricSaveToken: "candidate-token",
    candidate: { lyrics: { available: true, channels: ["main"] } },
  }), true);
});

test("song information candidate summary shows date, duration, version and lyric quality", () => {
  const { app } = createRendererHarness();
  const item = {
    candidate: {
      releaseDate: "2024-02-03",
      durationSeconds: 241,
      versionTerms: ["live"],
      lyrics: {
        available: true,
        synced: true,
        qualityLevel: "word",
        channels: ["main", "translation"],
      },
      provenance: {
        title: { provider: "musicbrainz" },
        artists: { provider: "musicbrainz" },
        recordingId: "internal-id",
      },
    },
  };

  assert.equal(app.songInfoCandidateMeta(item), "2024-02-03 · 04:01 · 现场 · 逐字歌词、翻译");
  assert.equal(app.songInfoProvenanceFields(item), "标题、歌手");
  assert.equal(app.songInfoCandidateMeta({ candidate: {} }), "");
});

test("single song lookup requests real metadata differences without mixing blocked lyric sources", async () => {
  const requests = [];
  const trackPath = "C:\\Music\\A.mp3";
  const { app } = createRendererHarness({
    lxEnv: {
      querySongInfo: async (payload) => {
        requests.push(payload);
        return { ok: true, current: {}, candidates: [], sources: [] };
      },
      cancelSongInfoQuery: async () => ({ ok: true }),
    },
  });
  app.$refs = {};
  app.$nextTick = (callback) => callback?.();
  app.trackByPath = new Map([[trackPath, { path: trackPath, resourceId: "resource-1" }]]);

  await app.openSongInfoLookup(trackPath);

  assert.equal(requests.length, 1);
  assert.ok(requests[0].requestedFields.includes("title"));
  assert.ok(requests[0].requestedFields.includes("cover"));
  assert.equal(requests[0].requestedFields.includes("lyrics"), false);
  assert.equal(requests[0].includeLyrics, true);
  assert.equal(requests[0].resourceId, "resource-1");
});

test("song information lyric save commits the selected candidate and retains undo id", async () => {
  const preparedPayloads = [];
  const commitPayloads = [];
  const { app } = createRendererHarness({
    lxEnv: {
      prepareLyricSave: async (payload) => {
        preparedPayloads.push(payload);
        return { ok: true, confirmationId: "confirm-1", targetExists: false };
      },
      commitLyricSave: async (payload) => {
        commitPayloads.push(payload);
        return { ok: true, status: "committed", transactionId: "tx-1" };
      },
      cancelLyricSave: async () => ({ ok: true }),
    },
  });
  const trackPath = "C:\\Music\\A.mp3";
  app._songInfoRequestGeneration = 3;
  app.songInfoDialog = {
    visible: true,
    path: trackPath,
    selectedIndex: 0,
    candidates: [{
      lyricSaveToken: "candidate-token",
      candidate: {
        candidateId: "provider:item",
        provider: "provider",
        lyrics: { available: true, channels: ["main"] },
      },
    }],
    lyricSaveBusy: false,
    lyricSaveMessage: "",
    lyricConfirmationId: "",
  };
  app.refreshCurrentLyricsAfterSidecarChange = async () => false;
  app.showNotice = () => {};

  await app.saveSelectedSongInfoLyrics();

  assert.equal(preparedPayloads.length, 1);
  assert.equal(preparedPayloads[0].candidateToken, "candidate-token");
  assert.equal(Object.hasOwn(preparedPayloads[0], "trackPath"), false);
  assert.equal(Object.hasOwn(preparedPayloads[0], "lyricsModel"), false);
  assert.equal(preparedPayloads[0].includeTranslation, true);
  assert.equal(preparedPayloads[0].includeRomanization, false);
  assert.equal(commitPayloads.length, 1);
  assert.equal(commitPayloads[0].confirmationId, "confirm-1");
  assert.equal(commitPayloads[0].replaceExisting, false);
  assert.equal(app.lastLyricSaveTransactionId, "tx-1");
  assert.equal(app.songInfoDialog.lyricSaveMessage, "已保存到歌曲旁");
  assert.equal(app.songInfoDialog.lyricSaveBusy, false);
});

test("existing sidecar replacement is cancelled without committing", async () => {
  const cancelled = [];
  let commitCount = 0;
  const { app } = createRendererHarness({
    lxEnv: {
      prepareLyricSave: async () => ({ ok: true, confirmationId: "confirm-existing", targetExists: true }),
      commitLyricSave: async () => {
        commitCount += 1;
        return { ok: true, status: "committed", transactionId: "tx-unexpected" };
      },
      cancelLyricSave: async (id) => {
        cancelled.push(id);
        return { ok: true };
      },
    },
  });
  const trackPath = "C:\\Music\\A.mp3";
  app._songInfoRequestGeneration = 5;
  app.songInfoDialog = {
    visible: true,
    path: trackPath,
    selectedIndex: 0,
    candidates: [{
      lyricSaveToken: "candidate-existing",
      candidate: { candidateId: "provider:item", provider: "provider", lyrics: { available: true } },
    }],
    lyricSaveBusy: false,
    lyricSaveMessage: "",
    lyricConfirmationId: "",
  };
  app.requestConfirmation = async () => false;

  await app.saveSelectedSongInfoLyrics();

  assert.equal(commitCount, 0);
  assert.deepEqual(cancelled, ["confirm-existing"]);
  assert.equal(app.songInfoDialog.lyricConfirmationId, "");
  assert.equal(app.songInfoDialog.lyricSaveBusy, false);
});

test("recent lyric undo state is restored after renderer restart", async () => {
  const { app } = createRendererHarness({
    lxEnv: {
      getRecentLyricSave: async () => ({
        ok: true,
        transaction: { transactionId: "tx-recovered", committedAt: 123456 },
      }),
    },
  });

  await app.loadRecentLyricSave();

  assert.equal(app.lastLyricSaveTransactionId, "tx-recovered");
  assert.equal(app.lastLyricSaveTrackPath, "");
});

test("late lyric undo recovery cannot overwrite a newer saved transaction", async () => {
  let resolveRecovery;
  const recovery = new Promise((resolve) => { resolveRecovery = resolve; });
  const { app } = createRendererHarness({
    lxEnv: {
      getRecentLyricSave: async () => recovery,
    },
  });

  const loading = app.loadRecentLyricSave();
  await new Promise((resolve) => setImmediate(resolve));
  app._lyricUndoStateGeneration += 1;
  app.lastLyricSaveTransactionId = "tx-new-save";
  app.lastLyricSaveTrackPath = "C:\\Music\\New.mp3";
  resolveRecovery({
    ok: true,
    transaction: { transactionId: "tx-stale-recovery", committedAt: 1000 },
  });
  await loading;

  assert.equal(app.lastLyricSaveTransactionId, "tx-new-save");
  assert.equal(app.lastLyricSaveTrackPath, "C:\\Music\\New.mp3");
});

test("late lyric undo completion cannot clear a newer saved transaction", async () => {
  let resolveUndo;
  const undoPending = new Promise((resolve) => { resolveUndo = resolve; });
  const refreshed = [];
  const { app } = createRendererHarness({
    lxEnv: {
      undoLyricSave: async () => undoPending,
      getRecentLyricSave: async () => ({ ok: true, transaction: null }),
    },
  });
  app.lastLyricSaveTransactionId = "tx-old";
  app.lastLyricSaveTrackPath = "C:\\Music\\Old.mp3";
  app.refreshCurrentLyricsAfterSidecarChange = async (trackPath) => {
    refreshed.push(trackPath);
    return true;
  };
  app.showNotice = () => {};

  const undoing = app.undoLastLyricSave();
  await new Promise((resolve) => setImmediate(resolve));
  app._lyricUndoStateGeneration += 1;
  app.lastLyricSaveTransactionId = "tx-new";
  app.lastLyricSaveTrackPath = "C:\\Music\\New.mp3";
  resolveUndo({ ok: true, status: "undone" });
  await undoing;

  assert.equal(app.lastLyricSaveTransactionId, "tx-new");
  assert.equal(app.lastLyricSaveTrackPath, "C:\\Music\\New.mp3");
  assert.deepEqual(refreshed, []);
  assert.equal(app.lyricUndoBusy, false);
});

test("undo refreshes current lyrics and then restores the next undoable transaction", async () => {
  const refreshed = [];
  const { app } = createRendererHarness({
    lxEnv: {
      undoLyricSave: async (transactionId) => ({ ok: transactionId === "tx-latest", status: "undone" }),
      getRecentLyricSave: async () => ({
        ok: true,
        transaction: { transactionId: "tx-older", committedAt: 1000 },
      }),
    },
  });
  app.lastLyricSaveTransactionId = "tx-latest";
  app.lastLyricSaveTrackPath = "";
  app.currentPath = "C:\\Music\\A.mp3";
  app.refreshCurrentLyricsAfterSidecarChange = async (trackPath) => {
    refreshed.push(trackPath);
    return true;
  };
  app.showNotice = () => {};

  await app.undoLastLyricSave();

  assert.deepEqual(refreshed, ["C:\\Music\\A.mp3"]);
  assert.equal(app.lastLyricSaveTransactionId, "tx-older");
  assert.equal(app.lyricUndoBusy, false);
});


test("history performance snapshot, query cache and pagination preserve behavior", () => {
  const { app, capturedConfig } = createRendererHarness();
  app.$refs = {};
  for (const name of ['listeningHistoryRows', 'listeningHistoryPageCount', 'listeningHistoryCurrentPage', 'listeningHistoryVisibleRows']) {
    Object.defineProperty(app, name, { get: () => capturedConfig.computed[name].call(app) });
  }
  app.listeningHistory.persistenceRevision = 7;
  app.listeningHistory.tracks = Object.fromEntries(Array.from({ length: 183 }, (_, i) => ["p" + i, {
    path: "p" + i, title: "歌曲" + i, artist: "鹿乃", album: "专辑", playCount: i + 1,
    listenedSeconds: i, recommendationBehavior: { skipOpportunityCount: 3 },
  }]));
  const snapshot = app.toPlainListeningHistory(app.listeningHistory);
  app.listeningHistory.tracks.p0.playCount = 99;
  app.listeningHistory.tracks.p0.recommendationBehavior.skipOpportunityCount = 8;
  assert.equal(snapshot.persistenceRevision, 7);
  assert.equal(snapshot.tracks.p0.playCount, 1);
  assert.equal(snapshot.tracks.p0.recommendationBehavior.skipOpportunityCount, 3);
  assert.equal(app.listeningHistoryPageCount, 3);
  assert.equal(app.listeningHistoryVisibleRows.length, 80);
  app.changeListeningHistoryPage(3);
  assert.equal(app.listeningHistoryVisibleRows.length, 23);
  app.setListeningHistoryQuery("鹿乃");
  assert.equal(app.listeningHistoryPage, 1);
  assert.equal(app.getListeningHistoryRows().length, 183);
  app.listeningHistory.tracks.p1.artist = "新歌手";
  app.setListeningHistoryQuery("新歌手");
  assert.equal(app.getListeningHistoryRows().length, 1);
  assert.equal(app.getListeningHistoryRows()[0].path, "p1");
});


function createEffectsRenderer() {
  const slots = [], fades = [];
  const real = require("../renderer/audio-effects");
  const engine = { context: {}, tail: null, resume: async () => true, gain() {}, apply() {}, setVolume() {},
    stopTail() { this.tail = null; },
    release(element) { element.pause(); element.removeAttribute("src"); },
    fade(outgoing, incoming, seconds) { this.tail = outgoing; fades.push({ outgoing, incoming, seconds }); },
  };
  const harness = createRendererHarness({ audioEffects: { ...real, Engine: function () { return engine; } },
    makeAudio(first) { const slot = slots.length ? new FakeAudio() : first; slot.readyState = 3; slots.push(slot); return slot; } });
  harness.app.audioEffects = real.normalize({ crossfade: true, seconds: 3 });
  harness.app.filteredTracks = [{ path: "C:/Music/A.mp3" }, { path: "C:/Music/B.mp3" }, { path: "C:/Music/C.mp3" }];
  return { ...harness, slots, fades };
}

test("crossfade reservation has no history effects and manual playback cancels its prepared slot", async () => {
  const { app, slots, fades } = createEffectsRenderer();
  await app.playByPath("C:/Music/A.mp3");
  slots[0].currentTime = 170;
  const before = app.playHistory.length;
  await app.prepareNaturalCrossfade(app.naturalQueueStamp());
  assert.equal(app.currentPath, "C:/Music/A.mp3");
  assert.equal(app.playHistory.length, before);
  assert.ok(slots[1].src.includes("B.mp3"));
  assert.equal(slots[1].paused, true);
  await app.playByPath("C:/Music/C.mp3");
  assert.equal(app.currentPath, "C:/Music/C.mp3");
  assert.equal(slots[1].src, "");
  assert.equal(fades.length, 0);
});

test("natural overlap commits the prepared slot once and subsequent manual switch does not crossfade", async () => {
  const { app, slots, fades } = createEffectsRenderer();
  await app.playByPath("C:/Music/A.mp3");
  slots[0].currentTime = 178;
  await app.prepareNaturalCrossfade(app.naturalQueueStamp());
  for (let i=0;i<5;i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.currentPath, "C:/Music/B.mp3");
  assert.equal(fades.length, 1);
  assert.equal(fades[0].outgoing, slots[0]);
  assert.equal(fades[0].incoming, slots[1]);
  assert.equal(fades[0].seconds, 2);
  assert.equal(app.playHistory.filter(p => p === "C:/Music/B.mp3").length, 1);
  await app.playByPath("C:/Music/C.mp3");
  assert.equal(fades.length, 1);
  assert.equal(app.currentPath, "C:/Music/C.mp3");
});


test("manual switch wins while incoming crossfade play is pending", async () => {
  const { app, slots } = createEffectsRenderer();
  await app.playByPath("C:/Music/A.mp3");
  slots[0].currentTime = 178;
  let release;
  slots[1].play = () => new Promise(resolve => { release = resolve; });
  await app.prepareNaturalCrossfade(app.naturalQueueStamp());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(typeof release, "function");
  await app.playByPath("C:/Music/C.mp3");
  release();
  for (let i=0;i<5;i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.currentPath, "C:/Music/C.mp3");
  assert.equal(slots[1].src, "");
  assert.equal(app.playHistory.includes("C:/Music/B.mp3"), false);
});

test("failed incoming crossfade leaves old audio at its current position", async () => {
  const { app, slots, fades } = createEffectsRenderer();
  app.filteredTracks = [{ path: "C:/Music/A.mp3" }, { path: "C:/Music/bad.mp3" }];
  await app.playByPath("C:/Music/A.mp3");
  slots[0].currentTime = 178;
  await app.prepareNaturalCrossfade(app.naturalQueueStamp());
  for (let i=0;i<5;i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.currentPath, "C:/Music/A.mp3");
  assert.equal(slots[0].currentTime, 178);
  assert.equal(slots[0].paused, false);
  assert.equal(fades.length, 0);
  assert.equal(app.playHistory.includes("C:/Music/bad.mp3"), false);
});

test("incoming error during overlap recovers outgoing ownership without adding history", async () => {
  const { app, slots } = createEffectsRenderer();
  await app.playByPath("C:/Music/A.mp3");
  slots[0].currentTime = 178;
  await app.prepareNaturalCrossfade(app.naturalQueueStamp());
  for (let i=0;i<5;i++) await new Promise(resolve => setImmediate(resolve));
  const count = app.playHistory.length;
  await app.recoverCrossfadeAudioError();
  assert.equal(app.currentPath, "C:/Music/A.mp3");
  assert.equal(app.playHistory.length, count);
  assert.equal(slots[1].src, "");
});
