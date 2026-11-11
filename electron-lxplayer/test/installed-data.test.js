'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {resolveDataDir} = require('../data-layout');
const {ResourceManager, revision} = require('../resource-manager');

test('installed data stays outside program files and portable overrides remain contained', () => {
  const root = path.resolve(os.tmpdir(), 'Flowave-program');
  const local = path.resolve(os.tmpdir(), 'Flowave-local');
  const external = path.resolve(os.tmpdir(), 'Flowave-saved-data');
  assert.equal(resolveDataDir(root, {mode:'installed', localAppData:local}), path.join(local,'Flowave/data'));
  assert.equal(resolveDataDir(root, {mode:'installed', raw:external}), external);
  assert.throws(() => resolveDataDir(root, {mode:'installed', raw:path.join(root,'data')}), /安装目录之外/);
  assert.equal(resolveDataDir(root, {mode:'portable', raw:external}), path.join(root,'data'));
  assert.equal(resolveDataDir(root, {mode:'portable', raw:path.join(root,'..cache')}), path.join(root,'..cache'));
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
  for (const mode of ['portable','installed']) {
    fs.writeFileSync(path.join(root,'distribution.json'),JSON.stringify({mode}));
    for (const raw of ['', external, 'relative', path.join(root,'data')]) {
      let expected;
      try { expected=resolveDataDir(root,{mode,raw,localAppData:local}); } catch { expected='rejected'; }
      const code = 'import sys;from pathlib import Path;from runtime_paths import resolve_data_dir\ntry: print(resolve_data_dir(Path(sys.argv[1]),sys.argv[2],sys.argv[3]))\nexcept ValueError: print("rejected")';
      const actual = execFileSync(python,['-c',code,root,raw,local],{cwd:repo,encoding:'utf8',windowsHide:true,env:{...process.env,PYTHONIOENCODING:'utf-8'}}).trim();
      assert.equal(actual, expected, mode + ' / ' + raw);
    }
  }
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
