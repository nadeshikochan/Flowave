'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash, randomUUID} = require('node:crypto');
const {locatorFile} = require('./data-layout');

const manifestName = '.flowave-workspace.json';
const hostApi = 1;

function readJson(file, limit = 65536) {
  if (fs.statSync(file).size > limit) throw Error('工作区描述文件过大，请核对目录。');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temporary = file + '.' + randomUUID() + '.tmp';
  let handle;
  try {
    handle = fs.openSync(temporary, 'wx');
    fs.writeFileSync(handle, text, 'utf8');
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = undefined;
    fs.renameSync(temporary, file);
  } finally {
    if (handle !== undefined) fs.closeSync(handle);
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return !relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

function restartArguments(argv, directory) {
  return [...argv.slice(1).filter(value => !value.startsWith('--flowave-workspace=')),
    '--flowave-workspace=' + encodeURIComponent(directory)];
}

class WorkspaceStore {
  constructor({appHome, mode, version, localAppData = process.env.LOCALAPPDATA}) {
    this.home = path.resolve(appHome);
    this.mode = mode;
    this.version = version;
    this.pointer = locatorFile(this.home, {mode, localAppData});
    this.history = path.join(path.dirname(this.pointer), 'workspace-history.json');
  }

  describe(directory, {allowUnmarked = false} = {}) {
    if (!path.isAbsolute(directory)) throw Error('请选择完整的工作区文件夹。');
    if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory())
      throw Error('工作区目录不可用，请连接原磁盘或选择其他工作区。');
    const resolved = fs.realpathSync(directory);
    if (inside(resolved, this.home) || (this.mode === 'installed' && inside(this.home, resolved)))
      throw Error('工作区须与程序安装目录分开。');
    const manifest = path.join(resolved, manifestName);
    if (fs.existsSync(manifest)) {
      let value;
      try { value = readJson(manifest); } catch { throw Error('工作区描述文件损坏，请保留原文件并恢复备份。'); }
      if (value.application !== 'Flowave' || value.schema !== 1 || !Number.isInteger(value.hostApi) || value.hostApi < 1)
        throw Error('无法识别该工作区格式，请使用兼容的 Flowave 版本。');
      if (value.hostApi > hostApi) throw Error('该工作区需要更新版本的 Flowave，请先更新软件。');
    } else if (!allowUnmarked && !this.legacy(resolved)) {
      throw Error('该文件夹包含的内容无法识别为 Flowave 工作区。请选择软件数据文件夹，或新建空工作区。');
    }
    return {path:resolved, name:path.basename(resolved), id:this.key(resolved)};
  }

  legacy(directory) {
    try {
      const selection = readJson(path.join(directory, 'config/features.json'));
      if (selection.schema === 1 && selection.enabled && typeof selection.enabled.recommendation === 'boolean') return true;
    } catch {}
    try {
      const config = readJson(path.join(directory, 'config/app.json'));
      if (config.model && config.similarity && typeof config.audio_dir === 'string') return true;
    } catch {}
    try {
      const receipt = readJson(path.join(directory, '.flowave-data.json'));
      return receipt.state === 'prepared' && typeof receipt.anchor === 'string';
    } catch { return false; }
  }

  assertSeparate(directory, current) {
    if (this.key(directory) !== this.key(current) && (inside(directory, current) || inside(current, directory)))
      throw Error('工作区目录不能互相包含，请选择独立文件夹。');
  }

  create(directory, current) {
    if (!path.isAbsolute(directory)) throw Error('请选择完整的工作区文件夹。');
    const target = fs.existsSync(directory) ? fs.realpathSync(directory) : path.resolve(directory);
    if (current) this.assertSeparate(target, current);
    if (inside(target, this.home) || (this.mode === 'installed' && inside(this.home, target)))
      throw Error('工作区须与程序安装目录分开。');
    if (fs.existsSync(target) && (!fs.statSync(target).isDirectory() || fs.lstatSync(target).isSymbolicLink() || fs.readdirSync(target).length))
      throw Error('新工作区需要空文件夹，已有内容会保留。');
    fs.mkdirSync(target, {recursive:true});
    this.adopt(target, false);
    return this.describe(target);
  }

  adopt(directory, legacyImport = true) {
    const file = path.join(directory, manifestName);
    if (!fs.existsSync(file)) writeAtomic(file, JSON.stringify({application:'Flowave', schema:1, hostApi, createdWith:this.version, legacyImport}));
  }

  encode(directory) {
    return this.mode !== 'installed' && inside(this.home, directory) ? './' + path.relative(this.home, directory) : directory;
  }

  decode(directory) {
    if (typeof directory !== 'string' || !directory) throw Error('最近工作区记录损坏。');
    if (this.mode === 'installed' && !path.isAbsolute(directory)) throw Error('最近工作区记录损坏。');
    return path.resolve(this.home, directory);
  }

  key(directory) {
    const encoded = this.encode(directory);
    return createHash('sha256').update(process.platform === 'win32' ? encoded.toLowerCase() : encoded).digest('hex').slice(0, 24);
  }

  recent() {
    if (!fs.existsSync(this.history)) return [];
    try {
      const value = readJson(this.history);
      if (value.schema !== 1 || !Array.isArray(value.items) || value.items.length > 12) throw Error('Invalid history');
      return value.items.map(item => this.describeRecent(item));
    } catch { throw Error('最近工作区列表无法读取，原文件已保留。仍可通过“打开工作区”选择目录。'); }
  }

  describeRecent(item) {
    const directory = this.decode(item.path);
    return {path:directory, id:this.key(directory), name:path.basename(directory)};
  }

  snapshot(current) {
    let recent = [], warning = '';
    try { recent = this.recent(); } catch (error) { warning = error.message; }
    return {current:this.describe(current), recent, warning};
  }

  activate(directory, {persist = true} = {}) {
    const target = this.describe(directory);
    this.adopt(target.path);
    if (!persist) return target;
    writeAtomic(this.pointer, this.encode(target.path));
    try {
      const recent = this.recent().filter(item => item.id !== target.id);
      const items = [target, ...recent].slice(0, 12).map(item => ({path:this.encode(item.path)}));
      writeAtomic(this.history, JSON.stringify({schema:1, items}));
    } catch (error) { target.warning = error.message; }
    return target;
  }
}

module.exports = {WorkspaceStore, restartArguments};
