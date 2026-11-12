'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const script = path.resolve(__dirname, '../../packaging/windows/uninstall-data.ps1');

function fixture(t, empty = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'flowave-uninstall-'));
  // Fixtures contain only files created by this check. Leave them for inspection.
  const data = path.join(base, '音乐 工作区'), program = path.join(base, 'program'), local = path.join(base, 'local');
  const write = (name, body='retained') => {const file=path.join(data,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,body);return file;};
  write('.flowave-workspace.json', JSON.stringify({application:'Flowave',schema:1,hostApi:1}));
  const files = empty ? [] : ['config/app.json','library/listening/history.json','library/listening-traces/trace.json',
    'library/tracks.json','library/tracks.json.previous','library/track-analysis/analysis.sqlite3',
    'library/stems/vocals.opus','library/practice-analysis/result.sqlite3','components/resources/model.bin',
    'packages/official/registry.json','cache/download.bin','logs/worker.log','electron/session',
    'downloads/music.mp3','my-own-file.txt'];
  for(const file of files)write(file);
  fs.mkdirSync(path.join(local,'Flowave'),{recursive:true});
  fs.writeFileSync(path.join(local,'Flowave/data-location.txt'),data);
  fs.writeFileSync(path.join(local,'Flowave/workspace-history.json'),'{}');
  const run = (action,groups='',extra=[]) => {
    const child=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,
      '-Action',action,'-DataDir',data,'-InstallDir',program,'-Groups',groups,...extra],
      {env:{...process.env,LOCALAPPDATA:local},windowsHide:true,encoding:'utf8'});
    let result;try{result=JSON.parse(child.stdout.replace(/^\uFEFF/,''));}catch{throw Error(child.stdout+'\n'+child.stderr);}
    return {code:child.status,...result};
  };
  return {base,data,program,local,write,files,run};
}

test('uninstall planning is read-only and default removal preserves all workspace files', t => {
  const {data,files,run}=fixture(t);
  assert.equal(run('Plan','temporary').ok,true);
  assert.equal(run('Remove').ok,true);
  for(const file of files)assert.equal(fs.readFileSync(path.join(data,file),'utf8'),'retained');
});

test('selected cache and resources are removed while personal data, results, music and unknown files remain', t => {
  const {data,run}=fixture(t);
  const result=run('Remove','temporary,resources');
  assert.equal(result.ok,true,JSON.stringify(result));
  for(const name of ['cache','logs','electron','components','packages'])assert.equal(fs.existsSync(path.join(data,name)),false);
  for(const name of ['config/app.json','library/tracks.json','library/listening/history.json','downloads/music.mp3','my-own-file.txt'])
    assert.equal(fs.existsSync(path.join(data,name)),true);
});

test('selected results do not remove listening history and unsupported selections leave all data intact', t => {
  const {data,run}=fixture(t);
  assert.equal(run('Remove','anything').code,45);
  assert.equal(fs.existsSync(path.join(data,'library/tracks.json')),true);
  assert.equal(run('Remove','results').ok,true);
  assert.equal(fs.existsSync(path.join(data,'library/tracks.json.previous')),false);
  assert.equal(fs.existsSync(path.join(data,'library/listening/history.json')),true);
});

test('forgetting location records is explicit and keeps workspace downloads and unknown content', t => {
  const {data,local,run}=fixture(t);
  assert.equal(run('Remove','personal,results,resources,temporary',['-ForgetLocations']).ok,true);
  assert.equal(fs.existsSync(path.join(local,'Flowave')),false);
  assert.equal(fs.existsSync(path.join(data,'downloads/music.mp3')),true);
  assert.equal(fs.existsSync(path.join(data,'my-own-file.txt')),true);
});

test('a reparse point prevents the entire selected cleanup before the first removal', t => {
  const {base,data,run}=fixture(t);
  const outside=path.join(base,'outside');fs.mkdirSync(outside);fs.writeFileSync(path.join(outside,'keep'),'safe');
  fs.symlinkSync(outside,path.join(data,'cache/link'),'junction');
  assert.equal(run('Remove','temporary,resources').code,45);
  assert.equal(fs.existsSync(path.join(data,'components/resources/model.bin')),true);
  assert.equal(fs.readFileSync(path.join(outside,'keep'),'utf8'),'safe');
});

test('an emptied workspace stays reopenable while locations are retained, and explicit full removal leaves no empty root', t => {
  const {data,local,run}=fixture(t,true);
  assert.equal(run('Remove','personal,results,resources,temporary').ok,true);
  assert.equal(fs.existsSync(path.join(data,'.flowave-workspace.json')),true);
  assert.equal(fs.existsSync(path.join(local,'Flowave/data-location.txt')),true);
  assert.equal(run('Remove','personal,results,resources,temporary',['-ForgetLocations']).ok,true);
  assert.equal(fs.existsSync(data),false);
  assert.equal(fs.existsSync(path.join(local,'Flowave')),false);
});
