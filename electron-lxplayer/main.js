const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  dialog,
  shell,
  screen,
  Menu,
  protocol,
  net: electronNet,
} = require("electron");
const path = require("path");
const fs = require("fs");
const http = require("http");
const net = require("net");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const axios = require("axios");
const onlineProviders = require("./online/providers");
const listeningHistoryOps = require("./listening-history-ops");
const listeningHistoryStore = require("./listening-history-store");
const secureProtocols = require("./secure-protocols");
const { revealLocalTrack } = require("./local-file-actions");
const { writeJsonObjectAtomic, createCoalescedWriter } = require("./async-json-writer");
const backendHealth = require("./backend-health");
const {AudioOutputMonitor}=require('./audio-output-monitor');
const audioOutputMonitor=new AudioOutputMonitor();
const {AudioOutputSafety}=require('./audio-output-safety');
const audioOutputSafety=new AudioOutputSafety(audioOutputMonitor);
const outputLeaseOwners=new Map(),outputLeaseWatched=new WeakSet();
function releaseOutputOwner(ownerId){const owned=outputLeaseOwners.get(ownerId);if(owned)for(const id of owned)audioOutputMonitor.release(id);outputLeaseOwners.delete(ownerId)}
function setOutputLease(event,consumer,enabled){
  if(!secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)||typeof consumer!=='string'||!/^calibration-[a-z0-9-]{1,50}$/.test(consumer))throw new Error('输出设备使用权无效');
  const contents=event.sender,id=`${contents.id}:${consumer}`;
  if(!outputLeaseWatched.has(contents)){
    const ownerId=contents.id;
    outputLeaseWatched.add(contents);contents.once('destroyed',()=>{releaseOutputOwner(ownerId);if(audioOutputSafety.owner===contents)audioOutputSafety.release()});
    contents.on('render-process-gone',()=>releaseOutputOwner(ownerId));
    contents.on('did-start-navigation',(_event,_url,inPlace,mainFrame)=>{if(mainFrame&&!inPlace)releaseOutputOwner(ownerId)});
  }
  if(enabled){let owned=outputLeaseOwners.get(contents.id);if(!owned)outputLeaseOwners.set(contents.id,owned=new Set());owned.add(id);audioOutputMonitor.acquire(id);return audioOutputMonitor.get();}
  outputLeaseOwners.get(contents.id)?.delete(id);audioOutputMonitor.release(id);return {ok:true};
}
audioOutputMonitor.on('change',value=>{
  for(const window of BrowserWindow.getAllWindows()){
    if(window.isDestroyed())continue;
    const contents=window.webContents;
    if(contents&&!contents.isDestroyed()&&secureProtocols.isTrustedRendererUrl(contents.getURL()))
      contents.send('lx-audio-output-changed',value);
  }
});
const { SongInfoProviderRegistry } = require("./song-info/provider-registry");
const { SongInfoQueryCache } = require("./song-info/query-cache");
const { SongInfoCacheMaintenance } = require("./song-info/cache-maintenance");
const { createMusicBrainzProvider } = require("./song-info/musicbrainz-provider");
const { createItunesProvider } = require("./song-info/itunes-provider");
const { createMusicPlatformProvider } = require("./song-info/music-platform-provider");
const { SongInfoService } = require("./song-info/song-info-service");
const { CoverArtAssetStore } = require("./song-info/cover-art-asset-store");
const { BatchSongInfoTaskManager } = require("./song-info/batch-task-manager");
const { LyricSidecarStore } = require("./song-info/lyric-sidecar-store");
const { createLyricSidecarRecoveryGate } = require("./song-info/lyric-sidecar-recovery");
const { LyricSaveService } = require("./song-info/lyric-save-service");
const { lyricFileLocation } = require("./song-info/lyric-file-location");
const { createTagEditor } = require("./song-info/tag-editor");
const { LyricProviderRegistry } = require("./lyrics/provider-registry");
const { LyricLookupService } = require("./lyrics/lookup-service");
const { createLocalLibraryLyricProvider } = require("./lyrics/local-library-provider");
const { createLddcStrategyLyricProvider } = require("./lyrics/lddc-strategy-provider");
const { createMusicTagStrategyLyricProvider } = require("./lyrics/music-tag-strategy-provider");
secureProtocols.registerPrivilegedSchemes(protocol);
const lyricSidecarRecovery = createLyricSidecarRecoveryGate();
const CONTROL_HOST = "127.0.0.1";
const CONTROL_PORT = 3901;
const BACKEND_HOST = "127.0.0.1";
const BACKEND_PORT_IS_EXPLICIT = String(process.env.KUMIKO_BACKEND_PORT || "").trim().length > 0;
const parsedBackendPort = Number.parseInt(String(process.env.KUMIKO_BACKEND_PORT || "29613"), 10);
let BACKEND_PORT = Number.isInteger(parsedBackendPort) && parsedBackendPort >= 1024 && parsedBackendPort <= 65535
  ? parsedBackendPort
  : 29613;
let BACKEND_URL = `http://${BACKEND_HOST}:${BACKEND_PORT}`;
const BACKEND_SERVICE_ID = "kumiko-music-local";
const BACKEND_PROTOCOL_VERSION = 1;
const BACKEND_START_TIMEOUT_MS = 20000;
const BACKEND_MAX_RESTARTS = 2;
const isDev = !app.isPackaged;
const packagedSmokeArg = process.argv.find((item) => String(item || "").startsWith("--kumiko-smoke-result="));
const PACKAGED_SMOKE_RESULT_PATH = String(
  process.env.KUMIKO_SMOKE_RESULT_PATH
  || (packagedSmokeArg ? packagedSmokeArg.slice("--kumiko-smoke-result=".length) : ""),
).trim();
const IS_PACKAGED_SMOKE_TEST = process.env.KUMIKO_PACKAGED_SMOKE_TEST === "1" || !!packagedSmokeArg;
const APP_HOME = path.resolve(process.env.KUMIKO_APP_HOME || (isDev ? path.join(__dirname, "..") : path.dirname(process.execPath)));
let distribution={};try{distribution=JSON.parse(fs.readFileSync(path.join(APP_HOME,'distribution.json'),'utf8'));}catch{}
const DATA_DIR = require('./data-layout').resolveDataDir(APP_HOME, {mode:distribution.mode, raw:process.env.KUMIKO_DATA_DIR});
const tracePersistence = require("./trace-persistence").createTracePersistence(path.join(DATA_DIR, "library", "listening-traces"));
const CONFIG_DIR = path.join(DATA_DIR, "config");
const officialCatalog = JSON.parse(JSON.stringify(require('./official-modules/catalog.json')));
if(distribution.officialPackages==='bundled')for(const item of Object.values(officialCatalog.packages))for(const release of item.releases)delete release.url;
const dataLayout = require('./data-layout').dataLayout(DATA_DIR);
const LISTENING_CONFIG_DIR = dataLayout.history;
const existingFeatureProfile = require('./feature-profile').isExistingProfile(DATA_DIR);
const officialPackages = require('./official-package-store').createOfficialPackageStore({
  directory:dataLayout.packages,catalog:officialCatalog,adoptLegacy:existingFeatureProfile,
  bundleSource:(id,version)=>{
    const release=officialCatalog.packages[id]?.releases.find(row=>row.version===version);
    if(!release)throw Error('缺少官方功能包版本。');
    return fs.readFileSync(path.join(__dirname,'official-modules','packages',release.bundle));
  },
});
const featureSelection = require('./feature-selection').createFeatureSelection(path.join(CONFIG_DIR, 'features.json'),{
  initialEnabled:existingFeatureProfile,
  available:id=>officialPackages.hasActive(id),
});
const resourceManager=new (require('./resource-manager').ResourceManager)(APP_HOME,{dataDir:DATA_DIR});
function featureSnapshot(){
  const selection=featureSelection.snapshot(),packages=officialPackages.snapshot();
  return {...selection,packages,resources:resourceManager.snapshot(),installation:officialModuleOperation?.progress||null,restartRequired:selection.restartRequired||Object.values(packages).some(value=>value?.restartRequired)};
}
let officialModuleOperation = null;
const startupBackground = new (require('./startup-background').StartupBackgroundStore)(path.join(CONFIG_DIR, 'appearance'));
let startupBackgroundBusy = false;
const CACHE_DIR = path.join(DATA_DIR, "cache");
const LOG_DIR = path.join(DATA_DIR, "logs");
const DOWNLOAD_DIR = path.join(DATA_DIR, "downloads");
const ONLINE_SOURCE_DIR = path.join(DATA_DIR, "online-sources");
const ELECTRON_USER_DATA_DIR = path.join(DATA_DIR, "electron");
const ELECTRON_SESSION_DATA_DIR = path.join(CACHE_DIR, "electron-session");
const ELECTRON_CRASH_DIR = path.join(LOG_DIR, "crashes");
process.env.KUMIKO_APP_HOME = APP_HOME;
process.env.KUMIKO_DATA_DIR = DATA_DIR;
process.env.KUMIKO_CONFIG_DIR = CONFIG_DIR;
process.env.KUMIKO_CACHE_DIR = CACHE_DIR;
process.env.KUMIKO_LOG_DIR = LOG_DIR;
fs.mkdirSync(CONFIG_DIR, { recursive: true });
fs.mkdirSync(CACHE_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
fs.mkdirSync(ONLINE_SOURCE_DIR, { recursive: true });
fs.mkdirSync(ELECTRON_USER_DATA_DIR, { recursive: true });
fs.mkdirSync(ELECTRON_SESSION_DATA_DIR, { recursive: true });
fs.mkdirSync(ELECTRON_CRASH_DIR, { recursive: true });
configurePortableElectronRuntime();
const metadata = require("./metadata-service");
const songInfoQueryCache = new SongInfoQueryCache({
  filePath: path.join(CACHE_DIR, "song-info", "queries.json"),
});
const songInfoRegistry = new SongInfoProviderRegistry({
  cache: songInfoQueryCache,
  onDiagnostic: ({ provider, error }) => {
    console.warn("[song-info] provider failed", {
      provider,
      code: String(error?.code || ""),
      status: Number(error?.status || error?.response?.status || 0),
    });
  },
});
songInfoRegistry.register(createMusicBrainzProvider({
  userAgent: `Flowave/${app.getVersion()} (https://github.com/nadeshikochan/Flowave)`,
}));
songInfoRegistry.register(createItunesProvider({ countries: ["CN", "US", "JP"] }));
for (const source of ["wy", "tx", "kg", "kw"]) {
  songInfoRegistry.register(createMusicPlatformProvider({ source, searchMusic: onlineProviders.searchMusic }));
}
const tagEditor = createTagEditor({
  request: async (action, payload) => {
    try { return (await axios.post(`${BACKEND_URL}/tracks/tags/${action}`, payload, { timeout: 0 })).data; }
    catch (error) { throw new Error(error.response?.status === 404 ? "后台版本尚不支持资料保存，请退出软件后重新启动当前版本" : String(error.response?.data?.detail || "资料保存服务暂时不可用")); }
  },
  onChanged: (trackPath, resourceId) => metadata.invalidateTrackMetadata({ trackPath, resourceId }),
  onResult: result => { if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("lx-song-tags-updated", result); },
});
const songInfoService = new SongInfoService({
  registry: songInfoRegistry,
  getMeta: (trackPath) => metadata.getMeta(trackPath),
});
const lyricQueryCache = new SongInfoQueryCache({
  filePath: path.join(CACHE_DIR, "song-info", "lyric-queries.json"),
});
const lyricSidecarStore = new LyricSidecarStore({
  snapshotRoot: path.join(CONFIG_DIR, "song-info", "lyric-sidecar-transactions"),
  resolveAudioRoot: audioPath => loadLibraryAudioRoot(audioPath),
});
const lyricProviderRegistry = new LyricProviderRegistry({
  cache: lyricQueryCache,
  onDiagnostic: ({ provider, error }) => {
    console.warn("[lyrics] provider failed", {
      provider,
      code: String(error?.code || ""),
      status: Number(error?.status || error?.response?.status || 0),
    });
  },
});
lyricProviderRegistry.register(createLddcStrategyLyricProvider({
  searchMusic: onlineProviders.searchMusic,
  getLyric: onlineProviders.getLyric,
}));
lyricProviderRegistry.register(createMusicTagStrategyLyricProvider({
  searchMusic: onlineProviders.searchMusic,
  getLyric: onlineProviders.getLyric,
}));
lyricProviderRegistry.register(createLocalLibraryLyricProvider({
  resolve: ({ trackPath, evidence, sources }) => {
    metadata.setLibraryAudioRoot(loadLibraryAudioRoots());
    return metadata.resolveLocalLyricsForLookup(trackPath, evidence, { sources });
  },
}), { allowLocalContext: true });
// 公网歌词来源须完成服务、缓存与保存三项审核后才能在此注册。
const lyricLookupService = new LyricLookupService({
  registry: lyricProviderRegistry,
  getMeta: (trackPath) => {
    metadata.setLibraryAudioRoot(loadLibraryAudioRoots());
    return metadata.getMeta(trackPath);
  },
  inspectSidecar: (trackPath) => lyricSidecarStore.inspect(trackPath),
});
const coverArtAssetStore = new CoverArtAssetStore({
  rootDir: path.join(CACHE_DIR, "song-info", "assets"),
});
const songInfoCacheMaintenance = new SongInfoCacheMaintenance({
  queryCaches: [songInfoQueryCache, lyricQueryCache],
  coverAssetStore: coverArtAssetStore,
});
const lyricSaveService = new LyricSaveService({
  store: lyricSidecarStore,
  onChanged: async (trackPath, resourceId) => {
    await metadata.invalidateLyricSources(trackPath, resourceId);
  },
});
const coverAssetControllers = new Map();
const batchSongInfoTasks = new BatchSongInfoTaskManager({
  filePath: path.join(CONFIG_DIR, "song-info", "tasks.json"),
  queryTrack: async ({ signal, ...payload }) => {
    if (signal?.aborted) {
      const error = new Error("batch query aborted");
      error.name = "AbortError";
      error.code = "ABORTED";
      throw error;
    }
    const cancel = () => songInfoService.cancel(payload.requestId);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await songInfoService.query({ ...payload, locale: "zh-CN" });
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  },
  queryLyrics: async ({ signal, ...payload }) => {
    if (signal?.aborted) {
      const error = new Error("batch lyric query aborted");
      error.name = "AbortError";
      error.code = "ABORTED";
      throw error;
    }
    const cancel = () => lyricLookupService.cancel(payload.requestId);
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await lyricLookupService.query({ ...payload, locale: "zh-CN" });
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  },
  saveLyrics: async ({
    requestId,
    track,
    result,
    candidateId,
    includeTranslation,
    includeRomanization,
    format,
    replaceExisting,
  }) => {
    const staged = lyricSaveService.stageQueryResult({
      requestId,
      trackPath: track?.path,
      resourceId: track?.resourceId,
      result,
      isSaveApproved: (providerId) => lyricProviderRegistry.canSave(providerId),
    });
    try {
      const selected = (Array.isArray(staged?.candidates) ? staged.candidates : []).find((item) => (
        String(item?.candidate?.candidateId || "") === String(candidateId || "")
      ));
      if (!selected?.lyricSaveToken) {
        return { ok: false, code: "LYRIC_SAVE_NOT_APPROVED" };
      }
      const prepared = await lyricSaveService.prepare({
        candidateToken: selected.lyricSaveToken,
        includeTranslation,
        includeRomanization,
        format,
      });
      return await lyricSaveService.commit({
        confirmationId: prepared.confirmationId,
        replaceExisting: Boolean(replaceExisting),
      });
    } finally {
      lyricSaveService.cancelStagedRequest(requestId);
    }
  },
  cancelQuery: (requestId, mode) => (
    mode === "lyric-sidecar"
      ? lyricLookupService.cancel(requestId)
      : songInfoService.cancel(requestId)
  ),
  onUpdate: (update) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("lx-song-info-batch-updated", update);
    }
  },
});
const onlineSourceRuntime = require("./online/source-runtime");
const DEFAULT_SHORTCUTS = {
  next_like: { accelerator: "Control+Right", scope: "global", label: "相似下一首" },
  prev: { accelerator: "Control+Left", scope: "global", label: "上一首" },
  vol_up: { accelerator: "Control+Up", scope: "global", label: "增大音量" },
  vol_down: { accelerator: "Control+Down", scope: "global", label: "减小音量" },
  toggle_desktop_lyric: { accelerator: "Control+Alt+Down", scope: "global", label: "切换桌面歌词" },
  favorite: { accelerator: "Control+Alt+0", scope: "global", label: "收藏" },
  play_pause: { accelerator: "Control+Space", scope: "global", label: "播放/暂停" },
  dislike_next: { accelerator: "Control+num0", scope: "global", label: "换个感觉" },
  locate_current: { accelerator: "Control+L", scope: "window", label: "定位当前歌曲" },
  open_search: { accelerator: "Control+F", scope: "window", label: "打开搜索" },
};
const DEFAULT_LYRIC_OVERLAY_CONFIG = {
  bounds: { x: 288, y: 0, width: 1090, height: 214 },
  settings: {
    locked: true,
    fontSize: 62,
    mainFontSize: 62,
    subFontSize: 34,
    opacity: 0.86,
    strokeStrength: 0.5,
    currentOnly: true,
    activeColor: "#60a9e1",
    inactiveColor: "#d5d9dc",
    metaColor: "#3e4347",
    fontFamily: "PingFang SC",
    switchScrollMs: 120,
  },
  locked: true,
};
const DEFAULT_MAIN_WINDOW_CONFIG = {
  bounds: { x: 115, y: 170, width: 1201, height: 801 },
  maximized: false,
};
const DEFAULT_LYRIC_SOURCE_CONFIG = {
  externalLyricDir: "",
};
let rendererState = loadRendererStateConfig();
let persistedRendererState = rendererState;
const rendererStateWriter = createCoalescedWriter(async (snapshot) => {
  await writeJsonObjectAtomic(getRendererStateConfigPath(), snapshot);
  persistedRendererState = snapshot;
});
const traceArchive = require('./trace-archive').createTraceArchive({
  directory: path.join(DATA_DIR, 'library', 'listening-traces'),
  getState: () => rendererState, setState: value => { rendererState = value; },
  saveState: saveRendererStateConfig, flushState: () => rendererStateWriter.flush(), journal: tracePersistence,
  request: async payload => {
    try { return (await axios.post(`${BACKEND_URL}/listening-traces/view`, payload, {timeout: 30000})).data; }
    catch (error) {
      const detail = error.response?.data?.detail;
      const failure = new Error(detail?.message || (typeof detail === 'string' ? detail : '轨迹服务暂时不可用，请重试'));
      failure.code = detail?.code || 'TRACE_SERVICE_UNAVAILABLE'; throw failure;
    }
  },
});
let listeningHistoryRecoveryState = {
  state: "primary",
  recovered: false,
  writeBlocked: false,
};
let listeningHistoryState = featureSelection.active.enabled.history || featureSelection.active.enabled.recommendation
  ? loadListeningHistoryConfig() : {};
const listeningHistoryPersistence = require("./history-persistence").createHistoryPersistence({
  initial: listeningHistoryState,
  write: history => saveListeningHistoryConfig(history),
  operate: (history, kind, revision) => performListeningHistoryOperation(kind, history, revision),
});
const HOTKEY_ACTION_WHITELIST = new Set([
  "next_like",
  "toggle_lyric",
  "open_search",
  "locate_current",
  "play",
  "pause",
  "stop",
  "prev",
  "vol_up",
  "vol_down",
  "toggle_desktop_lyric",
  "favorite",
  "play_pause",
  "dislike_next",
]);

let mainWindow = null;
let lyricOverlayWindow = null;
let lyricOverlayState = cloneJson(DEFAULT_LYRIC_OVERLAY_CONFIG);
let lyricOverlaySaveTimer = null;
let mainWindowSaveTimer = null;
let shortcutConfig = loadShortcutConfig();
let shortcutStatus = {};
let mediaSessionAvailable = null;
let controlServer = null;
let backendProc = null;
let backendReady = false;
let backendRestartAttempts = 0;
let backendRestartTimer = null;
let backendRestartResetTimer = null;
let backendStartPromise = null;
let appIsQuitting = false;
let quitCleanupPromise = null;
let quitCleanupFinished = false;
let lyricSourceConfig = loadLyricSourceConfig();
const pendingControlRequests = new Map();
const MEDIA_DIAG_MAX = 200;
let mediaDiagSeq = 0;
const mediaDiagEvents = [];
const { MediaInputCoordinator } = require('./media-input');
const mediaInput = new MediaInputCoordinator({ deliver(action, source) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  pushMediaDiag('media_input_accepted', { action, source });
  mainWindow.webContents.send('hotkey', action);
} });
let audioFocusWatcherProc = null;
let audioFocusWatcherAvailable = false;
lyricOverlayState = { ...lyricOverlayState, ...loadLyricOverlayConfig() };
let mainWindowState = loadMainWindowConfig();
metadata.setExternalLyricRoot(lyricSourceConfig.externalLyricDir);
metadata.setLibraryAudioRoot(loadLibraryAudioRoots());

function writePackagedSmokeStage(stage, extra = {}) {
  if (!IS_PACKAGED_SMOKE_TEST || !PACKAGED_SMOKE_RESULT_PATH) return;
  try {
    fs.writeFileSync(PACKAGED_SMOKE_RESULT_PATH, JSON.stringify({
      ok: false,
      stage: String(stage || "unknown"),
      pid: process.pid,
      ...extra,
    }, null, 2), "utf-8");
  } catch (error) {
    console.warn("[smoke] cannot write stage:", error?.message || error);
  }
}

function nextMediaDiagRequestId() {
  return `${Date.now().toString(36)}-${(mediaDiagSeq += 1).toString(36)}`;
}

function pushMediaDiag(type, payload = {}) {
  const event = {
    id: nextMediaDiagRequestId(),
    ts: Date.now(),
    type: String(type || "unknown"),
    ...payload,
  };
  mediaDiagEvents.push(event);
  if (mediaDiagEvents.length > MEDIA_DIAG_MAX) {
    mediaDiagEvents.splice(0, mediaDiagEvents.length - MEDIA_DIAG_MAX);
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("lx-media-diag", event);
  }
  return event;
}

audioOutputMonitor.on('wear-state', value => {
  // Keep hardware addresses and raw vendor payloads out of renderer diagnostics.
  pushMediaDiag('headphone_wear', { status: value.status, worn: value.worn });
});

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function cloneSerializableJson(value) {
  try {
    const cloned = JSON.parse(JSON.stringify(value || {}));
    return cloned && typeof cloned === "object" ? cloned : {};
  } catch {
    return {};
  }
}

function readJsonFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback === null ? null : cloneJson(fallback);
    const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return raw && typeof raw === "object" ? raw : (fallback === null ? null : cloneJson(fallback));
  } catch {
    return fallback === null ? null : cloneJson(fallback);
  }
}

function resolvePackagePathOrDefault(raw, fallback) {
  const candidate = path.resolve(String(raw || "").trim() || fallback);
  const rel = path.relative(APP_HOME, candidate);
  if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return candidate;
  }
  return fallback;
}

function configurePortableElectronRuntime() {
  try {
    app.setPath("userData", ELECTRON_USER_DATA_DIR);
    app.setPath("sessionData", ELECTRON_SESSION_DATA_DIR);
    app.setPath("crashDumps", ELECTRON_CRASH_DIR);
  } catch (e) {
    console.warn("[runtime] configure portable electron paths failed:", e?.message || e);
  }
}

function getMediaDiagSnapshot() {
  return {
    events: mediaDiagEvents.slice(-MEDIA_DIAG_MAX),
    shortcuts: getShortcutPayload(),
    audioFocusWatcherAvailable: !!audioFocusWatcherAvailable,
  };
}

function emitAudioFocusEvent(kind, payload = {}) {
  const evt = { kind: String(kind || "").trim(), ts: Date.now(), ...payload };
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("lx-audio-focus-event", evt);
  }
  pushMediaDiag("audio_focus_event", evt);
}

function getAudioFocusWatcherScriptPath() {
  return path.join(__dirname, "tools", "audio-focus-watcher", "watch.ps1");
}

function startAudioFocusWatcher() {
  if (audioFocusWatcherProc) return;
  const script = getAudioFocusWatcherScriptPath();
  if (!fs.existsSync(script)) {
    audioFocusWatcherAvailable = false;
    pushMediaDiag("audio_focus_watcher_unavailable", { reason: "script-missing", script });
    return;
  }
  try {
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    audioFocusWatcherProc = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      const text = String(chunk || "");
      text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).forEach((line) => {
        let evt = null;
        try {
          evt = JSON.parse(line);
        } catch {
          pushMediaDiag("audio_focus_watcher_stdout", { raw: line });
          return;
        }
        const kind = String(evt?.kind || "").toLowerCase();
        if (kind === "ready") {
          audioFocusWatcherAvailable = true;
          pushMediaDiag("audio_focus_watcher_ready", { raw: evt });
          return;
        }
        if (kind === "interrupt-start" || kind === "interrupt-end") {
          emitAudioFocusEvent(kind, evt);
          return;
        }
        pushMediaDiag("audio_focus_watcher_event", { raw: evt });
      });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      pushMediaDiag("audio_focus_watcher_stderr", { raw: String(chunk || "").trim() });
    });
    child.on("exit", (code, signal) => {
      audioFocusWatcherProc = null;
      audioFocusWatcherAvailable = false;
      pushMediaDiag("audio_focus_watcher_exit", { code, signal });
    });
  } catch (e) {
    audioFocusWatcherAvailable = false;
    pushMediaDiag("audio_focus_watcher_error", { error: String(e?.message || e || "") });
  }
}

function stopAudioFocusWatcher() {
  if (!audioFocusWatcherProc) return;
  try {
    audioFocusWatcherProc.kill();
  } catch {
    // ignore
  }
  audioFocusWatcherProc = null;
  audioFocusWatcherAvailable = false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBackendHealth(timeout = 900, baseUrl = BACKEND_URL) {
  try {
    const response = await axios.get(`${baseUrl}/health`, {
      timeout,
      validateStatus: () => true,
      proxy: false,
    });
    if (response.status !== 200 || !response.data || typeof response.data !== "object") {
      return { reachable: true, valid: false, detail: `HTTP ${response.status}` };
    }
    const validation = backendHealth.validateBackendHealth(response.data, {
      serviceId: BACKEND_SERVICE_ID,
      protocolVersion: BACKEND_PROTOCOL_VERSION,
      dataDir: DATA_DIR,
      featureSignature: featureSelection.signature,
    });
    return {
      reachable: true,
      valid: validation.valid,
      detail: validation.detail,
      health: response.data,
    };
  } catch (error) {
    const code = String(error?.code || "");
    if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(code)) {
      return { reachable: false, valid: false, detail: code };
    }
    return { reachable: false, valid: false, detail: String(error?.message || error) };
  }
}

function canBindBackendPort(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen({ host: BACKEND_HOST, port, exclusive: true }, () => {
      probe.close(() => resolve(true));
    });
  });
}

async function selectBackendEndpoint() {
  if (BACKEND_PORT_IS_EXPLICIT) return;
  const preferred = BACKEND_PORT;
  for (let offset = 0; offset <= 20; offset += 1) {
    const port = preferred + offset;
    if (port > 65535) break;
    const url = `http://${BACKEND_HOST}:${port}`;
    const existing = await readBackendHealth(300, url);
    if (existing.valid || (!existing.reachable && await canBindBackendPort(port))) {
      BACKEND_PORT = port;
      BACKEND_URL = url;
      if (offset > 0) {
        console.warn(`[backend] preferred port ${preferred} unavailable; using ${port}`);
      }
      return;
    }
  }
  throw new Error(`本机端口 ${preferred}-${Math.min(65535, preferred + 20)} 均不可用`);
}

async function waitForBackendReady(timeoutMs = BACKEND_START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await readBackendHealth();
    if (status.valid) return status.health;
    if (status.reachable && !status.valid) {
      throw new Error(`端口 ${BACKEND_PORT} 已被其他服务占用（${status.detail}）`);
    }
    if (!backendProc || backendProc.exitCode !== null) {
      throw new Error(`本机推荐服务已退出，退出码 ${backendProc?.exitCode ?? "unknown"}`);
    }
    await sleep(250);
  }
  throw new Error(`本机推荐服务启动超时（${Math.round(timeoutMs / 1000)} 秒）`);
}

async function startBackendServer() {
  if (backendStartPromise) return backendStartPromise;
  backendStartPromise = startBackendServerInner();
  try {
    return await backendStartPromise;
  } finally {
    backendStartPromise = null;
  }
}

async function startBackendServerInner() {
  await selectBackendEndpoint();
  const existing = await readBackendHealth();
  if (existing.valid) {
    backendReady = true;
    console.info(`[backend] reuse verified local service pid=${existing.health?.api_pid || "unknown"}`);
    return existing.health;
  }
  if (existing.reachable) {
    throw new Error(`端口 ${BACKEND_PORT} 已被其他服务占用，请关闭占用程序后重试`);
  }
  if (process.env.KUMIKO_SKIP_BACKEND_START === "1") {
    throw new Error(`已禁止自动启动后端，且 ${BACKEND_URL} 没有可用服务`);
  }
  if (backendProc) {
    return waitForBackendReady();
  }
  const apiExe = path.join(APP_HOME, "backend", "api.exe");
  const env = {
    ...process.env,
    KUMIKO_APP_HOME: APP_HOME,
    KUMIKO_DATA_DIR: DATA_DIR,
    FLOWAVE_FEATURES_SNAPSHOT: JSON.stringify(featureSelection.active),
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
  let cmd = apiExe;
  let args = ["--host", BACKEND_HOST, "--port", String(BACKEND_PORT)];
  if (!fs.existsSync(apiExe)) {
    cmd = process.env.KUMIKO_PYTHON || "python";
    args = ["-m", "uvicorn", "api:app", "--host", BACKEND_HOST, "--port", String(BACKEND_PORT), "--workers", "1"];
  }
  try {
    const child = spawn(cmd, args, {
      cwd: APP_HOME,
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    backendProc = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      String(chunk || "").split(/\r?\n/).filter(Boolean).forEach((line) => console.log(`[backend] ${line}`));
    });
    child.stderr.on("data", (chunk) => {
      String(chunk || "").split(/\r?\n/).filter(Boolean).forEach((line) => console.warn(`[backend] ${line}`));
    });
    child.on("exit", (code, signal) => {
      console.warn(`[backend] exit code=${code} signal=${signal || ""}`);
      if (backendProc === child) backendProc = null;
      const wasReady = backendReady;
      const shouldRecover = wasReady && !appIsQuitting && backendRestartAttempts < BACKEND_MAX_RESTARTS;
      backendReady = false;
      if (shouldRecover) {
        backendRestartAttempts += 1;
        if (backendRestartTimer) clearTimeout(backendRestartTimer);
        backendRestartTimer = setTimeout(() => {
          backendRestartTimer = null;
          if (appIsQuitting) return;
          startBackendServer().then(() => {
            console.info(`[backend] restart succeeded attempt=${backendRestartAttempts}`);
          }).catch((error) => {
            console.warn(`[backend] restart failed attempt=${backendRestartAttempts}:`, error?.message || error);
            if (backendRestartAttempts >= BACKEND_MAX_RESTARTS) {
              showBackendFailure(`本机推荐服务连续退出，已停止自动重启。\n\n${error?.message || error}`);
            }
          });
        }, 800);
      } else if (wasReady && !appIsQuitting) {
        showBackendFailure("本机推荐服务已退出。请重启软件；若问题持续，请导出诊断日志。");
      }
    });
    const health = await waitForBackendReady();
    backendReady = true;
    if (backendRestartAttempts > 0) {
      if (backendRestartResetTimer) clearTimeout(backendRestartResetTimer);
      backendRestartResetTimer = setTimeout(() => {
        backendRestartResetTimer = null;
        if (backendProc === child && backendReady && child.exitCode === null) {
          backendRestartAttempts = 0;
          console.info("[backend] restart budget reset after stable run");
        }
      }, 60000);
    }
    return health;
  } catch (e) {
    if (backendProc) {
      try {
        backendProc.kill();
      } catch {
        // ignore
      }
    }
    backendProc = null;
    backendReady = false;
    console.warn("[backend] start failed:", e?.message || e);
    throw e;
  }
}

function stopBackendServer() {
  backendReady = false;
  if (backendRestartTimer) {
    clearTimeout(backendRestartTimer);
    backendRestartTimer = null;
  }
  if (backendRestartResetTimer) {
    clearTimeout(backendRestartResetTimer);
    backendRestartResetTimer = null;
  }
  if (!backendProc) return;
  try {
    if (process.platform === "win32" && backendProc.pid) {
      spawnSync("taskkill.exe", ["/PID", String(backendProc.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      backendProc.kill();
    }
  } catch {
    try {
      backendProc.kill();
    } catch {
      // ignore
    }
  }
  backendProc = null;
}

function showBackendFailure(message) {
  const raw = String(message || "");
  console.error("本机服务启动失败", raw);
  let detail = "请重启 Flowave。若问题持续，请检查程序数据目录中的日志。";
  if (/端口|占用/.test(raw)) {
    detail = "本机服务端口被占用。请关闭冲突程序后重试。";
  } else if (/超时/.test(raw)) {
    detail = "本机服务启动超时。请重启 Flowave。";
  } else if (/退出/.test(raw)) {
    detail = "本机服务意外退出。请重启 Flowave；若问题持续，请检查程序数据目录中的日志。";
  }
  const options = {
    type: "error",
    title: "Flowave 启动失败",
    message: "本机服务未能启动",
    detail,
    buttons: ["知道了"],
    noLink: true,
  };
  if (app.isReady()) {
    dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : null, options).catch(() => {});
  }
}

function schedulePackagedSmokeTest() {
  if (!IS_PACKAGED_SMOKE_TEST) return;
  const resultPath = PACKAGED_SMOKE_RESULT_PATH;
  setTimeout(async () => {
    const payload = {
      ok: false,
      packaged: app.isPackaged,
      backendEndpoint: BACKEND_URL,
      backend: null,
      rendererErrors: [],
      playback: null,
      error: "",
    };
    try {
      const status = await readBackendHealth(2000);
      payload.backend = status.health || status;
      if (!status.valid) throw new Error(`本机服务连接失败：${status.detail || "未知错误"}`);
      if (!mainWindow || mainWindow.isDestroyed()) throw new Error("主窗口未创建");
      payload.rendererErrors = await mainWindow.webContents.executeJavaScript(
        "Array.isArray(window.__kumikoErrors) ? window.__kumikoErrors : []",
        true,
      );
      if (payload.rendererErrors.length) {
        throw new Error(`渲染层出现 ${payload.rendererErrors.length} 个错误`);
      }
      const goodAudioPath = String(process.env.KUMIKO_SMOKE_GOOD_AUDIO_PATH || "").trim();
      const badAudioPath = String(process.env.KUMIKO_SMOKE_BAD_AUDIO_PATH || "").trim();
      if (goodAudioPath || badAudioPath) {
        if (!goodAudioPath || !badAudioPath) {
          throw new Error("播放冒烟需要同时提供正常和损坏音频路径");
        }
        const playbackScript = `
          (async () => {
            const container = document.querySelector("#app");
            const vm = window.__kumikoApp || container?.__vue_app__?._instance?.proxy;
            if (!vm || typeof vm.playByPath !== "function") {
              throw new Error("无法取得播放器实例");
            }
            const goodPath = ${JSON.stringify(goodAudioPath)};
            const badPath = ${JSON.stringify(badAudioPath)};
            const good = await vm.playByPath(goodPath, true, "smoke");
            await new Promise((resolve) => setTimeout(resolve, 650));
            const beforeFailure = {
              path: String(vm.currentPath || ""),
              time: Number(vm.currentTime || 0),
              playing: !!vm.isPlaying,
            };
            const bad = await vm.playByPath(badPath, true, "smoke");
            const stored = window.lxEnv?.getRendererStateSync?.() || {};
            const history = Array.isArray(vm.playHistory) ? [...vm.playHistory] : [];
            const afterFailure = {
              path: String(vm.currentPath || ""),
              time: Number(vm.currentTime || 0),
              playing: !!vm.isPlaying,
              lastTrack: String(stored["lx-last-track"] || ""),
              history,
              pending: vm.pendingPlaybackTransition
                ? {
                  generation: Number(vm.pendingPlaybackTransition.generation || 0),
                  phase: String(vm.pendingPlaybackTransition.phase || ""),
                }
                : null,
            };
            vm.pauseByInternal("packaged-smoke:done");
            const ok = !!good?.ok
              && !bad?.ok
              && !bad?.canceled
              && beforeFailure.path === goodPath
              && beforeFailure.playing
              && afterFailure.path === goodPath
              && afterFailure.lastTrack === goodPath
              && !afterFailure.history.includes(badPath)
              && !afterFailure.pending;
            return { ok, good, bad, beforeFailure, afterFailure };
          })()
        `;
        payload.playback = await mainWindow.webContents.executeJavaScript(playbackScript, true);
        if (!payload.playback?.ok) {
          throw new Error("真实音频播放事务冒烟失败");
        }
      }
      payload.ok = true;
    } catch (error) {
      payload.error = String(error?.stack || error?.message || error);
    }
    if (resultPath) {
      try {
        fs.writeFileSync(resultPath, JSON.stringify(payload, null, 2), "utf-8");
      } catch (error) {
        console.warn("[smoke] cannot write result:", error?.message || error);
      }
    }
    console.info(payload.ok ? "PACKAGED_APP_SMOKE_TEST_OK" : "PACKAGED_APP_SMOKE_TEST_FAILED");
    app.quit();
  }, 5000);
}

writePackagedSmokeStage("main-loaded");

function hardenRendererNavigation(win) {
  if (!win || win.isDestroyed()) return;
  win.webContents.on("will-navigate", (event, targetUrl) => {
    if (!secureProtocols.isTrustedRendererUrl(targetUrl)) {
      event.preventDefault();
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
}

function createWindow() {
  const savedBounds = normalizeMainWindowBounds(mainWindowState?.bounds || null);
const win = new BrowserWindow({
    width: Number(savedBounds?.width) || 1200,
    height: Number(savedBounds?.height) || 800,
    x: Number.isFinite(savedBounds?.x) ? savedBounds.x : undefined,
    y: Number.isFinite(savedBounds?.y) ? savedBounds.y : undefined,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: "#121212",
    title: "Flowave",
    icon: path.join(__dirname, "renderer", "assets", "app-icon.ico"),
    frame: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  hardenRendererNavigation(win);

  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    const prefix = level >= 2 ? "warn" : "log";
    console[prefix](`[renderer] ${message} (${sourceId}:${line})`);
  });
  win.setMenuBarVisibility(false);
  win.webContents.on("did-finish-load", () => {
    console.info(`[renderer] did-finish-load url=${win.webContents.getURL()}`);
    writePackagedSmokeStage("renderer-loaded", {
      url: win.webContents.getURL(),
    });
  });
  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
    console.warn(`[renderer] did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
  });
  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    console.warn(`[renderer] preload-error path=${preloadPath} error=${error?.stack || error?.message || error}`);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    console.warn("[renderer] render-process-gone", details);
  });
  win.webContents.on("unresponsive", () => {
    console.warn("[renderer] unresponsive");
  });
  win.webContents.on("responsive", () => {
    console.info("[renderer] responsive");
  });

  win.loadURL(`${secureProtocols.APP_ORIGIN}/index.html`);

  if (isDev && process.env.KUMIKO_OPEN_DEVTOOLS === "1") {
    win.webContents.openDevTools({ mode: "detach" });
  }
  if (mainWindowState?.maximized) {
    win.maximize();
  }
  win.on("move", scheduleSaveMainWindowConfig);
  win.on("resize", scheduleSaveMainWindowConfig);
  win.on("maximize", scheduleSaveMainWindowConfig);
  win.on("unmaximize", scheduleSaveMainWindowConfig);
  win.on("close", event => {
    saveMainWindowConfig();
    if (!quitCleanupFinished) { event.preventDefault(); app.quit(); }
  });
  win.on("closed", () => {
    // The native window is already closed; do not query bounds here.
    mainWindow = null;
    if (lyricOverlayWindow && !lyricOverlayWindow.isDestroyed()) {
      lyricOverlayWindow.close();
    }
  });
  mainWindow = win;
  registerAllShortcuts(win);
  bindWindowShortcutEvents(win);
  ensureControlServer();
}

function createLyricOverlayWindow() {
  if (lyricOverlayWindow && !lyricOverlayWindow.isDestroyed()) {
    return lyricOverlayWindow;
  }
  const savedBounds = lyricOverlayState.bounds || {};
  lyricOverlayWindow = new BrowserWindow({
    width: Number(savedBounds.width) || 760,
    height: Number(savedBounds.height) || 200,
    x: Number.isFinite(savedBounds.x) ? savedBounds.x : undefined,
    y: Number.isFinite(savedBounds.y) ? savedBounds.y : undefined,
    minWidth: 360,
    minHeight: 110,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    thickFrame: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "overlay-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  hardenRendererNavigation(lyricOverlayWindow);
  lyricOverlayWindow.setAlwaysOnTop(true, "screen-saver");
  lyricOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  lyricOverlayWindow.setContentProtection(true);
  bindWindowShortcutEvents(lyricOverlayWindow);
  lyricOverlayWindow.loadURL(`${secureProtocols.APP_ORIGIN}/overlay.html`);
  lyricOverlayWindow.webContents.on("did-finish-load", () => {
    if (!lyricOverlayWindow || lyricOverlayWindow.isDestroyed()) return;
    lyricOverlayWindow.webContents.send("lx-lyric-overlay-settings", {
      ...lyricOverlayState.settings,
      locked: lyricOverlayState.locked,
    });
  });
  lyricOverlayWindow.on("closed", () => {
    scheduleSaveLyricOverlayConfig();
    lyricOverlayWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("lx-lyric-overlay-state", { open: false, locked: lyricOverlayState.locked });
    }
  });
  lyricOverlayWindow.on("move", scheduleSaveLyricOverlayConfig);
  lyricOverlayWindow.on("resize", scheduleSaveLyricOverlayConfig);
  applyLyricOverlayLock(lyricOverlayState.locked);
  return lyricOverlayWindow;
}

function scheduleSaveLyricOverlayConfig() {
  if (lyricOverlaySaveTimer) clearTimeout(lyricOverlaySaveTimer);
  lyricOverlaySaveTimer = setTimeout(() => {
    saveLyricOverlayConfig();
  }, 180);
}

function scheduleSaveMainWindowConfig() {
  if (mainWindowSaveTimer) clearTimeout(mainWindowSaveTimer);
  mainWindowSaveTimer = setTimeout(() => {
    saveMainWindowConfig();
  }, 180);
}

function normalizeMainWindowBounds(bounds) {
  if (!bounds || typeof bounds !== "object") return null;
  const width = Math.max(1100, Number(bounds.width) || 0);
  const height = Math.max(700, Number(bounds.height) || 0);
  const x = Number(bounds.x);
  const y = Number(bounds.y);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return { width, height };
  const displays = screen.getAllDisplays();
  const visible = displays.some((d) => {
    const wa = d.workArea;
    return x + width > wa.x && x < wa.x + wa.width && y + height > wa.y && y < wa.y + wa.height;
  });
  if (!visible) return { width, height };
  return { x, y, width, height };
}

function saveMainWindowConfig() {
  try {
    const configPath = getMainWindowConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    if (mainWindow && !mainWindow.isDestroyed()) {
      const maximized = mainWindow.isMaximized();
      const normalBounds = typeof mainWindow.getNormalBounds === "function" ? mainWindow.getNormalBounds() : mainWindow.getBounds();
      mainWindowState = {
        bounds: normalizeMainWindowBounds(normalBounds) || null,
        maximized,
      };
    }
    writeJsonFileAtomic(configPath, mainWindowState || {});
  } catch {
    // ignore
  }
}

function loadMainWindowConfig() {
  try {
    const configPath = getMainWindowConfigPath();
    if (!fs.existsSync(configPath)) return cloneJson(DEFAULT_MAIN_WINDOW_CONFIG);
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return {
      bounds: normalizeMainWindowBounds(raw?.bounds || null) || normalizeMainWindowBounds(DEFAULT_MAIN_WINDOW_CONFIG.bounds),
      maximized: Boolean(raw?.maximized),
    };
  } catch {
    return cloneJson(DEFAULT_MAIN_WINDOW_CONFIG);
  }
}

function saveLyricOverlayConfig() {
  try {
    const configPath = getLyricOverlayConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    if (lyricOverlayWindow && !lyricOverlayWindow.isDestroyed()) {
      lyricOverlayState.bounds = lyricOverlayWindow.getBounds();
    }
    writeJsonFileAtomic(configPath, {
      bounds: lyricOverlayState.bounds || null,
      settings: lyricOverlayState.settings || {},
      locked: !!lyricOverlayState.locked,
    });
  } catch {
    // ignore
  }
}

function loadLyricOverlayConfig() {
  try {
    const configPath = getLyricOverlayConfigPath();
    if (!fs.existsSync(configPath)) return cloneJson(DEFAULT_LYRIC_OVERLAY_CONFIG);
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return {
      bounds: raw?.bounds || cloneJson(DEFAULT_LYRIC_OVERLAY_CONFIG.bounds),
      settings: { ...DEFAULT_LYRIC_OVERLAY_CONFIG.settings, ...(raw?.settings || {}) },
      locked: typeof raw?.locked === "boolean" ? raw.locked : DEFAULT_LYRIC_OVERLAY_CONFIG.locked,
    };
  } catch {
    return cloneJson(DEFAULT_LYRIC_OVERLAY_CONFIG);
  }
}

function applyLyricOverlayLock(locked) {
  lyricOverlayState.locked = !!locked;
  scheduleSaveLyricOverlayConfig();
  if (!lyricOverlayWindow || lyricOverlayWindow.isDestroyed()) return;
  lyricOverlayWindow.setIgnoreMouseEvents(lyricOverlayState.locked, { forward: true });
  lyricOverlayWindow.webContents.send("lx-lyric-overlay-lock", { locked: lyricOverlayState.locked });
}

function pushLyricOverlaySettings(nextSettings) {
  lyricOverlayState.settings = { ...lyricOverlayState.settings, ...(nextSettings || {}) };
  scheduleSaveLyricOverlayConfig();
  if (!lyricOverlayWindow || lyricOverlayWindow.isDestroyed()) return;
  lyricOverlayWindow.webContents.send("lx-lyric-overlay-settings", {
    ...lyricOverlayState.settings,
    locked: lyricOverlayState.locked,
  });
}

function pushLyricOverlayUpdate(payload) {
  if (!lyricOverlayWindow || lyricOverlayWindow.isDestroyed()) return;
  lyricOverlayWindow.webContents.send("lx-lyric-overlay-update", payload || {});
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  try{await featureSelection.initialize();}catch(error){console.warn('[features] initial selection save deferred',error.code||'unavailable');}
  try{officialPackages.bootstrapLegacy();}catch(error){console.warn('[modules] registry initialization deferred',error.code||'unavailable');}
  try{officialPackages.collectUnused();}catch(error){console.warn('[modules] old package cleanup deferred',error.code||'unavailable');}
  writePackagedSmokeStage("when-ready");
  Menu.setApplicationMenu(null);
  secureProtocols.registerSecureProtocols({
    protocol,
    electronNet,
    rendererDir: path.join(__dirname, "renderer"),
    moduleAsset:url=>officialPackages.readAsset(url),
  });
  lyricSidecarRecovery.start({
    store: lyricSidecarStore,
    onDiagnostic: (summary) => {
      if (summary.conflict || summary.invalid || summary.failed) {
        console.warn("[lyrics] sidecar recovery", summary);
      } else {
        console.info("[lyrics] sidecar recovery", summary);
      }
    },
  });
  try {
    writePackagedSmokeStage("backend-starting");
    await startBackendServer();
    writePackagedSmokeStage("backend-ready");
  } catch (error) {
    writePackagedSmokeStage("backend-failed", {
      error: String(error?.stack || error?.message || error),
    });
    showBackendFailure(String(error?.message || error));
  }
  initOnlineSourceRuntime();
  writePackagedSmokeStage("online-runtime-ready");
  startAudioFocusWatcher();
  writePackagedSmokeStage("audio-watcher-started", {
    available: audioFocusWatcherAvailable,
  });
  createWindow();
  writePackagedSmokeStage("window-created");
  schedulePackagedSmokeTest();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}).catch((error) => {
  writePackagedSmokeStage("bootstrap-failed", {
    error: String(error?.stack || error?.message || error),
  });
  console.error("[startup] bootstrap failed:", error?.stack || error?.message || error);
  app.quit();
});

app.on("window-all-closed", () => {
  // 关闭所有窗口后确保退出，避免 npm start 残留
  if (lyricOverlayWindow && !lyricOverlayWindow.isDestroyed()) {
    lyricOverlayWindow.close();
  }
  app.quit();
});

app.on("before-quit", (event) => {
  if (quitCleanupFinished) return;
  event.preventDefault();
  appIsQuitting = true;
  if (quitCleanupPromise) return;
  officialModuleOperation?.control.abort();
  tagEditor.close();
  batchSongInfoTasks.close();
  songInfoService.cancelAll();
  lyricLookupService.cancelAll();
  for (const controller of coverAssetControllers.values()) controller.abort();
  coverAssetControllers.clear();
  if (lyricOverlayWindow && !lyricOverlayWindow.isDestroyed()) {
    lyricOverlayWindow.close();
  }
  quitCleanupPromise = (async () => {
    await resourceManager.close();
    await officialModuleOperation?.closed;
    if (mainWindow && !mainWindow.isDestroyed()) {
      let timeout;
      try {
        const finalHistory = await Promise.race([
          mainWindow.webContents.executeJavaScript("window.__kumikoApp?.prepareListeningHistoryQuit()"),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("renderer history flush timed out")), 5000); }),
        ]);
        if (finalHistory?.ok === false) console.warn("[history] final save failed; previous file retained");
      } catch (error) { console.warn("[history] final renderer snapshot unavailable", { code: String(error?.code || "") }); }
      finally { clearTimeout(timeout); }
    }
    return Promise.allSettled([traceArchive.flush(), metadata.flushMetadataCache(), listeningHistoryPersistence.flush(), startupBackground.pending, featureSelection.flush(), officialPackages.flush()]);
  })().then((results) => {
    for (const result of results) {
      if (result.status === "rejected") console.warn("[state] shutdown save failed", { code: String(result.reason?.code || "") });
    }
  }).then(() => tagEditor.drain()).then(() => lyricSaveService.drain({ timeoutMs: 15000 }))
    .then((result) => {
      if (!result.drained) {
        console.warn("[lyrics] timed out waiting for sidecar save", { pending: result.pending });
      }
    })
    .catch((error) => {
      console.warn("[lyrics] sidecar shutdown wait failed", { code: String(error?.code || "") });
    })
    .finally(() => {
      lyricSaveService.close();
      quitCleanupFinished = true;
      quitCleanupPromise = null;
      app.quit();
    });
});

function registerAllShortcuts(win) {
  shortcutStatus = {};
  globalShortcut.unregisterAll();
  const dispatch = (action, source, raw) => dispatchHotkeyAction(win, action, source, raw);
  Object.entries(shortcutConfig).forEach(([action, item]) => {
    const accelerator = (item?.accelerator || "").trim();
    if (!accelerator) {
      shortcutStatus[action] = { ok: true, reason: "empty" };
      return;
    }
    if (item?.scope !== "global") {
      shortcutStatus[action] = { ok: true, reason: "window" };
      return;
    }
    try {
      const ok = globalShortcut.register(accelerator, () => {
        pushMediaDiag("global_shortcut_fired", { source: "global-shortcut", accelerator, action });
        dispatch(action, "global-shortcut", accelerator);
      });
      shortcutStatus[action] = ok ? { ok: true } : { ok: false, reason: "register-failed" };
      pushMediaDiag("shortcut_register_result", { source: "global-shortcut", accelerator, action, ok: !!ok });
    } catch {
      shortcutStatus[action] = { ok: false, reason: "invalid-accelerator" };
      pushMediaDiag("shortcut_register_result", { source: "global-shortcut", accelerator, action, ok: false, reason: "invalid-accelerator" });
    }
  });
  // 系统媒体键（耳机/键盘媒体键）：不占用用户自定义快捷键配置
  const mediaBindings = [
    ["MediaPlayPause", "play_pause"],
    ["MediaStop", "stop"],
    ["MediaNextTrack", "next_like"], // 耳机下一首：找回本段感觉
    ["MediaPreviousTrack", "dislike_next"],
  ];
  mediaBindings.forEach(([accelerator, action]) => {
    // Standard Windows session routing coexists with other players. Global
    // media accelerators are only a fallback when session handlers are absent.
    if (mediaSessionAvailable !== false) {
      shortcutStatus[`media:${accelerator}`] = {ok:mediaSessionAvailable===true,reason:mediaSessionAvailable ? 'system-session' : 'session-pending'};
      return;
    }
    try {
      const ok = globalShortcut.register(accelerator, () => {
        pushMediaDiag("global_shortcut_fired", { source: "media-global-shortcut", accelerator, action });
        dispatch(action, "media-global-shortcut", accelerator);
      });
      shortcutStatus[`media:${accelerator}`] = ok ? { ok: true } : { ok: false, reason: "register-failed" };
      pushMediaDiag("media_key_register_result", { key: accelerator, action, ok: !!ok, reason: ok ? "" : "register-failed" });
      if (!ok) {
        console.warn(`[shortcuts][media] register failed: ${accelerator} -> ${action}`);
      }
    } catch (e) {
      shortcutStatus[`media:${accelerator}`] = { ok: false, reason: "unsupported" };
      pushMediaDiag("media_key_register_result", { key: accelerator, action, ok: false, reason: "unsupported", error: String(e?.message || e || "") });
      console.warn(`[shortcuts][media] register unsupported: ${accelerator} -> ${action}`, e?.message || e);
    }
  });
  const mediaSummary = mediaBindings.map(([k]) => `${k}:${shortcutStatus[`media:${k}`]?.ok ? "ok" : (shortcutStatus[`media:${k}`]?.reason || "unknown")}`).join(", ");
  console.info(`[shortcuts][media] summary ${mediaSummary}`);
  pushMediaDiag("media_key_register_summary", { summary: mediaSummary });
}

app.on("will-quit", () => {
  mediaInput.dispose();
  audioOutputSafety.dispose();
  audioOutputMonitor.dispose();
  for (const [name, cache] of [["metadata", songInfoQueryCache], ["lyrics", lyricQueryCache]]) {
    try {
      cache.close();
    } catch (error) {
      console.warn(`[song-info] ${name} cache flush failed`, error?.message || error);
    }
  }
  stopBackendServer();
  stopAudioFocusWatcher();
  if (mainWindowSaveTimer) {
    clearTimeout(mainWindowSaveTimer);
    mainWindowSaveTimer = null;
  }
  if (lyricOverlaySaveTimer) {
    clearTimeout(lyricOverlaySaveTimer);
    lyricOverlaySaveTimer = null;
  }
  if (controlServer) {
    try {
      controlServer.close();
    } catch {
      // ignore
    }
    controlServer = null;
  }
  saveMainWindowConfig();
  saveLyricOverlayConfig();
  globalShortcut.unregisterAll();
});

// 先声明，再注册，避免暂未初始化访问
let ipcRegistered = false;
// 确保主进程启动时即注册 IPC（避免 preload 报“无 handler”）
registerIpc();

function registerIpc() {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.on('lx-features-get-sync', event => {
    event.returnValue = secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)
      ? featureSnapshot() : null;
  });
  ipcMain.on('lx-module-template-sync',(event,id)=>{
    try{event.returnValue=secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)&&id==='history'?officialPackages.template(id):'';}
    catch{event.returnValue='';}
  });
  ipcMain.handle('lx-data-locations',event=>secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)&&event.sender===mainWindow?.webContents?require('./data-layout').locations(DATA_DIR,APP_HOME,dataLayout):[]);
  ipcMain.handle('lx-data-location-open',async(event,id)=>{
    if(!secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)||event.sender!==mainWindow?.webContents)return {ok:false};
    const location=require('./data-layout').locations(DATA_DIR,APP_HOME,dataLayout).find(row=>row.id===id);
    if(!location)return {ok:false,error:'未知数据目录。'};
    try{await fs.promises.mkdir(location.path,{recursive:true});const error=await shell.openPath(location.path);return error?{ok:false,error:'目录无法打开。'}:{ok:true};}catch{return {ok:false,error:'目录无法打开。'};}
  });
  const manageOfficialModule=async(event,value)=>{
    if(!secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)||event.sender!==mainWindow?.webContents)return {ok:false,error:'当前页面无权管理功能包。'};
    if(appIsQuitting)return {ok:false,error:'软件正在退出，原版本保留。'};
    const id=value?.id||'history';
    if(!Object.hasOwn(officialCatalog.packages,id))return {ok:false,error:'未知功能包。'};
    if(value?.action==='cancel'){
      if(officialModuleOperation?.id===id&&officialModuleOperation.phase!=='commit'){
        officialModuleOperation.control.abort();
        await resourceManager.cancel(id);
      }
      return {ok:true,selection:featureSnapshot()};
    }
    if(officialModuleOperation)return {ok:false,error:'另一个功能包操作正在进行。'};
    let finishOperation;
    const operation={id,control:new AbortController(),phase:'prepare',progress:{id,phase:'prepare'},closed:new Promise(resolve=>{finishOperation=resolve;})};officialModuleOperation=operation;
    const progress=payload=>{operation.phase=payload.phase;operation.progress={id,...payload};if(!event.sender.isDestroyed())event.sender.send('lx-module-progress',operation.progress);};
    try{
      if(value.revision!==officialPackages.snapshot().revision)throw Error('功能包状态已变化，请刷新后重试。');
      if(value?.action==='remove'){progress({phase:'commit'});await officialPackages.remove(value.revision,id);}
      else{
        let bytes;
        if(value?.action==='import'){
          const picked=await dialog.showOpenDialog(mainWindow,{title:'安装官方功能包',properties:['openFile'],filters:[{name:'Flowave 官方功能包',extensions:['fwm']} ]});
          if(picked.canceled)return {ok:true,canceled:true,selection:featureSnapshot()};
          const handle=await fs.promises.open(picked.filePaths[0],'r');
          try{const limit=require('./official-package-store').LIMIT;if((await handle.stat()).size>limit)throw Error('功能包超过大小限制。');const data=Buffer.alloc(limit+1);let length=0;while(length<data.length){const result=await handle.read(data,length,data.length-length,null);if(!result.bytesRead)break;length+=result.bytesRead;}bytes=data.subarray(0,length);}finally{await handle.close();}
        }else if(value?.action==='install'){
          const entry=officialCatalog.packages[id],release=entry.releases.find(row=>row.version===entry.latest);progress({phase:'prepare',done:0,total:release.bytes});
          if(release.url){progress({phase:'download',done:0,total:release.bytes});bytes=await require('./module-download').downloadOfficialRelease(release,{fetch:(...args)=>electronNet.fetch(...args),signal:operation.control.signal,onProgress:progress});}
          else bytes=await fs.promises.readFile(path.join(__dirname,'official-modules','packages',release.bundle));
        }else throw Error('未知功能包操作。');
        if(appIsQuitting||operation.control.signal.aborted)throw Error('安装已取消，原版本保留。');
        progress({phase:'verify',done:bytes.length,total:bytes.length});
        const verified=require('./official-package-store').decode(bytes,officialCatalog);
        if(verified.id!==id)throw Error('所选功能包与目标不一致。');
        progress({phase:'resources'});
        await resourceManager.prepare(id,event.sender,{signal:operation.control.signal,
          onProgress:resource=>progress({phase:'resources',resourcePhase:resource.phase,file:resource.phase==='install'?'正在安装运行环境…':resource.file,done:resource.done,total:resource.total})});
        if(appIsQuitting||operation.control.signal.aborted)throw Error('安装已取消，原版本保留。');
        progress({phase:'commit'});
        await officialPackages.install(bytes,value.revision,id);
      }
      // Installation and preference are separate atomic files. On partial failure
      // return the actual installation state so the UI cannot claim rollback.
      await featureSelection.select(id,value.action!=='remove',featureSelection.snapshot().selected.revision);
      progress({phase:'complete'});return {ok:true,selection:featureSnapshot()};
    }catch(error){progress({phase:'error'});return {ok:false,error:operation.control.signal.aborted?'安装已取消，原版本保留。':String(error.message||error),selection:featureSnapshot()};}
    finally{
      if(officialModuleOperation===operation)officialModuleOperation=null;
      finishOperation();
      if(!event.sender.isDestroyed())event.sender.send('lx-module-progress',{id,phase:'settled',selection:featureSnapshot()});
    }
  };
  ipcMain.handle('lx-module-manage',manageOfficialModule);
  ipcMain.handle('lx-resource-status',event=>secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)&&event.sender===mainWindow?.webContents?resourceManager.snapshot():{});
  ipcMain.handle('lx-resource-prepare',async(event,value)=>{
    if(!secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)||event.sender!==mainWindow?.webContents)return {ok:false,error:'当前页面无权准备资源。'};
    if(appIsQuitting)return {ok:false,error:'软件正在退出。'};
    const result=await manageOfficialModule(event,{id:value?.id,action:value?.action==='cancel'?'cancel':'install',revision:officialPackages.snapshot().revision});
    return {...result,status:resourceManager.snapshot()};
  });
  ipcMain.handle('lx-features-select', async (event, value) => {
    if (!secureProtocols.isTrustedRendererUrl(event.senderFrame?.url) || event.sender !== mainWindow?.webContents)
      return {ok:false,error:'当前页面无权更改功能。'};
    if(officialModuleOperation)return {ok:false,error:'功能安装正在进行，请完成或取消后再更改选择。'};
    try { await featureSelection.select(value?.id, value?.enabled, value?.revision);return {ok:true,selection:featureSnapshot()}; }
    catch (error) { return {ok:false,error:String(error.message || error)}; }
  });
  ipcMain.handle('lx-audio-output-playback', async (event, value) => {
    if (!secureProtocols.isTrustedRendererUrl(event.senderFrame?.url) || event.sender !== mainWindow?.webContents) return {ok:false};
    if (value?.playing === false) { audioOutputSafety.pause(event.sender, {wearToken:value.wearToken}); return {ok:true}; }
    if (value?.playing !== true) return {ok:false};
    return audioOutputSafety.prepare(event.sender, {resume:value.resume===true,allowOutputChange:value.allowOutputChange===true,wearToken:value.wearToken});
  });
  ipcMain.handle('lx-audio-output-get',async event=>secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)?audioOutputMonitor.get():{id:'',transport:'unknown',confirmed:false,reason:'untrusted-page'});
  ipcMain.handle('lx-audio-output-acquire',(event,id)=>setOutputLease(event,id,true));
  ipcMain.handle('lx-audio-output-release',(event,id)=>setOutputLease(event,id,false));
  ipcMain.on('lx-startup-background-get-sync', event => {
    event.returnValue = secureProtocols.isTrustedRendererUrl(event.senderFrame?.url) ? startupBackground.get() : { custom: false, name: '', url: '' };
  });
  ipcMain.handle('lx-startup-background-set', async (event, reset) => {
    if (!secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)) return { ok: false, message: '当前页面无法更改启动背景。' };
    if (startupBackgroundBusy) return { ok: false, message: '正在保存启动背景，请稍候。' };
    startupBackgroundBusy = true;
    try {
      if (reset === true) return { ok: true, background: await startupBackground.reset() };
      const win = BrowserWindow.fromWebContents(event.sender);
      const selected = await dialog.showOpenDialog(win, { title: '选择启动背景图片', properties: ['openFile'], filters: [{ name: '静态图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'avif'] }] });
      if (selected.canceled || !selected.filePaths[0]) return { ok: true, canceled: true };
      return { ok: true, background: await startupBackground.importFile(selected.filePaths[0]) };
    } catch { return { ok: false, message: '背景保存失败，请选择不超过25MB、4000万像素的PNG、JPEG、WebP或AVIF静态图片。原背景已保留。' }; }
    finally { startupBackgroundBusy = false; }
  });
  ipcMain.handle("lx-open-analysis-data", async (event) => {
    if (!secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)) return {ok:false,message:"当前页面无法打开数据目录。"};
    try {
      const folder=path.join(DATA_DIR,"library","track-analysis");
      fs.mkdirSync(folder,{recursive:true});
      const error=await shell.openPath(folder);
      return error ? {ok:false,message:"数据目录暂时无法打开。"} : {ok:true};
    } catch { return {ok:false,message:"数据目录暂时无法打开。"}; }
  });
  ipcMain.handle("lx-show-song-in-folder", async (event, filePath) => {
    if (!secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)) return {ok:false,message:"无法从当前页面定位文件。"};
    return revealLocalTrack(filePath, {shell});
  });
  const trustedTrace = (event, fn) => {
    if (!secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)) throw new Error('当前页面无法读取轨迹');
    return fn();
  };
  ipcMain.handle("lx-listening-trace-append", (event, payload) => trustedTrace(event, () => {
    if (traceArchive.blocksAppend) throw new Error('轨迹正在导出回退，请保留待重试记录');
    return tracePersistence.append(payload);
  }));
  ipcMain.handle('lx-listening-trace-hot', (event, payload) => trustedTrace(event, () => traceArchive.saveHot(payload)));
  ipcMain.handle('lx-listening-trace-prepare', (event, raw) => trustedTrace(event, () => traceArchive.prepare(raw)));
  ipcMain.handle('lx-listening-trace-routes', (event, payload) => trustedTrace(event, () => traceArchive.routes(payload)));
  ipcMain.handle('lx-listening-trace-route', (event, payload) => trustedTrace(event, () => traceArchive.route(payload)));
  ipcMain.handle('lx-listening-trace-attempt', (event, payload) => trustedTrace(event, () => traceArchive.attempt(payload)));
  ipcMain.handle('lx-listening-trace-rebuild', event => trustedTrace(event, () => traceArchive.rebuild()));
  ipcMain.handle('lx-listening-trace-rollback', event => trustedTrace(event, () => traceArchive.rollback()));
  ipcMain.handle("lx-renderer-state-get", async () => traceArchive.snapshot());
  ipcMain.on("lx-renderer-state-get-sync", (event) => {
    event.returnValue = traceArchive.snapshot();
  });
  ipcMain.on("lx-backend-config-get-sync", (event) => {
    event.returnValue = {
      baseUrl: BACKEND_URL,
      host: BACKEND_HOST,
      port: BACKEND_PORT,
      service: BACKEND_SERVICE_ID,
      protocolVersion: BACKEND_PROTOCOL_VERSION,
    };
  });
  ipcMain.handle("lx-renderer-state-set", async (_event, payload) => {
    const key = String(payload?.key || "").trim();
    if (!key) return { ok: false };
    if (key === '__flowaveTraceArchive' || (key === 'lx-sound-map-trace' && traceArchive.blocksLegacy)) return {ok:false, code:'TRACE_COLD_OWNED'};
    const value = String(payload?.value ?? "");
    if (rendererState?.[key] === value) return persistedRendererState === rendererState ? { ok: true } : saveRendererStateConfig();
    rendererState = { ...(rendererState || {}), [key]: value };
    return saveRendererStateConfig();
  });
  ipcMain.handle("lx-renderer-state-remove", async (_event, payload) => {
    const key = String(payload?.key || "").trim();
    if (!key) return { ok: false };
    if (key === '__flowaveTraceArchive' || (key === 'lx-sound-map-trace' && traceArchive.blocksLegacy)) return {ok:false, code:'TRACE_COLD_OWNED'};
    if (rendererState && Object.prototype.hasOwnProperty.call(rendererState, key)) {
      rendererState = { ...rendererState };
      delete rendererState[key];
      return saveRendererStateConfig();
    }
    return { ok: true };
  });
  ipcMain.handle("lx-listening-history-get", async () => {
    await listeningHistoryPersistence.flush();
    if (!featureSelection.active.enabled.history) return require('./history-feature-view').recommendationView(listeningHistoryPersistence.state);
    return listeningHistoryPersistence.state || {};
  });
  ipcMain.handle("lx-listening-history-status", async () => (
    cloneSerializableJson(listeningHistoryRecoveryState || {})
  ));
  ipcMain.handle("lx-listening-history-set", async (_event, payload) => {
    if (!featureSelection.active.enabled.history && !featureSelection.active.enabled.recommendation)
      return {ok:false,error:'听歌记录与推荐均已停用，未写入历史。'};
    if (!featureSelection.active.enabled.history) {
      try { payload = require('./history-feature-view').mergeRecommendationView(listeningHistoryPersistence.state, payload); }
      catch (error) { return {ok:false,error:String(error.message || error)}; }
    }
    const saved = await listeningHistoryPersistence.save(payload);
    listeningHistoryState = listeningHistoryPersistence.state;
    return saved;
  });
  ipcMain.handle("lx-listening-history-clear-stats", async () => (
    featureSelection.active.enabled.history ? listeningHistoryPersistence.operation("clear-stats") : {ok:false,error:'听歌记录已停用，原统计保留。'}
  ));
  ipcMain.handle("lx-listening-history-reset-recommendation-behavior", async () => (
    featureSelection.active.enabled.recommendation ? listeningHistoryPersistence.operation("reset-recommendation-behavior") : {ok:false,error:'推荐已停用，原学习记录保留。'}
  ));
  // 兼容旧 renderer：历史 reset 从此只清普通统计，禁止连带删除推荐学习。
  ipcMain.handle("lx-listening-history-reset", async () => (
    featureSelection.active.enabled.history ? listeningHistoryPersistence.operation("clear-stats") : {ok:false,error:'听歌记录已停用，原统计保留。'}
  ));
  ipcMain.handle("lx-window-control", async (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return { ok: false };
    if (action === "minimize") {
      win.minimize();
      return { ok: true };
    }
    if (action === "toggle-maximize") {
      if (win.isMaximized()) win.unmaximize();
      else win.maximize();
      return { ok: true };
    }
    if (action === "close") {
      win.close();
      return { ok: true };
    }
    return { ok: false };
  });
  ipcMain.handle("lx-install-model", async (event) => manageOfficialModule(event,{id:'recommendation',action:'install',revision:officialPackages.snapshot().revision}));
  ipcMain.handle(
    "lx-install-recommendation-engine",
    async (event) => manageOfficialModule(event,{id:'recommendation',action:'install',revision:officialPackages.snapshot().revision}),
  );
  ipcMain.handle("lx-lyric-source-get", async () => getLyricSourceConfigPayload());
  ipcMain.handle("lx-lyric-source-set", async (_event, payload) => {
    lyricSourceConfig = normalizeLyricSourceConfig({ ...(lyricSourceConfig || {}), ...(payload || {}) });
    saveLyricSourceConfig(lyricSourceConfig);
    metadata.setExternalLyricRoot(lyricSourceConfig.externalLyricDir);
    return { ok: true, ...getLyricSourceConfigPayload() };
  });
  ipcMain.handle("lx-lyric-source-pick", async () => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const ret = await dialog.showOpenDialog(win, {
      title: "选择 KTV 歌词文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
    if (ret.canceled || !ret.filePaths?.length) {
      return { canceled: true, ...getLyricSourceConfigPayload() };
    }
    return { canceled: false, path: ret.filePaths[0], ...getLyricSourceConfigPayload() };
  });
  ipcMain.handle("lx-get-song-info", async (_event, trackPath, options = {}) => {
    if (!trackPath) return null;
    try {
      metadata.setLibraryAudioRoot(loadLibraryAudioRoots());
      return await metadata.getMeta(trackPath, {
        includeLyricsModel: options?.includeLyricsModel === true,
        includeLyrics: options?.includeLyrics !== false,
        includeAudioDetails: options?.includeAudioDetails === true,
        resourceId: String(options?.resourceId || ""),
      });
    } catch (_) {
      return {
        path: trackPath,
        title: path.basename(trackPath, path.extname(trackPath)),
        artist: "未知艺术家",
        album: "",
        metadataError: true,
        duration: 0,
        cover: "",
        lyrics: "",
      };
    }
  });
  for (const [channel, handler] of Object.entries({
    "lx-song-tags-prepare": payload => { if (app.isPackaged) return { ok: false, message: "公开版资料写入尚未开放" }; return tagEditor.prepare(payload); },
    "lx-song-tags-commit": payload => { if (app.isPackaged) return { ok: false, message: "公开版资料写入尚未开放" }; return tagEditor.commit(payload.confirmationId); },
    "lx-song-tags-cancel": payload => tagEditor.cancel(payload.confirmationId),
    "lx-song-tags-cancel-queued": payload => tagEditor.cancelQueued(payload.requestId),
    "lx-song-tags-undo": payload => { if (app.isPackaged) return { ok: false, message: "公开版资料写入尚未开放" }; return tagEditor.undo(payload); },
    "lx-song-tags-playback": payload => { tagEditor.setPlayback(payload.path, payload.generation); return { ok: true }; },
    "lx-song-tags-wait": payload => tagEditor.waitForTarget(payload.path),
  })) ipcMain.handle(channel, async (event, payload) => {
    if (!secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)) return { ok: false, message: "无法从当前页面修改资料" };
    try { return await handler(payload || {}); }
    catch (error) { return { ok: false, message: String(error.message || "保存失败") }; }
  });
  ipcMain.handle("lx-song-tags-capabilities", async () => {
    if (app.isPackaged) return { editable: false };
    try { return (await axios.get(`${BACKEND_URL}/tracks/tags/capabilities`, { timeout: 3000 })).data; }
    catch (_) { return { editable: false }; }
  });
  ipcMain.handle("lx-song-info-query", async (_event, payload) => {
    try {
      const request = payload || {};
      if (request.mode === "lyrics") {
        metadata.setLibraryAudioRoot(loadLibraryAudioRoots());
        const result = await lyricLookupService.query({ ...request, onlyMissing: false, storageTarget: "sidecar" });
        const inspected = await lyricSidecarStore.inspect(request.trackPath);
        result.destination = path.relative(lyricSidecarStore.audioRoot(inspected.audioPath), inspected.sidecarPath);
        result.targetExists = Boolean(inspected.version.exists);
        return lyricSaveService.stageQueryResult({
          requestId: request.requestId, trackPath: request.trackPath, resourceId: request.resourceId,
          result, isSaveApproved: providerId => lyricProviderRegistry.canSave(providerId),
        });
      }
      const lyricResultPromise = request.includeLyrics === true
        ? lyricLookupService.query({ ...request, onlyMissing: true })
        : Promise.resolve(null);
      const [songResult, lyricResult] = await Promise.all([
        songInfoService.query(request),
        lyricResultPromise,
      ]);
      const recommendationOrder = { strong: 2, medium: 1, none: 0 };
      const result = {
        ...songResult,
        requestedFields: [
          ...(Array.isArray(songResult.requestedFields) ? songResult.requestedFields : []),
          ...(lyricResult && lyricResult.skipped !== "complete" ? ["lyrics"] : []),
        ],
        candidates: [
          ...(Array.isArray(songResult.candidates) ? songResult.candidates : []),
          ...(Array.isArray(lyricResult?.candidates) ? lyricResult.candidates : []),
        ].sort((left, right) => (
          (recommendationOrder[right?.recommendation] || 0) - (recommendationOrder[left?.recommendation] || 0)
          || Number(right?.score || 0) - Number(left?.score || 0)
        )),
        sources: [
          ...(Array.isArray(songResult.sources) ? songResult.sources : []),
          ...(Array.isArray(lyricResult?.sources) ? lyricResult.sources : []),
        ],
      };
      return lyricSaveService.stageQueryResult({
        requestId: request.requestId,
        trackPath: request.trackPath,
        resourceId: request.resourceId,
        result,
        isSaveApproved: (providerId) => lyricProviderRegistry.canSave(providerId),
      });
    } catch (error) {
      const code = String(error?.code || "");
      if (code === "INVALID_TRACK") return { ok: false, code, message: "请选择本地歌曲" };
      if (code === "TRACK_MISSING" || code === "ENOENT") return { ok: false, code: "TRACK_MISSING", message: "歌曲文件不存在" };
      if (code === "ABORTED" || error?.name === "AbortError") return { ok: false, code: "CANCELLED", message: "查询已取消" };
      console.warn("[song-info] query failed", { code, name: String(error?.name || "") });
      return { ok: false, code: "QUERY_FAILED", message: "查找失败，请重试" };
    }
  });
  ipcMain.handle("lx-song-info-query-cancel", async (_event, requestId) => {
    const queryCancelled = songInfoService.cancel(requestId);
    const lyricQueryCancelled = lyricLookupService.cancel(requestId);
    const stagedCancelled = lyricSaveService.cancelStagedRequest(requestId);
    return { ok: true, cancelled: Boolean(queryCancelled || lyricQueryCancelled || stagedCancelled) };
  });
  ipcMain.handle("lx-lyric-file-state", async (event, trackPath) => {
    if (!secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)) return { ok: false };
    try {
      const { inspected, filePath } = await lyricFileLocation(lyricSidecarStore, trackPath);
      return { ok: true, exists: Boolean(filePath), targetExists: Boolean(inspected.version.exists),
        destination: path.relative(lyricSidecarStore.audioRoot(inspected.audioPath) || path.dirname(inspected.audioPath), inspected.sidecarPath) };
    } catch (_) { return { ok: false }; }
  });
  ipcMain.handle("lx-lyric-show-in-folder", async (event, trackPath) => {
    if (!secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)) return { ok: false, message: "无法从当前页面定位文件" };
    try {
      const { filePath } = await lyricFileLocation(lyricSidecarStore, trackPath);
      if (!filePath) return { ok: false, message: "没有独立歌词文件，内嵌歌词保存在歌曲中" };
      shell.showItemInFolder(filePath);
      return { ok: true };
    } catch (_) { return { ok: false, message: "无法定位歌词文件" }; }
  });
  ipcMain.handle("lx-lyric-save-prepare", async (_event, payload) => {
    try {
      return await lyricSaveService.prepare(payload || {});
    } catch (error) {
      const code = String(error?.code || "LYRIC_SAVE_FAILED");
      console.warn("[lyrics] save prepare failed", { code });
      return {
        ok: false,
        code,
        message: code === "AUDIO_MISSING" ? "歌曲文件不存在" : "歌词无法保存",
      };
    }
  });
  ipcMain.handle("lx-lyric-save-commit", async (_event, payload) => {
    try {
      return await lyricSaveService.commit(payload || {});
    } catch (error) {
      const code = String(error?.code || "LYRIC_SAVE_FAILED");
      console.warn("[lyrics] save commit failed", { code });
      const message = code === "EXTERNAL_CHANGE"
        ? "歌词已被其他程序修改"
        : (code === "CONFIRMATION_EXPIRED" ? "请重新确认" : "保存失败");
      return { ok: false, code, message };
    }
  });
  ipcMain.handle("lx-lyric-save-cancel", async (_event, confirmationId) => ({
    ok: true,
    cancelled: lyricSaveService.cancel(confirmationId),
  }));
  ipcMain.handle("lx-lyric-save-recent", async () => {
    try {
      await lyricSidecarRecovery.wait();
      return await lyricSaveService.recentUndo();
    } catch (error) {
      console.warn("[lyrics] recent save lookup failed", { code: String(error?.code || "") });
      return { ok: false, transaction: null };
    }
  });
  ipcMain.handle("lx-lyric-save-undo", async (_event, transactionId) => {
    try {
      return await lyricSaveService.undo(transactionId);
    } catch (error) {
      const code = String(error?.code || "UNDO_CONFLICT");
      console.warn("[lyrics] undo failed", { code });
      return { ok: false, code, message: "歌词已变化，无法撤销" };
    }
  });
  ipcMain.handle("lx-song-info-cover-get", async (_event, payload) => {
    const requestId = String(payload?.requestId || "cover-single");
    coverAssetControllers.get(requestId)?.abort();
    const controller = new AbortController();
    coverAssetControllers.set(requestId, controller);
    try {
      const asset = await coverArtAssetStore.get(payload?.assetId, { signal: controller.signal });
      return {
        ok: true,
        assetId: asset.assetId,
        url: secureProtocols.toLocalMediaUrl(asset.path),
        width: asset.width,
        height: asset.height,
      };
    } catch (error) {
      if (controller.signal.aborted || error?.name === "AbortError" || error?.code === "ERR_CANCELED") {
        return { ok: false, code: "CANCELLED", message: "已取消" };
      }
      const code = String(error?.code || "COVER_ASSET_FAILED");
      console.warn("[song-info] cover asset failed", { code });
      return { ok: false, code, message: "封面不可用" };
    } finally {
      if (coverAssetControllers.get(requestId) === controller) coverAssetControllers.delete(requestId);
    }
  });
  ipcMain.handle("lx-song-info-cover-cancel", async (_event, requestId) => {
    const key = String(requestId || "cover-single");
    const controller = coverAssetControllers.get(key);
    if (!controller) return { ok: true, cancelled: false };
    controller.abort();
    coverAssetControllers.delete(key);
    return { ok: true, cancelled: true };
  });
  ipcMain.handle("lx-song-info-cache-clear", async () => {
    for (const controller of coverAssetControllers.values()) controller.abort();
    coverAssetControllers.clear();
    try {
      return { ok: true, ...(await songInfoCacheMaintenance.clear()) };
    } catch (error) {
      console.warn("[song-info] cache clear failed", { code: String(error?.code || "") });
      return { ok: false, code: "CACHE_CLEAR_FAILED", message: "缓存清理失败" };
    }
  });
  ipcMain.handle("lx-song-info-batch-list", async () => ({
    ok: true,
    loadStatus: batchSongInfoTasks.loadStatus,
    writeBlocked: batchSongInfoTasks.writeBlocked,
    lyricSidecarAvailable: lyricProviderRegistry.capabilities().saveProviders > 0,
    tasks: batchSongInfoTasks.list(),
  }));
  ipcMain.handle("lx-song-info-batch-create", async (_event, payload) => {
    try {
      return { ok: true, task: batchSongInfoTasks.create(payload || {}) };
    } catch (error) {
      const code = String(error?.code || "CREATE_FAILED");
      console.warn("[song-info] batch create failed", { code });
      return {
        ok: false,
        code,
        message: code === "TASK_UNFINISHED" ? "请先完成当前任务" : "无法创建任务",
      };
    }
  });
  ipcMain.handle("lx-song-info-batch-start", async (_event, taskId) => {
    try {
      const task = batchSongInfoTasks.get(taskId);
      if (!task) return { ok: false, code: "TASK_NOT_FOUND", message: "任务不存在" };
      if (batchSongInfoTasks.activeTaskId && batchSongInfoTasks.activeTaskId !== String(taskId || "")) {
        return { ok: false, code: "TASK_BUSY", message: "已有任务正在进行" };
      }
      batchSongInfoTasks.start(taskId).catch((error) => {
        console.warn("[song-info] batch task failed", { code: String(error?.code || "") });
      });
      return { ok: true, task };
    } catch (error) {
      const code = String(error?.code || "START_FAILED");
      return { ok: false, code, message: code === "TASK_BUSY" ? "已有任务正在进行" : "无法开始任务" };
    }
  });
  ipcMain.handle("lx-song-info-batch-cancel", async (_event, taskId) => ({
    ok: batchSongInfoTasks.cancel(taskId),
    task: batchSongInfoTasks.get(taskId),
  }));
  ipcMain.handle("lx-song-info-batch-retry", async (_event, payload) => {
    try {
      return { ok: true, ...batchSongInfoTasks.retry(payload?.taskId, payload?.itemIds) };
    } catch (error) {
      return { ok: false, code: String(error?.code || "RETRY_FAILED"), message: "无法重试" };
    }
  });
  ipcMain.handle("lx-song-info-batch-confirm", async (_event, payload) => {
    try {
      return {
        ok: true,
        task: await batchSongInfoTasks.confirmCandidate(payload?.taskId, payload?.itemId, payload?.candidateIndex),
      };
    } catch (error) {
      return { ok: false, code: String(error?.code || "CONFIRM_FAILED"), message: "无法确认结果" };
    }
  });
  ipcMain.handle("lx-song-info-batch-skip", async (_event, payload) => {
    try {
      return { ok: true, task: batchSongInfoTasks.skipItem(payload?.taskId, payload?.itemId) };
    } catch (error) {
      return { ok: false, code: String(error?.code || "SKIP_FAILED"), message: "无法跳过" };
    }
  });
  ipcMain.handle("lx-online-search", async (_event, payload) => {
    const keyword = String(payload?.keyword || "").trim();
    const source = String(payload?.source || "all");
    const page = Math.max(1, Number(payload?.page) || 1);
    const size = Math.max(1, Math.min(60, Number(payload?.size) || 20));
    if (!keyword) return { list: [], total: 0, limit: size };
    return onlineProviders.searchMusic(source, keyword, page, size);
  });
  ipcMain.handle("lx-online-songlist-search", async (_event, payload) => {
    const keyword = String(payload?.keyword || "").trim();
    const source = String(payload?.source || "all");
    const page = Math.max(1, Number(payload?.page) || 1);
    const size = Math.max(1, Math.min(60, Number(payload?.size) || 20));
    if (!keyword) return { list: [], total: 0, limit: size };
    return onlineProviders.searchSonglist(source, keyword, page, size);
  });
  ipcMain.handle("lx-online-songlist-tracks", async (_event, payload) => {
    const source = String(payload?.source || "");
    const id = String(payload?.id || "");
    const page = Math.max(1, Number(payload?.page) || 1);
    const size = Math.max(1, Math.min(200, Number(payload?.size) || 50));
    if (!source || !id) return { list: [], total: 0, limit: size };
    return onlineProviders.getSonglistTracks(source, id, page, size);
  });
  ipcMain.handle("lx-online-resolve-url", async (_event, payload) => {
    const source = String(payload?.source || "");
    const musicInfo = payload?.musicInfo || {};
    const quality = String(payload?.quality || "320k");
    const url = await onlineSourceRuntime.resolveMusicUrl(source, musicInfo, quality);
    return { url };
  });
  ipcMain.handle("lx-online-get-lyric", async (_event, payload) => {
    const source = String(payload?.source || "");
    const songId = String(payload?.songId || "");
    const title = String(payload?.title || "").trim().slice(0, 512);
    const artist = String(payload?.artist || "").trim().slice(0, 512);
    if (title) {
      metadata.setLibraryAudioRoot(loadLibraryAudioRoots());
      const local = await metadata.resolveExternalLyricsForOnline({
        title,
        artists: artist ? [artist] : [],
        album: String(payload?.album || "").trim().slice(0, 512),
        durationSeconds: Math.max(0, Math.min(24 * 60 * 60, Number(payload?.duration) || 0)),
      });
      if (local?.lyricsModel) return local;
    }
    return onlineProviders.getLyric(source, songId);
  });
  ipcMain.handle("lx-online-source-info", async () => {
    return onlineSourceRuntime.getSourceInfo();
  });
  ipcMain.handle("lx-online-source-config-get", async () => {
    return getOnlineSourceConfigPayload();
  });
  ipcMain.handle("lx-online-source-config-pick", async () => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const ret = await dialog.showOpenDialog(win, {
      title: "选择音源脚本文件",
      properties: ["openFile"],
      filters: [
        { name: "JavaScript", extensions: ["js", "cjs", "mjs"] },
        { name: "All Files", extensions: ["*"] },
      ],
    });
    if (ret.canceled || !ret.filePaths?.length) {
      return { canceled: true, ...getOnlineSourceConfigPayload() };
    }
    return { canceled: false, filePath: ret.filePaths[0], ...getOnlineSourceConfigPayload() };
  });
  ipcMain.handle("lx-online-source-config-set", async (_event, payload) => {
    const next = String(payload?.scriptPath || "").trim();
    if (!next) {
      try {
        saveOnlineSourceConfig({ scriptPath: "" });
        onlineSourceRuntime.setScriptPath("");
        return { ok: true, message: "已移除在线音源", ...getOnlineSourceConfigPayload() };
      } catch (e) {
        console.warn("移除在线音源失败", e);
        return { ok: false, message: "移除失败，请重试。", ...getOnlineSourceConfigPayload() };
      }
    }
    try {
      const target = importOnlineSourceScript(next);
      const candidate = await onlineSourceRuntime.prepareScriptPath(target);
      saveOnlineSourceConfig({ scriptPath: target });
      onlineSourceRuntime.commitPreparedRuntime(candidate);
      return { ok: true, message: "音源脚本已应用", ...getOnlineSourceConfigPayload() };
    } catch (e) {
      console.warn("音源脚本验证或保存失败", e);
      return {
        ok: false,
        message: "脚本验证失败，原音源仍可使用。",
        ...getOnlineSourceConfigPayload(),
      };
    }
  });
  ipcMain.handle("lx-online-source-reload", async () => {
    try {
      await onlineSourceRuntime.reloadRuntime();
      return { ok: true, message: "音源已重新载入", ...getOnlineSourceConfigPayload() };
    } catch (e) {
      console.warn("重载在线音源失败", e);
      return { ok: false, message: "重新载入失败，原音源仍可使用。", ...getOnlineSourceConfigPayload() };
    }
  });
  ipcMain.handle("lx-pick-directory", async () => {
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
    const ret = await dialog.showOpenDialog(win, {
      title: "选择下载目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (ret.canceled || !ret.filePaths?.length) return { canceled: true };
    return { canceled: false, path: ret.filePaths[0] };
  });
  ipcMain.handle("lx-online-download", async (_event, payload) => {
    const source = String(payload?.source || "").trim().toLowerCase();
    const quality = String(payload?.quality || "320k").trim().toLowerCase();
    const title = String(payload?.title || "").trim();
    const artist = String(payload?.artist || "").trim();
    const songId = String(payload?.songId || "").trim();
    const musicInfo = payload?.musicInfo || {};
    const downloadDirRaw = String(payload?.downloadDir || "").trim();
    if (!source) throw new Error("下载失败：缺少音源");
    if (!songId) throw new Error("下载失败：缺少歌曲标识");

    const resolved = await onlineSourceRuntime.resolveMusicUrl(source, musicInfo, quality);
    const url = normalizeResolvedUrl(resolved);
    if (!url) throw new Error("下载失败：音源未返回可用链接");

    const targetDir = resolvePackagePathOrDefault(downloadDirRaw, DOWNLOAD_DIR);
    fs.mkdirSync(targetDir, { recursive: true });
    const ext = decideAudioExt(url, quality);
    const filenameBase = sanitizeFilename(`${artist ? `${artist} - ` : ""}${title || songId}`) || songId;
    const filePath = resolveUniquePath(path.join(targetDir, `${filenameBase}${ext}`));

    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36",
      Accept: "*/*",
    };
    try {
      const origin = new URL(url).origin;
      headers.Referer = `${origin}/`;
    } catch {
      // ignore
    }
    const resp = await axios.get(url, {
      headers,
      responseType: "stream",
      timeout: 30000,
      maxRedirects: 5,
      validateStatus: () => true,
    });
    if (Number(resp.status) < 200 || Number(resp.status) >= 300) {
      throw new Error(`下载失败：上游状态码 ${resp.status}`);
    }
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(filePath);
      resp.data.pipe(ws);
      resp.data.on("error", reject);
      ws.on("error", reject);
      ws.on("finish", resolve);
    });
    return { ok: true, path: filePath, url };
  });
  ipcMain.handle("lx-shortcuts-get", async () => getShortcutPayload());
  ipcMain.handle("lx-shortcuts-set", async (_event, partial) => {
    shortcutConfig = mergeShortcutConfig(shortcutConfig, partial || {});
    saveShortcutConfig(shortcutConfig);
    if (mainWindow && !mainWindow.isDestroyed()) {
      registerAllShortcuts(mainWindow);
    }
    return getShortcutPayload();
  });
  ipcMain.handle("lx-shortcuts-reset", async () => {
    shortcutConfig = mergeShortcutConfig({}, DEFAULT_SHORTCUTS);
    saveShortcutConfig(shortcutConfig);
    if (mainWindow && !mainWindow.isDestroyed()) {
      registerAllShortcuts(mainWindow);
    }
    return getShortcutPayload();
  });
  ipcMain.handle('lx-media-session-ready', (event, available) => {
    if (!secureProtocols.isTrustedRendererUrl(event.senderFrame?.url) || event.sender !== mainWindow?.webContents || typeof available !== 'boolean') return false;
    mediaSessionAvailable = available;
    registerAllShortcuts(mainWindow);
    return true;
  });
  ipcMain.handle('lx-media-input', (event, action) => {
    if (!secureProtocols.isTrustedRendererUrl(event.senderFrame?.url)) return false;
    if (!['play','pause','play_pause','stop','next_like','dislike_next'].includes(action)) return false;
    return dispatchHotkeyAction(mainWindow, action, 'media-session', action);
  });
  ipcMain.handle("lx-media-diag-get", async () => getMediaDiagSnapshot());
  ipcMain.handle("lx-lyric-overlay-open", async (_event, payload) => {
    const win = createLyricOverlayWindow();
    if (payload && payload.settings) pushLyricOverlaySettings(payload.settings);
    if (payload && Object.prototype.hasOwnProperty.call(payload, "locked")) {
      applyLyricOverlayLock(payload.locked);
    }
    if (payload && payload.update) pushLyricOverlayUpdate(payload.update);
    if (typeof win.showInactive === "function") {
      win.showInactive();
    } else {
      win.show();
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("lx-lyric-overlay-state", { open: true, locked: lyricOverlayState.locked });
    }
    return { ok: true };
  });
  ipcMain.handle("lx-lyric-overlay-close", async () => {
    if (lyricOverlayWindow && !lyricOverlayWindow.isDestroyed()) {
      lyricOverlayWindow.close();
    }
    return { ok: true };
  });
  ipcMain.handle("lx-lyric-overlay-update", async (_event, payload) => {
    if (!lyricOverlayWindow || lyricOverlayWindow.isDestroyed()) return { ok: false, reason: "not-open" };
    if (payload && payload.settings) pushLyricOverlaySettings(payload.settings);
    if (payload && Object.prototype.hasOwnProperty.call(payload, "locked")) {
      applyLyricOverlayLock(payload.locked);
    }
    if (payload && payload.update) pushLyricOverlayUpdate(payload.update);
    return { ok: true };
  });
  ipcMain.on("lx-lyric-overlay-action", (_event, data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("lx-lyric-overlay-action", data || {});
    }
  });
  ipcMain.on("lx-player-control-result", (_event, data) => {
    const requestId = String(data?.requestId || "");
    if (!requestId || !pendingControlRequests.has(requestId)) return;
    const done = pendingControlRequests.get(requestId);
    pendingControlRequests.delete(requestId);
    done(data || {});
  });
}

function bindWindowShortcutEvents(win) {
  win.webContents.once('destroyed',()=>{if(audioOutputSafety.owner===win.webContents)audioOutputSafety.release()});
  win.webContents.on('render-process-gone',()=>{if(audioOutputSafety.owner===win.webContents)audioOutputSafety.release()});
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat && String(input.key || "").toLowerCase().startsWith("media")) return;
    const mediaKey = String(input.key || "").toLowerCase();
    if (mediaKey.startsWith("media")) {
      pushMediaDiag("before_input_event_raw", { source: "before-input-event", key: mediaKey, raw: String(input?.key || "") });
    }
    if (mediaKey === "mediaplaypause") {
      event.preventDefault();
      dispatchHotkeyAction(win, "play_pause", "before-input-event", mediaKey);
      return;
    }
    if (mediaKey === "mediaplay") {
      event.preventDefault();
      dispatchHotkeyAction(win, "play", "before-input-event", mediaKey);
      return;
    }
    if (mediaKey === "mediapause") {
      event.preventDefault();
      dispatchHotkeyAction(win, "pause", "before-input-event", mediaKey);
      return;
    }
    if (mediaKey === "mediastop") {
      event.preventDefault();
      dispatchHotkeyAction(win, "stop", "before-input-event", mediaKey);
      return;
    }
    if (mediaKey === "medianexttrack") {
      event.preventDefault();
      dispatchHotkeyAction(win, "next_like", "before-input-event", mediaKey);
      return;
    }
    if (mediaKey === "mediaprevioustrack") {
      event.preventDefault();
      dispatchHotkeyAction(win, "dislike_next", "before-input-event", mediaKey);
      return;
    }
    const hit = Object.entries(shortcutConfig).find(([, item]) => {
      if (!item || item.scope !== "window") return false;
      const accelerator = (item.accelerator || "").trim();
      if (!accelerator) return false;
      return isAcceleratorMatch(accelerator, input);
    });
    if (!hit) return;
    const [action] = hit;
    event.preventDefault();
    dispatchHotkeyAction(win, action, "window-shortcut", input?.key || "");
  });
  // Windows / 部分蓝牙耳机会走 app-command 事件
  win.on("app-command", (event, command) => {
    const c = String(command || "").toLowerCase();
    pushMediaDiag("app_command_raw", { source: "app-command", command: c });
    let action = "";
    if (c === "media-play-pause" || c === "media-playpause") action = "play_pause";
    else if (c === "media-play") action = "play";
    else if (c === "media-pause") action = "pause";
    else if (c === "media-stop") action = "stop";
    else if (c === "media-next-track" || c === "media-nexttrack") action = "next_like";
    else if (c === "media-previous-track" || c === "media-previoustrack") action = "dislike_next";
    if (!action) return;
    event.preventDefault();
    dispatchHotkeyAction(win, action, "app-command", c);
  });
}

function dispatchHotkeyAction(win, action, source = "unknown", raw = "") {
  const act = String(action || "").trim();
  const req = nextMediaDiagRequestId();
  if (!act || !HOTKEY_ACTION_WHITELIST.has(act)) {
    console.warn(`[media-input] ignored source=${source} action=${act || "<empty>"} raw=${String(raw || "")}`);
    pushMediaDiag("dispatch_hotkey_action", { req, source, action: act || "", raw: String(raw || ""), ok: false, reason: "not-whitelisted" });
    return false;
  }
  const targetWin = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : win;
  if (!targetWin || targetWin.isDestroyed()) {
    pushMediaDiag("dispatch_hotkey_action", { req, source, action: act, raw: String(raw || ""), ok: false, reason: "no-target-window" });
    return false;
  }
  if (["media-global-shortcut", "before-input-event", "app-command", "media-session"].includes(source)) {
    const accepted = mediaInput.submit(act, source);
    pushMediaDiag("dispatch_hotkey_action", { req, source, action: act, ok: accepted, reason: accepted ? "coalescing" : "deduped" });
    return accepted;
  }
  console.info(`[media-input] req=${req} source=${source} action=${act} raw=${String(raw || "")}`);
  pushMediaDiag("dispatch_hotkey_action", { req, source, action: act, raw: String(raw || ""), ok: true });
  targetWin.webContents.send("hotkey", act);
  return true;
}

function isAcceleratorMatch(accelerator, input) {
  const tokens = String(accelerator)
    .split("+")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!tokens.length) return false;

  let expectCtrl = false;
  let expectAlt = false;
  let expectShift = false;
  let expectMeta = false;
  let keyToken = "";

  tokens.forEach((t) => {
    if (t === "control" || t === "ctrl" || t === "cmdorctrl" || t === "commandorcontrol") expectCtrl = true;
    else if (t === "alt" || t === "option") expectAlt = true;
    else if (t === "shift") expectShift = true;
    else if (t === "meta" || t === "super" || t === "command" || t === "cmd") expectMeta = true;
    else keyToken = t;
  });

  const key = normalizeInputKey(input?.key || "");
  const expectedKey = normalizeInputKey(keyToken);
  if (!expectedKey || key !== expectedKey) return false;
  return Boolean(input.control) === expectCtrl &&
    Boolean(input.alt) === expectAlt &&
    Boolean(input.shift) === expectShift &&
    Boolean(input.meta) === expectMeta;
}

function normalizeInputKey(key) {
  const k = String(key || "").trim().toLowerCase();
  const map = {
    arrowleft: "left",
    arrowright: "right",
    arrowup: "up",
    arrowdown: "down",
    spacebar: "space",
    " ": "space",
    esc: "escape",
  };
  return map[k] || k;
}

function loadShortcutConfig() {
  try {
    const shortcutsPath = getShortcutsPath();
    if (!fs.existsSync(shortcutsPath)) return mergeShortcutConfig({}, DEFAULT_SHORTCUTS);
    const raw = JSON.parse(fs.readFileSync(shortcutsPath, "utf-8"));
    return mergeShortcutConfig({}, raw);
  } catch {
    return mergeShortcutConfig({}, DEFAULT_SHORTCUTS);
  }
}

function saveShortcutConfig(cfg) {
  try {
    const shortcutsPath = getShortcutsPath();
    fs.mkdirSync(path.dirname(shortcutsPath), { recursive: true });
    writeJsonFileAtomic(shortcutsPath, cfg);
  } catch {
    // ignore
  }
}

function mergeShortcutConfig(base, patch) {
  const out = {};
  Object.entries(DEFAULT_SHORTCUTS).forEach(([action, def]) => {
    const fromBase = base?.[action] || {};
    const fromPatch = patch?.[action] || {};
    const rawScope = fromPatch.scope || fromBase.scope || def.scope;
    // 迁移：定位当前曲目从全局快捷键调整为应用内快捷键
    const scope = action === "locate_current" && rawScope === "global" ? "window" : rawScope;
    const label = def.label;
    const accelerator = String(fromPatch.accelerator ?? fromBase.accelerator ?? def.accelerator ?? "").trim();
    out[action] = { scope, label, accelerator };
  });
  return out;
}

function getShortcutPayload() {
  const items = Object.entries(shortcutConfig).map(([action, item]) => ({
    action,
    label: item.label,
    scope: item.scope,
    accelerator: item.accelerator,
    status: shortcutStatus[action] || { ok: true },
  }));
  const media = ["MediaPlayPause", "MediaStop", "MediaNextTrack", "MediaPreviousTrack"].map((key) => ({
    key,
    status: shortcutStatus[`media:${key}`] || { ok: true, reason: "unknown" },
  }));
  return { items, media };
}

function getShortcutsPath() {
  return path.join(CONFIG_DIR, "shortcuts.json");
}

function getRendererStateConfigPath() {
  return path.join(CONFIG_DIR, "renderer_state.json");
}

function loadRendererStateConfig() {
  return readJsonFile(getRendererStateConfigPath(), {});
}

async function saveRendererStateConfig() {
  try {
    await rendererStateWriter.save(rendererState || {});
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error?.message || "保存失败") };
  }
}

function getListeningHistoryConfigPath() {
  return path.join(LISTENING_CONFIG_DIR, "listening_history.json");
}

function getListeningHistoryBackupDir() {
  return path.join(LISTENING_CONFIG_DIR, "listening-history-backups");
}

function getListeningHistorySnapshotDir() {
  return path.join(LISTENING_CONFIG_DIR, "listening-history-snapshots");
}

function loadListeningHistoryConfig() {
  try {
    const result = listeningHistoryStore.loadListeningHistoryWithRecovery({
      configDir: LISTENING_CONFIG_DIR,
    });
    listeningHistoryRecoveryState = cloneSerializableJson(result.status || {});
    return cloneSerializableJson(result.history || {});
  } catch (error) {
    listeningHistoryRecoveryState = {
      state: "unrecoverable",
      recovered: false,
      writeBlocked: true,
      warning: String(error?.message || error || "听歌历史恢复失败"),
    };
    return {};
  }
}

async function saveListeningHistoryConfig(history = listeningHistoryState, options = {}) {
  if (listeningHistoryRecoveryState?.writeBlocked) {
    return {
      ok: false,
      error: "听歌历史文件损坏且没有可用备份，已停止自动写入；请先备份用户数据再手动恢复。",
    };
  }
  try {
    const p = getListeningHistoryConfigPath();
    await fs.promises.mkdir(path.dirname(p), { recursive: true });
    const checkpointPath = path.join(getListeningHistorySnapshotDir(), `listening_history.${getLocalDateKey()}.before-first-save.json`);
    await fs.promises.mkdir(path.dirname(checkpointPath), { recursive: true });
    try { await fs.promises.copyFile(p, checkpointPath, fs.constants.COPYFILE_EXCL); }
    catch (error) { if (error.code !== "EEXIST" && error.code !== "ENOENT") throw error; }
    await writeHistoryAtomic(p, history);
    if (!options.skipBackup) {
      const backup = await backupListeningHistoryConfig();
      if (!backup.ok) {
        return {
          ok: true,
          backupOk: false,
          warning: backup.error || "听歌历史每日备份失败",
        };
      }
    }
    return { ok: true, backupOk: true };
  } catch (error) {
    return {
      ok: false,
      error: String(error?.message || error || "听歌历史保存失败"),
    };
  }
}

function getLocalDateKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function writeHistoryAtomic(filePath, history) {
  const { tracks = {}, ...header } = history;
  await writeJsonObjectAtomic(filePath, tracks, { header, entriesKey: "tracks" });
}

async function backupListeningHistoryConfig() {
  const target = path.join(getListeningHistoryBackupDir(), `listening_history.${getLocalDateKey()}.json`);
  const staged = target + `.${crypto.randomUUID()}.tmp`;
  try {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.copyFile(getListeningHistoryConfigPath(), staged);
    await fs.promises.rename(staged, target);
    return { ok: true };
  } catch (error) { return { ok: false, error: String(error?.message || error) }; }
  finally { await fs.promises.unlink(staged).catch(() => {}); }
}

function getListeningHistorySnapshotStamp(ts = Date.now()) {
  const date = new Date(ts);
  const pad = (value, length = 2) => String(value).padStart(length, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    pad(date.getMilliseconds(), 3),
  ].join("");
}

async function writeListeningHistoryOperationSnapshot(history, kind, now = Date.now()) {
  const snapshotDir = getListeningHistorySnapshotDir();
  await fs.promises.mkdir(snapshotDir, { recursive: true });
  const safeKind = String(kind || "operation").replace(/[^a-z0-9-]+/gi, "-");
  const rawSchemaVersion = Number(history?.version || 1);
  const schemaVersion = Number.isFinite(rawSchemaVersion)
    ? Math.max(1, Math.floor(rawSchemaVersion))
    : 1;
  const nonce = crypto.randomBytes(4).toString("hex");
  const name = `listening_history.${getListeningHistorySnapshotStamp(now)}.${safeKind}.v${schemaVersion}.${nonce}.json`;
  await writeHistoryAtomic(path.join(snapshotDir, name), history || {});
  return name;
}

async function performListeningHistoryOperation(kind, history, revision) {
  if (listeningHistoryRecoveryState?.writeBlocked) return { ok: false, error: "听歌记录处于受保护状态，禁止覆盖。" };
  const transform = kind === "clear-stats" ? listeningHistoryOps.clearListeningStats
    : kind === "reset-recommendation-behavior" ? listeningHistoryOps.resetRecommendationBehavior : null;
  if (!transform) return { ok: false, error: "未知听歌记录操作" };
  const snapshot = await writeListeningHistoryOperationSnapshot(history, kind);
  const next = transform(history, Date.now());
  next.persistenceRevision = revision;
  await writeHistoryAtomic(getListeningHistoryConfigPath(), next);
  listeningHistoryState = next;
  const backup = await backupListeningHistoryConfig();
  return { ok: true, history: next, snapshot, backupOk: backup.ok, warning: backup.ok ? "" : backup.error };
}

function writeJsonFileAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${path.basename(filePath)}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data || {}, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}

function listListeningHistoryBackupFiles() {
  const backupDir = getListeningHistoryBackupDir();
  if (!fs.existsSync(backupDir)) return [];
  return fs.readdirSync(backupDir)
    .map((name) => {
      const match = /^listening_history\.(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
      if (!match) return null;
      return { name, day: match[1], path: path.join(backupDir, name) };
    })
    .filter(Boolean)
    .sort((a, b) => b.day.localeCompare(a.day));
}

function pruneListeningHistoryBackups(keepDays = 3) {
  try {
    const backupDir = getListeningHistoryBackupDir();
    if (!fs.existsSync(backupDir)) return;
    const files = listListeningHistoryBackupFiles();
    files.slice(Math.max(0, Number(keepDays) || 3)).forEach((item) => {
      try {
        fs.unlinkSync(item.path);
      } catch {
        // ignore
      }
    });
  } catch {
    // ignore
  }
}

function getLyricOverlayConfigPath() {
  return path.join(CONFIG_DIR, "lyric_overlay.json");
}

function getMainWindowConfigPath() {
  return path.join(CONFIG_DIR, "main_window.json");
}

function getOnlineSourceConfigPath() {
  return path.join(CONFIG_DIR, "online_source.json");
}

function getLyricSourceConfigPath() {
  return path.join(CONFIG_DIR, "lyric_source.json");
}

function normalizeLyricSourceConfig(cfg = {}) {
  return {
    externalLyricDir: String(cfg?.externalLyricDir ?? DEFAULT_LYRIC_SOURCE_CONFIG.externalLyricDir).trim(),
  };
}

function loadLyricSourceConfig() {
  try {
    const p = getLyricSourceConfigPath();
    if (!fs.existsSync(p)) return normalizeLyricSourceConfig(DEFAULT_LYRIC_SOURCE_CONFIG);
    return normalizeLyricSourceConfig(JSON.parse(fs.readFileSync(p, "utf-8")) || {});
  } catch {
    return normalizeLyricSourceConfig(DEFAULT_LYRIC_SOURCE_CONFIG);
  }
}

function loadLibraryAudioRoots() {
  try {
    const configPath = path.join(CONFIG_DIR, "app.json");
    if (!fs.existsSync(configPath)) return [];
    const cfg=JSON.parse(fs.readFileSync(configPath,"utf-8").replace(/^\uFEFF/u,""));
    return (Array.isArray(cfg.audio_dirs)?cfg.audio_dirs:[cfg.audio_dir]).map(v=>String(v||"").trim()).filter(Boolean);
  } catch (_) { return []; }
}
function loadLibraryAudioRoot(audioPath = "") {
  const roots=loadLibraryAudioRoots();
  return roots.find(root=>{if(!audioPath)return false;const rel=path.relative(path.resolve(root),path.resolve(audioPath));return rel!==".."&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel)}) || roots[0] || "";
}

function saveLyricSourceConfig(cfg) {
  try {
    writeJsonFileAtomic(getLyricSourceConfigPath(), normalizeLyricSourceConfig(cfg));
  } catch {
    // ignore
  }
}

function getLyricSourceConfigPayload() {
  const config = normalizeLyricSourceConfig(lyricSourceConfig);
  const metadataConfig = typeof metadata.getExternalLyricConfig === "function" ? metadata.getExternalLyricConfig() : {};
  const dir = config.externalLyricDir;
  return {
    config,
    externalLyricDir: dir,
    exists: dir ? fs.existsSync(dir) : false,
    roots: Array.isArray(metadataConfig.roots) ? metadataConfig.roots : [],
    configPath: getLyricSourceConfigPath(),
  };
}

function loadOnlineSourceConfig() {
  try {
    const p = getOnlineSourceConfigPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf-8")) || {};
  } catch {
    return {};
  }
}

function saveOnlineSourceConfig(cfg) {
  const p = getOnlineSourceConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  writeJsonFileAtomic(p, cfg || {});
}

function initOnlineSourceRuntime() {
  const cfg = loadOnlineSourceConfig();
  const scriptPath = String(cfg?.scriptPath || "").trim();
  onlineSourceRuntime.setScriptPath(scriptPath);
  if (!scriptPath) {
    console.info("[online-source] no user script configured");
    return;
  }
  onlineSourceRuntime.reloadRuntime().catch((e) => {
    console.warn("[online-source] init failed:", e.message);
  });
}

function getOnlineSourceConfigPayload() {
  const scriptPath = onlineSourceRuntime.getScriptPath();
  const defaultScriptPath = onlineSourceRuntime.getDefaultScriptPath();
  return {
    scriptPath,
    defaultScriptPath,
    exists: !!scriptPath && fs.existsSync(scriptPath),
    sourceInfo: onlineSourceRuntime.getSourceInfo(),
  };
}

function ensureControlServer() {
  if (controlServer) return;
  controlServer = http.createServer((req, res) => {
    if (req.method === "GET" && String(req.url || "").startsWith("/online-proxy")) {
      handleOnlineProxy(req, res);
      return;
    }
    if (req.method !== "POST" || req.url !== "/control-music") {
      res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ success: false, message: "Not Found" }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) req.destroy();
    });
    req.on("end", async () => {
      try {
        const payload = body ? JSON.parse(body) : {};
        const action = String(payload?.action || "").trim();
        const filename = String(payload?.filename || "").trim();
        const result = await runPlayerControl(action, filename);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ success: false, message: `控制失败：${error.message}` }));
      }
    });
  });
  controlServer.listen(CONTROL_PORT, CONTROL_HOST, () => {
    console.log(`[control] listening on http://${CONTROL_HOST}:${CONTROL_PORT}/control-music`);
  });
  controlServer.on("error", (err) => {
    console.error("[control] server error:", err);
  });
}

async function handleOnlineProxy(req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once("close", abort);
  try {
    const requestUrl = new URL(String(req.url || ""), `http://${CONTROL_HOST}:${CONTROL_PORT}`);
    const targetUrl = String(requestUrl.searchParams.get("url") || "").trim();
    if (!/^https?:\/\//i.test(targetUrl)) {
      res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("invalid target url");
      return;
    }
    const headers = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0 Safari/537.36",
      Accept: "*/*",
      Connection: "keep-alive",
    };
    if (req.headers.range) headers.Range = String(req.headers.range);
    try {
      const origin = new URL(targetUrl).origin;
      headers.Referer = `${origin}/`;
    } catch {
      // ignore
    }
    const upstream = await axios.get(targetUrl, {
      headers,
      signal: controller.signal,
      responseType: "stream",
      maxRedirects: 5,
      timeout: 20000,
      validateStatus: () => true,
    });
    const statusCode = Number(upstream.status) || 200;
    const passthroughHeaders = { "access-control-allow-origin": "kumiko-app://renderer" };
    const forwardKeys = ["content-type", "content-length", "accept-ranges", "content-range", "cache-control"];
    forwardKeys.forEach((k) => {
      const v = upstream.headers?.[k];
      if (v !== undefined) passthroughHeaders[k] = v;
    });
    res.writeHead(statusCode, passthroughHeaders);
    upstream.data.pipe(res);
    upstream.data.on("error", () => {
      if (!res.writableEnded) res.end();
    });
  } catch (error) {
    if (res.destroyed || controller.signal.aborted) return;
    if (res.headersSent) { res.end(); return; }
    res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`proxy error: ${error.message}`);
  }
}

function normalizeResolvedUrl(resolved) {
  if (typeof resolved === "string") return String(resolved || "").trim();
  if (resolved && typeof resolved === "object") {
    const url = resolved.url || resolved.data?.url || resolved.data?.src || "";
    return String(url || "").trim();
  }
  return "";
}

function decideAudioExt(url, quality) {
  const q = String(quality || "").toLowerCase();
  if (q.includes("flac") || q.includes("hires")) return ".flac";
  try {
    const p = new URL(url).pathname || "";
    const ext = path.extname(p).toLowerCase();
    if ([".mp3", ".flac", ".m4a", ".aac", ".wav", ".ogg"].includes(ext)) return ext;
  } catch {
    // ignore
  }
  return ".mp3";
}

function sanitizeFilename(name) {
  return String(name || "").replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim();
}

function resolveUniquePath(targetPath) {
  if (!fs.existsSync(targetPath)) return targetPath;
  const ext = path.extname(targetPath);
  const base = targetPath.slice(0, -ext.length);
  let i = 1;
  while (true) {
    const next = `${base} (${i})${ext}`;
    if (!fs.existsSync(next)) return next;
    i += 1;
  }
}

function importOnlineSourceScript(rawPath) {
  const sourceRaw = String(rawPath || "").trim();
  if (!sourceRaw) throw new Error("请先选择音源脚本");
  const source = path.resolve(sourceRaw);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`音源脚本不存在：${source}`);
  }
  const rel = path.relative(APP_HOME, source);
  if (!rel || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    return source;
  }
  const ext = path.extname(source) || ".js";
  const base = sanitizeFilename(path.basename(source, ext)) || "online-source";
  const target = resolveUniquePath(path.join(ONLINE_SOURCE_DIR, `${base}${ext}`));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return target;
}

async function runPlayerControl(action, filename) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return { success: false, message: "播放器主窗口未启动" };
  }
  if (!action) {
    return { success: false, message: "缺少 action" };
  }
  const requestId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  const resultPromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (!pendingControlRequests.has(requestId)) return;
      pendingControlRequests.delete(requestId);
      resolve({ success: false, message: "播放器响应超时" });
    }, 6000);
    pendingControlRequests.set(requestId, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });

  mainWindow.webContents.send("lx-player-control", {
    requestId,
    action,
    filename,
  });
  const result = await resultPromise;
  return {
    success: !!result?.success,
    message: result?.message || (result?.success ? "操作成功" : "操作失败"),
    metadata: result?.metadata || null,
  };
}
