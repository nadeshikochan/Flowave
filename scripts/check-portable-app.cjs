// Real packaged Electron/API, isolated generated distribution only. No mocks,
// no host Python, no existing user profile, and no automatic music processing.
const fs = require('node:fs'), path = require('node:path'), net = require('node:net');
const {spawn, spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '..');
const folder = path.resolve(process.argv[2] || '');
const withResources = process.argv.includes('--resources');
const installed = process.argv.includes('--installed');
const fixtureRoot = path.join(repo, 'build/installer-check') + path.sep;
const defaultData = installed && process.argv.includes('--default-data');
const localAppData = installed ? path.join(path.dirname(folder),'local-app-data') : process.env.LOCALAPPDATA;
const dataFolder = defaultData
  ? fs.readFileSync(path.join(localAppData, 'Flowave/data-location.txt'), 'utf8').replace(/^\uFEFF/, '').trim()
  : installed ? path.join(path.dirname(folder), 'profile') : path.join(folder,'data');
const validFolder = installed
  ? folder.startsWith(fixtureRoot) && path.basename(folder) === 'Flowave'
  : folder.startsWith(path.join(repo, 'electron-lxplayer/dist/portable-')) && path.basename(folder) === 'win-unpacked';
if (!validFolder)
  throw Error('Pass an isolated portable build/win-unpacked directory.');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const owned = new Set();
if(withResources){
  // Reuse only bytes downloaded by this delivery check. The packaged installer
  // must still verify, extract and publish every resource in its own profile.
  const source=path.join(repo,'data/cache/resource-downloads'),cache=path.join(dataFolder,'cache/resource-downloads');
  fs.mkdirSync(cache,{recursive:true});
  for(const item of fs.readdirSync(source,{withFileTypes:true}))if(item.isFile()&&/^[a-f0-9]{64}$/.test(item.name)){
    const dest=path.join(cache,item.name);if(!fs.existsSync(dest))fs.linkSync(path.join(source,item.name),dest);
  }
}
const port = () => new Promise((resolve, reject) => {
  const server = net.createServer(); server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
});
async function open() {
  const debug = await port(), backend = await port();
  const out = fs.createWriteStream(path.join(repo, 'build/portable-delivery/app-check.log'), {flags: 'a'});
  // A hidden native window can suspend the splash's CSS exit transition.
  const child = spawn(path.join(folder, 'Flowave.exe'), ['--remote-debugging-port=' + debug], {
    cwd: folder, windowsHide: false, env: {...process.env, LOCALAPPDATA:localAppData, KUMIKO_APP_HOME: defaultData ? undefined : folder, KUMIKO_DATA_DIR:defaultData ? undefined : dataFolder, KUMIKO_BACKEND_PORT: String(backend)},
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  owned.add(child);
  child.stdout.pipe(out, {end: false}); child.stderr.pipe(out, {end: false});
  let exit, error; const closed = new Promise(resolve => { child.on('close', code => { owned.delete(child); exit = code; out.end(); resolve(); }); });
  child.on('error', value => { error = value; });
  let targets;
  for (let i = 0; i < 150; i++) {
    if (error || exit !== undefined) throw error || Error('App exited before opening its page: ' + exit);
    try { targets = await (await fetch(`http://127.0.0.1:${debug}/json/list`, {signal: AbortSignal.timeout(1000)})).json(); } catch {}
    if (targets?.some(row => row.type === 'page')) break;
    await sleep(200);
  }
  const target = targets?.find(row => row.type === 'page'); assert(target, 'No real renderer page');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  let sequence = 0; const pending = new Map(), errors = [];
  ws.onmessage = event => {
    const value = JSON.parse(event.data);
    if (value.id) { const job = pending.get(value.id); if (job) { clearTimeout(job.timer); job.resolve(value); pending.delete(value.id); } }
    else if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails.text);
    else if(value.method==='Runtime.consoleAPICalled')for(const arg of value.params.args||[])if(typeof arg.value==='string'&&arg.value.startsWith('INSTALL_PROGRESS '))console.log(arg.value);
  };
  const call = (method, params = {}, timeoutMs=60000) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Timed out: ' + method)); }, timeoutMs);
    pending.set(id, {resolve, timer}); ws.send(JSON.stringify({id, method, params}));
  });
  const evaluate = async (expression,timeoutMs) => {
    const value = await call('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true},timeoutMs);
    if (value.error || value.result?.exceptionDetails) throw Error(JSON.stringify(value.error || value.result.exceptionDetails));
    return value.result.result.value;
  };
  await call('Runtime.enable');
  for (let i = 0; i < 100; i++) {
    if (await evaluate('window.__flowaveMounted===true')) break;
    await sleep(200);
  }
  assert.equal(await evaluate('window.__flowaveMounted===true'), true, 'Mounted hook did not complete');
  assert.deepEqual(await evaluate('window.FlowaveFeatureModules.failures'),{},'A selected module fell back to the base interface');
  assert.deepEqual(await evaluate('window.__kumikoErrors||[]'),[],'Renderer recorded an initialization error');
  for (let i = 0; i < 40; i++) {
    if (await evaluate('!window.__kumikoApp.startupSplashVisible && !document.querySelector(".startup-splash")')) break;
    await sleep(200);
  }
  assert.equal(await evaluate('!window.__kumikoApp.startupSplashVisible && !document.querySelector(".startup-splash")'), true, 'Splash did not close');
  const health = await evaluate("(async () => (await axios.get(window.__kumikoApp.baseUrl + '/health')).data)()");
  assert.equal(health.access_required, true, 'Backend request admission is missing');
  assert.equal(path.resolve(health.data_dir), dataFolder, 'Backend used another profile');
  const close = async () => {
    try {
      await evaluate("window.lxEnv.windowControl('close')");
      await Promise.race([closed, sleep(15000).then(() => { if (exit === undefined) throw Error('App did not finish saving and exit'); })]);
    } finally {
      ws.close(); for (const job of pending.values()) clearTimeout(job.timer); pending.clear();
      if (exit === undefined) await new Promise(resolve => {
        const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
        killer.on('close', resolve); killer.on('error', resolve);
      });
    }
  };
  return {evaluate, call, close, errors};
}
(async () => {
  let app = await open();
  const installerArgument = process.argv.find(value => value.startsWith('--installer='));
  if (installed && installerArgument) {
    const blocked = spawnSync(installerArgument.slice('--installer='.length), ['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/SP-','/CURRENTUSER','/DIR=' + folder], {windowsHide:true, timeout:30000});
    assert.equal(blocked.status,7,'Installer must ask for the running app to exit');
    assert.equal(await app.evaluate('window.__flowaveMounted===true'),true,'Installer interrupted the running player');
    console.log('PASS: installation refuses the running target and preserves its process');
  }
  if(process.argv.includes('--reopen')){
    try{
      const historyOnly = process.argv.includes('--history-only');
      const selectionCheck = historyOnly
        ? 'window.lxEnv.getFeatureSelectionSync().active.enabled.history'
        : 'Object.values(window.lxEnv.getFeatureSelectionSync().active.enabled).every(Boolean)';
      const resourceCheck = historyOnly
        ? '(async()=>(await window.lxEnv.getResourceStatus()).history.ready)()'
        : '(async()=>Object.values(await window.lxEnv.getResourceStatus()).every(row=>row.ready))()';
      assert.equal(await app.evaluate(selectionCheck), true);
      assert.equal(await app.evaluate(resourceCheck), true);
      console.log(historyOnly
        ? 'PASS: normal default profile retains the installed history plugin'
        : 'PASS: saved app loads all four plugins and their resource paths');
      assert.deepEqual(app.errors,[]);
    }finally{await app.close();}
    return;
  }
  try {
    const initial = await app.evaluate('window.lxEnv.getFeatureSelectionSync()');
    assert(Object.values(initial.active.enabled).every(value => value === false), 'Use a fresh basic profile');
    const music = path.join(dataFolder, 'fixture-music'); fs.mkdirSync(music, {recursive: true});
    const audio = Buffer.alloc(44 + 44100 * 2 * 8);
    audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
    audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
    audio.writeUInt32LE(44100, 24); audio.writeUInt32LE(88200, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
    audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
    for(let i=0;i<44100*8;i++)audio.writeInt16LE(Math.round(300*Math.sin(2*Math.PI*220*i/44100)),44+i*2);
    const track = path.join(music, 'Flowave fixture.wav'); fs.writeFileSync(track, audio);
    assert.equal(await app.evaluate(`(async()=>{const app=window.__kumikoApp;app.audioDirectoriesDraft=[${JSON.stringify(music)}];return app.saveAudioDirectory();})()`), true);
    if(!withResources && !process.argv.includes('--history-only')){
      const playing = await app.evaluate(`(async()=>{const app=window.__kumikoApp;app.volume=0;await Vue.nextTick();const started=await app.playByPath(${JSON.stringify(track)});await new Promise(r=>setTimeout(r,500));const result={started,playing:app.isPlaying,time:app.currentTime,path:app.currentPath,blocked:app.outputSafetyBlocked,error:app.lastPlaybackError,reason:app.playbackPauseReason,source:app.lastPauseSource};app.pauseByManual('portable-check');return result;})()`);
      assert.equal(playing.playing, true, JSON.stringify(playing)); assert(playing.time > 0); assert.equal(playing.path, track);
      console.log('PASS: real directory scan and muted WAV playback advance the media clock');
    }
    const result = await app.evaluate("window.lxEnv.manageOfficialModule({id:'history',action:'install',revision:window.lxEnv.getFeatureSelectionSync().packages.revision})");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.selection.active.enabled.history, false);
    assert.equal(result.selection.selected.enabled.history, true);
    assert.equal(result.selection.resources.history.ready, true);
    if(withResources){
      await app.evaluate("window.fixtureProgressAt=0;window.lxEnv.onOfficialModuleProgress(value=>{if(Date.now()-window.fixtureProgressAt>5000||value.phase==='settled'){window.fixtureProgressAt=Date.now();console.info('INSTALL_PROGRESS '+JSON.stringify({id:value.id,phase:value.phase,file:value.file,done:value.done,total:value.total}));}});true");
      for(const id of ['recommendation','analysis','practice']){
        const installed=await app.evaluate(`window.lxEnv.manageOfficialModule({id:${JSON.stringify(id)},action:'install',revision:window.lxEnv.getFeatureSelectionSync().packages.revision})`,30*60*1000);
        assert.equal(installed.ok,true,installed.error);assert.equal(installed.selection.resources[id].ready,true);assert.equal(installed.selection.selected.enabled[id],true);
        console.log('PASS: packaged one-click install prepared all resources for '+id);
      }
    }
    await app.evaluate("window.__kumikoApp.view='settings';window.__kumikoApp.openSettingsSection('features')");
    const shot = await app.call('Page.captureScreenshot', {format: 'png'});
    fs.writeFileSync(path.join(repo, 'build/portable-delivery/feature-install.png'), Buffer.from(shot.result.data, 'base64'));
    assert.deepEqual(app.errors, []);
    console.log('PASS: real packaged base startup and one-click history installation');
  } finally { await app.close(); }
  const migratedCover = path.join(dataFolder, 'cache/metadata/covers/migrated-cover.png');
  fs.copyFileSync(path.join(repo, 'electron-lxplayer/renderer/assets/app-icon.png'), migratedCover);
  const metadataFile = path.join(dataFolder, 'cache/metadata/metadata_cache.json');
  const cached = JSON.parse(fs.readFileSync(metadataFile, 'utf8'));
  const fixtureTrack = path.join(dataFolder, 'fixture-music/Flowave fixture.wav');
  const metadata = Object.values(cached.entries).find(row => row.path === fixtureTrack);
  assert(metadata, 'The real metadata cache did not persist before moving covers');
  const oldCover = path.join(path.dirname(dataFolder), 'old workspace/data/cache/metadata/covers/migrated-cover.png');
  metadata.cover = metadata.cover_thumb = 'kumiko-media://local/' + encodeURIComponent(oldCover);
  fs.writeFileSync(metadataFile, JSON.stringify(cached));
  app = await open();
  try {
    assert.equal(await app.evaluate('window.lxEnv.getFeatureSelectionSync().active.enabled.history'), true);
    const coverResult = await app.evaluate(`(async()=>{
      const info=await window.lxEnv.getSongInfo(${JSON.stringify(fixtureTrack)},{includeLyrics:false});
      const width=await new Promise(resolve=>{const image=new Image();image.onload=()=>resolve(image.naturalWidth);image.onerror=()=>resolve(0);image.src=info.cover;});
      return {url:info.cover,width};
    })()`);
    assert(coverResult.url.includes(encodeURIComponent(migratedCover)), JSON.stringify(coverResult));
    assert(coverResult.width > 0, 'The migrated cover failed to decode in the real renderer');
    console.log('PASS: encoded migrated cover resolves and displays through the actual media protocol');
    if(withResources)assert.equal(await app.evaluate('Object.values(window.lxEnv.getFeatureSelectionSync().active.enabled).every(Boolean)'),true);
    const remove = await app.evaluate("window.lxEnv.manageOfficialModule({id:'history',action:'remove',revision:window.lxEnv.getFeatureSelectionSync().packages.revision})");
    assert.equal(remove.ok, true, remove.error);
    assert.equal(remove.selection.active.enabled.history, true, 'Removal must keep the running plugin until exit');
    assert.equal(remove.selection.selected.enabled.history, false);
    const reinstall = await app.evaluate("window.lxEnv.manageOfficialModule({id:'history',action:'install',revision:window.lxEnv.getFeatureSelectionSync().packages.revision})");
    assert.equal(reinstall.ok, true, reinstall.error);
    assert.equal(reinstall.selection.selected.enabled.history, true);
    assert.equal(fs.existsSync(path.join(dataFolder, 'fixture-music/Flowave fixture.wav')), true);
    assert.deepEqual(app.errors, []);
    console.log('PASS: saved selection and installed plugin load after full exit/reopen');
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const child of owned) await new Promise(resolve => {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
    killer.on('close', resolve); killer.on('error', resolve);
  });
});
