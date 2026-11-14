const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const {backendToken, authenticatedLocalRequest} = require('../backend-access');

test('backend credentials remain local to one workspace and renderer requests target one origin', () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'flowave-api-access-'));
  try {
    const token = backendToken(temporary);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(backendToken(temporary), token);
    assert.notEqual(backendToken(path.join(temporary, 'other')), token);
    fs.copyFileSync(path.join(temporary, 'electron/backend-access-token'), path.join(temporary, 'other/electron/backend-access-token'));
    assert.notEqual(backendToken(path.join(temporary, 'other')), token);
    const damaged = path.join(temporary, 'damaged');
    fs.mkdirSync(path.join(damaged, 'electron'), {recursive:true});
    fs.writeFileSync(path.join(damaged, 'electron/backend-access-token'), '');
    assert.match(backendToken(damaged), /^[0-9a-f]{64}$/);
    let intercept;
    const context = {window: {lxEnv: {getBackendConfigSync: () => ({baseUrl: 'http://127.0.0.1:29613', accessToken: token})}},
      URL, location: {href: 'kumiko-app://renderer/'},
      axios: {interceptors: {request: {use: callback => { intercept = callback; }}}}};
    const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
    vm.runInNewContext(source.slice(0, source.indexOf('const recommendationWarmups')), context);
    assert.equal(intercept({url: 'http://127.0.0.1:29613/config'}).headers['X-Flowave-Token'], token);
    assert.equal(intercept({url: '/practice/track', baseURL: 'http://127.0.0.1:29613'}).headers['X-Flowave-Token'], token);
    for (const url of ['https://example.com/', 'http://127.0.0.1:29614/config', 'http://127.0.0.1.example.com/']) {
      assert.equal(intercept({url}).headers['X-Flowave-Token'], undefined);
    }
    assert.equal(context.window.FlowaveBackendAccess.headers('http://127.0.0.1:29613/stems/page/x')['X-Flowave-Token'], token);
  } finally {
    assert(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(temporary, {recursive: true, force: true});
  }
});

test('the actual local playback-control handler authenticates before consuming or changing playback', async () => {
  const token = 'a'.repeat(64), outcomes = [], calls = [];
  let handler;
  const context = {controlServer: null, backendAccessToken: token, CONTROL_PORT: 3901, CONTROL_HOST: '127.0.0.1',
    http: {createServer: callback => {handler = callback; return {listen() {}, on() {}};}},
    require: () => ({authenticatedLocalRequest}), console, handleOnlineProxy() {},
    runPlayerControl: async (...args) => {calls.push(args); return {success: true};}};
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  vm.runInNewContext(source.slice(source.indexOf('function ensureControlServer()'), source.indexOf('async function handleOnlineProxy')), context);
  context.ensureControlServer();
  for (const headers of [
    {host:'127.0.0.1:3901'},
    {host:'127.0.0.1:3901',origin:'https://untrusted.example','x-flowave-token':token},
    {host:'untrusted.example@127.0.0.1','x-flowave-token':token},
    {host:'127.0.0.1:3901','x-flowave-token':'b'.repeat(64)},
    {host:'127.0.0.1:3901',origin:'kumiko-app://renderer','x-flowave-token':token},
  ]) {
    let status, consumed = false;
    const events = {};
    const req = {headers,method:'POST',url:'/control-music',on: (name,callback) => {events[name] = callback; consumed = true;}};
    const res = {writeHead: value => {status = value;},end() {}};
    handler(req, res);
    if (events.end) await events.end();
    outcomes.push([status, consumed]);
  }
  assert.deepEqual(outcomes, [[403,false],[403,false],[403,false],[403,false],[200,true]]);
  assert.equal(calls.length, 1);
});
