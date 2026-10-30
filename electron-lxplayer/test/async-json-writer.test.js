const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createCoalescedWriter, writeJsonObjectAtomic } = require("../async-json-writer");

test("performance persistence merges pending snapshots and drains updates during a write", async () => {
  const committed = [];
  let release;
  const writer = createCoalescedWriter(async (value) => {
    if (value === 2) await new Promise((resolve) => { release = resolve; });
    committed.push(value);
  }, 10000);
  const first = writer.save(1);
  const second = writer.save(2);
  const flushing = writer.flush();
  await Promise.resolve();
  assert.deepEqual(committed, []);
  const third = writer.save(3);
  release();
  await Promise.all([first, second, third, flushing]);
  assert.deepEqual(committed, [2, 3]);
});

test("performance persistence recovers from synchronous failures", async () => {
  const writer = createCoalescedWriter((value) => {
    if (!value) throw new Error("disk unavailable");
  }, 10000);
  const failed = writer.save(0);
  const rejection = assert.rejects(failed, /disk unavailable/);
  await assert.rejects(writer.flush(), /disk unavailable/);
  await rejection;
  const success = writer.save(1);
  await writer.flush();
  await success;
});

test("performance persistence yields between chunks and preserves the previous file on failure", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "flowave-json-writer-"));
  try {
    const file = path.join(root, "cache.json");
    const entries = new Map(Array.from({ length: 180 }, (_, index) => [String(index), { title: "歌曲".repeat(120) }]));
    let yielded = false;
    setImmediate(() => { yielded = true; });
    await writeJsonObjectAtomic(file, entries, { header: { version: 6 } });
    assert.equal(yielded, true);
    const previous = await fs.readFile(file, "utf8");
    assert.deepEqual(JSON.parse(previous), { version: 6, entries: Object.fromEntries(entries) });
    await assert.rejects(writeJsonObjectAtomic(file, entries, { serialize() { throw new Error("bad entry"); } }), /bad entry/);
    assert.equal(await fs.readFile(file, "utf8"), previous);
    assert.deepEqual(await fs.readdir(root), ["cache.json"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
