const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MediaInputCoordinator } = require('../media-input');
const { AudioOutputSafety } = require('../audio-output-safety');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { PassThrough } = require('node:stream');
const { AudioOutputMonitor } = require('../audio-output-monitor');

function clock() {
  let time = 0, id = 0;
  const timers = new Map(), delivered = [];
  const coordinator = new MediaInputCoordinator({
    now: () => time,
    schedule: (fn, delay) => { timers.set(++id, { fn, at: time + delay }); return id; },
    cancel: id => timers.delete(id),
    deliver: action => delivered.push(action),
  });
  return { coordinator, delivered, tick(ms) {
    time += ms;
    for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
  } };
}

test('media providers share one command and explicit pause wins over toggle', () => {
  const { coordinator: input, delivered, tick } = clock();
  input.submit('play_pause', 'media-global-shortcut');
  input.submit('play_pause', 'before-input-event');
  input.submit('pause', 'media-session');
  tick(40);
  assert.deepEqual(delivered, ['pause']);
  assert.equal(input.submit('play_pause', 'app-command'), false);
  tick(300);
  input.submit('play', 'media-session'); tick(40);
  assert.deepEqual(delivered, ['pause', 'play']);
});

test('independent rapid commands survive and coordinator teardown cancels pending work', () => {
  const { coordinator: input, delivered, tick } = clock();
  input.submit('next_like', 'app-command');
  input.submit('next_like', 'app-command'); tick(40);
  assert.deepEqual(delivered, ['next_like', 'next_like']);
  input.submit('dislike_next', 'media-session'); input.dispose(); tick(1000);
  assert.equal(delivered.length, 2);
});

function safetyFixture() {
  const monitor = new EventEmitter();
  monitor.leases = new Set();
  monitor.value = { id: 'headphones', transport: 'bluetooth', route: 'default' };
  monitor.acquire = id => monitor.leases.add(id);
  monitor.release = id => monitor.leases.delete(id);
  monitor.get = async () => monitor.value;
  const effects = [];
  const owner = { isDestroyed: () => false, setAudioMuted: value => effects.push(['mute', value]), send: (...args) => effects.push(['send', ...args]) };
  return { monitor, effects, owner, safety: new AudioOutputSafety(monitor) };
}

test('headphone loss mutes before pause delivery; unrelated devices and communication defaults do not trip', async () => {
  const { monitor, effects, owner, safety } = safetyFixture();
  assert.equal((await safety.prepare(owner)).ok, true);
  monitor.emit('device-event', { kind: 'removed', id: 'unrelated' });
  monitor.emit('device-event', { kind: 'default', id: 'speakers', flow: 0, role: 2 });
  assert.equal(effects.length, 0);
  monitor.emit('device-event', { kind: 'state', id: 'headphones', state: 8 });
  assert.deepEqual(effects[0], ['mute', true]);
  assert.equal(effects[1][1], 'lx-audio-output-safety');
  monitor.emit('device-event', { kind: 'removed', id: 'headphones' });
  assert.equal(effects.length, 2);
  safety.dispose();
  assert.equal(monitor.leases.size, 0);
  assert.equal(monitor.listenerCount('device-event'), 0);
});

test('automatic resume stays blocked; media resume cannot unmute speakers; explicit UI resume can', async () => {
  const { monitor, effects, owner, safety } = safetyFixture();
  await safety.prepare(owner);
  safety.trip('headphones-disconnected');
  safety.pause(owner);
  monitor.value = { id: 'speakers', transport: 'other', confirmed: true };
  assert.equal((await safety.prepare(owner)).ok, false);
  assert.equal((await safety.prepare(owner, { resume: true })).ok, false);
  assert.equal(monitor.leases.size, 0);
  assert.equal(effects.some(item => item[0] === 'mute' && item[1] === false), false);
  assert.equal((await safety.prepare(owner, { resume: true, allowOutputChange: true })).ok, true);
  assert.deepEqual(effects.at(-1), ['mute', false]);
  safety.dispose();
});

test('pending output preparation cannot revive playback after pause', async () => {
  const { monitor, owner, safety } = safetyFixture();
  let resolve;
  monitor.get = () => new Promise(done => { resolve = done; });
  const pending = safety.prepare(owner);
  safety.pause(owner);
  resolve(monitor.value);
  assert.equal((await pending).ok, false);
  assert.equal(monitor.leases.size, 0);
  safety.dispose();
});

test('only an explicit unworn report from the protected endpoint pauses; wearing never resumes', async () => {
  const { monitor, effects, owner, safety } = safetyFixture();
  await safety.prepare(owner);
  monitor.emit('wear-state', { id: 'other-headphones', status: 'reported', worn: false });
  monitor.emit('wear-state', { id: 'headphones', status: 'unavailable', worn: null });
  monitor.emit('wear-state', { id: 'headphones', status: 'reported', worn: true });
  monitor.emit('wear-state', { id: 'headphones', status: 'reported', worn: 'false' });
  assert.equal(effects.length, 0);
  monitor.emit('wear-state', { id: 'headphones', status: 'reported', worn: false });
  assert.deepEqual(effects[0], ['mute', true]);
  assert.equal(effects[1][2].reason, 'headphones-removed');
  monitor.emit('wear-state', { id: 'headphones', status: 'reported', worn: true });
  assert.equal(effects.length, 2);
  assert.equal(safety.blocked, true);
  safety.dispose();
  assert.equal(monitor.listenerCount('wear-state'), 0);
});

test('wear report received before route confirmation is applied before playback admission', async () => {
  const { monitor, effects, owner, safety } = safetyFixture();
  monitor.wearState = { id: 'headphones', status: 'reported', worn: false };
  assert.equal((await safety.prepare(owner)).ok, false);
  assert.equal(safety.blocked, true);
  assert.deepEqual(effects[0], ['mute', true]);
  safety.dispose();
});

test('default-device hints do not override the app actual route, and probe failure stops a protected session', async () => {
  const { monitor, owner, safety } = safetyFixture();
  await safety.prepare(owner);
  monitor.emit('change', { id: 'speakers', transport: 'other', confirmed: true });
  assert.equal(safety.blocked, false);
  monitor.emit('change', { id: 'headphones', transport: 'bluetooth', confirmed: true });
  monitor.emit('change', { id: '', transport: 'unknown', reason: 'probe-unavailable' });
  assert.equal(safety.blocked, true);
  safety.release();
  assert.equal((await safety.prepare(owner)).blocked, true); // renderer reload cannot clear native mute
  safety.dispose();
});

test('native endpoint messages stay separate from calibration snapshots and old helpers cannot publish', () => {
  const children = [];
  const monitor = new AudioOutputMonitor({ platform: 'win32', spawnProcess() {
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    children.push(child); return child;
  } });
  const events = [], wear = [];
  monitor.on('device-event', value => events.push(value));
  monitor.on('wear-state', value => wear.push(value));
  monitor.acquire('test');
  children[0].stdout.write(JSON.stringify({ type: 'wear-state', id: 'headphones', status: 'reported', worn: false }) + '\n');
  children[0].stdout.write(JSON.stringify({ type: 'wear-state', id: 'headphones', status: 'reported', worn: 0 }) + '\n');
  assert.equal(wear[0].worn, false);
  assert.equal(wear[1].worn, null);
  children[0].stdout.write(JSON.stringify({ type: 'device-event', kind: 'removed', id: 'headphones' }) + '\n');
  assert.equal(events.length, 1);
  assert.equal(monitor.state.reason, 'not-started');
  monitor.release('test');
  children[0].stdout.write(JSON.stringify({ type: 'device-event', kind: 'removed', id: 'late' }) + '\n');
  children[0].stdout.write(JSON.stringify({ type: 'wear-state', id: 'late', status: 'reported', worn: false }) + '\n');
  assert.equal(events.length, 1);
  assert.equal(wear.length, 2);
  monitor.dispose();
});

test('real Windows adapters map next/previous consistently and use global media keys only as fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const win = new EventEmitter(); win.webContents = new EventEmitter();
  const actions = [], registered = [];
  const context = { audioOutputSafety: { owner: null }, shortcutConfig: {}, shortcutStatus: {},
    mediaSessionAvailable: true, pushMediaDiag() {}, console: { info() {}, warn() {} },
    dispatchHotkeyAction: (_win, action) => actions.push(action),
    isAcceleratorMatch: () => false,
    globalShortcut: { unregisterAll() {}, register: key => { registered.push(key); return true; } } };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function bindWindowShortcutEvents('), source.indexOf('function dispatchHotkeyAction(')), context);
  context.bindWindowShortcutEvents(win);
  const event = { preventDefault() {} };
  for (const key of ['MediaNextTrack','MediaPreviousTrack']) win.webContents.emit('before-input-event', event, {type:'keyDown', key});
  win.webContents.emit('before-input-event', event, {type:'keyDown', key:'MediaNextTrack', isAutoRepeat:true});
  for (const command of ['media-next-track','media-previous-track']) win.emit('app-command', event, command);
  assert.deepEqual(actions, ['next_like','dislike_next','next_like','dislike_next']);
  vm.runInContext(source.slice(source.indexOf('function registerAllShortcuts('), source.indexOf('app.on("will-quit"')), context);
  context.registerAllShortcuts(win);
  assert.equal(registered.length, 0);
  context.mediaSessionAvailable = false;
  context.registerAllShortcuts(win);
  assert.equal(registered.length, 4);
});
