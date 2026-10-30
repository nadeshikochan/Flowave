const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHistoryPersistence } = require('../history-persistence');
const { writeJsonObjectAtomic } = require('../async-json-writer');
const history = (n, revision = 0) => ({ persistenceRevision: revision, totalSeconds: n,
  totalPlays: n, days: { '2026-10-19': n }, tracks: { x: { playCount: n, listenedSeconds: n } } });

test('saves coalesce, maintenance is a barrier and late pre-reset snapshots are rejected', async () => {
  const writes = [];
  const store = createHistoryPersistence({ initial: history(0), write: async value => {
    writes.push(value.totalPlays); return { ok: true };
  }, operate: async (_state, _kind, revision) => ({ ok: true, history: history(0, revision) }) });
  const a = store.save(history(1)), b = store.save(history(2));
  const clear = store.operation('clear-stats');
  const stale = store.save(history(3));
  assert.equal((await a).ok, true);
  assert.equal((await b).ok, true);
  assert.equal((await clear).history.persistenceRevision, 1);
  assert.equal((await stale).ok, false);
  assert.deepEqual(writes, [2]);
  assert.equal((await store.save(history(1, 1))).ok, true);
  await store.flush();
  assert.equal(store.state.totalPlays, 1);
});

test('failed write preserves committed state and drain waits for an active write', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let fail = true;
  const store = createHistoryPersistence({ initial: history(1), write: async () => {
    await gate; if (fail) throw Error('disk unavailable'); return { ok: true };
  } });
  const saving = store.save(history(2));
  let drained = false;
  const flush = store.flush().then(() => { drained = true; });
  await Promise.resolve();
  assert.equal(drained, false);
  release();
  assert.equal((await saving).ok, false);
  await flush;
  assert.equal(store.state.totalPlays, 1);
  fail = false;
  assert.equal((await store.save(history(3))).ok, true);
});

test('chunked history writer preserves its schema and yields during large saves', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flowave-history-write-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'history.json');
  const tracks = Object.fromEntries(Array.from({ length: 4000 }, (_, i) => ['song' + i, { title: '歌曲' + i, playCount: i }]));
  let yielded = false;
  setImmediate(() => { yielded = true; });
  await writeJsonObjectAtomic(file, tracks, { header: { version: 2, days: { today: 5 } }, entriesKey: 'tracks' });
  const result = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(yielded, true);
  assert.equal(result.tracks.song3999.playCount, 3999);
  assert.deepEqual(result.days, { today: 5 });
  assert.equal(Object.hasOwn(result, 'entries'), false);
  await assert.rejects(writeJsonObjectAtomic(file, { bad: 1n }, { header: {}, entriesKey: 'tracks' }));
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), result);
});
