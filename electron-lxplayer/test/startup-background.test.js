const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const sharp = require('sharp');
const { StartupBackgroundStore } = require('../startup-background');

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowave-background-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, '用户图片.png'), directory = path.join(root, 'appearance');
  await sharp({ create: { width: 3000, height: 1000, channels: 3, background: '#356bda' } }).png().toFile(source);
  return { root, source, directory };
}

test('startup artwork survives moving its original, reloads portably and can restore the default', async t => {
  const { root, source, directory } = await setup(t);
  const store = new StartupBackgroundStore(directory);
  assert.equal(store.get().custom, false);
  const result = await store.importFile(source);
  assert.equal(result.custom, true);
  assert.equal(result.name, '用户图片.png');
  await fs.unlink(source);
  const record = JSON.parse(await fs.readFile(store.recordPath, 'utf8'));
  const meta = await sharp(await fs.readFile(path.join(directory, record.file))).metadata();
  assert.equal(meta.width, 2560);
  assert.equal(meta.format, 'webp');
  const moved = path.join(root, 'moved');
  await fs.rename(directory, moved);
  const restored = new StartupBackgroundStore(moved);
  assert.equal(restored.get().custom, true);
  assert(restored.get().url.includes(encodeURIComponent(moved)));
  await restored.reset();
  assert.equal(new StartupBackgroundStore(moved).get().custom, false);
});

test('decode and configuration failures preserve the prior committed choice', async t => {
  const { root, source, directory } = await setup(t);
  const store = new StartupBackgroundStore(directory);
  const previous = await store.importFile(source);
  const invalid = path.join(root, 'invalid.png');
  await fs.writeFile(invalid, '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"/>');
  await assert.rejects(store.importFile(invalid));
  assert.deepEqual(store.get(), previous);
  const failing = new StartupBackgroundStore(directory, { writeRecord: async () => { throw new Error('disk failed'); } });
  await assert.rejects(failing.importFile(source), /disk failed/);
  await assert.rejects(failing.reset(), /disk failed/);
  assert.deepEqual(failing.get(), previous);
  assert.deepEqual(new StartupBackgroundStore(directory).get(), previous);
});

test('queued changes publish in order; missing and invalid managed files fall back without rewriting config', async t => {
  const { root, source, directory } = await setup(t);
  const store = new StartupBackgroundStore(directory);
  await Promise.all([store.importFile(source), store.reset()]);
  assert.equal(new StartupBackgroundStore(directory).get().custom, false);
  await store.importFile(source);
  const recordBytes = await fs.readFile(store.recordPath);
  const { file } = JSON.parse(recordBytes);
  await fs.unlink(path.join(directory, file));
  assert.equal(store.get().custom, false);
  assert.deepEqual(await fs.readFile(store.recordPath), recordBytes);
  await fs.writeFile(store.recordPath, JSON.stringify({ file: '../用户图片.png' }));
  assert.equal(new StartupBackgroundStore(directory).get().custom, false);
  assert((await fs.stat(path.join(root, '用户图片.png'))).isFile());
});
