'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {redact, createDiagnostics} = require('../diagnostics');
const {modulePlan, readInstallPlan} = require('../resource-plan');
const {writeJsonObjectAtomic} = require('../async-json-writer');
const {releaseInfo} = require('../release-info');

test('diagnostics hide local paths, credentials and request parameters', () => {
  const report = redact({path:'D:\\Music\\Kumiko\\song.mp3', token:'private-token',
    request:'https://user:password@example.com/private/token?key=secret',
    error:'Bearer private-token', nested:{authorization:'hidden'}});
  const text = JSON.stringify(report);
  for (const forbidden of ['Kumiko', 'song.mp3', 'private-token', 'password', 'key=secret'])
    assert(!text.includes(forbidden));
  assert(text.includes('https://example.com/'));
});

test('Windows UTF-8 build information remains identifiable', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'flowave-version-'));
  t.after(() => fs.rm(temp, {recursive:true, force:true}));
  await fs.writeFile(path.join(temp, 'package.json'), JSON.stringify({version:'0.2.0'}));
  await fs.writeFile(path.join(temp, 'build-info.json'), '\uFEFF' + JSON.stringify({version:'0.2.0', commit:'a'.repeat(40)}));
  assert.equal(releaseInfo(temp).commit, 'a'.repeat(40));
  assert.equal(releaseInfo(temp).development, false);
});

test('export saves only the previewed report and rejects replaced previews', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'flowave-diagnostics-'));
  t.after(() => fs.rm(temp, {recursive:true, force:true}));
  const service = createDiagnostics({root:temp, dataDir:temp,
    info:() => ({version:'test'}), packages:() => ({}), resources:() => ({}),
    media:() => ({events:[]}), gpu:async () => ({status:'fixture'})});
  const first = await service.preview();
  const output = path.join(temp, 'diagnostics.json');
  await service.export(first.id, async () => output);
  assert.deepEqual(JSON.parse(await fs.readFile(output, 'utf8')), JSON.parse(first.text));
  await service.preview();
  await assert.rejects(() => service.export(first.id, async () => output), /预览/);
  const current = await service.preview();
  const cancelled = await service.export(current.id, async () => '');
  assert(cancelled.cancelled);
});

test('resource plan counts environments and deduplicates shared downloads', () => {
  const root = path.resolve(__dirname, '../..');
  const catalog = require('../../resources/catalog.json');
  const plan = readInstallPlan(root, catalog);
  const result = modulePlan(catalog, plan, 'recommendation', () => false);
  const files = new Map();
  for (const id of catalog.modules.recommendation.profiles)
    for (const row of plan.profiles[id].files) files.set(row.sha256, row.bytes);
  for (const id of catalog.modules.recommendation.groups)
    for (const row of catalog.groups[id].files) files.set(row.sha256, row.bytes);
  assert.equal(result.downloadBytes, [...files.values()].reduce((a, b) => a + b, 0));
  assert(result.downloadBytes > 9 * 1000 ** 3);
  assert(modulePlan(catalog, plan, 'recommendation', () => true).ready);
  assert.equal(modulePlan(catalog, plan, 'recommendation', () => true).downloadBytes, 0);
});

test('a durability failure retains the previously committed file', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'flowave-durable-'));
  t.after(() => fs.rm(temp, {recursive:true, force:true}));
  const output = path.join(temp, 'state.json');
  await fs.writeFile(output, '{"saved":1}');
  const original = fs.open;
  fs.open = async (...args) => {
    const handle = await original(...args);
    handle.sync = async () => { throw Error('disk flush failed'); };
    return handle;
  };
  try { await assert.rejects(() => writeJsonObjectAtomic(output, {saved:2}), /flush/); }
  finally { fs.open = original; }
  assert.equal(await fs.readFile(output, 'utf8'), '{"saved":1}');
  assert.deepEqual(await fs.readdir(temp), ['state.json']);
});
