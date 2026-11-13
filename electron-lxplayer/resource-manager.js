'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn} = require('node:child_process');
const ordered = value => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const revision = value => crypto.createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');

// The module installer owns the transaction; this object owns only its child.
class ResourceManager {
  constructor(root, {spawnProcess = spawn, dataDir = path.join(root, 'data')} = {}) {
    this.root = root; this.dataDir = dataDir; this.spawnProcess = spawnProcess; this.operation = null; this.last = {};
  }
  catalog() { return JSON.parse(fs.readFileSync(path.join(this.root, 'resources/catalog.json'), 'utf8')); }
  ready(kind, id, item) {
    try {
      const folder = path.join(this.dataDir, 'components/resources', kind, id, revision(item).slice(0,16));
      return JSON.parse(fs.readFileSync(path.join(folder, '.ready.json'), 'utf8')).revision === revision(item);
    } catch { return false; }
  }
  snapshot() {
    let data;
    try { data = this.catalog(); } catch { return {}; }
    return Object.fromEntries(Object.entries(data.modules).map(([id, item]) => {
      const items = [
        ...(item.profiles || []).map(key => ({id: key, name: data.profiles[key].name, ready: this.ready('runtimes', key, data.profiles[key]), bytes: 0})),
        ...(item.groups || []).map(key => ({id: key, name: data.groups[key].name, ready: this.ready('assets', key, data.groups[key]), bytes: data.groups[key].files.reduce((n, row) => n + row.bytes, 0)})),
      ];
      const progress = this.operation?.id === id ? this.operation.progress : this.last[id] || {};
      return [id, {ready: items.every(row => row.ready), items, license: item.license,
        downloadBytes: items.filter(row => !row.ready).reduce((n, row) => n + row.bytes, 0),
        ...progress, running: this.operation?.id === id}];
    }));
  }
  async prepare(id, sender, {signal, onProgress = () => {}} = {}) {
    const data = this.catalog();
    if (!Object.hasOwn(data.modules, id)) throw Error('缺少此功能的资源清单。');
    if (this.operation) throw Error('已有资源安装任务，请等待完成或先取消。');
    if (signal?.aborted) throw Error('安装已取消。');
    if (this.snapshot()[id]?.ready) { delete this.last[id]; return {ok: true}; }
    const exe = ['backend/api.exe', 'build/backend/api/api.exe'].map(file => path.join(this.root, file)).find(file => fs.existsSync(file));
    const launcher = path.join(this.root, 'backend_launcher.py');
    const python = process.env.KUMIKO_PYTHON || path.join(this.root, '.venv/Scripts/python.exe');
    if (!exe && !(fs.existsSync(launcher) && fs.existsSync(python))) throw Error('资源安装器缺失，请检查程序或开发环境。');
    const command = exe || python;
    const args = exe ? ['--install-resources', id] : ['-X', 'utf8', launcher, '--install-resources', id];
    const op = {id, progress: {phase: 'prepare'}, cancelled: false, child: null, closed: null, killing: null};
    this.operation = op;
    const send = value => {
      if (this.operation !== op) return;
      op.progress = value;
      if (!sender.isDestroyed()) sender.send('lx-resource-progress', {id, ...value, status: this.snapshot()});
      onProgress(value);
    };
    let pending = '', stderr = '';
    try {
      const child = op.child = this.spawnProcess(command, args, {
        cwd: this.root, windowsHide: true,
        env: {...process.env, KUMIKO_APP_HOME: this.root, KUMIKO_DATA_DIR: this.dataDir, PYTHONIOENCODING: 'utf-8'},
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      op.closed = new Promise(resolve => {
        let spawnError;
        child.stdout.setEncoding('utf8');
        const consume = chunk => {
          pending += chunk;
          const rows = pending.split(/\r?\n/); pending = rows.pop().slice(-8192);
          for (const row of rows) {
            let value; try { value = JSON.parse(row); } catch { continue; }
            if (value && typeof value === 'object') send(value);
          }
        };
        child.stdout.on('data', consume);
        child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
        child.on('error', error => { spawnError = error; });
        child.on('close', code => { if (pending) consume('\n'); resolve({code, error: spawnError}); });
      });
      const abort = () => { this.cancel(id).catch(() => {}); };
      signal?.addEventListener('abort', abort, {once: true});
      if (signal?.aborted) abort();
      let result;
      try { result = await op.closed; } finally { signal?.removeEventListener('abort', abort); }
      if (op.cancelled || signal?.aborted) throw Error('安装已取消，已下载的完整文件可在重试时复用。');
      if (result.code !== 0 || !this.snapshot()[id]?.ready)
        throw Error(result.error?.message || op.progress.message || stderr.slice(-1000) || '资源安装未完成，请重试。');
      this.last[id] = {phase: 'complete', message: '所需资源已就绪。'};
      return {ok: true};
    } catch (error) {
      this.last[id] = {phase: op.cancelled || signal?.aborted ? 'cancelled' : 'error', message: String(error.message || error)};
      throw error;
    } finally {
      if (this.operation === op) this.operation = null;
      if (!sender.isDestroyed()) sender.send('lx-resource-progress', {id, ...this.last[id], status: this.snapshot()});
    }
  }
  async cancel(id) {
    const op = this.operation;
    if (!op || op.id !== id) return;
    op.cancelled = true;
    if (op.child?.pid && op.child.exitCode === null && !op.killing) {
      op.killing = new Promise((resolve, reject) => {
        const killer = this.spawnProcess('taskkill.exe', ['/PID', String(op.child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
        killer.on('error', reject);
        killer.on('close', code => code === 0 ? resolve() : reject(Error('无法停止资源进程，请等待当前任务退出。')));
      });
    }
    if (op.killing) await op.killing;
    await op.closed;
  }
  async close() { if (this.operation) await this.cancel(this.operation.id); }
}
module.exports = {ResourceManager, revision};
