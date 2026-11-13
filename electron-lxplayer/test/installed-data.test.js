'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {resolveDataDir} = require('../data-layout');
const {ResourceManager, revision} = require('../resource-manager');

test('installed and portable data use explicitly selected workspace roots', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowave-selection-'));
  t.after(() => fs.rmSync(temp, {recursive:true, force:true}));
  const root = path.join(temp, 'program');
  const local = path.join(temp, 'local');
  const external = path.join(temp, '自选数据目录');
  assert.throws(() => resolveDataDir(root, {mode:'installed', localAppData:local}), /尚未选择/);
  fs.mkdirSync(path.join(local, 'Flowave'), {recursive:true});
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(local, 'Flowave/data-location.txt'), '\ufeff' + external, 'utf8');
  assert.equal(resolveDataDir(root, {mode:'installed', localAppData:local}), external);
  assert.equal(resolveDataDir(root, {mode:'installed', raw:external}), external);
  assert.throws(() => resolveDataDir(root, {mode:'installed', raw:path.join(root,'data')}), /安装目录之外/);
  assert.equal(resolveDataDir(root, {mode:'portable', raw:external}), external);
  assert.equal(resolveDataDir(root, {mode:'portable', raw:path.join(root,'..cache')}), path.join(root,'..cache'));
  fs.renameSync(external, external + '-offline');
  assert.throws(() => resolveDataDir(root, {mode:'installed', localAppData:local}), /不可用/);
  assert.equal(fs.existsSync(path.join(local,'Flowave/data')), false);
});

test('Python and Electron resolve the same installed, portable and explicit data roots', t => {
  const repo = path.resolve(__dirname, '../..');
  const python = path.join(repo,'build/backend-venv/Scripts/python.exe');
  if (!fs.existsSync(python)) return t.skip('Pinned backend build environment is unavailable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'flowave-data-'));
  t.after(() => fs.rmSync(temp,{recursive:true,force:true}));
  const root = path.join(temp,'程序 with spaces');
  const local = path.join(temp,'user-local');
  const external = path.join(temp,'user data');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(local, 'Flowave'), {recursive:true});
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(local, 'Flowave/data-location.txt'), '\ufeff' + external, 'utf8');
  for (const mode of ['portable','installed']) {
    fs.writeFileSync(path.join(root,'distribution.json'),JSON.stringify({mode}));
    if (mode === 'portable') {
      fs.mkdirSync(path.join(root, 'workspace'));
      fs.writeFileSync(path.join(root, 'workspace-location.txt'), './workspace');
    }
    for (const raw of ['', external, 'relative', path.join(root,'data')]) {
      let expected;
      try { expected=resolveDataDir(root,{mode,raw,localAppData:local}); } catch { expected='rejected'; }
      const code = 'import sys;from pathlib import Path;from runtime_paths import resolve_data_dir\ntry: print(resolve_data_dir(Path(sys.argv[1]),sys.argv[2],sys.argv[3]))\nexcept ValueError: print("rejected")';
      const actual = execFileSync(python,['-c',code,root,raw,local],{cwd:repo,encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}}).trim();
      assert.equal(actual, expected, mode + ' / ' + raw);
    }
  }
});

test('installer copies and verifies old data before publishing the location and refuses unknown contents', t => {
  if (process.platform !== 'win32') return t.skip('Windows installer helper');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowave-relocation-'));
  t.after(() => fs.rmSync(temp, {recursive:true, force:true}));
  const repo = path.resolve(__dirname, '../..');
  const local = path.join(temp, 'local'), legacy = path.join(local, 'Flowave/data');
  const target = path.join(temp, '新数据 with spaces'), program = path.join(temp, 'program');
  fs.mkdirSync(path.join(legacy, 'config'), {recursive:true});
  fs.mkdirSync(path.join(legacy, 'library/stems'), {recursive:true});
  fs.writeFileSync(path.join(legacy, 'config/listening_history.json'), '{"listening":true}');
  fs.writeFileSync(path.join(legacy, 'library/stems/track.bin'), Buffer.alloc(4000, 7));
  const pointer = path.join(local, 'Flowave/data-location.txt');
  const shell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const run = (action, destination = target, mode = 'Copy') => execFileSync(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(repo, 'packaging/windows/data-location.ps1'), '-Action', action, '-DataDir', destination, '-InstallDir', program, '-DataMode', mode],
  {env:{...process.env, LOCALAPPDATA:local}, windowsHide:true, stdio:'pipe', encoding:'utf8'});
  run('Prepare');
  assert.equal(fs.existsSync(pointer), false);
  assert.deepEqual(fs.readFileSync(path.join(target, 'library/stems/track.bin')), fs.readFileSync(path.join(legacy, 'library/stems/track.bin')));
  run('Commit');
  assert.equal(resolveDataDir(program, {mode:'installed', localAppData:local}), target);
  assert.equal(fs.readFileSync(path.join(legacy, 'config/listening_history.json'), 'utf8'), '{"listening":true}');
  run('Prepare', target, 'Existing');
  run('Commit', target, 'Existing');
  const unknown = path.join(temp, 'unknown');
  fs.mkdirSync(unknown);
  fs.writeFileSync(path.join(unknown, 'keep.txt'), 'keep');
  assert.throws(() => run('Prepare', unknown));
  assert.equal(fs.readFileSync(path.join(unknown, 'keep.txt'), 'utf8'), 'keep');
  assert.equal(resolveDataDir(program, {mode:'installed', localAppData:local}), target);
  assert.throws(() => run('Prepare', path.join(program, 'data')));
});

test('new installation uses an empty workspace despite old data and an unavailable saved location', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowave-fresh-install-'));
  t.after(() => fs.rmSync(temp, {recursive:true, force:true}));
  const repo = path.resolve(__dirname, '../..');
  const local = path.join(temp, 'local'), legacy = path.join(local, 'Flowave/data');
  const pointer = path.join(local, 'Flowave/data-location.txt');
  const program = path.join(temp, 'program'), target = path.join(temp, '全新工作区');
  fs.mkdirSync(path.join(legacy, 'config'), {recursive:true});
  fs.writeFileSync(path.join(legacy, 'config/old.json'), 'old settings');
  fs.writeFileSync(pointer, path.join(temp, 'unavailable-disk'));
  const run = (action, destination=target, mode='New') => execFileSync('powershell.exe', [
    '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(repo,'packaging/windows/data-location.ps1'),
    '-Action',action,'-DataDir',destination,'-InstallDir',program,'-DataMode',mode,
  ], {env:{...process.env,LOCALAPPDATA:local},windowsHide:true,encoding:'utf8',stdio:'pipe'});
  run('Prepare');
  assert.equal(fs.readFileSync(pointer,'utf8'),path.join(temp,'unavailable-disk'));
  assert.deepEqual(fs.readdirSync(target),['.flowave-data.json']);
  run('Commit');
  assert.equal(fs.readFileSync(pointer,'utf8').replace(/^\uFEFF/,''),target);
  assert.equal(fs.readFileSync(path.join(legacy,'config/old.json'),'utf8'),'old settings');
  const unfinished = path.join(temp, 'interrupted');
  run('Prepare',unfinished);
  fs.writeFileSync(path.join(unfinished,'unexpected.txt'),'external data');
  assert.throws(()=>run('Commit',unfinished));
  assert.throws(()=>run('Prepare',unfinished));
  assert.throws(()=>run('Prepare',legacy));
  assert.equal(fs.readFileSync(pointer,'utf8').replace(/^\uFEFF/,''),target);
});

test('installed resource readiness reads the external data root', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'flowave-resources-data-'));
  t.after(() => fs.rmSync(temp,{recursive:true,force:true}));
  const root=path.join(temp,'program'), dataDir=path.join(temp,'data');
  const group={name:'model',files:[{bytes:1}]};
  fs.mkdirSync(path.join(root,'resources'),{recursive:true});
  fs.writeFileSync(path.join(root,'resources/catalog.json'), JSON.stringify({groups:{model:group},profiles:{},modules:{analysis:{groups:['model']}}}));
  const folder=path.join(dataDir,'components/resources/assets/model',revision(group).slice(0,16));
  fs.mkdirSync(folder,{recursive:true});
  fs.writeFileSync(path.join(folder,'.ready.json'),JSON.stringify({revision:revision(group)}));
  assert.equal(new ResourceManager(root,{dataDir}).snapshot().analysis.ready,true);
  assert.equal(fs.existsSync(path.join(root,'data')),false);
});
