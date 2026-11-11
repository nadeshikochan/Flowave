'use strict';
const {app, dialog, protocol} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {WorkspaceStore, restartArguments} = require('./workspaces');
const {resolveDataDir, locatorFile} = require('./data-layout');
require('./secure-protocols').registerPrivilegedSchemes(protocol);

const home = path.resolve(process.env.KUMIKO_APP_HOME || (app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..')));
let distribution = {};
try { distribution = JSON.parse(fs.readFileSync(path.join(home, 'distribution.json'), 'utf8')); } catch {}
const store = new WorkspaceStore({appHome:home, mode:distribution.mode, version:app.getVersion()});
const argument = process.argv.find(value => value.startsWith('--flowave-workspace='));

async function recover(error) {
  await app.whenReady();
  while (true) {
    const choice = await dialog.showMessageBox({type:'error', title:'无法打开工作区', message:error.message,
      detail:'原目录和位置记录保留。可以连接原磁盘后重试，或选择其他工作区。', buttons:['打开其他工作区', '新建工作区', '退出'], defaultId:2, cancelId:2});
    if (choice.response === 2) break;
    const create = choice.response === 1;
    const picked = await dialog.showOpenDialog({title:create ? '为新工作区选择空文件夹' : '打开 Flowave 工作区',
      properties:create ? ['openDirectory', 'createDirectory'] : ['openDirectory']});
    if (picked.canceled) break;
    try {
      const target = create ? store.create(picked.filePaths[0]) : store.describe(picked.filePaths[0]);
      app.relaunch({args:restartArguments(process.argv, target.path)});
      break;
    } catch (failure) { error = failure; }
  }
  app.exit(0);
}

try {
  const raw = process.env.KUMIKO_DATA_DIR || '';
  const directory = argument ? decodeURIComponent(argument.slice('--flowave-workspace='.length))
    : resolveDataDir(home, {mode:distribution.mode, raw});
  const unmarked = !argument && !fs.existsSync(path.join(directory, '.flowave-workspace.json'))
    && (!!raw || !fs.existsSync(locatorFile(home, {mode:distribution.mode})));
  const freshOverride = unmarked && !!raw && (!fs.existsSync(directory) || fs.readdirSync(directory).length === 0);
  if (unmarked) fs.mkdirSync(directory, {recursive:true});
  const target = store.describe(directory, {allowUnmarked:unmarked});
  for (const folder of ['electron', 'cache/electron-session', 'logs/crashes']) fs.mkdirSync(path.join(target.path, folder), {recursive:true});
  app.setPath('userData', path.join(target.path, 'electron'));
  app.setPath('sessionData', path.join(target.path, 'cache/electron-session'));
  app.setPath('crashDumps', path.join(target.path, 'logs/crashes'));
  if (!app.requestSingleInstanceLock()) {
    app.quit();
  } else {
    if (unmarked) store.adopt(target.path, !freshOverride);
    store.activate(target.path, {persist:false});
    process.env.FLOWAVE_WORKSPACE_PERSIST = argument || !raw ? '1' : '0';
    process.env.KUMIKO_APP_HOME = home;
    process.env.KUMIKO_DATA_DIR = target.path;
    require('./main');
  }
} catch (error) {
  recover(error).catch(failure => { dialog.showErrorBox('无法打开工作区', String(failure.message || failure)); app.exit(1); });
}
