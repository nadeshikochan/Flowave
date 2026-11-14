const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const yieldTask = () => new Promise((resolve) => setImmediate(resolve));

// 按条目序列化并异步原子提交，避免整库 JSON.stringify + 同步磁盘写入占住主进程。
async function writeJsonObjectAtomic(filePath, entries, { header = null, serialize = (value) => value, entriesKey = "entries" } = {}) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const staged = `${filePath}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(staged, "wx");
    await handle.writeFile(header ? `${JSON.stringify(header).slice(0, -1)},${JSON.stringify(entriesKey)}:{` : "{");
    const pairs = entries instanceof Map ? [...entries.entries()] : Object.entries(entries);
    let chunk = "", count = 0, first = true;
    for (const [key, value] of pairs) {
      const encoded = JSON.stringify(serialize(value));
      if (encoded === undefined) continue;
      chunk += `${first ? "" : ","}${JSON.stringify(key)}:${encoded}`;
      first = false;
      count += 1;
      if (chunk.length >= 32768 || count % 32 === 0) {
        await handle.writeFile(chunk);
        chunk = "";
        await yieldTask();
      }
    }
    await handle.writeFile(`${chunk}${header ? "}}" : "}"}`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(staged, filePath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(staged).catch(() => {});
  }
}

// 调用者传不可变快照；同一等待窗口只提交最后一代，所有调用在提交后才确认成功。
function createCoalescedWriter(write, delayMs = 100) {
  let pending = null, timer = null, running = null;
  function schedule() {
    if (!timer && !running && pending) timer = setTimeout(() => {
      timer = null;
      pump().catch(() => {});
    }, delayMs);
  }
  function pump() {
    if (running) return running;
    if (!pending) return Promise.resolve();
    const batch = pending;
    pending = null;
    running = Promise.resolve().then(async () => {
      try {
        await write(batch.value);
        batch.waiters.forEach(({ resolve }) => resolve());
      } catch (error) {
        batch.waiters.forEach(({ reject }) => reject(error));
        throw error;
      } finally {
        running = null;
        schedule();
      }
    });
    return running;
  }
  return {
    save(value) {
      if (!pending) pending = { value, waiters: [] };
      pending.value = value;
      const promise = new Promise((resolve, reject) => pending.waiters.push({ resolve, reject }));
      schedule();
      return promise;
    },
    async flush() {
      while (pending || running) {
        if (timer) { clearTimeout(timer); timer = null; }
        await pump();
      }
    },
  };
}

module.exports = { writeJsonObjectAtomic, createCoalescedWriter };
