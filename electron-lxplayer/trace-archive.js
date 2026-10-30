const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const LEGACY_KEY = 'lx-sound-map-trace';
const HOT_KEY = 'lx-sound-map-hot';
const OUTBOX_KEY = 'lx-sound-map-outbox';
const META_KEY = '__flowaveTraceArchive';
const validId = id => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id);

// Main owns the read pointer and renderer-state fence. Python owns only disposable views.
function createTraceArchive({directory, getState, setState, saveState, flushState, journal, request}) {
  const manifestPath = path.join(directory, 'archive.json');
  let manifest = {schema: 1, active: null, staging: null}, failure = '', pending = null, pendingAction = '', fenced = false, rollingBack = false;
  try {
    const value = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (value.schema !== 1 || ![value.active, value.staging].every(id => id === null || validId(id))) throw new Error('Invalid trace archive pointer');
    manifest = value;
  } catch (error) { if (error.code !== 'ENOENT') failure = '轨迹读取版本异常，已保留原文件'; }
  function status() {
    return {mode: failure ? 'error' : manifest.staging ? 'building' : manifest.active ? 'cold' : 'legacy',
      migrationId: manifest.active || '', message: failure};
  }
  function snapshot() {
    const value = {...getState(), [META_KEY]: status()};
    if (manifest.active || manifest.staging) delete value[LEGACY_KEY];
    return value;
  }
  async function writeManifest(value) {
    await fsp.mkdir(directory, {recursive: true});
    const temp = manifestPath + '.' + randomUUID() + '.tmp';
    let handle;
    try {
      handle = await fsp.open(temp, 'wx');
      await handle.writeFile(JSON.stringify(value)); await handle.sync(); await handle.close(); handle = null;
      await fsp.rename(temp, manifestPath);
      manifest = value;
    } finally { if (handle) await handle.close(); await fsp.unlink(temp).catch(() => {}); }
  }
  function exclusive(action, fn) {
    if (pending) return pendingAction === action ? pending : Promise.reject(new Error('轨迹正在执行其他维护操作，请稍后重试'));
    pendingAction = action;
    pending = Promise.resolve().then(fn).finally(() => { pending = null; pendingAction = ''; });
    return pending;
  }
  async function checkedSave() {
    const saved = await saveState();
    if (saved?.ok === false) throw new Error(saved.error || '轨迹状态保存失败');
  }
  async function prepare(legacyJson) {
    if (failure) throw new Error(failure);
    if (!manifest.staging && !manifest.active) {
      fenced = true;
      try {
        await flushState();
        const raw = getState()[LEGACY_KEY] ?? legacyJson ?? '[]';
        if (typeof raw !== 'string' || Buffer.byteLength(raw) > 64 * 1024 * 1024) throw new Error('旧轨迹快照无效');
        const watermarks = await journal.frontier();
        const id = randomUUID().replaceAll('-', '');
        await request({action: 'begin', migrationId: id, legacyJson: raw, watermarks});
        await writeManifest({...manifest, staging: id});
      } finally { fenced = false; }
    }
    if (manifest.staging) {
      const result = await request({action: 'prepare', migrationId: manifest.staging});
      if (result.status !== 'ready') return {...status(), progress: result};
      // Pointer is durable before the old config field can be removed. A crash in
      // between is safe: snapshot() already filters it and writes remain fenced.
      await writeManifest({schema: 1, active: manifest.staging, staging: null});
    } else if (manifest.active) {
      // A pointer alone proves no view/source integrity. Never remove a retained
      // legacy field when the selected view is missing, corrupt or still catching up.
      const result = await request({action: 'prepare', migrationId: manifest.active});
      if (result.status !== 'ready') return {...status(), mode:'building', progress:result};
    }
    const state = getState();
    if (Object.hasOwn(state, LEGACY_KEY)) {
      const next = {...state}; delete next[LEGACY_KEY]; setState(next); await checkedSave();
    }
    return status();
  }
  async function read(action, payload) {
    if (failure || !manifest.active || manifest.staging) throw new Error(failure || '轨迹正在整理，请稍后重试');
    await journal.flush();
    const migrationId = manifest.active;
    const result = await request({action, migrationId, ...payload});
    if (migrationId !== manifest.active || manifest.staging) throw new Error('轨迹读取版本已变化，请重试');
    return {...(result || {}), migrationId};
  }
  return {
    status, snapshot,
    get blocksLegacy() { return !!(failure || fenced || manifest.active || manifest.staging); },
    get blocksAppend() { return rollingBack; },
    // The durable hot snapshot and its retry queue are committed together BEFORE
    // append. A crash cannot leave a persisted event sequence ahead of hot state.
    async saveHot({rows, outbox}) {
      if (!Array.isArray(rows) || rows.length > 12 || !Array.isArray(outbox)) throw new Error('轨迹热状态格式无效');
      const hot = JSON.stringify(rows), retry = JSON.stringify(outbox);
      if (Buffer.byteLength(hot) > 512 * 1024 || Buffer.byteLength(retry) > 64 * 1024 * 1024) throw new Error('轨迹热状态过大');
      if (rows.some(row => !row || typeof row.attemptId !== 'string' || typeof row.path !== 'string')) throw new Error('轨迹热状态缺少标识');
      setState({...getState(), [HOT_KEY]: hot, [OUTBOX_KEY]: retry});
      await checkedSave(); return {ok: true};
    },
    prepare: raw => exclusive('prepare', () => prepare(raw)),
    routes: payload => read('routes', {limit: 100, beforeOrder: payload?.beforeOrder ?? null}),
    route: payload => read('route', {traceId: payload?.traceId}),
    attempt: payload => read('attempt', {attemptId: payload?.attemptId}),
    rebuild: () => exclusive('rebuild', async () => {
      if (failure || !manifest.active || manifest.staging) throw new Error(failure || '轨迹仍在整理');
      const id = randomUUID().replaceAll('-', '');
      await journal.flush();
      await request({action: 'rebuild', migrationId: id, previousId: manifest.active});
      await writeManifest({...manifest, staging: id});
      return status();
    }),
    rollback: () => exclusive('rollback', async () => {
      if (failure || !manifest.active || manifest.staging) throw new Error(failure || '轨迹尚未准备好');
      fenced = true; rollingBack = true;
      try {
        await journal.flush();
        const rows = await request({action: 'export', migrationId: manifest.active});
        if (!Array.isArray(rows)) throw new Error('轨迹导出格式无效');
        // Merge the CURRENT preferences; never restore the old whole config.
        setState({...getState(), [LEGACY_KEY]: JSON.stringify(rows)}); await checkedSave(); await flushState();
        await writeManifest({schema: 1, active: null, staging: null});
        return {ok: true, rows};
      } finally { fenced = false; rollingBack = false; }
    }),
    async flush() { if (pending) await pending; await journal.flush(); await flushState(); },
  };
}
module.exports = {createTraceArchive, LEGACY_KEY, HOT_KEY, META_KEY};
