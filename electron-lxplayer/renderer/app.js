const virtualViewportRuntimes = new WeakMap();
const recommendationWarmups = new WeakMap();
let soundMapDrainPromise = null;
let soundMapRetryTimer = null;
let soundMapArchiveTimer = null;
let soundMapArchivePromise = null;
const { createApp } = Vue;
let lyricAmbientRuntime = null;
const LyricUtils = window.LyricUtils || {};
const markSearchRaw = (value) => value && typeof value === "object" && typeof Vue.markRaw === "function"
  ? Vue.markRaw(value)
  : value;
const PlaybackTransitionUtils = window.PlaybackTransitionUtils || {};
const playbackTransitionCoordinator = new PlaybackTransitionUtils.PlaybackTransitionCoordinator();
const DEFAULT_THEME = "lx-light";
const DEFAULT_ACCENT = "#d22d2d";
const DEFAULT_LYRIC_FONT_SIZE = 23;
const DEFAULT_LYRIC_SUB_FONT_SIZE = 19;
const DEFAULT_LYRIC_FONT_FAMILY = "PingFang SC";
const DEFAULT_LYRIC_INACTIVE_COLOR = "#d5d9dc";
const DEFAULT_LYRIC_ACTIVE_COLOR = "#60a9e1";
const DEFAULT_LYRIC_META_COLOR = "#3e4347";
const DEFAULT_LYRIC_BG_COLOR = "#ffffff";
const DEFAULT_LYRIC_ACTIVE_SCALE = 1.35;
const DEFAULT_LYRIC_DISPLAY_MODE = "both";
const DEFAULT_LYRIC_GLOW_ENABLED = true;
const DEFAULT_LYRIC_GLOW_SPEED = 0.4;
const DEFAULT_LYRIC_RENDER_DELAY_MS = 0;
const DEFAULT_LYRIC_FOCUS_LEAD_MS = 500;
const DEFAULT_LYRIC_SWITCH_SCROLL_MS = 120;
const DEFAULT_DESKTOP_LYRIC_FONT_SIZE = 62;
const DEFAULT_DESKTOP_LYRIC_SUB_FONT_SIZE = 34;
const DEFAULT_DESKTOP_LYRIC_OPACITY = 0.86;
const DEFAULT_DESKTOP_LYRIC_STROKE = 0.5;
const DEFAULT_DESKTOP_LYRIC_LOCKED = true;
const DEFAULT_DESKTOP_LYRIC_CURRENT_ONLY = true;
const LISTENING_HISTORY_VERSION = 2;
const LISTENING_HISTORY_MAX_SAVE_DELAY_MS = 60000;
const ONLINE_TOKEN_PREFIX = "online://";
const ONLINE_SOURCE_LABELS = Object.freeze({
  kw: "酷我",
  kg: "酷狗",
  tx: "QQ",
  wy: "网易",
  mg: "咪咕",
});
const ONLINE_QUALITY_OPTIONS = Object.freeze([
  { value: "128k", label: "节省流量", shortLabel: "128k" },
  { value: "320k", label: "高音质 320k", shortLabel: "320k" },
  { value: "flac", label: "无损 FLAC", shortLabel: "无损" },
  { value: "flac24bit", label: "24 位无损", shortLabel: "24 位" },
  { value: "hires", label: "Hi-Res", shortLabel: "Hi-Res" },
]);
const PUBLIC_VIEWS = new Set(["library", "online", "settings", "seeds", "sound-map", "insights", "analysis", "practice"]);

const STARTUP_SPLASH_MIN_MS = 2000;
const STARTUP_SPLASH_MAX_MS = 4000;
const STARTUP_SPLASH_IMAGE = "./assets/startup-inuyama-aoi.jpg";
const initialStartupBackground = (() => {
  try { return window.lxEnv?.getStartupBackgroundSync?.() || { custom: false, name: '', url: '' }; }
  catch { return { custom: false, name: '', url: '' }; }
})();
const METADATA_FILL_CONCURRENCY = 4;
const SONG_INFO_BATCH_FIELD_OPTIONS = Object.freeze([
  { key: "title", label: "标题" },
  { key: "artists", label: "歌手" },
  { key: "album", label: "专辑" },
  { key: "albumArtists", label: "专辑歌手" },
  { key: "releaseDate", label: "发行日期" },
  { key: "trackNumber", label: "曲号" },
  { key: "discNumber", label: "碟号" },
  { key: "genres", label: "流派" },
  { key: "cover", label: "封面" },
  { key: "composers", label: "作曲" },
  { key: "lyricists", label: "作词" },
]);
const SONG_INFO_BATCH_SCOPE_OPTIONS = Object.freeze([
  { value: "all", label: "全部歌曲" },
  { value: "playlist", label: "当前歌单" },
  { value: "selected", label: "选中歌曲" },
]);
const SONG_INFO_BATCH_SCOPES = new Set(SONG_INFO_BATCH_SCOPE_OPTIONS.map((option) => option.value));
const SONG_INFO_LOOKUP_FIELDS = Object.freeze(SONG_INFO_BATCH_FIELD_OPTIONS.map((option) => option.key));
const DEFAULT_SONG_INFO_BATCH_FIELDS = Object.freeze({
  title: true,
  artists: true,
  album: true,
  albumArtists: true,
  releaseDate: true,
  trackNumber: true,
  discNumber: true,
  genres: true,
  cover: true,
  composers: false,
  lyricists: false,
});
const STORAGE_KEYS = Object.freeze({
  LAST_TRACK: "lx-last-track",
  LAST_TRACK_REF: "lx-last-track-ref",
  VOLUME: "lx-volume",
  THEME: "lx-theme",
  ACCENT: "lx-color",
  LYRIC_FONT: "lx-lyric-font",
  LYRIC_MAIN_FONT: "lx-lyric-main-font",
  LYRIC_SUB_FONT: "lx-lyric-sub-font",
  LYRIC_FONT_FAMILY: "lx-lyric-font-family",
  LYRIC_INACTIVE_COLOR: "lx-lyric-inactive-color",
  LYRIC_ACTIVE_COLOR: "lx-lyric-active-color",
  LYRIC_META_COLOR: "lx-lyric-meta-color",
  LYRIC_TEXT_COLOR_LEGACY: "lx-lyric-text-color",
  LYRIC_BG_COLOR: "lx-lyric-bg-color",
  LYRIC_ACTIVE_SCALE: "lx-lyric-active-scale",
  LYRIC_DISPLAY_MODE: "lx-lyric-display-mode",
  LYRIC_KARAOKE: "lx-lyric-karaoke",
  LYRIC_GLOW_ENABLED: "lx-lyric-glow-enabled",
  LYRIC_GLOW_SPEED: "lx-lyric-glow-speed",
  LYRIC_RENDER_DELAY_MS: "lx-lyric-render-delay-ms",
  LYRIC_FOCUS_LEAD_MS: "lx-lyric-focus-lead-ms",
  LYRIC_SWITCH_SCROLL_MS: "lx-lyric-switch-scroll-ms",
  LYRIC_SAVE_TRANSLATION: "lx-lyric-save-translation",
  LYRIC_SAVE_ROMANIZATION: "lx-lyric-save-romanization",
  DESKTOP_LYRIC_ENABLED: "lx-desktop-lyric-enabled",
  DESKTOP_LYRIC_LOCKED: "lx-desktop-lyric-locked",
  DESKTOP_LYRIC_FONT_SIZE: "lx-desktop-lyric-font-size",
  DESKTOP_LYRIC_MAIN_FONT: "lx-desktop-lyric-main-font",
  DESKTOP_LYRIC_SUB_FONT: "lx-desktop-lyric-sub-font",
  DESKTOP_LYRIC_OPACITY: "lx-desktop-lyric-opacity",
  DESKTOP_LYRIC_STROKE: "lx-desktop-lyric-stroke",
  DESKTOP_LYRIC_COVER_COLOR: "lx-desktop-lyric-cover-color",
  DESKTOP_LYRIC_CURRENT_ONLY: "lx-desktop-lyric-current-only",
  CUSTOM_PLAYLISTS: "lx-custom-playlists",
  PLAYLIST_ORDER: "lx-playlist-order",
  LAST_VIEW: "lx-last-view",
  UI_SNAPSHOT: "lx-ui-snapshot",
  UI_LIBRARY_SNAPSHOT: "lx-library-snapshot",
  USE_RECOMMEND: "lx-use-recommend",
  RECOMMEND_FULL_MODE: "lx-recommend-full-mode",
  ONLINE_MUSIC_SOURCE: "lx-online-music-source",
  ONLINE_SONGLIST_SOURCE: "lx-online-songlist-source",
  ONLINE_FILE_SOURCE: "lx-online-file-source",
  PLAY_HISTORY: "lx-play-history",
  PLAY_HISTORY_REFS: "lx-play-history-refs",
  DEFAULTS_VERSION: "lx-defaults-version",
  SONG_INFO_BATCH_SETTINGS: "lx-song-info-batch-settings",
});

const DEFAULTS_VERSION = "2026-06-config-renderer-state-v2";
const rendererStateStore = (() => {
  try {
    const state = window.lxEnv?.getRendererStateSync?.();
    return state && typeof state === "object" ? { ...state } : {};
  } catch {
    return {};
  }
})();

function getLegacyLocalStorageValue(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key, value) {
  rendererStateStore[key] = String(value ?? "");
  window.lxEnv?.setRendererState?.(key, rendererStateStore[key]).catch?.(() => {});
}

function writeStoredIfChanged(key, value) {
  const nextValue = String(value ?? "");
  if (readStoredString(key, null) === nextValue) return false;
  writeStored(key, nextValue);
  return true;
}

function removeStored(key) {
  delete rendererStateStore[key];
  window.lxEnv?.removeRendererState?.(key).catch?.(() => {});
}

function migrateLegacyLocalStorageToRendererState() {
  Object.values(STORAGE_KEYS).forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(rendererStateStore, key)) return;
    const legacy = getLegacyLocalStorageValue(key);
    if (legacy === null) return;
    writeStored(key, legacy);
  });
}

function applyDefaultStorageMigration() {
  if (rendererStateStore[STORAGE_KEYS.DEFAULTS_VERSION] === DEFAULTS_VERSION) return;
  const pairs = [
    [STORAGE_KEYS.LYRIC_FONT, DEFAULT_LYRIC_FONT_SIZE],
    [STORAGE_KEYS.LYRIC_MAIN_FONT, DEFAULT_LYRIC_FONT_SIZE],
    [STORAGE_KEYS.LYRIC_SUB_FONT, DEFAULT_LYRIC_SUB_FONT_SIZE],
    [STORAGE_KEYS.LYRIC_FONT_FAMILY, DEFAULT_LYRIC_FONT_FAMILY],
    [STORAGE_KEYS.LYRIC_ACTIVE_SCALE, DEFAULT_LYRIC_ACTIVE_SCALE],
    [STORAGE_KEYS.LYRIC_DISPLAY_MODE, DEFAULT_LYRIC_DISPLAY_MODE],
    [STORAGE_KEYS.LYRIC_GLOW_ENABLED, DEFAULT_LYRIC_GLOW_ENABLED ? "1" : "0"],
    [STORAGE_KEYS.LYRIC_GLOW_SPEED, DEFAULT_LYRIC_GLOW_SPEED],
    [STORAGE_KEYS.LYRIC_RENDER_DELAY_MS, DEFAULT_LYRIC_RENDER_DELAY_MS],
    [STORAGE_KEYS.LYRIC_FOCUS_LEAD_MS, DEFAULT_LYRIC_FOCUS_LEAD_MS],
    [STORAGE_KEYS.LYRIC_SWITCH_SCROLL_MS, DEFAULT_LYRIC_SWITCH_SCROLL_MS],
    [STORAGE_KEYS.LYRIC_SAVE_TRANSLATION, "1"],
    [STORAGE_KEYS.LYRIC_SAVE_ROMANIZATION, "0"],
    [STORAGE_KEYS.DESKTOP_LYRIC_LOCKED, DEFAULT_DESKTOP_LYRIC_LOCKED ? "1" : "0"],
    [STORAGE_KEYS.DESKTOP_LYRIC_MAIN_FONT, DEFAULT_DESKTOP_LYRIC_FONT_SIZE],
    [STORAGE_KEYS.DESKTOP_LYRIC_FONT_SIZE, DEFAULT_DESKTOP_LYRIC_FONT_SIZE],
    [STORAGE_KEYS.DESKTOP_LYRIC_SUB_FONT, DEFAULT_DESKTOP_LYRIC_SUB_FONT_SIZE],
    [STORAGE_KEYS.DESKTOP_LYRIC_OPACITY, DEFAULT_DESKTOP_LYRIC_OPACITY],
    [STORAGE_KEYS.DESKTOP_LYRIC_STROKE, DEFAULT_DESKTOP_LYRIC_STROKE],
    [STORAGE_KEYS.DESKTOP_LYRIC_CURRENT_ONLY, DEFAULT_DESKTOP_LYRIC_CURRENT_ONLY ? "1" : "0"],
  ];
  pairs.forEach(([key, value]) => {
    if (!Object.prototype.hasOwnProperty.call(rendererStateStore, key)) writeStored(key, value);
  });
  writeStored(STORAGE_KEYS.DEFAULTS_VERSION, DEFAULTS_VERSION);
}

migrateLegacyLocalStorageToRendererState();
applyDefaultStorageMigration();

let audio = new Audio();
const AudioEffects = window.FlowaveAudioEffects;
// Active audio + three prepared intents + one replacement buffer; all standby elements stay paused.
const audioSlots = AudioEffects ? [audio, new Audio(), new Audio(), new Audio(), new Audio()] : [audio];
for (const slot of audioSlots) { slot.crossOrigin = "anonymous"; slot.preload = "auto"; }
let overlapRecovery = null;
const audioEngine = AudioEffects ? new AudioEffects.Engine(audioSlots, window.AudioContext || window.webkitAudioContext, element => { if (overlapRecovery?.outgoing === element) overlapRecovery = null; }) : null;
let naturalFade = null, inflightNaturalFade = null, naturalFadeRevision = 0, naturalFadeAttempted = "";
let audioSettingsSaveTimer = null, audioDialogFocus = null, effectsResumePromise = null;
let practiceMetronome = null, practiceMetronomeGeneration = 0, practiceMetronomePreview = null, practiceMetronomePreviewTimer = null;
let practicePlayer = null, practiceOriginal = null, practiceController = null, practiceGeneration = 0;
let practiceTraining=null,practiceTrainingGeneration=0;
const slotEventHandlers = [];
const wireAudioSlot = slot => slotEventHandlers.forEach(([name, handler]) => slot.addEventListener(name, event => { if (slot === audio) handler(event); }));
audio.preload = "auto";
audio.volume = 0.8;
const HOTKEY_ACTIONS = Object.freeze({
  next_like: function nextLikeAction() {
    return this.useRecommend ? this.playLike() : this.nextTrack();
  },
  toggle_lyric: function toggleLyricAction() {
    return this.toggleLyric();
  },
  open_search: function openSearchAction() {
    return this.focusSearchInput();
  },
  locate_current: function locateCurrentAction() {
    return this.locateTrack(this.currentPath);
  },
  prev: function prevAction() {
    return this.prevTrack();
  },
  vol_up: function volUpAction() {
    return this.adjustVolumeBy(5);
  },
  vol_down: function volDownAction() {
    return this.adjustVolumeBy(-5);
  },
  toggle_desktop_lyric: function toggleDesktopLyricAction() {
    this.desktopLyricEnabled = !this.desktopLyricEnabled;
    return this.saveDesktopLyricSettings();
  },
  favorite: function favoriteAction() {
    return this.toggleFavoriteCurrentTrack();
  },
  play_pause: function playPauseAction() {
    return this.togglePlay();
  },
  dislike_next: function dislikeNextAction() {
    return this.playDislike();
  },
});
const LOCAL_PROXY_BASE = "http://127.0.0.1:3901";

function readStoredString(key, fallback) {
  if (key === 'lx-sound-map-trace' && rendererStateStore.__flowaveTraceArchive?.mode && rendererStateStore.__flowaveTraceArchive.mode !== 'legacy') return fallback;
  const val = Object.prototype.hasOwnProperty.call(rendererStateStore, key) ? rendererStateStore[key] : getLegacyLocalStorageValue(key);
  return val === null ? fallback : val;
}

function readStoredNumber(key, fallback) {
  const raw = readStoredString(key, null);
  if (raw === null || raw === undefined || String(raw).trim() === "") return fallback;
  const val = Number(raw);
  return Number.isFinite(val) ? val : fallback;
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  const safe = Number.isFinite(n) && n !== 0 ? n : fallback;
  return Math.max(min, Math.min(max, safe));
}

function clampNumberAllowZero(value, fallback, min, max) {
  const n = value === null || value === undefined || String(value).trim() === ""
    ? Number.NaN
    : Number(value);
  const safe = Number.isFinite(n) ? n : fallback;
  return Math.max(min, Math.min(max, safe));
}

function readStoredBool(key, fallback = false) {
  const val = readStoredString(key, null);
  if (val === null) return fallback;
  return val === "1";
}

function readStoredStringArray(key, maxLength = 500) {
  try {
    const value = JSON.parse(readStoredString(key, "[]"));
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => typeof item === "string" && item.length > 0)
      .slice(-Math.max(0, Number(maxLength) || 0));
  } catch {
    return [];
  }
}

function readStoredObjectArray(key, maxLength = 500) {
  try {
    const value = JSON.parse(readStoredString(key, "[]"));
    if (!Array.isArray(value)) return [];
    return value
      .filter((item) => item && typeof item === "object" && !Array.isArray(item))
      .slice(-Math.max(0, Number(maxLength) || 0));
  } catch {
    return [];
  }
}

function readStoredObject(key, fallback = {}) {
  try {
    const value = JSON.parse(readStoredString(key, "{}"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : { ...fallback };
  } catch {
    return { ...fallback };
  }
}

function pickRecommendPathByPolicy(vm, key) {
  const cache = vm.recCache || {};
  const toValidList = (arr) => (Array.isArray(arr) ? arr.filter((x) => x && x.path) : []);
  const likeList = toValidList(cache.like_list);
  const dislikeList = toValidList(cache.dislike_list);

  if (key === "like_next" && likeList.length) {
    if (cache.diagnostic?.policy === "session-intent-v5") {
      let cursor = Math.random();
      for (const item of likeList) {
        cursor -= Number(item.probability) || 0;
        if (cursor <= 0) return item.path;
      }
      return likeList[likeList.length - 1].path;
    }
    // 按排名递减概率：1, 1/2, 1/3 ...
    const weights = likeList.map((item, i) => (1 / (i + 1)) * Math.max(1, Math.min(1.25, Number(item.continuity_reward) || 1)));
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < likeList.length; i += 1) {
      r -= weights[i];
      if (r <= 0) return likeList[i].path;
    }
    return likeList[0].path;
  }
  if (key === "dislike_next" && dislikeList.length) {
    const selected = cache?.dislike_next?.path || dislikeList.find((item) => item.selected)?.path;
    if (selected) return selected;
    const weights = dislikeList.map((item) => {
      const w = Number(item.weight);
      return Number.isFinite(w) && w > 0 ? w : 1;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    if (total > 0) {
      let r = Math.random() * total;
      for (let i = 0; i < dislikeList.length; i += 1) {
        r -= weights[i];
        if (r <= 0) return dislikeList[i].path;
      }
    }
    return dislikeList[Math.floor(Math.random() * dislikeList.length)].path;
  }
  return cache?.[key]?.path || "";
}

function recommendationPacketPending(data) {
  const d=data?.diagnostic?.details;
  return ['building','unavailable'].includes(d?.semantic_status)||['index_building','analysis_building','analysis_inputs_pending'].includes(d?.preparation_status)||d?.reason==='context_preparing';
}

function recommendationPacketQuality(data, intent) {
  const rows = intent === 'change' ? data?.dislike_list : data?.like_list;
  if (!rows?.length || data?.missing || recommendationPacketPending(data)) return -1;
  if(data.diagnostic?.details?.context_reserve)return data.diagnostic.details.model==='muq+mert'?2.5:1.5;
  const fallback = data.diagnostic?.details?.fallback || data.stats?.like_fallback_level;
  if (fallback === 'library_reserve') return 0;
  if (fallback === 'continuity_reserve' || fallback === 'adjacent_mert_reserve') return 1;
  return (data.diagnostic?.details?.model || data.stats?.model) === 'muq+mert' ? 3 : 2;
}

async function tryPlayRecommendWithFallback(vm, key, withPrefetch = true, trigger = key, ready = null, previousEvidence = null) {
  if (!vm.useRecommend) return { candidateFound: false, result: null };
  const pendingEvidence=vm.recommendationResume;
  if(!previousEvidence&&pendingEvidence?.origin===vm.currentPath&&pendingEvidence.generation===vm.playbackGeneration)
    previousEvidence=pendingEvidence.previousEvidence;
  const action = vm.recommendationActionId = Number(vm.recommendationActionId || 0) + 1;
  const origin = vm.currentPath; let generation = vm.playbackGeneration;
  const current = () => action === vm.recommendationActionId && origin === vm.currentPath && generation === vm.playbackGeneration && vm.useRecommend;
  const intent = key === 'dislike_next' ? 'change' : trigger === 'like_button' ? 'recover' : vm.getDefaultRecommendationIntent();
  ready ||= vm.takePreparedRecommendation?.(intent);
  const guarded=intent==='continue';
  // Consume prepared decisions first; unfinished input queues this action for background preparation.
  let data = ready?.recommendationContext || (vm.hasFreshRecCache(intent) ? vm.recCache : null)
    || vm.getRecommendationReserve?.(intent);
  if(ready?.promise&&!ready.ready){
    const prepared=await ready.promise;
    if(!current()){vm.releasePreparedRecommendation?.(ready);return {candidateFound:true,result:{ok:false,canceled:true}};}
    if(!prepared?.ready){vm.releasePreparedRecommendation?.(ready);ready=null;}
  }
  const listKey=key==='dislike_next'?'dislike_list':'like_list';
  const computedEmpty=data?.diagnostic?.policy==='session-intent-v5'&&!data?.missing
    &&!recommendationPacketPending(data)&&!(data[listKey]||[]).length;
  if(computedEmpty){
    const scored=vm.getContextRecommendationReserve(intent,data);
    if(scored?.[listKey]?.length)data=scored;
    else{
      vm.releasePreparedRecommendation?.(ready);
      vm.showNotice(data.diagnostic?.details?.preparation_status==='index_required'?'当前歌曲尚未完成推荐索引，请先完成索引。':'推荐计算已完成，当前没有满足条件的可播放歌曲，保留当前播放。');
      return {candidateFound:true,result:{ok:false,exhausted:true}};
    }
  }
  if(guarded){
    data=vm.filterAdjacentRecommendation(data)||vm.getAdjacentRecommendationReserve();
    if(ready&&!data?.like_list?.some(row=>row.path===ready.path)){vm.releasePreparedRecommendation?.(ready);ready=null;}
    if(ready)ready.recommendationContext=data;
  }else if(key==='dislike_next'){
    data=vm.filterChangeRecommendation(data)||vm.getChangeRecommendationReserve();
    if(ready&&!data.dislike_list?.some(row=>row.path===ready.path)){vm.releasePreparedRecommendation?.(ready);ready=null;}
    if(ready)ready.recommendationContext=data;
  }
  if(recommendationPacketPending(data)){
    vm.releasePreparedRecommendation?.(ready);
    if(trigger!=='natural')vm.cancelNaturalCrossfade?.(false);
    vm.recommendationResume={intent,origin,generation,action,stamp:vm.getRecommendationPolicyStamp(),key,trigger,previousEvidence};
    // Preserve the requested action while preparation finishes; never choose an unreviewed stand-in.
    // A rejection can invalidate every in-flight job. Replace the old refresh timer
    // even when jobs still exist, so the requested action cannot wait on stale work.
    if(!vm.recommendationJobs?.jobs?.has(JSON.stringify([origin,vm.recommendationResume.stamp,intent])))
      void vm.scheduleRecommendPrefetch?.(0);
    vm.showNotice('推荐正在准备，完成后自动切换。');
    return {candidateFound:true,result:{ok:false,preparing:true}};
  }
  const candidates = [];
  if (ready?.path) candidates.push(ready.path);
  if (data) {
    const picked = pickRecommendPathByPolicy({recCache:data}, key);
    if (picked) candidates.push(picked);
    candidates.push(...(key === 'dislike_next' ? data.dislike_list || [] : data.like_list || []).map(row=>row.path));
  }
  let reserve = vm.getContextRecommendationReserve(intent,data)||(guarded?vm.getAdjacentRecommendationReserve():key==='dislike_next'?vm.getChangeRecommendationReserve():vm.getRecommendationReserve?.(intent));
  candidates.push(...(key === 'dislike_next' ? reserve?.dislike_list || [] : reserve?.like_list || []).map(row=>row.path));
  // Only fully evaluated normal/reserve candidates may enter playback; no library walk or placeholder replay.
  let lastError = '';
  const queue=[...new Set(candidates)].filter(Boolean);
  for (let cursor=0;cursor<queue.length;cursor++) {
    const path=queue[cursor];
    if (!current()) {vm.releasePreparedRecommendation?.(ready);return {candidateFound:true,result:{ok:false,canceled:true}};}
    if (vm.recommendationJobs?.failed?.has(path)) continue;
    const packet = ready?.path===path ? ready.recommendationContext : data?.[key==='dislike_next'?'dislike_list':'like_list']?.some(r=>r.path===path) ? data : reserve;
    if (packet) { vm.recCache=packet; vm.recCacheFor=origin; }
    if(guarded&&vm.getAdjacentMertSimilarity(path,packet)<vm.getEffectiveAdjacentMertFloor(packet))continue;
    if(key==='dislike_next'&&(path===origin||vm.getAdjacentMertSimilarity(path,packet)<0||vm.getAdjacentMertSimilarity(path,packet)>vm.getChangeMertCeiling()))continue;
    const result = await vm.playByPath(path,true,key,{trigger,previousEvidence,recommendationContext:packet,prepared:ready?.path===path&&ready.ready?ready:undefined});
    vm.releasePreparedRecommendation?.(ready);
    if(result?.ok && packet?.diagnostic?.details?.recovery_reference_missing)
      vm.showNotice('没有此前的感觉参考，已改为换个方向。');
    if(result?.ok&&guarded&&path===origin)vm.showNotice('推荐计算已完成，其他合格候选不足，重播当前歌曲。');
    if (result?.ok || result?.canceled || action!==vm.recommendationActionId || origin!==vm.currentPath) return {candidateFound:true,result};
    generation=vm.playbackGeneration;
    if(previousEvidence)previousEvidence={...previousEvidence,
      playbackGeneration:Number(vm._committedPlaybackGeneration ?? vm.playbackGeneration)};
    lastError = result?.error || lastError;
    if(!result?.adjacentRejected&&!result?.changeRejected&&!result?.policyRejected)vm.markRecommendationUnavailable?.(path);
    if(guarded){
      reserve=vm.getContextRecommendationReserve(intent,data)||vm.getAdjacentRecommendationReserve();
      for(const row of reserve.like_list||[])if(!queue.includes(row.path))queue.push(row.path);
      const replay=queue.indexOf(origin,cursor+1);if(replay>=0&&replay<queue.length-1)queue.push(...queue.splice(replay,1));
    }
    if(key==='dislike_next'){reserve=vm.getContextRecommendationReserve(intent,data)||vm.getChangeRecommendationReserve();for(const row of reserve.dislike_list||[])if(!queue.includes(row.path))queue.push(row.path);}
    ready = null;
  }
  // Missing/broken media are distinct from similarity exhaustion. Keep playing while replenishing the reserve.
  vm.scheduleRecommendPrefetch?.(0);
  const message = lastError || (key==='dislike_next'?'暂未准备好不同感觉的歌曲，保留当前播放并继续准备。':'曲库中暂时没有可读取的音频，正在重新准备。');
  vm.showNotice(message);
  return {candidateFound:true,result:{ok:false,error:message,resourcesUnavailable:true}};
}

const audioEffectsMethods = {
  async recoverCrossfadeAudioError() {
    const saved = overlapRecovery;
    if (!saved || saved.generation !== this._committedPlaybackGeneration || saved.outgoing.ended
        || audioEngine?.tail !== saved.outgoing) {
      this.pauseByInternal("audio-error");
      this.lastPlaybackError = "音频读取失败，请重新播放或切换歌曲。";
      return;
    }
    overlapRecovery = null;
    const failedDiagnosticId = this.listeningSession?.recommendationDiagnosticId;
    this.flushListeningSession("crossfade-error", { deferSave: true });
    this.finishRecommendationDiagnostic(failedDiagnosticId, "failed", { playbackErrorAfterStart: true });
    const failed = audio;
    audioEngine.tail = null;
    audioEngine.stopTail(null);
    audio = saved.outgoing;
    audioEngine.gain(audio, 1);
    audioEngine.release(failed);
    const snapshot = { ...saved.snapshot, keepCurrentAudio: true, position: Number(audio.currentTime) || 0 };
    const transition = this.beginPlaybackTransition(snapshot.path, "crossfade_recovery", snapshot);
    try {
      await this.restorePlaybackSnapshot(snapshot, transition);
      this.assertCurrentPlaybackTransition(transition);
      this.persistLastTrackReference(snapshot.path);
      this.finishPlaybackTransition(transition);
      this.audioEffectsMessage = "下一首音频读取失败，已恢复原歌曲。";
    } catch (error) {
      if (!this.isStalePlaybackTransitionError(error)) {
        this.finishPlaybackTransition(transition);
        this.isPlaying = false;
        this.lastPlaybackError = this.getPlaybackUserMessage(error);
      }
    }
  },
  async prepareSafeAudioOutput(resume = false, allowOutputChange = false, wearToken = null) {
    if (this.outputSafetyBlocked && !resume) throw new PlaybackTransitionUtils.StalePlaybackTransitionError("耳机输出变化后已停止播放");
    if (!window.lxEnv?.prepareAudioOutput) return;
    const revision = this.outputSafetyRevision;
    const result = await window.lxEnv.prepareAudioOutput({playing:true,resume,allowOutputChange,wearToken});
    if (revision !== this.outputSafetyRevision || !result?.ok) {
      if (revision === this.outputSafetyRevision && result?.blocked) {
        this.outputSafetyBlocked = true;
        this.playbackIntent = "pause";
      }
      throw new PlaybackTransitionUtils.StalePlaybackTransitionError("请确认耳机连接后点击播放");
    }
    if (resume) this.outputSafetyBlocked = false;
    if (result.warning === 'output-unconfirmed' && !this.outputSafetyWarningShown) {
      this.outputSafetyWarningShown = true;
      this.showNotice("暂时无法确认输出设备，耳机断连保护尚未就绪。", "error");
    }
  },
  isWearResumeCurrent(saved) {
    return !!saved && !this.pendingPlaybackTransition && saved.path === this.currentPath
      && saved.generation === this.playbackGeneration && saved.revision === this.outputSafetyRevision;
  },
  cancelWearResume() {
    if (!this.outputSafetyWearResume) return;
    this.outputSafetyWearResume = null;
    this.outputSafetyRevision++;
    window.lxEnv?.prepareAudioOutput?.({playing:false})?.catch?.(() => {});
  },
  async resumeByHeadphoneWear(event) {
    const saved = this.outputSafetyWearResume;
    if (!saved || saved.token !== event.wearToken || saved.resuming) return false;
    if (!this.isWearResumeCurrent(saved) || this.playbackIntent !== 'pause') { this.cancelWearResume(); return false; }
    saved.resuming = true;
    saved.revision = ++this.outputSafetyRevision;
    this.playbackIntent = 'play';
    const current = () => this.outputSafetyWearResume === saved && this.isWearResumeCurrent(saved) && this.playbackIntent === 'play';
    try {
      await this.prepareSafeAudioOutput(true, false, saved.token);
      if (!current()) return false;
      await this.resumeCurrentPathPlayback();
      if (!current()) return false;
      this.outputSafetyWearResume = null;
      this.lastPlaybackError = '';
      this.setPauseState('none', 'headphones-worn');
      return true;
    } catch (error) {
      if (!current()) return false;
      this.pauseByManual('headphones-resume-failed');
      if (!this.isStalePlaybackTransitionError(error)) {
        this.lastPlaybackError = this.getPlaybackUserMessage(error);
        this.showNotice(this.lastPlaybackError, 'error');
      }
      return false;
    }
  },
  handleAudioOutputSafety(event = {}) {
    if (event.reason === 'headphones-worn') return this.resumeByHeadphoneWear(event);
    const canResume = event.reason === 'headphones-removed' && Number.isSafeInteger(event.wearToken)
      && ((this.isPlaying && this.playbackIntent === 'play' && this.currentPath && !this.pendingPlaybackTransition)
        || this.isWearResumeCurrent(this.outputSafetyWearResume));
    this.outputSafetyBlocked = true;
    this.pauseByManual("output-safety:" + String(event.reason || "changed"), canResume ? event.wearToken : null);
    this.playbackGeneration = playbackTransitionCoordinator.invalidate();
    this.pendingPlaybackTransition = null;
    if (canResume) this.outputSafetyWearResume = { token: event.wearToken, path: this.currentPath,
      generation: this.playbackGeneration, revision: this.outputSafetyRevision, resuming: false };
    for (const slot of audioSlots) if (!slot.paused) slot.pause();
    practicePlayer?.pause();
    audioEngine?.context?.suspend()?.catch?.(() => {});
    this.showNotice(event.reason === 'headphones-removed'
      ? "双耳均已摘下，播放已暂停。"
      : "耳机输出已变化，播放已暂停。确认设备后点击播放继续。", "error");
  },
  async resumeEffectsEngine() {
    await this.prepareSafeAudioOutput();
    if (!audioEngine) return;
    // Leave ordinary playback on the native media path until an effect is needed.
    if (!audioEngine.context && !this.audioEffects.enabled && !this.audioEffects.crossfade) return;
    if (effectsResumePromise) return effectsResumePromise;
    effectsResumePromise = (async () => {
    try { await audioEngine.resume(); }
    catch (error) {
      const previous = { src: audio.currentSrc || audio.src || "", time: Number(audio.currentTime) || 0,
        playing: !audio.paused, rate: audio.playbackRate || 1 };
      this.disablePractice(false);
      this.cancelNaturalCrossfade();
      audioEngine.disable();
      for (let i = 0; i < audioSlots.length; i++) {
        const slot = new Audio(); slot.crossOrigin = "anonymous"; slot.preload = "auto";
        audioSlots[i] = slot; wireAudioSlot(slot);
      }
      audio = audioSlots[0]; audio.playbackRate = previous.rate;
      audioEngine.setVolume(this.volume / 100, this.muted);
      if (previous.src) {
        audio.src = previous.src; audio.load();
        await this.waitForAudioMetadata();
        try { audio.currentTime = previous.time; } catch { /* 保留播放能力。 */ }
        if (previous.playing) await audio.play().catch(() => {});
      }
      this.audioEffectsMessage = "音效输出暂不可用，已恢复普通播放；重新打开软件后可重试。";
    }
    })();
    try { await effectsResumePromise; } finally { effectsResumePromise = null; }
  },
  openEqualizer() {
    audioDialogFocus = document.activeElement;
    this.equalizerOpen = true;
    this.$nextTick(() => this.$refs.equalizerClose?.focus());
  },
  closeEqualizer() {
    this.equalizerOpen = false;
    this.$nextTick(() => audioDialogFocus?.focus?.());
  },
  async updateAudioEffects(custom = false) {
    if (!AudioEffects || !audioEngine) return;
    if (custom) this.audioEffects.preset = "custom";
    this.audioEffects = AudioEffects.normalize(this.audioEffects);
    this.cancelNaturalCrossfade();
    if (!this.audioEffects.crossfade) audioEngine.stopTail(audio, true);
    audioEngine.apply(this.audioEffects);
    clearTimeout(audioSettingsSaveTimer);
    audioSettingsSaveTimer = setTimeout(() => {
      writeStored("lx-audio-effects", JSON.stringify(this.audioEffects));
      audioSettingsSaveTimer = null;
    }, 300);
    try {
      if (this.currentPath && !audio.paused) await this.resumeEffectsEngine();
      this.audioEffectsMessage = audioEngine.Context ? "" : "当前音频输出不支持音效，已保持普通播放。";
    } catch (error) { this.audioEffectsMessage = this.getPlaybackUserMessage(error); }
  },
  selectEqualizerPreset() {
    const preset = AudioEffects?.presets[this.audioEffects.preset];
    if (preset) this.audioEffects.gains = [...preset.gains];
    this.updateAudioEffects();
  },
  resetEqualizer() {
    this.audioEffects.preset = "flat";
    this.audioEffects.preamp = 0;
    this.selectEqualizerPreset();
  },
  naturalQueueStamp() {
    const seedQueue = this.playlists?.find(p => p.id === this.currentPlaylist && p.type === "seed");
    return [this.currentPath, this.currentPlaylist, this.keyword, this.playMode, this.useRecommend,
      this._trackLoadGeneration, this.recommendFullMode, this.useRecommend ? this.getRecommendationPolicyStamp() : "",
      seedQueue ? JSON.stringify([seedQueue.tracks, seedQueue.seedPolicy, seedQueue.seedWrapSafe, seedQueue.seedVerification]) : ""].join("|");
  },
  canNaturallyAdvanceSeedQueue() {
    if (this.useRecommend || this.playMode === "shuffle") return true;
    const playlist = this.playlists?.find(p => p.id === this.currentPlaylist && p.type === "seed");
    if (!playlist) return true;
    if (playlist.seedPolicy !== 2 || playlist.seedVerification !== 1) return false;
    if (playlist.seedWrapSafe !== false) return true;
    const queue = this.getPlaybackQueueTracks();
    return queue.length > 0 && queue[queue.length - 1].path !== this.currentPath;
  },
  cancelNaturalCrossfade(resetAttempt = true, keep = null) {
    naturalFadeRevision += 1;
    const reserved = naturalFade; naturalFade = null;
    if (reserved?.ready) this.soundMapTraceRevision++;
    if (reserved && reserved !== keep) this.finishRecommendationDiagnostic(reserved.diagnosticId, "canceled");
    if (reserved?.element && reserved !== keep && reserved.element !== audio) audioEngine?.release(reserved.element);
    if (inflightNaturalFade && inflightNaturalFade !== keep) {
      const active = inflightNaturalFade; inflightNaturalFade = null;
      if (active.element !== audio) audioEngine?.release(active.element);
      this.finishRecommendationDiagnostic(active.diagnosticId, "canceled");
      if (active.transition && playbackTransitionCoordinator.isCurrent(active.transition)) {
        playbackTransitionCoordinator.invalidate(); this.pendingPlaybackTransition = null;
      }
    }
    if (resetAttempt) naturalFadeAttempted = "";
  },
  checkNaturalCrossfade() {
    if (!this.canNaturallyAdvanceSeedQueue()) { this.cancelNaturalCrossfade(false); return; }
    if(practiceTraining?.region&&practiceTraining.source===audio)return;
    if (practicePlayer || practiceController) return;
    if (!audioEngine?.context || !this.audioEffects.crossfade || !this.isPlaying || audio.paused
        || audio.seeking || this.pendingPlaybackTransition || this.listeningHistoryActionBusy) return;
    const duration = Number(audio.duration), rate = Number(audio.playbackRate) || 1;
    if (!Number.isFinite(duration) || duration < 2) return;
    const remaining = (duration - audio.currentTime) / rate;
    const seconds = Math.min(this.audioEffects.seconds, duration / rate / 2);
    const stamp = this.naturalQueueStamp();
    if (naturalFade && (naturalFade.stamp !== stamp || (!this.useRecommend && naturalFade.queue !== this.filteredTracks))) {
      this.cancelNaturalCrossfade();
    }
    if (this.useRecommend && naturalFade?.ready) {
      const intent=this.getDefaultRecommendationIntent(),cached=this.recommendationJobs?.caches?.get(intent);
      if (cached?.stamp===this.getRecommendationPolicyStamp() && Date.now()-cached.at<120000
          && recommendationPacketQuality(cached.data,intent)>recommendationPacketQuality(naturalFade.recommendationContext,intent)) {
        this.cancelNaturalCrossfade();naturalFadeAttempted='';
      }
    }
    if (naturalFade?.ready && remaining <= seconds && remaining > 0.12) {
      const prepared = naturalFade; naturalFade = null;
      prepared.seconds = Math.min(seconds, remaining, Number(prepared.element.duration) / rate / 2 || seconds);
      this.playByPath(prepared.path, true, prepared.source, { prepared });
    } else if (!naturalFade && !audioEngine.tail && !audioEngine.releasingTail && naturalFadeAttempted !== stamp && remaining <= seconds + 5 && remaining > 0.5) {
      naturalFadeAttempted = stamp;
      this.prepareNaturalCrossfade(stamp);
    }
  },
  async prepareNaturalCrossfade(stamp) {
    if(this.useRecommend&&this.getDefaultRecommendationIntent()!=='continue')return;
    const revision = ++naturalFadeRevision;
    let ready=this.useRecommend?this.takePreparedRecommendation(this.getDefaultRecommendationIntent()):null;
    if(ready?.promise&&!ready.ready){
      await ready.promise;
      if(!ready.ready||naturalFadeRevision!==revision||stamp!==this.naturalQueueStamp()||!this.audioEffects.crossfade){
        this.releasePreparedRecommendation(ready);return;
      }
    }
    if(ready&&this.getAdjacentMertSimilarity(ready.path,ready.recommendationContext)<this.getEffectiveAdjacentMertFloor(ready.recommendationContext)){
      this.releasePreparedRecommendation(ready);ready=null;
    }
    if(ready?.ready&&ready.element){this.recommendationJobs.claimed.delete(ready);ready.actionTicket=false;ready.stamp=stamp;ready.revision=revision;ready.queue=this.filteredTracks;naturalFade=ready;this.soundMapTraceRevision++;this.checkNaturalCrossfade();return;}
    const held=new Set([...this.recommendationJobs?.media?.values()||[],...this.recommendationJobs?.preparing?.values()||[]].map(t=>t.element));
    const element = audioSlots.find(slot => slot !== audio&&!held.has(slot));
    if (!element || audioEngine.tail || audioEngine.releasingTail) return;
    const reserved = { stamp, element, from: audio, revision, queue: this.filteredTracks, ready: false };
    naturalFade = reserved;
    const guard = () => {
      if (naturalFade !== reserved || naturalFadeRevision !== revision || this.naturalQueueStamp() !== stamp
          || !this.canNaturallyAdvanceSeedQueue()
          || !this.audioEffects.crossfade || (!this.useRecommend && reserved.queue !== this.filteredTracks)) {
        const error = new Error("自动接歌准备已取消"); error.code = "STALE_PLAYBACK_TRANSITION"; throw error;
      }
    };
    try {
      guard();
      const packet=this.useRecommend?(this.filterAdjacentRecommendation(this.hasFreshRecCache()?this.recCache:null)||this.getAdjacentRecommendationReserve()):null;
      let path = packet ? pickRecommendPathByPolicy({recCache:packet}, "like_next") : "";
      reserved.source = path ? "like_next" : "ended_fallback";
      if (!path && !this.useRecommend) path = PlaybackTransitionUtils.selectPlaylistNext(this.getPlaybackQueueTracks(), this.currentPath, this.playMode,
        { currentAliases: this.isOnlineToken(this.currentPath) ? [this.resolveOnlineRecommendAnchorPath(this.currentPath)] : [] })?.path;
      if (!path || path === this.currentPath) throw new Error("没有需要重叠的下一首");
      reserved.path = path;
      reserved.recommendationContext = packet || {};
      reserved.diagnosticId = this.beginRecommendationDiagnostic(path, reserved.source, reserved.recommendationContext, "natural");
      element.playbackRate = audio.playbackRate || 1;
      audioEngine.gain(element, 0);
      reserved.started = await this.startTargetAudio(path, guard, element, true);
      guard(); reserved.ready = true;
      this.soundMapTraceRevision++;
      this.checkNaturalCrossfade();
    } catch (error) {
      this.finishRecommendationDiagnostic(reserved.diagnosticId, this.isStalePlaybackTransitionError(error) ? "canceled" : "failed");
      if (naturalFade === reserved) { naturalFade = null; audioEngine.release(element); }
      if (!this.isStalePlaybackTransitionError(error)) this.audioEffectsMessage = "本次歌曲未准备好，将正常接歌。";
    }
  },
};

const playbackMethods = {
  getPlaybackUserMessage(error) {
    const message = String(error?.message || error || "").trim();
    if (!message) return "播放失败，请检查歌曲文件或音源。";
    if (/正在切换歌曲|在线曲目不存在|播放请求已被更新/.test(message)) return message;
    if (/ENOENT|not found|找不到|不存在|no such file/i.test(message)) {
      return "找不到歌曲文件。请刷新曲库或检查音乐目录。";
    }
    if (/NotSupported|MEDIA_ERR_(SRC_)?NOT_SUPPORTED|decode|解码|格式|损坏/i.test(message)) {
      return "音频格式不受支持或文件已损坏。";
    }
    if (/timeout|timed out|network|ECONN|ENET|上游状态码|HTTP|fetch failed/i.test(message)) {
      return "音源连接失败，请稍后重试。";
    }
    if (/EACCES|EPERM|permission|拒绝访问|无权限/i.test(message)) {
      return "无法读取歌曲文件。请检查文件权限。";
    }
    if (/在线播放|没有可用音频源|empty-url|source=|quality=|resolve:|\/play:/i.test(message)) {
      return "无法播放这首歌。请检查音源后重试。";
    }
    return "播放失败，请检查歌曲文件或音源。";
  },
  setPauseState(reason, source = "") {
    const r = String(reason || "none");
    this.playbackPauseReason = r;
    this.lastPauseSource = String(source || "");
    this.pausedByAudioInterruption = r === "interruption";
  },
  clearAudioInterruptSchedule(resetRetry = false) {
    const st = this.audioInterrupt || {};
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    if (resetRetry) st.retryCount = 0;
    st.armed = false;
    st.trackPath = "";
    this.audioInterrupt = st;
  },
  scheduleAutoResume(delayMs) {
    const st = this.audioInterrupt || {};
    if (!st.armed || this.playbackPauseReason !== "interruption" || this.isPlaying || !this.currentPath) return;
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    const baseDelay = Number(st.baseDelayMs) || 1200;
    const delay = Math.max(400, Number(delayMs) || baseDelay);
    const expectedPath = String(st.trackPath || this.currentPath);
    st.timer = setTimeout(() => {
      st.timer = null;
      this.resumeByAutoInterruption("timer", expectedPath);
    }, delay);
    this.audioInterrupt = st;
  },
  async resumeCurrentPathPlayback() {
    if (!this.currentPath) return;
    if (this.pendingPlaybackTransition) throw new Error("正在切换歌曲，请稍候");
    const expectedPath = String(this.currentPath);
    const expectedGeneration = Number(this.playbackGeneration) || 0;
    const outputRevision = this.outputSafetyRevision;
    const assertResumeStillCurrent = () => {
      if (
        this.pendingPlaybackTransition
        || outputRevision !== this.outputSafetyRevision
        || this.outputSafetyBlocked
        || expectedGeneration !== Number(this.playbackGeneration)
        || expectedPath !== String(this.currentPath || "")
      ) {
        throw new PlaybackTransitionUtils.StalePlaybackTransitionError("恢复播放已被切歌操作取代");
      }
    };
    if (!String(audio.getAttribute("src") || "").trim()) {
      if (this.isOnlineToken(this.currentPath)) {
        const track = this.onlineTrackMap[this.currentPath];
        if (!track) throw new Error("在线曲目不存在");
        const playSource = String(track.source || this.onlineFileSource || "").toLowerCase();
        const qualityQueue = this.buildOnlineQualityQueue(track);
        const errors = [];
        for (const quality of qualityQueue) {
          try {
            assertResumeStillCurrent();
            const resolved = await window.lxEnv.resolveOnlineUrl({
              source: playSource,
              quality,
              musicInfo: this.buildResolveMusicInfo(track),
            });
            assertResumeStillCurrent();
            const url = this.normalizeOnlineResolvedUrl(resolved);
            if (url) {
              const candidates = [this.wrapOnlineProxyUrl(url), ...(!audioEngine?.context ? [url] : [])].filter(Boolean);
              try {
                const actualSource = await this.playAudioWithFallback(candidates, assertResumeStillCurrent);
                assertResumeStillCurrent();
                this._committedAudioSource = actualSource;
                this._committedPlaybackGeneration = expectedGeneration;
                this.isPlaying = true;
                return;
              } catch (error) {
                if (this.isStalePlaybackTransitionError(error)) throw error;
                errors.push(`${quality}/play: ${error?.message || error}`);
              }
            } else {
              errors.push(`${quality}/resolve: empty-url`);
            }
          } catch (error) {
            if (this.isStalePlaybackTransitionError(error)) throw error;
            errors.push(`${quality}/resolve: ${error?.message || error}`);
          }
        }
        throw new Error(`在线播放恢复失败(source=${playSource}) ${errors.join(" | ")}`);
      }
      assertResumeStillCurrent();
      audio.src = this.pathToFile(this.currentPath);
      audio.load();
      this._committedAudioSource = String(audio.src || "");
    }
    assertResumeStillCurrent();
    await this.resumeEffectsEngine();
    assertResumeStillCurrent();
    await audio.play();
    assertResumeStillCurrent();
    this._committedAudioSource = String(audio.currentSrc || audio.src || "");
    this._committedPlaybackGeneration = expectedGeneration;
    this.isPlaying = true;
  },
  pauseByManual(source = "manual", wearToken = null) {
    this.outputSafetyWearResume = null;
    this.outputSafetyRevision = Number(this.outputSafetyRevision || 0) + 1;
    window.lxEnv?.prepareAudioOutput?.({playing:false,wearToken})?.catch?.(() => {});
    this.recommendationActionId = Number(this.recommendationActionId || 0) + 1;
    this.cancelRecommendPrefetch();
    for(const ticket of [...this.recommendationJobs?.claimed||[]]){ticket.canceled=true;this.releasePreparedRecommendation(ticket);}
    this.cancelNaturalCrossfade();
    audioEngine?.stopTail(audio);
    if (this.pendingPlaybackTransition) {
      this.playbackGeneration = playbackTransitionCoordinator.invalidate();
      this.pendingPlaybackTransition = null;
    }
    this.playbackIntent = "pause";
    this.setPauseState("manual", source);
    this.clearAudioInterruptSchedule(true);
    for (const slot of audioSlots) if (!slot.paused) slot.pause();
    practicePlayer?.pause();
    this.isPlaying = false;
  },
  pauseByInternal(source = "internal") {
    this.cancelWearResume();
    this.cancelNaturalCrossfade();
    audioEngine?.stopTail(audio);
    this.setPauseState("internal", source);
    this.clearAudioInterruptSchedule(true);
    if (!audio.paused) audio.pause();
    this.isPlaying = false;
  },
  pauseByInterruptionDetected(source = "audio.pause") {
    if (!this.currentPath) return;
    // Unexplained pauses include wear detection. Stop all pending playback and
    // keep user intent paused instead of guessing a timer-based recovery.
    this.pauseByManual(source);
    this.setPauseState("interruption", source);
  },
  async resumeByUserAction(source = "user") {
    this.cancelWearResume();
    const revision = this.outputSafetyRevision = Number(this.outputSafetyRevision || 0) + 1;
    this.playbackIntent = "play";
    this.clearAudioInterruptSchedule(true);
    this.setPauseState("none", source);
    if (!this.currentPath && this.tracks.length) {
      await this.playByPath(this.tracks[0].path);
      return;
    }
    if (!this.currentPath) return;
    try {
      await this.prepareSafeAudioOutput(true, !/hotkey|media/i.test(source));
      await this.resumeCurrentPathPlayback();
      if (revision !== this.outputSafetyRevision) return;
      this.lastPlaybackError = "";
      this.setPauseState("none", source);
    } catch (e) {
      if (revision !== this.outputSafetyRevision) return;
      console.warn("播放失败", e);
      this.lastPlaybackError = this.getPlaybackUserMessage(e);
    }
  },
  async resumeByAutoInterruption(source = "auto", expectedPath = "") {
    const st = this.audioInterrupt || {};
    if (!st.armed || this.playbackPauseReason !== "interruption" || this.isPlaying || !this.currentPath) return;
    if (expectedPath && String(this.currentPath) !== String(expectedPath)) {
      this.clearAudioInterruptSchedule(true);
      return;
    }
    try {
      await this.resumeCurrentPathPlayback();
      st.retryCount = 0;
      this.audioInterrupt = st;
      this.setPauseState("none", `auto:${source}`);
      this.clearAudioInterruptSchedule(true);
    } catch (e) {
      st.retryCount = Math.min(Number(st.maxRetry) || 8, (Number(st.retryCount) || 0) + 1);
      this.audioInterrupt = st;
      if ((Number(st.retryCount) || 0) >= (Number(st.maxRetry) || 8)) {
        console.warn("[audio-interrupt] auto-resume exhausted", e?.message || e);
        st.armed = false;
        this.audioInterrupt = st;
        return;
      }
      const base = Number(st.baseDelayMs) || 1200;
      const maxDelay = Number(st.maxDelayMs) || 10000;
      const backoff = Math.min(maxDelay, base * (2 ** Math.min(4, Number(st.retryCount) || 0)));
      this.scheduleAutoResume(backoff);
    }
  },
  dispatchPlayerAction(action, source = "unknown") {
    const act = String(action || "").trim();
    if (!act) return false;
    this.appendMediaDiagEvent("renderer_action_dispatched", { action: act, source });
    if (act === "play") {
      this.resumeByUserAction(`${source}:play`);
      return true;
    }
    if (act === "pause") {
      this.pauseByManual(`${source}:pause`);
      return true;
    }
    if (act === "stop") {
      this.pauseByManual(`${source}:stop`);
      return true;
    }
    if (act === "play_pause") {
      if (this.isPlaying) this.pauseByManual(`${source}:play_pause`);
      else this.resumeByUserAction(`${source}:play_pause`);
      return true;
    }
    const fn = HOTKEY_ACTIONS[act];
    if (typeof fn === "function") {
      fn.call(this);
      return true;
    }
    this.appendMediaDiagEvent("renderer_action_result", { action: act, source, ok: false, reason: "no-handler" });
    return false;
  },
  assertCurrentPlaybackTransition(transition) {
    playbackTransitionCoordinator.assertCurrent(transition);
  },
  isStalePlaybackTransitionError(error) {
    return PlaybackTransitionUtils.isStalePlaybackTransitionError(error);
  },
  isAudioEventForCommittedSource() {
    if (this.pendingPlaybackTransition) return false;
    const committed = String(this._committedAudioSource || "");
    if (!committed) return !this.currentPath;
    return String(audio.currentSrc || audio.src || "") === committed;
  },
  describeAudioSource(source) {
    const raw = String(source || "");
    try {
      const parsed = new URL(raw);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname}`.slice(0, 160);
    } catch {
      return raw.split("?")[0].slice(0, 160);
    }
  },
  capturePlaybackRollbackSnapshot() {
    const inherited = this.pendingPlaybackTransition?.rollbackSnapshot;
    if (inherited) {
      return {
        ...inherited,
        meta: { ...(inherited.meta || {}) },
        listeningSession: inherited.listeningSession ? { ...inherited.listeningSession } : null,
      };
    }
    return {
      path: String(this.currentPath || ""),
      meta: { ...(this.currentMeta || {}) },
      cover: String(this.currentCover || ""),
      coverFull: String(this.currentCoverFull || ""),
      duration: Number(this.duration) || 0,
      durationText: String(this.durationText || this.formatTime(this.duration || 0)),
      position: Number(this.currentTime) || 0,
      audioSource: String(this._committedAudioSource || audio.currentSrc || audio.src || ""),
      wasPlaying: !!this.isPlaying && !audio.ended,
      playbackIntent: String(this.playbackIntent || "pause"),
      pauseReason: String(this.playbackPauseReason || "none"),
      lastPauseSource: String(this.lastPauseSource || ""),
      recommendationContext: JSON.parse(JSON.stringify(this.recommendationContext || {})),
      listeningSession: null,
    };
  },
  beginPlaybackTransition(targetPath, source, rollbackSnapshot) {
    this.cancelWearResume();
    const transition = playbackTransitionCoordinator.begin({
      targetPath,
      source,
      actionId: `${String(source || "manual")}-${Date.now()}-${playbackTransitionCoordinator.generation + 1}`,
    });
    this.playbackGeneration = transition.generation;
    this._pendingSeekTime = null;
    this.pendingPlaybackTransition = {
      generation: transition.generation,
      actionId: transition.actionId,
      source: transition.source,
      targetPath: transition.targetPath,
      phase: "preparing",
      rollbackSnapshot,
    };
    return transition;
  },
  setPlaybackTransitionPhase(transition, phase) {
    if (!playbackTransitionCoordinator.isCurrent(transition)) return;
    this.pendingPlaybackTransition = {
      ...(this.pendingPlaybackTransition || {}),
      phase: String(phase || ""),
    };
  },
  finishPlaybackTransition(transition) {
    if (!playbackTransitionCoordinator.finish(transition)) return false;
    if (this.pendingPlaybackTransition?.generation === transition.generation) {
      this.pendingPlaybackTransition = null;
    }
    return true;
  },
  waitForAudioMetadata(timeoutMs = 3000) {
    if (audio.readyState >= 1) return Promise.resolve();
    return new Promise((resolve) => {
      let timer = null;
      const done = () => {
        audio.removeEventListener("loadedmetadata", done);
        audio.removeEventListener("error", done);
        if (timer) clearTimeout(timer);
        resolve();
      };
      audio.addEventListener("loadedmetadata", done, { once: true });
      audio.addEventListener("error", done, { once: true });
      timer = setTimeout(done, Math.max(100, Number(timeoutMs) || 3000));
    });
  },
  async restorePlaybackSnapshot(snapshot, transition) {
    this.assertCurrentPlaybackTransition(transition);
    const previous = snapshot || {};
    const previousSource = String(previous.audioSource || "");
    if (previousSource) {
      if (!previous.keepCurrentAudio) {
        audio.src = previousSource;
        audio.load();
        await this.waitForAudioMetadata();
      }
      this.assertCurrentPlaybackTransition(transition);
      const position = Math.max(0, Number(previous.position) || 0);
      try {
        if (previous.keepCurrentAudio) { /* 备用失败时原歌仍在继续，避免重载和回退进度。 */ }
        else if (Number.isFinite(audio.duration) && audio.duration > 0) {
          audio.currentTime = Math.min(position, Math.max(0, audio.duration - 0.05));
        } else {
          audio.currentTime = position;
        }
      } catch {
        // 部分格式需在 canplay 后才能 seek；恢复歌曲身份仍优先于不可靠进度。
      }
      if (previous.wasPlaying && !(previous.keepCurrentAudio && audio.ended)) {
        await audio.play();
        this.assertCurrentPlaybackTransition(transition);
      } else if (!audio.paused) {
        audio.pause();
      }
    } else {
      if (!audio.paused) audio.pause();
      audio.removeAttribute("src");
      audio.load();
    }

    this.assertCurrentPlaybackTransition(transition);
    this.currentPath = String(previous.path || "");
    if (previous.recommendationContext) {
      this.recommendationContext = previous.recommendationContext;
      writeStored("lx-recommendation-context-v2", JSON.stringify(this.recommendationContext));
    }
    this.currentMeta = { ...(previous.meta || { title: "", artist: "", album: "", lyric: "" }) };
    this.currentCover = this.pathToFile(String(previous.cover || ""));
    this.currentCoverFull = this.pathToFile(String(previous.coverFull || previous.cover || ""));
    this.duration = Number(previous.duration) || 0;
    this.durationText = String(previous.durationText || this.formatTime(this.duration));
    this.currentTime = Math.max(0, Number(previous.position) || 0);
    this.isPlaying = !!previous.wasPlaying && !audio.paused;
    this.playbackIntent = String(previous.playbackIntent || (this.isPlaying ? "play" : "pause"));
    this.setPauseState(previous.pauseReason || (this.isPlaying ? "none" : "manual"), previous.lastPauseSource || "playByPath:rollback");
    this._committedAudioSource = previousSource;
    this._committedPlaybackGeneration = transition.generation;
    this.listeningSession = previous.listeningSession
      ? {
        ...previous.listeningSession,
        playbackGeneration: transition.generation,
        state: previous.wasPlaying ? "playing" : "paused",
        pausedAt: previous.wasPlaying ? 0 : Date.now(),
        lastClockAt: this.getListeningClockMs(),
        lastWallAt: Date.now(),
        lastAudioTime: Number(audio.currentTime || previous.position || 0),
      }
      : null;
    if (this.listeningSession) this.finishRecommendationDiagnostic(this.listeningSession.recommendationDiagnosticId, "playing", { endReason: "" });
    this.applyTrackPresentation({
      meta: previous.meta || {},
      cover: previous.cover || "",
      coverFull: previous.coverFull || "",
      duration: previous.duration || 0,
    });
    this.syncMediaSessionPlaybackState();
    this.syncKaraokeProgressTicker();
  },
  async playAudioWithFallback(sources, transitionOrGuard, element = audio, prepareOnly = false) {
    const list = (sources || []).map((s) => String(s || "").trim()).filter(Boolean);
    const errors = [];
    const assertCurrent = () => {
      if (typeof transitionOrGuard === "function") transitionOrGuard();
      else this.assertCurrentPlaybackTransition(transitionOrGuard);
    };
    for (const src of list) {
      try {
        assertCurrent();
        if (audioEngine?.context || src.startsWith("kumiko-media:") || src.startsWith(LOCAL_PROXY_BASE)) element.crossOrigin = "anonymous";
        else element.removeAttribute("crossorigin");
        element.src = src;
        element.load();
        if (prepareOnly) await AudioEffects.waitReady(element, assertCurrent);
        else await element.play();
        assertCurrent();
        return String(element.currentSrc || element.src || src);
      } catch (e) {
        if (this.isStalePlaybackTransitionError(e)) throw e;
        errors.push(`${this.describeAudioSource(src)} -> ${e?.message || e}`);
      }
    }
    throw new Error(errors.length ? `没有可用音频源: ${errors.join(" | ")}` : "没有可用音频源");
  },
  async startTargetAudio(path, transition, element = audio, prepareOnly = false) {
    const guard = () => typeof transition === "function" ? transition() : this.assertCurrentPlaybackTransition(transition);
    if (!this.isOnlineToken(path)) {
      const source = await this.playAudioWithFallback([this.pathToFile(path)], guard, element, prepareOnly);
      return { actualSource: source, actualQuality: "", resolveDebug: "" };
    }

    const track = this.onlineTrackMap[path];
    if (!track) throw new Error("在线曲目不存在");
    const playSource = String(track.source || this.onlineFileSource || "").toLowerCase();
    const qualityQueue = this.buildOnlineQualityQueue(track);
    const errors = [];
    for (const quality of qualityQueue) {
      try {
        guard();
        const resolved = await window.lxEnv.resolveOnlineUrl({
          source: playSource,
          quality,
          musicInfo: this.buildResolveMusicInfo(track),
        });
        guard();
        const url = this.normalizeOnlineResolvedUrl(resolved);
        if (!url) throw new Error("empty-url");
        const candidates = [this.wrapOnlineProxyUrl(url)].filter(Boolean);
        try {
          const actualSource = await this.playAudioWithFallback(candidates, guard, element, prepareOnly);
          let host = "";
          try {
            host = new URL(url).host;
          } catch {
            host = "invalid-host";
          }
          return {
            actualSource,
            actualQuality: quality,
            resolveDebug: `source=${playSource}, quality=${quality}, host=${host}`,
          };
        } catch (error) {
          if (this.isStalePlaybackTransitionError(error)) throw error;
          errors.push(`${quality}/play: ${error?.message || error}`);
        }
      } catch (error) {
        if (this.isStalePlaybackTransitionError(error)) throw error;
        errors.push(`${quality}/resolve: ${error?.message || error}`);
      }
    }
    throw new Error(`在线播放失败(source=${playSource}) ${errors.join(" | ")}`);
  },
  async playByPath(path, pushHistory = true, source = "manual", options = {}) {
    if(this.soundMapRollbackActive)return {ok:false,canceled:true};
    const policyPacket=options.recommendationContext||options.prepared?.recommendationContext;
    const expectedIntent=source==='dislike_next'?'change':options.trigger==='like_button'?'recover':this.getDefaultRecommendationIntent();
    if(this.useRecommend&&['like_next','dislike_next'].includes(source)&&policyPacket?.diagnostic?.intent&&policyPacket.diagnostic.intent!==expectedIntent){
      this.releasePreparedRecommendation?.(options.prepared);
      return {ok:false,policyRejected:true,error:'推荐意图已变化，旧结果不能接管播放。'};
    }

    if(this.useRecommend&&['like_next','dislike_next'].includes(source)
        &&(['library_reserve','adjacent_mert_reserve'].includes(policyPacket?.diagnostic?.details?.fallback)
          ||recommendationPacketPending(policyPacket))){
      this.releasePreparedRecommendation?.(options.prepared);
      return {ok:false,policyRejected:true,error:'完整推荐仍在准备，已阻止未复核备用切歌。'};
    }

    if(source==='dislike_next'){
      const sim=this.getAdjacentMertSimilarity(String(path||''),options.recommendationContext||options.prepared?.recommendationContext);
      if(path===this.currentPath||sim<0||sim>this.getChangeMertCeiling()){
        this.releasePreparedRecommendation?.(options.prepared);
        return {ok:false,changeRejected:true,error:'候选与当前歌曲过于相似或尚未验证。'};
      }
    }
    if(this.useRecommend&&source==='like_next'&&expectedIntent==='continue'
        &&this.getAdjacentMertSimilarity(String(path||''),options.recommendationContext||options.prepared?.recommendationContext)<this.getEffectiveAdjacentMertFloor(options.recommendationContext||options.prepared?.recommendationContext)){
      this.releasePreparedRecommendation?.(options.prepared);
      return {ok:false,adjacentRejected:true,error:'候选未达到相邻 MERT 下限。'};
    }
    ++practiceTrainingGeneration;practiceTraining?.dispose();practiceTraining=null;
    this.disablePractice(false);
    const targetPath = String(path || "");
    if (targetPath && targetPath !== this.currentPath) window.FlowaveStemPlayer?.clearCache();
    if (!targetPath) return { ok: false, canceled: false, error: "播放目标为空" };
    const prepared = options.prepared;
    const finished = options.previousEvidence;
    const endedEvidence = finished?.origin === this.currentPath
      && finished.playbackGeneration === Number(this._committedPlaybackGeneration ?? this.playbackGeneration)
      ? finished : null;
    const outgoing = audio, preparedGeneration=this.playbackGeneration;
    this.cancelNaturalCrossfade(!prepared, prepared);
    if (!prepared) { overlapRecovery = null; audioEngine?.stopTail(audio, true); }
    const rollbackSnapshot = this.capturePlaybackRollbackSnapshot();
    const transition = this.beginPlaybackTransition(targetPath, source, rollbackSnapshot);
    const diagnosticId = prepared?.diagnosticId || this.beginRecommendationDiagnostic(targetPath, source, options.recommendationContext || options.prepared?.recommendationContext,
      options.trigger || (prepared ? "natural" : source));
    if (prepared) { prepared.transition = transition; inflightNaturalFade = prepared; }
    this.lastPlaybackError = "";
    const previousSession = this.listeningSession;
    const switchObservation={source,trigger:options.trigger||(prepared?"natural":source),target:this.makeTrackReference(targetPath),targetDecisionId:diagnosticId};
    if(previousSession) {
      this.updateListeningSessionProgress({force:true});
      this.recordSoundMapEvent("switch_requested",previousSession,"selection",{...switchObservation,targetDecision:this.soundMapDecisionSnapshot(diagnosticId)});
    }
    try {
      const tagGate = await window.lxEnv?.waitForTagWrite?.(targetPath);
      if (tagGate?.released === false) throw new Error("歌曲资料正在保存，请稍后播放");
      await this.resumeEffectsEngine();
      this.assertCurrentPlaybackTransition(transition);
      if (prepared) {
        if (prepared.from !== outgoing || audio !== outgoing || (prepared.actionTicket ? prepared.origin !== this.currentPath || prepared.playbackGeneration !== preparedGeneration : prepared.stamp !== this.naturalQueueStamp())) throw new Error("自动接歌状态已变化");
        audioEngine?.gain(prepared.element,0);
        await prepared.element.play();
        this.assertCurrentPlaybackTransition(transition);
        await AudioEffects.waitReady(prepared.element, () => this.assertCurrentPlaybackTransition(transition), 1200);
        this.assertCurrentPlaybackTransition(transition);
        rollbackSnapshot.position = Number(outgoing.currentTime) || rollbackSnapshot.position;
      }
      if (previousSession) {
        this.flushListeningSession("switch-attempt", { deferSave: true });
        rollbackSnapshot.listeningSession = {
          ...previousSession,
          lastWallAt: Date.now(),
          lastAudioTime: Number(rollbackSnapshot.position) || 0,
        };
      }
      this.playbackIntent = "play";
      this.setPauseState("internal", "playByPath:switch");
      this.clearAudioInterruptSchedule(true);
      if (!prepared && !audio.paused) {
        this._ignoredInternalPauseEvents += 1;
        audio.pause();
      }
      this.setPlaybackTransitionPhase(transition, "starting_audio");
      const started = prepared ? prepared.started : await this.startTargetAudio(targetPath, transition);
      this.assertCurrentPlaybackTransition(transition);
      if (prepared) { audio = prepared.element; naturalFadeAttempted = ""; }
      else audioEngine?.gain(audio, 1);

      const presentation = this.buildImmediateTrackPresentation(targetPath);
      this.currentPath = targetPath;
      this.applyTrackPresentation(presentation);
      this.currentTime = Number(audio.currentTime) || 0;
      if (Number.isFinite(audio.duration) && audio.duration > 0) {
        this.duration = audio.duration;
        this.durationText = this.formatTime(audio.duration);
      }
      this._committedAudioSource = started.actualSource;
      this._committedPlaybackGeneration = transition.generation;
      this.lastOnlineResolveDebug = started.resolveDebug;
      this.isPlaying = !audio.paused;
      if (previousSession) this.recordSoundMapEvent("play_ended", previousSession, "switch-committed",switchObservation);
      this.beginListeningSession(targetPath, { source, diagnosticId });
      if (this.listeningSession) this.listeningSession.recommendationDiagnosticId = diagnosticId;
      this.setPauseState("none", "playByPath:started");
      this.persistLastTrackReference(targetPath);
      if (String(source || "") !== "dislike_next") {
        this.handleRecommendationBehaviorAfterCommit(source);
      }
      if (pushHistory) this.pushHistory(targetPath);
      this.recordRecommendationOpportunity(targetPath, source);
      this.rememberContinuityTrack(targetPath);
      this.commitRecommendationContext(targetPath, source, previousSession || endedEvidence?.session,
        endedEvidence?.duration ?? rollbackSnapshot.duration, options.recommendationContext || prepared?.recommendationContext);
      this.finishRecommendationDiagnostic(diagnosticId, "playing", { started: true, attemptId: this.listeningSession?.attemptId || "" });
      this.markOnlinePlayStart(targetPath);
      this.finishPlaybackTransition(transition);
      if (inflightNaturalFade === prepared) inflightNaturalFade = null;
      if (prepared) {
        if (prepared.seconds > 0 && !outgoing.ended) {
          overlapRecovery = { outgoing, snapshot: rollbackSnapshot, generation: transition.generation };
          audioEngine.fade(outgoing, audio, prepared.seconds);
        }
        else { audioEngine.release(outgoing); audioEngine.gain(audio, 1); }
      }
      this.syncAudioDuration(presentation.duration);
      this.refreshCommittedTrackPresentation(targetPath, transition.generation);
      if (this.showLyric) {
        this.resumeLyricAutoFollow(false);
        this.updateLyricHighlight();
        this.scrollActiveLyricToCenter(false);
      }
      if (this.useRecommend) this.scheduleRecommendPrefetch();
      this.queueUiSnapshotSave();
      this.syncMediaSessionPlaybackState();
      this.syncKaraokeProgressTicker();
      return {
        ok: true,
        canceled: false,
        path: targetPath,
        generation: transition.generation,
        actualQuality: started.actualQuality,
      };
    } catch (err) {
      if(previousSession)this.recordSoundMapEvent(this.isStalePlaybackTransitionError(err)||!playbackTransitionCoordinator.isCurrent(transition)?"switch_canceled":"switch_failed",previousSession,"playback-request",switchObservation);
      this.finishRecommendationDiagnostic(diagnosticId, this.isStalePlaybackTransitionError(err) || !playbackTransitionCoordinator.isCurrent(transition) ? "canceled" : "failed");
      if (inflightNaturalFade === prepared) inflightNaturalFade = null;
      if (prepared && audio === outgoing) { rollbackSnapshot.keepCurrentAudio = true; rollbackSnapshot.position = Number(audio.currentTime) || 0; }
      if (prepared && prepared.element !== audio) audioEngine?.release(prepared.element);
      if (this.isStalePlaybackTransitionError(err) || !playbackTransitionCoordinator.isCurrent(transition)) {
        return {
          ok: false,
          canceled: true,
          path: targetPath,
          generation: transition.generation,
          error: "播放请求已被更新的操作取代",
        };
      }
      this.setPlaybackTransitionPhase(transition, "rolling_back");
      let rollbackError = null;
      try {
        await this.restorePlaybackSnapshot(rollbackSnapshot, transition);
      } catch (error) {
        if (this.isStalePlaybackTransitionError(error)) {
          return {
            ok: false,
            canceled: true,
            path: targetPath,
            generation: transition.generation,
            error: "播放请求已被更新的操作取代",
          };
        }
        rollbackError = error;
        this.isPlaying = false;
      }
      this.finishPlaybackTransition(transition);
      if (prepared && !prepared.actionTicket && audio.ended && this.playbackIntent === "play") this.handleEnded();
      this.lastPlaybackError = this.getPlaybackUserMessage(err);
      if (rollbackError) {
        this.lastPlaybackError += "；原歌曲也无法恢复，请重新播放。";
      }
      console.warn("播放失败", {
        error: err,
        rollbackError,
        targetPath,
        source,
      });
      return {
        ok: false,
        canceled: false,
        path: targetPath,
        generation: transition.generation,
        error: this.lastPlaybackError,
      };
    }
  },
  async togglePlay() {
    if(this.soundMapRollbackActive)return;
    if (!this.currentPath) return;
    if (this.isPlaying) {
      this.pauseByManual("togglePlay:pause");
    } else {
      await this.resumeByUserAction("togglePlay:resume");
    }
  },
  async prevTrack() {
    const prevPath = this.getPreviousPlayedPath();
    if (!prevPath) return { ok: false, canceled: false, error: "没有可回退的歌曲" };
    // 回退到历史曲目时不重复写入历史，保证连续“上一曲”可逐步回退
    return this.playByPath(prevPath, false, "previous");
  },
  adjustVolumeBy(delta) {
    this.volume = Math.max(0, Math.min(100, this.volume + delta));
    this.setVolume();
  },
  async nextTrack() {
    const attempt = await tryPlayRecommendWithFallback(this, "like_next", this.useRecommend, "next_button");
    if (attempt.candidateFound) return attempt.result;
    return this.playFromPlaylistNext("next");
  },
  async playFromPlaylistNext(source = "playlist_next", options = {}) {
    const list = this.getPlaybackQueueTracks();
    if (!list.length) return { ok: false, canceled: false, error: "当前歌单为空" };
    const anchor = this.isOnlineToken(this.currentPath)
      ? this.resolveOnlineRecommendAnchorPath(this.currentPath)
      : "";
    const next = PlaybackTransitionUtils.selectPlaylistNext(list, this.currentPath, this.playMode, {
      currentAliases: anchor ? [anchor] : [],
    });
    if (!next?.path) return { ok: false, canceled: false, error: "当前歌单没有可播放歌曲" };
    return this.playByPath(next.path, true, source, options);
  },
  async playLike() {
    const ready = this.useRecommend ? this.takePreparedRecommendation?.('recover') : null;
    if (this.useRecommend) {
      if (this.listeningSession) this.recordSoundMapEvent("correction_requested", this.listeningSession, "restore_previous_feeling", {scope:"current-context"});
      const current = this.makeTrackReference(this.currentPath);
      this.recommendationContext = window.RecommendationContext.repair(this.recommendationContext, current);
      writeStored("lx-recommendation-context-v2", JSON.stringify(this.recommendationContext));
      this.cancelNaturalCrossfade();
      this.cancelRecommendPrefetch();
    }
    const attempt = await tryPlayRecommendWithFallback(this, "like_next", true, "like_button", ready);
    if (attempt.candidateFound) return attempt.result;
    return this.playFromPlaylistNext("like_fallback");
  },
  async playDislike() {
    const ready = this.useRecommend ? this.takePreparedRecommendation?.('change') : null;
    const action = ++this.dislikeActionGeneration;
    const generation = this.playbackGeneration;
    const path = this.currentPath;
    void Promise.resolve(this.handleRecommendationBehaviorBeforeSwitch("dislike_next")).catch(error=>console.warn("听歌反馈保存暂未完成",error));
    if (action !== this.dislikeActionGeneration || generation !== this.playbackGeneration || path !== this.currentPath) {
      this.releasePreparedRecommendation?.(ready);
      return { ok:false, canceled:true, error:"播放请求已被更新的操作取代" };
    }
    const attempt = await tryPlayRecommendWithFallback(this, "dislike_next", this.useRecommend, "dislike_button", ready);
    if (attempt.candidateFound) return attempt.result;
    // 没有“不喜欢推荐”时，回退到普通下一首，不再转去“喜欢推荐”
    return this.playFromPlaylistNext("dislike_fallback");
  },
  async handleEnded() {
    if(this.playbackIntent==="pause")return {ok:true,ended:true,paused:true};
    if(practiceTraining?.path===this.currentPath&&practiceTraining.source===audio&&practiceTraining.ended())return;
    if (naturalFade?.path && naturalFade.stamp === this.naturalQueueStamp()) {
      const prepared = naturalFade;
      if (prepared.ready) {
        naturalFade = null; prepared.seconds = 0;
        return this.playByPath(prepared.path, true, prepared.source, { prepared });
      }
      this.cancelNaturalCrossfade(false);
      return this.playByPath(prepared.path, true, prepared.source,{recommendationContext:prepared.recommendationContext,trigger:'natural'});
    }
    const ready=this.useRecommend?this.takePreparedRecommendation?.(this.getDefaultRecommendationIntent()):null;
    this.cancelNaturalCrossfade(false);
    const endedSession=this.listeningSession;
    this.flushListeningSession("ended", { deferSave: true });
    const previousEvidence={origin:this.currentPath,duration:this.duration,
      playbackGeneration:Number(this._committedPlaybackGeneration ?? this.playbackGeneration),
      session:endedSession?{...endedSession}:null};
    this.clearAudioInterruptSchedule(true);
    this.setPauseState("none", "ended");
    const waiting=this.recommendationResume;
    if(waiting&&waiting.origin===this.currentPath&&waiting.generation===this.playbackGeneration&&waiting.action===this.recommendationActionId){
      // Natural end must not replace a queued explicit recover/change with a continue request.
      if(!waiting.previousEvidence)waiting.previousEvidence=previousEvidence;
      return {ok:false,preparing:true};
    }
    if (!this.canNaturallyAdvanceSeedQueue()) {
      const seed = this.playlists?.find(p => p.id === this.currentPlaylist && p.type === "seed");
      this.showNotice(seed?.seedPolicy === 2 && seed.seedVerification === 1 ? "本组已播完，首尾差异较大，已停止自动接歌。" : "请刷新复合种子推荐后继续自动接歌。");
      return { ok: true, ended: true };
    }
    const attempt = await tryPlayRecommendWithFallback(this, "like_next", this.useRecommend, "natural", ready, previousEvidence);
    if (attempt.candidateFound) return attempt.result;
    return this.playFromPlaylistNext("ended_fallback",{previousEvidence});
  },
  setVolume() {
    if (audioEngine) audioEngine.setVolume(this.volume / 100, this.muted);
    else audio.volume = Math.max(0, Math.min(1, this.volume / 100));
    writeStored(STORAGE_KEYS.VOLUME, String(this.volume));
  },
  toggleLyricVolumePanel() {
    this.lyricVolumeOpen = !this.lyricVolumeOpen;
  },
  toggleMute() {
    this.muted = !this.muted;
    if (audioEngine) audioEngine.setVolume(this.volume / 100, this.muted);
    else audio.muted = this.muted;
  },
  syncAudioDuration(fallback = 0) {
    const candidates = [
      Number(audio.duration),
      Number(fallback),
      Number(this.trackByPath.get(this.currentPath)?.duration),
      Number(this.onlineTrackMap[this.currentPath]?.duration),
      Number(this.duration),
    ];
    const next = candidates.find((value) => Number.isFinite(value) && value > 0) || 0;
    if (!next) return 0;
    this.duration = next;
    this.durationText = this.formatTime(next);
    return next;
  },
  applyPendingSeek() {
    if (this._pendingSeekTime === null || this._pendingSeekTime === undefined) return false;
    const pending = Number(this._pendingSeekTime);
    if (!Number.isFinite(pending) || Number(audio.readyState || 0) < 1) return false;
    const mediaDuration = Number(audio.duration);
    const target = Number.isFinite(mediaDuration) && mediaDuration > 0
      ? Math.min(Math.max(0, pending), mediaDuration)
      : Math.max(0, pending);
    try {
      audio.currentTime = target;
      return true;
    } catch {
      return false;
    }
  },
  seekAudioTo(target, reason = "seek") {
    this.cancelNaturalCrossfade();
    audioEngine?.stopTail(audio);
    const mediaDuration = Number(audio.duration);
    const stateDuration = Number(this.duration);
    const limit = Number.isFinite(mediaDuration) && mediaDuration > 0
      ? mediaDuration
      : (Number.isFinite(stateDuration) && stateDuration > 0 ? stateDuration : 0);
    const rawTarget = Number(target);
    if (!Number.isFinite(rawTarget)) return this.getListeningMediaTime();
    const requested = Math.max(0, rawTarget);
    const next = limit > 0 ? Math.min(requested, limit) : requested;
    if(practiceTraining?.source===audio&&practiceTraining.region&&(next<practiceTraining.region.start||next>=practiceTraining.region.end)){++practiceTrainingGeneration;practiceTraining.disableLoop();window.dispatchEvent(new Event('flowave-practice-loop-disabled'));}
    const previous = this.getListeningMediaTime();
    if (Math.abs(next - previous) < 0.01) return previous;
    this.beginListeningSeek(reason);
    this.recordSoundMapEvent("seek_requested",this.listeningSession,reason,{fromSeconds:previous,toSeconds:next});
    this._pendingSeekTime = next;
    if (Number(audio.readyState || 0) < 1) return next;
    try {
      audio.currentTime = next;
      return next;
    } catch (error) {
      if (Number(audio.readyState || 0) < 2) return next;
      this._pendingSeekTime = null;
      this.completeListeningSeek(`${reason}-failed`);
      console.warn("调整播放进度失败", error);
      return previous;
    }
  },
  seekByRangeInput(e) {
    if (!this.progressDuration) return;
    const next = this.seekAudioTo(Number(e?.currentTarget?.value || 0), "player-progress-drag");
    this.currentTime = next;
  },
  seekByKeyboard(e) {
    if (!this.progressDuration) return;
    const key = String(e?.key || "");
    let target = this.currentTime;
    if (key === "ArrowLeft") target -= e.shiftKey ? 10 : 5;
    else if (key === "ArrowRight") target += e.shiftKey ? 10 : 5;
    else if (key === "Home") target = 0;
    else if (key === "End") target = this.progressDuration;
    else return;
    e.preventDefault();
    this.currentTime = this.seekAudioTo(target, "keyboard-progress");
  },
  cycleMode() {
    this.playMode = this.playMode === "loop" ? "shuffle" : "loop";
  },
};

const lyricMethods = {
  syncOutputCalibrationConsumers() {
    const service=window.FlowaveOutputCalibration;
    if(!service?.acquire)return;
    if(!this.outputCalibrationLeases)this.outputCalibrationLeases=markSearchRaw(new Map());
    const enabled=!this.outputCalibrationClosed&&this.isPlaying&&!!this.currentPath&&service.hasEnabledProfile();
    const visible=typeof document==='undefined'||!document.hidden;
    const desired={lyrics:enabled&&visible&&this.showLyric,desktop:enabled&&this.desktopLyricEnabled,practice:enabled&&visible&&this.view==='practice'&&!this.showLyric};
    for(const [name,needed] of Object.entries(desired)){
      if(needed&&!this.outputCalibrationLeases.has(name))this.outputCalibrationLeases.set(name,service.acquire(name));
      else if(!needed&&this.outputCalibrationLeases.has(name)){const release=this.outputCalibrationLeases.get(name);this.outputCalibrationLeases.delete(name);release();}
    }
  },
  syncLyricAmbient() {
    this.$nextTick(() => {
      if (this.$?.isUnmounted) return;
      if (!this.showLyric && !lyricAmbientRuntime) return;
      const canvas = this.$refs.lyricAmbientCanvas;
      if (!canvas || typeof window.LyricAmbient !== "function") return;
      if (!lyricAmbientRuntime) lyricAmbientRuntime = new window.LyricAmbient(canvas);
      lyricAmbientRuntime.update({source:this.currentCoverFull || this.currentCover || "", visible:this.showLyric && this.lyricStageAutoColor, playing:this.isPlaying, enabled:this.lyricGlowEnabled, speed:this.lyricGlowSpeed});
    });
  },
  buildImmediateTrackPresentation(p) {
    const targetPath = String(p || "");
    const track = this.isOnlineToken(targetPath)
      ? this.onlineTrackMap[targetPath]
      : this.trackByPath?.get?.(targetPath);
    const cover = this.isOnlineToken(targetPath)
      ? this.onlineCoverUrl(track?.cover || "")
      : this.pathToFile(track?.cover_thumb || track?.cover || "");
    const coverFull = this.isOnlineToken(targetPath)
      ? cover
      : this.pathToFile(track?.cover || track?.cover_thumb || "");
    return {
      meta: {
        title: String(track?.title || track?.name || this.extractName(targetPath) || ""),
        artist: String(track?.artist || ""),
        album: String(track?.album || ""),
        lyric: "",
        lyricModel: null,
      },
      cover,
      coverFull,
      duration: Number(track?.duration) || 0,
    };
  },
  async refreshCommittedTrackPresentation(p, generation) {
    const targetPath = String(p || "");
    try {
      const presentation = await this.loadTrackPresentation(targetPath);
      if (
        Number(generation) !== Number(this.playbackGeneration)
        || Number(generation) !== Number(this._committedPlaybackGeneration)
        || targetPath !== String(this.currentPath || "")
      ) {
        return false;
      }
      this.applyTrackPresentation(presentation);
      this.currentTime = Number(audio.currentTime) || 0;
      this.syncAudioDuration(presentation.duration);
      if (presentation.onlineLyricRequest) {
        this.loadCommittedOnlineLyric(targetPath, generation, presentation.onlineLyricRequest);
      }
      this.queueUiSnapshotSave();
      return true;
    } catch (_) {
      // 音频已成功播放时保留即时展示，元数据补充失败不能打断播放。
      return false;
    }
  },
  async loadTrackPresentation(p) {
    if (this.isOnlineToken(p)) {
      const t = this.onlineTrackMap[p];
      if (t) {
        const presentation = {
          meta: {
            title: t.title || t.name || "",
            artist: t.artist || "",
            album: t.album || "",
            lyric: "",
          },
          cover: this.onlineCoverUrl(t.cover || ""),
          coverFull: this.onlineCoverUrl(t.cover || ""),
          duration: Number(t.duration) || 0,
          onlineLyricRequest: {
            source: t.source,
            songId: t.songId,
            title: t.title || t.name || "",
            artist: t.artist || "",
            album: t.album || "",
            duration: Number(t.duration) || 0,
          },
        };
        return presentation;
      }
      throw new Error("在线曲目不存在");
    }
    const info = (window.lxEnv && window.lxEnv.getSongInfo)
      ? await window.lxEnv.getSongInfo(p, {
        includeLyricsModel: true,
        resourceId: String(this.trackByPath?.get?.(p)?.resourceId || ""),
      })
      : null;
    if (info) {
      return {
        meta: {
          title: info.title,
          artist: info.artist,
          album: info.album,
          lyric: info.lyrics || "",
          lyricModel: info.lyricsModel && typeof info.lyricsModel === "object" ? info.lyricsModel : null,
        },
        cover: this.pathToFile(info.cover_thumb || info.cover || ""),
        coverFull: this.pathToFile(info.cover || info.cover_thumb || ""),
        duration: Number(info.duration) || 0,
      };
    }
    return {
      meta: { title: this.extractName(p), artist: "", album: "", lyric: "" },
      cover: "",
      coverFull: "",
      duration: 0,
    };
  },
  applyTrackPresentation(presentation) {
    const data = presentation && typeof presentation === "object" ? presentation : {};
    const meta = data.meta && typeof data.meta === "object" ? data.meta : {};
    this.currentMeta = {
      title: String(meta.title || ""),
      artist: String(meta.artist || ""),
      album: String(meta.album || ""),
      lyric: String(meta.lyric || ""),
      lyricModel: meta.lyricModel && typeof meta.lyricModel === "object" ? meta.lyricModel : null,
    };
    this.currentCover = this.pathToFile(String(data.cover || ""));
    this.currentCoverFull = this.pathToFile(String(data.coverFull || data.cover || ""));
    const presentationDuration = Number(data.duration) || 0;
    this.duration = presentationDuration;
    this.durationText = this.formatTime(presentationDuration);
    if (this.currentMeta.lyricModel && this.applyLyricModel(this.currentMeta.lyricModel)) {
      // Structured local lyrics preserve explicit line and word end times.
    } else if (this.currentMeta.lyric) {
      this.applyLyricText(this.currentMeta.lyric);
    } else {
      this.resetLyricState();
    }
    this.updateMediaSessionMetadata();
  },
  async populateCurrentMeta(p) {
    const targetPath = String(p || "");
    const generation = this.playbackGeneration;
    const presentation = await this.loadTrackPresentation(targetPath);
    if (targetPath !== String(this.currentPath || "") || generation !== this.playbackGeneration) {
      return false;
    }
    this.applyTrackPresentation(presentation);
    if (presentation.onlineLyricRequest) {
      this.loadCommittedOnlineLyric(targetPath, generation, presentation.onlineLyricRequest);
    }
    return true;
  },
  async loadCommittedOnlineLyric(path, generation, request) {
    try {
      const ly = await window.lxEnv.getOnlineLyric({
        source: request?.source,
        songId: request?.songId,
        title: request?.title,
        artist: request?.artist,
        album: request?.album,
        duration: request?.duration,
      });
      if (
        generation !== this.playbackGeneration
        || generation !== this._committedPlaybackGeneration
        || String(path || "") !== String(this.currentPath || "")
      ) {
        return false;
      }
      const lyricsModel = ly?.lyricsModel && typeof ly.lyricsModel === "object"
        ? ly.lyricsModel
        : null;
      if (lyricsModel && this.applyLyricModel(lyricsModel)) {
        this.currentMeta = { ...(this.currentMeta || {}), lyric: "", lyricModel: lyricsModel };
        this.updateMediaSessionMetadata();
        return true;
      }
      const lyricText = [ly?.lyric || "", ly?.tlyric || "", ly?.lxlyric || "", ly?.rlyric || ""].filter(Boolean).join("\n");
      this.currentMeta = { ...(this.currentMeta || {}), lyric: lyricText, lyricModel: null };
      if (lyricText) this.applyLyricText(lyricText);
      else this.resetLyricState();
      this.updateMediaSessionMetadata();
      return true;
    } catch {
      return false;
    }
  },
  resetLyricState() {
    this.lyricLines = [];
    this.currentLyricIndex = -1;
    this.lyricFocusIndex = -1;
    this.lyricScrollIndex = -1;
    this.currentLyricWordIndex = -1;
    this.currentLyricWordProgress = 0;
    this.lyricHasTimeline = false;
    this.lyricAutoFollow = true;
    this.clearLyricResumeTimer();
    this.stopKaraokeProgressTicker();
    this.resetKaraokeWordProgress();
  },
  applyLyricText(text) {
    const parsed = this.parseLrc(text || "");
    this.applyParsedLyrics(parsed);
  },
  applyLyricModel(model) {
    if (typeof LyricModelAdapter === "undefined" || typeof LyricModelAdapter.toRendererLyrics !== "function") {
      return false;
    }
    const parsed = LyricModelAdapter.toRendererLyrics(model);
    if (!parsed) return false;
    this.applyParsedLyrics(parsed);
    return true;
  },
  applyParsedLyrics(parsed) {
    this.lyricLines = parsed.lines;
    this.lyricHasTimeline = parsed.synced;
    this.currentLyricIndex = -1;
    this.lyricFocusIndex = -1;
    this.lyricScrollIndex = -1;
    this.currentLyricWordIndex = -1;
    this.currentLyricWordProgress = 0;
    this.lyricAutoFollow = true;
    this.clearLyricResumeTimer();
    this.resetKaraokeWordProgress();
    this.syncKaraokeProgressTicker();
  },
  clearLyricResumeTimer() {
    if (this.lyricResumeTimer) {
      clearTimeout(this.lyricResumeTimer);
      this.lyricResumeTimer = null;
    }
  },
  parseTimestamp(mm, ss) {
    // 兼容入口：历史调用保留，实际逻辑委托给 lyric-utils.js
    if (typeof LyricUtils.parseTimestamp === "function") {
      return LyricUtils.parseTimestamp(mm, ss);
    }
    return NaN;
  },
  parseInlineKaraoke(text) {
    // 兼容入口：历史调用保留，实际逻辑委托给 lyric-utils.js
    if (typeof LyricUtils.parseInlineKaraoke === "function") {
      return LyricUtils.parseInlineKaraoke(text);
    }
    return { plain: String(text || "").trim(), words: [] };
  },
  looksLikeRomanized(text) {
    if (typeof LyricUtils.looksLikeRomanized === "function") {
      return LyricUtils.looksLikeRomanized(text);
    }
    return false;
  },
  splitMainAndSub(text) {
    if (typeof LyricUtils.splitMainAndSub === "function") {
      return LyricUtils.splitMainAndSub(text);
    }
    return { main: String(text || "").trim(), sub: "" };
  },
  buildLyricLineFromGroup(group) {
    if (typeof LyricUtils.buildLyricLineFromGroup === "function") {
      return LyricUtils.buildLyricLineFromGroup(group);
    }
    return { main: "", sub: "", words: [] };
  },
  parseLrc(text) {
    if (typeof LyricUtils.parseLrc === "function") {
      return LyricUtils.parseLrc(text);
    }
    return { lines: [], synced: false };
  },
  persistLyricSettings() {
    this.lyricMainFontSize = clampNumber(this.lyricMainFontSize, DEFAULT_LYRIC_FONT_SIZE, 14, 72);
    this.lyricSubFontSize = clampNumber(this.lyricSubFontSize, DEFAULT_LYRIC_SUB_FONT_SIZE, 12, 56);
    writeStored(STORAGE_KEYS.LYRIC_FONT, String(this.lyricMainFontSize)); // 向后兼容
    writeStored(STORAGE_KEYS.LYRIC_MAIN_FONT, String(this.lyricMainFontSize));
    writeStored(STORAGE_KEYS.LYRIC_SUB_FONT, String(this.lyricSubFontSize));
    writeStored(STORAGE_KEYS.LYRIC_FONT_FAMILY, this.lyricFontFamily || DEFAULT_LYRIC_FONT_FAMILY);
    writeStored(STORAGE_KEYS.LYRIC_INACTIVE_COLOR, this.lyricInactiveColor || DEFAULT_LYRIC_INACTIVE_COLOR);
    writeStored(STORAGE_KEYS.LYRIC_ACTIVE_COLOR, this.lyricActiveColor || DEFAULT_LYRIC_ACTIVE_COLOR);
    writeStored(STORAGE_KEYS.LYRIC_META_COLOR, this.lyricMetaColor || DEFAULT_LYRIC_META_COLOR);
    writeStored(STORAGE_KEYS.LYRIC_TEXT_COLOR_LEGACY, this.lyricInactiveColor || DEFAULT_LYRIC_INACTIVE_COLOR); // 向后兼容
    writeStored(STORAGE_KEYS.LYRIC_BG_COLOR, this.lyricBgColor || DEFAULT_LYRIC_BG_COLOR);
    const scale = (LyricUtils.clampActiveScale || ((n) => Math.max(1.1, Math.min(1.35, Number(n) || DEFAULT_LYRIC_ACTIVE_SCALE))))(this.lyricActiveScale);
    this.lyricActiveScale = scale;
    writeStored(STORAGE_KEYS.LYRIC_ACTIVE_SCALE, String(scale));
    writeStored(STORAGE_KEYS.LYRIC_DISPLAY_MODE, this.lyricDisplayMode);
    writeStored(STORAGE_KEYS.LYRIC_KARAOKE, this.lyricKaraoke ? "1" : "0");
    writeStored("lx-lyric-stage-auto-color", this.lyricStageAutoColor ? "1" : "0");
    writeStored("lx-lyric-stage-scale", String(this.lyricStageScale));
    writeStored(STORAGE_KEYS.LYRIC_GLOW_ENABLED, this.lyricGlowEnabled ? "1" : "0");
    const glowSpeed = Math.max(0.4, Math.min(2.4, Number(this.lyricGlowSpeed) || DEFAULT_LYRIC_GLOW_SPEED));
    this.lyricGlowSpeed = glowSpeed;
    writeStored(STORAGE_KEYS.LYRIC_GLOW_SPEED, String(glowSpeed));
    this.lyricRenderDelayMs = Math.max(-1000, Math.min(1000, Math.round(Number(this.lyricRenderDelayMs) || 0)));
    this.lyricFocusLeadMs = Math.max(0, Math.min(500, Math.round(Number.isFinite(Number(this.lyricFocusLeadMs)) ? Number(this.lyricFocusLeadMs) : DEFAULT_LYRIC_FOCUS_LEAD_MS)));
    this.lyricSwitchScrollMs = Math.max(120, Math.min(800, Math.round(Number(this.lyricSwitchScrollMs) || DEFAULT_LYRIC_SWITCH_SCROLL_MS)));
    writeStored(STORAGE_KEYS.LYRIC_RENDER_DELAY_MS, String(this.lyricRenderDelayMs));
    writeStored(STORAGE_KEYS.LYRIC_FOCUS_LEAD_MS, String(this.lyricFocusLeadMs));
    writeStored(STORAGE_KEYS.LYRIC_SWITCH_SCROLL_MS, String(this.lyricSwitchScrollMs));
    writeStored(STORAGE_KEYS.LYRIC_SAVE_TRANSLATION, this.lyricSaveIncludeTranslation ? "1" : "0");
    writeStored(STORAGE_KEYS.LYRIC_SAVE_ROMANIZATION, this.lyricSaveIncludeRomanization ? "1" : "0");
  },
  persistDesktopLyricSettings() {
    this.desktopLyricMainFontSize = clampNumber(this.desktopLyricMainFontSize, DEFAULT_DESKTOP_LYRIC_FONT_SIZE, 20, 72);
    this.desktopLyricSubFontSize = clampNumber(this.desktopLyricSubFontSize, DEFAULT_DESKTOP_LYRIC_SUB_FONT_SIZE, 12, 56);
    this.desktopLyricOpacity = clampNumber(this.desktopLyricOpacity, DEFAULT_DESKTOP_LYRIC_OPACITY, 0.2, 1);
    this.desktopLyricStroke = clampNumberAllowZero(this.desktopLyricStroke, DEFAULT_DESKTOP_LYRIC_STROKE, 0, 1.5);
    writeStored(STORAGE_KEYS.DESKTOP_LYRIC_ENABLED, this.desktopLyricEnabled ? "1" : "0");
    writeStored(STORAGE_KEYS.DESKTOP_LYRIC_LOCKED, this.desktopLyricLocked ? "1" : "0");
    writeStored(STORAGE_KEYS.DESKTOP_LYRIC_MAIN_FONT, String(this.desktopLyricMainFontSize));
    writeStored(STORAGE_KEYS.DESKTOP_LYRIC_SUB_FONT, String(this.desktopLyricSubFontSize));
    writeStored(STORAGE_KEYS.DESKTOP_LYRIC_FONT_SIZE, String(this.desktopLyricMainFontSize)); // 向后兼容
    writeStored(STORAGE_KEYS.DESKTOP_LYRIC_OPACITY, String(this.desktopLyricOpacity));
    writeStored(STORAGE_KEYS.DESKTOP_LYRIC_STROKE, String(this.desktopLyricStroke));
    writeStored(STORAGE_KEYS.DESKTOP_LYRIC_COVER_COLOR, this.desktopLyricCoverColor ? "1" : "0");
    writeStored(STORAGE_KEYS.DESKTOP_LYRIC_CURRENT_ONLY, this.desktopLyricCurrentOnly ? "1" : "0");
  },
  saveDesktopLyricSettings() {
    if (this._desktopLyricSettingsSaveTimer) clearTimeout(this._desktopLyricSettingsSaveTimer);
    this._desktopLyricSettingsSaveTimer = setTimeout(() => {
      this._desktopLyricSettingsSaveTimer = null;
      this.persistDesktopLyricSettings();
      if (this.desktopLyricCoverColor) this.updateDesktopLyricCoverPalette();
      this.sendLyricOverlay();
    }, 120);
  },
  saveLyricSettings() {
    if (this._lyricSettingsSaveTimer) clearTimeout(this._lyricSettingsSaveTimer);
    this.$nextTick(() => {
      this.recalcLyricCenterSpacer();
      if (this.showLyric && this.lyricAutoFollow) this.scrollActiveLyricToCenter(false);
    });
    this.updateLyricHighlight(this.currentTime, { source: "settings" });
    this._lyricSettingsSaveTimer = setTimeout(() => {
      this._lyricSettingsSaveTimer = null;
      this.persistLyricSettings();
      this.sendLyricOverlay();
    }, 120);
  },
  recalcLyricCenterSpacer() {
    const box = this.$refs.lyricsScroll;
    const size = Math.max(14, Number(this.lyricMainFontSize) || DEFAULT_LYRIC_FONT_SIZE);
    const scale = Math.max(1, Number(this.lyricActiveScale) || DEFAULT_LYRIC_ACTIVE_SCALE);
    const overflow = Math.max(10, Math.ceil(size * (scale - 1) * 0.72));
    if (!box) {
      this.lyricCenterSpacer = Math.max(24, Math.round(size * 1.2 + overflow));
      return;
    }
    const spacer = Math.max(24, Math.round(box.clientHeight / 2 - size * 1.05 + overflow));
    this.lyricCenterSpacer = spacer;
  },
  shouldUseKaraoke(line, lineIdx) {
    return !!(this.lyricKaraoke && line && line.words && line.words.length && this.currentLyricIndex === lineIdx);
  },
  getKaraokeWordClass(lineIdx, wordIdx) {
    if (lineIdx !== this.currentLyricIndex) return "pending";
    if (wordIdx < this.currentLyricWordIndex) return "done";
    if (wordIdx > this.currentLyricWordIndex) return "pending";
    return "current";
  },
  computeKaraokeState(lineIdx, currentTime) {
    const nextLine = this.lyricLines[lineIdx + 1];
    return window.LyricTiming.wordState(this.lyricLines[lineIdx], currentTime,
      nextLine ? this.getLyricLineStartTime(nextLine) : NaN);
  },
  getLyricLineStartTime(line) {
    if (!line) return NaN;
    const firstWordTime = Array.isArray(line.words) && line.words.length
      ? Number(line.words[0]?.time)
      : NaN;
    if (Number.isFinite(firstWordTime)) return firstWordTime;
    const lineTime = Number(line.time);
    return Number.isFinite(lineTime) ? lineTime : NaN;
  },
  getLyricRenderTime(currentTime, options = {}) {
    const rawTime = Math.max(0, Number(currentTime || 0));
    const delayMs = options?.ignoreRenderDelay
      ? 0
      : Math.max(-1000, Math.min(1000, Number(this.lyricRenderDelayMs) || DEFAULT_LYRIC_RENDER_DELAY_MS));
    const outputDelay=window.FlowaveOutputCalibration?.delaySeconds({
      playing:!!(this.isPlaying&&!audio.paused&&!audio.ended&&!audio.seeking&&!audio.stretchWaiting),
      rate:Number(audio.playbackRate)||1,
    })||0;
    return Math.max(0, rawTime - delayMs / 1000 - outputDelay);
  },
  computeLyricLineIndexAt(currentTime, options = {}) {
    if (!this.lyricLines.length) return -1;
    if (!this.lyricHasTimeline) return 0;
    const leadSeconds = Math.max(0, Number(options?.leadMs) || 0) / 1000;
    const t = Number(currentTime || 0) + leadSeconds;
    for (let i = this.lyricLines.length - 1; i >= 0; i--) {
      if (t >= Number(this.getLyricLineStartTime(this.lyricLines[i]) || 0)) {
        return i;
      }
    }
    return -1;
  },
  computeLyricStateAt(currentTime, options = {}) {
    if (!this.lyricLines.length) {
      return { lineIndex: -1, wordIndex: -1, wordProgress: 0 };
    }
    if (!this.lyricHasTimeline) {
      return { lineIndex: 0, wordIndex: -1, wordProgress: 0 };
    }
    const leadMs = Math.max(0, Number(options?.leadMs) || 0);
    const lineIndex = this.computeLyricLineIndexAt(currentTime, { leadMs });
    if (lineIndex < 0) {
      return { lineIndex: -1, wordIndex: -1, wordProgress: 0 };
    }
    const karaokeState = this.lyricKaraoke ? this.computeKaraokeState(lineIndex, currentTime) : { wordIndex: -1, wordProgress: 0 };
    return {
      lineIndex,
      wordIndex: karaokeState.wordIndex,
      wordProgress: karaokeState.wordProgress,
    };
  },
  computeLyricScrollIndex(currentTime) {
    return this.computeLyricLineIndexAt(currentTime, {
      leadMs: Math.max(0, Number(this.lyricFocusLeadMs) || 0),
    });
  },
  computeOverlayPlaybackIndex(currentTime) {
    return this.computeLyricLineIndexAt(currentTime, {
      leadMs: Math.max(0, Number(this.lyricFocusLeadMs) || 0),
    });
  },
  getCurrentKaraokeWordElement() {
    if (!this.showLyric || this.currentLyricIndex < 0 || this.currentLyricWordIndex < 0) return null;
    if (
      this._karaokeActiveWordEl &&
      this._karaokeActiveLineIndex === this.currentLyricIndex &&
      this._karaokeActiveWordIndex === this.currentLyricWordIndex
    ) {
      return this._karaokeActiveWordEl;
    }
    const parent = this.$refs.lyricsScroll;
    if (!parent) return null;
    const el = parent.querySelector(`.lyric-line.karaoke-playing .lyric-word.current[data-word-idx="${this.currentLyricWordIndex}"]`);
    this._karaokeActiveWordEl = el || null;
    this._karaokeActiveLineIndex = this.currentLyricIndex;
    this._karaokeActiveWordIndex = this.currentLyricWordIndex;
    return this._karaokeActiveWordEl;
  },
  applyKaraokeWordProgress(progress) {
    const el = this.getCurrentKaraokeWordElement();
    if (!el) return;
    const clamped = Math.min(1, Math.max(0, Number(progress) || 0));
    if (this._karaokeRenderedProgress >= 0 && Math.abs(this._karaokeRenderedProgress - clamped) < 0.003) return;
    el.style.setProperty("--word-progress", `${Math.round(clamped * 1000) / 10}%`);
    this._karaokeRenderedProgress = clamped;
  },
  resetKaraokeWordProgress(options = {}) {
    const { preserveVisual = false, finalProgress = null } = options || {};
    if (this._karaokeActiveWordEl) {
      if (preserveVisual) {
        const progress = Number.isFinite(finalProgress) ? finalProgress : this._karaokeRenderedProgress;
        if (Number.isFinite(progress) && progress >= 0) {
          this._karaokeActiveWordEl.style.setProperty("--word-progress", `${Math.round(Math.min(1, Math.max(0, progress)) * 1000) / 10}%`);
        }
      } else {
        this._karaokeActiveWordEl.style.removeProperty("--word-progress");
      }
    }
    this._karaokeActiveWordEl = null;
    this._karaokeActiveLineIndex = -1;
    this._karaokeActiveWordIndex = -1;
    this._karaokeRenderedProgress = -1;
  },
  shouldRunKaraokeProgressTicker() {
    return !!(this.showLyric && this.lyricKaraoke && this.lyricHasTimeline && this.lyricLines.length
      && this.isPlaying && !audio.paused && !audio.seeking && !audio.stretchWaiting && Number(audio.readyState) >= 3);
  },
  stopKaraokeProgressTicker() {
    if (this._karaokeProgressRafId) {
      cancelAnimationFrame(this._karaokeProgressRafId);
      this._karaokeProgressRafId = 0;
    }
  },
  syncKaraokeProgressTicker() {
    if (!this.shouldRunKaraokeProgressTicker()) {
      this.stopKaraokeProgressTicker();
      return;
    }
    if (this._karaokeProgressRafId) return;
    const tick = () => {
      this._karaokeProgressRafId = 0;
      if (!this.shouldRunKaraokeProgressTicker()) {
        this.stopKaraokeProgressTicker();
        return;
      }
      this.updateLyricHighlight(Number(audio.currentTime || 0), { source: "raf" });
      this._karaokeProgressRafId = requestAnimationFrame(tick);
    };
    this._karaokeProgressRafId = requestAnimationFrame(tick);
  },
  stopLyricScrollAnimation() {
    if (this._lyricScrollRafId) {
      cancelAnimationFrame(this._lyricScrollRafId);
      this._lyricScrollRafId = 0;
    }
  },
  stopPendingLyricScrollRequest() {
    if (this._lyricScrollRequestRafId) {
      cancelAnimationFrame(this._lyricScrollRequestRafId);
      this._lyricScrollRequestRafId = 0;
    }
  },
  scheduleLyricViewportRefresh({ keepCentered = true } = {}) {
    if (!this.showLyric) return;
    this.stopLyricScrollAnimation();
    if (this._lyricResizeRafId) return;
    this._lyricResizeRafId = requestAnimationFrame(() => {
      this._lyricResizeRafId = 0;
      if (!this.showLyric) return;
      this.recalcLyricCenterSpacer();
      this.lyricProgrammaticScrollUntil = Date.now() + 160;
      if (keepCentered && this.lyricAutoFollow && this.lyricScrollIndex >= 0) {
        this.scrollActiveLyricToCenter(false);
      }
    });
  },
  getLyricScrollTarget(parent, lineEl) {
    if (!parent || !lineEl) return 0;
    const anchorRatio = this.lyricKaraoke ? 0.46 : 0.5;
    const rawTop = lineEl.offsetTop - parent.clientHeight * anchorRatio + lineEl.clientHeight / 2;
    const maxTop = Math.max(0, parent.scrollHeight - parent.clientHeight);
    return Math.max(0, Math.min(maxTop, rawTop));
  },
  scrollActiveLyricToCenter(animate = true) {
    this.stopPendingLyricScrollRequest();
    this._lyricScrollRequestRafId = requestAnimationFrame(() => {
      this._lyricScrollRequestRafId = 0;
      if (!this.showLyric || !this.lyricAutoFollow) return;
      const parent = this.$refs.lyricsScroll;
      if (!parent) return;
      const el = parent.querySelector(".lyric-line.scroll-target") || parent.querySelector(".lyric-line.active");
      if (!el) return;
      const top = this.getLyricScrollTarget(parent, el);
      this.stopLyricScrollAnimation();
      const startTop = parent.scrollTop;
      const delta = top - startTop;
      this.lyricProgrammaticScrollUntil = Date.now() + 200;
      if (!animate || Math.abs(delta) < 1) {
        parent.scrollTop = top;
        return;
      }
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
      if (reduced) { parent.scrollTop = top; return; }
      const duration = Math.max(140, Math.min(520, Number(this.lyricSwitchScrollMs) || DEFAULT_LYRIC_SWITCH_SCROLL_MS));
      this.lyricProgrammaticScrollUntil = Date.now() + duration * 3 + 80;
      let previous = performance.now();
      const started = previous;
      const step = now => {
        if (!this.showLyric || !this.lyricAutoFollow) { this._lyricScrollRafId = 0; return; }
        const elapsed = Math.max(0, Math.min(64, now - previous)); previous = now;
        const remaining = top - parent.scrollTop;
        if (Math.abs(remaining) < 1 || now - started >= duration * 3) { parent.scrollTop = top; this._lyricScrollRafId = 0; return; }
        const distance = remaining * (1 - Math.exp(-elapsed / (duration / 6)));
        parent.scrollTop += Math.sign(remaining) * Math.min(Math.abs(remaining), Math.max(1, Math.abs(distance)));
        this._lyricScrollRafId = requestAnimationFrame(step);
      };
      this._lyricScrollRafId = requestAnimationFrame(step);
    });
  },
  pauseLyricAutoFollow() {
    this.stopPendingLyricScrollRequest();
    this.stopLyricScrollAnimation();
    this.lyricProgrammaticScrollUntil = 0;
    this.lyricAutoFollow = false;
    this.clearLyricResumeTimer();
    this.lyricResumeTimer = setTimeout(() => {
      this.resumeLyricAutoFollow(true);
    }, 3000);
  },
  onLyricScrollIntent(event) {
    if (!this.showLyric) return;
    if (event.type === 'keydown' && !['ArrowUp','ArrowDown','PageUp','PageDown','Home','End',' '].includes(event.key)) return;
    if (event.type === 'pointerdown' && event.target !== event.currentTarget) return;
    this.pauseLyricAutoFollow();
  },
  resumeLyricAutoFollow(scrollNow = false) {
    this.lyricAutoFollow = true;
    this.clearLyricResumeTimer();
    if (scrollNow && this.lyricScrollIndex >= 0) {
      this.scrollActiveLyricToCenter(true);
    }
  },
  onLyricsScroll() {
    if (!this.showLyric || !this.lyricHasTimeline) return;
    // Scroll events also come from layout, anchoring and delayed automatic frames.
    // Only wheel/touch/keyboard/scrollbar intent may enter manual reading mode.
    if (!this.lyricAutoFollow) this.pauseLyricAutoFollow();
  },
  seekToLyricLine(line) {
    const lineStartTime = this.getLyricLineStartTime(line);
    if (!line || !this.lyricHasTimeline || !Number.isFinite(lineStartTime)) return;
    this.seekAudioTo(lineStartTime, "lyric-line");
    this.currentTime = audio.currentTime || lineStartTime;
    this.updateLyricHighlight(this.currentTime, { source: "seek", ignoreRenderDelay: true });
    if (audio.paused) {
      audio.play().catch(() => {});
    }
    this.isPlaying = true;
  },
  updateLyricHighlight(currentTime = this.currentTime, options = {}) {
    const renderTime = this.getLyricRenderTime(currentTime, options);
    const focusLeadMs = Math.max(0, Number(this.lyricFocusLeadMs) || 0);
    const state = this.computeLyricStateAt(renderTime, { leadMs: focusLeadMs });
    const nextScrollIndex = this.computeLyricScrollIndex(renderTime);
    const prevLineIndex = this.currentLyricIndex;
    const prevFocusIndex = this.lyricFocusIndex;
    const prevScrollIndex = this.lyricScrollIndex;
    const prevWordIndex = this.currentLyricWordIndex;
    const lineChanged = state.lineIndex !== prevLineIndex;
    const focusChanged = state.lineIndex !== prevFocusIndex;
    const scrollChanged = nextScrollIndex !== prevScrollIndex;
    const wordChanged = lineChanged || state.wordIndex !== prevWordIndex;
    this.currentLyricIndex = state.lineIndex;
    this.lyricFocusIndex = state.lineIndex;
    this.lyricScrollIndex = nextScrollIndex;
    this.currentLyricWordIndex = state.wordIndex;
    if (lineChanged || wordChanged) {
      this.currentLyricWordProgress = state.wordProgress;
      this.resetKaraokeWordProgress({
        preserveVisual: prevLineIndex >= 0 && prevWordIndex >= 0,
        finalProgress: lineChanged || wordChanged ? 1 : null,
      });
    }
    if (scrollChanged && this.showLyric && this.lyricAutoFollow) {
      this.scrollActiveLyricToCenter(!["seek", "seeked", "lyric-source", "settings"].includes(options.source));
    }
    if (scrollChanged || focusChanged || lineChanged || options.source !== "raf") {
      this.sendLyricOverlay();
    }
    if (options.source !== "raf") {
      this.currentLyricWordProgress = state.wordProgress;
    }
    if (state.lineIndex < 0 || state.wordIndex < 0) {
      return;
    }
    const applyProgress = () => this.applyKaraokeWordProgress(state.wordProgress);
    if (wordChanged) {
      this.$nextTick(applyProgress);
    } else {
      applyProgress();
    }
  },
  buildLyricOverlayPayload() {
    const renderTime = this.getLyricRenderTime(this.isAudioEventForCommittedSource() ? audio.currentTime : this.currentTime);
    const overlayPlaybackIndex = this.computeOverlayPlaybackIndex(renderTime);
    const playbackIdx = overlayPlaybackIndex >= 0 ? overlayPlaybackIndex : (this.currentLyricIndex >= 0 ? this.currentLyricIndex : 0);
    const current = this.lyricLines[playbackIdx] || null;
    const next = this.lyricLines[playbackIdx + 1] || null;
    const overlayKaraokeState = this.lyricKaraoke && playbackIdx >= 0
      ? this.computeKaraokeState(playbackIdx, renderTime)
      : { wordIndex: -1, wordProgress: 0 };
    const normalizeWords = (line) => Array.isArray(line?.words)
      ? line.words.map((word) => ({
        time: Number(word?.time) || 0,
        endTime: word?.endTime !== null && word?.endTime !== undefined && Number.isFinite(Number(word.endTime))
          ? Number(word.endTime)
          : null,
        text: String(word?.text || ""),
      }))
      : [];
    const normalizeLine = (line) => {
      const main = String(line?.main || "").trim();
      const sub = String(line?.sub || "").trim();
      return {
        time: Number(this.getLyricLineStartTime(line)) || 0,
        endTime: line?.endTime !== null && line?.endTime !== undefined && Number.isFinite(Number(line.endTime))
          ? Number(line.endTime)
          : null,
        // 桌面歌词固定保持来源主通道为歌曲原文；翻译只能作为次行，不能受软件内“只显示译文”设置影响。
        main,
        sub: main && sub && sub !== main ? sub : "",
        words: main ? normalizeWords(line) : [],
      };
    };
    return {
      title: this.currentMeta.title || this.extractName(this.currentPath) || "",
      artist: this.currentMeta.artist || "",
      playbackIndex: playbackIdx,
      currentTime: renderTime,
      playing: !!(this.isPlaying && !audio.paused && !audio.ended && !audio.seeking && !audio.stretchWaiting && Number(audio.readyState) >= 3),
      playbackRate: Number(audio.playbackRate) || 1,
      lyricHasTimeline: !!this.lyricHasTimeline,
      lyricKaraoke: !!this.lyricKaraoke,
      karaokeWordIndex: overlayKaraokeState.wordIndex,
      karaokeWordProgress: overlayKaraokeState.wordProgress,
      lyricFocusLeadMs: Math.max(0, Number(this.lyricFocusLeadMs) || 0),
      focusNext: this.lyricScrollIndex > playbackIdx,
      current: normalizeLine(current),
      next: normalizeLine(next),
    };
  },
  getLyricOverlaySettingsPayload() {
    const hasCover = !!this.getDesktopLyricCoverSource();
    const coverColors = this.desktopLyricCoverColor && hasCover ? this.desktopLyricCoverPalette : null;
    return {
      locked: !!this.desktopLyricLocked,
      fontSize: this.desktopLyricMainFontSize,
      mainFontSize: this.desktopLyricMainFontSize,
      subFontSize: this.desktopLyricSubFontSize,
      opacity: this.desktopLyricOpacity,
      strokeStrength: this.desktopLyricStroke,
      currentOnly: !!this.desktopLyricCurrentOnly,
      activeColor: coverColors?.activeColor || this.lyricActiveColor,
      inactiveColor: coverColors?.inactiveColor || this.lyricInactiveColor,
      metaColor: coverColors?.metaColor || this.lyricMetaColor,
      fontFamily: this.lyricFontFamily || DEFAULT_LYRIC_FONT_FAMILY,
      switchScrollMs: Math.max(120, Number(this.lyricSwitchScrollMs) || DEFAULT_LYRIC_SWITCH_SCROLL_MS),
    };
  },
  getDesktopLyricCoverSource() {
    return String(this.currentCoverFull || this.currentCover || "").trim();
  },
  remapMovedMetadataCacheUrl(src) {
    const raw = String(src || "").trim();
    const marker = "/data/cache/metadata/";
    if (!/^file:\/\//i.test(raw)) return raw;
    const normalized = raw.replace(/\\/g, "/");
    const idx = normalized.toLowerCase().lastIndexOf(marker);
    if (idx < 0) return raw;
    const appRoot = String(window.location?.href || "").split("/electron-lxplayer/renderer/")[0];
    if (!appRoot) return raw;
    return `${appRoot}${marker}${normalized.slice(idx + marker.length)}`;
  },
  async updateDesktopLyricCoverPalette() {
    const src = this.remapMovedMetadataCacheUrl(this.getDesktopLyricCoverSource());
    const cacheKey = `v3:${src}`;
    const requestId = (this._desktopLyricCoverPaletteRequestId || 0) + 1;
    this._desktopLyricCoverPaletteRequestId = requestId;
    if (!this.desktopLyricCoverColor || !src) {
      this.desktopLyricCoverPalette = null;
      this.sendLyricOverlay();
      return;
    }
    if (this._desktopLyricCoverPaletteCache?.has(cacheKey)) {
      this.desktopLyricCoverPalette = this._desktopLyricCoverPaletteCache.get(cacheKey);
      this.sendLyricOverlay();
      return;
    }
    try {
      const palette = await this.extractCoverLyricPalette(src);
      if (requestId !== this._desktopLyricCoverPaletteRequestId) return;
      this._desktopLyricCoverPaletteCache.set(cacheKey, palette);
      this.desktopLyricCoverPalette = palette;
      this.sendLyricOverlay();
    } catch (e) {
      if (requestId !== this._desktopLyricCoverPaletteRequestId) return;
      console.warn("桌面歌词封面取色失败", e?.message || e);
      this.desktopLyricCoverPalette = null;
      this.sendLyricOverlay();
    }
  },
  extractCoverLyricPalette(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const remappedSrc = this.remapMovedMetadataCacheUrl(src);
      if (/^https?:/i.test(src)) {
        img.crossOrigin = "anonymous";
      }
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          const size = 48;
          canvas.width = size;
          canvas.height = size;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) throw new Error("canvas unavailable");
          ctx.drawImage(img, 0, 0, size, size);
          const data = ctx.getImageData(0, 0, size, size).data;
          resolve(this.buildLyricPaletteFromPixels(data));
        } catch (e) {
          reject(e);
        }
      };
      img.onerror = () => reject(new Error("cover load failed"));
      img.src = remappedSrc;
    });
  },
  buildLyricPaletteFromPixels(data) {
    const buckets = new Map();
    for (let i = 0; i < data.length; i += 16) {
      const alpha = data[i + 3] / 255;
      if (alpha < 0.35) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;
      const brightness = (max + min) / 2 / 255;
      if (brightness < 0.08 || brightness > 0.96) continue;
      const key = `${Math.round(r / 24)}:${Math.round(g / 24)}:${Math.round(b / 24)}`;
      const vividWeight = alpha * (0.35 + saturation * 1.65) * (0.65 + Math.min(0.65, Math.abs(brightness - 0.52)));
      const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, weight: 0, vivid: 0 };
      bucket.r += r * vividWeight;
      bucket.g += g * vividWeight;
      bucket.b += b * vividWeight;
      bucket.weight += vividWeight;
      bucket.vivid += vividWeight * (0.55 + saturation * 1.2);
      buckets.set(key, bucket);
    }
    const candidates = Array.from(buckets.values())
      .filter((bucket) => bucket.weight > 0)
      .map((bucket) => ({
        r: bucket.r / bucket.weight,
        g: bucket.g / bucket.weight,
        b: bucket.b / bucket.weight,
        score: bucket.vivid,
      }))
      .sort((a, b) => b.score - a.score);
    const base = candidates[0] || { r: 128, g: 212, b: 255 };
    const active = this.adjustRgbForLyric(base, { saturation: 1.45, lightness: 0.62, minSaturation: 0.55, maxSaturation: 0.95 });
    const inactive = this.adjustRgbForLyric(base, { saturation: 0.22, lightness: 0.86, minSaturation: 0.08, maxSaturation: 0.28 });
    const meta = this.adjustRgbForLyric(base, { saturation: 0.18, lightness: 0.72, minSaturation: 0.06, maxSaturation: 0.24 });
    return {
      activeColor: this.rgbToHex(active),
      inactiveColor: this.rgbToHex(inactive),
      metaColor: this.rgbToHex(meta),
    };
  },
  adjustRgbForLyric(rgb, options = {}) {
    const hsl = this.rgbToHsl(rgb);
    const minSaturation = Number.isFinite(Number(options.minSaturation)) ? Number(options.minSaturation) : 0.38;
    const maxSaturation = Number.isFinite(Number(options.maxSaturation)) ? Number(options.maxSaturation) : 0.92;
    hsl.s = Math.max(minSaturation, Math.min(maxSaturation, hsl.s * (Number(options.saturation) || 1)));
    hsl.l = Math.max(0.18, Math.min(0.9, Number(options.lightness) || hsl.l));
    return this.hslToRgb(hsl);
  },
  rgbToHsl(rgb) {
    const r = Math.min(255, Math.max(0, rgb.r)) / 255;
    const g = Math.min(255, Math.max(0, rgb.g)) / 255;
    const b = Math.min(255, Math.max(0, rgb.b)) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0;
    let s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return { h, s, l };
  },
  hslToRgb(hsl) {
    const h = ((Number(hsl.h) || 0) % 1 + 1) % 1;
    const s = Math.max(0, Math.min(1, Number(hsl.s) || 0));
    const l = Math.max(0, Math.min(1, Number(hsl.l) || 0));
    if (s === 0) {
      const v = l * 255;
      return { r: v, g: v, b: v };
    }
    const hueToRgb = (p, q, tRaw) => {
      let t = tRaw;
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    return {
      r: hueToRgb(p, q, h + 1 / 3) * 255,
      g: hueToRgb(p, q, h) * 255,
      b: hueToRgb(p, q, h - 1 / 3) * 255,
    };
  },
  rgbToHex(rgb) {
    const toHex = (value) => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");
    return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
  },
  sendLyricOverlay() {
    if (!window.lxEnv) return;
    const settings = this.getLyricOverlaySettingsPayload();
    if (!this.desktopLyricEnabled) {
      if (this.desktopLyricOpen && typeof window.lxEnv.closeLyricOverlay === "function") {
        window.lxEnv.closeLyricOverlay().catch(() => {});
      }
      this.desktopLyricOpen = false;
      return;
    }
    // Pause should hide desktop lyric; playback resume will reopen via subsequent updates.
    if (this.currentPath && !this.isPlaying) {
      if (this.desktopLyricOpen && typeof window.lxEnv.closeLyricOverlay === "function") {
        window.lxEnv.closeLyricOverlay().catch(() => {});
      }
      this.desktopLyricOpen = false;
      return;
    }
    const update = this.buildLyricOverlayPayload();
    const openPayload = { settings, update, locked: this.desktopLyricLocked };
    if (!this.desktopLyricOpen && typeof window.lxEnv.openLyricOverlay === "function") {
      window.lxEnv.openLyricOverlay(openPayload).then((ret) => {
        this.desktopLyricOpen = !!ret?.ok;
        console.info(`[overlay-ui][open] ok=${this.desktopLyricOpen ? 1 : 0}`);
      }).catch(() => {
        this.desktopLyricOpen = false;
        console.warn("[overlay-ui][open] failed");
      });
      return;
    }
    if (typeof window.lxEnv.updateLyricOverlay === "function") {
      window.lxEnv.updateLyricOverlay(openPayload).then((ret) => {
        if (ret?.ok) {
          return;
        }
        console.warn(`[overlay-ui][update] not_ok reason=${ret?.reason || "-"}`);
        if (ret?.reason === "not-open" && typeof window.lxEnv.openLyricOverlay === "function") {
          this.desktopLyricOpen = false;
          window.lxEnv.openLyricOverlay(openPayload).then((openRet) => {
            this.desktopLyricOpen = !!openRet?.ok;
            console.info(`[overlay-ui][reopen] ok=${this.desktopLyricOpen ? 1 : 0}`);
          }).catch(() => {
            this.desktopLyricOpen = false;
            console.warn("[overlay-ui][reopen] failed");
          });
        }
      }).catch(() => {
        this.desktopLyricOpen = false;
        console.warn("[overlay-ui][update] failed");
      });
    }
  },
  handleLyricOverlayAction(data) {
    const action = data?.action || "";
    if (!action) return;
    if (action === "toggle-lock") {
      this.desktopLyricLocked = !this.desktopLyricLocked;
      this.saveDesktopLyricSettings();
      return;
    }
    if (action === "cycle-font") {
      const levels = [28, 34, 40, 46, 52, 58];
      const cur = Number(this.desktopLyricMainFontSize) || levels[0];
      const idx = levels.findIndex((n) => n >= cur - 0.01);
      this.desktopLyricMainFontSize = levels[(idx + 1) % levels.length];
      this.saveDesktopLyricSettings();
      return;
    }
    if (action === "cycle-opacity") {
      const levels = [0.55, 0.7, 0.85, 1];
      const cur = Number(this.desktopLyricOpacity) || levels[0];
      const idx = levels.findIndex((n) => n >= cur - 0.01);
      this.desktopLyricOpacity = levels[(idx + 1) % levels.length];
      this.saveDesktopLyricSettings();
      return;
    }
    if (action === "toggle-current-only") {
      this.desktopLyricCurrentOnly = !this.desktopLyricCurrentOnly;
      this.saveDesktopLyricSettings();
    }
  },
  openLyricPanel() {
    if (this.showLyric) return;
    this.showLyric = true;
    this.lyricVolumeOpen = false;
    this.resumeLyricAutoFollow(false);
    if (!this.lyricLines.length) {
      if (this.currentMeta.lyricModel && this.applyLyricModel(this.currentMeta.lyricModel)) {
        // Already applied through the structured path.
      } else if (this.currentMeta.lyric) {
        this.applyLyricText(this.currentMeta.lyric);
      }
    }
    this.$nextTick(() => {
      this.recalcLyricCenterSpacer();
      this.updateLyricHighlight();
      this.syncKaraokeProgressTicker();
      if (this.lyricScrollIndex >= 0) {
        this.scrollActiveLyricToCenter(false);
      }
    });
  },
  closeLyricPanel() {
    if (!this.showLyric) return;
    this.showLyric = false;
    this.lyricVolumeOpen = false;
    this.resumeLyricAutoFollow(false);
    this.stopPendingLyricScrollRequest();
    if (this._lyricResizeRafId) {
      cancelAnimationFrame(this._lyricResizeRafId);
      this._lyricResizeRafId = 0;
    }
    this.stopLyricScrollAnimation();
    this.stopKaraokeProgressTicker();
    this.resetKaraokeWordProgress();
  },
  toggleLyric() {
    if (this.showLyric) this.closeLyricPanel();
    else this.openLyricPanel();
  },
  handleHotkey(action) {
    console.info(`[hotkey] action=${action}`);
    this.appendMediaDiagEvent("renderer_hotkey_received", { action: String(action || "") });
    const ok = this.dispatchPlayerAction(action, "hotkey");
    this.appendMediaDiagEvent("renderer_action_result", { action: String(action || ""), ok: !!ok });
  },
};

let audioDetailReturnFocus = null;
const practiceMethods = {
  async configurePracticeTraining(payload) {
    if(!payload.enabled){if(payload.path===this.currentPath||practiceTraining?.path===payload.path)++practiceTrainingGeneration;if(practiceTraining?.path===payload.path){practiceTraining.dispose();practiceTraining=null}return;}
    if(payload.path!==this.currentPath||this.view!=='practice'||this.showLyric)return;
    const generation=++practiceTrainingGeneration,source=audio,path=this.currentPath;
    // User cancellation must detach native loops before any asynchronous DSP work.
    if(payload.loop!==true){if(practiceTraining?.source===source)practiceTraining.disableLoop();else if(source.practiceRegion)source.setPracticeRegion?.(null);}
    const rate=Math.max(.5,Math.min(1.25,Number(payload.rate)||1));
    if(source===practicePlayer&&rate!==1)await window.FlowaveStemPlayer.prepareStretch(audioEngine.context);
    if(generation!==practiceTrainingGeneration||audio!==source||path!==this.currentPath||this.view!=='practice'||this.showLyric)return;
    practiceTraining?.dispose(false);practiceTraining=null;
    this.cancelNaturalCrossfade();source.preservesPitch=true;source.playbackRate=rate;
    const transport=new window.FlowavePracticeTraining.Transport({source,config:{...payload,every:Math.max(1,Math.min(20,Math.round(Number(payload.every)||3))),step:Math.max(1,Math.min(10,Number(payload.step)||5)),target:Math.max(50,Math.min(125,Number(payload.target)||100))},readCurrent:()=>this.currentPath===path&&this.view==='practice'&&!this.showLyric?audio:null,
      setRate:async next=>{if(audio===source&&practiceTraining===transport&&transport.region&&transport.config.loop){source.playbackRate=next;}},
      seek:value=>{if(audio===source)this.currentTime=this.seekAudioTo(value,'practice-loop')},onError:message=>this.showNotice(message,'error')});
    transport.path=path;practiceTraining=transport;
  },
  async createPracticeCalibrationOutput() {
    if(this.muted||Number(this.volume)<=0)throw new Error('请先取消静音并调高主音量。');
    const clock=this.readPracticeClock(),path=this.currentPath;let analysis=null;
    if(this.featureEnabled?.('practice')!==false)try{const {data}=await axios.get(this.baseUrl+'/practice/analysis',{params:{path}});if(data.status==='ready')analysis=data.analysis}catch{}
    if(path!==this.currentPath)throw new Error('歌曲已变化，请重新开始校准。');
    const tempo=window.FlowavePracticeTiming.tempoAt(analysis,clock.time);
    await this.configurePracticeMetronome({enabled:false});
    window.dispatchEvent(new Event('flowave-calibration-start'));
    if(this.isPlaying)this.pauseByManual('bluetooth-calibration');
    if(!audioEngine?.Context)throw new Error('当前设备不支持校准声音。');
    await audioEngine.resume();
    const output=new window.FlowaveMetronome({context:audioEngine.context,destination:audioEngine.master,readClock:()=>({playing:false})});
    output.setVolume(65);audioEngine.metronomeMix=true;audioEngine.updatePeakProtection();
    return {bpm:tempo?tempo.bpm*clock.rate:120,meter:tempo?.meter?.[0]||4,denominator:tempo?.meter?.[1]||4,context:audioEngine.context,click:(when,accent)=>output.click(when,accent,'click'),dispose:()=>{output.dispose();audioEngine.metronomeMix=!!practiceMetronome;audioEngine.updatePeakProtection()}};
  },
  async configurePracticeMetronome(payload) {
    const generation = ++practiceMetronomeGeneration;
    clearTimeout(practiceMetronomePreviewTimer); practiceMetronomePreview?.dispose(); practiceMetronomePreview = null;
    practiceMetronome?.dispose(); practiceMetronome = null;
    if (audioEngine) { audioEngine.metronomeMix = false; audioEngine.updatePeakProtection(); }
    if (!payload.enabled) return;
    if (this.view !== 'practice' || this.showLyric || !this.currentPath || !payload.beats?.length) return;
    const path = this.currentPath;
    if (!audioEngine?.Context) throw new Error('当前设备不支持节拍器。');
    await audioEngine.resume();
    if (generation !== practiceMetronomeGeneration || this.view !== 'practice' || this.showLyric || this.currentPath !== path) return;
    practiceMetronome = new window.FlowaveMetronome({context:audioEngine.context,destination:audioEngine.master,
      readClock:()=>({...this.readPracticeClock(),playing:!audio.stretchWaiting&&this.view==='practice'&&!this.showLyric&&this.currentPath===path&&this.isPlaying&&!audio.paused&&!audio.ended&&!audio.seeking&&Number(audio.readyState)>=3&&!this.pendingPlaybackTransition,
        source:audio,loopEnd:practiceTraining?.source===audio?practiceTraining.region?.end:null,rate:Number(audio.playbackRate)||1,delay:audio===practicePlayer&&!audio.stretchWaiting?Math.max(0,(practicePlayer.started||0)-audioEngine.context.currentTime):0}),onError:payload.onError});
    audioEngine.metronomeMix = true; audioEngine.updatePeakProtection();
    practiceMetronome.configure(payload.beats,payload.volume,payload.sound);
  },
  setPracticeMetronomeSound(value) { practiceMetronome?.setSound(value); },
  async previewPracticeMetronome(payload) {
    const generation = practiceMetronomeGeneration;
    if (this.view !== 'practice' || this.showLyric) return;
    if (!audioEngine?.Context) throw new Error('当前设备不支持节拍器。');
    await audioEngine.resume();
    if (generation !== practiceMetronomeGeneration || this.view !== 'practice' || this.showLyric) return;
    clearTimeout(practiceMetronomePreviewTimer); practiceMetronomePreview?.dispose();
    const preview = new window.FlowaveMetronome({context:audioEngine.context,destination:audioEngine.master,readClock:()=>({playing:false})});
    practiceMetronomePreview = preview;
    audioEngine.metronomeMix = true; audioEngine.updatePeakProtection();
    preview.setVolume(payload.volume);preview.click(audioEngine.context.currentTime+.02,true,payload.sound);
    practiceMetronomePreviewTimer=setTimeout(()=>{preview.dispose();if(practiceMetronomePreview===preview){practiceMetronomePreview=null;audioEngine.metronomeMix=!!practiceMetronome;audioEngine.updatePeakProtection();}},180);
  },
  setPracticeMetronomeVolume(value) { practiceMetronome?.setVolume(value); },
  handlePracticeArrows(event) {
    if(this.view!=='practice'||this.showLyric||!this.currentPath||this.pendingPlaybackTransition||event.defaultPrevented||event.isComposing
      ||event.ctrlKey||event.altKey||event.metaKey||event.shiftKey||!['ArrowLeft','ArrowRight'].includes(event.key))return false;
    const target=event.target;
    if(target?.isContentEditable||target?.closest?.('input,textarea,select,[role="textbox"],[role="slider"],.practice-saved-title,.practice-confirm,.practice-saved-confirm'))return false;
    if([...document.querySelectorAll('[aria-modal="true"]')].some(node=>node.getClientRects().length))return false;
    const clock=this.readPracticeClock();if(clock.path!==this.currentPath||!Number.isFinite(clock.time))return false;
    const next=Math.max(0,clock.time+(event.key==='ArrowLeft'?-5:5));
    event.preventDefault();event.stopPropagation();this.seekPracticeTime(clock.duration>0?Math.min(clock.duration,next):next);return true;
  },
  handlePracticeSpace(event) {
    if (this.view !== 'practice' || this.showLyric || event.defaultPrevented || event.isComposing
      || event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || !['Space', ' '].includes(event.code || event.key)) return false;
    const target = event.target;
    if (target?.isContentEditable || target?.closest?.('input, textarea, select, [role="textbox"], .practice-saved-title, .practice-confirm, .practice-saved-confirm')) return false;
    if ([...document.querySelectorAll('[aria-modal="true"]')].some(node => node.getClientRects().length)) return false;
    event.preventDefault(); event.stopPropagation();
    if (!event.repeat) this.togglePlay();
    return true;
  },
  playSavedPracticeTrack(resourceId) { const track = this.trackByResourceId?.get(String(resourceId || '')); if (!track?.path) { this.lastPlaybackError = '这首歌已不在当前曲库中，无法播放。'; return; } return this.playByPath(track.path); },
  readPracticeClock() { return { path: this.currentPath, time: Number(audio.currentTime) || 0, duration: Number(audio.duration) || 0, rate:Number(audio.playbackRate)||1, trainingCycles:practiceTraining?.source===audio?practiceTraining.cycles:0, playing: !!(this.isPlaying && !audio.paused && !audio.ended && !audio.seeking && !audio.stretchWaiting) }; },
  seekPracticeTime(value) { if(practiceTraining?.source===audio&&practiceTraining.region&&(value<practiceTraining.region.start||value>=practiceTraining.region.end)){++practiceTrainingGeneration;practiceTraining.disableLoop();window.dispatchEvent(new Event('flowave-practice-loop-disabled'));}this.currentTime = this.seekAudioTo(value, 'practice-score'); },
  savePracticeVisibility() { writeStored('lx-practice-entry', this.showPracticeEntry ? '1' : '0'); },
  openPractice() {
    if (this.view !== 'practice') this.practiceReturn = { view: this.view, lyric: !!this.showLyric };
    if (this.showLyric) this.closeLyricPanel();
    this.setView('practice');
  },
  closePractice() {
    const previous = this.practiceReturn || { view: 'library', lyric: false };
    this.setView(previous.view === 'practice' ? 'library' : previous.view);
    if (previous.lyric) this.openLyricPanel();
  },
  updatePracticeMix(payload) { if (practicePlayer) { practicePlayer.setMix(payload.mix, payload.solo); if (payload.loop !== undefined) practicePlayer.loop = payload.loop; } },
  async enablePractice(payload) {
    if(this.featureEnabled?.('practice')===false)return;
    if (this.practiceLoading || practicePlayer || this.pendingPlaybackTransition || !this.currentPath) return;
    const original = audio, path = this.currentPath, generation = ++practiceGeneration;
    const controller = new AbortController(); practiceController = controller;
    this.practiceLoading = true; this.practiceLoadProgress = '准备同步音轨…';
    const guard = () => { controller.signal.throwIfAborted(); if (generation !== practiceGeneration || audio !== original || this.currentPath !== path || this.pendingPlaybackTransition) throw new Error('歌曲已变化，已取消载入伴奏。'); };
    let candidate = null, wasPlaying = false, pendingPages = null;
    try {
      this.cancelNaturalCrossfade(); audioEngine?.stopTail(audio);
      if (!audioEngine?.Context) throw new Error('当前音频设备不支持同步分轨播放。');
      await audioEngine.resume(); guard();
      const buffers = await window.FlowaveStemPlayer.decode(audioEngine.context, this.baseUrl, payload.detail, controller.signal,
        (done, total) => { if (generation === practiceGeneration) this.practiceLoadProgress = '载入音轨 ' + done + ' / ' + total; }, original.currentTime);
      pendingPages = buffers.pages;
      guard();
      // Query again before taking over playback: source or generation may have changed while decoding.
      const { data: current } = await axios.get(this.baseUrl + '/stems/track', { params: { path, validation_only: true }, signal: controller.signal });
      guard();
      if (current.status !== 'ready' || current.generation !== payload.detail.generation) throw new Error('分轨已变化，请重新载入。');
      const Player = buffers.pages ? window.FlowavePagedStemPlayer : window.FlowaveStemPlayer.StemPlayer;
      candidate = new Player(audioEngine.context, audioEngine.preamp, buffers, payload.detail,
        String(original.currentSrc || original.src), payload.mix);
      candidate.setMix(payload.mix, payload.solo);
      candidate.loop = payload.loop !== false;
      window.FlowaveStemPlayer.pin(buffers);
      candidate.currentTime = original.currentTime;
      if(original.playbackRate!==1)await window.FlowaveStemPlayer.prepareStretch(audioEngine.context);guard();
      candidate.playbackRate = original.playbackRate;
      const training=practiceTraining?.config;
      const playing = !original.paused; wasPlaying = playing;
      // Switch the event authority before pausing the native element; no duplicate history session.
      practiceOriginal = original; practicePlayer = candidate; audio = candidate; wireAudioSlot(candidate);
      audioEngine.externalMix = true; audioEngine.updatePeakProtection();
      original.pause(); this.practiceEnabled = true;
      this.currentTime = candidate.currentTime;
      if (playing) await candidate.play();
      controller.signal.throwIfAborted();
      if(generation!==practiceGeneration||audio!==candidate||this.currentPath!==path)throw new Error('歌曲已变化，已取消载入伴奏。');
      if(training)await this.configurePracticeTraining({...training,path,enabled:true});
      this.syncKaraokeProgressTicker(); this.sendLyricOverlay();
    } catch (error) {
      const currentFailure = generation === practiceGeneration && !controller.signal.aborted;
      if (candidate && practicePlayer === candidate) {
        this.disablePractice(false);
        if (wasPlaying && this.currentPath === path && !this.pendingPlaybackTransition) original.play().catch(() => { this.isPlaying = false; });
      }
      else candidate?.dispose();
      if(!candidate)pendingPages?.close();
      if (currentFailure) {
        window.FlowaveStemPlayer.clearCache();
        this.showNotice(error?.message || '伴奏载入失败，原曲保持可用。', 'error');
      }
    } finally {
      if (generation === practiceGeneration) { practiceController = null; this.practiceLoading = false; this.practiceLoadProgress = ''; }
    }
  },
  disablePractice(resume = true) {
    if (typeof resume !== 'boolean') resume = true;
    ++practiceGeneration; practiceController?.abort(); practiceController = null;
    this.practiceLoading = false; this.practiceLoadProgress = '';
    if (!practicePlayer) return;
    const player = practicePlayer, original = practiceOriginal;
    const training=practiceTraining?.source===player?practiceTraining.config:null;
    if(training){practiceTraining.dispose(false);practiceTraining=null;++practiceTrainingGeneration;}
    const at = player.currentTime, playing = !player.paused, rate = player.playbackRate;
    practicePlayer = null; practiceOriginal = null; audio = original;
    window.FlowaveStemPlayer.release(player.buffers, resume);
    player.dispose(); this.practiceEnabled = false;
    audioEngine.externalMix = false; audioEngine.updatePeakProtection();
    try { original.currentTime = Math.min(at, Number.isFinite(original.duration) ? original.duration : at); original.preservesPitch=true;original.playbackRate = resume?rate:1; }
    catch { this._pendingSeekTime = at; }
    this.currentTime = at;
    if (resume && playing) original.play().catch(() => { this.isPlaying = false; this.showNotice('请点击播放继续原曲。', 'error'); });
    if(resume&&training)this.configurePracticeTraining({...training,path:this.currentPath,enabled:true}).catch(error=>this.showNotice(error.message,'error'));
    this.syncKaraokeProgressTicker(); this.sendLyricOverlay();
  },
};
const soundMapMethods = {
  openSongAnalysis(path = "") {
    if(this.view!=="analysis")this.analysisReturn={view:this.view,lyric:!!this.showLyric};
    this.analysisPinnedPath=typeof path==="string"?path:"";
    if(this.showLyric)this.closeLyricPanel();
    this.setView("analysis");
  },
  closeSongAnalysis() {
    const previous=this.analysisReturn||{view:"library",lyric:false};
    this.setView(previous.view==="analysis"?"library":previous.view);
    if(previous.lyric)this.openLyricPanel();
  },
  playAnalysisQueue({paths,path}) {
    if(!Array.isArray(paths)||!paths.includes(path))return;
    this.installDetailQueue(paths,"曲库概览 · 筛选结果");
    return this.playByPath(path,true,"collection");
  },
  seekAnalysisTime(value) { this.currentTime=this.seekAudioTo(value,"song-analysis"); },
  openSoundMapFor(path) {
    this.closeAudioDetail();
    this.setView("sound-map");
    this.$nextTick(()=>this.$refs.soundMap?.focusPath(path));
  },
  readSoundMapPreferences() { return readStoredObject("lx-sound-map-preferences", {}); },
  writeSoundMapPreferences(value) { writeStored("lx-sound-map-preferences", JSON.stringify(value)); },
  soundMapTrack(path) {
    const track = this.trackByPath?.get(path) || this.onlineTrackMap?.[path] || {};
    return { title: track.title || track.name || this.extractName(path), artist: track.artist || "",
      cover: this.isOnlineToken(path) ? this.onlineCoverUrl(track.cover || "") : this.pathToFile(track.cover_thumb || track.cover || "") };
  },
  async soundMapMetadata(path, resourceId) {
    if (this.isOnlineToken(path)) return this.soundMapTrack(path);
    if (!window.lxEnv?.getSongInfo) return this.soundMapTrack(path);
    const info = await window.lxEnv.getSongInfo(path, {resourceId, includeLyrics:false});
    if (!info || info.metadataError) return this.soundMapTrack(path);
    return {title:info.title || this.extractName(path), artist:info.artist || "",
      cover:this.pathToFile(info.cover_thumb || info.cover || "")};
  },
  soundMapDecisionSnapshot(id) {
    const item=(this.recommendationDiagnostics||[]).find(row=>row.id===id);
    if(!item)return null;
    const fields=["id","requestId","at","source","trigger","from","target","policy","indexGeneration","scope",
      "parameters","historyCount","candidateCount","selectedRank","probability","similarity","recent",
      "feedbackUpdatedAt","continuityReward","fallback","poolStats","selectedScores","admission","candidateSample","consecutiveDislikeCount","sampling","intent","policyDetails","contextReferences","repeatedRecommendation","evidence","recordingMembers"];
    const snapshot=JSON.parse(JSON.stringify(Object.fromEntries(fields.map(key=>[key,item[key]]))));
    const size=()=>new TextEncoder().encode(JSON.stringify(snapshot)).length;
    // Keep the raw event appendable; references with stable IDs need no repeated long paths.
    if(size()>24000){
      snapshot.diagnosticTruncated=true;
      snapshot.contextReferences=(snapshot.contextReferences||[]).map(r=>r.resourceId?{resourceId:r.resourceId,songKey:r.songKey}:r);
      snapshot.candidateSample=[];
    }
    if(size()>24000){snapshot.evidence=null;snapshot.contextReferences=(snapshot.contextReferences||[]).map(r=>({resourceId:r.resourceId}));}
    if(size()>24000){snapshot.policyDetails={effective_intent:snapshot.policyDetails?.effective_intent,
      policy_build:snapshot.policyDetails?.policy_build,reason:snapshot.policyDetails?.reason};snapshot.diagnosticOmitted=true;}
    return snapshot;
  },
  persistSoundMapTrace() {
    if(this.featureEnabled?.('recommendation')===false)return;
    if (this.soundMapArchiveMode === 'legacy') writeStored("lx-sound-map-trace", JSON.stringify(this.soundMapTrace));
    else if (this.soundMapTrace.length > 8) this.soundMapTrace = markSearchRaw(this.soundMapTrace.slice(-8));
    this.soundMapTraceRevision++;
  },
  initializeSoundMapArchive() {
    if(this.featureEnabled?.('recommendation')===false)return;
    if (!window.lxEnv?.prepareListeningTrace || soundMapArchivePromise || this.listeningHistoryClosing) return soundMapArchivePromise;
    clearTimeout(soundMapArchiveTimer);
    soundMapArchivePromise = (async () => {
      try {
        await this.drainSoundMapEvents();
        if (this.listeningHistoryClosing) return;
        if (this.soundMapOutbox.length) throw new Error('请先保存待重试轨迹');
        // Also preserve the last observed anchor when there are no new events.
        await window.lxEnv.saveListeningTraceHot({rows:this.soundMapTrace.slice(-8),outbox:this.soundMapOutbox});
        const result = await window.lxEnv.prepareListeningTrace(this.soundMapArchiveMode === 'legacy' ? JSON.stringify(this.soundMapTrace) : undefined);
        this.soundMapArchiveMode = result.mode;
        rendererStateStore.__flowaveTraceArchive = result;
        if (result.mode !== 'legacy') {
          delete rendererStateStore['lx-sound-map-trace'];
          this.soundMapTrace = markSearchRaw(this.soundMapTrace.slice(-8));
        }
        this.soundMapArchiveError = '';
        this.soundMapTraceRevision++;
        if (result.mode === 'building' && !this.listeningHistoryClosing) soundMapArchiveTimer = setTimeout(()=>this.initializeSoundMapArchive(),100);
      } catch (error) {
        this.soundMapArchiveError = error?.message || '轨迹整理暂时失败，原记录保留';
        if (!this.listeningHistoryClosing) soundMapArchiveTimer = setTimeout(()=>this.initializeSoundMapArchive(),15000);
      } finally { soundMapArchivePromise = null; }
    })();
    return soundMapArchivePromise;
  },
  async rebuildSoundMapArchive() {
    await this.drainSoundMapEvents();
    if (this.soundMapOutbox.length) throw new Error('轨迹尚未保存，请先重试保存');
    const result = await window.lxEnv.rebuildListeningTrace();
    this.soundMapArchiveMode=result.mode;
    return this.initializeSoundMapArchive();
  },
  async prepareSoundMapRollback() {
    // Developer recovery entry: call before changing back to source without cold reads.
    if(this.soundMapRollbackActive||this.listeningSession||this.pendingPlaybackTransition)throw new Error('请停止播放并等待切换结束后再准备源码回退');
    this.soundMapRollbackActive=true;
    try{
      await this.drainSoundMapEvents();
      if(this.soundMapOutbox.length)throw new Error('请先保存待重试轨迹');
      if(soundMapArchivePromise)await soundMapArchivePromise;
      const result=await window.lxEnv.rollbackListeningTrace();
      if(!result?.ok||!Array.isArray(result.rows))throw new Error('轨迹回退导出失败');
      clearTimeout(soundMapArchiveTimer);
      this.soundMapArchiveMode='legacy';rendererStateStore.__flowaveTraceArchive={mode:'legacy'};
      this.soundMapTrace=markSearchRaw(result.rows);this.persistSoundMapTrace();
      return {ok:true,count:result.rows.length};
    }finally{this.soundMapRollbackActive=false;}
  },
  drainSoundMapEvents() {
    if(this.featureEnabled?.('recommendation')===false)return Promise.resolve({ok:true,skipped:true});
    if (soundMapDrainPromise) return soundMapDrainPromise;
    if (!window.lxEnv?.appendListeningTrace) return Promise.resolve();
    soundMapDrainPromise = (async () => {
      try {
        while (this.soundMapOutbox.length) {
          // Persist retry material before asking the main process for a durable acknowledgement.
          const saved=window.lxEnv.saveListeningTraceHot
            ? await window.lxEnv.saveListeningTraceHot({rows:this.soundMapTrace.slice(-8),outbox:this.soundMapOutbox})
            : await window.lxEnv.setRendererState("lx-sound-map-outbox", JSON.stringify(this.soundMapOutbox));
          if (!saved?.ok) throw new Error("待保存轨迹写入失败");
          const event=this.soundMapOutbox[0];
          await window.lxEnv.appendListeningTrace(JSON.parse(JSON.stringify(event)));
          this.soundMapOutbox=markSearchRaw(this.soundMapOutbox.filter(row=>row.eventId!==event.eventId));
          writeStored("lx-sound-map-outbox",JSON.stringify(this.soundMapOutbox));
        }
        this.soundMapSaveError="";
      } catch (_) {
        this.soundMapSaveError="轨迹尚未保存，稍后自动重试";
        clearTimeout(soundMapRetryTimer);
        soundMapRetryTimer=setTimeout(()=>this.drainSoundMapEvents(),15000);
      } finally { soundMapDrainPromise=null; this.soundMapTraceRevision++; }
    })();
    return soundMapDrainPromise;
  },
  recordSoundMapEvent(type, session = this.listeningSession, reason = "", observation = null) {
    if(this.featureEnabled?.('recommendation')===false)return;
    if (!session?.attemptId) return;
    const row = session.traceRow || this.soundMapTrace.find(item => item.attemptId === session.attemptId);
    if (!row) return;
    Object.assign(row, {listenedSeconds: type==="legacy_observed"?null:(Number(session.traceBaseWall)||0)+(Number(session.listenedSeconds)||0),
      creditedMediaSeconds: type==="legacy_observed"?null:(Number(session.traceBaseMedia)||0)+(Number(session.creditedMediaSeconds)||0), rejected: type==="legacy_observed"?null:!!session.dislikeHandled});
    if (type === "rejected" && reason) row.rejectionReason = reason;
    if (type === "correction_requested" && reason === "restore_previous_feeling") row.contextMismatch = true;
    const now = Date.now();
    row.eventSequence=(row.eventSequence||0)+1;
    const event = {schemaVersion:1,eventSequence:row.eventSequence,eventId:crypto.randomUUID(),type,occurredAt:now,
      traceId:row.traceId||"legacy",attemptId:row.attemptId,utcOffsetMinutes:-new Date(now).getTimezoneOffset(),
      playbackRate:session.playbackRate||null,mediaPositionSeconds:Number.isFinite(session.lastAudioTime)?session.lastAudioTime:null,track:{resourceId:row.resourceId,songKey:row.songKey,path:row.path,title:row.title,artist:row.artist,durationSeconds:row.durationSeconds||null},
      startedAt:row.at,source:row.source||"unknown",previousAttemptId:row.previousAttemptId||null,
      decisionId:row.decision?.id||null,decision:type==="play_started"?row.decision||null:null,observation,listenedSeconds:row.listenedSeconds,
      creditedMediaSeconds:row.creditedMediaSeconds,rejected:row.rejected,reason};
    this.soundMapOutbox = markSearchRaw([...this.soundMapOutbox,event]);
    writeStored("lx-sound-map-outbox", JSON.stringify(this.soundMapOutbox));
    this.persistSoundMapTrace();
    this.drainSoundMapEvents();
  },
  recordSoundMapPlayback(source = "resume") {
    if(this.featureEnabled?.('recommendation')===false)return;
    const session=this.listeningSession;
    if (!session?.attemptId) return;
    const existing=session.traceRow || this.soundMapTrace.find(row=>row.attemptId===session.attemptId);
    if(existing){session.traceRow=markSearchRaw(existing);return;}
    const last=this.soundMapTrace[this.soundMapTrace.length-1];
    const restart=["manual","collection","seed_path"].includes(source);
    const meta=this.getListeningTrackMeta(session.path)||{};
    const decision=this.soundMapDecisionSnapshot(session.recommendationDiagnosticId);
    const entry={traceArchived:true,decision,previousAttemptId:last?.attemptId||null,durationSeconds:Number(meta.duration)||null,attemptId:session.attemptId,traceId:restart||!last?crypto.randomUUID():(last.traceId||"legacy"),
      resourceId:session.resourceId||"",songKey:session.songKey||"",path:session.path,at:session.startedAt,
      title:meta.title||"",artist:meta.artist||"",source,rejected:false};
    this.soundMapTrace=markSearchRaw([...this.soundMapTrace,entry]);
    session.traceRow=markSearchRaw(entry);
    this.recordSoundMapEvent("play_started",session);
  },
  formatSoundMapRoute(id, rows, current = false) {
    let omitted=0,hidden=0;const items=[];
    for(let i=0;i<rows.length;i++) {
      const row=rows[i];
      const changedFrom=row.rejectionReason==='dislike_next' || window.FlowaveSoundMapModel?.effectiveIntent?.(rows[i+1])==='change';
      const recoveredFrom=!!row.contextMismatch || (rows[i+1]?.decision?.trigger==='like_button' && rows[i+1]?.previousAttemptId===row.attemptId);
      if(row.rejected && !changedFrom && !recoveredFrom){omitted++;hidden++;continue;}
      items.push({...row,path:this.resolveTrackReference(row,row.path)||row.path,occurrence:row.attemptId,
        contextMismatch:recoveredFrom,directionChanged:window.FlowaveSoundMapModel?.effectiveIntent?.(row)==='change',omittedBefore:omitted});omitted=0;
    }
    const changes=items.filter(row=>row.directionChanged).length,seconds=rows.reduce((sum,row)=>sum+(Number(row.listenedSeconds)||0),0);
    const prepared=current && naturalFade?.ready && naturalFade.stamp===this.naturalQueueStamp()?naturalFade.path:'';
    if(prepared)items.push({path:prepared,planned:true,occurrence:`prepared:${naturalFade.revision}`,omittedBefore:omitted});
    return {id:current?'recent':id,traceId:id,name:current?'当前轨迹':id==='legacy'?'早期播放记录':new Date(rows[0]?.at).toLocaleString(),kind:prepared?'mixed':'played',items,
      summary:id==='legacy'?`早期播放记录 · 时长与反馈未知${this.soundMapSaveError?' · '+this.soundMapSaveError:''}`:`${items.filter(x=>!x.planned).length} 首 · 已听 ${Math.floor(seconds/60)} 分钟${changes?` · 换感觉 ${changes} 次`:''} · 隐藏 ${hidden} 首${this.soundMapSaveError?' · '+this.soundMapSaveError:''}`};
  },
  async soundMapRoutes({beforeOrder=null} = {}) {
    if(this.soundMapArchiveMode==='building'||this.soundMapArchiveMode==='error') throw new Error(this.soundMapArchiveError||'轨迹正在整理，原记录保留');
    if(this.soundMapArchiveMode==='cold') {
      const result=await window.lxEnv.getListeningTraceRoutes({beforeOrder});
      if(result.syncing)throw new Error('轨迹正在追平最新记录，请稍后重试');
      const catalog=result.rows.map((row,index)=>({id:!beforeOrder&&index===0?'recent':row.trace_id,traceId:row.trace_id,
        name:!beforeOrder&&index===0?'当前轨迹':row.trace_id==='legacy'?'早期播放记录':new Date(row.startedAt).toLocaleString(),
        kind:'played',revision:row.revision,migrationId:result.migrationId,count:row.count}));
      if(beforeOrder===null) {
        const hotIds=[...new Set(this.soundMapTrace.map(row=>row.traceId||'legacy'))].reverse();
        for(const id of hotIds.reverse()) if(!catalog.some(row=>row.traceId===id)) catalog.unshift({id,traceId:id,name:'当前轨迹',kind:'played'});
        catalog.forEach((row,index)=>{row.id=index===0?'recent':row.traceId;if(index===0)row.name='当前轨迹';});
      }
      this.appendSoundMapQueue(catalog);
      return {routes:catalog,cursor:result.cursor};
    }
    const groups=new Map();
    for(const row of this.soundMapTrace) { const id=row.traceId||"legacy"; if(!groups.has(id))groups.set(id,[]); groups.get(id).push(row); }
    const entries=[...groups.entries()].reverse();
    const routes=entries.map(([id,rows],index)=>this.formatSoundMapRoute(id,rows,index===0));
    if(!routes.length)routes.push({id:"recent",name:"当前轨迹",kind:"played",items:[]});
    this.appendSoundMapQueue(routes);
    return {routes,cursor:null};
  },
  appendSoundMapQueue(routes) {
    if (!this.useRecommend && this.playMode!=="shuffle") {
      const playlist=this.playlists.find(p=>p.id===this.currentPlaylist);
      const paths=this.filteredTracks?.map(t=>t.path)||playlist?.tracks||[];
      if(paths.length)routes.push({id:"queue",name:"当前列表顺序",kind:"list",items:paths.map((path,i)=>({path,occurrence:`queue:${i}`}))});
    }
  },
  async loadSoundMapRoute(route) {
    if(route.items) return route;
    const result=await window.lxEnv.getListeningTraceRoute(route.traceId);
    if(result.syncing)throw new Error('轨迹正在追平最新记录，请重试');
    if(route.migrationId&&result.migrationId!==route.migrationId)throw new Error('轨迹读取版本变化，请刷新');
    const rows=result.rows.map(row=>({...row})),positions=new Map(rows.map((row,i)=>[row.attemptId,i]));
    for(const row of this.soundMapTrace.filter(row=>(row.traceId||'legacy')===route.traceId)) {
      const index=positions.get(row.attemptId);
      if(index===undefined)rows.push(row);else if((row.eventSequence||0)>=(rows[index].eventSequence||0))rows[index]={...rows[index],...row};
    }
    return {...this.formatSoundMapRoute(route.traceId,rows,route.id==='recent'),revision:result.revision,migrationId:result.migrationId};
  },
  async loadSoundMapAttempt(row, route) {
    if(this.soundMapArchiveMode!=='cold')return row;
    const result=await window.lxEnv.getListeningTraceAttempt(row.attemptId);
    if(route.migrationId&&result.migrationId!==route.migrationId)throw new Error('轨迹读取版本变化，请刷新');
    const hot=this.soundMapTrace.find(item=>item.attemptId===row.attemptId);
    if(hot && (!result.row || (hot.eventSequence||0)>=(result.row.eventSequence||0)))return {...row,...hot};
    if(!result.row)throw new Error('这次播放的详情尚未保存，请重试');
    return {...row,...result.row};
  },
};

const audioDetailMethods = {
  async openLyricTool(kind, event) {
    const tools = event?.currentTarget?.closest('details');
    if (tools) { tools.open = false; tools.querySelector('summary')?.focus(); }
    if (kind === "equalizer") { this.openEqualizer(); return; }
    const path = this.currentPath;
    const opening = this.openAudioDetail(path), generation = this.audioDetailGeneration;
    await opening;
    if (kind === "info" || generation !== this.audioDetailGeneration || !this.audioDetail.visible || this.audioDetail.path !== path || this.currentPath !== path || this.audioDetail.mode !== "info") return;
    if (kind === "artist") {
      const names = this.detailArtistNames();
      // Keep every credited artist selectable when there are multiple performers.
      if (names.length === 1) await this.openAudioDetailCollection("artist", names[0]);
    } else if (kind === "album") {
      if (this.audioDetail.info.album) await this.openAudioDetailCollection("album", this.audioDetail.info.album);
    } else if (kind === "similar") await this.openAudioDetailCollection("similar");
  },
  audioDetailCover() {
    const info = this.audioDetail.info || {};
    const cover = info.cover || info.cover_thumb || "";
    return this.isOnlineToken(this.audioDetail.path) ? this.onlineCoverUrl(cover) : this.pathToFile(cover);
  },
  detailComparable(value) { return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase(); },
  detailArtistNames(info = this.audioDetail.info) {
    const names = Array.isArray(info?.artists) && info.artists.length ? info.artists : [info?.artist];
    return [...new Set(names.map(s => String(s || "").trim()).filter(s => s && !["未知艺术家", "未知歌手"].includes(s)))];
  },
  async openAudioDetail(path = this.currentPath) {
    if (!path || typeof path !== "string") return;
    audioDetailReturnFocus = document.activeElement;
    this.cancelAudioDetailRequest();
    const generation = ++this.audioDetailGeneration;
    const known = this.trackByPath?.get(path) || this.onlineTrackMap?.[path] || {};
    const current = path === this.currentPath ? this.currentMeta : {};
    this.audioDetail = { visible:true, mode:"info", path, info:{...known,...current}, loading:true,
      error:"", label:"", rows:[], page:1, scanned:0, total:0, failures:0 };
    this.$nextTick(() => this.$refs?.audioDetailClose?.focus?.());
    try {
      let info;
      if (this.isOnlineToken(path)) info = {...known,...current};
      else if (window.lxEnv?.getSongInfo) info = await window.lxEnv.getSongInfo(path, {
        resourceId:this.makeTrackReference(path).resourceId, includeLyrics:false, includeAudioDetails:true,
      });
      else throw new Error("当前环境无法读取本地音频信息。");
      if (generation !== this.audioDetailGeneration || !this.audioDetail.visible) return;
      this.audioDetail.info = {...known,...current,...info};
      if (info?.metadataError) this.audioDetail.error = "音频信息读取失败，可稍后重新打开详情重试。";
    } catch (_) {
      if (generation === this.audioDetailGeneration) this.audioDetail.error = "音频信息暂时无法读取，请检查文件是否可用。";
    } finally {
      if (generation === this.audioDetailGeneration) this.audioDetail.loading = false;
    }
  },
  cancelAudioDetailRequest() {
    this.audioDetailController?.abort(); this.audioDetailController = null;
  },
  closeAudioDetail() {
    ++this.audioDetailGeneration; this.cancelAudioDetailRequest(); this.audioDetail.visible = false;
    this.$nextTick(() => audioDetailReturnFocus?.isConnected !== false && audioDetailReturnFocus?.focus?.());
  },
  backToAudioDetail() {
    ++this.audioDetailGeneration; this.cancelAudioDetailRequest();
    Object.assign(this.audioDetail,{mode:"info",loading:false,error:"",rows:[],page:1});
    this.$nextTick(() => this.$refs?.audioDetailClose?.focus?.());
  },
  audioDetailFields() {
    const info = this.audioDetail.info || {}, audioInfo = info.audioInfo || {};
    const n = value => Number.isFinite(Number(value)) && Number(value)>0 ? Number(value) : null;
    return [
      ["采样率", n(audioInfo.sampleRate) ? `${Number(audioInfo.sampleRate).toLocaleString()} Hz` : "未提供"],
      ["比特率", n(audioInfo.bitrate) ? `${Math.round(audioInfo.bitrate/1000)} kbps` : "未提供"],
      ["位深", n(audioInfo.bitsPerSample) ? `${audioInfo.bitsPerSample} bit` : "未提供"],
      ["声道", n(audioInfo.channels) ? audioInfo.channels===2 ? "双声道" : audioInfo.channels===1 ? "单声道" : `${audioInfo.channels} 声道` : "未提供"],
      ["编码", audioInfo.codec || "未提供"], ["封装格式", audioInfo.container || "未提供"],
      ["压缩类型", audioInfo.lossless===true ? "无损" : audioInfo.lossless===false ? "有损" : "未提供"],
      ["文件大小", n(audioInfo.size) ? `${(audioInfo.size/1048576).toFixed(2)} MB` : "未提供"],
      ["时长", n(audioInfo.duration || info.duration) ? this.formatTime(audioInfo.duration || info.duration) : "未提供"],
    ];
  },
  async openAudioDetailCollection(kind, value = "") {
    if(kind==='similar' && this.featureEnabled?.('recommendation')===false){this.openSettingsSection('features');return;}
    if (!this.audioDetail.visible) return;
    this.cancelAudioDetailRequest();
    const generation = ++this.audioDetailGeneration, library = this.tracks;
    const detail = this.audioDetail, anchor = detail.path, info = detail.info;
    Object.assign(detail,{ mode:kind,label:kind==="similar" ? "相似歌曲" : value, rows:[], page:1,
      error:"",loading:true,scanned:0,total:0,failures:0,similarityModel:"",similarityMissing:0,similarityFallback:"" });
    const current = () => generation===this.audioDetailGeneration && this.audioDetail.visible && this.tracks===library;
    try {
      let rows;
      if (kind === "similar") {
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        this.audioDetailController = controller;
        const query=anchor;
        const deadline=Date.now()+30000;
        const pause=()=>new Promise(resolve=>{
          const done=()=>{clearTimeout(timer);controller?.signal.removeEventListener('abort',done);resolve();};
          const timer=setTimeout(done,500);controller?.signal.addEventListener('abort',done,{once:true});
          if(controller?.signal.aborted)done();
        });
        let data;
        do {
          try {
            ({data}=await axios.post(`${this.baseUrl}/recommend`, { track_path:query,history:[],
              history_fallback:"strict",scope:this.recommendFullMode?"all":"local",ranking_only:true,return_all_ranked:true },
              {signal:controller?.signal,timeout:Math.max(1,Math.min(10000,deadline-Date.now()))}));
          } catch(error) {
            if(current()&&error?.response?.status===409&&Date.now()<deadline){await pause();continue;}
            throw error;
          }
          if(!current())return;
          if(data?.status!=='building')break;
          if(Date.now()>=deadline)throw new Error('歌曲关联数据仍在准备，请稍后重试。');
          await pause();
        } while(current());
        if (!current()) return;
        if (data?.missing) throw new Error(this.isOnlineToken(query)&&!this.recommendFullMode
          ? '当前只查询本地曲库；在线歌曲需启用完整推荐范围。' : '这首歌尚无推荐索引，暂时无法计算相似歌曲。');
        if(data?.ranking_policy!=='mert-nearest-v1')throw new Error('相似歌曲服务仍是旧版本，请重启软件及后台。');
        const expected=this.makeTrackReference(query).resourceId;
        if(!this.isOnlineToken(query)&&expected&&data.query_resource_id!==expected)
          throw new Error('查询歌曲身份发生变化，请重新打开详情。');
        detail.similarityModel=data.model;detail.similarityMissing=data.analysis_missing||0;
        detail.similarityFallback=data.fallback_reason||"";
        rows = (data?.all_ranked || []).filter(r=>r?.path && r.path!==anchor).map(r=>({
          ...(this.trackByPath.get(r.path) || this.onlineTrackMap?.[r.path] || {}), path:r.path, sim:r.sim,
        }));
      } else {
        // User-requested tag hydration, chunked and cancellable; never read lyrics.
        const targets = library.filter(t=>!this.isOnlineToken(t.path) && (!t._metaLoaded || !Array.isArray(t.artists) || t.albumArtist===undefined));
        detail.total = targets.length;
        const patches = [];
        for (let start=0;start<targets.length;start+=METADATA_FILL_CONCURRENCY) {
          if (!current()) return;
          await Promise.all(targets.slice(start,start+METADATA_FILL_CONCURRENCY).map(async t=>{
            try {
              if (!window.lxEnv?.getSongInfo) throw new Error("unavailable");
              const data = await window.lxEnv.getSongInfo(t.path,{resourceId:t.resourceId||"",includeLyrics:false});
              if (data?.metadataError || !data) throw new Error("unreadable");
              patches.push([t,{title:data.title||t.title,name:data.title||t.title,artist:data.artist||"",artists:Array.isArray(data.artists)?data.artists:[],
                album:data.album||"",albumArtist:data.albumArtist||"",trackNumber:Number(data.trackNumber)||0,
                discNumber:Number(data.discNumber)||0,_metaLoaded:true}]);
            } catch (_) { if (current()) detail.failures++; }
          }));
          if (!current()) return;
          detail.scanned = Math.min(targets.length,start+METADATA_FILL_CONCURRENCY);
          await this.$nextTick();
        }
        if (!current()) return;
        let searchChanged=false;
        for (const [track,patch] of patches) if (this.trackByPath.get(track.path)===track) {
          const changed=["title","name","artist","album"].some(key=>track[key]!==patch[key]);
          Object.assign(track,patch);
          if(changed){track._searchDoc=null;track._searchText=this.prepareTrackForList(track,{buildDoc:false})._searchText;searchChanged=true;}
        }
        if (patches.length) {
          this._localMetadataRevision = Number(this._localMetadataRevision||0)+1;
          if(searchChanged)this.queueSearchIndexRebuild(); this.queueUiSnapshotSave();
        }
        const all = [...library,...Object.values(this.onlineTrackMap || {})];
        const match = this.detailComparable(value);
        const albumArtist = this.detailComparable(info.albumArtist || info.artist);
        rows = all.filter(t=>kind==="artist"
          ? this.detailArtistNames(t).some(name=>this.detailComparable(name)===match)
          : this.detailComparable(t.album)===match && this.detailComparable(t.albumArtist || t.artist)===albumArtist);
        if (kind==="album") rows = [...rows].sort((a,b)=>(Number(a.discNumber)||1)-(Number(b.discNumber)||1)
          || (Number(a.trackNumber)||99999)-(Number(b.trackNumber)||99999));
      }
      if (!current()) return;
      const seen = new Set();
      detail.rows = markSearchRaw(rows.filter(t=>{
        const path = t.path || t.token; if(!path)return false;
        const key = this.detailTrackKey(path); if(seen.has(key))return false;seen.add(key);return true;
      }).map(t=>({...t,path:t.path||t.token})));
    } catch (error) {
      if (current() && error?.code!=="ERR_CANCELED" && error?.name!=="AbortError") detail.error = kind==="similar"
        ? this.getOperationUserMessage(error,"相似歌曲暂时无法载入，请重试。") : "歌曲信息暂时无法载入，请重试。";
    } finally {
      if (generation===this.audioDetailGeneration) {
        detail.loading=false;this.audioDetailController=null;
        if(this.tracks!==library)detail.error="音乐库已变化，请重新打开详情。";
      }
    }
  },
  audioDetailPageRows() { const start=(this.audioDetail.page-1)*60;return this.audioDetail.rows.slice(start,start+60); },
  audioDetailPageCount() { return Math.max(1,Math.ceil(this.audioDetail.rows.length/60)); },
  changeAudioDetailPage(delta) { this.audioDetail.page=Math.max(1,Math.min(this.audioDetailPageCount(),this.audioDetail.page+delta)); },
  detailTrackKey(path) {
    const ref = this.makeTrackReference(path);
    return ref.resourceId ? `resource:${ref.resourceId}` : this.isOnlineToken(path) ? path : this.normalizeComparablePath(path);
  },
  installDetailQueue(paths, name) {
    this.libraryBrowseMode = "songs";
    this.cancelNaturalCrossfade();
    const seen=new Set(), tracks=[];
    for(const path of paths) { const key=this.detailTrackKey(path);if(!seen.has(key)){seen.add(key);tracks.push(path);} }
    const queue={id:"session-current",type:"session",name:String(name||"正在播放").slice(0,100),tracks,
      trackRefs:tracks.map(p=>this.makeTrackReference(p))};
    this.sessionQueue=queue;
    this.playlists=[...this.playlists.filter(p=>p.type!=="session"),queue];
    writeStored("lx-session-queue",JSON.stringify(queue));
    this.currentPlaylist=queue.id;this.useRecommend=false;this.playMode="loop";
    this.searchInputResetRevision++;this.keywordDraft="";this.keyword="";this._librarySearchComposing=false;
    this.queueUiSnapshotSave();
  },
  async playAudioDetailCollection(path) {
    const detail=this.audioDetail;
    if(detail.loading || !detail.rows.some(t=>t.path===path))return;
    this.installDetailQueue(detail.rows.map(t=>t.path),`${detail.label} · ${detail.info.title||this.extractName(detail.path)}`);
    await this.$nextTick();
    return this.playByPath(path,true,"collection");
  },
  appendSimilarTopTen() {
    const detail=this.audioDetail;
    if(detail.mode!=="similar" || detail.loading)return;
    const currentKey=this.currentPath ? this.detailTrackKey(this.currentPath) : "";
    const additions=detail.rows.filter(t=>this.detailTrackKey(t.path)!==currentKey).slice(0,10).map(t=>t.path);
    if(!additions.length){this.showNotice("没有可加入的相似歌曲。");return;}
    const incoming=new Set(additions.map(p=>this.detailTrackKey(p)));
    let base=this.getPlaybackQueueTracks().map(t=>t.path);
    if(this.currentPath && !base.some(p=>this.detailTrackKey(p)===currentKey))base.unshift(this.currentPath);
    base=base.filter(p=>!incoming.has(this.detailTrackKey(p)));
    const at=this.currentPath ? base.findIndex(p=>this.detailTrackKey(p)===currentKey)+1 : 0;
    const previousName=this.libraryPageTitle||this.playlists.find(p=>p.id===this.currentPlaylist)?.name||"当前列表";
    this.installDetailQueue([...base.slice(0,at),...additions,...base.slice(at)],`正在播放 · ${previousName.replace(/^正在播放 · /,"")}`);
    this.showNotice(`已将 ${additions.length} 首加入接下来播放，按列表顺序继续。`);
  },
};

const seedMethods = {
  ensureSeedsLoaded() {
    if(this.featureEnabled?.('recommendation')===false)return Promise.resolve();
    if (this.seedsLoaded) return Promise.resolve(true);
    if (this.seedPreloadPromise) return this.seedPreloadPromise;
    this.seedPreloadPromise = this.loadSeeds().finally(() => { this.seedPreloadPromise = null; });
    return this.seedPreloadPromise;
  },
  playSeedDirection(path) {
    if (!path) return;
    // Direction tracks need not occur in the recommendation results.
    return this.playByPath(path, true, 'manual');
  },
  seedTrackInfo(path) {
    const track = this.trackByPath?.get(path) || this.onlineTrackMap?.[path] || {};
    return {title:track.title || track.name || this.extractName(path), artist:track.artist || ""};
  },
  seedTrackCover(path) {
    if (!path) return "";
    const track = this.trackByPath?.get(path) || this.onlineTrackMap?.[path];
    const cover = track?.cover_thumb || track?.cover || "";
    return this.isOnlineToken(path) ? this.onlineCoverUrl(cover) : this.pathToFile(cover);
  },
  async loadSeeds({ loadCurrent = true } = {}) {
    const generation = ++this.seedLoadGeneration;
    const { data } = await axios.get(`${this.baseUrl}/seeds`);
    if (generation !== this.seedLoadGeneration) return false;
    this.seeds = data.seeds || [];
    // 自动为已有推荐结果的种子生成歌单
    (this.seeds || []).forEach((s) => this.updateSeedPlaylist(s));
    if (!this.seeds.some((seed) => seed.id === this.currentSeedId)) {
      this.currentSeedId = "";
    }
    if (!this.currentSeedId && this.seeds.length) {
      this.currentSeedId = this.seeds[0].id;
    }
    if (loadCurrent && this.currentSeedId) {
      // 重新拉取当前种子详情，保持正/负列表与推荐同步
      await this.loadSeedDetail(this.currentSeedId, { listGeneration: generation });
    } else if (!this.currentSeedId) {
      this.seedRecs = [];
      this.seedPos = [];
      this.seedNeg = [];
    }
    this.seedsLoaded = true;
    return true;
  },
  async loadSeedDetail(id, { listGeneration = null } = {}) {
    if (!id) return false;
    const generation = ++this.seedDetailGeneration;
    const { data } = await axios.get(`${this.baseUrl}/seeds/${id}`);
    const seed = data.seed;
    if (
      generation !== this.seedDetailGeneration
      || id !== this.currentSeedId
      || (listGeneration !== null && listGeneration !== this.seedLoadGeneration)
    ) return false;
    this.currentSeedId = seed.id;
    this.seedRecs = this.sortSeedRecs(seed.rec_cache);
    this.seedPos = [...(seed.seed_track_paths || seed.pos_track_paths || [])];
    this.seedNeg = [...(seed.neg_track_paths || [])];
    this.updateSeedPlaylist(seed);
    // 更新 seeds 列表里对应项
    const idx = this.seeds.findIndex((s) => s.id === seed.id);
    if (idx >= 0) this.seeds.splice(idx, 1, seed);
    this.seedLoading = false;
    return true;
  },
  async promptNewSeed() {
    this.seedEditId = "";
    this.seedEditName = "";
    this.seedEditK = 50;
    this.seedEditModalVisible = true;
  },
  async renameSeed(seed) {
    if (!seed?.id) return;
    this.seedEditId = seed.id;
    this.seedEditName = seed.name;
    this.seedEditK = seed.k || 50;
    this.seedEditModalVisible = true;
  },
  async selectSeed(id) {
    if (!id) {
      ++this.seedDetailGeneration;
      this.currentSeedId = "";
      this.seedRecs = [];
      this.seedPos = [];
      this.seedNeg = [];
      this.seedLoading = false;
      return;
    }
    this.currentSeedId = id;
    this.seedRecs = []; this.seedPos = []; this.seedNeg = [];
    this.seedLoading = true;
    try {
      await this.loadSeedDetail(id);
    } catch (_) {
      if (this.currentSeedId === id) this.showNotice("组合加载失败", "error");
    } finally {
      if (this.currentSeedId === id) this.seedLoading = false;
    }
  },
  async promptSetK() {
    if (!this.currentSeed) return;
    this.seedEditId = this.currentSeed.id;
    this.seedEditName = this.currentSeed.name;
    this.seedEditK = this.currentSeed.k || 50;
    this.seedEditModalVisible = true;
  },
  async refreshCurrentSeed() {
    if (!this.currentSeedId) return;
    const seedId = this.currentSeedId;
    const generation = ++this.seedDetailGeneration;
    this.seedLoading = true;
    try {
      const k = this.currentSeed?.k || 50;
      const { data } = await axios.post(`${this.baseUrl}/seeds/${seedId}/refresh`, { k });
      if (generation !== this.seedDetailGeneration || seedId !== this.currentSeedId) return;
      this.seedRecs = this.sortSeedRecs(data.seed.rec_cache);
      // 更新当前种子正/负列表
      this.seedPos = [...(data.seed.seed_track_paths || data.seed.pos_track_paths || this.seedPos)];
      this.seedNeg = [...(data.seed.neg_track_paths || this.seedNeg)];
      const seedIndex = this.seeds.findIndex((seed) => seed.id === seedId);
      if (seedIndex >= 0) this.seeds.splice(seedIndex, 1, data.seed);
      this.updateSeedPlaylist(data.seed);
    } catch (error) {
      if (generation === this.seedDetailGeneration && seedId === this.currentSeedId) {
        this.showNotice(this.getOperationUserMessage(error, "推荐更新失败"), "error");
      }
    } finally {
      if (generation === this.seedDetailGeneration && seedId === this.currentSeedId) {
        this.seedLoading = false;
      }
    }
  },
  async playSeedTrack(path) {
    if (!path) return;
    return this.playSeedList(path);
  },
  playSeedList(startPath = "") {
    if (!this.seedRecs.length) return;
    if (this.seedRecs.some(r => r.admission_version !== 2 || r.verification_version !== 1)) {
      this.showNotice("请先刷新推荐，旧结果尚未经过听感复核。");
      return;
    }
    const chosen = this.seedRecs.find(r => r.path === startPath) || this.seedRecs[0];
    const group = this.seedRecs.filter(r => r.segment === chosen.segment);
    this.useRecommend = false; // 关闭推荐模式
    this.playMode = "loop"; // Explicitly preserve the planned path; shuffle remains a user choice afterwards.
    const list = group.map((r) => r.path);
    const pid = `seed-rec-${this.currentSeedId}`;
    const pname = this.currentSeed?.name || "复合种子推荐";
    const seedPl = { id: pid, name: pname, tracks: list, type: "seed", seedPolicy: 2, seedVerification: 1,
      seedSegment: chosen.segment, seedWrapSafe: chosen.wrap_safe };
    this.cancelNaturalCrossfade();
    // 保留现有歌单，追加/更新一个以种子命名的歌单
    const others = this.playlists.filter((p) => p.id !== pid);
    this.playlists = [...others, seedPl];
    // 保存排序（将新增歌单放在非系统列表末尾）
    const orderMap = this.loadPlaylistOrder();
    const maxOrder = Math.max(0, ...Object.values(orderMap).map((v) => Number(v) || 0));
    orderMap[pid] = maxOrder + 1;
    this.savePlaylistOrder(orderMap);
    this.currentPlaylist = pid;
    this.searchInputResetRevision += 1;
    this._librarySearchComposing = false;
    this.keywordDraft = "";
    this.keyword = "";
    this.selectedPath = list.includes(startPath) ? startPath : list[0];
    return this.playByPath(this.selectedPath, true, "seed_path");
  },
  async deleteCurrentSeed() {
    if (!this.currentSeedId) return;
    const seedId = this.currentSeedId;
    const confirmed = await this.requestConfirmation({
      title: "删除复合种子",
      message: "该复合种子及其推荐结果将被删除。",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) return;
    await axios.delete(`${this.baseUrl}/seeds/${seedId}`);
    if (this.currentSeedId === seedId) {
      ++this.seedDetailGeneration;
      this.currentSeedId = "";
      this.seedRecs = [];
      this.seedPos = [];
      this.seedNeg = [];
      await this.loadSeeds();
    } else {
      await this.loadSeeds({ loadCurrent: false });
    }
  },
  updateSeedPlaylist(seed) {
    if (!seed || !seed.id) return;
    const pid = `seed-rec-${seed.id}`;
    const sortedRecs = this.sortSeedRecs(seed.rec_cache);
    const existing = this.playlists.findIndex((p) => p.id === pid);
    const previous = existing >= 0 ? this.playlists[existing] : null;
    // Preserve the current song's new group after a refresh; group numbers can change.
    const chosen = sortedRecs.find(r => r.path === this.currentPath && this.currentPlaylist === pid) || sortedRecs[0];
    const group = chosen?.sequence_version === 2 ? sortedRecs.filter(r => r.segment === chosen.segment) : sortedRecs;
    const list = group.map((r) => r.path);
    const policy = chosen?.admission_version === 2 || seed.rec_diagnostics?.policy_version === 2
      ? { seedPolicy: 2, seedSegment: chosen?.segment ?? null, seedWrapSafe: chosen?.wrap_safe ?? false,
          seedVerification: chosen?.verification_version || seed.rec_diagnostics?.verification_version || 0 }
      : { seedPolicy: 0, seedSegment: null, seedWrapSafe: false, seedVerification: 0 };
    const name = seed.name || "复合种子推荐";
    // 仅在有推荐结果时才生成
    if (!list.length && !previous) return;
    if (this.currentPlaylist === pid) this.cancelNaturalCrossfade();
    if (existing >= 0) {
      const nextPl = { ...this.playlists[existing], name, tracks: list, type: "seed", ...policy };
      this.playlists.splice(existing, 1, nextPl);
      this.savePlaylistOrder(this.computeOrderMap(this.playlists));
    } else {
      const orderMap = this.loadPlaylistOrder();
      const maxOrder = Math.max(0, ...Object.values(orderMap).map((v) => Number(v) || 0));
      orderMap[pid] = maxOrder + 1;
      this.savePlaylistOrder(orderMap);
      this.playlists.push({ id: pid, name, tracks: list, type: "seed", ...policy });
    }
    if (this.currentPlaylist === pid) {
      // 触发视图更新并确保选中项在新列表内
      this.currentPlaylist = pid;
      if (list.length) this.selectedPath = list[0];
    }
  },
  sortSeedRecs(recs) {
    if (!recs) return [];
    if (recs.length && recs.every(r => [1, 2].includes(r?.sequence_version) && Number.isInteger(r.sequence_order))
      && new Set(recs.map(r => r.sequence_order)).size === recs.length) {
      return [...recs].sort((a, b) => a.sequence_order - b.sequence_order);
    }
    return [...recs].sort((a, b) => (b?.sim || 0) - (a?.sim || 0));
  },
  formatSeedMatch(value) {
    return Number.isFinite(Number(value)) ? Number(value).toFixed(3) : '—';
  },
  async openSeedMenu(path) {
    try {
      await this.loadSeeds();
    } catch (_) {
      this.showNotice("复合种子加载失败", "error");
      return;
    }
    this.seedModalTrack = path;
    this.seedModalExistingId = this.seeds[0]?.id || "";
    this.seedModalNewName = "";
    this.seedModalK = 50;
    this.seedModalTarget = "pos";
    this.seedModalVisible = true;
  },
  async removeTrackFromSeed(path) {
    if (!this.currentSeedId) return;
    const seedId = this.currentSeedId;
    const target = this.seedNeg.includes(path) ? "neg" : "pos";
    await axios.post(`${this.baseUrl}/seeds/${seedId}/tracks`, { action: "remove", tracks: [path], target });
    if (seedId !== this.currentSeedId) return;
    await this.refreshCurrentSeed();
  },
  async confirmSeedEdit() {
    if (!this.seedEditName.trim()) {
      this.showNotice("请输入名称。", "error");
      return;
    }
    const payload = { name: this.seedEditName.trim(), k: Number(this.seedEditK) || 50 };
    if (this.seedEditId) payload.id = this.seedEditId;
    const { data } = await axios.post(`${this.baseUrl}/seeds`, payload);
    this.seeds = data.seeds || this.seeds;
    this.seedEditModalVisible = false;
    await this.loadSeeds();
  },
  cancelSeedEdit() {
    this.seedEditModalVisible = false;
  },
  async confirmSeedModal() {
    if (!this.seedModalTrack) {
      this.seedModalVisible = false;
      return;
    }
    let targetId = this.seedModalExistingId;
    // 创建新种子
    if (this.seedModalNewName.trim()) {
      const k = Number(this.seedModalK) || 50;
      const { data } = await axios.post(`${this.baseUrl}/seeds`, { name: this.seedModalNewName.trim(), k });
      const created = (data.seeds || []).find((s) => s.name === this.seedModalNewName.trim());
      if (created) targetId = created.id;
      this.seeds = data.seeds || this.seeds;
    }
    if (!targetId && this.seeds.length) targetId = this.seeds[0].id;
    if (!targetId) {
      this.showNotice("请先创建复合种子。", "error");
      return;
    }
    await axios.post(`${this.baseUrl}/seeds/${targetId}/tracks`, { action: "add", tracks: [this.seedModalTrack], target: this.seedModalTarget || "pos" });
    this.seedModalVisible = false;
    await this.loadSeeds({ loadCurrent: false });
    this.currentSeedId = targetId;
    await this.refreshCurrentSeed();
  },
  cancelSeedModal() {
    this.seedModalVisible = false;
  },
};

const shortcutMethods = {
  shortcutScopeLabel(scope) {
    return scope === "global" ? "全局" : "应用内";
  },
  shortcutStatusTone(item) {
    if (!String(item?.accelerator || "").trim()) return "muted";
    return item?.status?.ok ? "ok" : "bad";
  },
  shortcutStatusLabel(item) {
    if (!String(item?.accelerator || "").trim()) return "已禁用";
    if (item?.status?.ok) return "正常";
    const reason = String(item?.status?.reason || "");
    if (reason === "invalid-accelerator") return "格式错误";
    if (reason === "register-failed") return "冲突";
    return "失败";
  },
  getMediaHotkeyStatusText() {
    if (!Array.isArray(this.shortcutMediaStatus) || !this.shortcutMediaStatus.length) return "等待检测";
    if (this.shortcutMediaStatus.every(it=>it?.status?.reason==='system-session')) return "系统媒体会话";
    if (this.shortcutMediaStatus.some(it=>it?.status?.reason==='session-pending')) return "等待系统媒体会话";
    return this.shortcutMediaStatus.every((it) => it?.status?.ok) ? "备用按键已注册" : "备用按键冲突";
  },
  formatMediaDiagType(type) {
    const labels = {
      renderer_hotkey_received: "快捷键输入",
      renderer_action_dispatched: "控制指令",
      renderer_action_result: "执行结果",
      mediaSession_action: "系统媒体键",
      media_input_accepted: "媒体操作已接收",
      headphone_wear: "耳机佩戴",
      audio_focus_event: "音频焦点",
      audio_play: "开始播放",
      audio_pause: "暂停播放",
      timeupdate_progress_stalled: "播放进度停滞",
    };
    return labels[String(type || "")] || "媒体事件";
  },
  formatMediaDiagDetail(event) {
    if (event?.type === 'headphone_wear') {
      if (event.status === 'reported') return event.worn === false ? '已摘下' : event.worn === true ? '已佩戴' : '状态未知';
      return ({'awaiting-event':'等待佩戴上报','detection-enabled':'耳机检测已开启','detection-disabled':'耳机检测已关闭',
        unavailable:'佩戴通道不可用','listener-failed':'佩戴监听失败',unsupported:'当前输出无佩戴状态'})[event.status] || '状态未知';
    }
    const actionLabels = {
      play: "播放",
      pause: "暂停",
      stop: "停止",
      prev: "上一首",
      previoustrack: "换个方向",
      next: "下一首",
      nexttrack: "找回感觉",
      next_like: "找回感觉",
      dislike_next: "换个感觉",
      like_next: "相似下一首",
      favorite: "收藏",
    };
    const action = actionLabels[String(event?.action || "").toLowerCase()] || "";
    if (event?.ok === false) return action ? `${action}未执行` : "未执行";
    if (action) return action;
    const kind = String(event?.kind || "").toLowerCase();
    if (kind === "interrupt-start") return "检测到音频占用";
    if (kind === "interrupt-end") return "音频占用已结束";
    return "";
  },
  appendMediaDiagEvent(type, payload = {}) {
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ts: Date.now(),
      type: String(type || "unknown"),
      ...payload,
    };
    this.mediaDiagEvents.push(item);
    if (this.mediaDiagEvents.length > 200) {
      this.mediaDiagEvents.splice(0, this.mediaDiagEvents.length - 200);
    }
  },
  formatMediaDiagTs(ts) {
    const d = new Date(Number(ts) || Date.now());
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  },
  async refreshMediaDiag() {
    if (!window.lxEnv || typeof window.lxEnv.getMediaDiag !== "function") return;
    try {
      const data = await window.lxEnv.getMediaDiag();
      const events = Array.isArray(data?.events) ? data.events : [];
      this.mediaDiagEvents = events.slice(-200);
      if (Array.isArray(data?.shortcuts?.media)) {
        this.shortcutMediaStatus = data.shortcuts.media;
      }
      this.audioFocusWatcherAvailable = !!data?.audioFocusWatcherAvailable;
    } catch {
      // ignore diag fetch failure
    }
  },
  async loadShortcutSettings() {
    if (!window.lxEnv || typeof window.lxEnv.getShortcuts !== "function") return;
    try {
      const data = await window.lxEnv.getShortcuts();
      this.shortcutItems = (data?.items || []).map((it) => ({
        action: it.action,
        label: it.label,
        scope: it.scope,
        accelerator: it.accelerator || "",
        status: it.status || { ok: true },
      }));
      this.shortcutMediaStatus = Array.isArray(data?.media) ? data.media : [];
      await this.refreshMediaDiag();
    } catch (e) {
      this.shortcutMessage = "快捷键配置读取失败";
    }
  },
  async saveShortcutSettings() {
    if (!window.lxEnv || typeof window.lxEnv.setShortcuts !== "function") return;
    const saveGeneration = Number(this._shortcutSaveGeneration || 0) + 1;
    this._shortcutSaveGeneration = saveGeneration;
    this.shortcutSaving = true;
    this.shortcutMessage = "";
    try {
      const partial = {};
      this.shortcutItems.forEach((it) => {
        partial[it.action] = { accelerator: String(it.accelerator || "").trim() };
      });
      const data = await window.lxEnv.setShortcuts(partial);
      if (saveGeneration !== this._shortcutSaveGeneration) return;
      this.shortcutItems = (data?.items || []).map((it) => ({
        action: it.action,
        label: it.label,
        scope: it.scope,
        accelerator: it.accelerator || "",
        status: it.status || { ok: true },
      }));
      this.shortcutMediaStatus = Array.isArray(data?.media) ? data.media : [];
      await this.refreshMediaDiag();
      const failed = this.shortcutItems.filter((it) => !it.status?.ok);
      this.shortcutMessage = failed.length
        ? `已保存，${failed.length} 个快捷键未生效。`
        : "快捷键已保存";
    } catch (e) {
      if (saveGeneration !== this._shortcutSaveGeneration) return;
      this.shortcutMessage = "保存失败";
    } finally {
      if (saveGeneration === this._shortcutSaveGeneration) this.shortcutSaving = false;
    }
  },
  scheduleShortcutAutoSave(delay = 500) {
    if (this._shortcutHydrating) return;
    if (this._shortcutAutoSaveTimer) clearTimeout(this._shortcutAutoSaveTimer);
    this.shortcutMessage = "";
    this._shortcutAutoSaveTimer = setTimeout(() => {
      this._shortcutAutoSaveTimer = null;
      this.saveShortcutSettings();
    }, Math.max(150, Number(delay) || 500));
  },
  async resetShortcutSettings() {
    if (!window.lxEnv || typeof window.lxEnv.resetShortcuts !== "function") return;
    this.shortcutSaving = true;
    this.shortcutMessage = "";
    try {
      const data = await window.lxEnv.resetShortcuts();
      this.shortcutItems = (data?.items || []).map((it) => ({
        action: it.action,
        label: it.label,
        scope: it.scope,
        accelerator: it.accelerator || "",
        status: it.status || { ok: true },
      }));
      this.shortcutMediaStatus = Array.isArray(data?.media) ? data.media : [];
      await this.refreshMediaDiag();
      this.shortcutMessage = "已恢复默认";
    } catch (e) {
      this.shortcutMessage = "恢复默认失败";
    } finally {
      this.shortcutSaving = false;
    }
  },
};

const dataMethods = {
  handleGlobalEscape(event) {
    if (String(event?.key || "") !== "Escape") return false;
    let handled = !!(
      this.onlineContextMenu?.show
      || this.playlistContextMenu?.show
      || this.trackContextMenu?.show
    );
    this.closeOnlineContextMenu();
    this.closePlaylistContextMenu();
    this.closeTrackContextMenu();
    if (this.audioDetail.visible) {
      if (this.audioDetail.mode!=="info") this.backToAudioDetail(); else this.closeAudioDetail();
      handled = true;
    } else if (this.equalizerOpen) {
      this.closeEqualizer();
      handled = true;
    } else if (this.confirmDialog.visible) {
      this.resolveConfirmation(false);
      handled = true;
    } else if (this.playlistEditModalVisible) {
      this.cancelPlaylistEdit();
      handled = true;
    } else if (this.playlistAddModalVisible) {
      this.cancelAddToPlaylist();
      handled = true;
    } else if (this.onlineDownloadModalVisible && !this.onlineDownloading) {
      this.onlineDownloadModalVisible = false;
      handled = true;
    } else if (this.songInfoDialog.visible) {
      this.closeSongInfoDialog();
      handled = true;
    } else if (this.seedModalVisible) {
      this.cancelSeedModal();
      handled = true;
    } else if (this.seedEditModalVisible) {
      this.cancelSeedEdit();
      handled = true;
    } else if (this.showLyric) {
      this.closeLyricPanel();
      handled = true;
    }
    if (handled && typeof event?.preventDefault === "function") event.preventDefault();
    return handled;
  },
  resolveStartupSplashImage(useDefault = false) {
    if (!useDefault && this.startupBackground?.custom && this.startupBackground.url) return this.startupBackground.url;
    try {
      return new URL(STARTUP_SPLASH_IMAGE, window.location.href).href;
    } catch {
      return STARTUP_SPLASH_IMAGE;
    }
  },
  startupBackgroundCss() {
    const fallback = this.resolveStartupSplashImage(true);
    return [...new Set([this.resolveStartupSplashImage(), fallback])].filter(Boolean).map(url => `url(${JSON.stringify(url)})`).join(', ') || 'none';
  },
  async changeStartupBackground(reset = false) {
    if (this.startupBackgroundSaving) return;
    this.startupBackgroundSaving = true;
    this.startupBackgroundMessage = '';
    try {
      if (!window.lxEnv?.setStartupBackground) throw new Error('当前环境无法选择本地图片。');
      const result = await window.lxEnv.setStartupBackground(reset === true);
      if (!result?.ok) throw new Error(result?.message || '启动背景保存失败。');
      if (result.canceled) return;
      this.startupBackground = result.background;
      this.startupSplashBackgroundStyle = this.startupBackgroundCss();
      this.startupBackgroundMessage = reset ? '已恢复默认背景。' : '已保存，下次启动时使用。';
    } catch (error) { this.startupBackgroundMessage = error.message || '启动背景保存失败，原背景已保留。'; }
    finally { this.startupBackgroundSaving = false; }
  },
  startupBackgroundPreviewError(event) {
    const fallback = this.resolveStartupSplashImage(true);
    if (event.target.src !== fallback) event.target.src = fallback;
  },
  scheduleStartupSplashMaxHide() {
    if (this._startupSplashMaxTimer) {
      clearTimeout(this._startupSplashMaxTimer);
      this._startupSplashMaxTimer = null;
    }
    this._startupSplashMaxTimer = setTimeout(() => {
      this.hideStartupSplash();
    }, STARTUP_SPLASH_MAX_MS);
  },
  onStartupReady() {
    if (!this.startupSplashVisible || this.startupSplashHiding) return;
    const elapsed = Date.now() - Number(this._startupSplashStartedAt || 0);
    const remain = Math.max(0, STARTUP_SPLASH_MIN_MS - elapsed);
    if (this._startupSplashDoneTimer) {
      clearTimeout(this._startupSplashDoneTimer);
      this._startupSplashDoneTimer = null;
    }
    this._startupSplashDoneTimer = setTimeout(() => {
      this.hideStartupSplash();
    }, remain);
  },
  hideStartupSplash() {
    if (!this.startupSplashVisible || this.startupSplashHiding) return;
    this.startupSplashHiding = true;
    if (this._startupSplashMaxTimer) {
      clearTimeout(this._startupSplashMaxTimer);
      this._startupSplashMaxTimer = null;
    }
    if (this._startupSplashDoneTimer) {
      clearTimeout(this._startupSplashDoneTimer);
      this._startupSplashDoneTimer = null;
    }
    if (this._startupSplashHideTimer) {
      clearTimeout(this._startupSplashHideTimer);
    }
    this._startupSplashHideTimer = setTimeout(() => {
      this._startupSplashHideTimer = null;
      this.startupSplashVisible = false;
      this.startupSplashHiding = false;
    }, 360);
  },
  scheduleStartupRefreshRetry(delay = 700) {
    if (this._startupRefreshTimer) {
      clearTimeout(this._startupRefreshTimer);
      this._startupRefreshTimer = null;
    }
    this._startupRefreshTimer = setTimeout(() => {
      this._startupRefreshTimer = null;
      this.refreshAll({ silent: true, startup: true }).catch(() => {});
    }, Math.max(200, Number(delay) || 700));
  },
  async refreshAll(options = {}) {
    const silent = !!options.silent;
    const startup = !!options.startup;
    if (startup && !Number.isFinite(this._startupLibraryInteractionRevision)) {
      this._startupLibraryInteractionRevision = Number(this._libraryInteractionRevision || 0);
    }
    if (startup && !Number.isFinite(this._startupPlaybackGeneration)) {
      this._startupPlaybackGeneration = Number(this.playbackGeneration || 0);
    }
    const startupInteractionRevision = startup
      ? this._startupLibraryInteractionRevision
      : Number(this._libraryInteractionRevision || 0);
    const startupPlaybackGeneration = startup
      ? this._startupPlaybackGeneration
      : Number(this.playbackGeneration || 0);
    this.loading = true;
    try {
      await this.loadConfig();
      await Promise.all([
        this.ensureSeedsLoaded().catch(() => {
          this.seedsLoaded = false;
          if (this.view === "seeds") this.showNotice("复合种子加载失败，请重新进入页面重试。", "error");
        }),
        this.loadOnlineSourceConfig(),
        this.loadLyricSourceConfig(),
        this.loadRecommendationRateStatus(),
        this.pollIndexTaskStatus(),
        this.loadListeningHistory(),
        this.loadTracks({
          startup,
          interactionRevision: startupInteractionRevision,
          playbackGeneration: startupPlaybackGeneration,
        }),
      ]);
      this.buildFolderPlaylists();
      await this.restoreLastTrack({
        locate: !startup,
        preserveSelection: startup
          && Number(startupInteractionRevision) !== Number(this._libraryInteractionRevision || 0),
        expectedPlaybackGeneration: startup ? startupPlaybackGeneration : null,
      });
      this.queueUiSnapshotSave();
      if (startup) {
        this.onStartupReady();
      }
    } catch (e) {
      if (!silent) {
        console.warn("刷新失败", e);
        this.showNotice(this.getOperationUserMessage(e, "刷新失败"), "error");
      } else if (startup) {
        console.warn("启动阶段刷新失败，稍后重试", e);
        this.scheduleStartupRefreshRetry();
      }
      throw e;
    } finally {
      this.loading = false;
    }
  },
  async loadConfig() {
    if (this._audioDirectorySavePromise) {
      await this._audioDirectorySavePromise;
    }
    const wasAutoSaveReady = this._configAutoSaveReady;
    if (wasAutoSaveReady) {
      if (this._configAutoSaveTimer) {
        clearTimeout(this._configAutoSaveTimer);
        this._configAutoSaveTimer = null;
      }
      const saved = await this.flushConfigAutoSave();
      if (saved?.ok === false && !saved?.skipped) {
        throw new Error("设置保存失败");
      }
    }
    this._configAutoSaveReady = false;
    let data;
    try {
      ({ data } = await axios.get(`${this.baseUrl}/config`));
    } catch (error) {
      this._configAutoSaveReady = wasAutoSaveReady;
      throw error;
    }
    this.params = JSON.parse(JSON.stringify(data));
    this.params.recommendation = { semantic_floor: .90, context_floor: .86, candidate_limit: 80, adjacent_mert_floor:.95,
      recent_exclusion: 2, allow_older_repeats: true, ...(this.params.recommendation || {}) };
    // 默认值补齐
    this.params.seed = this.params.seed || {};
    this.params.history = this.params.history || {};
    if (this.params.history.repeat_policy === undefined) {
      this.params.history.repeat_policy = this.params.history.allow_duplicates ? "allow" : "disallow";
    }
    this.params.history.no_repeat_within = clampNumberAllowZero(
      this.params.history.no_repeat_within,
      100,
      0,
      1000,
    );
    this.params.history.allow_duplicates = this.params.history.repeat_policy === "allow";
    this.params.dislike_correction = this.params.dislike_correction || {};
    const dc = this.params.dislike_correction;
    if (dc.enabled === undefined) dc.enabled = true;
    if (dc.enable_recommend_rate_fix === undefined) dc.enable_recommend_rate_fix = true;
    if (dc.rec_strength === undefined) dc.rec_strength = 1;
    if (dc.rec_fix_min === undefined) dc.rec_fix_min = 0.1;
    if (dc.rec_fix_max === undefined) dc.rec_fix_max = 20;
    if (dc.auto_rebuild_recommend_rate === undefined) dc.auto_rebuild_recommend_rate = true;
    if (dc.enable_skip_rate_fix === undefined) dc.enable_skip_rate_fix = true;
    if (dc.skip_strength === undefined) dc.skip_strength = 1;
    if (dc.skip_fix_min === undefined) dc.skip_fix_min = 0.33;
    if (dc.skip_fix_max === undefined) dc.skip_fix_max = 2;
    if (dc.skip_smooth_k === undefined) dc.skip_smooth_k = 20;
    if (dc.daily_decay === undefined) dc.daily_decay = 0.98;
    if (dc.consecutive_dislike_threshold === undefined) dc.consecutive_dislike_threshold = 0;
    if (dc.long_pause_reset_minutes === undefined) dc.long_pause_reset_minutes = 10;
    if (this.params.seed.tau_pos === undefined) this.params.seed.tau_pos = this.params.seed.tau || 20;
    if (this.params.seed.tau_neg === undefined) this.params.seed.tau_neg = this.params.seed.tau || 5;
    if (this.params.seed.lambda_neg === undefined) this.params.seed.lambda_neg = 0.5;
    this.params.online = this.params.online || {};
    if (this.params.online.auto_index_enabled === undefined) this.params.online.auto_index_enabled = true;
    if (!this.params.online.default_quality) this.params.online.default_quality = "320k";
    if (!Array.isArray(this.params.online.exclude_tokens)) this.params.online.exclude_tokens = [];
    this.params.online.auto_index_after_seconds = Math.max(5, Math.min(600, Number(this.params.online.auto_index_after_seconds) || 60));
    this.params.model = this.params.model || {};
    this.params.model.source = String(this.params.model.source || "m-a-p/MERT-v1-330M");
    this.params.model.local_dir = String(this.params.model.local_dir || "");
    this.params.audio_dirs = window.FlowaveFolders.normalizeRoots(Array.isArray(data.audio_dirs) ? data.audio_dirs : [data.audio_dir ?? this.params.audio_dir ?? ""]);
    this.params.audio_dir = this.params.audio_dirs[0] || "";
    this.params.download_dir = data.download_dir || this.params.download_dir || "";
    this.audioDirectoryDraft = String(this.params.audio_dir || "");
    this.audioDirectoriesDraft = [...this.params.audio_dirs];
    this._lastSavedConfigFingerprint = this.getConfigFingerprint(this.buildConfigPayload());
    this._configAutoSaveReady = true;
    this.syncCurrentTrackExcluded();
  },
  applyOnlineSourceConfigPayload(data) {
    this.onlineSourceScriptPath = String(data?.scriptPath || "");
    this.onlineSourceDefaultPath = String(data?.defaultScriptPath || "");
    this.onlineSourceScriptExists = !!data?.exists;
    const info = data?.sourceInfo || {};
    const names = Object.keys(info).map((name) => String(name || "").trim().toLowerCase()).filter(Boolean);
    this.onlineSourceNames = names;
    const allowed = new Set(names);
    const curMusicSource = String(this.onlineMusicSource || "all").toLowerCase();
    const curSonglistSource = String(this.onlineSonglistSource || "all").toLowerCase();
    if (names.length && curMusicSource !== "all" && !allowed.has(curMusicSource)) {
      this.onlineMusicSource = "all";
    }
    if (names.length && curSonglistSource !== "all" && !allowed.has(curSonglistSource)) {
      this.onlineSonglistSource = "all";
    }
    const curFileSource = String(this.onlineFileSource || "").toLowerCase();
    if (names.length && curFileSource && !allowed.has(curFileSource)) {
      this.onlineFileSource = names[0];
    }
  },
  async loadOnlineSourceConfig() {
    if (!window.lxEnv || typeof window.lxEnv.getOnlineSourceConfig !== "function") return;
    try {
      const data = await window.lxEnv.getOnlineSourceConfig();
      this.applyOnlineSourceConfigPayload(data || {});
    } catch (e) {
      console.warn("读取音源配置失败", e);
      this.onlineSourceMessage = this.getOperationUserMessage(e, "读取音源配置失败");
    }
  },
  applyLyricSourcePayload(data) {
    const cfg = data?.config || {};
    this.externalLyricDir = String(cfg.externalLyricDir || data?.externalLyricDir || "");
    this.externalLyricConfigPath = String(data?.configPath || "");
    this.externalLyricDirExists = !!data?.exists;
  },
  async loadLyricSourceConfig() {
    if (!window.lxEnv || typeof window.lxEnv.getLyricSourceConfig !== "function") return;
    try {
      const data = await window.lxEnv.getLyricSourceConfig();
      this.applyLyricSourcePayload(data || {});
      this.externalLyricMessage = this.externalLyricDirExists || !this.externalLyricDir
        ? ""
        : "KTV 歌词目录不存在，请重新选择";
    } catch (e) {
      console.warn("读取 KTV 歌词目录失败", e);
      this.externalLyricMessage = this.getOperationUserMessage(e, "读取歌词目录失败");
    }
  },
  async loadRecommendationRateStatus() {
    if(this.featureEnabled?.('recommendation')===false)return;
    try {
      const { data } = await axios.get(`${this.baseUrl}/recommendation-rate/status`);
      this.recommendationRateStatus = data || {};
      this.recommendationRateMessage = "";
      if (this.recommendationRateStatus.running && !this._recommendationRatePollTimer) {
        this.scheduleRecommendationRatePoll();
      }
    } catch (e) {
      console.warn("读取推荐率状态失败", e);
      this.recommendationRateMessage = this.getOperationUserMessage(e, "读取推荐率状态失败");
    }
  },
  scheduleRecommendationRatePoll() {
    if (this._recommendationRatePollTimer) clearTimeout(this._recommendationRatePollTimer);
    this._recommendationRatePollTimer = setTimeout(async () => {
      this._recommendationRatePollTimer = null;
      await this.loadRecommendationRateStatus();
      if (this.recommendationRateStatus?.running) {
        this.scheduleRecommendationRatePoll();
      }
    }, 1200);
  },
  async rebuildRecommendationRate() {
    this.recommendationRateMessage = "";
    try {
      const { data } = await axios.post(`${this.baseUrl}/recommendation-rate/rebuild`, { force: true });
      this.recommendationRateStatus = data || {};
      this.recommendationRateMessage = this.recommendationRateStatus.running ? "推荐率正在后台重建" : "推荐率重建已提交";
      this.scheduleRecommendationRatePoll();
    } catch (e) {
      console.warn("重建推荐率失败", e);
      this.recommendationRateMessage = this.getOperationUserMessage(e, "重建推荐率失败");
    }
  },
  refreshSkipRateStats() {
    this.updateSkipRateSummaryIfNeeded({ force: true });
    this.saveListeningHistoryNow();
    this.recommendationRateMessage = "跳过率统计已刷新";
  },
  formatRecommendationRateStatus(status) {
    const labels = {
      missing: "未生成",
      ready: "可用",
      stale: "需要更新",
      running: "重建中",
      failed: "失败",
    };
    return labels[String(status || "").toLowerCase()] || "未生成";
  },
  formatRecommendationFallback(level) {
    const labels = {
      strict: "合格候选",
      older_repeat: "较早重听",
      same_direction_expansion: "同方向近邻扩展",
      connected_neighbourhood: "沿关联邻域继续寻找",
      expanded_older_repeat: "扩展范围内较早重听",
      ignore_history: "忽略最近播放",
      nearest_out_of_range: "区间外最近",
      weighted: "加权",
      uniform: "等权",
      empty: "无候选",
    };
    return labels[String(level || "").toLowerCase()] || "—";
  },
  async pickOnlineSourceScript() {
    if (!window.lxEnv || typeof window.lxEnv.pickOnlineSourceScript !== "function") return;
    try {
      const data = await window.lxEnv.pickOnlineSourceScript();
      if (data?.canceled) return;
      if (data?.filePath) {
        this.onlineSourceScriptPath = data.filePath;
        await this.saveOnlineSourceScript();
      }
    } catch (e) {
      console.warn("选择音源脚本失败", e);
      this.onlineSourceMessage = this.getOperationUserMessage(e, "选择脚本失败");
    }
  },
  async pickDownloadDir() {
    if (!window.lxEnv || typeof window.lxEnv.pickDirectory !== "function") return;
    try {
      const ret = await window.lxEnv.pickDirectory();
      if (this.loading) return "";
      if (!ret?.canceled && ret?.path) {
        this.params.download_dir = String(ret.path);
      }
    } catch (e) {
      console.warn("选择下载目录失败", e);
      this.showNotice(this.getOperationUserMessage(e, "无法选择下载文件夹"), "error");
    }
  },
  normalizeDirectoryForComparison(value) {
    return String(value || "")
      .trim()
      .replace(/\//g, "\\")
      .replace(/\\+$/g, "")
      .toLocaleLowerCase();
  },
  configuredAudioDirectories() {
    return window.FlowaveFolders.normalizeRoots(Array.isArray(this.params.audio_dirs) ? this.params.audio_dirs : [this.params.audio_dir]);
  },
  hasPendingAudioDirectoryChange() {
    const keys=values=>window.FlowaveFolders.normalizeRoots(values).map(p=>this.normalizeDirectoryForComparison(p));
    return JSON.stringify(keys(this.audioDirectoriesDraft)) !== JSON.stringify(keys(this.configuredAudioDirectories()));
  },
  removeAudioDirectory(index) {
    if (this.loading) return;
    this.audioDirectoriesDraft = this.audioDirectoriesDraft.filter((_,i)=>i!==index);
    this.audioDirectoryDraft = this.audioDirectoriesDraft[0] || "";
    this.libraryRefreshMessage = "移除只影响音乐库，原音乐文件会保留；点击载入后生效。";
  },
  async pickAudioDir() {
    if (this.loading) return "";
    if (!window.lxEnv || typeof window.lxEnv.pickDirectory !== "function") return;
    try {
      const ret = await window.lxEnv.pickDirectory();
      if (this.loading) return "";
      if (!ret?.canceled && ret?.path) {
        this.audioDirectoriesDraft = window.FlowaveFolders.normalizeRoots([...this.audioDirectoriesDraft, String(ret.path)]);
        this.audioDirectoryDraft = this.audioDirectoriesDraft[0] || "";
        this.libraryRefreshMessage = "";
        return String(ret.path);
      }
    } catch (e) {
      console.warn("选择音乐目录失败", e);
      this.showNotice(this.getOperationUserMessage(e, "无法选择音乐文件夹"), "error");
    }
    return "";
  },
  async setupMusicLibrary() {
    const selectedPath = await this.pickAudioDir();
    if (!selectedPath) return;
    await this.saveAudioDirectory();
  },
  async saveAudioDirectory() {
    const audioDirs = window.FlowaveFolders.normalizeRoots(this.audioDirectoriesDraft);
    if (!audioDirs.length) {
      this.libraryRefreshMessage = "请先选择音乐文件夹。";
      return false;
    }
    if (this._audioDirectorySavePromise) return this._audioDirectorySavePromise;

    const savePromise = (async () => {
      this.loading = true;
      this.libraryRefreshMessage = "正在读取音乐文件夹…";
      this._configAutoSaveSuspended = true;
      this._configSaveQueued = true;
      if (this._configAutoSaveTimer) {
        clearTimeout(this._configAutoSaveTimer);
        this._configAutoSaveTimer = null;
      }
      try {
        if (this._configSavePromise) {
          await this._configSavePromise;
        }
        const { data: refreshResult } = await axios.post(`${this.baseUrl}/tracks/rescan`, { audio_dirs: audioDirs });
        this.libraryRefreshMessage = String(refreshResult?.message || "");
        if (!refreshResult?.committed) return false;
        const relocations = Array.isArray(refreshResult.relocations) ? refreshResult.relocations : [];
        this.applyLibraryRelocations(relocations);
        this.params.audio_dirs = window.FlowaveFolders.normalizeRoots(refreshResult.audio_dirs || audioDirs);
        this.params.audio_dir = this.params.audio_dirs[0] || "";
        this.audioDirectoriesDraft = [...this.params.audio_dirs];
        this.audioDirectoryDraft = this.params.audio_dir;
        await this.loadTracks({ preserveView: true, relocations });
        this.buildFolderPlaylists();
        this.$nextTick(() => this.refreshVirtualViewport());
        this.queueUiSnapshotSave();
        this.libraryRefreshMessage = this.tracks.length
          ? `已载入 ${this.tracks.length} 首歌曲。`
          : "没有发现支持的音频文件。";
        return true;
      } catch (e) {
        console.warn("载入音乐文件夹失败", e);
        this.libraryRefreshMessage = this.getOperationUserMessage(e, "载入失败");
        return false;
      } finally {
        this._configAutoSaveSuspended = false;
        const shouldFlushQueuedConfig = this._configSaveQueued;
        this._configSaveQueued = false;
        if (shouldFlushQueuedConfig) this.scheduleConfigAutoSave(100);
        this.loading = false;
      }
    })();
    this._audioDirectorySavePromise = savePromise;
    try {
      return await savePromise;
    } finally {
      if (this._audioDirectorySavePromise === savePromise) {
        this._audioDirectorySavePromise = null;
      }
    }
  },
  async pickExternalLyricDir() {
    if (!window.lxEnv || typeof window.lxEnv.pickLyricSourceDirectory !== "function") return;
    try {
      const ret = await window.lxEnv.pickLyricSourceDirectory();
      if (!ret?.canceled && ret?.path) {
        this.externalLyricDir = String(ret.path);
        this.externalLyricMessage = "";
        await this.saveExternalLyricDir();
      }
    } catch (e) {
      console.warn("选择 KTV 歌词目录失败", e);
      this.externalLyricMessage = this.getOperationUserMessage(e, "无法选择歌词文件夹");
    }
  },
  async saveExternalLyricDir() {
    if (!window.lxEnv || typeof window.lxEnv.setLyricSourceConfig !== "function") return;
    this.externalLyricSaving = true;
    this.externalLyricMessage = "";
    try {
      const data = await window.lxEnv.setLyricSourceConfig({ externalLyricDir: this.externalLyricDir });
      this.applyLyricSourcePayload(data || {});
      if (this.currentPath && !this.isOnlineToken(this.currentPath)) {
        await this.populateCurrentMeta(this.currentPath);
        this.updateLyricHighlight(this.currentTime, { source: "lyric-source", ignoreRenderDelay: true });
        this.sendLyricOverlay();
      }
      this.externalLyricMessage = this.externalLyricDirExists
        ? "KTV 歌词目录已保存"
        : "KTV 歌词目录已保存，但路径不存在";
    } catch (e) {
      console.warn("保存 KTV 歌词目录失败", e);
      this.externalLyricMessage = this.getOperationUserMessage(e, "保存歌词目录失败");
    } finally {
      this.externalLyricSaving = false;
    }
  },
  async pickModelDir() {
    if (!window.lxEnv || typeof window.lxEnv.pickDirectory !== "function") return;
    try {
      const ret = await window.lxEnv.pickDirectory();
      if (!ret?.canceled && ret?.path) {
        this.params.model = this.params.model || {};
        this.params.model.local_dir = String(ret.path);
      }
    } catch (e) {
      console.warn("选择模型目录失败", e);
      this.showNotice(this.getOperationUserMessage(e, "无法选择模型文件夹"), "error");
    }
  },
  async launchRecommendationInstaller() {
    this.openSettingsSection('features');
  },
  async launchModelInstaller() {
    this.openSettingsSection('features');
  },
  applyInstallerProgress(payload) {
    const task = String(payload?.task || "");
    if (!Object.prototype.hasOwnProperty.call(this.installerTasks, task)) return;
    const current = this.installerTasks[task] || {};
    const rawPercent = Number(payload?.percent);
    const percent = Number.isFinite(rawPercent) ? Math.max(0, Math.min(100, rawPercent)) : null;
    this.installerTasks[task] = {
      ...current,
      ...payload,
      task,
      percent,
      running: payload?.running !== false && !["complete", "error"].includes(String(payload?.phase || "")),
      phase: String(payload?.phase || current.phase || "starting"),
      message: String(payload?.message || current.message || "准备中…"),
      target: String(payload?.target || current.target || ""),
    };
  },
  setInstallerFailure(task, message) {
    this.applyInstallerProgress({ task, phase: "error", running: false, message });
  },
  installerProgressStyle(task) {
    const percent = Number(task?.percent);
    return { "--installer-progress": `${Number.isFinite(percent) ? percent : 30}%` };
  },
  async saveOnlineSourceScript() {
    if (!window.lxEnv || typeof window.lxEnv.setOnlineSourceScript !== "function") return;
    this.onlineSourceSaving = true;
    this.onlineSourceMessage = "";
    try {
      const data = await window.lxEnv.setOnlineSourceScript({ scriptPath: this.onlineSourceScriptPath });
      this.applyOnlineSourceConfigPayload(data || {});
      this.onlineSourceMessage = data?.message || (data?.ok ? "音源配置已保存" : "音源配置保存失败");
    } catch (e) {
      console.warn("保存在线音源失败", e);
      this.onlineSourceMessage = this.getOperationUserMessage(e, "保存失败");
    } finally {
      this.onlineSourceSaving = false;
    }
  },
  async resetOnlineSourceScript() {
    this.onlineSourceScriptPath = this.onlineSourceDefaultPath || "";
    await this.saveOnlineSourceScript();
  },
  setView(nextView) {
    const v = String(nextView || "").trim();
    const module=window.FlowaveFeatureModules?.viewModule(v);
    if(module && this.featureEnabled?.(module)===false){this.openSettingsSection('features');return;}
    if (!PUBLIC_VIEWS.has(v) || this.view === v) return;
    this.markLibraryUserInteraction();
    this.visitedViews = { ...(this.visitedViews || {}), [v]: true };
    this.view = v;
    if (v === "seeds") this.ensureSeedsLoaded().catch(() => this.showNotice("复合种子加载失败", "error"));
  },
  shouldRenderView(name) {
    const v = String(name || "");
    const module=window.FlowaveFeatureModules?.viewModule(v);
    if(module && this.featureEnabled?.(module)===false)return false;
    return PUBLIC_VIEWS.has(v) && (this.view === v || !!this.visitedViews?.[v]);
  },
  prepareTrackForList(track, options = {}) {
    const t = track || {};
    const buildDoc = options.buildDoc !== false;
    const title = t.title || t.name || this.extractName(t.path);
    const artist = t.artist || "";
    const album = t.album || "";
    const base = {
      ...t,
      title,
      name: t.name || title,
    };
    const search = window.KumikoSearch;
    const doc = buildDoc && search && typeof search.buildTrackDoc === "function"
      ? search.buildTrackDoc(base, { extractName: (p) => this.extractName(p) })
      : null;
    return {
      ...base,
      _searchDoc: markSearchRaw(doc),
      _searchText: doc?.allSearch || `${title} ${artist} ${album}`.toLowerCase(),
    };
  },
  rebuildTrackLookup() {
    this.trackByPath = new Map((this.tracks || []).map((t) => [t.path, t]));
    this.searchDocs = markSearchRaw((this.tracks || []).map((t) => t._searchDoc).filter(Boolean));
    this.searchFuse = markSearchRaw(window.KumikoSearch?.createFuse?.(this.searchDocs) || null);
    this.searchIndexReady = !!this.searchDocs.length;
    this.searchIndexBuilding = false;
  },
  queueSearchIndexRebuild(delay = 320) {
    if (this._searchIndexTimer) {
      clearTimeout(this._searchIndexTimer);
      this._searchIndexTimer = null;
    }
    this._searchIndexTimer = setTimeout(() => {
      this._searchIndexTimer = null;
      this.rebuildSearchIndexChunked();
    }, Math.max(50, Number(delay) || 180));
  },
  ensureSearchController() {
    if (this._searchWorkerController) return this._searchWorkerController;
    if (this._searchWorkerFailed || !window.Worker || !window.FlowaveSearchController) return null;
    try {
      const worker = new window.Worker("search-worker.js");
      const controller = new window.FlowaveSearchController(worker, {
        onReady: () => {
          if (this._searchWorkerTracks !== this.tracks) return;
          this.searchIndexReady = true;
          this.searchIndexBuilding = false;
          this.searchWorkerRevision += 1;
          if (this._searchWorkerRebuildPending) {
            this._searchWorkerRebuildPending = false;
            this.queueSearchIndexRebuild(100);
          }
        },
        onResults: () => { this.searchWorkerRevision += 1; },
        onError: () => {
          this._searchWorkerFailed = true;
          this._searchWorkerController = null;
          this.searchWorkerRevision += 1;
          this.rebuildSearchIndexChunked();
        },
      });
      this._searchWorkerController = controller;
      this._searchWorkerViews = new Map();
      return controller;
    } catch (_) {
      this._searchWorkerFailed = true;
      return null;
    }
  },
  rebuildSearchIndexChunked() {
    if (this._librarySearchComposing || Date.now() - Number(this._lastSearchInputAt || 0) < 300) {
      this.queueSearchIndexRebuild(300);
      return;
    }
    const controller = this.ensureSearchController();
    if (controller) {
      // 同一曲库的元数据连续更新不能不断中断冷构建，使搜索永远无法就绪。
      if (this._searchWorkerTracks === this.tracks && controller.generation > controller.activeGeneration) {
        this._searchWorkerRebuildPending = true;
        return;
      }
      this._searchWorkerRebuildPending = false;
      this._searchWorkerTracks = this.tracks;
      this.searchIndexBuilding = true;
      controller.build((this.tracks || []).map(({ path, title, name, artist, album }) => ({ path, title, name, artist, album, filename: this.extractName(path) })));
      return;
    }
    const search = window.KumikoSearch;
    if (!search || typeof search.buildTrackDoc !== "function") {
      this.rebuildTrackLookup();
      return;
    }
    const tracks = this.tracks || [];
    const buildId = (Number(this._searchIndexBuildId || 0) + 1);
    this._searchIndexBuildId = buildId;
    // 后台补齐只更新下一份索引；已有完整索引继续提供同一种搜索语义。
    this.searchIndexReady = !!this.searchDocs.length;
    this.searchIndexBuilding = true;
    this.trackByPath = new Map(tracks.map((t) => [t.path, t]));
    let index = 0;
    const chunkSize = 120;
    const buildChunk = () => {
      if (this._searchIndexBuildId !== buildId || this.tracks !== tracks) return;
      if (this.pendingPlaybackTransition || this.keywordDraft !== this.keyword || this._librarySearchComposing
        || Date.now() - Number(this._lastSearchInputAt || 0) < 300) {
        setTimeout(buildChunk, 40);
        return;
      }
      const sliceStartedAt = Date.now();
      const end = Math.min(tracks.length, index + chunkSize);
      for (; index < end; index += 1) {
        const t = tracks[index];
        if (!t || t._searchDoc) continue;
        const prepared = this.prepareTrackForList(t, { buildDoc: true });
        t._searchDoc = prepared._searchDoc;
        t._searchText = prepared._searchText;
        if (Date.now() - sliceStartedAt >= 6) {
          index += 1;
          break;
        }
      }
      if (index < tracks.length) {
        setTimeout(buildChunk, 0);
        return;
      }
      this.searchDocs = markSearchRaw(tracks.map((t) => t._searchDoc).filter(Boolean));
      this.searchFuse = markSearchRaw(window.KumikoSearch?.createFuse?.(this.searchDocs) || null);
      this.searchIndexReady = !!this.searchDocs.length;
      this.searchIndexBuilding = false;
    };
    setTimeout(buildChunk, 0);
  },
  scheduleLocalSearchCommit(scope, delay = 220) {
    if (this._localSearchTimers?.[scope]) {
      clearTimeout(this._localSearchTimers[scope]);
    }
    this._localSearchTimers = this._localSearchTimers || {};
    this._localSearchTimers[scope] = setTimeout(() => {
      this._localSearchTimers[scope] = null;
      if (scope === "library") this.keyword = this.keywordDraft;
      else if (scope === "rankingLeft") this.rankingLeftKeyword = this.rankingLeftKeywordDraft;
      else if (scope === "rankingRight") this.rankingRightKeyword = this.rankingRightKeywordDraft;
    }, Math.max(80, Number(delay) || 220));
  },
  commitLibrarySearch(value) {
    this.keywordDraft = String(value || "");
    this.keyword = this.keywordDraft;
  },
  onLibrarySearchActivity(composing = false) {
    this._lastSearchInputAt = Date.now();
    this._librarySearchComposing = composing === true;
    this._libraryInteractionRevision = Number(this._libraryInteractionRevision || 0) + 1;
    this.queueLibraryMetadataRefresh(400);
  },
  searchTrackList(list, keyword, fuzzy = true, scope = "library") {
    const items = Array.isArray(list) ? list : [];
    const kw = String(keyword || "").trim();
    if (!kw) return items;
    // 依赖只包含搜索代际；封面与时长变化不会重新启动全库搜索。
    void this.searchWorkerRevision;
    const controller = this._searchWorkerController;
    if (controller) {
      const paths = controller.query(kw, fuzzy, scope);
      const previous = this._searchWorkerViews.get(scope);
      if (paths !== null && previous?.paths === paths && previous?.items === items) return previous.results;
      const allowed = items === this.tracks ? null : new Set(items.map((track) => track.path));
      if (paths === null) return previous?.results
        ? previous.results.filter((track) => this.trackByPath.get(track.path) === track && (!allowed || allowed.has(track.path)))
        : items;
      const results = paths.map((path) => this.trackByPath.get(path)).filter((track) => track && (!allowed || allowed.has(track.path)));
      this._searchWorkerViews.set(scope, { paths, items, results });
      return results;
    }
    const search = window.KumikoSearch;
    if (!this.searchIndexReady || !search || typeof search.search !== "function") {
      const low = kw.toLowerCase();
      return items.filter((t) => String(t._searchText || "").includes(low));
    }
    const allowed = new Set(items.map((t) => t.path));
    const sourceDocs = this.searchDocs || [];
    const results = search.search(sourceDocs, this.searchFuse, kw, { fuzzy });
    return results
      .map((r) => this.trackByPath?.get(r.doc.path))
      .filter((t) => t && allowed.has(t.path));
  },
  searchRankingResults(list, keyword, fuzzy = true) {
    const items = Array.isArray(list) ? list : [];
    const kw = String(keyword || "").trim();
    if (!kw) return items;
    const search = window.KumikoSearch;
    if (!this.searchIndexReady || !search || typeof search.search !== "function") {
      const low = kw.toLowerCase();
      return items.filter((r) => String(r.name || this.extractName(r.path)).toLowerCase().includes(low));
    }
    const docs = items.map((r) => {
      const t = this.trackByPath?.get(r.path);
      return t?._searchDoc || search.buildTrackDoc({ path: r.path, title: r.name || this.extractName(r.path), artist: "" }, { extractName: (p) => this.extractName(p) });
    });
    const fuse = search.createFuse?.(docs) || null;
    const byPath = new Map(items.map((r) => [r.path, r]));
    return search.search(docs, fuse, kw, { fuzzy })
      .map((r) => byPath.get(r.doc.path))
      .filter(Boolean);
  },
  async reloadOnlineSourceScript() {
    if (!window.lxEnv || typeof window.lxEnv.reloadOnlineSource !== "function") return;
    this.onlineSourceSaving = true;
    this.onlineSourceMessage = "";
    try {
      const data = await window.lxEnv.reloadOnlineSource();
      this.applyOnlineSourceConfigPayload(data || {});
      this.onlineSourceMessage = data?.message || (data?.ok ? "音源已重新载入" : "重新载入失败");
    } catch (e) {
      console.warn("重载在线音源失败", e);
      this.onlineSourceMessage = this.getOperationUserMessage(e, "重新载入失败");
    } finally {
      this.onlineSourceSaving = false;
    }
  },
  rebuildTrackIdentityMaps() {
    this.trackByResourceId = new Map();
    this.trackResourcesBySongKey = new Map();
    (this.tracks || []).forEach((track) => {
      const resourceId = String(track?.resourceId || "");
      const songKey = String(track?.songKey || "");
      if (resourceId && !this.trackByResourceId.has(resourceId)) {
        this.trackByResourceId.set(resourceId, track);
      }
      if (songKey) {
        const list = this.trackResourcesBySongKey.get(songKey) || [];
        list.push(track);
        this.trackResourcesBySongKey.set(songKey, list);
      }
    });
  },
  makeTrackReference(path, previous = null) {
    const trackPath = String(path || previous?.path || "");
    const track = this.trackByPath.get(trackPath)
      || (previous?.resourceId ? this.trackByResourceId.get(String(previous.resourceId)) : null);
    return {
      resourceId: String(track?.resourceId || previous?.resourceId || ""),
      songKey: String(track?.songKey || previous?.songKey || ""),
      path: String(track?.path || trackPath),
    };
  },
  resolveTrackReference(reference, fallbackPath = "") {
    const ref = reference && typeof reference === "object" ? reference : {};
    const resourceId = String(ref.resourceId || ref.resource_id || "");
    if (resourceId) {
      const byResource = this.trackByResourceId.get(resourceId);
      if (byResource?.path) return String(byResource.path);
    }
    const path = String(ref.path || fallbackPath || "");
    if (path && (this.trackByPath.has(path) || this.isOnlineToken(path))) return path;
    const songKey = String(ref.songKey || ref.song_key || "");
    const keyMatches = songKey ? (this.trackResourcesBySongKey.get(songKey) || []) : [];
    if (keyMatches.length === 1 && keyMatches[0]?.path) return String(keyMatches[0].path);
    return path;
  },
  readLastTrackReference() {
    try {
      const raw = readStoredString(STORAGE_KEYS.LAST_TRACK_REF, "");
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  },
  persistLastTrackReference(path = this.currentPath) {
    const reference = this.makeTrackReference(path, this.currentTrackRef);
    this.currentTrackRef = reference;
    writeStored(STORAGE_KEYS.LAST_TRACK, reference.path);
    writeStored(STORAGE_KEYS.LAST_TRACK_REF, JSON.stringify(reference));
    return reference;
  },
  syncCustomPlaylistTrackRefs() {
    this.customPlaylists = (this.customPlaylists || []).map((playlist) => {
      const tracks = Array.isArray(playlist.tracks) ? playlist.tracks.map((path) => String(path || "")) : [];
      const availableRefs = Array.isArray(playlist.trackRefs) ? playlist.trackRefs.slice() : [];
      const trackRefs = tracks.map((trackPath) => {
        const matchIndex = availableRefs.findIndex((reference) => (
          String(reference?.path || "") === trackPath
          || this.resolveTrackReference(reference) === trackPath
        ));
        const previous = matchIndex >= 0 ? availableRefs.splice(matchIndex, 1)[0] : null;
        return this.makeTrackReference(trackPath, previous);
      });
      return { ...playlist, tracks, trackRefs };
    });
  },
  reconcilePersistentTrackReferences() {
    const beforePlaylists = JSON.stringify(this.customPlaylists || []);
    this.customPlaylists = (this.customPlaylists || []).map((playlist) => {
      const tracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
      const refs = Array.isArray(playlist.trackRefs) ? playlist.trackRefs : [];
      const nextTracks = [];
      const nextRefs = [];
      const seen = new Set();
      tracks.forEach((rawPath, index) => {
        const previousRef = refs[index] || { path: rawPath };
        const resolvedPath = this.resolveTrackReference(previousRef, rawPath) || String(rawPath || "");
        if (!resolvedPath) return;
        const nextRef = this.makeTrackReference(resolvedPath, previousRef);
        const identityKey = nextRef.resourceId ? `resource:${nextRef.resourceId}` : `path:${resolvedPath}`;
        if (seen.has(identityKey)) return;
        seen.add(identityKey);
        nextTracks.push(resolvedPath);
        nextRefs.push(nextRef);
      });
      return { ...playlist, tracks: nextTracks, trackRefs: nextRefs };
    });
    if (JSON.stringify(this.customPlaylists || []) !== beforePlaylists) {
      writeStoredIfChanged(STORAGE_KEYS.CUSTOM_PLAYLISTS, JSON.stringify(this.customPlaylists));
    }

    const history = Array.isArray(this.playHistory) ? this.playHistory : [];
    const refs = Array.isArray(this.playHistoryRefs) ? this.playHistoryRefs : [];
    const refOffset = Math.max(0, history.length - refs.length);
    this.playHistory = history.map((rawPath, index) => (
      this.resolveTrackReference(index >= refOffset ? refs[index - refOffset] : null, rawPath)
      || String(rawPath || "")
    )).filter(Boolean).slice(-500);
    this.playHistoryRefs = this.playHistory.map((path, index) => (
      this.makeTrackReference(path, index >= refOffset ? refs[index - refOffset] : null)
    ));
    writeStoredIfChanged(STORAGE_KEYS.PLAY_HISTORY, JSON.stringify(this.playHistory));
    writeStoredIfChanged(STORAGE_KEYS.PLAY_HISTORY_REFS, JSON.stringify(this.playHistoryRefs));

    const storedLegacyPath = readStoredString(STORAGE_KEYS.LAST_TRACK, "");
    const storedReference = this.readLastTrackReference();
    const resolvedLastPath = this.resolveTrackReference(storedReference, storedLegacyPath);
    if (resolvedLastPath) {
      const nextReference = this.makeTrackReference(resolvedLastPath, storedReference);
      writeStoredIfChanged(STORAGE_KEYS.LAST_TRACK, resolvedLastPath);
      writeStoredIfChanged(STORAGE_KEYS.LAST_TRACK_REF, JSON.stringify(nextReference));
      if (!this.currentTrackRef || this.currentTrackRef.resourceId === nextReference.resourceId) {
        this.currentTrackRef = nextReference;
      }
    }

    const resolvedCurrentPath = this.resolveTrackReference(this.currentTrackRef, this.currentPath);
    if (resolvedCurrentPath) {
      this.currentPath = resolvedCurrentPath;
      this.currentTrackRef = this.makeTrackReference(resolvedCurrentPath, this.currentTrackRef);
    }
  },
  async loadTracks(options = {}) {
    const loadGeneration = Number(this._trackLoadGeneration || 0) + 1;
    this._trackLoadGeneration = loadGeneration;
    this._metadataPlanGeneration = Number(this._metadataPlanGeneration || 0) + 1;
    if (this._metadataFillTimer) {
      clearTimeout(this._metadataFillTimer);
      this._metadataFillTimer = null;
    }
    if (this._metadataPriorityTimer) {
      clearTimeout(this._metadataPriorityTimer);
      this._metadataPriorityTimer = null;
    }
    const preserveView = !!options.preserveView;
    const startup = !!options.startup;
    const startupInteractionRevision = Number.isFinite(options.interactionRevision)
      ? Number(options.interactionRevision)
      : Number(this._libraryInteractionRevision || 0);
    const startupPlaybackGeneration = Number.isFinite(options.playbackGeneration)
      ? Number(options.playbackGeneration)
      : Number(this.playbackGeneration || 0);
    const startupViewStillCurrent = () => (
      !startup
      || startupInteractionRevision === Number(this._libraryInteractionRevision || 0)
    );
    const startupPlaybackStillCurrent = () => (
      !startup
      || startupPlaybackGeneration === Number(this.playbackGeneration || 0)
    );
    const restoredCurrentPath = String(this.currentPath || "");
    const previousTracks = new Map((this.tracks || []).map((track) => [String(track.path || ""), track]));
    const previousTracksByResource = new Map(
      (this.tracks || [])
        .filter((track) => track?.resourceId)
        .map((track) => [String(track.resourceId), track])
    );
    const relocationSourceByTarget = new Map(
      (options.relocations || [])
        .filter((item) => item?.from && item?.to)
        .map((item) => [String(item.to), String(item.from)])
    );
    const [{ data }, { data: catalogData }] = await Promise.all([
      axios.get(`${this.baseUrl}/tracks`, { params: { scope: "all" } }),
      axios.get(`${this.baseUrl}/online/catalog`).catch(() => ({ data: { catalog: {} } })),
    ]);
    if (loadGeneration !== this._trackLoadGeneration) return false;
    const catalog = catalogData?.catalog || {};
    Object.keys(catalog).forEach((token) => {
      const c = catalog[token] || {};
      this.onlineTrackMap[token] = {
        token,
        source: c.source || "",
        songId: c.songId || "",
        title: c.name || "",
        name: c.name || "",
        artist: c.artist || "",
        album: c.album || "",
        duration: c.duration || 0,
        durationText: this.formatTime(c.duration || 0),
        cover: c.cover || "",
        qualities: c.qualities || [],
        duplicate_of: c.duplicate_of || "",
        dedupe_key: c.dedupe_key || "",
        indexed: !!c.indexed,
        raw: {
          id: c.songId,
          songmid: c.songId,
          hash: c.songId,
          copyrightId: c.songId,
        },
      };
    });
    const items = data.tracks || [];
    const identityByPath = new Map(
      (Array.isArray(data.items) ? data.items : [])
        .filter((item) => item?.path)
        .map((item) => [String(item.path), item])
    );
    this.tracks = items.map((p) => {
      const previousPath = relocationSourceByTarget.get(String(p)) || String(p);
      const identity = identityByPath.get(String(p)) || null;
      const previous = previousTracksByResource.get(String(identity?.resource_id || ""))
        || previousTracks.get(previousPath)
        || previousTracks.get(String(p))
        || null;
      const nextSongKey = String(identity?.song_key || previous?.songKey || "");
      const sameResourceTagChanged = Boolean(
        previous?.resourceId
        && identity?.resource_id
        && String(previous.resourceId) === String(identity.resource_id)
        && String(previous.songKey || "")
        && nextSongKey
        && String(previous.songKey) !== nextSongKey
      );
      return {
        ...(previous || {}),
        path: p,
        title: this.onlineTrackMap[p]?.title || (sameResourceTagChanged ? this.extractName(p) : previous?.title) || this.extractName(p),
        name: this.onlineTrackMap[p]?.name || (sameResourceTagChanged ? this.extractName(p) : previous?.name) || this.extractName(p),
        artist: this.onlineTrackMap[p]?.artist || (sameResourceTagChanged ? "" : previous?.artist) || "",
        album: this.onlineTrackMap[p]?.album || (sameResourceTagChanged ? "" : previous?.album) || "",
        duration: this.onlineTrackMap[p]?.duration || previous?.duration || 0,
        durationText: this.onlineTrackMap[p]?.durationText || previous?.durationText || "00:00",
        cover: this.onlineTrackMap[p]?.cover || (sameResourceTagChanged ? "" : previous?.cover) || "",
        cover_thumb: this.onlineTrackMap[p]?.cover || (sameResourceTagChanged ? "" : (previous?.cover_thumb || previous?.cover)) || "",
        indexed: this.isOnlineToken(p) ? !!this.onlineTrackMap[p]?.indexed : !!previous?.indexed,
        resourceId: String(identity?.resource_id || previous?.resourceId || ""),
        songKey: nextSongKey,
        contentFingerprint: String(identity?.content_fingerprint || previous?.contentFingerprint || ""),
        _metaLoaded: sameResourceTagChanged ? false : !!previous?._metaLoaded,
      };
    }).map((t) => this.prepareTrackForList(t, { buildDoc: false }));
    this.trackByPath = new Map(this.tracks.map((t) => [t.path, t]));
    this.soundMapLibraryRevision++;
    if(this.useRecommend)void this.prepareRecommendationFeatures();
    this._localMetadataRevision = Number(this._localMetadataRevision || 0) + 1;
    this.rebuildTrackIdentityMaps();
    this.reconcilePersistentTrackReferences();
    this.listeningHistory = this.normalizeListeningHistory(this.listeningHistory);
    this.searchDocs = [];
    this.searchFuse = null;
    this.searchIndexReady = false;
    this.searchIndexBuilding = false;
    this.queueSearchIndexRebuild(650);
    if (!this.currentPath && this.tracks.length) {
      this.currentPath = this.tracks[0].path;
    }
    let startupTargetPath = "";
    if (startup) {
      const storedLastTrack = this.resolveTrackReference(
        this.readLastTrackReference(),
        readStoredString(STORAGE_KEYS.LAST_TRACK, null)
      );
      if (storedLastTrack && this.trackByPath.has(storedLastTrack)) {
        startupTargetPath = storedLastTrack;
      } else if (restoredCurrentPath && this.trackByPath.has(restoredCurrentPath)) {
        startupTargetPath = restoredCurrentPath;
      }
      if (startupTargetPath && startupPlaybackStillCurrent()) {
        this.currentPath = startupTargetPath;
        if (startupViewStillCurrent()) {
          this.selectedPath = startupTargetPath;
        }
      }
    }
    if (!preserveView && startupViewStillCurrent()) {
      this.libraryScrollTop = 0;
      this.rankingScrollTop = 0;
    }
    this.buildFolderPlaylists();
    if (startupTargetPath && startupPlaybackStillCurrent() && startupViewStillCurrent()) {
      this.locateTrack(startupTargetPath, {
        animate: false,
        center: true,
        flash: false,
        startup: true,
        loadGeneration,
        interactionRevision: startupInteractionRevision,
      });
    }
    const metadataPlan = this.buildMetadataFillPlan();
    const metadataPlanGeneration = Number(this._metadataPlanGeneration || 0);
    await this.fillMetadataTargets(metadataPlan.priority, loadGeneration, metadataPlanGeneration);
    if (loadGeneration !== this._trackLoadGeneration) return false;
    if (
      metadataPlanGeneration === Number(this._metadataPlanGeneration || 0)
      && this.view === "library"
      && metadataPlan.background.length
    ) {
      this.lazyFillMeta(metadataPlan.background, 0, 12, loadGeneration, metadataPlanGeneration);
    }
    this.$nextTick(() => this.refreshVirtualViewport());
    this.queueUiSnapshotSave();
    return true;
  },
  buildUiSnapshotPayload({ includeTracks = true } = {}) {
    const tracks = includeTracks && Array.isArray(this.tracks) ? this.tracks.slice(0, 5000).map((t) => ({
      path: t.path,
      title: t.title || "",
      name: t.name || "",
      artist: t.artist || "",
      album: t.album || "",
      artists: Array.isArray(t.artists) ? t.artists : undefined,
      albumArtist: t.albumArtist,
      trackNumber: Number(t.trackNumber)||0,
      discNumber: Number(t.discNumber)||0,
      duration: Number(t.duration || 0),
      durationText: t.durationText || "",
      cover: t.cover || "",
      cover_thumb: t.cover_thumb || "",
      indexed: !!t.indexed,
      resourceId: t.resourceId || "",
      songKey: t.songKey || "",
      contentFingerprint: t.contentFingerprint || "",
      _metaLoaded: !!t._metaLoaded,
    })) : [];
    return {
      version: 2,
      savedAt: Date.now(),
      ...(includeTracks ? { tracks } : {}),
      currentPath: this.currentPath || "",
      currentTrackRef: this.makeTrackReference(this.currentPath, this.currentTrackRef),
      selectedPath: this.selectedPath || "",
      currentPlaylist: this.currentPlaylist || "all",
      currentMeta: {
        title: this.currentMeta?.title || "",
        artist: this.currentMeta?.artist || "",
        album: this.currentMeta?.album || "",
      },
      currentCover: this.currentCover || "",
      currentCoverFull: this.currentCoverFull || "",
      duration: Number(this.duration || 0),
      currentTime: Number(this.currentTime || 0),
      rankingFor: this.rankingFor || "",
    };
  },
  saveUiSnapshot({ flushLibrary = false } = {}) {
    try {
      const libraryChanged = this._savedSnapshotTracks !== this.tracks
        || this._savedSnapshotMetadataRevision !== this._localMetadataRevision;
      const elapsed = Date.now() - Number(this._savedSnapshotLibraryAt || 0);
      const interactionIdle = !this._librarySearchComposing && !this.pendingPlaybackTransition
        && Date.now() - Number(this._lastSearchInputAt || 0) >= 300;
      const saveLibrary = libraryChanged && (flushLibrary || (interactionIdle && (this._savedSnapshotTracks !== this.tracks || elapsed >= 3000)));
      const payload = this.buildUiSnapshotPayload({ includeTracks: saveLibrary });
      if (saveLibrary) {
        if (this._uiLibrarySnapshotTimer) clearTimeout(this._uiLibrarySnapshotTimer);
        this._uiLibrarySnapshotTimer = null;
        writeStored(STORAGE_KEYS.UI_LIBRARY_SNAPSHOT, JSON.stringify({ version: 1, tracks: payload.tracks }));
        this._savedSnapshotTracks = this.tracks;
        this._savedSnapshotMetadataRevision = this._localMetadataRevision;
        this._savedSnapshotLibraryAt = Date.now();
        delete payload.tracks;
      } else if (libraryChanged && !this._uiLibrarySnapshotTimer) {
        this._uiLibrarySnapshotTimer = setTimeout(() => {
          this._uiLibrarySnapshotTimer = null;
          this.saveUiSnapshot();
        }, Math.max(300, 3000 - elapsed));
      }
      writeStored(STORAGE_KEYS.UI_SNAPSHOT, JSON.stringify(payload));
    } catch (e) {
      console.warn("保存界面快照失败", e);
    }
  },
  queueUiSnapshotSave(delay = 240) {
    if (this._uiSnapshotTimer) {
      clearTimeout(this._uiSnapshotTimer);
      this._uiSnapshotTimer = null;
    }
    this._uiSnapshotTimer = setTimeout(() => {
      this._uiSnapshotTimer = null;
      this.saveUiSnapshot();
    }, Math.max(0, Number(delay) || 0));
  },
  restoreUiSnapshot() {
    try {
      const raw = readStoredString(STORAGE_KEYS.UI_SNAPSHOT, null);
      if (!raw) return;
      const snap = JSON.parse(raw);
      if (snap && !Array.isArray(snap.tracks)) {
        snap.tracks = JSON.parse(readStoredString(STORAGE_KEYS.UI_LIBRARY_SNAPSHOT, "null"))?.tracks;
      }
      if (!snap || !Array.isArray(snap.tracks) || !snap.tracks.length) return;
      this.tracks = snap.tracks.map((t) => ({
        path: t.path,
        title: t.title || this.extractName(t.path),
        name: t.name || t.title || this.extractName(t.path),
        artist: t.artist || "",
        album: t.album || "",
        artists: Array.isArray(t.artists) ? t.artists : undefined,
        albumArtist: t.albumArtist,
        trackNumber: Number(t.trackNumber)||0,
        discNumber: Number(t.discNumber)||0,
        duration: Number(t.duration || 0),
        durationText: t.durationText || this.formatTime(t.duration || 0),
        cover: t.cover || "",
        cover_thumb: t.cover_thumb || t.cover || "",
        indexed: !!t.indexed,
        resourceId: String(t.resourceId || ""),
        songKey: String(t.songKey || ""),
        contentFingerprint: String(t.contentFingerprint || ""),
        _metaLoaded: !!t._metaLoaded,
      })).map((t) => this.prepareTrackForList(t, { buildDoc: false }));
      this.trackByPath = new Map(this.tracks.map((t) => [t.path, t]));
      this._localMetadataRevision = Number(this._localMetadataRevision || 0) + 1;
      this.rebuildTrackIdentityMaps();
      this.searchDocs = [];
      this.searchFuse = null;
      this.searchIndexReady = false;
      this.searchIndexBuilding = false;
      this.queueSearchIndexRebuild(900);
      this.currentPath = String(snap.currentPath || "");
      this.currentTrackRef = this.makeTrackReference(this.currentPath, snap.currentTrackRef || null);
      this.selectedPath = String(snap.selectedPath || snap.currentPath || "");
      this.currentPlaylist = String(snap.currentPlaylist || "all");
      this.currentMeta = {
        title: String(snap.currentMeta?.title || ""),
        artist: String(snap.currentMeta?.artist || ""),
        album: String(snap.currentMeta?.album || ""),
      };
      this.currentCover = this.pathToFile(String(snap.currentCover || ""));
      this.currentCoverFull = this.pathToFile(String(snap.currentCoverFull || snap.currentCover || ""));
      this.duration = Number(snap.duration || 0);
      this.durationText = this.formatTime(this.duration);
      this.currentTime = Number(snap.currentTime || 0);
      this.rankingFor = String(snap.rankingFor || this.currentPath || (this.tracks[0]?.path || ""));
      this.reconcilePersistentTrackReferences();
      this.buildFolderPlaylists();
      if (!this.playlists.find((p) => p.id === this.currentPlaylist)) {
        this.currentPlaylist = "all";
      }
      if (!this.selectedPath) {
        this.selectedPath = this.currentPath || (this.tracks[0]?.path || "");
      }
      this.$nextTick(() => this.refreshVirtualViewport());
    } catch (e) {
      console.warn("恢复界面快照失败", e);
    }
  },
  refreshVirtualViewport() {
    const libBody = this.$refs.libraryTableBody;
    const rankBody = this.$refs.rankingTableBody;
    let runtime = virtualViewportRuntimes.get(this);
    if (!runtime && typeof ResizeObserver === "function") {
      runtime = { observer: new ResizeObserver(() => this.refreshVirtualViewport()), library: null, ranking: null };
      virtualViewportRuntimes.set(this, runtime);
    }
    if (runtime && (runtime.library !== libBody || runtime.ranking !== rankBody)) {
      runtime.observer.disconnect();
      runtime.library = libBody;
      runtime.ranking = rankBody;
      if (libBody) runtime.observer.observe(libBody);
      if (rankBody) runtime.observer.observe(rankBody);
    }
    // Hidden pages have no layout; retain their valid viewport and scroll state.
    const libraryHeight = libBody
      ? Math.max(0, libBody.clientHeight - (Number.parseFloat(getComputedStyle(libBody).paddingTop) || 0))
      : 0;
    if (libraryHeight > 0) {
      this.libraryViewportHeight = libraryHeight;
      this.libraryScrollTop = Math.max(0, libBody.scrollTop || 0);
    }
    if (rankBody?.clientHeight > 0) {
      this.rankingViewportHeight = rankBody.clientHeight;
    }
  },
  disposeVirtualViewport() {
    virtualViewportRuntimes.get(this)?.observer.disconnect();
    virtualViewportRuntimes.delete(this);
  },
  onLibraryScroll(e) {
    const top = e?.target?.scrollTop || 0;
    this.libraryScrollTop = top;
    if (this.currentPlaylist) {
      this.playlistScrollTopMap[this.currentPlaylist] = top;
    }
    this.queueLibraryMetadataRefresh(140);
  },
  markLibraryUserInteraction() {
    this._libraryInteractionRevision = Number(this._libraryInteractionRevision || 0) + 1;
    this.queueLibraryMetadataRefresh();
  },
  queueLibraryMetadataRefresh(delay = 120) {
    const metadataPlanGeneration = Number(this._metadataPlanGeneration || 0) + 1;
    this._metadataPlanGeneration = metadataPlanGeneration;
    if (this._metadataFillTimer) {
      clearTimeout(this._metadataFillTimer);
      this._metadataFillTimer = null;
    }
    if (this._metadataPriorityTimer) {
      clearTimeout(this._metadataPriorityTimer);
      this._metadataPriorityTimer = null;
    }
    if (!this.trackByPath?.size) return;
    const loadGeneration = Number(this._trackLoadGeneration || 0);
    this._metadataPriorityTimer = setTimeout(async () => {
      this._metadataPriorityTimer = null;
      if (
        loadGeneration !== Number(this._trackLoadGeneration || 0)
        || metadataPlanGeneration !== Number(this._metadataPlanGeneration || 0)
      ) return;
      if (this._librarySearchComposing || Date.now() - Number(this._lastSearchInputAt || 0) < 300) {
        this.queueLibraryMetadataRefresh(350);
        return;
      }
      const plan = this.buildMetadataFillPlan();
      await this.fillMetadataTargets(plan.priority, loadGeneration, metadataPlanGeneration);
      if (
        loadGeneration !== Number(this._trackLoadGeneration || 0)
        || metadataPlanGeneration !== Number(this._metadataPlanGeneration || 0)
      ) return;
      if (this.view === "library" && plan.background.length) {
        this.lazyFillMeta(plan.background, 0, 12, loadGeneration, metadataPlanGeneration);
      }
    }, Math.max(40, Number(delay) || 120));
  },
  onRankingScroll(e) {
    this.rankingScrollTop = e?.target?.scrollTop || 0;
  },
  scrollLibraryToIndex(index, options = {}) {
    const body = this.$refs.libraryTableBody;
    if (index < 0) return;
    const rowHeight = Math.max(1, Number(this.libraryRowHeight) || 64);
    const viewportHeight = Math.max(
      rowHeight,
      Number(body ? body.clientHeight - (Number.parseFloat(getComputedStyle(body).paddingTop) || 0) : this.libraryViewportHeight) || rowHeight * 10,
    );
    const rowCount = Math.max(0, Number(options.rowCount) || this.filteredTracks.length || 0);
    const maxScrollTop = Math.max(0, rowCount * rowHeight - viewportHeight);
    const rawTarget = options.center
      ? (index + 0.5) * rowHeight - viewportHeight / 2
      : index * rowHeight - rowHeight * 2;
    const target = Math.max(0, Math.min(maxScrollTop, rawTarget));
    if (body) body.scrollTop = target;
    this.libraryScrollTop = target;
    if (this.currentPlaylist) {
      this.playlistScrollTopMap[this.currentPlaylist] = this.libraryScrollTop;
    }
  },
  rememberCurrentPlaylistScroll() {
    const body = this.$refs.libraryTableBody;
    if (!body || !this.currentPlaylist) return;
    this.playlistScrollTopMap[this.currentPlaylist] = body.scrollTop || 0;
  },
  restorePlaylistScroll(playlistId, smooth = false) {
    this.$nextTick(() => {
      const body = this.$refs.libraryTableBody;
      if (!body) return;
      const target = Math.max(0, Number(this.playlistScrollTopMap[playlistId]) || 0);
      if (smooth && typeof body.scrollTo === "function") {
        body.scrollTo({ top: target, behavior: "smooth" });
      } else {
        body.scrollTop = target;
      }
      this.libraryScrollTop = target;
      this.refreshVirtualViewport();
    });
  },
  applyLibraryRelocations(relocations = []) {
    const relocationMap = new Map(
      relocations
        .filter((item) => item?.from && item?.to)
        .map((item) => [String(item.from), String(item.to)])
    );
    if (!relocationMap.size) return;
    const remap = (path) => relocationMap.get(String(path || "")) || path;
    const previousCurrentPath = this.currentPath;
    this.currentPath = remap(this.currentPath);
    this.selectedPath = remap(this.selectedPath);
    this.rankingFor = remap(this.rankingFor);
    this.playHistory = (this.playHistory || []).map(remap);
    this.playHistoryRefs = (this.playHistoryRefs || []).map((reference) => ({
      ...(reference || {}),
      path: remap(reference?.path),
    }));
    writeStored(STORAGE_KEYS.PLAY_HISTORY, JSON.stringify(this.playHistory.slice(-500)));
    writeStored(STORAGE_KEYS.PLAY_HISTORY_REFS, JSON.stringify(this.playHistoryRefs.slice(-500)));
    this.customPlaylists = (this.customPlaylists || []).map((playlist) => ({
      ...playlist,
      tracks: (playlist.tracks || []).map(remap),
      trackRefs: (playlist.trackRefs || []).map((reference) => ({
        ...(reference || {}),
        path: remap(reference?.path),
      })),
    }));
    this.saveCustomPlaylists();
    const storedLastTrack = readStoredString(STORAGE_KEYS.LAST_TRACK, null);
    if (storedLastTrack && relocationMap.has(storedLastTrack)) {
      writeStored(STORAGE_KEYS.LAST_TRACK, relocationMap.get(storedLastTrack));
    } else if (previousCurrentPath && relocationMap.has(previousCurrentPath)) {
      writeStored(STORAGE_KEYS.LAST_TRACK, this.currentPath);
    }
    if (this.currentTrackRef) {
      this.currentTrackRef = { ...this.currentTrackRef, path: remap(this.currentTrackRef.path) };
    }
    const storedReference = this.readLastTrackReference();
    if (storedReference) {
      writeStored(STORAGE_KEYS.LAST_TRACK_REF, JSON.stringify({
        ...storedReference,
        path: remap(storedReference.path),
      }));
    }
    this.recCache = null;
    this.recCacheFor = null;
    this._recommendRequestId += 1;
  },
  async refreshSongList() {
    if (this.hasPendingAudioDirectoryChange()) {
      this.libraryRefreshMessage = "请先载入所选文件夹。";
      return false;
    }
    this.loading = true;
    this.libraryRefreshMessage = "正在扫描音乐目录…";
    try {
      const { data: refreshResult } = await axios.post(`${this.baseUrl}/tracks/rescan`);
      this.libraryRefreshMessage = String(refreshResult?.message || "");
      if (!refreshResult?.committed) return;
      const relocations = Array.isArray(refreshResult.relocations) ? refreshResult.relocations : [];
      this.applyLibraryRelocations(relocations);
      await this.loadTracks({ preserveView: true, relocations });
      this.buildFolderPlaylists();
      this.$nextTick(() => this.refreshVirtualViewport());
      this.queueUiSnapshotSave();
    } catch (e) {
      console.warn("刷新音乐库失败", e);
      this.libraryRefreshMessage = this.getOperationUserMessage(e, "刷新音乐库失败");
    } finally {
      this.loading = false;
    }
    return true;
  },
  async scanIndex(overwrite) {
    if(this.featureEnabled?.('recommendation')===false){this.openSettingsSection('features');return;}
    if (this.indexTaskRunning) return;
    if (overwrite) {
      const confirmed = await this.requestConfirmation({
        title: "重建推荐索引",
        message: "重新分析全部歌曲并生成新索引。",
        detail: "现有索引会保留到新索引完成，播放不受影响。",
        confirmLabel: "开始重建",
      });
      if (!confirmed) return;
    }
    this.indexTaskRunning = true;
    this._indexRequestActive = true;
    this.indexTaskStatus = { running: true, last_started_at: Date.now() / 1000, progress: { stage: "starting" } };
    this.pollIndexTaskStatus();
    try {
      await axios.post(`${this.baseUrl}/index`, { overwrite, folder: null });
      await this.loadTracks();
      this.buildFolderPlaylists();
      this.showNotice(overwrite ? "索引已重建。" : "索引已更新。");
    } catch (e) {
      console.warn("索引任务失败", e);
      this.showNotice(this.getOperationUserMessage(e, "索引失败"), "error");
    } finally {
      this._indexRequestActive = false;
      await this.pollIndexTaskStatus();
    }
  },
  async pollIndexTaskStatus() {
    if(this.featureEnabled?.('recommendation')===false)return;
    clearTimeout(this._indexStatusTimer);
    if (this._indexStatusStopped || this._indexStatusFetching) return;
    this._indexStatusFetching = true;
    try {
      const { data } = await axios.get(`${this.baseUrl}/index/status`, { timeout: 4000 });
      if (this._indexStatusStopped) return;
      const status = data?.worker_status || {};
      // The POST may still be reaching the backend on the first poll.
      if (status.running || !this._indexRequestActive) this.indexTaskStatus = status;
      this.indexTaskRunning = Boolean(status.running || this._indexRequestActive);
      this.indexTaskStatusUnavailable = false;
    } catch (_) {
      this.indexTaskStatusUnavailable = true;
    } finally {
      this._indexStatusFetching = false;
      this.indexTaskNow = Date.now();
      if (!this._indexStatusStopped && (this.indexTaskRunning || this._indexRequestActive)) {
        this._indexStatusTimer = setTimeout(() => this.pollIndexTaskStatus(), 1000);
      }
    }
  },
  indexTaskProgressText() {
    const status = this.indexTaskStatus || {};
    if (!status.last_started_at) return "";
    const progress = status.progress || {};
    const stages = { starting: "正在准备", scanning: "正在扫描歌曲", identity: "正在核对歌曲变化", embedding: "正在分析歌曲", model: "正在加载分析模型", inference: "正在使用模型分析", checkpoint: "正在保存阶段进度", publishing: "正在校验并保存索引" };
    const stage = status.running ? (stages[progress.stage] || "正在处理") : (status.last_ok ? "索引处理完成" : status.cancel_requested ? "任务已取消，旧索引保留" : "索引处理失败，旧索引保留");
    const total = Number(progress.total) || 0;
    const done = Number(progress.done) || 0;
    const elapsed = Math.max(0, Math.floor(((status.last_finished_at && !status.running ? status.last_finished_at * 1000 : this.indexTaskNow) - status.last_started_at * 1000) / 1000));
    const device = progress.device === "cuda" ? `GPU · ${progress.device_name || "显卡加速"}` : progress.device === "cpu" ? `CPU · ${progress.device_reason === "cpu_only" ? "当前计算组件不支持显卡加速" : "显卡加速不可用"}` : "正在检测计算设备";
    return [stage, total ? `${done} / ${total} 首（当前阶段 ${Math.floor(done / total * 100)}%）` : "", device,
      `复用 ${progress.reused || 0} 首 · 新分析 ${progress.embedded || 0} 首 · 失败 ${progress.failed || 0} 首`,
      `已用时 ${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒`, this.indexTaskStatusUnavailable ? "暂时无法获取最新进度，正在重连" : ""].filter(Boolean).join("；");
  },
  async updateIndex() {
    await this.scanIndex(false);
  },
  async cancelIndexTask() {
    try {
      const { data } = await axios.post(`${this.baseUrl}/index/cancel`);
      this.showNotice(data?.cancel_requested ? "正在取消，旧索引仍可使用。" : "当前没有索引任务。");
    } catch (e) {
      console.warn("取消索引任务失败", e);
      this.showNotice(this.getOperationUserMessage(e, "取消索引任务失败"), "error");
    }
  },
  async scanIndexMetaOnly() {
    this.loading = true;
    try {
      await axios.post(`${this.baseUrl}/index`, { overwrite: false, meta_only: true, folder: null });
      await this.loadTracks();
      this.buildFolderPlaylists();
      this.showNotice("元数据已刷新。");
    } catch (e) {
      console.warn("刷新元数据失败", e);
      this.showNotice(this.getOperationUserMessage(e, "刷新元数据失败"), "error");
    } finally {
      this.loading = false;
    }
  },
  buildConfigPayload() {
    const payload = JSON.parse(JSON.stringify(this.params || {}));
    payload.recommendation = payload.recommendation || {};
    const recommendation = payload.recommendation;
    recommendation.semantic_floor = clampNumberAllowZero(recommendation.semantic_floor, .90, 0, 1);
    recommendation.adjacent_mert_floor = clampNumberAllowZero(recommendation.adjacent_mert_floor, .95, 0, 1);
    recommendation.context_floor = clampNumberAllowZero(recommendation.context_floor, .86, 0, recommendation.semantic_floor);
    recommendation.candidate_limit = Math.round(clampNumberAllowZero(recommendation.candidate_limit, 80, 10, 200));
    recommendation.recent_exclusion = Math.round(clampNumberAllowZero(recommendation.recent_exclusion, 2, 1, 20));
    recommendation.allow_older_repeats = recommendation.allow_older_repeats !== false;
    delete payload.audio_dir;
    delete payload.audio_dirs;
    payload.online = payload.online || {};
    payload.history = payload.history || {};
    payload.history.no_repeat_within = clampNumberAllowZero(
      payload.history.no_repeat_within,
      100,
      0,
      1000,
    );
    payload.history.repeat_policy = String(payload.history.repeat_policy || "disallow");
    payload.history.allow_duplicates = payload.history.repeat_policy === "allow";
    payload.dislike_correction = payload.dislike_correction || {};
    const dc = payload.dislike_correction;
    dc.enabled = dc.enabled !== false;
    dc.enable_recommend_rate_fix = dc.enable_recommend_rate_fix !== false;
    dc.rec_strength = Math.max(0, Math.min(5, Number(dc.rec_strength ?? 1)));
    dc.rec_fix_min = Math.max(0.01, Math.min(10, Number(dc.rec_fix_min ?? 0.1)));
    dc.rec_fix_max = Math.max(0.01, Math.min(20, Number(dc.rec_fix_max ?? 20)));
    dc.auto_rebuild_recommend_rate = dc.auto_rebuild_recommend_rate !== false;
    dc.enable_skip_rate_fix = dc.enable_skip_rate_fix !== false;
    dc.skip_strength = Math.max(0, Math.min(5, Number(dc.skip_strength ?? 1)));
    dc.skip_fix_min = Math.max(0.01, Math.min(10, Number(dc.skip_fix_min ?? 0.33)));
    dc.skip_fix_max = Math.max(0.01, Math.min(20, Number(dc.skip_fix_max ?? 2)));
    dc.skip_smooth_k = Math.max(0, Math.min(10000, Number(dc.skip_smooth_k ?? 20)));
    dc.daily_decay = Math.max(0, Math.min(1, Number(dc.daily_decay ?? 0.98)));
    dc.consecutive_dislike_threshold = Math.max(0, Math.min(20, Math.floor(Number(dc.consecutive_dislike_threshold ?? 0))));
    dc.long_pause_reset_minutes = Math.max(0, Math.min(1440, Number(dc.long_pause_reset_minutes ?? 10)));
    payload.online.auto_index_after_seconds = Math.max(5, Math.min(600, Number(payload.online.auto_index_after_seconds) || 60));
    payload.model = payload.model || {};
    payload.model.source = String(payload.model.source || "m-a-p/MERT-v1-330M").trim();
    payload.model.local_dir = String(payload.model.local_dir || "").trim();
    return payload;
  },
  getConfigFingerprint(payload) {
    try {
      return JSON.stringify(payload || {});
    } catch {
      return "";
    }
  },
  scheduleConfigAutoSave(delay = 450) {
    if (!this._configAutoSaveReady) return;
    this.configSaveState = "pending";
    if (this._configAutoSaveSuspended) {
      this._configSaveQueued = true;
      return;
    }
    if (this._configAutoSaveTimer) clearTimeout(this._configAutoSaveTimer);
    this._configAutoSaveTimer = setTimeout(() => {
      this._configAutoSaveTimer = null;
      this.flushConfigAutoSave();
    }, Math.max(100, Number(delay) || 450));
  },
  async flushConfigAutoSave() {
    if (!this._configAutoSaveReady) return { ok: false, skipped: true };
    if (this._configAutoSaveSuspended) {
      this._configSaveQueued = true;
      this.configSaveState = "pending";
      return { ok: false, skipped: true, suspended: true };
    }
    const payload = this.buildConfigPayload();
    const fingerprint = this.getConfigFingerprint(payload);
    if (!fingerprint || fingerprint === this._lastSavedConfigFingerprint) {
      this.configSaveState = "saved";
      return { ok: true, skipped: true };
    }
    if (this._configSavePromise) {
      this._configSaveQueued = true;
      return this._configSavePromise;
    }
    this.configSaveState = "saving";
    this._configSavePromise = axios.post(`${this.baseUrl}/config`, payload)
      .then(() => {
        this._lastSavedConfigFingerprint = fingerprint;
        this.configSaveState = "saved";
        return { ok: true };
      })
      .catch((error) => {
        console.warn("自动保存配置失败", error);
        this.configSaveState = "error";
        this.showNotice(this.getOperationUserMessage(error, "设置保存失败"), "error");
        return { ok: false, error };
      })
      .finally(() => {
        this._configSavePromise = null;
        if (this._configSaveQueued) {
          this._configSaveQueued = false;
          this.scheduleConfigAutoSave(100);
        }
      });
    return this._configSavePromise;
  },
  flushConfigBeforeUnload() {
    if (!this._configAutoSaveReady) return;
    const payload = this.buildConfigPayload();
    const fingerprint = this.getConfigFingerprint(payload);
    if (!fingerprint || fingerprint === this._lastSavedConfigFingerprint) return;
    try {
      if (typeof navigator.sendBeacon === "function") {
        const body = new Blob([fingerprint], { type: "application/json" });
        if (navigator.sendBeacon(`${this.baseUrl}/config`, body)) {
          this._lastSavedConfigFingerprint = fingerprint;
          return;
        }
      }
    } catch {
      // 关闭阶段继续尝试普通请求。
    }
    if (this._configAutoSaveSuspended) {
      axios.post(`${this.baseUrl}/config`, payload).catch((error) => {
        console.warn("关闭前保存配置失败", error);
      });
      return;
    }
    this.flushConfigAutoSave();
  },
  ensureRecommendationRuntime() {
    if (!this.recommendationJobs) this.recommendationJobs=Vue.markRaw({jobs:new Map(),caches:new Map(),epoch:0});
    const rt=this.recommendationJobs;
    for (const name of ['media','preparing','reserves','failed','owners','waitingAudio','adjacency','adjacentJobs']) if(!rt[name])rt[name]=new Map();
    rt.claimed ||= new Set();
    return rt;
  },
  getAdjacentMertFloor(){return clampNumberAllowZero(this.params?.recommendation?.adjacent_mert_floor,.95,0,1);},
  getContextRecommendationReserve(intent,packet=null){
    const rt=this.ensureRecommendationRuntime(),cached=rt.caches.get(intent);
    if(!packet&&cached?.stamp===this.getRecommendationPolicyStamp()&&Date.now()-cached.at<120000)packet=cached.data;
    const saved=packet?.reserve;
    if(!saved?.diagnostic?.details?.context_reserve||saved.diagnostic.query_path!==this.currentPath||saved.diagnostic.intent!==intent)return null;
    const list=intent==='change'?'dislike_list':'like_list';
    const rows=(saved[list]||[]).filter(r=>!rt.failed.has(r.path)).map(r=>({...r}));
    const total=rows.reduce((s,r)=>s+(Number(r.probability)||0),0);
    for(const row of rows)row.probability=total?row.probability/total:1/rows.length;
    return {...saved,[list]:rows};
  },
  getChangeMertCeiling(){return clampNumberAllowZero(this.params?.dislike?.max_sim,.93,0,1);},
  filterChangeRecommendation(data){
    if(!data||data.diagnostic?.details?.fallback==='library_reserve'||recommendationPacketPending(data))return null;
    const ceiling=this.getChangeMertCeiling();
    const rows=(data.dislike_list||[]).map(r=>({...r,sim:this.getAdjacentMertSimilarity(r.path,data)}))
      .filter(r=>r.path!==this.currentPath&&r.sim>=0&&r.sim<=ceiling);
    if(!rows.length)return null;
    const sum=rows.reduce((s,r)=>s+(Number(r.probability)||Number(r.weight)||1),0);
    for(const row of rows)row.probability=(Number(row.probability)||Number(row.weight)||1)/sum;
    const selected=rows.find(r=>r.path===data.dislike_next?.path)||rows.find(r=>r.selected);
    return {...data,dislike_list:rows,dislike_next:selected||null,diagnostic:{...data.diagnostic,query_path:this.currentPath,
      details:{...data.diagnostic?.details,change_mert_ceiling:ceiling,change_verified:true}}};
  },
  getChangeRecommendationReserve(){
    const scored=this.getContextRecommendationReserve('change');if(scored)return this.filterChangeRecommendation(scored)||scored;
    return {dislike_list:[],diagnostic:{policy:'session-intent-v5',intent:'change',query_path:this.currentPath,
      details:{fallback:'context_preparing',reason:'context_preparing'}}};
  },
  getEffectiveAdjacentMertFloor(packet){
    const base=this.getAdjacentMertFloor(),details=packet?.diagnostic?.details;
    const floor=details?.adjacent_mert_floor,steps=details?.adjacent_mert_steps;
    return packet?.diagnostic?.query_path===this.currentPath&&details?.adjacent_mert_base_floor===base
      &&Number.isInteger(steps)&&steps>=0&&steps<=Math.ceil(base/.01)
      &&Number.isFinite(floor)&&floor>=0&&Math.abs(floor-Math.max(0,base-.01*steps))<1e-7?floor:base;
  },
  getAdjacentMertKey(path=this.currentPath){return JSON.stringify([path,this.recommendFullMode,this._trackLoadGeneration,this.getAdjacentMertFloor()]);},
  getAdjacentMertSimilarity(path,packet=null){
    if(path===this.currentPath)return 1;
    const rt=this.recommendationJobs;
    const cached=rt?.adjacency?.get(this.getAdjacentMertKey());
    if(cached&&Date.now()-cached.at<120000&&cached.pairs.has(path))return cached.pairs.get(path);
    for(const [key,entry]of rt?.adjacency||[])
      if(entry.origin===path&&key===this.getAdjacentMertKey(path)&&Date.now()-entry.at<120000&&entry.pairs.has(this.currentPath))return entry.pairs.get(this.currentPath);
    if(packet?.diagnostic?.query_path===this.currentPath){
      const row=[...(packet.like_list||[]),...(packet.dislike_list||[])].find(r=>r.path===path),sim=row?.sim;
      if(typeof sim==='number'&&Number.isFinite(sim)&&sim>=0&&sim<=1.000001)return sim;
    }
    return -1;
  },
  filterAdjacentRecommendation(data){
    if(!data||['library_reserve','adjacent_mert_reserve'].includes(data.diagnostic?.details?.fallback)||recommendationPacketPending(data))return null;
    const floor=this.getEffectiveAdjacentMertFloor(data);
    const rows=(data.like_list||[]).map(r=>({...r,sim:this.getAdjacentMertSimilarity(r.path,data)})).filter(r=>r.sim>=floor);
    if(!rows.length)return null;
    const total=rows.reduce((sum,r)=>sum+(Number(r.probability)||Number(r.weight)||1),0);
    for(const r of rows)r.probability=(Number(r.probability)||Number(r.weight)||1)/total;
    return {...data,like_list:rows,like_next:rows[0],diagnostic:{...data.diagnostic,query_path:this.currentPath,
      details:{...data.diagnostic?.details,adjacent_mert_floor:floor,adjacent_verified:true}}};
  },
  getAdjacentRecommendationReserve(){
    const scored=this.getContextRecommendationReserve('continue');if(scored)return this.filterAdjacentRecommendation(scored)||scored;
    const floor=this.getAdjacentMertFloor();
    return {like_list:[],diagnostic:{policy:'session-intent-v5',intent:'continue',query_path:this.currentPath,
      details:{fallback:'context_preparing',model:'pending',reason:'context_preparing',adjacent_mert_floor:floor}}};
  },
  async prepareAdjacentRecommendations(path=this.currentPath){
    if(!path||!this.useRecommend)return null;
    const rt=this.ensureRecommendationRuntime(),key=this.getAdjacentMertKey(path),saved=rt.adjacency.get(key);
    if(saved&&Date.now()-saved.at<45000)return saved;
    if(rt.adjacentJobs.has(key))return rt.adjacentJobs.get(key).promise;
    if(rt.adjacentJobs.size>=4){const [old,job]=rt.adjacentJobs.entries().next().value;job.controller.abort();rt.adjacentJobs.delete(old);}
    const controller=new AbortController(),job={controller,promise:null};rt.adjacentJobs.set(key,job);
    job.promise=(async()=>{
      try{
        const {data}=await axios.post(`${this.baseUrl}/recommend/adjacent`,{track_path:path,scope:this.recommendFullMode?'all':'local',adjacent_floor:this.getAdjacentMertFloor(),include_lower_adjacent:true},{signal:controller.signal,timeout:8000});
        if(controller.signal.aborted||key!==this.getAdjacentMertKey(path))return null;
        if(data?.policy!=='adjacent-mert-v1'||data.query_path!==path||data.floor!==0||data.base_floor!==this.getAdjacentMertFloor())throw new Error('相邻相似度服务需更新，请重启软件及后台。');
        const rows=(data.rows||[]).filter(r=>typeof r.path==='string'&&typeof r.sim==='number'&&Number.isFinite(r.sim)&&r.sim>=0&&r.sim<=1.000001);
        const entry={origin:path,rows,pairs:new Map(rows.map(r=>[r.path,r.sim])),at:Date.now(),generation:data.index_generation};
        rt.adjacency.set(key,entry);while(rt.adjacency.size>32)rt.adjacency.delete(rt.adjacency.keys().next().value);
        rt.adjacentError='';
        if(path===this.currentPath&&this.useRecommend){const safe=this.getAdjacentRecommendationReserve();rt.reserves.set('continue',safe);void this.prepareRecommendationAudio('continue',safe);const change=this.getChangeRecommendationReserve();rt.reserves.set('change',change);void this.prepareRecommendationAudio('change',change);}
        return entry;
      }catch(error){if(!controller.signal.aborted)rt.adjacentError=error?.response?.status===404?'相邻相似度服务需更新，请重启软件及后台。':error.message;return null;}
      finally{if(rt.adjacentJobs.get(key)===job)rt.adjacentJobs.delete(key);}
    })();return job.promise;
  },
  clearAdjacentRecommendations(){const rt=this.recommendationJobs;if(!rt)return;for(const job of rt.adjacentJobs?.values()||[])job.controller.abort();rt.adjacentJobs?.clear();rt.adjacency?.clear();},
  getRecommendationPreparationStamp() {
    // Display metadata does not change the prepared audio or its recommendation.
    return JSON.stringify([this.currentPath,this.playbackGeneration,this._trackLoadGeneration,this.recommendFullMode,
      this.recommendationContext?.revision,this.params?.recommendation,this.params?.similarity,this.params?.dislike,
      this.params?.audio_dir,this.params?.audio_dirs]);
  },
  seedRecommendationReserves() {
    const rt=this.ensureRecommendationRuntime(),stamp=this.getRecommendationPreparationStamp();
    if(rt.catalogue!==this.tracks||rt.catalogueRevision!==this._localMetadataRevision){
      rt.catalogue=this.tracks;rt.catalogueRevision=this._localMetadataRevision;rt.failed.clear();rt.reservesStamp='';
    }
    for(const [path,at]of rt.failed)if(Date.now()-at>180000)rt.failed.delete(path);
    if(rt.reservesStamp===stamp)return;
    rt.reservesStamp=stamp;rt.reserves.clear();
    rt.reserves.set('continue',this.getAdjacentRecommendationReserve());
    rt.reserves.set('change',this.getChangeRecommendationReserve());
    rt.reserves.set('recover',this.getContextRecommendationReserve('recover')||{like_list:[]});
    for(const intent of ['continue','recover','change'])void this.prepareRecommendationAudio(intent,rt.reserves.get(intent));
  },
  getRecommendationReserve(intent) {
    const scored=this.getContextRecommendationReserve(intent);if(scored)return scored;
    if(intent==='recover')return {like_list:[],diagnostic:{query_path:this.currentPath,intent,details:{reason:'context_preparing'}}};
    this.seedRecommendationReserves();return this.recommendationJobs?.reserves.get(intent)||null;
  },
  releasePreparedRecommendation(ticket) {
    if(!ticket)return;
    this.recommendationJobs?.claimed?.delete(ticket);
    const owners=this.recommendationJobs?.owners;
    if(ticket.element&&owners?.get(ticket.element)!==ticket)return;
    if(ticket.element&&ticket.element!==audio&&ticket.element!==naturalFade?.element&&ticket.element!==audioEngine?.tail){
      owners?.delete(ticket.element);
      if(audioEngine)audioEngine.release(ticket.element);else{ticket.element.pause();ticket.element.removeAttribute('src');ticket.element.load();}
    }
  },
  clearPreparedRecommendations() {
    const rt=this.recommendationJobs;if(!rt)return;
    clearTimeout(rt.audioRetry);rt.audioRetry=null;
    for(const ticket of rt.media?.values()||[])this.releasePreparedRecommendation(ticket);
    rt.media?.clear();
    for(const ticket of rt.preparing?.values()||[]){ticket.canceled=true;this.releasePreparedRecommendation(ticket);}
    rt.preparing?.clear();rt.waitingAudio?.clear();rt.reservesStamp='';
  },
  markRecommendationUnavailable(path) {
    const rt=this.ensureRecommendationRuntime();rt.failed.set(path,Date.now());
    while(rt.failed.size>Math.max(64,(this.tracks||[]).length+Object.keys(this.onlineTrackMap||{}).length))rt.failed.delete(rt.failed.keys().next().value);
    rt.reservesStamp='';
  },
  takePreparedRecommendation(intent) {
    const rt=this.recommendationJobs,base=this.getRecommendationPreparationStamp();
    const cached=rt?.caches?.get(intent);
    const reserve=rt?.reservesStamp===base?rt.reserves?.get(intent):null;
    const data=cached?.stamp===this.getRecommendationPolicyStamp() && Date.now()-cached.at<120000 ? cached.data
      : recommendationPacketQuality(reserve,intent)>=0?reserve:null;
    const dataQuality=recommendationPacketQuality(data,intent),listKey=intent==='change'?'dislike_list':'like_list';
    for(const ticket of [rt?.media?.get(intent),rt?.preparing?.get(intent)]){
      if(ticket&&ticket.from===audio&&ticket.base===base&&(!ticket.ready||Date.now()-ticket.at<120000)&&!rt.failed?.has(ticket.path)
          && recommendationPacketQuality(ticket.recommendationContext,intent)>=0
          &&(!data||dataQuality>=0&&recommendationPacketQuality(ticket.recommendationContext,intent)>dataQuality
            ||(data[listKey]||[]).some(row=>row.path===ticket.path))){
        if(dataQuality>=recommendationPacketQuality(ticket.recommendationContext,intent))ticket.recommendationContext=data;
        const old=rt.media.get(intent);if(old&&old!==ticket){rt.media.delete(intent);this.releasePreparedRecommendation(old);}
        if(rt.media.get(intent)===ticket)rt.media.delete(intent);
        if(rt.preparing.get(intent)===ticket)rt.preparing.delete(intent);
        rt.claimed.add(ticket);return ticket;
      }
    }
    const ticket=rt?.media?.get(intent);
    if(ticket){rt.media.delete(intent);this.releasePreparedRecommendation(ticket);}
    const path=data&&recommendationPacketQuality(data,intent)>=0?pickRecommendPathByPolicy({recCache:data},intent==='change'?'dislike_next':'like_next'):'';
    return path?{path,recommendationContext:data,ready:false,actionTicket:true,base}:null;
  },
  async prepareRecommendationAudio(intent,data) {
    if(!data||!this.useRecommend||typeof audioSlots==='undefined'||data.diagnostic?.details?.reason==='context_preparing')return null;
    if(intent==='continue')data=this.filterAdjacentRecommendation(data)||this.getAdjacentRecommendationReserve();
    if(intent==='change')data=this.filterChangeRecommendation(data)||this.getChangeRecommendationReserve();
    if(recommendationPacketPending(data))return null;
    const rt=this.ensureRecommendationRuntime(),base=this.getRecommendationPreparationStamp();
    const key=intent==='change'?'dislike_next':'like_next';
    let existing=rt.media.get(intent);
    if(intent==='continue'&&existing&&this.getAdjacentMertSimilarity(existing.path,existing.recommendationContext)<this.getEffectiveAdjacentMertFloor(existing.recommendationContext)){
      rt.media.delete(intent);this.releasePreparedRecommendation(existing);existing=null;
    }
    if(existing?.base===base&&existing.ready&&Date.now()-existing.at<120000&&!rt.failed.has(existing.path)
        && recommendationPacketQuality(existing.recommendationContext,intent)>recommendationPacketQuality(data,intent))return existing;
    const reusable=ticket=>ticket?.base===base&&!rt.failed.has(ticket.path)
      &&(!ticket.ready||Date.now()-ticket.at<120000)&&(data[key==='dislike_next'?'dislike_list':'like_list']||[]).some(row=>row.path===ticket.path);
    if(existing?.ready&&reusable(existing)){existing.recommendationContext=data;return existing;}
    const pending=rt.preparing.get(intent);
    if(reusable(pending)){pending.recommendationContext=data;return pending.promise;}
    const path=pickRecommendPathByPolicy({recCache:data},key);if(!path||rt.failed.has(path))return null;
    if(pending){pending.canceled=true;rt.preparing.delete(intent);this.releasePreparedRecommendation(pending);}
    const occupied=new Set([audio,naturalFade?.element,audioEngine?.tail,audioEngine?.releasingTail,
      ...[...rt.media.values(),...rt.preparing.values(),...rt.claimed].map(t=>t.element)]);
    const element=audioSlots.find(slot=>!occupied.has(slot));
    if(!element){
      rt.waitingAudio.set(intent,{data,base});
      if(!rt.audioRetry)rt.audioRetry=setTimeout(()=>{
        rt.audioRetry=null;const waiting=[...rt.waitingAudio];rt.waitingAudio.clear();
        for(const [intent,item]of waiting)if(this.useRecommend&&item.base===this.getRecommendationPreparationStamp())void this.prepareRecommendationAudio(intent,item.data);
      },120);
      return null;
    }
    rt.waitingAudio.delete(intent);
    const ticket={element,path,from:audio,origin:this.currentPath,playbackGeneration:this.playbackGeneration,
      base,ready:false,actionTicket:true,seconds:0,recommendationContext:data,source:key};
    rt.preparing.set(intent,ticket);rt.owners.set(element,ticket);
    const valid=()=>!ticket.canceled&&this.useRecommend&&audio===ticket.from
      &&(rt.claimed.has(ticket)?ticket.origin===this.currentPath&&ticket.playbackGeneration===this.playbackGeneration
        :rt.preparing.get(intent)===ticket&&base===this.getRecommendationPreparationStamp());
    const guard=()=>{if(!valid()){const e=new Error('预备歌曲已更新');e.code='STALE_PLAYBACK_TRANSITION';throw e;}};
    ticket.promise=(async()=>{
      try{
        element.playbackRate=audio.playbackRate||1;audioEngine?.gain(element,0);
        ticket.started=await this.startTargetAudio(path,guard,element,true);guard();
        ticket.ready=true;ticket.at=Date.now();
        if(!rt.claimed.has(ticket)){
          const prior=rt.media.get(intent);rt.media.set(intent,ticket);if(prior)this.releasePreparedRecommendation(prior);
        }
        return ticket;
      }catch(error){
        if(valid()&&error.code!=='STALE_PLAYBACK_TRANSITION'){
          this.markRecommendationUnavailable(path);
          // The failed resource is temporary availability evidence, never a user dislike.
          setTimeout(()=>{if(base===this.getRecommendationPreparationStamp())this.seedRecommendationReserves();},0);
        }
        return null;
      }finally{
        if(rt.preparing.get(intent)===ticket)rt.preparing.delete(intent);
        if(!ticket.ready&&!rt.claimed.has(ticket))this.releasePreparedRecommendation(ticket);
      }
    })();return ticket.promise;
  },
  cancelRecommendPrefetch() {
    this._recommendRequestId = Number(this._recommendRequestId || 0) + 1;
    if (this._recommendPrefetchTimer) clearTimeout(this._recommendPrefetchTimer);
    this._recommendPrefetchTimer = null;
    this.recommendationTimerResolve?.(null);
    this.recommendationTimerResolve = null;
    const runtime = this.recommendationJobs;
    if (runtime) {
      runtime.epoch++;
      for (const job of runtime.jobs.values()) job.controller.abort();
      runtime.jobs.clear();
      runtime.foreground=0;
      this.clearPreparedRecommendations?.();
    }
    this.loadingRec = false;
    this.recommendationResume = null;
    this.recommendationPreparing = false;
    this._recommendPendingPromise = null;
  },
  prepareRecommendationFeatures() {
    if(this.featureEnabled?.('recommendation')===false)return Promise.resolve(null);
    if(!this.useRecommend||!this.baseUrl)return Promise.resolve(null);
    const stamp=`${this.baseUrl}:${this.soundMapLibraryRevision}`,previous=recommendationWarmups.get(this);
    if(previous?.stamp===stamp)return previous.promise;
    const entry={stamp,promise:null};
    entry.promise=axios.post(`${this.baseUrl}/recommend/prepare`).then(({data})=>data).catch(()=>{
      if(recommendationWarmups.get(this)===entry)recommendationWarmups.delete(this);
      return null; // Formal queries retain their existing preparation/error contract.
    });
    recommendationWarmups.set(this,entry);return entry.promise;
  },
  scheduleRecommendPrefetch(delay = 80) {
    if(this.featureEnabled?.('recommendation')===false)return Promise.resolve(null);
    if(this.useRecommend)void this.prepareRecommendationFeatures();
    if (!this.currentPath || !this.useRecommend) return Promise.resolve(null);
    void this.prepareAdjacentRecommendations();
    this.seedRecommendationReserves?.();
    if (this._recommendPrefetchTimer) clearTimeout(this._recommendPrefetchTimer);
    this.recommendationTimerResolve?.(null);
    return new Promise(resolve => {
      this.recommendationTimerResolve = resolve;
      this._recommendPrefetchTimer = setTimeout(async () => {
        this._recommendPrefetchTimer = null;
        this.recommendationTimerResolve = null;
        const origin=this.currentPath, stamp=this.getRecommendationPolicyStamp();
        const waiting=this.recommendationResume;
        if(waiting&&waiting.origin===origin&&waiting.generation===this.playbackGeneration&&waiting.action===this.recommendationActionId){
          if(this.playbackIntent==='pause')this.recommendationResume=null;
          else waiting.stamp=stamp;
        }
        const intent = this.getDefaultRecommendationIntent();
        const intents = [...new Set([intent,'recover','change'])];
        const results = await Promise.allSettled(intents.map(intent=>this.prefetchRecommend({immediate:true,intent,background:true,force:true})));
        const primary = results[0].status==='fulfilled' ? results[0].value : null;
        resolve(primary);
        if (origin===this.currentPath && stamp===this.getRecommendationPolicyStamp() && this.useRecommend)
          this.scheduleRecommendPrefetch(['building','unavailable'].includes(primary?.diagnostic?.details?.semantic_status) ? 1500 : primary ? 45000 : 3000);
      }, Math.max(0, Number(delay) || 0));
    });
  },
  async prefetchRecommend(options = {}) {
    if(this.featureEnabled?.('recommendation')===false)return null;
    if (!options.immediate) return this.scheduleRecommendPrefetch(options.delay);
    if (!this.currentPath || !this.useRecommend) return null;
    if (!this.recommendationJobs) this.recommendationJobs = Vue.markRaw({ jobs: new Map(), caches: new Map(), epoch: 0 });
    const runtime = this.recommendationJobs;
    const path = this.currentPath, stamp = this.getRecommendationPolicyStamp();
    const intent = options.intent || this.getDefaultRecommendationIntent();
    if (!options.background) this.recommendationRequestError="";
    const cached = runtime.caches.get(intent);
    if (cached?.stamp === stamp && !options.force && Date.now()-cached.at < 120000) {
      if (!options.background) { this.recCache = cached.data; this.recCacheFor = path; this.recCacheStamp = stamp; this.recCacheAt = cached.at; }
      return cached.data;
    }
    const jobKey = JSON.stringify([path, stamp, intent]);
    for(const [key,pending]of runtime.jobs)if(pending.stamp!==stamp){pending.controller.abort();runtime.jobs.delete(key);}
    if (runtime.jobs.has(jobKey)) {
      const pending=runtime.jobs.get(jobKey), joinEpoch=runtime.epoch;
      if(!options.background) { runtime.foreground=(runtime.foreground||0)+1; this.loadingRec=true; }
      let data;
      try { data=await pending.promise; }
      finally {
        if(!options.background && runtime.epoch===joinEpoch) {
          runtime.foreground=Math.max(0,(runtime.foreground||0)-1);this.loadingRec=runtime.foreground>0;
        }
      }
      if(!data && pending.error && !options.background && stamp===this.getRecommendationPolicyStamp())
        this.recommendationRequestError=pending.error;
      if (data && !options.background && stamp === this.getRecommendationPolicyStamp()) {
        this.recCache=data; this.recCacheFor=path; this.recCacheStamp=stamp; this.recCacheAt=Date.now();
      }
      return data;
    }
    const controller = new AbortController(), epoch = runtime.epoch;
    const valid = () => !controller.signal.aborted && runtime.epoch === epoch && this.useRecommend
      && this.currentPath === path && this.getRecommendationPolicyStamp() === stamp;
    const pause = ms => new Promise(resolve => {
      const done = () => { clearTimeout(timer); controller.signal.removeEventListener("abort",done); resolve(); };
      const timer=setTimeout(done,ms); controller.signal.addEventListener("abort",done,{once:true});
    });
    const scope = this.recommendFullMode ? "all" : "local";
    const history = this.getRecommendHistoryWindow();
    const payload = {track_path:path,history,history_fallback:this.getRecommendHistoryPolicy().allowDuplicates?"relax":"strict",
      scope,...this.getRecommendationRequestContext(intent)};
    const signal = controller.signal;
    const job = {controller, promise:null, stamp};
    runtime.jobs.set(jobKey,job);
    job.promise = Promise.resolve().then(async () => {
      if (!options.background) { runtime.foreground=(runtime.foreground||0)+1; this.loadingRec=true; }
      try {
        const deadline=Date.now()+30000;
        let data, transientRetries=0;
        const httpOptions=()=>({signal,timeout:Math.max(1,Math.min(12000,deadline-Date.now()))});
        do {
          try {
            data=(await axios.post(`${this.baseUrl}/recommend`,payload,httpOptions())).data;
          } catch(error) {
            if(!valid()) return null;
            const changed=error?.response?.status===409;
            const transient=["ECONNABORTED","ERR_NETWORK"].includes(error?.code) || error?.response?.status===503;
            if(Date.now()>=deadline || (!changed && (!transient || transientRetries++>=2))) throw error;
            await pause(changed?300:500); continue;
          }
          if(!valid()) return null;
          if(!recommendationPacketPending(data)) break;
          if(Date.now()>=deadline) { const error=new Error("歌曲关联数据仍在准备，将继续后台尝试。"); error.code="RECOMMEND_BUILDING"; throw error; }
          await pause(700);
        } while(valid());
        if(!valid()) return null;
        if(!data?.missing && (data?.diagnostic?.policy!=="session-intent-v5"||data?.diagnostic?.details?.policy_build!=="context-guard-v5")) {
          const error=new Error("推荐服务仍是旧版本，请重新启动软件及后台服务。");error.code="RECOMMEND_POLICY_OLD";throw error;
        }
        // An empty completed result stays distinct from an unfinished computation; never replace its diagnosis with a placeholder.
        runtime.caches.set(intent,{stamp,data,at:Date.now()});
        void this.prepareRecommendationAudio?.(intent,data);
        this.recommendationPreparing=false;
        const resume=this.recommendationResume;
        if(resume && resume.intent===intent && resume.origin===path && resume.stamp===stamp
          && resume.generation===this.playbackGeneration && resume.action===this.recommendationActionId) {
          this.recommendationResume=null;
          setTimeout(()=>{
            if(valid() && resume.generation===this.playbackGeneration && resume.action===this.recommendationActionId&&this.playbackIntent!=='pause')
              void tryPlayRecommendWithFallback(this,resume.key||"like_next",true,resume.trigger||"natural",null,resume.previousEvidence);
          },0);
        }
        if(!options.background || intent===this.getDefaultRecommendationIntent()) {
          this.recCache=data||{};this.recCacheFor=path;this.recCacheStamp=stamp;this.recCacheAt=Date.now();
          this.log={like_list:data?.like_list||[],dislike_list:data?.dislike_list||[],dislike_debug:data?.dislike_debug||{},stats:data?.stats||{}};
          this.recommendationRequestError="";
          this.soundMapTraceRevision++;
        }
        return data;
      } catch(error) {
        if(valid()) {
          job.error=error.code?.startsWith("RECOMMEND_")?error.message:"推荐暂时不可用，请稍后再试。";
          if(!options.background) this.recommendationRequestError=job.error;
          void this.prepareRecommendationAudio?.(intent,this.getRecommendationReserve?.(intent));
          if(error.code==="RECOMMEND_BUILDING") { this.recommendationPreparing=true; this.scheduleRecommendPrefetch(1500); }
        }
        return null;
      } finally {
        if(runtime.jobs.get(jobKey)===job) runtime.jobs.delete(jobKey);
        const waiting=this.recommendationResume;
        if(this.useRecommend&&this.currentPath===path&&waiting?.origin===path
            &&waiting.generation===this.playbackGeneration&&waiting.action===this.recommendationActionId
            &&waiting.stamp!==this.getRecommendationPolicyStamp()){
          if(this.playbackIntent==='pause')this.recommendationResume=null;
          else void this.scheduleRecommendPrefetch(80);
        }
        if(!options.background && runtime.epoch===epoch) {
          runtime.foreground=Math.max(0,(runtime.foreground||0)-1);this.loadingRec=runtime.foreground>0;
        }
      }
    });
    return job.promise;
  },
};

const listeningHistoryMethods = {
  ensureRecommendationActivation() {
    if(this.featureEnabled?.('recommendation')===false || !this.currentPath || !readStoredBool('lx-recommendation-suspended',false))return;
    this.recommendationContext=window.RecommendationContext.fresh(this.makeTrackReference(this.currentPath),Number(this.recommendationContext?.revision||0)+1);
    this.continuityRecent=[];
    // Save the new context before clearing the marker. Interrupted persistence
    // can safely reset again without publishing pre-disable references.
    writeStored('lx-recommendation-context-v2',JSON.stringify(this.recommendationContext));
    writeStored('lx-continuity-recent','[]');
    writeStored('lx-recommendation-suspended','0');
  },
  getDefaultRecommendationIntent() {
    this.ensureRecommendationActivation?.();
    // A failed restore can leave the already rejected song playing; keep its existing repair.
    const key=window.RecommendationContext.key(this.makeTrackReference(this.currentPath));
    return key&&(this.recommendationContext?.blocked||[]).some(ref=>window.RecommendationContext.key(ref)===key)
      ? "recover" : "continue";
  },
  getRecommendationRequestContext(intent) {
    this.ensureRecommendationActivation?.();
    const reference = this.makeTrackReference(this.currentPath);
    const key=window.RecommendationContext.key(reference);
    const rejected=(this.recommendationContext?.blocked||[]).some(ref=>window.RecommendationContext.key(ref)===key);
    const predicted = intent === 'recover'&&!rejected ? window.RecommendationContext.repair(this.recommendationContext,reference) : this.recommendationContext;
    const request = window.RecommendationContext.request(predicted,reference,intent);
    const resolve = refs => refs.map(ref => {
      const path = this.resolveTrackReference(ref, ref.path);
      return path;
    }).filter(Boolean);
    const cooldown = Math.max(1, Math.min(20, Number(this.params?.recommendation?.recent_exclusion) || 2));
    return { intent, context_paths: resolve(request.anchors), excluded_paths: resolve(request.excluded || []), recent_paths: resolve(request.recent),
      protected_paths: resolve((request.cooldown?.length ? request.cooldown : this.playHistoryRefs || []).slice(-cooldown)),
      unavailable_paths: [...(this.recommendationJobs?.failed?.keys() || [])],
      blocked_paths: resolve(request.blocked), session_context: {
        origin_path:predicted.origin?resolve([predicted.origin])[0]||'':'',qualified:predicted.qualified,
        repair_active:!!predicted.repair,route_paths:resolve(predicted.route||[]),
        direction_paths: resolve(request.direction || []), direction_strength: request.directionStrength,
        negatives: (request.negatives || []).map(n => ({path: resolve([n.track])[0] || '', positive_paths: resolve(n.positive)})),
        memories: (request.memories || []).map(m => ({paths: resolve(m.refs), strength: m.strength})),
        played_paths: resolve(request.plays || []),
        repeat_flags: (request.outcomes || []).filter(o => o.automatic).map(o => !!o.repeated).slice(-19),
      } };
  },
  commitRecommendationContext(path, source, previous, duration, decision = null) {
    if(this.featureEnabled?.('recommendation')===false){writeStored('lx-recommendation-suspended','1');return;}
    const evidence = previous ? { reference: this.makeTrackReference(previous.path, previous),
      duration, listenedSeconds: previous.listenedSeconds, creditedMediaSeconds: previous.creditedMediaSeconds,
      rejected: previous.dislikeHandled } : {};
    evidence.resetDirection=decision?.diagnostic?.details?.recovery_reference_missing===true
      && decision?.diagnostic?.details?.effective_intent==='change';
    const earlier = [...(this.playHistoryRefs || [])];
    if (window.RecommendationContext.key(earlier.at(-1)) === window.RecommendationContext.key(this.makeTrackReference(path))) earlier.pop();
    evidence.targetPreviouslyPlayed = earlier.slice(-100).some(ref => window.RecommendationContext.key(ref) === window.RecommendationContext.key(this.makeTrackReference(path)));
    this.recommendationContext = window.RecommendationContext.commit(this.recommendationContext,
      this.makeTrackReference(path), source, evidence);
    writeStored("lx-recommendation-context-v2", JSON.stringify(this.recommendationContext));
    this.cancelRecommendPrefetch();
    const details = this.recCache?.diagnostic?.details;
    if (["like_next","dislike_next"].includes(source) && this.recCacheFor === previous?.path
        && ["older_repeat","expanded_older_repeat"].includes(details?.fallback)) this.showNotice("为保持当前感觉，已选择较早听过的歌曲。");
  },
  getContinuityRecentPaths() {
    const recent = this.continuityRecent || [];
    const seen = new Set([this.currentPath]);
    const paths = [];
    for (let i = recent.length - 1; i >= 0 && paths.length < 3; i--) {
      const item = recent[i];
      const path = this.resolveTrackReference(item, item.path) || item.path;
      if (!path || seen.has(path)) continue;
      seen.add(path);
      if (!item.rejected) paths.unshift(path);
    }
    return paths;
  },
  rememberContinuityTrack(path, rejected = false) {
    if(this.featureEnabled?.('recommendation')===false)return;
    const recent = this.continuityRecent || [];
    if (rejected && recent.at(-1)?.path === path) recent[recent.length - 1] = { ...recent.at(-1), rejected: true };
    else recent.push({ ...this.makeTrackReference(path), rejected });
    this.continuityRecent = recent.slice(-8);
    try { writeStored("lx-continuity-recent", JSON.stringify(this.continuityRecent)); } catch (_) {}
  },
  getRecommendationPolicyStamp() {
    this.ensureRecommendationActivation?.();
    return JSON.stringify([this.currentPath, this.recommendFullMode, this._trackLoadGeneration,
      this.params?.similarity, this.params?.dislike, this.params?.history, this.params?.dislike_correction,
      this.params?.audio_dir, this.listeningHistory?.recommendationBehaviorSummary?.updatedAt,
      this.getRecommendHistoryWindow(), this.getContinuityRecentPaths(), this.params?.recommendation,
      this.recommendationContext]);
  },
  saveRecommendationDiagnostics() {
    try { writeStored("lx-recommendation-diagnostics", JSON.stringify(this.recommendationDiagnostics)); } catch (_) {}
  },
  beginRecommendationDiagnostic(path, source, context, trigger = source) {
    if(this.featureEnabled?.('recommendation')===false)return '';
    const seed = this.playlists?.find(p => p.id === this.currentPlaylist && p.type === "seed");
    if (source === "prefetch") return "";
    const recommended = ["like_next", "dislike_next"].includes(source);
    const fallback = this.useRecommend && ["like_fallback", "dislike_fallback", "ended_fallback", "next"].includes(source);
    const manual = !seed && !recommended && !fallback;
    const cache = manual || seed ? {} : context || (this.hasFreshRecCache() ? this.recCache : null) || {};
    const dislike = source.startsWith("dislike");
    const list = dislike ? cache.dislike_list : cache.like_list;
    const candidates = Array.isArray(list) ? list.filter(item => item?.path) : [];
    const rank = candidates.findIndex(item => item.path === path);
    const item = candidates[rank];
    const scoreKeys=["sim","sim_secondary","semantic_similarity","local_semantic_similarity","intent_similarity","bridge_similarity","audio_score","audio_primary","mert_adjustment","bridge_penalty","recent_reward","repeat_penalty","next_available","recording_group_size","suitability","probability","continuity_reward","recent_similarity","rec_rate","rec_norm","rec_fix","skip_rate","skip_norm","skip_fix","skip_opportunities","skip_count","weight","correction_fix","direction","tag_similarity","tag_adjustment","direction_similarity","direction_adjustment","negative_penalty","old_direction_penalty"];
    const numericScores=row=>Object.fromEntries(scoreKeys.filter(key=>typeof row?.[key]==="number"&&Number.isFinite(row[key])).map(key=>[key,row[key]]));
    const stats=cache.stats||{};
    let probability = null;
    if (item) {
      if (dislike || cache.diagnostic?.policy === "session-intent-v5") probability = Number(item.probability) || null;
      else {
        const weights = candidates.map((r, i) => Math.max(1, Math.min(1.25, Number(r.continuity_reward) || 1)) / (i + 1));
        probability = weights[rank] / weights.reduce((a, b) => a + b, 0);
      }
    } else if (cache?.[source]?.path === path) probability = 1;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const entry = {
      id, at: Date.now(), source, trigger, status: "selected", from: this.makeTrackReference(this.currentPath),
      target: this.makeTrackReference(path), title: this.extractName(path),
      requestId: cache.diagnostic?.request_id || "", policy: seed ? (this.playMode === "shuffle" ? "seed-shuffle" : `seed-sequence-v${seed.seedPolicy || 1}`) : manual ? "manual-or-list" : cache.diagnostic?.policy || "legacy",
      intent: cache.diagnostic?.intent || null, policyDetails: cache.diagnostic?.details || null,
      contextReferences: (cache.diagnostic?.context_paths || []).map(path => this.makeTrackReference(path)),
      indexGeneration: cache.diagnostic?.index_generation || "", scope: cache.diagnostic?.scope || (this.recommendFullMode ? "all" : "local"),
      parameters: cache.diagnostic?.parameters || JSON.parse(JSON.stringify({recommendation:this.params?.recommendation,similarity:this.params?.similarity,dislike:this.params?.dislike,history:this.params?.history,dislike_correction:this.params?.dislike_correction})), historyCount: this.getRecommendHistoryWindow().length,
      candidateCount: seed ? seed.tracks.length : manual ? null : candidates.length, probability, similarity: item?.sim ?? null,
      selectedRank:rank>=0?rank+1:null,repeatedRecommendation:item?.is_repeat===true,selectedScores:item?numericScores(item):null,
      evidence:item?.evidence||null,recordingMembers:item?.recording_members||null,
      admission:item?{stage:item.admission_stage||null,expansion:item.admission_expansion??null,
        floor:item.admission_floor??null,cycleExit:!!item.cycle_exit}:null,
      poolStats:Object.fromEntries(["total_candidates","like_pool","dislike_pool","weighted_dislike_pool","history_fallback_policy","like_fallback_level","like_next_out_of_range"].filter(key=>stats[key]!==undefined).map(key=>[key,stats[key]])),
      candidateSample:candidates.slice(0,5).map((row,i)=>({track:this.makeTrackReference(row.path),rank:i+1,scores:numericScores(row)})),
      consecutiveDislikeCount:Number(this.consecutiveDislikeCount)||0,
      sampling:{mode:dislike?(cache.diagnostic?.policy === "session-intent-v5" ? "direction-balanced-bounded-correction" : cache.dislike_debug?.fallbackLevel||null):manual||seed?null:cache.diagnostic?.policy === "session-intent-v5" ? "quality-balanced-repeat-budget-v1" : "harmonic-rank-rolling-support-v1",
        totalWeight:dislike?cache.dislike_debug?.totalWeight??null:null,
        recommendationRateStatus:cache.dislike_debug?.recommendRateStatus||null},
      recent: (cache.diagnostic?.policy === "session-intent-v5" ? cache.diagnostic.recent_paths || [] : this.getContinuityRecentPaths()).map(p => this.makeTrackReference(p)),
      feedbackUpdatedAt: cache.dislike_debug?.skipRateUpdatedAt || 0,
      continuityReward: item?.continuity_reward ?? 1,
      fallback: seed ? "seed_path" : manual ? "manual_or_list" : cache.missing ? "missing_index" : dislike ? (cache.diagnostic?.details?.fallback || (rank >= 0 ? "strict" : cache.dislike_next?.path === path ? "farthest_out_of_range" : "playlist")) : cache.stats?.like_fallback_level || (rank >= 0 ? "strict" : "playlist"),
      attemptId: "", started: false, listenedSeconds: 0, rejected: false,
    };
    this.recommendationDiagnostics = [...(this.recommendationDiagnostics || []), entry].slice(-80);
    this.saveRecommendationDiagnostics();
    return id;
  },
  finishRecommendationDiagnostic(id, status, details = {}) {
    if (!id) return;
    const item = (this.recommendationDiagnostics || []).find(r => r.id === id);
    if (!item) return;
    Object.assign(item, details, { status, updatedAt: Date.now() });
    this.saveRecommendationDiagnostics();
  },
  formatRecommendationDecision(item) {
    const status = { selected: "准备播放", playing: "播放成功", paused: "已暂停", ended: "已结束", rejected: "已跳过", failed: "播放失败", canceled: "已取消", interrupted: "上次运行未结算" }[item.status] || "待确认";
    const fallback = { strict:"优先范围内",quality_balanced:"同感觉兼顾新歌与重听",continuity_reserve:"扩大范围保持续播",library_reserve:"曲库备用续播",older_repeat:"较早重听",same_direction_expansion:"同方向近邻扩展",connected_neighbourhood:"沿关联邻域继续寻找",expanded_older_repeat:"扩展范围内较早重听",seed_path:"连续路径",nearest_out_of_range:"区间为空，最近候选",farthest_out_of_range:"区间为空，远向候选",ignore_history:"允许重复回退",missing_index:"歌曲未建立推荐索引",manual_or_list:"自主选歌或列表播放",empty:"列表回退",playlist:"列表回退" }[item.fallback] || "列表回退";
    const trigger = { natural:"自然接歌",like_button:"相似下一首",next_button:"下一首",dislike_button:"换个感觉",manual_rejection:"手动歌曲反馈",seed_path:"复合种子",manual:"手动播放",previous:"上一首",playlist_next:"列表接歌" }[item.trigger] || "切歌";
    return `${trigger} · ${item.rejected ? "已跳过" : status}${item.candidateCount != null ? ` · 候选 ${item.candidateCount}` : ""} · ${fallback}${item.probability != null ? ` · 概率 ${(item.probability * 100).toFixed(2)}%` : ""} · 已听 ${Math.round(item.listenedSeconds || 0)} 秒`;
  },
  getEmptyListeningHistory() {
    return {
      version: LISTENING_HISTORY_VERSION,
      updatedAt: 0,
      totalSeconds: 0,
      totalPlays: 0,
      tracks: {},
      days: {},
      recommendationBehaviorSummary: {
        version: 1,
        updatedAt: 0,
        updatedDay: "",
        globalSkipRate: 0,
        totalSkipOpportunityCount: 0,
        totalDislikeChainSkipCount: 0,
        dailyDecay: 0.98,
      },
    };
  },
  getEmptyRecommendationBehavior(path = "") {
    return {
      resourceId: "",
      songKey: "",
      skipOpportunityCount: 0,
      dislikeChainSkipCount: 0,
      lastSkipAt: 0,
      lastOpportunityAt: 0,
      smoothedSkipRate: 0,
      skipNorm: 1,
      skipFix: 1,
      skipStatsUpdatedAt: 0,
      path,
    };
  },
  normalizeRecommendationBehavior(raw, path = "") {
    const base = this.getEmptyRecommendationBehavior(path);
    const src = raw && typeof raw === "object" ? raw : {};
    return {
      ...base,
      resourceId: String(src.resourceId || ""),
      songKey: String(src.songKey || ""),
      skipOpportunityCount: Math.max(0, Number(src.skipOpportunityCount || 0)),
      dislikeChainSkipCount: Math.max(0, Number(src.dislikeChainSkipCount || 0)),
      lastSkipAt: Math.max(0, Number(src.lastSkipAt || 0)),
      lastOpportunityAt: Math.max(0, Number(src.lastOpportunityAt || 0)),
      smoothedSkipRate: Math.max(0, Number(src.smoothedSkipRate || 0)),
      skipNorm: Math.max(0, Number(src.skipNorm || 1)),
      skipFix: Math.max(0, Number(src.skipFix || 1)),
      skipStatsUpdatedAt: Math.max(0, Number(src.skipStatsUpdatedAt || 0)),
      path,
    };
  },
  normalizeListeningHistory(raw) {
    const base = this.getEmptyListeningHistory();
    const src = raw && typeof raw === "object" ? raw : {};
    const tracks = {};
    Object.entries(src.tracks || {}).forEach(([storedKey, item]) => {
      if (!storedKey || !item || typeof item !== "object") return;
      const sourcePath = String(item.path || storedKey || "");
      const reference = {
        resourceId: String(item.resourceId || item.recommendationBehavior?.resourceId || ""),
        songKey: String(item.songKey || item.recommendationBehavior?.songKey || ""),
        path: sourcePath,
      };
      const path = this.resolveTrackReference(reference, sourcePath) || sourcePath;
      if (!path) return;
      const currentReference = this.makeTrackReference(path, reference);
      const normalizedBehavior = this.normalizeRecommendationBehavior(item.recommendationBehavior, path);
      normalizedBehavior.resourceId = currentReference.resourceId;
      normalizedBehavior.songKey = currentReference.songKey || normalizedBehavior.songKey;
      const normalized = {
        path,
        resourceId: currentReference.resourceId,
        songKey: currentReference.songKey,
        title: String(item.title || this.extractName(path)),
        artist: String(item.artist || ""),
        album: String(item.album || ""),
        duration: Math.max(0, Number(item.duration || 0)),
        playCount: Math.max(0, Math.floor(Number(item.playCount || 0))),
        listenedSeconds: Math.max(0, Number(item.listenedSeconds || 0)),
        lastPlayedAt: Math.max(0, Number(item.lastPlayedAt || 0)),
        lastCountedAt: Math.max(0, Number(item.lastCountedAt || 0)),
        recommendationBehavior: normalizedBehavior,
      };
      const existing = tracks[path];
      if (!existing) {
        tracks[path] = normalized;
        return;
      }
      existing.playCount += normalized.playCount;
      existing.listenedSeconds += normalized.listenedSeconds;
      existing.lastPlayedAt = Math.max(existing.lastPlayedAt, normalized.lastPlayedAt);
      existing.lastCountedAt = Math.max(existing.lastCountedAt, normalized.lastCountedAt);
      existing.duration = Math.max(existing.duration, normalized.duration);
      existing.recommendationBehavior.skipOpportunityCount += normalizedBehavior.skipOpportunityCount;
      existing.recommendationBehavior.dislikeChainSkipCount += normalizedBehavior.dislikeChainSkipCount;
      existing.recommendationBehavior.lastSkipAt = Math.max(
        existing.recommendationBehavior.lastSkipAt,
        normalizedBehavior.lastSkipAt
      );
      existing.recommendationBehavior.lastOpportunityAt = Math.max(
        existing.recommendationBehavior.lastOpportunityAt,
        normalizedBehavior.lastOpportunityAt
      );
    });
    const days = {};
    Object.entries(src.days || {}).forEach(([day, seconds]) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
      const value = Math.max(0, Number(seconds || 0));
      if (value > 0) days[day] = value;
    });
    const totalSeconds = Object.values(days).reduce((sum, v) => sum + Number(v || 0), 0);
    const totalPlays = Object.values(tracks).reduce((sum, it) => sum + Number(it.playCount || 0), 0);
    const rawSummary = src.recommendationBehaviorSummary && typeof src.recommendationBehaviorSummary === "object" ? src.recommendationBehaviorSummary : {};
    const recommendationBehaviorSummary = {
      version: Math.max(1, Math.floor(Number(rawSummary.version) || 1)),
      exposurePolicySince: Math.max(0, Number(rawSummary.exposurePolicySince) || 0),
      updatedAt: Math.max(0, Number(rawSummary.updatedAt || 0)),
      updatedDay: String(rawSummary.updatedDay || ""),
      globalSkipRate: Math.max(0, Number(rawSummary.globalSkipRate || 0)),
      totalSkipOpportunityCount: Math.max(0, Number(rawSummary.totalSkipOpportunityCount || 0)),
      totalDislikeChainSkipCount: Math.max(0, Number(rawSummary.totalDislikeChainSkipCount || 0)),
      dailyDecay: Math.max(0, Math.min(1, Number(rawSummary.dailyDecay || 0.98))),
    };
    return {
      ...base,
      version: LISTENING_HISTORY_VERSION,
      persistenceRevision: Math.max(0, Number(src.persistenceRevision || 0)),
      updatedAt: Math.max(0, Number(src.updatedAt || 0)),
      totalSeconds: totalSeconds || Math.max(0, Number(src.totalSeconds || 0)),
      totalPlays,
      tracks,
      days,
      recommendationBehaviorSummary,
    };
  },
  async loadListeningHistory() {
    if(this.featureEnabled?.('history')===false && this.featureEnabled?.('recommendation')===false)return;
    if (this.listeningHistoryLoaded || this.listeningHistoryLoading) return;
    if (!window.lxEnv || typeof window.lxEnv.getListeningHistory !== "function") return;
    this.listeningHistoryLoading = true;
    try {
      const [data, status] = await Promise.all([
        window.lxEnv.getListeningHistory(),
        typeof window.lxEnv.getListeningHistoryStatus === "function"
          ? window.lxEnv.getListeningHistoryStatus()
          : Promise.resolve({}),
      ]);
      this.listeningHistory = this.normalizeListeningHistory(data || {});
      this.listeningHistoryLoaded = !status?.writeBlocked;
      this.listeningHistoryRecoveryStatus = status && typeof status === "object" ? status : {};
      if (status?.state === "recovered") {
        const skipped = Array.isArray(status.invalidBackups) && status.invalidBackups.length
          ? `，跳过 ${status.invalidBackups.length} 个损坏备份`
          : "";
        const archive = status.corruptArchive ? "，损坏主文件已保留" : "";
        const warning = status.warning ? "；恢复结果尚未保存，请先备份用户数据" : "";
        const source = status.sourceDay ? `${status.sourceDay} 的备份` : "最近备份";
        this.listeningHistoryMessage = `听歌历史已从${source}恢复${skipped}${archive}${warning}`;
      } else if (status?.state === "unrecoverable") {
        const archive = status.corruptArchive ? "，损坏主文件已保留" : "";
        this.listeningHistoryMessage = `听歌历史和备份均无法读取，已停止自动写入${archive}。请先备份用户数据再手动恢复。`;
      } else if (status?.warning) {
        this.listeningHistoryMessage = "听歌历史维护失败，请先备份用户数据再重试。";
      }
      this.updateSkipRateSummaryIfNeeded({ force: true });
    } catch (e) {
      console.warn("读取听歌历史失败", e);
      this.listeningHistoryMessage = "听歌记录读取失败，已保留当前记录并停止保存，请重新打开软件重试。";
    } finally {
      this.listeningHistoryLoading = false;
    }
  },
  saveListeningHistoryNow() {
    if(this.featureEnabled?.('history')===false && this.featureEnabled?.('recommendation')===false)return Promise.resolve({ok:true,skipped:true});
    if (this._listeningHistorySaveTimer) {
      clearTimeout(this._listeningHistorySaveTimer);
      this._listeningHistorySaveTimer = null;
    }
    if (this._listeningHistoryMaxSaveTimer) {
      clearTimeout(this._listeningHistoryMaxSaveTimer);
      this._listeningHistoryMaxSaveTimer = null;
    }
    if (!window.lxEnv || typeof window.lxEnv.setListeningHistory !== "function") {
      return Promise.resolve({ ok: false, error: "听歌历史持久化接口不可用" });
    }
    if (!this.listeningHistoryLoaded) return Promise.resolve({ ok: false, error: "听歌记录尚未成功读取，禁止覆盖" });
    this.listeningHistory.updatedAt = Date.now();
    let payload;
    try { payload = this.toPlainListeningHistory(this.listeningHistory); } catch (error) {
      this.listeningHistoryMessage = "听歌记录暂时无法保存，现有文件已保留。";
      return Promise.resolve({ ok: false, error: String(error.message || error) });
    }
    return window.lxEnv.setListeningHistory(payload)
      .then((result) => {
        if (!result?.ok) this.listeningHistoryMessage = result?.error || "听歌记录保存失败，现有文件已保留。";
        if (result?.warning) console.warn("听歌历史备份警告", result.warning);
        return result;
      })
      .catch((e) => {
        console.warn("保存听歌历史失败", e);
        return { ok: false, error: String(e?.message || e || "保存听歌历史失败") };
      });
  },
  async prepareListeningHistoryQuit() {
    if (window.__flowaveStartupError) return { ok: true, skipped: "initialization-incomplete" };
    this.listeningHistoryClosing = true;
    clearTimeout(soundMapArchiveTimer);clearTimeout(soundMapRetryTimer);
    this.cancelNaturalCrossfade();
    audioEngine?.stopTail(audio);
    clearTimeout(audioSettingsSaveTimer);
    if (AudioEffects) writeStored("lx-audio-effects", JSON.stringify(this.audioEffects));
    await this.flushListeningSession("quit", { deferSave: true });
    await this.drainSoundMapEvents();
    return this.saveListeningHistoryNow();
  },
  toPlainListeningHistory(raw) {
    if (!raw || !raw.tracks || !raw.days) throw new Error("听歌记录结构异常，禁止写入");
    const tracks = {};
    for (const [key, track] of Object.entries(raw.tracks)) {
      tracks[key] = { ...track, recommendationBehavior: { ...track.recommendationBehavior } };
    }
    return {
      version: raw.version,
      persistenceRevision: Number(raw.persistenceRevision || 0),
      updatedAt: raw.updatedAt,
      totalSeconds: raw.totalSeconds,
      totalPlays: raw.totalPlays,
      tracks,
      days: { ...raw.days },
      recommendationBehaviorSummary: { ...raw.recommendationBehaviorSummary },
    };
  },
  setListeningHistoryQuery() {  },
  changeListeningHistoryPage() {  },
  queueListeningHistorySave(delay = 1000) {
    if(this.featureEnabled?.('history')===false && this.featureEnabled?.('recommendation')===false)return;
    if (this._listeningHistorySaveTimer) {
      clearTimeout(this._listeningHistorySaveTimer);
      this._listeningHistorySaveTimer = null;
    }
    this._listeningHistorySaveTimer = setTimeout(() => {
      this._listeningHistorySaveTimer = null;
      this.saveListeningHistoryNow();
    }, Math.max(100, Number(delay) || 1000));
    if (!this._listeningHistoryMaxSaveTimer) {
      this._listeningHistoryMaxSaveTimer = setTimeout(() => {
        this._listeningHistoryMaxSaveTimer = null;
        this.saveListeningHistoryNow();
      }, LISTENING_HISTORY_MAX_SAVE_DELAY_MS);
    }
  },
  beginListeningSession(path, { feedbackContinuation = null, source = "resume", diagnosticId = "" } = {}) {
    if (!path || this.listeningHistoryClosing) return;
    const now = Date.now();
    const reference = this.makeTrackReference(path);
    const tracePrior=feedbackContinuation?(feedbackContinuation.traceRow || this.soundMapTrace.find(row=>row.attemptId===feedbackContinuation.attemptId)):null;
    this.listeningSession = {
      traceBaseWall:Number(tracePrior?.listenedSeconds)||0,
      traceBaseMedia:Number(tracePrior?.creditedMediaSeconds)||0,
      traceRow: tracePrior ? markSearchRaw(tracePrior) : null,
      attemptId: feedbackContinuation?.attemptId || `${now}-${Math.random().toString(36).slice(2, 10)}`,
      path,
      resourceId: reference.resourceId,
      songKey: reference.songKey,
      playbackGeneration: Number(this._committedPlaybackGeneration || this.playbackGeneration || 0),
      startedAt: now,
      state: "playing",
      pausedAt: 0,
      lastClockAt: this.getListeningClockMs(),
      lastWallAt: now,
      lastAudioTime: this.getListeningMediaTime(),
      playbackRate: this.getListeningPlaybackRate(),
      listenedSeconds: 0,
      creditedMediaSeconds: 0,
      counted: false,
      recommendationOpportunityRecorded: !!feedbackContinuation?.recommendationOpportunityRecorded,
      dislikeHandled: !!feedbackContinuation?.dislikeHandled,
      dislikeFeedbackSave: feedbackContinuation?.dislikeFeedbackSave,
      recommendationDiagnosticId: feedbackContinuation?.recommendationDiagnosticId || diagnosticId,
    };
    try { this.recordSoundMapPlayback?.(source); }
    catch (_) { console.warn("[sound-map] listening route could not be saved"); }
    this.ensureListeningTrack(path);
    this.recordRecommendationOpportunity(path, "actual_playback");
    if (feedbackContinuation) this.finishRecommendationDiagnostic(feedbackContinuation.recommendationDiagnosticId, "playing", { endReason: "" });
  },
  getListeningClockMs() {
    try {
      if (typeof performance !== "undefined" && typeof performance.now === "function") {
        return Number(performance.now()) || Date.now();
      }
    } catch {
      // 某些隔离测试环境没有 performance。
    }
    return Date.now();
  },
  getListeningPlaybackRate() {
    const rate = Math.abs(Number(audio.playbackRate || 1));
    if (!Number.isFinite(rate) || rate <= 0) return 1;
    return Math.max(0.0625, Math.min(16, rate));
  },
  getListeningMediaTime() {
    const mediaTime = Number(audio.currentTime);
    if (Number.isFinite(mediaTime) && mediaTime >= 0) return mediaTime;
    const viewTime = Number(this.currentTime);
    return Number.isFinite(viewTime) ? Math.max(0, viewTime) : 0;
  },
  resetListeningSessionAnchors(session, state = "") {
    if (!session) return;
    const now = Date.now();
    if (state) session.state = state;
    session.lastClockAt = this.getListeningClockMs();
    session.lastWallAt = now;
    session.lastAudioTime = this.getListeningMediaTime();
    session.playbackRate = this.getListeningPlaybackRate();
  },
  resumeListeningSession(path) {
    const session = this.listeningSession;
    if (!session || session.path !== path) return false;
    session.playbackGeneration = Number(this._committedPlaybackGeneration || this.playbackGeneration || session.playbackGeneration || 0);
    session.pausedAt = 0;
    this.resetListeningSessionAnchors(session, "playing");
    this.finishRecommendationDiagnostic(session.recommendationDiagnosticId, "playing", { listenedSeconds: session.listenedSeconds });
    return true;
  },
  beginListeningSeek(reason = "seeking") {
    const session = this.listeningSession;
    if (!session || session.path !== this.currentPath) return;
    if (session.state === "playing") {
      this.updateListeningSessionProgress({ force: true });
    }
    this.resetListeningSessionAnchors(session, "seeking");
    session.lastCheckpointReason = String(reason || "seeking");
  },
  completeListeningSeek(reason = "seeked") {
    const session = this.listeningSession;
    if (!session || session.path !== this.currentPath) return;
    const state = audio.paused || audio.ended ? "paused" : "playing";
    this.resetListeningSessionAnchors(session, state);
    session.lastCheckpointReason = String(reason || "seeked");
    this.queueListeningHistorySave();
  },
  markListeningBuffering(reason = "buffering") {
    const session = this.listeningSession;
    if (!session || session.path !== this.currentPath) return;
    if (session.state === "playing") {
      this.updateListeningSessionProgress({ force: true });
    }
    this.resetListeningSessionAnchors(session, "buffering");
    session.lastCheckpointReason = String(reason || "buffering");
  },
  resumeListeningAfterBuffering(reason = "playing") {
    const session = this.listeningSession;
    if (!session || session.path !== this.currentPath) return;
    if (session.state !== "buffering" && session.state !== "seeking") return;
    const state = audio.paused || audio.ended ? "paused" : "playing";
    this.resetListeningSessionAnchors(session, state);
    session.lastCheckpointReason = String(reason || "playing");
  },
  handleListeningRateChange() {
    const session = this.listeningSession;
    if (!session || session.path !== this.currentPath) return;
    if (session.state === "playing") {
      this.updateListeningSessionProgress({ force: true });
    }
    this.resetListeningSessionAnchors(session, session.state || (audio.paused ? "paused" : "playing"));
    session.lastCheckpointReason = "ratechange";
  },
  updateListeningSessionProgress(options = {}) {
    const session = this.listeningSession;
    const force = !!options.force;
    if (this.listeningHistoryActionBusy && !force) return;
    if (!session || session.path !== this.currentPath || (!force && (!this.isPlaying || audio.paused || audio.ended))) return;
    if (session.state !== "playing") return;
    const now = Date.now();
    const clockNow = this.getListeningClockMs();
    const wallDelta = Math.max(
      0,
      Math.min(6 * 60 * 60, (clockNow - Number(session.lastClockAt || clockNow)) / 1000),
    );
    const current = this.getListeningMediaTime();
    const previous = Number(session.lastAudioTime || 0);
    const audioDelta = current - previous;
    const playbackRate = Math.max(
      0.0625,
      Math.min(16, Number(session.playbackRate || this.getListeningPlaybackRate()) || 1),
    );
    const expectedMediaDelta = wallDelta * playbackRate;
    const mediaDeltaTolerance = Math.max(
      0.5 * playbackRate,
      expectedMediaDelta * 0.25 + 0.1,
    );
    let effectiveWall = 0;
    let effectiveMedia = 0;
    const matchesClock = Math.abs(audioDelta - expectedMediaDelta) <= mediaDeltaTolerance;
    if (audioDelta > 0 && matchesClock) {
      const mediaWall = audioDelta / playbackRate;
      effectiveWall = Math.min(wallDelta || mediaWall, mediaWall);
      effectiveMedia = audioDelta;
    }
    session.lastClockAt = clockNow;
    session.lastWallAt = now;
    session.lastAudioTime = current;
    if (effectiveWall <= 0 || effectiveMedia <= 0) return;
    session.listenedSeconds += effectiveWall;
    session.creditedMediaSeconds = Math.max(0, Number(session.creditedMediaSeconds || 0)) + effectiveMedia;
    if (session.listenedSeconds - (session.traceCheckpointSeconds || 0) >= 30) {
      session.traceCheckpointSeconds = session.listenedSeconds;
      this.recordSoundMapEvent("checkpoint", session, "progress");
    }
    this.addListeningSeconds(session.path, effectiveWall, now - effectiveWall * 1000);
    this.maybeCountListeningPlay(session);
    this.queueListeningHistorySave();
  },
  checkpointListeningSession(reason = "checkpoint") {
    const session = this.listeningSession;
    if (!session) return;
    this.updateListeningSessionProgress({ force: true });
    this.maybeCountListeningPlay(session);
    session.state = "paused";
    session.pausedAt = Date.now();
    session.lastClockAt = this.getListeningClockMs();
    session.lastWallAt = session.pausedAt;
    session.lastAudioTime = this.getListeningMediaTime();
    session.lastCheckpointReason = String(reason || "checkpoint");
    this.recordSoundMapEvent("checkpoint", session, reason);
    this.finishRecommendationDiagnostic(session.recommendationDiagnosticId, "paused", { listenedSeconds: session.listenedSeconds });
    this.saveListeningHistoryNow();
  },
  flushListeningSession(reason = "flush", { deferSave = false } = {}) {
    const session = this.listeningSession;
    if (!session) return Promise.resolve({ ok: true });
    this.updateListeningSessionProgress({ force: true });
    this.maybeCountListeningPlay(session);
    session.state = "ended";
    session.endedAt = Date.now();
    session.endReason = String(reason || "flush");
    this.finishRecommendationDiagnostic(session.recommendationDiagnosticId, "ended", {
      listenedSeconds: session.listenedSeconds, endReason: session.endReason, rejected: !!session.dislikeHandled,
    });
    this.recordSoundMapEvent(reason === "switch-attempt" ? "checkpoint" : "play_ended", session, reason);
    this.listeningSession = null;
    if (deferSave) {
      this.queueListeningHistorySave();
      return Promise.resolve({ ok: true, scheduled: true });
    }
    return this.saveListeningHistoryNow();
  },
  ensureListeningTrack(path) {
    const hist = this.listeningHistory || this.getEmptyListeningHistory();
    this.listeningHistory = hist;
    const source = this.getListeningTrackMeta(path);
    let existingKey = path;
    let existing = hist.tracks[path] || null;
    if (!existing && source.resourceId) {
      const hit = Object.entries(hist.tracks || {}).find(([, item]) => (
        String(item?.resourceId || "") === source.resourceId
      ));
      if (hit) [existingKey, existing] = hit;
    }
    existing = existing || {};
    if (existingKey !== path) delete hist.tracks[existingKey];
    const recommendationBehavior = this.normalizeRecommendationBehavior(existing.recommendationBehavior, path);
    recommendationBehavior.resourceId = source.resourceId || recommendationBehavior.resourceId;
    recommendationBehavior.songKey = source.songKey || recommendationBehavior.songKey;
    hist.tracks[path] = {
      path,
      resourceId: source.resourceId || String(existing.resourceId || ""),
      songKey: source.songKey || String(existing.songKey || ""),
      title: source.title || existing.title || this.extractName(path),
      artist: source.artist || existing.artist || "",
      album: source.album || existing.album || "",
      duration: Number(source.duration || existing.duration || 0),
      playCount: Math.max(0, Math.floor(Number(existing.playCount || 0))),
      listenedSeconds: Math.max(0, Number(existing.listenedSeconds || 0)),
      lastPlayedAt: this.featureEnabled?.('history')===false ? Number(existing.lastPlayedAt || 0) : Math.max(Number(existing.lastPlayedAt || 0), Date.now()),
      lastCountedAt: Math.max(0, Number(existing.lastCountedAt || 0)),
      recommendationBehavior,
    };
    return hist.tracks[path];
  },
  getListeningTrackMeta(path) {
    if (this.isOnlineToken(path)) {
      const t = this.onlineTrackMap[path] || {};
      return {
        resourceId: String(t.resourceId || t.token || ""),
        songKey: String(t.songKey || t.dedupe_key || ""),
        title: t.title || t.name || this.extractName(path),
        artist: t.artist || "",
        album: t.album || "",
        duration: Number(t.duration || this.duration || 0),
      };
    }
    const t = this.trackByPath?.get?.(path) || {};
    return {
      resourceId: String(t.resourceId || ""),
      songKey: String(t.songKey || ""),
      title: this.currentPath === path ? (this.currentMeta?.title || t.title || t.name || this.extractName(path)) : (t.title || t.name || this.extractName(path)),
      artist: this.currentPath === path ? (this.currentMeta?.artist || t.artist || "") : (t.artist || ""),
      album: this.currentPath === path ? (this.currentMeta?.album || t.album || "") : (t.album || ""),
      duration: Number((this.currentPath === path ? this.duration : t.duration) || 0),
    };
  },
  addListeningSeconds() {  },
  addListeningSecondsByDay() {  },
  maybeCountListeningPlay() {  },
  getDislikeCorrectionConfig() {
    const cfg = this.params?.dislike_correction || {};
    return {
      enabled: cfg.enabled !== false,
      enable_skip_rate_fix: cfg.enable_skip_rate_fix !== false,
      skip_strength: Math.max(0, Math.min(5, Number(cfg.skip_strength ?? 1))),
      skip_fix_min: Math.max(0.01, Math.min(10, Number(cfg.skip_fix_min ?? 0.33))),
      skip_fix_max: Math.max(0.01, Math.min(20, Number(cfg.skip_fix_max ?? 2))),
      skip_smooth_k: Math.max(0, Math.min(10000, Number(cfg.skip_smooth_k ?? 20))),
      daily_decay: Math.max(0, Math.min(1, Number(cfg.daily_decay ?? 0.98))),
      consecutive_dislike_threshold: Math.max(0, Math.min(20, Math.floor(Number(cfg.consecutive_dislike_threshold ?? 0)))),
      long_pause_reset_minutes: Math.max(0, Math.min(1440, Number(cfg.long_pause_reset_minutes ?? 10))),
    };
  },
  isRecommendationControlSource(source) {
    return ["like_next", "dislike_next"].includes(String(source || ""));
  },
  resetConsecutiveDislike(source = "reset") {
    this.consecutiveDislikeCount = 0;
    this.lastDislikeAt = 0;
    this.lastDislikeResetSource = source;
    if (source === "recommendation-behavior-reset") {
      this.continuityRecent = [];
      const cooldown = this.recommendationContext?.cooldown || [];
      this.recommendationContext = { ...window.RecommendationContext.fresh(this.makeTrackReference(this.currentPath), Number(this.recommendationContext?.revision || 0) + 1), cooldown };
      writeStored("lx-recommendation-context-v2", JSON.stringify(this.recommendationContext));
      try { writeStored("lx-continuity-recent", "[]"); } catch (_) {}
    }
  },
  handleRecommendationBehaviorBeforeSwitch(source = "manual") {
    const src = String(source || "manual");
    if (src === "dislike_next" && this.currentPath) {
      const session = this.listeningSession;
      if (!session || session.path !== this.currentPath) return;
      if (session.dislikeHandled) return session.dislikeFeedbackSave;
      session.dislikeHandled = true;
      this.updateListeningSessionProgress({ force: true });
      this.recordSoundMapEvent("rejected", session, "dislike_next",{consecutiveRejectionsBefore:Number(this.consecutiveDislikeCount)||0,subjectiveReason:null});
      if (!session.recommendationDiagnosticId) session.recommendationDiagnosticId = this.beginRecommendationDiagnostic(this.currentPath, "manual_rejection");
      this.recordRecommendationOpportunity(this.currentPath, "manual_rejection");
      this.rememberContinuityTrack(this.currentPath, true);
      this.finishRecommendationDiagnostic(session.recommendationDiagnosticId, "rejected", { started:true, attemptId:session.attemptId, rejected: true, listenedSeconds: session.listenedSeconds });
      const cfg = this.getDislikeCorrectionConfig();
      if (this.consecutiveDislikeCount >= cfg.consecutive_dislike_threshold) {
        this.recordDislikeChainSkip(this.currentPath);
      }
      this.consecutiveDislikeCount = Math.max(0, Number(this.consecutiveDislikeCount || 0)) + 1;
      this.lastDislikeAt = Date.now();
      session.dislikeFeedbackSave = this.saveListeningHistoryNow();
      return session.dislikeFeedbackSave;
    }
  },
  handleRecommendationBehaviorAfterCommit(source = "manual") {
    const src = String(source || "manual");
    if (src !== "prefetch" && !["dislike_next", "dislike_fallback"].includes(src)) {
      this.resetConsecutiveDislike(src);
    }
  },
  recordRecommendationOpportunity(path, source = "") {
    if(this.featureEnabled?.('recommendation')===false)return;
    const session = this.listeningSession;
    if (!path || !session || session.path !== path || session.recommendationOpportunityRecorded) return;
    session.recommendationOpportunityRecorded = true;
    session.recommendationExposureSource = source;
    this.updateSkipRateSummaryIfNeeded(); // Decay old counts before adding today's exposure.
    const item = this.ensureListeningTrack(path);
    const behavior = this.normalizeRecommendationBehavior(item.recommendationBehavior, path);
    behavior.skipOpportunityCount = Math.max(0, Number(behavior.skipOpportunityCount || 0)) + 1;
    behavior.lastOpportunityAt = Date.now();
    item.recommendationBehavior = behavior;
    this.updateSkipRateSummaryIfNeeded({ force: true });
    this.queueListeningHistorySave();
  },
  recordDislikeChainSkip(path) {
    if(this.featureEnabled?.('recommendation')===false)return;
    if (!path) return;
    this.updateSkipRateSummaryIfNeeded();
    const item = this.ensureListeningTrack(path);
    const behavior = this.normalizeRecommendationBehavior(item.recommendationBehavior, path);
    behavior.dislikeChainSkipCount = Math.max(0, Number(behavior.dislikeChainSkipCount || 0)) + 1;
    behavior.lastSkipAt = Date.now();
    item.recommendationBehavior = behavior;
    this.updateSkipRateSummaryIfNeeded({ force: true });
  },
  updateSkipRateSummaryIfNeeded(options = {}) {
    if(this.featureEnabled?.('recommendation')===false)return;
    const hist = this.listeningHistory || this.getEmptyListeningHistory();
    this.listeningHistory = hist;
    const today = this.formatLocalDateKey();
    const summary = hist.recommendationBehaviorSummary || this.getEmptyListeningHistory().recommendationBehaviorSummary;
    const force = !!options.force;
    if (!force && summary.updatedDay === today) return;
    const cfg = this.getDislikeCorrectionConfig();
    const dayGap = (Date.parse(today + "T00:00:00Z") - Date.parse(summary.updatedDay + "T00:00:00Z")) / 86400000;
    const elapsedDays = Number.isFinite(dayGap) ? Math.max(0, Math.floor(dayGap)) : 0;
    const decay = summary.updatedDay ? cfg.daily_decay ** elapsedDays : 1;
    let totalOpps = 0;
    let totalSkips = 0;
    Object.values(hist.tracks || {}).forEach((item) => {
      if (!item || typeof item !== "object") return;
      item.recommendationBehavior = this.normalizeRecommendationBehavior(item.recommendationBehavior, item.path);
      const behavior = item.recommendationBehavior;
      if (decay !== 1) {
        behavior.skipOpportunityCount *= decay;
        behavior.dislikeChainSkipCount *= decay;
      }
      totalOpps += Math.max(0, Number(behavior.skipOpportunityCount || 0));
      totalSkips += Math.max(0, Number(behavior.dislikeChainSkipCount || 0));
    });
    const globalRate = totalOpps > 0 ? Math.max(0, Math.min(1, totalSkips / totalOpps)) : 0;
    Object.values(hist.tracks || {}).forEach((item) => {
      if (!item || typeof item !== "object") return;
      const behavior = item.recommendationBehavior || this.getEmptyRecommendationBehavior(item.path);
      const opps = Math.max(0, Number(behavior.skipOpportunityCount || 0));
      const skips = Math.max(0, Number(behavior.dislikeChainSkipCount || 0));
      if (globalRate > 0 && totalOpps > 0) {
        const smoothK = cfg.skip_smooth_k;
        const rate = (skips + globalRate * smoothK) / (opps + smoothK);
        const norm = globalRate > 0 ? rate / globalRate : 1;
        let fix = norm > 0 ? 1 / Math.pow(norm, cfg.skip_strength) : cfg.skip_fix_max;
        fix = Math.max(cfg.skip_fix_min, Math.min(cfg.skip_fix_max, fix));
        behavior.smoothedSkipRate = rate;
        behavior.skipNorm = norm;
        behavior.skipFix = fix;
      } else {
        behavior.smoothedSkipRate = 0;
        behavior.skipNorm = 1;
        behavior.skipFix = 1;
      }
      behavior.skipStatsUpdatedAt = Date.now();
      item.recommendationBehavior = behavior;
    });
    hist.recommendationBehaviorSummary = {
      version: 2,
      exposurePolicySince: Number(summary.exposurePolicySince) || Date.now(),
      updatedAt: Date.now(),
      updatedDay: today,
      globalSkipRate: globalRate,
      totalSkipOpportunityCount: totalOpps,
      totalDislikeChainSkipCount: totalSkips,
      dailyDecay: cfg.daily_decay,
    };
  },
  formatLocalDateKey(ts = Date.now()) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  },
  getListeningDayBars() { return []; },
  getListeningHistoryRows() { return []; },
  formatDurationLong() { return ""; },
  formatHistoryDate() { return ""; },
  async clearListeningStats() {
    if (this.listeningHistoryActionBusy) return;
    const confirmed = await this.requestConfirmation({
      title: "清空听歌统计",
      message: "播放次数、听歌时长和日期统计将归零。",
      detail: "推荐学习会保留，操作前会创建独立快照。",
      confirmLabel: "清空统计",
      tone: "danger",
    });
    if (!confirmed) return;
    const currentPath = String(this.currentPath || "");
    const feedbackContinuation = this.listeningSession ? { ...this.listeningSession } : null;
    const shouldContinueAttempt = !!currentPath && !!this.isPlaying && !audio.paused && !audio.ended;
    this.listeningHistoryActionBusy = true;
    this.listeningHistoryMessage = "正在清空听歌统计…";
    try {
      const saved = await this.flushListeningSession("clear-stats");
      if (saved?.ok === false) throw new Error(saved.error || "保存当前听歌统计失败");
      const operation = window.lxEnv?.clearListeningStats
        || window.lxEnv?.resetListeningHistory;
      if (typeof operation !== "function") throw new Error("当前版本缺少清空统计接口");
      const result = await operation();
      if (!result?.ok) throw new Error(result?.error || "清空听歌统计失败");
      this.listeningHistory = this.normalizeListeningHistory(result.history || {});
      this.listeningHistoryKeyword = "";
      this.listeningHistoryMessage = result.warning
        ? "听歌统计已清空，独立快照已保存；每日备份失败，请检查数据目录。"
        : "听歌统计已清空，推荐学习已保留。";
    } catch (error) {
      console.warn("清空听歌统计失败", error);
      this.listeningHistoryMessage = this.getOperationUserMessage(error, "清空失败");
    } finally {
      if (shouldContinueAttempt
        && currentPath === this.currentPath
        && this.isPlaying
        && !audio.paused
        && !audio.ended
        && !this.listeningSession) {
        this.beginListeningSession(currentPath, { feedbackContinuation });
      }
      this.listeningHistoryActionBusy = false;
    }
  },
  async resetRecommendationBehavior() {
    if (this.listeningHistoryActionBusy) return;
    const confirmed = await this.requestConfirmation({
      title: "重置推荐学习",
      message: "“换个感觉”的机会、连续跳过和修正值将归零。",
      detail: "播放次数与听歌时长会保留，操作前会创建独立快照。",
      confirmLabel: "重置学习",
      tone: "danger",
    });
    if (!confirmed) return;
    this.listeningHistoryActionBusy = true;
    this.listeningHistoryMessage = "正在重置推荐学习…";
    try {
      const saved = await this.saveListeningHistoryNow();
      if (saved?.ok === false) throw new Error(saved.error || "保存当前听歌统计失败");
      if (!window.lxEnv || typeof window.lxEnv.resetRecommendationBehavior !== "function") {
        throw new Error("当前版本缺少推荐学习重置接口");
      }
      const result = await window.lxEnv.resetRecommendationBehavior();
      if (!result?.ok) throw new Error(result?.error || "重置推荐学习失败");
      this.listeningHistory = this.normalizeListeningHistory(result.history || {});
      this.resetConsecutiveDislike("recommendation-behavior-reset");
      if (this.listeningSession) {
        this.listeningSession.recommendationOpportunityRecorded = false;
        this.listeningSession.dislikeHandled = false;
        this.listeningSession.dislikeFeedbackSave = null;
      }
      this.listeningHistoryMessage = result.warning
        ? "推荐学习已重置，独立快照已保存；每日备份失败，请检查数据目录。"
        : "推荐学习已重置，听歌统计已保留。";
    } catch (error) {
      console.warn("重置推荐学习失败", error);
      this.listeningHistoryMessage = this.getOperationUserMessage(error, "重置失败");
    } finally {
      this.listeningHistoryActionBusy = false;
    }
  },
  async clearListeningHistory() {
    return this.clearListeningStats();
  },
};

const playlistMethods = {
  openLibrarySongs() {
    this.libraryBrowseMode = "songs";
    this.selectPlaylist("all");
  },
  openFolderBrowser(path = null) {
    this.markLibraryUserInteraction();
    this.libraryBrowseMode = "folders";
    this.folderBrowsePath = path === null ? this.folderTree.root.path : String(path);
    this.clearLibrarySearch();
    this.libraryScrollTop = 0;
    this.setView("library");
    this.$nextTick(() => { if(this.$refs.libraryTableBody)this.$refs.libraryTableBody.scrollTop=0;this.refreshVirtualViewport(); });
  },
  async revealTrackInFolder() {
    const trackPath = String(this.trackContextMenu?.path || "");
    this.closeTrackContextMenu();
    if (!trackPath || this.isOnlineToken(trackPath)) return;
    try {
      const result = await window.lxEnv?.showSongInFolder?.(trackPath);
      if (!result?.ok) this.showNotice(result?.message || "无法打开文件位置。", "error");
    } catch (_) { this.showNotice("无法打开文件位置。", "error"); }
  },
  normalizeComparablePath(value) {
    return String(value || "")
      .replace(/\\/g, "/")
      .replace(/\/+$/, "")
      .toLocaleLowerCase();
  },
  isTrackInDownloadDirectory(trackPath) {
    if (this.isOnlineToken(trackPath)) return false;
    const root = this.normalizeComparablePath(this.params?.download_dir || "");
    const target = this.normalizeComparablePath(trackPath);
    if (!root || !target) return false;
    return target === root || target.startsWith(`${root}/`);
  },
  isTrackInDownloadFolder(trackPath) {
    if (this.isOnlineToken(trackPath)) return false;
    if (this.isTrackInDownloadDirectory(trackPath)) return true;
    const parentName = this.pathBasename(this.pathDirname(String(trackPath || "")));
    return /(?:下载|downloads?)/i.test(parentName);
  },
  orderTracksForAllPlaylist(tracks = this.tracks) {
    const regular = [];
    const downloaded = [];
    (tracks || []).forEach((track) => {
      (this.isTrackInDownloadFolder(track?.path) ? downloaded : regular).push(track);
    });
    return regular.concat(downloaded);
  },
  buildFolderPlaylists() {
    const existingSeedPls = this.playlists.filter((p) => p.type === "seed");
    const storedQueue = this.sessionQueue;
    let sessionLists = [];
    if (storedQueue && Array.isArray(storedQueue.tracks) && storedQueue.tracks.length) {
      const seen = new Set(), paths = [];
      storedQueue.tracks.slice(0,5000).forEach((path,i)=>{
        if(typeof path!=="string")return;
        const resolved=this.resolveTrackReference(storedQueue.trackRefs?.[i],path)||path;
        const key=this.detailTrackKey(resolved);if(seen.has(key))return;seen.add(key);paths.push(resolved);
      });
      const queue={id:"session-current",type:"session",name:String(storedQueue.name||"正在播放"),tracks:paths,trackRefs:paths.map(p=>this.makeTrackReference(p))};
      this.sessionQueue=queue;sessionLists=[queue];
      writeStoredIfChanged("lx-session-queue",JSON.stringify(queue));
    }
    const orderMap = this.loadPlaylistOrder();
    const map = {};
    const roots = this.configuredAudioDirectories();
    const labels = {};
    this.tracks.forEach((t) => {
      let folder = "未分组";
      if (this.isOnlineToken(t.path)) {
        folder = "在线音乐";
        if (!map[folder]) map[folder] = [];
        map[folder].push(t.path);
        return;
      }
      const owner = roots.find(root=>window.FlowaveFolders.contains(root,t.path));
      const root = String(owner||"").replace(/\\/g,"/").replace(/\/+$/g,"");
      const normalized = t.path.replace(/\\/g,"/");
      const rel = root ? normalized.slice(root.length+1) : "";
      const parts = rel.split('/');
      const name = root ? (parts.length>1?parts[0]:this.pathBasename(root)) : this.pathBasename(this.pathDirname(t.path))||"未分组";
      if(roots.length>1){folder=window.FlowaveFolders.key(parts.length>1?root+'/'+parts[0]:root);labels[folder]=(this.pathBasename(root)||root)+(parts.length>1?' / '+name:'');}
      else folder=name;
      if (!map[folder]) map[folder] = [];
      map[folder].push(t.path);
    });
    const pls = [{
      id: "all",
      name: "全部歌曲",
      tracks: this.orderTracksForAllPlaylist(this.tracks).map((t) => t.path),
      type: "system",
    }];
    Object.entries(map).forEach(([name, arr]) => {
      pls.push({ id: `folder-${name}`, name: labels[name] || name, tracks: arr, type: "folder" });
    });
    let combined = pls.concat(this.customPlaylists).concat(existingSeedPls,sessionLists);
    // 按保存的顺序排列非系统歌单
    combined = this.applyPlaylistOrder(combined, orderMap);
    this.playlists = combined;
    // 仅保留当前有效 id，并把新增歌单补到末尾，保证重启顺序稳定
    this.savePlaylistOrder(this.mergePlaylistOrderMap(this.playlists, orderMap));
    if (!this.playlists.find((p) => p.id === this.currentPlaylist)) this.currentPlaylist = "all";
    this.queueUiSnapshotSave();
  },
  mergePlaylistOrderMap(list, orderMap) {
    const map = orderMap || {};
    const ids = list.filter((p) => p.type !== "system").map((p) => p.id);
    const keep = ids
      .filter((id) => Object.prototype.hasOwnProperty.call(map, id))
      .sort((a, b) => (Number(map[a]) || 0) - (Number(map[b]) || 0));
    const seen = new Set(keep);
    const appended = ids.filter((id) => !seen.has(id));
    return Object.fromEntries([...keep, ...appended].map((id, idx) => [id, idx]));
  },
  applyPlaylistOrder(list, orderMap) {
    const system = list.filter((p) => p.type === "system"); // 只固定“全部歌曲”
    const others = list
      .filter((p) => p.type !== "system")
      .map((p, idx) => ({ p, idx })); // folder/custom/seed 可排序
    others.sort((a, b) => {
      const oa = orderMap[a.p.id] ?? Number.MAX_SAFE_INTEGER;
      const ob = orderMap[b.p.id] ?? Number.MAX_SAFE_INTEGER;
      if (oa !== ob) return oa - ob;
      return a.idx - b.idx;
    });
    return [...system, ...others.map((x) => x.p)];
  },
  persistCurrentPlaylistOrder() {
    this.savePlaylistOrder(this.computeOrderMap(this.playlists));
  },
  reorderNonSystemPlaylists(fromId, toId, insertAfter = false) {
    if (!fromId || !toId || fromId === toId) return false;
    const nonSystem = this.playlists.filter((p) => p.type !== "system");
    const system = this.playlists.filter((p) => p.type === "system");
    const idToIdx = Object.fromEntries(nonSystem.map((p, i) => [p.id, i]));
    if (!(fromId in idToIdx) || !(toId in idToIdx)) return false;
    const arr = nonSystem.slice();
    const fromIdx = idToIdx[fromId];
    const baseToIdx = idToIdx[toId];
    const [item] = arr.splice(fromIdx, 1);
    let toIdx = baseToIdx;
    if (fromIdx < toIdx) toIdx -= 1;
    if (insertAfter) toIdx += 1;
    toIdx = Math.max(0, Math.min(arr.length, toIdx));
    arr.splice(toIdx, 0, item);
    const next = [...system, ...arr];
    const same = next.length === this.playlists.length && next.every((p, i) => p.id === this.playlists[i].id);
    if (same) return false;
    this.playlists = next;
    return true;
  },
  promptNewPlaylist() {
    this.closePlaylistContextMenu();
    this.playlistEditId = "";
    this.playlistEditName = "";
    this.playlistEditError = "";
    this.playlistEditModalVisible = true;
  },
  openRenamePlaylistModal() {
    const id = String(this.playlistContextMenu?.playlistId || "");
    const playlist = this.customPlaylists.find((item) => item.id === id);
    this.closePlaylistContextMenu();
    if (!playlist) return;
    this.playlistEditId = playlist.id;
    this.playlistEditName = String(playlist.name || "");
    this.playlistEditError = "";
    this.playlistEditModalVisible = true;
  },
  confirmPlaylistEdit() {
    const name = String(this.playlistEditName || "").trim();
    if (!name) {
      this.playlistEditError = "请输入歌单名称。";
      return false;
    }
    const duplicate = this.customPlaylists.some(
      (item) => item.id !== this.playlistEditId && String(item.name || "").trim() === name
    );
    if (duplicate) {
      this.playlistEditError = "已经有同名歌单。";
      return false;
    }
    if (this.playlistEditId) {
      const playlist = this.customPlaylists.find((item) => item.id === this.playlistEditId);
      if (!playlist) {
        this.playlistEditError = "歌单已不存在，请重新打开。";
        return false;
      }
      playlist.name = name;
    } else {
      const created = { id: `custom-${Date.now()}`, name, tracks: [], trackRefs: [], type: "custom" };
      this.customPlaylists.push(created);
      this.currentPlaylist = created.id;
    }
    this.saveCustomPlaylists();
    this.buildFolderPlaylists();
    this.persistCurrentPlaylistOrder();
    this.playlistEditModalVisible = false;
    this.playlistEditError = "";
    return true;
  },
  cancelPlaylistEdit() {
    this.playlistEditModalVisible = false;
    this.playlistEditError = "";
  },
  addToPlaylist(path = "") {
    const trackPath = String(path || this.selectedPath || "");
    if (!trackPath) return;
    this.closeTrackContextMenu();
    this.playlistAddTrack = trackPath;
    this.playlistAddTargetId = this.customPlaylists[0]?.id || "";
    this.playlistAddNewName = "";
    this.playlistAddError = "";
    this.playlistAddModalVisible = true;
  },
  confirmAddToPlaylist() {
    const trackPath = String(this.playlistAddTrack || "");
    if (!trackPath) {
      this.playlistAddError = "歌曲已不存在，请重新选择。";
      return false;
    }
    const newName = String(this.playlistAddNewName || "").trim();
    let playlist = null;
    if (newName) {
      playlist = this.customPlaylists.find((item) => String(item.name || "").trim() === newName);
      if (!playlist) {
        playlist = { id: `custom-${Date.now()}`, name: newName, tracks: [], trackRefs: [], type: "custom" };
        this.customPlaylists.push(playlist);
      }
    } else {
      playlist = this.customPlaylists.find((item) => item.id === this.playlistAddTargetId);
    }
    if (!playlist) {
      this.playlistAddError = "请选择一个歌单，或输入新歌单名称。";
      return false;
    }
    if (!Array.isArray(playlist.tracks)) playlist.tracks = [];
    if (playlist.tracks.includes(trackPath)) {
      this.playlistAddError = `这首歌已经在「${playlist.name}」中。`;
      return false;
    }
    playlist.tracks.push(trackPath);
    this.saveCustomPlaylists();
    this.buildFolderPlaylists();
    this.playlistAddModalVisible = false;
    this.playlistAddError = "";
    return true;
  },
  cancelAddToPlaylist() {
    this.playlistAddModalVisible = false;
    this.playlistAddError = "";
  },
  loadCustomPlaylists() {
    const saved = readStoredString(STORAGE_KEYS.CUSTOM_PLAYLISTS, null);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        this.customPlaylists = Array.isArray(parsed)
          ? parsed.filter((playlist) => playlist && typeof playlist === "object").map((playlist) => ({
            ...playlist,
            tracks: Array.isArray(playlist.tracks) ? playlist.tracks.map((path) => String(path || "")).filter(Boolean) : [],
            trackRefs: Array.isArray(playlist.trackRefs) ? playlist.trackRefs : [],
          }))
          : [];
      } catch (e) {
        this.customPlaylists = [];
      }
    }
  },
  saveCustomPlaylists() {
    this.syncCustomPlaylistTrackRefs();
    writeStored(STORAGE_KEYS.CUSTOM_PLAYLISTS, JSON.stringify(this.customPlaylists));
  },
  openPlaylistContextMenu(event, pl) {
    if (!pl || pl.type !== "custom") {
      this.closePlaylistContextMenu();
      return;
    }
    this.currentPlaylist = pl.id;
    const position = this.clampContextMenuPosition(event, 170, 104);
    this.playlistContextMenu = {
      show: true,
      ...position,
      playlistId: pl.id,
      playlistName: String(pl.name || ""),
    };
    this.closeOnlineContextMenu();
    this.closeTrackContextMenu();
    this.prepareContextMenu("playlistContextMenuRoot",this.playlistContextMenu);
  },
  closePlaylistContextMenu() {
    this.restoreContextMenuFocus('playlistContextMenuRoot');
    this.playlistContextMenu.show = false;
  },
  async deletePlaylistFromContextMenu() {
    const id = String(this.playlistContextMenu?.playlistId || "");
    if (!id) return;
    const pl = this.customPlaylists.find((p) => p.id === id);
    this.closePlaylistContextMenu();
    if (!pl) return;
    const confirmed = await this.requestConfirmation({
      title: "删除歌单",
      message: `删除「${pl.name}」？`,
      detail: "歌曲文件不会被删除。",
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!confirmed) return;
    this.customPlaylists = this.customPlaylists.filter((p) => p.id !== id);
    this.saveCustomPlaylists();
    this.buildFolderPlaylists();
    if (this.currentPlaylist === id) this.currentPlaylist = "all";
    this.persistCurrentPlaylistOrder();
  },
  getCurrentCustomPlaylist() {
    if (this.libraryBrowseMode === "folders") return null;
    return this.customPlaylists.find((playlist) => playlist.id === this.currentPlaylist) || null;
  },
  canRemoveTrackFromCurrentPlaylist(path = "") {
    const playlist = this.getCurrentCustomPlaylist();
    return !!(playlist && Array.isArray(playlist.tracks) && playlist.tracks.includes(String(path || "")));
  },
  openTrackContextMenu(event, path) {
    const trackPath = String(path || "");
    if (!trackPath) return;
    this.selectedPath = trackPath;
    const position = this.clampContextMenuPosition(event, 272, 420);
    this.trackContextMenu = {
      show: true,
      ...position,
      path: trackPath,
    };
    this.closeOnlineContextMenu();
    this.closePlaylistContextMenu();
    this.prepareContextMenu("trackContextMenuRoot",this.trackContextMenu);
  },
  playFromTrackContextMenu() {
    const path = this.trackContextMenu.path;
    this.closeTrackContextMenu();
    if (path) this.playByPath(path);
  },
  prepareContextMenu(refName, state) {
    if (!document.activeElement?.closest?.('[role="menu"]')) this._contextMenuReturnFocus = document.activeElement;
    this.$nextTick(() => {
      const menu = this.$refs[refName];
      if (!state.show || !menu) return;
      const bounds = menu.getBoundingClientRect();
      Object.assign(state, this.clampContextMenuPosition({clientX:state.x,clientY:state.y},bounds.width,bounds.height));
      menu.querySelector('button:not(:disabled)')?.focus({preventScroll:true});
    });
  },
  restoreContextMenuFocus(refName) {
    if (this.$refs[refName]?.contains(document.activeElement) && this._contextMenuReturnFocus?.isConnected) {
      this._contextMenuReturnFocus.focus({preventScroll:true});
    }
  },
  onContextMenuKey(event) {
    const menu = event.currentTarget;
    const buttons = [...menu.querySelectorAll('button:not(:disabled)')];
    const index = buttons.indexOf(document.activeElement);
    if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key==='Home' ? 0 : event.key==='End' ? buttons.length-1 : (index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
      buttons[next]?.focus({preventScroll:true});
    } else if (['Escape','Tab'].includes(event.key)) {
      if (event.key==='Escape') { event.preventDefault(); event.stopPropagation(); }
      this.closeTrackContextMenu(); this.closeOnlineContextMenu(); this.closePlaylistContextMenu();
    }
  },
  closeTrackContextMenu() {
    this.restoreContextMenuFocus('trackContextMenuRoot');
    this.trackContextMenu.show = false;
  },
  addTrackContextSelectionToPlaylist() {
    const trackPath = String(this.trackContextMenu?.path || "");
    this.addToPlaylist(trackPath);
  },
  openSongInfoLookupFromContextMenu(mode = "metadata") {
    const trackPath = String(this.trackContextMenu?.path || "");
    this.closeTrackContextMenu();
    if (trackPath) this.openSongInfoLookup(trackPath, mode);
  },
  async openSongInfoLookup(trackPath, mode = "metadata", search = null) {
    const pathValue = String(trackPath || "").trim();
    if (!pathValue || this.isOnlineToken(pathValue)) return;
    const retained = this.songInfoDialog.visible && this.songInfoDialog.path === pathValue
      ? { draft: this.songInfoDialog.metadataDraft, original: this.songInfoDialog.metadataOriginal,
          queued: this.songInfoDialog.metadataQueued, queuedId: this.songInfoDialog.metadataQueuedRequestId, signature: this.songInfoDialog.metadataSaveSignature } : null;
    if (this.songInfoDialog.visible && this.songInfoDialog.path !== pathValue && this.songInfoHasUnsavedMetadata()) {
      if (!await this.requestConfirmation({ title:"放弃未保存的修改？",message:"当前歌曲资料尚未保存。",confirmLabel:"放弃修改" })) return;
    }
    if (this.songInfoDialog.requestId) {
      window.lxEnv?.cancelSongInfoQuery?.(this.songInfoDialog.requestId).catch?.(() => {});
    }
    if (this.songInfoDialog.coverRequestId) {
      window.lxEnv?.cancelSongInfoCover?.(this.songInfoDialog.coverRequestId).catch?.(() => {});
    }
    const generation = Number(this._songInfoRequestGeneration || 0) + 1;
    this._songInfoRequestGeneration = generation;
    const requestId = `song-info-${generation}`;
    this.songInfoDialog = {
      visible: true,
      mode: mode === "lyrics" ? "lyrics" : "metadata",
      searchTitle: String(search?.title || ""),
      manualIdentity: search?.manualIdentity === true,
      queriedSearchTitle: "", queriedSearchArtist: "",
      metadataDraft: retained?.draft || null, metadataOriginal: retained?.original || null,
      metadataQueued: retained?.queued || false, metadataQueuedRequestId: retained?.queuedId || "", metadataSaveSignature: retained?.signature || "",
      lyricFileExists: false,
      searchArtist: String(search?.artist || ""),
      destination: "",
      targetExists: false,
      showRejected: false,
      format: search?.format === "lrc" ? "lrc" : "enhanced-lrc",
      path: pathValue,
      requestId,
      loading: true,
      error: "",
      current: null,
      candidates: [],
      sources: [],
      selectedIndex: 0,
      coverUrls: {},
      coverRequestId: "",
      lyricSaveBusy: false,
      lyricSaveMessage: "",
      lyricConfirmationId: "",
    };
    this.$nextTick(() => this.$refs.songInfoClose?.focus?.());
    this.refreshSongInfoLyricFile();
    window.lxEnv?.getSongTagCapabilities?.().then(result => { this.songMetadataEditAvailable = result?.editable === true; }).catch(() => {});
    try {
      if (!window.lxEnv || typeof window.lxEnv.querySongInfo !== "function") {
        throw new Error("当前版本缺少歌曲信息查询接口");
      }
      const result = await window.lxEnv.querySongInfo({
        requestId,
        trackPath: pathValue,
        resourceId: String(this.trackByPath.get(pathValue)?.resourceId || ""),
        requestedFields: SONG_INFO_LOOKUP_FIELDS.filter(field => field !== "lyrics"),
        manualIdentity: this.songInfoDialog.manualIdentity,
        forceRefresh: search?.forceRefresh === true,
        mode: this.songInfoDialog.mode,
        searchTitle: this.songInfoDialog.searchTitle,
        searchArtist: this.songInfoDialog.searchArtist,
        includeLyrics: false,
        locale: "zh-CN",
      });
      if (generation !== this._songInfoRequestGeneration
        || !this.songInfoDialog.visible
        || this.songInfoDialog.requestId !== requestId) return;
      if (!result?.ok) {
        this.songInfoDialog.error = String(result?.message || "查找失败，请重试");
        this.songInfoDialog.sources = Array.isArray(result?.sources) ? result.sources : [];
        return;
      }
      this.songInfoDialog.current = result.current || null;
      this.seedSongInfoMetadata(result.current);
      this.songInfoDialog.queriedSearchTitle = search ? String(search.title || "") : String(result.current?.title || "");
      this.songInfoDialog.queriedSearchArtist = search ? String(search.artist || "") : (result.current?.artists || []).join("、");
      if (!search) {
        this.songInfoDialog.searchTitle ||= String(result.current?.title || "");
        this.songInfoDialog.searchArtist ||= (result.current?.artists || []).join("、");
      }
      if (Object.hasOwn(result, "destination")) this.songInfoDialog.destination = String(result.destination || "");
      if (Object.hasOwn(result, "targetExists")) this.songInfoDialog.targetExists = Boolean(result.targetExists);
      this.songInfoDialog.candidates = Array.isArray(result.candidates) ? result.candidates : [];
      this.songInfoDialog.sources = Array.isArray(result.sources) ? result.sources : [];
      this.songInfoDialog.selectedIndex = this.songInfoDialog.candidates.findIndex(item => item.recommendation !== "none");
      this.loadSelectedSongInfoCover();
    } catch (error) {
      if (generation === this._songInfoRequestGeneration && this.songInfoDialog.visible) {
        this.songInfoDialog.error = this.getOperationUserMessage(error, "查找失败");
      }
    } finally {
      if (generation === this._songInfoRequestGeneration && this.songInfoDialog.visible) {
        this.songInfoDialog.loading = false;
      }
    }
  },
  async closeSongInfoDialog() {
    if (this.songInfoDialog.lyricSaveBusy) return;
    if (this.songInfoHasUnsavedMetadata() && !await this.requestConfirmation({title:"放弃未保存的修改？",message:"歌曲资料尚未保存。",confirmLabel:"放弃修改"})) return;
    const requestId = String(this.songInfoDialog?.requestId || "");
    const coverRequestId = String(this.songInfoDialog?.coverRequestId || "");
    const lyricConfirmationId = String(this.songInfoDialog?.lyricConfirmationId || "");
    this._songInfoRequestGeneration = Number(this._songInfoRequestGeneration || 0) + 1;
    if (requestId) window.lxEnv?.cancelSongInfoQuery?.(requestId).catch?.(() => {});
    if (coverRequestId) window.lxEnv?.cancelSongInfoCover?.(coverRequestId).catch?.(() => {});
    if (lyricConfirmationId) window.lxEnv?.cancelLyricSave?.(lyricConfirmationId).catch?.(() => {});
    this.songInfoDialog.visible = false;
    this.songInfoDialog.loading = false;
    this.songInfoDialog.lyricSaveBusy = false;
    this.songInfoDialog.lyricConfirmationId = "";
  },
  retrySongInfoLookup() {
    const trackPath = String(this.songInfoDialog?.path || "");
    if (!String(this.songInfoDialog.searchTitle || "").trim()) {
      this.songInfoDialog.lyricSaveMessage = "请输入歌名"; return;
    }
    if (trackPath && !this.songInfoDialog.lyricSaveBusy) this.openSongInfoLookup(trackPath, this.songInfoDialog.mode, {
      title: this.songInfoDialog.searchTitle, artist: this.songInfoDialog.searchArtist, format: this.songInfoDialog.format, manualIdentity: true, forceRefresh: true,
    });
  },
  switchSongInfoMode(mode) {
    if (this.songInfoDialog.lyricSaveBusy || mode === this.songInfoDialog.mode) return;
    this.openSongInfoLookup(this.songInfoDialog.path, mode, {
      title: this.songInfoDialog.searchTitle, artist: this.songInfoDialog.searchArtist, manualIdentity: this.songInfoDialog.manualIdentity || this.songInfoSearchPending(),
    });
  },
  songInfoVisibleCandidates() {
    return this.songInfoDialog.candidates.map((item, index) => ({ item, index }))
      .filter(({ item }) => this.songInfoDialog.showRejected || item.recommendation !== "none");
  },
  songInfoRejectedCount() {
    return this.songInfoDialog.candidates.filter(item => item.recommendation === "none").length;
  },
  songInfoMetadataSupported() {
    return this.songMetadataEditAvailable && /\.(mp3|flac|m4a|ogg)$/i.test(this.songInfoDialog.path || "");
  },
  songInfoHasUnsavedMetadata() {
    return Object.keys(this.songInfoMetadataChanges()).length > 0
      && !(this.songInfoDialog.metadataQueued && JSON.stringify(this.songInfoDialog.metadataDraft) === this.songInfoDialog.metadataSaveSignature);
  },
  seedSongInfoMetadata(current) {
    if (!current || this.songInfoDialog.metadataDraft) return;
    const draft = {};
    for (const field of ["title", "artists", "album", "albumArtists", "releaseDate", "genres"]) {
      draft[field] = Array.isArray(current[field]) ? current[field].join("、") : String(current[field] || "");
    }
    this.songInfoDialog.metadataOriginal = { ...draft };
    this.songInfoDialog.metadataDraft = draft;
  },
  songInfoMetadataChanges() {
    const dialog = this.songInfoDialog, updates = {};
    if (!dialog.metadataDraft || !dialog.metadataOriginal) return updates;
    for (const field of Object.keys(dialog.metadataOriginal)) {
      const value = String(dialog.metadataDraft[field] || "").trim();
      if (value !== String(dialog.metadataOriginal[field] || "").trim()) updates[field] = ["artists", "albumArtists", "genres"].includes(field)
        ? value.split(/[、;；]/).map(item => item.trim()).filter(Boolean) : value;
    }
    return updates;
  },
  useSongInfoMetadataCandidate() {
    const candidate = this.selectedSongInfoCandidate()?.candidate;
    if (!candidate || !this.songInfoDialog.metadataDraft || this.songInfoDialog.lyricSaveBusy) return;
    for (const field of Object.keys(this.songInfoDialog.metadataDraft)) {
      const value = candidate[field];
      if (Array.isArray(value) ? value.length : Boolean(value)) this.songInfoDialog.metadataDraft[field] = Array.isArray(value) ? value.join("、") : String(value);
    }
    this.songInfoDialog.lyricSaveMessage = "已填入，保存后生效";
  },
  async saveSongInfoMetadata() {
    const dialog = this.songInfoDialog;
    if (!Object.keys(this.songInfoMetadataChanges()).length && this.selectedSongInfoCandidate()) this.useSongInfoMetadataCandidate();
    const updates = this.songInfoMetadataChanges();
    if (dialog.lyricSaveBusy || !this.songInfoMetadataSupported() || !Object.keys(updates).length || !dialog.metadataDraft?.title?.trim()) return;
    const path = dialog.path, requestId = dialog.requestId;
    dialog.lyricSaveBusy = true; dialog.lyricSaveMessage = "";
    let token = "";
    try {
      await window.lxEnv?.setTagPlaybackTarget?.({ path: this.currentPath, generation: this.playbackGeneration });
      const prepared = await window.lxEnv.prepareSongTagSave({ trackPath: path,
        resourceId: this.trackByPath.get(path)?.resourceId || "", updates });
      if (!prepared?.ok) throw new Error(prepared?.message || "无法保存资料");
      if (prepared.status === "unchanged") { dialog.lyricSaveMessage = "没有需要保存的修改"; return; }
      token = prepared.confirmationId;
      if (requestId !== this.songInfoDialog.requestId || !this.songInfoDialog.visible) return;
      const confirmed = await this.requestConfirmation({ title: "保存歌曲资料", message: "将修改音频文件中的以下资料：",
        detail: prepared.changes.map(change => `${this.songInfoFieldLabel(change.field)}：${this.formatSongInfoValue(change.field, change.current)} → ${this.formatSongInfoValue(change.field, change.proposed)}`).join("\n"), confirmLabel: "保存" });
      if (!confirmed || requestId !== this.songInfoDialog.requestId) return;
      dialog.metadataSaveSignature = JSON.stringify(dialog.metadataDraft);
      const result = await window.lxEnv.commitSongTagSave(token); token = "";
      if (!result?.ok) throw new Error(result?.message || "资料保存失败");
      dialog.metadataQueued = result.status === "queued";
      dialog.metadataQueuedRequestId = result.requestId || "";
      dialog.lyricSaveMessage = result.status === "queued" ? "已排队，切换歌曲后保存" : this.songInfoMetadataResultMessage(result);
      if (result.status === "queued") this.showNotice("已排队，切换歌曲后保存资料");
    } catch (error) { dialog.metadataQueued = false; if (requestId === this.songInfoDialog.requestId) dialog.lyricSaveMessage = this.getOperationUserMessage(error, "保存失败"); }
    finally { if (token) { try { await window.lxEnv?.cancelSongTagSave?.(token); } catch (_) {} } dialog.lyricSaveBusy = false; }
  },
  songInfoMetadataResultMessage(result) {
    const action = result?.undo ? "资料修改已撤销" : "资料已写入";
    return result?.refreshFailed || /pending-(reconcile|refresh)/.test(result?.status || "")
      ? `${action}，曲库同步未完成，请刷新后查看` : (result?.undo ? action : "资料已保存");
  },
  async handleSongTagsUpdated(result) {
    const requestId = this.songInfoDialog.requestId;
    const samePath = this.songInfoDialog.path === result?.trackPath;
    const matchesQueue = samePath && (!this.songInfoDialog.metadataQueuedRequestId || this.songInfoDialog.metadataQueuedRequestId === result?.requestId);
    if (matchesQueue) { this.songInfoDialog.metadataQueued = false; this.songInfoDialog.metadataQueuedRequestId = ""; }
    if (!result?.ok) {
      const cancelled = ["cancelled", "superseded"].includes(result?.status);
      if (matchesQueue) this.songInfoDialog.lyricSaveMessage = cancelled ? "待保存修改已取消" : (result?.message || "资料保存未完成");
      if (!cancelled) this.showNotice(result?.message || "资料保存未完成", "error");
      return;
    }
    if (result.undo) this.lastMetadataSave = null;
    else this.lastMetadataSave = { transactionId: result.transactionId, trackPath: result.trackPath };
    writeStored("metadata-last-save", JSON.stringify(this.lastMetadataSave));
    await this.loadTracks({ preserveView: true });
    const generation = this.playbackGeneration, path = result.trackPath;
    if (path === this.currentPath) {
      const presentation = await this.loadTrackPresentation(path);
      if (path === this.currentPath && generation === this.playbackGeneration) {
        this.applyTrackPresentation(presentation); this.updateMediaSessionMetadata();
      }
    }
    if (this.songInfoDialog.visible && this.songInfoDialog.path === path) {
      const info = await window.lxEnv.getSongInfo(path, { includeLyrics: false });
      if (this.songInfoDialog.path === path && this.songInfoDialog.visible && this.songInfoDialog.requestId === requestId) {
        const draft = this.songInfoDialog.metadataDraft;
        const preserveDraft = JSON.stringify(draft) !== this.songInfoDialog.metadataSaveSignature && Object.keys(this.songInfoMetadataChanges()).length > 0;
        this.songInfoDialog.metadataDraft = null;
        this.seedSongInfoMetadata({ ...info, artists: info.artists || [info.artist].filter(Boolean) });
        if (preserveDraft) this.songInfoDialog.metadataDraft = draft;
        this.songInfoDialog.lyricSaveMessage = this.songInfoMetadataResultMessage(result);
      }
    }
    this.showNotice(this.songInfoMetadataResultMessage(result));
  },
  async cancelQueuedSongInfoMetadata() {
    const queuedId = this.songInfoDialog.metadataQueuedRequestId;
    try {
      const result = await window.lxEnv?.cancelQueuedSongTagSave?.(queuedId);
      if (!result?.cancelled) this.showNotice("资料已开始保存，请等待完成");
    } catch (error) { this.showNotice(this.getOperationUserMessage(error, "取消失败，请重试"), "error"); }
  },
  async undoSongInfoMetadata() {
    const dialog = this.songInfoDialog, saved = this.lastMetadataSave;
    if (!saved || dialog.lyricSaveBusy) return;
    dialog.lyricSaveBusy = true;
    try {
      const result = await window.lxEnv.undoSongTagSave(saved);
      if (!result?.ok) this.showNotice(result?.message || "无法撤销资料修改", "error");
      else if (result.status === "queued" && this.songInfoDialog === dialog && dialog.path === saved.trackPath) {
        dialog.metadataQueued = true; dialog.metadataQueuedRequestId = result.requestId;
        dialog.lyricSaveMessage = "切换歌曲后撤销资料修改";
      }
    } catch (error) { this.showNotice(this.getOperationUserMessage(error, "无法撤销资料修改"), "error"); }
    finally { dialog.lyricSaveBusy = false; }
  },
  songInfoSearchPending() {
    const dialog = this.songInfoDialog;
    return String(dialog.searchTitle || "").trim() !== String(dialog.queriedSearchTitle || "").trim()
      || String(dialog.searchArtist || "").trim() !== String(dialog.queriedSearchArtist || "").trim();
  },
  songInfoLookupEmptyTitle() {
    const failed = this.songInfoDialog.sources.some(source => !["ok", "empty", "skipped"].includes(source.status));
    return failed ? "部分来源暂时不可用，可重试" : "没有找到匹配结果";
  },
  lookupSongInfoByFilename() {
    if (this.songInfoDialog.lyricSaveBusy) return;
    const filename = this.pathBasename(this.songInfoDialog.path).replace(/\.[^.]+$/, "");
    const parts = filename.split(/\s+-\s+/);
    this.songInfoDialog.searchTitle = parts.length === 2 ? parts[1].trim() : filename;
    this.songInfoDialog.searchArtist = parts.length === 2 ? parts[0].trim() : "";
    this.retrySongInfoLookup();
  },
  async refreshSongInfoLyricFile() {
    const trackPath = this.songInfoDialog.path;
    const requestId = this.songInfoDialog.requestId;
    try {
      const result = await window.lxEnv?.getLyricFileState?.(trackPath);
      if (!result?.ok || !this.songInfoDialog.visible || requestId !== this.songInfoDialog.requestId) return;
      this.songInfoDialog.lyricFileExists = Boolean(result.exists);
      this.songInfoDialog.targetExists = Boolean(result.targetExists);
      this.songInfoDialog.destination = String(result.destination || "");
    } catch (_) { /* File action stays unavailable; lookup remains independent. */ }
  },
  async showSongInfoLyricFolder() {
    const result = await window.lxEnv?.showLyricInFolder?.(this.songInfoDialog.path);
    if (!result?.ok) this.showNotice(result?.message || "无法定位歌词文件", "error");
  },
  async copySelectedSongInfo() {
    const item = this.selectedSongInfoCandidate();
    if (!item || item.recommendation === "none" || this.songInfoSearchPending()) return;
    const text = this.visibleSongInfoDifferences(item).map(diff =>
      `${this.songInfoFieldLabel(diff.field)}：${this.formatSongInfoValue(diff.field, diff.proposed)}`).join("\n");
    try { await navigator.clipboard.writeText(text); this.songInfoDialog.lyricSaveMessage = "已复制资料；音频文件未修改"; }
    catch (_) { this.songInfoDialog.lyricSaveMessage = "复制失败，请检查剪贴板权限"; }
  },
  selectSongInfoCandidate(index) {
    if (this.songInfoDialog.lyricSaveBusy) return;
    const next = Math.max(0, Math.min(Number(index) || 0, this.songInfoDialog.candidates.length - 1));
    this.songInfoDialog.selectedIndex = next;
    this.songInfoDialog.lyricSaveMessage = "";
    this.loadSelectedSongInfoCover();
  },
  songInfoCoverUrl(item) {
    const assetId = String(item?.candidate?.cover?.assetId || "");
    return assetId ? String(this.songInfoDialog.coverUrls?.[assetId] || "") : "";
  },
  async loadSelectedSongInfoCover() {
    const assetId = String(this.selectedSongInfoCandidate()?.candidate?.cover?.assetId || "");
    if (!assetId || this.songInfoDialog.coverUrls?.[assetId]) return;
    const generation = Number(this._songInfoRequestGeneration || 0);
    const previousRequestId = String(this.songInfoDialog.coverRequestId || "");
    if (previousRequestId) window.lxEnv?.cancelSongInfoCover?.(previousRequestId).catch?.(() => {});
    const requestId = `song-info-cover-${generation}-${this.songInfoDialog.selectedIndex}`;
    this.songInfoDialog.coverRequestId = requestId;
    try {
      const result = await window.lxEnv?.getSongInfoCover?.({ requestId, assetId });
      if (generation !== this._songInfoRequestGeneration
        || !this.songInfoDialog.visible
        || this.songInfoDialog.coverRequestId !== requestId
        || !result?.ok
        || result.assetId !== assetId) return;
      this.songInfoDialog.coverUrls = {
        ...(this.songInfoDialog.coverUrls || {}),
        [assetId]: String(result.url || ""),
      };
    } catch (_) {
      // 封面失败不影响候选信息浏览。
    } finally {
      if (this.songInfoDialog.coverRequestId === requestId) this.songInfoDialog.coverRequestId = "";
    }
  },
  selectedSongInfoCandidate() {
    const item = this.songInfoDialog.candidates[this.songInfoDialog.selectedIndex] || null;
    return item?.recommendation === "none" && !this.songInfoDialog.showRejected ? null : item;
  },
  songInfoCandidateHasLyrics(item = this.selectedSongInfoCandidate()) {
    return Boolean(item?.lyricSaveToken && item?.candidate?.lyrics?.available);
  },
  songInfoSaveContextMatches(generation, trackPath, candidateId) {
    const selectedId = String(this.selectedSongInfoCandidate()?.candidate?.candidateId || "");
    return Number(generation) === Number(this._songInfoRequestGeneration)
      && this.songInfoDialog.visible
      && String(this.songInfoDialog.path || "") === String(trackPath || "")
      && selectedId === String(candidateId || "");
  },
  async refreshCurrentLyricsAfterSidecarChange(trackPath) {
    const targetPath = String(trackPath || "");
    if (!targetPath || targetPath !== String(this.currentPath || "")) return false;
    const generation = Number(this.playbackGeneration || 0);
    try {
      const presentation = await this.loadTrackPresentation(targetPath);
      if (generation !== Number(this.playbackGeneration || 0)
        || targetPath !== String(this.currentPath || "")) return false;
      const meta = presentation?.meta || {};
      this.currentMeta = {
        ...(this.currentMeta || {}),
        lyric: String(meta.lyric || ""),
        lyricModel: meta.lyricModel && typeof meta.lyricModel === "object" ? meta.lyricModel : null,
      };
      if (this.currentMeta.lyricModel && this.applyLyricModel(this.currentMeta.lyricModel)) {
        // 统一模型保留逐字结束时间。
      } else if (this.currentMeta.lyric) {
        this.applyLyricText(this.currentMeta.lyric);
      } else {
        this.resetLyricState();
      }
      this.updateMediaSessionMetadata();
      return true;
    } catch (_) {
      return false;
    }
  },
  async saveSelectedSongInfoLyrics() {
    const item = this.selectedSongInfoCandidate();
    const candidate = item?.candidate || null;
    const trackPath = String(this.songInfoDialog?.path || "");
    const candidateId = String(candidate?.candidateId || "");
    if (!trackPath || !candidateId || !this.songInfoCandidateHasLyrics(item) || this.songInfoSearchPending() || this.songInfoDialog.loading || this.songInfoDialog.lyricSaveBusy) return;
    if (!window.lxEnv || typeof window.lxEnv.prepareLyricSave !== "function") {
      this.songInfoDialog.lyricSaveMessage = "当前版本无法保存歌词";
      return;
    }
    const generation = Number(this._songInfoRequestGeneration || 0);
    this.songInfoDialog.lyricSaveBusy = true;
    this.songInfoDialog.lyricSaveMessage = "";
    let confirmationId = "";
    try {
      const prepared = await window.lxEnv.prepareLyricSave({
        candidateToken: String(item.lyricSaveToken || ""),
        includeTranslation: this.lyricSaveIncludeTranslation,
        includeRomanization: this.lyricSaveIncludeRomanization,
        format: this.songInfoDialog.format,
      });
      confirmationId = String(prepared?.confirmationId || "");
      if (!this.songInfoSaveContextMatches(generation, trackPath, candidateId)) {
        if (confirmationId) {
          await window.lxEnv.cancelLyricSave?.(confirmationId);
          confirmationId = "";
        }
        return;
      }
      if (!prepared?.ok || !confirmationId) {
        this.songInfoDialog.lyricSaveMessage = String(prepared?.message || "歌词无法保存");
        return;
      }
      this.songInfoDialog.lyricConfirmationId = confirmationId;
      let replaceExisting = false;
      if (prepared.targetExists || prepared.identityCorrection) {
        const corrected = prepared.identityCorrection;
        const confirmed = await this.requestConfirmation({
          title: prepared.targetExists ? "替换歌词" : "确认歌曲",
          message: corrected ? `将「${candidate.title} · ${candidate.artists.join("、")}」的歌词保存给当前歌曲？` : "替换已有歌词？",
          detail: corrected ? "按你修正的歌名与歌手匹配。只保存歌词，不修改音频标签。" : "原歌词可撤销恢复。",
          confirmLabel: prepared.targetExists ? "替换" : "保存",
        });
        if (!confirmed || !this.songInfoSaveContextMatches(generation, trackPath, candidateId)) {
          await window.lxEnv.cancelLyricSave?.(confirmationId);
          confirmationId = "";
          if (this.songInfoSaveContextMatches(generation, trackPath, candidateId)) {
            this.songInfoDialog.lyricConfirmationId = "";
          }
          return;
        }
        replaceExisting = Boolean(prepared.targetExists);
      }
      const committed = await window.lxEnv.commitLyricSave({ confirmationId, replaceExisting });
      confirmationId = "";
      if (!committed?.ok) {
        if (this.songInfoSaveContextMatches(generation, trackPath, candidateId)) {
          this.songInfoDialog.lyricSaveMessage = String(committed?.message || "保存失败");
        } else {
          this.showNotice(String(committed?.message || "歌词保存失败"), "error");
        }
        return;
      }
      if (committed.status !== "committed") {
        if (this.songInfoSaveContextMatches(generation, trackPath, candidateId)) {
          this.songInfoDialog.lyricSaveMessage = committed.status === "unchanged" ? "与现有歌词完全相同，无需替换" : "已有歌词未修改";
          this.songInfoDialog.lyricConfirmationId = "";
        }
        return;
      }
      this._lyricUndoStateGeneration += 1;
      this.lastLyricSaveTransactionId = String(committed.transactionId || "");
      this.lastLyricSaveTrackPath = trackPath;
      if (this.songInfoSaveContextMatches(generation, trackPath, candidateId)) {
        this.songInfoDialog.lyricConfirmationId = "";
        this.songInfoDialog.lyricSaveMessage = committed.refreshFailed ? "歌词已保存，但刷新失败，请重新打开歌曲" : "已保存到对应的 KTV 歌词目录";
        this.songInfoDialog.targetExists = true;
        this.songInfoDialog.lyricFileExists = true;
      }
      await this.refreshCurrentLyricsAfterSidecarChange(trackPath);
      this.showNotice("歌词已保存");
    } catch (error) {
      const message = this.getOperationUserMessage(error, "歌词保存失败");
      if (this.songInfoSaveContextMatches(generation, trackPath, candidateId)) {
        this.songInfoDialog.lyricSaveMessage = message;
      } else {
        this.showNotice(message, "error");
      }
    } finally {
      if (confirmationId) window.lxEnv?.cancelLyricSave?.(confirmationId).catch?.(() => {});
      if (this.songInfoSaveContextMatches(generation, trackPath, candidateId)) {
        this.songInfoDialog.lyricConfirmationId = "";
        this.songInfoDialog.lyricSaveBusy = false;
      }
    }
  },
  async undoLastLyricSave() {
    const transactionId = String(this.lastLyricSaveTransactionId || "");
    const trackPath = String(this.lastLyricSaveTrackPath || this.currentPath || "");
    if (!transactionId || this.lyricUndoBusy) return;
    const undoStateGeneration = ++this._lyricUndoStateGeneration;
    this.lyricUndoBusy = true;
    try {
      const result = await window.lxEnv?.undoLyricSave?.(transactionId);
      if (!result?.ok || result.status !== "undone") {
        if (undoStateGeneration === this._lyricUndoStateGeneration) {
          this.showNotice(String(result?.message || "歌词已变化，无法撤销"), "error");
        }
        return;
      }
      if (undoStateGeneration !== this._lyricUndoStateGeneration) return;
      this.lastLyricSaveTransactionId = "";
      this.lastLyricSaveTrackPath = "";
      if (this.songInfoDialog.visible) {
        this.songInfoDialog.lyricSaveMessage = "已撤销";
        await this.refreshSongInfoLyricFile();
      }
      await this.refreshCurrentLyricsAfterSidecarChange(trackPath);
      await this.loadRecentLyricSave();
      this.showNotice("歌词保存已撤销");
    } catch (error) {
      this.showNotice(this.getOperationUserMessage(error, "撤销失败"), "error");
    } finally {
      this.lyricUndoBusy = false;
    }
  },
  async loadRecentLyricSave() {
    if (!window.lxEnv || typeof window.lxEnv.getRecentLyricSave !== "function") return;
    const undoStateGeneration = ++this._lyricUndoStateGeneration;
    try {
      const result = await window.lxEnv.getRecentLyricSave();
      if (!result?.ok || undoStateGeneration !== this._lyricUndoStateGeneration) return;
      this.lastLyricSaveTransactionId = String(result.transaction?.transactionId || "");
      this.lastLyricSaveTrackPath = "";
    } catch (_) {
      // 撤销记录恢复失败不影响播放和歌曲信息查询。
    }
  },
  songInfoCandidateStatus(item) {
    if (item?.recommendation === "strong") return "匹配";
    if (item?.recommendation === "medium") return "待确认";
    return "不匹配";
  },
  songInfoCandidateMeta(item) {
    const candidate = item?.candidate || {};
    const parts = [];
    const releaseDate = String(candidate.releaseDate || "").trim();
    if (releaseDate) parts.push(releaseDate);
    const duration = Number(candidate.durationSeconds || 0);
    if (duration > 0) parts.push(this.formatTime(duration));
    const versionLabels = {
      live: "现场",
      "dj-mix": "DJ Mix",
      remix: "Remix",
      acoustic: "不插电",
      instrumental: "纯音乐",
      karaoke: "卡拉 OK",
      "tv-size": "TV Size",
      remaster: "重制",
      "radio-edit": "Radio Edit",
      extended: "加长版",
      demo: "Demo",
      mono: "单声道",
      "sped-up": "加速版",
      slowed: "减速版",
      nightcore: "Nightcore",
      "language-en": "英文版",
      "language-ja": "日文版",
      "language-ko": "韩文版",
      "language-mandarin": "国语版",
      "language-cantonese": "粤语版",
    };
    const versions = [...new Set((candidate.versionTerms || []).map((term) => versionLabels[term]).filter(Boolean))];
    if (versions.length) parts.push(versions.join("、"));
    const lyrics = candidate.lyrics;
    if (lyrics?.available) {
      const quality = { word: "逐字歌词", line: "逐行歌词", plain: "纯文本歌词" }[lyrics.qualityLevel]
        || (lyrics.synced ? "同步歌词" : "歌词");
      const coverage = lyrics.qualityLevel === "word" && lyrics.lyricLines > 0
        ? `（${lyrics.wordTimedLines}/${lyrics.lyricLines} 行有字时间）` : "";
      const channels = [];
      if (lyrics.channels?.includes("translation")) channels.push("翻译");
      if (lyrics.channels?.includes("romanization")) channels.push("罗马音");
      parts.push([quality + coverage, ...channels].join("、"));
    }
    return parts.join(" · ");
  },
  songInfoProvenanceFields(item) {
    const provenance = item?.candidate?.provenance;
    if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return "";
    return Object.keys(provenance)
      .filter((field) => SONG_INFO_LOOKUP_FIELDS.includes(field))
      .map((field) => this.songInfoFieldLabel(field))
      .join("、");
  },
  songInfoFieldLabel(field) {
    return {
      title: "标题",
      artists: "歌手",
      album: "专辑",
      albumArtists: "专辑歌手",
      releaseDate: "日期",
      trackNumber: "曲号",
      trackTotal: "总曲数",
      discNumber: "碟号",
      discTotal: "总碟数",
      genres: "流派",
      cover: "封面",
      lyrics: "歌词",
      composers: "作曲",
      lyricists: "作词",
    }[field] || field;
  },
  formatSongInfoValue(field, value) {
    if (field === "cover") return value === true || value?.url || value?.assetId ? "有封面" : "—";
    if (field === "lyrics") return value ? "有歌词" : "—";
    if (Array.isArray(value)) return value.filter(Boolean).join("、") || "—";
    if (typeof value === "number") return value > 0 ? String(value) : "—";
    return String(value || "").trim() || "—";
  },
  visibleSongInfoDifferences(item) {
    return (item?.differences || []).filter((difference) => difference?.available);
  },
  songInfoSourceSummary() {
    const sources = this.songInfoDialog.sources || [];
    if (!sources.length) return "";
    return sources.map((source) => {
      if (source.status === "ok") return `${source.label || source.id} ${source.count || 0} 项`;
      if (source.status === "empty") return `${source.label || source.id} 暂无结果`;
      return source.message || `${source.label || source.id} 查询失败`;
    }).join(" · ");
  },
  removeTrackFromCurrentPlaylist(path = "") {
    const trackPath = String(path || this.trackContextMenu?.path || "");
    const playlist = this.getCurrentCustomPlaylist();
    this.closeTrackContextMenu();
    if (!playlist || !trackPath || !Array.isArray(playlist.tracks)) return false;
    const index = playlist.tracks.indexOf(trackPath);
    if (index < 0) return false;
    playlist.tracks = playlist.tracks.filter((item) => item !== trackPath);
    this.saveCustomPlaylists();
    this.buildFolderPlaylists();
    const nextPath = playlist.tracks[Math.min(index, Math.max(0, playlist.tracks.length - 1))] || "";
    if (this.selectedPath === trackPath) {
      this.selectedPath = nextPath || this.currentPath || "";
    }
    this.restorePlaylistScroll(playlist.id);
    return true;
  },
  handleDragStart(e, pl) {
    // 仅允许非系统歌单，且需长按激活（系统=全部歌曲）
    if (!this.dragState.enableDrag || pl.type === "system") {
      e.preventDefault();
      return;
    }
    this.dragState.draggingId = pl.id;
    this.dragState.overId = "";
    this.dragState.lastPreviewKey = "";
    e.dataTransfer.effectAllowed = "move";
  },
  handleDragOver(e, pl) {
    if (!this.dragState.draggingId || pl.id === this.dragState.draggingId) return;
    if (pl.type === "system") return;
    const rect = e?.currentTarget?.getBoundingClientRect?.();
    if (!rect) return;
    const insertAfter = e.clientY >= (rect.top + rect.height / 2);
    const previewKey = `${this.dragState.draggingId}->${pl.id}:${insertAfter ? "after" : "before"}`;
    if (this.dragState.lastPreviewKey === previewKey) return;
    const changed = this.reorderNonSystemPlaylists(this.dragState.draggingId, pl.id, insertAfter);
    if (changed) {
      // 某些环境下 drop 事件不稳定，拖动中一旦顺序变化即持久化
      this.persistCurrentPlaylistOrder();
    }
    this.dragState.overId = pl.id;
    this.dragState.lastPreviewKey = previewKey;
  },
  handleDrop() {
    if (this.dragState.draggingId) {
      this.persistCurrentPlaylistOrder();
    }
    this.handleDragEnd();
  },
  handleDragEnd() {
    if (this.dragState.draggingId) {
      this.persistCurrentPlaylistOrder();
    }
    this.dragState.draggingId = "";
    this.dragState.overId = "";
    this.dragState.lastPreviewKey = "";
    this.dragState.enableDrag = false;
    if (this.dragState.longPressTimer) clearTimeout(this.dragState.longPressTimer);
    this.dragState.longPressTimer = null;
  },
  startLongPress(pl) {
    if (pl.type === "system") return;
    if (this.dragState.longPressTimer) clearTimeout(this.dragState.longPressTimer);
    this.dragState.longPressTimer = setTimeout(() => {
      this.dragState.enableDrag = true;
    }, 350); // 长按 350ms 启动拖拽
  },
  cancelLongPress() {
    if (this.dragState.longPressTimer) clearTimeout(this.dragState.longPressTimer);
    this.dragState.longPressTimer = null;
    this.dragState.enableDrag = false;
  },
  loadPlaylistOrder() {
    try {
      const raw = readStoredString(STORAGE_KEYS.PLAYLIST_ORDER, null);
      if (!raw) return {};
      return JSON.parse(raw);
    } catch {
      return {};
    }
  },
  savePlaylistOrder(orderMap) {
    writeStored(STORAGE_KEYS.PLAYLIST_ORDER, JSON.stringify(orderMap));
  },
  async loadRanking(path) {
    if(this.featureEnabled?.('recommendation')===false)return;
    if (!path) return;
    this.rankingLoading = true;
    this.rankingFor = path;
    this.rankingScrollTop = 0;
    try {
      const { data } = await axios.post(`${this.baseUrl}/recommend`, {
        track_path: path,
        history: [],
        return_all_ranked: true,
        scope: this.recommendFullMode ? "all" : "local",
      });
      const all = data.all_ranked || [];
      const dedup = [];
      const seenByTitle = new Map();
      all.forEach((r) => {
        const info = this.getTrackDedupInfo(r.path);
        const titleKey = info.titleNorm;
        const artistKey = info.artistNorm;
        if (!titleKey) {
          dedup.push({
            ...r,
            name: info.titleDisplay || this.extractName(r.path),
          });
          return;
        }
        const artistSet = seenByTitle.get(titleKey) || new Set();
        const duplicate =
          artistSet.has(artistKey) ||
          artistSet.has("") ||
          (artistKey === "" && artistSet.size > 0);
        if (duplicate) return;
        artistSet.add(artistKey);
        seenByTitle.set(titleKey, artistSet);
        dedup.push({
          ...r,
          name: info.titleDisplay || this.extractName(r.path),
        });
      });
      this.rankingList = dedup.map((r, idx) => ({
        ...r,
        rank: idx + 1,
      }));
    } catch (e) {
      console.warn("排行获取失败", e);
    } finally {
      this.rankingLoading = false;
      this.$nextTick(() => {
        const body = this.$refs.rankingTableBody;
        if (body) body.scrollTop = 0;
        this.refreshVirtualViewport();
      });
    }
  },
  focusSearchInput() {
    if (this.view !== "library" && this.view !== "ranking" && this.view !== "online") {
      this.view = "library";
    }
    if (this._focusSearchRafId) cancelAnimationFrame(this._focusSearchRafId);
    this._focusSearchRafId = requestAnimationFrame(() => {
      this._focusSearchRafId = 0;
      const selector = this.view === "ranking"
        ? ".ranking-search-left"
        : (this.view === "online" ? ".online-topbar .search-input" : ".library-search-input");
      const el = document.querySelector(selector);
      if (el) {
        el.focus();
        if (typeof el.select === "function") el.select();
      }
    });
  },
  locateTrack(path, options = {}) {
    if (!path) return false;
    const {
      animate = true,
      center = false,
      flash = true,
      startup = false,
      loadGeneration = this._trackLoadGeneration,
      interactionRevision = Number(this._libraryInteractionRevision || 0),
    } = options;
    const startupStillCurrent = () => (
      !startup
      || (
        Number(loadGeneration) === Number(this._trackLoadGeneration)
        && Number(interactionRevision) === Number(this._libraryInteractionRevision || 0)
      )
    );
    if (!startupStillCurrent()) return false;
    this.libraryBrowseMode = "songs";
    const current = this.playlists.find((p) => p.id === this.currentPlaylist);
    const inCurrent = !!current && Array.isArray(current.tracks) && current.tracks.includes(path);
    const targetId = inCurrent ? this.currentPlaylist : "all";
    if (this.currentPlaylist !== targetId) {
      this.rememberCurrentPlaylistScroll();
      this.currentPlaylist = targetId;
    }
    if (!this.filteredTracks.some((track) => track.path === path) && this.keyword) {
      this._skipNextKeywordScrollReset = true;
      this.searchInputResetRevision += 1;
      this._librarySearchComposing = false;
      this.keywordDraft = "";
      this.keyword = "";
    }
    if (flash) {
      this.playlistLocateFlashId = targetId;
      if (this._playlistLocateFlashTimer) clearTimeout(this._playlistLocateFlashTimer);
      this._playlistLocateFlashTimer = setTimeout(() => {
        this._playlistLocateFlashTimer = null;
        if (this.playlistLocateFlashId === targetId) this.playlistLocateFlashId = "";
      }, 700);
    }
    this.selectedPath = path;
    if (flash) {
      this.locateHighlightPath = path;
      if (this._locateHighlightTimer) clearTimeout(this._locateHighlightTimer);
      this._locateHighlightTimer = setTimeout(() => {
        this._locateHighlightTimer = null;
        if (this.locateHighlightPath === path) this.locateHighlightPath = "";
      }, 1200);
    }
    this.$nextTick(() => {
      if (!startupStillCurrent()) return;
      this.refreshVirtualViewport();
      const idx = this.filteredTracks.findIndex((t) => t.path === path);
      if (idx >= 0) {
        this.scrollLibraryToIndex(idx, { center, rowCount: this.filteredTracks.length });
      }
      if (center) return;
      try {
        const selector = `.tracks-pane .row[data-path="${CSS.escape(path)}"]`;
        const el = document.querySelector(selector);
        if (el && el.parentElement) {
          el.scrollIntoView({ block: "center", behavior: animate ? "smooth" : "auto" });
        }
      } catch (e) {
        // ignore
      }
    });
    return true;
  },
  computeOrderMap(list) {
    const map = {};
    list
      .filter((p) => p.type !== "system")
      .forEach((p, idx) => {
        map[p.id] = idx;
      });
    return map;
  },
  selectPlaylist(id) {
    this.libraryBrowseMode = "songs";
    const changedView = this.view !== "library";
    if (changedView) this.setView("library");
    if (this.currentPlaylist === id) return;
    if (!changedView) this.markLibraryUserInteraction();
    this.rememberCurrentPlaylistScroll();
    this.currentPlaylist = id;
    this.restorePlaylistScroll(id);
    this.queueUiSnapshotSave();
  },
  getPlaybackQueueTracks() {
    // 复用界面已计算的搜索结果，循环和随机均遵守当前可见列表及顺序。
    if (Array.isArray(this.filteredTracks)) return this.filteredTracks;
    return this.searchTrackList(this.getCurrentPlaylistTracks(), this.keyword, this.fuzzy);
  },
  getCurrentPlaylistTracks() {
    if (this.libraryBrowseMode === "folders") return this.folderBrowserDirectory.tracks.map(path => this.trackByPath?.get(path)).filter(Boolean);
    const pl = this.playlists.find((p) => p.id === this.currentPlaylist);
    if (!pl || !Array.isArray(pl.tracks)) return this.tracks;
    return pl.tracks.map((p) => (
      this.trackByPath?.get(p)
      || this.onlineTrackMap[p]
      || this.prepareTrackForList({ path: p, name: this.extractName(p), artist: "", album: "" }, { buildDoc: false })
    ));
  },
  pathDirname(p) {
    const parts = p.split(/[/\\]/);
    parts.pop();
    return parts.join("/");
  },
  pathBasename(p) {
    return p.split(/[/\\]/).pop();
  },
};

const songInfoBatchMethods = {
  openSongInfoBatchSettings() {
    this.settingsTab = "song-info";
    this.songInfoBatchReviewLimit = 30;
    this.songInfoBatchFailureLimit = 10;
    this.loadSongInfoBatchTasks();
  },
  toggleSongInfoBatchField(key) {
    if (!Object.hasOwn(DEFAULT_SONG_INFO_BATCH_FIELDS, key)) return;
    this.songInfoBatchSettings.fields[key] = !this.songInfoBatchSettings.fields[key];
  },
  selectedSongInfoBatchFields() {
    const selected = this.songInfoBatchFieldOptions
      .filter((option) => Boolean(this.songInfoBatchSettings.fields[option.key]))
      .map((option) => option.key);
    if (selected.includes("trackNumber")) selected.push("trackTotal");
    if (selected.includes("discNumber")) selected.push("discTotal");
    return [...new Set(selected)];
  },
  songInfoBatchSourceTracks(scope = this.songInfoBatchSettings.scope) {
    const normalizedScope = SONG_INFO_BATCH_SCOPES.has(scope) ? scope : "all";
    if (normalizedScope === "selected") {
      const selected = this.trackByPath?.get(this.selectedPath);
      return selected ? [selected] : [];
    }
    if (normalizedScope === "playlist") return this.getCurrentPlaylistTracks();
    return this.tracks;
  },
  localSongInfoBatchTracks(scope = this.songInfoBatchSettings.scope) {
    const seen = new Set();
    return this.songInfoBatchSourceTracks(scope)
      .map((item) => this.trackByPath?.get(item?.path || item))
      .filter((track) => {
        const trackPath = String(track?.path || "");
        if (!trackPath || this.isOnlineToken(trackPath) || seen.has(trackPath)) return false;
        seen.add(trackPath);
        return true;
      })
      .map((track) => ({
        resourceId: track.resourceId || track.resource_id || "",
        songKey: track.songKey || track.song_key || "",
        path: track.path,
      }));
  },
  applySongInfoBatchUpdate(task, bumpRevision = true) {
    if (bumpRevision) this._songInfoBatchRevision = Number(this._songInfoBatchRevision || 0) + 1;
    if (task?.kind === "task-patch") {
      const header = task.task;
      if (!header?.id) return;
      const existing = (this.songInfoBatchTasks || []).find((item) => item.id === header.id);
      if (!existing) {
        this.loadSongInfoBatchTasks();
        return;
      }
      const changedItems = new Map((Array.isArray(task.items) ? task.items : []).map((item) => [String(item?.id || ""), item]));
      const items = (existing.items || []).map((item) => {
        const changed = changedItems.get(String(item.id));
        return changed ? { ...item, ...changed } : item;
      });
      this.applySongInfoBatchUpdate({ ...existing, ...header, items }, false);
      return;
    }
    if (!task?.id) return;
    const next = (this.songInfoBatchTasks || []).filter((item) => item.id !== task.id);
    next.push(task);
    next.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
    this.songInfoBatchTasks = next;
    const current = next.find((item) => item.id === this.songInfoBatchCurrentId);
    if (!current || (this.songInfoBatchTaskIsUnfinished(task) && !this.songInfoBatchTaskIsUnfinished(current))) {
      this.songInfoBatchCurrentId = task.id;
    }
  },
  async loadSongInfoBatchTasks() {
    if (!window.lxEnv?.listSongInfoBatchTasks) return;
    const generation = Number(this._songInfoBatchLoadGeneration || 0) + 1;
    this._songInfoBatchLoadGeneration = generation;
    const revision = Number(this._songInfoBatchRevision || 0);
    try {
      const result = await window.lxEnv.listSongInfoBatchTasks();
      if (generation !== this._songInfoBatchLoadGeneration || revision !== this._songInfoBatchRevision) return;
      if (!result?.ok) return;
      this.songInfoBatchTasks = Array.isArray(result.tasks) ? result.tasks : [];
      this._songInfoBatchRevision += 1;
      this.songInfoBatchStoreBlocked = Boolean(result.writeBlocked);
      this.songInfoLyricBatchAvailable = Boolean(result.lyricSidecarAvailable);
      if (!this.songInfoBatchCurrentId || !this.songInfoBatchTasks.some((task) => task.id === this.songInfoBatchCurrentId)) {
        const unfinished = this.songInfoBatchTasks.find((task) => this.songInfoBatchTaskIsUnfinished(task));
        this.songInfoBatchCurrentId = unfinished?.id || this.songInfoBatchTasks[0]?.id || "";
      }
      if (this.songInfoBatchStoreBlocked) this.songInfoBatchMessage = "任务记录无法恢复";
    } catch (_) {
      if (generation !== this._songInfoBatchLoadGeneration || revision !== this._songInfoBatchRevision) return;
      this.songInfoBatchMessage = "任务记录加载失败";
    }
  },
  currentSongInfoBatchTask() {
    return this.songInfoBatchTasks.find((task) => task.id === this.songInfoBatchCurrentId) || null;
  },
  songInfoBatchTaskIsUnfinished(task) {
    return Boolean(task?.id) && !["completed", "cancelled", "failed"].includes(task.state);
  },
  hasUnfinishedSongInfoBatchTask() {
    return this.songInfoBatchTasks.some((task) => this.songInfoBatchTaskIsUnfinished(task));
  },
  isSongInfoBatchRunning(task = this.currentSongInfoBatchTask()) {
    return ["scanning", "querying", "scoring", "writing", "verifying", "cancelling"].includes(task?.state);
  },
  songInfoBatchStatusLabel(task) {
    return {
      draft: "尚未开始",
      querying: "正在查找",
      writing: "正在保存",
      verifying: "正在检查",
      cancelling: "正在取消",
      cancelled: "已取消",
      paused: "已暂停",
      "paused-rate-limit": "稍后继续",
      "awaiting-confirmation": "需要确认",
      completed: "查找完成",
      failed: "查找失败",
    }[task?.state] || "";
  },
  songInfoBatchProgress(task) {
    const total = Math.max(0, Number(task?.counts?.total || 0));
    if (!total) return 0;
    return Math.max(0, Math.min(100, ((total - Number(task?.counts?.pending || 0)) / total) * 100));
  },
  songInfoBatchActiveTrackText(task) {
    const active = (task?.items || []).find((item) => ["querying", "writing", "verifying"].includes(item?.status));
    const trackPath = String(active?.track?.path || "");
    if (!trackPath) return "";
    const track = this.trackByPath?.get(trackPath);
    const title = String(track?.title || this.pathBasename(trackPath) || "").trim();
    const artist = String(track?.artist || (Array.isArray(track?.artists) ? track.artists.join("、") : "")).trim();
    return [title, artist].filter(Boolean).join(" · ");
  },
  songInfoBatchSummary(task) {
    if (!task?.counts) return "";
    const total = Math.max(0, Number(task.counts.total || 0));
    const checked = Math.max(0, total - Number(task.counts.pending || 0));
    const parts = [`已检查 ${checked}/${total}`];
    if (task.counts.matchedAuto) parts.push(`高匹配 ${task.counts.matchedAuto}`);
    if (task.counts.writtenAuto) parts.push(`已保存 ${task.counts.writtenAuto}`);
    if (task.counts.awaitingConfirmation) parts.push(`需要确认 ${task.counts.awaitingConfirmation}`);
    if (task.counts.confirmed) parts.push(`${task.mode === "lyric-sidecar" ? "已保存" : "已确认"} ${task.counts.confirmed}`);
    if (task.counts.skippedComplete) parts.push(`无需补充 ${task.counts.skippedComplete}`);
    if (task.counts.skipped) parts.push(`已跳过 ${task.counts.skipped}`);
    const lowMatch = this.songInfoBatchUncertainCount(task);
    const empty = Math.max(0, Number(task.counts.noMatch || 0) - lowMatch);
    if (lowMatch) parts.push(`低匹配 ${lowMatch}`);
    if (empty) parts.push(`无结果 ${empty}`);
    if (task.counts.failed) parts.push(`失败 ${task.counts.failed}`);
    if (task.counts.cancelled) parts.push(`已取消 ${task.counts.cancelled}`);
    return parts.join(" · ");
  },
  songInfoBatchReviewItems(task = this.currentSongInfoBatchTask()) {
    return (task?.items || [])
      .filter((item) => item.status === "awaiting-confirmation")
      .slice(0, this.songInfoBatchReviewLimit);
  },
  songInfoBatchAutomaticItems(task = this.currentSongInfoBatchTask()) {
    return (task?.items || []).filter((item) => item.status === "matched-auto" && item.candidates?.length).slice(0, 30);
  },
  songInfoBatchUncertainItems(task = this.currentSongInfoBatchTask()) {
    return (task?.items || [])
      .filter((item) => item.status === "no-match" && item.candidates?.length)
      .slice(0, this.songInfoBatchUncertainLimit);
  },
  songInfoBatchUncertainCount(task = this.currentSongInfoBatchTask()) {
    return (task?.items || []).filter((item) => item.status === "no-match" && item.candidates?.length).length;
  },
  songInfoBatchEmptyItems(task = this.currentSongInfoBatchTask()) {
    return (task?.items || [])
      .filter((item) => item.status === "no-match" && !item.candidates?.length)
      .slice(0, this.songInfoBatchEmptyLimit);
  },
  songInfoBatchEmptyCount(task = this.currentSongInfoBatchTask()) {
    return (task?.items || []).filter((item) => item.status === "no-match" && !item.candidates?.length).length;
  },
  songInfoBatchSourceResultText(item) {
    const sources = Array.isArray(item?.sources) ? item.sources : [];
    if (!sources.length) return "没有可用结果";
    return sources.map((source) => {
      const name = String(source?.label || source?.id || "来源");
      if (source?.status === "empty") return `${name} 无结果`;
      if (source?.status === "ok") return `${name} 未找到合适候选`;
      if (source?.status === "rate-limited") return `${name} 请求过多`;
      if (source?.status === "timeout") return `${name} 响应超时`;
      return `${name} 暂时不可用`;
    }).join(" · ");
  },
  songInfoBatchFailureItems(task = this.currentSongInfoBatchTask()) {
    return (task?.items || [])
      .filter((item) => item.status === "failed")
      .slice(0, this.songInfoBatchFailureLimit);
  },
  songInfoBatchItemText(item) {
    const trackPath = String(item?.track?.path || "");
    const track = this.trackByPath?.get(trackPath);
    const title = String(track?.title || this.pathBasename(trackPath) || "歌曲").trim();
    const artist = String(track?.artist || (Array.isArray(track?.artists) ? track.artists.join("、") : "")).trim();
    return [title, artist].filter(Boolean).join(" · ");
  },
  songInfoBatchErrorText(item) {
    const code = String(item?.errorCode || "").toUpperCase();
    if (/RATE/.test(code)) return "请求过于频繁";
    if (/TRACK_MISSING|AUDIO_MISSING|ENOENT/.test(code)) return "歌曲文件不存在";
    if (/EXTERNAL_CHANGE|CANDIDATE_CHANGED|CONFLICT/.test(code)) return "内容已变化";
    if (/SAVE|WRITE|VERIFY|LYRIC/.test(code)) return "保存失败";
    if (/OFFLINE|UNAVAILABLE|TIMEOUT|QUERY|FAILED/.test(code)) return "暂时无法查询";
    return "处理失败";
  },
  songInfoBatchChoiceKey(task, item) {
    return `${String(task?.id || "")}:${String(item?.id || "")}`;
  },
  songInfoBatchCandidateChoice(task, item) {
    return Math.max(0, Number(this.songInfoBatchChoices[this.songInfoBatchChoiceKey(task, item)] || 0));
  },
  songInfoBatchSelectedCandidate(task, item) {
    return item?.candidates?.[this.songInfoBatchCandidateChoice(task, item)] || null;
  },
  setSongInfoBatchCandidateChoice(task, item, value) {
    this.songInfoBatchChoices[this.songInfoBatchChoiceKey(task, item)] = Math.max(0, Number(value) || 0);
  },
  songInfoBatchCandidateText(candidate) {
    const data = candidate?.candidate || {};
    return [data.title, (data.artists || []).join("、"), data.album].filter(Boolean).join(" · ");
  },
  songInfoBatchCurrentText(item) {
    const current = item?.current || {};
    return [current.title, (current.artists || []).join("、"), current.album].filter(Boolean).join(" · ") || "文件名信息";
  },
  songInfoBatchCandidateReason(candidate) {
    if (!candidate) return "";
    const source = String(candidate?.candidate?.sourceLabel || candidate?.candidate?.provider || "").trim();
    const score = Number(candidate?.score);
    const reasons = Array.isArray(candidate?.reasons) ? candidate.reasons.filter(Boolean) : [];
    const blockers = Array.isArray(candidate?.blockers) ? candidate.blockers.filter(Boolean) : [];
    return [
      source,
      Number.isFinite(score) ? `匹配 ${Math.round(score)} 分` : "",
      ...reasons.slice(0, 2),
      ...blockers.slice(0, 2),
    ].filter(Boolean).join(" · ");
  },
  songInfoBatchCandidateSource(candidate) {
    return String(candidate?.candidate?.sourceLabel || candidate?.candidate?.provider || "未知").trim();
  },
  songInfoBatchCandidateScore(candidate) {
    const score = Number(candidate?.score);
    return Number.isFinite(score) ? Math.round(score) : 0;
  },
  songInfoBatchCandidateEvidence(candidate) {
    return (Array.isArray(candidate?.reasons) ? candidate.reasons : []).filter(Boolean).slice(0, 3).join("；");
  },
  songInfoBatchCandidateDoubts(candidate) {
    return (Array.isArray(candidate?.blockers) ? candidate.blockers : []).filter(Boolean).slice(0, 3).join("；");
  },
  async startSongInfoBatch() {
    if (this.songInfoBatchBusy || this.songInfoBatchStoreBlocked) return;
    const unfinished = this.songInfoBatchTasks.find((task) => this.songInfoBatchTaskIsUnfinished(task));
    if (unfinished) {
      this.songInfoBatchCurrentId = unfinished.id;
      this.songInfoBatchMessage = "请先完成当前任务";
      return;
    }
    const requestedFields = this.selectedSongInfoBatchFields();
    if (!requestedFields.length) {
      this.songInfoBatchMessage = "请选择补充内容";
      return;
    }
    const tracks = this.localSongInfoBatchTracks();
    if (!tracks.length) {
      this.songInfoBatchMessage = this.songInfoBatchSettings.scope === "selected"
        ? "先选择一首本地歌曲"
        : "当前范围没有本地歌曲";
      return;
    }
    this.songInfoBatchBusy = true;
    this.songInfoBatchMessage = "";
    try {
      const autoThreshold = clampNumberAllowZero(this.songInfoBatchSettings.autoThreshold, 95, 90, 99);
      const manualThreshold = clampNumberAllowZero(this.songInfoBatchSettings.manualThreshold, 75, 60, autoThreshold - 1);
      const concurrency = clampNumberAllowZero(this.songInfoBatchSettings.concurrency, 4, 1, 12);
      this.songInfoBatchSettings.autoThreshold = autoThreshold;
      this.songInfoBatchSettings.manualThreshold = manualThreshold;
      this.songInfoBatchSettings.concurrency = concurrency;
      const created = await window.lxEnv.createSongInfoBatchTask({
        tracks,
        requestedFields,
        autoThreshold,
        manualThreshold,
        minimumGap: 8,
        concurrency,
      });
      if (!created?.ok || !created.task) {
        this.songInfoBatchMessage = created?.message || "无法创建任务";
        return;
      }
      this.applySongInfoBatchUpdate(created.task);
      this.songInfoBatchCurrentId = created.task.id;
      const started = await window.lxEnv.startSongInfoBatchTask(created.task.id);
      if (!started?.ok) this.songInfoBatchMessage = started?.message || "无法开始任务";
    } catch (_) {
      this.songInfoBatchMessage = "无法开始任务";
    } finally {
      this.songInfoBatchBusy = false;
    }
  },
  async startLyricSidecarBatch() {
    if (this.songInfoBatchBusy || this.songInfoBatchStoreBlocked) return;
    if (!this.songInfoLyricBatchAvailable) {
      this.songInfoBatchMessage = "暂无歌词来源";
      return;
    }
    if (!Object.values(this.songInfoBatchSettings.lyricSources || {}).some(Boolean)) {
      this.songInfoBatchMessage = "请选择歌词来源";
      return;
    }
    const unfinished = this.songInfoBatchTasks.find((task) => this.songInfoBatchTaskIsUnfinished(task));
    if (unfinished) {
      this.songInfoBatchCurrentId = unfinished.id;
      this.songInfoBatchMessage = "请先完成当前任务";
      return;
    }
    const tracks = this.localSongInfoBatchTracks();
    if (!tracks.length) {
      this.songInfoBatchMessage = this.songInfoBatchSettings.scope === "selected"
        ? "先选择一首本地歌曲"
        : "当前范围没有本地歌曲";
      return;
    }
    this.songInfoBatchBusy = true;
    this.songInfoBatchMessage = "";
    try {
      const autoThreshold = clampNumberAllowZero(this.songInfoBatchSettings.autoThreshold, 95, 90, 99);
      const manualThreshold = clampNumberAllowZero(this.songInfoBatchSettings.manualThreshold, 75, 60, autoThreshold - 1);
      const concurrency = clampNumberAllowZero(this.songInfoBatchSettings.concurrency, 4, 1, 12);
      this.songInfoBatchSettings.autoThreshold = autoThreshold;
      this.songInfoBatchSettings.manualThreshold = manualThreshold;
      this.songInfoBatchSettings.concurrency = concurrency;
      const created = await window.lxEnv.createSongInfoBatchTask({
        mode: "lyric-sidecar",
        tracks,
        requestedFields: ["lyrics"],
        autoThreshold,
        manualThreshold,
        minimumGap: 8,
        concurrency,
        lyricOptions: {
          includeTranslation: this.lyricSaveIncludeTranslation,
          includeRomanization: this.lyricSaveIncludeRomanization,
          sources: Object.entries(this.songInfoBatchSettings.lyricSources || {})
            .filter(([, enabled]) => Boolean(enabled))
            .map(([source]) => source),
          skipExisting: this.songInfoBatchSettings.skipExistingLyrics !== false,
          format: this.songInfoBatchSettings.lyricFormat || "enhanced-lrc",
        },
      });
      if (!created?.ok || !created.task) {
        this.songInfoBatchMessage = created?.message || "无法创建任务";
        return;
      }
      this.applySongInfoBatchUpdate(created.task);
      this.songInfoBatchCurrentId = created.task.id;
      const started = await window.lxEnv.startSongInfoBatchTask(created.task.id);
      if (!started?.ok) this.songInfoBatchMessage = started?.message || "无法开始任务";
    } catch (_) {
      this.songInfoBatchMessage = "无法开始任务";
    } finally {
      this.songInfoBatchBusy = false;
    }
  },
  async continueSongInfoBatch(task = this.currentSongInfoBatchTask()) {
    if (!task?.id || this.songInfoBatchBusy) return;
    this.songInfoBatchBusy = true;
    this.songInfoBatchMessage = "";
    try {
      const result = await window.lxEnv.startSongInfoBatchTask(task.id);
      if (!result?.ok) this.songInfoBatchMessage = result?.message || "无法继续任务";
    } catch (_) {
      this.songInfoBatchMessage = "无法继续任务";
    } finally {
      this.songInfoBatchBusy = false;
    }
  },
  async cancelSongInfoBatch(task = this.currentSongInfoBatchTask()) {
    if (!task?.id) return;
    await window.lxEnv?.cancelSongInfoBatchTask?.(task.id);
  },
  async retrySongInfoBatch(task = this.currentSongInfoBatchTask(), statuses = ["failed"]) {
    if (!task?.id || this.songInfoBatchBusy) return;
    const allowed = new Set(Array.isArray(statuses) ? statuses.map(String) : []);
    const itemIds = (task.items || [])
      .filter((item) => allowed.has(String(item?.status || "")))
      .map((item) => String(item.id));
    if (!itemIds.length) return;
    this.songInfoBatchBusy = true;
    try {
      const retried = await window.lxEnv.retrySongInfoBatchTask({ taskId: task.id, itemIds });
      if (retried?.task) this.applySongInfoBatchUpdate(retried.task);
      if (retried?.ok && retried.changed > 0) {
        const started = await window.lxEnv.startSongInfoBatchTask(task.id);
        if (!started?.ok) this.songInfoBatchMessage = started?.message || "无法重试";
      }
    } catch (_) {
      this.songInfoBatchMessage = "无法重试";
    } finally {
      this.songInfoBatchBusy = false;
    }
  },
  async clearSongInfoLookupCache() {
    if (this.songInfoCacheBusy || this.hasUnfinishedSongInfoBatchTask()) return;
    this.songInfoCacheBusy = true;
    this.songInfoCacheMessage = "";
    this.songInfoCacheMessageTone = "";
    try {
      const result = await window.lxEnv?.clearSongInfoCache?.();
      if (!result?.ok) {
        this.songInfoCacheMessage = result?.message || "缓存清理失败";
        this.songInfoCacheMessageTone = "error";
        return;
      }
      const cleared = Number(result.queryEntries || 0) + Number(result.coverFiles || 0);
      this.songInfoCacheMessage = cleared > 0 ? "已清理" : "没有可清理的缓存";
    } catch (_) {
      this.songInfoCacheMessage = "缓存清理失败";
      this.songInfoCacheMessageTone = "error";
    } finally {
      this.songInfoCacheBusy = false;
    }
  },
  async confirmSongInfoBatchItem(task, item) {
    if (!task?.id || !item?.id) return;
    const result = await window.lxEnv?.confirmSongInfoBatchCandidate?.({
      taskId: task.id,
      itemId: item.id,
      candidateIndex: this.songInfoBatchCandidateChoice(task, item),
    });
    if (result?.task) this.applySongInfoBatchUpdate(result.task);
    else if (!result?.ok) this.songInfoBatchMessage = result?.message || "无法确认结果";
  },
  async skipSongInfoBatchItem(task, item) {
    if (!task?.id || !item?.id) return;
    const result = await window.lxEnv?.skipSongInfoBatchItem?.({ taskId: task.id, itemId: item.id });
    if (result?.task) this.applySongInfoBatchUpdate(result.task);
    else if (!result?.ok) this.songInfoBatchMessage = result?.message || "无法跳过";
  },
};

const utilityMethods = {
  openSettingsCategory(categoryId) {
    const category = window.FlowaveSettings.categoryFor(this.settingsTab);
    const chosen = window.FlowaveSettings.categories.find(c=>c.id===categoryId);
    if (chosen) this.openSettingsSection(category?.id===categoryId ? this.settingsTab : chosen.pages[0]);
  },
  openSettingsResult(item) {
    if (item) this.openSettingsSection(item.page, item.anchor);
  },
  openSettingsSection(id = "overview", anchor = "") {
    const module=window.FlowaveFeatureModules?.viewModule(id);
    if(module && this.featureEnabled?.(module)===false)id='features';
    const catalog = window.FlowaveSettings;
    if (id === "overview") id = catalog.titles[this.settingsTab] ? this.settingsTab : "general";
    if (!catalog.titles[id]) return;
    this.settingsOverviewQuery = "";
    this.settingsCalibrationOpen = false;
    const generation = this.settingsNavigationGeneration = (this.settingsNavigationGeneration || 0) + 1;
    if (id === "folders") { this.openFolderBrowser(); return; }
    if (id === "insights") { this.setView("insights"); return; }
    this.setView("settings");
    this.settingsTab = id;
    if (id === "song-info") this.openSongInfoBatchSettings();
    this.$nextTick(() => {
      if (generation !== this.settingsNavigationGeneration || this.view !== 'settings' || this.settingsTab !== id) return;
      const body = this.$refs.settingsBody || document.querySelector(".settings-body");
      body?.querySelectorAll('[data-active-setting]').forEach(el=>el.removeAttribute('data-active-setting'));
      if (body) body.scrollTop = 0;
      if (!anchor) return;
      const target = body?.querySelector('[data-setting-id="'+anchor+'"]');
      if (!target) { this.showNotice('此选项在相应功能可用时显示。'); return; }
      for (let parent = target; parent && parent !== body; parent = parent.parentElement) {
        if (parent.tagName === "DETAILS") parent.open = true;
      }
      target.dataset.activeSetting = 'true';
      target.setAttribute('tabindex','-1');
      target.scrollIntoView({block:'center'});
      target.focus({preventScroll:true});
    });
  },
  clearLibrarySearch() {
    this.searchInputResetRevision += 1;
    this._librarySearchComposing = false;
    this.keywordDraft = "";
    this.keyword = "";
    this.$nextTick(() => this.$refs.librarySearchInput?.focus?.());
  },
  showAllLibraryTracks() {
    this.searchInputResetRevision += 1;
    this._librarySearchComposing = false;
    this.keywordDraft = "";
    this.keyword = "";
    this.selectPlaylist("all");
  },
  clearOnlineMessage() {
    this.onlineMessage = "";
    this.onlineMessageTone = "info";
  },
  setOnlineMessage(message, tone = "info") {
    this.onlineMessage = String(message || "").trim();
    this.onlineMessageTone = tone === "error" ? "error" : "info";
  },
  trapDialogFocus(event) {
    const root = event?.currentTarget;
    if (!root) return;
    const controls = Array.from(root.querySelectorAll("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])"));
    if (controls.length < 2) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  },
  requestConfirmation({ title, message, detail = "", confirmLabel = "确认", tone = "primary" } = {}) {
    if (typeof this._confirmDialogResolver === "function") {
      this._confirmDialogResolver(false);
    }
    this._confirmReturnFocus = typeof HTMLElement !== "undefined" && document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    this.confirmDialog = {
      visible: true,
      title: String(title || "确认操作"),
      message: String(message || "").trim(),
      detail: String(detail || "").trim(),
      confirmLabel: String(confirmLabel || "确认"),
      tone: tone === "danger" ? "danger" : "primary",
    };
    return new Promise((resolve) => {
      this._confirmDialogResolver = resolve;
      this.$nextTick(() => this.$refs.confirmDialogCancel?.focus?.());
    });
  },
  resolveConfirmation(confirmed) {
    const resolve = this._confirmDialogResolver;
    const returnFocus = this._confirmReturnFocus;
    this._confirmDialogResolver = null;
    this._confirmReturnFocus = null;
    this.confirmDialog.visible = false;
    if (typeof resolve === "function") resolve(Boolean(confirmed));
    this.$nextTick(() => {
      if (returnFocus?.isConnected) returnFocus.focus?.();
    });
  },
  getOperationUserMessage(error, fallback = "操作失败") {
    const raw = String(error?.response?.data?.detail || error?.message || error || "").toLowerCase();
    if (/显存不足|cuda out of memory/.test(raw)) {
      return `${fallback}，显存不足，请关闭占用显卡的程序后重试。`;
    }
    if (/显卡计算环境不可用|cuda unavailable/.test(raw)) {
      return `${fallback}，显卡加速不可用，请检查显卡驱动与推荐组件。`;
    }
    if (/permission|access denied|eacces|eperm|拒绝访问|没有权限|无权限/.test(raw)) {
      return `${fallback}，请检查文件访问权限。`;
    }
    if (/model|mert|模型/.test(raw)) {
      return `${fallback}，请检查推荐组件和模型。`;
    }
    if (/audio_dir|folder|directory|目录|文件夹/.test(raw)) {
      return `${fallback}，请检查所选文件夹。`;
    }
    if (/timeout|timed out|network|failed to fetch|econn|连接|超时/.test(raw)) {
      return `${fallback}，请稍后重试。`;
    }
    return `${fallback}，请重试。`;
  },
  showNotice(message, tone = "info", duration = 3600) {
    const text = String(message || "").trim();
    if (!text) return;
    if (this._noticeTimer) clearTimeout(this._noticeTimer);
    this.notice = { visible: true, message: text, tone: tone === "error" ? "error" : "info" };
    this._noticeTimer = setTimeout(() => {
      this._noticeTimer = null;
      this.notice.visible = false;
    }, Math.max(1800, Number(duration) || 3600));
  },
  closeNotice() {
    if (this._noticeTimer) {
      clearTimeout(this._noticeTimer);
      this._noticeTimer = null;
    }
    this.notice.visible = false;
  },
  clampContextMenuPosition(event, menuWidth = 210, menuHeight = 170) {
    const margin = 8;
    const rawX = Math.max(margin, Number(event?.clientX || 0));
    const rawY = Math.max(margin, Number(event?.clientY || 0));
    const viewportWidth = Number(window.innerWidth || document.documentElement?.clientWidth || 0);
    const viewportHeight = Number(window.innerHeight || document.documentElement?.clientHeight || 0);
    return {
      x: viewportWidth > 0 ? Math.min(rawX, Math.max(margin, viewportWidth - menuWidth - margin)) : rawX,
      y: viewportHeight > 0 ? Math.min(rawY, Math.max(margin, viewportHeight - menuHeight - margin)) : rawY,
    };
  },
  windowControl(action) {
    window.lxEnv?.windowControl?.(action).catch?.(() => {});
  },
  setupMediaSessionIntegration() {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      window.lxEnv?.setMediaSessionAvailable?.(false)?.catch?.(() => {});
      return;
    }
    const bound = new Set();
    const ms = navigator.mediaSession;
    const bind = (action, handler) => {
      try {
        ms.setActionHandler(action, handler);
        bound.add(action);
      } catch {
        // action not supported on current platform
      }
    };
    const dispatch = action => {
      if (window.lxEnv?.sendMediaInput) window.lxEnv.sendMediaInput(action).catch(() => this.showNotice("系统媒体控制暂不可用", "error"));
      else this.dispatchPlayerAction(action, "mediasession");
    };
    bind("play", async () => {
      this.appendMediaDiagEvent("mediaSession_action", { action: "play" });
      dispatch("play");
    });
    bind("pause", () => {
      this.appendMediaDiagEvent("mediaSession_action", { action: "pause" });
      dispatch("pause");
    });
    bind("previoustrack", () => {
      this.appendMediaDiagEvent("mediaSession_action", { action: "previoustrack" });
      dispatch("dislike_next");
    });
    bind("nexttrack", () => {
      // 消费系统下一首命令，保持找回本段感觉的语义。
      this.appendMediaDiagEvent("mediaSession_action", { action: "nexttrack" });
      dispatch("next_like");
    });
    bind("stop", () => {
      this.appendMediaDiagEvent("mediaSession_action", { action: "stop" });
      dispatch("stop");
    });
    window.lxEnv?.setMediaSessionAvailable?.(['play','pause','nexttrack','previoustrack'].every(action=>bound.has(action)))?.catch?.(() => {});
    this.updateMediaSessionMetadata();
    this.syncMediaSessionPlaybackState();
  },
  syncMediaSessionPlaybackState() {
    if (!this.isPlaying && !this.pendingPlaybackTransition && !this.recommendationResume && !this.outputSafetyWearResume?.resuming)
      window.lxEnv?.prepareAudioOutput?.({playing:false,wearToken:this.outputSafetyWearResume?.token})?.catch?.(() => {});
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.playbackState = this.isPlaying ? "playing" : "paused";
    } catch {
      // ignore
    }
  },
  updateMediaSessionMetadata() {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator) || typeof MediaMetadata === "undefined") return;
    const title = String(this.currentMeta?.title || this.extractName(this.currentPath) || "").trim();
    const artist = String(this.currentMeta?.artist || "").trim();
    const album = String(this.currentMeta?.album || "").trim();
    if (!title && !artist && !album) return;
    const artwork = [];
    const cover = String(this.currentCover || this.currentCoverFull || "").trim();
    if (cover && /^(https?:|data:|blob:)/i.test(cover)) {
      artwork.push({ src: cover, sizes: "512x512", type: "image/png" });
    }
    try {
      navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork });
    } catch {
      // ignore invalid media metadata payload
    }
  },
  parseLocalNameMeta(path) {
    const p = String(path || "");
    if (!p || (this.isOnlineToken && this.isOnlineToken(p))) return { artist: "", title: "" };
    const base = p.split(/[\\/]/).pop() || "";
    const stem = base.replace(/\.[^/.]+$/, "").trim();
    if (!stem) return { artist: "", title: "" };
    const m = stem.match(/^(.+?)\s*[-–—]\s*(.+)$/);
    if (!m) return { artist: "", title: stem };
    return { artist: String(m[1] || "").trim(), title: String(m[2] || "").trim() };
  },
  normalizeTitleForKey(title) {
    let t = String(title || "").trim().toLowerCase();
    if (!t) return "";
    t = t.replace(/\.(mp3|flac|wav|m4a|ogg|aac|ape|wma)$/i, "");
    t = t.replace(/[\[\(（【]\s*(\d{2,4}\s*(k|kbps|khz)|flac(\s*24bit)?|hi[-\s]?res|24bit|16bit|hq|sq|lossless|无损)\s*[\]\)）】]$/i, "");
    t = t.replace(/(?:[-_.\s]+(\d{2,4}\s*(k|kbps)|flac(\s*24bit)?|hi[-\s]?res|24bit|16bit|hq|sq|lossless|无损))+$/i, "");
    t = t.replace(/\s+/g, " ").trim();
    return t;
  },
  getTrackDisplayMeta(path) {
    const p = String(path || "");
    const online = this.onlineTrackMap[p] || null;
    const local = this.trackByPath?.get?.(p) || null;
    const fileMeta = this.parseLocalNameMeta(p);
    const artist = String(online?.artist || local?.artist || fileMeta.artist || "").trim();
    let title = String(online?.title || online?.name || local?.title || local?.name || fileMeta.title || this.extractName(p)).trim();
    title = title.replace(/\.(mp3|flac|wav|m4a|ogg|aac|ape|wma)$/i, "").trim();
    if (artist) {
      const escapedArtist = artist.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      title = title.replace(new RegExp(`^${escapedArtist}\\s*[-–—]\\s*`, "i"), "").trim();
    }
    return { title: title || this.extractName(p), artist };
  },
  buildTrackArtistTitleKey(path) {
    const meta = this.getTrackDisplayMeta(path);
    const artist = String(meta.artist || "").trim().toLowerCase().replace(/\s+/g, " ");
    const title = this.normalizeTitleForKey(meta.title || "");
    if (!title) return "";
    return `${artist} - ${title}`.trim();
  },
  getLocalTrackMatchIndex() {
    const revision = Number(this._localMetadataRevision || 0);
    if (Number(this._localTrackMatchIndex?.revision) === revision) {
      return this._localTrackMatchIndex;
    }
    const byArtistTitle = new Map();
    const byTitle = new Map();
    const byTitleWithoutArtist = new Map();
    (this.tracks || []).forEach((track) => {
      const trackPath = String(track?.path || "");
      if (!trackPath || this.isOnlineToken(trackPath)) return;
      const info = this.getTrackDedupInfo(trackPath);
      if (!info.titleNorm) return;
      if (!byTitle.has(info.titleNorm)) byTitle.set(info.titleNorm, trackPath);
      if (info.artistNorm) {
        const exactKey = `${info.artistNorm}\u0000${info.titleNorm}`;
        if (!byArtistTitle.has(exactKey)) byArtistTitle.set(exactKey, trackPath);
      } else if (!byTitleWithoutArtist.has(info.titleNorm)) {
        byTitleWithoutArtist.set(info.titleNorm, trackPath);
      }
    });
    this._localTrackMatchIndex = {
      revision,
      byArtistTitle,
      byTitle,
      byTitleWithoutArtist,
    };
    return this._localTrackMatchIndex;
  },
  resolveOnlineRecommendAnchorPath(path) {
    const p = String(path || "");
    if (!p || !this.isOnlineToken(p)) return "";
    const t = this.onlineTrackMap[p] || this.onlineTracks.find((x) => x.token === p) || null;
    const dup = String(t?.duplicate_of || "").trim();
    if (dup && !this.isOnlineToken(dup)) return dup;
    const info = this.getTrackDedupInfo(p);
    if (!info.titleNorm) return "";
    const index = this.getLocalTrackMatchIndex();
    if (info.artistNorm) {
      return index.byArtistTitle.get(`${info.artistNorm}\u0000${info.titleNorm}`)
        || index.byTitleWithoutArtist.get(info.titleNorm)
        || "";
    }
    return index.byTitle.get(info.titleNorm) || "";
  },
  shouldSkipOnlineIndexForLocalDuplicate(path) {
    const p = String(path || "");
    if (!p || !this.isOnlineToken(p)) return "";
    const anchor = this.resolveOnlineRecommendAnchorPath(p);
    if (anchor && !this.isOnlineToken(anchor)) return anchor;
    return "";
  },
  getTrackDedupInfo(path) {
    const meta = this.getTrackDisplayMeta(path);
    return {
      titleNorm: this.normalizeTitleForKey(meta.title || ""),
      artistNorm: String(meta.artist || "").trim().toLowerCase().replace(/\s+/g, " "),
      titleDisplay: meta.title || this.extractName(path),
    };
  },
  queueOnlineAutoSearch() {
    this._onlineRequestGeneration = Number(this._onlineRequestGeneration || 0) + 1;
    this.onlineLoading = false;
    this.clearOnlineMessage();
    this.onlineHasSearched = false;
    this.onlineTracks = [];
    this.onlineSonglists = [];
    this.currentOnlineSonglist = null;
    this.onlineSonglistExpanded = false;
    this.onlineSelectedTokens = [];
    this.onlineSelectionAnchor = -1;
    if (this._onlineAutoSearchTimer) {
      clearTimeout(this._onlineAutoSearchTimer);
      this._onlineAutoSearchTimer = null;
    }
    const kw = String(this.onlineKeyword || "").trim();
    if (!kw) return;
    this._onlineAutoSearchTimer = setTimeout(() => {
      this._onlineAutoSearchTimer = null;
      this.searchOnline(1);
    }, 120);
  },
  toIpcSafeObject(value, fallback = {}) {
    try {
      return JSON.parse(JSON.stringify(value || fallback));
    } catch {
      return { ...fallback };
    }
  },
  normalizeOnlineResolvedUrl(resolved) {
    let url = "";
    if (typeof resolved === "string") {
      url = resolved;
    } else if (resolved && typeof resolved === "object") {
      url = resolved.url || resolved.data?.url || resolved.data?.src || "";
    }
    url = String(url || "").trim().replace(/^['"]|['"]$/g, "");
    if (!/^https?:\/\//i.test(url)) return "";
    return url;
  },
  wrapOnlineProxyUrl(url) {
    const clean = String(url || "").trim();
    if (!clean) return "";
    return `${LOCAL_PROXY_BASE}/online-proxy?url=${encodeURIComponent(clean)}`;
  },
  onlineCoverUrl(value) {
    const clean = String(value || "").trim();
    if (!clean) return "";
    if (/^(data:|blob:|kumiko-media:)/i.test(clean) || clean.startsWith(`${LOCAL_PROXY_BASE}/online-proxy?`)) {
      return clean;
    }
    return /^https?:\/\//i.test(clean) ? this.wrapOnlineProxyUrl(clean) : this.pathToFile(clean);
  },
  getOnlineSourceOptions(includeAll = true) {
    const declared = (this.onlineSourceNames || []).map((name) => String(name || "").trim().toLowerCase()).filter(Boolean);
    const fallback = this.onlineSourceScriptExists && !declared.length ? ["kw", "kg", "tx", "wy", "mg"] : [];
    const set = new Set([...declared, ...fallback]);
    const list = Array.from(set).map((value) => ({
      value,
      label: ONLINE_SOURCE_LABELS[value] || value.toUpperCase(),
    }));
    return includeAll ? [{ value: "all", label: "全部来源" }, ...list] : list;
  },
  getOnlineSourceLabel(source) {
    const value = String(source || "").trim().toLowerCase();
    return value ? (ONLINE_SOURCE_LABELS[value] || value.toUpperCase()) : "未知来源";
  },
  formatOnlineQualitySummary(qualities) {
    const available = new Set(
      (Array.isArray(qualities) ? qualities : [])
        .map((quality) => String(quality || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const priority = ["hires", "flac24bit", "flac", "320k", "128k"];
    const value = priority.find((quality) => available.has(quality));
    if (!value) return "";
    return ONLINE_QUALITY_OPTIONS.find((option) => option.value === value)?.shortLabel || value;
  },
  isOnlineToken(path) {
    return String(path || "").startsWith(ONLINE_TOKEN_PREFIX);
  },
  pickOnlineQuality(track) {
    const wanted = String(this.params?.online?.default_quality || "320k").trim().toLowerCase();
    return ["128k", "320k", "flac", "flac24bit", "hires"].includes(wanted) ? wanted : "320k";
  },
  buildOnlineQualityQueue(track) {
    const wanted = this.pickOnlineQuality(track);
    return PlaybackTransitionUtils.buildOnlineQualityQueue(wanted);
  },
  buildResolveMusicInfo(track) {
    const raw = this.toIpcSafeObject(track?.raw || {}, {});
    const songId = String(track?.songId || raw?.id || raw?.songmid || raw?.hash || raw?.copyrightId || "");
    if (!raw.id && songId) raw.id = songId;
    if (!raw.songmid && songId) raw.songmid = songId;
    if (!raw.hash && songId) raw.hash = songId;
    if (!raw.copyrightId && songId) raw.copyrightId = songId;
    return raw;
  },
  markOnlinePlayStart(path) {
    if (!this.isOnlineToken(path)) {
      this.onlineIndexPendingFor = "";
      return;
    }
    this.onlineIndexPendingFor = path;
    this.onlineIndexTriggered[path] = false;
  },
  syncCurrentTrackExcluded() {
    if (!this.isCurrentOnlineTrack) {
      this.currentTrackExcluded = false;
      return;
    }
    const arr = this.params?.online?.exclude_tokens || [];
    this.currentTrackExcluded = arr.includes(this.currentPath);
  },
  async toggleCurrentTrackExcluded() {
    if (!this.isCurrentOnlineTrack) return;
    const excluded = !!this.currentTrackExcluded;
    try {
      await axios.post(`${this.baseUrl}/online/exclude`, {
        token: this.currentPath,
        excluded,
      });
      const list = new Set(this.params.online.exclude_tokens || []);
      if (excluded) list.add(this.currentPath);
      else list.delete(this.currentPath);
      this.params.online.exclude_tokens = Array.from(list);
    } catch (e) {
      console.warn("更新在线排除失败", e);
    }
  },
  isOnlineTokenSelected(token) {
    return this.onlineSelectedTokenSet.has(token);
  },
  clearOnlineSelection() {
    this.onlineSelectedTokens = [];
    this.onlineSelectionAnchor = -1;
  },
  onOnlineTrackClick(event, track, idx) {
    if (!track?.token) return;
    const list = this.onlineTracks || [];
    const token = track.token;
    const ctrl = !!(event?.ctrlKey || event?.metaKey);
    const shift = !!event?.shiftKey;
    if (shift && this.onlineSelectionAnchor >= 0 && list.length) {
      const a = Math.max(0, Math.min(this.onlineSelectionAnchor, list.length - 1));
      const b = Math.max(0, Math.min(idx, list.length - 1));
      const [start, end] = a <= b ? [a, b] : [b, a];
      const rangeTokens = list.slice(start, end + 1).map((t) => t.token).filter(Boolean);
      if (ctrl) {
        const merged = new Set([...(this.onlineSelectedTokens || []), ...rangeTokens]);
        this.onlineSelectedTokens = Array.from(merged);
      } else {
        this.onlineSelectedTokens = rangeTokens;
      }
    } else if (ctrl) {
      const set = new Set(this.onlineSelectedTokens || []);
      if (set.has(token)) set.delete(token);
      else set.add(token);
      this.onlineSelectedTokens = Array.from(set);
      this.onlineSelectionAnchor = idx;
    } else {
      this.onlineSelectedTokens = [token];
      this.onlineSelectionAnchor = idx;
    }
    this.onlineTrackMap[token] = track;
    this.selectedPath = token;
    this.closeOnlineContextMenu();
  },
  onOnlineTrackContextMenu(event, track, idx) {
    if (!track?.token) return;
    const token = track.token;
    if (!this.isOnlineTokenSelected(token)) {
      this.onlineSelectedTokens = [token];
      this.onlineSelectionAnchor = idx;
      this.selectedPath = token;
    }
    const position = this.clampContextMenuPosition(event, 150, 62);
    this.onlineContextMenu = {
      show: true,
      ...position,
    };
    this.prepareContextMenu("onlineContextMenuRoot",this.onlineContextMenu);
  },
  closeOnlineContextMenu() {
    this.restoreContextMenuFocus('onlineContextMenuRoot');
    this.onlineContextMenu.show = false;
  },
  openOnlineDownloadModal() {
    this.closeOnlineContextMenu();
    if (!this.selectedOnlineTracks.length) {
      this.showNotice("请先选择在线歌曲。", "error");
      return;
    }
    this.onlineDownloadQuality = this.params?.online?.default_quality || "320k";
    this.onlineDownloadModalVisible = true;
  },
  async confirmOnlineDownload() {
    if (!window.lxEnv || typeof window.lxEnv.downloadOnlineTrack !== "function") return;
    const list = this.selectedOnlineTracks || [];
    if (!list.length) {
      this.showNotice("请选择要下载的歌曲。", "error");
      return;
    }
    this.onlineDownloading = true;
    let okCount = 0;
    let failCount = 0;
    const errors = [];
    try {
      for (const track of list) {
        try {
          const payload = {
            source: String(track.source || this.onlineFileSource || "").toLowerCase(),
            quality: this.onlineDownloadQuality || "320k",
            title: track.title || track.name || "",
            artist: track.artist || "",
            songId: track.songId || "",
            musicInfo: this.buildResolveMusicInfo(track),
            downloadDir: this.params?.download_dir || "",
          };
          const ret = await window.lxEnv.downloadOnlineTrack(payload);
          if (ret?.ok) okCount += 1;
          else {
            failCount += 1;
            errors.push(`${track.title || track.songId}: ${ret?.message || "失败"}`);
          }
        } catch (e) {
          failCount += 1;
          errors.push(`${track.title || track.songId}: ${e?.message || e}`);
        }
      }
      if (errors.length) console.warn("部分在线歌曲下载失败", errors);
      const msg = failCount
        ? `已下载 ${okCount} 首，${failCount} 首失败。`
        : `已下载 ${okCount} 首。`;
      this.showNotice(msg, failCount ? "error" : "info", failCount ? 8000 : 3600);
      if (!failCount) this.onlineDownloadModalVisible = false;
    } finally {
      this.onlineDownloading = false;
    }
  },
  ensureCustomPlaylistByName(name) {
    const targetName = String(name || "").trim();
    if (!targetName) return null;
    let pl = this.customPlaylists.find((p) => String(p.name || "").trim() === targetName);
    if (!pl) {
      pl = { id: `custom-${Date.now()}`, name: targetName, tracks: [], type: "custom" };
      this.customPlaylists.push(pl);
    }
    return pl;
  },
  isCurrentTrackInFavorite() {
    if (!this.currentPath || !this.isOnlineToken(this.currentPath)) return false;
    const pl = this.customPlaylists.find((p) => String(p.name || "").trim() === "我喜欢的歌");
    return !!(pl && Array.isArray(pl.tracks) && pl.tracks.includes(this.currentPath));
  },
  toggleFavoriteCurrentTrack() {
    if (!this.currentPath || !this.isOnlineToken(this.currentPath)) return;
    const pl = this.ensureCustomPlaylistByName("我喜欢的歌");
    if (!pl) return;
    const set = new Set(pl.tracks || []);
    if (set.has(this.currentPath)) set.delete(this.currentPath);
    else set.add(this.currentPath);
    pl.tracks = Array.from(set);
    this.saveCustomPlaylists();
    this.buildFolderPlaylists();
    this.persistCurrentPlaylistOrder();
  },
  async searchOnline(page = 1) {
    const requestGeneration = Number(this._onlineRequestGeneration || 0) + 1;
    this._onlineRequestGeneration = requestGeneration;
    const kw = (this.onlineKeyword || "").trim();
    if (!kw) {
      this.onlineTracks = [];
      this.onlineSonglists = [];
      this.currentOnlineSonglist = null;
      this.onlineSonglistExpanded = false;
      this.onlineSelectedTokens = [];
      this.onlineSelectionAnchor = -1;
      this.onlineLoading = false;
      this.clearOnlineMessage();
      this.onlineHasSearched = false;
      return;
    }
    const searchType = this.onlineSearchType;
    this.onlineLoading = true;
    this.clearOnlineMessage();
    try {
      if (searchType === "songlist") {
        const source = this.onlineSonglistSource;
        const data = await window.lxEnv.onlineSonglistSearch({
          source,
          keyword: kw,
          page,
          size: 30,
        });
        if (requestGeneration !== this._onlineRequestGeneration) return;
        this.onlineSonglists = data?.list || [];
        this.onlineSonglistsSnapshot = this.onlineSonglists.slice();
        this.currentOnlineSonglist = null;
        this.onlineTracks = [];
        this.onlineSonglistExpanded = false;
      } else {
        const source = this.onlineMusicSource;
        const data = await window.lxEnv.onlineSearch({
          source,
          keyword: kw,
          page,
          size: 30,
        });
        if (requestGeneration !== this._onlineRequestGeneration) return;
        const list = data?.list || [];
        this.onlineTracks = list;
        this.onlineSelectedTokens = [];
        this.onlineSelectionAnchor = -1;
        this.onlineSonglistExpanded = false;
        list.forEach((t) => {
          this.onlineTrackMap[t.token] = t;
        });
      }
      this.onlineHasSearched = true;
    } catch (e) {
      if (requestGeneration !== this._onlineRequestGeneration) return;
      console.warn("在线搜索失败", e);
      this.setOnlineMessage("搜索失败，请检查音源后重试。", "error");
      this.onlineTracks = [];
      this.onlineSonglists = [];
      this.currentOnlineSonglist = null;
      this.onlineSonglistExpanded = false;
    } finally {
      if (requestGeneration === this._onlineRequestGeneration) {
        this.onlineLoading = false;
      }
    }
  },
  async playOnlineTrack(track) {
    if (!track || !track.token) return;
    this.onlineTrackMap[track.token] = track;
    this.selectedPath = track.token;
    const result = await this.playByPath(track.token);
    if (!result?.ok && !result?.canceled) {
      this.showNotice(this.getPlaybackUserMessage(result?.error || this.lastPlaybackError), "error", 6000);
    }
  },
  async loadOnlineSonglistTracks(songlist) {
    if (!songlist || !songlist.source || !songlist.id) return;
    const requestGeneration = Number(this._onlineRequestGeneration || 0) + 1;
    this._onlineRequestGeneration = requestGeneration;
    this.onlineLoading = true;
    this.clearOnlineMessage();
    try {
      const data = await window.lxEnv.onlineSonglistTracks({
        source: songlist.source,
        id: songlist.id,
        page: 1,
        size: 80,
      });
      if (requestGeneration !== this._onlineRequestGeneration) return;
      const list = data?.list || [];
      this.currentOnlineSonglist = {
        ...songlist,
        total: Number(songlist.total) || list.length || 0,
      };
      this.onlineTracks = list;
      this.onlineSelectedTokens = [];
      this.onlineSelectionAnchor = -1;
      this.onlineSonglistExpanded = true;
      list.forEach((t) => {
        this.onlineTrackMap[t.token] = t;
      });
    } catch (e) {
      if (requestGeneration !== this._onlineRequestGeneration) return;
      console.warn("歌单展开失败", e);
      // 兜底：歌单详情失败时，使用同源歌曲搜索，避免页面直接失败
      try {
        const fallback = await window.lxEnv.onlineSearch({
          source: songlist.source,
          keyword: songlist.name || "",
          page: 1,
          size: 80,
        });
        if (requestGeneration !== this._onlineRequestGeneration) return;
        const list = fallback?.list || [];
        if (list.length) {
          this.currentOnlineSonglist = {
            ...songlist,
            total: Number(songlist.total) || list.length || 0,
          };
          this.onlineTracks = list;
          this.onlineSonglistExpanded = true;
          list.forEach((t) => {
            this.onlineTrackMap[t.token] = t;
          });
          this.setOnlineMessage("歌单读取受限，已显示当前来源的搜索结果。");
        } else {
          this.setOnlineMessage("歌单读取失败，请更换音源后重试。", "error");
        }
      } catch (fallbackError) {
        if (requestGeneration !== this._onlineRequestGeneration) return;
        console.warn("歌单展开兜底失败", fallbackError);
        this.setOnlineMessage("歌单读取失败，当前音源可能不支持。", "error");
      }
    } finally {
      if (requestGeneration === this._onlineRequestGeneration) {
        this.onlineLoading = false;
      }
    }
  },
  backToSonglistResults() {
    this._onlineRequestGeneration = Number(this._onlineRequestGeneration || 0) + 1;
    this.onlineLoading = false;
    this.clearOnlineMessage();
    this.onlineSearchType = "songlist";
    if (Array.isArray(this.onlineSonglistsSnapshot) && this.onlineSonglistsSnapshot.length) {
      this.onlineSonglists = this.onlineSonglistsSnapshot.slice();
    }
    this.onlineHasSearched = true;
    this.currentOnlineSonglist = null;
    this.onlineTracks = [];
    this.onlineSelectedTokens = [];
    this.onlineSelectionAnchor = -1;
    this.onlineSonglistExpanded = false;
  },
  async playCurrentOnlineSonglist() {
    const list = Array.isArray(this.onlineTracks) ? this.onlineTracks : [];
    if (!list.length) return;
    await this.playOnlineTrack(list[0]);
  },
  collectCurrentOnlineSonglist() {
    if (!this.currentOnlineSonglist || !Array.isArray(this.onlineTracks) || !this.onlineTracks.length) return;
    const rawName = String(this.currentOnlineSonglist.name || "").trim();
    const listName = rawName ? `在线歌单-${rawName}` : "在线歌单-收藏";
    const pl = this.ensureCustomPlaylistByName(listName);
    if (!pl) return;
    const merged = new Set(Array.isArray(pl.tracks) ? pl.tracks : []);
    this.onlineTracks.forEach((t) => {
      if (t?.token) merged.add(t.token);
    });
    pl.tracks = Array.from(merged);
    this.saveCustomPlaylists();
    this.buildFolderPlaylists();
    this.persistCurrentPlaylistOrder();
    this.showNotice(`已加入「${listName}」。`);
  },
  findTrackPathByFilename(filename) {
    const key = String(filename || "").trim().toLowerCase();
    if (!key) return "";
    const noExt = key.replace(/\.[^/.]+$/, "");
    const target = this.tracks.find((t) => {
      const p = String(t.path || "");
      const base = p.split(/[\\/]/).pop()?.toLowerCase() || "";
      const baseNoExt = base.replace(/\.[^/.]+$/, "");
      const title = String(t.title || t.name || "").toLowerCase();
      return base === key || baseNoExt === noExt || title === noExt || base.includes(noExt);
    });
    return target?.path || "";
  },
  async handleExternalPlayerControl(payload) {
    const requestId = String(payload?.requestId || "");
    const action = String(payload?.action || "").trim().toLowerCase();
    const filename = String(payload?.filename || "").trim();
    if (!requestId || !window.lxEnv || typeof window.lxEnv.send !== "function") return;
    const reply = (success, message = "", metadata = null) => {
      window.lxEnv.send("lx-player-control-result", { requestId, success, message, metadata });
    };
    try {
      if (action === "stop") {
        this.pauseByInternal("external:stop");
        reply(true, "音乐已停止");
        return;
      }
      if (action === "play_random") {
        const pool = this.getPlaybackQueueTracks();
        if (!pool.length) {
          reply(false, "播放器曲库为空");
          return;
        }
        const target = pool[Math.floor(Math.random() * pool.length)];
        const result = await this.playByPath(target.path);
        if (!result?.ok) {
          reply(false, result?.error || "歌曲播放失败");
          return;
        }
        this.selectedPath = target.path;
        reply(true, `正在播放: ${this.extractName(target.path)}`, {
          title: this.currentMeta?.title || this.extractName(target.path),
          artist: this.currentMeta?.artist || "",
          album: this.currentMeta?.album || "",
          lyrics: this.currentMeta?.lyric || "暂无歌词",
          path: target.path,
        });
        return;
      }
      if (action === "play_specific") {
        const targetPath = this.findTrackPathByFilename(filename);
        if (!targetPath) {
          reply(false, `未找到歌曲: ${filename}`);
          return;
        }
        const result = await this.playByPath(targetPath);
        if (!result?.ok) {
          reply(false, result?.error || `歌曲播放失败: ${filename}`);
          return;
        }
        this.selectedPath = targetPath;
        reply(true, `正在播放: ${this.extractName(targetPath)}`, {
          title: this.currentMeta?.title || this.extractName(targetPath),
          artist: this.currentMeta?.artist || "",
          album: this.currentMeta?.album || "",
          lyrics: this.currentMeta?.lyric || "暂无歌词",
          path: targetPath,
        });
        return;
      }
      reply(false, `不支持的 action: ${action}`);
    } catch (e) {
      reply(false, `控制异常: ${e?.message || e}`);
    }
  },
  extractName(p) {
    if (this.isOnlineToken && this.isOnlineToken(p)) {
      const t = this.onlineTrackMap[p];
      if (t?.title) return t.title;
      const m = String(p).match(/^online:\/\/([^/]+)\/(.+)$/);
      if (m) return `${m[1].toUpperCase()}:${m[2]}`;
    }
    if (!p) return "";
    const base = String(p).split(/[\\/]/).pop() || "";
    return base.replace(/\.[^/.]+$/, "");
  },
  pathToFile(p) {
    if (!p) return "";
    if (this.isOnlineToken && this.isOnlineToken(p)) return "";
    const raw = String(p);
    if (/^(kumiko-media:|data:|blob:|https?:)/i.test(raw)) return raw;
    let localPath = raw;
    if (/^file:\/\//i.test(raw)) {
      try {
        const parsed = new URL(raw);
        localPath = decodeURIComponent(parsed.pathname)
          .replace(/^\/([A-Za-z]:\/)/, "$1")
          .replace(/\//g, "\\");
      } catch (_) {
        localPath = raw.replace(/^file:\/\/\//i, "").replace(/\//g, "\\");
      }
    }
    return `kumiko-media://local/${encodeURIComponent(localPath)}`;
  },
  formatTime(sec) {
    if (!sec || Number.isNaN(sec) || sec === Infinity) return "00:00";
    const m = Math.floor(sec / 60).toString().padStart(2, "0");
    const s = Math.floor(sec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
  },
  getRecommendHistoryPolicy() {
    const historyCfg = this.params?.history || {};
    const policy = String(historyCfg.repeat_policy || (historyCfg.allow_duplicates ? "allow" : "disallow")).toLowerCase();
    return {
      allowDuplicates: policy === "allow",
      windowSize: clampNumberAllowZero(historyCfg.no_repeat_within, 100, 0, 1000),
    };
  },
  getRecommendHistoryWindow() {
    const hist = Array.isArray(this.playHistory) ? this.playHistory : [];
    const policy = this.getRecommendHistoryPolicy();
    if (policy.allowDuplicates || policy.windowSize <= 0) return [];
    return hist.slice(-policy.windowSize);
  },
  pushHistory(path) {
    if (!Array.isArray(this.playHistory)) this.playHistory = [];
    if (!Array.isArray(this.playHistoryRefs)) this.playHistoryRefs = [];
    if (this.playHistoryRefs.length !== this.playHistory.length) {
      this.playHistoryRefs = this.playHistory.map((historyPath) => this.makeTrackReference(historyPath));
    }
    this.playHistory.push(path);
    this.playHistoryRefs.push(this.makeTrackReference(path));
    if (this.playHistory.length > 500) {
      this.playHistory = this.playHistory.slice(-500);
      this.playHistoryRefs = this.playHistoryRefs.slice(-500);
    }
    writeStored(STORAGE_KEYS.PLAY_HISTORY, JSON.stringify(this.playHistory));
    writeStored(STORAGE_KEYS.PLAY_HISTORY_REFS, JSON.stringify(this.playHistoryRefs));
  },
  hasFreshRecCache(intent = this.getDefaultRecommendationIntent()) {
    const stamp=this.getRecommendationPolicyStamp();
    const saved=this.recommendationJobs?.caches.get(intent);
    if(saved?.stamp===stamp && Date.now()-saved.at < 120000) {
      this.recCache=saved.data;this.recCacheFor=this.currentPath;this.recCacheStamp=stamp;this.recCacheAt=saved.at;
    }
    return !!this.currentPath && this.recCacheFor===this.currentPath && this.recCacheStamp===stamp
      && this.recCache?.diagnostic?.intent===intent && Date.now()-Number(this.recCacheAt||0)<120000;
  },
  getPreviousPlayedPath() {
    const hist = this.playHistory || [];
    if (!hist.length || !this.currentPath) return "";
    // 从尾部开始找“当前曲目”最近一次出现，再取其前一首
    const curIdx = hist.lastIndexOf(this.currentPath);
    if (curIdx <= 0) return "";
    return hist[curIdx - 1] || "";
  },
  buildMetadataFillPlan() {
    const priority = [];
    const seen = new Set();
    const appendTrack = (track) => {
      const path = String(track?.path || "");
      if (!path || seen.has(path)) return;
      const current = this.trackByPath.get(path);
      if (!current) return;
      seen.add(path);
      priority.push(current);
    };
    appendTrack(this.trackByPath.get(this.currentPath));

    if (this.view !== "library") {
      const background = this.tracks.filter((track) => !seen.has(String(track?.path || "")));
      return { priority, background };
    }

    const playlistTracks = Array.isArray(this.currentPlaylistTracks) ? this.currentPlaylistTracks : this.getCurrentPlaylistTracks();
    const visibleTracks = Array.isArray(this.filteredTracks)
      ? this.filteredTracks : this.searchTrackList(playlistTracks, this.keyword, this.fuzzy);
    const rowHeight = Math.max(1, Number(this.libraryRowHeight) || 64);
    const viewportRows = Math.max(1, Math.ceil((Number(this.libraryViewportHeight) || 720) / rowHeight));
    const neighborRadius = viewportRows + Math.max(0, Number(this.virtualOverscan) || 0);
    const currentIndex = visibleTracks.findIndex((track) => track.path === this.currentPath);
    if (currentIndex >= 0) {
      for (let distance = 1; distance <= neighborRadius; distance += 1) {
        appendTrack(visibleTracks[currentIndex - distance]);
        appendTrack(visibleTracks[currentIndex + distance]);
      }
    }
    const visibleStart = Math.max(0, Math.floor((Number(this.libraryScrollTop) || 0) / rowHeight) - 2);
    const visibleCount = Math.max(20, viewportRows + 8);
    visibleTracks.slice(visibleStart, visibleStart + visibleCount).forEach(appendTrack);
    const background = this.tracks.filter((track) => !seen.has(String(track?.path || "")));
    return { priority, background };
  },
  async fillMetadataTargets(
    targets = [],
    generation = this._trackLoadGeneration,
    metadataPlanGeneration = null,
  ) {
    if (!window.lxEnv || typeof window.lxEnv.getSongInfo !== "function") return;
    const isCurrent = () => (
      generation === this._trackLoadGeneration
      && (
        !Number.isFinite(metadataPlanGeneration)
        || Number(metadataPlanGeneration) === Number(this._metadataPlanGeneration || 0)
      )
    );
    if (!isCurrent()) return;
    let changed = false;
    let searchChanged = false;
    const queue = Array.isArray(targets) ? targets.filter(Boolean) : [];
    let cursor = 0;
    const fillOne = async (t) => {
      if (!t || t._metaLoaded) return;
      if (this.isOnlineToken(t.path)) {
        if (isCurrent() && this.trackByPath.get(t.path) === t) {
          t._metaLoaded = true;
        }
        return;
      }
      try {
        const info = await window.lxEnv.getSongInfo(t.path, {
          resourceId: String(t.resourceId || ""),
          includeLyrics: false,
        });
        if (!isCurrent() || this.trackByPath.get(t.path) !== t) return;
        const previousSearchFields = [t.title, t.name, t.artist, t.album];
        Object.assign(t, {
          title: info.title || t.title,
          name: info.title || t.title,
          artist: info.artist || "",
          album: info.album || "",
          artists: Array.isArray(info.artists) ? info.artists : [],
          albumArtist: info.albumArtist || "",
          trackNumber: Number(info.trackNumber)||0,
          discNumber: Number(info.discNumber)||0,
          cover: this.pathToFile(info.cover || ""),
          cover_thumb: this.pathToFile(info.cover_thumb || info.cover || ""),
          duration: info.duration || 0,
          durationText: this.formatTime(info.duration || 0),
          _metaLoaded: true,
        });
        const prepared = this.prepareTrackForList(t, { buildDoc: false });
        t._searchText = prepared._searchText;
        if ([t.title, t.name, t.artist, t.album].some((value, index) => value !== previousSearchFields[index])) {
          t._searchDoc = null;
          searchChanged = true;
        }
        changed = true;
      } catch (e) {
        if (isCurrent() && this.trackByPath.get(t.path) === t) {
          t._metaLoaded = true;
        }
      }
    };
    const workerCount = Math.min(METADATA_FILL_CONCURRENCY, queue.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (cursor < queue.length && isCurrent()) {
        const index = cursor;
        cursor += 1;
        await fillOne(queue[index]);
      }
    }));
    if (!isCurrent()) return;
    if (changed) {
      this._localMetadataRevision = Number(this._localMetadataRevision || 0) + 1;
      if (searchChanged) this.queueSearchIndexRebuild(420);
      this.queueUiSnapshotSave(500);
    }
  },
  async lazyFillMeta(
    order = [],
    startIndex = 0,
    batch = 12,
    generation = this._trackLoadGeneration,
    metadataPlanGeneration = null,
  ) {
    if (Number.isFinite(order)) {
      generation = Number.isFinite(batch) ? Number(batch) : this._trackLoadGeneration;
      batch = Math.max(1, Number(startIndex) || 12);
      startIndex = Math.max(0, Number(order) || 0);
      order = this.tracks;
    }
    const isCurrent = () => (
      generation === this._trackLoadGeneration
      && (
        !Number.isFinite(metadataPlanGeneration)
        || Number(metadataPlanGeneration) === Number(this._metadataPlanGeneration || 0)
      )
    );
    if (!isCurrent()) return;
    const targetsInOrder = Array.isArray(order) && order.length ? order : this.tracks;
    const len = targetsInOrder.length;
    const targets = targetsInOrder.slice(startIndex, Math.min(len, startIndex + batch));
    if (!targets.length) return;
    await this.fillMetadataTargets(targets, generation, metadataPlanGeneration);
    if (!isCurrent()) return;
    if (startIndex + batch < len) {
      this._metadataFillTimer = setTimeout(() => {
        this._metadataFillTimer = null;
        this.lazyFillMeta(
          targetsInOrder,
          startIndex + batch,
          batch,
          generation,
          metadataPlanGeneration,
        );
      }, 24);
    }
  },
  async restoreLastTrack(options = {}) {
    this.disablePractice(false);
    window.FlowaveStemPlayer?.clearCache();
    if (
      Number.isFinite(options.expectedPlaybackGeneration)
      && Number(options.expectedPlaybackGeneration) !== Number(this.playbackGeneration || 0)
    ) {
      return false;
    }
    const storedReference = this.readLastTrackReference();
    const last = this.resolveTrackReference(
      storedReference,
      readStoredString(STORAGE_KEYS.LAST_TRACK, null)
    );
    if (!last || !this.tracks.length) return false;
    const hit = this.trackByPath?.get?.(last) || this.onlineTrackMap[last];
    if (hit) {
      this.currentPath = hit.path || hit.token;
      this.currentTrackRef = this.makeTrackReference(this.currentPath, storedReference);
      if (!options.preserveSelection) {
        this.selectedPath = hit.path || hit.token;
      }
      await this.populateCurrentMeta(this.currentPath);
      this.pauseByInternal("restoreLastTrack");
      if (this.isOnlineToken(this.currentPath)) {
        // 在线曲目仅恢复元信息，不预拉流，避免启动阻塞
        audio.removeAttribute("src");
        audio.load();
        this._committedAudioSource = "";
      } else {
        audio.src = this.pathToFile(hit.path);
        audio.load();
        this._committedAudioSource = String(audio.src || this.pathToFile(hit.path));
      }
      this._committedPlaybackGeneration = this.playbackGeneration;
      this.isPlaying = false;
      if (options.locate !== false) {
        this.locateTrack(this.currentPath, { animate: false, center: true });
      }
      return true;
    }
    return false;
  },
  applyTheme(name) {
    this.themeName = name;
    document.documentElement.setAttribute("data-theme", name);
    this.applyCustomColor();
    writeStored(STORAGE_KEYS.THEME, name);
  },
  applyCustomColor() {
    document.documentElement.style.setProperty("--accent", this.customColor);
    writeStored(STORAGE_KEYS.ACCENT, this.customColor);
  },
};

const computedProps = {
  settingsSections() { return Object.entries(window.FlowaveSettings.titles).map(([id,title])=>({id,title})); },
  settingsCategories() { return window.FlowaveSettings.categories.filter(row=>row.id!=='recommend'||this.featureEnabled?.('recommendation')!==false); },
  settingsTools() { return ['features','folders','insights','history','song-info'].filter(id=>this.featureEnabled?.(window.FlowaveFeatureModules?.viewModule(id) || '')!==false).map(id=>({id,title:window.FlowaveSettings.titles[id]})); },
  currentSettingsCategory() { return window.FlowaveSettings.categoryFor(this.settingsTab); },
  currentSettingsPages() { return (this.currentSettingsCategory?.pages || []).map(id=>({id,title:window.FlowaveSettings.titles[id]})); },
  settingsSearchResults() { return window.FlowaveSettings.search(this.settingsOverviewQuery); },
  filteredSettingsSections() { return this.settingsSections.filter(section=>!this.settingsOverviewQuery || window.FlowaveSettings.search(this.settingsOverviewQuery).some(item=>item.page===section.id)); },
  currentSettingsSectionTitle() { return window.FlowaveSettings.titles[this.settingsTab] || "设置"; },
  isCurrentOnlineTrack() {
    return this.isOnlineToken(this.currentPath);
  },
  sidebarPlaylists() { return this.playlists.filter(pl => pl.type !== "system" && pl.type !== "folder"); },
  folderShortcutPlaylists() { return this.playlists.filter(pl => pl.type === "folder"); },
  folderTree() { return markSearchRaw(window.FlowaveFolders.build(this.tracks,this.configuredAudioDirectories())); },
  folderBrowserDirectory() { return this.folderTree.nodes.get(window.FlowaveFolders.key(this.folderBrowsePath)) || this.folderTree.root; },
  folderBreadcrumbs() { return window.FlowaveFolders.breadcrumbs(this.folderTree,this.folderBrowsePath); },
  libraryPageTitle() {
    if (this.libraryBrowseMode === "folders") return this.folderBrowserDirectory === this.folderTree.root ? "文件夹" : this.folderBrowserDirectory.name;
    return this.playlists.find((playlist) => playlist.id === this.currentPlaylist)?.name || "音乐库";
  },
  currentPlaylistTracks() {
    return this.getCurrentPlaylistTracks();
  },
  canGoPrevious() {
    return !!this.getPreviousPlayedPath();
  },
  onlineSelectedTokenSet() {
    return new Set(this.onlineSelectedTokens || []);
  },
  onlineSourceScriptLabel() {
    return this.onlineSourceScriptPath ? this.pathBasename(this.onlineSourceScriptPath) : "";
  },
  onlineSourceSummaryLabel() {
    const labels = this.getOnlineSourceOptions(false).map((item) => item.label).filter(Boolean);
    return labels.length ? labels.join("、") : "暂无";
  },
  onlineQualityOptions() {
    return ONLINE_QUALITY_OPTIONS;
  },
  onlineTrackQualityLabels() {
    const labels = {};
    (this.onlineTracks || []).forEach((track) => {
      if (!track?.token) return;
      labels[track.token] = this.formatOnlineQualitySummary(track.qualities);
    });
    return labels;
  },
  selectedOnlineTracks() {
    const currentTracks = new Map(
      (this.onlineTracks || [])
        .filter((track) => track?.token)
        .map((track) => [track.token, track])
    );
    return (this.onlineSelectedTokens || [])
      .map((token) => this.onlineTrackMap[token] || currentTracks.get(token))
      .filter(Boolean);
  },
  filteredTracks() {
    return this.searchTrackList(this.currentPlaylistTracks, this.keyword, this.fuzzy);
  },
  librarySearchPending() {
    void this.searchWorkerRevision;
    const keyword = String(this.keyword || "").trim();
    return !!keyword && !!this._searchWorkerController && this._searchWorkerController.query(keyword, this.fuzzy) === null;
  },
  filteredRankingTracks() {
    return this.searchTrackList(this.tracks, this.rankingLeftKeyword, this.fuzzy, "rankingLeft");
  },
  progressPercent() {
    if (!this.progressDuration) return 0;
    return Math.min(100, (this.progressValue / this.progressDuration) * 100);
  },
  progressDuration() {
    const value = Number(this.duration || 0);
    return Number.isFinite(value) && value > 0 ? value : 0;
  },
  progressValue() {
    if (!this.progressDuration) return 0;
    const value = Number(this.currentTime || 0);
    if (!Number.isFinite(value)) return 0;
    return Math.min(this.progressDuration, Math.max(0, value));
  },
  configSaveLabel() {
    if (this.configSaveState === "saving" || this.configSaveState === "pending") return "正在保存";
    if (this.configSaveState === "error") return "保存失败";
    return "自动保存";
  },
  audioDirectoryChanged() {
    return this.hasPendingAudioDirectoryChange();
  },
  libraryDirectoryStatusLabel() {
    return this.audioDirectoryChanged ? "待载入" : `${this.tracks.length} 首`;
  },
  listeningHistoryRows() {
    return this.getListeningHistoryRows();
  },
  listeningHistoryPageCount() {
    return Math.max(1, Math.ceil(this.listeningHistoryRows.length / 80));
  },
  listeningHistoryCurrentPage() {
    return Math.min(this.listeningHistoryPageCount, this.listeningHistoryPage);
  },
  listeningHistoryVisibleRows() {
    const start = (this.listeningHistoryCurrentPage - 1) * 80;
    return this.listeningHistoryRows.slice(start, start + 80);
  },
  songInfoBatchTrackCount() {
    return this.localSongInfoBatchTracks().length;
  },
  songInfoBatchSelectedLocalAvailable() {
    const selected = this.trackByPath?.get(this.selectedPath);
    return Boolean(selected?.path && !this.isOnlineToken(selected.path));
  },
  listeningHistoryDayBars() {
    return this.getListeningDayBars();
  },
  listeningHistoryTodaySeconds() {
    const key = this.formatLocalDateKey(Date.now());
    return Number(this.listeningHistory?.days?.[key] || 0);
  },
  listeningHistoryTrackCount() {
    return Object.values(this.listeningHistory?.tracks || {}).filter((item) => (
      Math.max(0, Number(item?.playCount || 0)) > 0
      || Math.max(0, Number(item?.listenedSeconds || 0)) > 0
    )).length;
  },
  recentMediaDiagEvents() {
    return this.mediaDiagEvents.slice(-30).reverse();
  },
  filteredRanking() {
    return this.searchRankingResults(this.rankingList, this.rankingRightKeyword, this.fuzzy);
  },
  libraryVirtualEnabled() {
    return this.filteredTracks.length > 120;
  },
  libraryVisibleCount() {
    const base = Math.ceil(this.libraryViewportHeight / this.libraryRowHeight);
    return Math.max(20, base + this.virtualOverscan * 2);
  },
  libraryStart() {
    if (!this.libraryVirtualEnabled) return 0;
    const start = Math.floor(this.libraryScrollTop / this.libraryRowHeight) - this.virtualOverscan;
    return Math.max(0, Math.min(start, this.filteredTracks.length - this.libraryVisibleCount));
  },
  libraryEnd() {
    if (!this.libraryVirtualEnabled) return this.filteredTracks.length;
    return Math.min(this.filteredTracks.length, this.libraryStart + this.libraryVisibleCount);
  },
  libraryRenderTracks() {
    if (!this.libraryVirtualEnabled) return this.filteredTracks;
    return this.filteredTracks.slice(this.libraryStart, this.libraryEnd);
  },
  libraryTopSpacer() {
    if (!this.libraryVirtualEnabled) return 0;
    return this.libraryStart * this.libraryRowHeight;
  },
  libraryBottomSpacer() {
    if (!this.libraryVirtualEnabled) return 0;
    return (this.filteredTracks.length - this.libraryEnd) * this.libraryRowHeight;
  },
  rankingVirtualEnabled() {
    return this.filteredRanking.length > 120;
  },
  rankingVisibleCount() {
    const base = Math.ceil(this.rankingViewportHeight / this.rankingRowHeight);
    return Math.max(20, base + this.virtualOverscan * 2);
  },
  rankingStart() {
    if (!this.rankingVirtualEnabled) return 0;
    const start = Math.floor(this.rankingScrollTop / this.rankingRowHeight) - this.virtualOverscan;
    return Math.max(0, start);
  },
  rankingEnd() {
    if (!this.rankingVirtualEnabled) return this.filteredRanking.length;
    return Math.min(this.filteredRanking.length, this.rankingStart + this.rankingVisibleCount);
  },
  rankingRenderTracks() {
    if (!this.rankingVirtualEnabled) return this.filteredRanking;
    return this.filteredRanking.slice(this.rankingStart, this.rankingEnd);
  },
  rankingTopSpacer() {
    if (!this.rankingVirtualEnabled) return 0;
    return this.rankingStart * this.rankingRowHeight;
  },
  rankingBottomSpacer() {
    if (!this.rankingVirtualEnabled) return 0;
    return (this.filteredRanking.length - this.rankingEnd) * this.rankingRowHeight;
  },
  rankDisplayLimit() {
    return 200; // UI 限制展示前 N，避免 3000+ 条卡顿
  },
  allRankedUniqueLogs() {
    const merged = [...(this.log.like_list || []), ...(this.log.dislike_list || [])];
    const seen = new Set();
    const uniq = [];
    merged.forEach((it) => {
      if (!it || !it.path) return;
      if (seen.has(it.path)) return;
      seen.add(it.path);
      uniq.push(it);
    });
    return uniq.sort((a, b) => (b.sim || 0) - (a.sim || 0));
  },
  allRankedLogs() {
    return this.allRankedUniqueLogs.slice(0, this.rankDisplayLimit).map((it, idx) => ({
      ...it,
      rank: idx + 1,
      name: this.onlineTrackMap[it.path]?.title || this.extractName(it.path),
    }));
  },
  allRankedTotal() {
    return this.allRankedUniqueLogs.length;
  },
  filteredSeeds() {
    const kw = this.seedSearch.trim().toLowerCase();
    if (!kw) return this.seeds;
    const matches = this.seeds.filter((s) => (s.name || "").toLowerCase().includes(kw));
    const current = this.seeds.find((s) => s.id === this.currentSeedId);
    if (current && !matches.some((s) => s.id === current.id)) matches.unshift(current);
    return matches;
  },
  currentSeed() {
    return this.seeds.find((s) => s.id === this.currentSeedId) || null;
  },
  desktopLyricLineMode: {
    get() {
      return this.desktopLyricCurrentOnly ? "single" : "double";
    },
    set(value) {
      this.desktopLyricCurrentOnly = value === "single";
    },
  },
  lyricCanShowMain() {
    return this.lyricDisplayMode === "original" || this.lyricDisplayMode === "both";
  },
  lyricCanShowSub() {
    return this.lyricDisplayMode === "translation" || this.lyricDisplayMode === "both";
  },
  lyricPanelStyle() {
    const scale = Math.max(1.1, Math.min(1.35, Number(this.lyricActiveScale) || 1.18));
    const mainSize = clampNumber(this.lyricMainFontSize, DEFAULT_LYRIC_FONT_SIZE, 14, 72);
    const subSize = clampNumber(this.lyricSubFontSize, DEFAULT_LYRIC_SUB_FONT_SIZE, 12, 56);
    return {
      backgroundColor: this.lyricStageAutoColor ? "" : this.lyricBgColor,
      "--lyric-bg": this.lyricBgColor,
      "--lyric-inactive-text": this.lyricStageAutoColor ? "#f4f2f7" : this.lyricInactiveColor,
      "--lyric-stage-scale": String(this.lyricStageScale),
      "--lyric-active-text": this.lyricStageAutoColor ? "#ffffff" : this.lyricActiveColor,
      "--lyric-meta-text": this.lyricStageAutoColor ? "#eeeaf4" : this.lyricMetaColor,
      "--lyric-hover": "rgba(128, 128, 128, 0.10)",
      "--lyric-active-scale": String(scale),
      "--lyric-font-family": this.lyricFontFamily || "Microsoft YaHei UI",
      "--lyric-main-size": `${mainSize}px`,
      "--lyric-sub-size": `${subSize}px`,
    };
  },
  lyricGlowBackgroundImage() {
    const src = this.currentCoverFull || this.currentCover || "";
    if (!src) {
      return "linear-gradient(135deg, #343247, #202638)";
    }
    return `url('${String(src).replace(/'/g, "\\'")}')`;
  },
};

const watchHandlers = {
  params: {
    handler() {
      this.scheduleConfigAutoSave();
    },
    deep: true,
  },
  songInfoBatchSettings: {
    handler(value) {
      writeStored(STORAGE_KEYS.SONG_INFO_BATCH_SETTINGS, JSON.stringify(value || {}));
    },
    deep: true,
  },
  "params.download_dir"() {
    if (this.tracks.length) this.buildFolderPlaylists();
  },
  useRecommend(value) {
    if(this.featureEnabled?.('recommendation')===false){if(value)this.useRecommend=false;return;}
    writeStored(STORAGE_KEYS.USE_RECOMMEND, value ? "1" : "0");
    if (value) this.scheduleRecommendPrefetch();
    else { recommendationWarmups.delete(this); this.cancelRecommendPrefetch(); }
  },
  currentPath() {
    this.syncOutputCalibrationConsumers();
    window.lxEnv?.setTagPlaybackTarget?.({ path: this.currentPath, generation: this.playbackGeneration });
    if (practiceController) this.disablePractice(false);
    this.syncCurrentTrackExcluded();
    this.updateMediaSessionMetadata();
    this.queueUiSnapshotSave();
  },
  selectedPath() {
    this.queueUiSnapshotSave();
  },
  currentPlaylist() {
    this.queueUiSnapshotSave();
  },
  currentMeta: {
    handler() {
      this.queueUiSnapshotSave();
    },
  },
  currentCover() {
    this.syncLyricAmbient();
    if (this.desktopLyricCoverColor) this.updateDesktopLyricCoverPalette();
    this.queueUiSnapshotSave();
  },
  currentCoverFull() {
    this.syncLyricAmbient();
    if (this.desktopLyricCoverColor) this.updateDesktopLyricCoverPalette();
    this.queueUiSnapshotSave();
  },
  desktopLyricCoverColor() {
    this.updateDesktopLyricCoverPalette();
  },
  showLyric() { this.syncLyricAmbient(); this.syncOutputCalibrationConsumers(); },
  desktopLyricEnabled() { this.syncOutputCalibrationConsumers(); },
  lyricStageAutoColor() { this.syncLyricAmbient(); },
  lyricGlowEnabled() { this.syncLyricAmbient(); },
  lyricGlowSpeed() { this.syncLyricAmbient(); },
  isPlaying() {
    this.syncOutputCalibrationConsumers();
    this.syncLyricAmbient();
    this.sendLyricOverlay();
    this.syncMediaSessionPlaybackState();
  },
  recommendFullMode() {
    writeStored(STORAGE_KEYS.RECOMMEND_FULL_MODE, this.recommendFullMode ? "1" : "0");
    if (this.currentPath) this.scheduleRecommendPrefetch();
  },
  view() {
    this.syncOutputCalibrationConsumers();
    writeStored(STORAGE_KEYS.LAST_VIEW, String(this.view || "library"));
    if (this.view !== "online") {
      this._onlineRequestGeneration = Number(this._onlineRequestGeneration || 0) + 1;
      this.onlineLoading = false;
      this.clearOnlineMessage();
      if (this._onlineAutoSearchTimer) {
        clearTimeout(this._onlineAutoSearchTimer);
        this._onlineAutoSearchTimer = null;
      }
    }
    this.$nextTick(() => this.refreshVirtualViewport());
  },
  keywordDraft() {
    if (this.keywordDraft !== this.keyword) this.scheduleLocalSearchCommit("library");
  },
  keyword() {
    if (this._skipNextKeywordScrollReset) {
      this._skipNextKeywordScrollReset = false;
      return;
    }
    this.libraryScrollTop = 0;
    this.$nextTick(() => {
      const lib = this.$refs.libraryTableBody;
      if (lib) lib.scrollTop = 0;
    });
  },
  rankingLeftKeywordDraft() {
    this.scheduleLocalSearchCommit("rankingLeft");
  },
  rankingRightKeywordDraft() {
    this.scheduleLocalSearchCommit("rankingRight");
  },
  rankingRightKeyword() {
    this.rankingScrollTop = 0;
    this.$nextTick(() => {
      const rank = this.$refs.rankingTableBody;
      if (rank) rank.scrollTop = 0;
    });
  },
  fuzzy() {
    this.libraryScrollTop = 0;
    this.rankingScrollTop = 0;
  },
  filteredTracks() {
    this.$nextTick(() => this.refreshVirtualViewport());
  },
  filteredRanking() {
    this.$nextTick(() => this.refreshVirtualViewport());
  },
  onlineMusicSource(val) {
    writeStored(STORAGE_KEYS.ONLINE_MUSIC_SOURCE, String(val || "all"));
    if (this.onlineSearchType === "music") this.queueOnlineAutoSearch();
  },
  onlineSonglistSource(val) {
    writeStored(STORAGE_KEYS.ONLINE_SONGLIST_SOURCE, String(val || "all"));
    if (this.onlineSearchType === "songlist") this.queueOnlineAutoSearch();
  },
  onlineKeyword() {
    this._onlineRequestGeneration = Number(this._onlineRequestGeneration || 0) + 1;
    this.onlineLoading = false;
    this.clearOnlineMessage();
    this.onlineHasSearched = false;
    this.onlineTracks = [];
    this.onlineSonglists = [];
    this.currentOnlineSonglist = null;
    this.onlineSonglistExpanded = false;
    this.onlineSelectedTokens = [];
    this.onlineSelectionAnchor = -1;
    if (this._onlineAutoSearchTimer) {
      clearTimeout(this._onlineAutoSearchTimer);
      this._onlineAutoSearchTimer = null;
    }
  },
  onlineSearchType() {
    this.queueOnlineAutoSearch();
  },
  onlineFileSource(val) {
    writeStored(STORAGE_KEYS.ONLINE_FILE_SOURCE, String(val || "kw"));
  },
};

function mountedHook() {
  const module=window.FlowaveFeatureModules?.viewModule(this.view);
  if(module && this.featureEnabled?.(module)===false)this.view='library';
  if(this.featureEnabled?.('recommendation')===false)this.useRecommend=false;
  // Migrate only observed facts. Earlier records have no reliable feedback or duration.
  for (const row of this.soundMapTrace) if (!window.lxEnv?.prepareListeningTrace && !row.traceArchived) {
    row.traceArchived=true;
    this.recordSoundMapEvent("legacy_observed", {attemptId:row.attemptId}, "migration");
  }
  if(this.featureEnabled?.('recommendation')!==false){
    this.drainSoundMapEvents();
    soundMapArchiveTimer=setTimeout(()=>this.initializeSoundMapArchive(),1000);
  }
  const rememberIpcUnsubscribe = (unsubscribe) => {
    if (typeof unsubscribe === "function") this._ipcUnsubscribers.push(unsubscribe);
  };
  if (window.lxEnv?.onOfficialModuleProgress) {
    rememberIpcUnsubscribe(window.lxEnv.onOfficialModuleProgress(value => {
      this.featurePackageProgress = value || {};
      if(value?.selection){this.featureSelection=value.selection;this.featureSaving=false;}else{this.featureSaving=true;}
    }));
  }
  if(window.lxEnv?.onResourceProgress){rememberIpcUnsubscribe(window.lxEnv.onResourceProgress(value=>{if(value?.status)this.featureSelection.resources=value.status;}));}
  this._onLyricOutputCalibration=()=>{
    this.syncOutputCalibrationConsumers?.();
    this.resetKaraokeWordProgress();
    this.updateLyricHighlight(this.isAudioEventForCommittedSource()?Number(audio.currentTime)||0:this.currentTime,{source:'output-calibration'});
  };
  window.addEventListener('flowave-output-calibration',this._onLyricOutputCalibration);
  this.outputCalibrationVisibility=()=>this.syncOutputCalibrationConsumers();
  document.addEventListener('visibilitychange',this.outputCalibrationVisibility);
  this.syncOutputCalibrationConsumers();
  this._startupSplashStartedAt = Date.now();
  this.startupSplashBackgroundStyle = this.startupBackgroundCss();
  this.scheduleStartupSplashMaxHide();
  if (!PUBLIC_VIEWS.has(this.view)) {
    this.view = "library";
  }
  this.visitedViews = { ...(this.visitedViews || {}), [this.view]: true };
  // 先恢复上次音量
  const savedVol = Number(readStoredString(STORAGE_KEYS.VOLUME, null));
  if (!Number.isNaN(savedVol)) {
    this.volume = Math.min(100, Math.max(0, savedVol));
    if (audioEngine) audioEngine.setVolume(this.volume / 100, this.muted);
    else audio.volume = this.volume / 100;
  }
  this.applyTheme(this.themeName);
  this.loadCustomPlaylists();
  audioEngine?.apply(this.audioEffects);
  this.restoreUiSnapshot();
  if (this.desktopLyricCoverColor) {
    this.updateDesktopLyricCoverPalette();
  }
  this.setupMediaSessionIntegration();
  const bindSlotEvent = (name, handler) => {
    slotEventHandlers.push([name, handler]);
    audioSlots.forEach(slot => slot.addEventListener(name, event => { if (slot === audio) handler(event); }));
  };
  bindSlotEvent("ended", () => {
    if (!this.isAudioEventForCommittedSource()) return;
    this.handleEnded();
  });
  bindSlotEvent("play", () => {
    if (this.outputSafetyBlocked || this.playbackIntent === 'pause') { for (const slot of audioSlots) if (!slot.paused) slot.pause(); this.isPlaying=false; return; }
    if (audio.paused || !this.isAudioEventForCommittedSource()) return;
    const pausedAt = Number(this._lastPausedAt || 0);
    const resetMinutes = Number(this.getDislikeCorrectionConfig().long_pause_reset_minutes || 0);
    if (pausedAt > 0 && resetMinutes > 0 && Date.now() - pausedAt >= resetMinutes * 60 * 1000) {
      this.resetConsecutiveDislike("long-pause");
    }
    if (this.currentPath) {
      if (!this.resumeListeningSession(this.currentPath)) {
        this.beginListeningSession(this.currentPath);
      }
    }
    this.appendMediaDiagEvent("audio_play", {
      pauseReason: this.playbackPauseReason,
      time: Number(audio.currentTime || 0),
      volume: Number(audio.volume || 0),
    });
    this.isPlaying = true;
    this.clearAudioInterruptSchedule(true);
    this.setPauseState("none", "audio.play");
    this.syncMediaSessionPlaybackState();
    this.syncKaraokeProgressTicker();
  });
  bindSlotEvent("error", () => {
    if(audio===practicePlayer){this.lastPlaybackError=audio.error?.message||'伴奏读取失败，请重新载入或切回原曲。';this.showNotice(this.lastPlaybackError,'error');return;}
    if (this.isAudioEventForCommittedSource()) this.recoverCrossfadeAudioError();
  });
  bindSlotEvent("playing", () => {
    if (!this.isAudioEventForCommittedSource()) return;
    audioEngine?.continueFade(audio);
    this.resumeListeningAfterBuffering("playing");
    this.syncKaraokeProgressTicker();
    this.sendLyricOverlay();
  });
  bindSlotEvent("waiting", () => {
    if (!this.isAudioEventForCommittedSource()) return;
    this.markListeningBuffering("waiting");
    audioEngine?.holdTail(audio);
    this.stopKaraokeProgressTicker();
    this.sendLyricOverlay();
  });
  bindSlotEvent("stalled", () => {
    if (!this.isAudioEventForCommittedSource()) return;
    if (Number(audio.readyState || 0) < 3) {
      this.markListeningBuffering("stalled");
      this.stopKaraokeProgressTicker();
      this.sendLyricOverlay();
    }
  });
  bindSlotEvent("seeking", () => {
    if (!this.isAudioEventForCommittedSource()) return;
    this.cancelNaturalCrossfade(); audioEngine?.stopTail(audio);
    this.beginListeningSeek("seeking");
    this.stopKaraokeProgressTicker();
    this.sendLyricOverlay();
  });
  bindSlotEvent("seeked", () => {
    if (!this.isAudioEventForCommittedSource()) return;
    this._pendingSeekTime = null;
    this.completeListeningSeek("seeked");
    this.syncKaraokeProgressTicker();
    this.currentTime = Number(audio.currentTime) || 0;
    this.updateLyricHighlight(this.currentTime, { source: "seeked" });
  });
  bindSlotEvent("ratechange", () => {
    if (!this.isAudioEventForCommittedSource()) return;
    this.cancelNaturalCrossfade(); audioEngine?.stopTail(audio);
    this.handleListeningRateChange();
    this.updateLyricHighlight(Number(audio.currentTime)||0,{source:'ratechange'});
  });
  bindSlotEvent("pause", () => {
    if (this._ignoredInternalPauseEvents > 0) {
      this._ignoredInternalPauseEvents -= 1;
      return;
    }
    if (!this.isAudioEventForCommittedSource()) return;
    this._lastPausedAt = Date.now();
    this.checkpointListeningSession("pause");
    this.appendMediaDiagEvent("audio_pause", {
      pauseReason: this.playbackPauseReason,
      ended: !!audio.ended,
      time: Number(audio.currentTime || 0),
      volume: Number(audio.volume || 0),
    });
    const shouldCheck = this.isPlaying && !audio.ended;
    this.isPlaying = false;
    if (shouldCheck) {
      if (this.playbackPauseReason === "manual" || this.playbackPauseReason === "internal") {
        // no-op for expected pause sources
      } else {
        this.pauseByInterruptionDetected("audio.pause");
      }
    }
    this.syncMediaSessionPlaybackState();
    this.stopKaraokeProgressTicker();
  });
  bindSlotEvent("timeupdate", () => {
    if (!this.isAudioEventForCommittedSource()) return;
    this.currentTime = audio.currentTime || 0;
    this.syncAudioDuration();
    this.checkNaturalCrossfade();
    if (this.listeningSession?.state === "seeking" && !audio.seeking) {
      this.completeListeningSeek("timeupdate-after-seek");
    } else if (
      this.listeningSession?.state === "buffering"
      && !audio.paused
      && Number(audio.currentTime || 0) > Number(this.listeningSession.lastAudioTime || 0) + 0.001
    ) {
      this.resumeListeningAfterBuffering("timeupdate-after-buffering");
    }
    this.updateListeningSessionProgress();
    const now = Date.now();
    const lastAt = Number(this._lastTimeupdateAt || 0);
    const lastPos = Number(this._lastTimeupdatePos || 0);
    if (this.isPlaying && lastAt > 0) {
      const dt = now - lastAt;
      const dp = Math.abs((this.currentTime || 0) - lastPos);
      if (dt >= 2000 && dp < 0.01 && now - Number(this._stallDiagLastAt || 0) > 5000) {
        this._stallDiagLastAt = now;
        this.appendMediaDiagEvent("timeupdate_progress_stalled", {
          dt_ms: dt,
          dp_sec: dp,
          time: Number(this.currentTime || 0),
          volume: Number(audio.volume || 0),
        });
      }
    }
    this._lastTimeupdateAt = now;
    this._lastTimeupdatePos = Number(this.currentTime || 0);
    if (this.isCurrentOnlineTrack) {
      const threshold = Number(this.params?.online?.auto_index_after_seconds) || 60;
      const token = this.currentPath;
      if (
        this.featureEnabled?.('recommendation')!==false && this.params?.online?.auto_index_enabled &&
        this.onlineTrackMap[token] &&
        !this.currentTrackExcluded &&
        !this.onlineIndexTriggered[token] &&
        this.currentTime >= threshold
      ) {
        this.onlineIndexTriggered[token] = true;
        const track = this.onlineTrackMap[token];
        const localDuplicatePath = this.shouldSkipOnlineIndexForLocalDuplicate(token);
        if (localDuplicatePath) {
          track.duplicate_of = localDuplicatePath;
          track.dedupe_key = this.buildTrackArtistTitleKey(token);
          console.info(`[online-index][skip-client] duplicate_local token=${token} duplicate_of=${localDuplicatePath}`);
          return;
        }
        const streamUrl = String(audio.currentSrc || audio.src || "");
        if (!this.isOnlineToken(token) || !/^https?:\/\//i.test(streamUrl)) {
          return;
        }
        axios.post(`${this.baseUrl}/online/index`, {
          token,
          stream_url: streamUrl,
          meta: {
            source: track.source,
            songId: track.songId,
            name: track.title || track.name || "",
            artist: track.artist || "",
            album: track.album || "",
            duration: track.duration || 0,
            cover: track.cover || "",
            qualities: track.qualities || [],
            defaultQuality: this.pickOnlineQuality(track),
          },
          acquire: {
            resolver: "lx_custom_source",
            scriptPath: this.onlineSourceScriptPath || "",
            source: String(track.source || this.onlineFileSource || "").toLowerCase(),
            songId: track.songId,
          },
        }).then(() => this.loadTracks()).catch((e) => {
          console.warn("在线自动索引失败", e);
        });
      }
    }
    this.updateLyricHighlight();
  });
  bindSlotEvent("loadedmetadata", () => {
    if (!this.isAudioEventForCommittedSource()) return;
    this.syncAudioDuration();
    this.applyPendingSeek();
  });
  bindSlotEvent("durationchange", () => {
    if (!this.isAudioEventForCommittedSource()) return;
    this.syncAudioDuration();
  });
  bindSlotEvent("canplay", () => {
    if (!this.isAudioEventForCommittedSource()) return;
    this.syncAudioDuration();
    this.applyPendingSeek();
  });
  if (window.lxEnv?.onAudioOutputSafety) rememberIpcUnsubscribe(window.lxEnv.onAudioOutputSafety(event => this.handleAudioOutputSafety(event)));
  if (window.lxEnv && typeof window.lxEnv.onHotkey === "function") {
    rememberIpcUnsubscribe(window.lxEnv.onHotkey((action) => this.handleHotkey(action)));
  }
  if (window.lxEnv && typeof window.lxEnv.onMediaDiag === "function") {
    rememberIpcUnsubscribe(window.lxEnv.onMediaDiag((evt) => {
      if (!evt || typeof evt !== "object") return;
      this.mediaDiagEvents.push(evt);
      if (this.mediaDiagEvents.length > 200) {
        this.mediaDiagEvents.splice(0, this.mediaDiagEvents.length - 200);
      }
    }));
  }
  if (window.lxEnv && typeof window.lxEnv.onInstallerProgress === "function") {
    rememberIpcUnsubscribe(window.lxEnv.onInstallerProgress((payload) => {
      this.applyInstallerProgress(payload);
    }));
  }
  window.lxEnv?.getSongTagCapabilities?.().then(result => { this.songMetadataEditAvailable = result?.editable === true; }).catch(() => {});
  if (window.lxEnv?.onSongTagsUpdated) rememberIpcUnsubscribe(window.lxEnv.onSongTagsUpdated(result => {
    this.handleSongTagsUpdated(result).catch(() => this.showNotice("资料已写入，请刷新音乐库查看", "error"));
  }));
  window.lxEnv?.setTagPlaybackTarget?.({ path: this.currentPath, generation: this.playbackGeneration });
  if (window.lxEnv && typeof window.lxEnv.onSongInfoBatchUpdated === "function") {
    rememberIpcUnsubscribe(window.lxEnv.onSongInfoBatchUpdated((task) => {
      this.applySongInfoBatchUpdate(task);
    }));
  }
  if (window.lxEnv && typeof window.lxEnv.onLyricOverlayAction === "function") {
    rememberIpcUnsubscribe(window.lxEnv.onLyricOverlayAction((data) => this.handleLyricOverlayAction(data)));
  }
  if (window.lxEnv && typeof window.lxEnv.onLyricOverlayState === "function") {
    rememberIpcUnsubscribe(window.lxEnv.onLyricOverlayState((state) => {
      this.desktopLyricOpen = !!state?.open;
    }));
  }
  if (window.lxEnv && typeof window.lxEnv.on === "function") {
    rememberIpcUnsubscribe(window.lxEnv.on("lx-player-control", (payload) => {
      this.handleExternalPlayerControl(payload);
    }));
    rememberIpcUnsubscribe(window.lxEnv.on("lx-audio-focus-event", (payload) => {
      const kind = String(payload?.kind || "").toLowerCase();
      this.audioFocusWatcherAvailable = true;
      this.appendMediaDiagEvent("audio_focus_event", { kind, payload });
      if (kind === "interrupt-start") {
        this.pauseByInterruptionDetected("focus-watcher");
      } else if (kind === "interrupt-end") {
        this.resumeByAutoInterruption("focus-watcher");
      }
    }));
  }
  this._onResize = () => {
    this.refreshVirtualViewport();
    this.scheduleLyricViewportRefresh({ keepCentered: true });
  };
  this._onDocPointerDown = () => {
    this.closeOnlineContextMenu();
    this.closePlaylistContextMenu();
    this.closeTrackContextMenu();
  };
  this._onDocKeyDown = (event) => {
    if (!this.handlePracticeArrows(event)&&!this.handlePracticeSpace(event)) this.handleGlobalEscape(event);
  };
  window.addEventListener("resize", this._onResize);
  document.addEventListener("pointerdown", this._onDocPointerDown);
  document.addEventListener("keydown", this._onDocKeyDown);
  this.loadShortcutSettings();
  this.loadSongInfoBatchTasks();
  this.loadRecentLyricSave();
  this.refreshMediaDiag();
  this.refreshAll({ silent: true, startup: true }).catch(() => {});
  this.$nextTick(() => this.refreshVirtualViewport());
  this.sendLyricOverlay();
  window.__flowaveMounted = true;
}

function beforeUnmountHook() {
  // Failed startup may still contain defaults rather than the saved profile.
  // Release resources without publishing those partial preferences or history.
  const initialized = window.__flowaveMounted === true && !window.__flowaveStartupError;
  document.removeEventListener('visibilitychange',this.outputCalibrationVisibility);
  this.outputCalibrationClosed=true;
  for(const release of this.outputCalibrationLeases?.values()||[])release();
  this.outputCalibrationLeases?.clear();
  clearTimeout(soundMapArchiveTimer);clearTimeout(soundMapRetryTimer);
  this.disposeVirtualViewport();
  window.removeEventListener('flowave-output-calibration',this._onLyricOutputCalibration);
  lyricAmbientRuntime?.destroy();
  lyricAmbientRuntime = null;
  ++this.audioDetailGeneration;
  this.cancelAudioDetailRequest();
  this._indexStatusStopped = true;
  clearTimeout(this._indexStatusTimer);
  this.playbackGeneration = playbackTransitionCoordinator.invalidate();
  this._trackLoadGeneration = Number(this._trackLoadGeneration || 0) + 1;
  this._metadataPlanGeneration = Number(this._metadataPlanGeneration || 0) + 1;
  this.pendingPlaybackTransition = null;
  if (this._onResize) {
    window.removeEventListener("resize", this._onResize);
  }
  if (this._onDocPointerDown) {
    document.removeEventListener("pointerdown", this._onDocPointerDown);
  }
  if (this._onDocKeyDown) {
    document.removeEventListener("keydown", this._onDocKeyDown);
  }
  (this._ipcUnsubscribers || []).forEach((unsubscribe) => {
    try {
      unsubscribe();
    } catch {
      // ignore listener cleanup failures during shutdown
    }
  });
  this._ipcUnsubscribers = [];
  if (this._onlineAutoSearchTimer) {
    clearTimeout(this._onlineAutoSearchTimer);
    this._onlineAutoSearchTimer = null;
  }
  if (this._metadataPriorityTimer) {
    clearTimeout(this._metadataPriorityTimer);
    this._metadataPriorityTimer = null;
  }
  this._onlineRequestGeneration = Number(this._onlineRequestGeneration || 0) + 1;
  this._songInfoRequestGeneration = Number(this._songInfoRequestGeneration || 0) + 1;
  if (this.songInfoDialog?.requestId) {
    window.lxEnv?.cancelSongInfoQuery?.(this.songInfoDialog.requestId).catch?.(() => {});
  }
  if (this.songInfoDialog?.coverRequestId) {
    window.lxEnv?.cancelSongInfoCover?.(this.songInfoDialog.coverRequestId).catch?.(() => {});
  }
  if (this.songInfoDialog?.lyricConfirmationId) {
    window.lxEnv?.cancelLyricSave?.(this.songInfoDialog.lyricConfirmationId).catch?.(() => {});
  }
  this.onlineLoading = false;
  if (this.dragState?.longPressTimer) {
    clearTimeout(this.dragState.longPressTimer);
    this.dragState.longPressTimer = null;
  }
  if (this._playlistLocateFlashTimer) {
    clearTimeout(this._playlistLocateFlashTimer);
    this._playlistLocateFlashTimer = null;
  }
  if (this._locateHighlightTimer) {
    clearTimeout(this._locateHighlightTimer);
    this._locateHighlightTimer = null;
  }
  if (this._focusSearchRafId) {
    cancelAnimationFrame(this._focusSearchRafId);
    this._focusSearchRafId = 0;
  }
  if (this._rankingMetaRefreshTimer) {
    clearTimeout(this._rankingMetaRefreshTimer);
    this._rankingMetaRefreshTimer = null;
  }
  if (this._uiSnapshotTimer) {
    clearTimeout(this._uiSnapshotTimer);
    this._uiSnapshotTimer = null;
  }
  if (this._searchIndexTimer) {
    clearTimeout(this._searchIndexTimer);
    this._searchIndexTimer = null;
  }
  if (this._metadataFillTimer) {
    clearTimeout(this._metadataFillTimer);
    this._metadataFillTimer = null;
  }
  if (this._configAutoSaveTimer) {
    clearTimeout(this._configAutoSaveTimer);
    this._configAutoSaveTimer = null;
  }
  if (initialized) this.flushConfigBeforeUnload();
  if (this._shortcutAutoSaveTimer) {
    clearTimeout(this._shortcutAutoSaveTimer);
    this._shortcutAutoSaveTimer = null;
    if (initialized) this.saveShortcutSettings();
  }
  this._searchIndexBuildId = Number(this._searchIndexBuildId || 0) + 1;
  this._searchWorkerController?.close();
  this._searchWorkerController = null;
  this._searchWorkerViews?.clear();
  Object.values(this._localSearchTimers || {}).forEach((timer) => {
    if (timer) clearTimeout(timer);
  });
  this._localSearchTimers = {};
  if (this._startupRefreshTimer) {
    clearTimeout(this._startupRefreshTimer);
    this._startupRefreshTimer = null;
  }
  if (this._startupSplashMaxTimer) {
    clearTimeout(this._startupSplashMaxTimer);
    this._startupSplashMaxTimer = null;
  }
  if (this._startupSplashDoneTimer) {
    clearTimeout(this._startupSplashDoneTimer);
    this._startupSplashDoneTimer = null;
  }
  if (this._startupSplashHideTimer) {
    clearTimeout(this._startupSplashHideTimer);
    this._startupSplashHideTimer = null;
  }
  this.stopLyricScrollAnimation();
  this.stopPendingLyricScrollRequest();
  if (this._lyricResizeRafId) {
    cancelAnimationFrame(this._lyricResizeRafId);
    this._lyricResizeRafId = 0;
  }
  this.stopKaraokeProgressTicker();
  this.resetKaraokeWordProgress();
  this.cancelNaturalCrossfade();
  clearTimeout(audioSettingsSaveTimer);
  if (initialized) this.flushListeningSession("unmount");
  this.clearAdjacentRecommendations();
  audioEngine?.dispose();
  practiceController?.abort(); practiceController = null;
  ++practiceMetronomeGeneration;clearTimeout(practiceMetronomePreviewTimer);practiceMetronomePreview?.dispose();practiceMetronomePreview=null; practiceMetronome?.dispose(); practiceMetronome = null;
  ++practiceTrainingGeneration;practiceTraining?.dispose();practiceTraining=null;
  practicePlayer?.dispose(); practicePlayer = null; practiceOriginal = null;
  window.FlowaveStemPlayer?.clearCache();
  if (initialized) {
    this.saveListeningHistoryNow();
    this.saveUiSnapshot({ flushLibrary: true });
  }
  this.cancelRecommendPrefetch();
  if (this._recommendationRatePollTimer) {
    clearTimeout(this._recommendationRatePollTimer);
    this._recommendationRatePollTimer = null;
  }
  if (this._noticeTimer) {
    clearTimeout(this._noticeTimer);
    this._noticeTimer = null;
  }
  if (typeof this._confirmDialogResolver === "function") {
    this._confirmDialogResolver(false);
    this._confirmDialogResolver = null;
  }
  this._confirmReturnFocus = null;
  if (this._lyricSettingsSaveTimer) {
    clearTimeout(this._lyricSettingsSaveTimer);
    this._lyricSettingsSaveTimer = null;
    if (initialized) this.persistLyricSettings();
  }
  if (this._desktopLyricSettingsSaveTimer) {
    clearTimeout(this._desktopLyricSettingsSaveTimer);
    this._desktopLyricSettingsSaveTimer = null;
    if (initialized) this.persistDesktopLyricSettings();
  }
  this.clearAudioInterruptSchedule(true);
  this.clearLyricResumeTimer();
  if (window.lxEnv && typeof window.lxEnv.closeLyricOverlay === "function") {
    window.lxEnv.closeLyricOverlay().catch(() => {});
  }
}

const kumikoVueApp = createApp({
  data() {
    const backendConfig = window.lxEnv && typeof window.lxEnv.getBackendConfigSync === "function"
      ? window.lxEnv.getBackendConfigSync()
      : null;
    const storedSongInfoBatch = readStoredObject(STORAGE_KEYS.SONG_INFO_BATCH_SETTINGS, {});
    const storedSongInfoFields = storedSongInfoBatch.fields && typeof storedSongInfoBatch.fields === "object"
      ? storedSongInfoBatch.fields
      : {};
    const storedSongInfoAutoThreshold = clampNumberAllowZero(storedSongInfoBatch.autoThreshold, 95, 90, 99);
    const storedSongInfoManualThreshold = clampNumberAllowZero(
      storedSongInfoBatch.manualThreshold,
      75,
      60,
      storedSongInfoAutoThreshold - 1,
    );
    const storedSongInfoConcurrency = clampNumberAllowZero(storedSongInfoBatch.concurrency, 4, 1, 12);
    return {
      baseUrl: String(backendConfig?.baseUrl || "http://127.0.0.1:29613"),
      showPracticeEntry: readStoredString('lx-practice-entry', '1') !== '0',
      practiceEnabled: false, practiceLoading: false, practiceLoadProgress: '', practiceReturn: null,
      params: {
        recommendation: { semantic_floor: .90, context_floor: .86, candidate_limit: 80, recent_exclusion: 2, allow_older_repeats: true, adjacent_mert_floor:.95 },
        similarity: { like_min: 0.98, like_max: 0.99, fallback_top_n: 10 },
        dislike: { min_sim: 0.85, max_sim: 0.93 },
        dislike_correction: {
          enabled: true,
          enable_recommend_rate_fix: true,
          rec_strength: 1,
          rec_fix_min: 0.1,
          rec_fix_max: 20,
          auto_rebuild_recommend_rate: true,
          enable_skip_rate_fix: true,
          skip_strength: 1,
          skip_fix_min: 0.33,
          skip_fix_max: 2,
          skip_smooth_k: 20,
          daily_decay: 0.98,
          consecutive_dislike_threshold: 0,
          long_pause_reset_minutes: 10,
        },
        history: { allow_duplicates: false, repeat_policy: "disallow", no_repeat_within: 100 },
        seed: { tau: 30, tau_pos: 20, tau_neg: 5, lambda_neg: 0.5 },
        model: { source: "m-a-p/MERT-v1-330M", local_dir: "models/MERT-v1-330M" },
        online: { auto_index_enabled: true, auto_index_after_seconds: 60, default_quality: "320k", exclude_tokens: [] },
        audio_dir: "",
        download_dir: "",
      },
      tracks: [], // [{path,name,artist,album,duration,durationText}]
      trackByPath: new Map(),
      trackByResourceId: new Map(),
      trackResourcesBySongKey: new Map(),
      _localMetadataRevision: 0,
      _localTrackMatchIndex: null,
      searchDocs: [],
      searchFuse: null,
      _searchIndexTimer: null,
      _searchIndexBuildId: 0,
      _trackLoadGeneration: 0,
      _metadataFillTimer: null,
      _metadataPriorityTimer: null,
      _metadataPlanGeneration: 0,
      _libraryInteractionRevision: 0,
      _startupLibraryInteractionRevision: null,
      _startupPlaybackGeneration: null,
      _skipNextKeywordScrollReset: false,
      searchIndexReady: false,
      searchIndexBuilding: false,
      searchWorkerRevision: 0,
      searchInputResetRevision: 0,
      _localSearchTimers: {},
      playlists: [], // {id,name,tracks,type}
      sessionQueue: readStoredObject("lx-session-queue", null),
      soundMapArchiveMode: rendererStateStore.__flowaveTraceArchive?.mode || 'legacy',
      soundMapArchiveError: '',
      outputCalibrationLeases: markSearchRaw(new Map()), outputCalibrationClosed:false,
      soundMapRollbackActive: false,
      soundMapTrace: markSearchRaw(window.FlowaveFeatureModules?.enabled('recommendation')===false ? [] : readStoredObjectArray(rendererStateStore.__flowaveTraceArchive?.mode && rendererStateStore.__flowaveTraceArchive.mode!=='legacy' ? 'lx-sound-map-hot' : 'lx-sound-map-trace', Number.MAX_SAFE_INTEGER).filter(row=>row && typeof row.path==="string" && typeof row.attemptId==="string")),
      soundMapTraceRevision: 0,
      soundMapOutbox: markSearchRaw(window.FlowaveFeatureModules?.enabled('recommendation')===false ? [] : readStoredObjectArray("lx-sound-map-outbox", Number.MAX_SAFE_INTEGER)),
      soundMapSaveError: "",
      soundMapLibraryRevision: 0,
      analysisPinnedPath: "",
      analysisReturn: null,
      audioDetailGeneration: 0,
      audioDetailController: null,
      audioDetail: {visible:false,mode:"info",path:"",info:{},loading:false,error:"",label:"",rows:[],page:1,scanned:0,total:0,failures:0},
      currentPlaylist: "all",
      customPlaylists: [],
      seeds: [], // {id,name,k,seed_track_paths,rec_cache}
      currentSeedId: "",
      seedRecs: [],
      seedSearch: "",
      seedLoading: false,
      seedsLoaded: false,
      seedPreloadPromise: null,
      seedLoadGeneration: 0,
      seedDetailGeneration: 0,
      seedModalVisible: false,
      seedModalTrack: "",
      seedModalExistingId: "",
      seedModalNewName: "",
      seedModalK: 50,
      seedEditModalVisible: false,
      seedEditId: "",
      seedEditName: "",
      seedEditK: 50,
      seedPos: [],
      seedNeg: [],
      keywordDraft: "",
      keyword: "",
      rankingLeftKeywordDraft: "",
      rankingLeftKeyword: "",
      rankingRightKeywordDraft: "",
      rankingRightKeyword: "",
      onlineKeyword: "",
      onlineMusicSource: readStoredString(STORAGE_KEYS.ONLINE_MUSIC_SOURCE, "all"),
      onlineSonglistSource: readStoredString(STORAGE_KEYS.ONLINE_SONGLIST_SOURCE, "all"),
      onlineFileSource: readStoredString(STORAGE_KEYS.ONLINE_FILE_SOURCE, "kw"),
      onlineSearchType: "music",
      onlineLoading: false,
      onlineHasSearched: false,
      onlineMessage: "",
      onlineMessageTone: "info",
      notice: { visible: false, message: "", tone: "info" },
      _noticeTimer: null,
      confirmDialog: {
        visible: false,
        title: "",
        message: "",
        detail: "",
        confirmLabel: "确认",
        tone: "primary",
      },
      _confirmDialogResolver: null,
      _confirmReturnFocus: null,
      _onlineRequestGeneration: 0,
      _onlineAutoSearchTimer: null,
      onlineTracks: [],
      onlineSelectedTokens: [],
      onlineSelectionAnchor: -1,
      onlineSonglists: [],
      onlineSonglistsSnapshot: [],
      currentOnlineSonglist: null,
      onlineSonglistExpanded: false,
      onlineContextMenu: { show: false, x: 0, y: 0 },
      playlistContextMenu: { show: false, x: 0, y: 0, playlistId: "", playlistName: "" },
      libraryBrowseMode: "songs",
      folderBrowsePath: "",
      trackContextMenu: { show: false, x: 0, y: 0, path: "" },
      songInfoDialog: {
        visible: false,
        mode: "metadata", searchTitle: "", searchArtist: "", destination: "", targetExists: false,
        showRejected: false, format: "enhanced-lrc", lyricFileExists: false, manualIdentity: false,
        path: "",
        requestId: "",
        loading: false,
        error: "",
        current: null,
        candidates: [],
        sources: [],
        selectedIndex: 0,
        coverUrls: {},
        coverRequestId: "",
        lyricSaveBusy: false,
        lyricSaveMessage: "",
        lyricConfirmationId: "",
      },
      _songInfoRequestGeneration: 0,
      songMetadataEditAvailable: false,
      lastMetadataSave: readStoredObject("metadata-last-save", null),
      lastLyricSaveTransactionId: "",
      lastLyricSaveTrackPath: "",
      lyricUndoBusy: false,
      _lyricUndoStateGeneration: 0,
      songInfoBatchFieldOptions: SONG_INFO_BATCH_FIELD_OPTIONS,
      songInfoBatchScopeOptions: SONG_INFO_BATCH_SCOPE_OPTIONS,
      songInfoBatchSettings: {
        scope: SONG_INFO_BATCH_SCOPES.has(storedSongInfoBatch.scope) ? storedSongInfoBatch.scope : "all",
        fields: { ...DEFAULT_SONG_INFO_BATCH_FIELDS, ...storedSongInfoFields },
        autoThreshold: storedSongInfoAutoThreshold,
        manualThreshold: storedSongInfoManualThreshold,
        concurrency: storedSongInfoConcurrency,
        lyricSources: {
          lddc: storedSongInfoBatch.lyricSources?.lddc !== false,
          external: storedSongInfoBatch.lyricSources?.external !== false,
          embedded: storedSongInfoBatch.lyricSources?.embedded !== false,
        },
        lyricSaveTarget: "sidecar",
        lyricFormat: storedSongInfoBatch.lyricFormat === "lrc" ? "lrc" : "enhanced-lrc",
        skipExistingLyrics: storedSongInfoBatch.skipExistingLyrics !== false,
      },
      songInfoBatchTasks: [],
      songInfoBatchCurrentId: "",
      songInfoBatchChoices: {},
      songInfoBatchReviewLimit: 30,
      songInfoBatchUncertainLimit: 30,
      songInfoBatchEmptyLimit: 20,
      songInfoBatchFailureLimit: 10,
      songInfoBatchBusy: false,
      songInfoBatchMessage: "",
      songInfoBatchStoreBlocked: false,
      songInfoLyricBatchAvailable: false,
      _songInfoBatchLoadGeneration: 0,
      _songInfoBatchRevision: 0,
      songInfoCacheBusy: false,
      songInfoCacheMessage: "",
      songInfoCacheMessageTone: "",
      playlistEditModalVisible: false,
      playlistEditId: "",
      playlistEditName: "",
      playlistEditError: "",
      playlistAddModalVisible: false,
      playlistAddTrack: "",
      playlistAddTargetId: "",
      playlistAddNewName: "",
      playlistAddError: "",
      onlineDownloadModalVisible: false,
      onlineDownloadQuality: "320k",
      onlineDownloading: false,
      onlineTrackMap: {},
      onlineIndexPendingFor: "",
      onlineIndexTriggered: {},
      fuzzy: true,
      view: PUBLIC_VIEWS.has(readStoredString(STORAGE_KEYS.LAST_VIEW, "library"))
        ? readStoredString(STORAGE_KEYS.LAST_VIEW, "library")
        : "library",
      visitedViews: { library: true },
      settingsTab: "general",
      settingsNavigationGeneration: 0,
      settingsOverviewQuery: "",
      settingsCalibrationOpen: false,
      onlineSourceScriptPath: "",
      onlineSourceDefaultPath: "",
      onlineSourceScriptExists: false,
      onlineSourceSaving: false,
      onlineSourceMessage: "",
      installerTasks: {
        recommendation: {
          task: "recommendation",
          phase: "idle",
          running: false,
          percent: 0,
          message: "",
          target: "backend\\index-worker",
        },
        model: {
          task: "model",
          phase: "idle",
          running: false,
          percent: 0,
          message: "",
          target: "models\\MERT-v1-330M",
        },
      },
      configSaveState: "saved",
      audioDirectoryDraft: "",
      audioDirectoriesDraft: [],
      _configAutoSaveReady: false,
      _configAutoSaveTimer: null,
      _configSavePromise: null,
      _configSaveQueued: false,
      _configAutoSaveSuspended: false,
      _audioDirectorySavePromise: null,
      _lastSavedConfigFingerprint: "",
      indexTaskRunning: false,
      indexTaskStatus: {},
      indexTaskNow: Date.now(),
      indexTaskStatusUnavailable: false,
      libraryRefreshMessage: "",
      onlineSourceNames: [],
      externalLyricDir: "",
      externalLyricConfigPath: "",
      externalLyricDirExists: false,
      externalLyricSaving: false,
      externalLyricMessage: "",
      recommendationRateStatus: { status: "missing", running: false, progress: { done: 0, total: 0 }, summary: {} },
      recommendationRateMessage: "",
      _recommendationRatePollTimer: null,
      shortcutItems: [],
      shortcutMediaStatus: [],
      mediaDiagEvents: [],
      _ipcUnsubscribers: [],
      listeningHistory: {
        version: LISTENING_HISTORY_VERSION,
        updatedAt: 0,
        totalSeconds: 0,
        totalPlays: 0,
        tracks: {},
        days: {},
      },
      listeningSession: null,
      listeningHistoryKeyword: "",
      listeningHistoryPage: 1,
      listeningHistorySort: "playCount",
      listeningHistoryActionBusy: false,
      listeningHistoryMessage: "",
      listeningHistoryRecoveryStatus: {},
      listeningHistoryLoaded: false,
      listeningHistoryLoading: false,
      listeningHistoryClosing: false,
      audioEffects: AudioEffects ? AudioEffects.normalize(readStoredObject("lx-audio-effects")) : {},
      equalizerOpen: false,
      audioEffectsMessage: "",
      eqFrequencies: AudioEffects?.frequencies || [],
      eqPresets: AudioEffects?.presets || {},
      _listeningHistorySaveTimer: null,
      _listeningHistoryMaxSaveTimer: null,
      audioFocusWatcherAvailable: false,
      shortcutSaving: false,
      shortcutMessage: "",
      _shortcutHydrating: false,
      _shortcutAutoSaveTimer: null,
      _shortcutSaveGeneration: 0,
      themeName: readStoredString(STORAGE_KEYS.THEME, DEFAULT_THEME),
      customColor: readStoredString(STORAGE_KEYS.ACCENT, DEFAULT_ACCENT),
      isPlaying: false,
      playbackGeneration: 0,
      pendingPlaybackTransition: null,
      _committedPlaybackGeneration: 0,
      _committedAudioSource: "",
      _ignoredInternalPauseEvents: 0,
      currentPath: "",
      currentTrackRef: null,
      selectedPath: "",
      currentMeta: { title: "", artist: "", album: "", lyric: "", lyricModel: null },
      currentCover: "",      // 缩略图（底栏/列表）
      currentCoverFull: "",  // 原图（歌词页）
      duration: 0,
      durationText: "00:00",
      currentTime: 0,
      _pendingSeekTime: null,
      muted: false,
      volume: 80,
      pausedByAudioInterruption: false,
      playbackPauseReason: "none", // none | manual | internal | interruption
      outputSafetyBlocked: false,
      outputSafetyWarningShown: false,
      outputSafetyRevision: 0,
      outputSafetyWearResume: null,
      playbackIntent: "pause", // play | pause
      lastPauseSource: "",
      audioInterrupt: {
        timer: null,
        retryCount: 0,
        maxRetry: 8,
        baseDelayMs: 1200,
        maxDelayMs: 10000,
        armed: false,
        trackPath: "",
      },
      _lastTimeupdateAt: 0,
      _lastTimeupdatePos: 0,
      _stallDiagLastAt: 0,
      featureSelection: window.FlowaveFeatureModules?.initial || {active:{enabled:{}},selected:{enabled:{}}},
      featureCatalog: window.FlowaveFeatureModules?.catalog || [],
      moduleFailures: window.FlowaveFeatureModules?.failures || {},
      featureDataLocations: [],
      featurePackageProgress: window.FlowaveFeatureModules?.initial?.installation || {},
      featureSaving: !!window.FlowaveFeatureModules?.initial?.installation,
      featureMessage: '',
      useRecommend: window.FlowaveFeatureModules?.enabled('recommendation')===false ? false : readStoredBool(STORAGE_KEYS.USE_RECOMMEND, true),
      recommendFullMode: readStoredBool(STORAGE_KEYS.RECOMMEND_FULL_MODE, false),
      currentTrackExcluded: false,
      lastPlaybackError: "",
      lastOnlineResolveDebug: "",
      playMode: "loop", // loop | shuffle
      recCache: null,
      recCacheFor: null,
      recCacheAt: 0,
      recCacheStamp: "",
      dislikeActionGeneration: 0,
      recommendationActionId: 0,
      recommendationJobs: null,
      recommendationPreparing: false,
      recommendationResume: null,
      recommendationTimerResolve: null,
      recommendationRequestError: "",
      recommendationContext: readStoredObject("lx-recommendation-context-v2", {}),
      continuityRecent: readStoredObjectArray("lx-continuity-recent", 8),
      recommendationDiagnostics: window.FlowaveFeatureModules?.enabled('recommendation')===false ? [] : readStoredObjectArray("lx-recommendation-diagnostics", 80).map(item => ["selected", "playing"].includes(item.status) ? {...item,status:"interrupted"} : item),
      _uiSnapshotTimer: null,
      _playlistLocateFlashTimer: null,
      _locateHighlightTimer: null,
      _focusSearchRafId: 0,
      _startupRefreshTimer: null,
      _recommendPrefetchTimer: null,
      _recommendAbortController: null,
      _recommendPendingPromise: null,
      _recommendRequestId: 0,
      consecutiveDislikeCount: 0,
      lastDislikeAt: 0,
      lastDislikeResetSource: "",
      _lastPausedAt: 0,
      loading: false,
      loadingRec: false,
      startupSplashVisible: true,
      startupSplashHiding: false,
      startupSplashBackgroundStyle: "none",
      startupBackground: initialStartupBackground,
      startupBackgroundSaving: false,
      startupBackgroundMessage: initialStartupBackground.message || '',
      _startupSplashStartedAt: 0,
      _startupSplashMaxTimer: null,
      _startupSplashDoneTimer: null,
      _startupSplashHideTimer: null,
      log: { like_list: [], dislike_list: [], dislike_debug: {}, stats: {} },
      showLyric: false,
      lyricLines: [],
      currentLyricIndex: -1,
      lyricFocusIndex: -1,
      lyricScrollIndex: -1,
      currentLyricWordIndex: -1,
      currentLyricWordProgress: 0,
      _lyricScrollRafId: 0,
      _lyricScrollRequestRafId: 0,
      _lyricResizeRafId: 0,
      _karaokeProgressRafId: 0,
      _karaokeActiveWordEl: null,
      _karaokeActiveLineIndex: -1,
      _karaokeActiveWordIndex: -1,
      _karaokeRenderedProgress: -1,
      lyricHasTimeline: false,
      lyricAutoFollow: true,
      lyricResumeTimer: null,
      _lyricSettingsSaveTimer: null,
      _desktopLyricSettingsSaveTimer: null,
      lyricProgrammaticScrollUntil: 0,
      lyricMainFontSize: clampNumber(readStoredNumber(STORAGE_KEYS.LYRIC_MAIN_FONT, readStoredNumber(STORAGE_KEYS.LYRIC_FONT, DEFAULT_LYRIC_FONT_SIZE)), DEFAULT_LYRIC_FONT_SIZE, 14, 72),
      lyricSubFontSize: clampNumber(readStoredNumber(STORAGE_KEYS.LYRIC_SUB_FONT, DEFAULT_LYRIC_SUB_FONT_SIZE), DEFAULT_LYRIC_SUB_FONT_SIZE, 12, 56),
      lyricFontFamily: readStoredString(STORAGE_KEYS.LYRIC_FONT_FAMILY, DEFAULT_LYRIC_FONT_FAMILY),
      lyricInactiveColor: readStoredString(STORAGE_KEYS.LYRIC_INACTIVE_COLOR, readStoredString(STORAGE_KEYS.LYRIC_TEXT_COLOR_LEGACY, DEFAULT_LYRIC_INACTIVE_COLOR)),
      lyricActiveColor: readStoredString(STORAGE_KEYS.LYRIC_ACTIVE_COLOR, DEFAULT_LYRIC_ACTIVE_COLOR),
      lyricMetaColor: readStoredString(STORAGE_KEYS.LYRIC_META_COLOR, DEFAULT_LYRIC_META_COLOR),
      lyricBgColor: readStoredString(STORAGE_KEYS.LYRIC_BG_COLOR, DEFAULT_LYRIC_BG_COLOR),
      lyricActiveScale: (LyricUtils.clampActiveScale || ((n) => Math.max(1.1, Math.min(1.35, Number(n) || DEFAULT_LYRIC_ACTIVE_SCALE))))(readStoredNumber(STORAGE_KEYS.LYRIC_ACTIVE_SCALE, DEFAULT_LYRIC_ACTIVE_SCALE)),
      lyricDisplayMode: readStoredString(STORAGE_KEYS.LYRIC_DISPLAY_MODE, DEFAULT_LYRIC_DISPLAY_MODE), // original | translation | both
      lyricKaraoke: readStoredString(STORAGE_KEYS.LYRIC_KARAOKE, "1") !== "0",
      lyricStageAutoColor: readStoredBool("lx-lyric-stage-auto-color", true),
      lyricStageScale: Math.max(1, Math.min(2.4, readStoredNumber("lx-lyric-stage-scale", 1.8))),
      lyricGlowEnabled: readStoredBool(STORAGE_KEYS.LYRIC_GLOW_ENABLED, DEFAULT_LYRIC_GLOW_ENABLED),
      lyricGlowSpeed: Math.max(0.4, Math.min(2.4, readStoredNumber(STORAGE_KEYS.LYRIC_GLOW_SPEED, DEFAULT_LYRIC_GLOW_SPEED))),
      lyricRenderDelayMs: Math.max(-1000, Math.min(1000, readStoredNumber(STORAGE_KEYS.LYRIC_RENDER_DELAY_MS, DEFAULT_LYRIC_RENDER_DELAY_MS))),
      lyricFocusLeadMs: Math.max(0, Math.min(500, readStoredNumber(STORAGE_KEYS.LYRIC_FOCUS_LEAD_MS, DEFAULT_LYRIC_FOCUS_LEAD_MS))),
      lyricSwitchScrollMs: Math.max(120, Math.min(800, readStoredNumber(STORAGE_KEYS.LYRIC_SWITCH_SCROLL_MS, DEFAULT_LYRIC_SWITCH_SCROLL_MS))),
      lyricSaveIncludeTranslation: readStoredBool(STORAGE_KEYS.LYRIC_SAVE_TRANSLATION, true),
      lyricSaveIncludeRomanization: readStoredBool(STORAGE_KEYS.LYRIC_SAVE_ROMANIZATION, false),
      lyricVolumeOpen: false,
      lyricCenterSpacer: 120,
      desktopLyricEnabled: readStoredBool(STORAGE_KEYS.DESKTOP_LYRIC_ENABLED, false),
      desktopLyricLocked: readStoredBool(STORAGE_KEYS.DESKTOP_LYRIC_LOCKED, DEFAULT_DESKTOP_LYRIC_LOCKED),
      desktopLyricMainFontSize: clampNumber(readStoredNumber(STORAGE_KEYS.DESKTOP_LYRIC_MAIN_FONT, readStoredNumber(STORAGE_KEYS.DESKTOP_LYRIC_FONT_SIZE, DEFAULT_DESKTOP_LYRIC_FONT_SIZE)), DEFAULT_DESKTOP_LYRIC_FONT_SIZE, 20, 72),
      desktopLyricSubFontSize: clampNumber(readStoredNumber(STORAGE_KEYS.DESKTOP_LYRIC_SUB_FONT, DEFAULT_DESKTOP_LYRIC_SUB_FONT_SIZE), DEFAULT_DESKTOP_LYRIC_SUB_FONT_SIZE, 12, 56),
      desktopLyricOpacity: clampNumber(readStoredNumber(STORAGE_KEYS.DESKTOP_LYRIC_OPACITY, DEFAULT_DESKTOP_LYRIC_OPACITY), DEFAULT_DESKTOP_LYRIC_OPACITY, 0.2, 1),
      desktopLyricStroke: clampNumberAllowZero(readStoredNumber(STORAGE_KEYS.DESKTOP_LYRIC_STROKE, DEFAULT_DESKTOP_LYRIC_STROKE), DEFAULT_DESKTOP_LYRIC_STROKE, 0, 1.5),
      desktopLyricCoverColor: readStoredBool(STORAGE_KEYS.DESKTOP_LYRIC_COVER_COLOR, true),
      desktopLyricCoverPalette: null,
      _desktopLyricCoverPaletteCache: new Map(),
      _desktopLyricCoverPaletteRequestId: 0,
      desktopLyricCurrentOnly: readStoredBool(STORAGE_KEYS.DESKTOP_LYRIC_CURRENT_ONLY, DEFAULT_DESKTOP_LYRIC_CURRENT_ONLY),
      desktopLyricOpen: false,
      lyricFontOptions: [
        { label: "微软雅黑", value: "Microsoft YaHei UI" },
        { label: "等线", value: "DengXian" },
        { label: "黑体", value: "SimHei" },
        { label: "苹方", value: "PingFang SC" },
        { label: "思源黑体", value: "Noto Sans SC" },
        { label: "AXIS Font", value: "AXIS Font" },
        { label: "Sarasa Gothic", value: "Sarasa Gothic SC, Sarasa Gothic, 更纱黑体 SC" },
        { label: "思源宋体", value: "Noto Serif CJK SC, Source Han Serif SC, Source Han Serif" },
        { label: "筑紫明朝（TsukuMin）", value: "TsukuMin Pr6N, TsukuMinPr6N, Tsukushi Mincho" },
        { label: "Arial", value: "Arial" },
      ],
      playHistory: readStoredStringArray(STORAGE_KEYS.PLAY_HISTORY, 500),
      playHistoryRefs: readStoredObjectArray(STORAGE_KEYS.PLAY_HISTORY_REFS, 500),
      dragState: {
        draggingId: "",
        overId: "",
        lastPreviewKey: "",
        longPressTimer: null,
        enableDrag: false,
      },
      // 排行页面
      rankingList: [],
      rankingFor: "",
      rankingLoading: false,
      locateHighlightPath: "",
      // 大列表虚拟滚动
      libraryScrollTop: 0,
      libraryViewportHeight: 0,
      libraryRowHeight: 64,
      rankingScrollTop: 0,
      rankingViewportHeight: 0,
      rankingRowHeight: 56,
      virtualOverscan: 8,
      playlistScrollTopMap: {},
      playlistLocateFlashId: "",
    };
  },
  computed: computedProps,
  components: {
    'practice-page': window.FlowavePracticeUi || window.FlowavePractice || {render:()=>null},
    ...(window.FlowaveBluetoothCalibration ? {'bluetooth-calibration':window.FlowaveBluetoothCalibration}:{}),
    MusicInsights: window.FlowaveMusicInsights || {render:()=>null},
    SoundMap: window.FlowaveSoundMap || {render:()=>null},
    ...(window.FlowaveSearchInput ? { LibrarySearchInput: window.FlowaveSearchInput } : {}),
    ...(window.FlowaveViewBoundary ? { ViewBoundary: window.FlowaveViewBoundary } : {}),
  },
  watch: watchHandlers,
  mounted: mountedHook,
  beforeUnmount: beforeUnmountHook,
  methods: {
    ...(window.FlowaveFeatureModules?.methods || {}),
    ...practiceMethods,
    ...soundMapMethods,
    ...audioEffectsMethods,
    ...playbackMethods,
    ...lyricMethods,
    ...audioDetailMethods,
    ...seedMethods,
    ...shortcutMethods,
    ...dataMethods,
    ...listeningHistoryMethods,
    ...(window.FlowaveHistoryModule?.methods || {}),
    ...playlistMethods,
    ...songInfoBatchMethods,
    ...utilityMethods,
  },
});
window.__flowaveMounted = false;
window.__flowaveStartupError = "";
if (kumikoVueApp.config) kumikoVueApp.config.errorHandler = (error, _instance, info) => {
  const message = String(error?.message || error);
  if (!window.__flowaveMounted) window.__flowaveStartupError = message;
  const item = { type: "vue", message, source: String(info || ""), stack: String(error?.stack || "") };
  window.__kumikoErrors?.push(item);
  console.error("[kumiko-vue-error]", error, info);
};
const kumikoAppVm = kumikoVueApp.mount("#app");
Object.defineProperty(window, "__kumikoApp", {
  value: kumikoAppVm,
  configurable: false,
  enumerable: false,
  writable: false,
});
